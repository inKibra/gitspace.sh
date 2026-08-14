/**
 * Artifacts FS core library — semantics tested against real git in temp dirs:
 * repo bootstrap, branch-per-workspace worktree mounts, code-repo excludes,
 * pointer split + blob store, git-notes provenance, roll-up merge, abandon.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  abandonArtifacts,
  artifactPaths,
  artifactsMountDir,
  artifactsScope,
  captureArtifacts,
  ensureArtifactsMount,
  ensureArtifactsRepo,
  makeLfsPointer,
  parseLfsPointer,
  readArtifact,
  resolveLocalScratch,
  rollupArtifacts,
} from '../artifacts.js';
import { toggleFavorite } from '../artifacts-favorites.js';

let projectDir: string;
/** A real workspace is a directory on disk, and `ensureArtifactsMount` now
 *  refuses to mount into one that does not exist (that is what used to
 *  resurrect deleted workspaces as ghosts), so the fixture must create it. */
const wsDir = (name: string): string => {
  const dir = join(projectDir, 'workspaces', name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const g = (cwd: string, args: string): string =>
  execSync(`git -C ${JSON.stringify(cwd)} ${args}`, { encoding: 'utf8' }).trim();

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'gs-artifacts-'));
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('ensureArtifactsRepo', () => {
  it('creates a bare repo with a root commit on main; idempotent', async () => {
    const repo = await ensureArtifactsRepo(projectDir);
    expect(existsSync(join(repo, 'HEAD'))).toBe(true);
    expect(g(repo, 'log --oneline main')).toContain('init artifacts');
    const again = await ensureArtifactsRepo(projectDir);
    expect(again).toBe(repo);
    expect(g(repo, 'rev-list --count main')).toBe('1');
  });
});

