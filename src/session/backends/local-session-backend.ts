import type {
  Session as TmuxSession,
  InboxItem,
  SessionCtrl,
  SessionEvent,
} from '../../lib/tmux-lite/protocol.js';
import {
  listSessions,
  cancelPrepareAttachSession,
  clearTmuxInbox,
  getTmuxInbox,
  getTmuxNotificationConfig,
  getTmuxBundleConfigState,
  getTmuxBundleRefreshPlan,
  killTmuxSession,
  listTmuxGithubRepos,
  listTmuxLinearIssues,
  listTmuxRemoteBranches,
  markTmuxInboxRead,
  prepareAttachSession,
  requestTmuxEvents,
  sendTmuxReviewRequest,
  setTmuxWorkspacePhase,
  createTmuxProject,
  prepareTmuxProject,
  finalizeTmuxProject,
  cancelTmuxProjectCreation,
  createTmuxWorkspace,
  deleteTmuxWorkspace,
  deleteTmuxProject,
  applyTmuxBundleRefresh,
  applyTmuxBundleConfig,
  updateTmuxNotificationConfig,
  ensureServer,
  getMachineSnapshot,
  createSession,
  killSession,
  createCheckpoint,
  getInbox,
  clearInbox,
  markInboxRead,
  getReplaySnapshot,
  getReplayText,
  getReplayMarkdown,
  getAgentState,
  watchMachineEvents,
  watchAgentState,
  listAgentSessions as listTmuxAgentSessions,
  createAgentSession as createTmuxAgentSession,
  abortAgentSession as abortTmuxAgentSession,
  closeAgentSession as closeTmuxAgentSession,
  archiveAgentSession as archiveTmuxAgentSession,
  restoreAgentSession as restoreTmuxAgentSession,
  attachAgentSession as attachTmuxAgentSession,
  respondToAgentPermission as respondToTmuxAgentPermission,
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
import {
  getNotificationConfig,
  updateNotificationConfig,
} from '../../core/config.js';
import { listProjectSummaries } from '../../core/project-catalog.js';
import { scanWorkspaces } from '../../lib/remote-session/workspace-scanner.js';
import { deleteWorkspaceCore } from '../../core/workspace.js';
import { prepareWorkspaceForSession } from '../../core/workspace-lifecycle.js';
import {
  cancelPreparedProjectForSession,
  createProjectForSession,
  createWorkspaceForSession,
  deleteProjectForSession,
  finalizePreparedProjectForSession,
  listGithubReposForSession,
  listLinearIssuesForSession,
  listRemoteBranchesForSession,
  prepareProjectForSession,
  type SessionCreateProjectParams,
  type SessionCreateWorkspaceParams,
  type SessionFinalizeProjectParams,
} from '../../core/session-lifecycle.js';
import {
  getBundleRefreshPlan as getBundleRefreshPlanCore,
  applyBundleRefreshSubmission,
  getBundleConfigState as getBundleConfigStateCore,
  applyBundleConfigSubmission,
} from '../../core/bundle-refresh.js';
import { createBufferedSocketWriter } from '../../utils/bun-socket-writer.js';
import { findUtf8Boundary } from '../../utils/utf8.js';
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
import { executeLocalReviewOperation } from '../../core/review-executor.js';
import type { WideEventFilter } from '../../types/events.js';
import type { SessionLinearIssueSummary } from '../../types/lifecycle.js';
import {
  SpacesError,
  WorkspaceDeleteError,
  type WorkspaceDeleteErrorCode,
} from '../../types/errors.js';
import { parseProcessSessionName } from '../../lib/processes/names.js';
import {
  loadProcessesConfig,
  loadProcessesConfigWithDiagnostics,
  getProcessDefinition,
} from '../../lib/processes/config.js';
import { getProcessSpecs, startProcessInstance, stopProcessInstance } from '../../lib/processes/manager.js';
import { startProcessScheduler } from '../../lib/processes/scheduler.js';
import { normalizeProcessInstanceCount } from '../../lib/processes/instances.js';
import { readWorkspaceSnapshots } from '../../lib/events/reader.js';
import { readWideEvents } from '../../lib/events/reader.js';
import { listProcessEventsDirs } from '../../lib/events/paths.js';
import { resolveWorkspaceRef } from '../../lib/events/paths.js';
import { loadSavedEventFilters } from '../../lib/events/filters.js';
import { readProjectConfig } from '../../core/config.js';
import { existsSync } from 'fs';
import type { TerminalSnapshot } from '../backend.js';
import type { AgentStateUpdateDelta, WorkspaceAgentState } from '../../lib/tmux-lite/agent-event-manager.js';
import type { AgentWorkspaceTargetPayload } from '../../lib/tmux-lite/protocol.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewRequestError } from '../../types/errors.js';

export interface LocalSessionBackendDependencies {
  listSessions: typeof listSessions;
  listReplays: typeof listReplaysOffline;
  ensureServer: typeof ensureServer;
  createSession: typeof createSession;
  killSession: typeof killSession;
  createCheckpoint: typeof createCheckpoint;
  getInbox: typeof getInbox;
  clearInbox: typeof clearInbox;
  markInboxRead: typeof markInboxRead;
  getReplaySnapshot: typeof getReplaySnapshotOffline;
  getReplayText: typeof getReplayTextOffline;
  getReplayMarkdown: typeof getReplayMarkdown;
  getReplayFrame: typeof getReplayFrameOffline;
  getReplayTimeline: typeof getReplayTimelineOffline;
  getMachineSnapshot: typeof getMachineSnapshot;
  watchMachineEvents: typeof watchMachineEvents;
  dismissReplay: typeof dismissReplayOffline;
  undismissReplay: typeof undismissReplayOffline;
  getNotificationConfig: typeof getNotificationConfig;
  updateNotificationConfig: typeof updateNotificationConfig;
  listProjectSummaries: typeof listProjectSummaries;
  listGithubReposForSession: typeof listGithubReposForSession;
  listRemoteBranchesForSession: typeof listRemoteBranchesForSession;
  listLinearIssuesForSession: typeof listLinearIssuesForSession;
  createProjectForSession: (params: SessionCreateProjectParams) => Promise<unknown>;
  prepareProjectForSession: (params: SessionCreateProjectParams) => Promise<PreparedProjectResult>;
  finalizePreparedProjectForSession: (params: SessionFinalizeProjectParams) => Promise<unknown>;
  cancelPreparedProjectForSession: (projectName: string) => Promise<void>;
  createWorkspaceForSession: (params: SessionCreateWorkspaceParams) => Promise<unknown>;
  deleteProjectForSession: typeof deleteProjectForSession;
  scanWorkspaces: typeof scanWorkspaces;
  deleteWorkspaceCore: typeof deleteWorkspaceCore;
  prepareWorkspaceForSession: typeof prepareWorkspaceForSession;
  getBundleRefreshPlanCore: typeof getBundleRefreshPlanCore;
  applyBundleRefreshSubmission: typeof applyBundleRefreshSubmission;
  getBundleConfigStateCore: typeof getBundleConfigStateCore;
  applyBundleConfigSubmission: typeof applyBundleConfigSubmission;
  connectSessionSocket: (
    socketPath: string,
    handlers: LocalSessionSocketHandlers
  ) => Promise<LocalSessionSocketConnection>;
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
  agentControl?: Partial<LocalAgentControl>;
}

interface LocalAgentControl {
  getState: typeof getAgentState;
  watchState: typeof watchAgentState;
  listSessions: typeof listTmuxAgentSessions;
  createSession: typeof createTmuxAgentSession;
  abortSession: typeof abortTmuxAgentSession;
  closeSession: typeof closeTmuxAgentSession;
  archiveSession: typeof archiveTmuxAgentSession;
  restoreSession: typeof restoreTmuxAgentSession;
  attachSession: typeof attachTmuxAgentSession;
  respondToPermission: typeof respondToTmuxAgentPermission;
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
    createSession,
    killSession,
    createCheckpoint,
    getInbox,
    clearInbox,
    markInboxRead,
    getReplaySnapshot: getReplaySnapshotOffline,
    getReplayText: getReplayTextOffline,
    getReplayMarkdown,
    getReplayFrame: getReplayFrameOffline,
    getReplayTimeline: getReplayTimelineOffline,
    getMachineSnapshot,
    watchMachineEvents,
    dismissReplay: dismissReplayOffline,
    undismissReplay: undismissReplayOffline,
    getNotificationConfig,
    updateNotificationConfig,
    listProjectSummaries,
    listGithubReposForSession,
    listRemoteBranchesForSession,
      listLinearIssuesForSession,
      createProjectForSession,
      prepareProjectForSession,
      finalizePreparedProjectForSession,
      cancelPreparedProjectForSession,
      createWorkspaceForSession,
    deleteProjectForSession,
    scanWorkspaces,
    deleteWorkspaceCore,
    prepareWorkspaceForSession,
    getBundleRefreshPlanCore,
    applyBundleRefreshSubmission,
    getBundleConfigStateCore,
    applyBundleConfigSubmission,
    connectSessionSocket,
    ...overrides,
  };
}


