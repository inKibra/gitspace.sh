import type {
  Session as TmuxSession,
  InboxItem,
  SessionCtrl,
  SessionEvent,
  Command as TmuxCommand,
  Response as TmuxResponse,
} from '../../lib/tmux-lite/protocol.js';
import {
  listSessions,
  cancelPrepareAttachSession,
  prepareAttachSession,
  ensureServer,
  getMachineSnapshot,
  createSession,
  killSession,
  createCheckpoint,
  getReplayMarkdown,
  send,
  watchMachineEvents,
  deleteTmuxWorkspace,
} from '../../lib/tmux-lite/cli.js';
import { MachineStateClient } from '../../machine/state/client.js';
import {
  machineSnapshotToAgentState,
  machineSnapshotToKnownAgentSessions,
  machineSnapshotToProjects,
  machineSnapshotToSessions,
  machineSnapshotToWorkspaces,
} from '../../machine/state/selectors.js';
import type { MachineSnapshot } from '../../lib/tmux-lite/machine/protocol.js';
import {
  listReplaysOffline,
  getReplaySnapshotOffline,
  getReplayTextOffline,
  getReplayFrameOffline,
  getReplayTimelineOffline,
  dismissReplayOffline,
  undismissReplayOffline,
} from '../../lib/tmux-lite/replay/service.js';
import {
  encodeControl,
  encodePTY,
  parseFrames,
  decodeControl,
  FrameType,
} from '../../lib/tmux-lite/protocol.js';
import { listProjectSummaries } from '../../core/project-catalog.js';
import { scanWorkspaces } from '../../lib/remote-session/workspace-scanner.js';
import { deleteWorkspaceCore } from '../../core/workspace.js';
import { prepareWorkspaceForSession } from '../../core/workspace-lifecycle.js';
import { getWorkspaceRoot } from '../../core/paths.js';
import { createBufferedSocketWriter } from '../../utils/bun-socket-writer.js';
import { AttachLifecycle } from './attach-lifecycle.js';
import {
  matchesWorkspaceId,
  resolveWorkspaceName,
  toCanonicalWorkspaceId,
} from '../../utils/workspace-id.js';
import type {
  AttachSessionParams,
  BackendDescriptor,
  CreateProjectParams,
  FinalizeProjectParams,
  PreparedProjectResult,
  CreateWorkspaceParams,
  DeleteProjectParams,
  DeleteWorkspaceParams,
  SessionBackend,
} from '../backend.js';
import type { BackendEvent } from '../events.js';
import type { NotificationConfig } from '../../notifications/types.js';
import type { BundleRefreshPlan, BundleRefreshSubmission } from '../../types/bundle-refresh.js';
import type { BundleConfigState, BundleConfigSubmission } from '../../types/bundle-config.js';
import type { ReviewOperation, ReviewResult } from '../../types/review.js';
import type { WideEventFilter } from '../../types/events.js';
import type { SessionLinearIssueSummary } from '../../types/lifecycle.js';
import { parseProcessSessionName } from '../../lib/processes/names.js';
import {
  SpacesError,
  WorkspaceDeleteError,
  type WorkspaceDeleteErrorCode,
} from '../../types/errors.js';
import type { TerminalSnapshot } from '../backend.js';
import type { AgentStateUpdateDelta, WorkspaceAgentState } from '../../lib/tmux-lite/agent-event-manager.js';
import type { AgentWorkspaceTargetPayload } from '../../lib/tmux-lite/protocol.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewRequestError } from '../../types/errors.js';
import { throwServiceStartError } from './service-start-error.js';

export interface LocalSessionBackendDependencies {
  listSessions: typeof listSessions;
  listReplays: typeof listReplaysOffline;
  ensureServer: typeof ensureServer;
  sendTmuxCommand: (command: TmuxCommand) => Promise<TmuxResponse>;
  createSession: typeof createSession;
  killSession: typeof killSession;
  createCheckpoint: typeof createCheckpoint;
  prepareAttachSession: typeof prepareAttachSession;
  cancelPrepareAttachSession: typeof cancelPrepareAttachSession;
  deleteTmuxWorkspace: typeof deleteTmuxWorkspace;
  getReplaySnapshot: typeof getReplaySnapshotOffline;
  getReplayText: typeof getReplayTextOffline;
  getReplayMarkdown: typeof getReplayMarkdown;
  getReplayFrame: typeof getReplayFrameOffline;
  getReplayTimeline: typeof getReplayTimelineOffline;
  getMachineSnapshot: typeof getMachineSnapshot;
  watchMachineEvents: typeof watchMachineEvents;
  dismissReplay: typeof dismissReplayOffline;
  undismissReplay: typeof undismissReplayOffline;
  listProjectSummaries: typeof listProjectSummaries;
  scanWorkspaces: typeof scanWorkspaces;
  deleteWorkspaceCore: typeof deleteWorkspaceCore;
  prepareWorkspaceForSession: typeof prepareWorkspaceForSession;
  connectSessionSocket: (
    socketPath: string,
    handlers: LocalSessionSocketHandlers
  ) => Promise<LocalSessionSocketConnection>;
  getInbox?: () => Promise<unknown>;
  clearInbox?: (id?: string) => Promise<void>;
  markInboxRead?: (id: string) => Promise<void>;
  getNotificationConfig?: () => unknown | Promise<unknown>;
  updateNotificationConfig?: (config: NotificationConfig) => unknown | Promise<unknown>;
}

export interface LocalSessionSocketHandlers {
  onPtyData: (data: Uint8Array) => void;
  onControl: (event: SessionEvent) => void;
  onClose: () => void;
  onError: (error: Error) => void;
}

export interface LocalSessionSocketConnection {
  sendControl: (control: SessionCtrl) => void;
  sendPty: (data: Uint8Array) => void;
  close: () => void;
}

export interface LocalSessionBackendOptions {
  descriptor?: BackendDescriptor;
  deps?: Partial<LocalSessionBackendDependencies>;
}

