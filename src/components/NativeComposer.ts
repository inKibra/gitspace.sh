/**
 * NativeComposer — platform-agnostic state model for the native composer surface.
 *
 * No JSX, no DOM, no React imports beyond the `Reducer` type alias.
 * Consumed by both .web.tsx and .tui.tsx renderers.
 */

import type {
  HostUIDialogRequest,
  HostUIStatusEvent,
  HostUIWorkingMessageEvent,
  HostUINotifyEvent,
} from '../lib/tmux-lite/agents/host-ui-bridge.js';

// ---------------------------------------------------------------------------
// Composer state
// ---------------------------------------------------------------------------

export interface ComposerImage {
  id: string;
  dataUrl: string;
  name: string;
}

export interface ComposerFile {
  id: string;
  path: string;
  name: string;
}

export interface ComposerState {
  text: string;
  images: ComposerImage[];
  files: ComposerFile[];
  isSubmitting: boolean;
}

// ---------------------------------------------------------------------------
// Composer actions
// ---------------------------------------------------------------------------

export type ComposerAction =
  | { type: 'setText'; text: string }
  | { type: 'addImage'; dataUrl: string; name: string }
  | { type: 'removeImage'; id: string }
  | { type: 'addFile'; path: string; name: string }
  | { type: 'removeFile'; id: string }
  | { type: 'setSubmitting'; value: boolean }
  | { type: 'reset' };

// ---------------------------------------------------------------------------
// Dialog state (pending server-initiated dialog request)
// ---------------------------------------------------------------------------

export interface HostUIDialogState {
  pending: HostUIDialogRequest | null;
}

// ---------------------------------------------------------------------------
// Agent status state (working message, per-key status lines, notifications)
// ---------------------------------------------------------------------------

export interface AgentNotification {
  id: string;
  message: string;
  notificationType: 'info' | 'warning' | 'error';
  sessionId: string;
}

export interface AgentStatusState {
  /** Short working-progress message shown while the agent is active. */
  workingMessage: string | undefined;
  /**
   * Named status entries keyed by `HostUIStatusEvent.key`.
   * A value of `undefined` means the entry was cleared by the server.
   */
  statusEntries: Record<string, string | undefined>;
  /** Ordered list of notifications from the current session. */
  notifications: AgentNotification[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments that lack crypto.randomUUID (rare, belt-and-suspenders).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case 'setText':
      return { ...state, text: action.text };

    case 'addImage':
      return {
        ...state,
        images: [...state.images, { id: newId(), dataUrl: action.dataUrl, name: action.name }],
      };

    case 'removeImage':
      return { ...state, images: state.images.filter((img) => img.id !== action.id) };

    case 'addFile':
      return {
        ...state,
        files: [...state.files, { id: newId(), path: action.path, name: action.name }],
      };

    case 'removeFile':
      return { ...state, files: state.files.filter((f) => f.id !== action.id) };

    case 'setSubmitting':
      return { ...state, isSubmitting: action.value };

    case 'reset':
      return initialComposerState();
  }
}

// ---------------------------------------------------------------------------
// Initial state factory
// ---------------------------------------------------------------------------

export function initialComposerState(): ComposerState {
  return {
    text: '',
    images: [],
    files: [],
    isSubmitting: false,
  };
}
