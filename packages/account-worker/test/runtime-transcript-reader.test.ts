import { expect, test } from 'vitest';
import { readRuntimeTranscript, readRuntimeHistory } from '../src/runtime-transcript-reader.js';
import { RuntimeHistoryReadArgumentsSchema } from '@gitspace/protocol-runtime';

test('NDJSON transcript reader preserves large Unicode events across byte boundaries and cancels bounded reads', async () => {
  const event = { sessionId: 'pi', ordinal: 0, kind: 'legacy-note', createdAt: '2026-10-09T00:00:00.000Z', payload: { text: '\u{1D504}\n'.repeat(900_000) } };
  const encoded = new TextEncoder().encode(`${JSON.stringify(event)}\n`);
  let offset = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= encoded.length) throw new Error('Consumer read beyond requested event');
      controller.enqueue(encoded.subarray(offset, offset + 65_537));
      offset += 65_537;
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  for await (const recovered of readRuntimeTranscript(response)) {
    expect(recovered).toEqual(event);
    break;
  }
  expect(cancelled).toBe(true);
});

test('NDJSON transcript reader rejects a truncated final event instead of accepting a partial history', async () => {
  const response = new Response('{"ordinal":0,"payload":');
  await expect((async () => { for await (const _event of readRuntimeTranscript(response)) { /* Drain. */ } })()).rejects.toThrow();
});

test('history pages reference multi-megabyte escaped Unicode events and bound selected content ranges', async () => {
  const event = { sessionId: 'pi', ordinal: 0, kind: 'legacy-note', createdAt: '2026-10-09T00:00:00.000Z', payload: { text: 'preserved \\\"\u{1D504}\n'.repeat(350_000) } };
  const serialized = JSON.stringify(event);
  const encoded = new TextEncoder().encode(`${serialized}\n`);
  const response = () => {
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoded.subarray(offset, offset + 65_537));
        offset += 65_537;
        if (offset >= encoded.length) controller.close();
      },
    }, { highWaterMark: 0 }));
  };
  // The transport reader may normalize object keys. Sample against its actual
  // event representation, while checking that normalization preserves meaning.
  let content = '';
  for await (const recovered of readRuntimeTranscript(response())) {
    expect(recovered).toEqual(event);
    content = JSON.stringify(recovered);
    break;
  }
  const page = await readRuntimeHistory(response(), RuntimeHistoryReadArgumentsSchema.parse({ conversationId: 'pi' }), 'workspace');
  expect(page.mode).toBe('page');
  if (page.mode !== 'page') throw new Error('Expected page');
  expect(page.items).toEqual([{ type: 'content-reference', ordinal: 0, characters: content.length, content: { mode: 'content', workspaceId: 'workspace', conversationId: 'pi', ordinal: 0, contentOffset: 0 } }]);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65_536);
  // Exercise the real multi-megabyte path without repeatedly reparsing the whole
  // event for every range. The cases below restore complete oversized events.
  for (const contentOffset of [0, 65_536, Math.floor(content.length / 2), content.length - 100]) {
    const chunk = await readRuntimeHistory(response(), RuntimeHistoryReadArgumentsSchema.parse({ mode: 'content', conversationId: 'pi', ordinal: 0, contentOffset, contentLimit: 65_536 }), 'workspace');
    if (chunk.mode !== 'content') throw new Error('Expected content');
    expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(65_536);
    expect(chunk.contentOffset).toBe(contentOffset);
    expect(chunk.characters).toBe(content.length);
    const end = contentOffset + chunk.text.length;
    expect(end).toBeGreaterThan(contentOffset);
    expect(chunk.text.length).toBeLessThanOrEqual(65_536);
    expect(chunk.text).toBe(content.slice(contentOffset, end));
    expect(chunk.nextContentOffset).toBe(end === content.length ? null : end);
    if (chunk.nextContentOffset !== null) {
      const last = chunk.text.charCodeAt(chunk.text.length - 1);
      expect(last < 0xd800 || last > 0xdbff).toBe(true);
    }
  }
}, 30_000);

test('history byte-budget continuation starts at the first event not returned', async () => {
  const events = [0, 1, 2].map(ordinal => ({ sessionId: 'pi', ordinal, kind: 'message_end', createdAt: '2026-10-09T00:00:00.000Z', payload: { text: 'x'.repeat(40_000) } }));
  const source = events.map(event => JSON.stringify(event)).join('\n');
  const first = await readRuntimeHistory(new Response(source), RuntimeHistoryReadArgumentsSchema.parse({ conversationId: 'pi' }), 'workspace');
  expect(first).toEqual({ mode: 'page', items: [{ type: 'event', event: events[0] }], nextOffset: 1 });
  const second = await readRuntimeHistory(new Response(source), RuntimeHistoryReadArgumentsSchema.parse({ conversationId: 'pi', offset: 1 }), 'workspace');
  expect(second).toEqual({ mode: 'page', items: [{ type: 'event', event: events[1] }], nextOffset: 2 });
  const final = await readRuntimeHistory(new Response(source), RuntimeHistoryReadArgumentsSchema.parse({ conversationId: 'pi', offset: 2 }), 'workspace');
  expect(final).toEqual({ mode: 'page', items: [{ type: 'event', event: events[2] }], nextOffset: null });
  for (const page of [first, second, final]) expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65_536);
});

