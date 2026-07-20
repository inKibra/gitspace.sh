/**
 * Process config loader (repo workspace only)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ProcessesConfig, ProcessDefinition, ProcessInstanceSpec, ProcessPortConfig } from '../../types/processes.js';
import { validateProcessesConfig } from './schema.js';
import { normalizeProcessInstanceCount } from './instances.js';

export interface ProcessesConfigLoadResult {
  config: ProcessesConfig;
  error: string | null;
}

function stripJsoncComments(input: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        result += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    result += ch;
  }

  return result;
}

function stripJsonTrailingCommas(input: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) {
        j += 1;
      }
      const nextNonWhitespace = input[j];
      if (nextNonWhitespace === '}' || nextNonWhitespace === ']') {
        continue;
      }
    }

    result += ch;
  }

  return result;
}

function parseJsonc(raw: string): unknown {
  const withoutComments = stripJsoncComments(raw);
  const withoutTrailingCommas = stripJsonTrailingCommas(withoutComments);
  return JSON.parse(withoutTrailingCommas);
}

function normalizeProcessPortConfig(port: unknown): ProcessPortConfig | null {
  if (!port || typeof port !== 'object') {
    return null;
  }

  const candidate = port as { name?: unknown; protocol?: unknown };
  const normalized: ProcessPortConfig = {
    name: typeof candidate.name === 'string' ? candidate.name : '',
  };

  if (candidate.protocol === 'http' || candidate.protocol === 'tcp') {
    normalized.protocol = candidate.protocol;
  }

  return normalized;
}

function normalizeProcessDefinition(process: unknown): ProcessDefinition | null {
  if (!process || typeof process !== 'object') {
    return null;
  }

  const candidate = process as ProcessDefinition & { ports?: unknown };
  return {
    name: candidate.name,
    command: candidate.command,
    args: candidate.args,
    cwd: candidate.cwd,
    env: candidate.env,
    instances: candidate.instances,
    autostart: candidate.autostart,
    restart: candidate.restart,
    events: candidate.events,
    ports: Array.isArray(candidate.ports)
      ? candidate.ports
        .map(normalizeProcessPortConfig)
        .filter((port): port is ProcessPortConfig => Boolean(port))
      : undefined,
  };
}

/** Most call sites use `loadProcessesConfig`, which drops the diagnostic. A bad
 *  field (e.g. `"restart": "on-failure"` instead of `{"policy":"on-failure"}`)
 *  would then be ignored in silence, so warn once per distinct problem. */
const warnedConfigProblems = new Set<string>();

function warnOnceAboutConfigProblem(path: string, message: string): void {
  const key = `${path}\u0000${message}`;
  if (warnedConfigProblems.has(key)) return;
  warnedConfigProblems.add(key);
  console.error(`[processes] ${message} (${path})`);
}

/** Test seam: forget which problems have already been reported. */
export function resetProcessesConfigWarnings(): void {
  warnedConfigProblems.clear();
}

export function getProcessesConfigPath(workspacePath: string): string {
  return join(workspacePath, '.gitspace', 'processes.json');
}

export function loadProcessesConfigWithDiagnostics(workspacePath: string): ProcessesConfigLoadResult {
  const path = getProcessesConfigPath(workspacePath);
  if (!existsSync(path)) {
    return { config: { processes: [] }, error: null };
  }

  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw) {
    return { config: { processes: [] }, error: null };
  }

  let parsed: ProcessesConfig;
  try {
    parsed = parseJsonc(raw) as ProcessesConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSONC';
    warnOnceAboutConfigProblem(path, `Failed to parse .gitspace/processes.json: ${message}`);
    return {
      config: { processes: [] },
      error: `Failed to parse .gitspace/processes.json: ${message}`,
    };
  }

  const normalized: ProcessesConfig = {
    processes: Array.isArray(parsed.processes)
      ? parsed.processes
        .map(normalizeProcessDefinition)
        .filter((process): process is ProcessDefinition => Boolean(process))
      : [],
  };
  const validation = validateProcessesConfig(normalized);
  if (!validation.valid) {
    const message = `Invalid .gitspace/processes.json: ${validation.errors.join(', ')}`;
    warnOnceAboutConfigProblem(path, message);
    return { config: normalized, error: message };
  }
  return { config: normalized, error: null };
}

export function loadProcessesConfig(workspacePath: string): ProcessesConfig {
  return loadProcessesConfigWithDiagnostics(workspacePath).config;
}

export function getProcessInstances(config: ProcessesConfig): ProcessInstanceSpec[] {
  const instances: ProcessInstanceSpec[] = [];
  for (const process of config.processes) {
    const count = normalizeProcessInstanceCount(process.instances);
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
