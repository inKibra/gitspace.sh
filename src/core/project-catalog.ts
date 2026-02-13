import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  getAllProjectNames,
  getCurrentProject,
  getProjectWorkspacesDir,
  readProjectConfig,
} from './config.js';

export interface ProjectSummary {
  name: string;
  repository: string;
  workspaceCount: number;
  isCurrent: boolean;
}

/**
 * List projects with workspace counts and current-project marker.
 */
export function listProjectSummaries(): ProjectSummary[] {
  const projectNames = getAllProjectNames();
  const currentProject = getCurrentProject();

  return projectNames.map((name) => {
    const config = readProjectConfig(name);
    const workspacesDir = getProjectWorkspacesDir(name);
    let workspaceCount = 0;

    if (existsSync(workspacesDir)) {
      workspaceCount = readdirSync(workspacesDir)
        .filter((entry) => {
          const path = join(workspacesDir, entry);
          if (!existsSync(path)) {
            return false;
          }
          try {
            return readdirSync(path).length > 0;
          } catch {
            return false;
          }
        })
        .length;
    }

    return {
      name,
      repository: config.repository,
      workspaceCount,
      isCurrent: name === currentProject,
    };
  });
}
