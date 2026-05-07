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

export interface ConfirmPaneAttachedOptions {
  sessionId: string;
  sessionName?: string | null;
  workspaceId?: string | null;
  agentSessionId?: string | null;
  viewOnly?: boolean;
  meta?: AttachedSessionMeta | null;
}

export class PaneLifecycle {
  readonly paneId: string;
  readonly streamId: number;
  phase: 'attaching' | 'attached' = 'attaching';
  sessionId: string | null = null;
  sessionName: string | null = null;
  workspaceId: string | null = null;
  agentSessionId: string | null = null;
  viewOnly = false;
  meta: AttachedSessionMeta | null = null;

  private outputHandler: ((data: Uint8Array) => void) | null = null;
  private pendingPtyChunks: Uint8Array[] = [];
  private pendingUtf8Bytes = new Uint8Array(0);
  private replayChunks: Uint8Array[] = [];
  private replayBytes = 0;

  constructor(options: {
    paneId: string;
    streamId: number;
    sessionId?: string | null;
    workspaceId?: string | null;
    agentSessionId?: string | null;
    viewOnly?: boolean;
  }) {
    this.paneId = options.paneId;
    this.streamId = options.streamId;
    this.sessionId = options.sessionId ?? null;
    this.workspaceId = options.workspaceId ?? null;
    this.agentSessionId = options.agentSessionId ?? null;
    this.viewOnly = options.viewOnly ?? false;
  }

  setOutputHandler(handler: ((data: Uint8Array) => void) | null): void {
    this.outputHandler = handler;
    if (!handler) return;
    if (this.replayChunks.length > 0) {
      this.replayToHandler();
      return;
    }
    if (this.pendingPtyChunks.length === 0) return;
    const pending = concatUint8Array(this.pendingPtyChunks);
    this.pendingPtyChunks = [];
    this.pushPtyData(pending);
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
    this.pendingUtf8Bytes = boundary < combined.length
      ? combined.slice(boundary)
      : new Uint8Array(0);

    const chunk = combined.slice(0, boundary);
    if (chunk.length > 0) this.outputHandler(chunk);
  }

  confirmAttached(options: ConfirmPaneAttachedOptions): void {
    this.phase = 'attached';
    this.sessionId = options.sessionId;
    this.sessionName = options.sessionName ?? null;
    if (Object.prototype.hasOwnProperty.call(options, 'workspaceId')) {
      this.workspaceId = options.workspaceId ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(options, 'agentSessionId')) {
      this.agentSessionId = options.agentSessionId ?? null;
    }
    if (typeof options.viewOnly === 'boolean') {
      this.viewOnly = options.viewOnly;
    }
    if (Object.prototype.hasOwnProperty.call(options, 'meta')) {
      this.meta = options.meta ?? null;
    }
  }

  setMeta(meta: AttachedSessionMeta): void {
    this.meta = meta;
  }

  clear(): void {
    this.phase = 'attaching';
    this.sessionId = null;
    this.sessionName = null;
    this.workspaceId = null;
    this.agentSessionId = null;
    this.viewOnly = false;
    this.meta = null;
    this.pendingPtyChunks = [];
    this.pendingUtf8Bytes = new Uint8Array(0);
    this.replayChunks = [];
    this.replayBytes = 0;
    this.outputHandler = null;
  }

  private replayToHandler(): void {
    if (!this.outputHandler || this.replayChunks.length === 0) return;
    const replay = concatUint8Array(this.replayChunks);
    this.pendingPtyChunks = [];
    this.pendingUtf8Bytes = new Uint8Array(0);
    const boundary = findUtf8Boundary(replay);
    const chunk = replay.slice(0, boundary);
    this.pendingUtf8Bytes = boundary < replay.length ? replay.slice(boundary) : new Uint8Array(0);
    if (chunk.length > 0) this.outputHandler(chunk);
  }

  private appendReplayChunk(data: Uint8Array): void {
    if (data.length === 0) return;
    this.replayChunks.push(data);
    this.replayBytes += data.length;
    while (this.replayBytes > MAX_REPLAY_BYTES && this.replayChunks.length > 1) {
      const dropped = this.replayChunks.shift();
      this.replayBytes -= dropped?.length ?? 0;
    }
  }
}