export class LocalSessionBackend implements SessionBackend {
  readonly descriptor: BackendDescriptor;
  private readonly deps: LocalSessionBackendDependencies;
  private readonly handlers = new Set<(event: BackendEvent) => void>();
  private connected = false;
  private attachedSessionId: string | null = null;
  private attachedWorkspaceId: string | null = null;
  private sessionSocket: LocalSessionSocketConnection | null = null;
  private sessionSocketSessionId: string | null = null;
  private sessionSocketGeneration = 0;
  private closingSessionSocket = false;
  private ptyOutputHandler: ((data: Uint8Array) => void) | null = null;
  private pendingPtyChunks: Uint8Array[] = [];
  private pendingUtf8Bytes = new Uint8Array(0);
  private viewOnly = false;
  private pendingAttachAbortController: AbortController | null = null;
  private pendingAttachRequestId: string | null = null;
  private agentStateCache: Record<string, WorkspaceAgentState> = {};
  private readonly agentStateHandlers = new Set<(delta: AgentStateUpdateDelta) => void>();
  private stopAgentWatch: (() => void) | null = null;
  private readonly machineStateClient = new MachineStateClient();
  private readonly agentControl: LocalAgentControl;

  constructor(options: LocalSessionBackendOptions = {}) {
    this.descriptor = options.descriptor ?? DEFAULT_DESCRIPTOR;
    this.deps = buildDeps(options.deps);
    this.agentControl = {
      getState: options.agentControl?.getState ?? getAgentState,
      watchState: options.agentControl?.watchState ?? watchAgentState,
      listSessions: options.agentControl?.listSessions ?? listTmuxAgentSessions,
      createSession: options.agentControl?.createSession ?? createTmuxAgentSession,
      abortSession: options.agentControl?.abortSession ?? abortTmuxAgentSession,
      closeSession: options.agentControl?.closeSession ?? closeTmuxAgentSession,
      archiveSession: options.agentControl?.archiveSession ?? archiveTmuxAgentSession,
      restoreSession: options.agentControl?.restoreSession ?? restoreTmuxAgentSession,
      attachSession: options.agentControl?.attachSession ?? attachTmuxAgentSession,
      respondToPermission: options.agentControl?.respondToPermission ?? respondToTmuxAgentPermission,
    };
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

    await this.closeSessionSocket(false);
    this.connected = false;
    const wasAttached = this.attachedSessionId !== null;
    this.attachedSessionId = null;
    this.attachedWorkspaceId = null;
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
    return listTmuxGithubRepos(org);
  }

