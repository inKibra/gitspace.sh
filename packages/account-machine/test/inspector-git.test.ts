import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readRepositoryDiff,
  readRepositoryFile,
  readRepositoryIdentity,
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
  return { root, repositoryPath, spaceId: 'space-a', generation: 7 };
}

describe('Portable Inspector Git reads', () => {
  it('reads ordinary repository views with no base ref or base checkout', async () => {
    const context = fixture();
    git(context.repositoryPath, 'branch', '-D', 'main');
    const headCommit = git(context.repositoryPath, 'rev-parse', 'HEAD');

    expect(await readRepositoryIdentity(context)).toEqual({ headCommit });
    expect(await readRepositoryStatus({ ...context, mode: 'working' })).toContainEqual(expect.objectContaining({ path: 'file.txt', working: true }));
    expect(await readRepositoryTree({ ...context, mode: 'current' })).toContainEqual(expect.objectContaining({ path: 'untracked.txt', status: 'untracked' }));
    expect(await readRepositoryFile({ ...context, mode: 'staged', path: 'file.txt' })).toMatchObject({ content: 'staged\n', commitId: headCommit });
    const diff = await readRepositoryDiff({ ...context, mode: 'working', path: 'file.txt' });
    expect(diff).toMatchObject({ baseCommit: headCommit, headCommit });
    expect(diff.patch).toContain('-staged\n+working\n');
  });

  it('ignores invalid base refs outside base mode and requires one explicitly in base mode', async () => {
    const context = fixture();
    const invalidBase = { ...context, baseRef: '--invalid base' };
    const headCommit = git(context.repositoryPath, 'rev-parse', 'HEAD');

    expect(await readRepositoryIdentity(invalidBase)).toEqual({ headCommit });
    expect(await readRepositoryFile({ ...invalidBase, mode: 'current', path: 'file.txt' })).toMatchObject({ content: 'working\n', headCommit });
    expect(await readRepositoryStatus({ ...invalidBase, mode: 'working' })).toContainEqual(expect.objectContaining({ path: 'file.txt', working: true }));
    const staged = await readRepositoryDiff({ ...invalidBase, mode: 'staged', path: 'file.txt' });
    expect(staged.patch).toContain('-head\n+staged\n');

    await expect(readRepositoryStatus({ ...context, mode: 'base' })).rejects.toThrow('Base mode requires a base ref');
    await expect(readRepositoryTree({ ...context, mode: 'base' })).rejects.toThrow('Base mode requires a base ref');
    await expect(readRepositoryFile({ ...context, mode: 'base', path: 'file.txt' })).rejects.toThrow('Base mode requires a base ref');
    await expect(readRepositoryDiff({ ...context, mode: 'base' })).rejects.toThrow('Base mode requires a base ref');
    await expect(readRepositoryDiff({ ...invalidBase, mode: 'base' })).rejects.toThrow('Base ref is invalid');
  });

  it('compares a diverged immutable base commit locally after the base checkout is deleted', async () => {
    const context = fixture();
    const baseCommit = git(context.repositoryPath, 'rev-parse', 'main');
    const baseBlob = git(context.repositoryPath, 'rev-parse', 'main:file.txt');
    const baseCheckout = join(context.root, 'base-repository');
    git(context.root, 'clone', '--no-local', '--single-branch', '--branch', 'main', '--', context.repositoryPath, baseCheckout);
    writeFileSync(join(baseCheckout, 'file.txt'), 'advanced base\n');
    git(baseCheckout, 'add', 'file.txt');
    git(baseCheckout, 'commit', '-m', 'advance canonical base');
    const baseRef = git(baseCheckout, 'rev-parse', 'HEAD');
    git(context.repositoryPath, 'fetch', '--no-tags', '--', baseCheckout, 'refs/heads/main');
    rmSync(baseCheckout, { recursive: true, force: true });
    git(context.repositoryPath, 'branch', '-D', 'main');
    const portable = { ...context, baseRef };
    const refsBefore = git(context.repositoryPath, 'show-ref');
    const statusBefore = git(context.repositoryPath, 'status', '--porcelain=v1');

    expect(await readRepositoryTree({ ...portable, mode: 'base' })).toContainEqual(expect.objectContaining({ path: 'file.txt', blobId: baseBlob }));
    expect(await readRepositoryFile({ ...portable, mode: 'base', path: 'file.txt' })).toMatchObject({ content: 'base\n', commitId: baseCommit });
    expect(await readRepositoryStatus({ ...portable, mode: 'base' })).toContainEqual(expect.objectContaining({ path: 'file.txt', status: 'modified' }));
    const diff = await readRepositoryDiff({ ...portable, mode: 'base', path: 'file.txt' });
    expect(diff.baseCommit).toBe(baseCommit);
    expect(diff.patch).toContain('-base\n+working\n');
    expect(diff.files).toContainEqual(expect.objectContaining({ path: 'file.txt', additions: 1, deletions: 1 }));
    expect(git(context.repositoryPath, 'show-ref')).toBe(refsBefore);
    expect(git(context.repositoryPath, 'status', '--porcelain=v1')).toBe(statusBefore);
    expect(git(context.repositoryPath, 'show', ':file.txt')).toBe('staged');
    expect(await readRepositoryFile({ ...context, mode: 'current', path: 'file.txt' })).toMatchObject({ content: 'working\n' });
  });

  it('rejects missing revisions and unrelated histories rather than returning empty repository views', async () => {
    const context = fixture();
    await expect(readRepositoryDiff({ ...context, baseRef: 'missing-base', mode: 'base' })).rejects.toThrow('missing-base^{commit}');
    const unrelatedCommit = git(context.repositoryPath, 'commit-tree', 'HEAD^{tree}', '-m', 'unrelated history');
    await expect(readRepositoryDiff({ ...context, baseRef: unrelatedCommit, mode: 'base' })).rejects.toThrow('git merge-base');
    git(context.repositoryPath, 'symbolic-ref', 'HEAD', 'refs/heads/missing-head');
    await expect(readRepositoryStatus({ ...context, mode: 'working' })).rejects.toThrow('HEAD^{commit}');
  });
});

describe('Inspector Git reads', () => {
  it('reads current, working, staged, and base identities without changing repository state', async () => {
    const context = { ...fixture(), baseRef: 'main' };
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
    const context = { ...fixture(), baseRef: 'main' };
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
