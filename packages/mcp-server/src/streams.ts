import { deserialize } from 'result-rpc';
import { TranscriptEventCodec } from '@gitspace/protocol/transcript';

export type RpcResult = { status: 'ok'; value: unknown } | { status: 'error'; error: unknown };
export interface Subscription extends AsyncIterable<RpcResult> { close(): void }
export type StreamPage = {
  items: unknown[];
  nextInput: Record<string, unknown> | null;
  complete: boolean;
  reason: 'complete' | 'limit' | 'timeout' | 'resync' | 'ended';
  gap: boolean;
};
export class OperationFailure extends Error {
  constructor(readonly detail: unknown) { super('GitSpace operation failed'); }
}
export class StreamFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
export const STREAM_LIMITS = { items: 64, bytes: 1024 * 1024, waitMs: 5_000, maxWaitMs: 20_000 } as const;
const utf8 = new TextEncoder();
const timedOut = Symbol('timeout');

/** The caller closes and aborts the signed backend transport on every exit. */
export async function readLivePage(options: {
  path: string; input: Record<string, unknown>; stream: Subscription;
  encode(value: unknown): unknown; signal: AbortSignal;
}): Promise<StreamPage> {
  const { path, input, stream, encode, signal } = options;
  const items: unknown[] = [];
  let bytes = 0;
  let cursor = input.after ?? null;
  let ordinal = input.afterOrdinal;
  let reason: StreamPage['reason'] = 'limit';
  const complete = false;
  let gap = false;
  const iterator = stream[Symbol.asyncIterator]();
  let fragments: string[] = [];
  let chunks: unknown[] = [];
  let fragmentBytes = 0;
  const { promise: deadline, resolve } = Promise.withResolvers<typeof timedOut>();
  const abort = () => resolve(timedOut);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  try {
    while (items.length < STREAM_LIMITS.items) {
      const next = await Promise.race([iterator.next(), deadline]);
      if (next === timedOut) { reason = 'timeout'; break; }
      if (next.done) { reason = 'ended'; break; }
      if (next.value.status === 'error') throw new OperationFailure(next.value.error);
      const value = next.value.value as Record<string, unknown>;
      if (path === 'subagents.events') {
        if (typeof value.data !== 'string' || typeof value.complete !== 'boolean') throw new StreamFailure('INVALID_TRANSCRIPT_FRAGMENT');
        fragmentBytes += utf8.encode(value.data).byteLength;
        if (fragmentBytes > STREAM_LIMITS.bytes) throw new StreamFailure('TRANSCRIPT_EVENT_TOO_LARGE_USE_SUBAGENTS_CONTENT');
        fragments.push(value.data);
        chunks.push(encode(value));
        if (!value.complete) continue;
        const decoded = deserialize(fragments.join(''));
        if (!decoded.ok) throw new StreamFailure('INVALID_TRANSCRIPT_EVENT');
        const event = TranscriptEventCodec.decode(decoded.value);
        if (!event.ok || typeof ordinal !== 'number' || event.value.ordinal <= ordinal) throw new StreamFailure('TRANSCRIPT_CURSOR_GAP');
        const size = utf8.encode(JSON.stringify(chunks)).byteLength;
        if (size > STREAM_LIMITS.bytes) throw new StreamFailure('TRANSCRIPT_EVENT_TOO_LARGE_USE_SUBAGENTS_CONTENT');
        if (bytes + size > STREAM_LIMITS.bytes || (items.length > 0 && items.length + chunks.length > STREAM_LIMITS.items)) break;
        items.push(...chunks);
        bytes += size;
        ordinal = event.value.ordinal;
        chunks = []; fragments = []; fragmentBytes = 0;
        continue;
      }
      if (typeof value.cursor !== 'number' || !['snapshot', 'change', 'resync'].includes(String(value.type))) throw new StreamFailure('INVALID_STREAM_CURSOR');
      if (value.type === 'change' && value.previous !== cursor) throw new StreamFailure('STREAM_CURSOR_GAP');
      const encoded = encode(value);
      const size = utf8.encode(JSON.stringify(encoded)).byteLength;
      if (size > STREAM_LIMITS.bytes) throw new StreamFailure('STREAM_ITEM_TOO_LARGE');
      if (bytes + size > STREAM_LIMITS.bytes) break;
      items.push(encoded); bytes += size;
      if (value.type === 'resync') { gap = true; reason = 'resync'; cursor = null; break; }
      cursor = value.cursor;
    }
    if (reason === 'ended' && fragments.length) throw new StreamFailure('INCOMPLETE_TRANSCRIPT_EVENT');
    return { items, nextInput: complete ? null : { ...input, ...(path === 'subagents.events' ? { afterOrdinal: ordinal } : { after: cursor }) }, complete, reason, gap };
  } finally {
    signal.removeEventListener('abort', abort);
    stream.close();
    // Never await an iterator return blocked behind an uncancellable backend read.
    void iterator.return?.().catch(() => undefined);
  }
}
