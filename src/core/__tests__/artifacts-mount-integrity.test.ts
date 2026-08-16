/**
 * Mount/registration round trip, and the mount behaviour built on it.
 *
 * These reproduce the real incident: `core/base/.gitspace/artifacts/.git` named
 * registration `artifacts9`, which belonged to a workspace worktree, while
 * `artifacts8` — the base mount's own registration — sat orphaned. `git worktree
 * list` reported `base … [main]` throughout, because it reads registrations and
 * never the mounts' own `.git` files.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { execFileSync } from 'child_process';
import { inspectArtifactsMount } from '../artifacts-mount-integrity.js';
import { artifactsMountDir, ensureArtifactsMount, ensureArtifactsRepo } from '../artifacts.js';

let root: string;
let previousRoot: string | undefined;

const REPO = '.artifacts.git';

function g(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** A workspace directory that exists on disk, as a real one always does. */
function makeWorkspace(projectDir: string, name: string): string {
  const dir = join(projectDir, 'workspaces', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  previousRoot = process.env.GITSPACE_WORKSPACE_ROOT;
  root = mkdtempSync(join(tmpdir(), 'gs-mount-integrity-'));
  process.env.GITSPACE_WORKSPACE_ROOT = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.GITSPACE_WORKSPACE_ROOT;
  else process.env.GITSPACE_WORKSPACE_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('inspectArtifactsMount', () => {
  it('reports ok for a mount whose registration points back at it', async () => {
    const projectDir = join(root, 'proj');
    const wsDir = makeWorkspace(projectDir, 'feat-a');
    const mount = await ensureArtifactsMount(projectDir, wsDir, 'feat-a');

    const info = inspectArtifactsMount(join(projectDir, REPO), mount);
    expect(info.status).toBe('ok');
    expect(info.registration).toBeTruthy();
    expect(info.orphanedRegistrations).toEqual([]);
  });

  it('reports absent when nothing is mounted yet', async () => {
    const projectDir = join(root, 'proj');
    await ensureArtifactsRepo(projectDir);
    const info = inspectArtifactsMount(join(projectDir, REPO), artifactsMountDir(makeWorkspace(projectDir, 'never')));
    expect(info.status).toBe('absent');
  });

  it('reports dangling when the named registration is gone', async () => {
    const projectDir = join(root, 'proj');
    const wsDir = makeWorkspace(projectDir, 'feat-a');
    const mount = await ensureArtifactsMount(projectDir, wsDir, 'feat-a');
    const repoDir = join(projectDir, REPO);
    const id = inspectArtifactsMount(repoDir, mount).registration!;

    // The loser of a concurrent `worktree add` leaves exactly this: a mount
    // naming a registration that no longer exists.
    rmSync(join(repoDir, 'worktrees', id), { recursive: true, force: true });

    expect(inspectArtifactsMount(repoDir, mount).status).toBe('dangling');
  });

  it('reports cross-wired when the mount names another mount\'s registration', async () => {
    const projectDir = join(root, 'proj');
    const baseDir = makeWorkspace(projectDir, 'base-ish');
    const otherDir = makeWorkspace(projectDir, 'other');
    const baseMount = await ensureArtifactsMount(projectDir, baseDir, 'base-ish');
    const otherMount = await ensureArtifactsMount(projectDir, otherDir, 'other');
    const repoDir = join(projectDir, REPO);

    const otherId = inspectArtifactsMount(repoDir, otherMount).registration!;
    const baseId = inspectArtifactsMount(repoDir, baseMount).registration!;
    // The incident, exactly: base's `.git` repointed at the other worktree's
    // registration, base's own registration left orphaned.
    writeFileSync(join(baseMount, '.git'), `gitdir: ${join(repoDir, 'worktrees', otherId)}\n`);

    const info = inspectArtifactsMount(repoDir, baseMount);
    expect(info.status).toBe('cross-wired');
    expect(info.registration).toBe(otherId);
    expect(info.registrationPointsAt).toContain('other');
    // And the orphan is named, because that is the registration a blanket
    // `worktree prune` would recycle into someone else's worktree.
    expect(info.orphanedRegistrations).toContain(baseId);
  });

  it('sees through the check operators actually use: worktree list still looks healthy', async () => {
    const projectDir = join(root, 'proj');
    const baseDir = makeWorkspace(projectDir, 'base-ish');
    const otherDir = makeWorkspace(projectDir, 'other');
    const baseMount = await ensureArtifactsMount(projectDir, baseDir, 'base-ish');
    const otherMount = await ensureArtifactsMount(projectDir, otherDir, 'other');
    const repoDir = join(projectDir, REPO);
    const otherId = inspectArtifactsMount(repoDir, otherMount).registration!;
    writeFileSync(join(baseMount, '.git'), `gitdir: ${join(repoDir, 'worktrees', otherId)}\n`);

    // Registrations are still self-consistent, so this reports both trees on
    // their own branches — the reason the fault was invisible.
    const listed = g(repoDir, ['worktree', 'list']);
    expect(listed).toContain('base-ish');
    expect(listed).toContain('[base-ish]');
    // The round trip disagrees.
    expect(inspectArtifactsMount(repoDir, baseMount).status).toBe('cross-wired');
  });
});

describe('ensureArtifactsMount', () => {
  it('refuses to conjure a workspace directory that does not exist', async () => {
    const projectDir = join(root, 'proj');
    await ensureArtifactsRepo(projectDir);
    const ghostDir = join(projectDir, 'workspaces', 'deleted-workspace');

    await expect(ensureArtifactsMount(projectDir, ghostDir, 'deleted-workspace')).rejects.toThrow(/does not exist/);
    // The ghost mechanism: mkdirSync(recursive) used to materialise both of
    // these from nothing, after which the scanner reported a workspace.
    expect(existsSync(ghostDir)).toBe(false);
    expect(existsSync(join(ghostDir, '.gitspace'))).toBe(false);
  });

  it('repairs a dangling mount instead of adopting a stranger\'s registration', async () => {
    const projectDir = join(root, 'proj');
    const wsDir = makeWorkspace(projectDir, 'feat-a');
    const mount = await ensureArtifactsMount(projectDir, wsDir, 'feat-a');
    const repoDir = join(projectDir, REPO);
    const id = inspectArtifactsMount(repoDir, mount).registration!;
    rmSync(join(repoDir, 'worktrees', id), { recursive: true, force: true });

    const again = await ensureArtifactsMount(projectDir, wsDir, 'feat-a');
    expect(again).toBe(mount);
    const info = inspectArtifactsMount(repoDir, mount);
    expect(info.status).toBe('ok');
    expect(g(mount, ['branch', '--show-current'])).toBe('feat-a');
  });

  it('refuses to write through a cross-wired mount rather than compounding it', async () => {
    const projectDir = join(root, 'proj');
    const aDir = makeWorkspace(projectDir, 'feat-a');
    const bDir = makeWorkspace(projectDir, 'feat-b');
    const aMount = await ensureArtifactsMount(projectDir, aDir, 'feat-a');
    const bMount = await ensureArtifactsMount(projectDir, bDir, 'feat-b');
    const repoDir = join(projectDir, REPO);
    const bId = inspectArtifactsMount(repoDir, bMount).registration!;
    writeFileSync(join(aMount, '.git'), `gitdir: ${join(repoDir, 'worktrees', bId)}\n`);

    await expect(ensureArtifactsMount(projectDir, aDir, 'feat-a')).rejects.toThrow(/cross-wired/);
  });

  it('serialises concurrent calls for one mount into a single registration', async () => {
    const projectDir = join(root, 'proj');
    const wsDir = makeWorkspace(projectDir, 'feat-a');
    await ensureArtifactsRepo(projectDir);

    // The manufacturing step for the real incident: both callers passed the
    // existsSync check, both ran `worktree add`, and the loser wrote the mount's
    // .git file last. Eight at once, one registration expected.
    const mounts = await Promise.all(
      Array.from({ length: 8 }, () => ensureArtifactsMount(projectDir, wsDir, 'feat-a')),
    );
    const mount = artifactsMountDir(wsDir);
    expect(new Set(mounts)).toEqual(new Set([mount]));

    const repoDir = join(projectDir, REPO);
    const info = inspectArtifactsMount(repoDir, mount);
    expect(info.status).toBe('ok');
    expect(info.orphanedRegistrations).toEqual([]);
    // Exactly one registration claims this mount.
    const dotGit = readFileSync(join(mount, '.git'), 'utf8');
    expect(dotGit).toContain(info.registration!);
  });

  it('drops only registrations claiming this mount, never a live neighbour\'s', async () => {
    const projectDir = join(root, 'proj');
    const aDir = makeWorkspace(projectDir, 'feat-a');
    const bDir = makeWorkspace(projectDir, 'feat-b');
    const aMount = await ensureArtifactsMount(projectDir, aDir, 'feat-a');
    const bMount = await ensureArtifactsMount(projectDir, bDir, 'feat-b');
    const repoDir = join(projectDir, REPO);
    const bId = inspectArtifactsMount(repoDir, bMount).registration!;

    // Remove A's mount by hand, leaving its registration stale — the case the
    // old blanket `worktree prune` was there to clear.
    rmSync(aMount, { recursive: true, force: true });
    mkdirSync(dirname(aMount), { recursive: true });
    await ensureArtifactsMount(projectDir, aDir, 'feat-a');

    // B untouched: still registered, still on its own branch.
    expect(existsSync(join(repoDir, 'worktrees', bId))).toBe(true);
    expect(inspectArtifactsMount(repoDir, bMount).status).toBe('ok');
    expect(g(bMount, ['branch', '--show-current'])).toBe('feat-b');
  });
});
