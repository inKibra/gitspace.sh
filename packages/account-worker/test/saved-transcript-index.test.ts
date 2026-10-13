import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { reduceTranscriptToTurns, TRANSCRIPT_CONTENT_CHARACTERS, TRANSCRIPT_CONTENT_CHUNK_CHARACTERS, TRANSCRIPT_PAGE_BYTES, TRANSCRIPT_PAGE_ROWS, type TranscriptItem } from '@gitspace/blocks';
import type { TranscriptEvent } from '@gitspace/protocol/transcript';
import { SavedTranscriptIndex } from '../src/saved-transcript-index.js';
import { SavedTranscriptIndexDO } from '../src/saved-transcript-index-do.js';

const latest = { generation: null, before: null, after: null, around: null };

function messages(count: number, text: (ordinal: number) => string): TranscriptEvent[] {
  return Array.from({ length: count }, (_, ordinal) => ({ sessionId: 'saved', ordinal: ordinal + 1, kind: 'message_end', createdAt: new Date('2026-09-01T12:00:00Z'), payload: { message: { role: ordinal % 2 === 0 ? 'user' : 'assistant', content: text(ordinal) } } }));
}

function items(events: TranscriptEvent[]): TranscriptItem[] {
  return reduceTranscriptToTurns(events).flatMap((turn) => [...(turn.user ? [turn.user] : []), ...turn.items, ...turn.sideAgents]);
}

