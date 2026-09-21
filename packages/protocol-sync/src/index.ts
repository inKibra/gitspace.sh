import { z } from 'zod';

export const streamCursorSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const streamInputSchema = z.object({ after: streamCursorSchema.nullable() });
export function streamEventSchema<T extends z.ZodType>(value: T) {
  const position = { resource: z.string().min(1), cursor: streamCursorSchema, revision: streamCursorSchema };
  return z.discriminatedUnion('type', [
    z.object({ type: z.literal('snapshot'), ...position, previous: z.null(), value }),
    z.object({ type: z.literal('change'), ...position, previous: streamCursorSchema, value }),
    z.object({ type: z.literal('resync'), ...position, reason: z.enum(['cursor-expired', 'cursor-ahead']) }),
  ]);
}
export type StreamEvent<T> =
  | { type: 'snapshot'; resource: string; cursor: number; revision: number; previous: null; value: T }
  | { type: 'change'; resource: string; cursor: number; revision: number; previous: number; value: T }
  | { type: 'resync'; resource: string; cursor: number; revision: number; reason: 'cursor-expired' | 'cursor-ahead' };
export interface StreamState<T> { resource: string; cursor: number | null; revision: number | null; value: T | undefined; resync: boolean }
export function initialStreamState<T>(resource: string): StreamState<T> {
  return { resource, cursor: null, revision: null, value: undefined, resync: false };
}
/** A stream's authoritative revision, never arrival time, orders updates. */
export function applyStreamEvent<T>(state: StreamState<T>, event: StreamEvent<T>): StreamState<T> {
  if (event.resource !== state.resource) throw new Error(`Unexpected stream resource: ${event.resource}`);
  if (event.type === 'resync') {
    if (event.reason === 'cursor-expired' && state.cursor !== null && (event.cursor < state.cursor || event.revision < (state.revision ?? 0))) return state;
    return { ...state, resync: true };
  }
  // A fresh authority after an explicit reset may legitimately have a lower cursor.
  if (!state.resync && state.cursor !== null && (event.cursor < state.cursor || event.revision < (state.revision ?? 0))) return state;
  if (event.type === 'change') {
    if (state.cursor !== null && event.cursor === state.cursor) return state;
    if (state.resync || state.cursor === null || event.previous !== state.cursor) return { ...state, resync: true };
  }
  if (event.type === 'snapshot' && !state.resync && event.cursor === state.cursor && event.revision === state.revision) return state;
  return { resource: state.resource, cursor: event.cursor, revision: event.revision, value: event.value, resync: false };
}

const unknownStreamEventSchema = streamEventSchema(z.unknown());
/** The DO RPC byte stream is private; result-rpc supplies the public typed SSE framing. */
export async function* decodeChangeStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<StreamEvent<unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        if (end > 8 * 1024 * 1024) throw new Error('Synchronization frame exceeded its size limit');
        const row = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (row) yield unknownStreamEventSchema.parse(JSON.parse(row));
      }
      if (pending.length > 8 * 1024 * 1024) throw new Error('Synchronization frame exceeded its size limit');
    }
    if (!signal.aborted && pending.length) throw new Error('Synchronization stream ended inside a frame');
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
