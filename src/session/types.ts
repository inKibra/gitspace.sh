import type {
  InboxItem,
  ProjectInfo,
  SessionInfo,
  ScriptOutputResponse,
  RemoteOperationRecord,
  WorkspaceInfo,
} from '../lib/remote-session/protocol.js';
import type { NotificationConfig } from '../notifications/types.js';
import type { BackendDescriptor, BackendKey } from './backend.js';
import type { WideEvent, SavedEventFilter } from '../types/events.js';
import type { ReplayInfo } from '../lib/tmux-lite/replay/index.js';
import type { MachineSnapshot } from '../lib/tmux-lite/machine/protocol.js';

export interface AttachedSessionMeta {
  sessionName?: string | null;
  processTitle?: string | null;
  terminalTitle?: string | null;
  lastAlertKind?: import('../lib/tmux-lite/protocol.js').InboxItem['type'] | null;
  lastAlertPreview?: string | null;
  lastAlertAt?: number | null;
  unreadAlertCount?: number | null;
}

export interface ScriptRuntimeState {
  phase: ScriptOutputResponse['phase'];
  isRunning: boolean;
  error?: string;
  exitCode?: number;
  /** Workspace this script phase belongs to — consumers can detect stale state */
  workspaceId?: string;
}

export interface AttachedPaneState {
  paneId: string;
  /** PTY stream this pane reads, or null for a pane with no terminal at all —
   *  an agent pane renders the native transcript from events. */
  streamId: number | null;
  /** Terminal session backing the pane, or null for a stream-less agent pane. */
  sessionId: string | null;
  sessionName: string | null;
  meta: AttachedSessionMeta | null;
  workspaceId: string | null;
  agentSessionId: string | null;
  viewOnly: boolean;
}


export interface BackendSessionState {
  descriptor: BackendDescriptor;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error: string | null;
  commandError: { code?: string; message: string } | null;

  projects: ProjectInfo[];
  workspaces: WorkspaceInfo[];
  sessions: SessionInfo[];
  replays: ReplayInfo[];
  machineSnapshot: MachineSnapshot | null;
  /** Set when the initial machine snapshot failed to load (e.g. timed out); cleared when a snapshot arrives. */
  snapshotError: string | null;
  operations: Record<string, RemoteOperationRecord>;

  inbox: InboxItem[];
  inboxUnreadCount: number;

  notificationConfig: NotificationConfig | null;

  mode: 'browsing' | 'attached';
  attachedSessionId: string | null;
  attachedSessionName: string | null;
  attachedSessionMeta: AttachedSessionMeta | null;
  attachedWorkspaceId: string | null;
  /** Set when the default pane is showing an agent session. */
  attachedAgentSessionId: string | null;
  /** Set while an agent session is being opened. Cleared on open or error. */
  pendingAgentAttach: boolean;
  attachedPanes: Record<string, AttachedPaneState>;

  scriptState: ScriptRuntimeState | null;

  events: WideEvent[];
  liveEventIds: string[];
  savedEventFilters: SavedEventFilter[];

  pendingDialogRequest: import('../lib/tmux-lite/agents/host-ui-bridge.js').HostUIDialogRequest | null;
  agentWorkingMessage: string | undefined;
  pendingDialogByAgentSessionId: Record<string, import('../lib/tmux-lite/agents/host-ui-bridge.js').HostUIDialogRequest>;
  workingMessageByAgentSessionId: Record<string, string>;
}

export interface SessionEngineState {
  backendOrder: BackendKey[];
  backends: Record<BackendKey, BackendSessionState>;
  activeBackendKey: BackendKey | null;
}

export type SessionEngineAction =
  | { type: 'REGISTER_BACKEND'; descriptor: BackendDescriptor }
  | { type: 'UNREGISTER_BACKEND'; backendKey: BackendKey }
  | { type: 'SET_ACTIVE_BACKEND'; backendKey: BackendKey | null }
  | {
      type: 'SET_BACKEND_STATUS';
      backendKey: BackendKey;
      status: BackendSessionState['status'];
      error?: string | null;
    }
  | { type: 'SET_PROJECTS'; backendKey: BackendKey; projects: ProjectInfo[] }
  | { type: 'SET_WORKSPACES'; backendKey: BackendKey; workspaces: WorkspaceInfo[] }
  | { type: 'SET_SESSIONS'; backendKey: BackendKey; sessions: SessionInfo[] }
  | { type: 'SET_REPLAYS'; backendKey: BackendKey; replays: ReplayInfo[] }
  | { type: 'SET_MACHINE_SNAPSHOT'; backendKey: BackendKey; snapshot: MachineSnapshot | null }
  | { type: 'SET_SNAPSHOT_ERROR'; backendKey: BackendKey; message: string | null }
  | {
      type: 'SET_INBOX';
      backendKey: BackendKey;
      items: InboxItem[];
      unreadCount: number;
    }
  | {
      type: 'SET_NOTIFICATION_CONFIG';
      backendKey: BackendKey;
      config: NotificationConfig | null;
    }
  | {
      type: 'SET_SCRIPT_STATE';
      backendKey: BackendKey;
      scriptState: ScriptRuntimeState | null;
    }
  | {
      type: 'SET_OPERATIONS';
      backendKey: BackendKey;
      operations: RemoteOperationRecord[];
    }
  | {
      type: 'APPLY_OPERATION_EVENT';
      backendKey: BackendKey;
      operation: RemoteOperationRecord;
    }
  | {
      type: 'DISMISS_OPERATION';
      backendKey: BackendKey;
      operationId: string;
    }
  | {
      type: 'SET_ATTACHED_SESSION';
      backendKey: BackendKey;
      sessionId: string | null;
      sessionName?: string | null;
      meta?: AttachedSessionMeta | null;
      workspaceId?: string | null;
      agentSessionId?: string | null;
      preserveContextOnExit?: boolean;
    }
  | {
      type: 'ADD_PANE';
      backendKey: BackendKey;
      pane: AttachedPaneState;
    }
  | { type: 'REMOVE_PANE'; backendKey: BackendKey; paneId: string }
  | { type: 'UPDATE_PANE_META'; backendKey: BackendKey; paneId: string; meta: AttachedSessionMeta | null }
  | { type: 'CLEAR_ALL_PANES'; backendKey: BackendKey }
  | {
      type: 'SET_ATTACHED_SESSION_META';
      backendKey: BackendKey;
      meta: AttachedSessionMeta | null;
    }
  | {
      type: 'SET_COMMAND_ERROR';
      backendKey: BackendKey;
      commandError: { code?: string; message: string } | null;
    }
  | {
      type: 'SET_EVENTS';
      backendKey: BackendKey;
      events: WideEvent[];
      liveEventIds: string[];
    }
  | {
      type: 'SET_SAVED_EVENT_FILTERS';
      backendKey: BackendKey;
      filters: SavedEventFilter[];
    }
  | {
      type: 'SET_HOST_UI_DIALOG';
      backendKey: BackendKey;
      request: import('../lib/tmux-lite/agents/host-ui-bridge.js').HostUIDialogRequest;
    }
  | {
      type: 'SET_HOST_UI_WORKING_MESSAGE';
      backendKey: BackendKey;
      sessionId: string;
      message: string | undefined;
    }
  | { type: 'CLEAR_HOST_UI_DIALOG'; backendKey: BackendKey; agentSessionId?: string }
  | { type: 'SET_PENDING_AGENT_ATTACH'; backendKey: BackendKey; pending: boolean };
