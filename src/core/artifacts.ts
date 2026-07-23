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

import { exec, execFileSync, execSync } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { SpacesError } from '../types/errors.js';
import { pathInScope, localScratchRel, AMBIENT_WRITE_SCOPES } from './artifact-cap.js';
import { escapeShellArg } from '../utils/shell-escape.js';

const execAsync = promisify(exec);

/** Machine identity for artifacts commits (artifact commits are tool-authored). */
const GIT_ID = `-c user.name=${escapeShellArg('gitspace')} -c user.email=${escapeShellArg('artifacts@gitspace.sh')} -c commit.gpgsign=false`;
/** argv form of {@link GIT_ID} for execFileSync plumbing (no shell). */
const GIT_ID_ARGV = ['-c', 'user.name=gitspace', '-c', 'user.email=artifacts@gitspace.sh', '-c', 'commit.gpgsign=false'];

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

// ── goal-keyed layout / scope roots (docs/ARTIFACTS-FS.md "Tree layout") ────
//
// Every goal owns `goals/<goal-id>/` and NOTHING else; project-level artifacts
// live at the tree root. Disjoint goal folders are what make roll-up (merging a
// workspace's artifacts branch into main) mechanically conflict-free — two
// workspaces can never touch the same path. The flat layout (goal.md,
// rubric.json, reports/ at the mount root of every branch) collided on every
// merge, which is why it was migrated away from.
//
// `local://` means "the root I own", bound per session:
//   workspace / goal agent → goals/<goal-id>/      project agent → tree root

export const ARTIFACTS_GOALS_DIR = 'goals';

/** Mount-relative root of one goal's subtree. */
export function goalScopeRel(goalId: string): string {
  assertSafeRelPath(`${ARTIFACTS_GOALS_DIR}/${goalId}`);
  return `${ARTIFACTS_GOALS_DIR}/${goalId}`;
}

/** Does a mount-relative path fall inside ANY goal folder? */
export function isGoalScopedPath(relPath: string): boolean {
  return relPath === ARTIFACTS_GOALS_DIR || relPath.startsWith(`${ARTIFACTS_GOALS_DIR}/`);
}

/**
 * The goal id owning a workspace, read straight off the workspace's goal
 * record. Read as raw JSON rather than through `core/goal-chain.ts` on
 * purpose: goal-chain imports this module (canon write-through), so importing
 * it back would be a cycle, and `core/config.ts` has a top-level await that
 * makes it unsafe to pull into this dependency-light layer.
 *
 * Returns null for a dir that owns no goal — the project base clone (which
 * mounts `main`), or a workspace created before goal records existed. Callers
 * treat null as "scope is the tree root".
 */
