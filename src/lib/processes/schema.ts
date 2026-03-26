/**
 * Process schema utilities
 */

import type { ProcessesConfig, ProcessDefinition } from '../../types/processes.js';

export interface ProcessValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateProcessesConfig(config: ProcessesConfig): ProcessValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(config.processes)) {
    errors.push('processes must be an array');
    return { valid: false, errors };
  }

  const names = new Set<string>();
  for (const process of config.processes) {
    if (!process.name) {
      errors.push('process is missing name');
      continue;
    }
    if (names.has(process.name)) {
      errors.push(`duplicate process name: ${process.name}`);
    }
    names.add(process.name);

    if (!process.command) {
      errors.push(`process ${process.name} missing command`);
    }

    if (process.instances !== undefined) {
      if (!Number.isInteger(process.instances) || process.instances < 0) {
        errors.push(`process ${process.name} instances must be a non-negative integer`);
      }
    }

    if (process.events?.keepRawOutput !== undefined && typeof process.events.keepRawOutput !== 'boolean') {
      errors.push(`process ${process.name} keepRawOutput must be a boolean`);
    }

    if (process.ports !== undefined) {
      if (!Array.isArray(process.ports)) {
        errors.push(`process ${process.name} ports must be an array`);
      } else {
        const portNames = new Set<string>();
        for (const port of process.ports) {
          if (!port || typeof port !== 'object') {
            errors.push(`process ${process.name} port entries must be objects`);
            continue;
          }
          if (typeof port.name !== 'string' || port.name.trim().length === 0) {
            errors.push(`process ${process.name} port name must be a non-empty string`);
          } else if (portNames.has(port.name)) {
            errors.push(`process ${process.name} port names must be unique: ${port.name}`);
          } else {
            portNames.add(port.name);
          }
          if (port.protocol !== undefined && port.protocol !== 'http' && port.protocol !== 'tcp') {
            errors.push(`process ${process.name} port protocol must be http or tcp`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function describeProcess(process: ProcessDefinition): string {
  const args = process.args?.join(' ') ?? '';
  return `${process.name}: ${process.command} ${args}`.trim();
}
