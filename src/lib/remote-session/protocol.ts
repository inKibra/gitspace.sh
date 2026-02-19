/**
 * Remote session protocol - encrypted messages between client and machine
 *
 * These messages are sent over the encrypted channel after X3DH handshake.
 *
 * ## Protocol Layers
 *
 * 1. **Browsing Mode**: Uses JSON-RPC style messages (list_workspaces, attach_session, etc.)
 *    - Client sends: ClientToMachineMessage
 *    - Machine responds: MachineToClientMessage
 *
 * 2. **Attached Mode**: Uses binary framing with tmux-lite protocol
 *    - STREAM_ID.DATA (0): Raw PTY bytes (stdin/stdout)
 *    - STREAM_ID.CONTROL (1): JSON SessionCtrl messages (resize, detach, attach-init)
 *    - See src/lib/tmux-lite/protocol.ts for SessionCtrl/SessionEvent types
 */

// Re-export InboxItem from tmux-lite protocol
export type { InboxItem } from "../tmux-lite/protocol.js";
export type { ReviewOperation, ReviewResult } from "../../types/review.js";
export type {
  BundleRefreshPlan,
  BundleRefreshSubmission,
} from "../../types/bundle-refresh.js";

// Re-export attached mode control types from tmux-lite
// These are used in attached mode for resize/detach/attach-init
export type { SessionCtrl, SessionEvent } from "../tmux-lite/protocol.js";

// ============================================================================
// Client → Machine Messages (Browsing Mode)
// ============================================================================

/** Request list of workspaces on the machine */
export interface ListWorkspacesRequest {
  type: "list_workspaces";
}

/** Request list of sessions, optionally filtered by workspace */
export interface ListSessionsRequest {
  type: "list_sessions";
  workspaceId?: string;  // Filter by workspace, or all if omitted
}

/** Attach to a session (existing or new) */
export interface AttachSessionRequest {
  type: "attach_session";
  sessionId?: string;     // Attach to existing session
  workspaceId?: string;   // Create new session in workspace
  sessionName?: string;   // Name for new session (optional)
  cols?: number;          // Terminal dimensions
  rows?: number;
  scriptPolicy?: 'auto' | 'skip';
  command?: string;       // Command to run (process sessions)
  args?: string[];        // Command arguments
  env?: Record<string, string>;  // Environment variables
  /** When true, the server blocks PTY writes from this client */
  viewOnly?: boolean;
}

/** Request wide events for a workspace */
export interface GetEventsRequest {
  type: "get_events";
  workspacePath: string;
  processName?: string;
  filter?: import("../../types/events.js").WideEventFilter;
  limit?: number;
  sinceMs?: number;
}

/** Start a process in a workspace */
export interface StartProcessRequest {
  type: "start_process";
  workspaceId: string;
  processName: string;
}

/** Stop a process in a workspace */
export interface StopProcessRequest {
  type: "stop_process";
  workspaceId: string;
  processName: string;
}

/** Request list of projects on the machine */
export interface ListProjectsRequest {
  type: "list_projects";
}

/** Kill a session */
export interface KillSessionRequest {
  type: "kill_session";
  sessionId: string;
}

/** Delete a workspace */
export interface DeleteWorkspaceRequest {
  type: "delete_workspace";
  workspaceId: string;
  projectName: string;  // Needed to locate workspace
  scriptPolicy?: 'auto' | 'skip';
}

/** Request inbox items */
export interface GetInboxRequest {
  type: "get_inbox";
}

/** Clear inbox item(s) */
export interface ClearInboxRequest {
  type: "clear_inbox";
  id?: string;  // If omitted, clears all
}

/** Mark inbox item as read */
export interface MarkInboxReadRequest {
  type: "mark_inbox_read";
  id: string;
}

/** Request current notification configuration */
export interface GetNotificationConfigRequest {
  type: "get_notification_config";
}

/** Update notification configuration */
export interface UpdateNotificationConfigRequest {
  type: "update_notification_config";
  config: import("../../notifications/types.js").NotificationConfig;
}

/** Request bundle refresh plan for a workspace */
export interface GetBundleRefreshPlanRequest {
  type: "get_bundle_refresh_plan";
  projectName: string;
  workspaceId: string;
}

/** Apply bundle refresh submission for a workspace */
export interface ApplyBundleRefreshRequest {
  type: "apply_bundle_refresh";
  projectName: string;
  workspaceId: string;
  submission: import("../../types/bundle-refresh.js").BundleRefreshSubmission;
}

/**
 * Review operation request — wraps all review sub-operations in a single
 * message type, matched to its response by requestId.
 */
export interface ReviewRequest {
  type: "review_request";
  /** Unique ID for correlating request → response */
  requestId: string;
  operation: import("../../types/review.js").ReviewOperation;
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
  processes?: { name: string; instances?: number; ports?: import("../../types/processes.js").ProcessPortConfig[] }[];
}

/** Session information */
export interface SessionInfo {
  id: string;
  name: string;           // Display name (project:workspace:num)
  workspaceId: string;
  attached: boolean;      // Currently attached by another client
  createdAt: number;
  processTitle?: string;  // Current process (e.g., "vim", "npm run dev")
  exitCode?: number;      // If session has exited
  processName?: string;   // Managed process name
  processInstance?: number; // Managed process instance number
}