export function readWorkspaceGoalId(workspaceDir: string): string | null {
  const name = basename(workspaceDir);
  const goalFile = join(workspaceDir, '.gitspace', 'workspace', name, 'goal.json');
  if (!existsSync(goalFile)) return null;
  try {
    const id = (JSON.parse(readFileSync(goalFile, 'utf8')) as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * The artifacts scope a session owns: the mount plus the sub-root that
 * `local://` binds to. One object so callers never have to decide whether a
 * path is mount-relative or scope-relative by hand.
 */
export interface ArtifactsScope {
  /** Absolute path of the artifacts worktree mount. */
  mountDir: string;
  /** Mount-relative scope root: `goals/<id>` for a workspace, '' for project. */
  rootRel: string;
  /** Absolute path of the scope root — what `local://` binds to. */
  rootDir: string;
  /** True when this scope is the whole tree (project agent / base clone). */
  isProjectRoot: boolean;
  /** Scope-relative path → mount-relative path (what git commits). */
  rel(scopeRelPath: string): string;
  /** Scope-relative path → absolute path on disk. */
  abs(scopeRelPath: string): string;
}

/** Resolve the artifacts scope for a workspace (or base) directory. */
export function artifactsScope(workspaceOrBaseDir: string): ArtifactsScope {
  const mountDir = artifactsMountDir(workspaceOrBaseDir);
  const goalId = readWorkspaceGoalId(workspaceOrBaseDir);
  const rootRel = goalId ? goalScopeRel(goalId) : '';
  return {
    mountDir,
    rootRel,
    rootDir: rootRel ? join(mountDir, rootRel) : mountDir,
    isProjectRoot: rootRel === '',
    rel: (p: string) => (rootRel ? `${rootRel}/${p}` : p),
    abs: (p: string) => join(mountDir, rootRel ? `${rootRel}/${p}` : p),
  };
}

/**
 * Guard: `goals/**` is ROLL-UP-ONLY (docs/ARTIFACTS-FS.md).
 *
 * A project agent's `local://` is the tree root, so it CAN write into a goal
 * folder — it must not. The only writer of `goals/<id>/**` is the workspace
 * that owns the goal, and the only way that content reaches `main` is the
 * roll-up merge. If anything else edits a goal folder, the next roll-up of
 * that goal conflicts and the conflict-free property this layout exists for
 * is gone. Enforcement lives here rather than in skill prose because "the
 * agent knows not to" has a poor track record.
 */
/**
 * Companion guard for SCOPE-relative input (the paths a caller types at the
 * `space artifacts` CLI). Those get lifted through the scope root before git
 * sees them, so a workspace typing `goals/<other>/x` would silently become
 * `goals/<mine>/goals/<other>/x` — an ENOENT, or worse a real nested `goals/`
 * dir — instead of the refusal the author deserves. Reaching for `goals/` in
 * scope-relative space always means "I want another goal's folder", which is
 * never the caller's to write.
 */
export function assertScopeRelPathsNotGoalPrefixed(scope: ArtifactsScope, scopeRelPaths: string[]): void {
  if (scope.isProjectRoot) return; // at the tree root `goals/x` IS the real path — assertGoalScopeWrite judges it
  const offenders = scopeRelPaths.filter((p) => isGoalScopedPath(p));
  if (offenders.length === 0) return;
  throw new SpacesError(
    `Paths are relative to the goal folder you own (${scope.rootRel}), so ${offenders.join(', ')} would nest a second goals/ dir inside it. `
      + 'Write your own artifacts with a plain relative path (e.g. `reports/x.report.json`); '
      + 'to change another goal use `space goal set --goal <id>` — `goals/**` is roll-up-only.',
    'USER_ERROR',
    1,
  );
}

export function assertGoalScopeWrite(scope: ArtifactsScope, mountRelPaths: string[]): void {
  const offenders = mountRelPaths.filter(
    (p) => isGoalScopedPath(p) && !(scope.rootRel && (p === scope.rootRel || p.startsWith(`${scope.rootRel}/`))),
  );
  if (offenders.length === 0) return;
  throw new SpacesError(
    `goals/** is roll-up-only: ${offenders.join(', ')} is outside this session's scope (${scope.rootRel || 'project root'}). `
      + 'A goal folder has exactly one writer — the workspace that owns it — because that is what keeps roll-up merges conflict-free. '
      + 'To change another goal, use `space goal set --goal <id>`; to add project-level artifacts, write at the tree root.',
    'USER_ERROR',
    1,
  );
}

async function git(cwdOrRepo: string, args: string, opts: { id?: boolean; env?: Record<string, string> } = {}): Promise<string> {
  const cmd = `git -C ${escapeShellArg(cwdOrRepo)} ${opts.id ? `${GIT_ID} ` : ''}${args}`;
  try {
    const { stdout } = opts.env
      ? await execAsync(cmd, { env: { ...process.env, ...opts.env }, encoding: 'utf8' })
      : await execAsync(cmd);
    return stdout.trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SpacesError(`git failed (${args.split(' ')[0]}): ${msg}`, 'SYSTEM_ERROR', 1);
  }
}

/** Lazily create the project's bare artifacts repo with a root commit on main.
 *  Also (re)installs the managed hooks on EVERY call — existing projects
 *  self-migrate on the next mount touch, and hooks never travel with clones. */
export async function ensureArtifactsRepo(projectDir: string): Promise<string> {
  const { repoDir } = artifactPaths(projectDir);
  if (existsSync(join(repoDir, 'HEAD'))) {
    installArtifactHooks(projectDir);
    ensureSessionsExcluded(repoDir);
    return repoDir;
  }
  await initBareArtifactsRepo(repoDir);
  await seedRootCommit(repoDir);
  installArtifactHooks(projectDir);
  ensureSessionsExcluded(repoDir);
  return repoDir;
}

/** Session scratch (local:// roots at <mount>/.sessions/<sid>) is addressable
 *  but UNVERSIONED: the bare repo's shared info/exclude covers every worktree,
 *  so scratch never enters branch history, rollups, git status, or the
 *  pre-commit hook (docs/ARTIFACT-PROTOCOL.md Q2). */
function ensureSessionsExcluded(repoDir: string): void {
  try {
    const excludePath = join(repoDir, 'info', 'exclude');
    const line = '.sessions/';
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    if (!current.split('\n').includes(line)) {
      mkdirSync(dirname(excludePath), { recursive: true });
      appendFileSync(excludePath, `${current.endsWith('\n') || current === '' ? '' : '\n'}${line}\n`);
    }
  } catch { /* best-effort */ }
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

// ── managed hooks (docs/ARTIFACT-PROTOCOL.md Q1) ────────────────────────────
//
// Installed ONCE in the bare repo's hooks/ — verified to fire for commits in
// every current and future worktree mount (hook resolution goes through the
// git common dir). MUST be bash: dash broke on this script and failed OPEN
// (exit 0 with raw bytes committed). Hooks are ergonomics + safety net;
// `--no-verify` bypasses them, so the hard boundary is the push/rollup gate.

const HOOK_VERSION = 1;

/** pre-commit: auto-convert staged blobs ≥ threshold into blob-store bytes +
 *  a git-LFS pointer + a .gitattributes line — identical to capture output.
 *  Aborts the commit (non-zero) if the blob-store write cannot be verified. */
function preCommitHookScript(blobsDir: string): string {
  return `#!/bin/bash
# gssh-hook-v${HOOK_VERSION} pre-commit — gitspace artifacts pointer discipline.
# Managed by gssh (ensureArtifactsRepo); local edits are overwritten.
set -uo pipefail
BLOBS_DIR=${escapeShellArg(blobsDir)}
THRESHOLD=${DEFAULT_POINTER_THRESHOLD_BYTES}
[ "\${GSSH_ARTIFACTS_CAPTURE:-}" = "1" ] && exit 0

while IFS= read -r -d '' p; do
  sha=$(git rev-parse -q --verify ":$p" 2>/dev/null) || continue
  size=$(git cat-file -s "$sha" 2>/dev/null) || continue
  [ "$size" -lt "$THRESHOLD" ] && continue

  oid=$(git cat-file blob "$sha" | sha256sum | awk '{print $1}')
  shard="$BLOBS_DIR/\${oid:0:2}"
  mkdir -p "$shard" || { echo "gssh pre-commit: cannot create blob store at $BLOBS_DIR — aborting commit" >&2; exit 1; }
  blob="$shard/$oid"
  if [ ! -f "$blob" ]; then
    tmp="$blob.part.$$"
    if ! git cat-file blob "$sha" > "$tmp"; then rm -f "$tmp"; echo "gssh pre-commit: blob store write failed for $p — aborting commit" >&2; exit 1; fi
    actual=$(wc -c < "$tmp" | tr -d ' ')
    if [ "$actual" != "$size" ]; then rm -f "$tmp"; echo "gssh pre-commit: blob store verification failed for $p ($actual != $size bytes) — aborting commit" >&2; exit 1; fi
    mv "$tmp" "$blob" || { rm -f "$tmp"; echo "gssh pre-commit: blob store move failed for $p — aborting commit" >&2; exit 1; }
  fi
  [ -s "$blob" ] || { echo "gssh pre-commit: blob missing after write for $p — aborting commit" >&2; exit 1; }

  pointer=$(printf 'version https://git-lfs.github.com/spec/v1\\noid sha256:%s\\nsize %s' "$oid" "$size")
  psha=$(printf '%s\\n' "$pointer" | git hash-object -w --stdin) || { echo "gssh pre-commit: hash-object failed for $p" >&2; exit 1; }
  git update-index --cacheinfo "100644,$psha,$p" || { echo "gssh pre-commit: update-index failed for $p — aborting commit" >&2; exit 1; }
  printf '%s\\n' "$pointer" > "$p"

  case "$p" in
    *" "*) pat="\\"$p\\"" ;;
    *) pat="$p" ;;
  esac
  line="$pat filter=lfs diff=lfs merge=lfs -text"
  touch .gitattributes
  grep -qxF -- "$line" .gitattributes || { printf '%s\\n' "$line" >> .gitattributes; git add .gitattributes; }
  echo "gssh: $p ($size bytes) committed as LFS pointer \${oid:0:12}" >&2
done < <(git diff --cached --name-only --diff-filter=ACMR -z)

exit 0
`;
}

/** post-commit: provenance note for hand commits (capture attaches richer
 *  notes itself and sets GSSH_ARTIFACTS_CAPTURE=1 to skip this). */
function postCommitHookScript(): string {
  return `#!/bin/bash
# gssh-hook-v${HOOK_VERSION} post-commit — provenance note for hand commits.
# Managed by gssh (ensureArtifactsRepo); local edits are overwritten.
[ "\${GSSH_ARTIFACTS_CAPTURE:-}" = "1" ] && exit 0
note='{"tool":"hand-commit"'
if [ -n "\${GSSH_SESSION_ID:-}" ]; then note="$note,\\"session\\":\\"\${GSSH_SESSION_ID}\\""; fi
if [ -n "\${GSSH_TRIGGER_ID:-}" ]; then note="$note,\\"trigger\\":\\"\${GSSH_TRIGGER_ID}\\""; fi
note="$note}"
git -c user.name=gitspace -c user.email=artifacts@gitspace.sh -c commit.gpgsign=false notes add -f -m "$note" HEAD >/dev/null 2>&1
exit 0
`;
}

/** Idempotent, versioned hook install — write-if-changed by full content
 *  (covers version bumps AND a moved project dir re-baking BLOBS_DIR). */
export function installArtifactHooks(projectDir: string): void {
  const { repoDir, blobsDir } = artifactPaths(projectDir);
  const hooksDir = join(repoDir, 'hooks');
  const wanted: Array<[string, string]> = [
    ['pre-commit', preCommitHookScript(blobsDir)],
    ['post-commit', postCommitHookScript()],
  ];
  for (const [name, content] of wanted) {
    const path = join(hooksDir, name);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (current === content) continue;
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(path, content, { mode: 0o755 });
  }
}

/** Hook health for status surfaces — a regressed hook FAILS OPEN, so drift
 *  must be visible. */
export function artifactHooksStatus(projectDir: string): 'ok' | 'stale' | 'missing' {
  const { repoDir, blobsDir } = artifactPaths(projectDir);
  const pre = join(repoDir, 'hooks', 'pre-commit');
  const post = join(repoDir, 'hooks', 'post-commit');
  if (!existsSync(pre) || !existsSync(post)) return 'missing';
  const preOk = readFileSync(pre, 'utf8') === preCommitHookScript(blobsDir);
  const postOk = readFileSync(post, 'utf8') === postCommitHookScript();
  return preOk && postOk ? 'ok' : 'stale';
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
    // A manually-deleted mount leaves a stale worktree registration that
    // makes 'worktree add' refuse the same path — prune first, always.
    await git(repoDir, 'worktree prune');
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


/** Enforce a write-scope (capability globs) over a capture's file set —
 *  the mechanical enforcement ring for callers that carry a scope. */
function assertWritesInScope(files: CaptureFile[], allowedWrites: string[] | undefined): void {
  if (!allowedWrites) return;
  const outside = files.map((f) => f.path).filter((p) => !pathInScope(p, allowedWrites));
  if (outside.length > 0) {
    throw new SpacesError(
      `Write scope violation: ${outside.join(', ')} outside allowed globs (${allowedWrites.join(', ') || 'none'})`,
      'USER_ERROR',
      1,
    );
  }
}

function assertSafeRelPath(rel: string): void {
  if (!rel || rel.startsWith('/') || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new SpacesError(`Unsafe artifact path: ${rel}`, 'USER_ERROR', 1);
  }
}

/** Write files into a mount and commit them on its branch (one commit).
 *  Files at/over the pointer threshold are stored in the blob store and
 *  committed as LFS pointers (with matching .gitattributes lines, so external
 *  `git lfs` clones smudge them natively). Provenance rides in a git note. */
export async function captureArtifacts(
  projectDir: string,
  mountDir: string,
  files: CaptureFile[],
  opts: { message?: string; provenance?: CaptureProvenance; pointerThresholdBytes?: number; allowedWrites?: string[] } = {},
): Promise<CaptureResult> {
  if (files.length === 0) throw new SpacesError('captureArtifacts: no files given', 'USER_ERROR', 1);
  assertWritesInScope(files, opts.allowedWrites);
  const { blobsDir } = artifactPaths(projectDir);
  const threshold = opts.pointerThresholdBytes ?? DEFAULT_POINTER_THRESHOLD_BYTES;
  const pointers = files.filter((f) => writeCaptureFile(blobsDir, mountDir, f, threshold)).map((f) => f.path);
  const attributesTouched = ensureLfsAttributes(mountDir, pointers);

  const added = files.map((f) => escapeShellArg(f.path)).concat(attributesTouched ? [escapeShellArg('.gitattributes')] : []).join(' ');
  await git(mountDir, `add -- ${added}`);
  const message = opts.message ?? `capture: ${files.map((f) => f.path).join(', ')}`.slice(0, 200);
  // Capture is authoritative for pointer split + provenance; the managed
  // hooks stand down when this marker is set.
  await git(mountDir, `commit -q -m ${escapeShellArg(message)}`, { id: true, env: { GSSH_ARTIFACTS_CAPTURE: '1' } });
  const commit = await git(mountDir, 'rev-parse HEAD');
  if (opts.provenance && Object.keys(opts.provenance).length > 0) {
    await git(mountDir, `notes add -f -m ${escapeShellArg(JSON.stringify(opts.provenance))} ${commit}`, { id: true });
  }
  return { commit, pointers };
}

function raiseMissingSource(path: string): never {
  throw new SpacesError(`captureArtifacts: file ${path} has neither content nor sourceFile`, 'USER_ERROR', 1);
}

/** One .gitattributes line per LFS-pointer path. GitHub LFS (and any git-lfs
 *  clone) only treats a file as LFS when an attribute marks it, so pointer
 *  commits and attribute lines must land together. Returns true when the
 *  file changed (caller stages it). */
export function ensureLfsAttributes(mountDir: string, pointerPaths: string[]): boolean {
  if (pointerPaths.length === 0) return false;
  const attrPath = join(mountDir, '.gitattributes');
  const current = existsSync(attrPath) ? readFileSync(attrPath, 'utf8') : '';
  const lines = new Set(current.split('\n').filter(Boolean));
  let changed = false;
  for (const p of pointerPaths) {
    // gitattributes needs C-style quoting for paths with whitespace.
    const pattern = /\s/.test(p) ? `"${p}"` : p;
    const line = `${pattern} filter=lfs diff=lfs merge=lfs -text`;
    if (!lines.has(line)) {
      lines.add(line);
      changed = true;
    }
  }
  if (changed) writeFileSync(attrPath, `${[...lines].join('\n')}\n`);
  return changed;
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
  opts: { message?: string; provenance?: CaptureProvenance; pointerThresholdBytes?: number; allowedWrites?: string[] } = {},
): CaptureResult {
  if (files.length === 0) throw new SpacesError('captureArtifacts: no files given', 'USER_ERROR', 1);
  assertWritesInScope(files, opts.allowedWrites);
  const { blobsDir } = artifactPaths(projectDir);
  const threshold = opts.pointerThresholdBytes ?? DEFAULT_POINTER_THRESHOLD_BYTES;
  const pointers = files.filter((f) => writeCaptureFile(blobsDir, mountDir, f, threshold)).map((f) => f.path);
  const attributesTouched = ensureLfsAttributes(mountDir, pointers);
  const gitS = (args: string, env?: Record<string, string>): string => {
    try {
      return execSync(`git -C ${escapeShellArg(mountDir)} ${GIT_ID} ${args}`, { encoding: 'utf8', env: env ? { ...process.env, ...env } : undefined }).trim();
    } catch (e) {
      throw new SpacesError(`git failed (${args.split(' ')[0]}): ${e instanceof Error ? e.message : e}`, 'SYSTEM_ERROR', 1);
    }
  };
  gitS(`add -- ${files.map((f) => escapeShellArg(f.path)).concat(attributesTouched ? [escapeShellArg('.gitattributes')] : []).join(' ')}`);
  const message = opts.message ?? `capture: ${files.map((f) => f.path).join(', ')}`.slice(0, 200);
  gitS(`commit -q -m ${escapeShellArg(message)}`, { GSSH_ARTIFACTS_CAPTURE: '1' });
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
/**
 * List artifact files under the mount, returning MOUNT-relative paths.
 *
 * `scopeRel` restricts the walk to one subtree (e.g. a workspace's own
 * `goals/<goal-id>/`) while still returning mount-relative paths. This is what
 * keeps a WORKSPACE view from showing every rolled-up goal inherited from
 * `main`: a workspace's artifacts branch is branched off `main`, so the mount
 * physically contains every `goals/<other-id>/`; scoping to the workspace's own
 * goal folder shows only its artifacts. `@base`/project listings pass no scope
 * (rootRel === '') and still walk the whole mount (that's the project-home view,
 * which SHOULD show all goals).
 */
export function listArtifactFiles(mountDir: string, scopeRel = ''): ArtifactListEntry[] {
  const out: ArtifactListEntry[] = [];
  const walk = (rel: string): void => {
    const abs = rel ? join(mountDir, rel) : mountDir;
    for (const name of readdirSync(abs)) {
      if (rel === '' && (name === '.git' || name.startsWith('.git'))) continue;
      // Session scratch is addressable-by-URI but has NO TYPE and never
      // appears in curated listings (the git exclude does not help a
      // filesystem walk — this skip is load-bearing).
      if (rel === '' && name === '.sessions') continue;
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
  const startAbs = scopeRel ? join(mountDir, scopeRel) : mountDir;
  if (!existsSync(startAbs)) return out;
  walk(scopeRel);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}


/** Resolve a `local://` rel to its absolute path in the mount at `<mount>/<rel>`,
 *  creating any parent dirs on demand. local:// is simply the artifacts mount.
 *  Returns both the absolute path (to write/read) and the mount-relative path
 *  (to address via artifact:// URIs). */
export function resolveLocalScratch(mountDir: string, rel: string): { absPath: string; mountRel: string } {
  const mountRel = localScratchRel(rel);
  const absPath = join(mountDir, mountRel);
  mkdirSync(dirname(absPath), { recursive: true });
  return { absPath, mountRel };
}

/** Delete session-scratch dirs for sessions that are no longer live and have
 *  been idle past the retention window. The SDK has no session-dir GC. */
export function gcSessionScratch(mountDir: string, liveSessionIds: Set<string>, maxAgeMs = 14 * 24 * 3_600_000): number {
  const root = join(mountDir, '.sessions');
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const sid of readdirSync(root)) {
    if (liveSessionIds.has(sid)) continue;
    const dir = join(root, sid);
    try {
      if (Date.now() - statSync(dir).mtimeMs < maxAgeMs) continue;
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch { /* concurrent removal */ }
  }
  return removed;
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

/**
 * Point-in-time artifact read: `git show <commit>:<relPath>` from the bare
 * repo (share links pin the mount HEAD at mint), with LFS pointers resolved
 * against the local blob store. Blobs are content-addressed so a pinned
 * pointer stays resolvable for as long as the blob exists locally.
 */
export function readArtifactPinned(projectDir: string, commit: string, relPath: string): Buffer {
  assertSafeRelPath(relPath);
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new SpacesError(`Invalid pinned commit: ${commit}`, 'USER_ERROR', 1);
  const { repoDir, blobsDir } = artifactPaths(projectDir);
  let raw: Buffer;
  try {
    raw = execFileSync('git', ['-C', repoDir, 'show', `${commit}:${relPath}`], { maxBuffer: 512 * 1024 * 1024 });
  } catch {
    throw new SpacesError(`Artifact not found at pinned commit ${commit.slice(0, 8)}: ${relPath}`, 'USER_ERROR', 1);
  }
  const head = raw.subarray(0, 200).toString('utf8');
  const ptr = parseLfsPointer(head.startsWith(LFS_VERSION_LINE) ? raw.toString('utf8') : '');
  if (!ptr) return raw;
  const bp = blobPath(blobsDir, ptr.oid);
  if (!existsSync(bp)) throw new SpacesError(`Artifact blob missing for pinned read: ${ptr.oid}`, 'SYSTEM_ERROR', 1);
  return readFileSync(bp);
}

/**
 * The rich, rolled-up goal doc (`goals/<goalId>/goal.md`) read from artifacts
 * `main`, or null when it isn't there (never rolled up, no repo, or missing).
 * This survives workspace deletion — the authored doc lives on main after
 * roll-up, whereas the goal record's embedded `doc.bodyMarkdown` is only a stub.
 */
export function readRolledUpGoalMd(projectDir: string, goalId: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(goalId)) return null;
  const { repoDir } = artifactPaths(projectDir);
  if (!existsSync(repoDir)) return null;
  try {
    const raw = execFileSync(
      'git',
      ['-C', repoDir, 'show', `${MAIN_BRANCH}:${ARTIFACTS_GOALS_DIR}/${goalId}/goal.md`],
      { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const text = raw.toString('utf8');
    return text.trim().length > 0 ? text : null;
  } catch {
    return null; // not on main / no repo / not found
  }
}

/**
 * The rich goal doc from a live workspace's artifacts mount
 * (`<mount>/goals/<goalId>/goal.md`), or null when absent. Used at delete time
 * (the mount still exists) to capture the doc before the worktree is destroyed.
 */
export function readWorkspaceGoalMd(workspaceDir: string, goalId: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(goalId)) return null;
  const file = join(artifactsMountDir(workspaceDir), ARTIFACTS_GOALS_DIR, goalId, 'goal.md');
  try {
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf8');
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Fetch a missing blob by oid (bytes or null when the store doesn't have it).
 *  Dependency-injected into {@link readArtifactResolving} so core stays
 *  testable offline; the GitHub tier supplies an LFS-backed implementation. */
export type ArtifactBlobFetcher = (oid: string, size: number) => Promise<Buffer | null>;

/**
 * Async twin of {@link readArtifact}: on a pointer-miss (blob absent locally)
 * it asks a blob-fetcher for the bytes, verifies the sha256, stores the blob
 * locally, and returns it. Default fetcher is GitHub LFS (when this project's
 * artifacts remote is a github.com repo); pass `blobFetcher` explicitly to
 * override, or `null` to force offline behavior.
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

  const fetcher = opts.blobFetcher !== undefined ? opts.blobFetcher : await defaultGithubBlobFetcher(projectDir);
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

/** GitHub-LFS blob fetcher for this project, or null when the artifacts
 *  remote isn't a github.com repo. */
async function defaultGithubBlobFetcher(projectDir: string): Promise<ArtifactBlobFetcher | null> {
  try {
    const github = await import('./artifacts-github.js');
    return await github.createGithubBlobFetcher(projectDir);
  } catch {
    return null;
  }
}

// ── publish gate (docs/ARTIFACT-PROTOCOL.md Q1) ─────────────────────────────
//
// `--no-verify` escapes the hooks, so the bypass-proof boundary is here: no
// raw (non-pointer) blob ≥ threshold ever leaves the machine (sync) or
// reaches main (rollup). Gated bytes provably never left, which is what makes
// `repairArtifacts` safe.

export interface RawBlobOffender {
  path: string;
  size: number;
}

/** Scan a rev-list range for raw blobs ≥ the pointer threshold. Pointers are
 *  ~130 bytes, so size alone separates raw bytes from discipline-conformant
 *  content. `rangeArgs` is trusted caller-built rev-list syntax. */
export async function scanRawBlobOffenders(repoDir: string, rangeArgs: string): Promise<RawBlobOffender[]> {
  const cmd = `git -C ${escapeShellArg(repoDir)} rev-list --objects ${rangeArgs} | git -C ${escapeShellArg(repoDir)} cat-file --batch-check='%(objecttype) %(objectsize) %(rest)'`;
  let stdout = '';
  try {
    stdout = (await execAsync(cmd, { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (e) {
    throw new SpacesError(`artifacts gate scan failed: ${e instanceof Error ? e.message : e}`, 'SYSTEM_ERROR', 1);
  }
  const seen = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^blob (\d+) (.+)$/);
    if (!m) continue;
    const size = Number(m[1]);
    if (size < DEFAULT_POINTER_THRESHOLD_BYTES) continue;
    const path = m[2]!;
    seen.set(path, Math.max(seen.get(path) ?? 0, size));
  }
  return [...seen.entries()].map(([path, size]) => ({ path, size }));
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

// ── roll-up filter: canonical record vs. curated proof ──────────────────────
//
// Roll-up is favourites-aware (docs/ARTIFACTS-FS.md "Favorite"/"Roll-up"). A
// goal folder carries two kinds of thing:
//
//   1. The CANONICAL RECORD — what the goal SYSTEM writes to define the goal on
//      main: goal.md, rubric.json, the workflow spec, journal/, review/,
//      validation evidence, and the favourites manifest itself. This ALWAYS
//      rolls up, favourited or not: it is the goal's structural record and the
//      backing for its judged reviews (evidence outlives the workspace).
//   2. CURATED PROOF — everything else the user or an agent captured into the
//      goal folder (demos/, shots/, apps/, loose reports, arbitrary captures).
//      This rolls up ONLY when the user starred it (present in .favorites.json).
//
// The canonical set is DERIVED from the goal-system producer registry
// (AMBIENT_WRITE_SCOPES) rather than hardcoded, so a new producer's writes are
// canonical automatically. The workflow spec and favourites manifest are the
// two structural files authored at the goal-scope ROOT (not through a dedicated
// producer), so they are added explicitly.
//
// NOTE: this makes triggers/** and blame/** canonical too — they are
// goal-system structured records (a favourited data artifact whose trigger def
// or edit-breadcrumb was dropped would dangle), not free-form captures.

/** Goal-relative globs whose files are the goal's canonical record (always
 *  rolled up). AMBIENT_WRITE_SCOPES entries are already goal-relative; the
 *  root-level `.gitattributes` (lfs-backfill) is excluded here because it lives
 *  at the mount root, is never inside a goal folder, and is passed through as a
 *  project-level path by the filter. */
export const CANONICAL_GOAL_GLOBS: string[] = [
  ...new Set(Object.values(AMBIENT_WRITE_SCOPES).flat().filter((g) => g !== '.gitattributes')),
  '*.workflow.json',
  '.favorites.json',
];

/** The goal id owning a mount-relative path, or null when the path is not
 *  inside any goal folder (project-level artifacts at the tree root). */
function goalIdOfMountRel(mountRelPath: string): string | null {
  const prefix = `${ARTIFACTS_GOALS_DIR}/`;
  if (!mountRelPath.startsWith(prefix)) return null;
  const rest = mountRelPath.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash <= 0 ? null : rest.slice(0, slash);
}

/** execFileSync git (no shell) for filtering plumbing — file paths are
 *  arbitrary bytes bar NUL/slash, so they must never be interpolated into a
 *  shell string. `raw` skips the trailing-newline trim for -z output. */
function gitx(
  repoDir: string,
  args: string[],
  opts: { id?: boolean; input?: string; env?: Record<string, string>; raw?: boolean } = {},
): string {
  const full = ['-C', repoDir, ...(opts.id ? GIT_ID_ARGV : []), ...args];
  try {
    const out = execFileSync('git', full, {
      encoding: 'utf8',
      input: opts.input,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return opts.raw ? out : out.trim();
  } catch (e) {
    throw new SpacesError(`git failed (${args[0]}): ${e instanceof Error ? e.message : String(e)}`, 'SYSTEM_ERROR', 1);
  }
}

const splitZ = (s: string): string[] => s.split('\0').filter(Boolean);

/** Scope-relative favourites read OFF THE BRANCH (a membership test — no
 *  daemon, no translation; the manifest stores goal-relative relpaths). */
function readBranchFavoritesScopeRel(repoDir: string, branch: string, goalId: string): Set<string> {
  let raw: string;
  try {
    raw = execFileSync('git', ['-C', repoDir, 'show', `${branch}:${ARTIFACTS_GOALS_DIR}/${goalId}/.favorites.json`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'], // a missing manifest is normal — no stderr noise
    });
  } catch {
    return new Set(); // no manifest on this branch
  }
  try {
    const doc = JSON.parse(raw) as { favorites?: unknown };
    if (!Array.isArray(doc.favorites)) return new Set();
    return new Set(
      doc.favorites
        .filter((x): x is string => typeof x === 'string')
        .map((p) => p.replace(/^\/+/, '').replace(/\/+$/, ''))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

interface FilteredRollup {
  /** SHA of the filtered commit (parent = branch tip) to merge into main. */
  commit: string;
  ownedGoalIds: string[];
  canonicalCount: number;
  favoritedCount: number;
  excludedCount: number;
}

/**
 * Compose a FILTERED commit off the branch tip: the branch's tree with every
 * non-canonical, non-favourited file inside an OWNED goal folder removed. The
 * commit's parent is the branch tip, so merging it into main keeps the branch's
 * real history reachable (merge-base advances → freshen/re-rollup still work).
 *
 * Only goal folders the branch OWNS (changed since the merge-base) are
 * filtered; inherited goal folders (materialised by freshen, already on main)
 * and project-level paths pass through untouched — so disjoint goal folders
 * stay conflict-free and a legacy flat branch (no goal folders) yields a tree
 * identical to the branch, i.e. the old plain-merge behaviour.
 */
function buildFilteredRollupCommit(repoDir: string, branch: string): FilteredRollup {
  const mergeBase = gitx(repoDir, ['merge-base', MAIN_BRANCH, branch]);
  const changed = splitZ(gitx(repoDir, ['diff', '--name-only', '-z', `${mergeBase}..${branch}`], { raw: true }));
  const ownedGoalIds = new Set<string>();
  for (const p of changed) {
    const gid = goalIdOfMountRel(p);
    if (gid) ownedGoalIds.add(gid);
  }

  const favByGid = new Map<string, Set<string>>();
  for (const gid of ownedGoalIds) favByGid.set(gid, readBranchFavoritesScopeRel(repoDir, branch, gid));

  const files = splitZ(gitx(repoDir, ['ls-tree', '-r', '-z', '--name-only', branch], { raw: true }));
  const excluded: string[] = [];
  let canonicalCount = 0;
  let favoritedCount = 0;
  for (const p of files) {
    const gid = goalIdOfMountRel(p);
    if (!gid || !ownedGoalIds.has(gid)) continue; // project-level or inherited → keep as-is
    const goalRel = p.slice(`${ARTIFACTS_GOALS_DIR}/${gid}/`.length);
    if (pathInScope(goalRel, CANONICAL_GOAL_GLOBS)) {
      canonicalCount += 1;
      continue;
    }
    if (favByGid.get(gid)!.has(goalRel)) {
      favoritedCount += 1;
      continue;
    }
    excluded.push(p);
  }

  const tempIndex = join(repoDir, `.rollup-index-${Date.now()}-${process.pid}`);
  const tempWork = join(repoDir, `.rollup-work-${Date.now()}-${process.pid}`);
  mkdirSync(tempWork, { recursive: true });
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    gitx(repoDir, ['read-tree', branch], { env });
    if (excluded.length > 0) {
      // update-index refuses to run in a bare repo; a throwaway work-tree
      // (never written to — --force-remove only touches the index) satisfies
      // that check without materialising anything.
      gitx(repoDir, ['-c', 'core.bare=false', `--work-tree=${tempWork}`, 'update-index', '--force-remove', '-z', '--stdin'], {
        env,
        input: `${excluded.join('\0')}\0`,
      });
    }
    const tree = gitx(repoDir, ['write-tree'], { env });
    const branchTip = gitx(repoDir, ['rev-parse', branch]);
    const msg = `rollup-filter: ${branch} (canonical ${canonicalCount}, favorited ${favoritedCount}, excluded ${excluded.length})`;
    const commit = gitx(repoDir, ['commit-tree', tree, '-p', branchTip, '-m', msg], { id: true });
    return { commit, ownedGoalIds: [...ownedGoalIds], canonicalCount, favoritedCount, excludedCount: excluded.length };
  } finally {
    rmSync(tempIndex, { force: true });
    rmSync(tempWork, { recursive: true, force: true });
  }
}

/**
 * Merge a workspace's artifacts branch into main (no-ff, so roll-ups stay
 * visible in history) — FAVOURITES-AWARE. The canonical record always rolls
 * up; curated proof only when the user starred it (docs/ARTIFACTS-FS.md). A
 * filtered commit is composed off the branch tip (canonical + favourited only)
 * and that is what merges, so disjoint goal folders stay conflict-free while a
 * genuine same-path collision still surfaces as a conflict for manual curation.
 * Uses the existing main mount when present, otherwise a temporary worktree.
 */
export async function rollupArtifacts(
  projectDir: string,
  branch: string,
  opts: { removeBranch?: boolean; message?: string } = {},
): Promise<{ mergeCommit: string }> {
  const { repoDir } = artifactPaths(projectDir);
  if (branch === MAIN_BRANCH) throw new SpacesError('Cannot roll up main into itself', 'USER_ERROR', 1);
  if (!(await branchExists(repoDir, branch))) throw new SpacesError(`No artifacts branch: ${branch}`, 'USER_ERROR', 1);

  // Gate FIRST: a --no-verify raw blob committed between sync ticks must not
  // reach main through a rollup merge either. Scans the whole branch (matches
  // the sync gate); a raw large file means --no-verify abuse and needs repair
  // regardless of whether it would have been rolled up.
  const offenders = await scanRawBlobOffenders(repoDir, `${escapeShellArg(branch)} --not ${MAIN_BRANCH}`);
  if (offenders.length > 0) {
    const list = offenders.map((o) => `${o.path} (${(o.size / (1024 * 1024)).toFixed(1)} MB)`).join(', ');
    throw new SpacesError(
      `Roll-up of ${branch} refused: raw large files not stored as LFS pointers — ${list}. Run \`gssh space artifacts repair\` in that workspace (or \`gssh artifacts repair --workspace ${branch}\`), then roll up again.`,
      'USER_ERROR',
      1,
    );
  }

  const filtered = buildFilteredRollupCommit(repoDir, branch);

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
      await git(mainDir, `merge --no-ff -m ${escapeShellArg(message)} ${escapeShellArg(filtered.commit)}`, { id: true });
    } catch (e) {
      await git(mainDir, 'merge --abort').catch(() => undefined);
      throw new SpacesError(
        `Artifacts roll-up of ${branch} has conflicts — curate manually (${e instanceof Error ? e.message.split('\n')[0] : e})`,
        'USER_ERROR',
        1,
      );
    }
    const mergeCommit = await git(mainDir, 'rev-parse HEAD');
    // Provenance note: enrich with workspace + goal(s) + curation counts. Gate
    // rating/state would need a goal-chain read (a module cycle from this
    // dependency-light layer), so it is left to the richer trigger-confirmation
    // surface (#48 follow-up) — this stays cheap.
    const note = JSON.stringify({
      tool: 'rollup',
      workspace: branch,
      goals: filtered.ownedGoalIds,
      canonical: filtered.canonicalCount,
      favorited: filtered.favoritedCount,
      excluded: filtered.excludedCount,
    });
    await git(mainDir, `notes add -f -m ${escapeShellArg(note)} ${mergeCommit}`, { id: true }).catch(() => undefined);
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
 *  its artifacts (the .gitmodules pattern): an explicit git remote URL
 *  (GitHub-provisioned or BYO). */
export interface ArtifactsPointerConfig {
  /** Explicit git remote URL for the artifacts repo. */
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

export async function setArtifactsRemote(projectDir: string, url: string): Promise<void> {
  const { repoDir } = artifactPaths(projectDir);
  // Fresh repo + remote: ADOPT the remote's main instead of seeding an
  // unrelated local root commit (a second machine attaching via
  // .gitspace/artifacts.json must fast-forward from the remote's history).
  if (!existsSync(join(repoDir, 'HEAD'))) {
    await initBareArtifactsRepo(repoDir);
    await git(repoDir, `remote add origin ${escapeShellArg(url)}`);
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

export interface ArtifactsSyncResult {
  pushed: boolean;
  fastForwarded: boolean;
  /** Branches the publish gate refused (raw ≥2MB blobs — repair, then re-sync). */
  refused?: Array<{ branch: string; offenders: RawBlobOffender[] }>;
}

/** Git sync: fetch, fast-forward main (through the live main mount when one
 *  exists), gate every branch against raw large blobs, push the clean ones.
 *  Conflict-free by construction — non-ff main means someone must roll
 *  up/curate manually. Blob transport is the GitHub tier's job (LFS batch API
 *  in artifacts-github.ts); BYO remotes move branches only. */
export async function syncArtifacts(projectDir: string): Promise<ArtifactsSyncResult> {
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

  // Publish gate: refuse any branch whose unpushed commits carry a raw
  // (non-pointer) blob ≥ threshold; push the clean branches regardless so one
  // bad branch never blocks the rest of the project.
  const branches = (await git(repoDir, `for-each-ref --format='%(refname:short)' refs/heads`)).split('\n').map((b) => b.trim()).filter(Boolean);
  const refused: NonNullable<ArtifactsSyncResult['refused']> = [];
  const clean: string[] = [];
  for (const branch of branches) {
    const offenders = await scanRawBlobOffenders(repoDir, `${escapeShellArg(branch)} --not --remotes=origin`);
    if (offenders.length > 0) refused.push({ branch, offenders });
    else clean.push(branch);
  }
  if (refused.length === 0) {
    await git(repoDir, 'push origin --all');
    return { pushed: true, fastForwarded };
  }
  if (clean.length > 0) {
    await git(repoDir, `push origin ${clean.map((b) => escapeShellArg(b)).join(' ')}`);
  }
  return { pushed: clean.length > 0, fastForwarded, refused };
}

export interface RepairResult {
  /** Commits squashed into the repaired commit (0 = nothing to repair). */
  repaired: number;
  commit?: string;
}

/**
 * Repair a mount whose branch the publish gate refused: soft-reset to just
 * before the first offending commit and re-commit — the managed pre-commit
 * hook performs the pointer conversion. Safe ONLY because the gate guarantees
 * the offending bytes never left this machine; this is the one sanctioned
 * history modification (general daemon-side rewrite stays off the table).
 */
export async function repairArtifacts(projectDir: string, mountDir: string): Promise<RepairResult> {
  const { repoDir } = artifactPaths(projectDir);
  const branch = await git(mountDir, 'branch --show-current');
  if (!branch) throw new SpacesError('repair: mount is not on a branch', 'USER_ERROR', 1);
  const dirty = (await git(mountDir, 'status --porcelain')).split('\n').filter((l) => l.trim() && !l.startsWith('??'));
  if (dirty.length > 0) {
    throw new SpacesError('repair: mount has uncommitted changes — commit or stash them first', 'USER_ERROR', 1);
  }

  // Unpushed range: prefer the remote-tracking branch; otherwise a workspace
  // branch's local-only commits are everything past main.
  const hasRemoteBranch = await git(repoDir, `rev-parse --verify --quiet refs/remotes/origin/${escapeShellArg(branch)}`).then(() => true).catch(() => false);
  const range = hasRemoteBranch
    ? `HEAD --not refs/remotes/origin/${escapeShellArg(branch)}`
    : branch !== MAIN_BRANCH
      ? `HEAD --not ${MAIN_BRANCH}`
      : 'HEAD';

  const commits = (await git(mountDir, `rev-list --reverse ${range}`)).split('\n').map((c) => c.trim()).filter(Boolean);
  let firstBad: string | null = null;
  for (const c of commits) {
    // Objects introduced by c alone. c^ always exists here (every artifacts
    // repo has a seeded root commit below any workspace/main work).
    const introduced = await scanRawBlobOffenders(repoDir, `${c} --not ${c}^`).catch(() => [] as RawBlobOffender[]);
    if (introduced.length > 0) { firstBad = c; break; }
  }
  if (!firstBad) return { repaired: 0 };

  const base = await git(mountDir, `rev-parse ${firstBad}^`);
  const squashedCount = commits.length - commits.indexOf(firstBad);
  const messages = (await git(mountDir, `log --reverse --format=%s ${base}..HEAD`)).split('\n').filter(Boolean);
  await git(mountDir, `reset --soft ${base}`);
  const message = `repair: convert large files to LFS pointers\n\nSquashed ${squashedCount} commit(s):\n${messages.map((m) => `- ${m}`).join('\n')}`;
  // NO capture marker: the pre-commit hook must run — it is the converter.
  await git(mountDir, `commit -q -m ${escapeShellArg(message)}`, { id: true });
  const commit = await git(mountDir, 'rev-parse HEAD');

  // Verify the rewritten range itself is clean — if the hook is missing or
  // regressed, the repair commit would still carry raw bytes.
  const remaining = await scanRawBlobOffenders(repoDir, `${commit} --not ${base}`);
  if (remaining.length > 0) {
    throw new SpacesError(`repair: conversion incomplete — ${remaining.map((o) => o.path).join(', ')} still raw (is the pre-commit hook installed? gssh artifacts status)`, 'SYSTEM_ERROR', 1);
  }
  return { repaired: squashedCount, commit };
}

/** Drop a workspace's artifacts branch (and its mount) without merging. */
export async function abandonArtifacts(projectDir: string, branch: string): Promise<void> {
  const { repoDir } = artifactPaths(projectDir);
  if (branch === MAIN_BRANCH) throw new SpacesError('Refusing to abandon main', 'USER_ERROR', 1);
  const mounted = await worktreeFor(repoDir, branch);
  if (mounted) await git(repoDir, `worktree remove --force ${escapeShellArg(mounted)}`);
  if (await branchExists(repoDir, branch)) await git(repoDir, `branch -D ${escapeShellArg(branch)}`);
}
