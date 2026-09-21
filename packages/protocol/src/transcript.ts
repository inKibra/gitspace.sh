import { deserialize, serialize, wire, type InputOf } from 'result-rpc';
import { transcriptPageSchema, transcriptContentPageSchema, type TranscriptPage, type TranscriptContentPage } from '@gitspace/blocks';

export {
  TRANSCRIPT_PAGE_ROWS, TRANSCRIPT_PAGE_BYTES, TRANSCRIPT_CACHE_ROWS, TRANSCRIPT_CACHE_BYTES, TRANSCRIPT_CONTENT_CHARACTERS,
  type TranscriptRow, type TranscriptPageRequest, type TranscriptPage, type TranscriptContentRequest, type TranscriptContentPage,
} from '@gitspace/blocks';

export const TranscriptPageRequestFields = {
  generation: wire.nullable(wire.string),
  before: wire.nullable(wire.number),
  after: wire.nullable(wire.number),
  around: wire.nullable(wire.string),
  executionId: wire.optional(wire.nullable(wire.string)),
};
export const TranscriptContentRequestFields = {
  generation: wire.string,
  rowId: wire.string,
  offset: wire.number,
};
export const TranscriptPageCodec = wire.serializable(
  (value): value is TranscriptPage => transcriptPageSchema.safeParse(value).success,
  { id: 'gitspace/transcript-page/v1' },
);
export const TranscriptContentPageCodec = wire.serializable(
  (value): value is TranscriptContentPage => transcriptContentPageSchema.safeParse(value).success,
  { id: 'gitspace/transcript-content-page/v1' },
);

export const TranscriptEventCodec = wire.object({
  sessionId: wire.string,
  ordinal: wire.number,
  kind: wire.string,
  payload: wire.serializable(
    (value): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value),
    { id: 'gitspace/transcript-payload/v1' },
  ),
  createdAt: wire.date,
});
export type TranscriptEvent = InputOf<typeof TranscriptEventCodec>;

export const TranscriptChunkCodec = wire.object({
  data: wire.string,
  complete: wire.boolean,
});
export type TranscriptChunk = InputOf<typeof TranscriptChunkCodec>;

// Six-byte escapes for every UTF-16 code unit still leave room for the RPC
// envelope below its 1 MiB cap.
const CHUNK_CHARACTERS = 64 * 1024;

/** Frame one logical event without limiting or truncating its contents. */
export function* encodeTranscriptEventChunks(event: TranscriptEvent): Generator<TranscriptChunk> {
  const encoded = TranscriptEventCodec.encode(event);
  if (!encoded.ok) throw new TypeError(`Invalid transcript event: ${encoded.issues[0]?.message}`);
  // This serializes an application record, not a transport frame. Only the
  // bounded fragments below cross result-rpc's capped HTTP boundary.
  const serialized = serialize(encoded.value);
  if (!serialized.ok) throw new TypeError(`Unable to serialize transcript event: ${serialized.message}`);
  // Devalue can leave lone surrogates literal. Escape them before UTF-8 transport
  // replaces them, and never separate a valid pair across independently encoded frames.
  const text = serialized.value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    (surrogate) => `\\u${surrogate.charCodeAt(0).toString(16)}`);
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + CHUNK_CHARACTERS, text.length);
    const last = text.charCodeAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) end--;
    yield { data: text.slice(offset, end), complete: end === text.length };
    offset = end;
  }
}

/** Reassemble complete events; never expose or silently drop a partial event. */
export async function* decodeTranscriptChunks(chunks: AsyncIterable<TranscriptChunk>): AsyncGenerator<TranscriptEvent> {
  const fragments: string[] = [];
  for await (const chunk of chunks) {
    if (chunk.data.length === 0 || chunk.data.length > CHUNK_CHARACTERS) throw new TypeError('Invalid transcript fragment size');
    fragments.push(chunk.data);
    if (!chunk.complete) continue;
    const serialized = fragments.length === 1 ? fragments[0]! : fragments.join('');
    fragments.length = 0;
    const decoded = deserialize(serialized);
    if (!decoded.ok) throw new TypeError(`Unable to decode transcript event: ${decoded.message}`);
    const event = TranscriptEventCodec.decode(decoded.value);
    if (!event.ok) throw new TypeError(`Invalid transcript event: ${event.issues[0]?.message}`);
    yield event.value;
  }
  if (fragments.length !== 0) throw new TypeError('Transcript ended during an event');
}
