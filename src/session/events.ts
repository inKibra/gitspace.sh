import type {
  InboxItem,
  ProjectInfo,
  SessionInfo,
  ScriptOutputResponse,
  WorkspaceInfo,
} from '../lib/remote-session/protocol.js';
import type { NotificationConfig } from '../notifications/types.js';
import type { ReviewOperation, ReviewResult } from '../types/review.js';
import type { WideEvent, SavedEventFilter } from '../types/events.js';
import type { ReplayInfo } from '../lib/tmux-lite/replay/index.js';
import type { MachineSnapshot } from '../lib/tmux-lite/machine/protocol.js';
import type { AttachedSessionMeta } from './types.js';
import type { HostUIDialogRequest, HostUIEvent } from '../lib/tmux-lite/agents/host-ui-bridge.js';

export type BackendEvent =
  | { type: 'status'; status: 'disconnected' | 'connecting' | 'connected' | 'error'; error?: string }
  | { type: 'projects'; projects: ProjectInfo[] }
  | { type: 'workspaces'; workspaces: WorkspaceInfo[]; savedEventFilters?: SavedEventFilter[] }
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'replays'; replays: ReplayInfo[] }
  | { type: 'inbox'; items: InboxItem[]; unreadCount: number }
  | {
      type: 'script_output';
      phase: ScriptOutputResponse['phase'];
      data: Uint8Array;
      done?: boolean;
      error?: string;
      exitCode?: number;
    }
  | { type: 'notification_config'; config: NotificationConfig }
  | { type: 'attached'; sessionId: string; sessionName?: string; viewOnly?: boolean; workspaceId?: string; agentSessionId?: string }
  | { type: 'session_meta'; meta: AttachedSessionMeta }
  | { type: 'detached' }
  | { type: 'session_exited'; sessionId: string; exitCode?: number }
  | { type: 'command_error'; code?: string; message: string }
  | { type: 'error'; message: string }
  | { type: 'events'; events: WideEvent[]; liveEventIds: string[]; savedEventFilters?: SavedEventFilter[] }
  | { type: 'machine_snapshot'; snapshot: MachineSnapshot }
  | { type: 'process_started'; workspaceId: string; processName: string; sessionId?: string; sessionIds?: string[] }
  | { type: 'process_stopped'; workspaceId: string; processName: string }
  | { type: 'host_ui_dialog_request'; request: HostUIDialogRequest }
  | { type: 'host_ui_event'; event: HostUIEvent };

// Re-export for convenience
export type { ReviewOperation, ReviewResult };
