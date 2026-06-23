/**
 * Wide event path helpers
 */

import { existsSync, readdirSync } from 'fs';
import { join, relative, sep } from 'path';
import { getWorkspaceDir, getWorkspaceRoot } from '../../core/paths.js';
import { encodeProcessNameForPath } from '../processes/names.js';

const DEFAULT_INSTANCE = 1;
const EVENTS_STORAGE_DIR = join('.gitspace', 'events', 'processes');

export interface WorkspaceRef {
  projectName: string;
  workspaceId: string;
  workspacePath: string;
}

/**
 * Resolve workspace/project info from a cwd path
 */
export function resolveWorkspaceRef(cwd: string): WorkspaceRef | null {
  const workspaceRoot = getWorkspaceRoot();
  const rel = relative(workspaceRoot, cwd);
  if (!rel || rel.startsWith('..')) {
    return null;
  }
  const parts = rel.split(sep).filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  if (parts[1] !== 'workspaces') {
    return null;
  }
  const projectName = parts[0];
  const workspaceId = parts[2];
  const workspacePath = getWorkspaceDir(projectName, workspaceId);
  return { projectName, workspaceId, workspacePath };
}

/**
 * Get events directory for a process
 */
export function getProcessEventsDir(
  workspacePath: string,
  processName: string,
  processInstance?: number
): string {
  const instance = processInstance ?? DEFAULT_INSTANCE;
  return join(workspacePath, EVENTS_STORAGE_DIR, `${encodeProcessNameForPath(processName)}-${instance}`);
}

export function getProcessSnapshotsPath(
  workspacePath: string,
  processName: string,
  processInstance?: number
): string {
  return join(getProcessEventsDir(workspacePath, processName, processInstance), 'wide-snapshots.ndjson');
}

/**
 * Get all process events directories for a workspace
 */
export function listProcessEventsDirs(workspacePath: string): string[] {
  const base = join(workspacePath, EVENTS_STORAGE_DIR);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((entry: string) => !entry.startsWith('.'))
    .map((entry: string) => join(base, entry));
}
