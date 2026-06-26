import type { WorkspaceEditorId, WorkspaceEditorOption } from '../../utils/open-editor.js';
import type { Identity, SessionKeys } from '../../types/identity.js';
import type { PortConflictInfo } from '../../lib/processes/port-conflicts.js';
import {
  parseRemoteMessage,
  type AttachSessionRequest,
  type CancelPendingAttachRequest,
  type ClientToMachineMessage,
  type CommandResponse,
  type OperationAcceptedResponse,
  type OperationEventResponse,
  type OperationSnapshotResponse,
  type RunSpaceCommandResponse,
  type RefreshMachineSnapshotResponse,
  type DeleteWorkspaceRequest,
  type GetReplayTimelineRequest,
  type ListReplaysRequest,
  type MachineToClientMessage,
  type ScriptOutputResponse,
  type ReplayFrameResponse,
  type ReplayTimelineResponse,
  type ReplayDismissedResponse,
  type ReplayUndismissedResponse,
  type GetReplayFrameRequest,
  type DismissReplayRequest,
  type UndismissReplayRequest,
  type DismissOperationRequest,
  type RemoteSessionControl,
  type RemoteOperationRecord,
  type OperationDismissedResponse,
} from '../../lib/remote-session/protocol.js';
import type { BundleRefreshPlan, BundleRefreshSubmission } from '../../types/bundle-refresh.js';
import type { BundleConfigState, BundleConfigSubmission } from '../../types/bundle-config.js';
import type { ReviewOperation, ReviewResult } from '../../types/review.js';
import type { WideEventFilter } from '../../types/events.js';
import type { SessionLinearIssueSummary } from '../../types/lifecycle.js';
import { AttachLifecycle } from './attach-lifecycle.js';
import { PaneLifecycle } from './pane-lifecycle.js';
import type { NotificationConfig } from '../../notifications/types.js';
import {
  ReviewRequestError,
  WorkspaceDeleteError,
  type WorkspaceDeleteErrorCode,
} from '../../types/errors.js';
import { throwServiceStartError } from './service-start-error.js';
import type {
  AttachSessionParams,
  AttachPaneParams,
  BackendDescriptor,
  CreateProjectParams,
  FinalizeProjectParams,
  PreparedProjectResult,
  ReplayFrameTarget,
  ReplayTimeline,
  CreateWorkspaceParams,
  DeleteProjectParams,
  DeleteWorkspaceParams,
  SessionBackend,
  TerminateSessionOptions,
} from '../backend.js';
import type { BackendEvent } from '../events.js';
import type { AgentStateUpdateDelta, WorkspaceAgentState } from '../../lib/tmux-lite/agent-event-manager.js';
import type { AgentStateSnapshotPush, AgentStateUpdatePush } from '../../lib/remote-session/protocol.js';
import { applyAgentDeltaToAgentState } from '../../lib/tmux-lite/agent-state-reducer.js';
import { MachineStateClient } from '../../machine/state/client.js';
import {
  machineSnapshotToAgentState,
  machineSnapshotToKnownAgentSessions,
  machineSnapshotToProjects,
  machineSnapshotToSessions,
  machineSnapshotToWorkspaces,
} from '../../machine/state/selectors.js';
import type { Response as TmuxResponse } from '../../lib/tmux-lite/protocol.js';
import type { AddRequirementInput, AttachEvidenceInput, HumanReviewDecision, UpdateRequirementInput } from '../../core/goal-validation.js';
type TypedCommandResponse = TmuxResponse | RunSpaceCommandResponse | RefreshMachineSnapshotResponse;
import { createEmptyMachineSnapshot } from '../../machine/state/client.js';
import type { MachineAgentSessionRecord } from '../../lib/tmux-lite/machine/types.js';
import { writeTraceLog } from '../../utils/trace-log.js';
import { terminalMemoryDebugIncrement } from '../../utils/terminal-memory-debug.js';

type PendingOperationCompletion = {
  resolve: (operation: RemoteOperationRecord) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const DEFAULT_CONTROL_STREAM_ID = 1;
const DEFAULT_PANE_STREAM_ID = 2;
const DEFAULT_PANE_ID = 'default';
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 12_000;
const DEFAULT_INITIAL_SNAPSHOT_TIMEOUT_MS = 15_000;
const OPERATION_COMMAND_TYPES = new Set<string>([
  'create_project',
  'prepare_project_creation',
  'finalize_project_creation',
  'delete_project',
  'create_workspace',
  'rerun_workspace_scripts',
  'run_workspace_open_scripts',
  'run_workspace_script_selection',
  'run_space_command',
  'delete_workspace',
  'request_review',
  'open_workspace_editor',
]);

function operationCompletionTimeoutMs(operation: RemoteOperationRecord | undefined): number {
  switch (operation?.kind) {
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
    default:
      return 30 * 60 * 1000;
  }
}

interface RelayDataMessage {
  type: 'data';
  data: string;
  priority?: 'control' | 'bulk';
}

type RelayConnectMessage =
  {
    type: 'connect_to_machine';
    machineId: string;
    clientIdentityId: string;
    deviceCertificate: string;
  };

interface HandshakeEnvelope {
  type: 'handshake';
  phase: string;
  data: unknown;
}

type AuthorizationPayload = { type: 'access_list' };

interface SessionEventMessage {
  type: 'attached' | 'exited' | 'kicked' | 'session-meta';
  sessionId?: string;
  streamId: number;
  sessionName?: string;
  processTitle?: string;
  terminalTitle?: string;
  lastAlertKind?: import('../../lib/tmux-lite/protocol.js').InboxItem['type'];
  lastAlertPreview?: string;
  lastAlertAt?: number;
  unreadAlertCount?: number;
  cols?: number;
  rows?: number;
  code?: number;
}

interface PendingReplayFrameChunk {
  replayId: string;
  totalChunks: number;
  checkpoint: import('../backend.js').ReplayFrame['checkpoint'] | null;
  chunks: Map<number, import('../backend.js').ReplayFrame['events']>;
  receivedAtMs: number;
}

export interface RemoteSessionSocketHandlers {
  onOpen: () => void;
  onClose: (info?: { code?: number; reason?: string }) => void;
  onMessage: (data: string) => void;
  onError: (error: Error) => void;
}

export interface RemoteSessionSocketAdapter<TSocket> {
  setHandlers: (socket: TSocket, handlers: RemoteSessionSocketHandlers) => void;
  clearHandlers: (socket: TSocket) => void;
  send: (socket: TSocket, data: string) => void;
  close: (socket: TSocket) => void;
  getReadyState: (socket: TSocket) => number;
  getOpenReadyStateValue: () => number;
}

export interface RemoteSessionCryptoAdapter {
  readonly masterStreamId: number;
  readonly controlStreamId?: number;
  createFrame: (streamId: number, data: Uint8Array, key: Uint8Array) => Promise<Uint8Array>;
  openFrame: (
    frame: Uint8Array,
    key: Uint8Array
  ) => Promise<{ streamId: number; data: Uint8Array } | null>;
  encodeBase64: (data: Uint8Array) => string;
  decodeBase64: (base64: string) => Uint8Array;
}

export interface RemoteSessionHandshakeAdapter<THandshakeState, TServerHello, TServerAuth> {
  createClientHello: (machineIdHint?: string) => { state: THandshakeState; message: unknown };
  isServerHello: (data: unknown) => data is TServerHello;
  processServerHello: (
    state: THandshakeState,
    response: TServerHello
  ) => THandshakeState | null;
  createClientAuth: (
    state: THandshakeState,
    identity: Identity,
    authorization: AuthorizationPayload,
    deviceCertificate: string
  ) => {
    state: THandshakeState;
    message: unknown;
    sessionKeys: SessionKeys;
  };
  isServerAuth: (data: unknown) => data is TServerAuth;
  processServerAuth: (
    state: THandshakeState,
    response: TServerAuth,
    sessionKeys: SessionKeys
  ) => {
    peerIdentityId: string;
    authResult?: unknown;
  } | null;
}

export interface RemoteSessionBackendOptions<TSocket, THandshakeState, TServerHello, TServerAuth> {
  descriptor: BackendDescriptor;
  socket: TSocket;
  socketAdapter: RemoteSessionSocketAdapter<TSocket>;
  identity: Identity;
  machineId: string;
  deviceCertificate: string;
  signer: <T extends object>(message: T, identity: Identity) => T;
  crypto: RemoteSessionCryptoAdapter;
  handshake: RemoteSessionHandshakeAdapter<THandshakeState, TServerHello, TServerAuth>;
  storage?: import('../../sdk/engine/types.js').KeyValueStorage | null;
}

const MACHINE_TO_CLIENT_TYPES = new Set<string>([
  'replay_list',
  'replay_frame',
  'replay_timeline',
  'replay_dismissed',
  'replay_undismissed',
  'detached',
  'session_exited',
  'error',
  'workspace_deleted',
  'script_output',
  'process_started',
  'process_stopped',
  'command_response',
  'operation_accepted',
  'operation_snapshot',
  'operation_event',
  'operation_dismissed',
  'run_space_command_response',
  'refresh_machine_snapshot',
  'agent_state_snapshot',
  'agent_state_update',
  'machine_snapshot',
  'agent_dialog_request',
  'agent_ui_event',
]);

function isHandshakeEnvelope(value: unknown): value is HandshakeEnvelope {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const envelope = value as Partial<HandshakeEnvelope>;
  return envelope.type === 'handshake' && typeof envelope.phase === 'string';
}

function isSessionEventMessage(value: unknown): value is SessionEventMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Partial<SessionEventMessage>;
  return (
    message.type === 'attached' ||
    message.type === 'exited' ||
    message.type === 'kicked' ||
    message.type === 'session-meta'
  );
}

function toMachineMessage(value: unknown): MachineToClientMessage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as { type?: string };
  if (!candidate.type || !MACHINE_TO_CLIENT_TYPES.has(candidate.type)) {
    return null;
  }

  const parsed = parseRemoteMessage(JSON.stringify(value));
  if (!parsed || !MACHINE_TO_CLIENT_TYPES.has(parsed.type)) {
    return null;
  }

  return parsed as MachineToClientMessage;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}


function workspaceIdsMatch(expected: string, actual: string | undefined): boolean {
  if (!actual) {
    return false;
  }

  if (expected === actual) {
    return true;
  }

  const expectedSeparator = expected.indexOf(':');
  const actualSeparator = actual.indexOf(':');

  if (expectedSeparator > 0 && actualSeparator <= 0) {
    return expected.slice(expectedSeparator + 1) === actual;
  }

  if (expectedSeparator <= 0 && actualSeparator > 0) {
    return expected === actual.slice(actualSeparator + 1);
  }

  return false;
}

function getTerminalSessionWorkspaceId(
  snapshot: ReturnType<MachineStateClient['getSnapshot']>,
  sessionId: string | undefined,
): string | undefined {
  if (!sessionId) {
    return undefined;
  }

  const session = snapshot.terminalSessionsById[sessionId];
  const workspaceId = session?.workspaceId ?? session?.metadata?.workspaceId;
  return typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : undefined;
}

function toWorkspaceDeleteErrorCode(code: string | undefined): WorkspaceDeleteErrorCode {
  if (
    code === 'REMOVE_SCRIPT_FAILED' ||
    code === 'WORKSPACE_NOT_FOUND' ||
    code === 'WORKTREE_REMOVE_FAILED' ||
    code === 'PRESERVED_LEFTOVERS' ||
    code === 'DELETE_FAILED' ||
    code === 'NOT_FOUND' ||
    code === 'RESOURCE_NOT_FOUND' ||
    code === 'PERMISSION_DENIED' ||
    code === 'DELETE_TIMEOUT'
  ) {
    return code;
  }

  return 'DELETE_FAILED';
}

