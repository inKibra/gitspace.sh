/**
 * Remote transport protocol for encrypted client<->machine communication.
 *
 * Bounded operations use request/response correlation. Long-running work is
 * accepted quickly and then reported through machine-owned operation events.
 * Unsolicited pushes (machine_snapshot, operation_snapshot, operation_event,
 * agent_state_*, etc.) are sent without a request.
 */

// Re-export InboxItem from tmux-lite protocol
export type { InboxItem } from "../tmux-lite/protocol.js";
import type { PortConflictInfo } from '../processes/port-conflicts.js';

// Re-export agent state types from AgentEventManager
export type {
  AgentStateUpdateDelta,
  WorkspaceAgentState,
  AgentSessionSummary,
} from '../tmux-lite/agent-event-manager.js';
export type { ReviewOperation, ReviewResult } from "../../types/review.js";
export type {
  BundleRefreshPlan,
  BundleRefreshSubmission,
} from "../../types/bundle-refresh.js";
export type {
  BundleConfigState,
  BundleConfigSubmission,
} from '../../types/bundle-config.js';
export type {
  SessionLinearIssueSummary,
  WorkspaceSource,
} from "../../types/lifecycle.js";
export type {
  ConfirmStepResult,
  SpacesBundle,
} from '../../types/bundle.js';
export type { ReplayFrame, ReplayFrameTarget, ReplayInfo, ReplayTimeline } from '../tmux-lite/replay/types.js';

// Re-export tmux-lite attach-init/event types used on the machine-local Unix socket.
export type { SessionCtrl, SessionEvent } from "../tmux-lite/protocol.js";

export type RemoteOperationKind =
  | 'project.create'
  | 'project.prepare'
  | 'project.finalize'
  | 'project.delete'
  | 'workspace.create'
  | 'workspace.delete'
  | 'workspace.scripts'
  | 'space.command'
  | 'review.github'
  | 'workspace.editor.open';

export type RemoteOperationState = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RemoteOperationScope {
  projectName?: string;
  workspaceId?: string;
  workspaceName?: string;
  sessionId?: string;
}

export interface RemoteOperationRecord {
  operationId: string;
  kind: RemoteOperationKind;
  scope: RemoteOperationScope;
  state: RemoteOperationState;
  startedAt: number;
  updatedAt: number;
  phase?: string;
  message?: string;
  outputBase64?: string;
  result?: unknown;
  error?: { code?: string; message: string };
}

export type RemoteOperationEventType =
  | 'operation_started'
  | 'operation_progress'
  | 'operation_output'
  | 'operation_succeeded'
  | 'operation_failed'
  | 'operation_cancelled';

export interface RemoteOperationEvent {
  type: RemoteOperationEventType;
  operation: RemoteOperationRecord;
}

export type RemoteSessionControl =
  | { type: 'resize'; streamId: number; cols: number; rows: number }
  | { type: 'detach'; streamId: number }
  | { type: 'detach_all' };

// ============================================================================
// Client → Machine Messages (Browsing Mode)
// ============================================================================

/** Request list of saved replays, optionally filtered by workspace */
export interface ListReplaysRequest {
  type: 'list_replays';
  workspaceId?: string;
  includeDismissed?: boolean;
}

/** Request a replay frame (checkpoint + events) for client-side rendering */
export interface GetReplayFrameRequest {
  type: 'get_replay_frame';
  replayId: string;
  requestId: string;
  atMs?: number;
  atSeq?: number;
}

/** Request replay timeline metadata for scrubbing and playback */
export interface GetReplayTimelineRequest {
  type: 'get_replay_timeline';
  replayId: string;
}

/** Soft-hide a replay */
export interface DismissReplayRequest {
  type: 'dismiss_replay';
  replayId: string;
}

/** Restore a previously dismissed replay */
export interface UndismissReplayRequest {
  type: 'undismiss_replay';
  replayId: string;
}

export interface DismissOperationRequest {
  type: 'dismiss_operation';
  operationId: string;
}

