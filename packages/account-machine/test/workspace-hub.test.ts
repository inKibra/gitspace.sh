import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { terminalStreamResource, type MachineLiveNotice } from '@gitspace/protocol';
import { closeDaemonClients, daemonClientForProject } from '@gitspace/supervisor';
import { WorkspaceHubTerminalCoordinator, type WorkspaceCheckouts } from '../src/workspace-hub.js';
import type { TerminalSnapshot } from '../src/terminal-stream.js';

/** Every live notice a coordinator announces. */
class NoticeLog {
  readonly notices: MachineLiveNotice[] = [];
  private arrived = Promise.withResolvers<void>();
  readonly notify = (notice: MachineLiveNotice): void => {
    this.notices.push(notice);
    this.arrived.resolve();
    this.arrived = Promise.withResolvers<void>();
  };
  cursors(resource: string): number[] {
    return this.notices.filter((notice) => notice.resource === resource).map((notice) => notice.cursor);
  }
  /** The first notice about `resource` newer than `after`, once announced. */
  async next(resource: string, after: number): Promise<MachineLiveNotice> {
    for (;;) {
      const found = this.notices.find((notice) => notice.resource === resource && notice.cursor > after);
      if (found) return found;
      await this.arrived.promise;
    }
  }
}

/** Reads as a tab does: after its cursor, and again on each notice, until a snapshot satisfies `accept`. Every read
 * returns only events newer than the cursor it was given. */
async function follow(coordinator: WorkspaceHubTerminalCoordinator, log: NoticeLog, name: string | null, after: number | null, accept: (snapshot: TerminalSnapshot) => boolean): Promise<{ cursor: number; snapshot: TerminalSnapshot }> {
  let cursor = after;
  for (;;) {
    for (const event of await coordinator.events('workspace-a', name, cursor)) {
      if (cursor !== null) expect(event.cursor).toBeGreaterThan(cursor);
      if (event.type === 'resync') continue;
      cursor = event.cursor;
      if (accept(event.value)) return { cursor, snapshot: event.value };
    }
    await log.next(terminalStreamResource('workspace-a', 'machine-a', name), cursor ?? 0);
  }
}

