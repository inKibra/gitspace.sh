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

const execAsync = promisify(exec);

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
 * Create a git worktree
 */
export async function createWorktree(
  repoPath: string,
  workspacePath: string,
  branchName: string,
  baseBranch: string,
  existsRemotely?: boolean
): Promise<void> {
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
    logger.debug('Fetching latest changes...');
    await execAsync('git fetch --all --prune', { cwd: repoPath });

    // Pull latest base branch
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
      logger.debug(`Creating worktree from remote branch: ${branchName}`);
      await execAsync(
        `git worktree add ${escapeShellArg(workspacePath)} -b ${escapeShellArg(branchName)} ${escapeShellArg(`origin/${branchName}`)}`,
        { cwd: repoPath }
      );
    } else if (await checkLocalBranch(repoPath, branchName)) {
      // Branch exists locally, attach worktree to it
      logger.debug(`Creating worktree from local branch: ${branchName}`);
      await execAsync(`git worktree add ${escapeShellArg(workspacePath)} ${escapeShellArg(branchName)}`, {
        cwd: repoPath,
      });
    } else {
      // Branch doesn't exist, create new from base
      // Use --no-track to avoid setting upstream to baseBranch (user should push -u to set correct upstream)
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
