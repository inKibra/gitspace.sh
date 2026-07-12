#!/usr/bin/env bun
// @ts-nocheck - Uses Bun-specific APIs (Bun.Terminal, etc.)
/**
 * tmux-lite server - manages all sessions in a single process
 * Uses xterm-headless for proper terminal state tracking
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { Terminal as XTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { createBufferedSocketWriter } from "../../utils/bun-socket-writer";
import { installDsrCprResponder } from "./terminal-queries";
import { VirtualTerminal } from './agents/virtual-terminal.js';
import { registerVirtualTerminal, removeVirtualTerminal } from './virtual-session-registry.js';
import { forwardVirtualTerminalOutput } from './virtual-output-forwarder.js';
import { writeTraceLog } from '../../utils/trace-log.js';
import { raiseFileDescriptorLimitAtBoot } from '../../utils/rlimit.js';
import { getNotificationConfig, updateNotificationConfig, type NotificationConfig } from "../../core/config.js";
import { DEFAULT_NOTIFICATION_CONFIG } from "../../types/config.js";
import {
  applyTmuxLiteSandboxEnvironment,
  getRouterSocket,
  getSessionSocketPath,
  getPidFile,
  PROTOCOL_VERSION,
  PACKAGE_VERSION,
  type Command,
  type Response,
  type Session,
  type SessionCtrl,
  type InboxItem,
  type SessionCreateHooks,
  encodeRouterMessage,
  decodeRouterMessages,
  encodePTY,
  encodeControl,
  parseFrames,
  decodeControl,
  FrameType,
  MAX_FRAME_SIZE,
} from "./protocol";
import {
  appendReplayEvent,
  initializeReplay,
  listReplayInfos,
  reconcileRunningReplaysAsCrashed,
  updateReplayManifest,
  writeReplayCheckpoint,
} from "./replay/store.js";
import type { ReplayCheckpoint, ReplayEvent, ReplayManifest } from "./replay/types.js";
import { getReplayMarkdown, getReplaySnapshot, getReplayText } from "./replay/snapshot.js";
import {
  attachAgentSession as ensureAgentTerminalSession,
  archiveAgentSession,
  abortAgentSession,
  interruptAgentSession,
  closeAgentSession,
  createAgentSession,
  ensureAgentControlInitialized,
  getAgentControlSnapshot,
  shutdownAgentHosts,
  getKnownAgentSessions,
  listLiveAgentSessions,
  promptAgentSession,
  removeQueuedAgentMessage,
  stageUploadFile,
  rebindPiTerminalSessionOwnership,
  releasePiTerminalSessionOwnership,
  respondToAgentPermission,
  readAgentTranscriptRange,
  getAgentControlInfo,
  setAgentModel,
  setAgentThinkingLevel,
  setAgentApprovalMode,
  getAgentAuthProviders,
  setAgentProviderApiKey,
  getAgentSettings,
  setAgentSetting,
  getAgentSettingsSchema,
  getAgentTools,
  listAgentDefinitions,
  compactAgentSession,
  cycleAgentRole,
  applyAgentModelRole,
  getAgentHistory,
  getAgentSessionTree,
  navigateAgentHistory,
  startAgentOAuthLogin,
  respondAgentOAuthPrompt,
  restoreAgentSession,
  subscribeAgentControl,
  syncKnownWorkspaces,
  markAgentSessionIdle,
  setAgentHostUIEmitter,
  resolveAgentDialogResponse,
  listAgentCommands,
  getFileSuggestions,
} from './agent-control.js';
import { listAvailableEditors, openWorkspaceInEditor } from '../../utils/open-editor.js';
import { normalizeWorkspacePath } from '../../agents/agent-runtime-shared.js';
import { getWorkspaceRuntimeSnapshot } from './workspace-runtime.js';
import { setInProcessSessionSource } from '../processes/ports.js';
import { addWorkspaceNote, listWorkspaceNotes, removeWorkspaceNote, updateWorkspaceNote } from '../../core/workspace-metadata.js';
import { addGoalNearWorkspace, applyWorkspaceGoalPhaseChange, getGoalRecord, findGoalRecord, moveGoalInChain, previewWorkspaceGoalPhaseChange, updateGoalRecord } from '../../core/goal-chain.js';
import { computeReadiness } from '../../app/shared/goal-validation/readiness.js';
import { getSpaceStackStatus } from '../../commands/space-goals.js';
import { buildMachineSnapshot, buildGoalRecordsForProject } from './machine/build.js';
import type { MachineEvent, MachineSnapshot } from './machine/protocol.js';
import { applyMachineEventToSnapshot } from './machine/snapshot-patch.js';
import {
  computeAgentWorkspaceDeltaEvents,
  computePmDeltaEvents,
  computeProjectGoalsDeltaEvents,
  computeTerminalDeltaEvents,
} from './machine/live-model.js';
import { subscribeWorkspacePmUpdates, getWorkspacePmSnapshot } from './machine/pm-links.js';
import { suppressGoalChangeNotify } from '../../core/goal-notify.js';
import { scanWorkspaces } from '../remote-session/workspace-scanner.js';
import { startTriggerScheduler } from './trigger-scheduler.js';
import { setCommandDispatcher } from './command-dispatch.js';
import { deliverDialogRequest, isDialogResponseAuthorized } from './agent-dialog-delivery.js';
import { formatArtifactUri, mintArtifactCap, verifyArtifactCap, capAllows, parseArtifactUri } from '../../core/artifact-cap.js';
import { getOrCreateArtifactCapKeypair } from '../../core/artifact-cap-key.js';
import { matchesWorkspaceId, toCanonicalWorkspaceId } from '../../utils/workspace-id.js';
import { getProcessSpecs, startProcessInstance, stopProcessInstance } from '../processes/manager.js';
import { signalSubprocessTree } from './process-tree.js';
import { PortConflictError } from '../processes/port-conflicts.js';
import { attachWorkspaceSession } from '../../session/attach-workspace-session.js';
import { prepareWorkspaceForSession } from '../../core/workspace-lifecycle.js';
import type { executeLocalReviewOperation } from '../../core/review-executor.js';
import { runOffloaded, shutdownOffloadWorker } from './offload/offload-client.js';
import { readWorkspaceSnapshots, readWideEvents } from '../events/reader.js';
import { loadSavedEventFilters } from '../events/filters.js';
import { listProcessEventsDirs, resolveWorkspaceRef } from '../events/paths.js';
import { readProjectConfig } from '../../core/config.js';
import {
  listGithubReposForSession,
  listRemoteBranchesForSession,
  listLinearIssuesForSession,
  createProjectForSession,
  prepareProjectForSession,
  finalizePreparedProjectForSession,
  cancelPreparedProjectForSession,
  createWorkspaceForSession,
  deleteProjectForSession,
} from '../../core/session-lifecycle.js';
import { deleteWorkspaceCore } from '../../core/workspace.js';
import {
  getBundleRefreshPlan as getBundleRefreshPlanCore,
  applyBundleRefreshSubmission,
  getBundleConfigState as getBundleConfigStateCore,
  applyBundleConfigSubmission,
} from '../../core/bundle-refresh.js';

// Chunk size for large PTY data (leave room for frame header overhead)
// Using 512KB to be well under the 1MB limit
const PTY_CHUNK_SIZE = 512 * 1024;

// Max scrollback lines to include in serialized state during attach
// This is a limit - if less scrollback exists, we'll send what's available
const SERIALIZE_SCROLLBACK_LINES = 250;

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--test")) {
  applyTmuxLiteSandboxEnvironment("test", { preserveExplicit: true });
}

// Raise the open-fd limit before we start spawning PTYs, agent workers, and
// their bash-tool children. The raised soft limit is inherited by every child
// we fork, so this one call protects the whole session tree. Best-effort.
raiseFileDescriptorLimitAtBoot("tmux-lite-daemon");

const ROUTER_SOCKET = getRouterSocket();
const PID_FILE = getPidFile();
const SERVER_START_TIME = Date.now();
const RECORD_REPLAY_INPUT = process.env.TMUX_LITE_REPLAY_RECORD_INPUT === "1";
const REPLAY_CHECKPOINT_MIN_INTERVAL_MS = 2000;
const REPLAY_CHECKPOINT_BYTE_INTERVAL = 128 * 1024;
const REPLAY_CHECKPOINT_OUTPUT_EVENT_INTERVAL = 256;
const pendingAttachControllers = new Map<string, AbortController>();
const DEFAULT_TERMINATION_GRACE_MS = 5000;
const MAX_TERMINATION_GRACE_MS = 8000;

type TerminationMode = "graceful" | "force";

interface TerminationState {
  promise: Promise<void>;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  force: boolean;
}


// Load notification config (with fallback to defaults)
let notificationConfig: NotificationConfig;
try {
  notificationConfig = getNotificationConfig();
} catch {
  // If config can't be loaded (e.g., gitspace not initialized), use defaults
  notificationConfig = { ...DEFAULT_NOTIFICATION_CONFIG };
}

/**
 * Check if a notification type is enabled
 */
function isNotificationTypeEnabled(type: InboxItem['type']): boolean {
  if (!notificationConfig.enabled) return false;

  switch (type) {
    case 'exit':
      return notificationConfig.types.exit;
    case 'idle':
      return notificationConfig.types.idle;
    case 'bell':
      return notificationConfig.types.bell;
    case 'title':
      return notificationConfig.types.title;
    case 'osc':
      return notificationConfig.types.osc;
    default:
      return notificationConfig.types.osc;
  }
}

// Clean up old socket
try { unlinkSync(ROUTER_SOCKET); } catch {}

// Write PID file
writeFileSync(PID_FILE, String(process.pid));

try {
  const reconciled = reconcileRunningReplaysAsCrashed();
  if (reconciled.length > 0) {
    console.log(`[replay] marked ${reconciled.length} running replays as crashed`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[replay] failed to reconcile running replays: ${message}`);
}

interface ReplayRuntime {
  replayId: string;
  startedAt: number;
  nextSeq: number;
  eventCount: number;
  checkpointCount: number;
  lastCheckpointAt: number;
  bytesSinceCheckpoint: number;
  outputEventsSinceCheckpoint: number;
}

interface SessionData {
  info: Session;
  listener: any;
  ptyTerminal: Bun.Terminal | null;
  xterm: XTerminal;
  serialize: SerializeAddon;
  idleState: IdleDetectionState;
  proc: Bun.Subprocess | null;
  virtualTerminal: VirtualTerminal | null;
  client: any;
  clientWriter: any;
  ctrlBuffer: Buffer;
  pendingWrites: number;  // Track pending xterm writes
  attaching: boolean;
  attachDirty: boolean;
  attachPending: boolean;
  attachTimer: any;
  processTitle: string;   // Title set by running process (via OSC 0)
  terminalTitle: string;
  lastAlertKind?: InboxItem['type'];
  lastAlertPreview?: string;
  lastAlertAt?: number;
  unreadAlertCount: number;
  lastInteraction: number;  // Timestamp of last user input
  lastDetached: number;  // Timestamp of last detach (for grace period)
  lastAttached: number;  // Timestamp of last attach (for grace period)
  replay: ReplayRuntime | null;
  replayCheckpointPending: boolean;
  cleanupComplete: boolean;
  termination: TerminationState | null;
}

const sessions = new Map<string, SessionData>();
const inbox: InboxItem[] = [];
let routerListener: any = null;
let shuttingDown = false;
let machineSnapshotNonce = 0;
/** Live in-memory machine model (ticket #3). Mutation sites apply scoped
 *  deltas to this model and stream them to watchers; the full rebuild is
 *  demoted to connect/resync + a slow reconciliation cadence. */
let liveMachineSnapshot: MachineSnapshot | null = null;
/** Runtime workspace records captured by the last full build — reused by the
 *  scoped PM update (fingerprints for the pm cache) without re-scanning. */
let lastWorkspaceRuntimeRecords: import('./protocol.js').WorkspaceRuntimeRecord[] = [];
let machineSnapshotBuildsInFlight = 0;

// The daemon's own goal writes are already covered by scoped updates in the
// command handlers — don't loop a goal-changed notify back to ourselves.
suppressGoalChangeNotify();

function stopListener(listener: any): void {
  if (!listener || typeof listener.stop !== "function") {
    return;
  }
  try {
    listener.stop(true);
  } catch {
    try {
      listener.stop();
    } catch {}
  }
}

function safeUnlink(path: string): void {
  try { unlinkSync(path); } catch {}
}

function writeToClient(session: SessionData, data: Buffer): void {
  if (!session.client) return;
  if (session.clientWriter) {
    session.clientWriter.write(data);
    return;
  }
  session.client.write(data);
}

function writeChunkedPtyToClient(session: SessionData, data: Buffer | Uint8Array | string): number {
  const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  if (bytes.length === 0) return 0;
  let offset = 0;
  let chunkCount = 0;
  while (offset < bytes.length) {
    const chunkEnd = Math.min(offset + PTY_CHUNK_SIZE, bytes.length);
    const chunk = bytes.subarray(offset, chunkEnd);
    writeToClient(session, encodePTY(chunk));
    chunkCount += 1;
    offset = chunkEnd;
  }
  return chunkCount;
}

function flushClient(session: SessionData): void {
  if (session.clientWriter) session.clientWriter.flush();
}

// ============================================================================
// Socket State Management
// ============================================================================

/**
 * Type-safe socket state manager using WeakMap.
 * This avoids mutating socket objects with `as any` casts.
 */
interface RouterSocketState {
  buffer: Buffer;
  writer: any;
  watchesAgentState: boolean;
  watchesMachineState: boolean;
}

const routerSocketStates = new WeakMap<object, RouterSocketState>();
const agentStateWatchers = new Set<object>();
const machineStateWatchers = new Set<object>();
let traceLastTick = Date.now();
if (process.env.GITSPACE_TRACE?.trim()) {
  setInterval(() => {
    const now = Date.now();
    const lagMs = now - traceLastTick - 1000;
    traceLastTick = now;
    if (lagMs > 100) {
      writeTraceLog('event-loop-lag', { lagMs });
    }
  }, 1000).unref?.();
}
const agentSessionWatchOwners = new Map<string, object>();
const agentDialogOwners = new Map<string, object>();
// Dialogs delivered over the agent-state watcher conduit (serve+relay app)
// rather than to a single same-socket owner. Their response may arrive on any
// command socket (the app answers over a fresh RPC), so they resolve by
// dialogId regardless of the delivering socket. First valid response wins.
const conduitDeliveredDialogs = new Set<string>();

function getRouterSocketState(socket: object): RouterSocketState {
  let state = routerSocketStates.get(socket);
  if (!state) {
    state = { buffer: Buffer.alloc(0), writer: null, watchesAgentState: false, watchesMachineState: false };
    routerSocketStates.set(socket, state);
  }
  return state;
}

function deleteOwnedEntries(map: Map<string, object>, socket: object): void {
  for (const [key, owner] of map) {
    if (owner === socket) {
      map.delete(key);
    }
  }
}

function pickAgentDialogWatcher(sessionId: string): object | null {
  const owner = agentSessionWatchOwners.get(sessionId);
  if (!owner) {
    return null;
  }
  if (agentStateWatchers.has(owner)) {
    return owner;
  }
  agentSessionWatchOwners.delete(sessionId);
  return null;
}

function clearRouterSocketState(socket: object): void {
  agentStateWatchers.delete(socket);
  machineStateWatchers.delete(socket);
  deleteOwnedEntries(agentSessionWatchOwners, socket);
  deleteOwnedEntries(agentDialogOwners, socket);
  routerSocketStates.delete(socket);
}

function sendRouterResponse(socket: any, response: Response): void {
  const socketState = getRouterSocketState(socket);
  if (socketState.writer) socketState.writer.write(encodeRouterMessage(response));
  else socket.write(encodeRouterMessage(response));
}

const MIN_TERMINAL_COLS = 20;
const MAX_TERMINAL_COLS = 1000;
const MIN_TERMINAL_ROWS = 5;
const MAX_TERMINAL_ROWS = 400;

function clampTerminalDimension(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampTerminalSize(
  cols: unknown,
  rows: unknown,
  fallback: { cols: number; rows: number } = { cols: 80, rows: 24 },
): { cols: number; rows: number } {
  return {
    cols: clampTerminalDimension(cols, fallback.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS),
    rows: clampTerminalDimension(rows, fallback.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS),
  };
}

function broadcastAgentStateDelta(delta: import('./agent-event-manager.js').AgentStateUpdateDelta): void {
  if (delta.type !== 'agent_last_message') {
    writeTraceLog('agent-delta-broadcast', {
      deltaType: delta.type,
      agentWatchers: agentStateWatchers.size,
      machineWatchers: machineStateWatchers.size,
    });
  }
  for (const socket of agentStateWatchers) {
    try {
      sendRouterResponse(socket, { type: 'agent-state-update', delta });
    } catch {
      agentStateWatchers.delete(socket);
    }
  }
}

function shouldBroadcastMachineSnapshotForAgentDelta(delta: import('./agent-event-manager.js').AgentStateUpdateDelta): boolean {
  return delta.type !== 'agent_last_message';
}


async function buildCurrentMachineSnapshot(): Promise<MachineSnapshot> {
  const traceStartMs = Date.now();
  machineSnapshotBuildsInFlight += 1;
  try {
    await syncKnownWorkspaces();
    try {
      await getAgentControlReady();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[server] machine snapshot proceeding without agent runtime: ${message}`);
    }
    if (machineSnapshotNonce === 0) {
      machineSnapshotNonce = 1;
    }
    writeTraceLog('machine-snapshot-build-start', {
      nextNonce: machineSnapshotNonce,
      sessions: sessions.size,
      machineWatchers: machineStateWatchers.size,
    });
    const workspaceSnapshot = await getWorkspaceRuntimeSnapshot({
      sessions: Array.from(sessions.values()).map(getSessionInfo),
      agentStateByWorkspaceId: getAgentControlSnapshot(),
    });
    lastWorkspaceRuntimeRecords = workspaceSnapshot;
    const snapshot = buildMachineSnapshot({
      snapshotNonce: machineSnapshotNonce,
      terminalSessions: Array.from(sessions.values()).map(getSessionInfo),
      workspaces: workspaceSnapshot,
      agentStateByWorkspaceId: getAgentControlSnapshot(),
    });
    liveMachineSnapshot = snapshot;
    writeTraceLog('machine-snapshot-build-end', {
      snapshotNonce: snapshot.snapshotNonce,
      durationMs: Date.now() - traceStartMs,
      sessions: sessions.size,
      workspaceCount: snapshot.workspaceOrder.length,
      machineWatchers: machineStateWatchers.size,
    });
    return snapshot;
  } finally {
    machineSnapshotBuildsInFlight -= 1;
  }
}

/** Serve the live model while watchers keep it maintained; rebuild when the
 *  model is absent or could have gone stale (no watcher = structural changes
 *  skip their full-rebuild broadcasts). */
async function getCurrentMachineSnapshot(): Promise<MachineSnapshot> {
  if (liveMachineSnapshot && machineStateWatchers.size > 0) return liveMachineSnapshot;
  return buildCurrentMachineSnapshot();
}

let machineSnapshotBroadcastPromise: Promise<void> | null = null;
let machineSnapshotBroadcastQueued = false;


