/**
 * Core workspace and project deletion operations
 * These functions contain the shared logic used by CLI, TUI, and remote handlers
 */

import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  readProjectConfig,
  getProjectWorkspacesDir,
  getProjectBaseDir,
  getProjectDir,
  getScriptsPhaseDir,
  readGlobalConfig,
  updateGlobalConfig,
} from './config.js';
import {
  removeWorktree,
  deleteLocalBranch,
  getWorktreeInfo,
} from './git.js';
import { runScriptsInTerminal } from '../utils/run-scripts.js';
import { logger } from '../utils/logger.js';
import {
  listSessions,
  killSession,
  isServerRunning,
} from '../lib/tmux-lite/cli.js';

/**
 * Options for workspace deletion
 */
export interface DeleteWorkspaceOptions {
  /**
   * Run in non-interactive mode (for TUI/daemon/remote contexts).
   * When true, remove scripts run with stdin closed.
   */
  nonInteractive?: boolean;
  /** Keep the local branch after removing worktree */
  keepBranch?: boolean;
}

/**
 * Result of workspace deletion
 */
export interface DeleteWorkspaceResult {
  success: boolean;
  workspaceName: string;
  branch?: string;
  branchDeleted: boolean;
  sessionsKilled: number;
  error?: string;
}

/**
 * Core workspace deletion logic
 * Used by CLI, TUI, and remote session handlers
 *
 * @param projectName - Name of the project containing the workspace
 * @param workspaceName - Name of the workspace to delete
 * @param options - Deletion options
 */
export async function deleteWorkspaceCore(
  projectName: string,
  workspaceName: string,
  options: DeleteWorkspaceOptions = {}
): Promise<DeleteWorkspaceResult> {
  const workspacesDir = getProjectWorkspacesDir(projectName);
  const baseDir = getProjectBaseDir(projectName);
  const workspacePath = join(workspacesDir, workspaceName);

  const result: DeleteWorkspaceResult = {
    success: false,
    workspaceName,
    branchDeleted: false,
    sessionsKilled: 0,
  };

  // Validate workspace exists before attempting deletion
  if (!existsSync(workspacePath)) {
    result.error = `Workspace "${workspaceName}" does not exist`;
    return result;
  }

  // Get workspace info before deletion
  const info = await getWorktreeInfo(workspacePath);
  if (info) {
    result.branch = info.branch;
  }

  // Kill any sessions running in this workspace
  try {
    if (await isServerRunning()) {
      const sessions = await listSessions();
      const workspaceSessions = sessions.filter(s => s.cwd === workspacePath);
      for (const session of workspaceSessions) {
        try {
          await killSession(session.id);
          result.sessionsKilled++;
          logger.debug(`Killed session ${session.name} (${session.id})`);
        } catch (e) {
          logger.debug(`Failed to kill session ${session.id}: ${e}`);
        }
      }
    }
  } catch (e) {
    logger.debug(`Error checking/killing sessions: ${e}`);
  }

  // Run remove scripts (cleanup before deletion)
  try {
    const projectConfig = readProjectConfig(projectName);
    const removeScriptsDir = getScriptsPhaseDir(projectName, 'remove');
    await runScriptsInTerminal(
      removeScriptsDir,
      workspacePath,
      workspaceName,
      projectConfig.repository,
      { nonInteractive: options.nonInteractive }
    );
  } catch (e) {
    // Scripts are best-effort, log but continue
    logger.debug(`Remove scripts failed for ${workspaceName}: ${e}`);
  }

  // Remove worktree
  try {
    await removeWorktree(baseDir, workspacePath, true);
  } catch (e) {
    result.error = e instanceof Error ? e.message : 'Failed to remove worktree';
    return result;
  }

  // Try to delete the local branch
  if (!options.keepBranch && info?.branch) {
    try {
      await deleteLocalBranch(baseDir, info.branch, true);
      result.branchDeleted = true;
    } catch (e) {
      // Branch deletion is best-effort
      logger.debug(`Could not delete branch ${info.branch}: ${e}`);
    }
  }

  result.success = true;
  return result;
}

/**
 * Options for project deletion
 */
export interface DeleteProjectOptions {
  /**
   * Run in non-interactive mode (for TUI/daemon/remote contexts).
   * When true, remove scripts run with stdin closed.
   */
  nonInteractive?: boolean;
}

/**
 * Result of project deletion
 */
export interface DeleteProjectResult {
  success: boolean;
  projectName: string;
  workspacesDeleted: number;
  sessionsKilled: number;
  wasCurrentProject: boolean;
  errors: string[];
}

/**
 * Core project deletion logic
 * Tears down sessions, runs remove scripts for all workspaces, then deletes project
 *
 * @param projectName - Name of the project to delete
 * @param options - Deletion options
 */
export async function deleteProjectCore(
  projectName: string,
  options: DeleteProjectOptions = {}
): Promise<DeleteProjectResult> {
  const projectDir = getProjectDir(projectName);
  const workspacesDir = getProjectWorkspacesDir(projectName);

  const result: DeleteProjectResult = {
    success: false,
    projectName,
    workspacesDeleted: 0,
    sessionsKilled: 0,
    wasCurrentProject: false,
    errors: [],
  };

  // Validate project directory exists before attempting deletion
  if (!existsSync(projectDir)) {
    result.errors.push(`Project "${projectName}" does not exist`);
    return result;
  }

  // Get list of workspaces
  let workspaceNames: string[] = [];
  if (existsSync(workspacesDir)) {
    try {
      workspaceNames = readdirSync(workspacesDir);
    } catch (e) {
      logger.debug(`Could not read workspaces dir: ${e}`);
    }
  }

  // Delete each workspace (this handles session teardown and remove scripts)
  for (const workspaceName of workspaceNames) {
    try {
      const wsResult = await deleteWorkspaceCore(projectName, workspaceName, {
        nonInteractive: options.nonInteractive,
        keepBranch: true, // Don't try to delete branches, we're removing the whole repo
      });
      if (wsResult.success) {
        result.workspacesDeleted++;
        result.sessionsKilled += wsResult.sessionsKilled;
      } else if (wsResult.error) {
        result.errors.push(`${workspaceName}: ${wsResult.error}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${workspaceName}: ${msg}`);
      logger.debug(`Failed to delete workspace ${workspaceName}: ${e}`);
    }
  }

  // Remove entire project directory
  try {
    rmSync(projectDir, { recursive: true, force: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to remove project directory';
    result.errors.push(msg);
    return result;
  }

  // Update global config if this was the current project
  const globalConfig = readGlobalConfig();
  if (globalConfig.currentProject === projectName) {
    updateGlobalConfig({ currentProject: null });
    result.wasCurrentProject = true;
  }

  result.success = true;
  return result;
}