describe('ensureArtifactsMount', () => {
  it('branches off main and mounts at .gitspace/artifacts; idempotent', async () => {
    mkdirSync(wsDir('feat-a'), { recursive: true });
    const mount = await ensureArtifactsMount(projectDir, wsDir('feat-a'), 'feat-a');
    expect(mount).toBe(artifactsMountDir(wsDir('feat-a')));
    expect(g(mount, 'branch --show-current')).toBe('feat-a');
    expect(existsSync(join(mount, 'README.md'))).toBe(true); // root commit content
    const again = await ensureArtifactsMount(projectDir, wsDir('feat-a'), 'feat-a');
    expect(again).toBe(mount);
  });

  it('base mounts main directly', async () => {
    const base = join(projectDir, 'base');
    mkdirSync(base, { recursive: true });
    const mount = await ensureArtifactsMount(projectDir, base, 'main');
    expect(g(mount, 'branch --show-current')).toBe('main');
  });

  it('adds the mount to the code repo exclude file', async () => {
    const ws = wsDir('feat-x');
    mkdirSync(ws, { recursive: true });
    g(projectDir, `init -q ${JSON.stringify(ws)}`);
    await ensureArtifactsMount(projectDir, ws, 'feat-x');
    const exclude = readFileSync(join(ws, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.gitspace/artifacts/');
    // code repo doesn't see the mount
    writeFileSync(join(ws, 'code.ts'), 'x');
    const status = g(ws, 'status --porcelain');
    expect(status).toContain('code.ts');
    expect(status).not.toContain('artifacts');
  });
});

describe('captureArtifacts', () => {
  it('commits small files inline with git-notes provenance', async () => {
    mkdirSync(wsDir('w1'), { recursive: true });
    const mount = await ensureArtifactsMount(projectDir, wsDir('w1'), 'w1');
    const { commit, pointers } = await captureArtifacts(projectDir, mount, [
      { path: 'reports/summary.md', content: '# ok\n' },
    ], { provenance: { session: 's-1', goal: 'g-1', tool: 'test' } });
    expect(pointers).toEqual([]);
    expect(g(mount, `show ${commit}:reports/summary.md`)).toBe('# ok');
    const note = g(mount, `notes show ${commit}`);
    expect(JSON.parse(note)).toEqual({ session: 's-1', goal: 'g-1', tool: 'test' });
  });

  it('splits large files into blob store + LFS pointer; readArtifact resolves', async () => {
    mkdirSync(wsDir('w2'), { recursive: true });
    const mount = await ensureArtifactsMount(projectDir, wsDir('w2'), 'w2');
    const big = Buffer.alloc(4096, 7);
    const { pointers } = await captureArtifacts(projectDir, mount, [
      { path: 'demos/run.bin', content: big },
    ], { pointerThresholdBytes: 1024 });
    expect(pointers).toEqual(['demos/run.bin']);
    const ptrText = readFileSync(join(mount, 'demos/run.bin'), 'utf8');
    const ptr = parseLfsPointer(ptrText);
    expect(ptr).not.toBeNull();
    expect(ptr!.size).toBe(4096);
    const { blobsDir } = artifactPaths(projectDir);
    expect(existsSync(join(blobsDir, ptr!.oid.slice(0, 2), ptr!.oid))).toBe(true);
    expect(readArtifact(projectDir, mount, 'demos/run.bin').equals(big)).toBe(true);
    // Pointer captures commit matching .gitattributes lines (GitHub LFS +
    // external git-lfs clones need the attribute to treat the file as LFS).
    const attrs = g(mount, 'show HEAD:.gitattributes');
    expect(attrs).toContain('demos/run.bin filter=lfs diff=lfs merge=lfs -text');
  });

  it('captures from a sourceFile and rejects unsafe paths', async () => {
    mkdirSync(wsDir('w3'), { recursive: true });
    const mount = await ensureArtifactsMount(projectDir, wsDir('w3'), 'w3');
    const src = join(projectDir, 'shot.png');
    writeFileSync(src, 'PNGDATA');
    const { commit } = await captureArtifacts(projectDir, mount, [{ path: 'shots/shot.png', sourceFile: src }]);
    expect(g(mount, `show ${commit}:shots/shot.png`)).toBe('PNGDATA');
    await expect(captureArtifacts(projectDir, mount, [{ path: '../escape', content: 'x' }])).rejects.toThrow('Unsafe');
  });

  it('workspace branches are isolated', async () => {
    mkdirSync(wsDir('a'), { recursive: true });
    mkdirSync(wsDir('b'), { recursive: true });
    const ma = await ensureArtifactsMount(projectDir, wsDir('a'), 'a');
    const mb = await ensureArtifactsMount(projectDir, wsDir('b'), 'b');
    await captureArtifacts(projectDir, ma, [{ path: 'only-a.txt', content: 'a' }]);
    expect(existsSync(join(ma, 'only-a.txt'))).toBe(true);
    expect(existsSync(join(mb, 'only-a.txt'))).toBe(false);
  });
});

describe('rollupArtifacts', () => {
  it('merges a workspace branch into main via a temp worktree (no main mount)', async () => {
    mkdirSync(wsDir('done'), { recursive: true });
    const mount = await ensureArtifactsMount(projectDir, wsDir('done'), 'done');
    await captureArtifacts(projectDir, mount, [{ path: 'evidence/proof.txt', content: 'proof' }]);
    const { repoDir } = artifactPaths(projectDir);
    const { mergeCommit } = await rollupArtifacts(projectDir, 'done');
    expect(g(repoDir, `show ${mergeCommit}:evidence/proof.txt`)).toBe('proof');
    expect(g(repoDir, 'log --oneline main')).toContain('rollup: done');
    // temp worktree cleaned up
    expect(g(repoDir, 'worktree list').split('\n').length).toBe(2); // bare + done mount
  });

  it('advances main in the object DB (not a mount working tree) and can remove the branch', async () => {
    const base = join(projectDir, 'base');
    mkdirSync(base, { recursive: true });
    mkdirSync(wsDir('ship'), { recursive: true });
    const baseMount = await ensureArtifactsMount(projectDir, base, 'main');
    const mount = await ensureArtifactsMount(projectDir, wsDir('ship'), 'ship');
    await captureArtifacts(projectDir, mount, [{ path: 'r.md', content: 'r' }]);
    await rollupArtifacts(projectDir, 'ship', { removeBranch: true });
    const { repoDir } = artifactPaths(projectDir);
    // Landed on refs/heads/main in the object DB — readable without any worktree.
    expect(g(repoDir, 'show main:r.md')).toBe('r');
    // A base main mount is fast-forwarded (reset --keep) so it stays consistent
    // with the ref we advanced — clean status, and the file is present — instead
    // of showing phantom deletions.
    expect(g(baseMount, 'status --porcelain')).toBe('');
    expect(readFileSync(join(baseMount, 'r.md'), 'utf8')).toBe('r');
    expect(g(repoDir, 'branch --list ship')).toBe(''); // branch gone
    expect(existsSync(join(artifactsMountDir(wsDir('ship')), '.git'))).toBe(false); // mount gone
  });

  it('lands on main even when a mount has drifted onto another branch', async () => {
    const base = join(projectDir, 'base');
    mkdirSync(base, { recursive: true });
    mkdirSync(wsDir('drifty'), { recursive: true });
    const baseMount = await ensureArtifactsMount(projectDir, base, 'main');
    const mount = await ensureArtifactsMount(projectDir, wsDir('drifty'), 'drifty');
    const { repoDir } = artifactPaths(projectDir);
    // Simulate the wrong-branch incident: the base mount gets checked out onto
    // some OTHER branch. The old worktree-based rollup would have merged into
    // whatever the mount sat on; the object-DB rollup must still advance main.
    g(repoDir, 'branch other main');
    g(baseMount, 'checkout other');
    const driftyBefore = g(repoDir, 'rev-parse drifty');
    await captureArtifacts(projectDir, mount, [{ path: 'proof.md', content: 'ok' }]);
    const driftyAfterCapture = g(repoDir, 'rev-parse drifty');
    await rollupArtifacts(projectDir, 'drifty');
    expect(g(repoDir, 'show main:proof.md')).toBe('ok'); // main advanced
    // The merge never advanced 'drifty' — its tip is exactly the capture commit.
    expect(g(repoDir, 'rev-parse drifty')).toBe(driftyAfterCapture);
    expect(driftyAfterCapture).not.toBe(driftyBefore); // capture did commit onto drifty
    expect(g(repoDir, 'log --oneline drifty')).not.toContain('rollup');
  });

  it('aborts cleanly on conflicts', async () => {
    const base = join(projectDir, 'base');
    mkdirSync(base, { recursive: true });
    mkdirSync(wsDir('c1'), { recursive: true });
    const baseMount = await ensureArtifactsMount(projectDir, base, 'main');
    const m1 = await ensureArtifactsMount(projectDir, wsDir('c1'), 'c1');
    await captureArtifacts(projectDir, m1, [{ path: 'same.txt', content: 'from-c1' }]);
    await captureArtifacts(projectDir, baseMount, [{ path: 'same.txt', content: 'from-main' }]);
    await expect(rollupArtifacts(projectDir, 'c1')).rejects.toThrow('conflicts');
    // main mount left clean (merge aborted)
    expect(g(baseMount, 'status --porcelain')).toBe('');
  });
});

describe('rollupArtifacts — favorites filter (goal-keyed)', () => {
  /** Give a workspace a goal record so artifactsScope binds to goals/<gid>/. */
  const setupGoalWorkspace = (name: string, gid: string): string => {
    const ws = wsDir(name);
    const metaDir = join(ws, '.gitspace', 'workspace', name);
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, 'goal.json'), JSON.stringify({ id: gid }));
    return ws;
  };

  it('rolls up the canonical record + favorited proof only; excludes the rest', async () => {
    const gid = 'goal-abc';
    const ws = setupGoalWorkspace('feat', gid);
    const mount = await ensureArtifactsMount(projectDir, ws, 'feat');
    const scope = artifactsScope(ws);
    expect(scope.rootRel).toBe(`goals/${gid}`);

    await captureArtifacts(projectDir, mount, [
      // canonical record (always rolls up)
      { path: scope.rel('goal.md'), content: '# goal' },
      { path: scope.rel('rubric.json'), content: '{}' },
      { path: scope.rel('journal/01-plan.json'), content: '{}' },
      { path: scope.rel('review/guide.json'), content: '{}' },
      { path: scope.rel('validation/goal-abc/ev-x-shot.png'), content: 'PNG' },
      { path: scope.rel('plan.workflow.json'), content: '{}' },
      // curated proof (rolls up only if favorited)
      { path: scope.rel('demos/keep.webm'), content: 'keepbytes' },
      { path: scope.rel('demos/drop.webm'), content: 'dropbytes' },
      { path: scope.rel('reports/loose.report.json'), content: '{}' },
    ]);
    // Star exactly one proof artifact (commits goals/<gid>/.favorites.json).
    await toggleFavorite(projectDir, scope, scope.rel('demos/keep.webm'));

    const { mergeCommit } = await rollupArtifacts(projectDir, 'feat');
    const { repoDir } = artifactPaths(projectDir);
    const onMain = (p: string): string => g(repoDir, `ls-tree -r --name-only ${mergeCommit} -- ${JSON.stringify(p)}`);

    // canonical present
    expect(g(repoDir, `show ${mergeCommit}:goals/${gid}/goal.md`)).toBe('# goal');
    expect(onMain(`goals/${gid}/rubric.json`)).toContain('rubric.json');
    expect(onMain(`goals/${gid}/journal/01-plan.json`)).toContain('01-plan.json');
    expect(onMain(`goals/${gid}/review/guide.json`)).toContain('guide.json');
    expect(onMain(`goals/${gid}/validation/goal-abc/ev-x-shot.png`)).toContain('ev-x-shot.png');
    expect(onMain(`goals/${gid}/plan.workflow.json`)).toContain('plan.workflow.json');
    expect(onMain(`goals/${gid}/.favorites.json`)).toContain('.favorites.json');
    // favorited proof present
    expect(g(repoDir, `show ${mergeCommit}:goals/${gid}/demos/keep.webm`)).toBe('keepbytes');
    // non-favorited proof absent
    expect(onMain(`goals/${gid}/demos/drop.webm`)).toBe('');
    expect(onMain(`goals/${gid}/reports/loose.report.json`)).toBe('');

    // Provenance note records workspace + goal + curation counts.
    const note = JSON.parse(g(repoDir, `notes show ${mergeCommit}`));
    expect(note.tool).toBe('rollup');
    expect(note.goals).toEqual([gid]);
    expect(note.excluded).toBe(2);
  });

  it('two goals roll up into disjoint folders on main without conflict', async () => {
    const wsA = setupGoalWorkspace('a', 'goal-a');
    const wsB = setupGoalWorkspace('b', 'goal-b');
    const ma = await ensureArtifactsMount(projectDir, wsA, 'a');
    const mb = await ensureArtifactsMount(projectDir, wsB, 'b');
    await captureArtifacts(projectDir, ma, [{ path: 'goals/goal-a/goal.md', content: 'A' }]);
    await captureArtifacts(projectDir, mb, [{ path: 'goals/goal-b/goal.md', content: 'B' }]);
    await rollupArtifacts(projectDir, 'a');
    const { mergeCommit } = await rollupArtifacts(projectDir, 'b'); // must not conflict
    const { repoDir } = artifactPaths(projectDir);
    expect(g(repoDir, `show ${mergeCommit}:goals/goal-a/goal.md`)).toBe('A');
    expect(g(repoDir, `show ${mergeCommit}:goals/goal-b/goal.md`)).toBe('B');
  });
});