async function broadcastMachineSnapshotReplacementOnce(): Promise<void> {
  const traceStartMs = Date.now();
  if (machineStateWatchers.size === 0) return;
  const snapshot = await buildCurrentMachineSnapshot();
  // Stamp the nonce AFTER the build completes so it stays ahead of any
  // scoped deltas emitted while the build was in flight.
  machineSnapshotNonce += 1;
  snapshot.snapshotNonce = machineSnapshotNonce;
  liveMachineSnapshot = snapshot;
  writeTraceLog('machine-snapshot-broadcast-start', {
    snapshotNonce: snapshot.snapshotNonce,
    buildAndQueueDelayMs: Date.now() - traceStartMs,
    watchers: machineStateWatchers.size,
  });
  for (const socket of machineStateWatchers) {
    try {
      sendRouterResponse(socket, {
        type: 'machine-event',
        event: {
          type: 'snapshot-replaced',
          snapshotNonce: snapshot.snapshotNonce,
          snapshot,
        },
      });
    } catch {
      machineStateWatchers.delete(socket);
    }
  }
  writeTraceLog('machine-snapshot-broadcast-end', {
    snapshotNonce: snapshot.snapshotNonce,
    durationMs: Date.now() - traceStartMs,
    watchers: machineStateWatchers.size,
  });
}

async function broadcastMachineSnapshotReplacement(): Promise<void> {
  if (machineStateWatchers.size === 0) return;
  if (machineSnapshotBroadcastPromise) {
    machineSnapshotBroadcastQueued = true;
    return machineSnapshotBroadcastPromise;
  }
  machineSnapshotBroadcastPromise = (async () => {
    try {
      do {
        machineSnapshotBroadcastQueued = false;
        await broadcastMachineSnapshotReplacementOnce();
      } while (machineSnapshotBroadcastQueued && machineStateWatchers.size > 0);
    } finally {
      machineSnapshotBroadcastPromise = null;
    }
  })();
  return machineSnapshotBroadcastPromise;
}

// ─── Scoped machine deltas (ticket #3) ──────────────────────────────────────

/**
 * Compute scoped delta events against the live model, stamp each with the
 * next nonce, apply them to the model via the same transform clients use,
 * and stream them to machine watchers.
 *
 * Falls back to the full-rebuild path when a rebuild is racing us (the
 * rebuild re-reads all sources, so the mutation is captured either way).
 */
function emitScopedMachineEvents(compute: (snapshot: MachineSnapshot) => MachineEvent[]): void {
  if (!liveMachineSnapshot) {
    // No consumer has ever materialized the model — nothing to maintain.
    return;
  }
  if (machineSnapshotBroadcastPromise || machineSnapshotBuildsInFlight > 0) {
    machineSnapshotBroadcastQueued = true;
    if (!machineSnapshotBroadcastPromise) {
      void broadcastMachineSnapshotReplacement().catch(() => {});
    }
    return;
  }
  let events: MachineEvent[];
  try {
    events = compute(liveMachineSnapshot);
  } catch (error) {
    writeTraceLog('machine-delta-compute-error', {
      error: error instanceof Error ? error.message : String(error),
    });
    void broadcastMachineSnapshotReplacement().catch(() => {});
    return;
  }
  if (events.length === 0) return;

  for (const event of events) {
    machineSnapshotNonce += 1;
    (event as { snapshotNonce: number }).snapshotNonce = machineSnapshotNonce;
    liveMachineSnapshot = applyMachineEventToSnapshot(liveMachineSnapshot, event);
  }
  liveMachineSnapshot = { ...liveMachineSnapshot, snapshotNonce: machineSnapshotNonce };

  if (machineStateWatchers.size === 0) return;
  let deltaBytes = 0;
  try {
    deltaBytes = JSON.stringify(events).length;
  } catch { /* trace-only */ }
  writeTraceLog('machine-delta-broadcast', {
    eventTypes: events.map((event) => event.type),
    snapshotNonce: machineSnapshotNonce,
    deltaBytes,
    watchers: machineStateWatchers.size,
  });
  for (const socket of machineStateWatchers) {
    try {
      for (const event of events) {
        sendRouterResponse(socket, { type: 'machine-event', event });
      }
    } catch {
      machineStateWatchers.delete(socket);
    }
  }
}

/** One terminal session changed (created / exited / removed). */
function applyTerminalScopedUpdate(sessionId: string): void {
  emitScopedMachineEvents((snapshot) => {
    const data = sessions.get(sessionId);
    return computeTerminalDeltaEvents(snapshot, sessionId, data ? getSessionInfo(data) : null);
  });
}

/** One workspace's agent-session state changed (agent-event-manager delta). */
function applyAgentScopedUpdate(workspaceId: string): void {
  emitScopedMachineEvents((snapshot) =>
    computeAgentWorkspaceDeltaEvents(snapshot, workspaceId, getAgentControlSnapshot()[workspaceId]));
}

/** One project's goal state changed (goal command or CLI goal-changed notify). */
function applyGoalScopedUpdate(projectName: string): void {
  emitScopedMachineEvents((snapshot) =>
    computeProjectGoalsDeltaEvents(snapshot, projectName, buildGoalRecordsForProject(projectName)));
}

/** PR/Linear sync state moved for some workspace(s). */
function applyPmScopedUpdate(): void {
  if (lastWorkspaceRuntimeRecords.length === 0) {
    void broadcastMachineSnapshotReplacement().catch(() => {});
    return;
  }
  emitScopedMachineEvents((snapshot) =>
    computePmDeltaEvents(snapshot, getWorkspacePmSnapshot(lastWorkspaceRuntimeRecords)));
}

/** The full rebuild is demoted to a slow reconciliation cadence — it trues up
 *  anything a scoped delta could not see and re-exercises the resync path. */
const MACHINE_SNAPSHOT_RECONCILE_INTERVAL_MS = 5 * 60_000;
const machineSnapshotReconcileTimer = setInterval(() => {
  if (machineStateWatchers.size === 0) return;
  writeTraceLog('machine-snapshot-reconcile', { watchers: machineStateWatchers.size });
  void broadcastMachineSnapshotReplacement().catch(() => {});
}, MACHINE_SNAPSHOT_RECONCILE_INTERVAL_MS);
// The daemon's socket listeners own process lifetime — the reconcile cadence
// must never be what keeps a process (e.g. a test import) alive.
machineSnapshotReconcileTimer.unref?.();

let agentControlSubscribed = false;
let workspacePmSubscribed = false;

async function getAgentControlReady(): Promise<void> {
  await ensureAgentControlInitialized();
  if (!agentControlSubscribed) {
    subscribeAgentControl((delta) => {
      broadcastAgentStateDelta(delta);
      if (shouldBroadcastMachineSnapshotForAgentDelta(delta)) {
        // Scoped: rebuild only this workspace's agent records in the live
        // model instead of the O(everything) full snapshot per delta.
        applyAgentScopedUpdate(delta.workspaceId);
      }
    });
    agentControlSubscribed = true;

    // Install the host UI bridge emitter so extension dialog requests
    // and UI events are broadcast to all watching clients.
    setAgentHostUIEmitter({
      emitDialogRequest(request) {
        deliverDialogRequest(request, {
          pickSameSocketOwner: (sessionId) => pickAgentDialogWatcher(sessionId),
          watchers: () => agentStateWatchers,
          send: (socket, req) => sendRouterResponse(socket, { type: 'agent-dialog-request', request: req }),
          setOwner: (dialogId, socket) => agentDialogOwners.set(dialogId, socket),
          markConduitDelivered: (dialogId) => conduitDeliveredDialogs.add(dialogId),
          onSameSocketError: (socket, req) => {
            agentDialogOwners.delete(req.id);
            agentSessionWatchOwners.delete(req.sessionId);
            clearRouterSocketState(socket);
          },
          onWatcherError: (socket) => clearRouterSocketState(socket),
        });
      },
      emitEvent(event) {
        for (const socket of agentStateWatchers) {
          try {
            sendRouterResponse(socket, { type: 'agent-ui-event', event });
          } catch {
            clearRouterSocketState(socket);
          }
        }
      },
    });
  }

}


function ensureWorkspacePmSubscribed(): void {
  if (workspacePmSubscribed) {
    return;
  }
  subscribeWorkspacePmUpdates(() => {
    applyPmScopedUpdate();
  });
  workspacePmSubscribed = true;
}

async function resolveWorkspaceIdForRuntimePath(workspacePath: string): Promise<string | null> {
  const normalizedPath = normalizeWorkspacePath(workspacePath);
  const workspaces = await scanWorkspaces();
  const match = workspaces.find((workspace) => normalizeWorkspacePath(workspace.path) === normalizedPath);
  return match ? toCanonicalWorkspaceId(match) : null;
}

void getAgentControlReady().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[server] failed to initialize agent control: ${message}`);
});

// Artifacts auto-sync: every 5 minutes, projects with a configured remote
// push branches + upload missing blobs (BYO = branches only). Single-writer
// branches make this conflict-free; failures are quiet (offline is normal).
{
  let syncing = false;
  // De-dup gate-refusal inbox items per (project, branch, offender set) —
  // the tick repeats every 5 minutes but the user needs telling once.
  const notifiedGateRefusals = new Set<string>();
  // Sync failures were fully silent (offline is normal, so one failure stays
  // quiet) — but PERSISTENT failure means auth/access is broken and the user
  // believes they're sharing when they aren't. Notify once after 3 in a row.
  const syncFailStreak = new Map<string, { count: number; notified: boolean }>();
  const t = setInterval(() => {
    if (syncing) return;
    syncing = true;
    void (async () => {
      try {
        const { getArtifactsRemote, gcSessionScratch, artifactsMountDir } = await import('../../core/artifacts.js');
        const { getProjectDir, getProjectBaseDir } = await import('../../core/config.js');
        const scanned = await scanWorkspaces();
        const projects = [...new Set(scanned.map((w) => w.projectName))];
        // Session-scratch GC (local:// roots): the SDK has none; drop scratch
        // for sessions that are gone AND idle past retention.
        try {
          const liveIds = new Set<string>();
          for (const ws of Object.values(getAgentControlSnapshot())) {
            for (const sess of ws.sessions ?? []) liveIds.add(sess.id);
          }
          const dirs = [
            ...scanned.map((w) => w.path),
            ...projects.map((name) => { try { return getProjectBaseDir(name); } catch { return null; } }).filter((d): d is string => !!d),
          ];
          for (const dir of dirs) {
            const removed = gcSessionScratch(artifactsMountDir(dir), liveIds);
            if (removed > 0) console.error(`[artifacts] gc: removed ${removed} stale session scratch dir(s) under ${dir}`);
          }
        } catch { /* gc is best-effort */ }
        for (const projectName of projects) {
          try {
            const projectDir = getProjectDir(projectName);
            if (!(await getArtifactsRemote(projectDir))) continue;
            let r;
            try {
              // Runs in the offload child — git/LFS network I/O off the loop.
              r = await runOffloaded<Awaited<ReturnType<typeof import('../../core/artifacts-github.js').syncGithubArtifacts>>>(
                'artifacts-sync',
                { projectDir },
              );
              syncFailStreak.delete(projectName);
            } catch (e) {
              const streak = syncFailStreak.get(projectName) ?? { count: 0, notified: false };
              streak.count += 1;
              if (streak.count >= 3 && !streak.notified) {
                streak.notified = true;
                const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
                console.error(`[artifacts] sync for ${projectName} failing persistently: ${msg}`);
                addInboxItem(createInboxNotification(
                  `artifacts:${projectName}:sync`,
                  `artifacts · ${projectName}`,
                  'osc',
                  `Artifacts sync has failed ${streak.count} times in a row (${msg}). Sharing is stalled — check access (GitHub: gh auth login), then run \`gssh artifacts sync\`.`,
                ));
              }
              syncFailStreak.set(projectName, streak);
              continue;
            }
            if (r.pushed || r.blobsUploaded) console.error(`[artifacts] synced ${projectName}${r.blobsUploaded ? ` (+${r.blobsUploaded} blobs)` : ''}`);
            // Publish-gate refusals must be LOUD: a silently stalled
            // single-writer branch is the top agent-confusion risk.
            for (const refusal of r.refused ?? []) {
              const key = `${projectName}:${refusal.branch}:${refusal.offenders.map((o) => o.path).sort().join(',')}`;
              if (notifiedGateRefusals.has(key)) continue;
              notifiedGateRefusals.add(key);
              const files = refusal.offenders.map((o) => `${o.path} (${(o.size / (1024 * 1024)).toFixed(1)} MB)`).join(', ');
              console.error(`[artifacts] push REFUSED for ${projectName}/${refusal.branch}: raw large files ${files}`);
              addInboxItem(createInboxNotification(
                `artifacts:${projectName}:${refusal.branch}`,
                `artifacts · ${projectName}`,
                'osc',
                `Push of artifacts branch '${refusal.branch}' refused: ${files} committed raw (not as LFS pointers). Run \`gssh space artifacts repair\` in that workspace — sync resumes automatically.`,
              ));
            }
          } catch { /* offline / auth — retry next tick */ }
        }
      } catch { /* scan failed */ }
      syncing = false;
    })();
  }, 5 * 60_000);
  t.unref?.();
}

// Trigger scheduler (triggers M2): this machine fires cron triggers for the
// workspaces it hosts. Runs are ordinary agent sessions, visible in the UI.
startTriggerScheduler(
  async () => {
    const workspaces = (await scanWorkspaces()).map((w) => ({ id: w.id, name: w.name, path: w.path, projectName: w.projectName }));
    // Project-scope triggers: each project's BASE clone (main artifacts mount)
    // is a pseudo-workspace — its triggers/ fire here too, run by @base agents.
    try {
      const { getProjectBaseDir } = await import('../../core/config.js');
      const { existsSync } = await import('fs');
      for (const projectName of [...new Set(workspaces.map((w) => w.projectName))]) {
        try {
          const base = getProjectBaseDir(projectName);
          if (existsSync(base)) workspaces.push({ id: `${projectName}:@base`, name: '@base', path: base, projectName });
        } catch { /* skip */ }
      }
    } catch { /* workspace-only */ }
    return workspaces;
  },
  {
    log: (message) => console.error(`[triggers] ${message}`),
    runAgent: async (workspace, title, prompt) => {
      try {
        await getAgentControlReady();
        const target = { workspaceId: workspace.id, workspaceName: workspace.name, workspacePath: workspace.path, projectName: workspace.projectName };
        const sessions = await createAgentSession(target, title);
        const created = sessions.find((x) => x.title === title) ?? sessions[sessions.length - 1];
        if (!created) return null;
        for (let attempt = 0; attempt < 4; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
          try {
            await promptAgentSession(target, created.id, prompt);
            return created.id;
          } catch { /* discovery race — retry */ }
        }
        return null;
      } catch {
        return null;
      }
    },
    watchSessionIdle: watchAgentSessionIdle,
    mintCap: (workspace, trigger) => {
      try {
        const scope = trigger.writes.filter(Boolean);
        if (scope.length === 0) return null;
        return mintArtifactCap({
          sub: { kind: 'trigger', id: trigger.id },
          verbs: ['write'],
          scope: scope.map((g) => formatArtifactUri(workspace.projectName, workspace.name, g)),
          machineId: 'local',
          expiresAt: Date.now() + 6 * 60 * 60_000,
        }, getOrCreateArtifactCapKeypair().secretKey);
      } catch (e) {
        console.error(`[triggers] cap mint failed: ${e instanceof Error ? e.message : e}`);
        return null;
      }
    },
    notifyViolations: (workspace, trigger, enforcement) => {
      addInboxItem(createInboxNotification(
        `trigger:${workspace.projectName}:${trigger.id}`,
        `trigger · ${trigger.name}`,
        'osc',
        `Run wrote outside its scope — reverted: ${enforcement.violations.join(', ')}. The run is marked failed; widen the trigger's 'writes' globs if these paths are intended.`,
      ));
    },
  },
);


/** Resolve an artifact:// URI to on-disk dirs, lazily mounting. The '@base'
 *  workspace segment is the project base clone's main mount — this one
 *  segment replaces the whole former project-artifacts-* RPC family. */
async function resolveArtifactUriDirs(uri: string): Promise<{ projectDir: string; workspaceDir: string; mountDir: string; relPath: string }> {
  const { parseArtifactUri } = await import('../../core/artifact-cap.js');
  const { artifactsMountDir, ensureArtifactsMount } = await import('../../core/artifacts.js');
  const { getProjectBaseDir, getProjectDir } = await import('../../core/config.js');
  const { existsSync } = await import('fs');
  const { join } = await import('path');
  const parsed = parseArtifactUri(uri);
  const projectDir = getProjectDir(parsed.project);
  const workspaceDir = parsed.workspace === '@base' ? getProjectBaseDir(parsed.project) : join(projectDir, 'workspaces', parsed.workspace);
  const mountDir = artifactsMountDir(workspaceDir);
  if (!existsSync(join(mountDir, '.git'))) {
    try {
      await ensureArtifactsMount(projectDir, workspaceDir, parsed.workspace === '@base' ? 'main' : parsed.workspace);
    } catch { /* unmountable — lists read empty; writes fail loudly below */ }
  }
  return { projectDir, workspaceDir, mountDir, relPath: parsed.relPath };
}

/** Fire `onIdle` once when an agent session completes a run (busy → idle).
 *  Used to close the trigger run lifecycle — before this, nothing ever
 *  recorded `ok` and every cron re-fired on pending-lock expiry instead of
 *  its cadence. Auto-unsubscribes; a session that never goes busy within the
 *  grace window is treated as complete on its first idle after that. */
function watchAgentSessionIdle(
  workspace: { id: string },
  sessionId: string,
  onIdle: () => void,
): void {
  let sawBusy = false;
  const startedAt = Date.now();
  const unsubscribe = subscribeAgentControl((delta) => {
    if (delta.type !== 'agent_session_status' || delta.sessionId !== sessionId || delta.workspaceId !== workspace.id) return;
    if (delta.status.type === 'busy' || delta.status.type === 'retry' || delta.status.type === 'compacting') {
      sawBusy = true;
      return;
    }
    if (delta.status.type !== 'idle') return;
    // Idle before ever going busy = the prompt hasn't landed yet; give it a
    // grace window instead of declaring instant success.
    if (!sawBusy && Date.now() - startedAt < 30_000) return;
    unsubscribe();
    onIdle();
  });
  // Safety: never leak the subscription past a reasonable run ceiling.
  const t = setTimeout(() => unsubscribe(), 6 * 60 * 60_000);
  (t as { unref?: () => void }).unref?.();
}

ensureWorkspacePmSubscribed();

function getSessionInfo(s: SessionData): Session {
  return {
    ...s.info,
    processTitle: s.processTitle || undefined,
    terminalTitle: s.terminalTitle || undefined,
    lastAlertKind: s.lastAlertKind,
    lastAlertPreview: s.lastAlertPreview,
    lastAlertAt: s.lastAlertAt,
    unreadAlertCount: s.unreadAlertCount || undefined,
  };
}

// Let port-conflict resolution read this server's live sessions directly
// instead of round-tripping through the server socket. Without this, a machine
// snapshot built inside a command handler that resolves a workspace port would
// send a `list` command back to this (single-threaded, busy) server and
// deadlock. See setInProcessSessionSource in ../processes/ports.ts.
setInProcessSessionSource(() => Array.from(sessions.values()).map(getSessionInfo));