test.each(['\\\"\n\t\u0000', '\u00e9', '\u4e2d', '\u{1D504}', '\ud800\udc00\ud800X\udc00'])('history content budgets encoded JSON bytes for %j', async (pattern) => {
  const event = { sessionId: 'pi', ordinal: 8, kind: 'legacy-note', createdAt: '2026-10-09T00:00:00.000Z', payload: { text: pattern.repeat(40_000) } };
  const serialized = JSON.stringify(event);
  const page = await readRuntimeHistory(new Response(serialized), RuntimeHistoryReadArgumentsSchema.parse({ conversationId: 'pi' }), 'workspace');
  expect(page).toEqual({ mode: 'page', items: [{ type: 'content-reference', ordinal: 8, characters: expect.any(Number), content: { mode: 'content', workspaceId: 'workspace', conversationId: 'pi', ordinal: 8, contentOffset: 0 } }], nextOffset: null });
  if (page.mode !== 'page' || page.items[0]?.type !== 'content-reference') throw new Error('Expected content reference');
  const characters = page.items[0].characters;
  let contentOffset: number | null = 0;
  const chunks: string[] = [];
  while (contentOffset !== null) {
    const chunk = await readRuntimeHistory(new Response(serialized), RuntimeHistoryReadArgumentsSchema.parse({ mode: 'content', conversationId: 'pi', ordinal: 8, contentOffset, contentLimit: 65_536 }), 'workspace');
    if (chunk.mode !== 'content') throw new Error('Expected content');
    const wire = JSON.stringify(chunk);
    expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(65_536);
    expect(chunk.contentOffset).toBe(contentOffset);
    expect(chunk.characters).toBe(characters);
    const end = contentOffset + chunk.text.length;
    expect(end).toBeGreaterThan(contentOffset);
    expect(chunk.nextContentOffset).toBe(end === characters ? null : end);
    if (chunk.nextContentOffset !== null) {
      const last = chunk.text.charCodeAt(chunk.text.length - 1);
      expect(last < 0xd800 || last > 0xdbff).toBe(true);
    }
    chunks.push(JSON.parse(wire).text);
    contentOffset = chunk.nextContentOffset;
  }
  const recovered = chunks.join('');
  expect(recovered.length).toBe(characters);
  expect(JSON.parse(recovered)).toEqual(event);
});

test('history content respects UTF-16 offsets, small limits and EOF without losing surrogate halves', async () => {
  const event = { sessionId: 'pi', ordinal: 3, kind: 'legacy-note', createdAt: '2026-10-09T00:00:00.000Z', payload: { text: 'x\u{1D504}y' } };
  const serialized = JSON.stringify(event);
  const read = async (contentOffset: number, contentLimit: number, ordinal = 3) => {
    const result = await readRuntimeHistory(new Response(serialized), RuntimeHistoryReadArgumentsSchema.parse({ mode: 'content', conversationId: 'pi', ordinal, contentOffset, contentLimit }), 'workspace');
    if (result.mode !== 'content') throw new Error('Expected content');
    return JSON.parse(JSON.stringify(result)) as typeof result;
  };
  const complete = await read(0, 65_536);
  expect(complete.nextContentOffset).toBeNull();
  expect(JSON.parse(complete.text)).toEqual(event);
  expect(complete.characters).toBe(complete.text.length);
  const astralOffset = complete.text.indexOf('\u{1D504}');
  expect(astralOffset).toBeGreaterThan(0);
  const before = await read(astralOffset - 1, 2);
  expect(before.text).toBe('x');
  expect(before.nextContentOffset).toBe(astralOffset);
  const pair = await read(astralOffset, 2);
  expect(pair.text).toBe('\u{1D504}');
  expect(pair.nextContentOffset).toBe(astralOffset + 2);
  const high = await read(astralOffset, 1);
  const low = await read(high.nextContentOffset!, 1);
  expect(high.text).toBe('\ud835');
  expect(low.text).toBe('\udd04');
  expect(low.nextContentOffset).toBe(astralOffset + 2);
  expect(high.text + low.text).toBe(pair.text);
  expect(await read(complete.characters, 65_536)).toEqual({ mode: 'content', ordinal: 3, text: '', contentOffset: complete.characters, nextContentOffset: null, characters: complete.characters });
  await expect(read(complete.characters + 1, 1)).rejects.toThrow();
  await expect(read(0, 1, 4)).rejects.toThrow();
});

test('history page count limits continue at the next available ordinal across gaps', async () => {
  const events = [2, 9, 15].map(ordinal => ({ sessionId: 'pi', ordinal, kind: 'legacy-note', createdAt: '2026-10-09T00:00:00.000Z', payload: { text: '\u{1D504}' } }));
  const source = events.map(event => JSON.stringify(event)).join('\n');
  const first = await readRuntimeHistory(new Response(source), RuntimeHistoryReadArgumentsSchema.parse({ conversationId: 'pi', offset: 1, limit: 2 }), 'workspace');
  expect(first).toEqual({ mode: 'page', items: events.slice(0, 2).map(event => ({ type: 'event', event })), nextOffset: 15 });
  const final = await readRuntimeHistory(new Response(source), RuntimeHistoryReadArgumentsSchema.parse({ conversationId: 'pi', offset: 15, limit: 2 }), 'workspace');
  expect(final).toEqual({ mode: 'page', items: [{ type: 'event', event: events[2] }], nextOffset: null });
});
