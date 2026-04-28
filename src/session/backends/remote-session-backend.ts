import type { Identity, SessionKeys } from '../../types/identity.js';
import {
  parseRemoteMessage,
  type AttachSessionRequest,
  type CancelPendingAttachRequest,
  type ClientToMachineMessage,
  type DeleteWorkspaceRequest,
  type GetReplayTimelineRequest,
  type ListReplaysRequest,
  type MachineToClientMessage,
  type ScriptOutputResponse,
  type ReplayFrameResponse,
  type ReplayTimelineResponse,
  type ReplayDismissedResponse,
  type ReplayUndismissedResponse,
  type SessionCtrl,
  type GetReplayFrameRequest,
  type DismissReplayRequest,
  type UndismissReplayRequest,
  type CommandResponse,
} from '../../lib/remote-session/protocol.js';
import type { BundleRefreshPlan, BundleRefreshSubmission } from '../../types/bundle-refresh.js';
import type { BundleConfigState, BundleConfigSubmission } from '../../types/bundle-config.js';
import type { ReviewOperation, ReviewResult } from '../../types/review.js';
import type { WideEventFilter } from '../../types/events.js';
import type { SessionLinearIssueSummary } from '../../types/lifecycle.js';
import { AttachLifecycle } from './attach-lifecycle.js';
import type { NotificationConfig } from '../../notifications/types.js';
import {
  ReviewRequestError,
  WorkspaceDeleteError,
  type WorkspaceDeleteErrorCode,
} from '../../types/errors.js';
import { throwServiceStartError } from './service-start-error.js';
import type {
  AttachSessionParams,
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
} from '../backend.js';
import type { BackendEvent } from '../events.js';
import type { AgentStateUpdateDelta, WorkspaceAgentState } from '../../lib/tmux-lite/agent-event-manager.js';
import type { AgentStateSnapshotPush, AgentStateUpdatePush } from '../../lib/remote-session/protocol.js';
import { MachineStateClient } from '../../machine/state/client.js';
import {
  machineSnapshotToAgentState,
  machineSnapshotToKnownAgentSessions,
  machineSnapshotToProjects,
  machineSnapshotToSessions,
  machineSnapshotToWorkspaces,
} from '../../machine/state/selectors.js';
import type { Response as TmuxResponse } from '../../lib/tmux-lite/protocol.js';
import { createEmptyMachineSnapshot } from '../../machine/state/client.js';
import type { MachineAgentSessionRecord } from '../../lib/tmux-lite/machine/types.js';

const DEFAULT_CONTROL_STREAM_ID = 1;
const DEFAULT_DELETE_WORKSPACE_TIMEOUT_MS = 30000;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 10000;

