import type { WorkspaceEditorId, WorkspaceEditorOption } from '../../utils/open-editor.js';
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
  resyncMachineSnapshot,
  createSession,
  terminateSession,
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
import { readProjectConfig } from '../../core/config.js';
import { findGoalRecord, writeGoalRecord } from '../../core/goal-chain.js';
import { scanWorkspaces } from '../../lib/remote-session/workspace-scanner.js';
import { deleteWorkspaceCore } from '../../core/workspace.js';
import { prepareWorkspaceForSession, rerunWorkspaceScriptsForSession } from '../../core/workspace-lifecycle.js';
import { addRequirement, attachManualEvidence, recordHumanReview, removeRequirement, reopenRequirement, reorderRequirement, runGenerationCommand, runJudgmentCommand, runLlmJudgment, updateRequirement, type AddRequirementInput, type AttachEvidenceInput, type HumanReviewDecision, type UpdateRequirementInput } from '../../core/goal-validation.js';
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
  TerminateSessionOptions,
} from '../backend.js';
import type { BackendEvent } from '../events.js';
import type { NotificationConfig } from '../../notifications/types.js';
import type { BundleRefreshPlan, BundleRefreshSubmission } from '../../types/bundle-refresh.js';
import type { BundleConfigState, BundleConfigSubmission } from '../../types/bundle-config.js';
import type { ReviewOperation, ReviewResult } from '../../types/review.js';
import type { WideEventFilter } from '../../types/events.js';
import type { SessionLinearIssueSummary } from '../../types/lifecycle.js';
import { parseProcessSessionName } from '../../lib/processes/names.js';
import type { PortConflictInfo } from '../../lib/processes/port-conflicts.js';
import {
  SpacesError,
  WorkspaceDeleteError,
  type WorkspaceDeleteErrorCode,
} from '../../types/errors.js';
import type { TerminalSnapshot } from '../backend.js';
import type { AgentControlInfo, AgentDefinitionInfo, AgentHistoryEntry, AgentSettingItem, AgentSettingSchemaItem, AgentToolInfo, AgentTreeNode } from '../../agents/agent-runtime-types.js';
import type { AgentStateUpdateDelta, WorkspaceAgentState } from '../../lib/tmux-lite/agent-event-manager.js';
import type { AgentWorkspaceTargetPayload } from '../../lib/tmux-lite/protocol.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewRequestError } from '../../types/errors.js';
import { throwServiceStartError } from './service-start-error.js';
import { executeSpaceCommand } from '../../lib/tmux-lite/agents/extensions/space-command.js';
import { formatArtifactUri } from '../../core/artifact-cap.js';


