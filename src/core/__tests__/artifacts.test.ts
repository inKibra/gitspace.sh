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
  captureArtifacts,
  ensureArtifactsMount,
  ensureArtifactsRepo,
  makeLfsPointer,
  parseLfsPointer,
  readArtifact,
  rollupArtifacts,
} from '../artifacts.js';

let projectDir: string;
const wsDir = (name: string): string => join(projectDir, 'workspaces', name);
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

  it('merges through an existing main mount and can remove the branch', async () => {
    const base = join(projectDir, 'base');
    mkdirSync(base, { recursive: true });
    mkdirSync(wsDir('ship'), { recursive: true });
    const baseMount = await ensureArtifactsMount(projectDir, base, 'main');
    const mount = await ensureArtifactsMount(projectDir, wsDir('ship'), 'ship');
    await captureArtifacts(projectDir, mount, [{ path: 'r.md', content: 'r' }]);
    await rollupArtifacts(projectDir, 'ship', { removeBranch: true });
    expect(readFileSync(join(baseMount, 'r.md'), 'utf8')).toBe('r'); // landed in the live main mount
    const { repoDir } = artifactPaths(projectDir);
    expect(g(repoDir, 'branch --list ship')).toBe(''); // branch gone
    expect(existsSync(join(artifactsMountDir(wsDir('ship')), '.git'))).toBe(false); // mount gone
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

describe('LFS pointer format', () => {
  it('round-trips', () => {
    const oid = 'a'.repeat(64);
    const p = makeLfsPointer(oid, 123);
    expect(parseLfsPointer(p)).toEqual({ oid, size: 123 });
    expect(parseLfsPointer('not a pointer')).toBeNull();
  });
});
