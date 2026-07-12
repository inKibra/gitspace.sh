/**
 * Remote session handler - processes browse and PTY commands
 *
 * Handles the encrypted messages between client and machine after X3DH handshake.
 */

import { executeSpaceCommand } from '../tmux-lite/agents/extensions/space-command.js';
import { parseCommandArgs } from '@oh-my-pi/pi-coding-agent/utils/command-args';
const importExecModule = () => import('@oh-my-pi/pi-coding-agent/exec/exec');
import { createFrame, openFrame } from "../tmux-lite/crypto/frames";
import { scanWorkspaces } from "./workspace-scanner";
import {
  parseRemoteMessage,
  serializeRemoteMessage,
  type ClientToMachineMessage,
  type MachineToClientMessage,
  type RemoteOperationKind,
  type RemoteOperationRecord,
  type RemoteOperationScope,
} from "./protocol";
import type { MachineSnapshot } from "../tmux-lite/machine/protocol.js";
import { applyMachineEventToSnapshot } from '../tmux-lite/machine/snapshot-patch.js';
import type { SessionKeys, AccessType } from "../../types/identity.js";

// Import tmux-lite API for session management
import {
  listSessions,
  send as sendTmuxCommand,
  prepareAttachSession,
  cancelPrepareAttachSession,
  deleteTmuxWorkspace,
  isServerRunning,
  ensureServer,
  watchMachineEvents,
  type Session,
} from "../tmux-lite/cli";
import { dispatchInProcess, hasInProcessDispatcher } from '../tmux-lite/command-dispatch.js';
import { addWorkspaceNote, listWorkspaceNotes, removeWorkspaceNote, updateWorkspaceNote } from '../../core/workspace-metadata.js';

// Import project loading / workspace operations
import { prepareWorkspaceForSession, rerunWorkspaceScriptsForSession } from "../../core/workspace-lifecycle";
import { readProjectConfig } from '../../core/config.js';
import { matchesWorkspaceId } from '../../utils/workspace-id.js';

import {
  listReplaysOffline,
  getReplayFrameOffline,
  getReplayTimelineOffline,
  dismissReplayOffline,
  undismissReplayOffline,
} from '../tmux-lite/replay/service.js';
import type { ReplayFrame } from '../tmux-lite/replay/types.js';
import { readReplayManifest } from '../tmux-lite/replay/store.js';
// Process imports

import { logger } from "../../utils/logger.js";
import { writeTraceLog } from '../../utils/trace-log.js';
import type { Command as TmuxCommand, Response as TmuxResponse } from '../tmux-lite/protocol.js';

const BOUNDED_RPC_TIMEOUT_MS = 15_000;



const TERMINAL_OPERATION_RETENTION_LIMIT = 100;

function isTerminalOperation(operation: RemoteOperationRecord): boolean {
  return operation.state !== 'running';
}