/** Attach to a session (existing or new) */
export interface AttachSessionRequest {
  type: "attach_session";
  streamId: number;       // Per-pane PTY stream ID (2+; 0/1 are reserved)
  sessionId?: string;     // Attach to existing session
  workspaceId?: string;   // Create new session in workspace
  sessionName?: string;   // Name for new session (optional)
  cols: number;          // Terminal dimensions (required, used to send attach-init proactively)
  rows: number;
  scriptPolicy?: 'auto' | 'skip';
  command?: string;       // Command to run (process sessions)
  args?: string[];        // Command arguments
  env?: Record<string, string>;  // Environment variables
  /** When true, the server blocks PTY writes from this client */
  viewOnly?: boolean;
}

/** Cancel a currently running attach workflow (typically stuck scripts). */
export interface CancelPendingAttachRequest {
  type: 'cancel_pending_attach';
}

// ============================================================================
// Explicit Remote Commands (replaces generic tmux_command tunnel)
// ============================================================================

// --- Lifecycle & Discovery ---

export interface ListGithubReposRequest {
  type: 'list_github_repos';
  requestId: string;
  org?: string;
}

export interface ListRemoteBranchesRequest {
  type: 'list_remote_branches';
  requestId: string;
  projectName: string;
}

export interface ListLinearIssuesRequest {
  type: 'list_linear_issues';
  requestId: string;
  projectName: string;
}

// --- Project CRUD ---

export interface CreateProjectRequest {
  type: 'create_project';
  requestId: string;
  repository: string;
  projectName?: string;
  baseBranch?: string;
  setCurrent?: boolean;
  scratch?: boolean;
}

export interface PrepareProjectCreationRequest {
  type: 'prepare_project_creation';
  requestId: string;
  repository: string;
  projectName?: string;
  baseBranch?: string;
  setCurrent?: boolean;
}

export interface FinalizeProjectCreationRequest {
  type: 'finalize_project_creation';
  requestId: string;
  projectName: string;
  repository: string;
  baseBranch: string;
  bundle?: import('../../types/bundle.js').SpacesBundle;
  inputValues?: Record<string, string>;
  secretValues?: Record<string, string>;
  confirmResults?: Record<string, import('../../types/bundle.js').ConfirmStepResult>;
  setCurrent?: boolean;
}

export interface CancelProjectCreationRequest {
  type: 'cancel_project_creation';
  requestId: string;
  projectName: string;
}

export interface DeleteProjectRequest {
  type: 'delete_project';
  requestId: string;
  projectName: string;
}

// --- Workspace CRUD ---

export interface CreateWorkspaceRequest {
  type: 'create_workspace';
  requestId: string;
  projectName: string;
  workspaceName: string;
  branchName?: string;
  baseBranch?: string;
  parentWorkspaceName?: string;
  workspaceSource?: import('../../types/lifecycle.js').WorkspaceSource;
  linearIssue?: import('../../types/lifecycle.js').SessionLinearIssueSummary;
}

export interface ListWorkspaceNotesRequest {
  type: 'workspace_notes_list';
  requestId: string;
  projectName: string;
  workspaceName: string;
}


export interface RefreshMachineSnapshotRequest {
  type: 'refresh_machine_snapshot';
  requestId: string;
}
export interface AddWorkspaceNoteRequest {
  type: 'workspace_note_add';
  requestId: string;
  projectName: string;
  workspaceName: string;
  body: string;
}

export interface UpdateWorkspaceNoteRequest {
  type: 'workspace_note_update';
  requestId: string;
  projectName: string;
  workspaceName: string;
  noteId: string;
  body: string;
}

export interface RemoveWorkspaceNoteRequest {
  type: 'workspace_note_remove';
  requestId: string;
  projectName: string;
  workspaceName: string;
  noteId: string;
}

export interface UpdateGoalRequest {
  type: 'goal_update';
  requestId: string;
  projectName: string;
  goalId: string;
  updates: import('../../types/goals.js').GoalUpdateInput;
}

export interface AddGoalNearWorkspaceRequest {
  type: 'goal_add_near_workspace';
  requestId: string;
  projectName: string;
  workspaceName: string;
  title: string;
  position: 'before' | 'after';
}

export interface ReorderGoalRequest {
  type: 'goal_reorder';
  requestId: string;
  projectName: string;
  sourceToken: string;
  targetToken: string;
  position: 'before' | 'after';
}

export interface GoalStackStatusRequest {
  type: 'goal_stack_status';
  requestId: string;
  projectName: string;
  workspaceName: string;
}
export interface RerunWorkspaceScriptsRequest {
  type: 'rerun_workspace_scripts';
  requestId: string;
  projectName: string;
  workspaceId: string;
}

