/**
 * Artifacts FS — core library (docs/ARTIFACTS-FS.md).
 *
 * One artifacts git repo per project (`<projectDir>/.artifacts.git`, bare).
 * One branch per workspace, branched off `main`; each branch is mounted via
 * `git worktree add` at `<workspaceDir>/.gitspace/artifacts` (base mounts
 * `main`). Roll-up merges a workspace branch into `main`; abandon deletes it.
 *
 * Large files use an LFS-style pointer split: bytes ≥ threshold are stored
 * content-addressed (sha256) in `<projectDir>/.artifacts-blobs/` and the repo
 * commits a standard git-LFS pointer file instead. Provenance rides in
 * git-notes so metadata never mutates content commits.
 *
 * All functions take explicit directories (no global config) so they are unit
 * testable against temp dirs; command/daemon layers resolve project names.
 */

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { SpacesError } from '../types/errors.js';
import { escapeShellArg } from '../utils/shell-escape.js';

const execAsync = promisify(exec);

/** Machine identity for artifacts commits (artifact commits are tool-authored). */
const GIT_ID = `-c user.name=${escapeShellArg('gitspace')} -c user.email=${escapeShellArg('artifacts@gitspace.sh')} -c commit.gpgsign=false`;

export const DEFAULT_POINTER_THRESHOLD_BYTES = 2 * 1024 * 1024;
const ARTIFACTS_REPO_DIR = '.artifacts.git';
const ARTIFACTS_BLOBS_DIR = '.artifacts-blobs';
const MOUNT_RELATIVE = join('.gitspace', 'artifacts');
const MAIN_BRANCH = 'main';

export interface ArtifactPaths {
  repoDir: string;
  blobsDir: string;
}

export function artifactPaths(projectDir: string): ArtifactPaths {
  return {
    repoDir: join(projectDir, ARTIFACTS_REPO_DIR),
    blobsDir: join(projectDir, ARTIFACTS_BLOBS_DIR),
  };
}

export function artifactsMountDir(workspaceOrBaseDir: string): string {
  return join(workspaceOrBaseDir, MOUNT_RELATIVE);
}

async function git(cwdOrRepo: string, args: string, opts: { id?: boolean } = {}): Promise<string> {
  const cmd = `git -C ${escapeShellArg(cwdOrRepo)} ${opts.id ? `${GIT_ID} ` : ''}${args}`;
  try {
    const { stdout } = await execAsync(cmd);
    return stdout.trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SpacesError(`git failed (${args.split(' ')[0]}): ${msg}`, 'SYSTEM_ERROR', 1);
  }
}

/** Lazily create the project's bare artifacts repo with a root commit on main. */
export async function ensureArtifactsRepo(projectDir: string): Promise<string> {
  const { repoDir } = artifactPaths(projectDir);
  if (existsSync(join(repoDir, 'HEAD'))) return repoDir;
  await initBareArtifactsRepo(repoDir);
  await seedRootCommit(repoDir);
  return repoDir;
}

/** Root commit via plumbing (a bare repo has no working tree to commit from). */
async function seedRootCommit(repoDir: string): Promise<void> {
  const readme = 'Artifacts for this gitspace project. See docs/ARTIFACTS-FS.md.\n';
  const blob = await git(repoDir, `hash-object -w --stdin <<'GSEOF'\n${readme}GSEOF`);
  const tree = await git(repoDir, `mktree <<'GSEOF'\n100644 blob ${blob}\tREADME.md\nGSEOF`);
  const commit = await git(repoDir, `commit-tree ${tree} -m ${escapeShellArg('init artifacts')}`, { id: true });
  await git(repoDir, `update-ref refs/heads/${MAIN_BRANCH} ${commit}`);
  await git(repoDir, `symbolic-ref HEAD refs/heads/${MAIN_BRANCH}`);
}

