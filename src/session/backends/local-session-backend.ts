import type {
  Session as TmuxSession,
  InboxItem,
  SessionCtrl,
  SessionEvent,
} from '../../lib/tmux-lite/protocol.js';
import {
  listSessions,
  ensureServer,
  createSession,
  killSession,
  createCheckpoint,
  getInbox,
  clearInbox,
  markInboxRead,
  getReplaySnapshot,
  getReplayText,
  getReplayMarkdown,
} from '../../lib/tmux-lite/cli.js';
import {
  listReplaysOffline,
  getReplaySnapshotOffline,
  getReplayTextOffline,
  getReplayAnsiBufferOffline,
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
import { buildSessionName } from '../session-name.js';
import { buildWorkspaceSessionHooks } from '../workspace-shell-hooks.js';
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
import { resolveWorkspaceRef } from '../../lib/events/paths.js';
import { loadSavedEventFilters } from '../../lib/events/filters.js';
import { readProjectConfig } from '../../core/config.js';
import { existsSync } from 'fs';
import type { TerminalSnapshot } from '../backend.js';

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
  getReplayAnsi: typeof getReplayAnsiBufferOffline;
  getReplayTimeline: typeof getReplayTimelineOffline;
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

function scriptFailureCodeForPhase(phase: 'pre' | 'setup' | 'select'): string {
  if (phase === 'setup') {
    return 'SETUP_SCRIPT_FAILED';
  }
  if (phase === 'select') {
    return 'SELECT_SCRIPT_FAILED';
  }

  return 'PRE_SCRIPT_FAILED';
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
    getReplayAnsi: getReplayAnsiBufferOffline,
    getReplayTimeline: getReplayTimelineOffline,
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
  private sessionSocket: LocalSessionSocketConnection | null = null;
  private sessionSocketSessionId: string | null = null;
  private sessionSocketGeneration = 0;
  private closingSessionSocket = false;
  private ptyOutputHandler: ((data: Uint8Array) => void) | null = null;
  private pendingPtyChunks: Uint8Array[] = [];
  private pendingUtf8Bytes = new Uint8Array(0);
  private viewOnly = false;
  private pendingAttachAbortController: AbortController | null = null;

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
    this.connected = true;
    this.emit({ type: 'status', status: 'connected' });
  }

  async disconnect(): Promise<void> {
    this.pendingAttachAbortController?.abort();
    this.pendingAttachAbortController = null;

    await this.closeSessionSocket(false);
    this.connected = false;
    const wasAttached = this.attachedSessionId !== null;
    this.attachedSessionId = null;
    this.emit({ type: 'status', status: 'disconnected' });
    if (wasAttached) {
      this.emit({ type: 'detached' });
    }
  }

  async listProjects(): Promise<void> {
    const projects = this.deps.listProjectSummaries().map((project) => ({
      name: project.name,
      repository: project.repository,
      workspaceCount: project.workspaceCount,
      isCurrent: project.isCurrent,
    }));
    this.emit({ type: 'projects', projects });
  }

  async listGithubRepos(org?: string): Promise<string[]> {
    return this.deps.listGithubReposForSession(org);
  }

  async listRemoteBranches(projectName: string): Promise<string[]> {
    return this.deps.listRemoteBranchesForSession(projectName);
  }

  async listLinearIssues(projectName: string): Promise<SessionLinearIssueSummary[]> {
    return this.deps.listLinearIssuesForSession(projectName);
  }

  async listWorkspaces(): Promise<void> {
    const [workspaces, sessions] = await Promise.all([
      this.deps.scanWorkspaces(),
      this.deps.listSessions(),
    ]);

    const counts = new Map<string, number>();
    for (const session of sessions) {
      const current = counts.get(session.cwd) ?? 0;
      counts.set(session.cwd, current + 1);
    }

    const mappedWorkspaces = workspaces.map((workspace) => {
      const processConfig = loadProcessesConfigWithDiagnostics(workspace.path);
      return {
        ...workspace,
        id: toCanonicalWorkspaceId(workspace),
        sessionCount: counts.get(workspace.path) ?? 0,
        processes: processConfig.config.processes.map((p) => ({
          name: p.name,
          instances: p.instances,
          ports: p.ports,
        })),
        processConfigError: processConfig.error ?? undefined,
      };
    });

    this.emit({
      type: 'workspaces',
      workspaces: mappedWorkspaces,
    });
  }

  async listSessions(workspaceId?: string): Promise<void> {
    const [sessions, workspaces] = await Promise.all([
      this.deps.listSessions(),
      this.deps.scanWorkspaces(),
    ]);

    const workspaceByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]));

    const filtered = sessions
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
        if (!workspaceId) {
          return true;
        }
        return (
          session.workspaceId === workspaceId ||
          session.workspaceId.endsWith(`:${workspaceId}`)
        );
      });

    this.emit({ type: 'sessions', sessions: filtered });
  }

  async listReplays(workspaceId?: string, includeDismissed?: boolean): Promise<void> {
    const replays = await this.deps.listReplays({ workspaceId, includeDismissed });
    this.emit({ type: 'replays', replays });
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

  async getReplayAnsi(replayId: string, target?: import('../backend.js').ReplayFrameTarget): Promise<Uint8Array> {
    return this.deps.getReplayAnsi(replayId, target);
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
      await this.deps.createProjectForSession(params);
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
      return await this.deps.prepareProjectForSession(params);
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
      await this.deps.finalizePreparedProjectForSession(params);
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
      await this.deps.cancelPreparedProjectForSession(projectName);
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
      await this.deps.createWorkspaceForSession(params);
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
      await this.deps.deleteProjectForSession({ projectName });
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
    } else if (params.workspaceId) {
      const workspaceId = params.workspaceId;
      const workspaces = await this.deps.scanWorkspaces();
      const workspace = workspaces.find(
        (item) => matchesWorkspaceId(item, workspaceId)
      );
      if (!workspace) {
        throw new SpacesError(`Workspace not found: ${workspaceId}`, 'USER_ERROR', 1);
      }

      const sessions = await this.deps.listSessions();
      const fullName = buildSessionName({
        projectName: workspace.projectName,
        workspaceName: workspace.id,
        requestedName: params.sessionName,
        sessions,
      });

      if (params.command) {
        // Skip workspace scripts when a custom command is specified
        targetSession = await this.deps.createSession(fullName, workspace.path, {
          command: params.command,
          args: params.args,
          env: params.env,
        });
      } else {
        let currentPhase: 'pre' | 'setup' | 'select' = 'pre';
        const attachAbortController = new AbortController();
        this.pendingAttachAbortController = attachAbortController;

        const scriptResult = await this.deps.prepareWorkspaceForSession({
          projectName: workspace.projectName,
          workspacePath: workspace.path,
          workspaceName: workspace.id,
          interactiveScripts: false,
          bundleMode: 'error-if-changed',
          scriptPolicy: params.scriptPolicy ?? 'auto',
          signal: attachAbortController.signal,
          onOutput: (data) => {
            this.emitPtyData(data);
            this.emit({
              type: 'script_output',
              phase: currentPhase,
              data,
            });
          },
          onPhaseStart: (phase) => {
            currentPhase = phase;
            const banner = Buffer.from(`\r\n==> ${phase} scripts...\r\n`);
            this.emitPtyData(banner);
            this.emit({
              type: 'script_output',
              phase,
              data: banner,
            });
          },
        }).finally(() => {
          if (this.pendingAttachAbortController === attachAbortController) {
            this.pendingAttachAbortController = null;
          }
        });

        if (!scriptResult.success) {
          const scriptsCancelled = 'cancelled' in scriptResult && scriptResult.cancelled === true;
          const bundleNeedsRefresh =
            'bundleNeedsRefresh' in scriptResult && scriptResult.bundleNeedsRefresh;

          if ('bundleNeedsRefresh' in scriptResult && scriptResult.bundleNeedsRefresh) {
            this.emit({
              type: 'command_error',
              code: 'BUNDLE_REFRESH_REQUIRED',
              message: scriptResult.error,
            });
          } else if (scriptsCancelled) {
            this.emit({
              type: 'command_error',
              code: 'SCRIPT_CANCELLED',
              message: scriptResult.error,
            });
          } else {
            this.emit({
              type: 'command_error',
              code: scriptFailureCodeForPhase(scriptResult.phase),
              message: scriptResult.error,
            });
          }

          this.emit({
            type: 'script_output',
            phase: scriptResult.phase,
            data: new Uint8Array(0),
            done: true,
            error: scriptResult.error,
          });

          const error = new SpacesError(
            `Workspace scripts failed during ${scriptResult.phase}: ${scriptResult.error}`
          ) as Error & { code?: string };
          if (bundleNeedsRefresh) {
            error.code = 'BUNDLE_REFRESH_REQUIRED';
          } else if (scriptsCancelled) {
            error.code = 'SCRIPT_CANCELLED';
          } else {
            error.code = scriptFailureCodeForPhase(scriptResult.phase);
          }
          throw error;
        }

        this.emit({
          type: 'script_output',
          phase: currentPhase,
          data: new Uint8Array(0),
          done: true,
        });

        targetSession = await this.deps.createSession(fullName, workspace.path, {
          hooks: buildWorkspaceSessionHooks(workspace.projectName, workspace.id),
        });
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
    this.viewOnly = false;
    if (hadAttached) {
      this.emit({ type: 'detached' });
    }
  }

  async cancelPendingScripts(): Promise<void> {
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
    await this.deps.killSession(sessionId);
  }

  async deleteWorkspace(
    projectName: string,
    workspaceId: string,
    params: DeleteWorkspaceParams = {}
  ): Promise<void> {
    const resolvedWorkspaceId = resolveWorkspaceName(projectName, workspaceId);
    const scriptPolicy = params.scriptPolicy ?? 'auto';
    let emittedDone = false;

    try {
      const result = await this.deps.deleteWorkspaceCore(projectName, resolvedWorkspaceId, {
        nonInteractive: true,
        removeScriptPolicy: scriptPolicy === 'skip' ? 'skip' : 'enforce',
        onScriptOutput: (data) => {
          this.emitPtyData(data);
          this.emit({
            type: 'script_output',
            phase: 'remove',
            data,
          });
        },
      });

      if (!result.success) {
        const errorCode: WorkspaceDeleteErrorCode = result.errorCode ?? 'DELETE_FAILED';
        const message = result.error ?? `Failed to delete workspace ${resolvedWorkspaceId}`;

        this.emit({
          type: 'command_error',
          code: errorCode,
          message,
        });

        this.emit({
          type: 'script_output',
          phase: 'remove',
          data: new Uint8Array(0),
          done: true,
          error: message,
        });
        emittedDone = true;

        throw new WorkspaceDeleteError(message, errorCode);
      }

      this.emit({
        type: 'script_output',
        phase: 'remove',
        data: new Uint8Array(0),
        done: true,
      });
      emittedDone = true;
    } catch (error) {
      if (!emittedDone) {
        const message = error instanceof Error ? error.message : String(error);
        const errorCode = toWorkspaceDeleteErrorCode(error) ?? 'DELETE_FAILED';
        this.emit({
          type: 'script_output',
          phase: 'remove',
          data: new Uint8Array(0),
          done: true,
          error: message,
        });
        this.emit({
          type: 'command_error',
          code: errorCode,
          message,
        });

        if (!(error instanceof WorkspaceDeleteError)) {
          throw new WorkspaceDeleteError(message, errorCode);
        }
      }
      throw error;
    }
  }

  async getBundleRefreshPlan(projectName: string, workspaceId: string): Promise<BundleRefreshPlan> {
    const workspace = await this.resolveWorkspace(projectName, workspaceId);
    return this.deps.getBundleRefreshPlanCore(projectName, workspace.path, workspace.id);
  }

  async applyBundleRefresh(
    projectName: string,
    workspaceId: string,
    submission: BundleRefreshSubmission
  ): Promise<void> {
    const workspace = await this.resolveWorkspace(projectName, workspaceId);
    await this.deps.applyBundleRefreshSubmission(projectName, workspace.path, submission);
  }

  async getBundleConfigState(projectName: string, workspaceId: string): Promise<BundleConfigState> {
    const workspace = await this.resolveWorkspace(projectName, workspaceId);
    return this.deps.getBundleConfigStateCore(projectName, workspace.path, workspace.id);
  }

  async applyBundleConfigUpdate(
    projectName: string,
    workspaceId: string,
    submission: BundleConfigSubmission
  ): Promise<void> {
    const workspace = await this.resolveWorkspace(projectName, workspaceId);
    await this.deps.applyBundleConfigSubmission(projectName, workspace.path, submission);
  }

  async sendReviewRequest(operation: ReviewOperation): Promise<ReviewResult> {
    return executeLocalReviewOperation(operation, this.deps.scanWorkspaces);
  }

  async requestInbox(): Promise<void> {
    const [items, sessions] = await Promise.all([
      this.deps.getInbox(),
      this.deps.listSessions(),
    ]);

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
  }

  async clearInbox(id?: string): Promise<void> {
    await this.deps.clearInbox(id);
  }

  async markInboxRead(id: string): Promise<void> {
    await this.deps.markInboxRead(id);
  }

  async getNotificationConfig(): Promise<void> {
    const config = this.deps.getNotificationConfig() as NotificationConfig;
    this.emit({ type: 'notification_config', config });
  }

  async updateNotificationConfig(config: NotificationConfig): Promise<void> {
    const updated = this.deps.updateNotificationConfig(config) as NotificationConfig;
    this.emit({ type: 'notification_config', config: updated });
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
    const workspaceRef = resolveWorkspaceRef(workspacePath);
    if (!workspaceRef || !existsSync(workspaceRef.workspacePath)) {
      this.emit({ type: 'events', events: [], liveEventIds: [], savedEventFilters: [] });
      return;
    }

    const savedEventFilters = loadSavedEventFilters(workspaceRef.workspacePath);

    const projectConfig = readProjectConfig(workspaceRef.projectName);
    const snapshots = readWorkspaceSnapshots(workspaceRef.workspacePath, {
      maxBytes: projectConfig.events?.snapshotCacheMaxBytes,
      maxTimeline: projectConfig.events?.maxTimeline,
    });

    const filtered = snapshots
      .filter((snapshot) => {
        if (sinceMs !== undefined && snapshot.updatedAt < sinceMs) return false;
        if (!filter) return true;
        if (filter.processName && snapshot.processName !== filter.processName) return false;
        if (filter.level && snapshot.level !== filter.level) return false;
        if (filter.message && !snapshot.message.includes(filter.message)) return false;
        if (filter.eventName && snapshot.eventName !== filter.eventName) return false;
        if (filter.correlationId && snapshot.correlationId !== filter.correlationId) return false;
        return true;
      })
      .slice(0, limit ?? 200);

    const events = filtered.map((snapshot) => ({
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
    }));

    this.emit({ type: 'events', events, liveEventIds: [], savedEventFilters });
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
}
