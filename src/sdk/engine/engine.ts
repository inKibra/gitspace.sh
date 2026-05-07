/**
 * GitSpaceEngine — the platform-neutral core of the GitSpace SDK.
 *
 * Owns the BackendManager, session engine state, relay discovery loop, and
 * all action methods. This is the pure (non-React) extraction of what
 * `useMultiBackends` does via React hooks.
 *
 * Lifecycle: `new GitSpaceEngine(config)` → `engine.start()` → use → `engine.destroy()`.
 */

import { BackendManager } from '../../session/backend-manager.js';
import {
  createInitialSessionEngineState,
  sessionEngineReducer,
} from '../../session/reducer.js';
import type {
  BackendSessionState,
  SessionEngineAction,
  SessionEngineState,
} from '../../session/types.js';
import type {
  AttachSessionParams,
  BackendKey,
  CreateProjectParams,
  CreateWorkspaceParams,
  DeleteProjectParams,
  DeleteWorkspaceParams,
  FinalizeProjectParams,
  PreparedProjectResult,
  SessionBackend,
} from '../../session/backend.js';
import type { BackendManagerEvent } from '../../session/backend-manager.js';
import type { NotificationConfig } from '../../notifications/types.js';
import type { WideEventFilter } from '../../types/events.js';
import type { SessionLinearIssueSummary } from '../../types/lifecycle.js';
import type {
  BundleConfigState,
  BundleConfigSubmission,
} from '../../types/bundle-config.js';
import type { WorkspacePhase } from '../../types/config.js';
import type {
  BundleRefreshPlan,
  BundleRefreshSubmission,
} from '../../types/bundle-refresh.js';
import type { ReviewOperation, ReviewResult } from '../../types/review.js';
import type {
  ReplayFrame,
  ReplayFrameTarget,
  ReplayTimeline,
  TerminalSnapshot,
} from '../../lib/tmux-lite/replay/index.js';
import { buildRemoteBackendKey } from '../../session/backend-key.js';
import { logger } from '../../utils/logger.js';
import { toMultiMachineState } from '../../machine/multi/selectors.js';
import { RelayMachineDirectoryClient } from '../../relay-client/machine-directory-client.js';
import type {
  BackendScopedAgentSessionRef,
  BackendScopedSessionRef,
  BackendScopedWorkspaceRef,
  MultiMachineState,
} from '../../machine/multi/types.js';
import type { GitSpaceConfig, PlatformAdapters } from './types.js';

export const LOCAL_BACKEND_KEY: BackendKey = 'local';

export type GitSpaceEngineListener = (state: MultiMachineState) => void;

/**
 * Dispatches a BackendManagerEvent into the session engine reducer.
 * Mirrors the `dispatchBackendEvent` helper from useMultiBackends.
 */
