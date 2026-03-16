import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OpenCodeRuntimeInfo } from './opencode-types.js';
import { logger } from '../utils/logger.js';
import { getGitspaceDir } from '../core/config.js';

const workspaceWriteQueues = new Map<string, Promise<void>>();

export interface StoredOpenCodeRuntime extends OpenCodeRuntimeInfo {
  projectName?: string;
  pid?: number;
  lastSeenAt?: string;
}

export interface StoredWorkspaceAgentSession {
  id: string;
  title: string;
  rawTitle?: string;
  parentID?: string;
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
  lastKnownStatus?: string;
  terminalSessionId?: string;
  terminalSessionName?: string;
  managed?: boolean;
}

export interface StoredWorkspaceAgentSessionHistory {
  workspaceId: string;
  sessions: Record<string, StoredWorkspaceAgentSession>;
}

function getGitspaceHome(): string {
  return getGitspaceDir();
}

function getOpenCodeRoot(): string {
  return join(getGitspaceHome(), '.opencode');
}

function getRuntimeDir(): string {
  return join(getOpenCodeRoot(), 'runtimes');
}

function getSessionDir(): string {
  return join(getOpenCodeRoot(), 'sessions');
}

function fileNameForWorkspace(workspaceId: string): string {
  return `${encodeURIComponent(workspaceId)}.json`;
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

async function withWorkspaceWriteLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const previous = workspaceWriteQueues.get(workspaceId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  workspaceWriteQueues.set(workspaceId, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (workspaceWriteQueues.get(workspaceId) === queued) {
      workspaceWriteQueues.delete(workspaceId);
    }
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

export async function readStoredRuntime(workspaceId: string): Promise<StoredOpenCodeRuntime | null> {
  return readJsonFile<StoredOpenCodeRuntime>(join(getRuntimeDir(), fileNameForWorkspace(workspaceId)));
}

export async function writeStoredRuntime(runtime: StoredOpenCodeRuntime): Promise<void> {
  await writeJsonFile(join(getRuntimeDir(), fileNameForWorkspace(runtime.workspaceId)), runtime);
}

export async function deleteStoredRuntime(workspaceId: string): Promise<void> {
  try {
    await rm(join(getRuntimeDir(), fileNameForWorkspace(workspaceId)));
  } catch {
    // non-fatal
  }
}

export async function listStoredRuntimes(): Promise<StoredOpenCodeRuntime[]> {
  try {
    const entries = await readdir(getRuntimeDir());
    const runtimes = await Promise.all(
      entries.map((entry) => readJsonFile<StoredOpenCodeRuntime>(join(getRuntimeDir(), entry))),
    );
    return runtimes.filter((runtime): runtime is StoredOpenCodeRuntime => runtime !== null);
  } catch {
    return [];
  }
}

export async function readStoredSessionHistory(workspaceId: string): Promise<StoredWorkspaceAgentSessionHistory> {
  const stored = await readJsonFile<StoredWorkspaceAgentSessionHistory>(join(getSessionDir(), fileNameForWorkspace(workspaceId)));
  return stored ?? { workspaceId, sessions: {} };
}

export async function writeStoredSessionHistory(history: StoredWorkspaceAgentSessionHistory): Promise<void> {
  await writeJsonFile(join(getSessionDir(), fileNameForWorkspace(history.workspaceId)), history);
}

export async function upsertStoredSession(
  workspaceId: string,
  session: StoredWorkspaceAgentSession,
): Promise<void> {
  await withWorkspaceWriteLock(workspaceId, async () => {
    const history = await readStoredSessionHistory(workspaceId);
    history.sessions[session.id] = {
      ...history.sessions[session.id],
      ...session,
      lastSeenAt: session.lastSeenAt ?? new Date().toISOString(),
    };
    await writeStoredSessionHistory(history);
  });
}

export async function replaceStoredSessions(
  workspaceId: string,
  sessions: StoredWorkspaceAgentSession[],
): Promise<void> {
  await withWorkspaceWriteLock(workspaceId, async () => {
    const existing = await readStoredSessionHistory(workspaceId);
    const next: Record<string, StoredWorkspaceAgentSession> = {};
    for (const session of sessions) {
      next[session.id] = {
        ...existing.sessions[session.id],
        ...session,
        lastSeenAt: session.lastSeenAt ?? new Date().toISOString(),
      };
    }
    await writeStoredSessionHistory({ workspaceId, sessions: next });
  });
}

export async function deleteStoredSession(workspaceId: string, sessionId: string): Promise<void> {
  await withWorkspaceWriteLock(workspaceId, async () => {
    const history = await readStoredSessionHistory(workspaceId);
    delete history.sessions[sessionId];
    await writeStoredSessionHistory(history);
  });
}