  async listRemoteBranches(projectName: string): Promise<string[]> {
    return listTmuxRemoteBranches(projectName);
  }

  async listLinearIssues(projectName: string): Promise<SessionLinearIssueSummary[]> {
    return listTmuxLinearIssues(projectName);
  }

  async listWorkspaces(): Promise<void> {
    const mappedWorkspaces = machineSnapshotToWorkspaces(this.machineStateClient.getSnapshot());

    this.emit({
      type: 'workspaces',
      workspaces: mappedWorkspaces,
    });
  }

  async setWorkspaceStatus(projectName: string, workspaceName: string, phase: import('../../types/config.js').WorkspacePhase): Promise<void> {
    await setTmuxWorkspacePhase(projectName, workspaceName, phase);
    await this.listWorkspaces();
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
      await createTmuxProject(params);
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
      return await prepareTmuxProject(params);
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
      await finalizeTmuxProject(params);
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
      await cancelTmuxProjectCreation(projectName);
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
      await createTmuxWorkspace(params);
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
      await deleteTmuxProject(projectName);
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
    this.viewOnly = params.viewOnly ?? false;

    let targetSession: TmuxSession | null = null;

    if (params.sessionId) {
      const sessions = await this.deps.listSessions();
      targetSession = sessions.find((session) => session.id === params.sessionId) ?? null;
      if (!targetSession) {
        throw new SpacesError(`Session not found: ${params.sessionId}`, 'USER_ERROR', 1);
      }
      if (typeof targetSession.exitCode === 'number') {
        throw toExitedSessionError(targetSession);
      }
      // Resolve workspaceId from the machine snapshot for sessionId-based attach
      const snapshotSession = this.machineStateClient.getSnapshot().terminalSessionsById[params.sessionId];
      this.attachedWorkspaceId = snapshotSession?.workspaceId ?? null;
    } else if (params.workspaceId) {
      this.attachedWorkspaceId = params.workspaceId;
      let currentPhase: 'pre' | 'setup' | 'select' = 'pre';
      try {
        const prepared = await prepareAttachSession({
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
        this.attachedWorkspaceId = prepared.workspaceId ?? this.attachedWorkspaceId;
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

    await this.attachToSessionSocketWithRetry(targetSession, params);
  }

  async detachSession(): Promise<void> {
    if (this.sessionSocket) {
      this.sessionSocket.sendControl({ type: 'detach' });
    }

    const hadAttached = this.attachedSessionId !== null;
    await this.closeSessionSocket(false);
    this.attachedSessionId = null;
    this.attachedWorkspaceId = null;
    this.viewOnly = false;
    if (hadAttached) {
      this.emit({ type: 'detached' });
    }
  }

  async cancelPendingScripts(): Promise<void> {
    if (this.pendingAttachRequestId) {
      await cancelPrepareAttachSession(this.pendingAttachRequestId).catch(() => undefined);
      this.pendingAttachRequestId = null;
    }
    this.pendingAttachAbortController?.abort();
  }

  async writePtyData(data: Uint8Array): Promise<void> {
    if (this.viewOnly) {
      return;
    }
    const socket = this.sessionSocket;
    if (!socket || !this.attachedSessionId) {
      throw new SpacesError('No attached local session', 'SYSTEM_ERROR', 2);
    }
    socket.sendPty(data);
  }

  async resizePty(cols: number, rows: number): Promise<void> {
    const socket = this.sessionSocket;
    if (!socket || !this.attachedSessionId) {
      throw new SpacesError('No attached local session', 'SYSTEM_ERROR', 2);
    }
    socket.sendControl({ type: 'resize', cols, rows });
  }

  async killSession(sessionId: string): Promise<void> {
    await killTmuxSession(sessionId);
  }

  async deleteWorkspace(
    projectName: string,
    workspaceId: string,
    params: DeleteWorkspaceParams = {}
  ): Promise<void> {
    const resolvedWorkspaceId = resolveWorkspaceName(projectName, workspaceId);
    try {
      await deleteTmuxWorkspace({
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
    return getTmuxBundleRefreshPlan(projectName, workspaceId);
  }

  async applyBundleRefresh(
    projectName: string,
    workspaceId: string,
    submission: BundleRefreshSubmission
  ): Promise<void> {
    await applyTmuxBundleRefresh(projectName, workspaceId, submission);
  }

  async getBundleConfigState(projectName: string, workspaceId: string): Promise<BundleConfigState> {
    return getTmuxBundleConfigState(projectName, workspaceId);
  }

  async applyBundleConfigUpdate(
    projectName: string,
    workspaceId: string,
    submission: BundleConfigSubmission
  ): Promise<void> {
    await applyTmuxBundleConfig(projectName, workspaceId, submission);
  }

  async sendReviewRequest(operation: ReviewOperation): Promise<ReviewResult> {
    const response = await sendTmuxReviewRequest(operation);
    if (response.error) {
      throw new ReviewRequestError(response.error.message, response.error.code, { op: operation.op, requestId: response.requestId });
    }
    if (!response.result) {
      throw new ReviewRequestError('Missing review result', 'REVIEW_FAILED', { op: operation.op, requestId: response.requestId });
    }
    return response.result;
  }

  async requestInbox(): Promise<void> {
    const [inboxResponse, sessions, workspaces] = await Promise.all([
      getTmuxInbox(),
      listSessions(),
      this.deps.scanWorkspaces(),
    ]);
    const items = inboxResponse.items as InboxItem[];

    const activeSessionIds = new Set(sessions.map((session) => session.id));
    const activeUnread = new Set<string>();
    for (const item of items) {
      if (!item.read && activeSessionIds.has(item.sessionId)) {
        activeUnread.add(item.sessionId);
      }
    }

    this.emit({
      type: 'inbox',
      items: items as InboxItem[],
      unreadCount: activeUnread.size,
    });

    // Emit sessions from the same fetch — inbox includes exit notifications, so this keeps UI in sync
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
    await clearTmuxInbox(id);
    await this.requestInbox();
  }

  async markInboxRead(id: string): Promise<void> {
    await markTmuxInboxRead(id);
    await this.requestInbox();
  }

  async getNotificationConfig(): Promise<void> {
    const response = await getTmuxNotificationConfig();
    this.emit({ type: 'notification_config', config: response.config as NotificationConfig });
  }

  async updateNotificationConfig(config: NotificationConfig): Promise<void> {
    const response = await updateTmuxNotificationConfig(config);
    this.emit({ type: 'notification_config', config: response.config as NotificationConfig });
  }

  async startProcess(workspaceId: string, processName: string, instance?: number): Promise<void> {
    const workspaces = await this.deps.scanWorkspaces();
    const workspace = workspaces.find(
      (w) => w.id === workspaceId || toCanonicalWorkspaceId(w) === workspaceId
    );
    if (!workspace) {
      throw new SpacesError(`Workspace not found: ${workspaceId}`, 'USER_ERROR', 1);
    }

    const processConfig = loadProcessesConfig(workspace.path);
    const processDefinition = getProcessDefinition(processConfig, processName);
    if (!processDefinition) {
      throw new SpacesError(`Process not found: ${processName}`, 'USER_ERROR', 1);
    }
    if (normalizeProcessInstanceCount(processDefinition.instances) === 0) {
      throw new SpacesError(`Process is disabled (instances: 0): ${processName}`, 'USER_ERROR', 1);
    }

    const specs = getProcessSpecs(workspace.path).filter((s) =>
      s.name === processName && (instance === undefined || s.instance === instance)
    );
    if (specs.length === 0) {
      throw new SpacesError(`Process not found: ${processName}`, 'USER_ERROR', 1);
    }

    const sessionIds: string[] = [];
    const startedSpecs: typeof specs = [];
    try {
      for (const spec of specs) {
        const result = await startProcessInstance(workspace.path, spec);
        sessionIds.push(result.sessionId);
        startedSpecs.push(spec);
      }
    } catch (error) {
      for (const startedSpec of startedSpecs) {
        try {
          await stopProcessInstance(workspace.path, startedSpec);
        } catch {
          // Best-effort rollback; preserve original start error
        }
      }
      throw error;
    }

    if (!this.processSchedulers.has(workspace.path)) {
      this.processSchedulers.set(workspace.path, startProcessScheduler(workspace.path));
    }

    this.emit({
      type: 'process_started',
      workspaceId,
      processName,
      sessionId: sessionIds[0],
      sessionIds,
    });
  }

  async stopProcess(workspaceId: string, processName: string): Promise<void> {
    const workspaces = await this.deps.scanWorkspaces();
    const workspace = workspaces.find(
      (w) => w.id === workspaceId || toCanonicalWorkspaceId(w) === workspaceId
    );
    if (!workspace) {
      throw new SpacesError(`Workspace not found: ${workspaceId}`, 'USER_ERROR', 1);
    }

    const specs = getProcessSpecs(workspace.path).filter((s) => s.name === processName);
    if (specs.length === 0) {
      throw new SpacesError(`Process not found: ${processName}`, 'USER_ERROR', 1);
    }

    for (const spec of specs) {
      await stopProcessInstance(workspace.path, spec);
    }

    this.emit({
      type: 'process_stopped',
      workspaceId,
      processName,
    });
  }

  async requestEvents(
    workspacePath: string,
    filter?: WideEventFilter,
    limit?: number,
    sinceMs?: number,
  ): Promise<void> {
    const response = await requestTmuxEvents({ workspacePath, filter, limit, sinceMs });
    this.emit({ type: 'events', events: response.events, liveEventIds: response.liveEventIds, savedEventFilters: response.savedEventFilters ?? [] });
  }

  private processSchedulers = new Map<string, NodeJS.Timer>();

  private async attachToSessionSocket(
    session: TmuxSession,
    params: AttachSessionParams
  ): Promise<void> {
    await this.closeSessionSocket(true);

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
              this.emitPtyData(data);
            },
            onControl: (event) => {
              if (
                this.sessionSocketGeneration !== expectedGeneration ||
                this.sessionSocketSessionId !== expectedSessionId
              ) {
                return;
              }
              if (event.type === 'attached') {
                this.attachedSessionId = session.id;
                this.emit({
                  type: 'attached',
                  sessionId: session.id,
                  sessionName: session.name,
                  viewOnly: this.viewOnly,
                  workspaceId: this.attachedWorkspaceId ?? undefined,
                });
                this.emit({
                  type: 'session_meta',
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

              const hadAttached = this.attachedSessionId !== null;
              this.sessionSocket = null;
              this.sessionSocketSessionId = null;
              this.attachedSessionId = null;
              this.attachedWorkspaceId = null;

              if (!settled) {
                settleReject(new SpacesError(`Local session socket closed: ${session.name}`, 'SYSTEM_ERROR', 2));
                return;
              }

              if (hadAttached) {
                this.emit({ type: 'detached' });
              }
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
    params: AttachSessionParams
  ): Promise<void> {
    try {
      await this.attachToSessionSocket(session, params);
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

    await this.attachToSessionSocket(refreshed, params);
  }

  private async closeSessionSocket(emitDetached: boolean): Promise<void> {
    const socket = this.sessionSocket;
    const hadAttached = this.attachedSessionId !== null;

    // Invalidate any stale socket callbacks from earlier connections.
    this.sessionSocketGeneration += 1;

    if (socket) {
      this.closingSessionSocket = true;
      socket.close();
      this.sessionSocket = null;
      this.sessionSocketSessionId = null;
    }

    this.attachedSessionId = null;
    this.attachedWorkspaceId = null;
    this.pendingUtf8Bytes = new Uint8Array(0);
    this.pendingPtyChunks = [];

    if (emitDetached && hadAttached) {
      this.emit({ type: 'detached' });
    }
  }

  private handleSessionControl(event: SessionEvent, sessionId: string): void {
    if (event.type === 'kicked') {
      void this.closeSessionSocket(true);
      return;
    }

    if (event.type === 'exited') {
      const exitCode = typeof event.code === 'number' ? event.code : undefined;
      this.emit({ type: 'session_exited', sessionId, exitCode });
      void this.closeSessionSocket(false);
      return;
    }

    if (event.type === 'session-meta') {
      this.emit({
        type: 'session_meta',
        meta: {
          sessionName: event.sessionName ?? null,
          processTitle: event.processTitle ?? null,
          terminalTitle: event.terminalTitle ?? null,
          lastAlertKind: event.lastAlertKind ?? null,
          lastAlertPreview: event.lastAlertPreview ?? null,
          lastAlertAt: event.lastAlertAt ?? null,
          unreadAlertCount: event.unreadAlertCount ?? null,
        },
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

  // ============================================================================
  // Agent state — backed by tmux-lite agent control
  // ============================================================================

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
    return this.agentControl.respondToPermission(target, agentSessionId, permissionId, response);
  }

  async getKnownAgentSessions(workspaceId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    return machineSnapshotToKnownAgentSessions(this.machineStateClient.getSnapshot(), workspaceId, { includeArchived: true });
  }

  async listAgentSessions(workspaceId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    return machineSnapshotToKnownAgentSessions(this.machineStateClient.getSnapshot(), workspaceId, { includeArchived: false });
  }

  async createAgentSession(workspaceId: string, title?: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    await this.agentControl.createSession(target, title);
    const snapshot = await this.deps.getMachineSnapshot();
    this.machineStateClient.replaceSnapshot(snapshot);
    this.agentStateCache = machineSnapshotToAgentState(snapshot);
    this.broadcastAgentSnapshot();
    this.emitDerivedMachineState();
    return machineSnapshotToKnownAgentSessions(snapshot, workspaceId, { includeArchived: true });
  }

  async abortAgentSession(workspaceId: string, agentSessionId: string): Promise<boolean> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const ok = await this.agentControl.abortSession(target, agentSessionId);
    const snapshot = await this.deps.getMachineSnapshot();
    this.machineStateClient.replaceSnapshot(snapshot);
    this.agentStateCache = machineSnapshotToAgentState(snapshot);
    this.broadcastAgentSnapshot();
    this.emitDerivedMachineState();
    return ok;
  }

  async closeAgentSession(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    await this.agentControl.closeSession(target, agentSessionId);
    const snapshot = await this.deps.getMachineSnapshot();
    this.machineStateClient.replaceSnapshot(snapshot);
    this.agentStateCache = machineSnapshotToAgentState(snapshot);
    this.broadcastAgentSnapshot();
    this.emitDerivedMachineState();
    return machineSnapshotToKnownAgentSessions(snapshot, workspaceId, { includeArchived: true });
  }

  async archiveAgentSession(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    await this.agentControl.archiveSession(target, agentSessionId);
    const snapshot = await this.deps.getMachineSnapshot();
    this.machineStateClient.replaceSnapshot(snapshot);
    this.agentStateCache = machineSnapshotToAgentState(snapshot);
    this.broadcastAgentSnapshot();
    this.emitDerivedMachineState();
    return machineSnapshotToKnownAgentSessions(snapshot, workspaceId, { includeArchived: true });
  }

  async restoreAgentSession(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    await this.agentControl.restoreSession(target, agentSessionId);
    const snapshot = await this.deps.getMachineSnapshot();
    this.machineStateClient.replaceSnapshot(snapshot);
    this.agentStateCache = machineSnapshotToAgentState(snapshot);
    this.broadcastAgentSnapshot();
    this.emitDerivedMachineState();
    return machineSnapshotToKnownAgentSessions(snapshot, workspaceId, { includeArchived: true });
  }

  async attachAgentSession(workspaceId: string, agentSessionId: string, options: { viewOnly?: boolean } = {}): Promise<void> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const terminalSession = await this.agentControl.attachSession(target, agentSessionId);
    await this.attachSession({ sessionId: terminalSession.id, viewOnly: options.viewOnly });
  }

  // ============================================================================
  // Agent session preferences — persisted to ~/.gitspace/.agent-sessions.json
  // ============================================================================

  private get agentPrefsPath(): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
    return join(home, 'gitspace', '.agent-sessions.json');
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
}