const DEFAULT_DESCRIPTOR: BackendDescriptor = {
  key: 'local',
  kind: 'local',
  label: 'Local',
};

function toSessionInfo(
  session: TmuxSession,
  workspaceId: string
): {
  id: string;
  name: string;
  workspaceId: string;
  attached: boolean;
  createdAt: number;
  processTitle?: string;
  terminalTitle?: string;
  lastAlertKind?: import('../../lib/tmux-lite/protocol.js').InboxItem['type'];
  lastAlertPreview?: string;
  lastAlertAt?: number;
  unreadAlertCount?: number;
  exitCode?: number;
  socketPath?: string;
  cwd?: string;
  pid?: number;
} {
  return {
    id: session.id,
    name: session.name,
    workspaceId,
    attached: session.attached,
    createdAt: session.createdAt,
    processTitle: session.processTitle,
    terminalTitle: session.terminalTitle,
    lastAlertKind: session.lastAlertKind,
    lastAlertPreview: session.lastAlertPreview,
    lastAlertAt: session.lastAlertAt,
    unreadAlertCount: session.unreadAlertCount,
    exitCode: session.exitCode,
    socketPath: session.socketPath,
    cwd: session.cwd,
    pid: session.pid,
  };
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new SpacesError(fallback, 'SYSTEM_ERROR', 2);
}

function toWorkspaceDeleteErrorCode(error: unknown): WorkspaceDeleteErrorCode | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  if (
    code === 'REMOVE_SCRIPT_FAILED' ||
    code === 'WORKSPACE_NOT_FOUND' ||
    code === 'WORKTREE_REMOVE_FAILED' ||
    code === 'DELETE_FAILED'
  ) {
    return code;
  }

  return undefined;
}

function getErrorCode(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return fallback;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : fallback;
}

function getDefaultTerminalSize(): { cols: number; rows: number } {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  return { cols, rows };
}


function isAttachRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Timed out attaching to session') ||
    message.includes('Local session socket closed') ||
    message.includes('Local session socket error') ||
    message.includes('Failed to connect to session')
  );
}

function toExitedSessionError(session: TmuxSession): Error {
  const suffix = typeof session.exitCode === 'number' ? ` (exit ${session.exitCode})` : '';
  return new SpacesError(`Session has already exited: ${session.name}${suffix}`, 'USER_ERROR', 1);
}

async function refreshHostingAfterProcessChange(): Promise<void> {
  try {
    const { refreshTmuxHosting } = await import('../../lib/tmux-lite/hosting/supervisor.js');
    await refreshTmuxHosting();
  } catch {
    // Process start/stop must still succeed even if hosted route publication fails.
  }
}

function isAgentReplay(replay: { sessionName: string }): boolean {
  return replay.sessionName.startsWith('agent:');
}

async function connectSessionSocket(
  socketPath: string,
  handlers: LocalSessionSocketHandlers
): Promise<LocalSessionSocketConnection> {
  let frameBuffer = Buffer.alloc(0);
  let closed = false;
  let writer: ReturnType<typeof createBufferedSocketWriter> | null = null;

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      drain() {
        writer?.flush();
      },
      data(_socket, data) {
        if (closed) {
          return;
        }

        let parseResult;
        frameBuffer = Buffer.concat([frameBuffer, Buffer.from(data)]);
        try {
          parseResult = parseFrames(frameBuffer);
        } catch (error) {
          frameBuffer = Buffer.alloc(0);
          handlers.onError(toError(error, 'Failed to parse local session frames'));
          return;
        }

        frameBuffer = Buffer.from(parseResult.remaining);

        for (const frame of parseResult.frames) {
          if (frame.type === FrameType.PTY) {
            handlers.onPtyData(new Uint8Array(frame.payload));
            continue;
          }

          if (frame.type !== FrameType.CONTROL) {
            continue;
          }

          try {
            const event = decodeControl(frame.payload) as SessionEvent;
            handlers.onControl(event);
          } catch (error) {
            handlers.onError(toError(error, 'Failed to decode local session control frame'));
          }
        }
      },
      close() {
        if (closed) {
          return;
        }
        closed = true;
        handlers.onClose();
      },
      error(_socket, error) {
        handlers.onError(toError(error, 'Local session socket error'));
      },
    },
  });

  writer = createBufferedSocketWriter(socket);

  return {
    sendControl: (control) => {
      if (closed || !writer) {
        return;
      }
      writer.write(encodeControl(control));
    },
    sendPty: (data) => {
      if (closed || !writer) {
        return;
      }
      writer.write(encodePTY(Buffer.from(data)));
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      socket.end();
    },
  };
}

function buildDeps(
  overrides?: Partial<LocalSessionBackendDependencies>
 ): LocalSessionBackendDependencies {
  return {
    listSessions,
    listReplays: listReplaysOffline,
    ensureServer,
    sendTmuxCommand: async (command) => {
      await ensureServer();
      return send(command);
    },
    createSession,
    killSession,
    createCheckpoint,
    prepareAttachSession,
    cancelPrepareAttachSession,
    deleteTmuxWorkspace,
    getReplaySnapshot: getReplaySnapshotOffline,
    getReplayText: getReplayTextOffline,
    getReplayMarkdown,
    getReplayFrame: getReplayFrameOffline,
    getReplayTimeline: getReplayTimelineOffline,
    getMachineSnapshot,
    watchMachineEvents,
    dismissReplay: dismissReplayOffline,
    undismissReplay: undismissReplayOffline,
    listProjectSummaries,
    scanWorkspaces,
    deleteWorkspaceCore,
    prepareWorkspaceForSession,
    connectSessionSocket,
    ...overrides,
  };
}