export interface RunWorkspaceOpenScriptsRequest {
  type: 'run_workspace_open_scripts';
  requestId: string;
  projectName: string;
  workspaceId: string;
}

export interface RunWorkspaceScriptSelectionRequest {
  type: 'run_workspace_script_selection';
  requestId: string;
  projectName: string;
  workspaceId: string;
  selection: 'setup' | 'select' | 'setup-select';
}

export interface SetWorkspacePhaseRequest {
  type: 'set_workspace_phase';
  requestId: string;
  projectName: string;
  workspaceName: string;
  phase: import('../../types/config.js').WorkspacePhase;
  cascade?: boolean;
}

export interface PreviewWorkspacePhaseRequest {
  type: 'preview_workspace_phase';
  requestId: string;
  projectName: string;
  workspaceName: string;
  phase: import('../../types/config.js').WorkspacePhase;
}

export interface TerminateSessionRequest {
  type: 'terminate_session';
  requestId: string;
  sessionId: string;
  mode?: 'graceful' | 'force';
  graceMs?: number;
}

// --- Process Management ---

export interface StartProcessRequest {
  type: 'start_process';
  requestId: string;
  workspaceId: string;
  processName: string;
  instance?: number;
}

export interface ResolvePortConflictRequest {
  type: 'resolve_port_conflict';
  requestId: string;
  workspaceId: string;
  conflict: PortConflictInfo;
}


export interface StopProcessRequest {
  type: 'stop_process';
  requestId: string;
  workspaceId: string;
  processName: string;
}

export interface RequestEventsRequest {
  type: 'request_events';
  requestId: string;
  workspacePath: string;
  filter?: import('../../types/events.js').WideEventFilter;
  limit?: number;
  sinceMs?: number;
}

// --- Bundle & Review ---

export interface GetBundleRefreshPlanRequest {
  type: 'get_bundle_refresh_plan';
  requestId: string;
  projectName: string;
  workspaceId: string;
}

export interface ApplyBundleRefreshRequest {
  type: 'apply_bundle_refresh';
  requestId: string;
  projectName: string;
  workspaceId: string;
  submission: import('../../types/bundle-refresh.js').BundleRefreshSubmission;
}

export interface GetBundleConfigStateRequest {
  type: 'get_bundle_config_state';
  requestId: string;
  projectName: string;
  workspaceId: string;
}

export interface ApplyBundleConfigRequest {
  type: 'apply_bundle_config';
  requestId: string;
  projectName: string;
  workspaceId: string;
  submission: import('../../types/bundle-config.js').BundleConfigSubmission;
}

export interface RequestReviewRequest {
  type: 'request_review';
  requestId: string;
  operation: import('../../types/review.js').ReviewOperation;
}

// --- Inbox & Preferences ---

export interface GetInboxRequest {
  type: 'get_inbox';
  requestId: string;
}

export interface ClearInboxRequest {
  type: 'clear_inbox';
  requestId: string;
  id?: string;
}

export interface MarkInboxReadRequest {
  type: 'mark_inbox_read';
  requestId: string;
  id: string;
}

export interface GetNotificationConfigRequest {
  type: 'get_notification_config';
  requestId: string;
}

export interface UpdateNotificationConfigRequest {
  type: 'update_notification_config';
  requestId: string;
  config: import('../../notifications/types.js').NotificationConfig;
}

// --- Agent Operations ---

export interface ListAgentSessionsRequest {
  type: 'list_agent_sessions';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  mode?: 'known' | 'live';
}

export interface CreateAgentSessionRequest {
  type: 'create_agent_session';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  title?: string;
}

export interface AbortAgentSessionRequest {
  type: 'abort_agent_session';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
}

export interface InterruptAgentSessionRequest {
  type: 'interrupt_agent_session';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
}

export interface CloseAgentSessionRequest {
  type: 'close_agent_session';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
}

export interface ArchiveAgentSessionRequest {
  type: 'archive_agent_session';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
}

export interface RestoreAgentSessionRequest {
  type: 'restore_agent_session';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
}

export interface AttachAgentSessionRequest {
  type: 'attach_agent_session';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
  cols?: number;
  rows?: number;
}