describe('persistent saved transcript index', () => {
  it('rejects malformed cursors and offsets', async () => {
    const index = await SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, crypto.randomUUID(), ['cursor-source'], null, async () => messages(1, () => 'saved row'));
    await expect(index.page({ ...latest, before: -1 })).rejects.toThrow();
    await expect(index.page({ ...latest, after: 0.5 })).rejects.toThrow();
    await expect(index.page({ ...latest, before: 1, around: 'row' })).rejects.toThrow();
    await expect(index.content({ generation: index.generation, rowId: 'row', offset: -1 })).rejects.toThrow();
    await expect(index.content({ generation: index.generation, rowId: 'row', offset: 0.5 })).rejects.toThrow();
  });

  it('reopens durable pages in both directions and around anchors without reloading the immutable source', async () => {
    const userId = crypto.randomUUID();
    const events = messages(240, ordinal => `${ordinal}: ${'page text '.repeat(800)}`);
    const expected = items(events);
    const cold = await SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId, ['source-hash'], null, async () => events);
    const page = await cold.page(latest);
    expect(page.total).toBe(expected.length);
    expect(page.rows.map(row => row.item)).toEqual(expected.slice(-page.rows.length));
    expect(page.rows.length).toBeLessThanOrEqual(TRANSCRIPT_PAGE_ROWS);
    expect(new TextEncoder().encode(JSON.stringify(page.rows)).length).toBeLessThanOrEqual(TRANSCRIPT_PAGE_BYTES);
    const warm = await SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId, ['source-hash'], null, async () => { throw new Error('Warm reads must never load source'); });
    const older = await warm.page({ ...latest, generation: page.generation, before: page.rows[0]!.ordinal });
    expect(older.rows.map(row => row.item)).toEqual(expected.slice(older.rows[0]!.ordinal, page.rows[0]!.ordinal));
    const newer = await warm.page({ ...latest, generation: page.generation, after: older.rows.at(-1)!.ordinal });
    expect(newer.rows[0]!.id).toBe(page.rows[0]!.id);
    const centered = await warm.page({ ...latest, generation: page.generation, around: expected[100]!.id });
    expect(centered.rows.some(row => row.id === expected[100]!.id)).toBe(true);
    expect(centered.hasBefore).toBe(true);
    expect(centered.hasAfter).toBe(true);
    expect(await warm.page({ ...latest, before: 0, generation: 'stale' })).toEqual(page);
    expect(await warm.page({ ...latest, before: 0 })).toMatchObject({ rows: [], hasBefore: false, hasAfter: true });
    const owner = env.SAVED_TRANSCRIPTS.getByName(`${userId}:${page.generation}`);
    expect(await runInDurableObject(owner, (_instance, state) => new SavedTranscriptIndexDO(state, env).page(page.generation, null, latest))).toEqual(page);
  });

  it('seals derived content and returns exact oversized JSON across arbitrary UTF-16 offsets', async () => {
    const userId = crypto.randomUUID();
    const key = crypto.getRandomValues(new Uint8Array(32));
    // Exceeds SQLite's per-value limit; no full content value may be persisted.
    const events = messages(1, () => 'private transcript \u0000\\\"\ud83d\ude00'.repeat(100_000));
    const expected = items(events)[0]!;
    const full = JSON.stringify(expected);
    const index = await SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId, ['encrypted-hash'], key, async () => events);
    const page = await index.page(latest);
    expect(page.rows[0]).toMatchObject({ truncated: true, contentBytes: new TextEncoder().encode(full).length, contentRevision: 0 });
    let assembled = '';
    let offset: number | null = 0;
    while (offset !== null) {
      const part = await index.content({ generation: page.generation, rowId: expected.id, offset });
      expect(part.text.length).toBeLessThanOrEqual(TRANSCRIPT_CONTENT_CHARACTERS);
      expect(part.totalCharacters).toBe(full.length);
      assembled += part.text;
      offset = part.nextOffset;
    }
    expect(assembled).toBe(full);
    const crossingOffset = TRANSCRIPT_CONTENT_CHUNK_CHARACTERS - 1;
    const crossing = await index.content({ generation: page.generation, rowId: expected.id, offset: crossingOffset });
    expect(crossing.text).toBe(full.slice(crossingOffset, crossingOffset + TRANSCRIPT_CONTENT_CHARACTERS));
    expect(crossing.nextOffset).toBe(crossingOffset + TRANSCRIPT_CONTENT_CHARACTERS);
    expect(await index.content({ generation: page.generation, rowId: expected.id, offset: full.length })).toEqual({ text: '', offset: full.length, nextOffset: null, totalCharacters: full.length, contentRevision: 0 });
    await expect(index.content({ generation: page.generation, rowId: expected.id, offset: full.length + 1 })).rejects.toThrow('offset');
    await expect(index.content({ generation: page.generation, rowId: 'missing', offset: 0 })).rejects.toThrow('does not exist');
    await expect(SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId, ['encrypted-hash'], crypto.getRandomValues(new Uint8Array(32)), async () => events)).rejects.toThrow();
    const owner = env.SAVED_TRANSCRIPTS.getByName(`${userId}:${page.generation}`);
    const bounds = await runInDurableObject(owner, (_instance, state) => {
      const largest = state.storage.sql.exec<{ bytes: number }>('SELECT max(length(content)) AS bytes FROM content_chunks').one().bytes;
      const chunk = state.storage.sql.exec<{ content: ArrayBuffer }>('SELECT content FROM content_chunks WHERE id = ? AND position = 0', expected.id).one().content;
      const bytes = new Uint8Array(chunk);
      const exposed = new TextDecoder().decode(bytes).includes('private transcript');
      bytes[20] = bytes[20]! ^ 1;
      state.storage.sql.exec('UPDATE content_chunks SET content = ? WHERE id = ? AND position = 0', bytes.buffer, expected.id);
      return { largest, exposed };
    });
    expect(bounds.exposed).toBe(false);
    expect(bounds.largest).toBeLessThanOrEqual(TRANSCRIPT_CONTENT_CHUNK_CHARACTERS * 6 + 30);
    await expect(index.content({ generation: page.generation, rowId: expected.id, offset: 0 })).rejects.toThrow();
  });

  it('isolates users and invalidates cursors and content when source hashes change', async () => {
    const userId = crypto.randomUUID();
    const old = await SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId, ['old-hash'], null, async () => messages(1, () => 'owner history'));
    const previous = await old.page(latest);
    const stranger = await SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, crypto.randomUUID(), ['old-hash'], null, async () => messages(1, () => 'stranger history'));
    const foreign = await stranger.page(latest);
    expect(foreign.generation).not.toBe(previous.generation);
    expect(foreign.rows[0]!.item).toMatchObject({ text: 'stranger history' });
    const updated = await SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId, ['new-hash'], null, async () => messages(1, () => 'replacement history'));
    const reset = await updated.page({ ...latest, generation: previous.generation, before: 0 });
    expect(reset.generation).not.toBe(previous.generation);
    expect(reset.rows[0]!.item).toMatchObject({ text: 'replacement history' });
    await expect(updated.content({ generation: previous.generation, rowId: previous.rows[0]!.id, offset: 0 })).rejects.toThrow('generation changed');
    expect((await updated.content({ generation: reset.generation, rowId: reset.rows[0]!.id, offset: 3 })).text).toBe(JSON.stringify(reset.rows[0]!.item).slice(3));
    const empty = await SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId, ['empty-hash'], null, async () => []);
    expect(await empty.page(latest)).toMatchObject({ rows: [], total: 0, hasBefore: false, hasAfter: false });
  });

  it('discards interrupted partial builds and publishes only a complete retry', async () => {
    const userId = crypto.randomUUID();
    const events = messages(2, ordinal => `complete ${ordinal}`);
    await expect(SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId, ['retry'], null, async () => (async function* () {
      yield messages(1, () => 'uncommitted partial row')[0]!;
      throw new Error('Checkpoint read interrupted');
    })())).rejects.toThrow();
    const rebuilt = await SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId, ['retry'], null, async () => events);
    expect((await rebuilt.page(latest)).rows.map(row => row.item)).toEqual(items(events));
    const reopened = await SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId, ['retry'], null, async () => { throw new Error('Completed retry must be durable'); });
    expect(reopened.generation).toBe(rebuilt.generation);
  });

  it('serializes concurrent builds without replacing the accepted source', async () => {
    const userId = crypto.randomUUID();
    const events = messages(2, ordinal => `accepted ${ordinal}`);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const secondLoaded = Promise.withResolvers<void>();
    const first = SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId, ['concurrent'], null, async () => (async function* () {
      yield events[0]!;
      started.resolve();
      await release.promise;
      yield events[1]!;
    })());
    await started.promise;
    const second = SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId, ['concurrent'], null, async () => {
      secondLoaded.resolve();
      return messages(1, () => 'must not replace accepted source');
    });
    await secondLoaded.promise;
    release.resolve();
    const indexes = await Promise.all([first, second]);
    expect(indexes[0].generation).toBe(indexes[1].generation);
    expect((await indexes[1].page(latest)).rows.map(row => row.item)).toEqual(items(events));
  });
});

