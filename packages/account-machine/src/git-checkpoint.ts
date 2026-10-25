import { copyFile, lstat, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { sameGitLfsSnapshot, spaceGitCheckpointRef, spaceGitSnapshotRef, type SpaceCheckpointManifest } from '@gitspace/protocol-workspace';
import type { z } from 'zod';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime';
import { captureGitLfs, checkoutGitLfs, gitLfsRestoreReceipt, gitLfsWorktreeTree, hydrateGitLfs, restoredGitLfsPaths, type MachineGitLfs, type MachineGitLfsPublication } from './git-lfs.js';
import { gitWorktreeClock, gitWorktreeDelay, type GitWorktreeClock } from './git-worktree-watch.js';
import { artifactsPublicationRejection } from './artifacts-git-remote.js';

export type GitIntermediateCheckpoint = z.infer<typeof RuntimeGitCheckpointSchema>;

export class GitCheckpointError extends Error {
  constructor(readonly operation: string, message: string) {
    super(`${operation}: ${message}`);
    this.name = 'GitCheckpointError';
  }
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runGit(repositoryPath: string, args: string[], options: { env?: Record<string, string>; input?: string; raw?: boolean; allowMissingRef?: boolean } = {}): Promise<CommandResult> {
  const child = Bun.spawn(['git', ...args], {
    cwd: repositoryPath,
    env: { ...Bun.env, ...options.env },
    stdin: options.input === undefined ? 'ignore' : new Blob([options.input]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0 && !(options.allowMissingRef && exitCode === 1)) throw new GitCheckpointError(`git ${args[0] ?? ''}`.trim(), stderr.trim() || `exited with ${exitCode}`);
  return { exitCode, stdout: options.raw ? stdout : stdout.trim(), stderr: stderr.trim() };
}

function portablePath(repositoryPath: string, path: string): string {
  const absoluteRepository = resolve(repositoryPath);
  const absolutePath = resolve(repositoryPath, path);
  const local = relative(absoluteRepository, absolutePath);
  if (isAbsolute(path) || local === '' || local === '..' || local.startsWith(`..${sep}`)) {
    throw new GitCheckpointError('portable path', `${path} is outside the repository`);
  }
  return local.split(sep).join('/');
}

function checkpointEnvironment(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: 'GitSpace Checkpoint',
    GIT_AUTHOR_EMAIL: 'checkpoint@gitspace.invalid',
    GIT_COMMITTER_NAME: 'GitSpace Checkpoint',
    GIT_COMMITTER_EMAIL: 'checkpoint@gitspace.invalid',
  };
}

async function commitTree(repositoryPath: string, tree: string, parent: string | null, message: string): Promise<string> {
  const committed = await runGit(repositoryPath, ['commit-tree', tree, ...(parent === null ? [] : ['-p', parent])], {
    env: checkpointEnvironment(),
    input: `${message}\n`,
  });
  return committed.stdout;
}

export async function readGitCheckpointHead(repositoryPath: string): Promise<Pick<GitIntermediateCheckpoint, 'branch' | 'headCommit'>> {
  const branchRef = (await runGit(repositoryPath, ['symbolic-ref', 'HEAD'])).stdout;
  if (!branchRef.startsWith('refs/heads/')) throw new GitCheckpointError('branch', 'HEAD must name a branch');
  const branch = branchRef.slice('refs/heads/'.length);
  const branchExists = await runGit(repositoryPath, ['show-ref', '--verify', '--quiet', branchRef], { allowMissingRef: true });
  const headCommit = branchExists.exitCode === 1 ? null : (await runGit(repositoryPath, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout;
  return { branch, headCommit };
}


export async function readGitCheckpointInputStamp(repositoryPath: string): Promise<string> {
  const [tracked, untracked] = await Promise.all([
    runGit(repositoryPath, ['ls-files', '--modified', '--deleted', '-z'], { raw: true }),
    runGit(repositoryPath, ['ls-files', '--others', '--exclude-standard', '-z'], { raw: true }),
  ]);
  const paths = [...new Set([
    ...tracked.stdout.split('\0').filter(Boolean),
    ...untracked.stdout.split('\0').filter(Boolean),
  ])].sort();
  const index = (await runGit(repositoryPath, ['rev-parse', '--git-path', 'index'])).stdout;
  const stamps = await Promise.all([...paths, index].map(async path => {
    try {
      const stat = await lstat(resolve(repositoryPath, path), { bigint: true });
      return [path, stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(), stat.mode.toString()];
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [path, null];
      throw error;
    }
  }));
  return JSON.stringify([await readGitCheckpointHead(repositoryPath), stamps]);
}

export async function createGitIntermediateCheckpoint(input: {
  repositoryPath: string;
  spaceId: string;
  revision: number;
  captureId?: string;
  /** Overrides the space checkpoint ref, e.g. for a backup. */
  checkpointRef?: string;
  portableUntrackedPaths?: string[];
  lfs?: MachineGitLfsPublication;
  /** The LFS objects of the snapshot this capture follows; objects it placed are not confirmed or stored again. */
  committedLfs?: GitIntermediateCheckpoint['lfs'];
}): Promise<GitIntermediateCheckpoint> {
  const { branch, headCommit } = await readGitCheckpointHead(input.repositoryPath);
  const checkpointRef = input.checkpointRef ?? spaceGitCheckpointRef(input.captureId ?? input.spaceId, input.revision);
  const temporary = await mkdtemp(join(tmpdir(), 'gitspace-checkpoint-'));
  const temporaryIndex = join(temporary, 'index');
  const indexEnvironment = { GIT_INDEX_FILE: temporaryIndex };
  try {
    const lfs = await captureGitLfs(input.repositoryPath, headCommit, join(temporary, 'authority-index'), input.lfs, input.committedLfs);
    const realIndex = (await runGit(input.repositoryPath, ['rev-parse', '--git-path', 'index'])).stdout;
    try { await copyFile(resolve(input.repositoryPath, realIndex), temporaryIndex); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      await runGit(input.repositoryPath, ['read-tree', '--empty'], { env: indexEnvironment });
    }
    await lfs.sanitize(temporaryIndex, 'staged');
    const indexTree = (await runGit(input.repositoryPath, ['write-tree'], { env: indexEnvironment })).stdout;
    const indexCommit = await commitTree(input.repositoryPath, indexTree, headCommit, `GitSpace index checkpoint ${input.revision}`);
    await runGit(input.repositoryPath, [...rawFilters, 'add', '-u', '--', '.'], { env: indexEnvironment });
    await lfs.sanitize(temporaryIndex, 'modified');
    const trackedWorktreeTree = (await runGit(input.repositoryPath, ['write-tree'], { env: indexEnvironment })).stdout;
    const trackedWorktreeCommit = await commitTree(
      input.repositoryPath,
      trackedWorktreeTree,
      indexCommit,
      `GitSpace tracked worktree checkpoint ${input.revision}`,
    );
    const discovered = input.portableUntrackedPaths ?? (await runGit(input.repositoryPath, ['ls-files', '--others', '--exclude-standard', '-z'], { raw: true })).stdout.split('\0').filter(Boolean);
    const portablePaths = [...new Set(discovered.map((path) => portablePath(input.repositoryPath, path)))].sort();
    for (const path of portablePaths) {
      const ignored = Bun.spawn(['git', 'check-ignore', '-q', '--', path], { cwd: input.repositoryPath, stdout: 'ignore', stderr: 'ignore' });
      if (await ignored.exited === 0) throw new GitCheckpointError('portable path', `${path} is ignored and may contain machine-local or secret state`);
    }
    if (portablePaths.length > 0) await runGit(input.repositoryPath, [...rawFilters, 'add', '--', ...portablePaths], { env: indexEnvironment });
    await lfs.sanitize(temporaryIndex, 'added');
    const worktreeTree = (await runGit(input.repositoryPath, ['write-tree'], { env: indexEnvironment })).stdout;
    const worktreeCommit = await commitTree(
      input.repositoryPath,
      worktreeTree,
      trackedWorktreeCommit,
      `GitSpace portable worktree checkpoint ${input.revision}`,
    );
    await runGit(input.repositoryPath, ['update-ref', checkpointRef, worktreeCommit]);
    return { checkpointRef, headCommit, branch, indexCommit, trackedWorktreeCommit, worktreeCommit, indexTree, worktreeTree, lfs: lfs.snapshot };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function completeGitCheckpoint(repositoryPath: string, checkpoint: SpaceCheckpointManifest['repository']): Promise<GitIntermediateCheckpoint> {
  const complete = RuntimeGitCheckpointSchema.safeParse(checkpoint);
  if (complete.success) return complete.data;
  const [trackedWorktreeCommit, indexTree, worktreeTree] = await Promise.all([
    runGit(repositoryPath, ['rev-parse', `${checkpoint.worktreeCommit}^`]),
    runGit(repositoryPath, ['rev-parse', `${checkpoint.indexCommit}^{tree}`]),
    runGit(repositoryPath, ['rev-parse', `${checkpoint.worktreeCommit}^{tree}`]),
  ]);
  return RuntimeGitCheckpointSchema.parse({ ...checkpoint, trackedWorktreeCommit: trackedWorktreeCommit.stdout, indexTree: indexTree.stdout, worktreeTree: worktreeTree.stdout });
}

// The on-disk base filename is retained so existing cache reconciliation keeps its merge base.
export async function readGitCacheBase(repositoryPath: string): Promise<GitIntermediateCheckpoint | null> {
  const path = resolve(repositoryPath, (await runGit(repositoryPath, ['rev-parse', '--git-path', 'gitspace-replica-base.json'])).stdout);
  try { return RuntimeGitCheckpointSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveGitCacheBase(repositoryPath: string, checkpoint: GitIntermediateCheckpoint): Promise<void> {
  const path = resolve(repositoryPath, (await runGit(repositoryPath, ['rev-parse', '--git-path', 'gitspace-replica-base.json'])).stdout);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(checkpoint)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}


export async function restoreGitIntermediateCheckpoint(input: {
  repositoryPath: string;
  checkpoint: SpaceCheckpointManifest['repository'];
  branch: string;
  lfs?: MachineGitLfs;
}): Promise<void> {
  if (!/^[A-Za-z0-9._/-]+$/u.test(input.branch) || input.branch.startsWith('/') || input.branch.includes('..')) {
    throw new GitCheckpointError('restore branch', `invalid branch ${input.branch}`);
  }
  await hydrateGitLfs(input.repositoryPath, [input.checkpoint.worktreeCommit], input.checkpoint.lfs, input.lfs);
  const branchRef = `refs/heads/${input.branch}`;
  await runGit(input.repositoryPath, ['symbolic-ref', 'HEAD', branchRef]);
  if (input.checkpoint.headCommit === null) {
    await runGit(input.repositoryPath, ['update-ref', '-d', branchRef]);
  } else {
    await runGit(input.repositoryPath, ['update-ref', branchRef, input.checkpoint.headCommit]);
    await runGit(input.repositoryPath, ['reset', '--hard', input.checkpoint.headCommit], { env: { GIT_LFS_SKIP_SMUDGE: '1' } });
  }
  await runGit(input.repositoryPath, ['read-tree', '--reset', '-u', input.checkpoint.worktreeCommit], { env: { GIT_LFS_SKIP_SMUDGE: '1' } });
  await runGit(input.repositoryPath, ['read-tree', input.checkpoint.indexCommit]);
  await checkoutGitLfs(input.repositoryPath, input.checkpoint.worktreeCommit);
  await gitLfsRestoreReceipt(input.repositoryPath, await restoredGitLfsPaths(input.repositoryPath, input.checkpoint.worktreeCommit, input.checkpoint.lfs));
  await saveGitCacheBase(input.repositoryPath, await completeGitCheckpoint(input.repositoryPath, input.checkpoint));
}

export interface GitTreeChange { status: string; path: string }
/** Paths that differ between two trees as Git name-status entries, at most `limit` of them. */
export async function gitTreeChanges(repositoryPath: string, from: string, to: string, limit: number): Promise<{ changes: GitTreeChange[]; truncated: boolean }> {
  const fields = (await runGit(repositoryPath, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to], { raw: true })).stdout.split('\0').filter(Boolean);
  const changes: GitTreeChange[] = [];
  for (let index = 0; index + 1 < fields.length && changes.length < limit; index += 2) changes.push({ status: fields[index]!, path: fields[index + 1]! });
  return { changes, truncated: fields.length / 2 > limit };
}

/** A unified diff of one path between two trees. */
export async function gitTreePatch(repositoryPath: string, from: string, to: string, path: string): Promise<string> {
  return (await runGit(repositoryPath, ['diff-tree', '-p', '--no-renames', from, to, '--', path], { raw: true })).stdout;
}

export async function deleteGitRef(repositoryPath: string, ref: string): Promise<void> {
  await runGit(repositoryPath, ['update-ref', '-d', ref]);
}

/** The working copy exactly as a snapshot would send it, without publishing anything. */
export async function readGitWorktreeSnapshot(repositoryPath: string, spaceId: string): Promise<GitIntermediateCheckpoint> {
  const scratch = await createGitIntermediateCheckpoint({ repositoryPath, spaceId, captureId: `status-${crypto.randomUUID()}`, revision: Date.now() });
  await runGit(repositoryPath, ['update-ref', '-d', scratch.checkpointRef]);
  return scratch;
}

/** Resets the working copy, index, HEAD and branch to `base`. Files `current` added are removed too;
 * ignored files are never touched. */
export async function resetGitWorktree(input: { repositoryPath: string; current: GitIntermediateCheckpoint; base: GitIntermediateCheckpoint; lfs?: MachineGitLfs }): Promise<void> {
  // Track everything the snapshot holds, so the reset below removes what the base lacks.
  await runGit(input.repositoryPath, ['read-tree', input.current.worktreeCommit]);
  await restoreGitIntermediateCheckpoint({ repositoryPath: input.repositoryPath, checkpoint: input.base, branch: input.base.branch, lfs: input.lfs });
}

/** Re-applies the changes `backup` made since `base` onto the current files, as unsent changes. HEAD, the branch
 * and the index stay where they are. Overlapping edits are left as Git conflict markers and returned. */
export async function mergeGitBackupIntoWorktree(input: { repositoryPath: string; current: GitIntermediateCheckpoint; base: string; backup: string }): Promise<{ changes: GitTreeChange[]; conflicts: string[] }> {
  // Exit 1 means the merge has conflicts; the tree is still written, with markers.
  const fields = (await runGit(input.repositoryPath, ['merge-tree', '--write-tree', '-z', '--name-only', `--merge-base=${input.base}`, input.current.worktreeCommit, input.backup], { raw: true, allowMissingRef: true })).stdout.split('\0');
  const tree = fields[0]!;
  const end = fields.indexOf('', 1);
  const conflicts = [...new Set(fields.slice(1, end === -1 ? fields.length : end))];
  const { changes } = await gitTreeChanges(input.repositoryPath, input.current.worktreeTree, tree, 10_000);
  // Track everything the snapshot holds, so files the backup deleted are removed too.
  await runGit(input.repositoryPath, ['read-tree', input.current.worktreeCommit]);
  await runGit(input.repositoryPath, ['read-tree', '--reset', '-u', tree], { env: { GIT_LFS_SKIP_SMUDGE: '1' } });
  await runGit(input.repositoryPath, ['read-tree', input.current.indexTree]);
  await checkoutGitLfs(input.repositoryPath, tree);
  return { changes, conflicts };
}

/** GitSpace's snapshots and deltas carry an LFS file's real bytes (`gitLfsWorktreeTree`), so the commands that read or
 * write them switch off the LFS filter Git LFS's own setup configures; with it, Git would compare and write pointers. */
const rawFilters = ['-c', 'filter.lfs.process=', '-c', 'filter.lfs.clean=cat', '-c', 'filter.lfs.smudge=cat', '-c', 'filter.lfs.required=false'];

/** Apply only the portable delta. Git checks preimages before writing, so concurrent
 * human edits reject reconciliation rather than being reset out of the checkout. */
export async function applyGitCacheCheckpoint(input: {
  repositoryPath: string;
  previous: GitIntermediateCheckpoint;
  checkpoint: GitIntermediateCheckpoint;
  lfs?: MachineGitLfs;
}): Promise<void> {
  const { repositoryPath, previous, checkpoint } = input;
  await hydrateGitLfs(repositoryPath, [previous.worktreeCommit], previous.lfs, input.lfs);
  await hydrateGitLfs(repositoryPath, [checkpoint.worktreeCommit], checkpoint.lfs, input.lfs);
  const protectedPaths = [...new Set([...(previous.lfs?.heldBack ?? []), ...(checkpoint.lfs?.heldBack ?? [])].map(item => item.path))];
  const [beforeTree, afterTree] = await Promise.all([
    gitLfsWorktreeTree(repositoryPath, previous.worktreeCommit, checkpoint.worktreeCommit, protectedPaths),
    gitLfsWorktreeTree(repositoryPath, checkpoint.worktreeCommit, previous.worktreeCommit, protectedPaths),
  ]);
  const patch = (await runGit(repositoryPath, ['diff', '--binary', beforeTree, afterTree, '--', '.', ...protectedPaths.map(path => `:(exclude,literal)${path}`)], { raw: true })).stdout;
  if (patch) {
    try { await runGit(repositoryPath, [...rawFilters, 'apply', '--binary', '--whitespace=nowarn', '-'], { input: patch }); }
    catch (error) {
      // The worktree update may have completed before a process stopped while
      // updating the index/HEAD. Accept only a verifiably installed delta.
      try { await runGit(repositoryPath, [...rawFilters, 'apply', '--reverse', '--check', '-'], { input: patch }); }
      catch { throw error; }
    }
  }
  // Two-tree merging preserves concurrently staged changes or refuses them.
  await runGit(repositoryPath, ['read-tree', '-i', '-m', previous.indexCommit, checkpoint.indexCommit]);
  if (checkpoint.headCommit !== previous.headCommit || checkpoint.branch !== previous.branch) {
    const head = await readGitCheckpointHead(repositoryPath);
    if (head.headCommit !== checkpoint.headCommit || head.branch !== checkpoint.branch) {
      if (head.headCommit !== previous.headCommit || head.branch !== previous.branch) throw new GitCheckpointError('cache HEAD', 'HEAD changed during reconciliation');
      const target = `refs/heads/${checkpoint.branch}`;
      const zero = '0000000000000000000000000000000000000000';
      if (checkpoint.branch === previous.branch) {
        if (checkpoint.headCommit) await runGit(repositoryPath, ['update-ref', target, checkpoint.headCommit, previous.headCommit ?? zero]);
        else await runGit(repositoryPath, ['update-ref', '-d', target, previous.headCommit ?? zero]);
      } else {
        const existing = await runGit(repositoryPath, ['show-ref', '--verify', '--quiet', target], { allowMissingRef: true });
        if (existing.exitCode === 0 && (await runGit(repositoryPath, ['rev-parse', target])).stdout !== checkpoint.headCommit) throw new GitCheckpointError('cache branch', 'Target branch changed during reconciliation');
        if (existing.exitCode === 1 && checkpoint.headCommit) await runGit(repositoryPath, ['update-ref', target, checkpoint.headCommit, zero]);
        await runGit(repositoryPath, ['symbolic-ref', 'HEAD', target]);
      }
    }
  }
  await checkoutGitLfs(repositoryPath, checkpoint.worktreeCommit, protectedPaths);
}

export async function gitCheckpointIncludes(repositoryPath: string, checkpoint: GitIntermediateCheckpoint, previous: GitIntermediateCheckpoint): Promise<boolean> {
  return (await runGit(repositoryPath, ['merge-base', '--is-ancestor', previous.worktreeCommit, checkpoint.worktreeCommit], { allowMissingRef: true })).exitCode === 0;
}

/** A captured snapshot and the committed worktree it was taken against. */
export interface PendingGitSnapshot { checkpoint: GitIntermediateCheckpoint; base: string | null }

/** Serializes capture/publication; only uncertain writes retain their immutable pending ref. */
export class IncrementalGitSnapshots {
  private pending: Promise<GitIntermediateCheckpoint> | undefined;
  private unpublished: PendingGitSnapshot | undefined;

  constructor(private readonly options: {
    repositoryPath: string;
    spaceId: string;
    captureId?: string;
    lfs?: (publicationId: string) => Promise<MachineGitLfsPublication>;
    // Human writers have no completion protocol. Require this much unchanged
    // size/mtime/ctime for the complete dirty set, then recheck on both sides of
    // capture. This conservatively coalesces bursts, not arbitrarily long pauses.
    settleWindowMs?: number;
    clock?: GitWorktreeClock;
    signal?: AbortSignal;
    normalizeBranch?(branch: string, committed: GitIntermediateCheckpoint | null): string;
    allocateRevision(): Promise<number>;
    loadPending(): Promise<PendingGitSnapshot | null>;
    loadCommitted(): Promise<GitIntermediateCheckpoint | null>;
    savePending(pending: PendingGitSnapshot): Promise<void>;
    clearPending(): Promise<void>;
    /** `committed` is the last accepted checkpoint, whose HEAD the remote holds. */
    publish(checkpoint: GitIntermediateCheckpoint, committed: GitIntermediateCheckpoint | null): Promise<void>;
    /** `base` is the committed worktree the snapshot was taken against, never the current one. */
    commit(checkpoint: GitIntermediateCheckpoint, base: string | null): Promise<GitIntermediateCheckpoint>;
  }) {}

  capture(): Promise<GitIntermediateCheckpoint> {
    if (this.pending) return this.pending;
    const operation = this.captureNext();
    this.pending = operation;
    void operation.finally(() => { this.pending = undefined; }).catch(() => {});
    return operation;
  }

  async settle(): Promise<void> {
    await this.pending;
  }

  private async captureNext(): Promise<GitIntermediateCheckpoint> {
    const committed = await this.options.loadCommitted();
    const base = committed?.worktreeCommit ?? null;
    let stored = this.unpublished ?? await this.options.loadPending();
    // A snapshot taken against an older base would undo everything applied since. The checkout already
    // holds those changes, so drop the stale snapshot and capture again.
    if (stored && stored.base !== base) {
      // The ref may already be gone; it is only this snapshot's own publication ref.
      await runGit(this.options.repositoryPath, ['update-ref', '-d', stored.checkpoint.checkpointRef], { allowMissingRef: true }).catch(() => undefined);
      await (await this.options.lfs?.(stored.checkpoint.checkpointRef))?.releasePublication?.();
      // Its journal row goes too, or every later capture loads and drops it again.
      await this.options.clearPending();
      this.unpublished = undefined;
      stored = null;
    }
    let checkpoint = stored?.checkpoint ?? null;
    // Only a snapshot this call captured may be dropped on rejection; a reused pending one may already be on the remote.
    const fresh = !checkpoint;
    if (!checkpoint) {
      for (;;) {
        this.options.signal?.throwIfAborted();
        let stable = await readGitCheckpointInputStamp(this.options.repositoryPath);
        if (this.options.settleWindowMs !== undefined) {
          for (;;) {
            await gitWorktreeDelay(this.options.clock ?? gitWorktreeClock, this.options.settleWindowMs, this.options.signal);
            const next = await readGitCheckpointInputStamp(this.options.repositoryPath);
            if (next === stable) break;
            stable = next;
          }
        }
        const revision = await this.options.allocateRevision();
        const publicationId = spaceGitSnapshotRef(this.options.captureId ?? this.options.spaceId);
        const lfs = await this.options.lfs?.(publicationId);
        // Allocation and storage preparation can yield after the settle check.
        if (stable !== await readGitCheckpointInputStamp(this.options.repositoryPath)) {
          await lfs?.releasePublication?.();
          continue;
        }
        checkpoint = await createGitIntermediateCheckpoint({
          repositoryPath: this.options.repositoryPath,
          spaceId: this.options.spaceId,
          captureId: this.options.captureId,
          revision,
          checkpointRef: publicationId,
          lfs,
          committedLfs: committed?.lfs,
        });
        if (stable !== await readGitCheckpointInputStamp(this.options.repositoryPath)) {
          // Never journal, upload, or admit a candidate captured across a write.
          await runGit(this.options.repositoryPath, ['update-ref', '-d', checkpoint.checkpointRef, checkpoint.worktreeCommit], { allowMissingRef: true });
          await lfs?.releasePublication?.();
          continue;
        }
        this.options.signal?.throwIfAborted();
        checkpoint.branch = this.options.normalizeBranch?.(checkpoint.branch, committed) ?? checkpoint.branch;
        break;
      }
    }
    // The committed snapshot came back through the cloud, which keeps each LFS object's keys in its schema's order and
    // its objects in the order its merges added them, while a capture sorts them by oid; compared as listed, an
    // unchanged checkout always looked changed and was published again, forever.
    if (committed && committed.headCommit === checkpoint.headCommit && committed.branch === checkpoint.branch && committed.indexTree === checkpoint.indexTree && committed.worktreeTree === checkpoint.worktreeTree
      && sameGitLfsSnapshot(committed.lfs, checkpoint.lfs)) {
      // A stored snapshot can match what was committed after it (a restore, an applied cloud version) and its ref may
      // be gone already: it is dropped, not replayed, or every later capture would fail on it.
      if (committed.checkpointRef !== checkpoint.checkpointRef) await runGit(this.options.repositoryPath, ['update-ref', '-d', checkpoint.checkpointRef, checkpoint.worktreeCommit], { allowMissingRef: true });
      if (!fresh) { this.unpublished = undefined; await this.options.clearPending(); }
      await (await this.options.lfs?.(checkpoint.checkpointRef))?.releasePublication?.();
      return committed;
    }
    this.options.signal?.throwIfAborted();
    this.unpublished = { checkpoint, base };
    await this.options.savePending({ checkpoint, base });
    try { await this.options.publish(checkpoint, committed); }
    catch (error) {
      if (fresh && artifactsPublicationRejection(error)) {
        // Publication preflight guarantees these bytes never reached the remote; the next capture tries again.
        // Uncertain publication/commit failures must never take this branch.
        this.unpublished = undefined;
        await this.options.clearPending();
        await (await this.options.lfs?.(checkpoint.checkpointRef))?.releasePublication?.();
      }
      throw error;
    }
    // An aborted stream (e.g. a sync discard reset the checkout meanwhile) must not commit what it published.
    this.options.signal?.throwIfAborted();
    let accepted: GitIntermediateCheckpoint;
    try { accepted = await this.options.commit(checkpoint, base); }
    catch (error) { this.unpublished = undefined; throw error; }
    this.unpublished = undefined;
    await (await this.options.lfs?.(checkpoint.checkpointRef))?.releasePublication?.();
    return accepted;
  }
}
