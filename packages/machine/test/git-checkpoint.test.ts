import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitIntermediateCheckpoint, restoreGitIntermediateCheckpoint } from '../src/git-checkpoint.js';

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
    expect(git(target, 'rev-parse', 'HEAD')).toBe(checkpoint.headCommit);
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

  it('rejects ignored and escaping portable paths', async () => {
    const { source } = fixture();
    await expect(createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'space-a', revision: 1, portableUntrackedPaths: ['secret.env'] })).rejects.toThrow('ignored');
    await expect(createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: 'space-a', revision: 2, portableUntrackedPaths: ['../outside'] })).rejects.toThrow('outside');
  });
});
