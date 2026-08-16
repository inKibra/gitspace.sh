/**
 * Workspace scanner - finds and lists workspaces on the local machine.
 *
 * Scans the configured workspace root for <project>/workspaces/* directories.
 */

import { readdir, stat, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { WorkspaceInfo } from './protocol';
import type { WorkspacePhase } from '../../types/config.js';
import { getWorkspaceStatus, listWorkspaceNotes, summarizeWorkspaceNotes } from '../../core/workspace-metadata.js';
import { getWorkspaceDir, getWorkspaceProjectDir, getWorkspaceRoot } from '../../core/paths.js';

const STALE_DAYS = 30;

/**
 * Scan for all workspaces across all projects
 */
export async function scanWorkspaces(): Promise<WorkspaceInfo[]> {
  const workspaces: WorkspaceInfo[] = [];

  try {
    const workspaceRoot = getWorkspaceRoot();
    const entries = await readdir(workspaceRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Skip the 'app' directory (the CLI itself)
      if (entry.name === 'app') continue;

      const projectPath = getWorkspaceProjectDir(entry.name);
      const projectWorkspaces = await scanProjectWorkspaces(entry.name, projectPath);
      workspaces.push(...projectWorkspaces);
    }
  } catch (e) {
    // If the workspace root doesn't exist, return empty list
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw e;
  }

  // Sort by project name, then workspace name
  workspaces.sort((a, b) => {
    if (a.projectName !== b.projectName) {
      return a.projectName.localeCompare(b.projectName);
    }
    return a.name.localeCompare(b.name);
  });

  return workspaces;
}

/**
 * Scan workspaces for a single project
 */
async function scanProjectWorkspaces(
  projectName: string,
  projectPath: string
): Promise<WorkspaceInfo[]> {
  const workspaces: WorkspaceInfo[] = [];
  const workspacesDir = join(projectPath, 'workspaces');

  try {
    const entries = await readdir(workspacesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const workspacePath = join(workspacesDir, entry.name);
      // Remnant directories are filtered in getWorkspaceInfo, which every entry
      // point goes through.
      let status: WorkspacePhase | undefined;
      try {
        status = getWorkspaceStatus(projectName, entry.name);
      } catch {
        status = undefined;
      }
      const info = await getWorkspaceInfo(projectName, entry.name, workspacePath, status);
      if (info) {
        workspaces.push(info);
      }
    }
  } catch (e) {
    // Workspaces directory doesn't exist - no workspaces for this project
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw e;
  }

  return workspaces;
}

/**
 * Get detailed info for a single workspace
 */
async function getWorkspaceInfo(
  projectName: string,
  workspaceName: string,
  workspacePath: string,
  status?: WorkspacePhase
): Promise<WorkspaceInfo | null> {
  try {
    const stats = await stat(workspacePath);
    if (!stats.isDirectory()) return null;
    // A workspace IS a code worktree, so it always has a `.git`. A bare
    // directory here is a remnant — most often one holding nothing but
    // `.gitspace/artifacts`, whose branch outlives the workspace by design.
    // Treating it as a workspace resurrected removed ones as ghost rows in the
    // board's code lane (no branch, no phase, so they fell to the default).
    // Checked here rather than in the scan loop so the by-name lookup cannot
    // hand back a ghost either.
    if (!existsSync(join(workspacePath, '.git'))) return null;

    // Try to get git branch
    const branch = await getGitBranch(workspacePath);

    // Check if stale (no modification in 30+ days)
    const daysSinceModified = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
    const isStale = daysSinceModified > STALE_DAYS;

    // Count sessions (we'll get this from tmux-lite later)
    const sessionCount = 0;
    let notesSummary: ReturnType<typeof summarizeWorkspaceNotes> | undefined;
    try {
      notesSummary = summarizeWorkspaceNotes(listWorkspaceNotes(projectName, workspaceName));
    } catch {
      notesSummary = undefined;
    }

    return {
      id: workspaceName,
      name: workspaceName,
      path: workspacePath,
      projectName,
      branch,
      sessionCount,
      isStale,
      ...(status !== undefined && { status }),
      ...(notesSummary && notesSummary.total > 0 ? { notesSummary } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Get current git branch for a workspace
 */
async function getGitBranch(workspacePath: string): Promise<string | undefined> {
  try {
    const headPath = join(workspacePath, '.git', 'HEAD');
    const content = await readFile(headPath, 'utf-8');

    // Parse "ref: refs/heads/branch-name"
    const match = content.match(/^ref: refs\/heads\/(.+)$/m);
    if (match) {
      return match[1].trim();
    }

    // Detached HEAD - return short hash
    return content.trim().slice(0, 8);
  } catch {
    return undefined;
  }
}

/**
 * Get workspaces for a specific project
 */
export async function getProjectWorkspaces(projectName: string): Promise<WorkspaceInfo[]> {
  const projectPath = getWorkspaceProjectDir(projectName);
  return scanProjectWorkspaces(projectName, projectPath);
}

/**
 * Get info for a specific workspace
 */
export async function getWorkspace(
  projectName: string,
  workspaceName: string
): Promise<WorkspaceInfo | null> {
  const workspacePath = getWorkspaceDir(projectName, workspaceName);
  const status = getWorkspaceStatus(projectName, workspaceName);
  return getWorkspaceInfo(projectName, workspaceName, workspacePath, status);
}
