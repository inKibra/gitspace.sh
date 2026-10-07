import { copyFile, lstat, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spaceGitCheckpointRef, type SpaceCheckpointManifest } from '@gitspace/protocol-workspace';
import type { z } from 'zod';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime';
import { captureGitLfs, checkoutGitLfs, gitLfsRestoreReceipt, gitLfsWorktreeTree, hydrateGitLfs, restoredGitLfsPaths, type MachineGitLfs } from './git-lfs.js';
import { gitWorktreeClock, gitWorktreeDelay, type GitWorktreeClock } from './git-worktree-watch.js';

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


async function checkpointWorktreeStamp(repositoryPath: string): Promise<string> {
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
  portableUntrackedPaths?: string[];
  lfs?: MachineGitLfs;
}): Promise<GitIntermediateCheckpoint> {
  const { branch, headCommit } = await readGitCheckpointHead(input.repositoryPath);
  const checkpointRef = spaceGitCheckpointRef(input.captureId ?? input.spaceId, input.revision);
  const temporary = await mkdtemp(join(tmpdir(), 'gitspace-checkpoint-'));
  const temporaryIndex = join(temporary, 'index');
  const indexEnvironment = { GIT_INDEX_FILE: temporaryIndex };
  try {
    const lfs = await captureGitLfs(input.repositoryPath, headCommit, join(temporary, 'authority-index'), input.lfs);
    const realIndex = (await runGit(input.repositoryPath, ['rev-parse', '--git-path', 'index'])).stdout;
    try { await copyFile(resolve(input.repositoryPath, realIndex), temporaryIndex); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      await runGit(input.repositoryPath, ['read-tree', '--empty'], { env: indexEnvironment });
    }
    await lfs.sanitize(temporaryIndex, 'staged');
    const indexTree = (await runGit(input.repositoryPath, ['write-tree'], { env: indexEnvironment })).stdout;
    const indexCommit = await commitTree(input.repositoryPath, indexTree, headCommit, `GitSpace index checkpoint ${input.revision}`);
    const rawFilters = ['-c', 'filter.lfs.process=', '-c', 'filter.lfs.clean=cat', '-c', 'filter.lfs.required=false'];
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
    try { await runGit(repositoryPath, ['apply', '--binary', '--whitespace=nowarn', '-'], { input: patch }); }
    catch (error) {
      // The worktree update may have completed before a process stopped while
      // updating the index/HEAD. Accept only a verifiably installed delta.
      try { await runGit(repositoryPath, ['apply', '--reverse', '--check', '-'], { input: patch }); }
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

/** Serializes capture/publication; a failed publication is retried with the same immutable ref. */
export class IncrementalGitSnapshots {
  private pending: Promise<GitIntermediateCheckpoint> | undefined;
  private unpublished: GitIntermediateCheckpoint | undefined;

  constructor(private readonly options: {
    repositoryPath: string;
    spaceId: string;
    captureId?: string;
    lfs?: (publicationId: string) => Promise<MachineGitLfs>;
    // Human writers have no completion protocol. Require this much unchanged
    // size/mtime/ctime for the complete dirty set, then recheck on both sides of
    // capture. This conservatively coalesces bursts, not arbitrarily long pauses.
    settleWindowMs?: number;
    clock?: GitWorktreeClock;
    signal?: AbortSignal;
    normalizeBranch?(branch: string, committed: GitIntermediateCheckpoint | null): string;
    allocateRevision(): Promise<number>;
    loadPending(): Promise<GitIntermediateCheckpoint | null>;
    loadCommitted(): Promise<GitIntermediateCheckpoint | null>;
    savePending(checkpoint: GitIntermediateCheckpoint): Promise<void>;
    publish(checkpoint: GitIntermediateCheckpoint): Promise<void>;
    commit(checkpoint: GitIntermediateCheckpoint): Promise<GitIntermediateCheckpoint>;
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
    let checkpoint = this.unpublished ?? await this.options.loadPending();
    const committed = await this.options.loadCommitted();
    if (!checkpoint) {
      for (;;) {
        this.options.signal?.throwIfAborted();
        let stable: string | undefined;
        if (this.options.settleWindowMs !== undefined) {
          stable = await checkpointWorktreeStamp(this.options.repositoryPath);
          for (;;) {
            await gitWorktreeDelay(this.options.clock ?? gitWorktreeClock, this.options.settleWindowMs, this.options.signal);
            const next = await checkpointWorktreeStamp(this.options.repositoryPath);
            if (next === stable) break;
            stable = next;
          }
        }
        const revision = await this.options.allocateRevision();
        const publicationId = spaceGitCheckpointRef(this.options.captureId ?? this.options.spaceId, revision);
        const lfs = await this.options.lfs?.(publicationId);
        // Allocation and storage preparation can yield after the settle check.
        if (stable !== undefined && stable !== await checkpointWorktreeStamp(this.options.repositoryPath)) {
          await lfs?.releasePublication?.();
          continue;
        }
        checkpoint = await createGitIntermediateCheckpoint({
          repositoryPath: this.options.repositoryPath,
          spaceId: this.options.spaceId,
          captureId: this.options.captureId,
          revision,
          lfs,
        });
        if (stable !== undefined && stable !== await checkpointWorktreeStamp(this.options.repositoryPath)) {
          // Never journal, upload, or admit a candidate captured across a write.
          await runGit(this.options.repositoryPath, ['update-ref', '-d', checkpoint.checkpointRef, checkpoint.worktreeCommit]);
          await lfs?.releasePublication?.();
          continue;
        }
        this.options.signal?.throwIfAborted();
        checkpoint.branch = this.options.normalizeBranch?.(checkpoint.branch, committed) ?? checkpoint.branch;
        break;
      }
    }
    if (committed && committed.headCommit === checkpoint.headCommit && committed.branch === checkpoint.branch && committed.indexTree === checkpoint.indexTree && committed.worktreeTree === checkpoint.worktreeTree && JSON.stringify(committed.lfs) === JSON.stringify(checkpoint.lfs)) {
      if (committed.checkpointRef !== checkpoint.checkpointRef) await runGit(this.options.repositoryPath, ['update-ref', '-d', checkpoint.checkpointRef, checkpoint.worktreeCommit]);
      await (await this.options.lfs?.(checkpoint.checkpointRef))?.releasePublication?.();
      return committed;
    }
    this.unpublished = checkpoint;
    await this.options.savePending(checkpoint);
    await this.options.publish(checkpoint);
    let accepted: GitIntermediateCheckpoint;
    try { accepted = await this.options.commit(checkpoint); }
    catch (error) { this.unpublished = undefined; throw error; }
    this.unpublished = undefined;
    await (await this.options.lfs?.(checkpoint.checkpointRef))?.releasePublication?.();
    return accepted;
  }
}
