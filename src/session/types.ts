import type {
  InboxItem,
  ProjectInfo,
  SessionInfo,
  ScriptOutputResponse,
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

  inbox: InboxItem[];
  inboxUnreadCount: number;

  notificationConfig: NotificationConfig | null;

  mode: 'browsing' | 'attached';
  attachedSessionId: string | null;
  attachedSessionName: string | null;
  attachedSessionMeta: AttachedSessionMeta | null;
  attachedWorkspaceId: string | null;

  scriptState: ScriptRuntimeState | null;

  events: WideEvent[];
  liveEventIds: string[];
  savedEventFilters: SavedEventFilter[];
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
      type: 'SET_ATTACHED_SESSION';
      backendKey: BackendKey;
      sessionId: string | null;
      sessionName?: string | null;
      meta?: AttachedSessionMeta | null;
      workspaceId?: string | null;
    }
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
    };