export interface PromptAgentSessionRequest {
  type: 'prompt_agent_session';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
  text: string;
  images?: import('../tmux-lite/protocol.js').AgentPromptImage[];
  streamingBehavior?: 'steer' | 'followUp';
}

export interface RemoveAgentQueuedMessageRequest {
  type: 'remove_agent_queued_message';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
  kind: 'steering' | 'followUp';
  index: number;
}

export interface StageAgentUploadRequest {
  type: 'stage_agent_upload';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  fileName: string;
  data: string;
  mimeType: string;
}

export interface RespondAgentDialogRequest {
  type: 'respond_agent_dialog';
  requestId: string;
  dialogId: string;
  dialogType: 'select' | 'confirm' | 'input' | 'editor';
  value: string | boolean | undefined;
}

export interface RespondAgentPermissionRequest {
  type: 'respond_agent_permission';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
  permissionId: string;
  response: 'allow' | 'deny';
}

export interface GetAgentTranscriptRangeRequest {
  type: 'get_agent_transcript_range';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
  before?: string;
  limit: number;
}

export interface GetAgentControlInfoRequest {
  type: 'get_agent_control_info';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
}

export interface SetAgentModelRequest {
  type: 'set_agent_model';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
  provider: string;
  modelId: string;
}

export interface SetAgentThinkingLevelRequest {
  type: 'set_agent_thinking_level';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
  level: string;
}

export interface SetAgentApprovalModeRequest {
  type: 'set_agent_approval_mode';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
  mode: string;
}

export interface GetAgentAuthProvidersRequest {
  type: 'get_agent_auth_providers';
  requestId: string;
}

export interface SetAgentProviderApiKeyRequest {
  type: 'set_agent_provider_api_key';
  requestId: string;
  provider: string;
  key: string;
}

export interface GetAgentSettingsRequest {
  type: 'get_agent_settings';
  requestId: string;
}

export interface SetAgentSettingRequest {
  type: 'set_agent_setting';
  requestId: string;
  path: string;
  value: string | number | boolean;
}

export interface StartAgentOAuthLoginRequest {
  type: 'start_agent_oauth_login';
  requestId: string;
  provider: string;
  flowId: string;
}

export interface RespondAgentOAuthPromptRequest {
  type: 'respond_agent_oauth_prompt';
  requestId: string;
  flowId: string;
  value: string;
}

export interface GetAgentSettingsSchemaRequest {
  type: 'get_agent_settings_schema';
  requestId: string;
}

export interface GetAgentToolsRequest {
  type: 'get_agent_tools';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
}

export interface CompactAgentSessionRequest {
  type: 'compact_agent_session';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
}

export interface CycleAgentRoleRequest {
  type: 'cycle_agent_role';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
  direction: 'forward' | 'backward';
}

export interface ApplyAgentRoleRequest {
  type: 'apply_agent_role';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
  role: string;
}

export interface GetAgentHistoryRequest {
  type: 'get_agent_history';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
}

export interface NavigateAgentHistoryRequest {
  type: 'navigate_agent_history';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
  entryId: string;
  mode?: 'redo' | 'jump';
}

export interface GetAgentSessionTreeRequest {
  type: 'get_agent_session_tree';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  agentSessionId: string;
}

export interface ListArtifactsRequest {
  type: 'list_artifacts';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
}

export interface ReadArtifactRequest {
  type: 'read_artifact';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  path: string;
}

export interface WriteArtifactRequest {
  type: 'write_artifact';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  path: string;
  contentBase64: string;
  message?: string;
}

export interface ProjectArtifactsListRequest {
  type: 'project_artifacts_list';
  requestId: string;
  projectName: string;
}

export interface ProjectArtifactsReadRequest {
  type: 'project_artifacts_read';
  requestId: string;
  projectName: string;
  path: string;
}

export interface RepoTreeRequest {
  type: 'repo_tree';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
}

export interface RepoReadRequest {
  type: 'repo_read';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  path: string;
}

export interface RepoCommitRequest {
  type: 'repo_commit';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  message: string;
}

export interface ListAgentCommandsRequest {
  type: 'list_agent_commands';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
}

export interface ListWorkspaceEditorsRequest {
  type: 'list_workspace_editors';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
}

export interface OpenWorkspaceEditorRequest {
  type: 'open_workspace_editor';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  editorId: import('../../utils/open-editor.js').WorkspaceEditorId;
}



