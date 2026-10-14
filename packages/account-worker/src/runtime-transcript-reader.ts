import { RuntimeTranscriptSchema, type RuntimeHistoryReadArguments } from '@gitspace/protocol-runtime';
import { Buffer } from 'node:buffer';
import type { TranscriptEvent } from '@gitspace/protocol-runtime/session-controls';

/** Internal NDJSON transport: retain at most one event, not the whole transcript.
 * Closing a bounded history read cancels its upstream stream immediately. */
export async function* readRuntimeTranscript(response: Response): AsyncGenerator<TranscriptEvent & { sessionId: string }> {
  if (!response.ok || !response.body) throw new Error(`Runtime transcript is unavailable (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const fragments: string[] = [];
  try {
    while (true) {
      const next = await reader.read();
      const chunk = decoder.decode(next.value, { stream: !next.done });
      let start = 0;
      let newline: number;
      while ((newline = chunk.indexOf('\n', start)) >= 0) {
        const last = chunk.slice(start, newline);
        const line = fragments.length ? fragments.join('') + last : last;
        fragments.length = 0;
        if (line) yield RuntimeTranscriptSchema.element.parse(JSON.parse(line));
        start = newline + 1;
      }
      if (start < chunk.length) fragments.push(chunk.slice(start));
      if (next.done) break;
    }
    const pending = fragments.join('');
    if (pending.trim()) yield RuntimeTranscriptSchema.element.parse(JSON.parse(pending));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

type HistoryContentReference = { mode: 'content'; workspaceId: string; conversationId: string; ordinal: number; contentOffset: number };
type HistoryPageItem = { type: 'event'; event: TranscriptEvent & { sessionId: string } } | { type: 'content-reference'; ordinal: number; characters: number; content: HistoryContentReference };
export type RuntimeHistoryReadResult =
  | { mode: 'page'; items: HistoryPageItem[]; nextOffset: number | null }
  | { mode: 'content'; ordinal: number; text: string; contentOffset: number; nextContentOffset: number | null; characters: number };

const HISTORY_MAX_BYTES = 64 * 1024;

/** Count the JSON-string encoding of just the requested prefix, once. Paired
 * surrogates stay together unless the caller explicitly requests a single half;
 * JSON escapes that half losslessly, preserving the UTF-16 offset contract. */
function contentEnd(text: string, offset: number, limit: number, byteBudget: number): number {
  const maximum = Math.min(text.length, offset + limit);
  let end = offset;
  let bytes = 0;
  while (end < maximum) {
    const code = text.charCodeAt(end);
    let width = 1;
    let size: number;
    if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(end + 1) >= 0xdc00 && text.charCodeAt(end + 1) <= 0xdfff) {
      if (end + 1 < maximum) {
        width = 2;
        size = 4;
      } else {
        if (end > offset) break;
        size = 6;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      size = 6;
    } else if (code === 0x22 || code === 0x5c || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
      size = 2;
    } else if (code < 0x20) {
      size = 6;
    } else {
      size = code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
    if (bytes + size > byteBudget) break;
    bytes += size;
    end += width;
  }
  return end;
}

/** Pages and content results have a 64 KiB serialized budget. Large events remain
 * completely readable through explicit UTF-16 JSON-text offsets. The caller requests
 * only the ordinal range it needs (ordinals are `entryId * 1024 + n`), so a content
 * read streams one Pi entry and a page read starts at its offset. */
export async function readRuntimeHistory(response: Response, request: RuntimeHistoryReadArguments, workspaceId: string): Promise<RuntimeHistoryReadResult> {
  const items: HistoryPageItem[] = [];
  let bytes = 128; // Reserve the page envelope and either numeric or null cursor.
  for await (const event of readRuntimeTranscript(response)) {
    if (request.mode === 'content') {
      if (event.ordinal !== request.ordinal) continue;
      const text = JSON.stringify(event);
      if (request.contentOffset > text.length) throw new Error('History content offset exceeds the event');
      const result: Extract<RuntimeHistoryReadResult, { mode: 'content' }> = { mode: 'content', ordinal: event.ordinal, text: '', contentOffset: request.contentOffset, nextContentOffset: null, characters: text.length };
      // Reserve the larger of a null cursor and any offset into this event.
      const overhead = Buffer.byteLength(JSON.stringify(result)) + Math.max(0, String(text.length).length - 4);
      const end = contentEnd(text, request.contentOffset, request.contentLimit, HISTORY_MAX_BYTES - overhead);
      result.text = text.slice(request.contentOffset, end);
      result.nextContentOffset = end < text.length ? end : null;
      return result;
    }
    if (event.ordinal < request.offset) continue;
    if (items.length >= request.limit) return { mode: 'page', items, nextOffset: event.ordinal };
    const text = JSON.stringify(event);
    const eventBytes = Buffer.byteLength(text);
    const item: HistoryPageItem = eventBytes <= 60 * 1024
      ? { type: 'event', event }
      : { type: 'content-reference', ordinal: event.ordinal, characters: text.length, content: { mode: 'content', workspaceId, conversationId: request.conversationId, ordinal: event.ordinal, contentOffset: 0 } };
    const size = (item.type === 'event' ? eventBytes + '{"type":"event","event":}'.length : Buffer.byteLength(JSON.stringify(item))) + 1;
    if (128 + size > HISTORY_MAX_BYTES) throw new Error('History content reference exceeds the response byte budget');
    if (bytes + size > HISTORY_MAX_BYTES) return { mode: 'page', items, nextOffset: event.ordinal };
    items.push(item);
    bytes += size;
  }
  if (request.mode === 'content') throw new Error('History event was not found');
  return { mode: 'page', items, nextOffset: null };
}