function getUnreadInboxCountForSession(sessionId: string): number {
  let count = 0;
  for (const item of inbox) {
    if (item.sessionId === sessionId && !item.read) {
      count += 1;
    }
  }
  return count;
}

function pushSessionMeta(session: SessionData): void {
  if (!session.client) {
    return;
  }
  writeToClient(session, encodeControl({
    type: 'session-meta',
    sessionName: session.info.name,
    processTitle: session.processTitle || undefined,
    terminalTitle: session.terminalTitle || undefined,
    lastAlertKind: session.lastAlertKind,
    lastAlertPreview: session.lastAlertPreview,
    lastAlertAt: session.lastAlertAt,
    unreadAlertCount: session.unreadAlertCount || undefined,
  }));
}

function updateSessionAlertState(sessionId: string, updates: {
  kind?: InboxItem['type'];
  preview?: string;
  at?: number;
  unreadDelta?: number;
}): void {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  if (updates.kind) {
    session.lastAlertKind = updates.kind;
  }
  if (updates.preview !== undefined) {
    session.lastAlertPreview = updates.preview;
  }
  if (updates.at !== undefined) {
    session.lastAlertAt = updates.at;
  }
  if (typeof updates.unreadDelta === 'number') {
    session.unreadAlertCount = Math.max(0, session.unreadAlertCount + updates.unreadDelta);
  } else {
    session.unreadAlertCount = getUnreadInboxCountForSession(sessionId);
  }
  pushSessionMeta(session);
}

function updateSessionTitleState(sessionId: string, title: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  session.terminalTitle = title;
  session.processTitle = title;
  pushSessionMeta(session);
}

function clearIdleTimer(session: SessionData): void {
  if (session.idleState.idleTimer) {
    clearTimeout(session.idleState.idleTimer);
    session.idleState.idleTimer = null;
  }
}

function cleanupSessionResources(session: SessionData, options: { removeFromMap?: boolean; killed?: boolean } = {}): void {
  if (session.cleanupComplete) {
    return;
  }
  session.cleanupComplete = true;
  resolveTermination(session.termination);
  session.termination = null;
  clearIdleTimer(session);
  session.idleState.outputSinceIdle = 0;
  clearAttachTimer(session);
  session.attachPending = false;
  session.attaching = false;
  session.attachDirty = false;
  session.info.attached = false;
  session.clientWriter = null;
  if (session.client) {
    try { session.client.end(); } catch {}
    session.client = null;
  }
  stopListener(session.listener);
  // Close the PTY master fd. Bun.Terminal holds /dev/ptmx (plus its pts slave)
  // and does NOT release it when the child proc dies — without this, every
  // create+terminate cycle leaks ~4 fds and the daemon eventually hits EBADF.
  if (session.ptyTerminal) {
    try { session.ptyTerminal.close(); } catch {}
    session.ptyTerminal = null;
  }
  safeUnlink(session.info.socketPath);
  if (options.removeFromMap !== false) {
    sessions.delete(session.info.id);
  }

  const workspaceId = session.info.metadata?.workspaceId;
  const agentSessionId = session.info.metadata?.agentSessionId;
  releasePiTerminalSessionOwnership(session.info.id);
  if (workspaceId && agentSessionId && !options.killed) {
    markAgentSessionIdle(workspaceId, agentSessionId);
  }
}

async function terminateSessionData(session: SessionData, mode: TerminationMode, graceMs: number): Promise<void> {
  if (session.cleanupComplete) {
    return;
  }

  if (mode === "force") {
    resolveTermination(session.termination);
    session.termination = null;
    if (session.proc) {
      signalSubprocessTree(session.proc, "SIGKILL");
    }
    if (session.virtualTerminal) {
      session.virtualTerminal.stop();
      removeVirtualTerminal(session.info.id);
    }
    cleanupSessionResources(session, { killed: true });
    disposeSessionTerminal(session);
    applyTerminalScopedUpdate(session.info.id);
    return;
  }

  if (session.virtualTerminal) {
    session.virtualTerminal.stop();
    removeVirtualTerminal(session.info.id);
    cleanupSessionResources(session, { killed: true });
    disposeSessionTerminal(session);
    applyTerminalScopedUpdate(session.info.id);
    return;
  }

  if (!session.proc) {
    cleanupSessionResources(session, { killed: true });
    disposeSessionTerminal(session);
    applyTerminalScopedUpdate(session.info.id);
    return;
  }

  if (session.termination) {
    return session.termination.promise;
  }

  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const termination: TerminationState = {
    promise,
    resolve,
    timer: null,
    force: false,
  };
  session.termination = termination;

  signalSubprocessTree(session.proc, "SIGTERM");
  termination.timer = setTimeout(() => {
    if (session.cleanupComplete) {
      return;
    }
    termination.force = true;
    if (session.proc) {
      signalSubprocessTree(session.proc, "SIGKILL");
    }
    cleanupSessionResources(session, { killed: true });
    disposeSessionTerminal(session);
    applyTerminalScopedUpdate(session.info.id);
  }, graceMs);

  return promise;
}
function resolveTerminationMode(mode: unknown): TerminationMode | null {
  if (mode === undefined || mode === null) return "graceful";
  return mode === "graceful" || mode === "force" ? mode : null;
}

function resolveTerminationGraceMs(value: unknown): number | null {
  if (value === undefined || value === null) return DEFAULT_TERMINATION_GRACE_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.floor(value), MAX_TERMINATION_GRACE_MS);
}

function resolveTermination(state: TerminationState | null): void {
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.resolve();
}

function disposeSessionTerminal(session: SessionData): void {
  try { session.xterm.dispose(); } catch {}
}


function shutdownServer(options: { markRunningSessionsCrashed?: boolean } = {}): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const session of sessions.values()) {
    if (options.markRunningSessionsCrashed !== false) {
      markReplayCrashed(session);
    }
    try { session.xterm.dispose(); } catch {}
    cleanupSessionResources(session, { removeFromMap: false });
    if (session.proc) try { signalSubprocessTree(session.proc, 'SIGKILL'); } catch {}
    if (session.virtualTerminal) removeVirtualTerminal(session.info.id);
  }
  sessions.clear();

  // Agent worker children die with the daemon (shutdown msg + SIGTERM; their
  // SDK postmortem handlers run cleanup). SIGKILLed daemons are covered by the
  // workers' IPC-disconnect + ppid watchdogs instead.
  try { shutdownAgentHosts(); } catch {}
  try { shutdownOffloadWorker(); } catch {}

  stopListener(routerListener);
  safeUnlink(PID_FILE);
  safeUnlink(ROUTER_SOCKET);
}

// How long after last interaction before we consider the user "inactive"
const INTERACTION_TIMEOUT_MS = 30000; // 30 seconds
// Grace period after attach/detach - don't notify immediately
const ATTACH_GRACE_MS = 5000; // 5 seconds after attach
const DETACH_GRACE_MS = 5000; // 5 seconds after detach

type CtrlCMode = "auto" | "signal" | "byte";

const CTRL_C_MODE_ENV = "TMUX_LITE_CTRL_C_MODE";
const CTRL_C_MODE_VALUES = new Set<CtrlCMode>(["auto", "signal", "byte"]);
const ISIG_FLAG_BY_PLATFORM: Partial<Record<NodeJS.Platform, number>> = {
  darwin: 0x80,
  linux: 0x01,
  freebsd: 0x80,
  netbsd: 0x80,
  openbsd: 0x80,
};
const ETX_BYTE = 0x03;

function resolveCtrlCModeFromEnv(): CtrlCMode {
  const raw = process.env[CTRL_C_MODE_ENV]?.trim().toLowerCase();
  if (!raw) {
    return "auto";
  }

  if (CTRL_C_MODE_VALUES.has(raw as CtrlCMode)) {
    return raw as CtrlCMode;
  }

  console.warn(
    `[tmux-lite] Ignoring invalid ${CTRL_C_MODE_ENV}=${JSON.stringify(raw)} (expected auto|signal|byte)`
  );
  return "auto";
}

const ctrlCMode = resolveCtrlCModeFromEnv();

function terminalSignalsEnabled(ptyTerminal: Bun.Terminal): boolean {
  if (ctrlCMode === "signal") {
    return true;
  }

  if (ctrlCMode === "byte") {
    return false;
  }

  const isigFlag = ISIG_FLAG_BY_PLATFORM[process.platform];
  if (typeof isigFlag !== "number") {
    // Unknown platform: keep signal behavior so Ctrl+C still interrupts by default.
    return true;
  }

  // Closed terminals report 0; default to signal behavior in that edge case.
  const flags = ptyTerminal.localFlags;
  if (typeof flags !== "number" || flags === 0) {
    return true;
  }

  return (flags & isigFlag) !== 0;
}

function sendInterruptSignal(proc: Bun.Subprocess): boolean {
  return signalSubprocessTree(proc, 'SIGINT');
}

// ============================================================================
// OSC Pattern Registry
// ============================================================================

/**
 * Registry of OSC (Operating System Command) patterns for terminal notifications.
 * Each pattern matches specific escape sequences and extracts relevant data.
 */
interface OscPattern {
  name: string;
  pattern: RegExp;
  /** Extract notification data from a match. Returns null to skip notification. */
  extract: (match: RegExpMatchArray, context: OscMatchContext) => OscNotificationData | null;
}

interface OscMatchContext {
  sessionId: string;
  sessionName: string;
  processTitle: string;
  xterm: XTerminal;
  now: number;
}

interface OscNotificationData {
  type: InboxItem['type'];
  context: string;
  exitCode?: number;
}

const OSC_PATTERNS: OscPattern[] = [
  {
    // Custom exit code: ESC ] 777 ; exit : <code> BEL
    name: 'exit',
    pattern: /\x1b\]777;exit:(-?\d+)\x07/g,
    extract: (match, ctx) => ({
      type: 'exit',
      exitCode: parseInt(match[1], 10),
      context: getCurrentLine(ctx.xterm) || `Exit code: ${match[1]}`,
    }),
  },
  {
    // iTerm2/Growl notification: ESC ] 9 ; message BEL
    name: 'osc9',
    pattern: /\x1b\]9;([^\x07]*)\x07/g,
    extract: (match) => match[1] ? { type: 'osc', context: match[1] } : null,
  },
  {
    // Kitty notification: ESC ] 99 ; i=id:d=0; body BEL (simplified)
    name: 'osc99',
    pattern: /\x1b\]99;[^;]*;([^\x07]*)\x07/g,
    extract: (match) => match[1] ? { type: 'osc', context: match[1] } : null,
  },
  {
    // rxvt notification: ESC ] 777 ; notify ; title ; body BEL
    name: 'osc777notify',
    pattern: /\x1b\]777;notify;([^;]*);([^\x07]*)\x07/g,
    extract: (match) => ({
      type: 'osc',
      context: match[2] || match[1] || 'Notification',
    }),
  },
];

// Semantic shell integration patterns (OSC 133) - handled separately due to state tracking
const OSC_133_DONE_PATTERN = /\x1b\]133;D(?:;(\d+))?\x07/g;
const OSC_133_CMD_START = /\x1b\]133;C\x07/g;

/**
 * Process OSC patterns in terminal output and create inbox notifications.
 */
function processOscPatterns(
  str: string,
  ctx: OscMatchContext,
  addNotification: (data: OscNotificationData) => void
): void {
  for (const { name, pattern, extract } of OSC_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    const matches = [...str.matchAll(pattern)];
    for (const match of matches) {
      const data = extract(match, ctx);
      if (data) {
        addNotification(data);
        console.log(`[${ctx.sessionName}] ${name} notification: ${data.context.substring(0, 50)}`);
      }
    }
  }
}

// ============================================================================
// Inbox Notification Helpers
// ============================================================================

/**
 * Creates an inbox item with common fields populated.
 */
function createInboxNotification(
  sessionId: string,
  sessionName: string,
  type: InboxItem['type'],
  context: string,
  processTitle?: string,
  exitCode?: number
): Omit<InboxItem, 'id' | 'read'> {
  return {
    sessionId,
    sessionName,
    type,
    timestamp: Date.now(),
    context,
    processTitle,
    exitCode,
  };
}

// Check if user is actively using the session or recently attached/detached
// Returns true if we should SUPPRESS notifications
function isActivelyUsing(session: SessionData | undefined): boolean {
  if (!session) return false;

  const now = Date.now();

  // If recently detached, still suppress notifications (grace period)
  if (session.lastDetached > 0) {
    const timeSinceDetach = now - session.lastDetached;
    if (timeSinceDetach < DETACH_GRACE_MS) {
      return true; // Suppress - just detached
    }
  }

  // If not attached, don't suppress (unless in grace period above)
  if (!session.info.attached) return false;

  // If recently attached, suppress notifications (startup grace period)
  if (session.lastAttached > 0) {
    const timeSinceAttach = now - session.lastAttached;
    if (timeSinceAttach < ATTACH_GRACE_MS) {
      return true; // Suppress - just attached
    }
  }

  // If attached but never interacted AND past the attach grace period, don't suppress
  if (session.lastInteraction === 0) return false;

  // If attached and recently interacted, suppress
  const timeSinceInteraction = now - session.lastInteraction;
  return timeSinceInteraction < INTERACTION_TIMEOUT_MS;
}

let sessionCounter = 0;
let inboxCounter = 0;

function genId(): string {
  return String(sessionCounter++);
}

function genInboxId(): string {
  return String(inboxCounter++);
}

function buildCanonicalWorkspaceId(projectName: string, workspaceName: string): string {
  return `${projectName}:${workspaceName}`;
}

function createReplayId(sessionId: string): string {
  return `${Date.now()}-${sessionId}`;
}

function createReplayRuntime(
  sessionId: string,
  sessionName: string,
  cwd: string,
  cols: number,
  rows: number
): ReplayRuntime | null {
  const startedAt = Date.now();
  const replayId = createReplayId(sessionId);
  const workspaceRef = resolveWorkspaceRef(cwd);
  const workspaceId = workspaceRef
    ? buildCanonicalWorkspaceId(workspaceRef.projectName, workspaceRef.workspaceId)
    : undefined;

  const manifest: ReplayManifest = {
    version: 1,
    replayId,
    sessionId,
    sessionName,
    cwd,
    workspaceId,
    projectName: workspaceRef?.projectName,
    workspaceName: workspaceRef?.workspaceId,
    startedAt,
    status: "running",
    initialTerminal: {
      cols,
      rows,
      termType: process.env.TERM,
    },
    metadata: {},
    stats: {
      lastSeq: 0,
      eventCount: 0,
      checkpointCount: 0,
      durationMs: 0,
    },
  };

  try {
    initializeReplay(manifest);
    return {
      replayId,
      startedAt,
      nextSeq: 1,
      eventCount: 0,
      checkpointCount: 0,
      lastCheckpointAt: startedAt,
      bytesSinceCheckpoint: 0,
      outputEventsSinceCheckpoint: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[replay] failed to initialize replay for ${sessionName}: ${message}`);
    return null;
  }
}

function disableReplay(session: SessionData, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[replay] disabling replay for ${session.info.name}: ${message}`);
  session.replay = null;
}

function syncReplayManifest(
  session: SessionData,
  options: {
    status?: ReplayManifest["status"];
    endedAt?: number;
    title?: string;
    processTitle?: string;
    exitCode?: number;
    durationMs?: number;
  } = {}
): void {
  const replay = session.replay;
  if (!replay) {
    return;
  }

  const now = Date.now();
  const durationMs = Math.max(options.durationMs ?? 0, now - replay.startedAt);

  try {
    updateReplayManifest(replay.replayId, (manifest) => ({
      ...manifest,
      status: options.status ?? manifest.status,
      endedAt: options.endedAt ?? manifest.endedAt,
      metadata: {
        ...manifest.metadata,
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.processTitle !== undefined ? { processTitle: options.processTitle } : {}),
        ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
      },
      stats: {
        ...manifest.stats,
        lastSeq: Math.max(0, replay.nextSeq - 1),
        eventCount: replay.eventCount,
        checkpointCount: replay.checkpointCount,
        durationMs,
      },
    }));
  } catch (error) {
    disableReplay(session, error);
  }
}

function createReplayEvent(replay: ReplayRuntime, event: Omit<ReplayEvent, "v" | "seq" | "t">): ReplayEvent {
  const base = {
    v: 1 as const,
    seq: replay.nextSeq,
    t: Date.now() - replay.startedAt,
  };

  switch (event.type) {
    case "output":
      return { ...base, type: "output", encoding: event.encoding, data: event.data };
    case "input":
      return { ...base, type: "input", encoding: event.encoding, data: event.data };
    case "resize":
      return { ...base, type: "resize", cols: event.cols, rows: event.rows };
    case "marker":
      return { ...base, type: "marker", label: event.label };
    case "title":
      return { ...base, type: "title", title: event.title };
    case "process-title":
      return { ...base, type: "process-title", processTitle: event.processTitle };
    case "exit":
      return { ...base, type: "exit", code: event.code };
  }
}

function recordReplayEvent(session: SessionData, event: Omit<ReplayEvent, "v" | "seq" | "t">): void {
  const replay = session.replay;
  if (!replay) {
    return;
  }

  try {
    appendReplayEvent(replay.replayId, createReplayEvent(replay, event));
    replay.eventCount++;
    replay.nextSeq++;
  } catch (error) {
    disableReplay(session, error);
  }
}

function createReplayCheckpoint(replay: ReplayRuntime, session: SessionData): ReplayCheckpoint {
  const checkpointId = String(replay.checkpointCount).padStart(6, "0");
  return {
    version: 1,
    checkpointId,
    seq: Math.max(0, replay.nextSeq - 1),
    t: Date.now() - replay.startedAt,
    terminal: {
      cols: session.xterm.cols,
      rows: session.xterm.rows,
    },
    metadata: {
      title: session.processTitle || undefined,
      processTitle: session.processTitle || undefined,
      exitCode: session.info.exitCode,
    },
    serializer: {
      kind: "xterm-serialize",
      scrollbackLines: SERIALIZE_SCROLLBACK_LINES,
    },
    ansiPath: `checkpoints/${checkpointId}.ansi`,
  };
}

function writeReplayCheckpointNow(session: SessionData): void {
  const replay = session.replay;
  if (!replay) {
    return;
  }

  try {
    const checkpoint = createReplayCheckpoint(replay, session);
    const serialized = session.serialize.serialize({
      scrollback: SERIALIZE_SCROLLBACK_LINES,
    });
    writeReplayCheckpoint(replay.replayId, checkpoint, serialized);
    replay.checkpointCount++;
    replay.lastCheckpointAt = Date.now();
    replay.bytesSinceCheckpoint = 0;
    replay.outputEventsSinceCheckpoint = 0;
    syncReplayManifest(session);
  } catch (error) {
    disableReplay(session, error);
  }
}

