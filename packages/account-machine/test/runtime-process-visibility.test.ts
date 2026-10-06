import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProcessSupervisor } from '@gitspace/supervisor';
import { workspaceProcessVisible } from '../src/runtime-operations.js';

test('workspace process visibility spans generations and user services but excludes private and neighboring workspaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-process-scope-'));
  const workspace = join(root, 'workspace');
  const sibling = join(root, 'sibling');
  await mkdir(workspace); await mkdir(sibling);
  const supervisor = new ProcessSupervisor(join(root, 'supervisor'));
  await supervisor.recover();
  try {
    for (const [name, owner, cwd, visibility] of [
      ['prior-agent', 'runtime:old-attachment:1', workspace, 'public'],
      ['user-terminal', 'gitspace:workspace:user', workspace, 'public'],
      ['service', 'gitspace:workspace:service:web', workspace, 'public'],
      ['private', 'infrastructure', workspace, 'private'],
      ['neighbor', 'runtime:other-attachment:1', sibling, 'public'],
    ] as const) {
      await supervisor.request({ op: 'start', owner, spec: { name, application: '/bin/sleep', args: ['30'], env: {}, cwd, visibility, pty: false, restart: 'no', persist: true, detached: false } });
      const described = await supervisor.request({ op: 'describe', name });
      if (described.op !== 'describe') throw new Error('Unexpected supervisor response');
      expect(await workspaceProcessVisible(workspace, described)).toBe(name !== 'private' && name !== 'neighbor');
    }
  } finally { await supervisor.request({ op: 'shutdown' }); await rm(root, { recursive: true, force: true }); }
}, 10000);
