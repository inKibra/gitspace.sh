/**
 * Process registry helpers
 */

import { join } from 'path';
import type { ProcessDefinition, ProcessInstanceSpec } from '../../types/processes.js';
import { loadProcessesConfig, getProcessInstances } from './config.js';

export interface WorkspaceProcessRegistry {
  workspacePath: string;
  processes: ProcessDefinition[];
  instances: ProcessInstanceSpec[];
}

export function loadProcessRegistry(workspacePath: string): WorkspaceProcessRegistry {
  const config = loadProcessesConfig(workspacePath);
  return {
    workspacePath,
    processes: config.processes,
    instances: getProcessInstances(config),
  };
}

export function resolveProcessCwd(workspacePath: string, cwd?: string): string {
  return cwd ? join(workspacePath, cwd) : workspacePath;
}