function scheduleReplayCheckpoint(session: SessionData, force = false): void {
  const replay = session.replay;
  if (!replay) {
    return;
  }

  const now = Date.now();
  if (!force) {
    if (
      replay.bytesSinceCheckpoint < REPLAY_CHECKPOINT_BYTE_INTERVAL
      && replay.outputEventsSinceCheckpoint < REPLAY_CHECKPOINT_OUTPUT_EVENT_INTERVAL
    ) {
      return;
    }
    if (now - replay.lastCheckpointAt < REPLAY_CHECKPOINT_MIN_INTERVAL_MS) {
      return;
    }
  }

  if (session.replayCheckpointPending) {
    return;
  }

  session.replayCheckpointPending = true;
  const flush = () => {
    if (!sessions.has(session.info.id)) {
      return;
    }
    if (session.pendingWrites > 0) {
      setTimeout(flush, 10);
      return;
    }
    session.replayCheckpointPending = false;
    writeReplayCheckpointNow(session);
  };

  setTimeout(flush, 0);
}

function markReplayCrashed(session: SessionData, endedAt = Date.now()): void {
  if (!session.replay) {
    return;
  }
  syncReplayManifest(session, {
    status: "crashed",
    endedAt,
    processTitle: session.processTitle || undefined,
    durationMs: endedAt - session.replay.startedAt,
  });
}

function addInboxItem(item: Omit<InboxItem, 'id' | 'read'>): void {
  const session = sessions.get(item.sessionId);
  if (session?.info.kind === 'agent') {
    return;
  }
  // Check if this notification type is enabled in config
  if (!isNotificationTypeEnabled(item.type)) {
    return;
  }

  inbox.push({
    ...item,
    id: genInboxId(),
    read: false,
  });
  updateSessionAlertState(item.sessionId, {
    kind: item.type,
    preview: item.context,
    at: item.timestamp,
    unreadDelta: 1,
  });
  console.log(`[inbox] ${item.type}: ${item.sessionName} - ${item.context.substring(0, 50)}`);

  // Update titles for all attached sessions to show new inbox count
  broadcastTitleUpdate();
}

/**
 * Prune inbox items for a destroyed session.
 * This removes all notifications associated with a session when it exits,
 * keeping the inbox clean and ensuring the count only reflects active sessions.
 */
function pruneInboxForSession(sessionId: string): void {
  // Find and remove all inbox items for this session
  let i = inbox.length;
  while (i--) {
    if (inbox[i].sessionId === sessionId) {
      inbox.splice(i, 1);
    }
  }
  updateSessionAlertState(sessionId, { unreadDelta: 0 });
  console.log(`[inbox] Pruned notifications for session ${sessionId}`);
}

function getLastLines(xterm: XTerminal, count: number): string {
  const buffer = xterm.buffer.active;
  const lines: string[] = [];
  const startRow = Math.max(0, buffer.cursorY - count + 1);

  for (let i = startRow; i <= buffer.cursorY; i++) {
    const line = buffer.getLine(i)?.translateToString(true);
    if (line) lines.push(line);
  }

  return lines.join('\n').trim();
}

function getCurrentLine(xterm: XTerminal): string {
  const buffer = xterm.buffer.active;
  return buffer.getLine(buffer.cursorY)?.translateToString(true)?.trim() || '';
}

/**
 * Get count of unread inbox items, bounded by active sessions.
 * Returns the number of unique active sessions that have unread notifications,
 * not the total number of unread items. This prevents the count from growing
 * unboundedly (e.g., to 3000) and instead caps it at one per active session.
 */
function getUnreadInboxCount(): number {
  // Get unique session IDs that have unread items AND are still active
  const activeSessionsWithUnread = new Set<string>();
  
  for (const item of inbox) {
    if (!item.read && sessions.has(item.sessionId)) {
      activeSessionsWithUnread.add(item.sessionId);
    }
  }
  
  return activeSessionsWithUnread.size;
}

function buildTitle(sessionName: string, processTitle?: string): string {
  const unread = getUnreadInboxCount();
  let title = `tl: ${sessionName}`;

  if (processTitle) {
    title += ` | ${processTitle}`;
  }

  if (unread > 0) {
    title += ` (${unread} 🔔)`;
  }

  return title;
}

function sendTitle(session: SessionData, sessionName: string, processTitle?: string): void {
  if (!session.client) return;
  const title = buildTitle(sessionName, processTitle);
  // OSC 0 sets both icon and window title - must be framed!
  writeToClient(session, encodePTY(Buffer.from(`\x1b]0;${title}\x07`)));
}

function broadcastTitleUpdate(): void {
  // Update title for all attached sessions
  for (const [id, session] of sessions) {
    if (session.client) {
      sendTitle(session, session.info.name, session.processTitle);
    }
  }
}

// RIS (Reset to Initial State) - the nuclear option that resets everything
const TERM_RESET = Buffer.from("\x1bc");

// ============================================================================
// Session Helper Functions
// ============================================================================

/**
 * Configuration for idle detection in a session.
 */
interface IdleDetectionState {
  lastOutputTime: number;
  outputSinceIdle: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const IDLE_THRESHOLD_MS = 10000; // 10 seconds of quiet after output
const MIN_OUTPUT_FOR_IDLE = 500; // Need at least 500 bytes of output to consider "activity"

/**
 * Creates the idle detection check function for a session.
 */
function createIdleChecker(
  id: string,
  sessionName: string,
  xterm: XTerminal,
  idleState: IdleDetectionState,
  getProcessTitle: () => string
): () => void {
  return () => {
    const session = sessions.get(id);
    // Only notify if: not actively using, had significant output, and now idle
    if (!isActivelyUsing(session) && idleState.outputSinceIdle >= MIN_OUTPUT_FOR_IDLE) {
      const context = getLastLines(xterm, 3) || '(idle)';
      addInboxItem(createInboxNotification(
        id,
        sessionName,
        'idle',
        context,
        session?.processTitle || getProcessTitle()
      ));
      console.log(`[${sessionName}] idle notification after ${idleState.outputSinceIdle} bytes output`);
    }
    idleState.outputSinceIdle = 0;
  };
}

/**
 * Sets up xterm event handlers for bell and title change notifications.
 */
function setupXtermEventHandlers(
  id: string,
  sessionName: string,
  xterm: XTerminal
): { getProcessTitle: () => string; setProcessTitle: (title: string) => void } {
  let processTitle = '';
  let lastBellTime = 0;
  let lastTitleNotification = 0;

  // Track bells for inbox notifications (with debounce)
  xterm.onBell(() => {
    const session = sessions.get(id);
    // Don't notify if user is actively using the session
    if (isActivelyUsing(session)) return;

    const now = Date.now();
    // Debounce: ignore bells within 500ms of each other
    if (now - lastBellTime < 500) return;
    lastBellTime = now;

    // Get last few lines for context (not just current line)
    const context = getLastLines(xterm, 3) || getCurrentLine(xterm) || '(bell)';
    addInboxItem(createInboxNotification(
      id,
      sessionName,
      'bell',
      context,
      session?.processTitle
    ));
  });

  // Track title changes from running processes
  xterm.onTitleChange((title) => {
    console.log(`[${sessionName}] title changed: "${title}"`);
    const previousTitle = processTitle;
    processTitle = title;
    const session = sessions.get(id);
    if (session) {
      updateSessionTitleState(id, title);
      recordReplayEvent(session, { type: "process-title", processTitle: title });
      syncReplayManifest(session, { processTitle: title, title });
      // Update client's terminal title if attached
      if (session.client) {
        sendTitle(session, sessionName, title);
      }

      // Create inbox notification for ANY title change when not actively using
      // This helps track when background processes change state
      const now = Date.now();
      if (!isActivelyUsing(session) && title && title !== previousTitle) {
        // Debounce: don't notify more than once per 3 seconds
        if (now - lastTitleNotification > 3000) {
          lastTitleNotification = now;
          addInboxItem(createInboxNotification(
            id,
            sessionName,
            'title',
            title,
            title
          ));
          console.log(`[${sessionName}] title change: ${previousTitle} -> ${title}`);
        }
      }
    }
  });

  return {
    getProcessTitle: () => processTitle,
    setProcessTitle: (title: string) => { processTitle = title; },
  };
}

/**
 * State for tracking OSC 133 shell integration commands.
 */
interface Osc133State {
  commandRunning: boolean;
  commandStartTime: number;  // Timestamp when command started (for duration filter)
}

/**
 * Creates the PTY data handler that processes terminal output.
 */
function createPtyDataHandler(
  id: string,
  sessionName: string,
  xterm: XTerminal,
  idleState: IdleDetectionState,
  osc133State: Osc133State,
  checkIdle: () => void,
  getProcessTitle: () => string
): (term: Bun.Terminal, data: Buffer) => void {
  return (term, data) => {
    // Track output for idle detection
    idleState.lastOutputTime = Date.now();
    idleState.outputSinceIdle += data.length;

    // Reset idle timer
    if (idleState.idleTimer) clearTimeout(idleState.idleTimer);
    idleState.idleTimer = setTimeout(checkIdle, IDLE_THRESHOLD_MS);

    const session = sessions.get(id);
    if (!session) return;

    if (data.length > 0) {
      recordReplayEvent(session, {
        type: "output",
        encoding: "base64",
        data: data.toString("base64"),
      });
      if (session.replay) {
        session.replay.outputEventsSinceCheckpoint += 1;
      }
    }
    if (session.replay) {
      session.replay.bytesSinceCheckpoint += data.length;
      scheduleReplayCheckpoint(session);
    }

    const str = data.toString();
    const now = Date.now();

    // Only create inbox notifications if user is not actively using the session
    const activelyUsing = session.attaching || isActivelyUsing(session);
    const currentProcessTitle = session.processTitle || getProcessTitle();

    // Process OSC patterns for notifications (only if not actively using)
    if (!activelyUsing) {
      const oscContext: OscMatchContext = {
        sessionId: id,
        sessionName,
        processTitle: currentProcessTitle,
        xterm,
        now,
      };

      processOscPatterns(str, oscContext, (notifData) => {
        addInboxItem(createInboxNotification(
          id,
          sessionName,
          notifData.type,
          notifData.context,
          currentProcessTitle,
          notifData.exitCode
        ));
      });
    }

    // Check for semantic shell integration (OSC 133)
    // Command start
    if (OSC_133_CMD_START.test(str)) {
      osc133State.commandRunning = true;
      osc133State.commandStartTime = now;
      OSC_133_CMD_START.lastIndex = 0; // Reset regex state
    }

    // Command done - only notify if not actively using and command was running
    OSC_133_DONE_PATTERN.lastIndex = 0;
    const osc133DoneMatches = [...str.matchAll(OSC_133_DONE_PATTERN)];
    for (const match of osc133DoneMatches) {
      const exitCode = match[1] ? parseInt(match[1], 10) : 0;
      const commandDuration = osc133State.commandStartTime > 0
        ? now - osc133State.commandStartTime
        : 0;

      // Only notify for background sessions if:
      // - Non-zero exit (always notify on errors)
      // - OR command duration >= minCommandDurationMs
      const shouldNotify = !activelyUsing && (
        exitCode !== 0 ||
        (osc133State.commandRunning && commandDuration >= notificationConfig.minCommandDurationMs)
      );

      if (shouldNotify) {
        const context = getLastLines(xterm, 2) || `Command finished (exit ${exitCode})`;
        addInboxItem(createInboxNotification(
          id,
          sessionName,
          exitCode !== 0 ? 'exit' : 'osc',
          context,
          currentProcessTitle,
          exitCode !== 0 ? exitCode : undefined
        ));
        console.log(`[${sessionName}] OSC 133 command done: exit ${exitCode}, duration ${commandDuration}ms`);
      }
      osc133State.commandRunning = false;
      osc133State.commandStartTime = 0;
    }

    // Pass original data through unchanged to preserve all escape sequences
    // Our custom OSC 777 exit sequences are harmless - terminals ignore unknown OSC
    // Converting to string and back was corrupting cursor movement/screen control sequences

    // Keep xterm state current during attach so the client can be seeded
    // from the latest terminal snapshot instead of replaying queued output.
    session.pendingWrites++;
    xterm.write(data, () => {
      session.pendingWrites--;
    });

    if (session.attaching) {
      session.attachDirty = true;
      return;
    }

    // Send to client (buffered - avoid framed protocol desync on backpressure)
    writeToClient(session, encodePTY(data));
  };
}

/**
 * Handles process exit and cleanup for a session.
 */
function handleProcessExit(
  id: string,
  sessionName: string,
  xterm: XTerminal,
  socketPath: string,
  disposeDsr: () => void,
  getProcessTitle: () => string
): (code: number) => void {
  return (code) => {
    const session = sessions.get(id);
    if (!session) {
      return;
    }
    const endedAt = Date.now();

    // Clean up parser hooks
    try { disposeDsr(); } catch {}

    // Prune old inbox items for this session so inbox stays bounded to active sessions.
    // Do this before adding the final exit notification so the user still sees the exit event.
    pruneInboxForSession(id);

    // Capture last lines for inbox before disposing xterm
    const context = getLastLines(xterm, 3);
    addInboxItem(createInboxNotification(
      id,
      sessionName,
      'exit',
      context || `Session ended (exit ${code})`,
      session?.processTitle || getProcessTitle(),
      code
    ));

    // Update session info with exit code
    session.info.exitCode = code;
    recordReplayEvent(session, { type: "exit", code });
    syncReplayManifest(session, {
      status: "closed",
      endedAt,
      exitCode: code,
      processTitle: session.processTitle || getProcessTitle(),
      durationMs: session.replay ? endedAt - session.replay.startedAt : undefined,
    });

    if (session.client) {
      writeToClient(session, encodeControl({ type: "exited", code }));
      try { session.client.end(); } catch {}
    }

    xterm.dispose();
    cleanupSessionResources(session);
    applyTerminalScopedUpdate(session.info.id);
    console.log(`[${sessionName}] exited (${code})`);
  };
}

/**
 * Sends cursor visibility and style state to the client.
 */
function sendCursorState(session: SessionData): void {
  // Access xterm internal API for cursor hidden state
  // Note: _core is not part of the public API but is stable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const xtermInternal = session.xterm as { _core?: { coreService?: { isCursorHidden?: boolean } } };
  const isCursorHidden = xtermInternal._core?.coreService?.isCursorHidden;
  if (typeof isCursorHidden === "boolean") {
    writeToClient(session, encodePTY(Buffer.from(isCursorHidden ? "\x1b[?25l" : "\x1b[?25h")));
  }

  const cursorStyle = session.xterm.options.cursorStyle;
  const cursorBlink = session.xterm.options.cursorBlink;
  let cursorStyleParam: number | null = null;
  if (cursorStyle === "block") {
    cursorStyleParam = cursorBlink ? 2 : 1;
  } else if (cursorStyle === "underline") {
    cursorStyleParam = cursorBlink ? 4 : 3;
  } else if (cursorStyle === "bar") {
    cursorStyleParam = cursorBlink ? 6 : 5;
  }
  if (cursorStyleParam !== null) {
    writeToClient(session, encodePTY(Buffer.from(`\x1b[${cursorStyleParam} q`)));
  }
}

/**
 * Clears the attach timer for a session.
 */
function clearAttachTimer(session: SessionData): void {
  if (session.attachTimer) {
    clearTimeout(session.attachTimer);
    session.attachTimer = null;
  }
}

/**
 * Sends serialized terminal state to client during attach.
 */
function sendSerializedState(session: SessionData, sessionName: string): void {
  // Debug mode: skip xterm serialization to test if it's the issue
  const skipSerialize = process.env.TMUX_LITE_SKIP_SERIALIZE === '1';

  try {
    // Send reset first to clear any bad modes
    console.log(`[${sessionName}] sending TERM_RESET`);
    writeChunkedPtyToClient(session, TERM_RESET);
    writeChunkedPtyToClient(session, Buffer.from("\x1b[2J\x1b[H")); // clear + home

    if (!skipSerialize) {
      // Get serialized terminal state (including modes) for consistent redraws
      // Limit scrollback to prevent oversized payloads
      const serialized = session.serialize.serialize({
        scrollback: SERIALIZE_SCROLLBACK_LINES,
      });
      const serializedBytes = Buffer.from(serialized);

      // Log size for debugging
      const sizeKB = Math.round(serializedBytes.length / 1024);
      if (serializedBytes.length > PTY_CHUNK_SIZE) {
        console.log(`[${sessionName}] serialized ${serializedBytes.length} bytes (${sizeKB}KB) - will send in chunks`);
      } else {
        console.log(`[${sessionName}] serialized ${serializedBytes.length} bytes (${sizeKB}KB)`);
      }

      const chunkCount = writeChunkedPtyToClient(session, serializedBytes);
      if (chunkCount > 1) {
        console.log(`[${sessionName}] attached (restored ${serializedBytes.length} bytes in ${chunkCount} chunks)`);
      } else {
        console.log(`[${sessionName}] attached (restored ${serializedBytes.length} bytes)`);
      }
    } else {
      console.log(`[${sessionName}] attached (serialization skipped for debugging)`);
    }
  } catch (e) {
    console.log(`[${sessionName}] serialize error:`, e);
    // Fallback: just send a reset
    writeChunkedPtyToClient(session, TERM_RESET);
    writeChunkedPtyToClient(session, Buffer.from("\x1b[2J\x1b[H"));
  }
}

/**
 * Creates the startAttach function that handles the attach process.
 */
function createStartAttach(sessionName: string): (session: SessionData) => void {
  return (session: SessionData) => {
    if (!session.attachPending || !session.client) return;
    session.attachPending = false;
    clearAttachTimer(session);

    const settleAndSendState = () => {
      if (session.pendingWrites > 0) {
        setTimeout(settleAndSendState, 10);
        return;
      }

      session.attachDirty = false;
      sendSerializedState(session, sessionName);
      sendCursorState(session);

      const attachStart = Date.now();
      const finalizeAttach = () => {
        if (session.pendingWrites > 0 && Date.now() - attachStart < 500) {
          setTimeout(finalizeAttach, 10);
          return;
        }

        if (session.attachDirty && Date.now() - attachStart < 500) {
          setTimeout(settleAndSendState, 10);
          return;
        }

        session.attaching = false;

        writeToClient(session, encodeControl({ type: "attached" }));
        pushSessionMeta(session);

        // Set terminal title
        sendTitle(session, sessionName, session.processTitle);
      };

      finalizeAttach();
    };

    settleAndSendState();
  };
}

/**
 * Creates socket handlers for a session.
 */
function createSessionSocketHandlers(
  id: string,
  sessionName: string,
  proc: Bun.Subprocess,
  startAttach: (session: SessionData) => void
): {
  open: (socket: any) => void;
  data: (socket: any, data: Buffer) => void;
  drain: (socket: any) => void;
  close: (socket: any) => void;
} {
  return {
    open(socket) {
      const session = sessions.get(id);
      if (!session) return socket.end();

      // Kick existing client
      if (session.client) {
        writeToClient(session, encodeControl({ type: "kicked" }));
        session.client.end();
      }

      session.attaching = true;
      session.attachPending = true;
      session.attachDirty = false;
      session.client = socket;
      session.clientWriter = createBufferedSocketWriter(socket);
      session.info.attached = true;
      session.lastAttached = Date.now(); // Record attach time for grace period
      session.ctrlBuffer = Buffer.alloc(0);
      clearAttachTimer(session);
      // Fallback timeout - client should send attach-init immediately, but just in case
      session.attachTimer = setTimeout(() => {
        if (session.attachPending) {
          console.log(`[${sessionName}] WARN: attach-init not received after 5s, starting attach anyway`);
          startAttach(session);
        }
      }, 5000);
    },

    data(socket, data) {
      const session = sessions.get(id);
      if (!session) return;

      const applyResize = (cols: number, rows: number) => {
        const nextSize = clampTerminalSize(cols, rows, {
          cols: session.xterm.cols,
          rows: session.xterm.rows,
        });
        try {
          session.ptyTerminal.resize(nextSize.cols, nextSize.rows);
          session.xterm.resize(nextSize.cols, nextSize.rows);
          recordReplayEvent(session, { type: "resize", cols: nextSize.cols, rows: nextSize.rows });
          scheduleReplayCheckpoint(session, true);
          // Send SIGWINCH to process group so children (vim, etc.) get it
          try {
            process.kill(-proc.pid, "SIGWINCH");
          } catch {
            try {
              process.kill(proc.pid, "SIGWINCH");
            } catch {}
          }
        } catch {}
      };

      let buf = Buffer.from(data);

      // Prepend any buffered data
      if (session.ctrlBuffer.length > 0) {
        buf = Buffer.concat([session.ctrlBuffer, buf]);
      }

      // Parse frames using the new framed protocol
      let frames;
      let remaining;
      try {
        const result = parseFrames(buf);
        frames = result.frames;
        remaining = result.remaining;
      } catch (err) {
        // Protocol error - likely desync or corrupted data
        const msg = err instanceof Error ? err.message : 'Frame parse error';
        console.error(`[${sessionName}] Frame parse error: ${msg}`);
        // Close the client connection on protocol error
        socket.end();
        return;
      }
      // Copy remaining bytes - subarray references can become invalid when Bun reuses buffers
      session.ctrlBuffer = Buffer.from(remaining);

      for (const frame of frames) {
        if (frame.type === FrameType.CONTROL) {
          const ctrl = decodeControl(frame.payload) as SessionCtrl;
          if (ctrl.type === "resize" || ctrl.type === "attach-init") {
            applyResize(ctrl.cols, ctrl.rows);
            if (session.attaching && session.attachPending) {
              startAttach(session);
            }
          } else if (ctrl.type === "detach") {
            // Send reset before detaching to clean up client terminal
            writeToClient(session, encodePTY(TERM_RESET));
            session.client = null;
            session.clientWriter = null;
            session.info.attached = false;
            session.attaching = false;
            session.attachPending = false;
            clearAttachTimer(session);
            session.attachDirty = false;
            session.lastDetached = Date.now(); // Record detach time for grace period
            socket.end();
            console.log(`[${sessionName}] detached`);
          }
        } else if (frame.type === FrameType.PTY) {
          // Workaround for Bun PTY Ctrl+C line-discipline behavior.
          // Auto mode respects raw-mode apps (ISIG off => pass ETX through).
          // Override with TMUX_LITE_CTRL_C_MODE=signal|byte.
          if (frame.payload.length === 1 && frame.payload[0] === ETX_BYTE) {
            const shouldSignal = terminalSignalsEnabled(session.ptyTerminal);
            if (shouldSignal) {
              const signaled = sendInterruptSignal(proc);
              if (!signaled) {
                session.ptyTerminal.write(frame.payload);
              }
            } else {
              session.ptyTerminal.write(frame.payload);
            }
          } else {
            // Raw PTY input - write to terminal
            session.ptyTerminal.write(frame.payload);
          }
          if (RECORD_REPLAY_INPUT) {
            recordReplayEvent(session, {
              type: "input",
              encoding: "base64",
              data: Buffer.from(frame.payload).toString("base64"),
            });
          }
          // Track last interaction time
          session.lastInteraction = Date.now();
        }
      }
    },

    drain(socket) {
      const session = sessions.get(id);
      if (session && session.client === socket) {
        flushClient(session);
      }
    },

    close(socket) {
      const session = sessions.get(id);
      if (session && session.client === socket) {
        session.client = null;
        session.clientWriter = null;
        session.info.attached = false;
        session.attaching = false;
        session.attachPending = false;
        clearAttachTimer(session);
        session.attachDirty = false;
        console.log(`[${sessionName}] disconnected`);
      }
    }
  };
}

/**
 * Builds the shell environment with integration hooks.
 */
function buildShellEnvironment(
  id: string,
  shell: string,
  hooks?: SessionCreateHooks
): Record<string, string> {
  // Shell integration: report non-zero exit codes via OSC 777
  // This creates inbox notifications for failed commands
  const exitReporter = '__tl_report() { local e=$?; [[ $e -ne 0 ]] && printf "\\033]777;exit:%d\\007" "$e"; return $e; }';

  const shellEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    TMUX_LITE: id,
    ...(hooks?.env ?? {}),
  };

