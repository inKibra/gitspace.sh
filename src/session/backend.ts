import type { NotificationConfig } from '../notifications/types.js';
import type { BackendEvent } from './events.js';
import type {
  ReplayFrame,
  ReplayFrameTarget,
  ReplayInfo,
  ReplayTimeline,
  TerminalSnapshot,
} from '../lib/tmux-lite/replay/index.js';
import type {
  BundleRefreshPlan,
  BundleRefreshSubmission,
} from '../types/bundle-refresh.js';
import type {
  BundleConfigState,
  BundleConfigSubmission,
} from '../types/bundle-config.js';
import type { ReviewOperation, ReviewResult } from '../types/review.js';
import type { WideEventFilter } from '../types/events.js';
import type { SessionLinearIssueSummary, WorkspaceSource } from '../types/lifecycle.js';
import type { ConfirmStepResult, SpacesBundle } from '../types/bundle.js';
import type { AgentStateUpdateDelta, WorkspaceAgentState } from '../lib/tmux-lite/agent-event-manager.js';

export type BackendKey = string;
export type BackendKind = 'local' | 'remote';

export interface BackendDescriptor {
  key: BackendKey;
  kind: BackendKind;
  label: string;
  machineId?: string;
  relayUrl?: string;
}

export interface AttachPaneParams extends AttachSessionParams {
  paneId: string;
  agentSessionId?: string;
}


export interface AttachSessionParams {
  sessionId?: string;
  workspaceId?: string;
  sessionName?: string;
  cols?: number;
  rows?: number;
  scriptPolicy?: 'auto' | 'skip';
  /** When true, the client cannot send input to the PTY (view-only mode) */
  viewOnly?: boolean;
  /** Custom command to run (skips workspace scripts when set) */
  command?: string;
  /** Arguments for the custom command */
  args?: string[];
  /** Environment variables for the custom command */
  env?: Record<string, string>;
}

export interface DeleteWorkspaceParams {
  scriptPolicy?: 'auto' | 'skip';
  /**
   * Optional timeout for delete completion when waiting on remote responses.
   * Ignored by local backend.
   */
  timeoutMs?: number;
}

export interface CreateProjectParams {
  repository: string;
  projectName?: string;
  baseBranch?: string;
  setCurrent?: boolean;
}

export interface PreparedProjectResult {
  projectName: string;
  repository: string;
  baseBranch: string;
  bundle?: SpacesBundle;
  confirmStatuses?: Record<string, 'found' | 'missing'>;
}

export interface FinalizeProjectParams {
  projectName: string;
  repository: string;
  baseBranch: string;
  bundle?: SpacesBundle;
  inputValues?: Record<string, string>;
  secretValues?: Record<string, string>;
  confirmResults?: Record<string, ConfirmStepResult>;
  setCurrent?: boolean;
}

export interface CreateWorkspaceParams {
  projectName: string;
  workspaceName: string;
  branchName?: string;
  baseBranch?: string;
  workspaceSource?: WorkspaceSource;
  linearIssue?: SessionLinearIssueSummary;
}

export interface DeleteProjectParams {
  /**
   * Optional timeout for delete completion when waiting on remote responses.
   * Ignored by local backend.
   */
  timeoutMs?: number;
}

/**
 * Canonical backend contract used by shared session engine.
 */
export interface SessionBackend {
  readonly descriptor: BackendDescriptor;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  listProjects(): Promise<void>;
  listGithubRepos(org?: string): Promise<string[]>;
  listRemoteBranches(projectName: string): Promise<string[]>;
  listLinearIssues(projectName: string): Promise<SessionLinearIssueSummary[]>;
  listWorkspaces(): Promise<void>;
  /** Set workspace kanban phase; then listWorkspaces is implied (local) or caller should refresh (remote). */
  setWorkspaceStatus?(projectName: string, workspaceName: string, phase: import('../types/config.js').WorkspacePhase): Promise<void>;
  listSessions(workspaceId?: string): Promise<void>;
  listReplays?(workspaceId?: string, includeDismissed?: boolean): Promise<void>;

  createProject(params: CreateProjectParams): Promise<void>;
  prepareProjectCreation?(params: CreateProjectParams): Promise<PreparedProjectResult>;
  finalizeProjectCreation?(params: FinalizeProjectParams): Promise<void>;
  cancelProjectCreation?(projectName: string): Promise<void>;
  createWorkspace(params: CreateWorkspaceParams): Promise<void>;
  deleteProject(projectName: string, params?: DeleteProjectParams): Promise<void>;

  attachPane?(params: AttachPaneParams): Promise<void>;
  detachPane?(paneId: string): Promise<void>;
  detachAllPanes?(): Promise<void>;
  attachSession(params: AttachSessionParams): Promise<void>;
  detachSession(): Promise<void>;
  cancelPendingScripts?(): Promise<void>;

  killSession(sessionId: string): Promise<void>;
  deleteWorkspace(
    projectName: string,
    workspaceId: string,
    params?: DeleteWorkspaceParams
  ): Promise<void>;

