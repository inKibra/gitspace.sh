import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { decryptArtifactBytes } from '@gitspace/protocol';
import { reduceTranscriptToTurns, TRANSCRIPT_CONTENT_CHARACTERS, TRANSCRIPT_PAGE_BYTES, TRANSCRIPT_PAGE_ROWS, type TranscriptItem } from '@gitspace/blocks';
import type { TranscriptEvent } from '@gitspace/protocol/transcript';
import { SavedTranscriptIndex } from '../src/saved-transcript-index.js';

const latest = { generation: null, before: null, after: null, around: null };

function messages(count: number, text: (ordinal: number) => string): TranscriptEvent[] {
  return Array.from({ length: count }, (_, ordinal) => ({ sessionId: 'saved', ordinal: ordinal + 1, kind: 'message_end', createdAt: new Date('2026-09-01T12:00:00Z'), payload: { message: { role: ordinal % 2 === 0 ? 'user' : 'assistant', content: text(ordinal) } } }));
}

function items(events: TranscriptEvent[]): TranscriptItem[] {
  return reduceTranscriptToTurns(events).flatMap((turn) => [...(turn.user ? [turn.user] : []), ...turn.items, ...turn.sideAgents]);
}

describe('persistent saved transcript index', () => {
  it('rejects malformed cursors before reading indexed ranges', async () => {
    const userId = crypto.randomUUID();
    await SavedTranscriptIndex.open(env.DATA, userId, ['cursor-source'], null, async () => messages(1, () => 'saved row'));
    const ranges: R2GetOptions[] = [];
    const bucket = { get: (key: string, options?: R2GetOptions) => {
      if (options?.range) ranges.push(options);
      return env.DATA.get(key, options);
    } } as unknown as R2Bucket;
    const index = await SavedTranscriptIndex.open(bucket, userId, ['cursor-source'], null, async () => { throw new Error('Already indexed'); });
    await expect(index.page({ ...latest, before: -1 })).rejects.toThrow();
    await expect(index.page({ ...latest, after: 0.5 })).rejects.toThrow();
    await expect(index.page({ ...latest, before: 1, around: 'row' })).rejects.toThrow();
    await expect(index.content({ generation: index.generation, rowId: 'row', offset: -1 })).rejects.toThrow();
    await expect(index.content({ generation: index.generation, rowId: 'row', offset: 0.5 })).rejects.toThrow();
    expect(ranges).toEqual([]);
  });

  it('reopens from R2 and pages both ways and around anchors without reloading the source or unbounded index objects', async () => {
    const userId = crypto.randomUUID();
    const events = messages(240, (ordinal) => `${ordinal}: ${'page text '.repeat(800)}`);
    const expected = items(events);
    const cold = await SavedTranscriptIndex.open(env.DATA, userId, ['source-hash'], null, async () => events);
    const page = await cold.page(latest);
    expect(page.total).toBe(expected.length);
    expect(page.rows.map((row) => row.item)).toEqual(expected.slice(-page.rows.length));
    expect(page.rows.length).toBeLessThanOrEqual(TRANSCRIPT_PAGE_ROWS);
    expect(new TextEncoder().encode(JSON.stringify(page.rows)).length).toBeLessThanOrEqual(TRANSCRIPT_PAGE_BYTES);
    const reads: { key: string; length: number; range: boolean }[] = [];
    const bucket = { get: async (key: string, options?: R2GetOptions) => {
      const object = await env.DATA.get(key, options);
      if (object && 'arrayBuffer' in object) {
        const bytes = await object.arrayBuffer();
        reads.push({ key, length: bytes.byteLength, range: Boolean(options?.range) });
        return { arrayBuffer: async () => bytes };
      }
      return object;
    } } as unknown as R2Bucket;
    const warm = await SavedTranscriptIndex.open(bucket, userId, ['source-hash'], null, async () => { throw new Error('Warm reads must never load source'); });
    const older = await warm.page({ ...latest, generation: page.generation, before: page.rows[0]!.ordinal });
    expect(older.rows.map((row) => row.item)).toEqual(expected.slice(older.rows[0]!.ordinal, page.rows[0]!.ordinal));
    const newer = await warm.page({ ...latest, generation: page.generation, after: older.rows.at(-1)!.ordinal });
    expect(newer.rows[0]!.id).toBe(page.rows[0]!.id);
    const anchor = expected[100]!;
    const centered = await warm.page({ ...latest, generation: page.generation, around: anchor.id });
    expect(centered.rows.some((row) => row.id === anchor.id)).toBe(true);
    expect(centered.hasBefore).toBe(true);
    expect(centered.hasAfter).toBe(true);
    expect(await warm.page({ ...latest, before: 0, generation: 'stale' })).toEqual(page);
    expect(await warm.page({ ...latest, before: 0 })).toMatchObject({ rows: [], hasBefore: false, hasAfter: true });
    expect(reads.filter((read) => !read.key.endsWith('/manifest')).every((read) => read.range && read.length <= TRANSCRIPT_PAGE_BYTES)).toBe(true);
  });

  it('keeps encrypted derived objects sealed and returns exact oversized JSON across arbitrary UTF-16 offsets', async () => {
    const userId = crypto.randomUUID();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const events = messages(1, () => 'private transcript \u0000\\\"\ud83d\ude00'.repeat(14_000));
    const expected = items(events)[0]!;
    const full = JSON.stringify(expected);
    const index = await SavedTranscriptIndex.open(env.DATA, userId, ['encrypted-hash'], key, async () => events);
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
    const crossingOffset = 16 * 1024 - 1;
    const crossing = await index.content({ generation: page.generation, rowId: expected.id, offset: crossingOffset });
    expect(crossing.text).toBe(full.slice(crossingOffset, crossingOffset + TRANSCRIPT_CONTENT_CHARACTERS));
    expect(crossing.nextOffset).toBe(crossingOffset + TRANSCRIPT_CONTENT_CHARACTERS);
    expect(await index.content({ generation: page.generation, rowId: expected.id, offset: full.length })).toEqual({ text: '', offset: full.length, nextOffset: null, totalCharacters: full.length, contentRevision: 0 });
    await expect(index.content({ generation: page.generation, rowId: expected.id, offset: full.length + 1 })).rejects.toThrow('offset');
    await expect(index.content({ generation: page.generation, rowId: 'missing', offset: 0 })).rejects.toThrow('does not exist');
    const prefix = `users/${userId}/transcript-index/v2/${page.generation}`;
    const manifestObject = await env.DATA.get(`${prefix}/manifest`);
    const manifestBytes = new Uint8Array(await manifestObject!.arrayBuffer());
    expect(() => JSON.parse(new TextDecoder().decode(manifestBytes))).toThrow();
    const manifest = JSON.parse(new TextDecoder().decode(await decryptArtifactBytes(manifestBytes, key))) as { build: string };
    const rowObject = await env.DATA.get(`${prefix}/${manifest.build}/rows`);
    const rowBytes = new Uint8Array(await rowObject!.arrayBuffer());
    expect(JSON.parse(new TextDecoder().decode(await decryptArtifactBytes(rowBytes, key)))).toEqual(page.rows[0]);
    const contentKey = `${prefix}/${manifest.build}/content`;
    const content = new Uint8Array(await (await env.DATA.get(contentKey))!.arrayBuffer());
    content[20] = content[20]! ^ 1;
    await env.DATA.put(contentKey, content);
    await expect(index.content({ generation: page.generation, rowId: expected.id, offset: 0 })).rejects.toThrow();
    await expect(SavedTranscriptIndex.open(env.DATA, userId, ['encrypted-hash'], crypto.getRandomValues(new Uint8Array(32)), async () => events)).rejects.toThrow();
  });


  it('isolates equal source identities by user and invalidates cursors and content when source hashes change', async () => {
    const userId = crypto.randomUUID();
    const old = await SavedTranscriptIndex.open(env.DATA, userId, ['old-hash'], null, async () => messages(1, () => 'owner history'));
    const previous = await old.page(latest);
    const stranger = await SavedTranscriptIndex.open(env.DATA, crypto.randomUUID(), ['old-hash'], null, async () => messages(1, () => 'stranger history'));
    const foreign = await stranger.page(latest);
    expect(foreign.generation).not.toBe(previous.generation);
    expect(foreign.rows[0]!.item).toMatchObject({ text: 'stranger history' });
    const updated = await SavedTranscriptIndex.open(env.DATA, userId, ['new-hash'], null, async () => messages(1, () => 'replacement history'));
    const reset = await updated.page({ ...latest, generation: previous.generation, before: 0 });
    expect(reset.generation).not.toBe(previous.generation);
    expect(reset.rows[0]!.item).toMatchObject({ text: 'replacement history' });
    await expect(updated.content({ generation: previous.generation, rowId: previous.rows[0]!.id, offset: 0 })).rejects.toThrow('generation changed');
    const content = await updated.content({ generation: reset.generation, rowId: reset.rows[0]!.id, offset: 3 });
    expect(content.text).toBe(JSON.stringify(reset.rows[0]!.item).slice(3));
    const empty = await SavedTranscriptIndex.open(env.DATA, userId, ['empty-hash'], null, async () => []);
    expect(await empty.page(latest)).toMatchObject({ rows: [], total: 0, hasBefore: false, hasAfter: false });
  });
});

