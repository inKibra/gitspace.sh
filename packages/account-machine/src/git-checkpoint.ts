import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spaceGitCheckpointRef } from '@gitspace/protocol-workspace';
import type { z } from 'zod';
import type { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime';
import { captureGitLfs, checkoutGitLfs, gitLfsRestoreReceipt, hydrateGitLfs, restoredGitLfsPaths, type MachineGitLfs } from './git-lfs.js';

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

export async function createGitIntermediateCheckpoint(input: {
  repositoryPath: string;
  spaceId: string;
  revision: number;
  portableUntrackedPaths?: string[];
  lfs?: MachineGitLfs;
}): Promise<GitIntermediateCheckpoint> {
  const { branch, headCommit } = await readGitCheckpointHead(input.repositoryPath);
  const checkpointRef = spaceGitCheckpointRef(input.spaceId, input.revision);
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

export async function restoreGitIntermediateCheckpoint(input: {
  repositoryPath: string;
  checkpoint: Pick<GitIntermediateCheckpoint, 'headCommit' | 'indexCommit' | 'worktreeCommit' | 'lfs'>;
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
}

/** Serializes capture/publication; a failed publication is retried with the same immutable ref. */
export class IncrementalGitSnapshots {
  private pending: Promise<GitIntermediateCheckpoint> | undefined;
  private unpublished: GitIntermediateCheckpoint | undefined;

  constructor(private readonly options: {
    repositoryPath: string;
    spaceId: string;
    lfs?: (publicationId: string) => Promise<MachineGitLfs>;
    allocateRevision(): Promise<number>;
    loadPending(): Promise<GitIntermediateCheckpoint | null>;
    loadCommitted(): Promise<GitIntermediateCheckpoint | null>;
    savePending(checkpoint: GitIntermediateCheckpoint): Promise<void>;
    publish(checkpoint: GitIntermediateCheckpoint): Promise<void>;
    commit(checkpoint: GitIntermediateCheckpoint): Promise<void>;
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
    if (!checkpoint) {
      const revision = await this.options.allocateRevision();
      checkpoint = await createGitIntermediateCheckpoint({
        repositoryPath: this.options.repositoryPath,
        spaceId: this.options.spaceId,
        revision,
        lfs: await this.options.lfs?.(spaceGitCheckpointRef(this.options.spaceId, revision)),
      });
    }
    const committed = await this.options.loadCommitted();
    if (committed && committed.headCommit === checkpoint.headCommit && committed.branch === checkpoint.branch && committed.indexTree === checkpoint.indexTree && committed.worktreeTree === checkpoint.worktreeTree && JSON.stringify(committed.lfs) === JSON.stringify(checkpoint.lfs)) {
      if (committed.checkpointRef !== checkpoint.checkpointRef) await runGit(this.options.repositoryPath, ['update-ref', '-d', checkpoint.checkpointRef, checkpoint.worktreeCommit]);
      await (await this.options.lfs?.(checkpoint.checkpointRef))?.releasePublication?.();
      return committed;
    }
    this.unpublished = checkpoint;
    await this.options.savePending(checkpoint);
    await this.options.publish(checkpoint);
    await this.options.commit(checkpoint);
    await (await this.options.lfs?.(checkpoint.checkpointRef))?.releasePublication?.();
    this.unpublished = undefined;
    return checkpoint;
  }
}