describe('saved execution history', () => {
  it('pages hidden original calls independently of the canonical card, preserving full output and turn status', async () => {
    const events: TranscriptEvent[] = [];
    const largeOutput = 'complete command output 😀\n'.repeat(20_000);
    for (let i = 0; i < 75; i++) {
      events.push({ sessionId: 'saved', ordinal: events.length + 1, kind: 'tool_execution_start', createdAt: new Date(0), payload: { toolName: 'hub', toolCallId: `wait-${i}`, args: { op: 'wait', ids: ['build'] } } });
      events.push({ sessionId: 'saved', ordinal: events.length + 1, kind: 'tool_execution_end', createdAt: new Date(i * 1000), payload: { toolCallId: `wait-${i}`, result: i === 0 ? largeOutput : `observed ${i}`, details: { op: 'wait', jobs: [{ id: 'build', type: 'bash', label: 'Build', status: i === 74 ? 'completed' : 'running' }] } } });
    }
    const userId = crypto.randomUUID();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const cold = await SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId, ['execution-history'], key, async () => events);
    const page = await cold.page(latest);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ turnStatus: 'done', item: { type: 'execution', status: 'done', historyCount: 75 } });
    const warm = await SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId, ['execution-history'], key, async () => { throw new Error('Must use indexed history'); });
    const recent = await warm.page({ ...latest, executionId: page.rows[0]!.id });
    expect(recent.total).toBe(75);
    expect(recent.hasBefore).toBe(true);
    const earlier = await warm.page({ ...latest, executionId: page.rows[0]!.id, before: recent.rows[0]!.ordinal });
    expect(earlier.hasBefore).toBe(false);
    const history = [...earlier.rows, ...recent.rows];
    expect(history.map(row => row.item.type === 'tool-call' && row.item.toolCallId)).toEqual(Array.from({ length: 75 }, (_, i) => `wait-${i}`));
    let text = '';
    let offset: number | null = 0;
    while (offset !== null) {
      const part = await warm.content({ generation: page.generation, rowId: history[0]!.id, offset });
      text += part.text;
      offset = part.nextOffset;
    }
    expect(JSON.parse(text)).toMatchObject({ result: [{ text: largeOutput }] });
    await expect(warm.page({ ...latest, executionId: 'other', around: history[0]!.id })).resolves.toMatchObject({ total: 0, rows: [] });
  });
});