export interface RunSpaceCommandRequest {
  type: 'run_space_command';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  argsText: string;
}

export interface GetAgentFileSuggestionsRequest {
  type: 'get_agent_file_suggestions';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
  prefix: string;
  limit?: number;
}

/** Delete a workspace */
export interface DeleteWorkspaceRequest {
  type: "delete_workspace";
  requestId?: string;
  workspaceId: string;
  projectName: string;  // Needed to locate workspace
  scriptPolicy?: 'auto' | 'skip';
}

// ============================================================================
// Machine → Client Messages (Browsing Mode)
// ============================================================================

/** Workspace information */
export interface WorkspaceInfo {
  id: string;           // Canonical workspace id: project:workspace
  name: string;         // Display name
  path: string;         // Full path
  projectName: string;  // Parent project name
  branch?: string;      // Git branch if available
  sessionCount: number; // Number of active sessions
  isStale?: boolean;    // No activity for 30+ days
  serveDomain?: string; // Hosting domain for process ports
  processes?: import("../../types/processes.js").RuntimeProcessDefinition[];
  processConfigError?: string;
  /** GitSpace kanban phase (plan | code | review | ship). From project config. */
  status?: import('../../types/config.js').WorkspacePhase;
  notesSummary?: import('../../types/workspace.js').WorkspaceNotesSummary;
}

export interface ProjectInfo {
  name: string;
  repository: string;
  workspaceCount: number;
  isCurrent: boolean;
}

/** Session information */
export interface SessionInfo {
  id: string;
  name: string;           // Display name (project:workspace:num)
  workspaceId: string;
  attached: boolean;      // Currently attached by another client
  createdAt: number;
  processTitle?: string;  // Current process (e.g., "vim", "npm run dev")
   terminalTitle?: string;
   lastAlertKind?: import('../tmux-lite/protocol.js').InboxItem['type'];
   lastAlertPreview?: string;
   lastAlertAt?: number;
   unreadAlertCount?: number;
  exitCode?: number;      // If session has exited
  processName?: string;   // Managed process name
  processInstance?: number; // Managed process instance number
}

/** Response with replay list */
export interface ReplayListResponse {
  type: 'replay_list';
  replays: import('../tmux-lite/replay/types.js').ReplayInfo[];
}

/** Response with replay frame (checkpoint + events for client-side rendering) */
export interface ReplayFrameResponse {
  type: 'replay_frame';
  replayId: string;
  requestId: string;
  frame: import('../tmux-lite/replay/types.js').ReplayFrame;
  chunkIndex?: number;
  totalChunks?: number;
}

/** Response with replay timeline metadata */
export interface ReplayTimelineResponse {
  type: 'replay_timeline';
  replayId: string;
  timeline: import('../tmux-lite/replay/types.js').ReplayTimeline;
}

/** Replay dismissed successfully */
export interface ReplayDismissedResponse {
  type: 'replay_dismissed';
  replayId: string;
}

/** Replay restored successfully */
export interface ReplayUndismissedResponse {
  type: 'replay_undismissed';
  replayId: string;
}


/** Attached to session */
export interface AttachedResponse {
  type: 'attached';
  streamId: number;
  sessionId: string;
  sessionName?: string;
  viewOnly?: boolean;
}

/** Attached session metadata */
export interface SessionMetaResponse {
  type: 'session-meta';
  streamId: number;
  sessionName: string;
  processTitle?: string;
  terminalTitle?: string;
  lastAlertKind?: import('../tmux-lite/protocol.js').InboxItem['type'];
  lastAlertPreview?: string;
  lastAlertAt?: number;
  unreadAlertCount?: number;
}


/** Detached from session - back to browsing mode */
export interface DetachedResponse {
  type: "detached";
  streamId: number;
}

/** Session exited */
export interface SessionExitedResponse {
  type: "session_exited";
  sessionId: string;
  streamId: number;
  exitCode: number;
}

/** Error response */
export interface ErrorResponse {
  type: "error";
  code: string;
  message: string;
  workspaceId?: string;
  projectName?: string;
  requestId?: string;
}

/** Workspace deleted response */
export interface WorkspaceDeletedResponse {
  type: "workspace_deleted";
  requestId?: string;
  workspaceId: string;
}

