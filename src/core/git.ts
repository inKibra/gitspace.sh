/**
 * Git and worktree operations
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { SpacesError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import { escapeShellArg } from '../utils/shell-escape.js';
import type { WorktreeInfo } from '../types/workspace.js';
import type { ReviewChangedFile } from '../types/review.js';

const execAsync = promisify(exec);

const BASE_REF_CACHE_TTL_MS = 60_000;
const BASE_REF_CACHE_MAX_ENTRIES = 256;
const comparableBaseRefCache = new Map<string, { baseRef: string; cachedAt: number }>();
const comparableBaseRefInflight = new Map<string, Promise<string>>();

function isOwnerRepoShorthand(repository: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository);
}

function resolveCloneSource(repository: string): string {
  if (isOwnerRepoShorthand(repository)) {
    return `https://github.com/${repository}.git`;
  }
  return repository;
}

/**
 * Clone a repository from either a remote URL or owner/repo shorthand.
 */
export async function cloneRepository(repository: string, destination: string): Promise<void> {
  const source = resolveCloneSource(repository.trim());

  try {
    await execAsync(
      `git clone ${escapeShellArg(source)} ${escapeShellArg(destination)}`
    );
  } catch (error) {
    throw new SpacesError(
      `Failed to clone repository ${repository}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }
}

function comparableBaseRefKey(workspacePath: string, baseBranch: string): string {
  return `${workspacePath}::${baseBranch}`;
}

function pruneComparableBaseRefCache(now: number): void {
  for (const [key, value] of comparableBaseRefCache.entries()) {
    if (now - value.cachedAt >= BASE_REF_CACHE_TTL_MS) {
      comparableBaseRefCache.delete(key);
    }
  }

  const overflow = comparableBaseRefCache.size - BASE_REF_CACHE_MAX_ENTRIES;
  if (overflow <= 0) {
    return;
  }

  const sortedByAge = [...comparableBaseRefCache.entries()].sort(
    (a, b) => a[1].cachedAt - b[1].cachedAt
  );
  for (let index = 0; index < overflow; index++) {
    const entry = sortedByAge[index];
    if (!entry) {
      break;
    }
    comparableBaseRefCache.delete(entry[0]);
  }
}

/**
 * Get the default branch of a repository
 */
export async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync(
      'git symbolic-ref refs/remotes/origin/HEAD',
      { cwd: repoPath }
    );

    // Extract branch name from refs/remotes/origin/main -> main
    const branch = stdout.trim().replace('refs/remotes/origin/', '');
    return branch;
  } catch (error) {
    // Fallback to 'main' if we can't determine
    logger.debug(`Could not determine default branch, using 'main': ${error}`);
    return 'main';
  }
}

/**
 * Check if a branch exists on remote
 */
export async function checkRemoteBranch(
  repoPath: string,
  branchName: string
): Promise<boolean> {
  try {
    await execAsync(
      `git ls-remote --exit-code --heads origin ${escapeShellArg(branchName)}`,
      { cwd: repoPath }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * List all remote branches from origin
 * @param repoPath Path to the git repository
 * @returns Array of branch names (without origin/ prefix)
 */
export async function listRemoteBranches(repoPath: string): Promise<string[]> {
  try {
    // Fetch latest from remote
    await execAsync('git fetch --all --prune', { cwd: repoPath });

    const { stdout } = await execAsync(
      'git ls-remote --heads origin',
      { cwd: repoPath }
    );

    // Parse output: "hash\trefs/heads/branch-name"
    const branches = stdout
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        // Extract branch name from "hash\trefs/heads/branch-name"
        const match = line.match(/refs\/heads\/(.+)$/);
        return match ? match[1] : null;
      })
      .filter((branch): branch is string => branch !== null);

    return branches;
  } catch (error) {
    throw new SpacesError(
      `Failed to list remote branches: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }
}

/**
 * Check if a branch exists locally
 */
export async function checkLocalBranch(
  repoPath: string,
  branchName: string
): Promise<boolean> {
  try {
    await execAsync(
      `git show-ref --verify --quiet ${escapeShellArg(`refs/heads/${branchName}`)}`,
      { cwd: repoPath }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Options for creating a worktree
 */
export interface CreateWorktreeOptions {
  /** Whether the branch exists on the remote */
  existsRemotely?: boolean;
  /** Callback to report progress (for TUI loading indicator) */
  onProgress?: (message: string) => void;
}

/**
 * Create a git worktree
 */
export async function createWorktree(
  repoPath: string,
  workspacePath: string,
  branchName: string,
  baseBranch: string,
  existsRemotelyOrOptions?: boolean | CreateWorktreeOptions
): Promise<void> {
  // Handle both old signature (boolean) and new signature (options object)
  const options: CreateWorktreeOptions = typeof existsRemotelyOrOptions === 'boolean'
    ? { existsRemotely: existsRemotelyOrOptions }
    : existsRemotelyOrOptions ?? {};
  const { existsRemotely, onProgress } = options;

  try {
    // Check if worktree path already exists
    if (existsSync(workspacePath)) {
      throw new SpacesError(
        `Worktree path already exists: ${workspacePath}`,
        'USER_ERROR',
        1
      );
    }

    // Fetch latest changes
    onProgress?.('Fetching latest changes...');
    logger.debug('Fetching latest changes...');
    await execAsync('git fetch --all --prune', { cwd: repoPath });

    // Pull latest base branch
    onProgress?.(`Updating ${baseBranch}...`);
    try {
      await execAsync(`git pull --ff-only origin ${escapeShellArg(baseBranch)}`, {
        cwd: repoPath,
      });
    } catch (error) {
      logger.debug(`Could not fast-forward ${baseBranch}: ${error}`);
    }

    // Determine how to create the worktree
    if (existsRemotely) {
      // Branch exists on remote, create from remote branch
      onProgress?.(`Creating worktree from ${branchName}...`);
      logger.debug(`Creating worktree from remote branch: ${branchName}`);
      await execAsync(
        `git worktree add ${escapeShellArg(workspacePath)} -b ${escapeShellArg(branchName)} ${escapeShellArg(`origin/${branchName}`)}`,
        { cwd: repoPath }
      );
    } else if (await checkLocalBranch(repoPath, branchName)) {
      // Branch exists locally, attach worktree to it
      onProgress?.(`Creating worktree from ${branchName}...`);
      logger.debug(`Creating worktree from local branch: ${branchName}`);
      await execAsync(`git worktree add ${escapeShellArg(workspacePath)} ${escapeShellArg(branchName)}`, {
        cwd: repoPath,
      });
    } else {
      // Branch doesn't exist, create new from base
      // Use --no-track to avoid setting upstream to baseBranch (user should push -u to set correct upstream)
      onProgress?.(`Creating new branch ${branchName}...`);
      logger.debug(`Creating new branch from ${baseBranch}: ${branchName}`);
      await execAsync(
        `git worktree add -b ${escapeShellArg(branchName)} ${escapeShellArg(workspacePath)} ${escapeShellArg(`origin/${baseBranch}`)} --no-track`,
        { cwd: repoPath }
      );
    }
  } catch (error) {
    if (error instanceof SpacesError) {
      throw error;
    }

    throw new SpacesError(
      `Failed to create worktree: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }
}

/**
 * Create a worktree from a remote ref (e.g. origin/feature/foo).
 * Fetches the remote then runs: git worktree add -b <localBranch> <path> <remoteRef>
 */
export async function createWorktreeFromRemoteRef(
  repoPath: string,
  workspacePath: string,
  localBranchName: string,
  remoteRef: string
): Promise<void> {
  const separator = remoteRef.indexOf('/');
  const remote = separator > 0 ? remoteRef.slice(0, separator) : '';
  const branch = separator > 0 ? remoteRef.slice(separator + 1) : '';
  if (!remote || !branch) {
    throw new SpacesError(
      `Invalid remote ref: ${remoteRef}. Use form remote/branch (e.g. origin/feature/foo).`,
      'USER_ERROR',
      1
    );
  }
  try {
    if (existsSync(workspacePath)) {
      throw new SpacesError(`Worktree path already exists: ${workspacePath}`, 'USER_ERROR', 1);
    }
    await execAsync(`git fetch ${escapeShellArg(remote)}`, { cwd: repoPath });
    await execAsync(
      `git worktree add -b ${escapeShellArg(localBranchName)} ${escapeShellArg(workspacePath)} ${escapeShellArg(remoteRef)}`,
      { cwd: repoPath }
    );
  } catch (error) {
    if (error instanceof SpacesError) {
      throw error;
    }
    throw new SpacesError(
      `Failed to create worktree from ${remoteRef}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }
}

/**
 * Remove a git worktree
 */
export async function removeWorktree(
  repoPath: string,
  workspacePath: string,
  force: boolean = false
): Promise<void> {
  try {
    const forceFlag = force ? '--force' : '';
    await execAsync(`git worktree remove ${escapeShellArg(workspacePath)} ${forceFlag}`, {
      cwd: repoPath,
    });
  } catch (error) {
    throw new SpacesError(
      `Failed to remove worktree: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }
}

/**
 * Get information about a worktree
 */
export async function getWorktreeInfo(workspacePath: string): Promise<WorktreeInfo | null> {
  try {
    if (!existsSync(workspacePath)) {
      return null;
    }

    // Get current branch
    const { stdout: branchOutput } = await execAsync(
      'git rev-parse --abbrev-ref HEAD',
      { cwd: workspacePath }
    );
    const branch = branchOutput.trim();

    // Get commits ahead/behind
    let ahead = 0;
    let behind = 0;
    try {
      const { stdout: revListOutput } = await execAsync(
        `git rev-list --left-right --count ${escapeShellArg(`HEAD...origin/${branch}`)}`,
        { cwd: workspacePath }
      );
      const [aheadStr, behindStr] = revListOutput.trim().split('\t');
      ahead = parseInt(aheadStr, 10) || 0;
      behind = parseInt(behindStr, 10) || 0;
    } catch {
      // Branch may not have remote tracking
      logger.debug(`Could not get ahead/behind for ${branch}`);
    }

    // Get uncommitted changes count
    const { stdout: statusOutput } = await execAsync('git status --porcelain', {
      cwd: workspacePath,
    });
    const uncommittedChanges = statusOutput
      .trim()
      .split('\n')
      .filter((line) => line.length > 0).length;

    // Get last commit info
    const { stdout: lastCommitMsg } = await execAsync(
      'git log -1 --pretty=format:"%s"',
      { cwd: workspacePath }
    );
    const { stdout: lastCommitDate } = await execAsync(
      'git log -1 --pretty=format:"%aI"',
      { cwd: workspacePath }
    );

    const name = workspacePath.split('/').pop() || '';

    return {
      name,
      path: workspacePath,
      branch,
      ahead,
      behind,
      uncommittedChanges,
      lastCommit: lastCommitMsg.trim() || 'No commits',
      lastCommitDate: lastCommitDate ? new Date(lastCommitDate) : new Date(),
    };
  } catch (error) {
    logger.debug(`Failed to get worktree info for ${workspacePath}: ${error}`);
    return null;
  }
}

/**
 * Delete a local branch
 */
export async function deleteLocalBranch(
  repoPath: string,
  branchName: string,
  force: boolean = false
): Promise<void> {
  try {
    const forceFlag = force ? '-D' : '-d';
    await execAsync(`git branch ${forceFlag} ${escapeShellArg(branchName)}`, {
      cwd: repoPath,
    });
  } catch (error) {
    throw new SpacesError(
      `Failed to delete branch ${branchName}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }
}

/**
 * Get the unified diff between a workspace branch and its base branch.
 *
 * Uses three-dot diff (`base...HEAD`) so we only see changes introduced by
 * the workspace branch, not diverging changes on the base since the fork.
 *
 * @param workspacePath  Path to the git worktree
 * @param baseBranch     The branch to diff against (e.g. 'main')
 * @returns Unified diff string (empty string if no changes)
 */
export async function getWorkspaceDiff(
  workspacePath: string,
  baseBranch: string
): Promise<{ diff: string; baseBranch: string; headBranch: string }> {
  try {
    // Get the current HEAD branch name
    const { stdout: headOutput } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: workspacePath,
    });
    const headBranch = headOutput.trim();

    const mergeBase = await resolveComparableBaseRef(workspacePath, baseBranch);

    // Three-dot diff: changes on HEAD that are not in the selected base ref
    const { stdout: diffOutput } = await execAsync(
      `git diff ${escapeShellArg(mergeBase)}...HEAD`,
      { cwd: workspacePath, maxBuffer: 50 * 1024 * 1024 } // 50MB max
    );

    return {
      diff: diffOutput,
      baseBranch,
      headBranch,
    };
  } catch (error) {
    throw new SpacesError(
      `Failed to get workspace diff: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }
}

/**
 * List changed files in a workspace branch vs base branch.
 */
export async function getWorkspaceChangedFiles(
  workspacePath: string,
  baseBranch: string
): Promise<{ files: ReviewChangedFile[]; baseBranch: string; headBranch: string }> {
  try {
    const { stdout: headOutput } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: workspacePath,
    });
    const headBranch = headOutput.trim();

    const baseRef = await resolveComparableBaseRef(workspacePath, baseBranch);
    const { stdout } = await execAsync(
      `git diff --name-status -z --find-renames -M ${escapeShellArg(baseRef)}...HEAD`,
      { cwd: workspacePath, maxBuffer: 10 * 1024 * 1024 }
    );

    return {
      files: parseChangedFilesFromNameStatusZ(stdout),
      baseBranch,
      headBranch,
    };
  } catch (error) {
    throw new SpacesError(
      `Failed to list changed files: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }
}

/**
 * Get diff for a single file path in workspace vs base branch.
 */
export async function getWorkspaceFileDiff(
  workspacePath: string,
  baseBranch: string,
  filePath: string,
  prevFilePath?: string
): Promise<{ diff: string; baseBranch: string; headBranch: string }> {
  try {
    const { stdout: headOutput } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: workspacePath,
    });
    const headBranch = headOutput.trim();

    const baseRef = await resolveComparableBaseRef(workspacePath, baseBranch);
    const pathSpec = prevFilePath
      ? `${escapeShellArg(prevFilePath)} ${escapeShellArg(filePath)}`
      : escapeShellArg(filePath);

    const { stdout } = await execAsync(
      `git diff --patch --no-color --find-renames -M ${escapeShellArg(baseRef)}...HEAD -- ${pathSpec}`,
      { cwd: workspacePath, maxBuffer: 20 * 1024 * 1024 }
    );

    return {
      diff: stdout,
      baseBranch,
      headBranch,
    };
  } catch (error) {
    throw new SpacesError(
      `Failed to get file diff: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }
}

/**
 * Read a file's old/new versions for the workspace diff base.
 *
 * Uses merge-base(<base-ref>, HEAD) for the old side so content aligns with
 * three-dot diff semantics. For renames, pass prevFilePath for the old side.
 */
export async function getWorkspaceFileVersions(
  workspacePath: string,
  baseBranch: string,
  filePath: string,
  prevFilePath?: string
): Promise<{ oldContents: string | null; newContents: string | null }> {
  try {
    const baseRef = await resolveComparableBaseRef(workspacePath, baseBranch);
    const mergeBaseCommit = await resolveMergeBaseCommit(workspacePath, baseRef);

    const oldPath = prevFilePath ?? filePath;
    const [oldContents, newContents] = await Promise.all([
      readFileAtRevision(workspacePath, mergeBaseCommit, oldPath),
      readFileAtRevision(workspacePath, 'HEAD', filePath),
    ]);

    return { oldContents, newContents };
  } catch (error) {
    throw new SpacesError(
      `Failed to read workspace file versions: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }
}

/**
 * Read a file context range (or the full file when range omitted) on both
 * old/base and new/head sides for on-demand diff expansion.
 */
export async function getWorkspaceFileContextRange(
  workspacePath: string,
  baseBranch: string,
  filePath: string,
  prevFilePath?: string,
  range?: {
    oldStart?: number;
    oldEnd?: number;
    newStart?: number;
    newEnd?: number;
  }
): Promise<{
  oldStart: number;
  oldLines: string[];
  oldTotal: number;
  newStart: number;
  newLines: string[];
  newTotal: number;
}> {
  try {
    const baseRef = await resolveComparableBaseRef(workspacePath, baseBranch);
    const mergeBaseCommit = await resolveMergeBaseCommit(workspacePath, baseRef);

    const oldPath = prevFilePath ?? filePath;
    const [oldContents, newContents] = await Promise.all([
      readFileAtRevision(workspacePath, mergeBaseCommit, oldPath),
      readFileAtRevision(workspacePath, 'HEAD', filePath),
    ]);

    const oldAllLines = splitFileIntoLines(oldContents ?? '');
    const newAllLines = splitFileIntoLines(newContents ?? '');

    const oldTotal = oldAllLines.length;
    const newTotal = newAllLines.length;

    const [oldStart, oldEnd] = normalizeRange(oldTotal, range?.oldStart, range?.oldEnd);
    const [newStart, newEnd] = normalizeRange(newTotal, range?.newStart, range?.newEnd);

    const oldLines = oldTotal === 0 ? [] : oldAllLines.slice(oldStart - 1, oldEnd);
    const newLines = newTotal === 0 ? [] : newAllLines.slice(newStart - 1, newEnd);

    return {
      oldStart,
      oldLines,
      oldTotal,
      newStart,
      newLines,
      newTotal,
    };
  } catch (error) {
    throw new SpacesError(
      `Failed to read file context range: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }
}

async function resolveComparableBaseRef(
  workspacePath: string,
  baseBranch: string
): Promise<string> {
  const now = Date.now();
  pruneComparableBaseRefCache(now);

  const cacheKey = comparableBaseRefKey(workspacePath, baseBranch);
  const cached = comparableBaseRefCache.get(cacheKey);
  if (cached && now - cached.cachedAt < BASE_REF_CACHE_TTL_MS) {
    return cached.baseRef;
  }

  const inFlight = comparableBaseRefInflight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const resolvePromise = (async () => {
    // Best effort fetch. Keep short timeout to avoid hanging review requests.
    try {
      await execAsync(`git fetch origin ${escapeShellArg(baseBranch)} --quiet`, {
        cwd: workspacePath,
        timeout: 8000,
      });
    } catch {
      logger.debug(`Could not fetch origin/${baseBranch}, using local refs`);
    }

    const candidates = [`origin/${baseBranch}`, baseBranch];
    for (const candidate of candidates) {
      try {
        await execAsync(`git rev-parse --verify ${escapeShellArg(candidate)}`, {
          cwd: workspacePath,
          timeout: 5000,
        });

        comparableBaseRefCache.set(cacheKey, {
          baseRef: candidate,
          cachedAt: Date.now(),
        });
        pruneComparableBaseRefCache(Date.now());
        return candidate;
      } catch {
        // Try next candidate
      }
    }

    throw new Error(
      `Cannot resolve base ref for "${baseBranch}". Fetch the branch or update project base branch config.`
    );
  })();

  comparableBaseRefInflight.set(cacheKey, resolvePromise);
  try {
    return await resolvePromise;
  } finally {
    comparableBaseRefInflight.delete(cacheKey);
  }
}

async function resolveMergeBaseCommit(
  workspacePath: string,
  baseRef: string
): Promise<string> {
  const { stdout } = await execAsync(
    `git merge-base ${escapeShellArg(baseRef)} HEAD`,
    { cwd: workspacePath, timeout: 5000 }
  );

  const mergeBaseCommit = stdout.trim();
  if (!mergeBaseCommit) {
    throw new Error(`Could not determine merge base for ${baseRef} and HEAD`);
  }

  return mergeBaseCommit;
}

async function readFileAtRevision(
  workspacePath: string,
  revision: string,
  filePath: string
): Promise<string | null> {
  const spec = `${revision}:${filePath}`;

  try {
    const { stdout } = await execAsync(`git show ${escapeShellArg(spec)}`, {
      cwd: workspacePath,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const err = error as { message?: string; stderr?: string };
    const message = `${err.message ?? ''}\n${err.stderr ?? ''}`;

    // Missing file at ref is expected for new/deleted/renamed files.
    if (
      /exists on disk, but not in/i.test(message) ||
      /path .* does not exist in/i.test(message) ||
      /path .* not in/i.test(message) ||
      /invalid object name/i.test(message)
    ) {
      return null;
    }

    throw error;
  }
}

function normalizeRange(total: number, start?: number, end?: number): [number, number] {
  if (total <= 0) {
    return [1, 0];
  }

  const normalizedStart =
    typeof start === 'number' && Number.isFinite(start) ? clamp(Math.floor(start), 1, total) : 1;
  const normalizedEnd =
    typeof end === 'number' && Number.isFinite(end)
      ? clamp(Math.floor(end), normalizedStart, total)
      : total;

  return [normalizedStart, normalizedEnd];
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function splitFileIntoLines(contents: string): string[] {
  if (contents.length === 0) {
    return [];
  }

  const lines = contents.match(/[^\n]*\n|[^\n]+$/g);
  return lines ?? [];
}

function parseChangedFilesFromNameStatusZ(stdout: string): ReviewChangedFile[] {
  if (!stdout) {
    return [];
  }

  const tokens = stdout.split('\0').filter((token) => token.length > 0);
  const files: ReviewChangedFile[] = [];

  let index = 0;
  while (index < tokens.length) {
    const statusToken = tokens[index++];
    if (!statusToken) {
      continue;
    }

    const statusCode = statusToken[0];
    if (statusCode === 'R' || statusCode === 'C') {
      const prev = tokens[index++];
      const next = tokens[index++];
      if (!prev || !next) {
        continue;
      }
      files.push({
        filePath: next,
        prevFilePath: prev,
        changeType: statusCode === 'R' ? 'renamed' : 'copied',
      });
      continue;
    }

    const path = tokens[index++];
    if (!path) {
      continue;
    }

    const changeType: ReviewChangedFile['changeType'] =
      statusCode === 'A'
        ? 'new'
        : statusCode === 'D'
          ? 'deleted'
          : 'modified';

    files.push({ filePath: path, changeType });
  }

  return files;
}

/**
 * List all worktrees in a repository
 */
export async function listWorktrees(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('git worktree list --porcelain', {
      cwd: repoPath,
    });

    const worktrees: string[] = [];
    const lines = stdout.trim().split('\n');

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        const path = line.replace('worktree ', '');
        worktrees.push(path);
      }
    }

    return worktrees;
  } catch (error) {
    throw new SpacesError(
      `Failed to list worktrees: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }
}
