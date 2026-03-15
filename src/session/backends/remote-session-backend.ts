import type { Identity, SessionKeys } from '../../types/identity.js';
import {
  type ApplyBundleConfigUpdateRequest,
  parseRemoteMessage,
  type ApplyBundleRefreshRequest,
  type AttachSessionRequest,
  type CancelProjectCreationRequest,
  type CreateProjectRequest,
  type CreateWorkspaceRequest,
  type DeleteProjectRequest,
  type BundleRefreshAppliedResponse,
  type BundleConfigUpdatedResponse,
  type BundleConfigStateResponse,
  type BundleRefreshPlanResponse,
  type CancelPendingAttachRequest,
  type ClearInboxRequest,
  type ClientToMachineMessage,
  type DeleteWorkspaceRequest,
  type GithubRepoListResponse,
  type LinearIssueListResponse,
  type GetEventsRequest,
  type GetInboxRequest,
  type GetBundleRefreshPlanRequest,
  type GetBundleConfigStateRequest,
  type GetNotificationConfigRequest,
  type GetReplayTimelineRequest,
  type KillSessionRequest,
  type ListLinearIssuesRequest,
  type ListProjectsRequest,
  type ListGithubReposRequest,
  type ListReplaysRequest,
  type ListRemoteBranchesRequest,
  type ListSessionsRequest,
  type ListWorkspacesRequest,
  type MachineToClientMessage,
  type MarkInboxReadRequest,
  type PrepareProjectCreationRequest,
  type ProjectCreationCancelledResponse,
  type ProjectCreationPreparedResponse,
  type ReviewRequest,
  type ReviewResponse,
  type FinalizeProjectCreationRequest,
  type EventsListResponse,
  type ProjectCreatedResponse,
  type ProjectDeletedResponse,
  type RemoteBranchListResponse,
  type ScriptOutputResponse,
  type ReplayAnsiResponse,
  type ReplayTimelineResponse,
  type ReplayDismissedResponse,
  type ReplayUndismissedResponse,
  type SessionCtrl,
  type StartProcessRequest,
  type StopProcessRequest,
  type OpenCodeRequest,
  type OpenCodeResponse,
  type OpenCodeStreamCloseRequest,
  type OpenCodeStreamEventResponse,
  type OpenCodeStreamOpenRequest,
  type OpenCodeStreamOpenedResponse,
  type OpenCodeStreamClosedResponse,
  type OpenCodeStreamErrorResponse,
  type UpdateNotificationConfigRequest,
  type WorkspaceCreatedResponse,
  type GetReplayAnsiRequest,
  type DismissReplayRequest,
  type UndismissReplayRequest,
} from '../../lib/remote-session/protocol.js';
import type { BundleRefreshPlan, BundleRefreshSubmission } from '../../types/bundle-refresh.js';
import type { BundleConfigState, BundleConfigSubmission } from '../../types/bundle-config.js';
import type { ReviewOperation, ReviewResult } from '../../types/review.js';
import type { WideEvent, WideEventFilter } from '../../types/events.js';
import type { SessionLinearIssueSummary } from '../../types/lifecycle.js';
import { findUtf8Boundary } from '../../utils/utf8.js';
import { extractRepoName, sanitizeForFileSystem } from '../../utils/sanitize.js';
import type { NotificationConfig } from '../../notifications/types.js';
import {
  ReviewRequestError,
  WorkspaceDeleteError,
  type WorkspaceDeleteErrorCode,
} from '../../types/errors.js';
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
  OpenCodeBridgeBackend,
  SessionBackend,
} from '../backend.js';
import type { BackendEvent } from '../events.js';
import type {
  OpenCodeBridgeRequest,
  OpenCodeBridgeResponse,
  OpenCodeBridgeStreamEvent,
  OpenCodeBridgeStreamOpen,
} from '../../agents/opencode-bridge.js';
import type { OpenCodeRuntimeInfo } from '../../agents/opencode-types.js';
import type { AgentStateUpdateDelta, WorkspaceAgentState } from '../../serve/agent-event-manager.js';
import type { AgentStateSnapshotPush, AgentStateUpdatePush } from '../../lib/remote-session/protocol.js';

const DEFAULT_CONTROL_STREAM_ID = 1;
const DEFAULT_DELETE_WORKSPACE_TIMEOUT_MS = 30000;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 30000;

function normalizeExpectedProjectName(projectName: string | undefined, repository: string): string {
	const candidate = projectName?.trim() || extractRepoName(repository);
	return sanitizeForFileSystem(candidate) || candidate;
}

function normalizeProjectName(projectName: string): string {
	const trimmed = projectName.trim();
	return sanitizeForFileSystem(trimmed) || trimmed;
}

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

interface PtyOutputMessage {
  type: 'pty_output';
  data: string;
}

interface SessionEventMessage {
  type: 'attach-ready' | 'attached' | 'exited' | 'kicked';
  cols?: number;
  rows?: number;
  code?: number;
}

interface PendingEventsChunk {
  workspaceId: string;
  totalChunks: number;
  chunks: Map<number, WideEvent[]>;
  liveEventIds: string[];
  savedEventFilters?: import('../../types/events.js').SavedEventFilter[];
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
}

const MACHINE_TO_CLIENT_TYPES = new Set<string>([
  'workspace_list',
  'session_list',
  'replay_list',
  'replay_ansi',
  'replay_timeline',
  'replay_dismissed',
  'replay_undismissed',
  'attached',
  'detached',
  'session_exited',
  'error',
  'project_list',
  'github_repo_list',
  'remote_branch_list',
  'linear_issue_list',
  'project_creation_prepared',
  'project_creation_cancelled',
  'project_created',
  'workspace_created',
  'project_deleted',
  'session_killed',
  'workspace_deleted',
  'inbox_list',
  'inbox_cleared',
  'inbox_marked_read',
  'notification_config',
  'notification_config_updated',
  'script_output',
  'bundle_refresh_plan',
  'bundle_refresh_applied',
  'bundle_config_state',
  'bundle_config_updated',
  'review_response',
  'events_list',
  'process_started',
  'process_stopped',
  'opencode_response',
  'opencode_stream_opened',
  'opencode_stream_event',
  'opencode_stream_closed',
  'opencode_stream_error',
  'opencode_runtime',
  'agent_state_snapshot',
  'agent_state_update',
]);

function isHandshakeEnvelope(value: unknown): value is HandshakeEnvelope {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const envelope = value as Partial<HandshakeEnvelope>;
  return envelope.type === 'handshake' && typeof envelope.phase === 'string';
}

function isPtyOutputMessage(value: unknown): value is PtyOutputMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Partial<PtyOutputMessage>;
  return message.type === 'pty_output' && typeof message.data === 'string';
}