export class LocalSessionBackend implements SessionBackend {
  readonly descriptor: BackendDescriptor;
  private readonly deps: LocalSessionBackendDependencies;
  private readonly handlers = new Set<(event: BackendEvent) => void>();
  private connected = false;
  private attachedAgentSessionId: string | null = null;
  private readonly attachLifecycle = new AttachLifecycle((event) => {
    // Inject agentSessionId into attached events so the session engine knows
    // when an agent session is active (mirrors remote backend behavior).
    if (event.type === 'attached' && this.attachedAgentSessionId) {
      this.emit({ ...event, agentSessionId: this.attachedAgentSessionId });
      return;
    }
    if (event.type === 'detached' || event.type === 'session_exited') {
      this.attachedAgentSessionId = null;
    }
    this.emit(event);
  });
  private sessionSocket: LocalSessionSocketConnection | null = null;
  private sessionSocketSessionId: string | null = null;
  private sessionSocketGeneration = 0;
  private closingSessionSocket = false;
  private pendingAttachAbortController: AbortController | null = null;
  private pendingAttachRequestId: string | null = null;
  private agentStateCache: Record<string, WorkspaceAgentState> = {};
  private readonly agentStateHandlers = new Set<(delta: AgentStateUpdateDelta) => void>();
  private stopAgentWatch: (() => void) | null = null;
  private readonly machineStateClient = new MachineStateClient();

