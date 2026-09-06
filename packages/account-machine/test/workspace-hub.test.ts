import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitSpaceDatabase } from '@gitspace/core';
import { closeDaemonClients, daemonClientForProject } from '@oh-my-pi/pi-coding-agent/launch/client';
import { WorkspaceHubTerminalCoordinator } from '../src/workspace-hub.js';

const roots: string[] = [];
afterEach(async () => {
  await closeDaemonClients();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceHubTerminalCoordinator', () => {
  it('creates, attaches, writes, and stops a real OMP Hub PTY', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-workspace-hub-'));
    roots.push(root);
    const repositoryPath = join(root, 'repo');
    const workspacePath = join(root, 'workspace');
    mkdirSync(repositoryPath, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });

    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    expect(database.createProject({ id: 'project-a', name: 'GitSpace', repositoryPath }).status).toBe('ok');
    expect(database.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'agent-blame', branch: 'feature/test', rootPath: workspacePath }).status).toBe('ok');
    expect(database.possessSpace('workspace-a', 'machine-a').status).toBe('ok');

    const coordinator = new WorkspaceHubTerminalCoordinator(database, 'machine-a');
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

    const protectedRun = await coordinator.runLifecyclePlan('workspace-a', 'machine/prepare', [{
      id: 'protected',
      kind: 'script',
      command: '/untrusted/path-is-not-read.sh',
      content: 'set -euo pipefail; printf provider-; sleep 0.05; printf credential; printf "\\n%s\\n" "${HOME-unset}"',
    }], { PATH: process.env.PATH ?? '', TOKEN: 'provider-credential' }, { redactNames: ['TOKEN'] });
    expect(protectedRun.steps).toEqual([{ id: 'protected', exitCode: 0, output: '[redacted]\nunset' }]);
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

    const closing = database.beginSpaceClose({ spaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 1 });
    if (closing.status === 'error') throw closing.error;
    const closed = database.commitSpaceClosed({ spaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 1 });
    if (closed.status === 'error') throw closed.error;
    await coordinator.stopOwned('workspace-a');
    const hub = await daemonClientForProject(workspacePath);
    const described = await hub.request({ op: 'describe', name: terminal.name });
    expect(described.op).toBe('describe');
    if (described.op !== 'describe') throw new Error('Expected Hub describe response');
    expect(described.daemon.state).toBe('exited');

  }, 20_000);
});
