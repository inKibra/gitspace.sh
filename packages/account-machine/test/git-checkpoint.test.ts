import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitIntermediateCheckpoint, restoreGitIntermediateCheckpoint, applyGitReplicaCheckpoint, readGitReplicaBase, IncrementalGitSnapshots } from '../src/git-checkpoint.js';
import type { GitIntermediateCheckpoint } from '../src/git-checkpoint.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...Bun.env,
      GIT_AUTHOR_NAME: 'GitSpace Test',
      GIT_AUTHOR_EMAIL: 'test@gitspace.invalid',
      GIT_COMMITTER_NAME: 'GitSpace Test',
      GIT_COMMITTER_EMAIL: 'test@gitspace.invalid',
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fixture(): { root: string; source: string; remote: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-git-checkpoint-'));
  roots.push(root);
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const target = join(root, 'target');
  mkdirSync(source);
  mkdirSync(target);
  git(source, 'init', '-b', 'main');
  writeFileSync(join(source, '.gitignore'), 'secret.env\ncache/\n');
  writeFileSync(join(source, 'staged.txt'), 'base\n');
  writeFileSync(join(source, 'unstaged.txt'), 'base\n');
  writeFileSync(join(source, 'deleted.txt'), 'delete\n');
  writeFileSync(join(source, 'rename-old.txt'), 'rename\n');
  writeFileSync(join(source, 'executable.sh'), '#!/bin/sh\n');
  chmodSync(join(source, 'executable.sh'), 0o755);
  symlinkSync('staged.txt', join(source, 'linked.txt'));
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'base');
  writeFileSync(join(source, 'unpublished.txt'), 'unpublished\n');
  git(source, 'add', 'unpublished.txt');
  git(source, 'commit', '-m', 'unpublished');
  writeFileSync(join(source, 'staged.txt'), 'staged\n');
  git(source, 'add', 'staged.txt');
  writeFileSync(join(source, 'unstaged.txt'), 'unstaged\n');
  git(source, 'mv', 'rename-old.txt', 'rename-new.txt');
  writeFileSync(join(source, 'rename-new.txt'), 'rename\nunstaged\n');
  rmSync(join(source, 'deleted.txt'));
  chmodSync(join(source, 'executable.sh'), 0o644);
  writeFileSync(join(source, 'portable.txt'), 'portable\n');
  writeFileSync(join(source, 'secret.env'), 'never upload\n');
  mkdirSync(join(source, 'cache'));
  writeFileSync(join(source, 'cache', 'build.bin'), 'cache\n');
  git(root, 'init', '--bare', remote);
  return { root, source, remote, target };
}

