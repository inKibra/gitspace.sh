/**
 * Core workspace and project deletion operations
 * These functions contain the shared logic used by CLI, TUI, and remote handlers
 */

import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  readProjectConfig,
  updateProjectConfig,
  getProjectWorkspacesDir,
  getProjectBaseDir,
  getProjectDir,
  readGlobalConfig,
  updateGlobalConfig,
} from './config.js';
import {
  removeWorktree,
  deleteLocalBranch,
  getWorktreeInfo,
} from './git.js';
import { runScriptsInTerminal } from '../utils/run-scripts.js';
import { getProjectSecrets } from '../utils/secrets.js';
import { shouldSkipSecretDependentScripts } from './secret-runtime.js';
import { logger } from '../utils/logger.js';
import {
  listSessions,
  terminateSession,
  isServerRunning,
} from '../lib/tmux-lite/cli.js';
import {
  deleteReplaysForProject,
  deleteReplaysForWorkspace,
} from '../lib/tmux-lite/replay/store.js';

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
  /**
   * Callback to receive ANSI output from remove scripts (for TUI/Web terminal display).
   * Called with raw output from stdout/stderr.
   */
  onScriptOutput?: (data: Buffer) => void;
  /**
   * Callback to report progress on deletion steps (for TUI loading indicator).
   * Called with a human-readable message for each step.
   */
  onProgress?: (message: string) => void;
  /**
   * Controls remove-script behavior:
   * - enforce: fail deletion when remove scripts fail
   * - best-effort: log remove script failures and continue deletion
   * - skip: do not run remove scripts
   */
  removeScriptPolicy?: 'enforce' | 'best-effort' | 'skip';
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
  replaysDeleted?: number;
  errorCode?: 'WORKSPACE_NOT_FOUND' | 'REMOVE_SCRIPT_FAILED' | 'WORKTREE_REMOVE_FAILED';
  error?: string;
  removeScriptError?: string;
  /** True when the workspace had a goal that was relocated to the
   *  project-level archived store before the worktree was destroyed. */
  goalArchived?: boolean;
  /** Id of the archived goal (present when goalArchived is true). Still
   *  resolvable via getGoalRecord and still linked in its chain. */
  goalId?: string;
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
    replaysDeleted: 0,
  };

  // Validate workspace exists before attempting deletion
  if (!existsSync(workspacePath)) {
    result.errorCode = 'WORKSPACE_NOT_FOUND';
    result.error = `Workspace "${workspaceName}" does not exist`;
    return result;
  }

  const removeScriptPolicy = options.removeScriptPolicy ?? 'enforce';
  let projectConfig: ReturnType<typeof readProjectConfig> | null = null;
  try {
    projectConfig = readProjectConfig(projectName);
  } catch (error) {
    logger.debug(
      `Failed to read project config for ${projectName} while preparing delete: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const skipSecretScripts = shouldSkipSecretDependentScripts(
    projectName,
    projectConfig?.bundleSecretKeys
  );
  const effectiveRemoveScriptPolicy = skipSecretScripts ? 'skip' : removeScriptPolicy;

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
      if (workspaceSessions.length > 0) {
        options.onProgress?.(`Killing ${workspaceSessions.length} session(s)...`);
      }
      for (const session of workspaceSessions) {
        try {
          await terminateSession(session.id);
          result.sessionsKilled++;
          logger.debug(`Terminated session ${session.name} (${session.id})`);
        } catch (e) {
          logger.debug(`Failed to terminate session ${session.id}: ${e}`);
        }
      }
    }
  } catch (e) {
    logger.debug(`Error checking/killing sessions: ${e}`);
  }

  // Run remove scripts (cleanup before deletion)
  if (effectiveRemoveScriptPolicy !== 'skip') {
    try {
      const config = projectConfig ?? readProjectConfig(projectName);
      const removeScriptsDir = join(workspacePath, '.gitspace', 'scripts', 'remove');
      const bundleSecrets = config.bundleSecretKeys && config.bundleSecretKeys.length > 0
        ? await getProjectSecrets(projectName, config.bundleSecretKeys)
        : undefined;

      options.onProgress?.('Running cleanup scripts...');
      await runScriptsInTerminal(
        removeScriptsDir,
        workspacePath,
        workspaceName,
        config.repository,
        {
          bundleValues: config.bundleValues,
          bundleSecrets,
          nonInteractive: options.nonInteractive,
          onOutput: options.onScriptOutput,
        }
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (effectiveRemoveScriptPolicy === 'enforce') {
        result.errorCode = 'REMOVE_SCRIPT_FAILED';
        result.removeScriptError = message;
        result.error = `Remove scripts failed: ${message}`;
        return result;
      }

      logger.debug(`Remove scripts failed for ${workspaceName}: ${e}`);
    }
  } else {
    if (skipSecretScripts) {
      options.onProgress?.('Skipping cleanup scripts (secret loading disabled)...');
    } else {
      options.onProgress?.('Skipping cleanup scripts...');
    }
  }

  // Preserve the workspace's goal BEFORE the worktree (and the goal.json
  // living inside it) is destroyed. The record is relocated to the
  // project-level archived store and its chain link is deliberately kept, so
  // the goal id still resolves (getGoalRecord fallback) and the chain stays
  // intact. Best-effort: a goal failure must never block workspace deletion.
  // Imported lazily (like pruneArtifactMounts below) so the goal-chain module
  // graph stays out of workspace.ts's static load graph.
  try {
    const { archiveWorkspaceGoal } = await import('./goal-chain.js');
    const archived = archiveWorkspaceGoal(projectName, workspaceName);
    if (archived) {
      options.onProgress?.('Archiving goal...');
      result.goalArchived = true;
      result.goalId = archived.id;
    }
  } catch (e) {
    logger.debug(`Failed to archive goal for ${workspaceName}: ${e}`);
  }

  // Remove worktree
  options.onProgress?.('Removing worktree...');
  try {
    await removeWorktree(baseDir, workspacePath, true);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const isNotWorkingTreeError = /not a working tree/i.test(message);

    if (isNotWorkingTreeError) {
      logger.debug(
        `Worktree metadata missing for ${workspaceName}; removing directory directly.`
      );

      try {
        rmSync(workspacePath, { recursive: true, force: true });
      } catch (rmError) {
        result.errorCode = 'WORKTREE_REMOVE_FAILED';
        result.error =
          rmError instanceof Error
            ? rmError.message
            : 'Failed to remove orphaned workspace directory';
        return result;
      }
    } else {
      result.errorCode = 'WORKTREE_REMOVE_FAILED';
      result.error = message || 'Failed to remove worktree';
      return result;
    }
  }

  // Artifacts FS: the workspace's artifacts mount died with the directory —
  // prune the stale worktree registration. The artifacts BRANCH survives for a
  // later roll-up (merge into main) or explicit abandon. Best-effort.
  try {
    const { pruneArtifactMounts } = await import('./artifacts.js');
    await pruneArtifactMounts(getProjectDir(projectName), workspacePath);
  } catch {
    /* additive cleanup only */
  }

  // Try to delete the local branch
  if (!options.keepBranch && info?.branch) {
    options.onProgress?.(`Deleting branch ${info.branch}...`);
    try {
      await deleteLocalBranch(baseDir, info.branch, true);
      result.branchDeleted = true;
    } catch (e) {
      // Branch deletion is best-effort
      logger.debug(`Could not delete branch ${info.branch}: ${e}`);
    }
  }

  result.success = true;

  // Remove per-workspace bundle metadata for deleted workspace.
  try {
    const projectConfig = readProjectConfig(projectName);
    if (projectConfig.bundleWorkspaceState && projectConfig.bundleWorkspaceState[workspaceName]) {
      const nextState = { ...projectConfig.bundleWorkspaceState };
      delete nextState[workspaceName];

      updateProjectConfig(projectName, {
        bundleWorkspaceState: Object.keys(nextState).length > 0 ? nextState : undefined,
      });
    }
  } catch (e) {
    logger.debug(`Failed to update bundle workspace metadata for ${workspaceName}: ${e}`);
  }

  try {
    result.replaysDeleted = deleteReplaysForWorkspace(`${projectName}:${workspaceName}`, {
      projectName,
      workspaceName,
    });
  } catch (e) {
    logger.debug(`Failed to delete replay history for ${workspaceName}: ${e}`);
  }

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
  /**
   * Callback to report progress on deletion steps (for TUI loading indicator).
   * Called with a human-readable message for each step.
   */
  onProgress?: (message: string) => void;
}

/**
 * Result of project deletion
 */
export interface DeleteProjectResult {
  success: boolean;
  projectName: string;
  workspacesDeleted: number;
  sessionsKilled: number;
  replaysDeleted?: number;
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
    replaysDeleted: 0,
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
  for (let i = 0; i < workspaceNames.length; i++) {
    const workspaceName = workspaceNames[i];
    options.onProgress?.(`Removing workspace ${i + 1}/${workspaceNames.length}: ${workspaceName}...`);
    try {
      const wsResult = await deleteWorkspaceCore(projectName, workspaceName, {
        nonInteractive: options.nonInteractive,
        keepBranch: true, // Don't try to delete branches, we're removing the whole repo
        onProgress: options.onProgress,
        removeScriptPolicy: 'best-effort',
      });
      if (wsResult.success) {
        result.workspacesDeleted++;
        result.sessionsKilled += wsResult.sessionsKilled;
        result.replaysDeleted = (result.replaysDeleted ?? 0) + (wsResult.replaysDeleted ?? 0);
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
  options.onProgress?.('Removing project directory...');
  try {
    rmSync(projectDir, { recursive: true, force: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to remove project directory';
    result.errors.push(msg);
    return result;
  }

  try {
    result.replaysDeleted = (result.replaysDeleted ?? 0) + deleteReplaysForProject(projectName);
  } catch (e) {
    logger.debug(`Failed to delete replay history for project ${projectName}: ${e}`);
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
