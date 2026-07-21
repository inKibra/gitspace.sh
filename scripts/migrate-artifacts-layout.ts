/**
 * migrate-artifacts-layout.ts — flat → goal-keyed artifacts migration.
 *
 * WHY THIS EXISTS
 * ---------------
 * Commit df0a94f made `local://` bind to `goals/<goal-id>/` and made the
 * `space artifacts` CLI paths scope-relative (see src/core/artifacts.ts —
 * `artifactsScope`, `goalScopeRel`). A machine that pulls that code but whose
 * per-project artifacts repos are still in the OLD FLAT layout (goal.md,
 * rubric.json, reports/ … at the mount root of every workspace branch) will
 * break: the running code expects each goal's output under
 * `goals/<goal-id>/`, but those folders do not exist yet. Roll-up would also
 * collide on the first merge, which is exactly what the goal-keyed layout
 * exists to prevent (docs/ARTIFACTS-FS.md — "Tree layout", "Migration off the
 * flat mount").
 *
 * THE MODEL (authoritative: docs/ARTIFACTS-FS.md)
 * -----------------------------------------------
 *  - One artifacts repo per project: bare at `<project>/.artifacts.git`,
 *    worktrees mounted at `<workspace>/.gitspace/artifacts` and
 *    `base/.gitspace/artifacts`. One branch per workspace, branched off `main`.
 *  - Every goal owns `goals/<goal-id>/` and NOTHING else. Project-level
 *    artifacts stay at the tree root.
 *  - MIGRATION RULE, per workspace artifacts branch: everything the workspace
 *    PRODUCED moves under `goals/<goal-id>/`. Files INHERITED from `main`
 *    (present AND byte-identical at the branch's merge-base with `main`) STAY
 *    at root — they are project baseline, not workspace output. Classify PER
 *    FILE against the merge-base; a top-level dir does NOT move as a unit
 *    (e.g. `reports/` can split — one inherited file stays, one produced file
 *    moves).
 *  - `main` is NEVER migrated. Left entirely alone.
 *  - The target subdir is the CANONICAL one the running code computes:
 *    `artifactsScope(<workspaceDir>).rootRel` === `goals/<goal-id>`, resolved
 *    from the workspace's goal record
 *    (`<workspace>/.gitspace/workspace/<name>/goal.json`). A workspace with no
 *    goal record is SKIPPED (never guess a folder name).
 *
 * SAFETY POSTURE
 * --------------
 *  - DRY-RUN BY DEFAULT. Prints the full plan and mutates NOTHING. Pass
 *    `--apply` to actually move files.
 *  - IDEMPOTENT. An already-migrated branch (its produced files already live
 *    under `goals/<goal-id>/`, none left at root) is detected and SKIPPED.
 *    Safe to run twice.
 *  - BACKUP BEFORE MUTATION. Under `--apply`, each branch is tagged
 *    `premigrate/<branch>` at its pre-migration tip BEFORE any `git mv`. If
 *    that tag already exists the branch is REFUSED (a rerun can't clobber a
 *    backup). The exact undo command is printed.
 *  - Uses `git mv` so history follows (rename recorded). One commit per branch.
 *  - On ANY ambiguity (no goal record, dirty worktree, pre-existing backup
 *    tag, unexpected structure) the branch is SKIPPED and reported — never
 *    guessed, never forced.
 *  - Uncommitted working-tree edits in a mounted worktree are preserved: a
 *    dirty branch is skipped rather than touched.
 *
 * USAGE
 * -----
 *   bun scripts/migrate-artifacts-layout.ts            # dry-run (default)
 *   bun scripts/migrate-artifacts-layout.ts --apply    # perform the migration
 *   bun scripts/migrate-artifacts-layout.ts --projects-dir /path  # override root
 *
 * UNDO (per branch, after --apply)
 * --------------------------------
 *   # branch mounted at a worktree:
 *   git -C <workspace>/.gitspace/artifacts reset --hard premigrate/<branch>
 *   # branch not mounted:
 *   git -C <project>/.artifacts.git branch -f <branch> premigrate/<branch>
 *   # then, once satisfied:
 *   git -C <project>/.artifacts.git tag -d premigrate/<branch>
 * The script prints the exact command for each migrated branch.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';

import { artifactPaths, artifactsScope, readWorkspaceGoalId } from '../src/core/artifacts.js';

const MAIN_BRANCH = 'main';
const BACKUP_TAG_PREFIX = 'premigrate/';
// Machine identity for the migration commit — mirrors src/core/artifacts.ts.
const GIT_ID = ['-c', 'user.name=gitspace', '-c', 'user.email=artifacts@gitspace.sh', '-c', 'commit.gpgsign=false'];

const APPLY = process.argv.includes('--apply');

function resolveProjectsDir(): string {
  const flagIdx = process.argv.indexOf('--projects-dir');
  if (flagIdx >= 0 && process.argv[flagIdx + 1]) return process.argv[flagIdx + 1]!;
  const cfgPath = join(homedir(), 'gitspace', '.config.json');
  if (existsSync(cfgPath)) {
    try {
      const dir = (JSON.parse(readFileSync(cfgPath, 'utf8')) as { projectsDir?: unknown }).projectsDir;
      if (typeof dir === 'string' && dir.length > 0) return dir;
    } catch {
      /* fall through to default */
    }
  }
  return join(homedir(), 'gitspace');
}

