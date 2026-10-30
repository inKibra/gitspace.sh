import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { terminalLiveResource, terminalStreamResource, type MachineLiveNotice, type ProtectedTerminalEvent } from '@gitspace/protocol';
import { closeDaemonClients, daemonClientForProject, getDaemonRuntimeDir } from '@gitspace/supervisor';
import { WorkspaceHubTerminalCoordinator } from '../src/workspace-hub.js';

interface Fixture {
  root: string;
  workspace: string;
  coordinator: WorkspaceHubTerminalCoordinator;
  notices: MachineLiveNotice[];
  /** Settles on the next notice. */
  announced(): Promise<void>;
}
const fixtures: Fixture[] = [];
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-interactive-test-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const notices: MachineLiveNotice[] = [];
  let arrived = Promise.withResolvers<void>();
  const coordinator = new WorkspaceHubTerminalCoordinator('machine-a', {
    path: (spaceId) => spaceId === 'workspace-a' ? workspace : null,
    projectId: (spaceId) => spaceId === 'workspace-a' ? 'project-a' : null,
    list: () => ['workspace-a'],
    use: async () => {},
  }, undefined, (notice) => {
    notices.push(notice);
    arrived.resolve();
    arrived = Promise.withResolvers<void>();
  });
  const value = { root, workspace, coordinator, notices, announced: () => arrived.promise };
  fixtures.push(value);
  return value;
}

afterEach(async () => {
  for (const item of fixtures) await item.coordinator.stopOwned('workspace-a');
  for (const item of fixtures) {
    const client = await daemonClientForProject(item.workspace);
    await client.request({ op: 'shutdown' });
  }
  await closeDaemonClients();
  for (const item of fixtures.splice(0)) {
    rmSync(item.root, { recursive: true, force: true });
  }
});

/** Reads the protected terminal as a tab does: after its cursor, and again on each notice, until `done`. */
async function until({ coordinator, notices, announced }: Fixture, name: string, after: number | null, done: (events: ProtectedTerminalEvent[]) => boolean): Promise<{ cursor: number; events: ProtectedTerminalEvent[] }> {
  const resource = terminalLiveResource('machine-a', name);
  const events: ProtectedTerminalEvent[] = [];
  let cursor = after;
  for (;;) {
    const batch = await coordinator.live('workspace-a', name, cursor);
    events.push(...batch.events);
    cursor = batch.cursor;
    if (done(events)) return { cursor, events };
    while (!notices.some((notice) => notice.resource === resource && notice.cursor > batch.cursor)) await announced();
  }
}

function output(events: readonly ProtectedTerminalEvent[]): string {
  return events.flatMap((event) => event.type === 'output' ? [event.data] : []).join('');
}

function retainedFiles(root: string): string {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? retainedFiles(path) : entry.isFile() ? readFileSync(path).toString() : '';
  }).join('\n');
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