  getBundleRefreshPlan(projectName: string, workspaceId: string): Promise<BundleRefreshPlan>;
  applyBundleRefresh(
    projectName: string,
    workspaceId: string,
    submission: BundleRefreshSubmission
  ): Promise<void>;
  getBundleConfigState(projectName: string, workspaceId: string): Promise<BundleConfigState>;
  applyBundleConfigUpdate(
    projectName: string,
    workspaceId: string,
    submission: BundleConfigSubmission
  ): Promise<void>;

  requestInbox(): Promise<void>;
  clearInbox(id?: string): Promise<void>;
  markInboxRead(id: string): Promise<void>;

  getNotificationConfig(): Promise<void>;
  updateNotificationConfig(config: NotificationConfig): Promise<void>;

  sendReviewRequest(operation: ReviewOperation): Promise<ReviewResult>;
  startProcess?(workspaceId: string, processName: string, instance?: number): Promise<void>;
  stopProcess?(workspaceId: string, processName: string): Promise<void>;
  requestEvents?(workspacePath: string, filter?: WideEventFilter, limit?: number, sinceMs?: number): Promise<void>;

  writePaneData?(paneId: string, data: Uint8Array): Promise<void>;
  resizePane?(paneId: string, cols: number, rows: number): Promise<void>;
  setPaneOutputHandler?(paneId: string, handler: ((data: Uint8Array) => void) | null): void;
  writePtyData?(data: Uint8Array): Promise<void>;
  resizePty?(cols: number, rows: number): Promise<void>;
  createCheckpoint?(sessionId: string): Promise<void>;
  getReplaySnapshot?(replayId: string, atMs?: number, scrollbackLines?: number): Promise<TerminalSnapshot>;
  getReplayText?(
    replayId: string,
    atMs?: number,
    scrollbackLines?: number,
    includeScrollback?: boolean,
    trimTrailingBlankRows?: boolean,
  ): Promise<string>;
  getReplayMarkdown?(
    replayId: string,
    atMs?: number,
    scrollbackLines?: number,
    includeScrollback?: boolean,
    trimTrailingBlankRows?: boolean,
  ): Promise<string>;
  getReplayFrame?(replayId: string, target?: ReplayFrameTarget): Promise<ReplayFrame>;
  getReplayTimeline?(replayId: string): Promise<ReplayTimeline>;
  cancelPendingReplayRequests?(): void;
  dismissReplay?(replayId: string): Promise<void>;
  undismissReplay?(replayId: string): Promise<void>;

  onEvent(handler: (event: BackendEvent) => void): () => void;

  /** Subscribe to agent state deltas. Returns an unsubscribe function. */
  subscribeAgentState(handler: (delta: AgentStateUpdateDelta) => void): () => void;
  /** Get the current full agent state snapshot (all workspaces). */
  getAgentStateSnapshot(): Record<string, WorkspaceAgentState>;
  /**
   * Respond to an agent permission request.
   * workspaceId identifies which workspace owns the agent session.
   */
  respondToAgentPermission(
    workspaceId: string,
    agentSessionId: string,
    permissionId: string,
    response: 'allow' | 'deny',
  ): Promise<boolean>;

  /** Fast, persisted workspace-scoped agent sessions (history/snapshot-backed). */
  getKnownAgentSessions?(workspaceId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>>;
  /** Live refresh of workspace-scoped agent sessions from the runtime. */
  listAgentSessions?(workspaceId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>>;
  createAgentSession?(workspaceId: string, title?: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>>;
  abortAgentSession?(workspaceId: string, agentSessionId: string): Promise<boolean>;
  /**
   * Interrupt the agent's current turn without killing the session.
   * The agent stops its current LLM/tool execution and becomes idle,
   * ready for new prompts. Compare with abortAgentSession() which
   * kills the tmux session entirely.
   */
  interruptAgentSession?(workspaceId: string, agentSessionId: string): Promise<boolean>;
  closeAgentSession?(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>>;
  archiveAgentSession?(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>>;
  restoreAgentSession?(workspaceId: string, agentSessionId: string): Promise<Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }>>;
  attachAgentSession?(workspaceId: string, agentSessionId: string, options?: { viewOnly?: boolean; cols?: number; rows?: number; paneId?: string }): Promise<void>;
  promptAgentSession?(workspaceId: string, agentSessionId: string, text: string, images?: import('../lib/tmux-lite/protocol.js').AgentPromptImage[], options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
  stageUpload?(workspaceId: string, fileName: string, data: string, mimeType: string): Promise<{ stagedPath: string }>;
  /** Send a dialog response back to the server for a pending host UI dialog. */
  sendDialogResponse?(dialogId: string, dialogType: 'select' | 'confirm' | 'input' | 'editor', value: string | boolean | undefined): Promise<void>;

  /** Retrieve the persisted last-selected agent session ID for a workspace. */
  getAgentSessionPreference(workspaceId: string): Promise<string | null>;
  /** Persist the selected agent session ID for a workspace. */
  setAgentSessionPreference(workspaceId: string, sessionId: string): Promise<void>;
  listAgentCommands?(workspaceId: string): Promise<Array<{ name: string; description: string; kind: 'file' | 'custom' | 'extension' }>>;
  getFileSuggestions?(workspaceId: string, prefix: string, limit?: number): Promise<Array<{ path: string; isDirectory: boolean }>>;
}

export type { ReplayFrame, ReplayFrameTarget, ReplayInfo, ReplayTimeline, TerminalSnapshot };