function operationTimeoutMs(kind: RemoteOperationKind): number {
  switch (kind) {
    case 'workspace.editor.open':
      return 2 * 60 * 1000;
    case 'space.command':
    case 'review.github':
      return 10 * 60 * 1000;
    case 'project.create':
    case 'project.prepare':
    case 'project.finalize':
    case 'project.delete':
    case 'workspace.create':
    case 'workspace.delete':
    case 'workspace.scripts':
      return 30 * 60 * 1000;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(message) as Error & { code?: string };
          error.code = 'OPERATION_TIMEOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
/**
 * Session state for a connected client
 */
export type ClientState = "browsing" | "attached";

export interface RemoteClientSession {
  connectionId: string;
  state: ClientState;
  sessionKeys: SessionKeys;
  /** Access type granted to this client */
  accessType?: AccessType;
  /** For view: the specific session ID access was granted to */
  grantedSessionId?: string;
  /** Attached tmux-lite session ID (set after attach_session target resolution) */
  attachedSessionId?: string;
  /** Human-readable session name for attach lifecycle events */
  attachedSessionName?: string;
  /** Path to tmux-lite session socket (set after attach_session) */
  sessionSocketPath?: string;
  /** Initial terminal size requested by the client before attach-init is sent */
  initialCols?: number;
  initialRows?: number;
  streamId?: number;
  /** When true, PTY writes from this client are blocked server-side */
  viewOnly?: boolean;
}

type ReplaySessionAccessTarget = {
  sessionId: string;
};

// ============================================================================
// Permission Helpers
// ============================================================================

/**
 * Check if access type grants management permission
 */
function canManage(accessType: AccessType | undefined): boolean {
  return accessType === 'full';
}

/**
 * Check if client can attach to a specific session
 */
function canAttachSession(
  accessType: AccessType | undefined,
  grantedSessionId: string | undefined,
  targetSessionId: string
): boolean {
  if (accessType === 'full') return true;
  if (accessType === 'view') {
    return grantedSessionId === targetSessionId;
  }
  return false;
}

export function canAccessReplayForSession(
  accessType: AccessType | undefined,
  grantedSessionId: string | undefined,
  replay: ReplaySessionAccessTarget,
): boolean {
  return canAttachSession(accessType, grantedSessionId, replay.sessionId);
}

export function filterReplaysForSessionAccess<T extends ReplaySessionAccessTarget>(
  accessType: AccessType | undefined,
  grantedSessionId: string | undefined,
  replays: T[],
): T[] {
  if (accessType === 'full') {
    return replays;
  }
  if (accessType !== 'view') {
    return [];
  }
  if (!grantedSessionId) {
    return [];
  }
  return replays.filter((replay) => replay.sessionId === grantedSessionId);
}

function isAgentReplay(replay: { sessionName: string }): boolean {
  return replay.sessionName.startsWith('agent:');
}





/**
 * Remote session handler
 */
export class RemoteSessionHandler {
  private tmuxLiteAvailable = false;
  private processSchedulers = new Map<string, NodeJS.Timer>();
  private pendingAttachRuns = new Map<string, string>();
  private operations = new Map<string, RemoteOperationRecord>();
  private dismissedOperationIdsByConnection = new Map<string, Set<string>>();

  // Machine snapshot push state
  private latestMachineSnapshot: MachineSnapshot | null = null;
  private machineWatchUnsubscribe: (() => void) | null = null;
  /** connectionId → async send function for unsolicited machine snapshot pushes */
  private machineSnapshotWatchers = new Map<string, (msg: MachineToClientMessage) => Promise<void>>();
  /** Connections that opted into scoped machine deltas (`watch_machine_events`).
   *  Legacy clients stay on full machine_snapshot pushes. */
  private machineDeltaConnectionIds = new Set<string>();
  /** Periodic timer that fetches fresh snapshots for client reconciliation */
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private machineSnapshotRefreshInFlight: Promise<void> | null = null;


  /**
   * Initialize - check if tmux-lite is available and start machine event watch
   */
  async initialize(): Promise<void> {
    try {
      this.tmuxLiteAvailable = await isServerRunning();
      if (!this.tmuxLiteAvailable) {
        // Try to start the server
        await ensureServer();
        this.tmuxLiteAvailable = true;
      }
    } catch (e) {
      console.warn("[remote-session] tmux-lite not available:", e);
      this.tmuxLiteAvailable = false;
    }

    if (this.tmuxLiteAvailable) {
      await this.startMachineWatch();
      // Fetch a fresh snapshot every 30 s so clients that missed an update can
      // reconcile even if a previous post-operation refresh failed.
      this.reconciliationTimer = setInterval(() => {
        void this.refreshMachineSnapshot('periodic-reconciliation');
      }, 30000);
    }  // end if (this.tmuxLiteAvailable)
  }

  /**
   * Start watching machine events from tmux-lite.
   * Keeps the latest snapshot and broadcasts to all watching remote clients.
   */
  private async startMachineWatch(): Promise<void> {
    try {
      const unsubscribe = await watchMachineEvents({
        onSnapshot: (snapshot) => {
          this.latestMachineSnapshot = snapshot;
          void this.broadcastMachineSnapshot({ type: 'machine_snapshot', snapshot });
        },
        onEvent: (event) => {
          if (event.type === 'snapshot-replaced') {
            this.latestMachineSnapshot = event.snapshot;
            // A replacement resets every client's baseline — full push to all.
            void this.broadcastMachineSnapshot({ type: 'machine_snapshot', snapshot: event.snapshot });
            return;
          }
          if (!this.latestMachineSnapshot) return;
          // Contiguity: scoped deltas carry consecutive nonces. A gap means we
          // missed events — refetch (and re-baseline every client) instead of
          // applying onto diverged state.
          if (event.snapshotNonce !== this.latestMachineSnapshot.snapshotNonce + 1) {
            void this.refreshMachineSnapshot('nonce-gap');
            return;
          }
          this.latestMachineSnapshot = applyMachineEventToSnapshot(this.latestMachineSnapshot, event);
          void this.broadcastMachineDelta(event);
        },
        onError: (error) => {
          console.warn('[remote-session] Machine watch error:', error.message);
          this.machineWatchUnsubscribe = null;
          if (this.machineSnapshotWatchers.size > 0) {
            setTimeout(() => {
              if (!this.machineWatchUnsubscribe && this.machineSnapshotWatchers.size > 0) {
                void this.startMachineWatch();
              }
            }, 250);
          }
        },
      });
      this.machineWatchUnsubscribe = unsubscribe;
    } catch (e) {
      console.warn('[remote-session] Could not start machine watch:', e);
    }
  }

  /**
   * Register a browsing client to receive unsolicited machine snapshot pushes.
   * Immediately sends the current snapshot if available.
   */
  async onClientEntersBrowsing(
    connectionId: string,
    sendMessage: (msg: MachineToClientMessage) => Promise<void>,
  ): Promise<void> {
    this.machineSnapshotWatchers.set(connectionId, sendMessage);
    // Push current snapshot immediately so the client doesn't need to poll
    if (this.latestMachineSnapshot) {
      try {
        await sendMessage({ type: 'machine_snapshot', snapshot: this.latestMachineSnapshot });
      } catch {
        // Non-fatal — client may disconnect
      }
    }
    await this.broadcastOperationSnapshot(connectionId);
  }

  /**
   * Unregister a client from machine snapshot pushes.
   */
  onClientLeavesBrowsing(connectionId: string): void {
    this.machineSnapshotWatchers.delete(connectionId);
    this.machineDeltaConnectionIds.delete(connectionId);
  }

  private async broadcastMachineSnapshot(msg: { type: 'machine_snapshot'; snapshot: MachineSnapshot }): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const sendFn of this.machineSnapshotWatchers.values()) {
      promises.push(sendFn(msg).catch(() => undefined));
    }
    await Promise.allSettled(promises);
  }

  /** Scoped delta fan-out: machine_event to opted-in clients, full snapshot
   *  to legacy clients (old web bundles keep working unchanged). */
  private async broadcastMachineDelta(event: import('../tmux-lite/machine/protocol.js').MachineEvent): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [connectionId, sendFn] of this.machineSnapshotWatchers) {
      if (this.machineDeltaConnectionIds.has(connectionId)) {
        promises.push(sendFn({ type: 'machine_event', event }).catch(() => undefined));
      } else if (this.latestMachineSnapshot) {
        promises.push(sendFn({ type: 'machine_snapshot', snapshot: this.latestMachineSnapshot }).catch(() => undefined));
      }
    }
    await Promise.allSettled(promises);
  }

  private async refreshMachineSnapshot(reason: string): Promise<void> {
    if (this.machineSnapshotRefreshInFlight) {
      await this.machineSnapshotRefreshInFlight;
      return;
    }

    const refreshPromise = (async () => {
      try {
        const response = await withTimeout(
          sendTmuxCommand({ type: 'machine-snapshot' }),
          BOUNDED_RPC_TIMEOUT_MS,
          `Timed out refreshing machine snapshot (${reason})`,
        );
        if (response.type !== 'machine-snapshot') {
          throw new Error(response.type === 'error' ? response.message : `Unexpected machine snapshot response (${response.type})`);
        }
        const snapshot = response.snapshot;
        const previousNonce = this.latestMachineSnapshot?.snapshotNonce;
        this.latestMachineSnapshot = snapshot;
        // Reconciliation no-op: identical nonce means every watcher already
        // has this state — don't re-send the full snapshot to everyone.
        if (reason === 'periodic-reconciliation' && previousNonce === snapshot.snapshotNonce) {
          return;
        }
        await this.broadcastMachineSnapshot({ type: 'machine_snapshot', snapshot });
      } catch (error) {
        console.warn(`[remote-session] Failed to refresh machine snapshot (${reason}): ${error instanceof Error ? error.message : String(error)}`);
      }
    })();

    this.machineSnapshotRefreshInFlight = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      if (this.machineSnapshotRefreshInFlight === refreshPromise) {
        this.machineSnapshotRefreshInFlight = null;
      }
    }
  }

  private retainedOperationsForConnection(connectionId?: string): RemoteOperationRecord[] {
    const dismissed = connectionId ? this.dismissedOperationIdsByConnection.get(connectionId) : undefined;
    return [...this.operations.values()].filter((operation) => {
      return !(dismissed?.has(operation.operationId) && isTerminalOperation(operation));
    });
  }

  private async broadcastOperationSnapshot(connectionId?: string): Promise<void> {
    const message: MachineToClientMessage = {
      type: 'operation_snapshot',
      operations: this.retainedOperationsForConnection(connectionId),
    };
    if (connectionId) {
      const sendFn = this.machineSnapshotWatchers.get(connectionId);
      if (sendFn) await sendFn(message).catch(() => undefined);
      return;
    }
    const promises: Promise<void>[] = [];
    for (const sendFn of this.machineSnapshotWatchers.values()) {
      promises.push(sendFn(message).catch(() => undefined));
    }
    await Promise.allSettled(promises);
  }

  private async broadcastOperationEvent(operation: RemoteOperationRecord, type: import('./protocol.js').RemoteOperationEventType): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [connectionId, sendFn] of this.machineSnapshotWatchers.entries()) {
      if (isTerminalOperation(operation) && this.dismissedOperationIdsByConnection.get(connectionId)?.has(operation.operationId)) {
        continue;
      }
      const message: MachineToClientMessage = {
        type: 'operation_event',
        event: { type, operation },
      };
      promises.push(sendFn(message).catch(() => undefined));
    }
    await Promise.allSettled(promises);
  }

  private pruneTerminalOperations(): void {
    const terminalOperations = [...this.operations.values()]
      .filter(isTerminalOperation)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const operation of terminalOperations.slice(TERMINAL_OPERATION_RETENTION_LIMIT)) {
      this.operations.delete(operation.operationId);
      for (const dismissed of this.dismissedOperationIdsByConnection.values()) {
        dismissed.delete(operation.operationId);
      }
    }
  }


  private appendBase64Output(existing: string | undefined, chunk: string): string {
    if (!existing) return chunk;
    if (!chunk) return existing;
    return Buffer.concat([Buffer.from(existing, 'base64'), Buffer.from(chunk, 'base64')]).toString('base64');
  }

  /** Commands whose server handlers bind the CALLING SOCKET (transcript
   *  ownership) — they must keep riding the unix socket even in-process,
   *  or the daemon answers 'Unknown command' (the exact 'invalid command'
   *  users see when opening an agent pane). */
  private static readonly SOCKET_COUPLED_COMMANDS = new Set(['agent-attach', 'agent-dialog-response']);

  private async sendBoundedTmuxCommand(command: TmuxCommand): Promise<TmuxResponse> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      // Daemon-unification P3: the session-handler runs INSIDE the daemon —
      // dispatch directly when the server has registered (always, in the
      // unified topology). Socket-coupled commands keep the socket path so
      // their ownership binding lands on cli's persistent connection, same
      // as pre-P3. The timeout guard applies to both.
      const useDispatch = hasInProcessDispatcher() && !RemoteSessionHandler.SOCKET_COUPLED_COMMANDS.has(command.type);
      const invoke = useDispatch ? dispatchInProcess(command) : sendTmuxCommand(command);
      return await Promise.race([
        invoke,
        new Promise<TmuxResponse>((resolve) => {
          timeout = setTimeout(() => {
            resolve({ type: 'error', message: `Timed out waiting for command response (${command.type})` });
          }, BOUNDED_RPC_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private startOperationWatchdog(operationId: string, kind: RemoteOperationKind): () => void {
    const timeout = setTimeout(() => {
      const current = this.operations.get(operationId);
      if (!current || current.state !== 'running') return;
      this.updateOperation(operationId, {
        state: 'failed',
        phase: 'timeout',
        message: `Operation timed out (${kind})`,
        error: { code: 'OPERATION_TIMEOUT', message: `Operation timed out (${kind})` },
      }, 'operation_failed');
    }, operationTimeoutMs(kind));
    return () => clearTimeout(timeout);
  }
  private createOperation(params: {
    operationId?: string;
    kind: RemoteOperationKind;
    scope: RemoteOperationScope;
    phase?: string;
    message?: string;
  }): RemoteOperationRecord {
    const now = Date.now();
    const operation: RemoteOperationRecord = {
      operationId: params.operationId ?? crypto.randomUUID(),
      kind: params.kind,
      scope: params.scope,
      state: 'running',
      phase: params.phase,
      message: params.message,
      startedAt: now,
      updatedAt: now,
    };
    this.operations.set(operation.operationId, operation);
    void this.broadcastOperationEvent(operation, 'operation_started');
    return operation;
  }

  private updateOperation(operationId: string, patch: Partial<RemoteOperationRecord>, eventType: import('./protocol.js').RemoteOperationEventType = 'operation_progress'): RemoteOperationRecord | null {
    const current = this.operations.get(operationId);
    if (!current) return null;
    if (current.state !== 'running') return current;
    const next: RemoteOperationRecord = {
      ...current,
      ...patch,
      scope: patch.scope ?? current.scope,
      updatedAt: Date.now(),
    };
    this.operations.set(operationId, next);
    void this.broadcastOperationEvent(next, eventType);
    if (isTerminalOperation(next)) {
      this.pruneTerminalOperations();
    }
    return next;
  }

  private async sendOperationAccepted(
    session: RemoteClientSession,
    sendResponse: (data: Uint8Array) => void,
    requestId: string,
    operation: RemoteOperationRecord,
  ): Promise<void> {
    await this.sendMessage(session, sendResponse, {
      type: 'operation_accepted',
      requestId,
      operation,
    });
  }

  private async handleDismissOperation(
    session: RemoteClientSession,
    operationId: string,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    const current = this.operations.get(operationId);
    if (!current || isTerminalOperation(current)) {
      let dismissed = this.dismissedOperationIdsByConnection.get(session.connectionId);
      if (!dismissed) {
        dismissed = new Set<string>();
        this.dismissedOperationIdsByConnection.set(session.connectionId, dismissed);
      }
      dismissed.add(operationId);
    }
    this.pruneTerminalOperations();

    await this.sendMessage(session, sendResponse, {
      type: 'operation_dismissed',
      operationId,
    });
  }


  private async startWorkspaceScriptOperation(
    session: RemoteClientSession,
    sendResponse: (data: Uint8Array) => void,
    params: {
      requestId: string;
      projectName: string;
      workspaceId: string;
      selection: 'setup' | 'select' | 'setup-select';
      mode: 'rerun' | 'open';
    },
  ): Promise<void> {
    const workspaces = await scanWorkspaces();
    const workspace = workspaces.find(
      (item) =>
        item.projectName === params.projectName &&
        matchesWorkspaceId(item, params.workspaceId)
    );
    if (!workspace) {
      await this.sendError(session, sendResponse, 'WORKSPACE_NOT_FOUND', `Workspace not found: ${params.workspaceId}`, { requestId: params.requestId });
      return;
    }

    const workspaceId = `${params.projectName}:${workspace.id}`;
    let currentPhase: import('../../types/script-phase.js').WorkspaceScriptPhase =
      params.mode === 'open' || params.selection === 'select' ? 'select' : 'setup';
    const operation = this.createOperation({
      operationId: params.requestId,
      kind: 'workspace.scripts',
      scope: { projectName: params.projectName, workspaceId, workspaceName: workspace.id },
      phase: currentPhase,
      message: params.mode === 'open' ? 'Opening workspace...' : `Running ${params.selection} scripts...`,
    });
    await this.sendOperationAccepted(session, sendResponse, params.requestId, operation);
    const stopWatchdog = this.startOperationWatchdog(operation.operationId, operation.kind);

    void (async () => {
      try {
        const runOptions = {
          projectName: params.projectName,
          workspacePath: workspace.path,
          workspaceName: workspace.id,
          repository: readProjectConfig(params.projectName).repository,
          interactiveScripts: false as const,
          onOutput: (data: Uint8Array) => {
            const outputBase64 = Buffer.from(data).toString('base64');
            this.updateOperation(operation.operationId, {
              phase: currentPhase,
              message: `Running ${currentPhase} scripts...`,
              outputBase64: this.appendBase64Output(this.operations.get(operation.operationId)?.outputBase64, outputBase64),
            }, 'operation_output');
            void this.sendMessage(session, sendResponse, {
              type: 'script_output',
              phase: currentPhase,
              data: outputBase64,
              workspaceId,
            }).catch(() => undefined);
          },
          onPhaseStart: (phase: import('../../types/script-phase.js').WorkspaceScriptPhase) => {
            currentPhase = phase;
            this.updateOperation(operation.operationId, {
              phase,
              message: `Running ${phase} scripts...`,
            });
            void this.sendMessage(session, sendResponse, {
              type: 'script_output',
              phase,
              data: '',
              workspaceId,
            }).catch(() => undefined);
          },
        };
        const result = await withTimeout(
          params.mode === 'open'
            ? prepareWorkspaceForSession(runOptions)
            : rerunWorkspaceScriptsForSession({ ...runOptions, selection: params.selection }),
          operationTimeoutMs(operation.kind),
          `Operation timed out (${operation.kind})`,
        );
        if (!result.success) {
          const error = { code: `${result.phase.toUpperCase()}_SCRIPT_FAILED`, message: result.error };
          this.updateOperation(operation.operationId, {
            state: 'failed',
            phase: result.phase,
            message: result.error,
            error,
          }, 'operation_failed');
          await this.sendMessage(session, sendResponse, {
            type: 'script_output',
            phase: result.phase,
            data: '',
            done: true,
            error: result.error,
            workspaceId,
          });
          return;
        }
        this.updateOperation(operation.operationId, {
          state: 'succeeded',
          phase: currentPhase,
          message: 'Workspace scripts complete',
          result: { type: 'ok' },
        }, 'operation_succeeded');
        await this.sendMessage(session, sendResponse, {
          type: 'script_output',
          phase: currentPhase,
          data: '',
          done: true,
          workspaceId,
        });
      } catch (error) {
        const typedError = error instanceof Error ? error as Error & { code?: string } : undefined;
        const message = typedError?.message ?? String(error);
        this.updateOperation(operation.operationId, {
          state: 'failed',
          phase: currentPhase,
          message,
          error: { code: typedError?.code, message },
        }, 'operation_failed');
        await this.sendMessage(session, sendResponse, {
          type: 'script_output',
          phase: currentPhase,
          data: '',
          done: true,
          error: message,
          workspaceId,
        }).catch(() => undefined);
      } finally {
        stopWatchdog();
      }
    })();
  }

  private async startTmuxCommandOperation(
    session: RemoteClientSession,
    sendResponse: (data: Uint8Array) => void,
    params: {
      requestId: string;
      kind: RemoteOperationKind;
      scope: RemoteOperationScope;
      command: TmuxCommand;
      phase?: string;
      message?: string;
      refreshMachineSnapshot?: boolean;
    },
  ): Promise<void> {
    const operation = this.createOperation({
      operationId: params.requestId,
      kind: params.kind,
      scope: params.scope,
      phase: params.phase,
      message: params.message,
    });
    await this.sendOperationAccepted(session, sendResponse, params.requestId, operation);
    const stopWatchdog = this.startOperationWatchdog(operation.operationId, operation.kind);

    void (async () => {
      try {
        // The handler already validated tmux-lite availability during initialize().
        // Avoid ensureServer() here: it performs an unbounded agent-state RPC,
        // which can wedge operation responses when tmux-lite is busy.
        const response = await withTimeout(
          sendTmuxCommand(params.command),
          operationTimeoutMs(operation.kind),
          `Operation timed out (${operation.kind})`,
        );
        if (response.type === 'error') {
          this.updateOperation(operation.operationId, {
            state: 'failed',
            message: response.message,
            error: { code: response.code, message: response.message },
            result: response,
          }, 'operation_failed');
          return;
        }
        this.updateOperation(operation.operationId, {
          state: 'succeeded',
          message: params.message ? `${params.message} complete` : 'Operation complete',
          result: response,
        }, 'operation_succeeded');
        if (params.refreshMachineSnapshot) {
          await this.refreshMachineSnapshot(`${params.kind}:${operation.operationId}`);
        }
      } catch (error) {
        const typedError = error instanceof Error ? error as Error & { code?: string } : undefined;
        const message = typedError?.message ?? String(error);
        this.updateOperation(operation.operationId, {
          state: 'failed',
          message,
          error: { code: typedError?.code, message },
        }, 'operation_failed');
      } finally {
        stopWatchdog();
      }
    })();
  }

  /**
   * Handle an encrypted message from a client
   *
   * @param session - Client session info
   * @param encryptedData - Encrypted frame data
   * @param sendResponse - Callback to send encrypted response
   */
  async handleMessage(
    session: RemoteClientSession,
    encryptedData: Uint8Array,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      // Decrypt the frame
      const frame = await openFrame(encryptedData, session.sessionKeys.receiveKey);
      if (!frame) {
        console.error("[remote-session] Failed to decrypt frame");
        return;
      }

      // Parse as JSON message
      const json = new TextDecoder().decode(frame.data);
      const msg = parseRemoteMessage(json);

      if (!msg) {
        console.error("[remote-session] Failed to parse message");
        return;
      }

      // Handle based on message type
      await this.processMessage(session, msg as ClientToMachineMessage, sendResponse);
    } catch (e) {
      console.error("[remote-session] Error handling message:", e);
      await this.sendError(session, sendResponse, "INTERNAL_ERROR", "Failed to process message");
    }
  }

  /**
   * Process a client message
   */
  private async processMessage(
    session: RemoteClientSession,
    msg: ClientToMachineMessage,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    switch (msg.type) {
      case 'list_replays':
        await this.handleListReplays(session, msg.workspaceId, msg.includeDismissed, sendResponse);
        break;

      case 'get_replay_frame':
        await this.handleGetReplayFrame(session, msg.replayId, msg.requestId, msg.atMs, msg.atSeq, sendResponse);
        break;

      case 'get_replay_timeline':
        await this.handleGetReplayTimeline(session, msg.replayId, sendResponse);
        break;

      case 'dismiss_replay':
        await this.handleDismissReplay(session, msg.replayId, sendResponse);
        break;

      case 'undismiss_replay':
        await this.handleUndismissReplay(session, msg.replayId, sendResponse);
        break;

      case 'dismiss_operation':
        await this.handleDismissOperation(session, msg.operationId, sendResponse);
        break;

      case "attach_session":
        // Permission check for attach_session is done in handleAttachSession
        // because it depends on whether creating new session or attaching existing
        await this.handleAttachSession(session, msg, sendResponse);
        break;

      case 'cancel_pending_attach':
        await this.handleCancelPendingAttach(session, sendResponse);
        break;

      // Note: resize, detach, and pty_input are handled in attached mode
      // via client-session-manager using tmux-lite's SessionCtrl protocol,
      // not through this JSON-RPC handler.

      case "delete_workspace":
        // Security: Requires management permission
        if (!canManage(session.accessType)) {
          const normalizedWorkspaceId = msg.workspaceId.startsWith(`${msg.projectName}:`)
            ? msg.workspaceId.slice(msg.projectName.length + 1)
            : msg.workspaceId;
          await this.sendError(
            session,
            sendResponse,
            "PERMISSION_DENIED",
            "Requires full access to delete workspaces",
            { workspaceId: `${msg.projectName}:${normalizedWorkspaceId}`, requestId: msg.requestId }
          );
          return;
        }
        await this.handleDeleteWorkspace(
          session,
          msg.requestId,
          msg.projectName,
          msg.workspaceId,
          msg.scriptPolicy,
          sendResponse
        );
        break;

      case 'list_github_repos':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'github-repos',
          org: msg.org,
        }, sendResponse);
        break;

      case 'list_remote_branches':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'remote-branches',
          projectName: msg.projectName,
        }, sendResponse);
        break;

      case 'list_linear_issues':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'linear-issues',
          projectName: msg.projectName,
        }, sendResponse);
        break;

      case 'create_project':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.startTmuxCommandOperation(session, sendResponse, {
          requestId: msg.requestId,
          kind: 'project.create',
          scope: { projectName: msg.projectName },
          command: {
            type: 'project-create',
            repository: msg.repository,
            projectName: msg.projectName,
            baseBranch: msg.baseBranch,
            setCurrent: msg.setCurrent,
            scratch: msg.scratch,
          },
          message: 'Creating project',
          refreshMachineSnapshot: true,
        });
        break;

      case 'prepare_project_creation':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.startTmuxCommandOperation(session, sendResponse, {
          requestId: msg.requestId,
          kind: 'project.prepare',
          scope: { projectName: msg.projectName },
          command: {
            type: 'project-prepare',
            repository: msg.repository,
            projectName: msg.projectName,
            baseBranch: msg.baseBranch,
            setCurrent: msg.setCurrent,
          },
          message: 'Preparing project',
          refreshMachineSnapshot: true,
        });
        break;

      case 'finalize_project_creation':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.startTmuxCommandOperation(session, sendResponse, {
          requestId: msg.requestId,
          kind: 'project.finalize',
          scope: { projectName: msg.projectName },
          command: {
            type: 'project-finalize',
            projectName: msg.projectName,
            repository: msg.repository,
            baseBranch: msg.baseBranch,
            bundle: msg.bundle,
            inputValues: msg.inputValues,
            secretValues: msg.secretValues,
            confirmResults: msg.confirmResults,
            setCurrent: msg.setCurrent,
          },
          message: 'Finalizing project',
          refreshMachineSnapshot: true,
        });
        break;

      case 'cancel_project_creation':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'project-cancel',
          projectName: msg.projectName,
        }, sendResponse);
        break;

      case 'delete_project':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.startTmuxCommandOperation(session, sendResponse, {
          requestId: msg.requestId,
          kind: 'project.delete',
          scope: { projectName: msg.projectName },
          command: {
            type: 'project-delete',
            projectName: msg.projectName,
          },
          message: 'Deleting project',
          refreshMachineSnapshot: true,
        });
        break;

      case 'create_workspace':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.startTmuxCommandOperation(session, sendResponse, {
          requestId: msg.requestId,
          kind: 'workspace.create',
          scope: { projectName: msg.projectName, workspaceName: msg.workspaceName, workspaceId: `${msg.projectName}:${msg.workspaceName}` },
          command: {
            type: 'workspace-create',
            projectName: msg.projectName,
            workspaceName: msg.workspaceName,
            branchName: msg.branchName,
            baseBranch: msg.baseBranch,
            parentWorkspaceName: msg.parentWorkspaceName,
            workspaceSource: msg.workspaceSource,
            linearIssue: msg.linearIssue,
            githubIssueNumber: msg.githubIssueNumber,
          },
          message: 'Creating workspace',
          refreshMachineSnapshot: true,
        });
        break;

      case 'refresh_machine_snapshot':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        try {
          await this.refreshMachineSnapshot('client-request');
          const snapshot = this.latestMachineSnapshot;
          if (!snapshot) {
            await this.sendError(session, sendResponse, 'UNAVAILABLE', 'Machine snapshot unavailable', { requestId: msg.requestId });
            break;
          }
          await this.sendMessage(session, sendResponse, {
            type: 'refresh_machine_snapshot',
            requestId: msg.requestId,
            snapshot,
          });
        } catch (error) {
          await this.sendError(session, sendResponse, 'UNAVAILABLE', error instanceof Error ? error.message : String(error), { requestId: msg.requestId });
        }
        break;

      case 'watch_machine_events':
        // Opt in to scoped machine deltas (ticket #3). Reply with a full
        // snapshot as the nonce baseline; machine_event pushes follow.
        try {
          this.machineDeltaConnectionIds.add(session.connectionId);
          if (!this.latestMachineSnapshot) {
            await this.refreshMachineSnapshot('watch-machine-events');
          }
          const snapshot = this.latestMachineSnapshot;
          if (!snapshot) {
            this.machineDeltaConnectionIds.delete(session.connectionId);
            await this.sendError(session, sendResponse, 'UNAVAILABLE', 'Machine snapshot unavailable', { requestId: msg.requestId });
            break;
          }
          await this.sendMessage(session, sendResponse, {
            type: 'refresh_machine_snapshot',
            requestId: msg.requestId,
            snapshot,
          });
        } catch (error) {
          this.machineDeltaConnectionIds.delete(session.connectionId);
          await this.sendError(session, sendResponse, 'UNAVAILABLE', error instanceof Error ? error.message : String(error), { requestId: msg.requestId });
        }
        break;

      case 'preview_workspace_phase':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'workspace-phase-preview',
          projectName: msg.projectName,
          workspaceName: msg.workspaceName,
          phase: msg.phase,
        }, sendResponse);
        break;

      case 'set_workspace_phase':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'workspace-set-phase',
          projectName: msg.projectName,
          workspaceName: msg.workspaceName,
          phase: msg.phase,
          cascade: msg.cascade,
        }, sendResponse);
        break;


      case 'goal_add_near_workspace':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'goal-add-near-workspace',
          projectName: msg.projectName,
          workspaceName: msg.workspaceName,
          title: msg.title,
          position: msg.position,
        }, sendResponse);
        break;
      case 'goal_update':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'goal-update',
          projectName: msg.projectName,
          goalId: msg.goalId,
          updates: msg.updates,
        }, sendResponse);
        break;

      case 'get_goal_detail':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'goal-detail',
          projectName: msg.projectName,
          goalId: msg.goalId,
        }, sendResponse);
        break;

      case 'goal_reorder':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'goal-reorder',
          projectName: msg.projectName,
          sourceToken: msg.sourceToken,
          targetToken: msg.targetToken,
          position: msg.position,
        }, sendResponse);
        break;

      case 'goal_stack_status':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'goal-stack-status',
          projectName: msg.projectName,
          workspaceName: msg.workspaceName,
        }, sendResponse);
        break;

      case 'goal_gate_waive':
        // Human-only gate waive: only a managing HUMAN client reaches this
        // seam (UI button) — agents have no CLI path to it.
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'goal-gate-waive',
          projectName: msg.projectName,
          goalId: msg.goalId,
          phase: msg.phase,
          reason: msg.reason,
        }, sendResponse);
        break;
      case 'workspace_notes_list':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.sendMessage(session, sendResponse, {
          type: 'command_response',
          requestId: msg.requestId,
          response: { type: 'workspace-notes', notes: listWorkspaceNotes(msg.projectName, msg.workspaceName) },
        });
        break;

      case 'workspace_note_add':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.sendMessage(session, sendResponse, {
          type: 'command_response',
          requestId: msg.requestId,
          response: { type: 'workspace-note', note: addWorkspaceNote(msg.projectName, msg.workspaceName, { body: msg.body, kind: 'note' }) },
        });
        break;

      case 'workspace_note_update':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.sendMessage(session, sendResponse, {
          type: 'command_response',
          requestId: msg.requestId,
          response: { type: 'workspace-note', note: updateWorkspaceNote(msg.projectName, msg.workspaceName, msg.noteId, { body: msg.body, kind: 'note' }) },
        });
        break;
      case 'rerun_workspace_scripts':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.startWorkspaceScriptOperation(session, sendResponse, {
          requestId: msg.requestId,
          projectName: msg.projectName,
          workspaceId: msg.workspaceId,
          selection: 'setup-select',
          mode: 'rerun',
        });
        break;

      case 'run_workspace_open_scripts':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.startWorkspaceScriptOperation(session, sendResponse, {
          requestId: msg.requestId,
          projectName: msg.projectName,
          workspaceId: msg.workspaceId,
          selection: 'select',
          mode: 'open',
        });
        break;

      case 'run_workspace_script_selection':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.startWorkspaceScriptOperation(session, sendResponse, {
          requestId: msg.requestId,
          projectName: msg.projectName,
          workspaceId: msg.workspaceId,
          selection: msg.selection,
          mode: 'rerun',
        });
        break;

      case 'workspace_note_remove':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        if (!removeWorkspaceNote(msg.projectName, msg.workspaceName, msg.noteId)) {
          await this.sendError(session, sendResponse, 'NOTE_NOT_FOUND', `Workspace note not found: ${msg.noteId}`, { requestId: msg.requestId });
          return;
        }
        await this.sendMessage(session, sendResponse, {
          type: 'command_response',
          requestId: msg.requestId,
          response: { type: 'ok' },
        });
        break;

      case 'terminate_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'terminate',
          id: msg.sessionId,
          mode: msg.mode,
          graceMs: msg.graceMs,
        }, sendResponse);
        break;

      case 'start_process':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'service-start',
          workspaceId: msg.workspaceId,
          processName: msg.processName,
          instance: msg.instance,
        }, sendResponse);
        break;

      case 'resolve_port_conflict':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'service-resolve-port-conflict',
          conflict: msg.conflict,
        }, sendResponse);
        break;

      case 'stop_process':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'service-stop',
          workspaceId: msg.workspaceId,
          processName: msg.processName,
        }, sendResponse);
        break;

      case 'request_events':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'events-request',
          workspacePath: msg.workspacePath,
          filter: msg.filter,
          limit: msg.limit,
          sinceMs: msg.sinceMs,
        }, sendResponse);
        break;

      case 'get_bundle_refresh_plan':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'bundle-refresh-plan',
          projectName: msg.projectName,
          workspaceId: msg.workspaceId,
        }, sendResponse);
        break;

      case 'apply_bundle_refresh':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'bundle-refresh-apply',
          projectName: msg.projectName,
          workspaceId: msg.workspaceId,
          submission: msg.submission,
        }, sendResponse);
        break;

      case 'get_bundle_config_state':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'bundle-config-state',
          projectName: msg.projectName,
          workspaceId: msg.workspaceId,
        }, sendResponse);
        break;

      case 'apply_bundle_config':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'bundle-config-apply',
          projectName: msg.projectName,
          workspaceId: msg.workspaceId,
          submission: msg.submission,
        }, sendResponse);
        break;

      case 'request_review':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.startTmuxCommandOperation(session, sendResponse, {
          requestId: msg.requestId,
          kind: 'review.github',
          scope: {
            projectName: msg.operation.projectName,
            workspaceName: msg.operation.workspaceName,
            workspaceId: `${msg.operation.projectName}:${msg.operation.workspaceName}`,
          },
          command: {
            type: 'review-request',
            requestId: msg.requestId,
            operation: msg.operation,
          },
          message: `Review ${msg.operation.op}`,
        });
        break;

      case 'get_inbox':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'inbox',
        }, sendResponse);
        break;

      case 'clear_inbox':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'inbox-clear',
          id: msg.id,
        }, sendResponse);
        break;

      case 'mark_inbox_read':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'inbox-read',
          id: msg.id,
        }, sendResponse);
        break;

      case 'get_notification_config':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'notification-config-get',
        }, sendResponse);
        break;

      case 'update_notification_config':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'notification-config-update',
          config: msg.config,
        }, sendResponse);
        break;

      case 'list_agent_sessions':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-sessions',
          target: msg.target,
          mode: msg.mode,
        }, sendResponse);
        break;

      case 'create_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-create',
          target: msg.target,
          title: msg.title,
        }, sendResponse);
        break;

      case 'abort_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-abort',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;

      case 'interrupt_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access to interrupt agent sessions', { requestId: msg.requestId });
          return;
        }
        // Note: Pi SDK session.abort() means "interrupt current turn", not kill the session
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-interrupt',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;

      case 'close_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-close',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;

      case 'archive_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-archive',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;

      case 'restore_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-restore',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;

      case 'attach_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-attach',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
          cols: msg.cols,
          rows: msg.rows,
        }, sendResponse);
        break;

      case 'prompt_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-prompt',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
          text: msg.text,
          images: msg.images,
          streamingBehavior: msg.streamingBehavior,
        }, sendResponse);
        break;

      case 'remove_agent_queued_message':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-queue-remove',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
          kind: msg.kind,
          index: msg.index,
        }, sendResponse);
        break;

      case 'stage_agent_upload':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-stage-upload',
          target: msg.target,
          fileName: msg.fileName,
          data: msg.data,
          mimeType: msg.mimeType,
        }, sendResponse);
        break;

      case 'respond_agent_dialog':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-dialog-response',
          dialogId: msg.dialogId,
          dialogType: msg.dialogType,
          value: msg.value,
        }, sendResponse);
        break;

      case 'respond_agent_permission':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-permission',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
          permissionId: msg.permissionId,
          response: msg.response,
        }, sendResponse);
        break;

      case 'get_agent_transcript_range':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-transcript-range',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
          before: msg.before,
          limit: msg.limit,
        }, sendResponse);
        break;

      case 'get_agent_control_info':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-control-info',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;

      case 'set_agent_model':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-set-model',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
          provider: msg.provider,
          modelId: msg.modelId,
        }, sendResponse);
        break;

      case 'set_agent_thinking_level':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-set-thinking-level',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
          level: msg.level,
        }, sendResponse);
        break;

      case 'set_agent_approval_mode':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-set-approval-mode',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
          mode: msg.mode,
        }, sendResponse);
        break;

      case 'get_agent_auth_providers':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'agent-auth-providers' }, sendResponse);
        break;

      case 'set_agent_provider_api_key':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-set-api-key',
          provider: msg.provider,
          key: msg.key,
        }, sendResponse);
        break;

      case 'get_agent_settings':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'agent-get-settings' }, sendResponse);
        break;

      case 'set_agent_setting':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-set-setting',
          path: msg.path,
          value: msg.value,
        }, sendResponse);
        break;

      case 'start_agent_oauth_login':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-oauth-login',
          provider: msg.provider,
          flowId: msg.flowId,
        }, sendResponse);
        break;

      case 'respond_agent_oauth_prompt':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-oauth-respond',
          flowId: msg.flowId,
          value: msg.value,
        }, sendResponse);
        break;

      case 'get_agent_settings_schema':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'agent-settings-schema' }, sendResponse);
        break;

      case 'get_agent_tools':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-tools',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;

      case 'list_agent_definitions':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-list-agents',
          target: msg.target,
        }, sendResponse);
        break;

      case 'compact_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-compact',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;

      case 'cycle_agent_role':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-cycle-role',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
          direction: msg.direction,
        }, sendResponse);
        break;

      case 'apply_agent_role':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-apply-role',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
          role: msg.role,
        }, sendResponse);
        break;

      case 'get_agent_history':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-history',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;

      case 'navigate_agent_history':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-navigate-history',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
          entryId: msg.entryId,
          mode: msg.mode,
        }, sendResponse);
        break;

      case 'get_agent_session_tree':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-tree',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;







      case 'report_problem':
        // Any collaborator may report a problem — no manage gate. The bundle
        // is redacted daemon-side before it is written.
        await this.handleTypedCommand(session, msg.requestId, { type: 'report-problem', note: msg.note, clientBundleJson: msg.clientBundleJson, fileIssue: msg.fileIssue, projectName: msg.projectName }, sendResponse);
        break;

      case 'project_artifacts_rollup':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'project-artifacts-rollup', projectName: msg.projectName, workspace: msg.workspace, removeBranch: msg.removeBranch }, sendResponse);
        break;

      case 'artifact_share_mint':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'artifact-share-mint', uri: msg.uri, ttlMs: msg.ttlMs, maxUses: msg.maxUses }, sendResponse);
        break;

      case 'artifact_share_revoke':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'artifact-share-revoke', tokenId: msg.tokenId }, sendResponse);
        break;

      case 'artifact_share_list':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'artifact-share-list' }, sendResponse);
        break;

      case 'artifact_list':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'artifact-list', uriPrefix: msg.uriPrefix }, sendResponse);
        break;

      case 'artifact_read':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'artifact-read', uri: msg.uri }, sendResponse);
        break;

      case 'artifact_write':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'artifact-write', uri: msg.uri, contentBase64: msg.contentBase64, message: msg.message, cap: msg.cap }, sendResponse);
        break;

      case 'project_artifacts_status':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'project-artifacts-status', projectName: msg.projectName }, sendResponse);
        break;

      case 'project_artifacts_remote_set':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'project-artifacts-remote-set', projectName: msg.projectName, url: msg.url }, sendResponse);
        break;

      case 'project_artifacts_provision':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'project-artifacts-provision', projectName: msg.projectName }, sendResponse);
        break;

      case 'trigger_save':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'trigger-save', target: msg.target, trigger: msg.trigger }, sendResponse);
        break;

      case 'trigger_run_now':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'trigger-run-now', target: msg.target, triggerId: msg.triggerId }, sendResponse);
        break;

      case 'project_artifacts_sync':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, { type: 'project-artifacts-sync', projectName: msg.projectName }, sendResponse);
        break;

      case 'repo_tree':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'repo-tree',
          target: msg.target,
        }, sendResponse);
        break;

      case 'repo_read':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'repo-read',
          target: msg.target,
          path: msg.path,
        }, sendResponse);
        break;

      case 'repo_commit':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'repo-commit',
          target: msg.target,
          message: msg.message,
        }, sendResponse);
        break;

      case 'list_agent_commands':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-list-commands',
          target: msg.target,
        }, sendResponse);

        break;
      case 'list_workspace_editors':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'workspace-editors-list',
          target: msg.target,
        }, sendResponse);
        break;

      case 'open_workspace_editor':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.startTmuxCommandOperation(session, sendResponse, {
          requestId: msg.requestId,
          kind: 'workspace.editor.open',
          scope: {
            projectName: msg.target.projectName,
            workspaceId: msg.target.workspaceId,
            workspaceName: msg.target.workspaceName,
          },
          command: {
            type: 'workspace-editor-open',
            target: msg.target,
            editorId: msg.editorId,
          },
          message: 'Opening workspace editor',
        });
        break;


      case 'get_agent_file_suggestions':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-file-suggestions',
          target: msg.target,
          prefix: msg.prefix,
          limit: msg.limit,
        }, sendResponse);
        break;


      case 'run_space_command':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        {
          const operation = this.createOperation({
            operationId: msg.requestId,
            kind: 'space.command',
            scope: {
              projectName: msg.target.projectName,
              workspaceId: msg.target.workspaceId,
              workspaceName: msg.target.workspaceName,
            },
            phase: 'running',
            message: 'Running space command',
          });
          await this.sendOperationAccepted(session, sendResponse, msg.requestId, operation);
          const stopWatchdog = this.startOperationWatchdog(operation.operationId, operation.kind);
          void (async () => {
            try {
              const { execCommand } = await importExecModule();
              const output = await withTimeout(
                executeSpaceCommand(
                  {
                    exec: async (command, commandArgs, options) => {
                      const result = await execCommand(command, commandArgs, options?.cwd ?? msg.target.workspacePath, options);
                      return { stdout: result.stdout, stderr: result.stderr, code: result.code, killed: result.killed ?? false };
                    },
                  },
                  { cwd: msg.target.workspacePath },
                  // Structured args (programmatic callers) are authoritative
                  // and bypass the tokenizer; argsText is the human-typed path.
                  msg.args ?? parseCommandArgs(msg.argsText),
                ),
                operationTimeoutMs(operation.kind),
                `Operation timed out (${operation.kind})`,
              );
              this.updateOperation(operation.operationId, {
                state: 'succeeded',
                phase: 'complete',
                message: 'Space command complete',
                result: {
                  type: 'run_space_command_response',
                  requestId: msg.requestId,
                  output,
                },
              }, 'operation_succeeded');
            } catch (error) {
              const typedError = error instanceof Error ? error as Error & { code?: string } : undefined;
              const message = typedError?.message ?? String(error);
              this.updateOperation(operation.operationId, {
                state: 'failed',
                phase: 'failed',
                message,
                error: { code: typedError?.code ?? 'COMMAND_ERROR', message },
              }, 'operation_failed');
            } finally {
              stopWatchdog();
            }
          })();
        }
        break;
      default: {
        // Exhaustiveness check - log unknown message types
        const unknownMsg = msg as { type: string };
        console.warn("[remote-session] Unknown message type:", unknownMsg.type);
      }
    }
  }

  private async handleTypedCommand(
    session: RemoteClientSession,
    requestId: string,
    tmuxCommand: TmuxCommand,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    const traceStartMs = Date.now();
    // Include the review sub-op so slow/frequent review-requests are identifiable
    // in the trace ring (they otherwise all read as commandType "review-request").
    const commandOp = tmuxCommand.type === 'review-request' ? tmuxCommand.operation?.op : undefined;
    writeTraceLog('machine-command-start', {
      requestId,
      commandType: tmuxCommand.type,
      op: commandOp,
    });
    try {
      // The handler already validated tmux-lite availability during initialize().
      // Avoid ensureServer() here: it performs an unbounded agent-state RPC,
      // which can wedge client responses when tmux-lite is busy.
      const response = await this.sendBoundedTmuxCommand(tmuxCommand);
      writeTraceLog('machine-command-tmux-response', {
        requestId,
        commandType: tmuxCommand.type,
        op: commandOp,
        responseType: response.type,
        durationMs: Date.now() - traceStartMs,
      });
      await this.sendMessage(session, sendResponse, {
        type: 'command_response',
        requestId,
        response,
      });
      writeTraceLog('machine-command-response-sent', {
        requestId,
        commandType: tmuxCommand.type,
        op: commandOp,
        responseType: response.type,
        durationMs: Date.now() - traceStartMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeTraceLog('machine-command-error', {
        requestId,
        commandType: tmuxCommand.type,
        op: commandOp,
        durationMs: Date.now() - traceStartMs,
        error: message,
      });
      await this.sendMessage(session, sendResponse, {
        type: 'command_response',
        requestId,
        response: { type: 'error', message },
      });
    }
  }

  private async handleListReplays(
    session: RemoteClientSession,
    workspaceId: string | undefined,
    includeDismissed: boolean | undefined,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    const replays = filterReplaysForSessionAccess(
      session.accessType,
      session.grantedSessionId,
      listReplaysOffline({ workspaceId, includeDismissed: includeDismissed ?? false }),
    ).filter((replay) => !isAgentReplay(replay));
    await this.sendMessage(session, sendResponse, {
      type: 'replay_list',
      replays,
    });
  }

  private async handleGetReplayFrame(
    session: RemoteClientSession,
    replayId: string,
    requestId: string,
    atMs: number | undefined,
    atSeq: number | undefined,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    const manifest = readReplayManifest(replayId);
    if (!manifest) {
      await this.sendError(session, sendResponse, 'NOT_FOUND', `Replay not found: ${replayId}`, { requestId });
      return;
    }

    if (!canAccessReplayForSession(session.accessType, session.grantedSessionId, manifest)) {
      await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Not authorized to access this replay', { requestId });
      return;
    }

    const frame = getReplayFrameOffline(replayId, { atMs, atSeq });

    const maxPayloadBytes = 900_000;
    const buildPayload = (
      events: ReplayFrame['events'],
      chunkIndex: number,
      totalChunks: number,
      checkpoint: ReplayFrame['checkpoint'] | null,
    ) => ({
      type: 'replay_frame' as const,
      replayId,
      requestId,
      frame: {
        replayId,
        checkpoint,
        events,
      },
      chunkIndex,
      totalChunks,
    });

    const chunks: ReplayFrame['events'][] = [];
    const eventJsonSizes = frame.events.map((event) => Buffer.byteLength(JSON.stringify(event)));
    const basePayloadSize = (checkpoint: ReplayFrame['checkpoint'] | null) => Buffer.byteLength(JSON.stringify(buildPayload([], 0, 1, checkpoint)));
    let chunk: ReplayFrame['events'] = [];
    let chunkSizeBytes = basePayloadSize(frame.checkpoint);
    for (const [index, event] of frame.events.entries()) {
      const eventSizeBytes = eventJsonSizes[index] ?? 0;
      let hasEventsBeforePush = chunk.length > 0;
      let candidateSize = chunkSizeBytes + eventSizeBytes + (hasEventsBeforePush ? 1 : 0);
      if (candidateSize > maxPayloadBytes && chunk.length > 0) {
        chunks.push(chunk);
        chunk = [];
        chunkSizeBytes = basePayloadSize(null);
        hasEventsBeforePush = false;
        candidateSize = chunkSizeBytes + eventSizeBytes;
      }

      chunk.push(event);
      chunkSizeBytes += eventSizeBytes + (hasEventsBeforePush ? 1 : 0);
    }

    if (chunk.length > 0 || chunks.length === 0) {
      chunks.push(chunk);
    }

    const totalChunks = chunks.length;
    for (let i = 0; i < totalChunks; i += 1) {
      await this.sendMessage(session, sendResponse, buildPayload(chunks[i] ?? [], i, totalChunks, i === 0 ? frame.checkpoint : null));
    }
  }

  private async handleGetReplayTimeline(
    session: RemoteClientSession,
    replayId: string,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    const manifest = readReplayManifest(replayId);
    if (!manifest) {
      await this.sendError(session, sendResponse, 'NOT_FOUND', `Replay not found: ${replayId}`);
      return;
    }

    if (!canAccessReplayForSession(session.accessType, session.grantedSessionId, manifest)) {
      await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Not authorized to access this replay');
      return;
    }

    const timeline = getReplayTimelineOffline(replayId);
    await this.sendMessage(session, sendResponse, {
      type: 'replay_timeline',
      replayId,
      timeline,
    });
  }

  private async handleDismissReplay(
    session: RemoteClientSession,
    replayId: string,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    if (!canManage(session.accessType)) {
      await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access to dismiss replays');
      return;
    }
    const manifest = readReplayManifest(replayId);
    if (!manifest) {
      await this.sendError(session, sendResponse, 'NOT_FOUND', `Replay not found: ${replayId}`);
      return;
    }
    if (!canAccessReplayForSession(session.accessType, session.grantedSessionId, manifest)) {
      await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Not authorized to access this replay');
      return;
    }
    if (manifest.status === 'running') {
      await this.sendError(session, sendResponse, 'USER_ERROR', 'Running replays cannot be dismissed');
      return;
    }

    dismissReplayOffline(replayId);
    await this.sendMessage(session, sendResponse, { type: 'replay_dismissed', replayId });
  }

  private async handleUndismissReplay(
    session: RemoteClientSession,
    replayId: string,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    if (!canManage(session.accessType)) {
      await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access to restore replays');
      return;
    }

    const manifest = readReplayManifest(replayId);
    if (!manifest) {
      await this.sendError(session, sendResponse, 'NOT_FOUND', `Replay not found: ${replayId}`);
      return;
    }
    if (!canAccessReplayForSession(session.accessType, session.grantedSessionId, manifest)) {
      await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Not authorized to access this replay');
      return;
    }

    undismissReplayOffline(replayId);
    await this.sendMessage(session, sendResponse, { type: 'replay_undismissed', replayId });
  }

  private async handleCancelPendingAttach(
    session: RemoteClientSession,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    if (!canManage(session.accessType)) {
      await this.sendError(
        session,
        sendResponse,
        'PERMISSION_DENIED',
        'Requires full access to cancel pending attach runs'
      );
      return;
    }

    const pending = this.pendingAttachRuns.get(session.connectionId);
    if (!pending) {
      return;
    }

    await cancelPrepareAttachSession(pending).catch(() => undefined);
    this.pendingAttachRuns.delete(session.connectionId);
  }

  /**
   * Handle attach_session request
   */
  private async handleAttachSession(
    session: RemoteClientSession,
    msg: {
      streamId: number;
      sessionId?: string;
      workspaceId?: string;
      sessionName?: string;
      cols: number;
      rows: number;
      scriptPolicy?: 'auto' | 'skip';
      viewOnly?: boolean;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    },
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    console.log("[remote-session] handleAttachSession:", JSON.stringify(msg));

    if (!this.tmuxLiteAvailable) {
      await this.sendError(session, sendResponse, "UNAVAILABLE", "Session manager not available");
      return;
    }

    try {
      const existingAttachRun = this.pendingAttachRuns.get(session.connectionId);
      if (existingAttachRun) {
        await cancelPrepareAttachSession(existingAttachRun).catch(() => undefined);
        this.pendingAttachRuns.delete(session.connectionId);
      }

      let targetSession: Session | null = null;

      // If no session ID, create new session in workspace
      if (!msg.sessionId && msg.workspaceId) {
        // Security: Creating new sessions requires full/manage access
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, "PERMISSION_DENIED", "Requires full access to create sessions");
          return;
        }
        let currentPhase: 'pre' | 'setup' | 'select' = 'pre';
        try {
          console.log('[remote-session] prepareAttachSession starting', { workspaceId: msg.workspaceId, sessionName: msg.sessionName, scriptPolicy: msg.scriptPolicy });
          const prepared = await prepareAttachSession({
            workspaceId: msg.workspaceId,
            sessionName: msg.sessionName,
            command: msg.command,
            args: msg.args,
            env: msg.env,
            scriptPolicy: msg.scriptPolicy,
            viewOnly: msg.viewOnly,
            onRequestId: (requestId) => {
              this.pendingAttachRuns.set(session.connectionId, requestId);
            },
            onScriptOutput: (event) => {
              currentPhase = event.phase;
              void this.sendMessage(session, sendResponse, {
                type: 'script_output',
                phase: event.phase,
                data: event.data,
                done: event.done,
                error: event.error,
              }).catch((error) => {
                logger.debug(`[remote-session] Failed to stream script output: ${error instanceof Error ? error.message : String(error)}`);
              });
            },
          });
          this.pendingAttachRuns.delete(session.connectionId);
          console.log('[remote-session] prepareAttachSession completed', { sessionId: prepared.session.id, sessionName: prepared.session.name, workspaceId: prepared.workspaceId, scriptPolicy: msg.scriptPolicy });
          targetSession = prepared.session;
        } catch (error) {
          console.error('[remote-session] prepareAttachSession failed', { workspaceId: msg.workspaceId, sessionName: msg.sessionName, scriptPolicy: msg.scriptPolicy, error: error instanceof Error ? error.message : String(error) });
          this.pendingAttachRuns.delete(session.connectionId);
          const typedError = error instanceof Error ? error as Error & { code?: string } : undefined;
          if (!msg.command) {
            await this.sendMessage(session, sendResponse, {
              type: 'script_output',
              phase: currentPhase,
              data: '',
              done: true,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          await this.sendError(
            session,
            sendResponse,
            typedError?.code ?? 'ATTACH_FAILED',
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
      } else if (msg.sessionId) {
        // Security: Check if client can attach to this session
        if (!canAttachSession(session.accessType, session.grantedSessionId, msg.sessionId)) {
          await this.sendError(session, sendResponse, "PERMISSION_DENIED", "Not authorized to attach to this session");
          return;
        }

        // Resolve target session. Prefer the cached machine snapshot to avoid
        // a Unix-socket round-trip to tmux-lite on every attach. Fall back to
        // a live listSessions() only if the session isn't in the snapshot yet
        // (e.g. it was just created and the snapshot hasn't propagated).
        const cachedRecord = this.latestMachineSnapshot?.terminalSessionsById[msg.sessionId];
        if (cachedRecord) {
          targetSession = {
            id: cachedRecord.id,
            name: cachedRecord.name,
            socketPath: cachedRecord.socketPath,
            pid: 0,
            attached: cachedRecord.attached,
            cwd: cachedRecord.cwd,
            createdAt: cachedRecord.createdAt,
            exitCode: cachedRecord.exitCode,
            kind: cachedRecord.kind === 'agent' ? 'agent' : 'shell',
            hidden: cachedRecord.hidden,
          };
        } else {
          const sessions = await listSessions();
          targetSession = sessions.find(s => s.id === msg.sessionId) ?? null;
        }
      }

      if (!targetSession) {
        await this.sendError(session, sendResponse, "NOT_FOUND", "Session not found");
        return;
      }

      session.state = "attached";
      session.attachedSessionId = targetSession.id;
      session.streamId = msg.streamId;
      session.attachedSessionName = targetSession.name;
      session.sessionSocketPath = targetSession.socketPath;
      session.initialCols = msg.cols;
      session.initialRows = msg.rows;
      session.viewOnly = msg.viewOnly ?? false;

      // ClientSessionManager now owns the real PTY attach handshake.
      // This step only resolves which tmux session to connect to.
    } catch (e) {
      console.error("[remote-session] Failed to attach session:", e);
      const typedError = e instanceof Error ? e as Error & { code?: string } : undefined;
      const detail = typedError?.message ?? String(e);
      await this.sendError(
        session,
        sendResponse,
        typedError?.code ?? "ATTACH_FAILED",
        `Failed to attach to session: ${detail}`
      );
    }
  }

  /**
   * Handle delete_workspace request
   */
  private async handleDeleteWorkspace(
    session: RemoteClientSession,
    requestId: string | undefined,
    projectName: string,
    workspaceId: string,
    scriptPolicy: 'auto' | 'skip' | undefined,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    const normalizedWorkspaceId = workspaceId.startsWith(`${projectName}:`)
      ? workspaceId.slice(projectName.length + 1)
      : workspaceId;
    const canonicalWorkspaceId = `${projectName}:${normalizedWorkspaceId}`;
    const operationId = requestId ?? crypto.randomUUID();
    const operation = this.createOperation({
      operationId,
      kind: 'workspace.delete',
      scope: { projectName, workspaceId: canonicalWorkspaceId, workspaceName: normalizedWorkspaceId },
      phase: 'remove',
      message: 'Deleting workspace',
    });
    await this.sendOperationAccepted(session, sendResponse, operationId, operation);
    const stopWatchdog = this.startOperationWatchdog(operation.operationId, operation.kind);

    void (async () => {
      try {
        await withTimeout(
          deleteTmuxWorkspace({
            projectName,
            workspaceId: normalizedWorkspaceId,
            scriptPolicy,
            onScriptOutput: (event) => {
              this.updateOperation(operationId, {
                phase: 'remove',
                outputBase64: this.appendBase64Output(this.operations.get(operationId)?.outputBase64, event.data),
                message: event.done
                  ? event.error ? `Remove scripts failed: ${event.error}` : 'Remove scripts complete'
                  : 'Running remove scripts',
              }, event.done ? 'operation_progress' : 'operation_output');
              void this.sendMessage(session, sendResponse, {
                type: 'script_output',
                phase: 'remove',
                data: event.data,
                done: event.done,
                error: event.error,
                workspaceId: canonicalWorkspaceId,
              }).catch((error) => {
                logger.debug(`[remote-session] Failed to stream remove script output: ${error instanceof Error ? error.message : String(error)}`);
              });
            },
          }),
          operationTimeoutMs(operation.kind),
          `Operation timed out (${operation.kind})`,
        );

        this.updateOperation(operationId, {
          state: 'succeeded',
          phase: 'complete',
          message: 'Workspace deleted',
          result: {
            type: 'workspace_deleted',
            requestId: operationId,
            workspaceId: canonicalWorkspaceId,
          },
        }, 'operation_succeeded');
        await this.refreshMachineSnapshot(`workspace.delete:${operationId}`);
      } catch (e) {
        console.error("[remote-session] Failed to delete workspace:", e);
        const typedError = e instanceof Error ? e as Error & { code?: string } : undefined;
        const message = typedError?.message ?? String(e);
        this.updateOperation(operationId, {
          state: 'failed',
          phase: 'failed',
          message,
          error: { code: typedError?.code ?? "DELETE_FAILED", message },
        }, 'operation_failed');
      } finally {
        stopWatchdog();
      }
    })();
  }

  // ============================================================================
  // Review Request Handling
  // ============================================================================

  /**
   * Send an encrypted message to client
   */
  private async sendMessage(
    session: RemoteClientSession,
    sendResponse: (data: Uint8Array) => void,
    msg: MachineToClientMessage
  ): Promise<void> {
    const json = serializeRemoteMessage(msg);
    const data = new TextEncoder().encode(json);
    const frame = await createFrame(0, data, session.sessionKeys.sendKey);
    sendResponse(frame);
  }

  /**
   * Send an error message to client
   */
  private async sendError(
    session: RemoteClientSession,
    sendResponse: (data: Uint8Array) => void,
    code: string,
    message: string,
    options?: { workspaceId?: string; projectName?: string; requestId?: string }
  ): Promise<void> {
    await this.sendMessage(session, sendResponse, {
      type: "error",
      code,
      message,
      workspaceId: options?.workspaceId,
      projectName: options?.projectName,
      requestId: options?.requestId,
    });
  }

  /**
   * Cleanup
   */
  cleanupConnection(connectionId: string): void {
    const pending = this.pendingAttachRuns.get(connectionId);
    if (pending) {
      void cancelPrepareAttachSession(pending).catch(() => undefined);
      this.pendingAttachRuns.delete(connectionId);
    }
    this.onClientLeavesBrowsing(connectionId);
    this.dismissedOperationIdsByConnection.delete(connectionId);
  }

  async cleanup(): Promise<void> {
    // Stop machine event watch
    this.machineWatchUnsubscribe?.();
    this.machineWatchUnsubscribe = null;
    this.machineSnapshotWatchers.clear();
    // Stop periodic reconciliation timer
    if (this.reconciliationTimer !== null) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }

    // Clean up process schedulers
    for (const timer of this.processSchedulers.values()) {
      clearInterval(timer);
    }
    this.processSchedulers.clear();
    this.tmuxLiteAvailable = false;
  }
}
