/**
 * Enforcement floor (docs/ARTIFACT-PROTOCOL.md Q1) — the managed hooks, the
 * publish gates, and repair, exercised against real git in temp dirs. This
 * harness is NON-OPTIONAL: the dash failure mode (silent exit-0 no-op letting
 * raw bytes through) is invisible without it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  artifactHooksStatus,
  artifactPaths,
  captureArtifacts,
  ensureArtifactsMount,
  ensureArtifactsRepo,
  installArtifactHooks,
  parseLfsPointer,
  readArtifact,
  repairArtifacts,
  rollupArtifacts,
  scanRawBlobOffenders,
  setArtifactsRemote,
  syncArtifacts,
} from '../artifacts.js';

const MB = 1024 * 1024;

let projectDir: string;
const wsDir = (name: string): string => join(projectDir, 'workspaces', name);
const g = (cwd: string, args: string, env?: Record<string, string>): string =>
  execSync(`git -C ${JSON.stringify(cwd)} -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${args}`, {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : undefined,
  }).trim();

async function mountFor(name: string): Promise<string> {
  mkdirSync(wsDir(name), { recursive: true });
  return ensureArtifactsMount(projectDir, wsDir(name), name);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'gs-hooks-'));
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('hook install', () => {
  it('installs versioned hooks on repo create, re-installs when stale, reports status', async () => {
    const repo = await ensureArtifactsRepo(projectDir);
    const pre = join(repo, 'hooks', 'pre-commit');
    const post = join(repo, 'hooks', 'post-commit');
    expect(existsSync(pre)).toBe(true);
    expect(existsSync(post)).toBe(true);
    expect(readFileSync(pre, 'utf8')).toContain('# gssh-hook-v');
    expect(artifactHooksStatus(projectDir)).toBe('ok');

    writeFileSync(pre, '#!/bin/bash\nexit 0\n');
    expect(artifactHooksStatus(projectDir)).toBe('stale');
    installArtifactHooks(projectDir);
    expect(artifactHooksStatus(projectDir)).toBe('ok');

    rmSync(post);
    expect(artifactHooksStatus(projectDir)).toBe('missing');
    await ensureArtifactsRepo(projectDir); // every ensure self-heals
    expect(artifactHooksStatus(projectDir)).toBe('ok');
  });
});

describe('pre-commit pointer conversion (hand commits)', () => {
  it('plain add+commit of a ≥2MB file lands a pointer, stores the blob, stages .gitattributes, notes provenance', async () => {
    const mount = await mountFor('w1');
    const big = Buffer.alloc(3 * MB, 7);
    mkdirSync(join(mount, 'demos'), { recursive: true });
    writeFileSync(join(mount, 'demos', 'big.bin'), big);
    g(mount, 'add -A');
    g(mount, 'commit -q -m "hand commit"', { GSSH_SESSION_ID: 'sess-123' });

    // committed content is the 132-byte pointer, not raw bytes
    const committed = g(mount, 'show HEAD:demos/big.bin');
    const ptr = parseLfsPointer(`${committed}\n`);
    expect(ptr).not.toBeNull();
    expect(ptr!.size).toBe(3 * MB);
    // working file rewritten to the pointer; status clean
    expect(parseLfsPointer(readFileSync(join(mount, 'demos', 'big.bin'), 'utf8'))).not.toBeNull();
    expect(g(mount, 'status --porcelain')).toBe('');
    // blob in the store; readArtifact resolves
    const { blobsDir } = artifactPaths(projectDir);
    expect(existsSync(join(blobsDir, ptr!.oid.slice(0, 2), ptr!.oid))).toBe(true);
    expect(readArtifact(projectDir, mount, 'demos/big.bin').equals(big)).toBe(true);
    // .gitattributes line committed
    expect(g(mount, 'show HEAD:.gitattributes')).toContain('demos/big.bin filter=lfs diff=lfs merge=lfs -text');
    // post-commit provenance note with session identity
    const note = JSON.parse(g(mount, 'notes show HEAD'));
    expect(note.tool).toBe('hand-commit');
    expect(note.session).toBe('sess-123');
  });

  it('commit -a converts a modified tracked file', async () => {
    const mount = await mountFor('w2');
    writeFileSync(join(mount, 'file.bin'), 'small');
    g(mount, 'add -A');
    g(mount, 'commit -q -m small');
    writeFileSync(join(mount, 'file.bin'), Buffer.alloc(2 * MB + 1, 3));
    g(mount, 'commit -q -am grow');
    const ptr = parseLfsPointer(`${g(mount, 'show HEAD:file.bin')}\n`);
    expect(ptr).not.toBeNull();
    expect(ptr!.size).toBe(2 * MB + 1);
    expect(g(mount, 'status --porcelain')).toBe('');
  });

  it('small files pass untouched and capture commits are left to captureArtifacts', async () => {
    const mount = await mountFor('w3');
    writeFileSync(join(mount, 'note.md'), '# small\n');
    g(mount, 'add -A');
    g(mount, 'commit -q -m note');
    expect(g(mount, 'show HEAD:note.md')).toBe('# small');

    // capture path: its own note survives (post-commit stands down)
    const { commit } = await captureArtifacts(projectDir, mount, [
      { path: 'evidence/run.bin', content: Buffer.alloc(3 * MB, 9) },
    ], { provenance: { session: 's-9', tool: 'test' } });
    const note = JSON.parse(g(mount, `notes show ${commit}`));
    expect(note).toEqual({ session: 's-9', tool: 'test' });
  });

  it('aborts the commit when the blob store is unwritable (no silent raw bytes)', async () => {
    const mount = await mountFor('w4');
    const { blobsDir } = artifactPaths(projectDir);
    // Make the blob store an unusable FILE so mkdir -p fails.
    writeFileSync(blobsDir, 'not a dir');
    writeFileSync(join(mount, 'big.bin'), Buffer.alloc(3 * MB, 1));
    g(mount, 'add -A');
    const before = g(mount, 'rev-list --count HEAD');
    expect(() => g(mount, 'commit -q -m boom')).toThrow();
    expect(g(mount, 'rev-list --count HEAD')).toBe(before);
    rmSync(blobsDir);
  });
});

describe('publish gates + repair', () => {
  async function remoteFixture(): Promise<string> {
    const remote = join(projectDir, 'remote.git');
    execSync(`git init -q --bare ${JSON.stringify(remote)}`);
    await setArtifactsRemote(projectDir, remote);
    return remote;
  }

  it('sync refuses a branch with a --no-verify raw blob, pushes clean branches, and repair unblocks it', async () => {
    const dirty = await mountFor('dirty');
    const clean = await mountFor('clean');
    const remote = await remoteFixture();

    writeFileSync(join(clean, 'ok.md'), 'fine');
    g(clean, 'add -A');
    g(clean, 'commit -q -m ok');

    writeFileSync(join(dirty, 'raw.bin'), Buffer.alloc(3 * MB, 5));
    g(dirty, 'add -A');
    g(dirty, 'commit -q --no-verify -m sneak');

    const sync = await syncArtifacts(projectDir);
    expect(sync.pushed).toBe(true); // clean branches still went
    expect(sync.refused).toHaveLength(1);
    expect(sync.refused![0]!.branch).toBe('dirty');
    expect(sync.refused![0]!.offenders[0]!.path).toBe('raw.bin');
    // the raw bytes never left the machine
    const remoteBranches = execSync(`git -C ${JSON.stringify(remote)} for-each-ref --format='%(refname:short)' refs/heads`, { encoding: 'utf8' });
    expect(remoteBranches).toContain('clean');
    expect(remoteBranches).not.toContain('dirty');

    const r = await repairArtifacts(projectDir, dirty);
    expect(r.repaired).toBe(1);
    const ptr = parseLfsPointer(`${g(dirty, 'show HEAD:raw.bin')}\n`);
    expect(ptr).not.toBeNull();

    const again = await syncArtifacts(projectDir);
    expect(again.refused).toBeUndefined();
    const afterBranches = execSync(`git -C ${JSON.stringify(remote)} for-each-ref --format='%(refname:short)' refs/heads`, { encoding: 'utf8' });
    expect(afterBranches).toContain('dirty');
    // and what arrived remotely is the pointer, not 3MB of raw bytes
    const remoteBlob = execSync(`git -C ${JSON.stringify(remote)} show dirty:raw.bin`, { encoding: 'utf8' });
    expect(parseLfsPointer(remoteBlob)).not.toBeNull();
  });

  it('rollup refuses a branch with raw blobs and succeeds after repair', async () => {
    const mount = await mountFor('feature');
    writeFileSync(join(mount, 'video.bin'), Buffer.alloc(4 * MB, 2));
    g(mount, 'add -A');
    g(mount, 'commit -q --no-verify -m sneak');

    await expect(rollupArtifacts(projectDir, 'feature')).rejects.toThrow('refused');
    await repairArtifacts(projectDir, mount);
    const { mergeCommit } = await rollupArtifacts(projectDir, 'feature');
    expect(mergeCommit).toBeTruthy();
    const { repoDir } = artifactPaths(projectDir);
    // main carries the pointer
    const inMain = execSync(`git -C ${JSON.stringify(repoDir)} show main:video.bin`, { encoding: 'utf8' });
    expect(parseLfsPointer(inMain)).not.toBeNull();
  });

  it('repair squashes multiple offending commits, preserves messages, is a no-op when clean', async () => {
    const mount = await mountFor('multi');
    writeFileSync(join(mount, 'a.bin'), Buffer.alloc(3 * MB, 1));
    g(mount, 'add -A');
    g(mount, 'commit -q --no-verify -m "first sneak"');
    writeFileSync(join(mount, 'note.md'), 'in between');
    g(mount, 'add -A');
    g(mount, 'commit -q -m "note commit"');

    const r = await repairArtifacts(projectDir, mount);
    expect(r.repaired).toBe(2);
    expect(g(mount, 'log -1 --format=%B')).toContain('first sneak');
    expect(g(mount, 'log -1 --format=%B')).toContain('note commit');
    expect(g(mount, 'status --porcelain')).toBe('');
    expect(await scanRawBlobOffenders(artifactPaths(projectDir).repoDir, 'multi --not main')).toHaveLength(0);
    // note survived alongside the pointer
    expect(g(mount, 'show HEAD:note.md')).toBe('in between');

    expect((await repairArtifacts(projectDir, mount)).repaired).toBe(0);
  });

  it('repair refuses a mount with uncommitted tracked changes', async () => {
    const mount = await mountFor('busy');
    writeFileSync(join(mount, 'raw.bin'), Buffer.alloc(3 * MB, 5));
    g(mount, 'add -A');
    g(mount, 'commit -q --no-verify -m sneak');
    writeFileSync(join(mount, 'README.md'), 'edited but not committed');
    await expect(repairArtifacts(projectDir, mount)).rejects.toThrow('uncommitted');
  });
});
