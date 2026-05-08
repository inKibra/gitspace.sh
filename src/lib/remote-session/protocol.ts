/**
 * Remote transport protocol for encrypted client<->machine communication.
 *
 * Each operation has an explicit request type. The server responds with a
 * CommandResponse wrapping the tmux-lite Response for request/response
 * correlation. Unsolicited pushes (machine_snapshot, agent_state_*, etc.)
 * are sent without a request.
 */

// Re-export InboxItem from tmux-lite protocol
export type { InboxItem } from "../tmux-lite/protocol.js";

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
  workspaceSource?: import('../../types/lifecycle.js').WorkspaceSource;
  linearIssue?: import('../../types/lifecycle.js').SessionLinearIssueSummary;
}

export interface ListWorkspaceNotesRequest {
  type: 'workspace_notes_list';
  requestId: string;
  projectName: string;
  workspaceName: string;
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
}

export interface KillSessionRequest {
  type: 'kill_session';
  requestId: string;
  sessionId: string;
}

// --- Process Management ---

export interface StartProcessRequest {
  type: 'start_process';
  requestId: string;
  workspaceId: string;
  processName: string;
  instance?: number;
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

export interface ListAgentCommandsRequest {
  type: 'list_agent_commands';
  requestId: string;
  target: import('../tmux-lite/protocol.js').AgentWorkspaceTargetPayload;
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

export interface RunSpaceCommandResponse {
  type: 'run_space_command_response';
  requestId: string;
  output: string;
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
  | ListWorkspaceNotesRequest
  | AddWorkspaceNoteRequest
  | UpdateWorkspaceNoteRequest
  | RemoveWorkspaceNoteRequest
  | RerunWorkspaceScriptsRequest
  | RunWorkspaceOpenScriptsRequest
  | RunWorkspaceScriptSelectionRequest
  | SetWorkspacePhaseRequest
  | KillSessionRequest
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
  | ListAgentCommandsRequest
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
  | WorkspaceNoteResponse
  | ScriptOutputResponse
  | CommandResponse
  | RunSpaceCommandResponse
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
    'workspace_notes_list',
    'workspace_note_add',
    'workspace_note_update',
    'workspace_note_remove',
    'rerun_workspace_scripts',
    'run_workspace_open_scripts',
    'run_workspace_script_selection',
    'set_workspace_phase',
    'kill_session',
    'start_process',
    'stop_process',
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
    'list_agent_commands',
    'get_agent_file_suggestions',
    'run_space_command',
  ]);
  return BROWSE_TYPES.has(msg.type);
}