interface RelayDataMessage {
  type: 'data';
  data: string;
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

function toWorkspaceDeleteErrorCode(code: string | undefined): WorkspaceDeleteErrorCode {
  if (
    code === 'REMOVE_SCRIPT_FAILED' ||
    code === 'WORKSPACE_NOT_FOUND' ||
    code === 'WORKTREE_REMOVE_FAILED' ||
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
    resolve: (response: TmuxResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
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
    this.attachLifecycle.setOutputHandler(handler);
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

  async listGithubRepos(org?: string): Promise<string[]> {
    const response = await this.sendTypedCommand({ type: 'list_github_repos', requestId: crypto.randomUUID(), org });
    if (response.type === 'github-repos') return response.repos;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected GitHub repo response');
  }

  async listRemoteBranches(projectName: string): Promise<string[]> {
    const response = await this.sendTypedCommand({ type: 'list_remote_branches', requestId: crypto.randomUUID(), projectName });
    if (response.type === 'remote-branches') return response.branches;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected remote branches response');
  }

  async listLinearIssues(projectName: string): Promise<SessionLinearIssueSummary[]> {
    const response = await this.sendTypedCommand({ type: 'list_linear_issues', requestId: crypto.randomUUID(), projectName });
    if (response.type === 'linear-issues') return response.issues;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected linear issues response');
  }

  async listWorkspaces(): Promise<void> {
    await this.waitForInitialSnapshot();
    this.emit({ type: 'workspaces', workspaces: machineSnapshotToWorkspaces(this.machineStateClient.getSnapshot()) });
  }

  async setWorkspaceStatus(
    projectName: string,
    workspaceName: string,
    phase: import('../../types/config.js').WorkspacePhase
  ): Promise<void> {
    const response = await this.sendTypedCommand({ type: 'set_workspace_phase', requestId: crypto.randomUUID(), projectName, workspaceName, phase });
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

  async createProject(params: CreateProjectParams): Promise<void> {
    const response = await this.sendTypedCommand({ type: 'create_project', requestId: crypto.randomUUID(), ...params });
    if (response.type === 'project-created') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected project create response');
  }

  async prepareProjectCreation(params: CreateProjectParams): Promise<PreparedProjectResult> {
    const response = await this.sendTypedCommand({ type: 'prepare_project_creation', requestId: crypto.randomUUID(), ...params });
    if (response.type === 'project-prepared') return response.result;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected project prepare response');
  }

  async finalizeProjectCreation(params: FinalizeProjectParams): Promise<void> {
    const response = await this.sendTypedCommand({ type: 'finalize_project_creation', requestId: crypto.randomUUID(), ...params });
    if (response.type === 'project-created') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected project finalize response');
  }

  async cancelProjectCreation(projectName: string): Promise<void> {
    const response = await this.sendTypedCommand({ type: 'cancel_project_creation', requestId: crypto.randomUUID(), projectName });
    if (response.type === 'project-cancelled') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected project cancel response');
  }

  async createWorkspace(params: CreateWorkspaceParams): Promise<void> {
    const response = await this.sendTypedCommand({ type: 'create_workspace', requestId: crypto.randomUUID(), ...params });
    if (response.type === 'workspace-created') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected workspace create response');
  }

  async deleteProject(projectName: string, params: DeleteProjectParams = {}): Promise<void> {
    void params;
    const response = await this.sendTypedCommand({ type: 'delete_project', requestId: crypto.randomUUID(), projectName });
    if (response.type === 'project-deleted') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected project delete response');
  }

  async attachSession(params: AttachSessionParams): Promise<void> {
    if (this.attachLifecycle.isTransportActive) {
      // Switching sessions: tell the server to close the prior tmux-lite
      // socket but don't wait for the round-trip. The server's per-connection
      // queue serializes detach → attach_session, and the new 'attached' event
      // is what unblocks the client UI. Awaiting the detached event before
      // sending attach_session was pure wait theater — one extra RTT for no
      // observable benefit.
      this.rejectPendingDetachTransition(new Error('Superseded by new attach'));
      this.attachedAgentSessionId = null;
      this.pendingAttachedAgentSession = null;
      this.attachLifecycle.clearAttachment({ emitDetached: true });
      void this.sendCommand({ type: 'detach' }).catch((error) => {
        console.warn('[remote-session] fire-and-forget detach failed:', error);
      });
    }

    this.attachLifecycle.beginAttach({
      workspaceId: params.workspaceId ?? null,
      viewOnly: params.viewOnly ?? false,
    });
    const command: AttachSessionRequest = {
      type: 'attach_session',
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      sessionName: params.sessionName,
      // cols/rows are required on the wire so the server can send attach-init
      // immediately on socket open. Fall back to 80x24 if a caller didn't
      // pass them; the terminal will resize to its real viewport on mount.
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
    const response = await this.sendTypedCommand({ type: 'list_agent_sessions', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), mode: 'live' });
    if (response.type === 'agent-sessions') return response.sessions;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent sessions response');
  }

  async createAgentSession(workspaceId: string, title?: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    await this.waitForInitialSnapshot();
    const response = await this.sendTypedCommand({ type: 'create_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), title });
    if (response.type === 'agent-sessions') return response.sessions;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent create response');
  }

  async abortAgentSession(workspaceId: string, agentSessionId: string): Promise<boolean> {
    await this.waitForInitialSnapshot();
    const response = await this.sendTypedCommand({ type: 'abort_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), agentSessionId });
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
    const response = await this.sendTypedCommand({ type: 'interrupt_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), agentSessionId });
    if (response.type === 'agent-bool') return response.ok;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent interrupt response');
  }

  async closeAgentSession(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    await this.waitForInitialSnapshot();
    const response = await this.sendTypedCommand({ type: 'close_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), agentSessionId });
    if (response.type === 'agent-sessions') {
      this.applyOptimisticAgentState(agentSessionId, { state: 'closed', closedAt: new Date().toISOString() });
      return response.sessions;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent close response');
  }

  async archiveAgentSession(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    await this.waitForInitialSnapshot();
    const response = await this.sendTypedCommand({ type: 'archive_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), agentSessionId });
    if (response.type === 'agent-sessions') {
      this.applyOptimisticAgentState(agentSessionId, { state: 'archived', archivedAt: new Date().toISOString() });
      return response.sessions;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent archive response');
  }

  async restoreAgentSession(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    await this.waitForInitialSnapshot();
    const response = await this.sendTypedCommand({ type: 'restore_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), agentSessionId });
    if (response.type === 'agent-sessions') {
      this.applyOptimisticAgentState(agentSessionId, { state: 'closed', archivedAt: undefined });
      return response.sessions;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent restore response');
  }

  async attachAgentSession(workspaceId: string, agentSessionId: string, options: { viewOnly?: boolean; cols?: number; rows?: number } = {}): Promise<void> {
    await this.waitForInitialSnapshot();
    // attachSession() handles detaching from the prior tmux-lite session via
    // its own fire-and-forget detach path; no need for an extra round-trip here.
    const response = await this.sendTypedCommand({ type: 'attach_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), agentSessionId, cols: options.cols, rows: options.rows });
    if (response.type !== 'session') {
      if (response.type === 'error') throw new Error(response.message);
      throw new Error('Unexpected agent attach response');
    }
    this.pendingAttachedAgentSession = {
      agentSessionId,
      sessionId: response.session.id,
    };
    try {
      await this.attachSession({ sessionId: response.session.id, workspaceId, viewOnly: options.viewOnly, cols: options.cols, rows: options.rows });
    } catch (error) {
      this.pendingAttachedAgentSession = null;
      throw error;
    }
  }

  async promptAgentSession(workspaceId: string, agentSessionId: string, text: string, images?: import('../../lib/tmux-lite/protocol.js').AgentPromptImage[], options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
    await this.waitForInitialSnapshot();
    const response = await this.sendTypedCommand({ type: 'prompt_agent_session', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), agentSessionId, text, images, streamingBehavior: options?.streamingBehavior });
    if (response.type === 'ok') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error(`Unexpected prompt response: ${response.type}`);
  }

  async stageUpload(workspaceId: string, fileName: string, data: string, mimeType: string): Promise<{ stagedPath: string }> {
    await this.waitForInitialSnapshot();
    const response = await this.sendTypedCommand({ type: 'stage_agent_upload', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), fileName, data, mimeType });
    if (response.type === 'agent-staged') return { stagedPath: response.stagedPath };
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected stage upload response');
  }

  async sendDialogResponse(dialogId: string, dialogType: 'select' | 'confirm' | 'input' | 'editor', value: string | boolean | undefined): Promise<void> {
    const response = await this.sendTypedCommand({ type: 'respond_agent_dialog', requestId: crypto.randomUUID(), dialogId, dialogType, value });
    if (response.type === 'agent-bool') {
      if (response.ok) return;
      throw new Error(`Dialog is no longer pending: ${dialogId}`);
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected dialog response acknowledgement');
  }

  async listAgentCommands(workspaceId: string): Promise<Array<{ name: string; description: string; kind: 'file' | 'custom' | 'extension' }>> {
    await this.waitForInitialSnapshot();
    const response = await this.sendTypedCommand({ type: 'list_agent_commands', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId) });
    if (response.type === 'agent-commands') return response.commands;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected list commands response');
  }

  async getFileSuggestions(workspaceId: string, prefix: string, limit?: number): Promise<Array<{ path: string; isDirectory: boolean }>> {
    await this.waitForInitialSnapshot();
    const response = await this.sendTypedCommand({ type: 'get_agent_file_suggestions', requestId: crypto.randomUUID(), target: this.getAgentWorkspaceTarget(workspaceId), prefix, limit });
    if (response.type === 'agent-file-suggestions') return response.suggestions;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected file suggestions response');
  }

  async detachSession(): Promise<void> {
    if (!this.attachLifecycle.isTransportActive) {
      return;
    }

    // If we're still in the attaching phase (scripts running, no PTY socket yet),
    // just clear local state — there's nothing to detach on the machine side.
    if (this.attachLifecycle.isAttaching) {
      this.attachLifecycle.clearAttachment({ emitDetached: true });
      return;
    }
    if (this.pendingDetachTransition) {
      return new Promise<void>((resolve, reject) => {
        const pending = this.pendingDetachTransition;
        if (!pending) {
          resolve();
          return;
        }
        const currentResolve = pending.resolve;
        const currentReject = pending.reject;
        pending.resolve = () => { currentResolve(); resolve(); };
        pending.reject = (error: Error) => { currentReject(error); reject(error); };
      });
    }

    const waitForDetach = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingDetachTransition = null;
        this.attachLifecycle.clearAttachment({ emitDetached: true });
        this.attachedAgentSessionId = null;
        this.pendingAttachedAgentSession = null;
        reject(new Error('Timed out waiting for remote detach'));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);
      this.pendingDetachTransition = {
        resolve: () => {
          clearTimeout(timeout);
          this.pendingDetachTransition = null;
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          this.pendingDetachTransition = null;
          reject(error);
        },
        timeout,
      };
    });

    try {
      const ctrl: SessionCtrl = { type: 'detach' };
      await this.sendCommand(ctrl);
      await waitForDetach;
    } catch (error) {
      this.rejectPendingDetachTransition(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async cancelPendingScripts(): Promise<void> {
    const command: CancelPendingAttachRequest = { type: 'cancel_pending_attach' };
    await this.sendCommand(command);
  }

  async killSession(sessionId: string): Promise<void> {
    const response = await this.sendTypedCommand({ type: 'kill_session', requestId: crypto.randomUUID(), sessionId });
    if (response.type === 'ok') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected kill session response');
  }

  async deleteWorkspace(
    projectName: string,
    workspaceId: string,
    params: DeleteWorkspaceParams = {}
  ): Promise<void> {
    if (this.pendingDeleteWorkspace) {
      throw new Error('Workspace delete request already in progress');
    }

    const command: DeleteWorkspaceRequest = {
      type: 'delete_workspace',
      projectName,
      workspaceId,
      scriptPolicy: params.scriptPolicy,
    };
    const timeoutMs =
      typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_DELETE_WORKSPACE_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingDeleteWorkspace;
        if (!pending || !workspaceIdsMatch(pending.workspaceId, workspaceId)) {
          return;
        }

        this.pendingDeleteWorkspace = null;
        pending.reject(
          new WorkspaceDeleteError(
            `Timed out waiting for workspace deletion response (${workspaceId})`,
            'DELETE_TIMEOUT'
          )
        );
      }, timeoutMs);

      this.pendingDeleteWorkspace = {
        workspaceId,
        resolve,
        reject,
        timeout,
      };

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingDeleteWorkspace;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingDeleteWorkspace = null;
        const message = error instanceof Error ? error.message : String(error);
        pending.reject(new WorkspaceDeleteError(message, 'DELETE_FAILED'));
      });
    });
  }

  async getBundleRefreshPlan(projectName: string, workspaceId: string): Promise<BundleRefreshPlan> {
    const response = await this.sendTypedCommand({ type: 'get_bundle_refresh_plan', requestId: crypto.randomUUID(), projectName, workspaceId });
    if (response.type === 'bundle-refresh-plan') return response.plan;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected bundle refresh plan response');
  }

  async applyBundleRefresh(
    projectName: string,
    workspaceId: string,
    submission: BundleRefreshSubmission
  ): Promise<void> {
    const response = await this.sendTypedCommand({ type: 'apply_bundle_refresh', requestId: crypto.randomUUID(), projectName, workspaceId, submission });
    if (response.type === 'bundle-refresh-applied') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected bundle refresh apply response');
  }

  async getBundleConfigState(projectName: string, workspaceId: string): Promise<BundleConfigState> {
    const response = await this.sendTypedCommand({ type: 'get_bundle_config_state', requestId: crypto.randomUUID(), projectName, workspaceId });
    if (response.type === 'bundle-config-state') return response.state;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected bundle config state response');
  }

  async applyBundleConfigUpdate(
    projectName: string,
    workspaceId: string,
    submission: BundleConfigSubmission
  ): Promise<void> {
    const response = await this.sendTypedCommand({ type: 'apply_bundle_config', requestId: crypto.randomUUID(), projectName, workspaceId, submission });
    if (response.type === 'bundle-config-applied') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected bundle config apply response');
  }

  async requestInbox(): Promise<void> {
    await this.waitForInitialSnapshot();
    const response = await this.sendTypedCommand({ type: 'get_inbox', requestId: crypto.randomUUID() });
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
    const response = await this.sendTypedCommand({ type: 'clear_inbox', requestId: crypto.randomUUID(), id });
    if (response.type === 'ok') {
      await this.requestInbox();
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected clear inbox response');
  }

  async markInboxRead(id: string): Promise<void> {
    const response = await this.sendTypedCommand({ type: 'mark_inbox_read', requestId: crypto.randomUUID(), id });
    if (response.type === 'ok') {
      await this.requestInbox();
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected mark inbox read response');
  }

  async getNotificationConfig(): Promise<void> {
    const response = await this.sendTypedCommand({ type: 'get_notification_config', requestId: crypto.randomUUID() });
    if (response.type === 'notification-config') {
      this.emit({ type: 'notification_config', config: response.config });
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected notification config response');
  }

  async updateNotificationConfig(config: NotificationConfig): Promise<void> {
    const response = await this.sendTypedCommand({ type: 'update_notification_config', requestId: crypto.randomUUID(), config });
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
    const response = await this.sendTypedCommand({ type: 'request_review', requestId, operation });
    console.debug('[review-debug] remote backend sendReviewRequest response', {
      op: operation.op,
      requestId,
      responseType: response.type,
      reviewRequestId: response.type === 'review-response' ? response.requestId : undefined,
    });
    if (response.type === 'review-response') {
      if (response.error) {
        throw new ReviewRequestError(response.error.message, response.error.code, { op: operation.op, requestId: response.requestId });
      }
      if (!response.result) {
        throw new ReviewRequestError('Review response missing result', 'REVIEW_MISSING_RESULT', { op: operation.op, requestId: response.requestId });
      }
      return response.result;
    }
    if (response.type === 'error') {
      throw new ReviewRequestError(response.message, 'REVIEW_FAILED', { op: operation.op });
    }
    throw new ReviewRequestError('Unexpected review response', 'REVIEW_FAILED', { op: operation.op });
  }

  async startProcess(workspaceId: string, processName: string, instance?: number): Promise<void> {
    const response = await this.sendTypedCommand({
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

  async stopProcess(workspaceId: string, processName: string): Promise<void> {
    const response = await this.sendTypedCommand({
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
    const response = await this.sendTypedCommand({ type: 'request_events', requestId: crypto.randomUUID(), workspacePath, filter, limit, sinceMs });
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
    if (this.attachLifecycle.currentViewOnly) {
      return;
    }
    this.assertConnected();

    const key = this.sessionKeys;
    if (!key) {
      throw new Error('Session keys are not established');
    }

    const frame = await this.crypto.createFrame(this.crypto.masterStreamId, data, key.sendKey);
    const encoded = this.crypto.encodeBase64(frame);
    const message: RelayDataMessage = { type: 'data', data: encoded };
    this.socketAdapter.send(this.socket, JSON.stringify(message));
  }

  async resizePty(cols: number, rows: number): Promise<void> {
    const ctrl: SessionCtrl = { type: 'resize', cols, rows };
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
      case 'detached':
        this.attachLifecycle.clearAttachment({ emitDetached: true });
        this.resolvePendingDetachTransition();
        return;
      case 'session_exited':
        this.attachLifecycle.emitExited(message.exitCode, message.sessionId);
        this.resolvePendingDetachTransition();
        return;
      case 'workspace_deleted':
        this.resolveWorkspaceDelete(message.workspaceId);
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
      case 'machine_snapshot':
        this.machineStateClient.replaceSnapshot(message.snapshot);
        this.emitDerivedMachineState();
        this.agentStateCache = machineSnapshotToAgentState(message.snapshot);
        this.resolveInitialSnapshot();
        // Stale-attachment guard: if the session we're attached to is no longer
        // present in the snapshot, the server removed it. Emit exited so the
        // frontend transitions out of attached state and preserves workspace context.
        // Only runs when fully attached (not during the attaching phase).
        if (this.attachLifecycle.isAttached && this.attachLifecycle.sessionId) {
          const sid = this.attachLifecycle.sessionId;
          if (!(sid in message.snapshot.terminalSessionsById)) {
            this.attachLifecycle.emitExited(undefined, sid);
            this.attachedAgentSessionId = null;
          }
        }
        return;
      case 'command_response':
        this.resolveTypedCommand(message as CommandResponse);
        return;
      case 'error':
        if (message.requestId) {
          this.rejectPendingTypedCommand(message.requestId, message.message);
        }
        this.rejectPendingReplayFrame(message.message, { requestId: message.requestId, force: !message.requestId });
        this.rejectPendingReplayTimeline(message.message, undefined, true);
        this.rejectPendingDismissReplay(message.message, undefined, true);
        this.rejectPendingUndismissReplay(message.message, undefined, true);
        if (message.workspaceId) {
          this.rejectPendingWorkspaceDelete(message.code, message.message, message.workspaceId);
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

    this.emit({
      type: 'script_output',
      phase: message.phase,
      data,
      done: message.done,
      error: message.error,
      exitCode: message.exitCode,
      workspaceId: this.attachLifecycle.workspaceId ?? undefined,
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

  private handleSessionEvent(message: SessionEventMessage): void {
    if (message.type === 'kicked') {
      this.attachLifecycle.clearAttachment({ emitDetached: true });
      this.resolvePendingDetachTransition();
      return;
    }

    if (message.type === 'exited') {
      this.attachLifecycle.emitExited(message.code, message.sessionId);
      this.resolvePendingDetachTransition();
      return;
    }

    if (message.type === 'attached' && message.sessionId) {
      this.attachLifecycle.confirmAttached({
        sessionId: message.sessionId,
        sessionName: message.sessionName,
        workspaceId: this.attachLifecycle.workspaceId,
        viewOnly: this.attachLifecycle.currentViewOnly,
      });
      return;
    }

    if (message.type === 'session-meta') {
      this.attachLifecycle.emitSessionMeta({
        sessionName: message.sessionName ?? null,
        processTitle: message.processTitle ?? null,
        terminalTitle: message.terminalTitle ?? null,
        lastAlertKind: message.lastAlertKind ?? null,
        lastAlertPreview: message.lastAlertPreview ?? null,
        lastAlertAt: message.lastAlertAt ?? null,
        unreadAlertCount: message.unreadAlertCount ?? null,
      });
    }
  }

  private resolveWorkspaceDelete(workspaceId: string): void {
    const pending = this.pendingDeleteWorkspace;
    if (!pending) {
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
    force = false
  ): void {
    const pending = this.pendingDeleteWorkspace;
    if (!pending) {
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

  private async sendCommand(message: ClientToMachineMessage | SessionCtrl): Promise<void> {
    this.assertConnected();

    const keys = this.sessionKeys;
    if (!keys) {
      throw new Error('Session keys are not established');
    }

    const streamId = this.crypto.controlStreamId ?? DEFAULT_CONTROL_STREAM_ID;
    const payload = new TextEncoder().encode(JSON.stringify(message));
    const frame = await this.crypto.createFrame(streamId, payload, keys.sendKey);
    const encoded = this.crypto.encodeBase64(frame);
    const relayMessage: RelayDataMessage = { type: 'data', data: encoded };
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
    this.machineStateClient.applyEvent({
      type: 'agent-session-upserted',
      snapshotNonce: snapshot.snapshotNonce,
      session: { ...agent, ...patch },
    });
    this.emitDerivedMachineState();
  }

  private async sendTypedCommand(request: ClientToMachineMessage & { requestId: string }): Promise<TmuxResponse> {
    const requestId = request.requestId;
    return new Promise<TmuxResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingTypedCommands.get(requestId);
        if (!pending) return;
        this.pendingTypedCommands.delete(requestId);
        reject(new Error(`Timed out waiting for command response (${request.type})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);
      this.pendingTypedCommands.set(requestId, { resolve, reject, timeout });
      void this.sendCommand(request).catch((error) => {
        const pending = this.pendingTypedCommands.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingTypedCommands.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private resolveTypedCommand(message: CommandResponse): void {
    const pending = this.pendingTypedCommands.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingTypedCommands.delete(message.requestId);
    pending.resolve(message.response);
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
    this.rejectPendingWorkspaceDelete('DELETE_FAILED', 'Remote session disconnected', undefined, true);
    for (const pending of this.pendingTypedCommands.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Remote session disconnected'));
    }
    this.pendingTypedCommands.clear();
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
    await this.initialSnapshotPromise;
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

  private handleAgentStateSnapshot(msg: AgentStateSnapshotPush): void {
    this.agentStateCache = {};
    for (const workspace of msg.workspaces) {
      this.agentStateCache[workspace.workspaceId] = workspace;
    }
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
    // Apply delta to local cache
    if ('workspaceId' in delta && 'sessionId' in delta) {
      const state = this.agentStateCache[delta.workspaceId];
      if (state) {
        switch (delta.type) {
          case 'agent_session_status':
            state.statuses[delta.sessionId] = delta.status;
            break;
          case 'agent_permission_added':
            if (!state.pendingPermissions[delta.sessionId]) state.pendingPermissions[delta.sessionId] = [];
            state.pendingPermissions[delta.sessionId].push(delta.permission);
            break;
          case 'agent_permission_removed':
            if (state.pendingPermissions[delta.sessionId]) {
              state.pendingPermissions[delta.sessionId] = state.pendingPermissions[delta.sessionId].filter(
                (p) => p.id !== delta.permissionId,
              );
            }
            break;
          case 'agent_last_message':
            state.lastMessages[delta.sessionId] = delta.preview;
            break;
          case 'agent_session_created':
            if (!state.sessions.some((s) => s.id === delta.sessionId)) {
              state.sessions.push({ id: delta.sessionId, title: delta.title });
            }
            break;
          case 'agent_session_updated': {
            const idx = state.sessions.findIndex((s) => s.id === delta.sessionId);
            if (idx !== -1) state.sessions[idx] = { id: delta.sessionId, title: delta.title };
            break;
          }
          case 'agent_session_deleted':
            state.sessions = state.sessions.filter((s) => s.id !== delta.sessionId);
            break;
        }
      }
    }
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
    const tmuxResponse = await this.sendTypedCommand({
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
