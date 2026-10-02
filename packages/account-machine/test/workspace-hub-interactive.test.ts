import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitSpaceDatabase } from '@gitspace/core';
import type { ProtectedTerminalEvent } from '@gitspace/protocol';
import { closeDaemonClients, daemonClientForProject } from '@oh-my-pi/pi-coding-agent/launch/client';
import { getDaemonRuntimeDir } from '@oh-my-pi/pi-utils';
import { sql } from 'drizzle-orm';
import { WorkspaceHubTerminalCoordinator } from '../src/workspace-hub.js';

interface Fixture {
  root: string;
  workspace: string;
  database: GitSpaceDatabase;
  coordinator: WorkspaceHubTerminalCoordinator;
}
const fixtures: Fixture[] = [];
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-interactive-test-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
  for (const result of [
    database.createProject({ id: 'project-a', name: 'Test', repositoryPath: workspace }),
    database.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'interactive', branch: 'test', rootPath: workspace }),
    database.possessSpace('workspace-a', 'machine-a'),
  ]) if (result.status === 'error') throw result.error;
  const coordinator = new WorkspaceHubTerminalCoordinator(database, 'machine-a');
  const value = { root, workspace, database, coordinator };
  fixtures.push(value);
  return value;
}

afterEach(async () => {
  for (const item of fixtures) await item.coordinator.stopOwned('workspace-a');
  await closeDaemonClients();
  for (const item of fixtures.splice(0)) {
    item.database.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

async function until(stream: AsyncIterator<ProtectedTerminalEvent>, predicate: (text: string) => boolean): Promise<string> {
  let output = '';
  for (;;) {
    const item = await stream.next();
    if (item.done) throw new Error('Terminal ended before expected output');
    if (item.value.type === 'output') output += item.value.data;
    if (predicate(output)) return output;
  }
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
  it('feeds ordinary terminal input without echo, reconnects the same script, and keeps output out of durable storage', async () => {
    const { coordinator, workspace, database } = fixture();
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
    const controller = new AbortController();
    const stream = coordinator.live('workspace-a', terminal!.name, controller.signal);
    const prompt = await until(stream, (text) => text.includes('First code:'));
    expect(prompt).not.toContain(inputCanary);
    const pid = readFileSync(join(workspace, 'process-id'), 'utf8');
    await coordinator.send('workspace-a', terminal!.name, `${inputCanary}\n`);
    const reply = await until(stream, (text) => text.includes('Second code:'));
    expect(reply).toContain(outputCanary);
    expect(reply).not.toContain(inputCanary);
    expect(readFileSync(join(workspace, 'received'), 'utf8')).toBe(inputCanary);
    const observerController = new AbortController();
    const observations = coordinator.events('workspace-a', terminal!.name, null, observerController.signal);
    await observations.next();
    observerController.abort();
    await observations.return();
    controller.abort();
    await stream.return();

    const reconnect = new AbortController();
    const resumed = coordinator.live('workspace-a', terminal!.name, reconnect.signal);
    const notice = await resumed.next();
    expect(notice.done).toBe(false);
    expect(notice.value).toEqual({ type: 'state', steps: [{ id: 'auth', status: 'running', exitCode: null }] });
    expect(readFileSync(join(workspace, 'process-id'), 'utf8')).toBe(pid);
    await coordinator.send('workspace-a', terminal!.name, 'finish\n');
    const finalEvents: ProtectedTerminalEvent[] = [];
    for await (const event of resumed) finalEvents.push(event);
    const resumedOutput = finalEvents.filter((event) => event.type === 'output').map((event) => event.data).join('');
    expect(resumedOutput).toContain('COMPLETE');
    expect(resumedOutput).not.toContain(outputCanary);
    expect(resumedOutput).not.toContain('First code:');
    expect(finalEvents.filter((event) => event.type === 'complete')).toEqual([{ type: 'complete', exitCode: 0 }]);
    expect(finalEvents.at(-2)).toEqual({ type: 'state', steps: [{ id: 'auth', status: 'succeeded', exitCode: 0 }] });
    expect(finalEvents.at(-1)).toEqual({ type: 'complete', exitCode: 0 });
    const result = await execution;
    reconnect.abort();
    await resumed.return();
    expect(result.exitCode).toBe(0);
    expect(result.steps.map((step) => ({ id: step.id, exitCode: step.exitCode }))).toEqual([{ id: 'auth', exitCode: 0 }]);
    expect(JSON.parse(readFileSync(bindingsPath, 'utf8'))).toEqual({ bindings: { resource: 'fixture-resource' } });
    const completionController = new AbortController();
    const completion = coordinator.events('workspace-a', terminal!.name, null, completionController.signal);
    let ended = false;
    for await (const event of completion) {
      if (event.type !== 'resync' && event.value.terminals.some((entry) => entry.name === terminal!.name && entry.state === 'exited')) {
        ended = true;
        completionController.abort();
        break;
      }
    }
    expect(ended).toBe(true);
    const safeRead = await coordinator.read('workspace-a', terminal!.name, null);
    const journal = database.orm.all(sql`SELECT body FROM terminal_stream_heads UNION ALL SELECT body FROM terminal_stream_changes`);
    const retained = JSON.stringify({ result, durableOutput, safeRead, journal }) + retainedFiles(getDaemonRuntimeDir(workspace)) + readFileSync(join(workspace, 'runner.log'), 'utf8');
    expect(retained).not.toContain(inputCanary);
    expect(retained).not.toContain(outputCanary);
    const hub = await daemonClientForProject(workspace);
    const logs = await hub.request({ op: 'logs', name: terminal!.name, lines: 1_000, head: true, follow: false, timeoutMs: 5_000 });
    expect(JSON.stringify(logs)).not.toContain(outputCanary);
    expect(JSON.stringify(logs)).not.toContain(inputCanary);
    await expect(coordinator.send('workspace-a', terminal!.name, 'must-not-run\n')).rejects.toThrow();
  }, 25_000);

  it('delivers fast ordered steps and the final private UTF-8 stderr bytes before one failed completion', async () => {
    const { coordinator, workspace, database } = fixture();
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
    const events: ProtectedTerminalEvent[] = [];
    for await (const event of coordinator.live('workspace-a', 'life-protected-fast', new AbortController().signal)) events.push(event);
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
    const journal = database.orm.all(sql`SELECT body FROM terminal_stream_heads UNION ALL SELECT body FROM terminal_stream_changes`);
    const retained = JSON.stringify({ result, durableOutput, safeRead, journal }) + retainedFiles(getDaemonRuntimeDir(workspace)) + readFileSync(join(workspace, 'runner.log'), 'utf8');
    for (const line of lines) expect(retained).not.toContain(line);
  }, 25_000);

  it('cancels the script and its background child without creating a replacement shell', async () => {
    const { coordinator, workspace } = fixture();
    const started = Promise.withResolvers<void>();
    const execution = coordinator.runLifecyclePlan('workspace-a', 'workspace/materialize', [{
      id: 'waiting', kind: 'script', command: '/approved/wait.sh',
      content: 'sleep 300 &\nprintf "%s" "$!" > child-id\nprintf "Ready: "\nread -r answer\nwait',
    }], { PATH: process.env.PATH ?? '' }, { interactive: true, runId: 'protected-cancel', deadlineAt: new Date(Date.now() + 15_000).toISOString(), onStarted: async () => started.resolve() });
    await Promise.race([started.promise, execution.then(() => { throw new Error('Runner exited before attach'); })]);
    const controller = new AbortController();
    const stream = coordinator.live('workspace-a', 'life-protected-cancel', controller.signal);
    await until(stream, (text) => text.includes('Ready:'));
    const child = Number(readFileSync(join(workspace, 'child-id'), 'utf8'));
    expect(alive(child)).toBe(true);
    await coordinator.cancelLifecycleRun('workspace-a', 'life-protected-cancel');
    const result = await execution;
    controller.abort();
    await stream.return();
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
