/**
 * Workspace scanner - finds and lists workspaces on the local machine
 *
 * Scans ~/gitspace/<project>/workspaces/* for workspace directories.
 */

import { readdir, stat, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { WorkspaceInfo } from "./protocol";
import type { WorkspacePhase } from "../../types/config.js";
import { getWorkspaceStatus } from "../../core/workspace-metadata.js";
import { listWorkspaceNotes, summarizeWorkspaceNotes } from "../../core/workspace-metadata.js";

const SPACES_DIR = join(homedir(), "gitspace");
const STALE_DAYS = 30;

/**
 * Scan for all workspaces across all projects
 */
export async function scanWorkspaces(): Promise<WorkspaceInfo[]> {
  const workspaces: WorkspaceInfo[] = [];

  try {
    // List all projects in ~/gitspace/
    const entries = await readdir(SPACES_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Skip the 'app' directory (the CLI itself)
      if (entry.name === "app") continue;

      const projectPath = join(SPACES_DIR, entry.name);
      const projectWorkspaces = await scanProjectWorkspaces(entry.name, projectPath);
      workspaces.push(...projectWorkspaces);
    }
  } catch (e) {
    // If ~/gitspace/ doesn't exist, return empty list
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
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
  const workspacesDir = join(projectPath, "workspaces");

  try {
    const entries = await readdir(workspacesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const workspacePath = join(workspacesDir, entry.name);
      const status = getWorkspaceStatus(projectName, entry.name);
      const info = await getWorkspaceInfo(projectName, entry.name, workspacePath, status);
      if (info) {
        workspaces.push(info);
      }
    }
  } catch (e) {
    // Workspaces directory doesn't exist - no workspaces for this project
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
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

    // Try to get git branch
    const branch = await getGitBranch(workspacePath);

    // Check if stale (no modification in 30+ days)
    const daysSinceModified = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
    const isStale = daysSinceModified > STALE_DAYS;

    // Count sessions (we'll get this from tmux-lite later)
    const sessionCount = 0;
    const notesSummary = summarizeWorkspaceNotes(listWorkspaceNotes(projectName, workspaceName));

    return {
      id: workspaceName,
      name: workspaceName,
      path: workspacePath,
      projectName,
      branch,
      sessionCount,
      isStale,
      ...(status !== undefined && { status }),
      ...(notesSummary.total > 0 ? { notesSummary } : {}),
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
    const headPath = join(workspacePath, ".git", "HEAD");
    const content = await readFile(headPath, "utf-8");

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
  const projectPath = join(SPACES_DIR, projectName);
  return scanProjectWorkspaces(projectName, projectPath);
}

/**
 * Get info for a specific workspace
 */
export async function getWorkspace(
  projectName: string,
  workspaceName: string
): Promise<WorkspaceInfo | null> {
  const workspacePath = join(SPACES_DIR, projectName, "workspaces", workspaceName);
  const status = getWorkspaceStatus(projectName, workspaceName);
  return getWorkspaceInfo(projectName, workspaceName, workspacePath, status);
}