describe('saved execution history', () => {
  it('ranges hidden original calls independently of the canonical card, including encrypted full output', async () => {
    const events: TranscriptEvent[] = [];
    const largeOutput = 'complete command output 😀\n'.repeat(20_000);
    for (let i = 0; i < 75; i++) {
      events.push({ sessionId: 'saved', ordinal: events.length + 1, kind: 'tool_execution_start', createdAt: new Date(0), payload: { toolName: 'hub', toolCallId: `wait-${i}`, args: { op: 'wait', ids: ['build'] } } });
      events.push({ sessionId: 'saved', ordinal: events.length + 1, kind: 'tool_execution_end', createdAt: new Date(i * 1000), payload: { toolCallId: `wait-${i}`, result: i === 0 ? largeOutput : `observed ${i}`, details: { op: 'wait', jobs: [{ id: 'build', type: 'bash', label: 'Build', status: i === 74 ? 'completed' : 'running' }] } } });
    }
    const userId = crypto.randomUUID();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const cold = await SavedTranscriptIndex.open(env.DATA, userId, ['execution-history'], key, async () => events);
    const page = await cold.page(latest);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.item).toMatchObject({ type: 'execution', status: 'done', historyCount: 75 });
    const warm = await SavedTranscriptIndex.open(env.DATA, userId, ['execution-history'], key, async () => { throw new Error('Must use indexed history'); });
    const recent = await warm.page({ ...latest, executionId: page.rows[0]!.id });
    expect(recent.total).toBe(75);
    expect(recent.hasBefore).toBe(true);
    const earlier = await warm.page({ ...latest, executionId: page.rows[0]!.id, before: recent.rows[0]!.ordinal });
    expect(earlier.hasBefore).toBe(false);
    const history = [...earlier.rows, ...recent.rows];
    expect(history.map((row) => row.item.type === 'tool-call' && row.item.toolCallId)).toEqual(Array.from({ length: 75 }, (_, i) => `wait-${i}`));
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
