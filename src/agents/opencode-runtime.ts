// Bun global is available at runtime but not in the web tsc build which
// traverses this file via type-only import chains. Declare it so tsc is happy.
declare const Bun: any;

import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareWorkspaceIntegrations } from '../integrations/apply.js';
import {
  buildAuthenticatedOpenCodeUrl,
  createOpenCodeBasicAuthHeader,
  type OpenCodeRuntimeInfo,
  type OpenCodeRuntimeTarget,
} from './opencode-runtime-shared.js';

export type { OpenCodeRuntimeInfo, OpenCodeRuntimeTarget } from './opencode-runtime-shared.js';

interface RuntimeEntry {
  info: OpenCodeRuntimeInfo;
  process: OpenCodeRuntimeProcess;
}

interface OpenCodeRuntimeProcess {
  exitCode: number | null;
  kill(): void;
}

interface BunSpawnAPI {
  spawn(options: {
    cmd: string[];
    cwd: string;
    env: Record<string, string | undefined>;
    stdout: 'ignore';
    stderr: 'ignore';
  }): OpenCodeRuntimeProcess;
}

function getBunSpawn(): BunSpawnAPI['spawn'] {
  const bun = (globalThis as typeof globalThis & { Bun?: BunSpawnAPI }).Bun;
  if (!bun) {
    throw new Error('OpenCode runtime requires Bun.spawn');
  }
  return bun.spawn.bind(bun);
}

function hashToPort(workspaceId: string): number {
  const hash = createHash('sha256').update(workspaceId).digest();
  return 41000 + (hash.readUInt16BE(0) % 10000);
}

function createPassword(): string {
  return randomBytes(24).toString('base64url');
}

async function checkHealth(info: OpenCodeRuntimeInfo): Promise<boolean> {
  try {
    const response = await fetch(`${info.baseUrl}/global/health`, {
      headers: {
        authorization: createOpenCodeBasicAuthHeader(info),
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealthy(info: OpenCodeRuntimeInfo, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await checkHealth(info)) {
      return;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for OpenCode runtime for ${info.workspaceId}`);
}

export class OpenCodeRuntimeManager {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly runtimeStartedHandlers = new Set<(info: OpenCodeRuntimeInfo) => void>();
  private readonly runtimeStoppedHandlers = new Set<(workspaceId: string) => void>();

  /** Register a callback for when a runtime is successfully started. Returns unsubscribe. */
  onRuntimeStarted(handler: (info: OpenCodeRuntimeInfo) => void): () => void {
    this.runtimeStartedHandlers.add(handler);
    return () => { this.runtimeStartedHandlers.delete(handler); };
  }

  /** Register a callback for when a runtime is removed. Returns unsubscribe. */
  onRuntimeStopped(handler: (workspaceId: string) => void): () => void {
    this.runtimeStoppedHandlers.add(handler);
    return () => { this.runtimeStoppedHandlers.delete(handler); };
  }

  private emitRuntimeStarted(info: OpenCodeRuntimeInfo): void {
    for (const handler of this.runtimeStartedHandlers) {
      try { handler(info); } catch { /* non-fatal */ }
    }
  }

  private emitRuntimeStopped(workspaceId: string): void {
    for (const handler of this.runtimeStoppedHandlers) {
      try { handler(workspaceId); } catch { /* non-fatal */ }
    }
  }

  /** Returns all currently tracked runtime infos (may include crashed/stale ones) */
  listRuntimes(): OpenCodeRuntimeInfo[] {
    return Array.from(this.entries.values()).map((e) => e.info);
  }

  async ensureWorkspaceRuntime(target: OpenCodeRuntimeTarget): Promise<OpenCodeRuntimeInfo> {
    const existing = this.entries.get(target.workspaceId);
    if (existing) {
      if (existing.process.exitCode === null && (await checkHealth(existing.info))) {
        return existing.info;
      }

      try {
        existing.process.kill();
      } catch {
        // no-op
      }
      this.entries.delete(target.workspaceId);
      this.emitRuntimeStopped(target.workspaceId);
    }

    const username = 'gitspace';
    const password = createPassword();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = hashToPort(`${target.workspaceId}:${attempt}`);
      const info: OpenCodeRuntimeInfo = {
        workspaceId: target.workspaceId,
        workspacePath: target.workspacePath,
        hostname: '127.0.0.1',
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        username,
        password,
        startedAt: new Date().toISOString(),
      };

      if (await checkHealth(info)) {
        continue;
      }

      const spawn = getBunSpawn();
      const child = spawn({
        cmd: ['opencode', 'web', '--hostname', '127.0.0.1', '--port', String(port)],
        cwd: target.workspacePath,
        env: {
          ...process.env,
          ...(target.projectName ? (await prepareWorkspaceIntegrations(target.projectName, target.workspacePath)).env : {}),
          OPENCODE_SERVER_USERNAME: username,
          OPENCODE_SERVER_PASSWORD: password,
        },
        stdout: 'ignore',
        stderr: 'ignore',
      });

      try {
        await waitForHealthy(info);
        this.entries.set(target.workspaceId, { info, process: child });
        this.emitRuntimeStarted(info);
        return info;
      } catch (error) {
        try {
          child.kill();
        } catch {
          // no-op
        }

        if (attempt === 19) {
          throw error;
        }
      }
    }

    throw new Error(`Failed to start OpenCode runtime for ${target.workspaceId}`);
  }

  async getWorkspaceRuntime(workspaceId: string): Promise<OpenCodeRuntimeInfo | null> {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      return null;
    }

    if (entry.process.exitCode !== null) {
      this.entries.delete(workspaceId);
      this.emitRuntimeStopped(workspaceId);
      return null;
    }

    if (!(await checkHealth(entry.info))) {
      return null;
    }

    return entry.info;
  }
}

export const defaultOpenCodeRuntimeManager = new OpenCodeRuntimeManager();

export { buildAuthenticatedOpenCodeUrl, createOpenCodeBasicAuthHeader };