export interface WorkspaceNotesResponse {
  type: 'workspace_notes';
  notes: import('../../types/workspace.js').WorkspaceNote[];
}

export interface WorkspaceNoteResponse {
  type: 'workspace_note';
  note: import('../../types/workspace.js').WorkspaceNote;
}

export interface WorkspacePhasePreviewResponse {
  type: 'workspace_phase_preview';
  preview: import('../../types/goals.js').WorkspacePhaseChangePreview;
}

export interface GoalResponse {
  type: 'goal';
  goal: import('../../types/goals.js').GoalRecord;
}

export interface GoalChainResponse {
  type: 'goal-chain';
  chain: import('../../types/goals.js').GoalChain;
}

export interface GoalStackStatusResponse {
  type: 'goal-stack-status';
  status: import('../../types/goals.js').ChainStackStatus;
}

/** Script output during attach_session (streams lifecycle script output) */
export interface ScriptOutputResponse {
  type: "script_output";
  /** Current script phase (pre, setup, select, remove) */
  phase: "pre" | "setup" | "select" | "remove";
  /** ANSI output data (base64 encoded for binary safety) */
  data: string;
  /** Whether scripts are complete */
  done?: boolean;
  /** Exit code if scripts failed (only when done=true) */
  exitCode?: number;
  /** Error message if scripts failed (only when done=true) */
  error?: string;
  /** Workspace this script output belongs to. */
  workspaceId?: string;
}

/**
 * Response to any explicit remote command request.
 * Wraps the tmux-lite Response with a requestId for correlation.
 */
export interface CommandResponse {
  type: 'command_response';
  requestId: string;
  response: import('../tmux-lite/protocol.js').Response;
}

export interface OperationAcceptedResponse {
  type: 'operation_accepted';
  requestId: string;
  operation: RemoteOperationRecord;
}

export interface OperationSnapshotResponse {
  type: 'operation_snapshot';
  operations: RemoteOperationRecord[];
}

export interface OperationDismissedResponse {
  type: 'operation_dismissed';
  operationId: string;
}

export interface OperationEventResponse {
  type: 'operation_event';
  event: RemoteOperationEvent;
}

export interface RunSpaceCommandResponse {
  type: 'run_space_command_response';
  requestId: string;
  output: string;
}

export interface WorkspaceEditorsResponse {
  type: 'workspace-editors';
  requestId: string;
  editors: import('../../utils/open-editor.js').WorkspaceEditorOption[];
}

export interface RefreshMachineSnapshotResponse {
  type: 'refresh_machine_snapshot';
  requestId: string;
  snapshot: import('../tmux-lite/machine/protocol.js').MachineSnapshot;
}



/**
 * Machine pushes a full snapshot of all workspace agent states on client connect.
 * This is an unsolicited push from the machine, not a response to a request.
 */
export interface AgentStateSnapshotPush {
  type: 'agent_state_snapshot';
  workspaces: import('../tmux-lite/agent-event-manager.js').WorkspaceAgentState[];
}

/**
 * Machine pushes an incremental agent state delta to all connected clients.
 * This is an unsolicited push from the machine, not a response to a request.
 */
export interface AgentStateUpdatePush {
  type: 'agent_state_update';
  delta: import('../tmux-lite/agent-event-manager.js').AgentStateUpdateDelta;
}

/**
 * Machine pushes a full machine snapshot to the client.
 * Sent immediately after handshake + on every snapshot-replaced event.
 * This is an unsolicited push — no client request needed.
 */
export interface MachineSnapshotPush {
  type: 'machine_snapshot';
  snapshot: import('../tmux-lite/machine/protocol.js').MachineSnapshot;
}

/**
 * Machine pushes a host UI dialog request to the client.
 * The client should render the dialog and send back an agent-dialog-response.
 */
export interface AgentDialogRequestPush {
  type: 'agent_dialog_request';
  request: import('../tmux-lite/agents/host-ui-bridge.js').HostUIDialogRequest;
}

/**
 * Machine pushes a fire-and-forget host UI event to the client.
 * Status updates, notifications, widget changes, etc.
 */
export interface AgentUIEventPush {
  type: 'agent_ui_event';
  event: import('../tmux-lite/agents/host-ui-bridge.js').HostUIEvent;
}



// ============================================================================
// Union Types
// ============================================================================

