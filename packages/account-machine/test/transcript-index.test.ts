import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TRANSCRIPT_CONTENT_CHARACTERS, transcriptPageSchema, type TranscriptItem, type TranscriptPageRequest } from '@gitspace/blocks';
import { TranscriptIndex } from '../src/transcript-index.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
const latest: TranscriptPageRequest = { generation: null, before: null, after: null, around: null };

function fixture(prepare?: (path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-transcript-index-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'index.sqlite');
  prepare?.(path);
  const index = new TranscriptIndex(path, 'session');
  cleanup.push(() => index.close());
  return { root, path, index };
}

function fullItem(index: TranscriptIndex, rowId: string): TranscriptItem {
  let offset: number | null = 0;
  let text = '';
  while (offset !== null) {
    const page = index.content({ generation: index.generation, rowId, offset });
    expect(page.text.length).toBeLessThanOrEqual(TRANSCRIPT_CONTENT_CHARACTERS);
    text += page.text;
    offset = page.nextOffset;
  }
  return JSON.parse(text) as TranscriptItem;
}

describe('durable transcript index', () => {
  it('keeps immutable source events lossless even when their kinds name live updates', () => {
    const { index } = fixture();
    const createdAt = '2026-01-01T00:00:00.000Z';
    const events = [
      { ordinal: 1, kind: 'message_update', payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } }, createdAt },
      { ordinal: 2, kind: 'message_update', payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'larger partial' }] } }, createdAt },
      { ordinal: 3, kind: 'message_end', payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'complete' }] } }, createdAt },
    ];
    index.seed(events);
    expect(index.snapshot()).toEqual(events);
    expect(index.page(latest).rows[0]!.item).toMatchObject({ type: 'message', text: 'complete', pending: false });
  });

  it('pages every individual block in one long turn and finalizes an old tool without moving its row', () => {
    const { index } = fixture();
    index.append('turn_start', {});
    for (let tool = 0; tool < 170; tool++) {
      index.append('tool_execution_start', { toolCallId: `tool-${tool}`, toolName: 'bash', args: { command: `echo ${tool}` } });
    }
    const end = index.page(latest);
    expect(end.rows.map((row) => row.ordinal)).toEqual(Array.from({ length: 64 }, (_, ordinal) => ordinal + 107));
    expect(end).toMatchObject({ total: 170, hasBefore: true, hasAfter: false });
    const seen = [...end.rows];
    let window = end;
    while (window.hasBefore) {
      window = index.page({ ...latest, generation: end.generation, before: window.rows[0]!.ordinal });
      transcriptPageSchema.parse(window);
      seen.unshift(...window.rows);
    }
    expect(seen.map((row) => row.ordinal)).toEqual(Array.from({ length: 170 }, (_, ordinal) => ordinal + 1));
    expect(new Set(seen.map((row) => row.id)).size).toBe(170);
    expect(index.page({ ...latest, after: 64 }).rows[0]!.ordinal).toBe(65);
    const old = seen[0]!;
    const result = 'historical output\u0000😀'.repeat(20_000);
    index.append('tool_execution_end', { toolCallId: 'tool-0', result, isError: false, details: { full: result } });
    const refreshed = index.page({ ...latest, generation: end.generation, around: old.id });
    transcriptPageSchema.parse(refreshed);
    expect(refreshed.revision).toBeGreaterThan(end.revision);
    expect(refreshed.rows[0]).toMatchObject({ id: old.id, ordinal: old.ordinal, truncated: true, item: { status: 'done' } });
    expect(Buffer.byteLength(JSON.stringify(refreshed.rows))).toBeLessThanOrEqual(96 * 1024);
    expect(fullItem(index, old.id)).toMatchObject({ type: 'tool-call', status: 'done', details: { full: result }, result: [{ text: result }] });
    expect(index.page(latest).rows.map((row) => row.id)).toEqual(end.rows.map((row) => row.id));
  });

  it('preserves a streaming message identity on finalization and after a durable reopen', () => {
    const { index, path } = fixture();
    index.append('turn_start', {});
    index.append('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'hel' }] } });
    const streaming = index.page(latest).rows[0]!;
    index.append('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } });
    index.append('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } });
    const finalized = index.page(latest);
    expect(finalized.rows).toHaveLength(1);
    expect(finalized.rows[0]).toMatchObject({ id: streaming.id, ordinal: streaming.ordinal, item: { text: 'hello', pending: false } });
    expect(index.snapshot().map((event) => event.kind)).toEqual(['turn_start', 'message_end']);
    const reopened = new TranscriptIndex(path, 'session');
    cleanup.push(() => reopened.close());
    expect(reopened.page(latest)).toEqual(finalized);
    reopened.append('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } });
    reopened.append('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'second complete' }] } });
    const messages = reopened.page(latest).rows;
    expect(messages.map((row) => row.item.type === 'message' ? row.item.text : null)).toEqual(['hello', 'second complete']);
    expect(messages[0]!.id).toBe(streaming.id);
    expect(messages[1]!.id).not.toBe(streaming.id);
  });

  it('keeps late message parts in place and unresolved tool status correct when resuming a coalesced journal', () => {
    const { index, path } = fixture();
    index.append('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } });
    index.append('tool_execution_start', { toolCallId: 'one', toolName: 'bash', args: {} });
    index.append('tool_execution_start', { toolCallId: 'two', toolName: 'bash', args: {} });
    const message = { role: 'assistant', content: [{ type: 'text', text: 'first' }, { type: 'thinking', thinking: 'late part' }] };
    index.append('message_update', { message });
    index.append('message_end', { message });
    const original = index.page(latest);
    expect(original.rows.map((row) => row.item.type)).toEqual(['message', 'tool-call', 'tool-call', 'thinking']);
    const reopened = new TranscriptIndex(path, 'session');
    cleanup.push(() => reopened.close());
    reopened.append('tool_execution_end', { toolCallId: 'one', result: 'complete', isError: false });
    const remaining = reopened.page(latest);
    expect(remaining.rows.map(({ id, ordinal }) => ({ id, ordinal }))).toEqual(original.rows.map(({ id, ordinal }) => ({ id, ordinal })));
    expect(remaining.rows.every((row) => row.turnStatus === 'running')).toBe(true);
    reopened.append('tool_execution_end', { toolCallId: 'two', result: 'complete', isError: false });
    expect(reopened.page(latest).rows.every((row) => row.turnStatus === 'done')).toBe(true);
  });

  it('resets old cursors on reseed and refuses content from another generation or row', () => {
    const { index } = fixture();
    index.append('message_end', { message: { role: 'user', content: 'old branch' } });
    const old = index.page(latest);
    index.seed([{ ordinal: 1, kind: 'message_end', payload: { message: { role: 'user', content: 'new branch' } }, createdAt: '2026-01-01T00:00:00.000Z' }]);
    const reset = index.page({ ...latest, generation: old.generation, before: 0 });
    expect(reset.generation).not.toBe(old.generation);
    expect(reset.rows[0]!.item).toMatchObject({ text: 'new branch' });
    expect(() => index.content({ generation: old.generation, rowId: old.rows[0]!.id, offset: 0 })).toThrow();
    expect(() => index.content({ generation: reset.generation, rowId: 'missing', offset: 0 })).toThrow();
    expect(() => index.page({ ...latest, before: 1, after: 2 })).toThrow();
    expect(() => index.page({ ...latest, before: -1 })).toThrow();
    expect(() => index.content({ generation: reset.generation, rowId: reset.rows[0]!.id, offset: -1 })).toThrow();
    index.seed([]);
    expect(index.page(latest)).toMatchObject({ rows: [], total: 0, hasBefore: false, hasAfter: false });
  });

  it('indexes appended JSONL once, waits for complete records, and resets a branch without retaining abandoned rows', async () => {
    const { root, index } = fixture();
    const source = join(root, 'session.jsonl');
    const header = JSON.stringify({ type: 'session', version: 3, id: 'omp-session' });
    const message = (id: string, parentId: string | null, text: string) => JSON.stringify({
      type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: text },
    });
    writeFileSync(source, `${header}\r\n${message('one', null, 'first')}\r\n${message('two', 'one', 'abandoned')}\r\n`);
    await index.syncFile(source);
    const original = index.page(latest);
    await index.syncFile(source);
    expect(index.page(latest)).toEqual(original);
    const appended = message('three', 'two', 'appended');
    appendFileSync(source, appended.slice(0, 40));
    await index.syncFile(source);
    expect(index.page(latest)).toEqual(original);
    appendFileSync(source, `${appended.slice(40)}\n`);
    await index.syncFile(source);
    const growing = index.page(latest);
    expect(growing.generation).toBe(original.generation);
    expect(growing.rows.slice(0, 2)).toEqual(original.rows);
    expect(growing.rows[2]!.item).toMatchObject({ text: 'appended' });
    appendFileSync(source, `${message('fork', 'one', 'new branch')}\n`);
    await index.syncFile(source);
    const branch = index.page({ ...latest, generation: growing.generation, before: 1 });
    expect(branch.generation).not.toBe(growing.generation);
    expect(branch.rows.map((row) => row.item.type === 'message' ? row.item.text : null)).toEqual(['first', 'new branch']);
    expect(() => index.content({ generation: growing.generation, rowId: growing.rows[2]!.id, offset: 0 })).toThrow();
    index.navigateBranch('one');
    const navigated = index.page(latest);
    expect(navigated.generation).not.toBe(branch.generation);
    expect(navigated.rows.map((row) => row.item.type === 'message' ? row.item.text : null)).toEqual(['first']);
    await index.syncFile(source);
    expect(index.page(latest)).toEqual(navigated);
    await index.syncFile(source, true);
    const readopted = index.page(latest);
    expect(readopted.generation).not.toBe(navigated.generation);
    expect(readopted.rows.map((row) => row.item.type === 'message' ? row.item.text : null)).toEqual(['first', 'new branch']);
    writeFileSync(source, `${header}\n${message('replacement', null, 'replacement')}\n`);
    await index.syncFile(source);
    expect(index.page(latest).generation).not.toBe(branch.generation);
    expect(index.page(latest).rows[0]!.item).toMatchObject({ text: 'replacement' });
  });

  it('upgrades source navigation metadata without losing a live tail and preserves an explicitly empty branch', async () => {
    const { root, index } = fixture((path) => {
      const old = new Database(path);
      old.exec('CREATE TABLE source_entries (id TEXT PRIMARY KEY, parentId TEXT, sequence INTEGER NOT NULL UNIQUE, event TEXT)');
      old.query('INSERT INTO source_entries VALUES (?, ?, ?, ?)').run('stale', null, 1, null);
      old.close();
    });
    const source = join(root, 'session.jsonl');
    const entries = [
      { type: 'session', version: 3, id: 'session' },
      { type: 'message', id: 'one', parentId: null, message: { role: 'user', content: 'first' } },
      { type: 'model_change', id: 'fork', parentId: 'one' },
      { type: 'message', id: 'left', parentId: 'fork', message: { role: 'user', content: 'left branch' } },
      { type: 'message', id: 'right', parentId: 'fork', message: { role: 'user', content: 'right branch' } },
    ];
    writeFileSync(source, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
    index.append('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'pending text' }] } });
    const pending = index.page(latest);
    await index.syncSourceFile(source);
    expect(index.page(latest)).toEqual(pending);
    expect(index.historyPage({ anchorId: 'fork', direction: 'children', cursor: null }).entries.map(entry => entry.id)).toEqual(['left', 'right']);
    index.navigateBranch('left');
    const left = index.page(latest);
    await index.syncSourceFile(source);
    expect(index.page(latest)).toEqual(left);
    expect(index.historyPage({ anchorId: 'left', direction: 'around', cursor: null }).entries.filter(entry => entry.current).map(entry => entry.id)).toEqual(['left']);
    expect(left.rows.map(row => row.item.type === 'message' ? row.item.text : null)).toEqual(['first', 'left branch']);
    index.navigateBranch(null);
    const empty = index.page(latest);
    expect(empty.rows).toEqual([]);
    await index.syncSourceFile(source);
    expect(index.page(latest)).toEqual(empty);
    expect(index.historyPage({ anchorId: 'right', direction: 'around', cursor: null }).entries.some(entry => entry.current)).toBe(false);
    expect(index.historyPage({ anchorId: 'fork', direction: 'children', cursor: null }, null).entries.map(entry => entry.id)).toEqual(['left', 'right']);
    appendFileSync(source, `${JSON.stringify({ type: 'message', id: 'reset', parentId: null, message: { role: 'user', content: 'new root' } })}\n`);
    await index.syncSourceFile(source);
    expect(index.page(latest)).toEqual(empty);
    expect(index.historyPage({ anchorId: null, direction: 'children', cursor: null }, null).entries.map(entry => entry.id)).toEqual(['one', 'reset']);
  });

  it('keeps projection ingestion independent from history sync while a tool is pending', async () => {
    const { root, index } = fixture();
    const source = join(root, 'session.jsonl');
    writeFileSync(source, [
      { type: 'session', version: 3, id: 'session' },
      { type: 'message', id: 'user', parentId: null, message: { role: 'user', content: 'run command' } },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    await index.syncFile(source);
    index.append('tool_execution_start', { toolCallId: 'pending', toolName: 'bash', args: { command: 'build' } });
    index.append('tool_execution_update', { toolCallId: 'pending', partialResult: 'working' });
    const pending = index.page(latest);
    const tool = pending.rows.find(row => row.item.type === 'tool-call')!;
    appendFileSync(source, `${JSON.stringify({
      type: 'custom', customType: 'tool_execution_end', id: 'result', parentId: 'user',
      data: { toolCallId: 'pending', result: 'finished', isError: false },
    })}\n`);
    await index.syncSourceFile(source);
    expect(index.page(latest)).toEqual(pending);
    await index.syncFile(source);
    const completed = index.page(latest);
    expect(completed.generation).toBe(pending.generation);
    expect(completed.rows.map(row => row.id)).toEqual(pending.rows.map(row => row.id));
    expect(fullItem(index, tool.id)).toMatchObject({ type: 'tool-call', status: 'done', result: [{ text: 'finished' }] });
    expect(index.snapshot().some(event => event.kind === 'tool_execution_update')).toBe(false);
    await index.syncFile(source);
    expect(index.page(latest)).toEqual(completed);
  });

  it('serves exact arbitrary UTF-16 slices of oversized serialized items across surrogate boundaries', () => {
    const { index } = fixture();
    const item: TranscriptItem = { id: 'unicode', type: 'message', role: 'assistant', text: '\u0000"\\😀'.repeat(30_000) };
    index.write('turn', item);
    const serialized = JSON.stringify(item);
    const offset = 16 * 1024 - 3;
    expect(index.content({ generation: index.generation, rowId: item.id, offset }).text).toBe(serialized.slice(offset, offset + TRANSCRIPT_CONTENT_CHARACTERS));
    expect(fullItem(index, item.id)).toEqual(item);
    expect(index.content({ generation: index.generation, rowId: item.id, offset: serialized.length })).toEqual({ text: '', offset: serialized.length, nextOffset: null, totalCharacters: serialized.length, contentRevision: 1 });
  });

});

describe('correlated execution history', () => {
  it('keeps one stable card while paging every original observation across turns and reopen', () => {
    const { index, path } = fixture();
    for (let i = 0; i < 90; i++) {
      index.append('turn_start', {});
      index.append('tool_execution_start', { toolCallId: `wait-${i}`, toolName: 'hub', args: { op: 'wait', ids: ['build-job'] } });
      index.append('tool_execution_end', {
        toolCallId: `wait-${i}`, result: `observation ${i}`, isError: false,
        details: { op: 'wait', jobs: [{ id: 'build-job', type: 'bash', label: 'Build workspace', status: i === 89 ? 'completed' : 'running', durationMs: i * 1000 }] },
      });
      index.append('turn_end', {});
    }
    const page = index.page(latest);
    expect(page.total).toBe(1);
    expect(page.rows).toHaveLength(1);
    const card = page.rows[0]!;
    expect(card.item).toMatchObject({ type: 'execution', kind: 'job', status: 'done', historyCount: 90 });
    const history = index.page({ ...latest, executionId: card.id });
    expect(history.total).toBe(90);
    expect(history.hasBefore).toBe(true);
    expect(history.hasAfter).toBe(false);
    const earlier = index.page({ ...latest, executionId: card.id, before: history.rows[0]!.ordinal });
    expect(earlier.hasBefore).toBe(false);
    expect(earlier.hasAfter).toBe(true);
    const original = [...earlier.rows, ...history.rows];
    expect(original.map((row) => row.item.type === 'tool-call' && row.item.toolCallId)).toEqual(Array.from({ length: 90 }, (_, i) => `wait-${i}`));
    const reopened = new TranscriptIndex(path, 'session');
    cleanup.push(() => reopened.close());
    expect(reopened.page(latest)).toEqual(page);
    reopened.append('turn_start', {});
    reopened.append('tool_execution_start', { toolCallId: 'repeat', toolName: 'hub', args: { op: 'jobs' } });
    reopened.append('tool_execution_end', { toolCallId: 'repeat', result: 'settled', details: { op: 'jobs', jobs: [{ id: 'build-job', type: 'bash', label: 'Build workspace', status: 'completed', durationMs: 89000 }] } });
    expect(reopened.page(latest).rows[0]).toMatchObject({ id: card.id, ordinal: card.ordinal, turnId: card.turnId, item: { historyCount: 91, status: 'done' } });
    expect(reopened.page({ ...latest, executionId: card.id }).total).toBe(91);
    expect(fullItem(reopened, original[0]!.id)).toMatchObject({ type: 'tool-call', result: [{ text: 'observation 0' }] });
    expect(reopened.page({ ...latest, executionId: 'not-this-execution' })).toMatchObject({ rows: [], total: 0, hasBefore: false, hasAfter: false });
  });

  it('keeps reused job IDs separate across reopen and late updates to an older launch', () => {
    const { index, path } = fixture();
    const launch = (target: TranscriptIndex, call: string) => {
      target.append('tool_execution_start', { toolCallId: call, toolName: 'bash', args: { command: 'same command' } });
      target.append('tool_execution_end', { toolCallId: call, result: 'backgrounded', details: { async: { state: 'running', jobId: 'bg_5', type: 'bash' } } });
    };
    const observe = (target: TranscriptIndex, call: string, status: string) => {
      target.append('tool_execution_start', { toolCallId: call, toolName: 'hub', args: { op: 'wait', ids: ['bg_5'] } });
      target.append('tool_execution_end', { toolCallId: call, result: status, details: { op: 'wait', jobs: [{ id: 'bg_5', type: 'bash', status, label: 'same command' }] } });
    };
    launch(index, 'first-launch');
    observe(index, 'first-wait', 'failed');
    const first = index.page(latest).rows.find(row => row.item.type === 'execution')!;
    launch(index, 'second-launch');
    const reopened = new TranscriptIndex(path, 'session');
    cleanup.push(() => reopened.close());
    observe(reopened, 'second-wait', 'completed');
    reopened.append('tool_execution_end', { toolCallId: 'first-launch', result: 'backgrounded', details: { async: { state: 'running', jobId: 'bg_5', type: 'bash' } } });
    observe(reopened, 'repeat-second-wait', 'completed');
    const cards = reopened.page(latest).rows.filter(row => row.item.type === 'execution');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ id: first.id, ordinal: first.ordinal, item: { status: 'failed', historyCount: 2 } });
    expect(cards[1]!.item).toMatchObject({ status: 'done', historyCount: 3 });
    expect(reopened.page({ ...latest, executionId: cards[1]!.id }).rows.map(row => row.item.type === 'tool-call' && row.item.toolCallId))
      .toEqual(['second-launch', 'second-wait', 'repeat-second-wait']);
  });

  it('rebuilds old disk projections without losing source history or reusing stale cursors', () => {
    const { index, path } = fixture();
    index.append('tool_execution_start', { toolCallId: 'wait', toolName: 'hub', args: { op: 'wait' } });
    index.append('tool_execution_end', { toolCallId: 'wait', result: 'running', details: { op: 'wait', jobs: [{ id: 'job', type: 'bash', status: 'running', label: 'Build' }] } });
    const original = index.snapshot();
    const oldGeneration = index.generation;
    const database = new Database(path);
    database.run("DELETE FROM metadata WHERE key = 'projectionVersion'");
    database.close();
    const reopened = new TranscriptIndex(path, 'session');
    cleanup.push(() => reopened.close());
    expect(reopened.generation).not.toBe(oldGeneration);
    expect(reopened.snapshot()).toEqual(original);
    const page = reopened.page({ ...latest, generation: oldGeneration, before: 0 });
    expect(page.rows.map((row) => row.item.type)).toEqual(['execution']);
    expect(page.rows[0]!.item).toMatchObject({ historyCount: 1 });
    expect(reopened.page({ ...latest, executionId: page.rows[0]!.id }).rows[0]!.item).toMatchObject({ type: 'tool-call', result: [{ text: 'running' }] });
  });
});
