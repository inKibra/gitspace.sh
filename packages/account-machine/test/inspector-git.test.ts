import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readRepositoryDiff,
  readRepositoryFile,
  readRepositoryStatus,
  readRepositoryTree,
  type InspectorRepositoryContext,
} from '../src/inspector-git.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...Bun.env,
      GIT_AUTHOR_NAME: 'Inspector Test',
      GIT_AUTHOR_EMAIL: 'inspector@gitspace.invalid',
      GIT_COMMITTER_NAME: 'Inspector Test',
      GIT_COMMITTER_EMAIL: 'inspector@gitspace.invalid',
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fixture(): InspectorRepositoryContext & { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-inspector-git-'));
  roots.push(root);
  const repositoryPath = join(root, 'repository');
  mkdirSync(repositoryPath);
  git(repositoryPath, 'init', '-b', 'main');
  writeFileSync(join(repositoryPath, 'file.txt'), 'base\n');
  writeFileSync(join(repositoryPath, 'unchanged.txt'), 'same\n');
  git(repositoryPath, 'add', '.');
  git(repositoryPath, 'commit', '-m', 'base');
  git(repositoryPath, 'switch', '-c', 'feature/inspector');
  writeFileSync(join(repositoryPath, 'file.txt'), 'head\n');
  git(repositoryPath, 'add', 'file.txt');
  git(repositoryPath, 'commit', '-m', 'head change');
  writeFileSync(join(repositoryPath, 'file.txt'), 'staged\n');
  git(repositoryPath, 'add', 'file.txt');
  writeFileSync(join(repositoryPath, 'file.txt'), 'working\n');
  writeFileSync(join(repositoryPath, 'untracked.txt'), 'untracked\n');
  writeFileSync(join(root, 'outside-secret.txt'), 'secret that must not be followed\n');
  symlinkSync('../outside-secret.txt', join(repositoryPath, 'outside-link'));
  return { root, repositoryPath, spaceId: 'space-a', generation: 7, baseRef: 'main' };
}

describe('Inspector Git reads', () => {
  it('reads current, working, staged, and base identities without changing repository state', async () => {
    const context = fixture();
    const before = git(context.repositoryPath, 'status', '--porcelain=v1');
    const base = await readRepositoryFile({ ...context, mode: 'base', path: 'file.txt' });
    const staged = await readRepositoryFile({ ...context, mode: 'staged', path: 'file.txt' });
    const working = await readRepositoryFile({ ...context, mode: 'working', path: 'file.txt' });
    const current = await readRepositoryFile({ ...context, mode: 'current', path: 'file.txt' });

    expect(base.content).toBe('base\n');
    expect(staged.content).toBe('staged\n');
    expect(working.content).toBe('working\n');
    expect(current.content).toBe('working\n');
    expect(base.commitId).not.toBe(current.headCommit);
    expect(staged.blobId).not.toBe(current.blobId);
    expect([base, staged, working, current].every((file) => file.spaceId === 'space-a' && file.generation === 7)).toBe(true);
    expect(git(context.repositoryPath, 'status', '--porcelain=v1')).toBe(before);
  });

  it('returns mode-specific status, tree, and parseable patches including untracked files', async () => {
    const context = fixture();
    const before = git(context.repositoryPath, 'status', '--porcelain=v1');
    const workingStatus = await readRepositoryStatus({ ...context, mode: 'working' });
    const stagedStatus = await readRepositoryStatus({ ...context, mode: 'staged' });
    const baseStatus = await readRepositoryStatus({ ...context, mode: 'base' });
    expect(workingStatus.map((entry) => entry.path)).toEqual(['file.txt', 'outside-link', 'untracked.txt']);
    expect(stagedStatus).toEqual([expect.objectContaining({ path: 'file.txt', staged: true, working: true })]);
    expect(baseStatus.map((entry) => entry.path)).toContain('untracked.txt');

    const tree = await readRepositoryTree({ ...context, mode: 'current' });
    expect(tree).toContainEqual(expect.objectContaining({ path: 'untracked.txt', status: 'untracked', kind: 'file', generation: 7 }));
    expect(tree).toContainEqual(expect.objectContaining({ path: 'outside-link', kind: 'symlink' }));

    const currentDiff = await readRepositoryDiff({ ...context, mode: 'current', path: 'file.txt' });
    const workingDiff = await readRepositoryDiff({ ...context, mode: 'working' });
    const stagedDiff = await readRepositoryDiff({ ...context, mode: 'staged' });
    const baseDiff = await readRepositoryDiff({ ...context, mode: 'base' });
    expect(currentDiff.patch).toContain('@@ -1,1 +1,1 @@');
    expect(workingDiff.patch).toContain('+working');
    expect(workingDiff.patch).toContain('untracked.txt');
    expect(stagedDiff.patch).toContain('+staged');
    expect(stagedDiff.patch).not.toContain('+working');
    expect(baseDiff.patch).toContain('+working');
    expect(baseDiff.baseCommit).not.toBe(baseDiff.headCommit);
    expect(git(context.repositoryPath, 'status', '--porcelain=v1')).toBe(before);
  });

  it('rejects escaping paths and never follows worktree symlinks', async () => {
    const context = fixture();
    await expect(readRepositoryFile({ ...context, mode: 'current', path: '../outside-secret.txt' })).rejects.toThrow('outside');
    await expect(readRepositoryTree({ ...context, mode: 'current', path: '.git/config' })).rejects.toThrow('portable repository path');
    const symlink = await readRepositoryFile({ ...context, mode: 'current', path: 'outside-link' });
    expect(symlink.kind).toBe('symlink');
    expect(symlink.content).toBe('../outside-secret.txt');
    expect(symlink.content).not.toContain('secret that must not be followed');
  });
});