/** All messages from client to machine (browsing mode) */
export type ClientToMachineMessage =
  | ListReplaysRequest
  | GetReplayFrameRequest
  | GetReplayTimelineRequest
  | DismissReplayRequest
  | UndismissReplayRequest
  | DismissOperationRequest
  | AttachSessionRequest
  | CancelPendingAttachRequest
  | DeleteWorkspaceRequest
  // Explicit remote commands (lifecycle & discovery)
  | ListGithubReposRequest
  | ListRemoteBranchesRequest
  | ListLinearIssuesRequest
  // Project CRUD
  | CreateProjectRequest
  | PrepareProjectCreationRequest
  | FinalizeProjectCreationRequest
  | CancelProjectCreationRequest
  | DeleteProjectRequest
  // Workspace CRUD
  | CreateWorkspaceRequest
  | RefreshMachineSnapshotRequest
  | ListWorkspaceNotesRequest
  | AddWorkspaceNoteRequest
  | UpdateWorkspaceNoteRequest
  | RemoveWorkspaceNoteRequest
  | AddGoalNearWorkspaceRequest
  | UpdateGoalRequest
  | ReorderGoalRequest
  | GoalStackStatusRequest
  | RerunWorkspaceScriptsRequest
  | RunWorkspaceOpenScriptsRequest
  | RunWorkspaceScriptSelectionRequest
  | ResolvePortConflictRequest
  | SetWorkspacePhaseRequest
  | TerminateSessionRequest
  | PreviewWorkspacePhaseRequest
  // Process management
  | StartProcessRequest
  | StopProcessRequest
  | RequestEventsRequest
  // Bundle & review
  | GetBundleRefreshPlanRequest
  | ApplyBundleRefreshRequest
  | GetBundleConfigStateRequest
  | ApplyBundleConfigRequest
  | RequestReviewRequest
  // Inbox & preferences
  | GetInboxRequest
  | ClearInboxRequest
  | MarkInboxReadRequest
  | GetNotificationConfigRequest
  | UpdateNotificationConfigRequest
  // Agent operations
  | ListAgentSessionsRequest
  | CreateAgentSessionRequest
  | AbortAgentSessionRequest
  | InterruptAgentSessionRequest
  | CloseAgentSessionRequest
  | ArchiveAgentSessionRequest
  | RestoreAgentSessionRequest
  | AttachAgentSessionRequest
  | PromptAgentSessionRequest
  | RemoveAgentQueuedMessageRequest
  | StageAgentUploadRequest
  | RespondAgentDialogRequest
  | RespondAgentPermissionRequest
  | GetAgentTranscriptRangeRequest
  | GetAgentControlInfoRequest
  | SetAgentModelRequest
  | SetAgentThinkingLevelRequest
  | SetAgentApprovalModeRequest
  | GetAgentAuthProvidersRequest
  | SetAgentProviderApiKeyRequest
  | GetAgentSettingsRequest
  | SetAgentSettingRequest
  | StartAgentOAuthLoginRequest
  | RespondAgentOAuthPromptRequest
  | GetAgentSettingsSchemaRequest
  | GetAgentToolsRequest
  | CompactAgentSessionRequest
  | CycleAgentRoleRequest
  | ApplyAgentRoleRequest
  | GetAgentHistoryRequest
  | NavigateAgentHistoryRequest
  | GetAgentSessionTreeRequest
  | ListArtifactsRequest
  | ReadArtifactRequest
  | WriteArtifactRequest
  | ProjectArtifactsListRequest
  | ProjectArtifactsReadRequest
  | RepoTreeRequest
  | RepoReadRequest
  | RepoCommitRequest
  | ListAgentCommandsRequest
  | ListWorkspaceEditorsRequest
  | OpenWorkspaceEditorRequest
  | GetAgentFileSuggestionsRequest
  | RunSpaceCommandRequest
  ;

