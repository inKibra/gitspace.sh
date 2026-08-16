/**
 * Daemon ↔ agent-worker IPC protocol (Bun.spawn ipc — structured JSON both ways).
 *
 * One worker child process owns exactly one OMP AgentSession (a
 * LocalSessionHost). The daemon's WorkerSessionHost proxy forwards every
 * AgentSessionHost method as an RPC and receives the host's sinks
 * (events, dialog requests, UI events, terminal bytes) as push messages.
 *
 * All payloads are JSON-serializable — the same data already crosses the
 * daemon→client frame boundary today.
 */

import type { AgentEvent } from '../../../../agents/backend.js';
import type { HostUIDialogRequest, HostUIEvent } from '../host-ui-bridge.js';
import type { AgentReportPayload, SessionHostBoot, SessionHostTarget } from '../session-host.js';

/** Promise-returning AgentSessionHost methods forwardable as RPCs. */
export const WORKER_RPC_METHODS = [
  'prompt',
  'interrupt',
  'compact',
  'removeQueuedMessage',
  'setModel',
  'getControlInfo',
  'cycleRole',
  'applyRole',
  'setThinkingLevel',
  'getGoalMode',
  'setGoalMode',
  'shake',
  'setApprovalMode',
  'setSetting',
  'getTools',
  'getHistory',
  'navigateHistory',
  'getSessionTree',
  'readTranscriptRange',
  'listSessionCommands',
  'resolveDialog',
] as const;
export type WorkerRpcMethod = (typeof WORKER_RPC_METHODS)[number];

/** Fire-and-forget AgentSessionHost methods (no result, no ack). */
export const WORKER_CAST_METHODS = [
  'setEditorTextFromClient',
  'enableUI',
  'setTitle',
] as const;
export type WorkerCastMethod = (typeof WORKER_CAST_METHODS)[number];

// --- daemon → worker ---------------------------------------------------------

export type WorkerRequest =
  | {
      t: 'init';
      target: SessionHostTarget;
      boot: SessionHostBoot;
      enableUI: boolean;
    }
  | { t: 'rpc'; id: number; method: WorkerRpcMethod; args: unknown[] }
  | { t: 'cast'; method: WorkerCastMethod; args: unknown[] }
  /** Dispose the session and exit(0). */
  | { t: 'shutdown' };

// --- worker → daemon ---------------------------------------------------------

export type WorkerNotification =
  | { t: 'ready'; sessionId: string }
  | { t: 'init-error'; error: string }
  | { t: 'rpc-result'; id: number; ok: true; result: unknown }
  | { t: 'rpc-result'; id: number; ok: false; error: string }
  | { t: 'event'; event: AgentEvent }
  | { t: 'dialog-request'; request: HostUIDialogRequest }
  | { t: 'ui-event'; event: HostUIEvent }
  /** Agent invoked the SDK's report tool — route to the daemon's report pipeline. */
  | { t: 'agent-report'; payload: AgentReportPayload };

export function isWorkerRequest(msg: unknown): msg is WorkerRequest {
  return typeof msg === 'object' && msg !== null && typeof (msg as { t?: unknown }).t === 'string';
}

export function isWorkerNotification(msg: unknown): msg is WorkerNotification {
  return typeof msg === 'object' && msg !== null && typeof (msg as { t?: unknown }).t === 'string';
}
