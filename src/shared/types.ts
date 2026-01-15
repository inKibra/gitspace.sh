/**
 * Shared types for TUI and Web components
 *
 * These types are platform-agnostic and used by both interfaces.
 */

// ============================================================================
// Machine Types
// ============================================================================

/** Machine connection status */
export type MachineStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

/** Machine info for display */
export interface MachineInfo {
  /** Unique machine ID */
  id: string;
  /** Display label */
  label: string;
  /** Whether this is the local machine */
  isLocal: boolean;
  /** Connection status */
  status: MachineStatus;
  /** Error message if status is 'error' */
  error?: string;
}

// ============================================================================
// Project Types
// ============================================================================

/** Project state for display */
export interface Project {
  /** Project name */
  name: string;
  /** GitHub repository (e.g., "owner/repo") */
  repository: string;
  /** Number of workspaces */
  workspaceCount: number;
  /** Whether this is the currently selected project */
  isCurrent: boolean;
}

// ============================================================================
// Workspace Types
// ============================================================================

/** Session within a workspace */
export interface WorkspaceSession {
  /** Session ID */
  id: string;
  /** Session name */
  name: string;
  /** Whether a client is attached */
  attached: boolean;
  /** Creation timestamp */
  createdAt: number;
  /** Current process title */
  processTitle?: string;
}

/** Workspace state for display */
export interface Workspace {
  /** Workspace name */
  name: string;
  /** Full path to workspace directory */
  path: string;
  /** Git branch name */
  branch: string;
  /** Commits ahead of remote */
  ahead: number;
  /** Commits behind remote */
  behind: number;
  /** Number of uncommitted changes */
  uncommittedChanges: number;
  /** Last commit date */
  lastCommitDate: Date;
  /** Whether workspace is stale (no recent activity) */
  isStale: boolean;
  /** Active sessions in this workspace */
  sessions: WorkspaceSession[];
}

// ============================================================================
// Inbox Types
// ============================================================================

/** Inbox notification types */
export type InboxItemType = 'bell' | 'exit' | 'title' | 'idle' | 'osc';

/** Inbox notification item */
export interface InboxItem {
  /** Unique ID */
  id: string;
  /** Session ID that generated the notification */
  sessionId: string;
  /** Session name */
  sessionName: string;
  /** Notification type */
  type: InboxItemType;
  /** Timestamp */
  timestamp: number;
  /** Whether the item has been read */
  read: boolean;
  /** Context/message content */
  context: string;
  /** Process title when notification occurred */
  processTitle?: string;
  /** Exit code (for exit type) */
  exitCode?: number;
}

// ============================================================================
// Session Stream Types
// ============================================================================

/** Stream for terminal I/O */
export interface SessionStream {
  /** Send data to the session */
  write(data: Uint8Array): void;
  /** Resize the terminal */
  resize(cols: number, rows: number): void;
  /** Detach from the session */
  detach(): void;
  /** Close the stream */
  close(): void;
  /** Register data handler */
  onData(handler: (data: Uint8Array) => void): void;
  /** Register close handler */
  onClose(handler: (exitCode?: number) => void): void;
}

// ============================================================================
// Navigation Types
// ============================================================================

/** Navigation location */
export type NavigationLocation =
  | { screen: 'machines' }
  | { screen: 'projects'; machineId: string }
  | { screen: 'workspaces'; machineId: string; projectName: string }
  | { screen: 'session'; machineId: string; projectName: string; workspaceName: string; sessionId: string };

/** Panel focus */
export type PanelFocus = 'machines' | 'projects' | 'workspaces' | 'inbox';
