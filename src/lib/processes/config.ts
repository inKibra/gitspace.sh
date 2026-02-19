/**
 * Process config loader (repo workspace only)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ProcessesConfig, ProcessDefinition, ProcessInstanceSpec } from '../../types/processes.js';
import { validateProcessesConfig } from './schema.js';

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
    return {
      config: { processes: [] },
      error: `Failed to parse .gitspace/processes.json: ${message}`,
    };
  }

  const normalized: ProcessesConfig = {
    processes: Array.isArray(parsed.processes) ? parsed.processes : [],
  };
  const validation = validateProcessesConfig(normalized);
  if (!validation.valid) {
    return {
      config: normalized,
      error: `Invalid .gitspace/processes.json: ${validation.errors.join(', ')}`,
    };
  }
  return { config: normalized, error: null };
}

export function loadProcessesConfig(workspacePath: string): ProcessesConfig {
  return loadProcessesConfigWithDiagnostics(workspacePath).config;
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