async function initBareArtifactsRepo(repoDir: string): Promise<void> {
  mkdirSync(repoDir, { recursive: true });
  await git(repoDir, `init --bare --initial-branch=${MAIN_BRANCH} -q`);
}

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  try {
    await git(repoDir, `show-ref --verify -q refs/heads/${escapeShellArg(branch)}`);
    return true;
  } catch {
    return false;
  }
}

/** Append `.gitspace/artifacts/` to the enclosing code repo's shared exclude
 *  file so the mount never shows up in `git status`. Best-effort: silently
 *  skipped when the dir isn't inside a git repo. */
async function ensureCodeRepoExcludes(dirInsideCodeRepo: string): Promise<void> {
  try {
    const excludeRel = await git(dirInsideCodeRepo, 'rev-parse --git-path info/exclude');
    const gitRoot = await git(dirInsideCodeRepo, 'rev-parse --show-toplevel');
    const excludePath = excludeRel.startsWith('/') ? excludeRel : join(gitRoot, excludeRel);
    const line = `${MOUNT_RELATIVE}/`;
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    if (!current.split('\n').includes(line)) {
      mkdirSync(dirname(excludePath), { recursive: true });
      appendFileSync(excludePath, `${current.endsWith('\n') || current === '' ? '' : '\n'}${line}\n`);
    }
  } catch {
    /* not a git repo (tests, exotic layouts) — nothing to exclude */
  }
}

/**
 * Ensure `branch` exists (off main) and is mounted at
 * `<workspaceDir>/.gitspace/artifacts`. Pass `branch = 'main'` for the base
 * clone's mount. Idempotent.
 */
export async function ensureArtifactsMount(projectDir: string, workspaceDir: string, branch: string): Promise<string> {
  const repoDir = await ensureArtifactsRepo(projectDir);
  if (branch !== MAIN_BRANCH && !(await branchExists(repoDir, branch))) {
    await git(repoDir, `branch ${escapeShellArg(branch)} ${MAIN_BRANCH}`);
  }
  const mountDir = artifactsMountDir(workspaceDir);
  if (!existsSync(join(mountDir, '.git'))) {
    mkdirSync(dirname(mountDir), { recursive: true });
    await git(repoDir, `worktree add ${escapeShellArg(mountDir)} ${escapeShellArg(branch)}`);
  }
  await ensureCodeRepoExcludes(workspaceDir);
  return mountDir;
}

// ── LFS pointers ────────────────────────────────────────────────────────────

const LFS_VERSION_LINE = 'version https://git-lfs.github.com/spec/v1';

export function makeLfsPointer(sha256Hex: string, sizeBytes: number): string {
  return `${LFS_VERSION_LINE}\noid sha256:${sha256Hex}\nsize ${sizeBytes}\n`;
}

export function parseLfsPointer(text: string): { oid: string; size: number } | null {
  if (!text.startsWith(LFS_VERSION_LINE)) return null;
  const oid = /\noid sha256:([0-9a-f]{64})\n/.exec(text)?.[1];
  const size = /\nsize (\d+)\n?/.exec(text)?.[1];
  if (!oid || !size) return null;
  return { oid, size: Number(size) };
}

/** Content-addressed location of a blob in the local blob store. */
export function artifactBlobPath(blobsDir: string, oid: string): string {
  return join(blobsDir, oid.slice(0, 2), oid);
}

const blobPath = artifactBlobPath;

// ── capture ─────────────────────────────────────────────────────────────────

export interface CaptureFile {
  /** Path inside the mount (posix-relative, e.g. "demos/run.webm"). */
  path: string;
  content?: Buffer | string;
  /** Alternative to `content`: copy from this file. */
  sourceFile?: string;
}

export interface CaptureProvenance {
  session?: string;
  goal?: string;
  chain?: string;
  tool?: string;
  [key: string]: string | undefined;
}

export interface CaptureResult {
  commit: string;
  /** Paths that were stored as LFS pointers (blob in the blob store). */
  pointers: string[];
}