  constructor(options: LocalSessionBackendOptions = {}) {
    this.descriptor = options.descriptor ?? DEFAULT_DESCRIPTOR;
    this.deps = buildDeps(options.deps);
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

  async connect(): Promise<void> {
    await this.deps.ensureServer();
    try {
      const snapshot = await this.deps.getMachineSnapshot();
      this.machineStateClient.replaceSnapshot(snapshot);
      this.agentStateCache = machineSnapshotToAgentState(snapshot);
      this.stopAgentWatch?.();
      this.stopAgentWatch = await this.deps.watchMachineEvents({
        onSnapshot: (machineSnapshot) => {
          this.machineStateClient.replaceSnapshot(machineSnapshot);
          this.agentStateCache = machineSnapshotToAgentState(machineSnapshot);
          this.broadcastAgentSnapshot();
          this.emitDerivedMachineState();
        },
        onEvent: (event) => {
          const machineSnapshot = this.machineStateClient.applyEvent(event);
          this.agentStateCache = machineSnapshotToAgentState(machineSnapshot);
          this.broadcastAgentSnapshot();
          this.emitDerivedMachineState();
        },
      });

      // Block initial connection on full machine preload so the UI does not
      // briefly render an empty state and then hydrate later.
      this.emitDerivedMachineState();
      await this.requestInbox();
      await this.getNotificationConfig();
    } catch (error) {
      this.agentStateCache = {};
      this.stopAgentWatch = null;
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'error', message: `Failed to initialize agent state watch: ${message}` });
      throw error;
    }
    this.connected = true;
    this.emit({ type: 'status', status: 'connected' });
  }

  async disconnect(): Promise<void> {
    this.pendingAttachAbortController?.abort();
    this.pendingAttachAbortController = null;
    this.stopAgentWatch?.();
    this.stopAgentWatch = null;

    const wasAttached = this.attachLifecycle.isAttached;
    await this.closeSessionSocket(false);
    this.attachLifecycle.reset();
    this.attachedAgentSessionId = null;
    this.connected = false;
    this.emit({ type: 'status', status: 'disconnected' });
    if (wasAttached) {
      this.emit({ type: 'detached' });
    }
  }

  async listProjects(): Promise<void> {
    const projects = machineSnapshotToProjects(this.machineStateClient.getSnapshot());
    this.emit({ type: 'projects', projects });
  }

  async listGithubRepos(org?: string): Promise<string[]> {
    const response = await this.sendTmuxCommand({ type: 'github-repos', org });
    if (response.type === 'github-repos') return response.repos;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected GitHub repo response');
  }

  async listRemoteBranches(projectName: string): Promise<string[]> {
    const response = await this.sendTmuxCommand({ type: 'remote-branches', projectName });
    if (response.type === 'remote-branches') return response.branches;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected remote branches response');
  }

  async listLinearIssues(projectName: string): Promise<SessionLinearIssueSummary[]> {
    const response = await this.sendTmuxCommand({ type: 'linear-issues', projectName });
    if (response.type === 'linear-issues') return response.issues;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected linear issues response');
  }

  async listWorkspaces(): Promise<void> {
    const mappedWorkspaces = machineSnapshotToWorkspaces(this.machineStateClient.getSnapshot());

    this.emit({
      type: 'workspaces',
      workspaces: mappedWorkspaces,
    });
  }

  async setWorkspaceStatus(projectName: string, workspaceName: string, phase: import('../../types/config.js').WorkspacePhase): Promise<void> {
    const response = await this.sendTmuxCommand({ type: 'workspace-set-phase', projectName, workspaceName, phase });
    if (response.type === 'ok') {
      await this.listWorkspaces();
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected workspace phase response');
  }

  async listSessions(workspaceId?: string): Promise<void> {
    const filtered = machineSnapshotToSessions(this.machineStateClient.getSnapshot(), workspaceId);
    this.emit({ type: 'sessions', sessions: filtered });
  }

  async listReplays(workspaceId?: string, includeDismissed?: boolean): Promise<void> {
    const replays = await this.deps.listReplays({ workspaceId, includeDismissed });
    this.emit({ type: 'replays', replays: replays.filter((replay) => !isAgentReplay(replay)) });
  }

  async createCheckpoint(sessionId: string): Promise<void> {
    await this.deps.createCheckpoint(sessionId);
  }

  async getReplaySnapshot(replayId: string, atMs?: number, scrollbackLines?: number): Promise<TerminalSnapshot> {
    return this.deps.getReplaySnapshot(replayId, { atMs, scrollbackLines });
  }

  async getReplayText(
    replayId: string,
    atMs?: number,
    scrollbackLines?: number,
    includeScrollback?: boolean,
    trimTrailingBlankRows?: boolean,
  ): Promise<string> {
    return this.deps.getReplayText(replayId, {
      atMs,
      scrollbackLines,
      includeScrollback,
      trimTrailingBlankRows,
    });
  }

  async getReplayMarkdown(
    replayId: string,
    atMs?: number,
    scrollbackLines?: number,
    includeScrollback?: boolean,
    trimTrailingBlankRows?: boolean,
  ): Promise<string> {
    return this.deps.getReplayMarkdown(replayId, {
      atMs,
      scrollbackLines,
      includeScrollback,
      trimTrailingBlankRows,
    });
  }

  async getReplayFrame(replayId: string, target?: import('../backend.js').ReplayFrameTarget): Promise<import('../backend.js').ReplayFrame> {
    return this.deps.getReplayFrame(replayId, target);
  }

  async getReplayTimeline(replayId: string): Promise<import('../backend.js').ReplayTimeline> {
    return this.deps.getReplayTimeline(replayId);
  }

  async dismissReplay(replayId: string): Promise<void> {
    this.deps.dismissReplay(replayId);
  }

  async undismissReplay(replayId: string): Promise<void> {
    this.deps.undismissReplay(replayId);
  }

  async createProject(params: CreateProjectParams): Promise<void> {
    try {
      const response = await this.sendTmuxCommand({ type: 'project-create', ...params });
      if (response.type === 'project-created') return;
      if (response.type === 'error') throw new Error(response.message);
      throw new Error('Unexpected project create response');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: 'command_error',
        code: getErrorCode(error, 'CREATE_PROJECT_FAILED'),
        message,
      });
      throw error;
    }
  }

  async prepareProjectCreation(params: CreateProjectParams): Promise<PreparedProjectResult> {
    try {
      const response = await this.sendTmuxCommand({ type: 'project-prepare', ...params });
      if (response.type === 'project-prepared') return response.result;
      if (response.type === 'error') throw new Error(response.message);
      throw new Error('Unexpected project prepare response');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: 'command_error',
        code: getErrorCode(error, 'CREATE_PROJECT_FAILED'),
        message,
      });
      throw error;
    }
  }

  async finalizeProjectCreation(params: FinalizeProjectParams): Promise<void> {
    try {
      const response = await this.sendTmuxCommand({ type: 'project-finalize', ...params });
      if (response.type === 'project-created') return;
      if (response.type === 'error') throw new Error(response.message);
      throw new Error('Unexpected project finalize response');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: 'command_error',
        code: getErrorCode(error, 'CREATE_PROJECT_FAILED'),
        message,
      });
      throw error;
    }
  }

  async cancelProjectCreation(projectName: string): Promise<void> {
    try {
      const response = await this.sendTmuxCommand({ type: 'project-cancel', projectName });
      if (response.type === 'project-cancelled') return;
      if (response.type === 'error') throw new Error(response.message);
      throw new Error('Unexpected project cancel response');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: 'command_error',
        code: getErrorCode(error, 'CREATE_PROJECT_FAILED'),
        message,
      });
      throw error;
    }
  }

  async createWorkspace(params: CreateWorkspaceParams): Promise<void> {
    try {
      const response = await this.sendTmuxCommand({ type: 'workspace-create', ...params });
      if (response.type === 'workspace-created') return;
      if (response.type === 'error') throw new Error(response.message);
      throw new Error('Unexpected workspace create response');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: 'command_error',
        code: getErrorCode(error, 'CREATE_WORKSPACE_FAILED'),
        message,
      });
      throw error;
    }
  }

  async deleteProject(projectName: string, _params: DeleteProjectParams = {}): Promise<void> {
    try {
      const response = await this.sendTmuxCommand({ type: 'project-delete', projectName });
      if (response.type === 'project-deleted') return;
      if (response.type === 'error') throw new Error(response.message);
      throw new Error('Unexpected project delete response');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: 'command_error',
        code: getErrorCode(error, 'DELETE_PROJECT_FAILED'),
        message,
      });
      throw error;
    }
  }

  async attachSession(params: AttachSessionParams): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
    this.attachLifecycle.beginAttach({ viewOnly: params.viewOnly ?? false });

    let targetSession: TmuxSession | null = null;
    let targetWorkspaceId: string | null = null;

    if (params.sessionId) {
      const sessions = await this.deps.listSessions();
      targetSession = sessions.find((session) => session.id === params.sessionId) ?? null;
      if (!targetSession) {
        throw new SpacesError(`Session not found: ${params.sessionId}`, 'USER_ERROR', 1);
      }
      if (typeof targetSession.exitCode === 'number') {
        throw toExitedSessionError(targetSession);
      }
      // Resolve workspaceId from the machine snapshot for sessionId-based attach.
      // attachToSessionSocket() tears down any existing socket first, so keep the
      // resolved workspace separate and re-apply it for each attach attempt.
      const snapshotSession = this.machineStateClient.getSnapshot().terminalSessionsById[params.sessionId];
      targetWorkspaceId = snapshotSession?.workspaceId ?? null;
      this.attachLifecycle.beginAttach({ workspaceId: targetWorkspaceId, viewOnly: params.viewOnly ?? false });
    } else if (params.workspaceId) {
      targetWorkspaceId = params.workspaceId;
      this.attachLifecycle.beginAttach({ workspaceId: targetWorkspaceId, viewOnly: params.viewOnly ?? false });
      let currentPhase: 'pre' | 'setup' | 'select' = 'pre';
      try {
        const prepared = await this.deps.prepareAttachSession({
          workspaceId: params.workspaceId,
          sessionName: params.sessionName,
          command: params.command,
          args: params.args,
          env: params.env,
          scriptPolicy: params.scriptPolicy,
          viewOnly: params.viewOnly,
          onRequestId: (requestId) => {
            this.pendingAttachRequestId = requestId;
          },
          onScriptOutput: (event) => {
            currentPhase = event.phase;
            this.emitPtyData(Buffer.from(event.data, 'base64'));
            this.emit({ type: 'script_output', phase: event.phase, data: Buffer.from(event.data, 'base64'), done: event.done, error: event.error });
          },
        });
        targetSession = prepared.session;
        targetWorkspaceId = prepared.workspaceId ?? targetWorkspaceId;
        this.attachLifecycle.updateAttachContext({ workspaceId: targetWorkspaceId, viewOnly: params.viewOnly ?? false });
        this.pendingAttachRequestId = null;
      } catch (error) {
        this.pendingAttachRequestId = null;
        const typedError = error instanceof Error ? error as Error & { code?: string } : undefined;
        if (!params.command) {
          this.emit({
            type: 'script_output',
            phase: currentPhase,
            data: new Uint8Array(0),
            done: true,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (typedError?.code) {
          this.emit({
            type: 'command_error',
            code: typedError.code,
            message: typedError.message,
          });
        }
        throw error;
      }
    } else {
      throw new SpacesError('attachSession requires sessionId or workspaceId', 'USER_ERROR', 1);
    }

    await this.attachToSessionSocketWithRetry(targetSession, params, targetWorkspaceId);
  }

  async detachSession(): Promise<void> {
    if (this.sessionSocket) {
      this.sessionSocket.sendControl({ type: 'detach' });
    }

    await this.closeSessionSocket(true);
  }

  async cancelPendingScripts(): Promise<void> {
    if (this.pendingAttachRequestId) {
      await this.deps.cancelPrepareAttachSession(this.pendingAttachRequestId).catch(() => undefined);
      this.pendingAttachRequestId = null;
    }
    this.pendingAttachAbortController?.abort();
  }

  async writePtyData(data: Uint8Array): Promise<void> {
    if (this.attachLifecycle.currentViewOnly) {
      return;
    }
    const socket = this.sessionSocket;
    if (!socket || !this.attachLifecycle.sessionId) {
      throw new SpacesError('No attached local session', 'SYSTEM_ERROR', 2);
    }
    socket.sendPty(data);
  }

  async resizePty(cols: number, rows: number): Promise<void> {
    const socket = this.sessionSocket;
    if (!socket || !this.attachLifecycle.sessionId) {
      throw new SpacesError('No attached local session', 'SYSTEM_ERROR', 2);
    }
    socket.sendControl({ type: 'resize', cols, rows });
  }

  async killSession(sessionId: string): Promise<void> {
    const response = await this.sendTmuxCommand({ type: 'kill', id: sessionId });
    if (response.type === 'ok') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected kill session response');
  }

  async deleteWorkspace(
    projectName: string,
    workspaceId: string,
    params: DeleteWorkspaceParams = {}
  ): Promise<void> {
    const resolvedWorkspaceId = resolveWorkspaceName(projectName, workspaceId);
    try {
      await this.deps.deleteTmuxWorkspace({
        projectName,
        workspaceId: resolvedWorkspaceId,
        scriptPolicy: params.scriptPolicy,
        onScriptOutput: (event) => {
          const data = Buffer.from(event.data, 'base64');
          this.emitPtyData(data);
          this.emit({ type: 'script_output', phase: 'remove', data, done: event.done, error: event.error });
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = toWorkspaceDeleteErrorCode(error) ?? 'DELETE_FAILED';
      this.emit({ type: 'command_error', code: errorCode, message });
      if (!(error instanceof WorkspaceDeleteError)) {
        throw new WorkspaceDeleteError(message, errorCode);
      }
      throw error;
    }
  }

  async getBundleRefreshPlan(projectName: string, workspaceId: string): Promise<BundleRefreshPlan> {
    const response = await this.sendTmuxCommand({ type: 'bundle-refresh-plan', projectName, workspaceId });
    if (response.type === 'bundle-refresh-plan') return response.plan;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected bundle refresh plan response');
  }

  async applyBundleRefresh(
    projectName: string,
    workspaceId: string,
    submission: BundleRefreshSubmission
  ): Promise<void> {
    const response = await this.sendTmuxCommand({ type: 'bundle-refresh-apply', projectName, workspaceId, submission });
    if (response.type === 'bundle-refresh-applied') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected bundle refresh apply response');
  }

  async getBundleConfigState(projectName: string, workspaceId: string): Promise<BundleConfigState> {
    const response = await this.sendTmuxCommand({ type: 'bundle-config-state', projectName, workspaceId });
    if (response.type === 'bundle-config-state') return response.state;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected bundle config state response');
  }

  async applyBundleConfigUpdate(
    projectName: string,
    workspaceId: string,
    submission: BundleConfigSubmission
  ): Promise<void> {
    const response = await this.sendTmuxCommand({ type: 'bundle-config-apply', projectName, workspaceId, submission });
    if (response.type === 'bundle-config-applied') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected bundle config apply response');
  }

  async sendReviewRequest(operation: ReviewOperation): Promise<ReviewResult> {
    const response = await this.sendTmuxCommand({ type: 'review-request', requestId: crypto.randomUUID(), operation });
    if (response.type === 'review-response') {
      if (response.error) {
        throw new ReviewRequestError(response.error.message, response.error.code, { op: operation.op, requestId: response.requestId });
      }
      if (!response.result) {
        throw new ReviewRequestError('Missing review result', 'REVIEW_FAILED', { op: operation.op, requestId: response.requestId });
      }
      return response.result;
    }
    if (response.type === 'error') {
      throw new ReviewRequestError(response.message, 'REVIEW_FAILED', { op: operation.op });
    }
    throw new ReviewRequestError('Unexpected review response', 'REVIEW_FAILED', { op: operation.op });
  }

  async requestInbox(): Promise<void> {
    const [response, sessions, workspaces] = await Promise.all([
      this.sendTmuxCommand({ type: 'inbox' }),
      this.deps.listSessions(),
      this.deps.scanWorkspaces(),
    ]);
    if (response.type !== 'inbox') {
      if (response.type === 'error') throw new Error(response.message);
      throw new Error('Unexpected inbox response');
    }

    const items = response.items as InboxItem[];
    const activeSessionIds = new Set(sessions.map((session) => session.id));
    const activeUnread = new Set<string>();
    for (const item of items) {
      if (!item.read && activeSessionIds.has(item.sessionId)) {
        activeUnread.add(item.sessionId);
      }
    }

    this.emit({
      type: 'inbox',
      items,
      unreadCount: activeUnread.size,
    });

    const filtered = this.convertSessionsToInfo(sessions, workspaces, undefined);
    this.emit({ type: 'sessions', sessions: filtered });
  }

  private convertSessionsToInfo(
    sessions: TmuxSession[],
    workspaces: Awaited<ReturnType<typeof scanWorkspaces>>,
    workspaceId?: string
  ): import('../../lib/remote-session/protocol.js').SessionInfo[] {
    const workspaceByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]));
    return sessions
      .filter((session) => !(session.hidden || session.kind === 'agent'))
      .map((session) => {
        const parsed = parseProcessSessionName(session.name);
        let workspace = workspaceByPath.get(session.cwd);
        if (!workspace && parsed) {
          workspace = workspaces.find((w) => w.id === parsed.workspaceId);
        }
        if (!workspace) {
          workspace = workspaces.find((w) => session.cwd.startsWith(w.path));
        }
        const id = workspace ? toCanonicalWorkspaceId(workspace) : (parsed?.workspaceId ? `unknown:${parsed.workspaceId}` : 'unknown');
        const info = toSessionInfo(session, id);
        return {
          ...info,
          processName: parsed?.processName,
          processInstance: parsed?.instance,
        };
      })
      .filter((session) => {
        if (!workspaceId) return true;
        return session.workspaceId === workspaceId || session.workspaceId.endsWith(`:${workspaceId}`);
      });
  }


  async clearInbox(id?: string): Promise<void> {
    const response = await this.sendTmuxCommand({ type: 'inbox-clear', id });
    if (response.type === 'ok') {
      await this.requestInbox();
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected inbox clear response');
  }

  async markInboxRead(id: string): Promise<void> {
    const response = await this.sendTmuxCommand({ type: 'inbox-read', id });
    if (response.type === 'ok') {
      await this.requestInbox();
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected inbox read response');
  }

  async getNotificationConfig(): Promise<void> {
    const response = await this.sendTmuxCommand({ type: 'notification-config-get' });
    if (response.type === 'notification-config') {
      this.emit({ type: 'notification_config', config: response.config });
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected notification config response');
  }

  async updateNotificationConfig(config: NotificationConfig): Promise<void> {
    const response = await this.sendTmuxCommand({ type: 'notification-config-update', config });
    if (response.type === 'notification-config') {
      this.emit({ type: 'notification_config', config: response.config });
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected notification config update response');
  }

  async startProcess(workspaceId: string, processName: string, instance?: number): Promise<void> {
    const response = await this.sendTmuxCommand({
      type: 'service-start',
      workspaceId,
      processName,
      instance,
    });
    if (response.type === 'service-started') {
      await refreshHostingAfterProcessChange();
      this.emit({
        type: 'process_started',
        workspaceId: response.workspaceId,
        processName: response.processName,
        sessionId: response.sessionId,
        sessionIds: response.sessionIds,
      });
      return;
    }
    if (response.type === 'error') throwServiceStartError(response);
    throw new Error('Unexpected tmux service start response');
  }

  async stopProcess(workspaceId: string, processName: string): Promise<void> {
    const response = await this.sendTmuxCommand({
      type: 'service-stop',
      workspaceId,
      processName,
    });
    if (response.type === 'service-stopped') {
      await refreshHostingAfterProcessChange();
      this.emit({
        type: 'process_stopped',
        workspaceId: response.workspaceId,
        processName: response.processName,
      });
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected tmux service stop response');
  }

  async requestEvents(
    workspacePath: string,
    filter?: WideEventFilter,
    limit?: number,
    sinceMs?: number,
  ): Promise<void> {
    const response = await this.sendTmuxCommand({ type: 'events-request', workspacePath, filter, limit, sinceMs });
    if (response.type === 'events-list') {
      this.emit({ type: 'events', events: response.events, liveEventIds: response.liveEventIds, savedEventFilters: response.savedEventFilters ?? [] });
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected events response');
  }

  private processSchedulers = new Map<string, NodeJS.Timer>();

  private async attachToSessionSocket(
    session: TmuxSession,
    params: AttachSessionParams,
    workspaceId: string | null,
  ): Promise<void> {
    await this.closeSessionSocket(true, { preserveWorkspaceId: true });
    this.attachLifecycle.beginAttach({ workspaceId, viewOnly: params.viewOnly ?? false });

    const size = getDefaultTerminalSize();
    const cols = params.cols ?? size.cols;
    const rows = params.rows ?? size.rows;
    const expectedSessionId = session.id;
    const expectedGeneration = ++this.sessionSocketGeneration;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      const timeout = setTimeout(() => {
        settleReject(new SpacesError(`Timed out attaching to session ${session.name}`, 'SYSTEM_ERROR', 2));
      }, 15000);

      void (async () => {
        try {
          const connection = await this.deps.connectSessionSocket(session.socketPath, {
            onPtyData: (data) => {
              if (
                this.sessionSocketGeneration !== expectedGeneration ||
                this.sessionSocketSessionId !== expectedSessionId
              ) {
                return;
              }
              this.attachLifecycle.pushPtyData(data);
            },
            onControl: (event) => {
              if (
                this.sessionSocketGeneration !== expectedGeneration ||
                this.sessionSocketSessionId !== expectedSessionId
              ) {
                return;
              }
              if (event.type === 'attached') {
                this.attachLifecycle.confirmAttached({
                  sessionId: session.id,
                  sessionName: session.name,
                  workspaceId: this.attachLifecycle.workspaceId,
                  viewOnly: this.attachLifecycle.currentViewOnly,
                  meta: {
                    sessionName: session.name,
                    processTitle: session.processTitle ?? null,
                    terminalTitle: session.terminalTitle ?? null,
                    lastAlertKind: session.lastAlertKind ?? null,
                    lastAlertPreview: session.lastAlertPreview ?? null,
                    lastAlertAt: session.lastAlertAt ?? null,
                    unreadAlertCount: session.unreadAlertCount ?? null,
                  },
                });
                settleResolve();
                return;
              }
              this.handleSessionControl(event, session.id);
            },
            onClose: () => {
              if (
                this.sessionSocketGeneration !== expectedGeneration ||
                this.sessionSocketSessionId !== expectedSessionId
              ) {
                return;
              }
              if (this.closingSessionSocket) {
                this.closingSessionSocket = false;
                return;
              }

              this.sessionSocket = null;
              this.sessionSocketSessionId = null;

              if (!settled) {
                this.attachLifecycle.clearAttachment({ preserveWorkspaceId: true, preserveViewOnly: true });
                settleReject(new SpacesError(`Local session socket closed: ${session.name}`, 'SYSTEM_ERROR', 2));
                return;
              }

              this.attachLifecycle.clearAttachment({ emitDetached: true });
            },
            onError: (error) => {
              this.emit({ type: 'error', message: error.message });
              settleReject(error);
            },
          });

          this.sessionSocket = connection;
          this.sessionSocketSessionId = expectedSessionId;
          connection.sendControl({ type: 'attach-init', cols, rows, clientType: 'cli' });
        } catch (error) {
          settleReject(toError(error, `Failed to connect to session ${session.name}`));
        }
      })();
    });
  }

  private async attachToSessionSocketWithRetry(
    session: TmuxSession,
    params: AttachSessionParams,
    workspaceId: string | null,
  ): Promise<void> {
    try {
      await this.attachToSessionSocket(session, params, workspaceId);
      return;
    } catch (error) {
      if (!isAttachRetryableError(error)) {
        throw error;
      }
    }

    const latestSessions = await this.deps.listSessions();
    const refreshed = latestSessions.find((item) => item.id === session.id) ?? session;

    if (typeof refreshed.exitCode === 'number') {
      throw toExitedSessionError(refreshed);
    }

    await this.attachToSessionSocket(refreshed, params, workspaceId);
  }

  private async closeSessionSocket(emitDetached: boolean, options: { preserveWorkspaceId?: boolean } = {}): Promise<void> {
    const socket = this.sessionSocket;

    // Invalidate any stale socket callbacks from earlier connections.
    this.sessionSocketGeneration += 1;

    if (socket) {
      this.closingSessionSocket = true;
      socket.close();
      this.sessionSocket = null;
      this.sessionSocketSessionId = null;
    }

    this.attachLifecycle.clearAttachment({
      emitDetached,
      preserveWorkspaceId: options.preserveWorkspaceId ?? false,
      preserveViewOnly: options.preserveWorkspaceId ?? false,
    });
  }

  private handleSessionControl(event: SessionEvent, sessionId: string): void {
    if (event.type === 'kicked') {
      void this.closeSessionSocket(true);
      return;
    }

    if (event.type === 'exited') {
      const exitCode = typeof event.code === 'number' ? event.code : undefined;
      this.attachLifecycle.emitExited(exitCode, sessionId);
      void this.closeSessionSocket(false);
      return;
    }

    if (event.type === 'session-meta') {
      this.attachLifecycle.emitSessionMeta({
        sessionName: event.sessionName ?? null,
        processTitle: event.processTitle ?? null,
        terminalTitle: event.terminalTitle ?? null,
        lastAlertKind: event.lastAlertKind ?? null,
        lastAlertPreview: event.lastAlertPreview ?? null,
        lastAlertAt: event.lastAlertAt ?? null,
        unreadAlertCount: event.unreadAlertCount ?? null,
      });
    }
  }

  private async resolveWorkspace(
    projectName: string,
    workspaceId: string
  ): Promise<{ id: string; path: string }> {
    const resolvedWorkspaceId = resolveWorkspaceName(projectName, workspaceId);
    const workspaces = await this.deps.scanWorkspaces();
    const workspace = workspaces.find(
      (item) =>
        item.projectName === projectName &&
        (item.id === resolvedWorkspaceId || matchesWorkspaceId(item, workspaceId))
    );

    if (!workspace) {
      throw new SpacesError(`Workspace not found: ${workspaceId}`, 'USER_ERROR', 1);
    }

    return {
      id: toCanonicalWorkspaceId(workspace),
      path: workspace.path,
    };
  }

  private async resolveAgentWorkspaceTarget(workspaceId: string): Promise<AgentWorkspaceTargetPayload> {
    const workspaces = await this.deps.scanWorkspaces();
    const workspace = workspaces.find((item) => matchesWorkspaceId(item, workspaceId));
    if (!workspace) {
      throw new SpacesError(`Workspace not found: ${workspaceId}`, 'USER_ERROR', 1);
    }
    return {
      workspaceId: toCanonicalWorkspaceId(workspace),
      workspaceName: workspace.id,
      workspacePath: workspace.path,
      projectName: workspace.projectName,
    };
  }

  private emitPtyData(data: Uint8Array): void {
    this.attachLifecycle.pushPtyData(data);
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

  private broadcastAgentSnapshot(): void {
    const delta: AgentStateUpdateDelta = { type: 'agent_state_snapshot', workspaces: this.agentStateCache };
    for (const handler of this.agentStateHandlers) {
      handler(delta);
    }
  }

  private async refreshMachineSnapshotState(): Promise<MachineSnapshot> {
    const snapshot = await this.deps.getMachineSnapshot();
    this.machineStateClient.replaceSnapshot(snapshot);
    this.agentStateCache = machineSnapshotToAgentState(snapshot);
    this.broadcastAgentSnapshot();
    this.emitDerivedMachineState();
    return snapshot;
  }

  // ============================================================================
  // Agent state — backed by tmux-lite tmux commands + machine snapshots
  // ============================================================================

  private async sendTmuxCommand(command: TmuxCommand): Promise<TmuxResponse> {
    return this.deps.sendTmuxCommand(command);
  }

  subscribeAgentState(handler: (delta: AgentStateUpdateDelta) => void): () => void {
    this.agentStateHandlers.add(handler);
    return () => {
      this.agentStateHandlers.delete(handler);
    };
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
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({
      type: 'agent-permission',
      target,
      agentSessionId,
      permissionId,
      response,
    });
    if (tmuxResponse.type === 'agent-bool') return tmuxResponse.ok;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected agent permission response');
  }

  async getKnownAgentSessions(workspaceId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    return machineSnapshotToKnownAgentSessions(this.machineStateClient.getSnapshot(), workspaceId, { includeArchived: true });
  }

  async listAgentSessions(workspaceId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-sessions', target, mode: 'live' });
    if (response.type === 'agent-sessions') return response.sessions;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent sessions response');
  }

  async createAgentSession(workspaceId: string, title?: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-create', target, title });
    if (response.type === 'agent-sessions') {
      await this.refreshMachineSnapshotState();
      return response.sessions;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent create response');
  }

  async abortAgentSession(workspaceId: string, agentSessionId: string): Promise<boolean> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-abort', target, agentSessionId });
    if (response.type === 'agent-bool') {
      await this.refreshMachineSnapshotState();
      return response.ok;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent abort response');
  }

  async closeAgentSession(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-close', target, agentSessionId });
    if (response.type === 'agent-sessions') {
      await this.refreshMachineSnapshotState();
      return response.sessions;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent close response');
  }

  async archiveAgentSession(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-archive', target, agentSessionId });
    if (response.type === 'agent-sessions') {
      await this.refreshMachineSnapshotState();
      return response.sessions;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent archive response');
  }

  async restoreAgentSession(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-restore', target, agentSessionId });
    if (response.type === 'agent-sessions') {
      await this.refreshMachineSnapshotState();
      return response.sessions;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent restore response');
  }

  async attachAgentSession(workspaceId: string, agentSessionId: string, options: { viewOnly?: boolean; cols?: number; rows?: number } = {}): Promise<void> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-attach', target, agentSessionId, cols: options.cols, rows: options.rows });
    if (response.type !== 'session') {
      if (response.type === 'error') throw new Error(response.message);
      throw new Error('Unexpected agent attach response');
    }
    this.attachedAgentSessionId = agentSessionId;
    try {
      await this.refreshMachineSnapshotState();
      await this.attachSession({ sessionId: response.session.id, workspaceId, viewOnly: options.viewOnly, cols: options.cols, rows: options.rows });
    } catch (error) {
      this.attachedAgentSessionId = null;
      throw error;
    }
  }

  async promptAgentSession(workspaceId: string, agentSessionId: string, text: string, images?: import('../../lib/tmux-lite/protocol.js').AgentPromptImage[]): Promise<void> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-prompt', target, agentSessionId, text, images });
    if (response.type === 'ok') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error(`Unexpected prompt response: ${response.type}`);
  }

  async stageUpload(workspaceId: string, fileName: string, data: string, mimeType: string): Promise<{ stagedPath: string }> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-stage-upload', target, fileName, data, mimeType });
    if (response.type === 'agent-staged') return { stagedPath: response.stagedPath };
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected stage upload response');
  }

  async sendDialogResponse(dialogId: string, dialogType: 'select' | 'confirm' | 'input' | 'editor', value: string | boolean | undefined): Promise<void> {
    const response = await this.sendTmuxCommand({ type: 'agent-dialog-response', dialogId, dialogType, value });
    if (response.type === 'agent-bool') {
      if (response.ok) return;
      throw new Error(`Dialog is no longer pending: ${dialogId}`);
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected dialog response acknowledgement');
  }

  // ============================================================================
  // Agent session preferences — persisted to ~/.gitspace/.agent-sessions.json
  // ============================================================================

  private get agentPrefsPath(): string {
    return join(getWorkspaceRoot(), '.agent-sessions.json');
  }

  private agentPrefsCache: Record<string, string> | null = null;

  private async loadAgentPrefs(): Promise<Record<string, string>> {
    if (this.agentPrefsCache) return this.agentPrefsCache;
    try {
      const raw = await readFile(this.agentPrefsPath, 'utf8');
      this.agentPrefsCache = JSON.parse(raw) as Record<string, string>;
    } catch {
      this.agentPrefsCache = {};
    }
    return this.agentPrefsCache!;
  }

  private async saveAgentPrefs(prefs: Record<string, string>): Promise<void> {
    this.agentPrefsCache = prefs;
    try {
      await mkdir(join(this.agentPrefsPath, '..'), { recursive: true });
      await writeFile(this.agentPrefsPath, JSON.stringify(prefs, null, 2), 'utf8');
    } catch {
      // Non-fatal — preference persistence is best-effort
    }
  }

  async getAgentSessionPreference(workspaceId: string): Promise<string | null> {
    const prefs = await this.loadAgentPrefs();
    return prefs[workspaceId] ?? null;
  }

  async setAgentSessionPreference(workspaceId: string, sessionId: string): Promise<void> {
    const prefs = await this.loadAgentPrefs();
    prefs[workspaceId] = sessionId;
    await this.saveAgentPrefs(prefs);
  }

  async listAgentCommands(workspaceId: string): Promise<Array<{ name: string; description: string; kind: 'file' | 'custom' | 'extension' }>> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-list-commands', target });
    if (response.type === 'agent-commands') return response.commands;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected list commands response');
  }

  async getFileSuggestions(workspaceId: string, prefix: string, limit?: number): Promise<Array<{ path: string; isDirectory: boolean }>> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-file-suggestions', target, prefix, limit });
    if (response.type === 'agent-file-suggestions') return response.suggestions;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected file suggestions response');
  }
}
