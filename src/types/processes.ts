/**
 * Workspace process definitions
 */

import type { EventsConfig } from './config.js';

export type ProcessRestartPolicy = 'never' | 'on-failure' | 'always';

export type ProcessPortProtocol = 'http' | 'tcp';

export interface ProcessPortConfig {
  name: string;
  protocol?: ProcessPortProtocol;
}

export interface ResolvedProcessPort extends ProcessPortConfig {
  instance: number;
  port: number;
}

export interface RuntimeProcessDefinition {
  name: string;
  instances?: number;
  ports?: ResolvedProcessPort[];
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
