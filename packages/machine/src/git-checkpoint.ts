import { mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spaceGitCheckpointRef } from '@gitspace/protocol/space-checkpoint';

export interface GitIntermediateCheckpoint {
  checkpointRef: string;
  headCommit: string;
  branch: string;
  indexCommit: string;
  trackedWorktreeCommit: string;
  worktreeCommit: string;
  indexTree: string;
  worktreeTree: string;
}

export class GitCheckpointError extends Error {
  constructor(readonly operation: string, message: string) {
    super(`${operation}: ${message}`);
    this.name = 'GitCheckpointError';
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

async function runGit(repositoryPath: string, args: string[], options: { env?: Record<string, string>; input?: string } = {}): Promise<CommandResult> {
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
  if (exitCode !== 0) throw new GitCheckpointError(`git ${args[0] ?? ''}`.trim(), stderr.trim() || `exited with ${exitCode}`);
  return { stdout: stdout.trim(), stderr: stderr.trim() };
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

async function commitTree(repositoryPath: string, tree: string, parent: string, message: string): Promise<string> {
  const committed = await runGit(repositoryPath, ['commit-tree', tree, '-p', parent], {
    env: checkpointEnvironment(),
    input: `${message}\n`,
  });
  return committed.stdout;
}

export async function createGitIntermediateCheckpoint(input: {
  repositoryPath: string;
  spaceId: string;
  revision: number;
  portableUntrackedPaths?: string[];
}): Promise<GitIntermediateCheckpoint> {
  const branch = (await runGit(input.repositoryPath, ['branch', '--show-current'])).stdout;
  if (!branch) throw new GitCheckpointError('branch', 'detached HEAD checkpoints are not supported');
  const checkpointRef = spaceGitCheckpointRef(input.spaceId, input.revision);
  const headCommit = (await runGit(input.repositoryPath, ['rev-parse', 'HEAD'])).stdout;
  const indexTree = (await runGit(input.repositoryPath, ['write-tree'])).stdout;
  const indexCommit = await commitTree(input.repositoryPath, indexTree, headCommit, `GitSpace index checkpoint ${input.revision}`);
  const temporary = await mkdtemp(join(tmpdir(), 'gitspace-checkpoint-'));
  const temporaryIndex = join(temporary, 'index');
  const indexEnvironment = { GIT_INDEX_FILE: temporaryIndex };
  try {
    await runGit(input.repositoryPath, ['read-tree', indexTree], { env: indexEnvironment });
    await runGit(input.repositoryPath, ['add', '-u', '--', '.'], { env: indexEnvironment });
    const trackedWorktreeTree = (await runGit(input.repositoryPath, ['write-tree'], { env: indexEnvironment })).stdout;
    const trackedWorktreeCommit = await commitTree(
      input.repositoryPath,
      trackedWorktreeTree,
      indexCommit,
      `GitSpace tracked worktree checkpoint ${input.revision}`,
    );
    const discovered = input.portableUntrackedPaths ?? (await runGit(input.repositoryPath, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
    const portablePaths = [...new Set(discovered.map((path) => portablePath(input.repositoryPath, path)))].sort();
    for (const path of portablePaths) {
      const ignored = Bun.spawn(['git', 'check-ignore', '-q', '--', path], { cwd: input.repositoryPath, stdout: 'ignore', stderr: 'ignore' });
      if (await ignored.exited === 0) throw new GitCheckpointError('portable path', `${path} is ignored and may contain machine-local or secret state`);
    }
    if (portablePaths.length > 0) await runGit(input.repositoryPath, ['add', '--', ...portablePaths], { env: indexEnvironment });
    const worktreeTree = (await runGit(input.repositoryPath, ['write-tree'], { env: indexEnvironment })).stdout;
    const worktreeCommit = await commitTree(
      input.repositoryPath,
      worktreeTree,
      trackedWorktreeCommit,
      `GitSpace portable worktree checkpoint ${input.revision}`,
    );
    await runGit(input.repositoryPath, ['update-ref', checkpointRef, worktreeCommit]);
    return { checkpointRef, headCommit, branch, indexCommit, trackedWorktreeCommit, worktreeCommit, indexTree, worktreeTree };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function restoreGitIntermediateCheckpoint(input: {
  repositoryPath: string;
  checkpoint: Pick<GitIntermediateCheckpoint, 'headCommit' | 'indexCommit' | 'worktreeCommit'>;
  branch: string;
}): Promise<void> {
  if (!/^[A-Za-z0-9._/-]+$/u.test(input.branch) || input.branch.startsWith('/') || input.branch.includes('..')) {
    throw new GitCheckpointError('restore branch', `invalid branch ${input.branch}`);
  }
  const branchRef = `refs/heads/${input.branch}`;
  await runGit(input.repositoryPath, ['symbolic-ref', 'HEAD', branchRef]);
  await runGit(input.repositoryPath, ['update-ref', branchRef, input.checkpoint.headCommit]);
  await runGit(input.repositoryPath, ['reset', '--hard', input.checkpoint.headCommit]);
  await runGit(input.repositoryPath, ['read-tree', '--reset', '-u', input.checkpoint.worktreeCommit]);
  await runGit(input.repositoryPath, ['read-tree', input.checkpoint.indexCommit]);
}
