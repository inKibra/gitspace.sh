import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OpenCodeRuntimeInfo } from './opencode-types.js';
import { logger } from '../utils/logger.js';
import { getGitspaceDir } from '../core/config.js';

export interface StoredOpenCodeRuntime extends OpenCodeRuntimeInfo {
  projectName?: string;
  pid?: number;
  lastSeenAt?: string;
}

const MACHINE_RUNTIME_KEY = 'machine';
const OPENCODE_RUNTIME_STORE_DIR_ENV = 'OPENCODE_RUNTIME_STORE_DIR';

export function getOpenCodeRoot(): string {
  const override = process.env[OPENCODE_RUNTIME_STORE_DIR_ENV]?.trim();
  if (override) {
    return override;
  }
  return join(getGitspaceDir(), '.opencode');
}

export function getRuntimeDir(): string {
  return join(getOpenCodeRoot(), 'runtimes');
}

function runtimeFileName(runtimeKey = MACHINE_RUNTIME_KEY): string {
  return `${encodeURIComponent(runtimeKey)}.json`;
}

export function getStoredRuntimePath(runtimeKey = MACHINE_RUNTIME_KEY): string {
  return join(getRuntimeDir(), runtimeFileName(runtimeKey));
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    logger.error(`[opencode-store] Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, filePath);
}

export async function readStoredRuntime(runtimeKey = MACHINE_RUNTIME_KEY): Promise<StoredOpenCodeRuntime | null> {
  return readJsonFile<StoredOpenCodeRuntime>(getStoredRuntimePath(runtimeKey));
}

export async function writeStoredRuntime(runtime: StoredOpenCodeRuntime): Promise<void> {
  await writeJsonFile(getStoredRuntimePath(runtime.runtimeKey), runtime);
}

export async function deleteStoredRuntime(runtimeKey = MACHINE_RUNTIME_KEY): Promise<void> {
  try {
    await rm(getStoredRuntimePath(runtimeKey));
  } catch {
    // non-fatal
  }
}

export async function listStoredRuntimes(): Promise<StoredOpenCodeRuntime[]> {
  try {
    const entries = await readdir(getRuntimeDir(), { withFileTypes: true });
    const runtimes = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => readJsonFile<StoredOpenCodeRuntime>(join(getRuntimeDir(), entry.name))),
    );
    return runtimes.filter((runtime): runtime is StoredOpenCodeRuntime => runtime !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    logger.error(`[opencode-store] Failed to list runtimes: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
