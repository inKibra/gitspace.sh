/**
 * Switch command implementation
 * Handles both 'gssh switch project' and 'gssh switch [workspace-name]'
 */

import { existsSync, readdirSync } from 'fs';
import {
  readGlobalConfig,
  readProjectConfig,
  setCurrentProject,
  getAllProjectNames,
  getCurrentProject,
  getProjectWorkspacesDir,
} from '../core/config.js';
import { selectItem } from '../utils/prompts.js';
import { logger } from '../utils/logger.js';
import { openWorkspaceShell } from '../core/shell.js';
import { getWorktreeInfo } from '../core/git.js';
import { SpacesError, NoProjectError } from '../types/errors.js';
import { join } from 'path';
import { runCommandsInTerminal } from '../utils/run-commands.js';
import { fuzzyMatch } from '../utils/fuzzy-match.js';
import { preloadProjectSecrets } from '../utils/secrets.js';
import type {
  WorkspaceCandidate,
  RankedWorkspace,
} from '../types/workspace-fuzzy.js';

/**
 * Switch to a different project
 */
export async function switchProject(projectNameArg?: string): Promise<void> {
  const allProjects = getAllProjectNames();

  if (allProjects.length === 0) {
    throw new SpacesError(
      'No projects found\n\nCreate a project first:\n  gssh add project',
      'USER_ERROR',
      1
    );
  }

  let projectName: string;

  if (projectNameArg) {
    // Project name provided as argument
    if (!allProjects.includes(projectNameArg)) {
      throw new SpacesError(
        `Project "${projectNameArg}" not found`,
        'USER_ERROR',
        1
      );
    }
    projectName = projectNameArg;
  } else {
    // Select project using fzf
    const currentProject = getCurrentProject();
    const projectOptions = allProjects.map((name) => {
      const config = readProjectConfig(name);
      const indicator = name === currentProject ? ' (current)' : '';
      return `${name} - ${config.repository}${indicator}`;
    });

    const selected = await selectItem(projectOptions, 'Select project:');

    if (!selected) {
      logger.info('Cancelled');
      return;
    }

    // Extract project name from selection
    projectName = selected.split(' - ')[0];
  }

  // Set as current project
  setCurrentProject(projectName);
  logger.success(`Switched to project: ${projectName}`);
}

/**
 * Switch to a workspace in the current project
 */
export async function switchWorkspace(
  workspaceNameArg?: string,
  options: {
    noShell?: boolean;
    force?: boolean;
  } = {}
): Promise<void> {
  // Get current project
  const currentProject = getCurrentProject();
  if (!currentProject) {
    throw new NoProjectError();
  }

  const projectConfig = readProjectConfig(currentProject);
  const workspacesDir = getProjectWorkspacesDir(currentProject);

  // Check if workspaces directory exists
  if (!existsSync(workspacesDir)) {
    throw new SpacesError(
      `No workspaces found in project "${currentProject}"\n\nCreate a workspace first:\n  gssh add`,
      'USER_ERROR',
      1
    );
  }

  // Get all workspace directories
  const workspaces = readdirSync(workspacesDir).filter((entry) => {
    const path = join(workspacesDir, entry);
    return existsSync(path) && readdirSync(path).length > 0; // Not empty
  });

  if (workspaces.length === 0) {
    throw new SpacesError(
      `No workspaces found in project "${currentProject}"\n\nCreate a workspace first:\n  gssh add`,
      'USER_ERROR',
      1
    );
  }

  let workspaceName: string;

  if (workspaceNameArg) {
    // Try exact match first (backward compatible)
    if (workspaces.includes(workspaceNameArg)) {
      workspaceName = workspaceNameArg;
    } else {
      // No exact match - try fuzzy matching
      logger.debug(`No exact match for "${workspaceNameArg}", trying fuzzy match...`);

      const candidates = await gatherWorkspaceCandidates(
        workspacesDir,
        workspaces
      );

      const matches = fuzzyMatch(workspaceNameArg, candidates);

      if (matches.length === 0) {
        throw new SpacesError(
          `No workspaces match "${workspaceNameArg}"\n\nAvailable workspaces:\n${workspaces.map(w => '  - ' + w).join('\n')}`,
          'USER_ERROR',
          1
        );
      }

      // Rank matches
      const ranked = rankMatches(matches);

      // If only one match or force flag, use directly
      if (ranked.length === 1 || options.force) {
        workspaceName = ranked[0].workspace.name;
        logger.info(`Fuzzy matched "${workspaceNameArg}" → ${workspaceName}`);
      } else {
        // Multiple matches - show interactive selection
        const selected = await selectFromRanked(ranked, workspaceNameArg);

        if (!selected) {
          logger.info('Cancelled');
          return;
        }

        workspaceName = selected.name;
      }
    }
  } else {
    // Get workspace info for display
    const workspaceOptions: string[] = [];

    for (const workspace of workspaces) {
      const workspacePath = join(workspacesDir, workspace);
      const info = await getWorktreeInfo(workspacePath);

      if (info) {
        const statusParts: string[] = [];

        // Add ahead/behind info
        if (info.ahead > 0 || info.behind > 0) {
          statusParts.push(`[${info.branch} +${info.ahead} -${info.behind}]`);
        } else {
          statusParts.push(`[${info.branch}]`);
        }

        // Add uncommitted changes
        if (info.uncommittedChanges > 0) {
          statusParts.push(`${info.uncommittedChanges} uncommitted`);
        } else {
          statusParts.push('clean');
        }

        const display = `${workspace.padEnd(30)} ${statusParts.join(' ')}`;
        workspaceOptions.push(display);
      } else {
        workspaceOptions.push(workspace);
      }
    }

    const selected = await selectItem(workspaceOptions, 'Select workspace:');

    if (!selected) {
      logger.info('Cancelled');
      return;
    }

    // Extract workspace name (first part before padding)
    workspaceName = selected.split(/\s+/)[0];
  }

  const workspacePath = join(workspacesDir, workspaceName);

  // Preload project secrets into cache to minimize keychain prompts
  if (projectConfig.bundleSecretKeys && projectConfig.bundleSecretKeys.length > 0) {
    await preloadProjectSecrets(currentProject, projectConfig.bundleSecretKeys);
  }

  // Switch to workspace
  if (options.noShell) {
    logger.success(`Workspace: ${workspacePath}`);
    logger.log(`\nTo navigate:\n  cd ${workspacePath}`);
  } else {
    // Open workspace shell
    await openWorkspaceShell(
      workspacePath,
      currentProject,
      projectConfig.repository,
      false // never skip setup on switch
    );
  }
}