function dispatchBackendEvent(
  event: BackendManagerEvent
): SessionEngineAction | null {
  const { backendKey, event: evt } = event;
  switch (evt.type) {
    case 'status':
      return { type: 'SET_BACKEND_STATUS', backendKey, status: evt.status, error: evt.error ?? null };
    case 'projects':
      return { type: 'SET_PROJECTS', backendKey, projects: evt.projects };
    case 'workspaces':
      // workspaces event may carry savedEventFilters — handle below
      return null; // handled specially
    case 'sessions':
      return { type: 'SET_SESSIONS', backendKey, sessions: evt.sessions };
    case 'replays':
      return { type: 'SET_REPLAYS', backendKey, replays: evt.replays };
    case 'inbox':
      return { type: 'SET_INBOX', backendKey, items: evt.items, unreadCount: evt.unreadCount };
    case 'notification_config':
      return { type: 'SET_NOTIFICATION_CONFIG', backendKey, config: evt.config };
    case 'pane_attached':
      return {
        type: 'ADD_PANE',
        backendKey,
        pane: {
          paneId: evt.paneId,
          streamId: evt.streamId,
          sessionId: evt.sessionId,
          sessionName: evt.sessionName ?? null,
          meta: { sessionName: evt.sessionName ?? null },
          workspaceId: evt.workspaceId ?? null,
          agentSessionId: evt.agentSessionId ?? null,
          viewOnly: evt.viewOnly ?? false,
        },
      };
    case 'pane_meta':
      return { type: 'UPDATE_PANE_META', backendKey, paneId: evt.paneId, meta: evt.meta };
    case 'pane_detached':
    case 'pane_exited':
      return { type: 'REMOVE_PANE', backendKey, paneId: evt.paneId };
    case 'attached':
      return {
        type: 'SET_ATTACHED_SESSION',
        backendKey,
        sessionId: evt.sessionId,
        sessionName: evt.sessionName ?? null,
        meta: { sessionName: evt.sessionName ?? null },
        workspaceId: evt.workspaceId ?? null,
        agentSessionId: evt.agentSessionId ?? null,
      };
    case 'session_meta':
      return { type: 'SET_ATTACHED_SESSION_META', backendKey, meta: evt.meta };
    case 'detached':
    case 'session_exited':
      return { type: 'SET_ATTACHED_SESSION', backendKey, sessionId: null };
    case 'command_error':
      return {
        type: 'SET_COMMAND_ERROR',
        backendKey,
        commandError: { code: evt.code, message: evt.message },
      };
    case 'error':
      return { type: 'SET_BACKEND_STATUS', backendKey, status: 'error', error: evt.message };
    case 'script_output':
      return {
        type: 'SET_SCRIPT_STATE',
        backendKey,
        scriptState:
          evt.done && !evt.error
            ? null
            : {
                phase: evt.phase,
                isRunning: !evt.done,
                error: evt.error,
                exitCode: evt.exitCode,
              },
      };
    case 'events':
      // events may carry savedEventFilters — handled specially
      return null;
    case 'machine_snapshot':
      return { type: 'SET_MACHINE_SNAPSHOT', backendKey, snapshot: evt.snapshot };
    case 'host_ui_dialog_request':
      return { type: 'SET_HOST_UI_DIALOG', backendKey, request: evt.request };
    case 'host_ui_event':
      if (evt.event.type === 'working-message') {
        return {
          type: 'SET_HOST_UI_WORKING_MESSAGE',
          backendKey,
          message: evt.event.payload.message,
        };
      }
      return null;
    default:
      return null;
  }
}

export class GitSpaceEngine {
  private manager: BackendManager;
  private engineState: SessionEngineState;
  private listeners = new Set<GitSpaceEngineListener>();
  private projectedState: MultiMachineState;
  private notifyScheduled = false;

  // Relay discovery state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private directoryClient: RelayMachineDirectoryClient<any> | null = null;
  private registeredRemoteBackends = new Map<string, BackendKey>();
  private deviceCert: string | null = null;
  private relayStopped = false;
  private destroyed = false;

  // Config
  private platform: PlatformAdapters;
  private relay: GitSpaceConfig['relay'];
  private identity: GitSpaceConfig['identity'];

