/**
 * Daemon-side client for the offload worker (see offload-worker.ts).
 *
 * One lazy, persistent child; respawned on next use if it dies. Every call is
 * an rpc with a deadline. Keeps heavy/network work (review ops → GitHub)
 * off the daemon event loop.
 */

import { fileURLToPath } from 'node:url';
import type { Subprocess } from 'bun';

const WORKER_SCRIPT = fileURLToPath(new URL('./offload-worker.ts', import.meta.url));
const DEFAULT_TIMEOUT_MS = 600_000;

function getOffloadCommand(): string[] {
  const isCompiled = !process.execPath.endsWith('bun');
  const cmd = isCompiled
    ? [process.execPath, '--internal-offload-worker']
    : ['bun', WORKER_SCRIPT];
  // Own session (Linux) — group-wide signals from either side don't cross.
  if (process.platform === 'linux' && Bun.which('setsid')) {
    return ['setsid', ...cmd];
  }
  return cmd;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let proc: Subprocess | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function ensureWorker(): Subprocess {
  if (proc) return proc;
  const spawned = Bun.spawn({
    cmd: getOffloadCommand(),
    env: process.env as Record<string, string>,
    stdout: 'inherit',
    stderr: 'inherit',
    ipc(rawMessage) {
      const msg = rawMessage as { t?: string; id?: number; ok?: boolean; result?: unknown; error?: string };
      if (msg?.t !== 'rpc-result' || typeof msg.id !== 'number') return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? 'offload op failed'));
    },
  });
  void spawned.exited.then((code) => {
    if (proc === spawned) proc = null;
    const detail = `offload worker exited (code ${code ?? 'unknown'})`;
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(detail));
    }
  });
  proc = spawned;
  return spawned;
}

/** Run an op in the offload worker. Respawns the worker if it died. */
export function runOffloaded<T>(op: string, payload: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const worker = ensureWorker();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`offload op '${op}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    try {
      worker.send({ t: 'rpc', id, op, payload });
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Daemon shutdown: kill the offload child (signal-handler safe). */
export function shutdownOffloadWorker(): void {
  if (!proc) return;
  try {
    proc.kill();
  } catch {
    /* already dead */
  }
  proc = null;
}
