import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitSpaceDatabase } from '@gitspace/core';
import { closeDaemonClients } from '@oh-my-pi/pi-coding-agent/launch/client';
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

    const stopped = await coordinator.stop('workspace-a', terminal.name);
    expect(['exited', 'failed']).toContain(stopped.state);
  }, 20_000);
});