describe('Git intermediate checkpoint', () => {
  it('uses Git ignore sources, not scratch names, to select portable state', async () => {
    const { root, source } = fixture();
    const portable = ['notes.tmp', 'notes.temp', 'notes~', '.#notes', '.notes.swp', '#notes#', 'file.lock'];
    for (const path of portable) writeFileSync(join(source, path), 'portable scratch\n');
    mkdirSync(join(source, 'nested'));
    writeFileSync(join(source, 'nested/.gitignore'), 'nested-secret\n');
    writeFileSync(join(source, 'nested/nested-secret'), 'secret\n');
    writeFileSync(join(source, '.git/info/exclude'), 'info-secret\n');
    writeFileSync(join(source, 'info-secret'), 'secret\n');
    const globalIgnore = join(root, 'global-ignore');
    writeFileSync(globalIgnore, 'global-secret\nstaged.txt\n');
    git(source, 'config', 'core.excludesFile', globalIgnore);
    writeFileSync(join(source, 'global-secret'), 'secret\n');
    const checkpoint = await createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'scratch', revision: 1 });
    const paths = git(source, 'ls-tree', '-r', '--name-only', checkpoint.worktreeCommit).split('\n');
    for (const path of portable) expect(paths).toContain(path);
    for (const path of ['nested/nested-secret', 'info-secret', 'global-secret', 'secret.env', 'cache/build.bin']) expect(paths).not.toContain(path);
    expect(git(source, 'show', `${checkpoint.worktreeCommit}:staged.txt`)).toBe('staged');
  });

  it('does not publish the private checkout branch but preserves an explicit human branch switch', async () => {
    const { source } = fixture();
    let committed = await createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'branch', revision: 1 });
    const base = committed;
    git(source, 'switch', '-c', 'private-replica');
    let revision = 1;
    const publications: GitIntermediateCheckpoint[] = [];
    const snapshots = new IncrementalGitSnapshots({
      repositoryPath: source, spaceId: 'branch', allocateRevision: async () => ++revision,
      loadPending: async () => null, loadCommitted: async () => committed, savePending: async () => {},
      normalizeBranch: (branch, prior) => branch === 'private-replica' ? prior?.branch ?? branch : branch,
      publish: async checkpoint => { publications.push(checkpoint); },
      commit: async checkpoint => { committed = checkpoint; return checkpoint; },
    });
    expect(await snapshots.capture()).toEqual(base);
    expect(publications).toEqual([]);
    expect(git(source, 'branch', '--show-current')).toBe('private-replica');
    git(source, 'switch', '-c', 'human-branch');
    const changed = await snapshots.capture();
    expect(changed.branch).toBe('human-branch');
    expect(publications).toEqual([changed]);
    expect(git(source, 'branch', '--show-current')).toBe('human-branch');
  });

  it('applies cloud state while preserving later human edits and ignored files', async () => {
    const { source, remote, target } = fixture();
    const base = await createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'replica', revision: 1 });
    git(source, 'push', remote, `${base.checkpointRef}:${base.checkpointRef}`);
    git(target, 'init', '-b', 'main');
    git(target, 'fetch', remote, `${base.checkpointRef}:${base.checkpointRef}`);
    await restoreGitIntermediateCheckpoint({ repositoryPath: target, checkpoint: base, branch: 'main' });
    expect(await readGitReplicaBase(target)).toEqual(base);
    writeFileSync(join(source, 'staged.txt'), 'cloud staged\n');
    git(source, 'add', 'staged.txt');
    git(source, 'commit', '-m', 'cloud commit');
    writeFileSync(join(source, 'portable.txt'), 'cloud portable\n');
    const incoming = await createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'replica', revision: 2 });
    git(source, 'push', remote, `${incoming.checkpointRef}:${incoming.checkpointRef}`);
    git(target, 'fetch', remote, `${incoming.checkpointRef}:${incoming.checkpointRef}`);
    writeFileSync(join(target, 'unstaged.txt'), 'later human edit\n');
    writeFileSync(join(target, 'secret.env'), 'local secret\n');
    await applyGitReplicaCheckpoint({ repositoryPath: target, previous: base, checkpoint: incoming });
    expect(await Bun.file(join(target, 'portable.txt')).text()).toBe('cloud portable\n');
    expect(await Bun.file(join(target, 'unstaged.txt')).text()).toBe('later human edit\n');
    expect(await Bun.file(join(target, 'secret.env')).text()).toBe('local secret\n');
    if (incoming.headCommit === null) throw new Error('Committed cloud fixture lost HEAD');
    expect(git(target, 'rev-parse', 'HEAD')).toBe(incoming.headCommit);
    expect(git(target, 'write-tree')).toBe(incoming.indexTree);
    const human = await createGitIntermediateCheckpoint({ repositoryPath: target, spaceId: 'human', revision: 1 });
    expect(git(target, 'show', `${human.worktreeCommit}:unstaged.txt`)).toBe('later human edit');
    expect(git(target, 'show', `${human.worktreeCommit}:portable.txt`)).toBe('cloud portable');
  });

  it('refuses overlapping concurrent human edits without modifying the index or HEAD', async () => {
    const { source, remote, target } = fixture();
    const base = await createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'conflict', revision: 1 });
    git(source, 'push', remote, `${base.checkpointRef}:${base.checkpointRef}`);
    git(target, 'init', '-b', 'main');
    git(target, 'fetch', remote, `${base.checkpointRef}:${base.checkpointRef}`);
    await restoreGitIntermediateCheckpoint({ repositoryPath: target, checkpoint: base, branch: 'main' });
    writeFileSync(join(source, 'unstaged.txt'), 'cloud edit\n');
    const incoming = await createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'conflict', revision: 2 });
    git(source, 'push', remote, `${incoming.checkpointRef}:${incoming.checkpointRef}`);
    git(target, 'fetch', remote, `${incoming.checkpointRef}:${incoming.checkpointRef}`);
    writeFileSync(join(target, 'unstaged.txt'), 'human edit\n');
    await expect(applyGitReplicaCheckpoint({ repositoryPath: target, previous: base, checkpoint: incoming })).rejects.toThrow();
    expect(await Bun.file(join(target, 'unstaged.txt')).text()).toBe('human edit\n');
    expect(git(target, 'write-tree')).toBe(base.indexTree);
    if (base.headCommit === null) throw new Error('Committed base fixture lost HEAD');
    expect(git(target, 'rev-parse', 'HEAD')).toBe(base.headCommit);
  });

  it('restores unborn staged and unstaged state across committed machine handoffs', async () => {
    const { source, remote, target } = fixture();
    git(source, 'checkout', '--orphan', 'unborn');
    git(source, 'rm', '-rf', '.');
    writeFileSync(join(source, '.gitignore'), 'secret.env\ncache/\n');
    writeFileSync(join(source, 'new.txt'), 'staged\n');
    writeFileSync(join(source, 'deleted-new.txt'), 'staged deletion\n');
    git(source, 'add', '.gitignore', 'new.txt', 'deleted-new.txt');
    writeFileSync(join(source, 'new.txt'), 'unstaged\n');
    rmSync(join(source, 'deleted-new.txt'));
    const status = git(source, 'status', '--porcelain=v1');
    const unborn = await createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'unborn-space', revision: 1 });
    expect(unborn.headCommit).toBeNull();
    expect(git(source, 'rev-list', '--parents', '-n', '1', unborn.indexCommit)).toBe(unborn.indexCommit);
    git(source, 'push', remote, `${unborn.checkpointRef}:${unborn.checkpointRef}`);
    git(target, 'init', '-b', 'unborn');
    git(target, 'fetch', remote, `${unborn.checkpointRef}:${unborn.checkpointRef}`);
    await restoreGitIntermediateCheckpoint({ repositoryPath: target, checkpoint: unborn, branch: 'unborn' });
    expect(git(target, 'symbolic-ref', 'HEAD')).toBe('refs/heads/unborn');
    expect(git(target, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('');
    expect(git(target, 'write-tree')).toBe(unborn.indexTree);
    expect(git(target, 'status', '--porcelain=v1')).toBe(status);
    expect(await Bun.file(join(target, 'new.txt')).text()).toBe('unstaged\n');
    expect(existsSync(join(target, 'deleted-new.txt'))).toBe(false);
    expect(existsSync(join(target, 'secret.env'))).toBe(false);

    git(source, 'commit', '-m', 'first real commit');
    writeFileSync(join(source, 'later.txt'), 'only in committed checkpoint\n');
    git(source, 'add', 'later.txt');
    const committed = await createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'unborn-space', revision: 2 });
    expect(committed.headCommit).toBe(git(source, 'rev-parse', 'HEAD'));
    git(source, 'push', remote, `${committed.checkpointRef}:${committed.checkpointRef}`);
    git(target, 'fetch', remote, `${committed.checkpointRef}:${committed.checkpointRef}`);
    await restoreGitIntermediateCheckpoint({ repositoryPath: target, checkpoint: committed, branch: 'unborn' });
    expect(committed.headCommit).toBe(git(target, 'rev-parse', 'HEAD'));
    expect(git(target, 'status', '--porcelain=v1')).toBe(git(source, 'status', '--porcelain=v1'));
    git(target, 'branch', 'unrelated');
    writeFileSync(join(target, 'secret.env'), 'machine secret\n');
    await restoreGitIntermediateCheckpoint({ repositoryPath: target, checkpoint: unborn, branch: 'unborn' });
    expect(git(target, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/unrelated');
    expect(git(target, 'symbolic-ref', 'HEAD')).toBe('refs/heads/unborn');
    expect(git(target, 'write-tree')).toBe(unborn.indexTree);
    expect(git(target, 'status', '--porcelain=v1')).toBe(status);
    expect(existsSync(join(target, 'later.txt'))).toBe(false);
    expect(await Bun.file(join(target, 'secret.env')).text()).toBe('machine secret\n');
  });

  it('deduplicates unborn incremental snapshots but publishes the first real commit', async () => {
    const { source } = fixture();
    git(source, 'checkout', '--orphan', 'unborn');
    let revision = 0;
    let committed: GitIntermediateCheckpoint | null = null;
    let pending: GitIntermediateCheckpoint | null = null;
    const publications: GitIntermediateCheckpoint[] = [];
    const snapshots = new IncrementalGitSnapshots({
      repositoryPath: source, spaceId: 'unborn-space',
      allocateRevision: async () => ++revision,
      loadPending: async () => pending, loadCommitted: async () => committed,
      savePending: async checkpoint => { pending = checkpoint; },
      publish: async checkpoint => { publications.push(checkpoint); },
      commit: async checkpoint => { committed = checkpoint; pending = null; return checkpoint; },
    });
    const first = await snapshots.capture();
    expect(first.headCommit).toBeNull();
    expect(await snapshots.capture()).toEqual(first);
    expect(publications).toEqual([first]);
    git(source, 'commit', '-m', 'first real commit');
    const next = await snapshots.capture();
    expect(next.headCommit).toBe(git(source, 'rev-parse', 'HEAD'));
    expect(publications).toEqual([first, next]);
    expect(await snapshots.capture()).toEqual(next);
    expect(publications).toEqual([first, next]);
  });

  it('rejects detached and corrupt HEAD instead of treating them as unborn', async () => {
    const { source } = fixture();
    git(source, 'checkout', '--detach');
    await expect(createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'space-a', revision: 1 })).rejects.toThrow();
    git(source, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    writeFileSync(join(source, '.git', 'refs', 'heads', 'main'), `${'f'.repeat(40)}\n`);
    await expect(createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'space-a', revision: 2 })).rejects.toThrow();
  });

  it('restores exact HEAD, index, worktree, modes, symlinks, and portable untracked files', async () => {
    const { source, remote, target } = fixture();
    const status = git(source, 'status', '--porcelain=v1');
    const checkpoint = await createGitIntermediateCheckpoint({
      repositoryPath: source,
      spaceId: 'space-a',
      revision: 1,
      portableUntrackedPaths: ['portable.txt'],
    });
    expect(git(source, 'status', '--porcelain=v1')).toBe(status);
    expect(git(source, 'branch', '--show-current')).toBe('main');
    git(source, 'push', remote, `${checkpoint.checkpointRef}:${checkpoint.checkpointRef}`);
    git(target, 'init', '-b', 'main');
    git(target, 'fetch', remote, `${checkpoint.checkpointRef}:${checkpoint.checkpointRef}`);
    await restoreGitIntermediateCheckpoint({ repositoryPath: target, checkpoint, branch: 'main' });
    expect(checkpoint.headCommit).toBe(git(target, 'rev-parse', 'HEAD'));
    expect(git(target, 'write-tree')).toBe(checkpoint.indexTree);
    expect(git(target, 'status', '--porcelain=v1')).toBe(status);
    expect(git(target, 'rev-list', '--count', 'main')).toBe('2');
    expect(lstatSync(join(target, 'linked.txt')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(target, 'linked.txt'))).toBe('staged.txt');
    expect(lstatSync(join(target, 'executable.sh')).mode & 0o111).toBe(0);
    expect(existsSync(join(target, 'portable.txt'))).toBe(true);
    expect(existsSync(join(target, 'secret.env'))).toBe(false);
    expect(existsSync(join(target, 'cache', 'build.bin'))).toBe(false);
  });

  it('preserves whitespace in automatically discovered untracked paths', async () => {
    const { source, target, remote } = fixture();
    writeFileSync(join(source, ' leading space.txt'), 'leading\n');
    const checkpoint = await createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'space-a', revision: 2 });
    git(source, 'push', remote, `${checkpoint.checkpointRef}:${checkpoint.checkpointRef}`);
    git(target, 'init', '-b', 'main');
    git(target, 'fetch', remote, `${checkpoint.checkpointRef}:${checkpoint.checkpointRef}`);
    await restoreGitIntermediateCheckpoint({ repositoryPath: target, checkpoint, branch: 'main' });
    expect(existsSync(join(target, ' leading space.txt'))).toBe(true);
  });

  it('retries an uncertain publication with the same snapshot instead of recapturing edits', async () => {
    const { source } = fixture();
    let revision = 0;
    const published: string[] = [];
    let committed = '';
    let pending: GitIntermediateCheckpoint | null = null;
    const snapshots = new IncrementalGitSnapshots({
      repositoryPath: source,
      loadPending: async () => pending,
      loadCommitted: async () => null,
      savePending: async (checkpoint) => { pending = checkpoint; },
      spaceId: 'space-a',
      allocateRevision: async () => ++revision,
      publish: async (checkpoint) => {
        published.push(checkpoint.worktreeCommit);
        if (published.length === 1) throw new Error('partition');
      },
      commit: async (checkpoint) => { committed = checkpoint.worktreeCommit; pending = null; return checkpoint; },
    });
    await expect(snapshots.capture()).rejects.toThrow('partition');
    writeFileSync(join(source, 'staged.txt'), 'later edit\n');
    const recovered = await snapshots.capture();
    expect(published).toEqual([recovered.worktreeCommit, recovered.worktreeCommit]);
    expect(committed).toBe(recovered.worktreeCommit);
    expect(revision).toBe(1);
  });

  it('rejects ignored and escaping portable paths', async () => {
    const { source } = fixture();
    await expect(createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'space-a', revision: 1, portableUntrackedPaths: ['secret.env'] })).rejects.toThrow('ignored');
    await expect(createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'space-a', revision: 2, portableUntrackedPaths: ['../outside'] })).rejects.toThrow('outside');
  });
});