/** Ready checkouts of project-a by workspace id. */
function checkouts(held = new Map<string, string>(), use: WorkspaceCheckouts['use'] = async () => {}): WorkspaceCheckouts {
  return {
    path: (spaceId) => held.get(spaceId) ?? null,
    projectId: (spaceId) => held.has(spaceId) ? 'project-a' : null,
    list: () => [...held.keys()],
    use,
    changed: async () => {},
  };
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots) {
    const client = await daemonClientForProject(join(root, 'workspace'));
    await client.request({ op: 'shutdown' });
  }
  await closeDaemonClients();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceHubTerminalCoordinator', () => {
  it('runs workspace hooks in an attached cache checkout that the machine does not hold as a space', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-workspace-hub-cache-'));
    roots.push(root);
    const checkout = join(root, 'workspace');
    mkdirSync(checkout, { recursive: true });
    const coordinator = new WorkspaceHubTerminalCoordinator('machine-a', checkouts());
    const result = await coordinator.runLifecyclePlan('cloud-workspace', 'workspace/materialize', [{
      id: 'materialize', kind: 'script', command: '/approved/materialize.sh', content: "printf 'materialized' > marker",
    }], { PATH: process.env.PATH ?? '' }, { directory: checkout });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(checkout, 'marker'), 'utf8')).toBe('materialized');
  }, 20_000);

  it('cancels a cache lifecycle run by its checkout without a held space', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-workspace-hub-cancel-'));
    roots.push(root);
    const checkout = join(root, 'workspace');
    mkdirSync(checkout, { recursive: true });
    const coordinator = new WorkspaceHubTerminalCoordinator('machine-a', checkouts());
    const started = Promise.withResolvers<void>();
    const execution = coordinator.runLifecyclePlan('cloud-workspace', 'workspace/materialize', [{
      id: 'wait', kind: 'script', command: '/approved/wait.sh', content: 'sleep 30',
    }], { PATH: process.env.PATH ?? '' }, { directory: checkout, runId: 'cache-cancel', onStarted: async () => started.resolve() });
    await started.promise;
    await coordinator.cancelLifecycleRun('cloud-workspace', 'life-cache-cancel', checkout);
    expect((await execution).exitCode).not.toBe(0);
  }, 20_000);

  it('creates, attaches, writes, and stops a real GitSpace supervisor PTY', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-workspace-hub-'));
    roots.push(root);
    const workspacePath = join(root, 'workspace');
    mkdirSync(workspacePath, { recursive: true });

    const coordinator = new WorkspaceHubTerminalCoordinator('machine-a', checkouts(new Map([['workspace-a', workspacePath]])));
    const terminal = await coordinator.createShell('workspace-a');
    expect(terminal.kind).toBe('user');
    expect(terminal.cwd).toBe(workspacePath);
    expect(terminal.owner).toBe('gitspace:workspace-a:user');
    expect((await coordinator.list('workspace-a')).map((item) => item.name)).toContain(terminal.name);

    await coordinator.send('workspace-a', terminal.name, "printf 'hub-ready\\n'\r");
    let rendered = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      rendered = (await coordinator.read('workspace-a', terminal.name, null)).data;
      if (rendered.includes('hub-ready')) break;
      await Bun.sleep(25);
    }
    expect(rendered).toContain('hub-ready');

    const lifecycle = await coordinator.runLifecyclePlan('workspace-a', 'checks', [
      { id: 'first', kind: 'check', command: "printf 'first\\n'" },
      { id: 'second', kind: 'check', command: "printf 'second\\n'" },
    ], { PATH: process.env.PATH ?? '' });
    expect(lifecycle.exitCode).toBe(0);
    expect(lifecycle.steps).toEqual([
      { id: 'first', exitCode: 0, output: 'first' },
      { id: 'second', exitCode: 0, output: 'second' },
    ]);

    const lifecycleHome = join(root, 'lifecycle-home');
    mkdirSync(lifecycleHome);
    writeFileSync(join(lifecycleHome, 'config'), 'home-visible');
    const protectedRun = await coordinator.runLifecyclePlan('workspace-a', 'machine/prepare', [{
      id: 'protected',
      kind: 'script',
      command: '/untrusted/path-is-not-read.sh',
      content: 'set -euo pipefail; printf provider-; sleep 0.05; printf credential; printf "\\n"; cat "$HOME/config"',
    }], { PATH: process.env.PATH ?? '', HOME: lifecycleHome, TOKEN: 'provider-credential' }, { redactNames: ['TOKEN'] });
    expect(protectedRun.steps).toEqual([{ id: 'protected', exitCode: 0, output: '[redacted]\nhome-visible' }]);
    const protectedLogs = await coordinator.read('workspace-a', protectedRun.terminalName, null);
    expect(protectedLogs.data).not.toContain('provider-credential');
    expect(protectedLogs.data).toContain('[redacted]');

    let completeLog = '';
    const verbose = await coordinator.runLifecyclePlan('workspace-a', 'checks', [{
      id: 'verbose', kind: 'check',
      command: 'i=0; while [ "$i" -lt 60000 ]; do printf "safe-line\\n"; i=$((i+1)); done; printf "complete\\n"',
    }], { PATH: process.env.PATH ?? '' }, { onOutput: async (output) => { completeLog += output; } });
    expect(completeLog.split('safe-line\n').length - 1).toBe(60000);
    expect(verbose.steps.map(({ id, exitCode }) => ({ id, exitCode }))).toEqual([{ id: 'verbose', exitCode: 0 }]);
    expect(verbose.steps[0]!.output.endsWith('complete')).toBe(true);

    await coordinator.stopOwned('workspace-a');
    const hub = await daemonClientForProject(workspacePath);
    const described = await hub.request({ op: 'describe', name: terminal.name });
    expect(described.op).toBe('describe');
    if (described.op !== 'describe') throw new Error('Expected Hub describe response');
    expect(described.daemon.state).toBe('exited');

  }, 20_000);

  it('starts a user shell in the ready cache checkout with the bundle terminal PATH and variables', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-workspace-hub-'));
    roots.push(root);
    const cachePath = join(root, 'workspace');
    mkdirSync(join(cachePath, '.gitspace'), { recursive: true });
    mkdirSync(join(cachePath, 'tools', 'bin'), { recursive: true });
    writeFileSync(join(cachePath, '.gitspace', 'bundle.json'), JSON.stringify({ version: 1, profiles: { base: {} }, terminal: { path: ['tools/bin'], env: { HUB_FIXTURE_GREETING: 'bundle-env' } } }));
    writeFileSync(join(cachePath, 'tools', 'bin', 'hub-fixture-tool'), "#!/bin/sh\nprintf 'bundle-tool:%s\\n' \"$HUB_FIXTURE_GREETING\"\n", { mode: 0o755 });
    // Only the workspace's ready cache checkout can host the shell.
    const used: string[] = [];
    const coordinator = new WorkspaceHubTerminalCoordinator('machine-a', checkouts(new Map([['workspace-a', cachePath]]), async (spaceId) => { used.push(spaceId); }));
    const terminal = await coordinator.createShell('workspace-a');
    expect(used).toEqual(['workspace-a']);
    expect(terminal).toMatchObject({ kind: 'user', cwd: cachePath, machineId: 'machine-a' });

    await coordinator.send('workspace-a', terminal.name, 'hub-fixture-tool; exit\r');
    const hub = await daemonClientForProject(cachePath);
    const exited = await hub.request({ op: 'wait', name: terminal.name, for: 'exit', timeoutMs: 10_000 });
    expect(exited).toMatchObject({ op: 'wait', timedOut: false });
    expect((await coordinator.read('workspace-a', terminal.name, null)).data).toContain('bundle-tool:bundle-env');
  }, 20_000);

  it('announces each commit of an observed cache shell and its output, and stops observing what nobody watches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-workspace-hub-stream-'));
    roots.push(root);
    const cachePath = join(root, 'workspace');
    mkdirSync(cachePath, { recursive: true });
    const log = new NoticeLog();
    const coordinator = new WorkspaceHubTerminalCoordinator('machine-a', checkouts(new Map([['workspace-a', cachePath]])), undefined, log.notify);
    const inventory = terminalStreamResource('workspace-a', 'machine-a', null);
    const [initial] = await coordinator.events('workspace-a', null, null);
    expect(initial).toMatchObject({ type: 'snapshot', value: { terminals: [], output: null } });
    // The first observation is one commit, announced once; at the head there is nothing newer.
    expect(log.notices).toEqual([{ workspace: 'workspace-a', resource: inventory, cursor: initial!.cursor }]);
    expect(await coordinator.events('workspace-a', null, initial!.cursor)).toEqual([]);

    const terminal = await coordinator.createShell('workspace-a');
    const listed = await follow(coordinator, log, null, initial!.cursor, (snapshot) => snapshot.terminals.length > 0);
    expect(listed.snapshot.terminals.map((entry) => entry.name)).toEqual([terminal.name]);
    expect(log.cursors(inventory)).toContain(listed.cursor);
    expect(new Set(log.cursors(inventory)).size).toBe(log.cursors(inventory).length);

    const selected = terminalStreamResource('workspace-a', 'machine-a', terminal.name);
    const attached = await follow(coordinator, log, terminal.name, null, (snapshot) => snapshot.output?.name === terminal.name);
    await coordinator.send('workspace-a', terminal.name, "printf 'stream-%s\\n' delivered\r");
    const output = await follow(coordinator, log, terminal.name, attached.cursor, (snapshot) => snapshot.output?.data.includes('stream-delivered') === true);
    expect(output.snapshot.terminals.map((entry) => entry.name)).toEqual([terminal.name]);
    try {
      // Unwatched at a cursor a read has returned: its reader may be subscribing, so the observer keeps announcing.
      coordinator.unwatched(inventory, listed.cursor);
      const announced = Math.max(...log.cursors(inventory));
      const second = await coordinator.createShell('workspace-a');
      await log.next(inventory, announced);
      // Unwatched at a change no read has returned: the observer stops, and changes go unannounced.
      const stoppedAt = Math.max(...log.cursors(inventory));
      coordinator.unwatched(inventory, stoppedAt);
      await coordinator.send('workspace-a', second.name, 'exit\r');
      await follow(coordinator, log, terminal.name, output.cursor, (snapshot) => !snapshot.terminals.some((entry) => entry.name === second.name));
      // An absent commit has no event to await; give a still-running observer the same supervisor wake time to show itself.
      await Bun.sleep(200);
      expect(log.cursors(inventory).filter((cursor) => cursor > stoppedAt)).toEqual([]);
      // The next read observes again and returns only what changed after its cursor, announcing the change.
      const resumed = await coordinator.events('workspace-a', null, stoppedAt);
      expect(resumed.map((event) => event.type)).toEqual(['change']);
      expect(resumed[0]).toMatchObject({ previous: stoppedAt, value: { terminals: [{ name: terminal.name }] } });
      expect(log.cursors(inventory).filter((cursor) => cursor > stoppedAt)).toEqual([resumed[0]!.cursor]);
      await coordinator.send('workspace-a', terminal.name, 'exit\r');
      await follow(coordinator, log, null, resumed[0]!.cursor, (snapshot) => snapshot.terminals.length === 0);
    } finally {
      coordinator.unwatched(inventory, Number.MAX_SAFE_INTEGER);
      coordinator.unwatched(selected, Number.MAX_SAFE_INTEGER);
    }
  }, 20_000);
});
