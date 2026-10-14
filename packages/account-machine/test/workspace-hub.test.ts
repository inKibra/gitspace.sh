import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StreamEvent } from '@gitspace/protocol-sync';
import { closeDaemonClients, daemonClientForProject } from '@gitspace/supervisor';
import { WorkspaceHubTerminalCoordinator, type WorkspaceCheckouts } from '../src/workspace-hub.js';
import type { TerminalSnapshot } from '../src/terminal-stream.js';

async function observe(events: AsyncGenerator<StreamEvent<TerminalSnapshot>>, accept: (snapshot: TerminalSnapshot) => boolean): Promise<TerminalSnapshot> {
  for (;;) {
    const event = await events.next();
    if (event.done) throw new Error('Terminal stream ended');
    if (event.value.type !== 'resync' && accept(event.value.value)) return event.value.value;
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

  it('streams a cache checkout shell and its output to subscribers that started before the shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-workspace-hub-stream-'));
    roots.push(root);
    const cachePath = join(root, 'workspace');
    mkdirSync(cachePath, { recursive: true });
    const coordinator = new WorkspaceHubTerminalCoordinator('machine-a', checkouts(new Map([['workspace-a', cachePath]])));
    const controller = new AbortController();
    const inventory = coordinator.events('workspace-a', null, null, controller.signal);
    try {
      expect(await observe(inventory, () => true)).toEqual({ terminals: [], output: null });
      const terminal = await coordinator.createShell('workspace-a');
      const listed = await observe(inventory, (snapshot) => snapshot.terminals.length > 0);
      expect(listed.terminals.map((entry) => entry.name)).toEqual([terminal.name]);

      const selected = coordinator.events('workspace-a', terminal.name, null, controller.signal);
      try {
        await observe(selected, (snapshot) => snapshot.output?.name === terminal.name);
        await coordinator.send('workspace-a', terminal.name, "printf 'stream-%s\\n' delivered\r");
        const output = await observe(selected, (snapshot) => snapshot.output?.data.includes('stream-delivered') === true);
        expect(output.terminals.map((entry) => entry.name)).toEqual([terminal.name]);

        await coordinator.send('workspace-a', terminal.name, 'exit\r');
        await observe(inventory, (snapshot) => snapshot.terminals.length === 0);
      } finally {
        await selected.return(undefined);
      }
    } finally {
      controller.abort();
      await inventory.return(undefined);
    }
  }, 20_000);
});