function isSessionEventMessage(value: unknown): value is SessionEventMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Partial<SessionEventMessage>;
  return (
    message.type === 'attach-ready' ||
    message.type === 'attached' ||
    message.type === 'exited' ||
    message.type === 'kicked'
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

function concatUint8Array(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
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
  implements SessionBackend, OpenCodeBridgeBackend {
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

  private mode: 'browsing' | 'attached' = 'browsing';
  private attachedSessionId: string | null = null;
  private viewOnly = false;
  private handshakeState: THandshakeState | null = null;
  private sessionKeys: SessionKeys | null = null;
  private isConnected = false;
  private listenersAttached = false;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private pendingBundleRefreshPlan:
    | {
        resolve: (plan: BundleRefreshPlan) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingBundleRefreshApply:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingBundleConfigState:
    | {
        resolve: (state: BundleConfigState) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingBundleConfigUpdate:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingDeleteWorkspace:
    | {
        workspaceId: string;
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingGithubRepos:
    | {
        resolve: (repos: string[]) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingRemoteBranches:
    | {
        projectName: string;
        resolve: (branches: string[]) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingLinearIssues:
    | {
        projectName: string;
        resolve: (issues: SessionLinearIssueSummary[]) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingCreateProject:
    | {
        projectName: string;
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingPrepareProject:
    | {
        projectName: string;
        resolve: (result: PreparedProjectResult) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingCancelProject:
    | {
        projectName: string;
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingCreateWorkspace:
    | {
        projectName: string;
        workspaceName: string;
        expectedWorkspaceId: string;
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingDeleteProject:
    | {
        projectName: string;
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingReviewRequests = new Map<string, {
    op: ReviewOperation['op'];
    resolve: (result: ReviewResult) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private pendingReplayAnsi:
    | {
        replayId: string;
        resolve: (data: Uint8Array) => void;
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
  private ptyOutputHandler: ((data: Uint8Array) => void) | null = null;
  private pendingPtyChunks: Uint8Array[] = [];
  private pendingUtf8Bytes = new Uint8Array(0);
  private pendingEventChunks = new Map<string, PendingEventsChunk>();
  private pendingOpenCodeRequests = new Map<string, {
    resolve: (response: OpenCodeBridgeResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private openCodeStreamHandlers = new Map<string, (event: OpenCodeBridgeStreamEvent) => void>();
  private pendingOpenCodeRuntimeInfo = new Map<string, {
    workspaceId: string;
    resolve: (info: OpenCodeRuntimeInfo) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private pendingOpenCodeStreamOpen = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

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
  }

  onEvent(handler: (event: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  setPtyOutputHandler(handler: ((data: Uint8Array) => void) | null): void {
    this.ptyOutputHandler = handler;
    if (!handler || this.pendingPtyChunks.length === 0) {
      return;
    }

    const pending = [...this.pendingPtyChunks];
    this.pendingPtyChunks = [];
    for (const chunk of pending) {
      this.emitPtyData(chunk);
    }
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
    const command: ListProjectsRequest = { type: 'list_projects' };
    await this.sendCommand(command);
  }

  async listGithubRepos(org?: string): Promise<string[]> {
    if (this.pendingGithubRepos) {
      throw new Error('GitHub repository list request already in progress');
    }

    const command: ListGithubReposRequest = { type: 'list_github_repos', org };

    return new Promise<string[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingGithubRepos) {
          return;
        }

        this.pendingGithubRepos = null;
        reject(new Error('Timed out waiting for GitHub repository list'));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.pendingGithubRepos = { resolve, reject, timeout };

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingGithubRepos;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingGithubRepos = null;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async listRemoteBranches(projectName: string): Promise<string[]> {
    if (this.pendingRemoteBranches) {
      throw new Error('Remote branch list request already in progress');
    }

    const command: ListRemoteBranchesRequest = {
      type: 'list_remote_branches',
      projectName,
    };

    return new Promise<string[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingRemoteBranches;
        if (!pending || pending.projectName !== projectName) {
          return;
        }

        this.pendingRemoteBranches = null;
        pending.reject(new Error(`Timed out waiting for remote branches (${projectName})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.pendingRemoteBranches = {
        projectName,
        resolve,
        reject,
        timeout,
      };

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingRemoteBranches;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingRemoteBranches = null;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async listLinearIssues(projectName: string): Promise<SessionLinearIssueSummary[]> {
    if (this.pendingLinearIssues) {
      throw new Error('Linear issue list request already in progress');
    }

    const command: ListLinearIssuesRequest = {
      type: 'list_linear_issues',
      projectName,
    };

    return new Promise<SessionLinearIssueSummary[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingLinearIssues;
        if (!pending || pending.projectName !== projectName) {
          return;
        }

        this.pendingLinearIssues = null;
        pending.reject(new Error(`Timed out waiting for Linear issues (${projectName})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.pendingLinearIssues = {
        projectName,
        resolve,
        reject,
        timeout,
      };

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingLinearIssues;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingLinearIssues = null;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async listWorkspaces(): Promise<void> {
    const command: ListWorkspacesRequest = { type: 'list_workspaces' };
    await this.sendCommand(command);
  }

  async listSessions(workspaceId?: string): Promise<void> {
    const command: ListSessionsRequest = { type: 'list_sessions', workspaceId };
    await this.sendCommand(command);
  }

  async listReplays(workspaceId?: string, includeDismissed?: boolean): Promise<void> {
    const command: ListReplaysRequest = {
      type: 'list_replays',
      workspaceId,
      includeDismissed,
    };
    await this.sendCommand(command);
  }

  async getReplayAnsi(replayId: string, target?: ReplayFrameTarget): Promise<Uint8Array> {
    if (this.pendingReplayAnsi) {
      throw new Error('Replay ANSI request already in progress');
    }

    const command: GetReplayAnsiRequest = {
      type: 'get_replay_ansi',
      replayId,
      atMs: target?.atMs,
      atSeq: target?.atSeq,
    };
    return new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingReplayAnsi;
        if (!pending || pending.replayId !== replayId) {
          return;
        }
        this.pendingReplayAnsi = null;
        pending.reject(new Error(`Timed out waiting for replay ANSI (${replayId})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.pendingReplayAnsi = { replayId, resolve, reject, timeout };

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingReplayAnsi;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingReplayAnsi = null;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async getReplayTimeline(replayId: string): Promise<ReplayTimeline> {
    if (this.pendingReplayTimeline) {
      throw new Error('Replay timeline request already in progress');
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

  async requestOpenCode(request: Omit<OpenCodeBridgeRequest, 'requestId'>): Promise<OpenCodeBridgeResponse> {
    const requestId = crypto.randomUUID();
    const command: OpenCodeRequest = {
      type: 'opencode_request',
      requestId,
      ...request,
    };

    return new Promise<OpenCodeBridgeResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingOpenCodeRequests.get(requestId);
        if (!pending) {
          return;
        }
        this.pendingOpenCodeRequests.delete(requestId);
        reject(new Error(`Timed out waiting for OpenCode response (${request.path})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.pendingOpenCodeRequests.set(requestId, { resolve, reject, timeout });

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingOpenCodeRequests.get(requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingOpenCodeRequests.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async getOpenCodeRuntimeInfo(workspaceId: string): Promise<OpenCodeRuntimeInfo> {
    const requestId = crypto.randomUUID();
    const command = {
      type: 'get_opencode_runtime' as const,
      workspaceId,
    };

    return new Promise<OpenCodeRuntimeInfo>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingOpenCodeRuntimeInfo.get(requestId);
        if (!pending) {
          return;
        }
        this.pendingOpenCodeRuntimeInfo.delete(requestId);
        reject(new Error(`Timed out waiting for OpenCode runtime info (${workspaceId})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.pendingOpenCodeRuntimeInfo.set(requestId, {
        workspaceId,
        resolve,
        reject,
        timeout,
      });

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingOpenCodeRuntimeInfo.get(requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingOpenCodeRuntimeInfo.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async subscribeOpenCode(
    request: Omit<OpenCodeBridgeStreamOpen, 'requestId'>,
    handler: (event: OpenCodeBridgeStreamEvent) => void,
  ): Promise<() => Promise<void>> {
    const requestId = crypto.randomUUID();
    const command: OpenCodeStreamOpenRequest = {
      type: 'opencode_stream_open',
      requestId,
      ...request,
    };

    return new Promise<() => Promise<void>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingOpenCodeStreamOpen.get(requestId);
        if (!pending) {
          return;
        }
        this.pendingOpenCodeStreamOpen.delete(requestId);
        this.openCodeStreamHandlers.delete(requestId);
        reject(new Error(`Timed out opening OpenCode stream (${request.path})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.openCodeStreamHandlers.set(requestId, handler);
      this.pendingOpenCodeStreamOpen.set(requestId, {
        resolve: () => {
          resolve(async () => {
            const closeCommand: OpenCodeStreamCloseRequest = {
              type: 'opencode_stream_close',
              requestId,
            };
            this.openCodeStreamHandlers.delete(requestId);
            await this.sendCommand(closeCommand);
          });
        },
        reject,
        timeout,
      });

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingOpenCodeStreamOpen.get(requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingOpenCodeStreamOpen.delete(requestId);
        this.openCodeStreamHandlers.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async createProject(params: CreateProjectParams): Promise<void> {
    if (this.pendingCreateProject || this.pendingPrepareProject || this.pendingCancelProject) {
      throw new Error('Project creation request already in progress');
    }

    const command: CreateProjectRequest = {
      type: 'create_project',
      repository: params.repository,
      projectName: params.projectName,
      baseBranch: params.baseBranch,
      setCurrent: params.setCurrent,
    };
    const expectedProjectName = normalizeExpectedProjectName(params.projectName, params.repository);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingCreateProject;
        if (!pending) {
          return;
        }

        this.pendingCreateProject = null;
        pending.reject(new Error('Timed out waiting for project creation response'));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.pendingCreateProject = {
        projectName: expectedProjectName,
        resolve,
        reject,
        timeout,
      };

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingCreateProject;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingCreateProject = null;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async prepareProjectCreation(params: CreateProjectParams): Promise<PreparedProjectResult> {
    if (this.pendingCreateProject || this.pendingPrepareProject || this.pendingCancelProject) {
      throw new Error('Project preparation request already in progress');
    }

    const command: PrepareProjectCreationRequest = {
      type: 'prepare_project_creation',
      repository: params.repository,
      projectName: params.projectName,
      baseBranch: params.baseBranch,
      setCurrent: params.setCurrent,
    };
    const expectedProjectName = normalizeExpectedProjectName(params.projectName, params.repository);

    return new Promise<PreparedProjectResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingPrepareProject;
        if (!pending) {
          return;
        }

        this.pendingPrepareProject = null;
        pending.reject(new Error('Timed out waiting for project preparation response'));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.pendingPrepareProject = {
        projectName: expectedProjectName,
        resolve,
        reject,
        timeout,
      };

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingPrepareProject;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingPrepareProject = null;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async finalizeProjectCreation(params: FinalizeProjectParams): Promise<void> {
    if (this.pendingCreateProject || this.pendingPrepareProject || this.pendingCancelProject) {
      throw new Error('Project creation request already in progress');
    }

    const command: FinalizeProjectCreationRequest = {
      type: 'finalize_project_creation',
      projectName: params.projectName,
      repository: params.repository,
      baseBranch: params.baseBranch,
      bundle: params.bundle,
      inputValues: params.inputValues,
      secretValues: params.secretValues,
      confirmResults: params.confirmResults,
      setCurrent: params.setCurrent,
    };
    const expectedProjectName = normalizeExpectedProjectName(params.projectName, params.repository);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingCreateProject;
        if (!pending) {
          return;
        }

        this.pendingCreateProject = null;
        pending.reject(new Error('Timed out waiting for project creation response'));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.pendingCreateProject = {
        projectName: expectedProjectName,
        resolve,
        reject,
        timeout,
      };

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingCreateProject;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingCreateProject = null;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async cancelProjectCreation(projectName: string): Promise<void> {
    if (this.pendingCreateProject || this.pendingPrepareProject || this.pendingCancelProject) {
      throw new Error('Project cancellation request already in progress');
    }

    const expectedProjectName = normalizeProjectName(projectName);

    const command: CancelProjectCreationRequest = {
      type: 'cancel_project_creation',
      projectName,
    };

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingCancelProject;
        if (!pending || pending.projectName !== expectedProjectName) {
          return;
        }

        this.pendingCancelProject = null;
        pending.reject(new Error(`Timed out waiting for project cancellation response (${expectedProjectName})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.pendingCancelProject = {
        projectName: expectedProjectName,
        resolve,
        reject,
        timeout,
      };

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingCancelProject;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingCancelProject = null;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async createWorkspace(params: CreateWorkspaceParams): Promise<void> {
    if (this.pendingCreateWorkspace) {
      throw new Error('Workspace creation request already in progress');
    }

    const expectedWorkspaceId = `${params.projectName}:${params.workspaceName}`;
    const command: CreateWorkspaceRequest = {
      type: 'create_workspace',
      projectName: params.projectName,
      workspaceName: params.workspaceName,
      branchName: params.branchName,
      baseBranch: params.baseBranch,
      workspaceSource: params.workspaceSource,
      linearIssue: params.linearIssue,
    };

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingCreateWorkspace;
        if (!pending) {
          return;
        }

        this.pendingCreateWorkspace = null;
        pending.reject(new Error(`Timed out waiting for workspace creation response (${expectedWorkspaceId})`));
      }, DEFAULT_LIFECYCLE_TIMEOUT_MS);

      this.pendingCreateWorkspace = {
        projectName: params.projectName,
        workspaceName: params.workspaceName,
        expectedWorkspaceId,
        resolve,
        reject,
        timeout,
      };

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingCreateWorkspace;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingCreateWorkspace = null;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async deleteProject(projectName: string, params: DeleteProjectParams = {}): Promise<void> {
    if (this.pendingDeleteProject) {
      throw new Error('Project delete request already in progress');
    }

    const command: DeleteProjectRequest = {
      type: 'delete_project',
      projectName,
    };

    const timeoutMs =
      typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_LIFECYCLE_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingDeleteProject;
        if (!pending || pending.projectName !== projectName) {
          return;
        }

        this.pendingDeleteProject = null;
        pending.reject(new Error(`Timed out waiting for project deletion response (${projectName})`));
      }, timeoutMs);

      this.pendingDeleteProject = {
        projectName,
        resolve,
        reject,
        timeout,
      };

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingDeleteProject;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingDeleteProject = null;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async attachSession(params: AttachSessionParams): Promise<void> {
    this.viewOnly = params.viewOnly ?? false;
    const command: AttachSessionRequest = {
      type: 'attach_session',
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      sessionName: params.sessionName,
      cols: params.cols,
      rows: params.rows,
      scriptPolicy: params.scriptPolicy,
      viewOnly: params.viewOnly,
      command: params.command,
      args: params.args,
      env: params.env,
    };
    await this.sendCommand(command);
  }

  async detachSession(): Promise<void> {
    const ctrl: SessionCtrl = { type: 'detach' };
    await this.sendCommand(ctrl);
  }

  async cancelPendingScripts(): Promise<void> {
    const command: CancelPendingAttachRequest = { type: 'cancel_pending_attach' };
    await this.sendCommand(command);
  }

  async killSession(sessionId: string): Promise<void> {
    const command: KillSessionRequest = { type: 'kill_session', sessionId };
    await this.sendCommand(command);
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
    if (this.pendingBundleRefreshPlan) {
      throw new Error('Bundle refresh plan request already in progress');
    }

    const command: GetBundleRefreshPlanRequest = {
      type: 'get_bundle_refresh_plan',
      projectName,
      workspaceId,
    };

    return new Promise<BundleRefreshPlan>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingBundleRefreshPlan) {
          return;
        }
        this.pendingBundleRefreshPlan = null;
        reject(new Error('Timed out waiting for bundle refresh plan'));
      }, 15000);

      this.pendingBundleRefreshPlan = { resolve, reject, timeout };
      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingBundleRefreshPlan;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingBundleRefreshPlan = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async applyBundleRefresh(
    projectName: string,
    workspaceId: string,
    submission: BundleRefreshSubmission
  ): Promise<void> {
    if (this.pendingBundleRefreshApply) {
      throw new Error('Bundle refresh apply request already in progress');
    }

    const command: ApplyBundleRefreshRequest = {
      type: 'apply_bundle_refresh',
      projectName,
      workspaceId,
      submission,
    };

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingBundleRefreshApply) {
          return;
        }
        this.pendingBundleRefreshApply = null;
        reject(new Error('Timed out applying bundle refresh submission'));
      }, 15000);

      this.pendingBundleRefreshApply = { resolve, reject, timeout };
      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingBundleRefreshApply;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingBundleRefreshApply = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async getBundleConfigState(projectName: string, workspaceId: string): Promise<BundleConfigState> {
    if (this.pendingBundleConfigState) {
      throw new Error('Bundle config state request already in progress');
    }

    const command: GetBundleConfigStateRequest = {
      type: 'get_bundle_config_state',
      projectName,
      workspaceId,
    };

    return new Promise<BundleConfigState>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingBundleConfigState) {
          return;
        }
        this.pendingBundleConfigState = null;
        reject(new Error('Timed out waiting for bundle config state'));
      }, 15000);

      this.pendingBundleConfigState = { resolve, reject, timeout };
      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingBundleConfigState;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingBundleConfigState = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async applyBundleConfigUpdate(
    projectName: string,
    workspaceId: string,
    submission: BundleConfigSubmission
  ): Promise<void> {
    if (this.pendingBundleConfigUpdate) {
      throw new Error('Bundle config update request already in progress');
    }

    const command: ApplyBundleConfigUpdateRequest = {
      type: 'apply_bundle_config_update',
      projectName,
      workspaceId,
      submission,
    };

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingBundleConfigUpdate) {
          return;
        }
        this.pendingBundleConfigUpdate = null;
        reject(new Error('Timed out applying bundle config update'));
      }, 15000);

      this.pendingBundleConfigUpdate = { resolve, reject, timeout };
      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingBundleConfigUpdate;
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingBundleConfigUpdate = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async requestInbox(): Promise<void> {
    const command: GetInboxRequest = { type: 'get_inbox' };
    await this.sendCommand(command);
  }

  async clearInbox(id?: string): Promise<void> {
    const command: ClearInboxRequest = { type: 'clear_inbox', id };
    await this.sendCommand(command);
  }

  async markInboxRead(id: string): Promise<void> {
    const command: MarkInboxReadRequest = { type: 'mark_inbox_read', id };
    await this.sendCommand(command);
  }

  async getNotificationConfig(): Promise<void> {
    const command: GetNotificationConfigRequest = { type: 'get_notification_config' };
    await this.sendCommand(command);
  }

  async updateNotificationConfig(config: NotificationConfig): Promise<void> {
    const command: UpdateNotificationConfigRequest = {
      type: 'update_notification_config',
      config,
    };
    await this.sendCommand(command);
  }

  async sendReviewRequest(operation: ReviewOperation): Promise<ReviewResult> {
    const requestId = crypto.randomUUID();

    const command: ReviewRequest = {
      type: 'review_request',
      requestId,
      operation,
    };

    return new Promise<ReviewResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingReviewRequests.has(requestId)) {
          return;
        }
        this.pendingReviewRequests.delete(requestId);
        reject(
          new ReviewRequestError(
            `Timed out waiting for review response (${operation.op})`,
            'REVIEW_TIMEOUT',
            { op: operation.op, requestId }
          )
        );
      }, 30000);

      this.pendingReviewRequests.set(requestId, {
        op: operation.op,
        resolve,
        reject,
        timeout,
      });

      void this.sendCommand(command).catch((error) => {
        const pending = this.pendingReviewRequests.get(requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingReviewRequests.delete(requestId);
        const message = error instanceof Error ? error.message : String(error);
        reject(
          new ReviewRequestError(message, 'REVIEW_FAILED', {
            op: pending.op,
            requestId,
          })
        );
      });
    });
  }

  async startProcess(workspaceId: string, processName: string, instance?: number): Promise<void> {
    const command: StartProcessRequest = {
      type: 'start_process',
      workspaceId,
      processName,
      instance,
    };
    await this.sendCommand(command);
  }

  async stopProcess(workspaceId: string, processName: string): Promise<void> {
    const command: StopProcessRequest = {
      type: 'stop_process',
      workspaceId,
      processName,
    };
    await this.sendCommand(command);
  }

  async requestEvents(
    workspacePath: string,
    filter?: WideEventFilter,
    limit?: number,
    sinceMs?: number,
  ): Promise<void> {
    const command: GetEventsRequest = {
      type: 'get_events',
      workspacePath,
      filter,
      limit,
      sinceMs,
    };
    await this.sendCommand(command);
  }

  async writePtyData(data: Uint8Array): Promise<void> {
    if (this.viewOnly) {
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
        this.rejectPendingBundleRefreshRequests(error.message);
        this.rejectPendingGithubRepoList(error.message);
        this.rejectPendingRemoteBranches(error.message, undefined, true);
        this.rejectPendingLinearIssues(error.message, undefined, true);
        this.rejectPendingPrepareProject(error.message, undefined, true);
        this.rejectPendingProjectCreate(error.message, undefined, true);
        this.rejectPendingCancelProject(error.message, undefined, true);
        this.rejectPendingWorkspaceCreate(error.message, undefined, undefined, true);
        this.rejectPendingProjectDelete(error.message, undefined, true);
        this.rejectPendingWorkspaceDelete('DELETE_FAILED', error.message);
        this.rejectAllPendingReviewRequests(error.message);
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

    if (isPtyOutputMessage(parsedMessage)) {
      this.emitPtyData(this.crypto.decodeBase64(parsedMessage.data));
      return;
    }

    const machineMessage = toMachineMessage(parsedMessage);
    if (machineMessage) {
      await this.handleMachineMessage(machineMessage);
      return;
    }

    if (isSessionEventMessage(parsedMessage)) {
      this.handleSessionEvent(parsedMessage);
      return;
    }

    if (this.mode === 'attached') {
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
      this.mode = 'browsing';
      this.handshakeState = null;
      this.emit({ type: 'status', status: 'connected' });
      this.resolveConnect();
    }
  }

  private async handleMachineMessage(message: MachineToClientMessage): Promise<void> {
    switch (message.type) {
      case 'project_list':
        this.emit({ type: 'projects', projects: message.projects });
        return;
      case 'github_repo_list':
        this.resolveGithubRepoList(message);
        return;
      case 'remote_branch_list':
        this.resolveRemoteBranchList(message);
        return;
      case 'linear_issue_list':
        this.resolveLinearIssueList(message);
        return;
      case 'project_creation_prepared':
        this.resolvePrepareProject(message);
        return;
      case 'project_creation_cancelled':
        this.resolveCancelProject(message);
        return;
      case 'project_created':
        this.resolveCreateProject(message);
        await this.listProjects();
        return;
      case 'workspace_created':
        this.resolveCreateWorkspace(message);
        await this.listWorkspaces();
        await this.listSessions(message.workspaceId);
        return;
      case 'project_deleted':
        this.resolveDeleteProject(message);
        await this.listProjects();
        await this.listWorkspaces();
        await this.listSessions();
        return;
      case 'workspace_list':
        this.emit({
          type: 'workspaces',
          workspaces: message.workspaces,
          savedEventFilters: message.savedEventFilters,
        });
        return;
      case 'session_list':
        this.emit({ type: 'sessions', sessions: message.sessions });
        return;
      case 'replay_list':
        this.emit({ type: 'replays', replays: message.replays });
        return;
      case 'replay_ansi':
        this.resolveReplayAnsi(message);
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
      case 'attached':
        this.mode = 'attached';
        this.attachedSessionId = message.sessionId;
        this.emit({
          type: 'attached',
          sessionId: message.sessionId,
          sessionName: message.sessionName,
          viewOnly: this.viewOnly,
        });
        return;
      case 'detached':
        this.mode = 'browsing';
        this.attachedSessionId = null;
        this.viewOnly = false;
        this.emit({ type: 'detached' });
        return;
      case 'session_exited':
        this.mode = 'browsing';
        this.attachedSessionId = null;
        this.emit({
          type: 'session_exited',
          sessionId: message.sessionId,
          exitCode: message.exitCode,
        });
        return;
      case 'session_killed':
        await this.listWorkspaces();
        await this.listSessions(
          message.workspaceId && message.workspaceId !== 'unknown' ? message.workspaceId : undefined
        );
        return;
      case 'workspace_deleted':
        this.resolveWorkspaceDelete(message.workspaceId);
        await this.listWorkspaces();
        return;
      case 'inbox_list':
        this.emit({
          type: 'inbox',
          items: message.items,
          unreadCount: message.unreadCount,
        });
        return;
      case 'inbox_cleared':
      case 'inbox_marked_read':
        await this.requestInbox();
        return;
      case 'notification_config':
      case 'notification_config_updated':
        this.emit({ type: 'notification_config', config: message.config });
        return;
      case 'script_output':
        this.handleScriptOutput(message);
        return;
      case 'bundle_refresh_plan': {
        this.resolveBundleRefreshPlan(message);
        return;
      }
      case 'bundle_refresh_applied': {
        this.resolveBundleRefreshApply(message);
        return;
      }
      case 'bundle_config_state': {
        this.resolveBundleConfigState(message);
        return;
      }
      case 'bundle_config_updated': {
        this.resolveBundleConfigUpdate(message);
        return;
      }
      case 'review_response': {
        this.resolveReviewRequest(message);
        return;
      }
      case 'events_list':
        this.handleEventsList(message);
        return;
      case 'process_started':
        this.emit({
          type: 'process_started',
          workspaceId: message.workspaceId,
          processName: message.processName,
          sessionId: message.sessionId,
          sessionIds: message.sessionIds,
        });
        return;
      case 'process_stopped':
        this.emit({
          type: 'process_stopped',
          workspaceId: message.workspaceId,
          processName: message.processName,
        });
        return;
      case 'opencode_response':
        this.resolveOpenCodeRequest(message);
        return;
      case 'opencode_stream_opened':
        this.resolveOpenCodeStreamOpened(message);
        return;
      case 'opencode_stream_event':
        this.handleOpenCodeStreamEvent(message);
        return;
      case 'opencode_stream_closed':
        this.handleOpenCodeStreamClosed(message);
        return;
      case 'opencode_stream_error':
        this.handleOpenCodeStreamError(message);
        return;
      case 'opencode_runtime':
        this.resolveOpenCodeRuntimeInfo(message);
        return;
      case 'agent_state_snapshot':
        this.handleAgentStateSnapshot(message as unknown as AgentStateSnapshotPush);
        return;
      case 'agent_state_update':
        this.handleAgentStateUpdate(message as unknown as AgentStateUpdatePush);
        return;
      case 'error':
        this.rejectPendingBundleRefreshRequests(message.message);
        this.rejectPendingGithubRepoList(message.message);
        this.rejectPendingRemoteBranches(message.message, message.projectName);
        this.rejectPendingLinearIssues(message.message, message.projectName);
        this.rejectPendingPrepareProject(message.message, message.projectName);
        this.rejectPendingProjectCreate(message.message, message.projectName);
        this.rejectPendingCancelProject(message.message, message.projectName);
        this.rejectPendingWorkspaceCreate(message.message, message.workspaceId, message.projectName);
        this.rejectPendingProjectDelete(message.message, message.projectName);
        this.rejectPendingReplayAnsi(message.message, undefined, true);
        this.rejectPendingReplayTimeline(message.message, undefined, true);
        this.rejectPendingDismissReplay(message.message, undefined, true);
        this.rejectPendingUndismissReplay(message.message, undefined, true);
        this.rejectPendingOpenCodeRuntimeInfo(message.message, message.workspaceId);
        this.rejectPendingOpenCodeRequests(message.message);
        this.rejectPendingOpenCodeStreams(message.message);
        if (message.workspaceId) {
          this.rejectPendingWorkspaceDelete(message.code, message.message, message.workspaceId);
        }
        this.emit({
          type: 'command_error',
          code: message.code,
          message: message.message,
        });
        return;
      default:
        return;
    }
  }

  private handleScriptOutput(message: ScriptOutputResponse): void {
    const data = message.data ? this.crypto.decodeBase64(message.data) : new Uint8Array(0);
    if (data.length > 0) {
      this.emitPtyData(data);
    }

    this.emit({
      type: 'script_output',
      phase: message.phase,
      data,
      done: message.done,
      error: message.error,
      exitCode: message.exitCode,
    });
  }

  private resolveGithubRepoList(message: GithubRepoListResponse): void {
    const pending = this.pendingGithubRepos;
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingGithubRepos = null;
    pending.resolve(message.repos);
  }

  private resolveRemoteBranchList(message: RemoteBranchListResponse): void {
    const pending = this.pendingRemoteBranches;
    if (!pending) {
      return;
    }

    if (pending.projectName !== message.projectName) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRemoteBranches = null;
    pending.resolve(message.branches);
  }

  private resolveLinearIssueList(message: LinearIssueListResponse): void {
    const pending = this.pendingLinearIssues;
    if (!pending) {
      return;
    }

    if (pending.projectName !== message.projectName) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingLinearIssues = null;
    pending.resolve(message.issues);
  }

  private resolvePrepareProject(message: ProjectCreationPreparedResponse): void {
    const pending = this.pendingPrepareProject;
    if (!pending) {
      return;
    }

    if (pending.projectName !== message.projectName) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingPrepareProject = null;
    pending.resolve({
      projectName: message.projectName,
      repository: message.repository,
      baseBranch: message.baseBranch,
      bundle: message.bundle,
      confirmStatuses: message.confirmStatuses,
    });
  }

  private resolveCreateProject(message: ProjectCreatedResponse): void {
    const pending = this.pendingCreateProject;
    if (!pending) {
      return;
    }

    if (pending.projectName !== message.projectName) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCreateProject = null;
    pending.resolve();
  }

  private resolveCancelProject(message: ProjectCreationCancelledResponse): void {
    const pending = this.pendingCancelProject;
    if (!pending) {
      return;
    }

    if (pending.projectName !== message.projectName) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCancelProject = null;
    pending.resolve();
  }

  private resolveCreateWorkspace(message: WorkspaceCreatedResponse): void {
    const pending = this.pendingCreateWorkspace;
    if (!pending) {
      return;
    }

    if (!workspaceIdsMatch(pending.expectedWorkspaceId, message.workspaceId)) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCreateWorkspace = null;
    pending.resolve();
  }

  private resolveDeleteProject(message: ProjectDeletedResponse): void {
    const pending = this.pendingDeleteProject;
    if (!pending) {
      return;
    }

    if (pending.projectName !== message.projectName) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingDeleteProject = null;
    pending.resolve();
  }

  private rejectPendingGithubRepoList(message: string): void {
    const pending = this.pendingGithubRepos;
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingGithubRepos = null;
    pending.reject(new Error(message));
  }

  private resolveOpenCodeRequest(message: OpenCodeResponse): void {
    const pending = this.pendingOpenCodeRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingOpenCodeRequests.delete(message.requestId);
    pending.resolve({
      requestId: message.requestId,
      status: message.status,
      headers: message.headers,
      bodyBase64: message.bodyBase64,
    });
  }

  private resolveOpenCodeStreamOpened(message: OpenCodeStreamOpenedResponse): void {
    const pending = this.pendingOpenCodeStreamOpen.get(message.requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingOpenCodeStreamOpen.delete(message.requestId);
    pending.resolve();
  }

  private handleOpenCodeStreamEvent(message: OpenCodeStreamEventResponse): void {
    const handler = this.openCodeStreamHandlers.get(message.requestId);
    if (!handler) {
      return;
    }

    handler({
      requestId: message.requestId,
      event: message.event,
      data: message.data,
      id: message.id,
    });
  }

  private handleOpenCodeStreamClosed(message: OpenCodeStreamClosedResponse): void {
    const pending = this.pendingOpenCodeStreamOpen.get(message.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingOpenCodeStreamOpen.delete(message.requestId);
      pending.reject(new Error('OpenCode stream closed before opening'));
    }
    this.openCodeStreamHandlers.delete(message.requestId);
  }

  private handleOpenCodeStreamError(message: OpenCodeStreamErrorResponse): void {
    const pending = this.pendingOpenCodeStreamOpen.get(message.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingOpenCodeStreamOpen.delete(message.requestId);
      this.openCodeStreamHandlers.delete(message.requestId);
      pending.reject(new Error(message.message));
      return;
    }

    this.openCodeStreamHandlers.delete(message.requestId);
    this.emit({ type: 'error', message: message.message });
  }

  private resolveOpenCodeRuntimeInfo(message: Extract<MachineToClientMessage, { type: 'opencode_runtime' }>): void {
    for (const [requestId, pending] of this.pendingOpenCodeRuntimeInfo) {
      if (!workspaceIdsMatch(pending.workspaceId, message.workspaceId)) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingOpenCodeRuntimeInfo.delete(requestId);
      pending.resolve({
        workspaceId: message.workspaceId,
        workspacePath: message.workspacePath,
        hostname: message.hostname,
        port: message.port,
        baseUrl: message.baseUrl,
        username: message.username,
        password: message.password,
        startedAt: new Date().toISOString(),
      });
      return;
    }
  }

  private rejectPendingOpenCodeRequests(message: string): void {
    for (const [requestId, pending] of this.pendingOpenCodeRequests) {
      clearTimeout(pending.timeout);
      this.pendingOpenCodeRequests.delete(requestId);
      pending.reject(new Error(message));
    }
  }

  private rejectPendingOpenCodeRuntimeInfo(message: string, workspaceId?: string): void {
    for (const [requestId, pending] of this.pendingOpenCodeRuntimeInfo) {
      if (workspaceId && !workspaceIdsMatch(pending.workspaceId, workspaceId)) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingOpenCodeRuntimeInfo.delete(requestId);
      pending.reject(new Error(message));
    }
  }

  private rejectPendingOpenCodeStreams(message: string): void {
    for (const [requestId, pending] of this.pendingOpenCodeStreamOpen) {
      clearTimeout(pending.timeout);
      this.pendingOpenCodeStreamOpen.delete(requestId);
      this.openCodeStreamHandlers.delete(requestId);
      pending.reject(new Error(message));
    }
  }

  private rejectPendingRemoteBranches(
    message: string,
    projectName?: string,
    force = false
  ): void {
    const pending = this.pendingRemoteBranches;
    if (!pending) {
      return;
    }

    if (!force && projectName && pending.projectName !== projectName) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRemoteBranches = null;
    pending.reject(new Error(message));
  }

  private rejectPendingLinearIssues(
    message: string,
    projectName?: string,
    force = false
  ): void {
    const pending = this.pendingLinearIssues;
    if (!pending) {
      return;
    }

    if (!force && projectName && pending.projectName !== projectName) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingLinearIssues = null;
    pending.reject(new Error(message));
  }

  private rejectPendingProjectCreate(
    message: string,
    projectName?: string,
    force = false
  ): void {
    const pending = this.pendingCreateProject;
    if (!pending) {
      return;
    }

    if (!force && projectName && pending.projectName !== projectName) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCreateProject = null;
    pending.reject(new Error(message));
  }

  private rejectPendingPrepareProject(
    message: string,
    projectName?: string,
    force = false
  ): void {
    const pending = this.pendingPrepareProject;
    if (!pending) {
      return;
    }

    if (!force && projectName && pending.projectName !== projectName) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingPrepareProject = null;
    pending.reject(new Error(message));
  }

  private rejectPendingCancelProject(
    message: string,
    projectName?: string,
    force = false
  ): void {
    const pending = this.pendingCancelProject;
    if (!pending) {
      return;
    }

    if (!force && projectName && pending.projectName !== projectName) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCancelProject = null;
    pending.reject(new Error(message));
  }

  private rejectPendingWorkspaceCreate(
    message: string,
    workspaceId?: string,
    projectName?: string,
    force = false
  ): void {
    const pending = this.pendingCreateWorkspace;
    if (!pending) {
      return;
    }

    if (!force && workspaceId && !workspaceIdsMatch(pending.expectedWorkspaceId, workspaceId)) {
      return;
    }

    if (!force && projectName && pending.projectName !== projectName) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCreateWorkspace = null;
    pending.reject(new Error(message));
  }

  private rejectPendingProjectDelete(
    message: string,
    projectName?: string,
    force = false
  ): void {
    const pending = this.pendingDeleteProject;
    if (!pending) {
      return;
    }

    if (!force && projectName && pending.projectName !== projectName) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingDeleteProject = null;
    pending.reject(new Error(message));
  }

  private resolveReplayAnsi(message: ReplayAnsiResponse): void {
    const pending = this.pendingReplayAnsi;
    if (!pending || pending.replayId !== message.replayId) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingReplayAnsi = null;
    pending.resolve(this.crypto.decodeBase64(message.data));
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

  private rejectPendingReplayAnsi(message: string, replayId?: string, force = false): void {
    const pending = this.pendingReplayAnsi;
    if (!pending) {
      return;
    }
    if (!force && replayId && pending.replayId !== replayId) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingReplayAnsi = null;
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

  private prunePendingEventChunks(nowMs = Date.now()): void {
    const ttlMs = 30_000;
    for (const [requestId, pending] of this.pendingEventChunks) {
      if (nowMs - pending.receivedAtMs > ttlMs) {
        this.pendingEventChunks.delete(requestId);
      }
    }
  }

  private handleEventsList(message: EventsListResponse): void {
    const totalChunks = message.totalChunks ?? 1;
    const chunkIndex = message.chunkIndex ?? 0;
    const requestId = message.requestId;

    if (!requestId || totalChunks <= 1) {
      this.emit({
        type: 'events',
        events: message.events,
        liveEventIds: message.liveEventIds,
        savedEventFilters: message.savedEventFilters,
      });
      return;
    }

    this.prunePendingEventChunks();

    const pending = this.pendingEventChunks.get(requestId) ?? {
      workspaceId: message.workspaceId,
      totalChunks,
      chunks: new Map<number, WideEvent[]>(),
      liveEventIds: message.liveEventIds,
      savedEventFilters: message.savedEventFilters,
      receivedAtMs: Date.now(),
    };

    pending.workspaceId = message.workspaceId;
    pending.totalChunks = totalChunks;
    pending.liveEventIds = message.liveEventIds;
    pending.savedEventFilters = message.savedEventFilters;
    pending.receivedAtMs = Date.now();
    pending.chunks.set(chunkIndex, message.events);
    this.pendingEventChunks.set(requestId, pending);

    if (pending.chunks.size < pending.totalChunks) {
      return;
    }

    const merged: WideEvent[] = [];
    for (let idx = 0; idx < pending.totalChunks; idx += 1) {
      const chunk = pending.chunks.get(idx);
      if (!chunk) {
        return;
      }
      merged.push(...chunk);
    }

    this.pendingEventChunks.delete(requestId);
    this.emit({
      type: 'events',
      events: merged,
      liveEventIds: pending.liveEventIds,
      savedEventFilters: pending.savedEventFilters,
    });
  }

  private handleSessionEvent(message: SessionEventMessage): void {
    if (message.type === 'kicked') {
      this.mode = 'browsing';
      this.attachedSessionId = null;
      this.emit({ type: 'detached' });
      return;
    }

    if (message.type === 'exited') {
      const sessionId = this.attachedSessionId;
      this.mode = 'browsing';
      this.attachedSessionId = null;
      if (sessionId) {
        this.emit({ type: 'session_exited', sessionId, exitCode: message.code });
      }
      return;
    }

    if (message.type === 'attached' && this.attachedSessionId) {
      this.emit({ type: 'attached', sessionId: this.attachedSessionId });
    }
  }

  private resolveBundleRefreshPlan(message: BundleRefreshPlanResponse): void {
    const pending = this.pendingBundleRefreshPlan;
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingBundleRefreshPlan = null;
    pending.resolve(message.plan);
  }

  private resolveBundleRefreshApply(_message: BundleRefreshAppliedResponse): void {
    const pending = this.pendingBundleRefreshApply;
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingBundleRefreshApply = null;
    pending.resolve();
  }

  private resolveBundleConfigState(message: BundleConfigStateResponse): void {
    const pending = this.pendingBundleConfigState;
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingBundleConfigState = null;
    pending.resolve(message.state);
  }

  private resolveBundleConfigUpdate(_message: BundleConfigUpdatedResponse): void {
    const pending = this.pendingBundleConfigUpdate;
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingBundleConfigUpdate = null;
    pending.resolve();
  }

  private rejectPendingBundleRefreshRequests(message: string): void {
    const error = new Error(message);

    if (this.pendingBundleRefreshPlan) {
      clearTimeout(this.pendingBundleRefreshPlan.timeout);
      this.pendingBundleRefreshPlan.reject(error);
      this.pendingBundleRefreshPlan = null;
    }

    if (this.pendingBundleRefreshApply) {
      clearTimeout(this.pendingBundleRefreshApply.timeout);
      this.pendingBundleRefreshApply.reject(error);
      this.pendingBundleRefreshApply = null;
    }

    if (this.pendingBundleConfigState) {
      clearTimeout(this.pendingBundleConfigState.timeout);
      this.pendingBundleConfigState.reject(error);
      this.pendingBundleConfigState = null;
    }

    if (this.pendingBundleConfigUpdate) {
      clearTimeout(this.pendingBundleConfigUpdate.timeout);
      this.pendingBundleConfigUpdate.reject(error);
      this.pendingBundleConfigUpdate = null;
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

  private resolveReviewRequest(message: ReviewResponse): void {
    const pending = this.pendingReviewRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingReviewRequests.delete(message.requestId);
    if (message.error) {
      pending.reject(
        new ReviewRequestError(
          message.error.message,
          message.error.code || 'REVIEW_FAILED',
          { op: pending.op, requestId: message.requestId }
        )
      );
    } else if (message.result) {
      pending.resolve(message.result);
    } else {
      pending.reject(
        new ReviewRequestError('Review response missing result', 'REVIEW_MISSING_RESULT', {
          op: pending.op,
          requestId: message.requestId,
        })
      );
    }
  }

  private rejectAllPendingReviewRequests(message: string): void {
    for (const [requestId, pending] of this.pendingReviewRequests) {
      clearTimeout(pending.timeout);
      pending.reject(
        new ReviewRequestError(message, 'REVIEW_FAILED', {
          op: pending.op,
          requestId,
        })
      );
      this.pendingReviewRequests.delete(requestId);
    }
  }

  private emitPtyData(data: Uint8Array): void {
    if (!this.ptyOutputHandler) {
      this.pendingPtyChunks.push(data);
      return;
    }

    const combined = this.pendingUtf8Bytes.length
      ? concatUint8Array([this.pendingUtf8Bytes, data])
      : data;

    const boundary = findUtf8Boundary(combined);
    if (boundary < combined.length) {
      this.pendingUtf8Bytes = combined.slice(boundary);
    } else {
      this.pendingUtf8Bytes = new Uint8Array(0);
    }

    const chunk = combined.slice(0, boundary);
    if (chunk.length > 0) {
      this.ptyOutputHandler(chunk);
    }
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

  private resolveConnect(): void {
    if (this.connectResolve) {
      this.connectResolve();
    }
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
  }

  private rejectConnect(error: Error): void {
    if (this.connectReject) {
      this.connectReject(error);
    }
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
  }

  private resetState(): void {
    this.isConnected = false;
    this.mode = 'browsing';
    this.attachedSessionId = null;
    this.handshakeState = null;
    this.sessionKeys = null;
    this.pendingPtyChunks = [];
    this.pendingUtf8Bytes = new Uint8Array(0);
    this.pendingEventChunks.clear();
    this.rejectPendingBundleRefreshRequests('Remote session disconnected');
    this.rejectPendingGithubRepoList('Remote session disconnected');
    this.rejectPendingRemoteBranches('Remote session disconnected', undefined, true);
    this.rejectPendingLinearIssues('Remote session disconnected', undefined, true);
    this.rejectPendingPrepareProject('Remote session disconnected', undefined, true);
    this.rejectPendingProjectCreate('Remote session disconnected', undefined, true);
    this.rejectPendingCancelProject('Remote session disconnected', undefined, true);
    this.rejectPendingWorkspaceCreate('Remote session disconnected', undefined, undefined, true);
    this.rejectPendingProjectDelete('Remote session disconnected', undefined, true);
    this.rejectPendingReplayAnsi('Remote session disconnected', undefined, true);
    this.rejectPendingReplayTimeline('Remote session disconnected', undefined, true);
    this.rejectPendingDismissReplay('Remote session disconnected', undefined, true);
    this.rejectPendingUndismissReplay('Remote session disconnected', undefined, true);
    this.rejectPendingWorkspaceDelete('DELETE_FAILED', 'Remote session disconnected', undefined, true);
    this.rejectPendingOpenCodeRuntimeInfo('Remote session disconnected');
    this.rejectPendingOpenCodeRequests('Remote session disconnected');
    this.rejectPendingOpenCodeStreams('Remote session disconnected');
    this.rejectAllPendingReviewRequests('Remote session disconnected');
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
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
    // Tunnel the permission response through the existing opencode_request bridge
    const resp = await this.requestOpenCode({
      workspaceId,
      method: 'POST',
      path: `/session/${encodeURIComponent(agentSessionId)}/permissions/${encodeURIComponent(permissionId)}`,
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from(JSON.stringify({ response })).toString('base64'),
    });
    try {
      return JSON.parse(Buffer.from(resp.bodyBase64 ?? '', 'base64').toString('utf8')) as boolean;
    } catch {
      return resp.status >= 200 && resp.status < 300;
    }
  }

  // ============================================================================
  // Agent session preferences — stored via requestOpenCode (relay-tunneled)
  // Note: Preferences for remote machines are stored locally in the client,
  // not on the remote machine, since they're UI state, not workspace state.
  // ============================================================================

  private remoteAgentPrefsCache: Record<string, string> = {};

  async getAgentSessionPreference(workspaceId: string): Promise<string | null> {
    return this.remoteAgentPrefsCache[workspaceId] ?? null;
  }

  async setAgentSessionPreference(workspaceId: string, sessionId: string): Promise<void> {
    this.remoteAgentPrefsCache[workspaceId] = sessionId;
    // Best-effort: also persist to localStorage if available (web context)
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`gssh:agent-session:${workspaceId}`, sessionId);
      }
    } catch { /* non-fatal */ }
  }
}
