// Bun global is available at runtime but not in the web tsc build which
// traverses this file via type-only import chains. Declare it so tsc is happy.
declare const Bun: any;

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { getGitspaceDir } from '../core/config.js';
import {
  buildAuthenticatedOpenCodeUrl,
  createOpenCodeBasicAuthHeader,
  type OpenCodeRuntimeInfo,
  type OpenCodeRuntimeTarget,
} from './opencode-runtime-shared.js';
import { deleteStoredRuntime, listStoredRuntimes, writeStoredRuntime, type StoredOpenCodeRuntime } from './opencode-store.js';
import { writeAgentLog } from './agent-log.js';

export type { OpenCodeRuntimeInfo, OpenCodeRuntimeTarget } from './opencode-runtime-shared.js';

const MACHINE_RUNTIME_KEY = 'machine';

interface RuntimeEntry {
  info: OpenCodeRuntimeInfo;
  process?: OpenCodeRuntimeProcess;
  pid?: number;
}

interface OpenCodeRuntimeProcess {
  exitCode: number | null;
  kill(): void;
  pid?: number;
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

function hashToPort(runtimeKey: string): number {
  const hash = createHash('sha256').update(runtimeKey).digest();
  return 41000 + (hash.readUInt16BE(0) % 10000);
}

function createPassword(): string {
  return randomBytes(24).toString('base64url');
}

function getRuntimeWorkingDirectory(): string {
  return getGitspaceDir();
}

async function checkHealth(info: OpenCodeRuntimeInfo): Promise<boolean> {
  try {
    const { OpenCodeClient } = await import('./opencode-client.js');
    const client = new OpenCodeClient({
      baseUrl: info.baseUrl,
      fetch: (input, init) =>
        fetch(input as RequestInfo, {
          ...init,
          headers: { ...(init?.headers ?? {}), authorization: createOpenCodeBasicAuthHeader(info) },
        }),
    });
    return client.checkHealth();
  } catch {
    return false;
  }
}

async function isPortInUse(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForHealthy(info: OpenCodeRuntimeInfo, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await checkHealth(info)) {
      return;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for OpenCode runtime ${info.runtimeKey}`);
}

export class OpenCodeRuntimeManager {
  private entry: RuntimeEntry | null = null;
  private readonly runtimeStartedHandlers = new Set<(info: OpenCodeRuntimeInfo) => void>();
  private readonly runtimeStoppedHandlers = new Set<(runtimeKey: string) => void>();
  private initializePromise: Promise<void> | null = null;
  private inflightEnsure: Promise<OpenCodeRuntimeInfo> | null = null;

  onRuntimeStarted(handler: (info: OpenCodeRuntimeInfo) => void): () => void {
    this.runtimeStartedHandlers.add(handler);
    return () => { this.runtimeStartedHandlers.delete(handler); };
  }

  onRuntimeStopped(handler: (runtimeKey: string) => void): () => void {
    this.runtimeStoppedHandlers.add(handler);
    return () => { this.runtimeStoppedHandlers.delete(handler); };
  }

  private emitRuntimeStarted(info: OpenCodeRuntimeInfo): void {
    for (const handler of this.runtimeStartedHandlers) {
      try { handler(info); } catch { /* non-fatal */ }
    }
  }

  private emitRuntimeStopped(runtimeKey: string): void {
    for (const handler of this.runtimeStoppedHandlers) {
      try { handler(runtimeKey); } catch { /* non-fatal */ }
    }
  }

  listRuntimes(): OpenCodeRuntimeInfo[] {
    return this.entry ? [this.entry.info] : [];
  }

  async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.loadPersistedRuntime();
    }
    return this.initializePromise;
  }

  private async loadPersistedRuntime(): Promise<void> {
    const runtimes = await listStoredRuntimes();
    const runtime = runtimes[0];
    if (!runtime) {
      return;
    }
    const runtimeCwd = getRuntimeWorkingDirectory();
    if (!existsSync(runtimeCwd)) {
      await deleteStoredRuntime();
      return;
    }
    if (!(await checkHealth(runtime))) {
      await deleteStoredRuntime();
      return;
    }
    this.entry = {
      info: runtime,
      pid: runtime.pid,
    };
    this.emitRuntimeStarted(runtime);
  }

  private async forgetRuntime(): Promise<void> {
    const runtimeKey = this.entry?.info.runtimeKey ?? MACHINE_RUNTIME_KEY;
    this.entry = null;
    await deleteStoredRuntime();
    this.emitRuntimeStopped(runtimeKey);
  }

  async ensureWorkspaceRuntime(_target: OpenCodeRuntimeTarget): Promise<OpenCodeRuntimeInfo> {
    return this.ensureMachineRuntime();
  }

  async ensureMachineRuntime(): Promise<OpenCodeRuntimeInfo> {
    if (this.inflightEnsure) {
      return this.inflightEnsure;
    }
    const ensurePromise = this.ensureMachineRuntimeInternal().finally(() => {
      this.inflightEnsure = null;
    });
    this.inflightEnsure = ensurePromise;
    return ensurePromise;
  }

  private async ensureMachineRuntimeInternal(): Promise<OpenCodeRuntimeInfo> {
    await this.initialize();
    const existing = this.entry;
    if (existing) {
      const processRunning = existing.process ? existing.process.exitCode === null : true;
      if (processRunning && (await checkHealth(existing.info))) {
        writeAgentLog('opencode runtime reuse', { port: existing.info.port, pid: existing.pid });
        return existing.info;
      }

      if (existing.process) {
        try {
          existing.process.kill();
        } catch {
          // no-op
        }
      }
      await this.forgetRuntime();
    }

    const username = 'opencode';
    const password = createPassword();
    const runtimeCwd = getRuntimeWorkingDirectory();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = hashToPort(`${MACHINE_RUNTIME_KEY}:${attempt}`);
      const info: OpenCodeRuntimeInfo = {
        runtimeKey: MACHINE_RUNTIME_KEY,
        hostname: '127.0.0.1',
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        username,
        password,
        startedAt: new Date().toISOString(),
      };

      if (await isPortInUse(info.hostname, port)) {
        continue;
      }

      const spawn = getBunSpawn();
      writeAgentLog('opencode runtime spawn attempt', { attempt, port, cwd: runtimeCwd });
      const child = spawn({
        cmd: ['opencode', 'serve', '--hostname', '127.0.0.1', '--port', String(port)],
        cwd: runtimeCwd,
        env: {
          ...process.env,
          OPENCODE_SERVER_USERNAME: username,
          OPENCODE_SERVER_PASSWORD: password,
        },
        stdout: 'ignore',
        stderr: 'ignore',
      });

      try {
        await waitForHealthy(info);
        const storedRuntime: StoredOpenCodeRuntime = {
          ...info,
          pid: typeof child.pid === 'number' ? child.pid : undefined,
          lastSeenAt: new Date().toISOString(),
        };
        this.entry = { info: storedRuntime, process: child, pid: storedRuntime.pid };
        await writeStoredRuntime(storedRuntime);
        writeAgentLog('opencode runtime started', { port, pid: storedRuntime.pid });
        this.emitRuntimeStarted(storedRuntime);
        return storedRuntime;
      } catch (error) {
        writeAgentLog('opencode runtime failed', { attempt, port, error: error instanceof Error ? error.message : String(error) });
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

    throw new Error('Failed to start machine OpenCode runtime');
  }

  async getWorkspaceRuntime(_workspaceId: string): Promise<OpenCodeRuntimeInfo | null> {
    return this.getMachineRuntime();
  }

  async getMachineRuntime(): Promise<OpenCodeRuntimeInfo | null> {
    await this.initialize();
    const entry = this.entry;
    if (!entry) {
      return null;
    }
    if (entry.process && entry.process.exitCode !== null) {
      await this.forgetRuntime();
      return null;
    }
    if (!(await checkHealth(entry.info))) {
      await this.forgetRuntime();
      return null;
    }

    void writeStoredRuntime({
      ...entry.info,
      pid: entry.pid,
      lastSeenAt: new Date().toISOString(),
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[opencode-runtime] failed to persist runtime ${MACHINE_RUNTIME_KEY}: ${message}`);
    });

    return entry.info;
  }

  async shutdown(): Promise<void> {
    const entry = this.entry;
    if (!entry) {
      await deleteStoredRuntime();
      return;
    }
    if (entry.process) {
      try {
        if (typeof entry.process.pid === 'number') {
          try {
            process.kill(-entry.process.pid, 'SIGTERM');
          } catch {
            process.kill(entry.process.pid, 'SIGTERM');
          }
        } else {
          entry.process.kill();
        }
      } catch {
        // non-fatal
      }
    } else if (typeof entry.pid === 'number') {
      try {
        try {
          process.kill(-entry.pid, 'SIGTERM');
        } catch {
          process.kill(entry.pid, 'SIGTERM');
        }
      } catch {
        // non-fatal
      }
    }
    writeAgentLog('opencode runtime shutdown', { pid: entry.pid, port: entry.info.port });
    await this.forgetRuntime();
  }
}

export const defaultOpenCodeRuntimeManager = new OpenCodeRuntimeManager();

export { buildAuthenticatedOpenCodeUrl, createOpenCodeBasicAuthHeader };
