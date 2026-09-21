import { describe, expect, it } from 'bun:test';
import { DEFAULT_MAX_WIRE_BYTES, deserialize, serialize } from 'result-rpc';
import { decodeTranscriptChunks, encodeTranscriptEventChunks, TranscriptChunkCodec, type TranscriptChunk, type TranscriptEvent } from '../src/transcript.js';

async function collect(chunks: AsyncIterable<TranscriptChunk>): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = [];
  for await (const event of decodeTranscriptChunks(chunks)) events.push(event);
  return events;
}

describe('bounded transcript framing', () => {
  it('preserves oversized events and rich Unicode values through capped wire frames', async () => {
    const events: TranscriptEvent[] = [{
      sessionId: 'session', ordinal: 1, kind: 'message_end', createdAt: new Date('2026-09-08T00:00:00Z'),
      payload: { text: '\u0000<\\"\ud800\u{20000}'.repeat(160_000), timestamp: new Date('2026-09-07T00:00:00Z'), bytes: new Uint8Array([0, 128, 255]) },
    }, {
      sessionId: 'session', ordinal: 2, kind: 'turn_end', createdAt: new Date('2026-09-08T00:00:01Z'), payload: {},
    }];
    async function* transport(): AsyncGenerator<TranscriptChunk> {
      let sequence = 0;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      for (const event of events) {
        for (const chunk of encodeTranscriptEventChunks(event)) {
          const frame = serialize({ v: 1, seq: sequence++, done: false, response: { v: 1, status: 'ok', value: chunk } }, { maxBytes: DEFAULT_MAX_WIRE_BYTES });
          if (!frame.ok) throw new Error(frame.message);
          const decoded = deserialize(decoder.decode(encoder.encode(frame.value)), { maxBytes: DEFAULT_MAX_WIRE_BYTES });
          if (!decoded.ok) throw new Error(decoded.message);
          const envelope = decoded.value;
          if (!envelope || typeof envelope !== 'object' || !('response' in envelope)) throw new TypeError('Missing response');
          const response = envelope.response;
          if (!response || typeof response !== 'object' || !('value' in response)) throw new TypeError('Missing response value');
          const received = TranscriptChunkCodec.decode(response.value);
          if (!received.ok) throw new Error(received.issues[0]?.message);
          yield received.value;
        }
      }
    }
    expect(await collect(transport())).toEqual(events);
  });

  it('rejects a stream ending inside an event instead of dropping its remainder', async () => {
    async function* truncated(): AsyncGenerator<TranscriptChunk> {
      yield { data: '[{"sessionId":', complete: false };
    }
    await expect(collect(truncated())).rejects.toBeInstanceOf(TypeError);
  });
});
