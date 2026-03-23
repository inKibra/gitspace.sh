/**
 * Remote transport protocol for encrypted client<->machine communication.
 *
 * App and machine operations flow through tmux-lite via `tmux_command`.
 * The remaining top-level messages are transport-oriented attached/replay flows
 * plus machine and agent snapshot pushes.
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

// Re-export attached mode control types from tmux-lite
// These are used in attached mode for resize/detach/attach-init
export type { SessionCtrl, SessionEvent } from "../tmux-lite/protocol.js";

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

/** Cancel a currently running attach workflow (typically stuck scripts). */
export interface CancelPendingAttachRequest {
  type: 'cancel_pending_attach';
}

export interface TmuxCommandRequest {
  type: 'tmux_command';
  requestId: string;
  command: import('../tmux-lite/protocol.js').Command;
}

/** Delete a workspace */
export interface DeleteWorkspaceRequest {
  type: "delete_workspace";
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
  processes?: { name: string; instances?: number; ports?: import("../../types/processes.js").ProcessPortConfig[] }[];
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

/** Session attached successfully - transitions to attached mode */
export interface AttachedResponse {
  type: "attached";
  sessionId: string;
  sessionName: string;
   processTitle?: string;
   terminalTitle?: string;
   lastAlertKind?: import('../tmux-lite/protocol.js').InboxItem['type'];
   lastAlertPreview?: string;
   lastAlertAt?: number;
   unreadAlertCount?: number;
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
  projectName?: string;
  requestId?: string;
}

/** Workspace deleted response */
export interface WorkspaceDeletedResponse {
  type: "workspace_deleted";
  workspaceId: string;
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

export interface TmuxCommandResponse {
  type: 'tmux_command_response';
  requestId: string;
  response: import('../tmux-lite/protocol.js').Response;
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
  | TmuxCommandRequest
  ;

/** All messages from machine to client (browsing mode) */
export type MachineToClientMessage =
  | ReplayListResponse
  | ReplayFrameResponse
  | ReplayTimelineResponse
  | ReplayDismissedResponse
  | ReplayUndismissedResponse
  | AttachedResponse
  | DetachedResponse
  | SessionExitedResponse
  | ErrorResponse
  | WorkspaceDeletedResponse
  | ScriptOutputResponse
  | TmuxCommandResponse
  | AgentStateSnapshotPush
  | AgentStateUpdatePush
  | MachineSnapshotPush;

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
export function isBrowseMessage(msg: RemoteSessionMessage): msg is
  | ListReplaysRequest
  | GetReplayFrameRequest
  | GetReplayTimelineRequest
  | DismissReplayRequest
  | UndismissReplayRequest
  | AttachSessionRequest
  | CancelPendingAttachRequest
  | DeleteWorkspaceRequest
  | TmuxCommandRequest {
  return [
    'list_replays',
    'get_replay_frame',
    'get_replay_timeline',
    'dismiss_replay',
    'undismiss_replay',
    "attach_session",
    'cancel_pending_attach',
    'delete_workspace',
    'tmux_command',
  ].includes(msg.type);
}