function assertSafeRelPath(rel: string): void {
  if (!rel || rel.startsWith('/') || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new SpacesError(`Unsafe artifact path: ${rel}`, 'USER_ERROR', 1);
  }
}

/** Write files into a mount and commit them on its branch (one commit).
 *  Files at/over the pointer threshold are stored in the blob store and
 *  committed as LFS pointers. Provenance is attached as a git note. */
export async function captureArtifacts(
  projectDir: string,
  mountDir: string,
  files: CaptureFile[],
  opts: { message?: string; provenance?: CaptureProvenance; pointerThresholdBytes?: number } = {},
): Promise<CaptureResult> {
  if (files.length === 0) throw new SpacesError('captureArtifacts: no files given', 'USER_ERROR', 1);
  const { blobsDir } = artifactPaths(projectDir);
  const threshold = opts.pointerThresholdBytes ?? DEFAULT_POINTER_THRESHOLD_BYTES;
  const pointers = files.filter((f) => writeCaptureFile(blobsDir, mountDir, f, threshold)).map((f) => f.path);

  const added = files.map((f) => escapeShellArg(f.path)).join(' ');
  await git(mountDir, `add -- ${added}`);
  const message = opts.message ?? `capture: ${files.map((f) => f.path).join(', ')}`.slice(0, 200);
  await git(mountDir, `commit -q -m ${escapeShellArg(message)}`, { id: true });
  const commit = await git(mountDir, 'rev-parse HEAD');
  if (opts.provenance && Object.keys(opts.provenance).length > 0) {
    await git(mountDir, `notes add -f -m ${escapeShellArg(JSON.stringify(opts.provenance))} ${commit}`, { id: true });
  }
  return { commit, pointers };
}

function raiseMissingSource(path: string): never {
  throw new SpacesError(`captureArtifacts: file ${path} has neither content nor sourceFile`, 'USER_ERROR', 1);
}

/** Write one capture file into the mount (pointer-splitting large bytes).
 *  Returns true when the file was stored as a pointer. */
function writeCaptureFile(blobsDir: string, mountDir: string, f: CaptureFile, threshold: number): boolean {
  assertSafeRelPath(f.path);
  const bytes = f.content !== undefined
    ? (typeof f.content === 'string' ? Buffer.from(f.content) : f.content)
    : readFileSync(f.sourceFile ?? raiseMissingSource(f.path));
  const target = join(mountDir, f.path);
  mkdirSync(dirname(target), { recursive: true });
  if (bytes.length >= threshold) {
    const oid = createHash('sha256').update(bytes).digest('hex');
    const bp = blobPath(blobsDir, oid);
    if (!existsSync(bp)) {
      mkdirSync(dirname(bp), { recursive: true });
      writeFileSync(bp, bytes);
    }
    writeFileSync(target, makeLfsPointer(oid, bytes.length));
    return true;
  }
  writeFileSync(target, bytes);
  return false;
}

/** Synchronous twin of {@link captureArtifacts} for sync producer paths
 *  (e.g. goal-validation evidence). Same semantics, execSync git. */
export function captureArtifactsSync(
  projectDir: string,
  mountDir: string,
  files: CaptureFile[],
  opts: { message?: string; provenance?: CaptureProvenance; pointerThresholdBytes?: number } = {},
): CaptureResult {
  if (files.length === 0) throw new SpacesError('captureArtifacts: no files given', 'USER_ERROR', 1);
  const { blobsDir } = artifactPaths(projectDir);
  const threshold = opts.pointerThresholdBytes ?? DEFAULT_POINTER_THRESHOLD_BYTES;
  const pointers = files.filter((f) => writeCaptureFile(blobsDir, mountDir, f, threshold)).map((f) => f.path);
  const gitS = (args: string): string => {
    try {
      return execSync(`git -C ${escapeShellArg(mountDir)} ${GIT_ID} ${args}`, { encoding: 'utf8' }).trim();
    } catch (e) {
      throw new SpacesError(`git failed (${args.split(' ')[0]}): ${e instanceof Error ? e.message : e}`, 'SYSTEM_ERROR', 1);
    }
  };
  gitS(`add -- ${files.map((f) => escapeShellArg(f.path)).join(' ')}`);
  const message = opts.message ?? `capture: ${files.map((f) => f.path).join(', ')}`.slice(0, 200);
  gitS(`commit -q -m ${escapeShellArg(message)}`);
  const commit = gitS('rev-parse HEAD');
  if (opts.provenance && Object.keys(opts.provenance).length > 0) {
    gitS(`notes add -f -m ${escapeShellArg(JSON.stringify(opts.provenance))} ${commit}`);
  }
  return { commit, pointers };
}

