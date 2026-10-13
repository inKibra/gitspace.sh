import type { Conversation, EntryId, Storage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { readLegacyHistoryEvent } from '@gitspace/runtime-core';
import type { TranscriptEvent } from '@gitspace/protocol-runtime/session-controls';

export type RuntimeTranscriptEvent = TranscriptEvent & { sessionId: string };
export type RuntimeTranscriptFormat = 'json' | 'ndjson';

/** Pi exposes newest-first scans with inclusive numeric ID bounds. Fixed ID windows
 * keep both the scan and its chronological reversal bounded, including fork ancestry.
 * Capture the high-water mark before streaming so concurrent appends cannot extend it. */
export async function transcriptResponse(storage: Storage, target: Conversation, format: RuntimeTranscriptFormat = 'json'): Promise<Response> {
  const last = (await target.entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id;
  async function* events(): AsyncGenerator<RuntimeTranscriptEvent> {
    let ordinal = 0;
    if (last === undefined) return;
    for (let first = 0; first <= Number(last); first += 128) {
      const page = await target.entries({ minEntryId: first as EntryId, maxEntryId: Math.min(first + 127, Number(last)) as EntryId }, 128, undefined, BACKGROUND_CONTEXT);
      for (let index = page.items.length - 1; index >= 0; index--) {
        const entry = page.items[index]!;
        const legacy = await readLegacyHistoryEvent(storage, entry);
        if (legacy) yield { ...legacy, sessionId: String(target.id), ordinal: ordinal++ };
        for (const message of entry.model ?? []) yield { sessionId: String(target.id), ordinal: ordinal++, kind: 'message_end', payload: { message, entryId: String(entry.id) }, createdAt: new Date(message.timestamp).toISOString() };
      }
    }
  }
  const iterator = events();
  const encoder = new TextEncoder();
  let first = true;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          if (format === 'json') controller.enqueue(encoder.encode(first ? '[]' : ']'));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(format === 'ndjson' ? `${JSON.stringify(next.value)}\n` : `${first ? '[' : ','}${JSON.stringify(next.value)}`));
        first = false;
      } catch (error) {
        await iterator.return(undefined);
        controller.error(error);
      }
    },
    async cancel() { await iterator.return(undefined); },
  }, { highWaterMark: 0 });
  return new Response(body, { headers: { 'content-type': format === 'ndjson' ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8' } });
}