/** Response with workspace list */
export interface WorkspaceListResponse {
  type: "workspace_list";
  workspaces: WorkspaceInfo[];
  savedEventFilters?: import("../../types/events.js").SavedEventFilter[];
}

/** Response with session list */
export interface SessionListResponse {
  type: "session_list";
  sessions: SessionInfo[];
}

/** Session attached successfully - transitions to attached mode */
export interface AttachedResponse {
  type: "attached";
  sessionId: string;
  sessionName: string;
  cols: number;
  rows: number;
}

/** Detached from session - back to browsing mode */
export interface DetachedResponse {
  type: "detached";
}

/** Session exited */
export interface SessionExitedResponse {
  type: "session_exited";
  sessionId: string;
  exitCode: number;
}

/** Error response */
export interface ErrorResponse {
  type: "error";
  code: string;
  message: string;
  workspaceId?: string;
}

/** Project information */
export interface ProjectInfo {
  name: string;
  repository: string;
  workspaceCount: number;
  isCurrent: boolean;
}

/** Response with project list */
export interface ProjectListResponse {
  type: "project_list";
  projects: ProjectInfo[];
}

/** Session killed response */
export interface SessionKilledResponse {
  type: "session_killed";
  sessionId: string;
  workspaceId: string;
}

/** Workspace deleted response */
export interface WorkspaceDeletedResponse {
  type: "workspace_deleted";
  workspaceId: string;
}

/** Response with inbox items */
export interface InboxListResponse {
  type: "inbox_list";
  items: import("../tmux-lite/protocol.js").InboxItem[];
  unreadCount: number;
}

/** Inbox item(s) cleared response */
export interface InboxClearedResponse {
  type: "inbox_cleared";
  id?: string;  // Which item was cleared, or undefined if all cleared
}

/** Inbox item marked as read response */
export interface InboxMarkedReadResponse {
  type: "inbox_marked_read";
  id: string;
}

/** Current notification configuration */
export interface NotificationConfigResponse {
  type: "notification_config";
  config: import("../../notifications/types.js").NotificationConfig;
}

/** Notification configuration updated */
export interface NotificationConfigUpdatedResponse {
  type: "notification_config_updated";
  config: import("../../notifications/types.js").NotificationConfig;
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
}

/** Bundle refresh plan response */
export interface BundleRefreshPlanResponse {
  type: "bundle_refresh_plan";
  plan: import("../../types/bundle-refresh.js").BundleRefreshPlan;
}

/** Bundle refresh applied successfully */
export interface BundleRefreshAppliedResponse {
  type: "bundle_refresh_applied";
  projectName: string;
  workspaceId: string;
}

/** Review operation response — carries either a result or an error */
export interface ReviewResponse {
  type: "review_response";
  /** Matches the requestId from the ReviewRequest */
  requestId: string;
  result?: import("../../types/review.js").ReviewResult;
  error?: { code: string; message: string };
}

/** Response with wide events list */
export interface EventsListResponse {
  type: "events_list";
  workspaceId: string;
  events: import("../../types/events.js").WideEvent[];
  liveEventIds: string[];
  requestId?: string;
  chunkIndex?: number;
  totalChunks?: number;
}

/** Process started response */
export interface ProcessStartedResponse {
  type: "process_started";
  workspaceId: string;
  processName: string;
  sessionId?: string;
}

/** Process stopped response */
export interface ProcessStoppedResponse {
  type: "process_stopped";
  workspaceId: string;
  processName: string;
}

// ============================================================================
// Union Types
// ============================================================================

/** All messages from client to machine (browsing mode) */
export type ClientToMachineMessage =
  | ListWorkspacesRequest
  | ListSessionsRequest
  | AttachSessionRequest
  | ListProjectsRequest
  | KillSessionRequest
  | DeleteWorkspaceRequest
  | GetInboxRequest
  | ClearInboxRequest
  | MarkInboxReadRequest
  | GetNotificationConfigRequest
  | UpdateNotificationConfigRequest
  | GetBundleRefreshPlanRequest
  | ApplyBundleRefreshRequest
  | ReviewRequest
  | GetEventsRequest
  | StartProcessRequest
  | StopProcessRequest;

/** All messages from machine to client (browsing mode) */
export type MachineToClientMessage =
  | WorkspaceListResponse
  | SessionListResponse
  | AttachedResponse
  | DetachedResponse
  | SessionExitedResponse
  | ErrorResponse
  | ProjectListResponse
  | SessionKilledResponse
  | WorkspaceDeletedResponse
  | InboxListResponse
  | InboxClearedResponse
  | InboxMarkedReadResponse
  | NotificationConfigResponse
  | NotificationConfigUpdatedResponse
  | ScriptOutputResponse
  | BundleRefreshPlanResponse
  | BundleRefreshAppliedResponse
  | ReviewResponse
  | EventsListResponse
  | ProcessStartedResponse
  | ProcessStoppedResponse;

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
 * Check if a message is a browse command (workspace/session listing)
 */
export function isBrowseMessage(msg: RemoteSessionMessage): msg is
  | ListWorkspacesRequest
  | ListSessionsRequest
  | AttachSessionRequest {
  return ["list_workspaces", "list_sessions", "attach_session", "get_events"].includes(msg.type);
}