export interface LocalSessionBackendDependencies {
  listSessions: typeof listSessions;
  listReplays: typeof listReplaysOffline;
  ensureServer: typeof ensureServer;
  sendTmuxCommand: (command: TmuxCommand) => Promise<TmuxResponse>;
  createSession: typeof createSession;
  terminateSession: typeof terminateSession;
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
  /** Forced full-rebuild fetch for nonce-gap recovery. Falls back to
   *  getMachineSnapshot when absent. */
  resyncMachineSnapshot?: typeof getMachineSnapshot;
  watchMachineEvents: typeof watchMachineEvents;
  dismissReplay: typeof dismissReplayOffline;
  undismissReplay: typeof undismissReplayOffline;
  listProjectSummaries: typeof listProjectSummaries;
  scanWorkspaces: typeof scanWorkspaces;
  deleteWorkspaceCore: typeof deleteWorkspaceCore;
  prepareWorkspaceForSession: typeof prepareWorkspaceForSession;
  rerunWorkspaceScriptsForSession: typeof rerunWorkspaceScriptsForSession;
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
    code === 'PRESERVED_LEFTOVERS' ||
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
    terminateSession,
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
    resyncMachineSnapshot,
    watchMachineEvents,
    dismissReplay: dismissReplayOffline,
    undismissReplay: undismissReplayOffline,
    listProjectSummaries,
    scanWorkspaces,
    deleteWorkspaceCore,
    prepareWorkspaceForSession,
    rerunWorkspaceScriptsForSession,
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
  private pendingAttachedAgentSession: { agentSessionId: string; sessionId: string } | null = null;
  private readonly attachLifecycle = new AttachLifecycle((event) => {
    if (event.type === 'attached' && this.pendingAttachedAgentSession?.sessionId === event.sessionId) {
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
  private machineResyncInFlight: Promise<void> | null = null;

  /** Nonce-gap recovery: fetch a forced full rebuild and replace the model.
   *  Single-flight — a burst of gapped events triggers one resync. */
  private requestMachineResync(): void {
    if (this.machineResyncInFlight) return;
    this.machineResyncInFlight = (async () => {
      try {
        const resync = this.deps.resyncMachineSnapshot ?? this.deps.getMachineSnapshot;
        const snapshot = await resync();
        this.machineStateClient.replaceSnapshot(snapshot);
        this.agentStateCache = machineSnapshotToAgentState(snapshot);
        this.broadcastAgentSnapshot();
        this.emitDerivedMachineState();
      } catch {
        // Recoverable: the next snapshot-replaced (5-min reconciliation) or
        // reconnect trues the model up.
      } finally {
        this.machineResyncInFlight = null;
      }
    })();
  }

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

  setScriptOutputHandler(handler: ((data: Uint8Array) => void) | null): void {
    this.attachLifecycle.setScriptOutputHandler(handler);
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
          // Contiguity check: every scoped delta carries the next nonce. A
          // gap (dropped event, daemon restart) means our model diverged —
          // request a forced resync instead of applying onto bad state.
          if (event.type !== 'snapshot-replaced') {
            const expected = this.machineStateClient.getSnapshot().snapshotNonce + 1;
            if (event.snapshotNonce !== expected) {
              this.requestMachineResync();
              return;
            }
          }
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
    this.pendingAttachedAgentSession = null;
    this.connected = false;
    this.emit({ type: 'status', status: 'disconnected' });
    if (wasAttached) {
      this.emit({ type: 'detached' });
    }
  }

  async listProjects(): Promise<void> {
    const projects = machineSnapshotToProjects(await this.refreshMachineSnapshotState());
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
    const mappedWorkspaces = machineSnapshotToWorkspaces(await this.refreshMachineSnapshotState());
    this.emit({
      type: 'workspaces',
      workspaces: mappedWorkspaces,
    });
  }


  async previewWorkspaceStatusChange(projectName: string, workspaceName: string, phase: import('../../types/config.js').WorkspacePhase): Promise<import('../../types/goals.js').WorkspacePhaseChangePreview> {
    const response = await this.sendTmuxCommand({ type: 'workspace-phase-preview', projectName, workspaceName, phase });
    if (response.type === 'workspace-phase-preview') {
      return response.preview;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected workspace phase preview response');
  }

  async setWorkspaceStatus(projectName: string, workspaceName: string, phase: import('../../types/config.js').WorkspacePhase, options?: { cascade?: boolean }): Promise<void> {
    const response = await this.sendTmuxCommand({ type: 'workspace-set-phase', projectName, workspaceName, phase, cascade: options?.cascade });
    if (response.type === 'ok') {
      await this.listWorkspaces();
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected workspace phase response');
  }

  async listSessions(workspaceId?: string): Promise<void> {
    const filtered = machineSnapshotToSessions(await this.refreshMachineSnapshotState(), workspaceId);
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
            const data = Buffer.from(event.data, 'base64');
            this.attachLifecycle.pushScriptData(data);
            this.emit({ type: 'script_output', phase: event.phase, data, done: event.done, error: event.error, workspaceId: params.workspaceId });
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

  async terminateSession(sessionId: string, options: TerminateSessionOptions = {}): Promise<void> {
    const response = await this.sendTmuxCommand({ type: 'terminate', id: sessionId, mode: options.mode, graceMs: options.graceMs });
    if (response.type === 'ok') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected terminate session response');
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
          this.attachLifecycle.pushScriptData(data);
          this.emit({ type: 'script_output', phase: 'remove', data, done: event.done, error: event.error, workspaceId: resolvedWorkspaceId });
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

  async rerunWorkspaceScripts(projectName: string, workspaceId: string): Promise<void> {
    const workspaceRef = await this.resolveWorkspace(projectName, workspaceId);
    let currentPhase: import('../../types/script-phase.js').WorkspaceScriptPhase = 'setup';
    const result = await this.deps.rerunWorkspaceScriptsForSession({
      projectName,
      workspacePath: workspaceRef.path,
      workspaceName: workspaceRef.id,
      repository: readProjectConfig(projectName).repository,
      interactiveScripts: false,
      onOutput: (data) => {
        this.attachLifecycle.pushScriptData(data);
        this.emit({ type: 'script_output', phase: currentPhase, data: new Uint8Array(data), workspaceId: workspaceRef.id });
      },
      onPhaseStart: (phase) => {
        currentPhase = phase;
        this.emit({
          type: 'script_output',
          phase,
          data: new Uint8Array(0),
          done: false,
          workspaceId: workspaceRef.id,
        });
      },
      selection: 'setup-select',
    });
    if (!result.success) {
      this.emit({ type: 'command_error', code: `${result.phase.toUpperCase()}_SCRIPT_FAILED`, message: result.error });
      throw new Error(result.error);
    }
    this.emit({ type: 'script_output', phase: currentPhase, data: new Uint8Array(0), done: true, workspaceId: workspaceRef.id });
  }

  async runWorkspaceScriptSelection(projectName: string, workspaceId: string, selection: 'setup' | 'select' | 'setup-select'): Promise<void> {
    const workspaceRef = await this.resolveWorkspace(projectName, workspaceId);
    let currentPhase: import('../../types/script-phase.js').WorkspaceScriptPhase = selection === 'select' ? 'select' : 'setup';
    const result = await this.deps.rerunWorkspaceScriptsForSession({
      projectName,
      workspacePath: workspaceRef.path,
      workspaceName: workspaceRef.id,
      repository: readProjectConfig(projectName).repository,
      interactiveScripts: false,
      onOutput: (data) => {
        this.attachLifecycle.pushScriptData(data);
        this.emit({ type: 'script_output', phase: currentPhase, data: new Uint8Array(data), workspaceId: workspaceRef.id });
      },
      onPhaseStart: (phase) => {
        currentPhase = phase;
        this.emit({
          type: 'script_output',
          phase,
          data: new Uint8Array(0),
          done: false,
          workspaceId: workspaceRef.id,
        });
      },
      selection,
    });
    if (!result.success) {
      this.emit({ type: 'command_error', code: `${result.phase.toUpperCase()}_SCRIPT_FAILED`, message: result.error });
      throw new Error(result.error);
    }
    this.emit({ type: 'script_output', phase: currentPhase, data: new Uint8Array(0), done: true, workspaceId: workspaceRef.id });
  }

  async runWorkspaceOpenScripts(projectName: string, workspaceId: string): Promise<void> {
    const workspaceRef = await this.resolveWorkspace(projectName, workspaceId);
    let currentPhase: import('../../types/script-phase.js').WorkspaceScriptPhase = 'select';
    const result = await this.deps.prepareWorkspaceForSession({
      projectName,
      workspacePath: workspaceRef.path,
      workspaceName: workspaceRef.id,
      repository: readProjectConfig(projectName).repository,
      interactiveScripts: false,
      onOutput: (data) => {
        this.attachLifecycle.pushScriptData(data);
        this.emit({ type: 'script_output', phase: currentPhase, data: new Uint8Array(data), workspaceId: workspaceRef.id });
      },
      onPhaseStart: (phase) => {
        currentPhase = phase;
        this.emit({
          type: 'script_output',
          phase,
          data: new Uint8Array(0),
          done: false,
          workspaceId: workspaceRef.id,
        });
      },
    });
    if (!result.success) {
      this.emit({ type: 'command_error', code: `${result.phase.toUpperCase()}_SCRIPT_FAILED`, message: result.error });
      throw new Error(result.error);
    }
    this.emit({ type: 'script_output', phase: currentPhase, data: new Uint8Array(0), done: true, workspaceId: workspaceRef.id });
  }
  async listWorkspaceNotes(projectName: string, workspaceName: string): Promise<import('../../types/workspace.js').WorkspaceNote[]> {
    const response = await this.sendTmuxCommand({ type: 'workspace-notes-list', projectName, workspaceName });
    if (response.type === 'workspace-notes') return response.notes;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected workspace notes response');
  }

  async addWorkspaceNote(projectName: string, workspaceName: string, body: string): Promise<import('../../types/workspace.js').WorkspaceNote> {
    const response = await this.sendTmuxCommand({ type: 'workspace-note-add', projectName, workspaceName, body });
    if (response.type === 'workspace-note') {
      await this.listWorkspaces();
      return response.note;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected workspace note add response');
  }

  async updateWorkspaceNote(projectName: string, workspaceName: string, noteId: string, body: string): Promise<import('../../types/workspace.js').WorkspaceNote> {
    const response = await this.sendTmuxCommand({ type: 'workspace-note-update', projectName, workspaceName, noteId, body });
    if (response.type === 'workspace-note') {
      await this.listWorkspaces();
      return response.note;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected workspace note update response');
  }

  async removeWorkspaceNote(projectName: string, workspaceName: string, noteId: string): Promise<void> {
    const response = await this.sendTmuxCommand({ type: 'workspace-note-remove', projectName, workspaceName, noteId });
    if (response.type === 'ok') {
      await this.listWorkspaces();
      return;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected workspace note remove response');
  }

  async addGoalNearWorkspace(projectName: string, workspaceName: string, title: string, position: 'before' | 'after'): Promise<import('../../types/goals.js').GoalRecord> {
    const response = await this.sendTmuxCommand({ type: 'goal-add-near-workspace', projectName, workspaceName, title, position });
    if (response.type === 'goal') {
      await this.listWorkspaces();
      return response.goal;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected goal add response');
  }

  async updateGoal(projectName: string, goalId: string, updates: import('../../types/goals.js').GoalUpdateInput): Promise<import('../../types/goals.js').GoalRecord> {
    const response = await this.sendTmuxCommand({ type: 'goal-update', projectName, goalId, updates });
    if (response.type === 'goal') {
      await this.listWorkspaces();
      return response.goal;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected goal update response');
  }

  async getGoalDetail(projectName: string, goalId: string): Promise<{ doc: import('../../types/goals.js').GoalDoc; validation: import('../../types/goals.js').GoalValidation }> {
    const response = await this.sendTmuxCommand({ type: 'goal-detail', projectName, goalId });
    if (response.type === 'goal-detail') return { doc: response.doc, validation: response.validation };
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected goal detail response');
  }

  async listGoalChains(projectName: string): Promise<import('../../types/goals.js').GoalChainSummary[]> {
    const response = await this.sendTmuxCommand({ type: 'goal-chains-list', projectName });
    if (response.type === 'goal-chains') return response.chains;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected goal chains list response');
  }

  async addPlannedGoalToChain(projectName: string, input: import('../../core/goal-chain.js').AddPlannedGoalToChainInput): Promise<import('../../types/goals.js').GoalRecord> {
    const response = await this.sendTmuxCommand({ type: 'goal-add-planned', projectName, input });
    if (response.type === 'goal') {
      await this.listWorkspaces();
      return response.goal;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected planned goal add response');
  }

  async moveGoalInChain(projectName: string, sourceToken: string, targetToken: string, position: 'before' | 'after'): Promise<import('../../types/goals.js').GoalChain> {
    const response = await this.sendTmuxCommand({ type: 'goal-reorder', projectName, sourceToken, targetToken, position });
    if (response.type === 'goal-chain') {
      await this.listWorkspaces();
      return response.chain;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected goal reorder response');
  }

  async getGoalStackStatus(projectName: string, workspaceName: string): Promise<import('../../types/goals.js').ChainStackStatus> {
    const response = await this.sendTmuxCommand({ type: 'goal-stack-status', projectName, workspaceName });
    if (response.type === 'goal-stack-status') return response.status;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected goal stack status response');
  }

  async waiveGoalGate(projectName: string, goalId: string, phase: string, reason: string): Promise<import('../../types/goals.js').GoalRecord> {
    const response = await this.sendTmuxCommand({ type: 'goal-gate-waive', projectName, goalId, phase, reason });
    if (response.type === 'goal') {
      await this.listWorkspaces();
      return response.goal;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected goal gate waive response');
  }

  async addGoalRequirement(projectName: string, goalId: string, input: AddRequirementInput): Promise<import('../../types/goals.js').Requirement> {
    const goal = findGoalRecord(projectName, goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    const { validation, requirement } = addRequirement(goal.validation, input, goal);
    writeGoalRecord(projectName, { ...goal, validation });
    await this.listWorkspaces();
    return requirement;
  }

  async updateGoalRequirement(projectName: string, goalId: string, requirementId: string, patch: UpdateRequirementInput): Promise<import('../../types/goals.js').Requirement> {
    const goal = findGoalRecord(projectName, goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    const { validation, requirement } = updateRequirement(goal.validation, requirementId, patch, goal);
    writeGoalRecord(projectName, { ...goal, validation });
    await this.listWorkspaces();
    return requirement;
  }

  async removeGoalRequirement(projectName: string, goalId: string, requirementId: string): Promise<void> {
    const goal = findGoalRecord(projectName, goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    const validation = removeRequirement(goal.validation, requirementId, goal);
    writeGoalRecord(projectName, { ...goal, validation });
    await this.listWorkspaces();
  }

  async reorderGoalRequirement(projectName: string, goalId: string, requirementId: string, position: number): Promise<void> {
    const goal = findGoalRecord(projectName, goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    const validation = reorderRequirement(goal.validation, requirementId, position);
    writeGoalRecord(projectName, { ...goal, validation });
    await this.listWorkspaces();
  }

  async reopenGoalRequirement(projectName: string, goalId: string, requirementId: string): Promise<import('../../types/goals.js').Requirement> {
    const goal = findGoalRecord(projectName, goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    const result = reopenRequirement(goal, requirementId);
    writeGoalRecord(projectName, result.goal);
    await this.listWorkspaces();
    return result.requirement;
  }

  async attachGoalEvidence(projectName: string, goalId: string, requirementId: string, input: AttachEvidenceInput): Promise<import('../../types/goals.js').Evidence> {
    const goal = findGoalRecord(projectName, goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    const result = attachManualEvidence(projectName, goal, requirementId, input);
    writeGoalRecord(projectName, result.goal);
    await this.listWorkspaces();
    return result.evidence;
  }

  async runGoalGeneration(projectName: string, goalId: string, requirementId: string): Promise<{ requirement: import('../../types/goals.js').Requirement; evidence: import('../../types/goals.js').Evidence; autoAccepted: boolean }> {
    const goal = findGoalRecord(projectName, goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    const result = runGenerationCommand(projectName, goal, requirementId);
    writeGoalRecord(projectName, result.goal);
    await this.listWorkspaces();
    return { requirement: result.requirement, evidence: result.evidence, autoAccepted: result.autoAccepted };
  }

  async runGoalJudgment(projectName: string, goalId: string, requirementId: string): Promise<{ requirement: import('../../types/goals.js').Requirement; review: import('../../types/goals.js').Review }> {
    const goal = findGoalRecord(projectName, goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    const requirement = goal.validation.requirements[requirementId];
    if (!requirement) throw new Error(`Unknown requirement: ${requirementId}`);
    let result;
    if (requirement.judgment.kind === 'command') result = runJudgmentCommand(projectName, goal, requirementId);
    else if (requirement.judgment.kind === 'llm') result = runLlmJudgment(goal, requirementId);
    else throw new Error('Human judgment is not run; use recordGoalHumanReview.');
    writeGoalRecord(projectName, result.goal);
    await this.listWorkspaces();
    return { requirement: result.requirement, review: result.review };
  }

  async recordGoalHumanReview(projectName: string, goalId: string, requirementId: string, decision: HumanReviewDecision, note: string, score?: number, createdBy?: string): Promise<import('../../types/goals.js').Review> {
    const goal = findGoalRecord(projectName, goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    const result = recordHumanReview(goal, requirementId, decision, note, score, createdBy);
    writeGoalRecord(projectName, result.goal);
    await this.listWorkspaces();
    return result.review;
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

  async resolvePortConflict(conflict: PortConflictInfo): Promise<void> {
    const response = await this.sendTmuxCommand({
      type: 'service-resolve-port-conflict',
      conflict,
    });
    if (response.type === 'ok') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected port conflict resolution response');
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
    // Project agents: '<project>:@base' is a pseudo-workspace homed at the
    // project base clone; the server normalizes the real path.
    if (workspaceId.endsWith(':@base')) {
      const projectName = workspaceId.slice(0, -':@base'.length);
      return { workspaceId, workspaceName: '@base', workspacePath: '', projectName };
    }
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

  async getAgentTranscriptRange(
    workspaceId: string,
    agentSessionId: string,
    before: string | undefined,
    limit: number,
  ): Promise<{ blocks: unknown[]; oldestCursor: string | null; hasMore: boolean }> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({
      type: 'agent-transcript-range',
      target,
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

  async getAgentControlInfo(workspaceId: string, agentSessionId: string): Promise<AgentControlInfo> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-control-info', target, agentSessionId });
    if (tmuxResponse.type === 'agent-control-info') return tmuxResponse.info;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected agent control-info response');
  }

  async setAgentModel(workspaceId: string, agentSessionId: string, provider: string, modelId: string): Promise<boolean> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-set-model', target, agentSessionId, provider, modelId });
    if (tmuxResponse.type === 'agent-set-model') return tmuxResponse.ok;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected agent set-model response');
  }

  async setAgentThinkingLevel(workspaceId: string, agentSessionId: string, level: string): Promise<boolean> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-set-thinking-level', target, agentSessionId, level });
    if (tmuxResponse.type === 'agent-bool') return tmuxResponse.ok;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected set-thinking-level response');
  }

  async setAgentApprovalMode(workspaceId: string, agentSessionId: string, mode: string): Promise<boolean> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-set-approval-mode', target, agentSessionId, mode });
    if (tmuxResponse.type === 'agent-bool') return tmuxResponse.ok;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected set-approval-mode response');
  }

  async getAgentAuthProviders(): Promise<Array<{ provider: string; hasAuth: boolean; accounts?: Array<{ id: number; type: string; label: string; disabled: boolean }> }>> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-auth-providers' });
    if (tmuxResponse.type === 'agent-auth-providers') return tmuxResponse.providers;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected auth-providers response');
  }

  async removeAgentProviderAccount(provider: string, credentialId: number): Promise<boolean> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-remove-account', provider, credentialId });
    if (tmuxResponse.type === 'agent-remove-account') return tmuxResponse.ok;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected remove-account response');
  }

  async checkAgentProviderUsage(provider: string): Promise<Array<{ id: number; email?: string; ok: boolean | null; reason?: string; limits: Array<{ label: string; unit?: string; used?: number; limit?: number; remaining?: number; remainingFraction?: number; resetsAt?: number }> }>> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-provider-usage', provider });
    if (tmuxResponse.type === 'agent-provider-usage') return tmuxResponse.accounts;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected provider-usage response');
  }

  async setAgentProviderApiKey(provider: string, key: string): Promise<boolean> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-set-api-key', provider, key });
    if (tmuxResponse.type === 'agent-bool') return tmuxResponse.ok;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected set-api-key response');
  }

  async getAgentSettings(): Promise<AgentSettingItem[]> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-get-settings' });
    if (tmuxResponse.type === 'agent-settings') return tmuxResponse.settings;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected settings response');
  }

  async setAgentSetting(path: string, value: string | number | boolean | string[]): Promise<boolean> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-set-setting', path, value });
    if (tmuxResponse.type === 'agent-bool') return tmuxResponse.ok;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected set-setting response');
  }

  async startAgentOAuthLogin(provider: string, flowId: string): Promise<boolean> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-oauth-login', provider, flowId });
    if (tmuxResponse.type === 'agent-bool') return tmuxResponse.ok;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected oauth-login response');
  }

  async respondAgentOAuthPrompt(flowId: string, value: string): Promise<boolean> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-oauth-respond', flowId, value });
    if (tmuxResponse.type === 'agent-bool') return tmuxResponse.ok;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected oauth-respond response');
  }

  async getAgentSettingsSchema(): Promise<AgentSettingSchemaItem[]> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-settings-schema' });
    if (tmuxResponse.type === 'agent-settings-schema') return tmuxResponse.schema;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected settings-schema response');
  }

  async getAgentTools(workspaceId: string, agentSessionId: string): Promise<AgentToolInfo[]> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-tools', target, agentSessionId });
    if (tmuxResponse.type === 'agent-tools') return tmuxResponse.tools;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected tools response');
  }

  async listAgentDefinitions(workspaceId: string): Promise<AgentDefinitionInfo[]> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-list-agents', target });
    if (tmuxResponse.type === 'agent-list-agents') return tmuxResponse.agents;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected list-agents response');
  }

  async compactAgentSession(workspaceId: string, agentSessionId: string): Promise<boolean> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-compact', target, agentSessionId });
    if (tmuxResponse.type === 'agent-bool') return tmuxResponse.ok;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected compact response');
  }

  async cycleAgentRole(workspaceId: string, agentSessionId: string, direction: 'forward' | 'backward'): Promise<boolean> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-cycle-role', target, agentSessionId, direction });
    if (tmuxResponse.type === 'agent-bool') return tmuxResponse.ok;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected cycle-role response');
  }

  async applyAgentModelRole(workspaceId: string, agentSessionId: string, role: string): Promise<boolean> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-apply-role', target, agentSessionId, role });
    if (tmuxResponse.type === 'agent-bool') return tmuxResponse.ok;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected apply-role response');
  }

  async getAgentHistory(workspaceId: string, agentSessionId: string): Promise<AgentHistoryEntry[]> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-history', target, agentSessionId });
    if (tmuxResponse.type === 'agent-history') return tmuxResponse.entries;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected history response');
  }

  async getAgentSessionTree(workspaceId: string, agentSessionId: string): Promise<AgentTreeNode[]> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-tree', target, agentSessionId });
    if (tmuxResponse.type === 'agent-tree') return tmuxResponse.nodes;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected tree response');
  }

  /** artifact:// URI for a workspace target (project methods use '@base'). */
  private async artifactUriFor(workspaceId: string, relPath = ''): Promise<string> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    return formatArtifactUri(target.projectName, target.workspaceName, relPath);
  }

  async listWorkspaceArtifacts(workspaceId: string): Promise<Array<{ path: string; size: number; pointer: boolean }>> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'artifact-list', uriPrefix: await this.artifactUriFor(workspaceId) });
    if (tmuxResponse.type === 'artifact-list') return tmuxResponse.entries;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected artifact-list response');
  }

  async readWorkspaceArtifact(workspaceId: string, path: string): Promise<{ base64: string; size: number; truncated: boolean }> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'artifact-read', uri: await this.artifactUriFor(workspaceId, path) });
    if (tmuxResponse.type === 'artifact-read') return { base64: tmuxResponse.base64, size: tmuxResponse.size, truncated: tmuxResponse.truncated };
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected artifact-read response');
  }

  async writeWorkspaceArtifact(workspaceId: string, path: string, contentBase64: string, message?: string): Promise<string> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'artifact-write', uri: await this.artifactUriFor(workspaceId, path), contentBase64, message });
    if (tmuxResponse.type === 'artifact-write') return tmuxResponse.commit;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected artifact-write response');
  }

  async listWorkspaceFavorites(workspaceId: string): Promise<string[]> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'favorites-list', uriPrefix: await this.artifactUriFor(workspaceId) });
    if (tmuxResponse.type === 'favorites') return tmuxResponse.favorites;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected favorites-list response');
  }

  async toggleWorkspaceFavorite(workspaceId: string, path: string): Promise<{ favorites: string[]; snapshotSkipped?: string[] }> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'favorites-toggle', uri: await this.artifactUriFor(workspaceId, path) });
    if (tmuxResponse.type === 'favorites') return { favorites: tmuxResponse.favorites, snapshotSkipped: tmuxResponse.snapshotSkipped };
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected favorites-toggle response');
  }

  async mergeWorkspaceFavorites(workspaceId: string, paths: string[]): Promise<string[]> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'favorites-merge', uriPrefix: await this.artifactUriFor(workspaceId), paths });
    if (tmuxResponse.type === 'favorites') return tmuxResponse.favorites;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected favorites-merge response');
  }

  async listProjectArtifacts(projectName: string): Promise<Array<{ path: string; size: number; pointer: boolean }>> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'artifact-list', uriPrefix: formatArtifactUri(projectName, '@base') });
    if (tmuxResponse.type === 'artifact-list') return tmuxResponse.entries;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected artifact-list response');
  }

  async readProjectArtifact(projectName: string, path: string): Promise<{ base64: string; size: number; truncated: boolean }> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'artifact-read', uri: formatArtifactUri(projectName, '@base', path) });
    if (tmuxResponse.type === 'artifact-read') return { base64: tmuxResponse.base64, size: tmuxResponse.size, truncated: tmuxResponse.truncated };
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected artifact-read response');
  }

  async writeProjectArtifact(projectName: string, path: string, contentBase64: string, message?: string): Promise<string> {
    const tmuxResponse = await this.sendTmuxCommand({ type: 'artifact-write', uri: formatArtifactUri(projectName, '@base', path), contentBase64, message });
    if (tmuxResponse.type === 'artifact-write') return tmuxResponse.commit;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected artifact-write response');
  }

  async getProjectArtifactsStatus(projectName: string): Promise<{ repoPath: string; remote: string | null; branches: string[]; pointerCommitted?: boolean }> {
    const r = await this.sendTmuxCommand({ type: 'project-artifacts-status', projectName });
    if (r.type === 'project-artifacts-status') return { repoPath: r.repoPath, remote: r.remote, branches: r.branches, pointerCommitted: r.pointerCommitted };
    if (r.type === 'error') throw new Error(r.message);
    throw new Error('Unexpected project-artifacts-status response');
  }

  async setProjectArtifactsRemote(projectName: string, url: string): Promise<{ pushed: boolean; fastForwarded: boolean }> {
    const r = await this.sendTmuxCommand({ type: 'project-artifacts-remote-set', projectName, url });
    if (r.type === 'project-artifacts-sync') return { pushed: r.pushed, fastForwarded: r.fastForwarded };
    if (r.type === 'error') throw new Error(r.message);
    throw new Error('Unexpected project-artifacts-remote-set response');
  }

  async reportProblem(note: string, clientBundle: unknown, opts: { fileIssue?: boolean; projectName?: string } = {}): Promise<{ path: string; issueUrl?: string; issueNumber?: number }> {
    const r = await this.sendTmuxCommand({ type: 'report-problem', note, clientBundleJson: JSON.stringify(clientBundle), fileIssue: opts.fileIssue, projectName: opts.projectName });
    if (r.type === 'report-problem') return { path: r.path, issueUrl: r.issueUrl, issueNumber: r.issueNumber };
    if (r.type === 'error') throw new Error(r.message);
    throw new Error('Unexpected report-problem response');
  }

  async rollupProjectArtifacts(projectName: string, workspace: string, opts: { removeBranch?: boolean } = {}): Promise<{ mergeCommit: string }> {
    const r = await this.sendTmuxCommand({ type: 'project-artifacts-rollup', projectName, workspace, removeBranch: opts.removeBranch });
    if (r.type === 'project-artifacts-rollup') return { mergeCommit: r.mergeCommit };
    if (r.type === 'error') throw new Error(r.message);
    throw new Error('Unexpected rollup response');
  }

  async mintArtifactShare(uri: string, opts: { ttlMs?: number; maxUses?: number } = {}): Promise<{ url: string; tokenId: string; expiresAt: number }> {
    const r = await this.sendTmuxCommand({ type: 'artifact-share-mint', uri, ttlMs: opts.ttlMs, maxUses: opts.maxUses });
    if (r.type === 'artifact-share-mint') return { url: r.url, tokenId: r.tokenId, expiresAt: r.expiresAt };
    if (r.type === 'error') throw new Error(r.message);
    throw new Error('Unexpected artifact-share-mint response');
  }

  async revokeArtifactShare(tokenId: string): Promise<boolean> {
    const r = await this.sendTmuxCommand({ type: 'artifact-share-revoke', tokenId });
    if (r.type === 'artifact-share-revoke') return r.revoked;
    if (r.type === 'error') throw new Error(r.message);
    throw new Error('Unexpected artifact-share-revoke response');
  }

  async saveWorkspaceTrigger(workspaceId: string, trigger: import('../../core/triggers.js').TriggerRecord): Promise<import('../../core/triggers.js').TriggerRecord> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const r = await this.sendTmuxCommand({ type: 'trigger-save', target, trigger });
    if (r.type === 'trigger-save') return r.trigger;
    if (r.type === 'error') throw new Error(r.message);
    throw new Error('Unexpected trigger-save response');
  }

  async runWorkspaceTriggerNow(workspaceId: string, triggerId: string): Promise<{ sessionId: string }> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const r = await this.sendTmuxCommand({ type: 'trigger-run-now', target, triggerId });
    if (r.type === 'trigger-run-now') return { sessionId: r.sessionId };
    if (r.type === 'error') throw new Error(r.message);
    throw new Error('Unexpected trigger-run-now response');
  }

  async provisionProjectArtifacts(projectName: string): Promise<{ slug: string; url: string; created: boolean; blobsUploaded: number; collaboratorsCopied: number }> {
    const r = await this.sendTmuxCommand({ type: 'project-artifacts-provision', projectName });
    if (r.type === 'project-artifacts-provision') return { slug: r.slug, url: r.url, created: r.created, blobsUploaded: r.blobsUploaded, collaboratorsCopied: r.collaboratorsCopied };
    if (r.type === 'error') throw new Error(r.message);
    throw new Error('Unexpected provision response');
  }

  async syncProjectArtifacts(projectName: string): Promise<{ pushed: boolean; fastForwarded: boolean }> {
    const r = await this.sendTmuxCommand({ type: 'project-artifacts-sync', projectName });
    if (r.type === 'project-artifacts-sync') return { pushed: r.pushed, fastForwarded: r.fastForwarded };
    if (r.type === 'error') throw new Error(r.message);
    throw new Error('Unexpected project-artifacts-sync response');
  }

  async listRepoFiles(workspaceId: string): Promise<Array<{ path: string; status?: string }>> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'repo-tree', target });
    if (tmuxResponse.type === 'repo-tree') return tmuxResponse.entries;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected repo-tree response');
  }

  async readRepoFile(workspaceId: string, path: string): Promise<{ base64: string | null; size: number; truncated: boolean }> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'repo-read', target, path });
    if (tmuxResponse.type === 'repo-read') return { base64: tmuxResponse.base64, size: tmuxResponse.size, truncated: tmuxResponse.truncated };
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected repo-read response');
  }

  async searchRepoContent(workspaceId: string, query: string, options?: { caseSensitive?: boolean }): Promise<{ hits: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'repo-search', target, query, caseSensitive: options?.caseSensitive });
    if (tmuxResponse.type === 'repo-search') return { hits: tmuxResponse.hits, truncated: tmuxResponse.truncated };
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected repo-search response');
  }

  async commitWorkspaceChanges(workspaceId: string, message: string): Promise<string | null> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'repo-commit', target, message });
    if (tmuxResponse.type === 'repo-commit') return tmuxResponse.commit;
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected repo-commit response');
  }

  async navigateAgentHistory(workspaceId: string, agentSessionId: string, entryId: string, mode: 'redo' | 'jump' = 'redo'): Promise<{ ok: boolean; editorText?: string }> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const tmuxResponse = await this.sendTmuxCommand({ type: 'agent-navigate-history', target, agentSessionId, entryId, mode });
    if (tmuxResponse.type === 'agent-navigate') return { ok: tmuxResponse.ok, editorText: tmuxResponse.editorText };
    if (tmuxResponse.type === 'error') throw new Error(tmuxResponse.message);
    throw new Error('Unexpected navigate-history response');
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

  async interruptAgentSession(workspaceId: string, agentSessionId: string): Promise<boolean> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    // Note: 'agent-interrupt' gracefully stops the current turn; 'agent-abort' kills the tmux session.
    const response = await this.sendTmuxCommand({ type: 'agent-interrupt', target, agentSessionId });
    if (response.type === 'agent-bool') {
      await this.refreshMachineSnapshotState();
      return response.ok;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected agent interrupt response');
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
    this.pendingAttachedAgentSession = {
      agentSessionId,
      sessionId: response.session.id,
    };
    try {
      await this.refreshMachineSnapshotState();
      await this.attachSession({ sessionId: response.session.id, workspaceId, viewOnly: options.viewOnly, cols: options.cols, rows: options.rows });
    } catch (error) {
      this.pendingAttachedAgentSession = null;
      this.attachedAgentSessionId = null;
      throw error;
    }
  }

  async promptAgentSession(workspaceId: string, agentSessionId: string, text: string, images?: import('../../lib/tmux-lite/protocol.js').AgentPromptImage[], options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-prompt', target, agentSessionId, text, images, streamingBehavior: options?.streamingBehavior });
    if (response.type === 'ok') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error(`Unexpected prompt response: ${response.type}`);
  }

  async removeAgentQueuedMessage(workspaceId: string, agentSessionId: string, kind: 'steering' | 'followUp', index: number): Promise<string | null> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-queue-remove', target, agentSessionId, kind, index });
    if (response.type === 'agent-queued-message') {
      await this.refreshMachineSnapshotState();
      return response.message;
    }
    if (response.type === 'error') throw new Error(response.message);
    throw new Error(`Unexpected queued message response: ${response.type}`);
  }

  async stageUpload(workspaceId: string, fileName: string, data: string, mimeType: string): Promise<{ stagedPath: string }> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-stage-upload', target, fileName, data, mimeType });
    if (response.type === 'agent-staged') return { stagedPath: response.stagedPath };
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected stage upload response');
  }

  async sendDialogResponse(dialogId: string, dialogType: import('../../lib/tmux-lite/agents/host-ui-bridge.js').HostUIDialogResponseType, value: import('../../lib/tmux-lite/agents/host-ui-bridge.js').HostUIDialogResponseValue): Promise<void> {
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

  async listAvailableEditors(workspaceId: string): Promise<WorkspaceEditorOption[]> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'workspace-editors-list', target });
    if (response.type === 'workspace-editors') return response.editors;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected editor listing response');
  }

  async openWorkspaceInEditor(workspaceId: string, editorId: WorkspaceEditorId): Promise<void> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'workspace-editor-open', target, editorId });
    if (response.type === 'ok') return;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected open editor response');
  }

  async runSpaceCommand(workspaceId: string, argsText: string): Promise<string> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const [{ parseCommandArgs }, { execCommand }] = await Promise.all([
      import('@oh-my-pi/pi-coding-agent/utils/command-args'),
      import('@oh-my-pi/pi-coding-agent/exec/exec'),
    ]);
    const args = parseCommandArgs(argsText);
    return executeSpaceCommand(
      {
        exec: async (command, commandArgs, options) => {
          const result = await execCommand(command, commandArgs, options?.cwd ?? target.workspacePath, options);
          return { stdout: result.stdout, stderr: result.stderr, code: result.code, killed: result.killed ?? false };
        },
      },
      { cwd: target.workspacePath },
      args,
    );
  }

  async getFileSuggestions(workspaceId: string, prefix: string, limit?: number): Promise<Array<{ path: string; isDirectory: boolean }>> {
    const target = await this.resolveAgentWorkspaceTarget(workspaceId);
    const response = await this.sendTmuxCommand({ type: 'agent-file-suggestions', target, prefix, limit });
    if (response.type === 'agent-file-suggestions') return response.suggestions;
    if (response.type === 'error') throw new Error(response.message);
    throw new Error('Unexpected file suggestions response');
  }
}