  const shellName = shell.split('/').pop() ?? '';

  // Add PROMPT_COMMAND only for bash-compatible shells.
  if (shellName === 'bash' || shellName === 'rbash') {
    const existingPrompt = process.env.PROMPT_COMMAND || '';
    shellEnv.PROMPT_COMMAND = `${exitReporter}; __tl_report${existingPrompt ? '; ' + existingPrompt : ''}`;
  }

  return shellEnv;
}

function getShellInitScript(shell: string, hooks?: SessionCreateHooks): string | null {
  const shellInit = hooks?.shellInit;
  if (!shellInit) return null;

  const shellName = shell.split('/').pop() ?? '';
  const scriptParts: string[] = [];

  if (shellInit.all) {
    scriptParts.push(shellInit.all);
  }

  const isBashShell = shellName === 'bash' || shellName === 'rbash';
  const isZshShell = shellName === 'zsh';
  const isShShell = shellName === 'sh' || shellName === 'dash';

  if (isBashShell && shellInit.bash) {
    scriptParts.push(shellInit.bash);
  } else if (isZshShell && shellInit.zsh) {
    scriptParts.push(shellInit.zsh);
  } else if (isShShell && shellInit.sh) {
    scriptParts.push(shellInit.sh);
  }

  if (scriptParts.length === 0) {
    return null;
  }

  return `${scriptParts.join('\n')}\n`;
}

function cleanupFailedSessionCreation(
  sessionName: string,
  proc: Bun.Subprocess,
  xterm: XTerminal,
  disposeDsr: () => void,
  socketPath: string,
  ptyTerminal?: Bun.Terminal | null
): void {
  try { disposeDsr(); } catch {}
  try { signalSubprocessTree(proc, 'SIGKILL'); } catch {}
  try { xterm.dispose(); } catch {}
  // Release the PTY master fd on the failed-startup path too.
  if (ptyTerminal) { try { ptyTerminal.close(); } catch {} }
  safeUnlink(socketPath);
  console.warn(`[${sessionName}] cleaned up failed session startup`);
}

// ============================================================================
// Main Session Creation
// ============================================================================