describe('protected interactive lifecycle terminals', () => {
  it('feeds ordinary terminal input without echo, reattaches the same script without replay, and keeps output out of durable storage', async () => {
    const live = fixture();
    const { coordinator, workspace } = live;
    const started = Promise.withResolvers<void>();
    const inputCanary = `input-café-${crypto.randomUUID()}`;
    const outputCanary = new Bun.CryptoHasher('sha256').update(inputCanary).digest('hex');
    let durableOutput = '';
    const bindingsPath = join(workspace, 'bindings.json');
    writeFileSync(bindingsPath, '{"bindings":{}}');
    const execution = coordinator.runLifecyclePlan('workspace-a', 'workspace/materialize', [{
      id: 'auth', kind: 'script', command: '/approved/auth.sh',
      content: `set -eu\nprintf '%s' "$$" > process-id\nprintf 'First code: '\nIFS= read -r first\nprintf '%s' "$first" > received\nprintf 'PRIVATE:'\nprintf '%s' "$first" | sha256sum\nprintf 'Second code: '\nIFS= read -r second\ntest "$second" = finish\nprintf '%s' '{"bindings":{"resource":"fixture-resource"}}' > "$GITSPACE_LIFECYCLE_OUTPUT"\nprintf 'COMPLETE\\n'`,
    }], { PATH: process.env.PATH ?? '', GITSPACE_LIFECYCLE_OUTPUT: bindingsPath }, {
      interactive: true, runId: 'protected-roundtrip', deadlineAt: new Date(Date.now() + 15_000).toISOString(),
      onStarted: async () => started.resolve(), onOutput: async (chunk) => { durableOutput += chunk; },
    });
    await Promise.race([started.promise, execution.then(() => { throw new Error('Runner exited before attach'); })]);
    const terminal = (await coordinator.list('workspace-a')).find((item) => item.name === 'life-protected-roundtrip');
    expect(terminal?.protected).toBe(true);
    const name = terminal!.name;
    const prompt = await until(live, name, null, (events) => output(events).includes('First code:'));
    expect(output(prompt.events)).not.toContain(inputCanary);
    const pid = readFileSync(join(workspace, 'process-id'), 'utf8');
    await coordinator.send('workspace-a', name, `${inputCanary}\n`);
    const reply = await until(live, name, prompt.cursor, (events) => output(events).includes('Second code:'));
    expect(output(reply.events)).not.toContain('First code:');
    expect(output(reply.events)).toContain(outputCanary);
    expect(output(reply.events)).not.toContain(inputCanary);
    expect(readFileSync(join(workspace, 'received'), 'utf8')).toBe(inputCanary);
    expect((await coordinator.events('workspace-a', name, null))[0]).toMatchObject({ type: 'snapshot' });
    // A fresh read attaches without earlier output, whether or not the machine is still attached.
    expect((await coordinator.live('workspace-a', name, null)).events).toEqual([{ type: 'state', steps: [{ id: 'auth', status: 'running', exitCode: null }] }]);
    coordinator.unwatched(terminalLiveResource('machine-a', name), Number.MAX_SAFE_INTEGER);
    const resumed = await until(live, name, null, (events) => events.length > 0);
    expect(resumed.events).toEqual([{ type: 'state', steps: [{ id: 'auth', status: 'running', exitCode: null }] }]);
    expect(readFileSync(join(workspace, 'process-id'), 'utf8')).toBe(pid);
    await coordinator.send('workspace-a', name, 'finish\n');
    const final = await until(live, name, resumed.cursor, (events) => events.some((event) => event.type === 'complete'));
    expect(output(final.events)).toContain('COMPLETE');
    expect(output(final.events)).not.toContain(outputCanary);
    expect(output(final.events)).not.toContain('First code:');
    expect(final.events.filter((event) => event.type === 'complete')).toEqual([{ type: 'complete', exitCode: 0 }]);
    expect(final.events.at(-2)).toEqual({ type: 'state', steps: [{ id: 'auth', status: 'succeeded', exitCode: 0 }] });
    expect(final.events.at(-1)).toEqual({ type: 'complete', exitCode: 0 });
    const result = await execution;
    expect(result.exitCode).toBe(0);
    expect(result.steps.map((step) => ({ id: step.id, exitCode: step.exitCode }))).toEqual([{ id: 'auth', exitCode: 0 }]);
    expect(JSON.parse(readFileSync(bindingsPath, 'utf8'))).toEqual({ bindings: { resource: 'fixture-resource' } });
    // A tab arriving after the end reads the completion, still without earlier output.
    expect((await coordinator.live('workspace-a', name, null)).events).toEqual([
      { type: 'state', steps: [{ id: 'auth', status: 'succeeded', exitCode: 0 }] }, { type: 'complete', exitCode: 0 },
    ]);
    const metadata = terminalStreamResource('workspace-a', 'machine-a', name);
    let cursor: number | null = null;
    for (;;) {
      const events = await coordinator.events('workspace-a', name, cursor);
      if (events.some((event) => event.type !== 'resync' && event.value.terminals.some((entry) => entry.name === name && entry.state === 'exited'))) break;
      cursor = events.at(-1)?.cursor ?? cursor;
      while (!live.notices.some((notice) => notice.resource === metadata && notice.cursor > (cursor ?? 0))) await live.announced();
    }
    coordinator.unwatched(metadata, Number.MAX_SAFE_INTEGER);
    const safeRead = await coordinator.read('workspace-a', terminal!.name, null);
    const retained = JSON.stringify({ result, durableOutput, safeRead }) + retainedFiles(getDaemonRuntimeDir(workspace)) + readFileSync(join(workspace, 'runner.log'), 'utf8');
    expect(retained).not.toContain(inputCanary);
    expect(retained).not.toContain(outputCanary);
    const hub = await daemonClientForProject(workspace);
    const logs = await hub.request({ op: 'logs', name: terminal!.name, lines: 1_000, head: true, follow: false, timeoutMs: 5_000 });
    expect(JSON.stringify(logs)).not.toContain(outputCanary);
    expect(JSON.stringify(logs)).not.toContain(inputCanary);
    await expect(coordinator.send('workspace-a', terminal!.name, 'must-not-run\n')).rejects.toThrow();
  }, 25_000);

  it('delivers fast ordered steps and the final private UTF-8 stderr bytes before one failed completion', async () => {
    const live = fixture();
    const { coordinator, workspace } = live;
    const started = Promise.withResolvers<void>();
    const seed = crypto.randomUUID();
    const canary = new Bun.CryptoHasher('sha256').update(seed).digest('hex');
    const deriveCanary = `value=$(printf '%s' '${seed}' | sha256sum); value=\${value%% *}`;
    const lines = [`ready-10-${canary}`, `ready-20-${canary}`, `error-30-${canary}-café-尾`];
    let durableOutput = '';
    const execution = coordinator.runLifecyclePlan('workspace-a', 'workspace/materialize', [
      { id: '10', kind: 'script', command: '/approved/10.sh', content: `${deriveCanary}; printf 'ready-10-%s\\n' "$value"` },
      { id: '20', kind: 'script', command: '/approved/20.sh', content: `${deriveCanary}; printf 'ready-20-%s\\n' "$value"` },
      { id: '30', kind: 'script', command: '/approved/30.sh', content: `${deriveCanary}; printf 'error-30-%s-café-尾' "$value" >&2; exit 1` },
      { id: '40', kind: 'script', command: '/approved/40.sh', content: 'touch must-not-run' },
    ], { PATH: process.env.PATH ?? '', GITSPACE_LIFECYCLE_OUTPUT: join(workspace, 'bindings.json') }, {
      interactive: true, runId: 'protected-fast', deadlineAt: new Date(Date.now() + 15_000).toISOString(),
      onStarted: async () => started.resolve(), onOutput: async (chunk) => { durableOutput += chunk; },
    });
    await Promise.race([started.promise, execution.then(() => { throw new Error('Runner exited before attach'); })]);
    const { events } = await until(live, 'life-protected-fast', null, (received) => received.some((event) => event.type === 'complete'));
    const result = await execution;
    const states = events.filter((event) => event.type === 'state');
    expect(events[0]).toEqual({
      type: 'state', steps: ['10', '20', '30', '40'].map((id) => ({ id, status: 'pending', exitCode: null })),
    });
    expect(states.map((event) => event.steps.map((step) => step.status))).toEqual([
      ['pending', 'pending', 'pending', 'pending'],
      ['running', 'pending', 'pending', 'pending'],
      ['succeeded', 'pending', 'pending', 'pending'],
      ['succeeded', 'running', 'pending', 'pending'],
      ['succeeded', 'succeeded', 'pending', 'pending'],
      ['succeeded', 'succeeded', 'running', 'pending'],
      ['succeeded', 'succeeded', 'failed', 'pending'],
    ]);
    expect(states.at(-1)?.steps.map((step) => step.exitCode)).toEqual([0, 0, 1, null]);
    expect(events.filter((event) => event.type === 'output').map((event) => event.data).join('').replaceAll('\r\n', '\n')).toBe(`${lines[0]}\n${lines[1]}\n${lines[2]}`);
    expect(events.filter((event) => event.type === 'complete')).toEqual([{ type: 'complete', exitCode: 1 }]);
    expect(events.at(-1)).toEqual({ type: 'complete', exitCode: 1 });
    expect(result.exitCode).toBe(1);
    expect(result.steps.map((step) => [step.id, step.exitCode])).toEqual([['10', 0], ['20', 0], ['30', 1]]);
    expect(readdirSync(workspace)).not.toContain('must-not-run');
    const safeRead = await coordinator.read('workspace-a', 'life-protected-fast', null);
    const retained = JSON.stringify({ result, durableOutput, safeRead }) + retainedFiles(getDaemonRuntimeDir(workspace)) + readFileSync(join(workspace, 'runner.log'), 'utf8');
    for (const line of lines) expect(retained).not.toContain(line);
  }, 25_000);

  it('cancels the script and its background child without creating a replacement shell', async () => {
    const live = fixture();
    const { coordinator, workspace } = live;
    const started = Promise.withResolvers<void>();
    const execution = coordinator.runLifecyclePlan('workspace-a', 'workspace/materialize', [{
      id: 'waiting', kind: 'script', command: '/approved/wait.sh',
      content: 'sleep 300 &\nprintf "%s" "$!" > child-id\nprintf "Ready: "\nread -r answer\nwait',
    }], { PATH: process.env.PATH ?? '' }, { interactive: true, runId: 'protected-cancel', deadlineAt: new Date(Date.now() + 15_000).toISOString(), onStarted: async () => started.resolve() });
    await Promise.race([started.promise, execution.then(() => { throw new Error('Runner exited before attach'); })]);
    await until(live, 'life-protected-cancel', null, (events) => output(events).includes('Ready:'));
    const child = Number(readFileSync(join(workspace, 'child-id'), 'utf8'));
    expect(alive(child)).toBe(true);
    await coordinator.cancelLifecycleRun('workspace-a', 'life-protected-cancel');
    const result = await execution;
    expect(result.exitCode).not.toBe(0);
    expect(alive(child)).toBe(false);
    await expect(coordinator.send('workspace-a', 'life-protected-cancel', 'echo bypass\n')).rejects.toThrow();
  }, 25_000);

  it('expires an unattached terminal without executing the script', async () => {
    const { coordinator, workspace } = fixture();
    const result = await coordinator.runLifecyclePlan('workspace-a', 'workspace/materialize', [{
      id: 'never-started', kind: 'script', command: '/approved/wait.sh', content: 'touch should-not-exist',
    }], { PATH: process.env.PATH ?? '' }, { interactive: true, runId: 'protected-unattached', deadlineAt: new Date(Date.now() + 1_500).toISOString() });
    expect(result.exitCode).not.toBe(0);
    expect(readdirSync(workspace)).not.toContain('should-not-exist');
  }, 15_000);
});