// ── git plumbing (argv form, no shell) ──────────────────────────────────────

function git(dir: string, args: string[], env?: Record<string, string>): string {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      // Capture stderr (don't inherit) so expected probe failures in gitTry stay
      // silent; genuine failures surface it on the thrown error below.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    }).trim();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const detail = (err.stderr ? err.stderr.toString() : err.message ?? '').trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function gitId(dir: string, args: string[], env?: Record<string, string>): string {
  return git(dir, [...GIT_ID, ...args], env);
}

/** Try a git command; return null on failure (never throws). */
function gitTry(dir: string, args: string[]): string | null {
  try {
    return git(dir, args);
  } catch {
    return null;
  }
}

// ── discovery ───────────────────────────────────────────────────────────────

interface ProjectRepo {
  name: string;
  projectDir: string;
  repoDir: string;
}

function discoverProjects(projectsDir: string): ProjectRepo[] {
  if (!existsSync(projectsDir)) return [];
  const out: ProjectRepo[] = [];
  for (const name of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, name);
    let isDir = false;
    try {
      isDir = statSync(projectDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const { repoDir } = artifactPaths(projectDir);
    if (existsSync(join(repoDir, 'HEAD'))) out.push({ name, projectDir, repoDir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function listBranches(repoDir: string): string[] {
  return git(repoDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean);
}

/** branch → absolute mounted worktree path (only for branches with a worktree). */
function worktreeMap(repoDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const out = gitTry(repoDir, ['worktree', 'list', '--porcelain']) ?? '';
  let current: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/') && current) {
      map.set(line.slice('branch refs/heads/'.length), current);
    } else if (line === '') current = null;
  }
  return map;
}

// ── classification ──────────────────────────────────────────────────────────

/** Files tracked on `branch` at root (recursive), EXCLUDING `goals/**` and the
 *  top-level `.gitattributes` (which governs the whole tree and stays put). */
function rootTrackedFiles(repoDir: string, branch: string): string[] {
  return git(repoDir, ['ls-tree', '-r', '--name-only', branch])
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !f.startsWith('goals/'))
    .filter((f) => f !== '.gitattributes');
}

/** A file is PRODUCED unless it is present AND byte-identical at the branch's
 *  merge-base with main (then it is an inherited baseline that stays at root). */
function classify(repoDir: string, branch: string, mergeBase: string, files: string[]): { produced: string[]; inherited: string[] } {
  const produced: string[] = [];
  const inherited: string[] = [];
  for (const f of files) {
    const branchBlob = gitTry(repoDir, ['rev-parse', `${branch}:${f}`]);
    const baseBlob = gitTry(repoDir, ['rev-parse', `${mergeBase}:${f}`]);
    if (baseBlob !== null && baseBlob === branchBlob) inherited.push(f);
    else produced.push(f);
  }
  return { produced, inherited };
}

/** Does the branch already carry a `<rootRel>/…` subtree? */
function hasGoalSubtree(repoDir: string, branch: string, rootRel: string): boolean {
  const all = git(repoDir, ['ls-tree', '-r', '--name-only', branch]).split('\n');
  return all.some((p) => p === rootRel || p.startsWith(`${rootRel}/`));
}

// ── worktree state ──────────────────────────────────────────────────────────

/** Tracked (non-untracked) changes only — session scratch / untracked files
 *  are ignored so we never block on `.sessions/`. */
function dirtyTracked(worktreeDir: string): string[] {
  const out = gitTry(worktreeDir, ['status', '--porcelain']) ?? '';
  return out.split('\n').filter((l) => l.trim() && !l.startsWith('??'));
}

// ── plan ────────────────────────────────────────────────────────────────────

type Disposition =
  | { kind: 'migrate'; produced: string[]; inherited: string[]; rootRel: string; goalId: string }
  | { kind: 'skip'; reason: string };

interface BranchPlan {
  branch: string;
  workspaceDir: string | null;
  mountDir: string | null;
  disposition: Disposition;
}

function planBranch(repo: ProjectRepo, branch: string, mounts: Map<string, string>): BranchPlan {
  const mountDir = mounts.get(branch) ?? null;
  // Prefer the real mounted worktree to locate the workspace dir; fall back to
  // the conventional `<project>/workspaces/<branch>` for an unmounted branch.
  const workspaceDir = mountDir ? dirname(dirname(mountDir)) : join(repo.projectDir, 'workspaces', branch);

  if (!existsSync(workspaceDir)) {
    return { branch, workspaceDir: null, mountDir, disposition: { kind: 'skip', reason: `workspace dir not found (${workspaceDir}) — cannot resolve goal id` } };
  }

  // Canonical target dir — EXACTLY what the running code binds local:// to.
  const scope = artifactsScope(workspaceDir);
  const goalId = readWorkspaceGoalId(workspaceDir);
  if (scope.isProjectRoot || !goalId) {
    return { branch, workspaceDir, mountDir, disposition: { kind: 'skip', reason: 'no goal record (goal.json) for this workspace — refusing to guess a folder name' } };
  }
  const rootRel = scope.rootRel; // `goals/<goalId>`

  const mergeBase = gitTry(repo.repoDir, ['merge-base', branch, MAIN_BRANCH]);
  if (!mergeBase) {
    return { branch, workspaceDir, mountDir, disposition: { kind: 'skip', reason: `no merge-base with ${MAIN_BRANCH} (unrelated history) — refusing to classify` } };
  }

  const files = rootTrackedFiles(repo.repoDir, branch);
  const { produced, inherited } = classify(repo.repoDir, branch, mergeBase, files);

  if (produced.length === 0) {
    const reason = hasGoalSubtree(repo.repoDir, branch, rootRel)
      ? `already migrated (produced files already under ${rootRel}/, none at root)`
      : `nothing to migrate (no workspace-produced files — branch is fully merged into ${MAIN_BRANCH} / never diverged)`;
    return { branch, workspaceDir, mountDir, disposition: { kind: 'skip', reason } };
  }

  return { branch, workspaceDir, mountDir, disposition: { kind: 'migrate', produced, inherited, rootRel, goalId } };
}

// ── .gitattributes fixup (LFS pattern paths follow moved files) ──────────────

function attrToken(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

/** Rewrite root `.gitattributes` so any LFS pattern for a moved file points at
 *  its new `goals/<id>/…` path. No-op when the file is absent (the common case
 *  — the real repos have none). Returns true when the file changed. */
function fixGitattributes(worktreeDir: string, moves: Array<[string, string]>): boolean {
  const attrPath = join(worktreeDir, '.gitattributes');
  if (!existsSync(attrPath)) return false;
  const original = readFileSync(attrPath, 'utf8');
  let changed = false;
  const rewritten = original
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      // First token is the pattern (possibly quoted); the rest are attrs.
      const quoted = line.match(/^\s*"([^"]+)"(.*)$/);
      const pattern = quoted ? quoted[1]! : line.replace(/^\s*/, '').split(/\s+/)[0]!;
      const rest = quoted ? quoted[2]! : line.slice(line.indexOf(pattern) + pattern.length);
      const move = moves.find(([from]) => from === pattern);
      if (!move) return line;
      changed = true;
      return `${attrToken(move[1])}${rest}`;
    })
    .join('\n');
  if (changed) writeFileSync(attrPath, rewritten);
  return changed;
}

