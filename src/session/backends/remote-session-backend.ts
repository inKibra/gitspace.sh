import type { Identity, SessionKeys } from '../../types/identity.js';
import {
  parseRemoteMessage,
  type ApplyBundleRefreshRequest,
  type AttachSessionRequest,
  type BundleRefreshAppliedResponse,
  type BundleRefreshPlanResponse,
  type ClearInboxRequest,
  type ClientToMachineMessage,
  type DeleteWorkspaceRequest,
  type GetEventsRequest,
  type GetInboxRequest,
  type GetBundleRefreshPlanRequest,
  type GetNotificationConfigRequest,
  type KillSessionRequest,
  type ListProjectsRequest,
  type ListSessionsRequest,
  type ListWorkspacesRequest,
  type MachineToClientMessage,
  type MarkInboxReadRequest,
  type ReviewRequest,
  type ReviewResponse,
  type ScriptOutputResponse,
  type SessionCtrl,
  type StartProcessRequest,
  type StopProcessRequest,
  type UpdateNotificationConfigRequest,
} from '../../lib/remote-session/protocol.js';
import type { BundleRefreshPlan, BundleRefreshSubmission } from '../../types/bundle-refresh.js';
import type { ReviewOperation, ReviewResult } from '../../types/review.js';
import type { WideEventFilter } from '../../types/events.js';
import { findUtf8Boundary } from '../../utils/utf8.js';
import type { NotificationConfig } from '../../notifications/types.js';
import {
  ReviewRequestError,
  WorkspaceDeleteError,
  type WorkspaceDeleteErrorCode,
} from '../../types/errors.js';
import type {
  AttachSessionParams,
  BackendDescriptor,
  DeleteWorkspaceParams,
  SessionBackend,
} from '../backend.js';
import type { BackendEvent } from '../events.js';

const DEFAULT_CONTROL_STREAM_ID = 1;
const DEFAULT_DELETE_WORKSPACE_TIMEOUT_MS = 30000;

interface RelayDataMessage {
  type: 'data';
  data: string;
}

type RelayConnectMessage =
  | {
      type: 'connect_with_invite';
      inviteId: string;
      clientIdentityId: string;
    }
  | {
      type: 'connect_to_machine';
      machineId: string;
      clientIdentityId: string;
    };

interface HandshakeEnvelope {
  type: 'handshake';
  phase: string;
  data: unknown;
}

type AuthorizationPayload =
  | { type: 'invite'; inviteToken: string }
  | { type: 'access_list' };

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

export interface RemoteSessionSocketHandlers {
  onOpen: () => void;
  onClose: () => void;
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
    authorization: AuthorizationPayload
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
  inviteId?: string;
  inviteToken?: string;
  signer: <T extends object>(message: T, identity: Identity) => T;
  crypto: RemoteSessionCryptoAdapter;
  handshake: RemoteSessionHandshakeAdapter<THandshakeState, TServerHello, TServerAuth>;
}

const MACHINE_TO_CLIENT_TYPES = new Set<string>([
  'workspace_list',
  'session_list',
  'attached',
  'detached',
  'session_exited',
  'error',
  'project_list',
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
  'review_response',
  'events_list',
  'process_started',
  'process_stopped',
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
  implements SessionBackend {
  readonly descriptor: BackendDescriptor;

  private readonly socket: TSocket;
  private readonly socketAdapter: RemoteSessionSocketAdapter<TSocket>;
  private readonly identity: Identity;
  private readonly machineId: string;
  private readonly inviteId?: string;
  private readonly inviteToken?: string;
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
  private pendingDeleteWorkspace:
    | {
        workspaceId: string;
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
  private ptyOutputHandler: ((data: Uint8Array) => void) | null = null;
  private pendingPtyChunks: Uint8Array[] = [];
  private pendingUtf8Bytes = new Uint8Array(0);

  constructor(options: RemoteSessionBackendOptions<TSocket, THandshakeState, TServerHello, TServerAuth>) {
    this.descriptor = options.descriptor;
    this.socket = options.socket;
    this.socketAdapter = options.socketAdapter;
    this.identity = options.identity;
    this.machineId = options.machineId;
    this.inviteId = options.inviteId;
    this.inviteToken = options.inviteToken;
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

  async listWorkspaces(): Promise<void> {
    const command: ListWorkspacesRequest = { type: 'list_workspaces' };
    await this.sendCommand(command);
  }

  async listSessions(workspaceId?: string): Promise<void> {
    const command: ListSessionsRequest = { type: 'list_sessions', workspaceId };
    await this.sendCommand(command);
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

  async startProcess(workspaceId: string, processName: string): Promise<void> {
    const command: StartProcessRequest = {
      type: 'start_process',
      workspaceId,
      processName,
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
      onClose: () => {
        this.rejectConnect(new Error('Socket closed before handshake completed'));
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
        this.rejectPendingWorkspaceDelete('DELETE_FAILED', error.message);
        this.rejectAllPendingReviewRequests(error.message);
        this.emit({ type: 'status', status: 'error', error: error.message });
      },
    });

    this.listenersAttached = true;
  }

  private sendRelayConnectMessage(): void {
    const relayMessage: RelayConnectMessage = this.inviteId
      ? {
          type: 'connect_with_invite',
          inviteId: this.inviteId,
          clientIdentityId: this.identity.id,
        }
      : {
          type: 'connect_to_machine',
          machineId: this.machineId,
          clientIdentityId: this.identity.id,
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

      const authorization: AuthorizationPayload = this.inviteToken
        ? { type: 'invite', inviteToken: this.inviteToken }
        : { type: 'access_list' };

      const auth = this.handshake.createClientAuth(nextState, this.identity, authorization);
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
      case 'review_response': {
        this.resolveReviewRequest(message);
        return;
      }
      case 'events_list':
        this.emit({
          type: 'events',
          events: message.events,
          liveEventIds: message.liveEventIds,
        });
        return;
      case 'process_started':
        this.emit({
          type: 'process_started',
          workspaceId: message.workspaceId,
          processName: message.processName,
          sessionId: message.sessionId,
        });
        return;
      case 'process_stopped':
        this.emit({
          type: 'process_stopped',
          workspaceId: message.workspaceId,
          processName: message.processName,
        });
        return;
      case 'error':
        this.rejectPendingBundleRefreshRequests(message.message);
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
    this.rejectPendingBundleRefreshRequests('Remote session disconnected');
    this.rejectPendingWorkspaceDelete('DELETE_FAILED', 'Remote session disconnected', undefined, true);
    this.rejectAllPendingReviewRequests('Remote session disconnected');
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
  }
}