describe('abandonArtifacts', () => {
  it('removes the mount and branch; main untouched', async () => {
    mkdirSync(wsDir('scrap'), { recursive: true });
    const mount = await ensureArtifactsMount(projectDir, wsDir('scrap'), 'scrap');
    await captureArtifacts(projectDir, mount, [{ path: 'junk.txt', content: 'x' }]);
    await abandonArtifacts(projectDir, 'scrap');
    const { repoDir } = artifactPaths(projectDir);
    expect(g(repoDir, 'branch --list scrap')).toBe('');
    expect(existsSync(join(mount, '.git'))).toBe(false);
    expect(g(repoDir, 'rev-list --count main')).toBe('1'); // main untouched
  });

  it('refuses to abandon main', async () => {
    await ensureArtifactsRepo(projectDir);
    await expect(abandonArtifacts(projectDir, 'main')).rejects.toThrow('main');
  });
});

describe('remote + sync (Tier 1 BYO)', () => {
  it('set/get remote, sync pushes branches and fast-forwards main', async () => {
    const { setArtifactsRemote, getArtifactsRemote, syncArtifacts } = await import('../artifacts.js');
    // local bare "remote"
    const remoteDir = join(projectDir, 'byo-remote.git');
    execSync(`git init -q --bare --initial-branch=main ${JSON.stringify(remoteDir)}`);
    mkdirSync(wsDir('r1'), { recursive: true });
    const mount = await ensureArtifactsMount(projectDir, wsDir('r1'), 'r1');
    await captureArtifacts(projectDir, mount, [{ path: 'a.txt', content: 'a' }]);
    expect(await getArtifactsRemote(projectDir)).toBeNull();
    await setArtifactsRemote(projectDir, remoteDir);
    expect(await getArtifactsRemote(projectDir)).toBe(remoteDir);
    const r = await syncArtifacts(projectDir);
    expect(r.pushed).toBe(true);
    expect(g(remoteDir, 'branch --list r1')).not.toBe(''); // workspace branch pushed
    expect(g(remoteDir, 'show main:README.md')).toContain('Artifacts');
    // remote main moves ahead → sync fast-forwards local main
    const tmp = join(projectDir, 'tmpclone');
    execSync(`git clone -q ${JSON.stringify(remoteDir)} ${JSON.stringify(tmp)}`);
    writeFileSync(join(tmp, 'upstream.txt'), 'up');
    g(tmp, '-c user.name=t -c user.email=t@t add -A');
    g(tmp, '-c user.name=t -c user.email=t@t commit -qm upstream');
    g(tmp, 'push -q origin main');
    const r2 = await syncArtifacts(projectDir);
    expect(r2.fastForwarded).toBe(true);
    const { repoDir } = artifactPaths(projectDir);
    expect(g(repoDir, 'show main:upstream.txt')).toBe('up');
  });

  it('pointer config round-trips and stages in the code repo', async () => {
    const { readArtifactsPointerConfig, writeArtifactsPointerConfig } = await import('../artifacts.js');
    const code = join(projectDir, 'code');
    mkdirSync(code, { recursive: true });
    execSync(`git init -q ${JSON.stringify(code)}`);
    expect(readArtifactsPointerConfig(code)).toBeNull();
    await writeArtifactsPointerConfig(code, { remote: 'https://example.com/x.git' });
    expect(readArtifactsPointerConfig(code)).toEqual({ remote: 'https://example.com/x.git' });
    expect(g(code, 'diff --cached --name-only')).toBe('.gitspace/artifacts.json'); // staged
  });
});