// ── apply ───────────────────────────────────────────────────────────────────

interface ApplyOutcome {
  ok: boolean;
  message: string;
  undo?: string;
}

function backupTagName(branch: string): string {
  return `${BACKUP_TAG_PREFIX}${branch}`;
}

function tagExists(repoDir: string, tag: string): boolean {
  return gitTry(repoDir, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]) !== null;
}

function applyBranch(repo: ProjectRepo, plan: BranchPlan): ApplyOutcome {
  if (plan.disposition.kind !== 'migrate') return { ok: true, message: 'skipped' };
  const { produced, rootRel } = plan.disposition;
  const { branch, mountDir } = plan;
  const tag = backupTagName(branch);

  // 1. Never clobber an existing backup — an interrupted rerun must not lose it.
  if (tagExists(repo.repoDir, tag)) {
    return { ok: false, message: `REFUSED: backup tag ${tag} already exists (interrupted prior run?). Inspect it, then delete it to retry: git -C ${repo.repoDir} tag -d ${tag}` };
  }

  // 2. Choose the worktree to operate in; never disturb uncommitted edits.
  let worktreeDir = mountDir;
  let tempWorktree: string | null = null;
  if (worktreeDir) {
    const dirty = dirtyTracked(worktreeDir);
    if (dirty.length > 0) {
      return { ok: false, message: `SKIPPED: mounted worktree has uncommitted tracked changes (${dirty.length}) — commit or stash them, then rerun. Left untouched.` };
    }
  }

  // 3. Backup BEFORE any mutation.
  git(repo.repoDir, ['tag', tag, `refs/heads/${branch}`]);

  try {
    if (!worktreeDir) {
      tempWorktree = join(repo.projectDir, `.artifacts-migrate-${Date.now()}`);
      git(repo.repoDir, ['worktree', 'add', '--quiet', tempWorktree, branch]);
      worktreeDir = tempWorktree;
    }

    // 4. git mv each produced file under goals/<goal-id>/ (history follows).
    const moves: Array<[string, string]> = produced.map((f) => [f, `${rootRel}/${f}`]);
    for (const [from, to] of moves) {
      // git mv does not create nested destination dirs — make them first.
      mkdirSync(dirname(join(worktreeDir, to)), { recursive: true });
      git(worktreeDir, ['mv', from, to]);
    }

    // 5. LFS attribute paths follow their files (no-op when none).
    const attrChanged = fixGitattributes(worktreeDir, moves);
    if (attrChanged) git(worktreeDir, ['add', '--', '.gitattributes']);

    // 6. One commit per branch. GSSH_ARTIFACTS_CAPTURE=1 stands the managed
    //    hooks down so this stays a PURE rename (no raw→LFS conversion, so git
    //    records renames and blobs are untouched).
    const msg = `migrate: flat layout -> ${rootRel}/ (${produced.length} produced file${produced.length === 1 ? '' : 's'})`;
    gitId(worktreeDir, ['commit', '-q', '-m', msg], { GSSH_ARTIFACTS_CAPTURE: '1' });

    const undo = mountDir
      ? `git -C ${mountDir} reset --hard ${tag}   # then: git -C ${repo.repoDir} tag -d ${tag}`
      : `git -C ${repo.repoDir} branch -f ${branch} ${tag}   # then: git -C ${repo.repoDir} tag -d ${tag}`;
    return { ok: true, message: `migrated ${produced.length} file(s) into ${rootRel}/ (backup tag ${tag})`, undo };
  } finally {
    if (tempWorktree) gitTry(repo.repoDir, ['worktree', 'remove', '--force', tempWorktree]);
  }
}

