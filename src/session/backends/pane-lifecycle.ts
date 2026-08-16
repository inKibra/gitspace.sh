import type { AttachedSessionMeta } from '../types.js';
import { findUtf8Boundary } from '../../utils/utf8.js';
import { terminalMemoryDebugGauge, terminalMemoryDebugIncrement, terminalMemoryDebugMax } from '../../utils/terminal-memory-debug.js';

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

/** Bytes retained for a handler that has not mounted yet (or has remounted).
 *  This ring is the ONLY pre-handler buffer: a pane whose consumer never
 *  mounts — an agent pane, which renders the native transcript and never
 *  registers a terminal writer — must not accumulate output without bound. */
export const MAX_REPLAY_BYTES = 256 * 1024;

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
    terminalMemoryDebugIncrement(handler ? 'pane.outputHandler.set' : 'pane.outputHandler.clear');
    if (!handler) return;
    this.replayToHandler();
  }

  hasOutputHandler(): boolean {
    return this.outputHandler !== null;
  }


  pushPtyData(data: Uint8Array): void {
    this.appendReplayChunk(data);
    if (!this.outputHandler) return;

    const combined = this.pendingUtf8Bytes.length
      ? concatUint8Array([this.pendingUtf8Bytes, data])
      : data;
    const boundary = findUtf8Boundary(combined);
    this.pendingUtf8Bytes = boundary < combined.length
      ? combined.slice(boundary)
      : new Uint8Array(0);

    const chunk = combined.slice(0, boundary);
    if (chunk.length > 0) {
      terminalMemoryDebugIncrement('pane.outputHandler.write');
      this.outputHandler(chunk);
    }
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
    this.pendingUtf8Bytes = new Uint8Array(0);
    this.replayChunks = [];
    this.replayBytes = 0;
    this.outputHandler = null;
  }

  private replayToHandler(): void {
    if (!this.outputHandler || this.replayChunks.length === 0) return;
    const replay = concatUint8Array(this.replayChunks);
    this.pendingUtf8Bytes = new Uint8Array(0);
    const boundary = findUtf8Boundary(replay);
    const chunk = replay.slice(0, boundary);
    this.pendingUtf8Bytes = boundary < replay.length ? replay.slice(boundary) : new Uint8Array(0);
    if (chunk.length > 0) {
      terminalMemoryDebugIncrement('pane.replay.flush');
      this.outputHandler(chunk);
    }
  }

  private appendReplayChunk(data: Uint8Array): void {
    if (data.length === 0) return;
    let chunk = data;
    if (chunk.length > MAX_REPLAY_BYTES) {
      chunk = chunk.slice(chunk.length - MAX_REPLAY_BYTES);
      terminalMemoryDebugIncrement('pane.replayChunks.truncateLargeChunk');
    }
    this.replayChunks.push(chunk);
    this.replayBytes += chunk.length;
    terminalMemoryDebugGauge('pane.replayBytes', this.replayBytes);
    terminalMemoryDebugMax('pane.replayBytes.max', this.replayBytes);
    while (this.replayBytes > MAX_REPLAY_BYTES && this.replayChunks.length > 0) {
      const overflow = this.replayBytes - MAX_REPLAY_BYTES;
      const first = this.replayChunks[0]!;
      if (first.length <= overflow) {
        const dropped = this.replayChunks.shift();
        this.replayBytes -= dropped?.length ?? 0;
        terminalMemoryDebugIncrement('pane.replayChunks.drop');
        continue;
      }
      this.replayChunks[0] = first.slice(overflow);
      this.replayBytes -= overflow;
      terminalMemoryDebugIncrement('pane.replayChunks.trim');
      break;
    }
  }
}
