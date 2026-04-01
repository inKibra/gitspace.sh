/**
 * Host UI Bridge — routes Pi SDK extension UI requests to the native GitSpace
 * surface (web or TUI) instead of the Pi terminal.
 *
 * Architecture:
 *   Pi SDK extension calls → ExtensionUIContext → OmpHostUIContext (this bridge)
 *     → emits a dialog request event
 *     → waits on a Promise for the native UI response
 *     → returns the result to the SDK
 *
 * The bridge is installed into each agent session via setToolUIContext().
 * Dialog requests are emitted to the owning native client and resolved from its response.
 */

import type { OmpHostUIContext, OmpDialogOptions } from './omp-types.js';

type HostUIDialogOptions = Pick<OmpDialogOptions, 'helpText'>;
// ---------------------------------------------------------------------------
// Dialog request types — server → client
// ---------------------------------------------------------------------------

export type HostUIDialogRequest =
  | {
      type: 'select';
      id: string;
      sessionId: string;
      title: string;
      options: string[];
      dialogOptions?: HostUIDialogOptions;
    }
  | {
      type: 'confirm';
      id: string;
      sessionId: string;
      title: string;
      message: string;
      dialogOptions?: HostUIDialogOptions;
    }
  | {
      type: 'input';
      id: string;
      sessionId: string;
      title: string;
      placeholder?: string;
      dialogOptions?: HostUIDialogOptions;
    }
  | {
      type: 'editor';
      id: string;
      sessionId: string;
      title: string;
      prefill?: string;
    };

// ---------------------------------------------------------------------------
// Dialog response types — client → server
// ---------------------------------------------------------------------------

export type HostUIDialogResponse =
  | { type: 'select'; id: string; value: string | undefined }
  | { type: 'confirm'; id: string; value: boolean }
  | { type: 'input'; id: string; value: string | undefined }
  | { type: 'editor'; id: string; value: string | undefined };

// ---------------------------------------------------------------------------
// Status / notification events — server → client (fire-and-forget)
// ---------------------------------------------------------------------------

export interface HostUIStatusEvent {
  sessionId: string;
  key: string;
  text: string | undefined;
}

export interface HostUIWorkingMessageEvent {
  sessionId: string;
  message: string | undefined;
}

export interface HostUINotifyEvent {
  sessionId: string;
  message: string;
  notificationType: 'info' | 'warning' | 'error';
}

export interface HostUIWidgetEvent {
  sessionId: string;
  key: string;
  lines: string[] | undefined;
}

export interface HostUIEditorTextEvent {
  sessionId: string;
  text: string;
  mode: 'set' | 'paste';
}

export interface HostUITitleEvent {
  sessionId: string;
  title: string;
}

/**
 * Union of all fire-and-forget host UI events (server → client).
 * These do not require a response.
 */
export type HostUIEvent =
  | { type: 'status'; payload: HostUIStatusEvent }
  | { type: 'working-message'; payload: HostUIWorkingMessageEvent }
  | { type: 'notify'; payload: HostUINotifyEvent }
  | { type: 'widget'; payload: HostUIWidgetEvent }
  | { type: 'editor-text'; payload: HostUIEditorTextEvent }
  | { type: 'title'; payload: HostUITitleEvent };

// ---------------------------------------------------------------------------
// Bridge emitter interface — the coordinator wires this to the protocol layer
// ---------------------------------------------------------------------------

export interface HostUIBridgeEmitter {
  /** Emit a dialog request to all watching clients. */
  emitDialogRequest(request: HostUIDialogRequest): void;
  /** Emit a fire-and-forget UI event to all watching clients. */
  emitEvent(event: HostUIEvent): void;
}

// ---------------------------------------------------------------------------
// Pending dialog tracker
// ---------------------------------------------------------------------------

