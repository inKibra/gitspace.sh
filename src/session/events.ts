import type {
  InboxItem,
  ProjectInfo,
  SessionInfo,
  ScriptOutputResponse,
  WorkspaceInfo,
} from '../lib/remote-session/protocol.js';
import type { NotificationConfig } from '../notifications/types.js';
import type { ReviewOperation, ReviewResult } from '../types/review.js';

export type BackendEvent =
  | { type: 'status'; status: 'disconnected' | 'connecting' | 'connected' | 'error'; error?: string }
  | { type: 'projects'; projects: ProjectInfo[] }
  | { type: 'workspaces'; workspaces: WorkspaceInfo[] }
  | { type: 'sessions'; sessions: SessionInfo[] }
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
  | { type: 'attached'; sessionId: string; sessionName?: string }
  | { type: 'detached' }
  | { type: 'session_exited'; sessionId: string; exitCode?: number }
  | { type: 'command_error'; code?: string; message: string }
  | { type: 'error'; message: string }
  | { type: 'review_response'; requestId: string; result?: ReviewResult; error?: { code: string; message: string } };

// Re-export for convenience
export type { ReviewOperation, ReviewResult };