describe('session scratch (.sessions/)', () => {
  it('is git-excluded, invisible to listings, typeless, and GC-able', async () => {
    const base = join(projectDir, 'base');
    mkdirSync(base, { recursive: true });
    const mount = await ensureArtifactsMount(projectDir, base, 'main');

    // scratch that would leak into extension-keyed kinds without the guards
    const sessDir = join(mount, '.sessions', 'sess-1', 'local');
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, 'PLAN.md'), '# plan');
    writeFileSync(join(sessDir, 'sneaky.dashboard.json'), '{}');

    // git-excluded: status stays clean (bare repo info/exclude covers worktrees)
    expect(g(mount, 'status --porcelain')).toBe('');
    // invisible to the curated walk
    const listed = (await import('../artifacts.js')).listArtifactFiles(mount).map((e) => e.path);
    expect(listed.some((p) => p.includes('.sessions'))).toBe(false);
    // typeless to classification (guards extension-keyed kinds)
    const { classifyArtifact } = await import('../../components/artifact-kinds.js');
    expect(classifyArtifact('.sessions/sess-1/local/sneaky.dashboard.json')).toBe('other');

    // GC: live ids survive; dead-and-old dirs go
    const { gcSessionScratch } = await import('../artifacts.js');
    expect(gcSessionScratch(mount, new Set(['sess-1']))).toBe(0); // live
    expect(gcSessionScratch(mount, new Set(), 0)).toBe(1);        // dead + past retention
    expect(existsSync(join(mount, '.sessions', 'sess-1'))).toBe(false);
  });
});

describe('resolveLocalScratch', () => {
  it('maps to the mount root, creating parent dirs, matching abs + mount-rel paths', async () => {
    const mount = await ensureArtifactsMount(projectDir, wsDir('feat-a'), 'feat-a');
    const { absPath, mountRel } = resolveLocalScratch(mount, 'notes/PLAN.md');
    expect(mountRel).toBe('notes/PLAN.md');
    expect(absPath).toBe(join(mount, mountRel));
    expect(existsSync(join(mount, 'notes'))).toBe(true);
  });

  it('rejects traversal', async () => {
    const mount = await ensureArtifactsMount(projectDir, wsDir('feat-a'), 'feat-a');
    expect(() => resolveLocalScratch(mount, '../escape')).toThrow('Unsafe');
  });
});

describe('LFS pointer format', () => {
  it('round-trips', () => {
    const oid = 'a'.repeat(64);
    const p = makeLfsPointer(oid, 123);
    expect(parseLfsPointer(p)).toEqual({ oid, size: 123 });
    expect(parseLfsPointer('not a pointer')).toBeNull();
  });
});