export interface ArtifactListEntry {
  /** Mount-relative posix path. */
  path: string;
  /** On-disk size; for pointers this is the REAL blob size. */
  size: number;
  /** Stored as an LFS pointer (blob lives in the blob store). */
  pointer: boolean;
}

/** Recursively list a mount's files (pointer-aware, `.git` excluded). */
export function listArtifactFiles(mountDir: string): ArtifactListEntry[] {
  const out: ArtifactListEntry[] = [];
  const walk = (rel: string): void => {
    const abs = rel ? join(mountDir, rel) : mountDir;
    for (const name of readdirSync(abs)) {
      if (rel === '' && (name === '.git' || name.startsWith('.git'))) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const st = statSync(join(mountDir, childRel));
      if (st.isDirectory()) {
        walk(childRel);
      } else {
        let size = st.size;
        let pointer = false;
        if (st.size < 400) {
          const ptr = parseLfsPointer(readFileSync(join(mountDir, childRel), 'utf8'));
          if (ptr) {
            pointer = true;
            size = ptr.size;
          }
        }
        out.push({ path: childRel, size, pointer });
      }
    }
  };
  if (!existsSync(mountDir)) return out;
  walk('');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Read an artifact from a mount, transparently resolving LFS pointers. */
export function readArtifact(projectDir: string, mountDir: string, relPath: string): Buffer {
  assertSafeRelPath(relPath);
  const raw = readFileSync(join(mountDir, relPath));
  const head = raw.subarray(0, 200).toString('utf8');
  const ptr = parseLfsPointer(head.startsWith(LFS_VERSION_LINE) ? raw.toString('utf8') : '');
  if (!ptr) return raw;
  const { blobsDir } = artifactPaths(projectDir);
  const bp = blobPath(blobsDir, ptr.oid);
  if (!existsSync(bp)) throw new SpacesError(`Artifact blob missing: ${ptr.oid}`, 'SYSTEM_ERROR', 1);
  return readFileSync(bp);
}

/** Fetch a missing blob by oid (bytes or null when the store doesn't have it).
 *  Dependency-injected into {@link readArtifactResolving} so core stays
 *  testable offline; the managed tier supplies an HTTP-backed implementation. */
export type ArtifactBlobFetcher = (oid: string, size: number) => Promise<Buffer | null>;

/**
 * Async twin of {@link readArtifact}: on a pointer-miss (blob absent locally)
 * it asks a blob-fetcher for the bytes, verifies the sha256, stores the blob
 * locally, and returns it. Default fetcher is the managed tier's (when this
 * project is attached to gitspace.sh-managed artifacts); pass `blobFetcher`
 * explicitly to override, or `null` to force offline behavior.
 */
export async function readArtifactResolving(
  projectDir: string,
  mountDir: string,
  relPath: string,
  opts: { blobFetcher?: ArtifactBlobFetcher | null } = {},
): Promise<Buffer> {
  assertSafeRelPath(relPath);
  const raw = readFileSync(join(mountDir, relPath));
  const head = raw.subarray(0, 200).toString('utf8');
  const ptr = parseLfsPointer(head.startsWith(LFS_VERSION_LINE) ? raw.toString('utf8') : '');
  if (!ptr) return raw;
  const { blobsDir } = artifactPaths(projectDir);
  const bp = blobPath(blobsDir, ptr.oid);
  if (existsSync(bp)) return readFileSync(bp);

  const fetcher = opts.blobFetcher !== undefined ? opts.blobFetcher : await defaultManagedBlobFetcher(projectDir);
  if (fetcher) {
    const bytes = await fetcher(ptr.oid, ptr.size).catch(() => null);
    if (bytes) {
      const gotOid = createHash('sha256').update(bytes).digest('hex');
      if (gotOid !== ptr.oid) {
        throw new SpacesError(
          `Fetched artifact blob hash mismatch for ${relPath} (expected ${ptr.oid}, got ${gotOid})`,
          'SYSTEM_ERROR',
          1,
        );
      }
      mkdirSync(dirname(bp), { recursive: true });
      writeFileSync(bp, bytes);
      return bytes;
    }
  }
  throw new SpacesError(`Artifact blob missing: ${ptr.oid}`, 'SYSTEM_ERROR', 1);
}

/** Managed-tier blob fetcher for this project, or null when unmanaged. */
async function defaultManagedBlobFetcher(projectDir: string): Promise<ArtifactBlobFetcher | null> {
  try {
    const managed = await import('./artifacts-managed.js');
    return await managed.createDefaultBlobFetcher(projectDir);
  } catch {
    return null;
  }
}

// ── roll-up / abandon ───────────────────────────────────────────────────────

/** Where (if anywhere) a branch is currently checked out as a worktree. */
async function worktreeFor(repoDir: string, branch: string): Promise<string | null> {
  const out = await git(repoDir, 'worktree list --porcelain');
  let current: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}` && current) return current;
  }
  return null;
}

/**
 * Merge a workspace's artifacts branch into main (no-ff, so roll-ups stay
 * visible in history). Uses the existing main mount when present, otherwise a
 * temporary worktree. On merge conflict the merge is aborted and a
 * USER_ERROR is thrown (roll-up is where curation happens — the caller
 * surfaces the conflict for a manual pass).
 */
export async function rollupArtifacts(
  projectDir: string,
  branch: string,
  opts: { removeBranch?: boolean; message?: string } = {},
): Promise<{ mergeCommit: string }> {
  const { repoDir } = artifactPaths(projectDir);
  if (branch === MAIN_BRANCH) throw new SpacesError('Cannot roll up main into itself', 'USER_ERROR', 1);
  if (!(await branchExists(repoDir, branch))) throw new SpacesError(`No artifacts branch: ${branch}`, 'USER_ERROR', 1);

  let mainDir = await worktreeFor(repoDir, MAIN_BRANCH);
  let temp: string | null = null;
  if (!mainDir) {
    temp = join(projectDir, `.artifacts-rollup-${Date.now()}`);
    await git(repoDir, `worktree add ${escapeShellArg(temp)} ${MAIN_BRANCH}`);
    mainDir = temp;
  }
  try {
    const message = opts.message ?? `rollup: ${branch}`;
    try {
      await git(mainDir, `merge --no-ff -m ${escapeShellArg(message)} ${escapeShellArg(branch)}`, { id: true });
    } catch (e) {
      await git(mainDir, 'merge --abort').catch(() => undefined);
      throw new SpacesError(
        `Artifacts roll-up of ${branch} has conflicts — curate manually (${e instanceof Error ? e.message.split('\n')[0] : e})`,
        'USER_ERROR',
        1,
      );
    }
    const mergeCommit = await git(mainDir, 'rev-parse HEAD');
    if (opts.removeBranch) {
      const mounted = await worktreeFor(repoDir, branch);
      if (mounted) await git(repoDir, `worktree remove --force ${escapeShellArg(mounted)}`);
      await git(repoDir, `branch -D ${escapeShellArg(branch)}`);
    }
    return { mergeCommit };
  } finally {
    if (temp) await git(repoDir, `worktree remove --force ${escapeShellArg(temp)}`).catch(() => undefined);
  }
}

/** Clean up stale worktree registrations after a workspace dir was deleted
 *  out from under its mount (workspace removal deletes the whole tree). The
 *  branch survives for a later roll-up. Best-effort no-op without a repo. */
export async function pruneArtifactMounts(projectDir: string): Promise<void> {
  const { repoDir } = artifactPaths(projectDir);
  if (!existsSync(join(repoDir, 'HEAD'))) return;
  await git(repoDir, 'worktree prune').catch(() => undefined);
}

// ── remotes / sync (Tier 1: BYO — docs/ARTIFACTS-FS.md) ────────────────────

/** The committed pointer file in the CODE repo that lets any clone rediscover
 *  its artifacts (the .gitmodules pattern). BYO form: explicit remote URL. */
export interface ArtifactsPointerConfig {
  /** gitspace.sh-managed identity ("handle/slug") — Tier 2, resolved later. */
  project?: string;
  /** BYO: explicit git remote URL for the artifacts repo. */
  remote?: string;
}

const POINTER_CONFIG_RELATIVE = join('.gitspace', 'artifacts.json');

export function readArtifactsPointerConfig(codeRepoDir: string): ArtifactsPointerConfig | null {
  const p = join(codeRepoDir, POINTER_CONFIG_RELATIVE);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as ArtifactsPointerConfig;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Write + stage the pointer file in the code repo (committing is the user's
 *  call — it lands in their history). */
export async function writeArtifactsPointerConfig(codeRepoDir: string, config: ArtifactsPointerConfig): Promise<void> {
  const p = join(codeRepoDir, POINTER_CONFIG_RELATIVE);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(config, null, 2)}\n`);
  await git(codeRepoDir, `add -- ${escapeShellArg(POINTER_CONFIG_RELATIVE)}`).catch(() => undefined);
}

