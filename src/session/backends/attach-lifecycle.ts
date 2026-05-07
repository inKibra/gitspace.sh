import type { BackendEvent } from '../events.js';
import type { AttachedSessionMeta } from '../types.js';
import { findUtf8Boundary } from '../../utils/utf8.js';

function concatUint8Array(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

const MAX_REPLAY_BYTES = 1024 * 1024;

export interface BeginAttachOptions {
  workspaceId?: string | null;
  viewOnly?: boolean;
}

export interface ConfirmAttachedOptions {
  sessionId: string;
  sessionName?: string;
  workspaceId?: string | null;
  viewOnly?: boolean;
  meta?: AttachedSessionMeta | null;
}

export interface ClearAttachOptions {
  emitDetached?: boolean;
  preserveWorkspaceId?: boolean;
  preserveViewOnly?: boolean;
}

export class AttachLifecycle {
  private phase: 'browsing' | 'attaching' | 'attached' = 'browsing';
  private attachedSessionId: string | null = null;
  private attachedWorkspaceId: string | null = null;
  private viewOnly = false;
  private outputHandler: ((data: Uint8Array) => void) | null = null;
  private pendingPtyChunks: Uint8Array[] = [];
  private pendingUtf8Bytes = new Uint8Array(0);
  private replayChunks: Uint8Array[] = [];
  private replayBytes = 0;

  // Script output flows on its own channel so script bytes never leak into
  // session terminals. Separate buffer + handler, separate UTF-8 boundary state.
  private scriptOutputHandler: ((data: Uint8Array) => void) | null = null;
  private pendingScriptChunks: Uint8Array[] = [];
  private pendingScriptUtf8Bytes = new Uint8Array(0);

  private readonly emit: (event: BackendEvent) => void;

  constructor(emit: (event: BackendEvent) => void) {
    this.emit = emit;
  }
  get sessionId(): string | null {
    return this.attachedSessionId;
  }

  get workspaceId(): string | null {
    return this.attachedWorkspaceId;
  }

  get isAttached(): boolean {
    return this.phase === 'attached' && this.attachedSessionId !== null;
  }

  get isTransportActive(): boolean {
    return this.phase === 'attaching' || this.phase === 'attached';
  }

  get isAttaching(): boolean {
    return this.phase === 'attaching';
  }

  get currentViewOnly(): boolean {
    return this.viewOnly;
  }

  setOutputHandler(handler: ((data: Uint8Array) => void) | null): void {
    this.outputHandler = handler;
    if (!handler) {
      return;
    }
    if (this.replayChunks.length > 0) {
      this.replayToHandler();
      return;
    }
    if (this.pendingPtyChunks.length === 0) {
      return;
    }

    const pending = concatUint8Array(this.pendingPtyChunks);
    this.pendingPtyChunks = [];
    this.pushPtyData(pending);
  }

  setScriptOutputHandler(handler: ((data: Uint8Array) => void) | null): void {
    this.scriptOutputHandler = handler;
    if (!handler || this.pendingScriptChunks.length === 0) {
      return;
    }
    const pending = concatUint8Array(this.pendingScriptChunks);
    this.pendingScriptChunks = [];
    this.pushScriptData(pending);
  }

  beginAttach(options: BeginAttachOptions = {}): void {
    this.phase = 'attaching';
    if (Object.prototype.hasOwnProperty.call(options, 'workspaceId')) {
      this.attachedWorkspaceId = options.workspaceId ?? null;
    }
    this.viewOnly = options.viewOnly ?? false;
    this.clearPtyBuffer();
  }

  /** Update attach context (workspace, viewOnly) without clearing buffered PTY data. */
  updateAttachContext(options: BeginAttachOptions): void {
    if (Object.prototype.hasOwnProperty.call(options, 'workspaceId')) {
      this.attachedWorkspaceId = options.workspaceId ?? null;
    }
    if (typeof options.viewOnly === 'boolean') {
      this.viewOnly = options.viewOnly;
    }
  }

  confirmAttached(options: ConfirmAttachedOptions): void {
    this.phase = 'attached';
    this.attachedSessionId = options.sessionId;
    if (Object.prototype.hasOwnProperty.call(options, 'workspaceId')) {
      this.attachedWorkspaceId = options.workspaceId ?? null;
    }
    if (typeof options.viewOnly === 'boolean') {
      this.viewOnly = options.viewOnly;
    }

    this.emit({
      type: 'attached',
      sessionId: options.sessionId,
      sessionName: options.sessionName,
      viewOnly: this.viewOnly,
      workspaceId: this.attachedWorkspaceId ?? undefined,
    });

    if (options.meta) {
      this.emitSessionMeta(options.meta);
    }
  }

  emitSessionMeta(meta: AttachedSessionMeta): void {
    this.emit({ type: 'session_meta', meta });
  }

  clearAttachment(options: ClearAttachOptions = {}): void {
    const hadSession = this.attachedSessionId !== null;
    const wasAttached = this.phase === 'attached';
    this.phase = 'browsing';
    this.attachedSessionId = null;
    if (!options.preserveWorkspaceId) {
      this.attachedWorkspaceId = null;
    }
    if (!options.preserveViewOnly) {
      this.viewOnly = false;
    }
    this.clearPtyBuffer();

    if ((options.emitDetached ?? false) && (hadSession || wasAttached)) {
      this.emit({ type: 'detached' });
    }
  }

  emitExited(exitCode?: number, sessionId = this.attachedSessionId): void {
    this.phase = 'browsing';
    this.attachedSessionId = null;
    this.attachedWorkspaceId = null;
    this.viewOnly = false;
    this.clearPtyBuffer();

    if (sessionId) {
      this.emit({ type: 'session_exited', sessionId, exitCode });
    }
  }

  pushPtyData(data: Uint8Array): void {
    this.appendReplayChunk(data);
    if (!this.outputHandler) {
      this.pendingPtyChunks.push(data);
      return;
    }

    const combined = this.pendingUtf8Bytes.length
      ? concatUint8Array([this.pendingUtf8Bytes, data])
      : data;

    const boundary = findUtf8Boundary(combined);
    if (boundary < combined.length) {
      this.pendingUtf8Bytes = combined.slice(boundary);
    } else {
      this.pendingUtf8Bytes = new Uint8Array(0);
    }

    const chunk = combined.slice(0, boundary);
    if (chunk.length > 0) {
      this.outputHandler(chunk);
    }
  }

  pushScriptData(data: Uint8Array): void {
    if (!this.scriptOutputHandler) {
      this.pendingScriptChunks.push(data);
      return;
    }

    const combined = this.pendingScriptUtf8Bytes.length
      ? concatUint8Array([this.pendingScriptUtf8Bytes, data])
      : data;

    const boundary = findUtf8Boundary(combined);
    if (boundary < combined.length) {
      this.pendingScriptUtf8Bytes = combined.slice(boundary);
    } else {
      this.pendingScriptUtf8Bytes = new Uint8Array(0);
    }

    const chunk = combined.slice(0, boundary);
    if (chunk.length > 0) {
      this.scriptOutputHandler(chunk);
    }
  }

  reset(): void {
    this.phase = 'browsing';
    this.attachedSessionId = null;
    this.attachedWorkspaceId = null;
    this.viewOnly = false;
    this.clearPtyBuffer();
    this.clearScriptBuffer();
  }

  private clearPtyBuffer(): void {
    this.pendingPtyChunks = [];
    this.pendingUtf8Bytes = new Uint8Array(0);
    this.replayChunks = [];
    this.replayBytes = 0;
  }

  clearScriptBuffer(): void {
    this.pendingScriptChunks = [];
    this.pendingScriptUtf8Bytes = new Uint8Array(0);
  }

  private replayToHandler(): void {
    if (!this.outputHandler || this.replayChunks.length === 0) {
      return;
    }
    const replay = concatUint8Array(this.replayChunks);
    this.pendingPtyChunks = [];
    this.pendingUtf8Bytes = new Uint8Array(0);
    const boundary = findUtf8Boundary(replay);
    const chunk = replay.slice(0, boundary);
    this.pendingUtf8Bytes = boundary < replay.length ? replay.slice(boundary) : new Uint8Array(0);
    if (chunk.length > 0) {
      this.outputHandler(chunk);
    }
  }

  private appendReplayChunk(data: Uint8Array): void {
    if (data.length === 0) {
      return;
    }
    this.replayChunks.push(data);
    this.replayBytes += data.length;
    while (this.replayBytes > MAX_REPLAY_BYTES && this.replayChunks.length > 1) {
      const dropped = this.replayChunks.shift();
      this.replayBytes -= dropped?.length ?? 0;
    }
  }
}
