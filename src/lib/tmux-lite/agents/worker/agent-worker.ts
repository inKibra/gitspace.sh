/**
 * Agent worker entrypoint — a child process that owns ONE OMP AgentSession.
 *
 * Spawned by WorkerSessionHost via Bun.spawn({ ipc }). Runs a LocalSessionHost
 * whose sinks serialize onto the IPC channel; incoming 'rpc'/'cast' messages
 * dispatch to the host by method name (allowlisted).
 *
 * Being the process's only top-level session means the SDK auto-creates a
 * dedicated AsyncJobManager here (background bash/task jobs work per agent),
 * and the SDK's process-global mutations (chdir, PI_CODING_AGENT_DIR env,
 * Settings/AgentRegistry singletons, postmortem exit handlers) are confined
 * to this process instead of racing across sessions in the daemon.
 */

// MUST be the first import: it populates PI_DOCS_EMBED, which the SDK captures
// at module scope the first time its docs-index is evaluated. Without it every
// agent we spawn gets a throwing `omp://` and cannot read the documentation of
// the harness it is running inside. See core/pi-docs-embed.ts.
import '../../../../core/pi-docs-embed-install.js';

import type { LocalSessionHost } from '../local-session-host.js';
import type { SessionHostSinks } from '../session-host.js';
import { raiseFileDescriptorLimitAtBoot } from '../../../../utils/rlimit.js';
import {
  WORKER_RPC_METHODS,
  WORKER_CAST_METHODS,
  isWorkerRequest,
  type WorkerNotification,
  type WorkerRequest,
} from './protocol.js';

// This worker spawns bash-tool children of its own; raise the fd limit here too
// (belt-and-suspenders on top of the daemon's inherited limit). Best-effort.
raiseFileDescriptorLimitAtBoot('agent-worker');

const RPC_METHODS = new Set<string>(WORKER_RPC_METHODS);
const CAST_METHODS = new Set<string>(WORKER_CAST_METHODS);

function send(msg: WorkerNotification): void {
  try {
    process.send?.(msg);
  } catch (err) {
    // The daemon is gone — nothing useful left to do in this process.
    console.error('[agent-worker] IPC send failed; exiting:', err);
    process.exit(1);
  }
}

let host: LocalSessionHost | null = null;
let initStarted = false;
let shuttingDown = false;

const sinks: SessionHostSinks = {
  onEvent: (event) => send({ t: 'event', event }),
  onDialogRequest: (request) => send({ t: 'dialog-request', request }),
  onUiEvent: (event) => send({ t: 'ui-event', event }),
  onAgentReport: (payload) => send({ t: 'agent-report', payload }),
};

async function handleInit(msg: Extract<WorkerRequest, { t: 'init' }>): Promise<void> {
  if (initStarted) {
    send({ t: 'init-error', error: 'duplicate init' });
    return;
  }
  initStarted = true;
  try {
    // Import lazily so the SDK's module-level side effects only run once we
    // actually boot (and never for a spawn that dies before init).
    const { LocalSessionHost: HostImpl } = await import('../local-session-host.js');
    host = await HostImpl.boot(msg.target, msg.boot, sinks, { enableUI: msg.enableUI });
    send({ t: 'ready', sessionId: host.sessionId });
  } catch (err) {
    send({ t: 'init-error', error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

async function handleRpc(msg: Extract<WorkerRequest, { t: 'rpc' }>): Promise<void> {
  if (!host) {
    send({ t: 'rpc-result', id: msg.id, ok: false, error: 'worker not initialized' });
    return;
  }
  if (!RPC_METHODS.has(msg.method)) {
    send({ t: 'rpc-result', id: msg.id, ok: false, error: `unknown rpc method: ${msg.method}` });
    return;
  }
  try {
    const fn = (host as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[msg.method];
    const result = await fn.apply(host, msg.args);
    send({ t: 'rpc-result', id: msg.id, ok: true, result: result ?? null });
  } catch (err) {
    send({ t: 'rpc-result', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function handleCast(msg: Extract<WorkerRequest, { t: 'cast' }>): void {
  if (!host || !CAST_METHODS.has(msg.method)) return;
  try {
    const fn = (host as unknown as Record<string, (...args: unknown[]) => unknown>)[msg.method];
    fn.apply(host, msg.args);
  } catch (err) {
    console.error(`[agent-worker] cast ${msg.method} failed:`, err);
  }
}

async function handleShutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await Promise.race([
      host?.dispose(),
      new Promise<void>((resolve) => setTimeout(resolve, 8000)),
    ]);
  } catch (err) {
    console.error('[agent-worker] dispose during shutdown failed:', err);
  }
  process.exit(0);
}

process.on('message', (raw: unknown) => {
  if (!isWorkerRequest(raw)) return;
  switch (raw.t) {
    case 'init':
      void handleInit(raw);
      return;
    case 'rpc':
      void handleRpc(raw);
      return;
    case 'cast':
      handleCast(raw);
      return;
    case 'shutdown':
      void handleShutdown();
      return;
  }
});

// If the daemon dies, the IPC channel closes — exit rather than orphan the
// session process.
process.on('disconnect', () => {
  console.error('[agent-worker] daemon disconnected; exiting');
  process.exit(1);
});

// No ppid polling: 'disconnect' above is fd-driven, so it fires for a daemon
// that exited gracefully, was SIGTERMed, or was SIGKILLed — measured at ~80ms
// for SIGKILL. If this worker is blocked in synchronous work the event is
// QUEUED, not lost, and lands the instant the thread yields. A ppid poll adds
// nothing: its own callback needs the same event loop, so it cannot run in any
// situation where 'disconnect' cannot be delivered.

console.log(`[agent-worker] started pid=${process.pid}`);