/**
 * Gather workspace candidates with metadata for fuzzy matching
 *
 * @param workspacesDir Path to workspaces directory
 * @param workspaceNames Array of workspace names
 * @returns Array of workspace candidates with metadata
 */
async function gatherWorkspaceCandidates(
  workspacesDir: string,
  workspaceNames: string[]
): Promise<WorkspaceCandidate[]> {
  const candidates: WorkspaceCandidate[] = [];

  for (const name of workspaceNames) {
    const path = join(workspacesDir, name);
    const info = await getWorktreeInfo(path);

    if (info) {
      candidates.push({
        name: info.name,
        path: info.path,
        branch: info.branch,
        ahead: info.ahead,
        behind: info.behind,
        uncommittedChanges: info.uncommittedChanges,
        lastCommit: info.lastCommit,
      });
    }
  }

  return candidates;
}

/**
 * Rank fuzzy matches with additional scoring
 *
 * Additional ranking factors:
 * - Shorter workspace names get +5 bonus (easier to type)
 *
 * @param matches Fuzzy match results
 * @returns Ranked workspace results
 */
function rankMatches(
  matches: Array<{ item: WorkspaceCandidate; score: number; matchedIndices: number[] }>
): RankedWorkspace[] {
  const ranked: RankedWorkspace[] = matches.map((match) => {
    let finalScore = match.score;

    // Bonus for shorter names (easier to remember/type)
    if (match.item.name.length <= 15) {
      finalScore += 5;
    }

    return {
      workspace: match.item,
      matchScore: match.score,
      finalScore,
      matchedIndices: match.matchedIndices,
    };
  });

  // Sort by final score
  ranked.sort((a, b) => b.finalScore - a.finalScore);

  return ranked;
}

/**
 * Display ranked workspaces and prompt for selection
 *
 * @param ranked Ranked workspace results
 * @param query Original query (for display)
 * @returns Selected workspace or null if cancelled
 */
async function selectFromRanked(
  ranked: RankedWorkspace[],
  query: string
): Promise<WorkspaceCandidate | null> {
  // Format each workspace for display
  const choices = ranked.map((r) => formatWorkspaceChoice(r));

  const selected = await selectItem(
    choices,
    `Multiple matches for "${query}":`
  );

  if (!selected) {
    return null;
  }

  // Parse workspace name from selection (first part before padding)
  const workspaceName = selected.split(/\s+/)[0];
  const workspace = ranked.find((r) => r.workspace.name === workspaceName);

  return workspace ? workspace.workspace : null;
}

/**
 * Format a ranked workspace for display in selection list
 *
 * Format: "name    [branch +A -B] status"
 * Example: "my-feature    [main +2 -0] clean"
 *
 * @param ranked Ranked workspace
 * @returns Formatted string for display
 */
function formatWorkspaceChoice(ranked: RankedWorkspace): string {
  const ws = ranked.workspace;
  const parts: string[] = [];

  // Workspace name (padded to 30 chars for alignment)
  parts.push(ws.name.padEnd(30));

  // Branch info with ahead/behind
  if (ws.ahead > 0 || ws.behind > 0) {
    parts.push(`[${ws.branch} +${ws.ahead} -${ws.behind}]`);
  } else {
    parts.push(`[${ws.branch}]`);
  }

  // Uncommitted changes or clean status
  if (ws.uncommittedChanges > 0) {
    parts.push(`${ws.uncommittedChanges} uncommitted`);
  } else {
    parts.push('clean');
  }

  return parts.join(' ');
}
