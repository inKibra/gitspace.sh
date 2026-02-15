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
  getInbox,
  clearInbox,
  markInboxRead,
} from '../../lib/tmux-lite/cli.js';
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
  getBundleRefreshPlan as getBundleRefreshPlanCore,
  applyBundleRefreshSubmission,
} from '../../core/bundle-refresh.js';
import { createBufferedSocketWriter } from '../../utils/bun-socket-writer.js';
import { findUtf8Boundary } from '../../utils/utf8.js';
import type {
  AttachSessionParams,
  BackendDescriptor,
  DeleteWorkspaceParams,
  SessionBackend,
} from '../backend.js';
import type { BackendEvent } from '../events.js';
import type { NotificationConfig } from '../../notifications/types.js';
import type { BundleRefreshPlan, BundleRefreshSubmission } from '../../types/bundle-refresh.js';
import { SpacesError } from '../../types/errors.js';

export interface LocalSessionBackendDependencies {
  listSessions: typeof listSessions;
  ensureServer: typeof ensureServer;
  createSession: typeof createSession;
  killSession: typeof killSession;
  getInbox: typeof getInbox;
  clearInbox: typeof clearInbox;
  markInboxRead: typeof markInboxRead;
  getNotificationConfig: typeof getNotificationConfig;
  updateNotificationConfig: typeof updateNotificationConfig;
  listProjectSummaries: typeof listProjectSummaries;
  scanWorkspaces: typeof scanWorkspaces;
  deleteWorkspaceCore: typeof deleteWorkspaceCore;
  prepareWorkspaceForSession: typeof prepareWorkspaceForSession;
  getBundleRefreshPlanCore: typeof getBundleRefreshPlanCore;
  applyBundleRefreshSubmission: typeof applyBundleRefreshSubmission;
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

function toWorkspaceId(projectName: string, workspaceName: string): string {
  return `${projectName}:${workspaceName}`;
}

function toCanonicalWorkspaceId(workspace: { projectName: string; id: string }): string {
  return toWorkspaceId(workspace.projectName, workspace.id);
}

function resolveWorkspaceName(projectName: string, workspaceId: string): string {
  const prefix = `${projectName}:`;
  if (workspaceId.startsWith(prefix)) {
    return workspaceId.slice(prefix.length);
  }
  return workspaceId;
}

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
    ensureServer,
    createSession,
    killSession,
    getInbox,
    clearInbox,
    markInboxRead,
    getNotificationConfig,
    updateNotificationConfig,
    listProjectSummaries,
    scanWorkspaces,
    deleteWorkspaceCore,
    prepareWorkspaceForSession,
    getBundleRefreshPlanCore,
    applyBundleRefreshSubmission,
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

    this.emit({
      type: 'workspaces',
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        id: toCanonicalWorkspaceId(workspace),
        sessionCount: counts.get(workspace.path) ?? 0,
      })),
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
        const workspace = workspaceByPath.get(session.cwd);
        const id = workspace ? toCanonicalWorkspaceId(workspace) : 'unknown';
        return toSessionInfo(session, id);
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

  async attachSession(params: AttachSessionParams): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }

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
      const workspaces = await this.deps.scanWorkspaces();
      const workspace = workspaces.find(
        (item) =>
          item.id === params.workspaceId ||
          toCanonicalWorkspaceId(item) === params.workspaceId
      );
      if (!workspace) {
        throw new SpacesError(`Workspace not found: ${params.workspaceId}`, 'USER_ERROR', 1);
      }

      let currentPhase: 'pre' | 'setup' | 'select' = 'pre';

      const scriptResult = await this.deps.prepareWorkspaceForSession({
        projectName: workspace.projectName,
        workspacePath: workspace.path,
        workspaceName: workspace.id,
        interactiveScripts: false,
        bundleMode: 'error-if-changed',
        scriptPolicy: params.scriptPolicy ?? 'auto',
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
        },
      });

      if (!scriptResult.success) {
        const bundleNeedsRefresh =
          'bundleNeedsRefresh' in scriptResult && scriptResult.bundleNeedsRefresh;

        if ('bundleNeedsRefresh' in scriptResult && scriptResult.bundleNeedsRefresh) {
          this.emit({
            type: 'command_error',
            code: 'BUNDLE_REFRESH_REQUIRED',
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

      const sessions = await this.deps.listSessions();
      const sessionPrefix = `${workspace.projectName}:${workspace.id}:`;
      const count = sessions.filter((session) => session.name.startsWith(sessionPrefix)).length;
      const suffix = params.sessionName ?? String(count + 1);
      const fullName = `${sessionPrefix}${suffix}`;
      targetSession = await this.deps.createSession(fullName, workspace.path);
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
    if (hadAttached) {
      this.emit({ type: 'detached' });
    }
  }

  async writePtyData(data: Uint8Array): Promise<void> {
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
        const errorCode = result.errorCode === 'REMOVE_SCRIPT_FAILED'
          ? 'REMOVE_SCRIPT_FAILED'
          : 'DELETE_FAILED';
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

        const error = new Error(message) as Error & { code?: string };
        error.code = errorCode;
        throw error;
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
        this.emit({
          type: 'script_output',
          phase: 'remove',
          data: new Uint8Array(0),
          done: true,
          error: message,
        });
        this.emit({
          type: 'command_error',
          code: 'DELETE_FAILED',
          message,
        });
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
        (item.id === resolvedWorkspaceId || toCanonicalWorkspaceId(item) === workspaceId)
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