  constructor(config: GitSpaceConfig) {
    this.platform = config.platform;
    this.relay = config.relay;
    this.identity = config.identity;

    this.engineState = createInitialSessionEngineState();
    this.projectedState = toMultiMachineState(this.engineState);

    this.manager = new BackendManager((evt: BackendManagerEvent) => {
      this.handleBackendEvent(evt);
    });
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  /** Start the engine: connect local backend and begin relay discovery. */
  async start(): Promise<void> {
    // Reset destroyed flag — React StrictMode calls unmount→mount in dev,
    // so start() may be called after a prior destroy().
    this.destroyed = false;

    // Register local backend if factory provided
    if (this.platform.createLocalBackend) {
      const backend = this.platform.createLocalBackend();
      this.dispatch({ type: 'REGISTER_BACKEND', descriptor: backend.descriptor });
      this.manager.register(backend);
      try {
        await this.manager.connect(LOCAL_BACKEND_KEY);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[engine] Local backend connect failed: ${message}`);
        this.dispatch({ type: 'SET_BACKEND_STATUS', backendKey: LOCAL_BACKEND_KEY, status: 'error', error: message });
      }
    }

    // Start relay discovery if configured
    await this.startRelayDiscovery();
  }

  /** Tear down all backends and stop relay discovery. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    this.stopRelayDiscovery();
    await this.manager.disconnectAll();
  }

  /**
   * Update relay/identity config at runtime (e.g., identity resolved after
   * provider mount). Restarts relay discovery with new config.
   */
  async updateConfig(config: Pick<GitSpaceConfig, 'relay' | 'identity'>): Promise<void> {
    const relayChanged = config.relay?.url !== this.relay?.url;
    const identityChanged = config.identity?.id !== this.identity?.id;
    this.relay = config.relay;
    this.identity = config.identity;

    if (relayChanged || identityChanged) {
      this.deviceCert = null;
      this.stopRelayDiscovery();
      await this.startRelayDiscovery();
    }
  }

  // ─── State ────────────────────────────────────────────────────────────────────

  /** Current projected multi-machine state. */
  getState(): MultiMachineState {
    // If a notification is pending, compute fresh projection to avoid stale reads
    if (this.notifyScheduled) {
      this.projectedState = toMultiMachineState(this.engineState);
    }
    return this.projectedState;
  }

  /** Full engine state (for consumers that need backend session details). */
  getEngineState(): SessionEngineState {
    return this.engineState;
  }

  /** Subscribe to state changes. Returns unsubscribe function. */
  subscribe(listener: GitSpaceEngineListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ─── Core accessors ─────────────────────────────────────────────────────────

  get activeBackendKey(): BackendKey | null {
    return this.engineState.activeBackendKey;
  }

  get localBackendKey(): BackendKey {
    return LOCAL_BACKEND_KEY;
  }

  /** Raw SessionBackend for a given key. Use for PTY send/resize/setWriteCallback. */
  getBackend(key: BackendKey): SessionBackend | null {
    return this.manager.get(key);
  }

  /** Full BackendSessionState for a given key. */
  getBackendState(key: BackendKey): BackendSessionState | null {
    return this.engineState.backends[key] ?? null;
  }

  // ─── Fanout actions (ALL connected backends) ────────────────────────────────

  listProjects(): void {
    for (const key of this.manager.keys()) {
      this.withBackend(key, (b) => b.listProjects()).catch((e: unknown) =>
        logger.error(`[${key}] listProjects: ${e}`)
      );
    }
  }

  listWorkspaces(): void {
    for (const key of this.manager.keys()) {
      this.withBackend(key, (b) => b.listWorkspaces()).catch((e: unknown) =>
        logger.error(`[${key}] listWorkspaces: ${e}`)
      );
    }
  }

  listSessions(workspaceId?: string): void {
    for (const key of this.manager.keys()) {
      this.withBackend(key, (b) => b.listSessions(workspaceId)).catch((e: unknown) =>
        logger.error(`[${key}] listSessions: ${e}`)
      );
    }
  }

  listReplays(workspaceId?: string, includeDismissed?: boolean): void {
    for (const key of this.manager.keys()) {
      this.withBackend(key, (b) => b.listReplays?.(workspaceId, includeDismissed) ?? Promise.resolve()).catch(
        (e: unknown) => logger.error(`[${key}] listReplays: ${e}`)
      );
    }
  }

  requestInbox(): void {
    for (const key of this.manager.keys()) {
      this.withBackend(key, (b) => b.requestInbox()).catch((e: unknown) =>
        logger.error(`[${key}] requestInbox: ${e}`)
      );
    }
  }

  clearInbox(id?: string): Promise<void> {
    return this.withBackend(LOCAL_BACKEND_KEY, (b) => b.clearInbox(id));
  }

  markInboxRead(id: string): Promise<void> {
    return this.withBackend(LOCAL_BACKEND_KEY, (b) => b.markInboxRead(id));
  }

  getNotificationConfig(): void {
    for (const key of this.manager.keys()) {
      this.withBackend(key, (b) => b.getNotificationConfig()).catch((e: unknown) =>
        logger.error(`[${key}] getNotificationConfig: ${e}`)
      );
    }
  }

  updateNotificationConfig(config: NotificationConfig): Promise<void> {
    return this.withBackend(LOCAL_BACKEND_KEY, (b) => b.updateNotificationConfig(config));
  }

  // ─── Ref-scoped actions ─────────────────────────────────────────────────────

  attachSession(ref: BackendScopedWorkspaceRef, params: AttachSessionParams): Promise<void> {
    return this.withRefBackend(ref, (b) =>
      b.attachSession({ workspaceId: ref.workspaceId, ...params })
    );
  }

  detachSession(ref: BackendScopedWorkspaceRef | BackendScopedSessionRef): Promise<void> {
    return this.withRefBackend(ref, (b) => b.detachSession());
  }

  cancelPendingScripts(ref: BackendScopedWorkspaceRef): Promise<void> {
    return this.withRefBackend(ref, (b) => b.cancelPendingScripts?.() ?? Promise.resolve());
  }

  killSession(ref: BackendScopedSessionRef): Promise<void> {
    return this.withRefBackend(ref, (b) => b.killSession(ref.sessionId));
  }

  deleteWorkspace(ref: BackendScopedWorkspaceRef, params?: DeleteWorkspaceParams): Promise<void> {
    const workspace = this.getWorkspaceRecord(ref);
    const projectName = workspace?.projectName ?? ref.workspaceId.split(':')[0] ?? ref.workspaceId;
    return this.withRefBackend(ref, (b) => b.deleteWorkspace(projectName, ref.workspaceId, params));
  }

  setWorkspaceStatus(ref: BackendScopedWorkspaceRef, phase: WorkspacePhase): Promise<void> {
    const workspace = this.getWorkspaceRecord(ref);
    const projectName = workspace?.projectName ?? ref.workspaceId.split(':')[0] ?? ref.workspaceId;
    const workspaceName = workspace?.name ?? ref.workspaceId.split(':')[1] ?? ref.workspaceId;
    return this.withRefBackend(ref, (b) =>
      b.setWorkspaceStatus?.(projectName, workspaceName, phase) ?? Promise.resolve()
    );
  }

  startProcess(ref: BackendScopedWorkspaceRef, processName: string, instance?: number): Promise<void> {
    return this.withRefBackend(ref, (b) =>
      b.startProcess?.(ref.workspaceId, processName, instance) ?? Promise.resolve()
    );
  }

  stopProcess(ref: BackendScopedWorkspaceRef, processName: string): Promise<void> {
    return this.withRefBackend(ref, (b) =>
      b.stopProcess?.(ref.workspaceId, processName) ?? Promise.resolve()
    );
  }

  requestEvents(
    ref: BackendScopedWorkspaceRef,
    filter?: WideEventFilter,
    limit?: number,
    sinceMs?: number
  ): Promise<void> {
    const workspace = this.getWorkspaceRecord(ref);
    if (!workspace) return Promise.resolve();
    return this.withRefBackend(ref, (b) =>
      b.requestEvents?.(workspace.path, filter, limit, sinceMs) ?? Promise.resolve()
    );
  }

  getBundleRefreshPlan(ref: BackendScopedWorkspaceRef): Promise<BundleRefreshPlan> {
    const workspace = this.getWorkspaceRecord(ref);
    const projectName = workspace?.projectName ?? ref.workspaceId.split(':')[0] ?? ref.workspaceId;
    return this.withRefBackend(ref, (b) => b.getBundleRefreshPlan(projectName, ref.workspaceId));
  }

  applyBundleRefresh(ref: BackendScopedWorkspaceRef, submission: BundleRefreshSubmission): Promise<void> {
    const workspace = this.getWorkspaceRecord(ref);
    const projectName = workspace?.projectName ?? ref.workspaceId.split(':')[0] ?? ref.workspaceId;
    return this.withRefBackend(ref, (b) => b.applyBundleRefresh(projectName, ref.workspaceId, submission));
  }

  getBundleConfigState(ref: BackendScopedWorkspaceRef): Promise<BundleConfigState> {
    const workspace = this.getWorkspaceRecord(ref);
    const projectName = workspace?.projectName ?? ref.workspaceId.split(':')[0] ?? ref.workspaceId;
    return this.withRefBackend(ref, (b) => b.getBundleConfigState(projectName, ref.workspaceId));
  }

  applyBundleConfigUpdate(ref: BackendScopedWorkspaceRef, submission: BundleConfigSubmission): Promise<void> {
    const workspace = this.getWorkspaceRecord(ref);
    const projectName = workspace?.projectName ?? ref.workspaceId.split(':')[0] ?? ref.workspaceId;
    return this.withRefBackend(ref, (b) =>
      b.applyBundleConfigUpdate(projectName, ref.workspaceId, submission)
    );
  }

  createCheckpoint(ref: BackendScopedSessionRef): Promise<void> {
    return this.withRefBackend(ref, (b) => b.createCheckpoint?.(ref.sessionId) ?? Promise.resolve());
  }

  sendReviewRequest(ref: BackendScopedWorkspaceRef | BackendScopedSessionRef, operation: ReviewOperation): Promise<ReviewResult> {
    return this.withRefBackend(ref, (b) => b.sendReviewRequest(operation));
  }

  // ─── Agent session actions ──────────────────────────────────────────────────

  respondToAgentPermission(
    ref: BackendScopedAgentSessionRef,
    permissionId: string,
    response: 'allow' | 'deny'
  ): Promise<boolean> {
    return this.withRefBackend(ref, (b) =>
      b.respondToAgentPermission(ref.workspaceId, ref.agentSessionId, permissionId, response)
    );
  }

  createAgentSession(ref: BackendScopedWorkspaceRef, title?: string) {
    return this.withRefBackend(ref, (b) =>
      b.createAgentSession?.(ref.workspaceId, title) ?? Promise.resolve([])
    );
  }

  /**
   * Destroy the agent session entirely (kills the backing tmux session).
   * Use this for row-menu / explicit close actions. Compare with stopAgentTurn()
   * which only cancels the current LLM turn and leaves the session alive.
   */
  killAgentSession(ref: BackendScopedAgentSessionRef): Promise<boolean> {
    return this.withRefBackend(ref, (b) =>
      b.abortAgentSession?.(ref.workspaceId, ref.agentSessionId) ?? Promise.resolve(false)
    );
  }

  /**
   * Cancel the current LLM turn without killing the session.
   * The session remains alive and transitions to IDLE. Use this for the
   * composer stop button and the sidebar ✕ shown on a running agent.
   * Compare with killAgentSession() which destroys the session entirely.
   */
  stopAgentTurn(ref: BackendScopedAgentSessionRef): Promise<boolean> {
    return this.withRefBackend(ref, (b) =>
      b.interruptAgentSession?.(ref.workspaceId, ref.agentSessionId) ?? Promise.resolve(false)
    );
  }

  closeAgentSession(ref: BackendScopedAgentSessionRef) {
    return this.withRefBackend(ref, (b) =>
      b.closeAgentSession?.(ref.workspaceId, ref.agentSessionId) ?? Promise.resolve([])
    );
  }

  archiveAgentSession(ref: BackendScopedAgentSessionRef) {
    return this.withRefBackend(ref, (b) =>
      b.archiveAgentSession?.(ref.workspaceId, ref.agentSessionId) ?? Promise.resolve([])
    );
  }

  restoreAgentSession(ref: BackendScopedAgentSessionRef) {
    return this.withRefBackend(ref, (b) =>
      b.restoreAgentSession?.(ref.workspaceId, ref.agentSessionId) ?? Promise.resolve([])
    );
  }

  async attachAgentSession(ref: BackendScopedAgentSessionRef, attachOptions?: { viewOnly?: boolean; cols?: number; rows?: number; paneId?: string }): Promise<void> {
    this.dispatch({ type: 'SET_PENDING_AGENT_ATTACH', backendKey: ref.backendKey, pending: true });
    try {
      return await this.withRefBackend(ref, (b) =>
        b.attachAgentSession?.(ref.workspaceId, ref.agentSessionId, attachOptions) ?? Promise.resolve()
      );
    } catch (error) {
      this.dispatch({ type: 'SET_PENDING_AGENT_ATTACH', backendKey: ref.backendKey, pending: false });
      throw error;
    }
  }

  promptAgentSession(ref: BackendScopedAgentSessionRef, text: string, images?: import('../../lib/tmux-lite/protocol.js').AgentPromptImage[], options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
    return this.withRefBackend(ref, (b) =>
      b.promptAgentSession?.(ref.workspaceId, ref.agentSessionId, text, images, options) ?? Promise.resolve()
    );
  }

  removeAgentQueuedMessage(ref: BackendScopedAgentSessionRef, kind: 'steering' | 'followUp', index: number): Promise<string | null> {
    return this.withRefBackend(ref, (b) =>
      b.removeAgentQueuedMessage?.(ref.workspaceId, ref.agentSessionId, kind, index) ?? Promise.resolve(null)
    );
  }

  stageUpload(ref: BackendScopedWorkspaceRef, fileName: string, data: string, mimeType: string): Promise<{ stagedPath: string }> {
    return this.withRefBackend(ref, (b) => {
      if (!b.stageUpload) return Promise.reject(new Error('File staging unavailable'));
      return b.stageUpload(ref.workspaceId, fileName, data, mimeType);
    });
  }

  sendDialogResponse(
    backendKey: BackendKey,
    dialogId: string,
    dialogType: 'select' | 'confirm' | 'input' | 'editor',
    value: string | boolean | undefined,
  ): Promise<void> {
    return this.withBackend(backendKey, (b) =>
      b.sendDialogResponse?.(dialogId, dialogType, value) ?? Promise.resolve()
    );
  }

  clearPendingDialog(backendKey: BackendKey): void {
    this.dispatch({ type: 'CLEAR_HOST_UI_DIALOG', backendKey });
  }

  getAgentSessionPreference(ref: BackendScopedWorkspaceRef): Promise<string | null> {
    return this.withRefBackend(ref, (b) => b.getAgentSessionPreference(ref.workspaceId));
  }

  setAgentSessionPreference(ref: BackendScopedWorkspaceRef, sessionId: string): Promise<void> {
    return this.withRefBackend(ref, (b) => b.setAgentSessionPreference(ref.workspaceId, sessionId));
  }

  listAgentCommands(ref: BackendScopedWorkspaceRef): Promise<Array<{ name: string; description: string; kind: 'file' | 'custom' | 'extension' }>> {
    return this.withRefBackend(ref, (b) => {
      if (!b.listAgentCommands) return Promise.reject(new Error('Command listing unavailable'));
      return b.listAgentCommands(ref.workspaceId);
    });
  }

  getFileSuggestions(ref: BackendScopedWorkspaceRef, prefix: string, limit?: number): Promise<Array<{ path: string; isDirectory: boolean }>> {
    return this.withRefBackend(ref, (b) => {
      if (!b.getFileSuggestions) return Promise.reject(new Error('File suggestions unavailable'));
      return b.getFileSuggestions(ref.workspaceId, prefix, limit);
    });
  }

  // ─── Backend-targeted creation/discovery ────────────────────────────────────

  createProject(backendKey: BackendKey, params: CreateProjectParams): Promise<void> {
    return this.withBackend(backendKey, async (b) => {
      await b.createProject(params);
      await b.listProjects();
      await b.listWorkspaces();
      await b.listSessions();
    });
  }

  prepareProjectCreation(backendKey: BackendKey, params: CreateProjectParams): Promise<PreparedProjectResult> {
    return this.withBackend(backendKey, (b) => {
      if (!b.prepareProjectCreation) return Promise.reject(new Error('Project preparation unavailable'));
      return b.prepareProjectCreation(params);
    });
  }

  finalizeProjectCreation(backendKey: BackendKey, params: FinalizeProjectParams): Promise<void> {
    return this.withBackend(backendKey, async (b) => {
      if (!b.finalizeProjectCreation) throw new Error('Project finalization unavailable');
      await b.finalizeProjectCreation(params);
      await b.listProjects();
      await b.listWorkspaces();
      await b.listSessions();
    });
  }

  cancelProjectCreation(backendKey: BackendKey, projectName: string): Promise<void> {
    return this.withBackend(backendKey, async (b) => {
      if (!b.cancelProjectCreation) throw new Error('Project cancellation unavailable');
      await b.cancelProjectCreation(projectName);
      await b.listProjects();
      await b.listWorkspaces();
      await b.listSessions();
    });
  }

  createWorkspace(backendKey: BackendKey, params: CreateWorkspaceParams): Promise<void> {
    return this.withBackend(backendKey, async (b) => {
      await b.createWorkspace(params);
      await b.listWorkspaces();
      await b.listSessions();
    });
  }

  deleteProject(backendKey: BackendKey, projectName: string, params?: DeleteProjectParams): Promise<void> {
    return this.withBackend(backendKey, async (b) => {
      await b.deleteProject(projectName, params);
      await b.listProjects();
      await b.listWorkspaces();
      await b.listSessions();
    });
  }

  listGithubRepos(backendKey: BackendKey, org?: string): Promise<string[]> {
    return this.withBackend(backendKey, (b) => b.listGithubRepos(org));
  }

  listRemoteBranches(backendKey: BackendKey, projectName: string): Promise<string[]> {
    return this.withBackend(backendKey, (b) => b.listRemoteBranches(projectName));
  }

  listLinearIssues(backendKey: BackendKey, projectName: string): Promise<SessionLinearIssueSummary[]> {
    return this.withBackend(backendKey, (b) => b.listLinearIssues(projectName));
  }

  // ─── Replay actions ─────────────────────────────────────────────────────────

  getReplaySnapshot(backendKey: BackendKey, replayId: string, atMs?: number, scrollbackLines?: number): Promise<TerminalSnapshot> {
    return this.withBackend(backendKey, (b) => {
      if (!b.getReplaySnapshot) return Promise.reject(new Error('Replay snapshot unavailable'));
      return b.getReplaySnapshot(replayId, atMs, scrollbackLines);
    });
  }

  getReplayText(
    backendKey: BackendKey,
    replayId: string,
    atMs?: number,
    scrollbackLines?: number,
    includeScrollback?: boolean,
    trimTrailingBlankRows?: boolean
  ): Promise<string> {
    return this.withBackend(backendKey, (b) => {
      if (!b.getReplayText) return Promise.reject(new Error('Replay text unavailable'));
      return b.getReplayText(replayId, atMs, scrollbackLines, includeScrollback, trimTrailingBlankRows);
    });
  }

  getReplayMarkdown(
    backendKey: BackendKey,
    replayId: string,
    atMs?: number,
    scrollbackLines?: number,
    includeScrollback?: boolean,
    trimTrailingBlankRows?: boolean
  ): Promise<string> {
    return this.withBackend(backendKey, (b) => {
      if (!b.getReplayMarkdown) return Promise.reject(new Error('Replay markdown unavailable'));
      return b.getReplayMarkdown(replayId, atMs, scrollbackLines, includeScrollback, trimTrailingBlankRows);
    });
  }

  getReplayFrame(backendKey: BackendKey, replayId: string, target?: ReplayFrameTarget): Promise<ReplayFrame> {
    return this.withBackend(backendKey, (b) => {
      if (!b.getReplayFrame) return Promise.reject(new Error('Replay frame unavailable'));
      return b.getReplayFrame(replayId, target);
    });
  }

  getReplayTimeline(backendKey: BackendKey, replayId: string): Promise<ReplayTimeline> {
    return this.withBackend(backendKey, (b) => {
      if (!b.getReplayTimeline) return Promise.reject(new Error('Replay timeline unavailable'));
      return b.getReplayTimeline(replayId);
    });
  }

  dismissReplay(backendKey: BackendKey, replayId: string): Promise<void> {
    return this.withBackend(backendKey, (b) => b.dismissReplay?.(replayId) ?? Promise.resolve());
  }

  undismissReplay(backendKey: BackendKey, replayId: string): Promise<void> {
    return this.withBackend(backendKey, (b) => b.undismissReplay?.(replayId) ?? Promise.resolve());
  }

  cancelPendingReplayRequests(backendKey: BackendKey): void {
    this.manager.get(backendKey)?.cancelPendingReplayRequests?.();
  }

  // ─── Internal: state dispatch ─────────────────────────────────────────────

  private dispatch(action: SessionEngineAction): void {
    this.engineState = sessionEngineReducer(this.engineState, action);
    // Defer projection + notification to the next microtask so rapid-fire
    // dispatches (e.g. SET_WORKSPACES + SET_SAVED_EVENT_FILTERS) coalesce
    // into a single subscriber notification.
    if (!this.notifyScheduled) {
      this.notifyScheduled = true;
      queueMicrotask(() => {
        this.notifyScheduled = false;
        const next = toMultiMachineState(this.engineState);
        this.projectedState = next;
        for (const listener of this.listeners) {
          listener(next);
        }
      });
    }
  }

  private handleBackendEvent(evt: BackendManagerEvent): void {
    const { backendKey, event } = evt;

    // Special cases that produce multiple dispatches
    if (event.type === 'workspaces') {
      this.dispatch({ type: 'SET_WORKSPACES', backendKey, workspaces: event.workspaces });
      if (event.savedEventFilters) {
        this.dispatch({ type: 'SET_SAVED_EVENT_FILTERS', backendKey, filters: event.savedEventFilters });
      }
      return;
    }
    if (event.type === 'events') {
      this.dispatch({ type: 'SET_EVENTS', backendKey, events: event.events, liveEventIds: event.liveEventIds });
      if (event.savedEventFilters) {
        this.dispatch({ type: 'SET_SAVED_EVENT_FILTERS', backendKey, filters: event.savedEventFilters });
      }
      return;
    }

    const action = dispatchBackendEvent(evt);
    if (action) this.dispatch(action);
  }

  // ─── Internal: backend routing ────────────────────────────────────────────

  private withBackend<T>(key: BackendKey, fn: (b: SessionBackend) => Promise<T>): Promise<T> {
    const backend = this.manager.get(key);
    if (!backend) return Promise.reject(new Error(`No backend registered: ${key}`));
    return fn(backend);
  }

  private withRefBackend<T>(
    ref: BackendScopedWorkspaceRef | BackendScopedSessionRef | BackendScopedAgentSessionRef,
    fn: (b: SessionBackend) => Promise<T>
  ): Promise<T> {
    return this.withBackend(ref.backendKey, fn);
  }

  private getWorkspaceRecord(ref: BackendScopedWorkspaceRef) {
    const snapshot = this.engineState.backends[ref.backendKey]?.machineSnapshot;
    return snapshot?.workspacesById[ref.workspaceId] ?? null;
  }

  // ─── Internal: relay discovery ────────────────────────────────────────────

  private async startRelayDiscovery(): Promise<void> {
    const { createRemoteBackend, relaySocketAdapter, createRelaySigner, getDeviceCertificate } = this.platform;
    const { relay, identity } = this;

    if (!relay || !identity || !createRemoteBackend || !relaySocketAdapter || !createRelaySigner) return;

    this.relayStopped = false;
    const relayUrl = relay.url;
    const signer = createRelaySigner(identity);

    // Compute device certificate
    if (!this.deviceCert && getDeviceCertificate) {
      try {
        this.deviceCert = await getDeviceCertificate(identity);
      } catch (err) {
        logger.warning(`[engine] Failed to get device certificate: ${err}`);
        return;
      }
    }
    const deviceCertificate = this.deviceCert;
    if (!deviceCertificate) {
      logger.warning('[engine] No device certificate; cannot create relay directory client');
      return;
    }

    if (this.relayStopped) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.directoryClient = new RelayMachineDirectoryClient<any>({
      relayUrl,
      clientIdentityId: identity.id,
      deviceCertificate,
      socketAdapter: relaySocketAdapter,
      signer: (msg) => signer(msg),
      pingIntervalMs: 20000,
      onMachineList: (machines) => {
        if (this.relayStopped) return;
        const onlineMachines = machines.filter((m) => m.online && m.isAuthorized);
        const localMachineId = this.engineState.backends[LOCAL_BACKEND_KEY]?.descriptor.machineId;
        const visibleRemoteMachines = localMachineId
          ? onlineMachines.filter((machine) => machine.machineId !== localMachineId)
          : onlineMachines;
        const onlineIds = new Set(visibleRemoteMachines.map((m) => m.machineId));

        // Register new backends for machines that just appeared
        for (const machine of visibleRemoteMachines) {
          if (this.registeredRemoteBackends.has(machine.machineId)) continue;
          const backendKey = buildRemoteBackendKey(relayUrl, machine.machineId);
          try {
            const { backend } = createRemoteBackend({
              relayUrl,
              identity,
              machineId: machine.machineId,
              deviceCertificate,
              machineLabel: machine.label,
              storage: this.platform.storage,
            });
            this.dispatch({ type: 'REGISTER_BACKEND', descriptor: backend.descriptor });
            this.manager.register(backend);
            this.registeredRemoteBackends.set(machine.machineId, backendKey);
            this.manager.connect(backendKey).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              logger.warning(`[engine] Remote backend connect failed (${machine.machineId}): ${msg}`);
              this.dispatch({ type: 'SET_BACKEND_STATUS', backendKey, status: 'error', error: msg });
            });
          } catch (err) {
            logger.warning(`[engine] Failed to create remote backend for ${machine.machineId}: ${err}`);
          }
        }

        // Unregister backends for machines that went offline / lost auth
        for (const [machineId, backendKey] of this.registeredRemoteBackends) {
          if (!onlineIds.has(machineId)) {
            this.registeredRemoteBackends.delete(machineId);
            this.manager.unregister(backendKey).catch(() => undefined);
            this.dispatch({ type: 'UNREGISTER_BACKEND', backendKey });
          }
        }
      },
      onError: (msg) => {
        logger.warning(`[engine] Relay directory error: ${msg}`);
      },
    });

    this.directoryClient.connect().catch((err: unknown) => {
      logger.warning(`[engine] Relay directory connect failed: ${err}`);
    });
  }

  private stopRelayDiscovery(): void {
    this.relayStopped = true;
    this.directoryClient?.disconnect();
    this.directoryClient = null;

    // Unregister all remote backends registered by this relay
    for (const [, backendKey] of this.registeredRemoteBackends) {
      this.manager.unregister(backendKey).catch(() => undefined);
      this.dispatch({ type: 'UNREGISTER_BACKEND', backendKey });
    }
    this.registeredRemoteBackends.clear();
  }
}