// ── reporting ───────────────────────────────────────────────────────────────

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function main(): void {
  const projectsDir = resolveProjectsDir();
  console.log(C.bold('\nArtifacts layout migration — flat → goal-keyed'));
  console.log(C.dim(`mode: ${APPLY ? 'APPLY (mutating)' : 'DRY-RUN (default — nothing is changed)'}`));
  console.log(C.dim(`projects dir: ${projectsDir}\n`));

  const projects = discoverProjects(projectsDir);
  if (projects.length === 0) {
    console.log(C.yellow('No projects with an artifacts repo found. Nothing to do.'));
    return;
  }

  let migrated = 0;
  let wouldMigrate = 0;
  let skipped = 0;
  let refused = 0;
  const undoCommands: string[] = [];

  for (const repo of projects) {
    console.log(C.bold(`▌ project ${repo.name}`) + C.dim(`  (${repo.repoDir})`));
    const mounts = worktreeMap(repo.repoDir);
    const branches = listBranches(repo.repoDir);
    const workspaceBranches = branches.filter((b) => b !== MAIN_BRANCH);

    if (branches.includes(MAIN_BRANCH)) console.log(`   ${C.dim('main')}  ${C.dim('left untouched (never migrated)')}`);
    if (workspaceBranches.length === 0) {
      console.log(`   ${C.dim('(no workspace branches — nothing to migrate)')}\n`);
      continue;
    }

    for (const branch of workspaceBranches) {
      let plan: BranchPlan;
      try {
        plan = planBranch(repo, branch, mounts);
      } catch (e) {
        skipped += 1;
        console.log(`   ${C.yellow('SKIP')} ${C.bold(branch)} — planning error: ${e instanceof Error ? e.message : e}`);
        continue;
      }

      if (plan.disposition.kind === 'skip') {
        skipped += 1;
        console.log(`   ${C.yellow('SKIP')} ${C.bold(branch)} — ${plan.disposition.reason}`);
        continue;
      }

      const { produced, inherited, rootRel, goalId } = plan.disposition;
      console.log(`   ${C.cyan('MIGRATE')} ${C.bold(branch)}  ${C.dim(`goal=${goalId}  →  ${rootRel}/`)}${plan.mountDir ? '' : C.dim('  [unmounted — temp worktree]')}`);
      for (const f of produced) console.log(`       ${C.green('move')} ${f}  →  ${rootRel}/${f}`);
      for (const f of inherited) console.log(`       ${C.dim(`stay ${f}  (inherited baseline)`)}`);

      if (!APPLY) {
        wouldMigrate += 1;
        continue;
      }

      const outcome = applyBranch(repo, plan);
      if (outcome.ok && outcome.undo) {
        migrated += 1;
        console.log(`       ${C.green('✓ ' + outcome.message)}`);
        console.log(`       ${C.dim('undo: ' + outcome.undo)}`);
        undoCommands.push(`# ${repo.name}/${branch}\n${outcome.undo}`);
      } else if (outcome.ok) {
        console.log(`       ${C.dim(outcome.message)}`);
      } else {
        refused += 1;
        console.log(`       ${C.red('✗ ' + outcome.message)}`);
      }
    }
    console.log('');
  }

  // ── summary ──
  console.log(C.bold('Summary'));
  if (APPLY) {
    console.log(`  migrated: ${C.green(String(migrated))}   skipped: ${C.yellow(String(skipped))}   refused: ${refused ? C.red(String(refused)) : '0'}`);
    if (undoCommands.length > 0) {
      console.log(C.bold('\nUndo (restores pre-migration state; run per branch as needed):'));
      for (const u of undoCommands) console.log(`  ${u.replace('\n', '\n  ')}`);
    }
    if (refused > 0) console.log(C.red('\nSome branches were refused (see ✗ above) — resolve and rerun; safe to repeat.'));
  } else {
    console.log(`  would migrate: ${C.cyan(String(wouldMigrate))}   would skip: ${C.yellow(String(skipped))}`);
    console.log(C.dim('\nDry-run only. Re-run with --apply to perform the migration.'));
    console.log(C.dim('Each migrated branch is tagged premigrate/<branch> before any change (backup + printed undo).'));
  }
  console.log('');
}

main();
