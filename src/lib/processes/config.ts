/**
 * Process config loader (repo workspace only)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ProcessesConfig, ProcessDefinition, ProcessInstanceSpec } from '../../types/processes.js';
import { validateProcessesConfig } from './schema.js';

export function getProcessesConfigPath(workspacePath: string): string {
  return join(workspacePath, '.gitspace', 'processes.json');
}

export function loadProcessesConfig(workspacePath: string): ProcessesConfig {
  const path = getProcessesConfigPath(workspacePath);
  if (!existsSync(path)) {
    return { processes: [] };
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as ProcessesConfig;
  const normalized: ProcessesConfig = {
    processes: Array.isArray(parsed.processes) ? parsed.processes : [],
  };
  const validation = validateProcessesConfig(normalized);
  if (!validation.valid) {
    console.warn(`[processes] Invalid config at ${path}: ${validation.errors.join(', ')}`);
  }
  return normalized;
}

export function getProcessInstances(config: ProcessesConfig): ProcessInstanceSpec[] {
  const instances: ProcessInstanceSpec[] = [];
  for (const process of config.processes) {
    const count = Math.max(1, process.instances ?? 1);
    for (let idx = 1; idx <= count; idx++) {
      instances.push({ name: process.name, instance: idx, definition: process });
    }
  }
  return instances;
}

export function getProcessDefinition(
  config: ProcessesConfig,
  name: string
): ProcessDefinition | null {
  return config.processes.find((process) => process.name === name) ?? null;
}