export async function getArtifactsRemote(projectDir: string): Promise<string | null> {
  const { repoDir } = artifactPaths(projectDir);
  if (!existsSync(join(repoDir, 'HEAD'))) return null;
  try {
    return await git(repoDir, 'remote get-url origin');
  } catch {
    return null;
  }
}

export async function setArtifactsRemote(
  projectDir: string,
  url: string,
  opts: { beforeFetch?: (repoDir: string) => Promise<void> } = {},
): Promise<void> {
  const { repoDir } = artifactPaths(projectDir);
  // Fresh repo + remote: ADOPT the remote's main instead of seeding an
  // unrelated local root commit (a second machine attaching via
  // .gitspace/artifacts.json must fast-forward from the remote's history).
  if (!existsSync(join(repoDir, 'HEAD'))) {
    await initBareArtifactsRepo(repoDir);
    await git(repoDir, `remote add origin ${escapeShellArg(url)}`);
    // Managed tier hook: install http auth config before the adopt fetch.
    await opts.beforeFetch?.(repoDir);
    try {
      await git(repoDir, 'fetch origin --prune');
      await git(repoDir, `update-ref refs/heads/${MAIN_BRANCH} refs/remotes/origin/${MAIN_BRANCH}`);
      await git(repoDir, `symbolic-ref HEAD refs/heads/${MAIN_BRANCH}`);
    } catch {
      // Remote unreachable or empty — fall back to a local root commit so the
      // repo is usable offline; a later sync will reconcile (empty remote
      // accepts our push; unreachable stays local-first).
      await seedRootCommit(repoDir);
    }
    return;
  }
  const existing = await getArtifactsRemote(projectDir);
  if (existing === null) await git(repoDir, `remote add origin ${escapeShellArg(url)}`);
  else await git(repoDir, `remote set-url origin ${escapeShellArg(url)}`);
}

