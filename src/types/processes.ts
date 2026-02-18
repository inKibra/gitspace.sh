/**
 * Workspace process definitions
 */

import type { EventsConfig } from './config.js';

export type ProcessRestartPolicy = 'never' | 'on-failure' | 'always';

export type ProcessPortProtocol = 'http' | 'tcp';

export interface ProcessPortConfig {
  port: number;
  name?: string;
  protocol?: ProcessPortProtocol;
}

export interface ProcessRestartConfig {
  policy: ProcessRestartPolicy;
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface ProcessDefinition {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  instances?: number;
  autostart?: boolean;
  restart?: ProcessRestartConfig;
  events?: Partial<EventsConfig> & { enabled?: boolean; keepRawOutput?: boolean };
  ports?: ProcessPortConfig[];
}

export interface ProcessesConfig {
  processes: ProcessDefinition[];
}

export interface ProcessInstanceSpec {
  name: string;
  instance: number;
  definition: ProcessDefinition;
}