interface PendingDialog<T> {
  sessionId: string;
  dialogType: HostUIDialogResponse['type'];
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function isValidDialogResponseValue(dialogType: HostUIDialogResponse['type'], value: unknown): boolean {
  switch (dialogType) {
    case 'confirm':
      return typeof value === 'boolean';
    case 'select':
    case 'input':
    case 'editor':
      return typeof value === 'string' || typeof value === 'undefined';
    default:
      return false;
  }
}


function sanitizeDialogOptions(dialogOptions?: OmpDialogOptions): HostUIDialogOptions | undefined {
  if (!dialogOptions?.helpText) return undefined;
  return { helpText: dialogOptions.helpText };
}


let dialogIdCounter = 0;
function nextDialogId(): string {
  return `dlg-${++dialogIdCounter}-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// Bridge state — manages pending dialogs and editor text per session
// ---------------------------------------------------------------------------

export class HostUIBridgeState {
  private readonly pendingDialogs = new Map<string, PendingDialog<unknown>>();
  private readonly editorTexts = new Map<string, string>();

  /**
   * Create an OmpHostUIContext implementation for a specific agent session.
   * Dialog requests flow through the emitter; fire-and-forget events likewise.
   */
  createContextForSession(sessionId: string, emitter: HostUIBridgeEmitter): OmpHostUIContext {
    return {
      select: (title, options, dialogOptions) => {
        return this.requestDialog<string | undefined>(emitter, {
          type: 'select',
          id: nextDialogId(),
          sessionId,
          title,
          options,
          dialogOptions: sanitizeDialogOptions(dialogOptions),
        });
      },

      confirm: (title, message, dialogOptions) => {
        return this.requestDialog<boolean>(emitter, {
          type: 'confirm',
          id: nextDialogId(),
          sessionId,
          title,
          message,
          dialogOptions: sanitizeDialogOptions(dialogOptions),
        });
      },

      input: (title, placeholder, dialogOptions) => {
        return this.requestDialog<string | undefined>(emitter, {
          type: 'input',
          id: nextDialogId(),
          sessionId,
          title,
          placeholder,
          dialogOptions: sanitizeDialogOptions(dialogOptions),
        });
      },

      editor: (title, prefill) => {
        return this.requestDialog<string | undefined>(emitter, {
          type: 'editor',
          id: nextDialogId(),
          sessionId,
          title,
          prefill,
        });
      },

      notify: (message, type) => {
        emitter.emitEvent({
          type: 'notify',
          payload: { sessionId, message, notificationType: type ?? 'info' },
        });
      },

      setStatus: (key, text) => {
        emitter.emitEvent({
          type: 'status',
          payload: { sessionId, key, text },
        });
      },

      setWorkingMessage: (message) => {
        emitter.emitEvent({
          type: 'working-message',
          payload: { sessionId, message },
        });
      },

      setWidget: (key, content) => {
        emitter.emitEvent({
          type: 'widget',
          payload: { sessionId, key, lines: content as string[] | undefined },
        });
      },

      setEditorText: (text) => {
        this.editorTexts.set(sessionId, text);
        emitter.emitEvent({
          type: 'editor-text',
          payload: { sessionId, text, mode: 'set' },
        });
      },

      pasteToEditor: (text) => {
        const current = this.editorTexts.get(sessionId) ?? '';
        this.editorTexts.set(sessionId, current + text);
        emitter.emitEvent({
          type: 'editor-text',
          payload: { sessionId, text, mode: 'paste' },
        });
      },

      getEditorText: () => {
        return this.editorTexts.get(sessionId) ?? '';
      },

      setTitle: (title) => {
        emitter.emitEvent({
          type: 'title',
          payload: { sessionId, title },
        });
      },
    };
  }

  /**
   * Resolve a pending dialog request with a client response.
   * Returns true if the dialog was found and resolved.
   */
  resolveDialog(response: HostUIDialogResponse): boolean {
    const pending = this.pendingDialogs.get(response.id);
    if (!pending) return false;
    this.pendingDialogs.delete(response.id);
    if (pending.dialogType !== response.type) {
      pending.reject(new Error(`Dialog type mismatch for ${response.id}: expected ${pending.dialogType}, received ${response.type}`));
      return false;
    }
    if (!isValidDialogResponseValue(pending.dialogType, response.value)) {
      pending.reject(new Error(`Dialog value mismatch for ${response.id}: invalid payload for ${pending.dialogType}`));
      return false;
    }
    pending.resolve(response.value);
    return true;
  }

  /**
   * Reject all pending dialogs (e.g., on session dispose).
   */
  rejectAllForSession(sessionId: string, reason: string): void {
    for (const [id, pending] of this.pendingDialogs) {
      if (pending.sessionId !== sessionId) continue;
      pending.reject(new Error(reason));
      this.pendingDialogs.delete(id);
    }
    this.editorTexts.delete(sessionId);
  }

  /**
   * Update the cached editor text (called from native composer on the client side).
   */
  setEditorTextFromClient(sessionId: string, text: string): void {
    this.editorTexts.set(sessionId, text);
  }

  private requestDialog<T>(emitter: HostUIBridgeEmitter, request: HostUIDialogRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pendingDialogs.set(request.id, {
        sessionId: request.sessionId,
        dialogType: request.type,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        emitter.emitDialogRequest(request);
      } catch (error) {
        this.pendingDialogs.delete(request.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
