import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MachineDiscardGate, localWorkDigest } from '../src/machine-discard.js';

describe('machine-local discard authorization', () => {
  const workspaces = [{ projectId: 'project-a', workspaceId: 'workspace-a', generation: 3, reason: 'unpublished-local-work' as const }];
  it('requires the exact issued machine, operation and unchanged local-work confirmation', () => {
    const gate = new MachineDiscardGate('machine-a');
    const refusal = gate.require('sleep', 'work-digest-a', workspaces);
    expect(() => gate.require('sleep', 'work-digest-a', workspaces, { ...refusal.confirmation, token: 'forged' })).toThrow();
    expect(() => gate.require('sleep', 'work-digest-a', workspaces, { ...refusal.confirmation, machineId: 'machine-b' })).toThrow();
    expect(() => gate.require('destroy', 'work-digest-a', workspaces, refusal.confirmation)).toThrow();
    expect(() => gate.require('sleep', 'work-digest-b', workspaces, refusal.confirmation)).toThrow();
    const changed = gate.require('sleep', 'work-digest-b', workspaces);
    expect(changed.confirmation.token).not.toBe(refusal.confirmation.token);
    expect(gate.require('sleep', 'work-digest-b', workspaces, changed.confirmation)).toBeNull();
    expect(() => gate.require('sleep', 'work-digest-b', workspaces, changed.confirmation)).toThrow();
  });
});

it('invalidates confirmation when a worktree index or unreachable local Git object changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-discard-digest-'));
  const repository = join(root, 'repository');
  const worktree = join(root, 'worktree');
  mkdirSync(repository);
  const git = (cwd: string, ...args: string[]) => {
    const child = Bun.spawnSync(['git', ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  };
  try {
    git(repository, 'init', '-b', 'main');
    writeFileSync(join(repository, 'tracked.txt'), 'seed\n');
    git(repository, 'add', '.');
    git(repository, '-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '-m', 'seed');
    git(repository, 'worktree', 'add', '-b', 'work', worktree);
    const original = await localWorkDigest([worktree], { generation: 1 });
    writeFileSync(join(root, 'unreachable.txt'), 'unreachable local blob\n');
    git(worktree, 'hash-object', '-w', join(root, 'unreachable.txt'));
    const withObject = await localWorkDigest([worktree], { generation: 1 });
    expect(withObject).not.toBe(original);
    writeFileSync(join(worktree, 'tracked.txt'), 'edited\n');
    git(worktree, 'add', 'tracked.txt');
    const staged = await localWorkDigest([worktree], { generation: 1 });
    git(worktree, 'reset', '--', 'tracked.txt');
    expect(await localWorkDigest([worktree], { generation: 1 })).not.toBe(staged);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
