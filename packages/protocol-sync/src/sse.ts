import type { z } from 'zod';
import { streamEventSchema, type StreamEvent } from './index.js';

/** Decode SSE data records; transport fragments never become partial domain changes. */
export async function* decodeSseChanges<T>(stream: ReadableStream<Uint8Array>, valueSchema: z.ZodType<T>, signal: AbortSignal): AsyncGenerator<StreamEvent<T>> {
  const schema = streamEventSchema(valueSchema);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const maximumFrameCharacters = 8 * 1024 * 1024;
  let pending = '';
  let data: string[] = [];
  let dataCharacters = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, boundary).replace(/\r$/u, '');
        pending = pending.slice(boundary + 1);
        if (line === '') {
          if (data.length) {
            const event = schema.parse(JSON.parse(data.join('\n')));
            data = [];
            dataCharacters = 0;
            yield event;
          }
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        if (field !== 'data') continue;
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '');
        dataCharacters += value.length + 1;
        if (dataCharacters > maximumFrameCharacters) throw new Error('Synchronization frame exceeded its size limit');
        data.push(value);
      }
      if (pending.length > maximumFrameCharacters) throw new Error('Synchronization frame exceeded its size limit');
    }
    if (!signal.aborted && (pending.length || data.length)) throw new Error('Synchronization stream ended inside a frame');
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
