/**
 * Process schema utilities
 */

import type { ProcessesConfig, ProcessDefinition } from '../../types/processes.js';

export interface ProcessValidationResult {
  valid: boolean;
  errors: string[];
}

const RESTART_POLICIES = ['never', 'on-failure', 'always'] as const;

/** `restart` is an OBJECT ({policy,maxAttempts,backoffMs,maxBackoffMs}), but the
 *  shorthand `"restart": "on-failure"` reads as plausible JSON and used to be
 *  accepted silently — the reader (`getRestartConfig`) then fell back to
 *  policy 'never', so the process never restarted and nothing said why. */
function validateRestart(name: string, restart: unknown, errors: string[]): void {
  if (restart === undefined) return;
  if (typeof restart !== 'object' || restart === null || Array.isArray(restart)) {
    errors.push(
      `process ${name} restart must be an object like {"policy": "on-failure"}, got ${Array.isArray(restart) ? 'an array' : typeof restart}` +
      (typeof restart === 'string' ? ` — write {"policy": ${JSON.stringify(restart)}} instead of ${JSON.stringify(restart)}` : '')
    );
    return;
  }

  const candidate = restart as Record<string, unknown>;
  if (!RESTART_POLICIES.includes(candidate.policy as never)) {
    errors.push(`process ${name} restart.policy must be one of ${RESTART_POLICIES.join(' | ')}`);
  }
  for (const key of ['maxAttempts', 'backoffMs', 'maxBackoffMs'] as const) {
    const value = candidate[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < 0) {
      errors.push(`process ${name} restart.${key} must be a non-negative integer`);
    }
  }
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
    } else if (typeof process.command !== 'string') {
      errors.push(`process ${process.name} command must be a string`);
    }

    if (process.args !== undefined
      && (!Array.isArray(process.args) || process.args.some((arg) => typeof arg !== 'string'))) {
      errors.push(`process ${process.name} args must be an array of strings`);
    }

    if (process.cwd !== undefined && typeof process.cwd !== 'string') {
      errors.push(`process ${process.name} cwd must be a string`);
    }

    if (process.env !== undefined) {
      if (typeof process.env !== 'object' || process.env === null || Array.isArray(process.env)) {
        errors.push(`process ${process.name} env must be an object of string values`);
      } else if (Object.values(process.env).some((value) => typeof value !== 'string')) {
        errors.push(`process ${process.name} env values must be strings (quote numbers, e.g. "PORT": "3000")`);
      }
    }

    if (process.autostart !== undefined && typeof process.autostart !== 'boolean') {
      errors.push(`process ${process.name} autostart must be a boolean`);
    }

    validateRestart(process.name, process.restart, errors);

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
