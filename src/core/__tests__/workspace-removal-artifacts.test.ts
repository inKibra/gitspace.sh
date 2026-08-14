/**
 * What workspace removal leaves behind.
 *
 * Removal must take the directory AND the artifacts registration that claimed
 * it, while the artifacts BRANCH survives for a later roll-up (deliberate —
 * `core/workspace.ts` says so). Getting this half-right is what produced ghost
 * rows in the board's code lane.
 *
 * It must also not free a NEIGHBOUR's stale registration name. A blanket
 * `git worktree prune` does exactly that, and `worktree add` then hands the
 * recycled name to the next caller — the step that turns a dangling mount
 * pointer into a live pointer into someone else's worktree.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { artifactsMountDir, ensureArtifactsMount, pruneArtifactMounts } from '../artifacts.js';
import { inspectArtifactsMount } from '../artifacts-mount-integrity.js';

let root: string;
let previousRoot: string | undefined;

const REPO = '.artifacts.git';

function g(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** A workspace as removal finds one: a directory with an artifacts mount. */
async function makeMountedWorkspace(projectDir: string, name: string): Promise<string> {
  const dir = join(projectDir, 'workspaces', name);
  mkdirSync(dir, { recursive: true });
  await ensureArtifactsMount(projectDir, dir, name);
  return dir;
}

beforeEach(() => {
  previousRoot = process.env.GITSPACE_WORKSPACE_ROOT;
  root = mkdtempSync(join(tmpdir(), 'gs-removal-'));
  process.env.GITSPACE_WORKSPACE_ROOT = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.GITSPACE_WORKSPACE_ROOT;
  else process.env.GITSPACE_WORKSPACE_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('pruneArtifactMounts after a workspace directory is removed', () => {
  it('drops the registration that claimed the removed mount, and keeps the branch', async () => {
    const projectDir = join(root, 'proj');
    const wsDir = await makeMountedWorkspace(projectDir, 'feat-a');
    const repoDir = join(projectDir, REPO);
    const mount = artifactsMountDir(wsDir);
    const id = inspectArtifactsMount(repoDir, mount).registration!;
    expect(existsSync(join(repoDir, 'worktrees', id))).toBe(true);

    // Removal deletes the whole workspace tree, mount included.
    rmSync(wsDir, { recursive: true, force: true });
    await pruneArtifactMounts(projectDir, wsDir);

    // Nothing left claiming it.
    expect(existsSync(join(repoDir, 'worktrees', id))).toBe(false);
    expect(inspectArtifactsMount(repoDir, mount).orphanedRegistrations).toEqual([]);
    // The branch outlives the workspace on purpose — it may still be rolled up.
    expect(g(repoDir, ['branch', '--list', 'feat-a'])).toContain('feat-a');
  });

  it('leaves a neighbour\'s stale registration name un-recycled', async () => {
    const projectDir = join(root, 'proj');
    const goneDir = await makeMountedWorkspace(projectDir, 'feat-gone');
    const otherDir = await makeMountedWorkspace(projectDir, 'feat-other');
    const repoDir = join(projectDir, REPO);
    const otherMount = artifactsMountDir(otherDir);
    const otherId = inspectArtifactsMount(repoDir, otherMount).registration!;

    // The neighbour goes stale the way the real incident did: its mount vanishes
    // while its registration stays. A blanket prune would free `otherId` here.
    rmSync(otherMount, { recursive: true, force: true });

    rmSync(goneDir, { recursive: true, force: true });
    await pruneArtifactMounts(projectDir, goneDir);

    // The neighbour's name is still reserved, so no later `worktree add` can be
    // handed it while something may still point there.
    expect(existsSync(join(repoDir, 'worktrees', otherId))).toBe(true);
  });

  it('is a no-op for a project with no artifacts repo', async () => {
    const projectDir = join(root, 'bare-proj');
    mkdirSync(projectDir, { recursive: true });
    await pruneArtifactMounts(projectDir, join(projectDir, 'workspaces', 'nope'));
    expect(existsSync(join(projectDir, REPO))).toBe(false);
  });

  it('a removed workspace does not come back when artifacts are touched again', async () => {
    const projectDir = join(root, 'proj');
    const wsDir = await makeMountedWorkspace(projectDir, 'feat-a');
    rmSync(wsDir, { recursive: true, force: true });
    await pruneArtifactMounts(projectDir, wsDir);

    // The ghost loop: any artifact touch used to rebuild the directory from
    // nothing via mkdirSync(recursive), after which the scanner reported a
    // workspace again.
    await expect(ensureArtifactsMount(projectDir, wsDir, 'feat-a')).rejects.toThrow(/does not exist/);
    expect(existsSync(wsDir)).toBe(false);
  });

  it('still cleans up when the mount was left behind rather than deleted', async () => {
    // Belt and braces: `git worktree remove` can refuse a tree it considers
    // dirty, so removal may leave the mount in place.
    const projectDir = join(root, 'proj');
    const wsDir = await makeMountedWorkspace(projectDir, 'feat-a');
    const repoDir = join(projectDir, REPO);
    const mount = artifactsMountDir(wsDir);
    writeFileSync(join(mount, 'stray.txt'), 'uncommitted\n');
    const id = inspectArtifactsMount(repoDir, mount).registration!;

    rmSync(wsDir, { recursive: true, force: true });
    await pruneArtifactMounts(projectDir, wsDir);

    expect(existsSync(join(repoDir, 'worktrees', id))).toBe(false);
  });
});