// ── managed project marker (Tier 2 — gitspace.sh-managed) ──────────────────

/** Local, machine-scoped marker (bare-repo git config) that this project's
 *  artifacts are gitspace.sh-managed ("handle/slug"). The committed
 *  `.gitspace/artifacts.json` is the durable cross-machine pointer; this is
 *  the resolved local state derived from it. */
const MANAGED_PROJECT_CONFIG_KEY = 'gitspace.artifactsProject';

export async function getManagedArtifactsProject(projectDir: string): Promise<string | null> {
  const { repoDir } = artifactPaths(projectDir);
  if (!existsSync(join(repoDir, 'HEAD'))) return null;
  try {
    const v = await git(repoDir, `config --get ${MANAGED_PROJECT_CONFIG_KEY}`);
    return v || null;
  } catch {
    return null;
  }
}

export async function setManagedArtifactsProject(projectDir: string, project: string): Promise<void> {
  const repoDir = await ensureArtifactsRepo(projectDir);
  await git(repoDir, `config ${MANAGED_PROJECT_CONFIG_KEY} ${escapeShellArg(project)}`);
}

export interface ArtifactsBlobSyncResult {
  total: number;
  uploaded: number;
  alreadyPresent: number;
  failed: number;
}

export interface ArtifactsSyncResult {
  pushed: boolean;
  fastForwarded: boolean;
  /** Present only for managed (Tier 2) syncs — blob store upload results. */
  blobs?: ArtifactsBlobSyncResult;
}