export class RemoteSessionBackend<TSocket, THandshakeState, TServerHello, TServerAuth>
  implements SessionBackend {
  readonly descriptor: BackendDescriptor;

  private readonly socket: TSocket;
  private readonly socketAdapter: RemoteSessionSocketAdapter<TSocket>;
  private readonly identity: Identity;
  private readonly machineId: string;
  private readonly deviceCertificate: string;
  private readonly signer: <T extends object>(message: T, identity: Identity) => T;
  private readonly crypto: RemoteSessionCryptoAdapter;
  private readonly handshake: RemoteSessionHandshakeAdapter<THandshakeState, TServerHello, TServerAuth>;
  private readonly handlers = new Set<(event: BackendEvent) => void>();

  private readonly attachLifecycle = new AttachLifecycle((event) => {
    if (
      event.type === 'attached'
      && this.pendingAttachedAgentSession?.sessionId === event.sessionId
    ) {
      this.attachedAgentSessionId = this.pendingAttachedAgentSession.agentSessionId;
      this.pendingAttachedAgentSession = null;
    }
    if (event.type === 'attached' && this.attachedAgentSessionId) {
      this.emit({ ...event, agentSessionId: this.attachedAgentSessionId });
      return;
    }
    if (event.type === 'detached' || event.type === 'session_exited') {
      this.attachedAgentSessionId = null;
      this.pendingAttachedAgentSession = null;
    }
    this.emit(event);
  });
  private handshakeState: THandshakeState | null = null;
  private sessionKeys: SessionKeys | null = null;
  private isConnected = false;
  private attachedAgentSessionId: string | null = null;
  private pendingAttachedAgentSession: { agentSessionId: string; sessionId: string } | null = null;
  private readonly panes = new Map<string, PaneLifecycle>();
  private nextStreamId = DEFAULT_PANE_STREAM_ID + 1;
  private listenersAttached = false;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private initialSnapshotPromise: Promise<void> | null = null;
  private initialSnapshotResolve: (() => void) | null = null;
  private initialSnapshotReject: ((error: Error) => void) | null = null;
  private initialSnapshotReceived = false;
  private pendingDeleteWorkspace:
    | {
        requestId: string;
        workspaceId: string;
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private replayFrameRequestSeq = 0;
  private pendingReplayFrame:
    | {
        replayId: string;
        requestId: string;
        resolve: (frame: import('../backend.js').ReplayFrame) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingReplayTimeline:
    | {
        replayId: string;
        resolve: (timeline: ReplayTimeline) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingDismissReplay:
    | {
        replayId: string;
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingUndismissReplay:
    | {
        replayId: string;
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingReplayFrameChunks = new Map<string, PendingReplayFrameChunk>();
  private pendingTypedCommands = new Map<string, {
    resolve: (response: TypedCommandResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    startedAtMs: number;
  }>();
  private pendingOperationStarts = new Map<string, {
    resolve: (operation: RemoteOperationRecord) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    startedAtMs: number;
  }>();
  private pendingOperationCompletions = new Map<string, PendingOperationCompletion>();
  private operations = new Map<string, RemoteOperationRecord>();
  private pendingDetachTransition: {
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  } | null = null;
  private readonly machineStateClient = new MachineStateClient();
  private readonly storage: import('../../sdk/engine/types.js').KeyValueStorage | null | undefined;

  constructor(options: RemoteSessionBackendOptions<TSocket, THandshakeState, TServerHello, TServerAuth>) {
    this.descriptor = options.descriptor;
    this.socket = options.socket;
    this.socketAdapter = options.socketAdapter;
    this.identity = options.identity;
    this.machineId = options.machineId;
    this.deviceCertificate = options.deviceCertificate;
    this.signer = options.signer;
    this.crypto = options.crypto;
    this.handshake = options.handshake;
    this.storage = options.storage;
  }

  onEvent(handler: (event: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  setPtyOutputHandler(handler: ((data: Uint8Array) => void) | null): void {
    terminalMemoryDebugIncrement(handler ? 'backend.ptyOutputHandler.set' : 'backend.ptyOutputHandler.clear');
    this.attachLifecycle.setOutputHandler(handler);
  }

  setPaneOutputHandler(paneId: string, handler: ((data: Uint8Array) => void) | null): void {
    terminalMemoryDebugIncrement(handler ? 'backend.paneOutputHandler.set' : 'backend.paneOutputHandler.clear');
    if (!this.panes.has(paneId)) {
      terminalMemoryDebugIncrement('backend.paneOutputHandler.missingPane');
    }
    this.panes.get(paneId)?.setOutputHandler(handler);
  }

  setScriptOutputHandler(handler: ((data: Uint8Array) => void) | null): void {
    this.attachLifecycle.setScriptOutputHandler(handler);
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.emit({ type: 'status', status: 'connecting' });
    this.attachSocketListeners();

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
    this.initialSnapshotReceived = false;
    this.initialSnapshotPromise = new Promise<void>((resolve, reject) => {
      this.initialSnapshotResolve = resolve;
      this.initialSnapshotReject = reject;
    });

    if (this.isSocketOpen()) {
      this.sendRelayConnectMessage();
    }

    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    if (!this.listenersAttached) {
      this.resetState();
      this.emit({ type: 'status', status: 'disconnected' });
      return;
    }

    this.socketAdapter.clearHandlers(this.socket);
    this.listenersAttached = false;
    this.socketAdapter.close(this.socket);
    this.resetState();
    this.emit({ type: 'status', status: 'disconnected' });
    this.emit({ type: 'detached' });
  }

  async listProjects(): Promise<void> {
    await this.waitForInitialSnapshot();
    this.emit({ type: 'projects', projects: machineSnapshotToProjects(this.machineStateClient.getSnapshot()) });
  }

  private async refreshMachineSnapshot(): Promise<void> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({ type: 'refresh_machine_snapshot', requestId: crypto.randomUUID() });
    if (response.type === 'refresh_machine_snapshot') {
      this.machineStateClient.replaceSnapshot(response.snapshot);
      this.emitDerivedMachineState();
      this.agentStateCache = machineSnapshotToAgentState(response.snapshot);
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected refresh machine snapshot response');
  }


  async listGithubRepos(org?: string): Promise<string[]> {
    const response = await this.sendRpcCommand({ type: 'list_github_repos', requestId: crypto.randomUUID(), org });
    if (response.type === 'github-repos') return response.repos;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected GitHub repo response');
  }

  async listRemoteBranches(projectName: string): Promise<string[]> {
    const response = await this.sendRpcCommand({ type: 'list_remote_branches', requestId: crypto.randomUUID(), projectName });
    if (response.type === 'remote-branches') return response.branches;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected remote branches response');
  }

  async listLinearIssues(projectName: string): Promise<SessionLinearIssueSummary[]> {
    const response = await this.sendRpcCommand({ type: 'list_linear_issues', requestId: crypto.randomUUID(), projectName });
    if (response.type === 'linear-issues') return response.issues;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected linear issues response');
  }

  async listWorkspaces(): Promise<void> {
    await this.waitForInitialSnapshot();
    this.emit({ type: 'workspaces', workspaces: machineSnapshotToWorkspaces(this.machineStateClient.getSnapshot()) });
  }


  async previewWorkspaceStatusChange(
    projectName: string,
    workspaceName: string,
    phase: import('../../types/config.js').WorkspacePhase
  ): Promise<import('../../types/goals.js').WorkspacePhaseChangePreview> {
    const response = await this.sendRpcCommand({ type: 'preview_workspace_phase', requestId: crypto.randomUUID(), projectName, workspaceName, phase });
    if (response.type === 'workspace-phase-preview') {
      return response.preview;
    }
    if (response.type === 'error') {
      throw new Error(response.message);
    }
    throw new Error('Unexpected workspace phase preview response');
  }

  async setWorkspaceStatus(
    projectName: string,
    workspaceName: string,
    phase: import('../../types/config.js').WorkspacePhase,
    options?: { cascade?: boolean }
  ): Promise<void> {
    const response = await this.sendRpcCommand({ type: 'set_workspace_phase', requestId: crypto.randomUUID(), projectName, workspaceName, phase, cascade: options?.cascade });
    if (response.type === 'ok') {
      await this.listWorkspaces();
      return;
    }
    if (response.type === 'error') {
      throw new Error(response.message);
    }
    throw new Error('Unexpected workspace status response');
  }

  async listSessions(workspaceId?: string): Promise<void> {
    await this.waitForInitialSnapshot();
    this.emit({ type: 'sessions', sessions: machineSnapshotToSessions(this.machineStateClient.getSnapshot(), workspaceId) });
  }

  async listReplays(workspaceId?: string, includeDismissed?: boolean): Promise<void> {
    const command: ListReplaysRequest = {
      type: 'list_replays',
      workspaceId,
      includeDismissed,
    };
    await this.sendCommand(command);
  }

  cancelPendingReplayRequests(): void {
    this.cancelPendingReplayFrame();
    if (this.pendingReplayTimeline) {
      clearTimeout(this.pendingReplayTimeline.timeout);
      this.pendingReplayTimeline.reject(new Error('Replay timeline request cancelled'));
      this.pendingReplayTimeline = null;
    }
  }

  private cancelPendingReplayFrame(): void {
    if (this.pendingReplayFrame) {
      clearTimeout(this.pendingReplayFrame.timeout);
      this.pendingReplayFrame.reject(new Error('Replay frame request cancelled'));
      this.pendingReplayFrame = null;
    }
  }

  async getReplayFrame(replayId: string, target?: ReplayFrameTarget): Promise<import('../backend.js').ReplayFrame> {
    if (this.pendingReplayFrame) {
      // Cancel only the stale frame request, not timeline
      this.cancelPendingReplayFrame();
    }

    const requestId = `rf-${++this.replayFrameRequestSeq}-${Date.now().toString(36)}`;
    const command: GetReplayFrameRequest = {
      type: 'get_replay_frame',
      replayId,
      requestId,
      atMs: target?.atMs,
      atSeq: target?.atSeq,
    };
    return new Promise<import('../backend.js').ReplayFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingReplayFrame;
        if (!pending || pending.requestId !== requestId) {
          return;
        }
        this.pendingReplayFrame = null;
        pending.reject(new Error(`Timed out waiting for replay frame (${replayId})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      const pendingEntry = { replayId, requestId, resolve, reject, timeout };
      this.pendingReplayFrame = pendingEntry;

      void this.sendCommand(command).catch((error) => {
        // Guard against stale send failures cancelling a newer request
        if (this.pendingReplayFrame !== pendingEntry) {
          return;
        }
        clearTimeout(pendingEntry.timeout);
        this.pendingReplayFrame = null;
        pendingEntry.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async getReplayTimeline(replayId: string): Promise<ReplayTimeline> {
    if (this.pendingReplayTimeline) {
      // Cancel stale in-flight request so we can start a fresh one
      const pending = this.pendingReplayTimeline;
      clearTimeout(pending.timeout);
      pending.reject(new Error('Replay timeline request cancelled'));
      this.pendingReplayTimeline = null;
    }

    const command: GetReplayTimelineRequest = { type: 'get_replay_timeline', replayId };
    return new Promise<ReplayTimeline>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingReplayTimeline;
        if (!pending || pending.replayId !== replayId) {
          return;
        }
        this.pendingReplayTimeline = null;
        pending.reject(new Error(`Timed out waiting for replay timeline (${replayId})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.pendingReplayTimeline = { replayId, resolve, reject, timeout };

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingReplayTimeline;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingReplayTimeline = null;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async dismissReplay(replayId: string): Promise<void> {
    if (this.pendingDismissReplay) {
      throw new Error('Replay dismiss request already in progress');
    }
    const command: DismissReplayRequest = { type: 'dismiss_replay', replayId };
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingDismissReplay;
        if (!pending || pending.replayId !== replayId) {
          return;
        }
        this.pendingDismissReplay = null;
        pending.reject(new Error(`Timed out dismissing replay (${replayId})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.pendingDismissReplay = { replayId, resolve, reject, timeout };
      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingDismissReplay;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingDismissReplay = null;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async undismissReplay(replayId: string): Promise<void> {
    if (this.pendingUndismissReplay) {
      throw new Error('Replay restore request already in progress');
    }
    const command: UndismissReplayRequest = { type: 'undismiss_replay', replayId };
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingUndismissReplay;
        if (!pending || pending.replayId !== replayId) {
          return;
        }
        this.pendingUndismissReplay = null;
        pending.reject(new Error(`Timed out restoring replay (${replayId})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.pendingUndismissReplay = { replayId, resolve, reject, timeout };
      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingUndismissReplay;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingUndismissReplay = null;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async dismissOperation(operationId: string): Promise<void> {
    const command: DismissOperationRequest = { type: 'dismiss_operation', operationId };
    await this.sendCommand(command);
  }

  async createProject(params: CreateProjectParams): Promise<void> {
    const operation = await this.startOperationCommand({ type: 'create_project', requestId: crypto.randomUUID(), ...params });
    const response = (await this.waitForOperation(operation.operationId)).result as TmuxResponse | undefined;
    if (response?.type === 'project-created') return;
    throw new Error('Unexpected project create response');
  }

  async prepareProjectCreation(params: CreateProjectParams): Promise<PreparedProjectResult> {
    const operation = await this.startOperationCommand({ type: 'prepare_project_creation', requestId: crypto.randomUUID(), ...params });
    const response = (await this.waitForOperation(operation.operationId)).result as TmuxResponse | undefined;
    if (response?.type === 'project-prepared') return response.result;
    throw new Error('Unexpected project prepare response');
  }

  async finalizeProjectCreation(params: FinalizeProjectParams): Promise<void> {
    const operation = await this.startOperationCommand({ type: 'finalize_project_creation', requestId: crypto.randomUUID(), ...params });
    const response = (await this.waitForOperation(operation.operationId)).result as TmuxResponse | undefined;
    if (response?.type === 'project-created') return;
    throw new Error('Unexpected project finalize response');
  }

  async cancelProjectCreation(projectName: string): Promise<void> {
    const response = await this.sendRpcCommand({ type: 'cancel_project_creation', requestId: crypto.randomUUID(), projectName });
    if (response.type === 'project-cancelled') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected project cancel response');
  }

  async createWorkspace(params: CreateWorkspaceParams): Promise<void> {
    const operation = await this.startOperationCommand({ type: 'create_workspace', requestId: crypto.randomUUID(), ...params });
    const response = (await this.waitForOperation(operation.operationId)).result as TmuxResponse | undefined;
    if (response?.type === 'workspace-created') return;
    throw new Error('Unexpected workspace create response');
  }

  async deleteProject(projectName: string, params: DeleteProjectParams = {}): Promise<void> {
    void params;
    const operation = await this.startOperationCommand({ type: 'delete_project', requestId: crypto.randomUUID(), projectName });
    const response = (await this.waitForOperation(operation.operationId)).result as TmuxResponse | undefined;
    if (response?.type === 'project-deleted') return;
    throw new Error('Unexpected project delete response');
  }

  async attachSession(params: AttachSessionParams): Promise<void> {
    await this.attachPane({ ...params, paneId: DEFAULT_PANE_ID });
  }

  async attachPane(params: AttachPaneParams): Promise<void> {
    const resolvedWorkspaceId =
      params.workspaceId ?? getTerminalSessionWorkspaceId(this.machineStateClient.getSnapshot(), params.sessionId);
    const existingPane = this.panes.get(params.paneId);
    if (existingPane) {
      this.panes.delete(params.paneId);
      void this.sendCommand({ type: 'detach', streamId: existingPane.streamId }).catch((error) => {
        console.warn('[remote-session] fire-and-forget pane detach failed:', error);
      });
    }

    if (params.paneId === DEFAULT_PANE_ID && this.attachLifecycle.isTransportActive) {
      this.rejectPendingDetachTransition(new Error('Superseded by new attach'));
      this.attachedAgentSessionId = null;
      this.pendingAttachedAgentSession = null;
      this.attachLifecycle.clearAttachment({ emitDetached: true });
    }

    const streamId = params.paneId === DEFAULT_PANE_ID ? DEFAULT_PANE_STREAM_ID : this.nextStreamId++;
    const pane = new PaneLifecycle({
      paneId: params.paneId,
      streamId,
      sessionId: params.sessionId ?? null,
      workspaceId: resolvedWorkspaceId ?? null,
      agentSessionId: params.agentSessionId ?? null,
      viewOnly: params.viewOnly ?? false,
    });
    this.panes.set(params.paneId, pane);

    if (params.paneId === DEFAULT_PANE_ID) {
      this.attachLifecycle.beginAttach({
        workspaceId: resolvedWorkspaceId ?? null,
        viewOnly: params.viewOnly ?? false,
      });
    }

    const command: AttachSessionRequest = {
      type: 'attach_session',
      streamId,
      sessionId: params.sessionId,
      workspaceId: resolvedWorkspaceId,
      sessionName: params.sessionName,
      cols: params.cols ?? 80,
      rows: params.rows ?? 24,
      scriptPolicy: params.scriptPolicy,
      viewOnly: params.viewOnly,
      command: params.command,
      args: params.args,
      env: params.env,
    };
    await this.sendCommand(command);
  }

  async getKnownAgentSessions(workspaceId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    await this.waitForInitialSnapshot();
    return machineSnapshotToKnownAgentSessions(this.machineStateClient.getSnapshot(), workspaceId, { includeArchived: true });
  }

  async listAgentSessions(workspaceId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({ type: 'list_agent_sessions', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), mode: 'live' });
    if (response.type === 'agent-sessions') return response.sessions;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent sessions response');
  }

  async createAgentSession(workspaceId: string, title?: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({ type: 'create_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), title });
    if (response.type === 'agent-sessions') return response.sessions;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent create response');
  }

  async abortAgentSession(workspaceId: string, agentSessionId: string): Promise<boolean> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({ type: 'abort_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), agentSessionId });
    if (response.type === 'agent-bool') {
      if (response.ok) {
        this.applyOptimisticAgentState(agentSessionId, { state: 'closed' });
      }
      return response.ok;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent abort response');
  }

  async interruptAgentSession(workspaceId: string, agentSessionId: string): Promise<boolean> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({ type: 'interrupt_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), agentSessionId });
    if (response.type === 'agent-bool') return response.ok;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent interrupt response');
  }

  async closeAgentSession(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({ type: 'close_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), agentSessionId });
    if (response.type === 'agent-sessions') {
      this.applyOptimisticAgentState(agentSessionId, { state: 'closed', closedAt: new Date().toISOString() });
      return response.sessions;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent close response');
  }

  async archiveAgentSession(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({ type: 'archive_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), agentSessionId });
    if (response.type === 'agent-sessions') {
      this.applyOptimisticAgentState(agentSessionId, { state: 'archived', archivedAt: new Date().toISOString() });
      return response.sessions;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent archive response');
  }

  async restoreAgentSession(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({ type: 'restore_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), agentSessionId });
    if (response.type === 'agent-sessions') {
      this.applyOptimisticAgentState(agentSessionId, { state: 'closed', archivedAt: undefined });
      return response.sessions;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent restore response');
  }


  private findExistingAgentTerminalSession(workspaceId: string, agentSessionId: string): string | null {
    const snapshot = this.machineStateClient.getSnapshot();
    for (const session of Object.values(snapshot.terminalSessionsById)) {
      if (session.exitCode !== undefined || session.kind !== 'agent') continue;
      const linkedAgentSessionId = session.linkedAgentSessionId ?? session.metadata?.agentSessionId;
      const linkedWorkspaceId = session.workspaceId ?? session.metadata?.workspaceId;
      if (linkedAgentSessionId === agentSessionId && linkedWorkspaceId === workspaceId) {
        return session.id;
      }
    }
    return null;
  }

  async attachAgentSession(workspaceId: string, agentSessionId: string, options: { viewOnly?: boolean; cols?: number; rows?: number; paneId?: string } = {}): Promise<void> {
    await this.waitForInitialSnapshot();
    const existingTerminalSessionId = this.findExistingAgentTerminalSession(workspaceId, agentSessionId);
    const paneId = options.paneId ?? DEFAULT_PANE_ID;
    if (existingTerminalSessionId) {
      if (paneId === DEFAULT_PANE_ID) {
        this.pendingAttachedAgentSession = {
          agentSessionId,
          sessionId: existingTerminalSessionId,
        };
      }
      try {
        await this.attachPane({
          paneId,
          sessionId: existingTerminalSessionId,
          workspaceId,
          agentSessionId,
          viewOnly: options.viewOnly,
          cols: options.cols,
          rows: options.rows,
        });
      } catch (error) {
        this.pendingAttachedAgentSession = null;
        throw error;
      }
      return;
    }
    // attachSession() handles detaching from the prior tmux-lite session via
    // its own fire-and-forget detach path; no need for an extra round-trip here.
    const response = await this.sendRpcCommand({ type: 'attach_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), agentSessionId, cols: options.cols, rows: options.rows });
    if (response.type !== 'session') {
      if (response.type === 'error') throw new Error(response.message);
      throw new Error('Unexpected agent attach response');
    }
    if (paneId === DEFAULT_PANE_ID) {
      this.pendingAttachedAgentSession = {
        agentSessionId,
        sessionId: response.session.id,
      };
    }
    try {
      await this.attachPane({ paneId, sessionId: response.session.id, workspaceId, agentSessionId, viewOnly: options.viewOnly, cols: options.cols, rows: options.rows });
    } catch (error) {
      this.pendingAttachedAgentSession = null;
      throw error;
    }
  }

  async promptAgentSession(workspaceId: string, agentSessionId: string, text: string, images?: import('../../lib/tmux-lite/protocol.js').AgentPromptImage[], options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({ type: 'prompt_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), agentSessionId, text, images, streamingBehavior: options?.streamingBehavior });
    if (response.type === 'ok') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error(`Unexpected prompt response: ${response.type}`);
  }

  async removeAgentQueuedMessage(workspaceId: string, agentSessionId: string, kind: 'steering' | 'followUp', index: number): Promise<string | null> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({
      type: 'remove_agent_queued_message',
      requestId: crypto.randomUUID(),
      target: this.getAgentWorkspaceTarget(workspaceId),
      agentSessionId,
      kind,
      index,
    });
    if (response.type === 'agent-queued-message') return response.message;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error(`Unexpected queued message response: ${response.type}`);
  }

  async stageUpload(workspaceId: string, fileName: string, data: string, mimeType: string): Promise<{ stagedPath: string }> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({ type: 'stage_agent_upload', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), fileName, data, mimeType });
    if (response.type === 'agent-staged') return { stagedPath: response.stagedPath };
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected stage upload response');
  }

  async sendDialogResponse(dialogId: string, dialogType: 'select' | 'confirm' | 'input' | 'editor', value: string | boolean | undefined): Promise<void> {
    const response = await this.sendRpcCommand({ type: 'respond_agent_dialog', requestId: crypto.randomUUID(), dialogId, dialogType, value });
    if (response.type === 'agent-bool') {
      if (response.ok) return;
      throw new Error(`Dialog is no longer pending: ${dialogId}`);
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected dialog response acknowledgement');
  }

  async listAgentCommands(workspaceId: string): Promise<Array<{ name: string; description: string; kind: 'file' | 'custom' | 'extension' }>> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({ type: 'list_agent_commands', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId) });
    if (response.type === 'agent-commands') return response.commands;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected list commands response');
  }

  async listAvailableEditors(workspaceId: string): Promise<WorkspaceEditorOption[]> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({
      type: 'list_workspace_editors',
      requestId: crypto.randomUUID(),
      target: this.getAgentWorkspaceTarget(workspaceId),
    });
    if (response.type === 'workspace-editors') return response.editors;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected editor listing response');
  }

  async openWorkspaceInEditor(workspaceId: string, editorId: WorkspaceEditorId): Promise<void> {
    await this.waitForInitialSnapshot();
    const operation = await this.startOperationCommand({
      type: 'open_workspace_editor',
      requestId: crypto.randomUUID(),
      target: this.getAgentWorkspaceTarget(workspaceId),
      editorId,
    });
    const response = (await this.waitForOperation(operation.operationId)).result as TmuxResponse | undefined;
    if (response?.type === 'ok') return;
    throw new Error('Unexpected open editor response');
  }


  async runSpaceCommand(workspaceId: string, argsText: string): Promise<string> {
    await this.waitForInitialSnapshot();
    const operation = await this.startOperationCommand({
      type: 'run_space_command',
      requestId: crypto.randomUUID(),
      target: this.getAgentWorkspaceTarget(workspaceId),
      argsText,
    });
    const response = (await this.waitForOperation(operation.operationId)).result as RunSpaceCommandResponse | undefined;
    if (response?.type === 'run_space_command_response') return response.output;
    throw new Error('Unexpected run space command response');
  }

  private unwrapSpaceCommandOutput(output: string): string {
    const trimmed = output.trim();
    for (const token of ['\n{', '\n[', '{', '[']) {
      const index = trimmed.lastIndexOf(token);
      if (index >= 0) {
        const candidate = token.startsWith('\n') ? trimmed.slice(index + 1).trim() : trimmed.slice(index).trim();
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {}
      }
    }
    if (trimmed.includes('exit code:')) {
      throw new Error(output);
    }
    return trimmed;
  }

  private getWorkspaceIdForGoal(projectName: string, goalId: string): string {
    const snapshot = this.machineStateClient.getSnapshot();
    const persistedGoalId = goalId.includes(':') ? goalId.split(':').slice(-1)[0] : goalId;
    const fullGoalId = `${projectName}:${persistedGoalId}`;
    const goal = snapshot.goalsById?.[fullGoalId];
    if (!goal) {
      throw new Error(`Goal not found: ${goalId}`);
    }
    if (goal.workspaceName) {
      const workspace = Object.values(snapshot.workspacesById).find((item) => item && item.projectName === projectName && item.name === goal.workspaceName);
      if (workspace) return workspace.id;
    }
    const fallback = Object.values(snapshot.workspacesById).find((item) => item && item.projectName === projectName);
    if (fallback) return fallback.id;
    throw new Error(`No workspace is available to run goal command for ${goal.title}.`);
  }

  async addGoalRequirement(projectName: string, goalId: string, input: AddRequirementInput): Promise<import('../../types/goals.js').Requirement> {
    const workspaceId = this.getWorkspaceIdForGoal(projectName, goalId);
    const parts = ['goal', 'requirement', 'add', '--goal', goalId, '--title', input.title, '--kind', input.kind, '--rubric', input.rubric, '--gen', input.generation.kind, '--judge', input.judgment.kind, '--json'];
    if (input.generation.kind === 'command') parts.push('--gen-command', input.generation.command);
    if (input.judgment.kind === 'command') {
      parts.push('--judge-command', input.judgment.command);
      parts.push('--expect', input.judgment.expect.kind);
      if (input.judgment.expect.kind === 'stdout-contains') parts.push('--expect-needle', input.judgment.expect.needle);
      if (input.judgment.expect.kind === 'output-matches') parts.push('--expect-pattern', input.judgment.expect.pattern);
    }
    if (input.judgment.kind === 'llm' && input.judgment.modelHint) parts.push('--model-hint', input.judgment.modelHint);
    if (input.required === false) parts.push('--optional');
    const output = await this.runSpaceCommand(workspaceId, parts.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' '));
    const parsed = JSON.parse(this.unwrapSpaceCommandOutput(output)) as { goalId: string; requirement: import('../../types/goals.js').Requirement };
    await this.listWorkspaces();
    return parsed.requirement;
  }

  async updateGoalRequirement(projectName: string, goalId: string, requirementId: string, patch: UpdateRequirementInput): Promise<import('../../types/goals.js').Requirement> {
    const workspaceId = this.getWorkspaceIdForGoal(projectName, goalId);
    const parts = ['goal', 'requirement', 'update', '--goal', goalId, '--requirement', requirementId, '--json'];
    if (patch.title !== undefined) parts.push('--title', patch.title);
    if (patch.kind !== undefined) parts.push('--kind', patch.kind);
    if (patch.rubric !== undefined) parts.push('--rubric', patch.rubric);
    if (patch.required === true) parts.push('--required');
    if (patch.required === false) parts.push('--optional');
    if (patch.generation) {
      parts.push('--gen', patch.generation.kind);
      if (patch.generation.kind === 'command') parts.push('--gen-command', patch.generation.command);
    }
    if (patch.judgment) {
      parts.push('--judge', patch.judgment.kind);
      if (patch.judgment.kind === 'command') {
        parts.push('--judge-command', patch.judgment.command);
        parts.push('--expect', patch.judgment.expect.kind);
        if (patch.judgment.expect.kind === 'stdout-contains') parts.push('--expect-needle', patch.judgment.expect.needle);
        if (patch.judgment.expect.kind === 'output-matches') parts.push('--expect-pattern', patch.judgment.expect.pattern);
      }
      if (patch.judgment.kind === 'llm' && patch.judgment.modelHint) parts.push('--model-hint', patch.judgment.modelHint);
    }
    const output = await this.runSpaceCommand(workspaceId, parts.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' '));
    const parsed = JSON.parse(this.unwrapSpaceCommandOutput(output)) as { goalId: string; requirement: import('../../types/goals.js').Requirement };
    await this.listWorkspaces();
    return parsed.requirement;
  }

  async removeGoalRequirement(projectName: string, goalId: string, requirementId: string): Promise<void> {
    const workspaceId = this.getWorkspaceIdForGoal(projectName, goalId);
    const parts = ['goal', 'requirement', 'remove', '--goal', goalId, '--requirement', requirementId, '--json'];
    await this.runSpaceCommand(workspaceId, parts.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' '));
    await this.listWorkspaces();
  }

  async reorderGoalRequirement(projectName: string, goalId: string, requirementId: string, position: number): Promise<void> {
    const workspaceId = this.getWorkspaceIdForGoal(projectName, goalId);
    const parts = ['goal', 'requirement', 'reorder', '--goal', goalId, '--requirement', requirementId, '--position', String(position), '--json'];
    await this.runSpaceCommand(workspaceId, parts.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' '));
    await this.listWorkspaces();
  }

  async reopenGoalRequirement(projectName: string, goalId: string, requirementId: string): Promise<import('../../types/goals.js').Requirement> {
    const workspaceId = this.getWorkspaceIdForGoal(projectName, goalId);
    const parts = ['goal', 'requirement', 'reopen', '--goal', goalId, '--requirement', requirementId, '--json'];
    const output = await this.runSpaceCommand(workspaceId, parts.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' '));
    const parsed = JSON.parse(this.unwrapSpaceCommandOutput(output)) as { goalId: string; requirementId: string; status: import('../../types/goals.js').RequirementStatus };
    await this.listWorkspaces();
    const goal = await this.refreshAndFetchGoal(projectName, goalId);
    return goal.validation.requirements[requirementId];
    void parsed;
  }

  async attachGoalEvidence(projectName: string, goalId: string, requirementId: string, input: AttachEvidenceInput): Promise<import('../../types/goals.js').Evidence> {
    const workspaceId = this.getWorkspaceIdForGoal(projectName, goalId);
    const parts = ['goal', 'artifact', 'attach', '--goal', goalId, '--requirement', requirementId, '--json'];
    if (input.name) parts.push('--name', input.name);
    if (input.body) parts.push('--body', input.body);
    if (input.path) parts.push('--path', input.path);
    if (input.url) parts.push('--url', input.url);
    const output = await this.runSpaceCommand(workspaceId, parts.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' '));
    const parsed = JSON.parse(this.unwrapSpaceCommandOutput(output)) as { goalId: string; requirementId: string; evidence: import('../../types/goals.js').Evidence };
    await this.listWorkspaces();
    return parsed.evidence;
  }

  async runGoalGeneration(projectName: string, goalId: string, requirementId: string): Promise<{ requirement: import('../../types/goals.js').Requirement; evidence: import('../../types/goals.js').Evidence; autoAccepted: boolean }> {
    const workspaceId = this.getWorkspaceIdForGoal(projectName, goalId);
    const parts = ['goal', 'artifact', 'run', '--goal', goalId, '--requirement', requirementId, '--json'];
    const output = await this.runSpaceCommand(workspaceId, parts.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' '));
    const parsed = JSON.parse(this.unwrapSpaceCommandOutput(output)) as { goalId: string; requirementId: string; evidence: import('../../types/goals.js').Evidence; autoAccepted: boolean };
    await this.listWorkspaces();
    const goal = await this.refreshAndFetchGoal(projectName, goalId);
    return { requirement: goal.validation.requirements[requirementId], evidence: parsed.evidence, autoAccepted: parsed.autoAccepted };
  }

  async runGoalJudgment(projectName: string, goalId: string, requirementId: string): Promise<{ requirement: import('../../types/goals.js').Requirement; review: import('../../types/goals.js').Review }> {
    const workspaceId = this.getWorkspaceIdForGoal(projectName, goalId);
    const parts = ['goal', 'review', 'run', '--goal', goalId, '--requirement', requirementId, '--json'];
    const output = await this.runSpaceCommand(workspaceId, parts.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' '));
    const parsed = JSON.parse(this.unwrapSpaceCommandOutput(output)) as { goalId: string; requirementId: string; review: import('../../types/goals.js').Review };
    await this.listWorkspaces();
    const goal = await this.refreshAndFetchGoal(projectName, goalId);
    return { requirement: goal.validation.requirements[requirementId], review: parsed.review };
  }

  async recordGoalHumanReview(projectName: string, goalId: string, requirementId: string, decision: HumanReviewDecision, note: string, createdBy?: string): Promise<import('../../types/goals.js').Review> {
    const workspaceId = this.getWorkspaceIdForGoal(projectName, goalId);
    const parts = ['goal', 'review', 'record', '--goal', goalId, '--requirement', requirementId, '--decision', decision, '--body', note, '--json'];
    if (createdBy) parts.push('--created-by', createdBy);
    const output = await this.runSpaceCommand(workspaceId, parts.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' '));
    const parsed = JSON.parse(this.unwrapSpaceCommandOutput(output)) as { goalId: string; requirementId: string; review: import('../../types/goals.js').Review };
    await this.listWorkspaces();
    return parsed.review;
  }

  private async refreshAndFetchGoal(projectName: string, goalId: string): Promise<import('../../types/goals.js').GoalRecord> {
    await this.refreshMachineSnapshot();
    const snapshot = this.machineStateClient.getSnapshot();
    const persistedGoalId = goalId.includes(':') ? goalId.split(':').slice(-1)[0] : goalId;
    const fullGoalId = `${projectName}:${persistedGoalId}`;
    const goal = snapshot.goalsById?.[fullGoalId];
    if (!goal) throw new Error(`Goal not found in refreshed snapshot: ${goalId}`);
    return goal as unknown as import('../../types/goals.js').GoalRecord;
  }

  async getFileSuggestions(workspaceId: string, prefix: string, limit?: number): Promise<Array<{ path: string; isDirectory: boolean }>> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({ type: 'get_agent_file_suggestions', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), prefix, limit });
    if (response.type === 'agent-file-suggestions') return response.suggestions;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected file suggestions response');
  }

  async detachSession(): Promise<void> {
    await this.detachPane(DEFAULT_PANE_ID);
  }

  async detachPane(paneId: string): Promise<void> {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    this.panes.delete(paneId);
    if (paneId === DEFAULT_PANE_ID) {
      this.attachLifecycle.clearAttachment({ emitDetached: true });
      this.attachedAgentSessionId = null;
      this.pendingAttachedAgentSession = null;
    }
    await this.sendCommand({ type: 'detach', streamId: pane.streamId });
    if (paneId !== DEFAULT_PANE_ID) {
      this.emit({ type: 'pane_detached', paneId });
    }
  }

  async detachAllPanes(): Promise<void> {
    this.panes.clear();
    this.attachLifecycle.clearAttachment({ emitDetached: true });
    this.attachedAgentSessionId = null;
    this.pendingAttachedAgentSession = null;
    await this.sendCommand({ type: 'detach_all' });
  }

  async cancelPendingScripts(): Promise<void> {
    const command: CancelPendingAttachRequest = { type: 'cancel_pending_attach' };
    await this.sendCommand(command);
  }

  async terminateSession(sessionId: string, options: TerminateSessionOptions = {}): Promise<void> {
    const response = await this.sendRpcCommand({ type: 'terminate_session', requestId: crypto.randomUUID(), sessionId, mode: options.mode, graceMs: options.graceMs });
    if (response.type === 'ok') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected terminate session response');
  }

  async deleteWorkspace(
    projectName: string,
    workspaceId: string,
    params: DeleteWorkspaceParams = {}
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    const command: DeleteWorkspaceRequest & { requestId: string } = {
      type: 'delete_workspace',
      requestId,
      projectName,
      workspaceId,
      scriptPolicy: params.scriptPolicy,
    };

    try {
      const operation = await this.startOperationCommand(command);
      const response = (await this.waitForOperation(operation.operationId)).result as { type?: string; workspaceId?: string } | undefined;
      if (response?.type === 'workspace_deleted') {
        await this.listWorkspaces();
        return;
      }
      throw new WorkspaceDeleteError(
        `Unexpected workspace deletion response (${workspaceId})`,
        'DELETE_FAILED',
      );
    } catch (error) {
      if (error instanceof WorkspaceDeleteError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkspaceDeleteError(message, toWorkspaceDeleteErrorCode((error as Error & { code?: string }).code));
    }
  }

  async listWorkspaceNotes(projectName: string, workspaceName: string): Promise<import('../../types/workspace.js').WorkspaceNote[]> {
    const response = await this.sendRpcCommand({ type: 'workspace_notes_list', requestId: crypto.randomUUID(), projectName, workspaceName });
    if (response.type === 'workspace-notes') return response.notes;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected workspace notes response');
  }

  async addWorkspaceNote(projectName: string, workspaceName: string, body: string): Promise<import('../../types/workspace.js').WorkspaceNote> {
    const response = await this.sendRpcCommand({ type: 'workspace_note_add', requestId: crypto.randomUUID(), projectName, workspaceName, body });
    if (response.type === 'workspace-note') {
      await this.listWorkspaces();
      return response.note;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected workspace note add response');
  }

  async updateWorkspaceNote(projectName: string, workspaceName: string, noteId: string, body: string): Promise<import('../../types/workspace.js').WorkspaceNote> {
    const response = await this.sendRpcCommand({ type: 'workspace_note_update', requestId: crypto.randomUUID(), projectName, workspaceName, noteId, body });
    if (response.type === 'workspace-note') {
      await this.listWorkspaces();
      return response.note;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected workspace note update response');
  }

  async removeWorkspaceNote(projectName: string, workspaceName: string, noteId: string): Promise<void> {
    const response = await this.sendRpcCommand({ type: 'workspace_note_remove', requestId: crypto.randomUUID(), projectName, workspaceName, noteId });
    if (response.type === 'ok') {
      await this.listWorkspaces();
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected workspace note remove response');
  }

  async addGoalNearWorkspace(projectName: string, workspaceName: string, title: string, position: 'before' | 'after'): Promise<import('../../types/goals.js').GoalRecord> {
    const response = await this.sendRpcCommand({ type: 'goal_add_near_workspace', requestId: crypto.randomUUID(), projectName, workspaceName, title, position });
    if (response.type === 'goal') {
      await this.listWorkspaces();
      return response.goal;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected goal add response');
  }

  async updateGoal(projectName: string, goalId: string, updates: import('../../types/goals.js').GoalUpdateInput): Promise<import('../../types/goals.js').GoalRecord> {
    const response = await this.sendRpcCommand({ type: 'goal_update', requestId: crypto.randomUUID(), projectName, goalId, updates });
    if (response.type === 'goal') {
      await this.listWorkspaces();
      return response.goal;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected goal update response');
  }

  async moveGoalInChain(projectName: string, sourceToken: string, targetToken: string, position: 'before' | 'after'): Promise<import('../../types/goals.js').GoalChain> {
    const response = await this.sendRpcCommand({ type: 'goal_reorder', requestId: crypto.randomUUID(), projectName, sourceToken, targetToken, position });
    if (response.type === 'goal-chain') {
      await this.listWorkspaces();
      return response.chain;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected goal reorder response');
  }

  async getGoalStackStatus(projectName: string, workspaceName: string): Promise<import('../../types/goals.js').ChainStackStatus> {
    const response = await this.sendRpcCommand({ type: 'goal_stack_status', requestId: crypto.randomUUID(), projectName, workspaceName });
    if (response.type === 'goal-stack-status') return response.status;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected goal stack status response');
  }

  async rerunWorkspaceScripts(projectName: string, workspaceId: string): Promise<void> {
    const operation = await this.startOperationCommand({ type: 'rerun_workspace_scripts', requestId: crypto.randomUUID(), projectName, workspaceId });
    await this.waitForOperation(operation.operationId);
    await this.listWorkspaces();
    return;
  }

  async runWorkspaceOpenScripts(projectName: string, workspaceId: string): Promise<void> {
    const operation = await this.startOperationCommand({ type: 'run_workspace_open_scripts', requestId: crypto.randomUUID(), projectName, workspaceId });
    await this.waitForOperation(operation.operationId);
    await this.listWorkspaces();
    return;
  }

  async runWorkspaceScriptSelection(projectName: string, workspaceId: string, selection: 'setup' | 'select' | 'setup-select'): Promise<void> {
    const operation = await this.startOperationCommand({ type: 'run_workspace_script_selection', requestId: crypto.randomUUID(), projectName, workspaceId, selection });
    await this.waitForOperation(operation.operationId);
    await this.listWorkspaces();
    return;
  }
  async getBundleRefreshPlan(projectName: string, workspaceId: string): Promise<BundleRefreshPlan> {
    const response = await this.sendRpcCommand({ type: 'get_bundle_refresh_plan', requestId: crypto.randomUUID(), projectName, workspaceId });
    if (response.type === 'bundle-refresh-plan') return response.plan;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected bundle refresh plan response');
  }

  async applyBundleRefresh(
    projectName: string,
    workspaceId: string,
    submission: BundleRefreshSubmission
  ): Promise<void> {
    const response = await this.sendRpcCommand({ type: 'apply_bundle_refresh', requestId: crypto.randomUUID(), projectName, workspaceId, submission });
    if (response.type === 'bundle-refresh-applied') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected bundle refresh apply response');
  }

  async getBundleConfigState(projectName: string, workspaceId: string): Promise<BundleConfigState> {
    const response = await this.sendRpcCommand({ type: 'get_bundle_config_state', requestId: crypto.randomUUID(), projectName, workspaceId });
    if (response.type === 'bundle-config-state') return response.state;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected bundle config state response');
  }

  async applyBundleConfigUpdate(
    projectName: string,
    workspaceId: string,
    submission: BundleConfigSubmission
  ): Promise<void> {
    const response = await this.sendRpcCommand({ type: 'apply_bundle_config', requestId: crypto.randomUUID(), projectName, workspaceId, submission });
    if (response.type === 'bundle-config-applied') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected bundle config apply response');
  }

  async requestInbox(): Promise<void> {
    await this.waitForInitialSnapshot();
    const response = await this.sendRpcCommand({ type: 'get_inbox', requestId: crypto.randomUUID() });
    if (response.type === 'inbox') {
      const sessions = machineSnapshotToSessions(this.machineStateClient.getSnapshot());
      const activeSessionIds = new Set(sessions.map((session) => session.id));
      const unreadCount = new Set(response.items.filter((item) => !item.read && activeSessionIds.has(item.sessionId)).map((item) => item.sessionId)).size;
      this.emit({ type: 'inbox', items: response.items, unreadCount });
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected inbox response');
  }

  async clearInbox(id?: string): Promise<void> {
    const response = await this.sendRpcCommand({ type: 'clear_inbox', requestId: crypto.randomUUID(), id });
    if (response.type === 'ok') {
      await this.requestInbox();
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected clear inbox response');
  }

  async markInboxRead(id: string): Promise<void> {
    const response = await this.sendRpcCommand({ type: 'mark_inbox_read', requestId: crypto.randomUUID(), id });
    if (response.type === 'ok') {
      await this.requestInbox();
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected mark inbox read response');
  }

  async getNotificationConfig(): Promise<void> {
    const response = await this.sendRpcCommand({ type: 'get_notification_config', requestId: crypto.randomUUID() });
    if (response.type === 'notification-config') {
      this.emit({ type: 'notification_config', config: response.config });
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected notification config response');
  }

  async updateNotificationConfig(config: NotificationConfig): Promise<void> {
    const response = await this.sendRpcCommand({ type: 'update_notification_config', requestId: crypto.randomUUID(), config });
    if (response.type === 'notification-config') {
      this.emit({ type: 'notification_config', config: response.config });
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected notification config update response');
  }

  async sendReviewRequest(operation: ReviewOperation): Promise<ReviewResult> {
    const requestId = crypto.randomUUID();
    console.debug('[review-debug] remote backend sendReviewRequest start', {
      op: operation.op,
      requestId,
    });
    const operationRecord = await this.startOperationCommand({ type: 'request_review', requestId, operation });
    const response = (await this.waitForOperation(operationRecord.operationId)).result as TmuxResponse | undefined;
    console.debug('[review-debug] remote backend sendReviewRequest response', {
      op: operation.op,
      requestId,
      responseType: response?.type,
      reviewRequestId: response?.type === 'review-response' ? response.requestId : undefined,
    });
    if (response?.type === 'review-response') {
      if (response.error) {
        throw new ReviewRequestError(response.error.message, response.error.code, { op: operation.op, requestId: response.requestId });
      }
      if (!response.result) {
        throw new ReviewRequestError('Review response missing result', 'REVIEW_FAILED', { op: operation.op, requestId: response.requestId });
      }
      return response.result;
    }
    throw new ReviewRequestError('Unexpected review response', 'REVIEW_FAILED', { op: operation.op });
  }

  async startProcess(workspaceId: string, processName: string, instance?: number): Promise<void> {
    const response = await this.sendRpcCommand({
      type: 'start_process',
      requestId: crypto.randomUUID(),
      workspaceId,
      processName,
      instance,
    });
    if (response.type === 'service-started') {
      this.emit({
        type: 'process_started',
        workspaceId: response.workspaceId,
        processName: response.processName,
        sessionId: response.sessionId,
        sessionIds: response.sessionIds,
      });
      return;
    }
    if (response.type === 'error') {
      throwServiceStartError(response);
    }
    throw new Error('Unexpected tmux service start response');
  }

  async resolvePortConflict(conflict: PortConflictInfo): Promise<void> {
    const response = await this.sendRpcCommand({
      type: 'resolve_port_conflict',
      requestId: crypto.randomUUID(),
      workspaceId: conflict.managedWorkspaceId ?? '',
      conflict,
    });
    if (response.type === 'ok') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected port conflict resolution response');
  }

  async stopProcess(workspaceId: string, processName: string): Promise<void> {
    const response = await this.sendRpcCommand({
      type: 'stop_process',
      requestId: crypto.randomUUID(),
      workspaceId,
      processName,
    });
    if (response.type === 'service-stopped') {
      this.emit({
        type: 'process_stopped',
        workspaceId: response.workspaceId,
        processName: response.processName,
      });
      return;
    }
    if (response.type === 'error') {
      throw new Error(response.message);
    }
    throw new Error('Unexpected tmux service stop response');
  }

  async requestEvents(
    workspacePath: string,
    filter?: WideEventFilter,
    limit?: number,
    sinceMs?: number,
  ): Promise<void> {
    const response = await this.sendRpcCommand({ type: 'request_events', requestId: crypto.randomUUID(), workspacePath, filter, limit, sinceMs });
    if (response.type === 'events-list') {
      this.emit({ type: 'events', events: response.events, liveEventIds: response.liveEventIds, savedEventFilters: response.savedEventFilters ?? [] });
      return;
    }
    if (response.type === 'error') {
      throw new Error(response.message);
    }
    throw new Error('Unexpected events response');
  }

  async writePtyData(data: Uint8Array): Promise<void> {
    await this.writePaneData(DEFAULT_PANE_ID, data);
  }

  async writePaneData(paneId: string, data: Uint8Array): Promise<void> {
    const pane = this.panes.get(paneId);
    if (!pane || pane.viewOnly) return;
    this.assertConnected();

    const key = this.sessionKeys;
    if (!key) {
      throw new Error('Session keys are not established');
    }

    const frame = await this.crypto.createFrame(pane.streamId, data, key.sendKey);
    const encoded = this.crypto.encodeBase64(frame);
    const message: RelayDataMessage = { type: 'data', data: encoded, priority: 'bulk' };
    this.socketAdapter.send(this.socket, JSON.stringify(message));
  }

  async resizePty(cols: number, rows: number): Promise<void> {
    await this.resizePane(DEFAULT_PANE_ID, cols, rows);
  }

  async resizePane(paneId: string, cols: number, rows: number): Promise<void> {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    const ctrl: RemoteSessionControl = { type: 'resize', streamId: pane.streamId, cols, rows };
    await this.sendCommand(ctrl);
  }

  private attachSocketListeners(): void {
    if (this.listenersAttached) {
      return;
    }

    this.socketAdapter.setHandlers(this.socket, {
      onOpen: () => {
        this.sendRelayConnectMessage();
      },
      onClose: (info) => {
        const closeMessage = info?.code || info?.reason
          ? `Socket closed before handshake completed (code=${info?.code ?? 'unknown'}, reason=${info?.reason || 'none'})`
          : 'Socket closed before handshake completed';
        this.rejectConnect(new Error(closeMessage));
        if (this.attachLifecycle.isTransportActive) {
          this.attachLifecycle.clearAttachment({ emitDetached: true });
          this.attachedAgentSessionId = null;
          this.pendingAttachedAgentSession = null;
        }
        this.resetState();
        this.emit({ type: 'status', status: 'disconnected' });
      },
      onMessage: (raw) => {
        void this.handleRelayMessage(raw).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.emit({ type: 'error', message: `Failed to process relay message: ${message}` });
        });
      },
      onError: (error) => {
        this.rejectConnect(error);
        this.rejectPendingWorkspaceDelete('DELETE_FAILED', error.message);
        this.emit({ type: 'status', status: 'error', error: error.message });
      },
    });

    this.listenersAttached = true;
  }

  private sendRelayConnectMessage(): void {
    const relayMessage: RelayConnectMessage = {
      type: 'connect_to_machine',
      machineId: this.machineId,
      clientIdentityId: this.identity.id,
      deviceCertificate: this.deviceCertificate,
    };

    const signed = this.signer(relayMessage, this.identity);
    this.socketAdapter.send(this.socket, JSON.stringify(signed));
  }

  private async handleRelayMessage(raw: string): Promise<void> {
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== 'object') {
      this.emit({ type: 'error', message: 'Invalid relay message JSON' });
      return;
    }

    const message = parsed as { type?: unknown; [key: string]: unknown };
    if (typeof message.type !== 'string') {
      this.emit({ type: 'error', message: 'Relay message missing type' });
      return;
    }

    switch (message.type) {
      case 'connection_established':
        this.startHandshake();
        return;
      case 'data':
        if (typeof message.data !== 'string') {
          this.emit({ type: 'error', message: 'Relay data message missing payload' });
          return;
        }
        await this.handleRelayDataPayload(message.data);
        return;
      case 'error':
        if (typeof message.message !== 'string') {
          this.emit({ type: 'error', message: 'Relay error message missing text' });
          this.rejectConnect(new Error('Relay error message missing text'));
          return;
        }
        this.emit({ type: 'status', status: 'error', error: message.message });
        this.emit({ type: 'error', message: message.message });
        this.rejectConnect(new Error(message.message));
        return;
      case 'pong':
        return;
      default:
        return;
    }
  }

  private startHandshake(): void {
    const { state, message } = this.handshake.createClientHello(this.machineId);
    this.handshakeState = state;

    const envelope: HandshakeEnvelope = {
      type: 'handshake',
      phase: 'client_hello',
      data: message,
    };

    this.socketAdapter.send(this.socket, JSON.stringify(envelope));
  }

  private async handleRelayDataPayload(base64Data: string): Promise<void> {
    const encryptedBytes = this.crypto.decodeBase64(base64Data);

    if (!this.isConnected) {
      const plaintextMaybeHandshake = safeJsonParse(new TextDecoder().decode(encryptedBytes));
      if (isHandshakeEnvelope(plaintextMaybeHandshake)) {
        this.handleHandshakeEnvelope(plaintextMaybeHandshake);
        return;
      }

      this.emit({ type: 'error', message: 'Unexpected pre-handshake relay payload' });
      return;
    }

    const keys = this.sessionKeys;
    if (!keys) {
      this.emit({ type: 'error', message: 'Received encrypted payload before handshake completion' });
      return;
    }

    const opened = await this.crypto.openFrame(encryptedBytes, keys.receiveKey);
    if (!opened) {
      this.emit({ type: 'error', message: 'Failed to decrypt frame payload' });
      return;
    }

    if (opened.streamId > (this.crypto.controlStreamId ?? DEFAULT_CONTROL_STREAM_ID)) {
      const pane = this.findPaneByStreamId(opened.streamId);
      pane?.pushPtyData(opened.data);
      if (pane?.paneId === DEFAULT_PANE_ID && !pane.hasOutputHandler()) {
        this.emitPtyData(opened.data);
      }
      return;
    }

    const decodedText = new TextDecoder().decode(opened.data);
    const parsedMessage = safeJsonParse(decodedText);

    const machineMessage = toMachineMessage(parsedMessage);
    if (machineMessage) {
      await this.handleMachineMessage(machineMessage);
      return;
    }

    if (isSessionEventMessage(parsedMessage)) {
      this.handleSessionEvent(parsedMessage);
      return;
    }

    if (this.attachLifecycle.isTransportActive) {
      this.emitPtyData(opened.data);
    }
  }

  private handleHandshakeEnvelope(envelope: HandshakeEnvelope): void {
    const state = this.handshakeState;
    if (!state) {
      this.emit({ type: 'status', status: 'error', error: 'Missing handshake state' });
      this.rejectConnect(new Error('Missing handshake state'));
      return;
    }

    if (envelope.phase === 'server_hello') {
      if (!this.handshake.isServerHello(envelope.data)) {
        this.emit({ type: 'status', status: 'error', error: 'Invalid server_hello payload' });
        this.rejectConnect(new Error('Invalid server_hello payload'));
        return;
      }

      const nextState = this.handshake.processServerHello(state, envelope.data);
      if (!nextState) {
        this.emit({ type: 'status', status: 'error', error: 'Failed to process server_hello' });
        this.rejectConnect(new Error('Failed to process server_hello'));
        return;
      }

      this.handshakeState = nextState;

      const authorization: AuthorizationPayload = { type: 'access_list' };

      const auth = this.handshake.createClientAuth(
        nextState,
        this.identity,
        authorization,
        this.deviceCertificate,
      );
      this.handshakeState = auth.state;
      this.sessionKeys = auth.sessionKeys;

      const envelopeOut: HandshakeEnvelope = {
        type: 'handshake',
        phase: 'client_auth',
        data: auth.message,
      };
      this.socketAdapter.send(this.socket, JSON.stringify(envelopeOut));
      return;
    }

    if (envelope.phase === 'server_auth') {
      if (!this.handshake.isServerAuth(envelope.data)) {
        this.emit({ type: 'status', status: 'error', error: 'Invalid server_auth payload' });
        this.rejectConnect(new Error('Invalid server_auth payload'));
        return;
      }

      const keys = this.sessionKeys;
      if (!keys) {
        this.emit({ type: 'status', status: 'error', error: 'Missing session keys' });
        this.rejectConnect(new Error('Missing session keys'));
        return;
      }

      const result = this.handshake.processServerAuth(state, envelope.data, keys);
      if (!result) {
        this.emit({ type: 'status', status: 'error', error: 'Handshake rejected' });
        this.rejectConnect(new Error('Handshake rejected'));
        return;
      }

      this.isConnected = true;
      this.handshakeState = null;
      this.emit({ type: 'status', status: 'connected' });
      this.resolveConnect();
    }
  }

  private async handleMachineMessage(message: MachineToClientMessage): Promise<void> {
    switch (message.type) {
      case 'replay_list':
        this.emit({ type: 'replays', replays: message.replays });
        return;
      case 'replay_frame':
        this.resolveReplayFrame(message);
        return;
      case 'replay_timeline':
        this.resolveReplayTimeline(message);
        return;
      case 'replay_dismissed':
        this.resolveDismissReplay(message);
        return;
      case 'replay_undismissed':
        this.resolveUndismissReplay(message);
        return;
      case 'detached': {
        const pane = this.findPaneByStreamId(message.streamId);
        if (pane) {
          this.panes.delete(pane.paneId);
          this.emit({ type: 'pane_detached', paneId: pane.paneId });
          if (pane.paneId === DEFAULT_PANE_ID) {
            this.attachLifecycle.clearAttachment({ emitDetached: true });
            this.resolvePendingDetachTransition();
          }
        }
        return;
      }
      case 'session_exited': {
        const pane = this.findPaneByStreamId(message.streamId);
        if (pane) {
          this.panes.delete(pane.paneId);
          this.emit({ type: 'pane_exited', paneId: pane.paneId, sessionId: message.sessionId, exitCode: message.exitCode });
          if (pane.paneId === DEFAULT_PANE_ID) {
            this.attachLifecycle.emitExited(message.exitCode, message.sessionId);
            this.resolvePendingDetachTransition();
          }
        }
        return;
      }
      case 'workspace_deleted':
        this.resolveWorkspaceDelete(message.workspaceId, message.requestId);
        return;
      case 'operation_accepted':
        this.resolveOperationAccepted(message as OperationAcceptedResponse);
        return;
      case 'operation_snapshot':
        this.handleOperationSnapshot(message as OperationSnapshotResponse);
        return;
      case 'operation_event':
        this.handleOperationEvent(message as OperationEventResponse);
        return;
      case 'operation_dismissed':
        this.handleOperationDismissed(message as OperationDismissedResponse);
        return;
      case 'script_output':
        this.handleScriptOutput(message);
        return;
      case 'agent_state_snapshot':
        this.handleAgentStateSnapshot(message as unknown as AgentStateSnapshotPush);
        return;
      case 'agent_state_update':
        this.handleAgentStateUpdate(message as unknown as AgentStateUpdatePush);
        return;
      case 'refresh_machine_snapshot':
        this.resolveRefreshMachineSnapshot(message as RefreshMachineSnapshotResponse);
        return;
      case 'machine_snapshot':
        this.machineStateClient.replaceSnapshot(message.snapshot);
        if (Object.keys(this.agentStateCache).length === 0) {
          this.agentStateCache = machineSnapshotToAgentState(message.snapshot);
        }
        this.syncAgentStateCacheIntoMachineSnapshot();
        this.emitDerivedMachineState();
        this.resolveInitialSnapshot();
        for (const pane of [...this.panes.values()]) {
          if (pane.sessionId && !(pane.sessionId in message.snapshot.terminalSessionsById)) {
            this.panes.delete(pane.paneId);
            this.emit({ type: 'pane_exited', paneId: pane.paneId, sessionId: pane.sessionId });
            if (pane.paneId === DEFAULT_PANE_ID) {
              this.attachLifecycle.emitExited(undefined, pane.sessionId);
              this.attachedAgentSessionId = null;
            }
          }
        }
        return;
      case 'command_response':
        this.resolveTypedCommand(message as CommandResponse);
        return;
      case 'run_space_command_response':
        this.resolveRunSpaceCommandResponse(message as RunSpaceCommandResponse);
        return;
      case 'error':
        if (message.requestId) {
          this.rejectPendingTypedCommand(message.requestId, message.message);
          this.rejectPendingOperationStart(message.requestId, message.message, message.code);
        }
        this.rejectPendingReplayFrame(message.message, { requestId: message.requestId, force: !message.requestId });
        this.rejectPendingReplayTimeline(message.message, undefined, true);
        this.rejectPendingDismissReplay(message.message, undefined, true);
        this.rejectPendingUndismissReplay(message.message, undefined, true);
        if (message.workspaceId) {
          this.rejectPendingWorkspaceDelete(message.code, message.message, message.workspaceId, message.requestId);
        }
        this.emit({
          type: 'command_error',
          code: message.code,
          message: message.message,
        });
        return;
      case 'agent_dialog_request':
        this.emit({ type: 'host_ui_dialog_request', request: message.request });
        return;
      case 'agent_ui_event':
        this.emit({ type: 'host_ui_event', event: message.event });
        return;
      default:
        return;
    }
  }

  private handleScriptOutput(message: ScriptOutputResponse): void {
    const data = message.data ? this.crypto.decodeBase64(message.data) : new Uint8Array(0);
    if (data.length > 0) {
      this.attachLifecycle.pushScriptData(data);
    }

    const inferredWorkspaceId = message.workspaceId
      ?? (message.phase === 'remove' ? this.pendingDeleteWorkspace?.workspaceId : undefined)
      ?? this.attachLifecycle.workspaceId
      ?? undefined;

    this.emit({
      type: 'script_output',
      phase: message.phase,
      data,
      done: message.done,
      error: message.error,
      exitCode: message.exitCode,
      workspaceId: inferredWorkspaceId,
    });
  }

  private resolveReplayFrame(message: ReplayFrameResponse): void {
    const totalChunks = message.totalChunks ?? 1;
    const chunkIndex = message.chunkIndex ?? 0;
    if (totalChunks > 1) {
      this.prunePendingReplayFrameChunks();
      const pendingChunk = this.pendingReplayFrameChunks.get(message.requestId) ?? {
        replayId: message.replayId,
        totalChunks,
        checkpoint: null,
        chunks: new Map<number, import('../backend.js').ReplayFrame['events']>(),
        receivedAtMs: Date.now(),
      };
      pendingChunk.replayId = message.replayId;
      pendingChunk.totalChunks = totalChunks;
      pendingChunk.receivedAtMs = Date.now();
      if (message.frame.checkpoint) {
        pendingChunk.checkpoint = message.frame.checkpoint;
      }
      pendingChunk.chunks.set(chunkIndex, message.frame.events);
      this.pendingReplayFrameChunks.set(message.requestId, pendingChunk);

      if (pendingChunk.chunks.size < pendingChunk.totalChunks) {
        return;
      }

      const mergedEvents: import('../backend.js').ReplayFrame['events'] = [];
      for (let idx = 0; idx < pendingChunk.totalChunks; idx += 1) {
        const chunk = pendingChunk.chunks.get(idx);
        if (!chunk) {
          return;
        }
        mergedEvents.push(...chunk);
      }
      this.pendingReplayFrameChunks.delete(message.requestId);
      message = {
        ...message,
        totalChunks: 1,
        chunkIndex: 0,
        frame: {
          replayId: message.replayId,
          checkpoint: pendingChunk.checkpoint,
          events: mergedEvents,
        },
      };
    }

    const pending = this.pendingReplayFrame;
    if (!pending || pending.requestId !== message.requestId) {
      // Stale response for a cancelled or superseded request — discard
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingReplayFrame = null;
    pending.resolve(message.frame);
  }

  private resolveReplayTimeline(message: ReplayTimelineResponse): void {
    const pending = this.pendingReplayTimeline;
    if (!pending || pending.replayId !== message.replayId) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingReplayTimeline = null;
    pending.resolve(message.timeline);
  }

  private rejectPendingReplayFrame(message: string, options?: { replayId?: string; requestId?: string; force?: boolean }): void {
    const pending = this.pendingReplayFrame;
    if (!pending) {
      return;
    }
    const force = options?.force ?? false;
    if (!force) {
      // If requestId is provided, match on that (most precise)
      if (options?.requestId && pending.requestId !== options.requestId) {
        return;
      }
      // Otherwise fall back to replayId match
      if (!options?.requestId && options?.replayId && pending.replayId !== options.replayId) {
        return;
      }
    }
    clearTimeout(pending.timeout);
    this.pendingReplayFrame = null;
    pending.reject(new Error(message));
  }

  private rejectPendingReplayTimeline(message: string, replayId?: string, force = false): void {
    const pending = this.pendingReplayTimeline;
    if (!pending) {
      return;
    }
    if (!force && replayId && pending.replayId !== replayId) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingReplayTimeline = null;
    pending.reject(new Error(message));
  }

  private resolveDismissReplay(message: ReplayDismissedResponse): void {
    const pending = this.pendingDismissReplay;
    if (!pending || pending.replayId !== message.replayId) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingDismissReplay = null;
    pending.resolve();
  }

  private rejectPendingDismissReplay(message: string, replayId?: string, force = false): void {
    const pending = this.pendingDismissReplay;
    if (!pending) {
      return;
    }
    if (!force && replayId && pending.replayId !== replayId) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingDismissReplay = null;
    pending.reject(new Error(message));
  }

  private resolveUndismissReplay(message: ReplayUndismissedResponse): void {
    const pending = this.pendingUndismissReplay;
    if (!pending || pending.replayId !== message.replayId) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingUndismissReplay = null;
    pending.resolve();
  }

  private rejectPendingUndismissReplay(message: string, replayId?: string, force = false): void {
    const pending = this.pendingUndismissReplay;
    if (!pending) {
      return;
    }
    if (!force && replayId && pending.replayId !== replayId) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingUndismissReplay = null;
    pending.reject(new Error(message));
  }

  private prunePendingReplayFrameChunks(nowMs = Date.now()): void {
    const ttlMs = 30_000;
    for (const [requestId, pending] of this.pendingReplayFrameChunks) {
      if (nowMs - pending.receivedAtMs > ttlMs) {
        this.pendingReplayFrameChunks.delete(requestId);
      }
    }
  }

  private findPaneByStreamId(streamId: number): PaneLifecycle | null {
    for (const pane of this.panes.values()) {
      if (pane.streamId === streamId) return pane;
    }
    return null;
  }

  private handleSessionEvent(message: SessionEventMessage): void {
    const pane = this.findPaneByStreamId(message.streamId);

    if (message.type === 'kicked') {
      if (pane) {
        this.panes.delete(pane.paneId);
        this.emit({ type: 'pane_detached', paneId: pane.paneId });
        if (pane.paneId === DEFAULT_PANE_ID) {
          this.attachLifecycle.clearAttachment({ emitDetached: true });
          this.resolvePendingDetachTransition();
        }
      }
      return;
    }

    if (message.type === 'exited') {
      if (pane) {
        this.panes.delete(pane.paneId);
        this.emit({ type: 'pane_exited', paneId: pane.paneId, sessionId: message.sessionId ?? pane.sessionId ?? '', exitCode: message.code });
        if (pane.paneId === DEFAULT_PANE_ID) {
          this.attachLifecycle.emitExited(message.code, message.sessionId);
          this.resolvePendingDetachTransition();
        }
      }
      return;
    }

    if (message.type === 'attached' && message.sessionId && pane) {
      pane.confirmAttached({
        sessionId: message.sessionId,
        sessionName: message.sessionName,
        workspaceId: pane.workspaceId,
        agentSessionId: pane.agentSessionId,
        viewOnly: pane.viewOnly,
      });
      this.emit({
        type: 'pane_attached',
        paneId: pane.paneId,
        streamId: pane.streamId,
        sessionId: message.sessionId,
        sessionName: message.sessionName,
        workspaceId: pane.workspaceId ?? undefined,
        agentSessionId: pane.agentSessionId ?? undefined,
        viewOnly: pane.viewOnly,
      });
      if (pane.paneId === DEFAULT_PANE_ID) {
        this.attachLifecycle.confirmAttached({
          sessionId: message.sessionId,
          sessionName: message.sessionName,
          workspaceId: this.attachLifecycle.workspaceId,
          viewOnly: this.attachLifecycle.currentViewOnly,
        });
      }
      return;
    }

    if (message.type === 'session-meta' && pane) {
      const meta = {
        sessionName: message.sessionName ?? null,
        processTitle: message.processTitle ?? null,
        terminalTitle: message.terminalTitle ?? null,
        lastAlertKind: message.lastAlertKind ?? null,
        lastAlertPreview: message.lastAlertPreview ?? null,
        lastAlertAt: message.lastAlertAt ?? null,
        unreadAlertCount: message.unreadAlertCount ?? null,
      };
      pane.setMeta(meta);
      this.emit({ type: 'pane_meta', paneId: pane.paneId, meta });
      if (pane.paneId === DEFAULT_PANE_ID) {
        this.attachLifecycle.emitSessionMeta(meta);
      }
    }
  }

  private resolveWorkspaceDelete(workspaceId: string, requestId?: string): void {
    const pending = this.pendingDeleteWorkspace;
    if (!pending) {
      return;
    }

    if (requestId && pending.requestId !== requestId) {
      return;
    }

    if (!workspaceIdsMatch(pending.workspaceId, workspaceId)) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingDeleteWorkspace = null;
    pending.resolve();
  }

  private rejectPendingWorkspaceDelete(
    code: string | undefined,
    message: string,
    workspaceId?: string,
    requestId?: string,
    force = false
  ): void {
    const pending = this.pendingDeleteWorkspace;
    if (!pending) {
      return;
    }

    if (!force && requestId && pending.requestId !== requestId) {
      return;
    }

    if (!force && workspaceId && !workspaceIdsMatch(pending.workspaceId, workspaceId)) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingDeleteWorkspace = null;
    pending.reject(new WorkspaceDeleteError(message, toWorkspaceDeleteErrorCode(code)));
  }

  private emitPtyData(data: Uint8Array): void {
    this.attachLifecycle.pushPtyData(data);
  }

  private async sendCommand(message: ClientToMachineMessage | RemoteSessionControl): Promise<void> {
    this.assertConnected();

    const keys = this.sessionKeys;
    if (!keys) {
      throw new Error('Session keys are not established');
    }

    const streamId = this.crypto.controlStreamId ?? DEFAULT_CONTROL_STREAM_ID;
    const payload = new TextEncoder().encode(JSON.stringify(message));
    const frame = await this.crypto.createFrame(streamId, payload, keys.sendKey);
    const encoded = this.crypto.encodeBase64(frame);
    const relayMessage: RelayDataMessage = { type: 'data', data: encoded, priority: 'control' };
    this.socketAdapter.send(this.socket, JSON.stringify(relayMessage));
  }

  private assertConnected(): void {
    if (!this.isSocketOpen()) {
      throw new Error('Socket is not connected');
    }
  }

  private isSocketOpen(): boolean {
    return (
      this.socketAdapter.getReadyState(this.socket) ===
      this.socketAdapter.getOpenReadyStateValue()
    );
  }

  private emit(event: BackendEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private emitDerivedMachineState(): void {
    const snapshot = this.machineStateClient.getSnapshot();
    this.emit({ type: 'machine_snapshot', snapshot });
    this.emit({ type: 'projects', projects: machineSnapshotToProjects(snapshot) });
    this.emit({ type: 'workspaces', workspaces: machineSnapshotToWorkspaces(snapshot) });
    this.emit({ type: 'sessions', sessions: machineSnapshotToSessions(snapshot) });
  }

  private applyOptimisticAgentState(agentSessionId: string, patch: Partial<MachineAgentSessionRecord>): void {
    const snapshot = this.machineStateClient.getSnapshot();
    const agent = snapshot.agentSessionsById[agentSessionId];
    if (!agent) return;
    this.applyOptimisticAgentStateCache(agent, patch);
    this.machineStateClient.applyEvent({
      type: 'agent-session-upserted',
      snapshotNonce: snapshot.snapshotNonce,
      session: { ...agent, ...patch },
    });
    this.emitDerivedMachineState();
  }

  private applyOptimisticAgentStateCache(agent: MachineAgentSessionRecord, patch: Partial<MachineAgentSessionRecord>): void {
    const workspace = this.agentStateCache[agent.workspaceId];
    if (!workspace) return;
    const sessionIndex = workspace.sessions.findIndex((session) => session.id === agent.id);
    if (sessionIndex === -1) return;
    const session = workspace.sessions[sessionIndex]!;
    const nextSession = {
      ...session,
      closedAt: patch.closedAt !== undefined ? patch.closedAt : session.closedAt,
      archivedAt: patch.archivedAt !== undefined ? patch.archivedAt : session.archivedAt,
    };
    if (patch.state === 'closed' && !nextSession.closedAt) {
      nextSession.closedAt = new Date().toISOString();
    }
    if (patch.state === 'archived' && !nextSession.archivedAt) {
      nextSession.archivedAt = new Date().toISOString();
    }
    if (patch.state !== 'archived') {
      nextSession.archivedAt = undefined;
    }
    workspace.sessions = [
      ...workspace.sessions.slice(0, sessionIndex),
      nextSession,
      ...workspace.sessions.slice(sessionIndex + 1),
    ];
    if (patch.state === 'closed' || patch.state === 'archived') {
      delete workspace.statuses[agent.id];
      delete workspace.pendingPermissions[agent.id];
      delete workspace.pendingQuestions[agent.id];
      delete workspace.lastMessages[agent.id];
      delete workspace.errorMessages[agent.id];
      delete workspace.todoPhases[agent.id];
      delete workspace.modelInfo[agent.id];
      delete workspace.queuedMessages[agent.id];
    }
  }

  private async sendRpcCommand(request: ClientToMachineMessage & { requestId: string }): Promise<TypedCommandResponse> {
    if (OPERATION_COMMAND_TYPES.has(request.type)) {
      throw new Error(`Command ${request.type} must use startOperation(), not sendRpcCommand()`);
    }
    const requestId = request.requestId;
    const startedAtMs = Date.now();
    return new Promise<TypedCommandResponse>((resolve, reject) => {
      writeTraceLog('remote-command-send', {
        requestId,
        commandType: request.type,
        pendingCount: this.pendingTypedCommands.size,
      });
      const timeout = setTimeout(() => {
        const pending = this.pendingTypedCommands.get(requestId);
        if (!pending) return;
        this.pendingTypedCommands.delete(requestId);
        writeTraceLog('remote-command-timeout', {
          requestId,
          commandType: request.type,
          durationMs: Date.now() - pending.startedAtMs,
          pendingCount: this.pendingTypedCommands.size,
        });
        reject(new Error(`Timed out waiting for command response (${request.type})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);
      this.pendingTypedCommands.set(requestId, { resolve, reject, timeout, startedAtMs });
      void this.sendCommand(request).catch((error) => {
        const pending = this.pendingTypedCommands.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        writeTraceLog('remote-command-send-error', {
          requestId,
          commandType: request.type,
          durationMs: Date.now() - pending.startedAtMs,
          error: error instanceof Error ? error.message : String(error),
        });
        this.pendingTypedCommands.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }


  private async startOperationCommand(request: ClientToMachineMessage & { requestId: string }): Promise<RemoteOperationRecord> {
    const requestId = request.requestId;
    if (!OPERATION_COMMAND_TYPES.has(request.type)) {
      throw new Error(`Command ${request.type} must use sendRpcCommand(), not startOperation()`);
    }
    const startedAtMs = Date.now();
    return new Promise<RemoteOperationRecord>((resolve, reject) => {
      writeTraceLog('remote-operation-send', {
        requestId,
        commandType: request.type,
        pendingCount: this.pendingOperationStarts.size,
      });
      const timeout = setTimeout(() => {
        const pending = this.pendingOperationStarts.get(requestId);
        if (!pending) return;
        this.pendingOperationStarts.delete(requestId);
        reject(new Error(`Timed out waiting for operation acceptance (${request.type})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);
      this.pendingOperationStarts.set(requestId, { resolve, reject, timeout, startedAtMs });
      void this.sendCommand(request).catch((error) => {
        const pending = this.pendingOperationStarts.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingOperationStarts.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private resolveTypedCommand(message: CommandResponse): void {
    const pending = this.pendingTypedCommands.get(message.requestId);
    if (!pending) return;
    writeTraceLog('remote-command-resolve', {
      requestId: message.requestId,
      responseType: message.response.type,
      durationMs: Date.now() - pending.startedAtMs,
      pendingCount: this.pendingTypedCommands.size,
    });
    clearTimeout(pending.timeout);
    this.pendingTypedCommands.delete(message.requestId);
    pending.resolve(message.response);
  }

  private resolveOperationAccepted(message: OperationAcceptedResponse): void {
    this.operations.set(message.operation.operationId, message.operation);
    this.emit({ type: 'operation_event', event: { type: 'operation_started', operation: message.operation } });
    const pending = this.pendingOperationStarts.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingOperationStarts.delete(message.requestId);
    pending.resolve(message.operation);
  }

  private rejectPendingOperationStart(requestId: string, message: string, code?: string): void {
    const pending = this.pendingOperationStarts.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingOperationStarts.delete(requestId);
    const error = new Error(message);
    if (code) (error as Error & { code?: string }).code = code;
    pending.reject(error);
  }

  private handleOperationSnapshot(message: OperationSnapshotResponse): void {
    this.operations = new Map(message.operations.map((operation) => [operation.operationId, operation]));
    this.emit({ type: 'operation_snapshot', operations: message.operations });
    for (const operation of message.operations) {
      this.settleOperationCompletion(operation);
    }
  }

  private handleOperationEvent(message: OperationEventResponse): void {
    const operation = message.event.operation;
    this.operations.set(operation.operationId, operation);
    this.emit({ type: 'operation_event', event: message.event });
    this.settleOperationCompletion(operation);
  }

  private handleOperationDismissed(message: OperationDismissedResponse): void {
    this.operations.delete(message.operationId);
    this.emit({ type: 'operation_dismissed', operationId: message.operationId });
  }

  private settleOperationCompletion(operation: RemoteOperationRecord): void {
    if (operation.state === 'running') return;
    const pending = this.pendingOperationCompletions.get(operation.operationId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingOperationCompletions.delete(operation.operationId);
    if (operation.state === 'succeeded') {
      pending.resolve(operation);
      return;
    }
    const error = new Error(operation.error?.message ?? operation.message ?? `Operation ${operation.state}`);
    if (operation.error?.code) (error as Error & { code?: string }).code = operation.error.code;
    pending.reject(error);
  }

  private waitForOperation(operationId: string): Promise<RemoteOperationRecord> {
    const current = this.operations.get(operationId);
    if (current && current.state !== 'running') {
      return current.state === 'succeeded'
        ? Promise.resolve(current)
        : Promise.reject(Object.assign(new Error(current.error?.message ?? current.message ?? `Operation ${current.state}`), current.error?.code ? { code: current.error.code } : {}));
    }
    return new Promise<RemoteOperationRecord>((resolve, reject) => {
      const operation = this.operations.get(operationId);
      const timeout = setTimeout(() => {
        const pending = this.pendingOperationCompletions.get(operationId);
        if (!pending) return;
        this.pendingOperationCompletions.delete(operationId);
        pending.reject(new Error(`Timed out waiting for operation completion (${operationId})`));
      }, operationCompletionTimeoutMs(operation));
      this.pendingOperationCompletions.set(operationId, { resolve, reject, timeout });
    });
  }


  private resolveRefreshMachineSnapshot(message: RefreshMachineSnapshotResponse): void {
    const pending = this.pendingTypedCommands.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingTypedCommands.delete(message.requestId);
    pending.resolve(message);
  }
  private resolveRunSpaceCommandResponse(message: RunSpaceCommandResponse): void {
    const pending = this.pendingTypedCommands.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingTypedCommands.delete(message.requestId);
    pending.resolve(message);
  }

  private rejectPendingTypedCommand(requestId: string, message: string): void {
    const pending = this.pendingTypedCommands.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingTypedCommands.delete(requestId);
    pending.reject(new Error(message));
  }

  private getAgentWorkspaceTarget(workspaceId: string): import('../../lib/tmux-lite/protocol.js').AgentWorkspaceTargetPayload {
    const snapshot = this.machineStateClient.getSnapshot();
    const workspace = Object.entries(snapshot.workspacesById).find(([key, item]) => item && (workspaceIdsMatch(key, workspaceId) || workspaceIdsMatch(item.id, workspaceId)))?.[1];
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      projectName: workspace.projectName,
    };
  }

  private resolveConnect(): void {
    if (this.connectResolve) {
      this.connectResolve();
    }
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
  }

  private rejectConnect(error: Error): void {
    this.listenersAttached = false;
    if (this.connectReject) {
      this.connectReject(error);
    }
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
  }

  private resetState(): void {
    this.listenersAttached = false;
    this.isConnected = false;
    this.attachLifecycle.reset();
    this.panes.clear();
    this.nextStreamId = DEFAULT_PANE_STREAM_ID + 1;
    this.rejectPendingDetachTransition(new Error('Remote session disconnected'));
    this.handshakeState = null;
    this.sessionKeys = null;
    this.attachedAgentSessionId = null;
    this.pendingAttachedAgentSession = null;
    this.pendingReplayFrameChunks.clear();
    this.rejectPendingReplayFrame('Remote session disconnected', { force: true });
    this.rejectPendingReplayTimeline('Remote session disconnected', undefined, true);
    this.rejectPendingDismissReplay('Remote session disconnected', undefined, true);
    this.rejectPendingUndismissReplay('Remote session disconnected', undefined, true);
    this.rejectPendingWorkspaceDelete('DELETE_FAILED', 'Remote session disconnected', undefined, undefined, true);
    for (const pending of this.pendingTypedCommands.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Remote session disconnected'));
    }
    this.pendingTypedCommands.clear();
    for (const pending of this.pendingOperationStarts.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Remote session disconnected'));
    }
    this.pendingOperationStarts.clear();
    for (const pending of this.pendingOperationCompletions.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Remote session disconnected'));
    }
    this.pendingOperationCompletions.clear();
    this.rejectInitialSnapshot(new Error('Remote session disconnected'));
    this.machineStateClient.replaceSnapshot(createEmptyMachineSnapshot());
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.initialSnapshotPromise = null;
    this.initialSnapshotResolve = null;
    this.initialSnapshotReject = null;
    this.initialSnapshotReceived = false;
  }

  private resolvePendingDetachTransition(): void {
    const pending = this.pendingDetachTransition;
    if (!pending) {
      return;
    }
    pending.resolve();
  }

  private rejectPendingDetachTransition(error: Error): void {
    const pending = this.pendingDetachTransition;
    if (!pending) {
      return;
    }
    pending.reject(error);
  }


  private resolveInitialSnapshot(): void {
    if (this.initialSnapshotReceived) {
      return;
    }
    this.initialSnapshotReceived = true;
    this.initialSnapshotResolve?.();
    this.initialSnapshotResolve = null;
    this.initialSnapshotReject = null;
  }

  private async waitForInitialSnapshot(): Promise<void> {
    if (this.initialSnapshotReceived || !this.initialSnapshotPromise) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.initialSnapshotPromise,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for initial machine snapshot from ${this.machineId}`));
          }, DEFAULT_INITIAL_SNAPSHOT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private rejectInitialSnapshot(error: Error): void {
    if (this.initialSnapshotReceived) {
      return;
    }
    this.initialSnapshotReject?.(error);
    this.initialSnapshotResolve = null;
    this.initialSnapshotReject = null;
  }

  // ============================================================================
  // Agent state — backed by machine-pushed messages
  // ============================================================================

  private agentStateCache: Record<string, WorkspaceAgentState> = {};
  private agentStateHandlers = new Set<(delta: AgentStateUpdateDelta) => void>();

  private toMachineAgentSessionRecord(workspace: WorkspaceAgentState, sessionId: string): MachineAgentSessionRecord | null {
    const snapshot = this.machineStateClient.getSnapshot();
    const workspaceRecord = snapshot.workspacesById[workspace.workspaceId];
    const session = workspace.sessions.find((item) => item.id === sessionId);
    if (!workspaceRecord || !session) {
      return null;
    }

    const pendingPermissionIds = (workspace.pendingPermissions[sessionId] ?? []).map((permission) => permission.id);
    const pendingQuestionIds = (workspace.pendingQuestions[sessionId] ?? []).map((question) => question.id);
    const status = workspace.statuses[sessionId];
    const errorMessage = workspace.errorMessages[sessionId]
      ?? (status?.type === 'retry' ? status.message : undefined);
    const state: MachineAgentSessionRecord['state'] = session.archivedAt
      ? 'archived'
      : session.closedAt
        ? 'closed'
        : pendingPermissionIds.length > 0 || pendingQuestionIds.length > 0
          ? 'permission-needed'
          : status?.type === 'retry' || errorMessage
            ? 'retrying'
            : status?.type === 'busy'
              ? 'running'
              : 'waiting';

    return {
      id: session.id,
      workspaceId: workspace.workspaceId,
      projectId: workspaceRecord.projectId,
      title: session.title,
      state,
      updatedAt: session.updatedAt,
      closedAt: session.closedAt,
      archivedAt: session.archivedAt,
      pendingPermissionIds,
      pendingPermissionCount: pendingPermissionIds.length,
      pendingQuestionIds,
      pendingQuestionCount: pendingQuestionIds.length,
      errorMessage,
      lastMessagePreview: workspace.lastMessages[sessionId],
      modelInfo: workspace.modelInfo[sessionId],
      todoPhases: workspace.todoPhases[sessionId],
      queuedMessages: workspace.queuedMessages[sessionId],
    };
  }

  private refreshWorkspaceAgentSummary(workspaceId: string): boolean {
    const snapshot = this.machineStateClient.getSnapshot();
    const workspace = snapshot.workspacesById[workspaceId];
    if (!workspace) return false;
    const agentIds = snapshot.agentSessionIdsByWorkspaceId[workspaceId] ?? [];
    const agents = agentIds
      .map((id) => snapshot.agentSessionsById[id])
      .filter((agent): agent is MachineAgentSessionRecord => Boolean(agent));
    const nextSummary = {
      ...workspace.summary,
      agentCount: agents.length,
      runningAgentCount: agents.filter((agent) => agent.state === 'running').length,
      waitingAgentCount: agents.filter((agent) => agent.state === 'waiting').length,
      permissionAgentCount: agents.filter((agent) => agent.state === 'permission-needed').length,
      retryingAgentCount: agents.filter((agent) => agent.state === 'retrying').length,
      closedAgentCount: agents.filter((agent) => agent.state === 'closed').length,
      archivedAgentCount: agents.filter((agent) => agent.state === 'archived').length,
    };
    const agentIdsChanged = workspace.agentSessionIds.length !== agentIds.length
      || workspace.agentSessionIds.some((id, index) => id !== agentIds[index]);
    const summaryChanged = workspace.summary.agentCount !== nextSummary.agentCount
      || workspace.summary.runningAgentCount !== nextSummary.runningAgentCount
      || workspace.summary.waitingAgentCount !== nextSummary.waitingAgentCount
      || workspace.summary.permissionAgentCount !== nextSummary.permissionAgentCount
      || workspace.summary.retryingAgentCount !== nextSummary.retryingAgentCount
      || workspace.summary.closedAgentCount !== nextSummary.closedAgentCount
      || workspace.summary.archivedAgentCount !== nextSummary.archivedAgentCount;
    if (!agentIdsChanged && !summaryChanged) return false;
    this.machineStateClient.applyEvent({
      type: 'workspace-upserted',
      snapshotNonce: snapshot.snapshotNonce,
      workspace: {
        ...workspace,
        agentSessionIds: agentIds,
        summary: nextSummary,
      },
    });
    return true;
  }


  private syncAgentWorkspaceIntoMachineSnapshot(workspace: WorkspaceAgentState): boolean {
    const snapshot = this.machineStateClient.getSnapshot();
    if (!snapshot.workspacesById[workspace.workspaceId]) {
      return false;
    }

    let changed = false;
    const nextIds = new Set(workspace.sessions.map((session) => session.id));
    for (const existingId of snapshot.agentSessionIdsByWorkspaceId[workspace.workspaceId] ?? []) {
      const existing = snapshot.agentSessionsById[existingId];
      if (existing && existing.state !== 'archived' && !nextIds.has(existingId)) {
        this.machineStateClient.applyEvent({
          type: 'agent-session-removed',
          snapshotNonce: snapshot.snapshotNonce,
          sessionId: existingId,
          workspaceId: workspace.workspaceId,
        });
        changed = true;
      }
    }

    for (const session of workspace.sessions) {
      const record = this.toMachineAgentSessionRecord(workspace, session.id);
      if (!record) continue;
      this.machineStateClient.applyEvent({
        type: 'agent-session-upserted',
        snapshotNonce: snapshot.snapshotNonce,
        session: record,
      });
      changed = true;
    }

    changed = this.refreshWorkspaceAgentSummary(workspace.workspaceId) || changed;
    return changed;
  }

  private syncAgentStateCacheIntoMachineSnapshot(): void {
    let changed = false;
    for (const workspace of Object.values(this.agentStateCache)) {
      changed = this.syncAgentWorkspaceIntoMachineSnapshot(workspace) || changed;
    }
    if (changed) {
      this.emitDerivedMachineState();
    }
  }

  private handleAgentStateSnapshot(msg: AgentStateSnapshotPush): void {
    this.agentStateCache = {};
    for (const workspace of msg.workspaces) {
      this.agentStateCache[workspace.workspaceId] = workspace;
    }
    this.syncAgentStateCacheIntoMachineSnapshot();
    // Emit a snapshot delta so subscribers can refresh
    const snapshot: AgentStateUpdateDelta = {
      type: 'agent_state_snapshot',
      workspaces: this.agentStateCache,
    };
    for (const handler of this.agentStateHandlers) {
      try { handler(snapshot); } catch { /* non-fatal */ }
    }
  }

  private handleAgentStateUpdate(msg: AgentStateUpdatePush): void {
    const delta = msg.delta;
    this.agentStateCache = applyAgentDeltaToAgentState(this.agentStateCache, delta);
    this.syncAgentStateCacheIntoMachineSnapshot();
    for (const handler of this.agentStateHandlers) {
      try { handler(delta); } catch { /* non-fatal */ }
    }
  }

  subscribeAgentState(handler: (delta: AgentStateUpdateDelta) => void): () => void {
    this.agentStateHandlers.add(handler);
    return () => { this.agentStateHandlers.delete(handler); };
  }

  getAgentStateSnapshot(): Record<string, WorkspaceAgentState> {
    return this.agentStateCache;
  }

  async respondToAgentPermission(
    workspaceId: string,
    agentSessionId: string,
    permissionId: string,
    response: 'allow' | 'deny',
  ): Promise<boolean> {
    await this.waitForInitialSnapshot();
    const tmuxResponse = await this.sendRpcCommand({
      type: 'respond_agent_permission',
      requestId: crypto.randomUUID(),
      target: this.getAgentWorkspaceTarget(workspaceId),
      agentSessionId,
      permissionId,
      response,
    });
    if (tmuxResponse.type === 'agent-bool') return tmuxResponse.ok;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected agent permission response');
  }

  /** Read one page of an agent session's transcript as blocks (range-paginated). */
  async getAgentTranscriptRange(
    workspaceId: string,
    agentSessionId: string,
    before: string | undefined,
    limit: number,
  ): Promise<{ blocks: unknown[]; oldestCursor: string | null; hasMore: boolean }> {
    await this.waitForInitialSnapshot();
    const tmuxResponse = await this.sendRpcCommand({
      type: 'get_agent_transcript_range',
      requestId: crypto.randomUUID(),
      target: this.getAgentWorkspaceTarget(workspaceId),
      agentSessionId,
      before,
      limit,
    });
    if (tmuxResponse.type === 'agent-transcript-range') {
      return { blocks: tmuxResponse.blocks, oldestCursor: tmuxResponse.oldestCursor, hasMore: tmuxResponse.hasMore };
    }
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected agent transcript response');
  }

  // ============================================================================
  // Agent session preferences — stored locally on the client machine
  // Note: Preferences for remote machines are stored locally in the client,
  // not on the remote machine, since they're UI state, not workspace state.
  // ============================================================================

  private remoteAgentPrefsCache: Record<string, string> = {};

  async getAgentSessionPreference(workspaceId: string): Promise<string | null> {
    const cached = this.remoteAgentPrefsCache[workspaceId];
    if (cached) return cached;
    // Fall back to persistent storage (e.g. localStorage) so preferences
    // survive page reloads even though the in-memory cache is empty.
    try {
      const stored = this.storage?.getItem(`gssh:agent-session:${workspaceId}`) ?? null;
      if (stored) {
        this.remoteAgentPrefsCache[workspaceId] = stored;
        return stored;
      }
    } catch { /* storage unavailable */ }
    return null;
  }

  async setAgentSessionPreference(workspaceId: string, sessionId: string): Promise<void> {
    this.remoteAgentPrefsCache[workspaceId] = sessionId;
    // Best-effort: also persist to storage if available
    try {
      this.storage?.setItem(`gssh:agent-session:${workspaceId}`, sessionId);
    } catch (e) {
      console.warn('[remote-session-backend] Failed to persist agent session preference:', e);
    }
  }
}