/** All messages from machine to client (browsing mode) */
export type MachineToClientMessage =
  | ReplayListResponse
  | ReplayFrameResponse
  | ReplayTimelineResponse
  | ReplayDismissedResponse
  | ReplayUndismissedResponse
  | AttachedResponse
  | SessionMetaResponse
  | DetachedResponse
  | SessionExitedResponse
  | ErrorResponse
  | WorkspaceDeletedResponse
  | WorkspaceNotesResponse
  | WorkspacePhasePreviewResponse
  | WorkspaceNoteResponse
  | GoalResponse
  | GoalChainResponse
  | GoalStackStatusResponse
  | ScriptOutputResponse
  | CommandResponse
  | OperationAcceptedResponse
  | OperationSnapshotResponse
  | OperationEventResponse
  | OperationDismissedResponse
  | RunSpaceCommandResponse
  | WorkspaceEditorsResponse
  | RefreshMachineSnapshotResponse
  | AgentStateSnapshotPush
  | AgentStateUpdatePush
  | MachineSnapshotPush
  | AgentDialogRequestPush
  | AgentUIEventPush;

/** All remote session messages */
export type RemoteSessionMessage =
  | ClientToMachineMessage
  | MachineToClientMessage;

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a remote session message from JSON
 */
export function parseRemoteMessage(json: string): RemoteSessionMessage | null {
  try {
    const msg = JSON.parse(json);
    if (!msg || typeof msg.type !== "string") {
      return null;
    }
    return msg as RemoteSessionMessage;
  } catch {
    return null;
  }
}

/**
 * Serialize a remote session message to JSON
 */
export function serializeRemoteMessage(msg: RemoteSessionMessage): string {
  return JSON.stringify(msg);
}

/**
 * Check if a message is a browse command
 */
export function isBrowseMessage(msg: RemoteSessionMessage): msg is ClientToMachineMessage {
  // All ClientToMachineMessage types are browse-mode messages.
  // This list is maintained alongside the ClientToMachineMessage union above.
  const BROWSE_TYPES: ReadonlySet<string> = new Set([
    'list_replays',
    'get_replay_frame',
    'get_replay_timeline',
    'dismiss_replay',
    'undismiss_replay',
    'dismiss_operation',
    'attach_session',
    'cancel_pending_attach',
    'delete_workspace',
    // Explicit remote commands
    'list_github_repos',
    'list_remote_branches',
    'list_linear_issues',
    'create_project',
    'prepare_project_creation',
    'finalize_project_creation',
    'cancel_project_creation',
    'delete_project',
    'create_workspace',
    'refresh_machine_snapshot',
    'workspace_notes_list',
    'workspace_note_add',
    'workspace_note_update',
    'workspace_note_remove',
    'goal_add_near_workspace',
    'goal_update',
    'goal_reorder',
    'goal_stack_status',
    'rerun_workspace_scripts',
    'run_workspace_open_scripts',
    'run_workspace_script_selection',
    'preview_workspace_phase',
    'set_workspace_phase',
    'terminate_session',
    'start_process',
    'stop_process',
    'resolve_port_conflict',
    'request_events',
    'get_bundle_refresh_plan',
    'apply_bundle_refresh',
    'get_bundle_config_state',
    'apply_bundle_config',
    'request_review',
    'get_inbox',
    'clear_inbox',
    'mark_inbox_read',
    'get_notification_config',
    'update_notification_config',
    'list_agent_sessions',
    'create_agent_session',
    'abort_agent_session',
    'interrupt_agent_session',
    'close_agent_session',
    'archive_agent_session',
    'restore_agent_session',
    'attach_agent_session',
    'prompt_agent_session',
    'remove_agent_queued_message',
    'stage_agent_upload',
    'respond_agent_dialog',
    'respond_agent_permission',
    'get_agent_transcript_range',
    'get_agent_control_info',
    'set_agent_model',
    'set_agent_thinking_level',
    'set_agent_approval_mode',
    'get_agent_auth_providers',
    'set_agent_provider_api_key',
    'get_agent_settings',
    'set_agent_setting',
    'start_agent_oauth_login',
    'respond_agent_oauth_prompt',
    'get_agent_settings_schema',
    'get_agent_tools',
    'compact_agent_session',
    'cycle_agent_role',
    'apply_agent_role',
    'get_agent_history',
    'navigate_agent_history',
    'get_agent_session_tree',
    'list_artifacts',
    'read_artifact',
    'write_artifact',
    'project_artifacts_list',
    'project_artifacts_read',
    'repo_tree',
    'repo_read',
    'repo_commit',
    'list_agent_commands',
    'list_workspace_editors',
    'open_workspace_editor',
    'get_agent_file_suggestions',
    'run_space_command',
  ]);
  return BROWSE_TYPES.has(msg.type);
}