/** Sync the artifacts repo with its remote. BYO (Tier 1): git-only. Managed
 *  (Tier 2, when a managed project is configured): token-refreshing git sync
 *  plus blob-store upload of any local blobs the API doesn't have yet. */
export async function syncArtifacts(projectDir: string): Promise<ArtifactsSyncResult> {
  const managedProject = await getManagedArtifactsProject(projectDir);
  if (managedProject) {
    const { syncManagedArtifacts } = await import('./artifacts-managed.js');
    return syncManagedArtifacts(projectDir, managedProject);
  }
  return syncArtifactsGit(projectDir);
}

/** Git-only sync: fetch, fast-forward main (through the live main mount when
 *  one exists), push all branches. Conflict-free by construction — non-ff
 *  main means someone must roll up/curate manually. This is the whole story
 *  for BYO; the managed tier wraps it with token refresh + blob sync. */
export async function syncArtifactsGit(projectDir: string): Promise<ArtifactsSyncResult> {
  const { repoDir } = artifactPaths(projectDir);
  const remote = await getArtifactsRemote(projectDir);
  if (!remote) throw new SpacesError('No artifacts remote configured (gssh artifacts remote add <url>)', 'USER_ERROR', 1);
  await git(repoDir, 'fetch origin --prune');
  let fastForwarded = false;
  const hasRemoteMain = await git(repoDir, `rev-parse --verify --quiet refs/remotes/origin/${MAIN_BRANCH}`).then(() => true).catch(() => false);
  if (hasRemoteMain) {
    const mainDir = await worktreeFor(repoDir, MAIN_BRANCH);
    try {
      if (mainDir) await git(mainDir, `merge --ff-only origin/${MAIN_BRANCH}`, { id: true });
      else await git(repoDir, `fetch origin ${MAIN_BRANCH}:${MAIN_BRANCH}`);
      fastForwarded = true;
    } catch {
      /* non-ff — leave for manual curation */
    }
  }
  await git(repoDir, 'push origin --all');
  return { pushed: true, fastForwarded };
}

/** Drop a workspace's artifacts branch (and its mount) without merging. */
export async function abandonArtifacts(projectDir: string, branch: string): Promise<void> {
  const { repoDir } = artifactPaths(projectDir);
  if (branch === MAIN_BRANCH) throw new SpacesError('Refusing to abandon main', 'USER_ERROR', 1);
  const mounted = await worktreeFor(repoDir, branch);
  if (mounted) await git(repoDir, `worktree remove --force ${escapeShellArg(mounted)}`);
  if (await branchExists(repoDir, branch)) await git(repoDir, `branch -D ${escapeShellArg(branch)}`);
}
