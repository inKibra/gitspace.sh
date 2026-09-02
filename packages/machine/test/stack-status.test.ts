import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeStackStatus } from '../src/stack-status.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...Bun.env,
      GIT_AUTHOR_NAME: 'Stack Test',
      GIT_AUTHOR_EMAIL: 'stack@gitspace.invalid',
      GIT_COMMITTER_NAME: 'Stack Test',
      GIT_COMMITTER_EMAIL: 'stack@gitspace.invalid',
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function commit(cwd: string, file: string, content: string): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-m', `${file}: ${content.trim()}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** Base `main`, `parent` with two commits past the fork, `child` worktree branched from the parent's fork point. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-stack-status-'));
  roots.push(root);
  const base = join(root, 'base');
  mkdirSync(base);
  git(base, 'init', '-b', 'main');
  commit(base, 'file.txt', 'base\n');
  git(base, 'switch', '-c', 'parent');
  const fork = commit(base, 'parent.txt', 'one\n');
  const child = join(root, 'child');
  git(base, 'worktree', 'add', '-b', 'child', child, 'parent');
  commit(base, 'parent.txt', 'two\n');
  commit(base, 'parent.txt', 'three\n');
  commit(child, 'child.txt', 'mine\n');
  git(base, 'switch', 'main');
  return { base, child, fork };
}

describe('computeStackStatus', () => {
  it('counts parent commits the child lacks and instructs a plain rebase', async () => {
    const { child, fork } = fixture();
    const status = await computeStackStatus({ rootPath: child, baseBranch: 'main', parent: { id: 'parent-id', branch: 'parent' } });
    expect(status).toEqual({
      parentId: 'parent-id',
      parentBranch: 'parent',
      baseBranch: 'main',
      mergeBase: fork,
      parentAhead: 2,
      parentMerged: 'not-merged',
      instruction: 'Rebase onto the parent: `git rebase parent`',
    });
  });

  it('switches to a rebase --onto instruction once the parent merged into the base', async () => {
    const { base, child } = fixture();
    git(base, 'merge', '--no-ff', 'parent', '-m', 'merge parent');
    const status = await computeStackStatus({ rootPath: child, baseBranch: 'main', parent: { id: 'parent-id', branch: 'parent' } });
    expect(status.parentMerged).toBe('merged');
    expect(status.parentAhead).toBe(2);
    expect(status.instruction).toBe('The parent merged into main. Rebase only your own commits: `git rebase --onto main parent`, then this workspace is no longer stacked.');
  });

  it('is quiet when the child already carries every parent commit', async () => {
    const { base, child } = fixture();
    git(child, 'rebase', 'parent');
    const status = await computeStackStatus({ rootPath: child, baseBranch: 'main', parent: { id: 'parent-id', branch: 'parent' } });
    expect(status.parentAhead).toBe(0);
    expect(status.parentMerged).toBe('not-merged');
    expect(status.instruction).toBeNull();
    expect(status.mergeBase).toBe(git(base, 'rev-parse', 'parent'));
  });

  it('reports unknown for an unstacked workspace or a missing base branch', async () => {
    const { child } = fixture();
    const unstacked = await computeStackStatus({ rootPath: child, baseBranch: 'main', parent: null });
    expect(unstacked).toEqual({ parentId: null, parentBranch: null, baseBranch: 'main', mergeBase: null, parentAhead: 0, parentMerged: 'unknown', instruction: null });
    const missingBase = await computeStackStatus({ rootPath: child, baseBranch: 'does-not-exist', parent: { id: 'parent-id', branch: 'parent' } });
    expect(missingBase.parentMerged).toBe('unknown');
    expect(missingBase.parentAhead).toBe(2);
    expect(missingBase.instruction).toBe('Rebase onto the parent: `git rebase parent`');
  });
});
