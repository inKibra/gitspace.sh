/**
 * Delete means delete.
 *
 * A removed workspace's artifacts branch used to survive "for a later roll-up",
 * which sounds safe and isn't: nothing surfaced orphaned branches anywhere, so
 * kept-for-later meant kept forever and findable by nobody. `removeWorkspace`
 * now drops the branch, and the delete confirmation warns first — which only
 * works if the count it warns with is honest.
 *
 * These cover the two units that carry that: `abandonArtifacts` (the deletion)
 * and `unmergedArtifactCommits` (the number the warning quotes).
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { abandonArtifacts, artifactPaths, ensureArtifactsMount, unmergedArtifactCommits } from '../artifacts.js';
import { deleteWorkspaceCore } from '../workspace.js';

let root: string;
let previousRoot: string | undefined;

function g(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** A mounted workspace whose artifacts branch carries one unmerged commit. */
async function workspaceWithArtifact(projectDir: string, name: string, file = 'note.md'): Promise<string> {
  const dir = join(projectDir, 'workspaces', name);
  mkdirSync(dir, { recursive: true });
  const mount = await ensureArtifactsMount(projectDir, dir, name);
  writeFileSync(join(mount, file), `captured by ${name}\n`);
  g(mount, ['add', file]);
  g(mount, ['commit', '-m', `capture ${file}`]);
  return mount;
}

beforeEach(() => {
  previousRoot = process.env.GITSPACE_WORKSPACE_ROOT;
  root = mkdtempSync(join(tmpdir(), 'gssh-abandon-'));
  process.env.GITSPACE_WORKSPACE_ROOT = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.GITSPACE_WORKSPACE_ROOT;
  else process.env.GITSPACE_WORKSPACE_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('abandonArtifacts', () => {
  it('removes the branch and its mount', async () => {
    const projectDir = join(root, 'proj');
    await workspaceWithArtifact(projectDir, 'feat-a');
    const { repoDir } = artifactPaths(projectDir);
    expect(g(repoDir, ['branch', '--list', 'feat-a'])).toContain('feat-a');

    await abandonArtifacts(projectDir, 'feat-a');

    expect(g(repoDir, ['branch', '--list', 'feat-a'])).toBe('');
    // The worktree registration must go with it, or the next `worktree add`
    // inherits a dangling name — the cross-wire failure mode.
    expect(g(repoDir, ['worktree', 'list'])).not.toContain('feat-a');
  });

  it('leaves a neighbour untouched', async () => {
    const projectDir = join(root, 'proj');
    await workspaceWithArtifact(projectDir, 'feat-a');
    await workspaceWithArtifact(projectDir, 'feat-b');

    await abandonArtifacts(projectDir, 'feat-a');

    const { repoDir } = artifactPaths(projectDir);
    expect(g(repoDir, ['branch', '--list', 'feat-b'])).toContain('feat-b');
  });

  it('refuses to abandon main', async () => {
    const projectDir = join(root, 'proj');
    await workspaceWithArtifact(projectDir, 'feat-a');
    await expect(abandonArtifacts(projectDir, 'main')).rejects.toThrow(/main/i);
  });
});

describe('deleteWorkspaceCore', () => {
  it('takes the artifacts branch with the workspace', async () => {
    const projectDir = join(root, 'proj');
    // A real project has a base repo; removal reaches for it to drop the worktree.
    const base = join(projectDir, 'base');
    mkdirSync(base, { recursive: true });
    g(base, ['init', '-q', '-b', 'main']);
    writeFileSync(join(base, 'r.md'), 'x\n');
    g(base, ['add', '.']);
    g(base, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    await workspaceWithArtifact(projectDir, 'feat-a');

    const { repoDir } = artifactPaths(projectDir);
    expect(g(repoDir, ['branch', '--list', 'feat-a'])).toContain('feat-a');

    const result = await deleteWorkspaceCore('proj', 'feat-a', { removeScriptPolicy: 'skip' });

    expect(result.success).toBe(true);
    // The point of the change: delete means delete, artifacts included.
    expect(g(repoDir, ['branch', '--list', 'feat-a'])).toBe('');
  });
});

describe('unmergedArtifactCommits', () => {
  it('counts the commits main does not have', async () => {
    const projectDir = join(root, 'proj');
    await workspaceWithArtifact(projectDir, 'feat-a');
    expect(await unmergedArtifactCommits(projectDir, 'feat-a')).toBe(1);
  });

  it('counts each commit, so the warning can quote a real number', async () => {
    const projectDir = join(root, 'proj');
    const mount = await workspaceWithArtifact(projectDir, 'feat-a');
    writeFileSync(join(mount, 'second.md'), 'more\n');
    g(mount, ['add', 'second.md']);
    g(mount, ['commit', '-m', 'capture second']);
    expect(await unmergedArtifactCommits(projectDir, 'feat-a')).toBe(2);
  });

  it('is 0 for a branch that never diverged — nothing would be lost', async () => {
    const projectDir = join(root, 'proj');
    const dir = join(projectDir, 'workspaces', 'fresh');
    mkdirSync(dir, { recursive: true });
    await ensureArtifactsMount(projectDir, dir, 'fresh');
    expect(await unmergedArtifactCommits(projectDir, 'fresh')).toBe(0);
  });

  it('is 0 for a branch that does not exist rather than throwing', async () => {
    const projectDir = join(root, 'proj');
    await workspaceWithArtifact(projectDir, 'feat-a');
    expect(await unmergedArtifactCommits(projectDir, 'never-existed')).toBe(0);
  });

  it('is 0 for main itself', async () => {
    const projectDir = join(root, 'proj');
    await workspaceWithArtifact(projectDir, 'feat-a');
    expect(await unmergedArtifactCommits(projectDir, 'main')).toBe(0);
  });
});