function createSession(
  name: string | undefined,
  cwd: string,
  options?: {
    hooks?: SessionCreateHooks;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    kind?: import('./protocol.js').SessionKind;
    hidden?: boolean;
    recordReplay?: boolean;
    metadata?: Record<string, string>;
  }
): Session {
  const id = genId();
  const sessionName = name || `session-${id}`;
  const socketPath = getSessionSocketPath(id);
  const socketDir = dirname(socketPath);
  if (!existsSync(socketDir)) {
    mkdirSync(socketDir, { recursive: true });
  }
  safeUnlink(socketPath);

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const replay = options?.recordReplay === false ? null : createReplayRuntime(id, sessionName, cwd, cols, rows);

  // Create xterm-headless for proper terminal state tracking
  const xterm = new XTerminal({
    cols,
    rows,
    // Keep stored scrollback bounded.
    scrollback: 2_000,
    allowProposedApi: true,
  });

  const serialize = new SerializeAddon();
  xterm.loadAddon(serialize);

  // Set up xterm event handlers for notifications (bell, title changes)
  const { getProcessTitle } = setupXtermEventHandlers(id, sessionName, xterm);

  // Initialize idle detection state
  const idleState: IdleDetectionState = {
    lastOutputTime: 0,
    outputSinceIdle: 0,
    idleTimer: null,
  };

  // Initialize OSC 133 state for shell integration
  const osc133State: Osc133State = {
    commandRunning: false,
    commandStartTime: 0,
  };

  // Create the idle checker function
  const checkIdle = createIdleChecker(id, sessionName, xterm, idleState, getProcessTitle);

  // Create PTY terminal with data handler
  const ptyDataHandler = createPtyDataHandler(
    id,
    sessionName,
    xterm,
    idleState,
    osc133State,
    checkIdle,
    getProcessTitle
  );

  const ptyTerminal = new Bun.Terminal({
    cols,
    rows,
    data: ptyDataHandler,
  });

  // Terminal query support (server-side): respond to DSR (CSI 6 n) with CPR.
  const disposeDsr = installDsrCprResponder(xterm, (data) => {
    try { ptyTerminal.write(data); } catch {}
  });

  // Spawn shell process (or custom command if provided)
  const shell = process.env.SHELL || "/bin/bash";
  const hooks = options?.hooks;
  const shellEnv = buildShellEnvironment(id, shell, hooks);

  const spawnCmd = options?.command
    ? [options.command, ...(options.args ?? [])]
    : [shell];
  const spawnEnv = {
    ...shellEnv,
    ...(options?.env ?? {}),
  };

  const isolateProcessGroup = options?.metadata?.role === 'process';

  const proc = Bun.spawn(spawnCmd, {
    terminal: ptyTerminal,
    cwd,
    env: spawnEnv,
    detached: isolateProcessGroup,
  });

  const shellInitScript = getShellInitScript(shell, hooks);
  if (shellInitScript) {
    try {
      ptyTerminal.write(shellInitScript);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[${sessionName}] failed to apply shell init hook: ${message}`);
    }
  }

  // Handle process exit
  proc.exited
    .then(handleProcessExit(id, sessionName, xterm, socketPath, disposeDsr, getProcessTitle))
    .catch((err: unknown) => console.error(`[${sessionName}] proc.exited handler failed:`, err));

  // Create session info
  const info: Session = {
    id,
    name: sessionName,
    socketPath,
    pid: proc.pid,
    attached: false,
    cwd,
    createdAt: Date.now(),
    kind: options?.kind ?? 'shell',
    hidden: options?.hidden ?? false,
    metadata: options?.metadata,
  };

  // Create attach handler
  const startAttach = createStartAttach(sessionName);

  // Create and bind socket handlers
  const socketHandlers = createSessionSocketHandlers(id, sessionName, proc, startAttach);

  // Create session socket
  let listener;
  try {
    listener = Bun.listen({
      unix: socketPath,
      socket: socketHandlers,
    });
  } catch (error) {
    cleanupFailedSessionCreation(sessionName, proc, xterm, disposeDsr, socketPath, ptyTerminal);
    throw error;
  }

  // Store session data
  sessions.set(id, {
    info,
    listener,
    ptyTerminal,
    xterm,
    serialize,
    idleState,
    proc,
    virtualTerminal: null,
    client: null,
    clientWriter: null,
    ctrlBuffer: Buffer.alloc(0),
    pendingWrites: 0,
    attaching: false,
    attachDirty: false,
    attachPending: false,
    attachTimer: null,
    processTitle: '',
    terminalTitle: '',
    unreadAlertCount: 0,
    lastInteraction: 0,
    lastDetached: 0,
    lastAttached: 0,
    replay,
    replayCheckpointPending: false,
    cleanupComplete: false,
    termination: null,
  });

  const session = sessions.get(id);
  if (session?.replay) {
    writeReplayCheckpointNow(session);
  }

  console.log(`[${sessionName}] created (pid ${proc.pid})`);
  return info;
}

/**
 * Create a virtual session backed by VirtualTerminal instead of a PTY child process.
 * The coordinator retrieves the registered VirtualTerminal and boots
 * InteractiveMode in-process against the same xterm-headless state.
 */
function createVirtualSession(
  name: string | undefined,
  cwd: string,
  options?: {
    cols?: number;
    rows?: number;
    kind?: import('./protocol.js').SessionKind;
    hidden?: boolean;
    metadata?: Record<string, string>;
  }
): Session {
  const id = genId();
  const sessionName = name || `virtual-${id}`;
  const socketPath = getSessionSocketPath(id);
  const socketDir = dirname(socketPath);
  if (!existsSync(socketDir)) {
    mkdirSync(socketDir, { recursive: true });
  }
  safeUnlink(socketPath);

  const { cols, rows } = clampTerminalSize(options?.cols, options?.rows);
  const xterm = new XTerminal({
    cols,
    rows,
    scrollback: 100,
    allowProposedApi: true,
  });

  const serialize = new SerializeAddon();
  xterm.loadAddon(serialize);

  setupXtermEventHandlers(id, sessionName, xterm);

  const idleState: IdleDetectionState = {
    lastOutputTime: 0,
    outputSinceIdle: 0,
    idleTimer: null,
  };

  const virtualTerminal = new VirtualTerminal(cols, rows, (data: string) => {
    idleState.lastOutputTime = Date.now();
    idleState.outputSinceIdle += data.length;

    const session = sessions.get(id);
    if (!session) return;

    forwardVirtualTerminalOutput(
      session,
      (chunk, callback) => xterm.write(chunk, callback),
      (chunk) => { writeChunkedPtyToClient(session, chunk); },
      data,
    );
  });

  registerVirtualTerminal(id, virtualTerminal);

  const info: Session = {
    id,
    name: sessionName,
    socketPath,
    pid: process.pid,
    attached: false,
    cwd,
    createdAt: Date.now(),
    kind: options?.kind ?? 'agent',
    hidden: options?.hidden ?? true,
    metadata: options?.metadata,
  };

  const startAttach = createStartAttach(sessionName);
  const socketHandlers = {
    open(socket: any) {
      const session = sessions.get(id);
      if (!session) return socket.end();

      if (session.client) {
        writeToClient(session, encodeControl({ type: 'kicked' }));
        session.client.end();
      }

      session.attaching = true;
      session.attachPending = true;
      session.attachDirty = false;
      session.client = socket;
      session.clientWriter = createBufferedSocketWriter(socket);
      session.info.attached = true;
      session.lastAttached = Date.now();
      session.ctrlBuffer = Buffer.alloc(0);
      clearAttachTimer(session);
      session.attachTimer = setTimeout(() => {
        if (session.attachPending) {
          console.log(`[${sessionName}] WARN: attach-init not received after 5s, starting attach anyway`);
          startAttach(session);
        }
      }, 5000);
    },

    data(socket: any, data: Buffer) {
      const session = sessions.get(id);
      if (!session) return;
      const applyResize = (cols: number, rows: number) => {
        const nextSize = clampTerminalSize(cols, rows, {
          cols: session.xterm.cols,
          rows: session.xterm.rows,
        });
        try {
          virtualTerminal.resize(nextSize.cols, nextSize.rows);
          session.xterm.resize(nextSize.cols, nextSize.rows);
        } catch {}
      };

      let buf = Buffer.from(data);
      if (session.ctrlBuffer.length > 0) {
        buf = Buffer.concat([session.ctrlBuffer, buf]);
      }

      let frames;
      let remaining;
      try {
        const result = parseFrames(buf);
        frames = result.frames;
        remaining = result.remaining;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Frame parse error';
        console.error(`[${sessionName}] Frame parse error: ${msg}`);
        socket.end();
        return;
      }
      session.ctrlBuffer = Buffer.from(remaining);

      for (const frame of frames) {
        if (frame.type === FrameType.CONTROL) {
          const ctrl = decodeControl(frame.payload) as SessionCtrl;
          if (ctrl.type === 'resize' || ctrl.type === 'attach-init') {
            applyResize(ctrl.cols, ctrl.rows);
            if (session.attaching && session.attachPending) {
              startAttach(session);
            }
          } else if (ctrl.type === 'detach') {
            writeToClient(session, encodePTY(TERM_RESET));
            session.client = null;
            session.clientWriter = null;
            session.info.attached = false;
            session.attaching = false;
            session.attachPending = false;
            clearAttachTimer(session);
            session.attachDirty = false;
            session.lastDetached = Date.now();
            socket.end();
            console.log(`[${sessionName}] detached`);
          }
        } else if (frame.type === FrameType.PTY) {
          virtualTerminal.injectInput(Buffer.from(frame.payload).toString('utf-8'));
          session.lastInteraction = Date.now();
        }
      }
    },

    drain(socket: any) {
      const session = sessions.get(id);
      if (session && session.client === socket) flushClient(session);
    },

    close(socket: any) {
      const session = sessions.get(id);
      if (session && session.client === socket) {
        session.client = null;
        session.clientWriter = null;
        session.info.attached = false;
        session.attaching = false;
        session.attachPending = false;
        clearAttachTimer(session);
        session.attachDirty = false;
        console.log(`[${sessionName}] disconnected`);
      }
    },
  };

  let listener;
  try {
    listener = Bun.listen({
      unix: socketPath,
      socket: socketHandlers,
    });
  } catch (error) {
    removeVirtualTerminal(id);
    try { xterm.dispose(); } catch {}
    safeUnlink(socketPath);
    throw error;
  }

  sessions.set(id, {
    info,
    listener,
    ptyTerminal: null,
    xterm,
    serialize,
    idleState,
    proc: null,
    virtualTerminal,
    client: null,
    clientWriter: null,
    ctrlBuffer: Buffer.alloc(0),
    pendingWrites: 0,
    attaching: false,
    attachDirty: false,
    attachPending: false,
    attachTimer: null,
    processTitle: '',
    terminalTitle: '',
    unreadAlertCount: 0,
    lastInteraction: 0,
    lastDetached: 0,
    lastAttached: 0,
    replay: null,
    replayCheckpointPending: false,
    cleanupComplete: false,
    termination: null,
  });

  console.log(`[${sessionName}] virtual session created`);
  return info;
}

// Router server
/** Request/response command dispatch — the single implementation behind BOTH
 *  transports: the unix socket handler AND (daemon-unification P3) the
 *  in-process remote session-handler, which previously round-tripped every
 *  typed command through the socket to itself. Connection-coupled commands
 *  (attach/watch/delete streams, kill-server) stay in the socket handler
 *  and are unreachable here (dispatch returns their error via default).
 */
export async function dispatchCommand(cmd: Command): Promise<Response | null> {
  // Project agents: '<project>:@base' pseudo-workspace targets resolve to
  // the project BASE clone (main artifacts mount) — normalize here so
  // every handler on either transport sees a real path.
  if ('target' in cmd && cmd.target && typeof cmd.target === 'object' && 'workspaceName' in cmd.target && (cmd.target as { workspaceName?: string }).workspaceName === '@base') {
    try {
      const { getProjectBaseDir } = await import('../../core/config.js');
      const t = cmd.target as { workspaceId: string; workspaceName: string; workspacePath: string; projectName: string };
      t.workspacePath = getProjectBaseDir(t.projectName);
      t.workspaceId = `${t.projectName}:@base`;
    } catch { /* leave as-is; handler will error */ }
  }
  let res: Response | null = null;
  switch (cmd.type) {
          case "list":
            res = {
              type: "sessions",
              sessions: Array.from(sessions.values()).map(getSessionInfo)
            };
            break;

          case "list-replays":
            res = {
              type: "replays",
              replays: listReplayInfos({
                workspaceId: cmd.workspaceId,
                sessionId: cmd.sessionId,
                status: cmd.status,
              }),
            };
            break;

          case "replay-snapshot":
            try {
              res = {
                type: "replay-snapshot",
                snapshot: await getReplaySnapshot(cmd.replayId, {
                  atMs: cmd.atMs,
                  scrollbackLines: cmd.scrollbackLines,
                }),
              };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: "error", message: `Failed to load replay snapshot: ${errMsg}` };
            }
            break;

          case "replay-text":
            try {
              res = {
                type: "replay-text",
                text: await getReplayText(cmd.replayId, {
                  atMs: cmd.atMs,
                  scrollbackLines: cmd.scrollbackLines,
                  includeScrollback: cmd.includeScrollback,
                  trimTrailingBlankRows: cmd.trimTrailingBlankRows,
                }),
              };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: "error", message: `Failed to load replay text: ${errMsg}` };
            }
            break;

          case "replay-markdown":
            try {
              res = {
                type: "replay-markdown",
                markdown: await getReplayMarkdown(cmd.replayId, {
                  atMs: cmd.atMs,
                  scrollbackLines: cmd.scrollbackLines,
                  includeScrollback: cmd.includeScrollback,
                  trimTrailingBlankRows: cmd.trimTrailingBlankRows,
                }),
              };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: "error", message: `Failed to load replay markdown: ${errMsg}` };
            }
            break;

          case "create-checkpoint": {
            const s = sessions.get(cmd.id);
            if (!s) {
              res = { type: "error", message: `Session ${cmd.id} not found` };
            } else {
              writeReplayCheckpointNow(s);
              res = { type: "ok" };
            }
            break;
          }

          case "new":
            try {
              const session = createSession(cmd.name, cmd.cwd, {
                hooks: cmd.hooks,
                command: cmd.command,
                args: cmd.args,
                env: cmd.env,
                kind: cmd.kind,
                hidden: cmd.hidden,
                recordReplay: cmd.recordReplay,
                metadata: cmd.metadata,
              });
              applyTerminalScopedUpdate(session.id);
              res = { type: "session", session };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              console.error(`[server] createSession failed: ${errMsg}`);
              res = { type: "error", message: `Failed to create session: ${errMsg}` };
            }
            break;

          case 'new-virtual':
            try {
              const session = createVirtualSession(cmd.name, cmd.cwd, {
                cols: cmd.cols,
                rows: cmd.rows,
                kind: cmd.kind,
                hidden: cmd.hidden,
                metadata: cmd.metadata,
              });
              applyTerminalScopedUpdate(session.id);
              res = { type: 'session', session };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              console.error(`[server] createVirtualSession failed: ${errMsg}`);
              res = { type: 'error', message: `Failed to create virtual session: ${errMsg}` };
            }
            break;

          case 'virtual-resize':
            try {
              const session = sessions.get(cmd.id);
              if (!session || !session.virtualTerminal) {
                res = { type: 'error', message: `Virtual session not found: ${cmd.id}` };
                break;
              }
              const { cols, rows } = clampTerminalSize(cmd.cols, cmd.rows, {
                cols: session.xterm.cols,
                rows: session.xterm.rows,
              });
              session.virtualTerminal.resize(cols, rows);
              session.xterm.resize(cols, rows);
              res = { type: 'ok' };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to resize virtual session: ${errMsg}` };
            }
            break;

          case 'agent-state':
            try {
              await getAgentControlReady();
              res = { type: 'agent-state', workspaces: Object.values(getAgentControlSnapshot()) };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to load agent state: ${errMsg}` };
            }
            break;

          case 'machine-snapshot':
            try {
              const snapshot = await getCurrentMachineSnapshot();
              res = { type: 'machine-snapshot', snapshot };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to load machine snapshot: ${errMsg}` };
            }
            break;

          case 'machine-resync':
            // Client-detected nonce gap (or explicit reconciliation): force a
            // full rebuild from sources so the caller gets trued-up state.
            try {
              const snapshot = await buildCurrentMachineSnapshot();
              writeTraceLog('machine-resync', { snapshotNonce: snapshot.snapshotNonce });
              res = { type: 'machine-snapshot', snapshot };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to resync machine snapshot: ${errMsg}` };
            }
            break;

          case 'goal-changed':
            // Fire-and-forget notify from the space CLI after a goal.json
            // write — re-read that project's goals and emit scoped deltas.
            try {
              writeTraceLog('goal-changed-notify', { projectName: cmd.projectName, workspaceName: cmd.workspaceName });
              applyGoalScopedUpdate(cmd.projectName);
              res = { type: 'ok' };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to apply goal change: ${errMsg}` };
            }
            break;

          case 'agent-queue-remove':
            try {
              await getAgentControlReady();
              const message = await removeQueuedAgentMessage(cmd.target, cmd.agentSessionId, cmd.kind, cmd.index);
              res = { type: 'agent-queued-message', message };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to remove queued agent message: ${errMsg}` };
            }
            break;


          case 'agent-stage-upload':
            try {
              await getAgentControlReady();
              const stageResult = await stageUploadFile(cmd.target, cmd.fileName, cmd.data, cmd.mimeType);
              res = { type: 'agent-staged', stagedPath: stageResult.stagedPath };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to stage upload: ${errMsg}` };
            }
            break;



          case 'workspace-phase-preview':
            try {
              res = { type: 'workspace-phase-preview', preview: previewWorkspaceGoalPhaseChange(cmd.projectName, cmd.workspaceName, cmd.phase) };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to preview workspace phase: ${errMsg}` };
            }
            break;

          case 'workspace-set-phase':
            try {
              applyWorkspaceGoalPhaseChange(cmd.projectName, cmd.workspaceName, cmd.phase, { cascade: cmd.cascade });
              applyGoalScopedUpdate(cmd.projectName);
              res = { type: 'ok' };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to set workspace phase: ${errMsg}` };
            }
            break;

          case 'service-start':
            try {
              const workspaces = await scanWorkspaces();
              const workspace = workspaces.find((w) => matchesWorkspaceId(w, cmd.workspaceId));
              if (!workspace) {
                res = { type: 'error', message: `Workspace not found: ${cmd.workspaceId}` };
                break;
              }
              const specs = getProcessSpecs(workspace.path).filter(
                (spec) => spec.name === cmd.processName && (cmd.instance === undefined || spec.instance === cmd.instance),
              );
              if (specs.length === 0) {
                res = { type: 'error', message: `Service not found: ${cmd.processName}` };
                break;
              }
              const sessionIds: string[] = [];
              for (const spec of specs) {
                const result = await startProcessInstance(workspace.path, spec);
                sessionIds.push(result.sessionId);
              }
              void broadcastMachineSnapshotReplacement().catch(() => {});
              res = {
                type: 'service-started',
                workspaceId: cmd.workspaceId,
                processName: cmd.processName,
                sessionId: sessionIds[0],
                sessionIds,
              };
            } catch (e) {
              if (e instanceof PortConflictError) {
                res = {
                  type: 'error',
                  code: e.code,
                  message: `Failed to start service: ${e.message}`,
                  processName: cmd.processName,
                  portConflicts: e.conflicts,
                };
                break;
              }
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to start service: ${errMsg}` };
            }
            break;

          case 'service-resolve-port-conflict':
            try {
              const { resolvePortConflict } = await import('../processes/ports.js');
              await resolvePortConflict(cmd.conflict);
              res = { type: 'ok' };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to resolve port conflict: ${errMsg}` };
            }
            break;

          case 'service-stop':
            try {
              const workspaces = await scanWorkspaces();
              const workspace = workspaces.find((w) => matchesWorkspaceId(w, cmd.workspaceId));
              if (!workspace) {
                res = { type: 'error', message: `Workspace not found: ${cmd.workspaceId}` };
                break;
              }
              const specs = getProcessSpecs(workspace.path).filter((spec) => spec.name === cmd.processName);
              if (specs.length === 0) {
                res = { type: 'error', message: `Service not found: ${cmd.processName}` };
                break;
              }
              for (const spec of specs) {
                await stopProcessInstance(workspace.path, spec);
              }
              void broadcastMachineSnapshotReplacement().catch(() => {});
              res = { type: 'service-stopped', workspaceId: cmd.workspaceId, processName: cmd.processName };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to stop service: ${errMsg}` };
            }
            break;

          case 'github-repos':
            try {
              res = { type: 'github-repos', repos: await listGithubReposForSession(cmd.org) };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'remote-branches':
            try {
              res = { type: 'remote-branches', projectName: cmd.projectName, branches: await listRemoteBranchesForSession(cmd.projectName) };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'linear-issues':
            try {
              res = { type: 'linear-issues', projectName: cmd.projectName, issues: await listLinearIssuesForSession(cmd.projectName) };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'project-create':
            try {
              const result = await createProjectForSession(cmd);
              void broadcastMachineSnapshotReplacement().catch(() => {});
              res = { type: 'project-created', ...result };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'project-prepare':
            try {
              res = { type: 'project-prepared', result: await prepareProjectForSession(cmd) };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'project-finalize':
            try {
              const result = await finalizePreparedProjectForSession(cmd);
              void broadcastMachineSnapshotReplacement().catch(() => {});
              res = { type: 'project-created', ...result };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'project-cancel':
            try {
              await cancelPreparedProjectForSession(cmd.projectName);
              res = { type: 'project-cancelled', projectName: cmd.projectName };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'workspace-create':
            try {
              res = { type: 'workspace-created', ...(await createWorkspaceForSession(cmd)) };
              void broadcastMachineSnapshotReplacement().catch(() => {});
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'project-delete':
            try {
              await deleteProjectForSession({ projectName: cmd.projectName });
              void broadcastMachineSnapshotReplacement().catch(() => {});
              res = { type: 'project-deleted', projectName: cmd.projectName };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'workspace-notes-list':
            try {
              res = { type: 'workspace-notes', notes: listWorkspaceNotes(cmd.projectName, cmd.workspaceName) };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'workspace-note-add':
            try {
              res = { type: 'workspace-note', note: addWorkspaceNote(cmd.projectName, cmd.workspaceName, { body: cmd.body, kind: 'note' }) };
              void broadcastMachineSnapshotReplacement().catch(() => {});
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'workspace-note-update':
            try {
              res = { type: 'workspace-note', note: updateWorkspaceNote(cmd.projectName, cmd.workspaceName, cmd.noteId, { body: cmd.body, kind: 'note' }) };
              void broadcastMachineSnapshotReplacement().catch(() => {});
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'workspace-note-remove':
            try {
              const removed = removeWorkspaceNote(cmd.projectName, cmd.workspaceName, cmd.noteId);
              if (!removed) {
                res = { type: 'error', message: `Workspace note not found: ${cmd.noteId}` };
                break;
              }
              void broadcastMachineSnapshotReplacement().catch(() => {});
              res = { type: 'ok' };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'goal-update':
            try {
              res = { type: 'goal', goal: updateGoalRecord(cmd.projectName, cmd.goalId, cmd.updates) };
              applyGoalScopedUpdate(cmd.projectName);
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'goal-add-near-workspace':
            try {
              res = { type: 'goal', goal: addGoalNearWorkspace(cmd.projectName, cmd.workspaceName, cmd.title, cmd.position) };
              applyGoalScopedUpdate(cmd.projectName);
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'goal-reorder':
            try {
              res = { type: 'goal-chain', chain: moveGoalInChain(cmd.projectName, cmd.sourceToken, cmd.targetToken, cmd.position) };
              applyGoalScopedUpdate(cmd.projectName);
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'goal-stack-status':
            try {
              res = { type: 'goal-stack-status', status: getSpaceStackStatus({ project: cmd.projectName, workspace: cmd.workspaceName }) };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'goal-detail':
            // Cold detail fetch (ticket #42): the snapshot carries a slim goal
            // projection; this serves the full doc + validation (with computed
            // readiness) for one goal on demand.
            try {
              const goal = getGoalRecord(cmd.projectName, cmd.goalId) ?? findGoalRecord(cmd.projectName, cmd.goalId);
              if (!goal) {
                res = { type: 'error', message: `Goal not found: ${cmd.goalId}` };
                break;
              }
              res = {
                type: 'goal-detail',
                doc: goal.doc,
                validation: { ...goal.validation, readiness: computeReadiness(goal.validation) },
              };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'goal-gate-waive':
            // Human-only escape hatch for computed phase gates: the CLI has
            // no waive flag, so this daemon command (a UI button) is the only
            // path. Records a 'gate' timeline event with reason + actor.
            try {
              const { waiveGoalGate } = await import('../../core/goal-workflow.js');
              res = { type: 'goal', goal: await waiveGoalGate(cmd.projectName, cmd.goalId, cmd.phase, cmd.reason, 'human/ui') };
              applyGoalScopedUpdate(cmd.projectName);
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;
          case 'bundle-refresh-plan':
            try {
              const workspaceRef = resolveWorkspaceRef(cmd.workspaceId.includes(':') ? cmd.workspaceId : cmd.workspaceId);
              const workspaces = await scanWorkspaces();
              const workspace = workspaces.find((w) => matchesWorkspaceId(w, cmd.workspaceId) && w.projectName === cmd.projectName);
              if (!workspace) {
                res = { type: 'error', message: `Workspace not found: ${cmd.workspaceId}` };
                break;
              }
              res = { type: 'bundle-refresh-plan', plan: await getBundleRefreshPlanCore(cmd.projectName, workspace.path, `${cmd.projectName}:${workspace.id}`) };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'bundle-refresh-apply':
            try {
              const workspaces = await scanWorkspaces();
              const workspace = workspaces.find((w) => matchesWorkspaceId(w, cmd.workspaceId) && w.projectName === cmd.projectName);
              if (!workspace) {
                res = { type: 'error', message: `Workspace not found: ${cmd.workspaceId}` };
                break;
              }
              await applyBundleRefreshSubmission(cmd.projectName, workspace.path, cmd.submission);
              res = { type: 'bundle-refresh-applied', projectName: cmd.projectName, workspaceId: `${cmd.projectName}:${workspace.id}` };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'bundle-config-state':
            try {
              const workspaces = await scanWorkspaces();
              const workspace = workspaces.find((w) => matchesWorkspaceId(w, cmd.workspaceId) && w.projectName === cmd.projectName);
              if (!workspace) {
                res = { type: 'error', message: `Workspace not found: ${cmd.workspaceId}` };
                break;
              }
              res = { type: 'bundle-config-state', state: await getBundleConfigStateCore(cmd.projectName, workspace.path, `${cmd.projectName}:${workspace.id}`) };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'bundle-config-apply':
            try {
              const workspaces = await scanWorkspaces();
              const workspace = workspaces.find((w) => matchesWorkspaceId(w, cmd.workspaceId) && w.projectName === cmd.projectName);
              if (!workspace) {
                res = { type: 'error', message: `Workspace not found: ${cmd.workspaceId}` };
                break;
              }
              await applyBundleConfigSubmission(cmd.projectName, workspace.path, cmd.submission);
              res = { type: 'bundle-config-applied', projectName: cmd.projectName, workspaceId: `${cmd.projectName}:${workspace.id}` };
            } catch (e) {
              res = { type: 'error', message: e instanceof Error ? e.message : String(e) };
            }
            break;

          case 'review-request':
            try {
              // Review ops (GitHub import/push, big diffs) run in the offload
              // child so their network/git I/O never stalls the daemon loop.
              const result = await runOffloaded<Awaited<ReturnType<typeof executeLocalReviewOperation>>>(
                'review',
                { operation: cmd.operation },
              );
              res = { type: 'review-response', requestId: cmd.requestId, result };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'review-response', requestId: cmd.requestId, error: { code: 'REVIEW_ERROR', message: errMsg } };
            }
            break;

          case 'events-request':
            try {
              const workspaceRef = resolveWorkspaceRef(cmd.workspacePath);
              if (!workspaceRef || !existsSync(workspaceRef.workspacePath)) {
                res = { type: 'events-list', workspaceId: cmd.workspacePath, events: [], liveEventIds: [], savedEventFilters: [] };
                break;
              }
              const savedEventFilters = loadSavedEventFilters(workspaceRef.workspacePath);
              const projectConfig = readProjectConfig(workspaceRef.projectName);
              const snapshots = readWorkspaceSnapshots(workspaceRef.workspacePath, {
                maxBytes: projectConfig.events?.snapshotCacheMaxBytes,
                maxTimeline: projectConfig.events?.maxTimeline,
              });
              const filtered = snapshots
                .filter((snapshot) => {
                  if (cmd.sinceMs !== undefined && snapshot.updatedAt < cmd.sinceMs) return false;
                  const filter = cmd.filter;
                  if (!filter) return true;
                  if (filter.processName && snapshot.processName !== filter.processName) return false;
                  if (filter.level && snapshot.level !== filter.level) return false;
                  if (filter.message && !snapshot.message.includes(filter.message)) return false;
                  if (filter.eventName && snapshot.eventName !== filter.eventName) return false;
                  if (filter.correlationId && snapshot.correlationId !== filter.correlationId) return false;
                  return true;
                })
                .slice(0, cmd.limit ?? 200);
              const events = filtered.length > 0
                ? filtered.map((snapshot) => ({
                    eventId: snapshot.lastEventId,
                    eventName: snapshot.eventName,
                    level: snapshot.level,
                    timestamp: new Date(snapshot.updatedAt).toISOString(),
                    timestampMs: snapshot.updatedAt,
                    message: snapshot.message,
                    sessionId: '',
                    workspaceId: workspaceRef.workspaceId,
                    projectName: workspaceRef.projectName,
                    processName: snapshot.processName,
                    processInstance: snapshot.processInstance,
                    raw: snapshot.raw ?? {},
                    kind: 'wide' as const,
                    correlationId: snapshot.correlationId,
                    timeline: Object.values(snapshot.timelineMap),
                    timelineMap: snapshot.timelineMap,
                    timelineOrder: snapshot.timelineOrder,
                  }))
                : listProcessEventsDirs(workspaceRef.workspacePath)
                    .flatMap((eventsDir) => readWideEvents({
                      eventsDir,
                      filter: { ...(cmd.filter ?? {}), kind: cmd.filter?.kind ?? 'source' },
                      limit: cmd.limit,
                      sinceMs: cmd.sinceMs,
                    }))
                    .sort((a, b) => b.timestampMs - a.timestampMs)
                    .slice(0, cmd.limit ?? 200);
              res = { type: 'events-list', workspaceId: workspaceRef.workspaceId, events, liveEventIds: [], savedEventFilters };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to load events: ${errMsg}` };
            }
            break;

          case 'agent-sessions':
            try {
              await getAgentControlReady();
              const sessions = cmd.mode === 'known'
                ? await getKnownAgentSessions(cmd.target)
                : await listLiveAgentSessions(cmd.target);
              res = { type: 'agent-sessions', sessions };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to list agent sessions: ${errMsg}` };
            }
            break;

          case 'agent-create':
            try {
              await getAgentControlReady();
              const sessions = await createAgentSession(cmd.target, cmd.title);
              res = { type: 'agent-sessions', sessions };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to create agent session: ${errMsg}` };
            }
            break;

          case 'agent-abort':
            try {
              await getAgentControlReady();
              const ok = await abortAgentSession(cmd.target, cmd.agentSessionId);
              res = { type: 'agent-bool', ok };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to abort agent session: ${errMsg}` };
            }
            break;

          case 'agent-interrupt':
            try {
              await getAgentControlReady();
              const ok = await interruptAgentSession(cmd.target, cmd.agentSessionId);
              res = { type: 'agent-bool', ok };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to interrupt agent session: ${errMsg}` };
            }
            break;

          case 'agent-close':
            try {
              await getAgentControlReady();
              const sessions = await closeAgentSession(cmd.target, cmd.agentSessionId);
              res = { type: 'agent-sessions', sessions };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to close agent session: ${errMsg}` };
            }
            break;

          case 'agent-archive':
            try {
              await getAgentControlReady();
              const sessions = await archiveAgentSession(cmd.target, cmd.agentSessionId);
              res = { type: 'agent-sessions', sessions };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to archive agent session: ${errMsg}` };
            }
            break;

          case 'agent-restore':
            try {
              await getAgentControlReady();
              const sessions = await restoreAgentSession(cmd.target, cmd.agentSessionId);
              res = { type: 'agent-sessions', sessions };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to restore agent session: ${errMsg}` };
            }
            break;

          case 'agent-permission':
            try {
              await getAgentControlReady();
              const ok = await respondToAgentPermission(
                cmd.target,
                cmd.agentSessionId,
                cmd.permissionId,
                cmd.response,
              );
              res = { type: 'agent-bool', ok };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to respond to agent permission: ${errMsg}` };
            }
            break;

          case 'agent-transcript-range':
            try {
              await getAgentControlReady();
              const page = await readAgentTranscriptRange(cmd.target, cmd.agentSessionId, { before: cmd.before, limit: cmd.limit });
              res = { type: 'agent-transcript-range', blocks: page.blocks, oldestCursor: page.oldestCursor, hasMore: page.hasMore };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to read transcript: ${errMsg}` };
            }
            break;

          case 'agent-control-info':
            try {
              await getAgentControlReady();
              const info = await getAgentControlInfo(cmd.target, cmd.agentSessionId);
              res = { type: 'agent-control-info', info };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to read control info: ${errMsg}` };
            }
            break;

          case 'agent-set-model':
            try {
              await getAgentControlReady();
              const ok = await setAgentModel(cmd.target, cmd.agentSessionId, cmd.provider, cmd.modelId);
              res = { type: 'agent-set-model', ok };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to set model: ${errMsg}` };
            }
            break;

          case 'agent-set-thinking-level':
            try {
              await getAgentControlReady();
              const ok = await setAgentThinkingLevel(cmd.target, cmd.agentSessionId, cmd.level);
              res = { type: 'agent-bool', ok };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to set thinking level: ${errMsg}` };
            }
            break;

          case 'agent-set-approval-mode':
            try {
              await getAgentControlReady();
              const ok = await setAgentApprovalMode(cmd.target, cmd.agentSessionId, cmd.mode);
              res = { type: 'agent-bool', ok };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to set approval mode: ${errMsg}` };
            }
            break;

          case 'agent-auth-providers':
            try {
              await getAgentControlReady();
              const providers = await getAgentAuthProviders();
              res = { type: 'agent-auth-providers', providers };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to list providers: ${errMsg}` };
            }
            break;

          case 'agent-set-api-key':
            try {
              await getAgentControlReady();
              const ok = await setAgentProviderApiKey(cmd.provider, cmd.key);
              res = { type: 'agent-bool', ok };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to save API key: ${errMsg}` };
            }
            break;

          case 'agent-get-settings':
            try {
              await getAgentControlReady();
              const settings = await getAgentSettings();
              res = { type: 'agent-settings', settings };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to read settings: ${errMsg}` };
            }
            break;

          case 'agent-set-setting':
            try {
              await getAgentControlReady();
              const ok = await setAgentSetting(cmd.path, cmd.value);
              res = { type: 'agent-bool', ok };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to set setting: ${errMsg}` };
            }
            break;

          case 'agent-oauth-login':
            // Fire-and-forget: the flow's auth/prompt/done events arrive via
            // agent-state deltas. Respond immediately that it started.
            try {
              await getAgentControlReady();
              void startAgentOAuthLogin(cmd.provider, cmd.flowId);
              res = { type: 'agent-bool', ok: true };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to start sign-in: ${errMsg}` };
            }
            break;

          case 'agent-oauth-respond':
            try {
              const ok = respondAgentOAuthPrompt(cmd.flowId, cmd.value);
              res = { type: 'agent-bool', ok };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to respond: ${errMsg}` };
            }
            break;

          case 'agent-settings-schema':
            try {
              await getAgentControlReady();
              const schema = await getAgentSettingsSchema();
              res = { type: 'agent-settings-schema', schema };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to read settings schema: ${errMsg}` };
            }
            break;

          case 'agent-tools':
            try {
              await getAgentControlReady();
              const tools = await getAgentTools(cmd.target, cmd.agentSessionId);
              res = { type: 'agent-tools', tools };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to list tools: ${errMsg}` };
            }
            break;

          case 'agent-list-agents':
            try {
              await getAgentControlReady();
              const agents = await listAgentDefinitions(cmd.target);
              res = { type: 'agent-list-agents', agents };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to list agents: ${errMsg}` };
            }
            break;

          case 'agent-compact':
            try {
              await getAgentControlReady();
              const ok = await compactAgentSession(cmd.target, cmd.agentSessionId);
              res = { type: 'agent-bool', ok };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to compact: ${errMsg}` };
            }
            break;

          case 'agent-cycle-role':
            try {
              await getAgentControlReady();
              const ok = await cycleAgentRole(cmd.target, cmd.agentSessionId, cmd.direction);
              res = { type: 'agent-bool', ok };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to cycle role: ${errMsg}` };
            }
            break;

          case 'agent-apply-role':
            try {
              await getAgentControlReady();
              const ok = await applyAgentModelRole(cmd.target, cmd.agentSessionId, cmd.role);
              res = { type: 'agent-bool', ok };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to apply role: ${errMsg}` };
            }
            break;

          case 'agent-history':
            try {
              await getAgentControlReady();
              const entries = await getAgentHistory(cmd.target, cmd.agentSessionId);
              res = { type: 'agent-history', entries };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to read history: ${errMsg}` };
            }
            break;

          case 'agent-navigate-history':
            try {
              await getAgentControlReady();
              const result = await navigateAgentHistory(cmd.target, cmd.agentSessionId, cmd.entryId, cmd.mode);
              res = { type: 'agent-navigate', ok: result.ok, editorText: result.editorText };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to rewind: ${errMsg}` };
            }
            break;

          case 'agent-tree':
            try {
              await getAgentControlReady();
              const nodes = await getAgentSessionTree(cmd.target, cmd.agentSessionId);
              res = { type: 'agent-tree', nodes };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to read tree: ${errMsg}` };
            }
            break;

          case 'agent-list-commands':
            try {
              await getAgentControlReady();
              const commands = await listAgentCommands(cmd.target);
              res = { type: 'agent-commands', commands };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to list commands: ${errMsg}` };
            }
            break;

          case 'workspace-editors-list':
            try {
              const editors = await listAvailableEditors();
              res = { type: 'workspace-editors', editors };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to list editors: ${errMsg}` };
            }
            break;


          case 'artifact-list':
            try {
              const { listArtifactFiles } = await import('../../core/artifacts.js');
              const { mountDir } = await resolveArtifactUriDirs(cmd.uriPrefix);
              res = { type: 'artifact-list', entries: listArtifactFiles(mountDir) };
            } catch (e) {
              res = { type: 'error', message: `Failed to list artifacts: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'artifact-read':
            try {
              const { readArtifactResolving } = await import('../../core/artifacts.js');
              const { projectDir, mountDir, relPath } = await resolveArtifactUriDirs(cmd.uri);
              const MAX_READ = 25 * 1024 * 1024;
              const bytes = await readArtifactResolving(projectDir, mountDir, relPath);
              const truncated = bytes.length > MAX_READ;
              res = { type: 'artifact-read', base64: (truncated ? bytes.subarray(0, MAX_READ) : bytes).toString('base64'), size: bytes.length, truncated };
            } catch (e) {
              res = { type: 'error', message: `Failed to read artifact: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'artifact-write':
            try {
              const { captureArtifacts } = await import('../../core/artifacts.js');
              const { projectDir, mountDir, relPath } = await resolveArtifactUriDirs(cmd.uri);
              if (!relPath) { res = { type: 'error', message: 'artifact-write needs a file path in the URI' }; break; }
              // A presented capability is VERIFIED (fail closed) and its scope
              // enforced; provenance comes from the verified subject. Cap-less
              // writes (the UI) keep web-ui provenance and no extra scope.
              let capSub: { kind: string; id?: string } | undefined;
              let allowedWrites: string[] | undefined;
              if (cmd.cap) {
                const verified = verifyArtifactCap(cmd.cap, { publicKey: getOrCreateArtifactCapKeypair().publicKey });
                const parsedUri = parseArtifactUri(cmd.uri);
                if (!capAllows(verified, 'write', parsedUri)) {
                  res = { type: 'error', message: `Capability does not permit writing ${cmd.uri}` };
                  break;
                }
                capSub = verified.sub;
                allowedWrites = verified.scope.map((u) => { try { return parseArtifactUri(u).relPath || '**'; } catch { return '(invalid)'; } });
              }
              const provenance = capSub
                ? { tool: capSub.kind, ...(capSub.kind === 'session' ? { session: capSub.id } : {}), ...(capSub.kind === 'trigger' ? { trigger: capSub.id } : {}) }
                : { tool: 'web-ui' };
              const result = await captureArtifacts(projectDir, mountDir, [{ path: relPath, content: Buffer.from(cmd.contentBase64, 'base64') }], { message: cmd.message, provenance, allowedWrites });
              res = { type: 'artifact-write', commit: result.commit };
            } catch (e) {
              res = { type: 'error', message: `Failed to write artifact: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'serve-activate':
            try {
              const { activateServeRuntime } = await import('./serve-runtime.js');
              const c = cmd.config;
              const b64 = (v: string): Uint8Array => Uint8Array.from(Buffer.from(v, 'base64'));
              const status = await activateServeRuntime({
                relayUrl: c.relayUrl,
                relayPubkey: c.relayPubkey,
                machineId: c.machineId,
                ownerUserRootId: c.ownerUserRootId,
                identity: {
                  id: c.identity.id,
                  label: c.identity.label,
                  createdAt: c.identity.createdAt,
                  signing: { publicKey: b64(c.identity.signingPublicKey), secretKey: b64(c.identity.signingSecretKey) },
                  keyExchange: { publicKey: b64(c.identity.keyExchangePublicKey), privateKey: b64(c.identity.keyExchangeSecretKey) },
                },
                publicIdentity: c.publicIdentity,
                bootstrapToken: c.bootstrapToken,
                registerPermit: c.registerPermit,
                enrollmentToken: c.enrollmentToken,
                deviceCertificate: c.deviceCertificate,
              });
              res = { type: 'serve-status', status };
            } catch (e) {
              res = { type: 'error', message: `serve activation failed: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'serve-deactivate':
            try {
              const { deactivateServeRuntime } = await import('./serve-runtime.js');
              res = { type: 'serve-status', status: await deactivateServeRuntime() };
            } catch (e) {
              res = { type: 'error', message: `serve deactivation failed: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'serve-status':
            try {
              const { getServeRuntimeStatus } = await import('./serve-runtime.js');
              res = { type: 'serve-status', status: getServeRuntimeStatus() };
            } catch (e) {
              res = { type: 'error', message: `serve status failed: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'project-artifacts-rollup':
            try {
              const { rollupArtifacts } = await import('../../core/artifacts.js');
              const { getProjectDir } = await import('../../core/config.js');
              // The publish gate inside rollupArtifacts refuses raw large
              // blobs; its error names the repair command.
              const r = await rollupArtifacts(getProjectDir(cmd.projectName), cmd.workspace, { removeBranch: cmd.removeBranch });
              res = { type: 'project-artifacts-rollup', mergeCommit: r.mergeCommit };
            } catch (e) {
              res = { type: 'error', message: `Roll-up failed: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'report-problem':
            try {
              // Local write (the reversible sink + fallback) + GitHub issue to
              // the GitSpace repo — a report is a problem WITH GitSpace, so it
              // goes where GitSpace is fixed (not the user's project). Issue
              // failure degrades to local-only inside fileProblemReport.
              // Agent-originated reports (origin 'agent') ride the same routine
              // via fileAgentReport (pi-coordinator onAgentReport sink).
              const { fileProblemReport } = await import('./problem-report.js');
              let clientBundle: unknown = {};
              try { clientBundle = JSON.parse(cmd.clientBundleJson); } catch { clientBundle = { parseError: 'client bundle was not valid JSON' }; }
              const filed = await fileProblemReport(cmd.note, clientBundle, Date.now());
              res = { type: 'report-problem', path: filed.path, issueUrl: filed.issueUrl, issueNumber: filed.issueNumber };
            } catch (e) {
              res = { type: 'error', message: `Failed to write problem report: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'artifact-share-mint':
            try {
              const { mintShareLink } = await import('./artifact-share.js');
              const { readHostConfig } = await import('../../commands/host.js');
              const hostConfig = readHostConfig();
              const hostedDomain = hostConfig?.subdomain ? `${hostConfig.subdomain}.gitspace.sh` : null;
              const r = await mintShareLink({ uri: cmd.uri, ttlMs: cmd.ttlMs, maxUses: cmd.maxUses, live: cmd.live, hostedDomain });
              res = { type: 'artifact-share-mint', url: r.url, tokenId: r.tokenId, expiresAt: r.expiresAt };
            } catch (e) {
              res = { type: 'error', message: `Failed to mint share link: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'artifact-share-revoke':
            try {
              const { revokeShareLink } = await import('./artifact-share.js');
              res = { type: 'artifact-share-revoke', revoked: revokeShareLink(cmd.tokenId) };
            } catch (e) {
              res = { type: 'error', message: `Failed to revoke share link: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'artifact-share-list':
            try {
              const { listShareLinks } = await import('./artifact-share.js');
              res = { type: 'artifact-share-list', shares: listShareLinks() };
            } catch (e) {
              res = { type: 'error', message: `Failed to list share links: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'trigger-save':
            try {
              const { saveTrigger } = await import('../../core/triggers.js');
              const { ensureArtifactsMount, artifactsMountDir } = await import('../../core/artifacts.js');
              const { getProjectDir } = await import('../../core/config.js');
              const { existsSync: ex } = await import('fs');
              const { join: j } = await import('path');
              const projectDir = getProjectDir(cmd.target.projectName);
              if (!ex(j(artifactsMountDir(cmd.target.workspacePath), '.git'))) {
                await ensureArtifactsMount(projectDir, cmd.target.workspacePath, cmd.target.workspaceName === '@base' ? 'main' : cmd.target.workspaceName);
              }
              const record = await saveTrigger(projectDir, cmd.target.workspacePath, cmd.trigger);
              res = { type: 'trigger-save', trigger: record };
            } catch (e) {
              res = { type: 'error', message: `Failed to save trigger: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'trigger-run-now':
            try {
              await getAgentControlReady();
              const { listTriggers, recordTriggerRun } = await import('../../core/triggers.js');
              const { buildTriggerPrompt } = await import('./trigger-scheduler.js');
              const { getProjectDir } = await import('../../core/config.js');
              const projectDir = getProjectDir(cmd.target.projectName);
              const trigger = listTriggers(cmd.target.workspacePath).find((t) => t.id === cmd.triggerId);
              if (!trigger) { res = { type: 'error', message: `Unknown trigger: ${cmd.triggerId}` }; break; }
              let capToken: string | undefined;
              try {
                const scope = trigger.writes.filter(Boolean);
                if (scope.length > 0) {
                  capToken = mintArtifactCap({
                    sub: { kind: 'trigger', id: trigger.id },
                    verbs: ['write'],
                    scope: scope.map((g) => formatArtifactUri(cmd.target.projectName, cmd.target.workspaceName, g)),
                    machineId: 'local',
                    expiresAt: Date.now() + 6 * 60 * 60_000,
                  }, getOrCreateArtifactCapKeypair().secretKey);
                }
              } catch { /* cap optional */ }
              const prompt = buildTriggerPrompt(trigger, { capToken });
              if (!prompt) { res = { type: 'error', message: `Trigger ${trigger.name} has no prompt to run.` }; break; }
              // Same lifecycle as scheduled fires: pending → spawn → enforce+ok on idle.
              const { mountHead } = await import('../../core/triggers.js');
              await recordTriggerRun(projectDir, cmd.target.workspacePath, trigger.id, { status: 'pending', note: 'manual run', startCommit: mountHead(cmd.target.workspacePath) ?? undefined });
              const before = new Set((await getKnownAgentSessions(cmd.target)).map((s) => s.id));
              const sessions = await createAgentSession(cmd.target, `trigger: ${trigger.name}`);
              const created = sessions.find((s) => !before.has(s.id)) ?? sessions[sessions.length - 1];
              if (!created) {
                await recordTriggerRun(projectDir, cmd.target.workspacePath, trigger.id, { status: 'fail', note: 'agent session failed to start' });
                res = { type: 'error', message: 'Agent session failed to start.' };
                break;
              }
              let prompted = false;
              for (let attempt = 0; attempt < 4 && !prompted; attempt++) {
                if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
                try { await promptAgentSession(cmd.target, created.id, prompt); prompted = true; } catch { /* discovery race */ }
              }
              if (!prompted) {
                await recordTriggerRun(projectDir, cmd.target.workspacePath, trigger.id, { status: 'fail', note: 'prompt delivery failed', sessionId: created.id });
                res = { type: 'error', message: 'Run session created but the prompt failed — open it and prompt manually.' };
                break;
              }
              watchAgentSessionIdle({ id: cmd.target.workspaceId }, created.id, () => {
                void (async () => {
                  const { completeTriggerRun } = await import('../../core/triggers.js');
                  const outcome = await completeTriggerRun(projectDir, cmd.target.workspacePath, trigger.id, { sessionId: created.id });
                  if (outcome.enforcement.violations.length > 0) {
                    addInboxItem(createInboxNotification(
                      `trigger:${cmd.target.projectName}:${trigger.id}`,
                      `trigger · ${trigger.name}`,
                      'osc',
                      `Run wrote outside its scope — reverted: ${outcome.enforcement.violations.join(', ')}. The run is marked failed.`,
                    ));
                  }
                })().catch(() => undefined);
              });
              res = { type: 'trigger-run-now', sessionId: created.id };
            } catch (e) {
              res = { type: 'error', message: `Failed to run trigger: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;





          case 'project-artifacts-status':
            try {
              const { artifactPaths, getArtifactsRemote, ensureArtifactsRepo } = await import('../../core/artifacts.js');
              const { getProjectDir } = await import('../../core/config.js');
              const { execFileSync } = await import('child_process');
              const projectDir = getProjectDir(cmd.projectName);
              await ensureArtifactsRepo(projectDir);
              const { repoDir } = artifactPaths(projectDir);
              const remote = await getArtifactsRemote(projectDir);
              let branches: string[] = [];
              try {
                branches = execFileSync('git', ['-C', repoDir, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' })
                  .split('\n').map((x) => x.trim()).filter(Boolean);
              } catch { /* fresh repo */ }
              // Teammates adopt via the COMMITTED pointer; a staged-but-
              // uncommitted .gitspace/artifacts.json means sharing is not yet
              // reaching anyone else — the wizard surfaces the remaining step.
              let pointerCommitted: boolean | undefined;
              if (remote) {
                try {
                  const { getProjectBaseDir } = await import('../../core/config.js');
                  const base = getProjectBaseDir(cmd.projectName);
                  const dirty = execFileSync('git', ['-C', base, 'status', '--porcelain', '--', '.gitspace/artifacts.json'], { encoding: 'utf8' }).trim();
                  const tracked = execFileSync('git', ['-C', base, 'ls-files', '--', '.gitspace/artifacts.json'], { encoding: 'utf8' }).trim();
                  pointerCommitted = dirty === '' && tracked !== '';
                } catch { /* base missing / not a git repo */ }
              }
              res = { type: 'project-artifacts-status', repoPath: repoDir, remote, branches, pointerCommitted };
            } catch (e) {
              res = { type: 'error', message: `Failed to read artifacts status: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'project-artifacts-remote-set':
            try {
              const { setArtifactsRemote, syncArtifacts, writeArtifactsPointerConfig } = await import('../../core/artifacts.js');
              const { getProjectBaseDir, getProjectDir } = await import('../../core/config.js');
              const projectDir = getProjectDir(cmd.projectName);
              await setArtifactsRemote(projectDir, cmd.url);
              // Commit the pointer into the CODE repo so collaborators inherit it.
              try { await writeArtifactsPointerConfig(getProjectBaseDir(cmd.projectName), { remote: cmd.url }); } catch { /* base missing */ }
              const sync = await syncArtifacts(projectDir);
              res = { type: 'project-artifacts-sync', pushed: sync.pushed, fastForwarded: sync.fastForwarded };
            } catch (e) {
              res = { type: 'error', message: `Failed to connect artifacts remote: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'project-artifacts-provision':
            try {
              const { provisionGithubArtifacts } = await import('../../core/artifacts-github.js');
              const { getProjectBaseDir, getProjectDir } = await import('../../core/config.js');
              const r = await provisionGithubArtifacts(cmd.projectName, getProjectDir(cmd.projectName), getProjectBaseDir(cmd.projectName));
              res = { type: 'project-artifacts-provision', slug: r.slug, url: r.url, created: r.created, blobsUploaded: r.blobsUploaded, collaboratorsCopied: r.collaboratorsCopied };
            } catch (e) {
              res = { type: 'error', message: `Provisioning failed: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'project-artifacts-sync':
            try {
              const { syncArtifacts, getArtifactsRemote } = await import('../../core/artifacts.js');
              const { slugFromRemote, uploadMissingBlobs } = await import('../../core/artifacts-github.js');
              const { getProjectDir } = await import('../../core/config.js');
              const projectDir = getProjectDir(cmd.projectName);
              const sync = await syncArtifacts(projectDir);
              // GitHub remotes also move large-file blobs (GitHub LFS batch API).
              const slug = slugFromRemote(await getArtifactsRemote(projectDir));
              if (slug) await uploadMissingBlobs(projectDir, slug);
              res = { type: 'project-artifacts-sync', pushed: sync.pushed, fastForwarded: sync.fastForwarded };
            } catch (e) {
              res = { type: 'error', message: `Failed to sync artifacts: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;


          case 'repo-tree':
            try {
              const { listRepoFiles } = await import('../../core/git.js');
              res = { type: 'repo-tree', entries: await listRepoFiles(cmd.target.workspacePath) };
            } catch (e) {
              res = { type: 'error', message: `Failed to list repo files: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'repo-read':
            try {
              const { readRepoFile } = await import('../../core/git.js');
              const MAX_READ = 8 * 1024 * 1024;
              const bytes = readRepoFile(cmd.target.workspacePath, cmd.path);
              if (bytes === null) {
                res = { type: 'repo-read', base64: null, size: 0, truncated: false };
              } else {
                const truncated = bytes.length > MAX_READ;
                res = {
                  type: 'repo-read',
                  base64: (truncated ? bytes.subarray(0, MAX_READ) : bytes).toString('base64'),
                  size: bytes.length,
                  truncated,
                };
              }
            } catch (e) {
              res = { type: 'error', message: `Failed to read file: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'repo-commit':
            try {
              const { commitAllChanges } = await import('../../core/git.js');
              const commit = await commitAllChanges(cmd.target.workspacePath, cmd.message);
              res = { type: 'repo-commit', commit };
            } catch (e) {
              res = { type: 'error', message: `Failed to commit: ${e instanceof Error ? e.message : String(e)}` };
            }
            break;

          case 'workspace-editor-open':
            try {
              const result = await openWorkspaceInEditor(cmd.editorId, cmd.target.workspacePath);
              res = result.ok ? { type: 'ok' } : { type: 'error', message: result.message };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to open editor: ${errMsg}` };
            }
            break;


          case 'agent-file-suggestions':
            try {
              await getAgentControlReady();
              const suggestions = await getFileSuggestions(cmd.target, cmd.prefix, cmd.limit);
              res = { type: 'agent-file-suggestions', suggestions };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to get file suggestions: ${errMsg}` };
            }
            break;

          case "inbox":
            res = { type: "inbox", items: [...inbox] };
            break;

          case "inbox-clear":
            if (cmd.id) {
              const idx = inbox.findIndex(i => i.id === cmd.id);
              if (idx !== -1) {
                const [removed] = inbox.splice(idx, 1);
                if (removed) updateSessionAlertState(removed.sessionId, { unreadDelta: 0 });
              }
            } else {
              inbox.length = 0;
              for (const session of sessions.values()) {
                updateSessionAlertState(session.info.id, { unreadDelta: 0 });
              }
            }
            broadcastTitleUpdate();
            res = { type: "ok" };
            break;

          case "inbox-read": {
            const item = inbox.find(i => i.id === cmd.id);
            if (item) {
              item.read = true;
              updateSessionAlertState(item.sessionId, { unreadDelta: 0 });
            }
            broadcastTitleUpdate();
            res = { type: "ok" };
            break;
          }

          case 'notification-config-get':
            res = { type: 'notification-config', config: notificationConfig };
            break;

          case 'notification-config-update':
            notificationConfig = updateNotificationConfig(cmd.config);
            res = { type: 'notification-config', config: notificationConfig };
            break;

          case "version":
            res = {
              type: "version",
              version: PACKAGE_VERSION,
              protocol: PROTOCOL_VERSION,
            };
            break;

          case "status": {
            const sessionList = Array.from(sessions.values());
            const attachedCount = sessionList.filter(s => s.info.attached).length;
            res = {
              type: "status",
              version: PACKAGE_VERSION,
              protocol: PROTOCOL_VERSION,
              pid: process.pid,
              uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
              sessions: sessionList.length,
              attached: attachedCount,
            };
            break;
          }

          case "terminate": {
            const s = sessions.get(cmd.id);
            if (!s) {
              res = { type: "error", message: `Session ${cmd.id} not found` };
            } else {
              const mode = resolveTerminationMode(cmd.mode);
              const graceMs = resolveTerminationGraceMs(cmd.graceMs);
              if (!mode) {
                res = { type: "error", message: "Invalid terminate mode" };
              } else if (graceMs === null) {
                res = { type: "error", message: "Invalid terminate graceMs" };
              } else {
                await terminateSessionData(s, mode, graceMs);
                res = { type: "ok" };
              }
            }
            break;
          }

          case 'agent-prompt': {
            const traceStartMs = Date.now();
            writeTraceLog('tmux-agent-prompt-start', {
              agentSessionId: cmd.agentSessionId,
              workspaceId: cmd.target.workspaceId,
              textLength: cmd.text.length,
              imageCount: cmd.images?.length ?? 0,
            });
            try {
              await getAgentControlReady();
              writeTraceLog('tmux-agent-prompt-control-ready', {
                agentSessionId: cmd.agentSessionId,
                workspaceId: cmd.target.workspaceId,
                durationMs: Date.now() - traceStartMs,
              });
              // ok here means the turn was accepted. Turn progress and completion are surfaced via existing agent events, not via this response.
              await promptAgentSession(cmd.target, cmd.agentSessionId, cmd.text, cmd.images, { streamingBehavior: cmd.streamingBehavior });
              writeTraceLog('tmux-agent-prompt-accepted', {
                agentSessionId: cmd.agentSessionId,
                workspaceId: cmd.target.workspaceId,
                durationMs: Date.now() - traceStartMs,
              });
              res = { type: 'ok' };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to prompt agent session: ${errMsg}` };
              writeTraceLog('tmux-agent-prompt-error', {
                agentSessionId: cmd.agentSessionId,
                workspaceId: cmd.target.workspaceId,
                durationMs: Date.now() - traceStartMs,
                error: errMsg,
              });
            }
            break;
          }

          default:
            res = { type: "error", message: "Unknown command" };
  }
  return res;
}

// Daemon-unification P3: the in-process session-handler dispatches typed
// commands directly — no socket round trip to ourselves.
setCommandDispatcher(dispatchCommand);
console.error('[dispatch] in-process command dispatcher registered');

routerListener = Bun.listen({
  unix: ROUTER_SOCKET,
  socket: {
    open(socket) {
      const socketState = getRouterSocketState(socket);
      socketState.writer = createBufferedSocketWriter(socket as any);
    },
    close(socket) {
      clearRouterSocketState(socket);
    },

    async data(socket, data) {
      const socketState = getRouterSocketState(socket);
      const combined = Buffer.concat([socketState.buffer, Buffer.from(data)]);
      let decoded;

      try {
        decoded = decodeRouterMessages(combined);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid request";
        if (socketState.writer) socketState.writer.write(encodeRouterMessage({ type: "error", message }));
        else socket.write(encodeRouterMessage({ type: "error", message }));
        socketState.buffer = Buffer.alloc(0);
        return;
      }

      socketState.buffer = decoded.remaining;

      for (const message of decoded.messages) {
        const cmd = message as Command;
        // Loop-resident commands (agent-attach, agent-dialog-response) also
        // carry '@base' targets — normalize here too (idempotent with the
        // dispatchCommand normalization for everything routed through it).
        if ('target' in cmd && cmd.target && typeof cmd.target === 'object' && 'workspaceName' in cmd.target && (cmd.target as { workspaceName?: string }).workspaceName === '@base') {
          try {
            const { getProjectBaseDir } = await import('../../core/config.js');
            const t = cmd.target as { workspaceId: string; workspaceName: string; workspacePath: string; projectName: string };
            t.workspacePath = getProjectBaseDir(t.projectName);
            t.workspaceId = `${t.projectName}:@base`;
          } catch { /* leave as-is; handler will error */ }
        }
        const commandTraceStartMs = Date.now();
        writeTraceLog('tmux-command-start', {
          commandType: cmd.type,
          requestId: 'requestId' in cmd ? cmd.requestId : undefined,
        });
        let res: Response;
        const writeResponse = (response: Response) => {
          if (socketState.writer) socketState.writer.write(encodeRouterMessage(response));
          else socket.write(encodeRouterMessage(response));
        };

        switch (cmd.type) {
          case 'attach-prepare':
            try {
              let targetSession: Session;
              let workspaceId: string | undefined;
              if (cmd.sessionId) {
                const s = sessions.get(cmd.sessionId);
                if (!s) {
                  res = { type: 'error', message: `Session ${cmd.sessionId} not found` };
                  break;
                }
                targetSession = getSessionInfo(s);
              } else if (cmd.workspaceId) {
                let currentPhase: 'pre' | 'setup' | 'select' = 'pre';
                const prepared = await attachWorkspaceSession({
                  scanWorkspaces,
                  listSessions: async () => Array.from(sessions.values()).map((session) => ({ name: session.info.name })),
                  createSession: async (name, cwd, options) => createSession(name, cwd, options),
                  prepareWorkspaceForSession: async (args) => prepareWorkspaceForSession(args),
                }, {
                  workspaceId: cmd.workspaceId,
                  sessionName: cmd.sessionName,
                  command: cmd.command,
                  args: cmd.args,
                  env: cmd.env,
                  scriptPolicy: cmd.scriptPolicy,
                  onAbortController: (controller) => {
                    if (controller) {
                      pendingAttachControllers.set(cmd.requestId, controller);
                    } else {
                      pendingAttachControllers.delete(cmd.requestId);
                    }
                  },
                  onOutput: (data, phase) => {
                    currentPhase = phase;
                    writeResponse({ type: 'attach-script-output', requestId: cmd.requestId, phase, data: Buffer.from(data).toString('base64') });
                  },
                  onPhaseStart: (phase) => {
                    currentPhase = phase;
                    const banner = Buffer.from(`\r\n==> ${phase} scripts...\r\n`);
                    writeResponse({ type: 'attach-script-output', requestId: cmd.requestId, phase, data: banner.toString('base64') });
                  },
                });
                if (!cmd.command) {
                  writeResponse({ type: 'attach-script-output', requestId: cmd.requestId, phase: currentPhase, data: '', done: true });
                }
                targetSession = prepared.session;
                workspaceId = prepared.workspace.id;
              } else {
                res = { type: 'error', message: 'attach-prepare requires sessionId or workspaceId' };
                break;
              }
              applyTerminalScopedUpdate(targetSession.id);
              writeResponse({ type: 'attach-prepared', requestId: cmd.requestId, session: targetSession, workspaceId, viewOnly: cmd.viewOnly });
              continue;
            } catch (e) {
              pendingAttachControllers.delete(cmd.requestId);
              const typedError = e instanceof Error ? e as Error & { code?: string } : undefined;
              const message = `Failed to prepare attach: ${typedError?.message ?? String(e)}`;
              res = typedError?.code
                ? { type: 'error', message, code: typedError.code }
                : { type: 'error', message };
            }
            break;

          case 'attach-cancel': {
            const controller = pendingAttachControllers.get(cmd.requestId);
            if (controller) {
              controller.abort();
              pendingAttachControllers.delete(cmd.requestId);
            }
            res = { type: 'ok' };
            break;
          }

          case "attach": {
            const s = sessions.get(cmd.id);
            if (!s) {
              res = { type: "error", message: `Session ${cmd.id} not found` };
            } else if (s.info.attached && !cmd.force) {
              res = { type: "already-attached", session: getSessionInfo(s) };
            } else {
              res = { type: "session", session: getSessionInfo(s) };
            }
            break;
          }

          case 'agent-watch':
            try {
              await getAgentControlReady();
              socketState.watchesAgentState = true;
              agentStateWatchers.add(socket);
              res = { type: 'agent-watch-started' };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to start agent watch: ${errMsg}` };
            }
            break;

          case 'machine-watch':
            try {
              const snapshot = await getCurrentMachineSnapshot();
              socketState.watchesMachineState = true;
              machineStateWatchers.add(socket);
              writeResponse({ type: 'machine-snapshot', snapshot });
              res = { type: 'machine-watch-started' };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to start machine watch: ${errMsg}` };
            }
            break;


          case 'workspace-delete':
            try {
              const normalizedWorkspaceId = cmd.workspaceId.startsWith(`${cmd.projectName}:`)
                ? cmd.workspaceId.slice(cmd.projectName.length + 1)
                : cmd.workspaceId;
              const canonicalWorkspaceId = `${cmd.projectName}:${normalizedWorkspaceId}`;
              const result = await deleteWorkspaceCore(cmd.projectName, normalizedWorkspaceId, {
                nonInteractive: true,
                removeScriptPolicy: cmd.scriptPolicy === 'skip' ? 'skip' : 'enforce',
                onScriptOutput: (data) => {
                  writeResponse({ type: 'workspace-delete-output', requestId: cmd.requestId, data: data.toString('base64') });
                },
              });
              if (!result.success) {
                const message = result.error ?? `Failed to delete workspace ${normalizedWorkspaceId}`;
                writeResponse({ type: 'workspace-delete-output', requestId: cmd.requestId, data: '', done: true, error: message });
                res = { type: 'error', message, code: result.errorCode };
                break;
              }
              writeResponse({ type: 'workspace-delete-output', requestId: cmd.requestId, data: '', done: true });
              void broadcastMachineSnapshotReplacement().catch(() => {});
              res = { type: 'workspace-deleted', requestId: cmd.requestId, workspaceId: canonicalWorkspaceId };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              writeResponse({ type: 'workspace-delete-output', requestId: cmd.requestId, data: '', done: true, error: errMsg });
              res = { type: 'error', message: errMsg };
            }
            break;

          case 'agent-attach':
            try {
              await getAgentControlReady();
              const session = await ensureAgentTerminalSession(cmd.target, cmd.agentSessionId, { cols: cmd.cols, rows: cmd.rows });
              agentSessionWatchOwners.set(cmd.agentSessionId, socket);
              res = { type: 'session', session };
              applyTerminalScopedUpdate(session.id);
              // The agent record's linkedTerminalSessionId derives from this
              // terminal — refresh the workspace's agent records too.
              if (session.metadata?.workspaceId) {
                applyAgentScopedUpdate(session.metadata.workspaceId);
              }
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to attach agent session: ${errMsg}` };
            }
            break;

          case 'agent-dialog-response':
            try {
              // Same-socket dialogs (path a) may only be answered by the socket
              // they were delivered to. Conduit-delivered dialogs (path b, the
              // serve+relay app) resolve by dialogId from any command socket.
              if (!isDialogResponseAuthorized(cmd.dialogId, socket, agentDialogOwners, conduitDeliveredDialogs)) {
                res = { type: 'agent-bool', ok: false };
                break;
              }
              const resolved = await resolveAgentDialogResponse({
                type: cmd.dialogType,
                id: cmd.dialogId,
                value: cmd.value as any,
              });
              // First valid response wins; drop the tracking so late/duplicate
              // responses find no pending dialog and no-op (ok:false).
              agentDialogOwners.delete(cmd.dialogId);
              conduitDeliveredDialogs.delete(cmd.dialogId);
              res = { type: 'agent-bool', ok: resolved };
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res = { type: 'error', message: `Failed to resolve dialog: ${errMsg}` };
            }
            break;

          case "kill-server":
            console.log("Shutting down...");
            res = { type: "ok" };
            if (socketState.writer) socketState.writer.write(encodeRouterMessage(res));
            else socket.write(encodeRouterMessage(res));
            // Clean up socket file after sending response, before exit
            setTimeout(() => {
              shutdownServer();
              process.exit(0);
            }, 100);
            return;

          default: {
            const dispatched = await dispatchCommand(cmd);
            res = dispatched ?? { type: 'error', message: `Unknown command: ${(cmd as { type?: string }).type}` };
          }
        }

        sendRouterResponse(socket, res);
        writeTraceLog('tmux-command-response', {
          commandType: cmd.type,
          requestId: 'requestId' in cmd ? cmd.requestId : undefined,
          responseType: res.type,
          durationMs: Date.now() - commandTraceStartMs,
        });
        if (res.type === 'agent-watch-started') {
          try {
            sendRouterResponse(socket, { type: 'agent-state', workspaces: Object.values(getAgentControlSnapshot()) });
          } catch {}
        }
        if (res.type === 'machine-watch-started') {
          try {
            const snapshot = await getCurrentMachineSnapshot();
            sendRouterResponse(socket, { type: 'machine-snapshot', snapshot });
          } catch {}
        }
      }
    },
    drain(socket) {
      const socketState = getRouterSocketState(socket);
      socketState.writer?.flush?.();
    }
  }
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal}, cleaning up sessions...`);
    shutdownServer();
    process.exit(0);
  });
}

process.on("exit", () => {
  shutdownServer({ markRunningSessionsCrashed: false });
});
