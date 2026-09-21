import { afterEach, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionControlView } from '@gitspace/protocol';
import type { SessionHistoryPageRequest } from '@gitspace/protocol-agent';
import { TranscriptIndex } from '../src/transcript-index.js';
import { boundSessionControl, SESSION_HISTORY_PAGE_BYTES, SESSION_HISTORY_RAW_STEPS, pageSessionHistory, type SessionHistorySource } from '@gitspace/protocol-agent'

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
const around = (anchorId: string | null): SessionHistoryPageRequest => ({ anchorId, direction: 'around', cursor: null });
const message = (id: string, parentId: string | null, content = id, role = 'user') => ({ type: 'message', id, parentId, message: { role, content } });

async function fixture(entries: Record<string, unknown>[]) {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-session-history-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'session.jsonl');
  writeFileSync(source, [JSON.stringify({ type: 'session', version: 3, id: 'session' }), ...entries.map(entry => JSON.stringify(entry)), ''].join('\n'));
  const index = new TranscriptIndex(join(root, 'index.sqlite'), 'session');
  cleanup.push(() => index.close());
  await index.syncSourceFile(source);
  return { index, source };
}

it('keeps prompt recall bounded without silently shortening recalled messages', () => {
  const source: SessionControlView = {
    sessionId: 'session', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null,
    fastMode: false, approvalMode: 'always-ask', planMode: false, context: null, cost: 0, todos: [],
    queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null, historyAnchorId: 'entry-999',
    history: Array.from({ length: 1000 }, (_, index) => ({ entryId: `entry-${index}`, text: `Prompt ${index} ${'x'.repeat(1000)}` })),
  };
  source.history.at(-1)!.text = 'large prompt '.repeat(10_000);
  const result = boundSessionControl(source);
  expect(result.history.length).toBeLessThanOrEqual(64);
  expect(result.history.reduce((sum, entry) => sum + entry.text.length, 0)).toBeLessThanOrEqual(32 * 1024);
  expect(result.history.at(-1)).toEqual(source.history.at(-2));
  for (const entry of result.history) expect(entry.text).toBe(source.history.find(original => original.entryId === entry.entryId)!.text);
  expect(source.history.at(-1)!.text).toBe('large prompt '.repeat(10_000));
});

it('centers a deep durable chain and pages adjacent ancestry in both directions', async () => {
  const { index } = await fixture(Array.from({ length: 6000 }, (_, sequence) => message(`e${sequence}`, sequence ? `e${sequence - 1}` : null)));
  const centered = index.historyPage(around('e3000'));
  expect(centered.entries.map(entry => entry.id)).toEqual(Array.from({ length: 401 }, (_, offset) => `e${2800 + offset}`));
  expect(centered.entries.some(entry => entry.current)).toBe(false);
  const before = index.historyPage({ anchorId: centered.anchorId, direction: 'before', cursor: centered.beforeCursor });
  expect(before.entries.map(entry => entry.id)).toEqual(Array.from({ length: 200 }, (_, offset) => `e${2600 + offset}`));
  const returned = index.historyPage({ anchorId: centered.anchorId, direction: 'after', cursor: before.afterCursor });
  expect(returned.entries.map(entry => entry.id)).toEqual(Array.from({ length: 200 }, (_, offset) => `e${2800 + offset}`));
  const newest = index.historyPage(around('e5999'));
  expect(newest.entries.filter(entry => entry.current).map(entry => entry.id)).toEqual(['e5999']);
  expect(newest.afterCursor).toBeNull();
}, 30_000);

it('advances raw cursors through empty tool-only windows without exceeding the work budget', () => {
  let reads = 0;
  const last = SESSION_HISTORY_RAW_STEPS * 3;
  const source: SessionHistorySource = {
    entry: id => {
      reads++;
      const sequence = Number(id.slice(1));
      if (!Number.isInteger(sequence) || sequence < 0 || sequence > last) return null;
      return { id, parentId: sequence ? `e${sequence - 1}` : null, sequence: sequence + 1, role: sequence === 0 ? 'user' : null, preview: sequence === 0 ? 'first prompt' : '', tools: 0, childCount: sequence === last ? 0 : 1 };
    },
    children: (parentId, _sequence, _direction, limit) => {
      const sequence = parentId === null ? 0 : Number(parentId.slice(1)) + 1;
      const row = sequence <= last ? source.entry(`e${sequence}`) : null;
      return row && limit ? [row] : [];
    },
  };
  let page = pageSessionHistory(source, around(`e${last}`), `e${last}`);
  expect(page.entries.map(entry => entry.id)).toEqual([`e${last}`]);
  let emptyPages = 0;
  const seenCursors = new Set<string>();
  while (page.beforeCursor !== null) {
    expect(seenCursors.has(page.beforeCursor)).toBe(false);
    seenCursors.add(page.beforeCursor);
    reads = 0;
    page = pageSessionHistory(source, { anchorId: `e${last}`, direction: 'before', cursor: page.beforeCursor }, `e${last}`);
    expect(reads).toBeLessThanOrEqual(SESSION_HISTORY_RAW_STEPS + 4);
    if (!page.entries.length) emptyPages++;
  }
  expect(emptyPages).toBeGreaterThan(0);
  expect(page.entries.map(entry => entry.id)).toEqual(['e0']);
});

it('exposes nonmessage forks and direct choices without choosing a branch or fabricating message text', async () => {
  const { index } = await fixture([
    { type: 'model_change', id: 'root', parentId: null },
    { type: 'thinking_level_change', id: 'left', parentId: 'root' },
    message('left-message', 'left', 'Left history'),
    { type: 'custom', customType: 'metadata', id: 'right', parentId: 'root' },
    message('right-message', 'right', 'Right history'),
    message('other-root', null, 'Other root'),
  ]);
  const fork = index.historyPage(around('root'));
  expect(fork.entries).toEqual([{ id: 'root', parentId: null, sequence: 1, role: 'branch', preview: '', tools: 0, childCount: 2, current: false }]);
  expect(fork.afterCursor).toBeNull();
  const choices = index.historyPage({ anchorId: 'root', direction: 'children', cursor: null });
  expect(choices.entries.map(entry => [entry.id, entry.role, entry.preview])).toEqual([['left', 'branch', ''], ['right', 'branch', '']]);
  expect(index.historyPage(around('left')).entries.map(entry => entry.id)).toEqual(['root', 'left', 'left-message']);
  expect(index.historyPage(around('right')).entries.map(entry => entry.id)).toEqual(['root', 'right', 'right-message']);
  expect(index.historyPage({ anchorId: null, direction: 'children', cursor: null }).entries.map(entry => entry.id)).toEqual(['root', 'other-root']);
  expect(index.historyPage(around('left-message')).entries.filter(entry => entry.current)).toEqual([]);
  expect(index.historyPage(around('other-root'), null).entries.some(entry => entry.current)).toBe(false);
});

it('paginates all root and sibling choices bidirectionally', async () => {
  const { index } = await fixture([
    ...Array.from({ length: 450 }, (_, sequence) => message(`root${sequence}`, null)),
    ...Array.from({ length: 450 }, (_, sequence) => ({ type: 'model_change', id: `child${sequence}`, parentId: 'root0' })),
  ]);
  for (const anchorId of [null, 'root0']) {
    const first = index.historyPage({ anchorId, direction: 'children', cursor: null });
    const second = index.historyPage({ anchorId, direction: 'children', cursor: first.afterCursor });
    const third = index.historyPage({ anchorId, direction: 'children', cursor: second.afterCursor });
    const prefix = anchorId === null ? 'root' : 'child';
    expect([...first.entries, ...second.entries, ...third.entries].map(entry => entry.id)).toEqual(Array.from({ length: 450 }, (_, sequence) => `${prefix}${sequence}`));
    expect(third.afterCursor).toBeNull();
    expect(index.historyPage({ anchorId, direction: 'children', cursor: second.beforeCursor }).entries).toEqual(first.entries);
  }
});

it('keeps an anchored window stable after appending and leaves the live projection untouched', async () => {
  const { index, source } = await fixture(Array.from({ length: 1000 }, (_, sequence) => message(`e${sequence}`, sequence ? `e${sequence - 1}` : null)));
  index.append('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'Still streaming' }] } });
  index.append('tool_execution_start', { toolCallId: 'pending', toolName: 'bash', args: { command: 'sleep 5' } });
  const transcript = index.page({ generation: null, before: null, after: null, around: null });
  const before = index.historyPage(around('e300'));
  appendFileSync(source, `${JSON.stringify(message('appended', 'e999'))}\n`);
  await index.syncSourceFile(source);
  expect(index.historyPage(around('e300'))).toEqual(before);
  expect(index.page({ generation: null, before: null, after: null, around: null })).toEqual(transcript);
  expect(index.historyPage(around('appended')).entries.at(-1)).toMatchObject({ id: 'appended', current: true });
});

it('bounds multibyte responses and keeps oversized prompts reachable across byte cutoffs', async () => {
  const content = '\u{1f600}'.repeat(5000);
  const { index } = await fixture(Array.from({ length: 500 }, (_, sequence) => message(`e${sequence}`, sequence ? `e${sequence - 1}` : null, content)));
  let page = index.historyPage(around('e0'));
  const reached = page.entries.map(entry => entry.id);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(SESSION_HISTORY_PAGE_BYTES);
  expect(page.entries.length).toBeLessThan(201);
  while (page.afterCursor !== null) {
    page = index.historyPage({ anchorId: 'e0', direction: 'after', cursor: page.afterCursor });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(SESSION_HISTORY_PAGE_BYTES);
    reached.push(...page.entries.map(entry => entry.id));
  }
  expect(reached).toEqual(Array.from({ length: 500 }, (_, sequence) => `e${sequence}`));
});

it('handles empty history and rejects malformed or mismatched cursors without changing scope', async () => {
  const { index } = await fixture([]);
  expect(index.historyPage(around(null))).toEqual({ entries: [], anchorId: null, beforeCursor: null, afterCursor: null });
  for (const cursor of ['', '{}', 'null', 'not-json']) {
    expect(() => index.historyPage({ anchorId: null, direction: 'after', cursor })).toThrow('Invalid session history cursor');
  }
  expect(() => index.historyPage({ anchorId: null, direction: 'before', cursor: null })).toThrow('cursor is required');
  expect(() => index.historyPage(around('missing'))).toThrow('anchor is unavailable');
  const populated = await fixture(Array.from({ length: 500 }, (_, sequence) => message(`e${sequence}`, sequence ? `e${sequence - 1}` : null)));
  const page = populated.index.historyPage(around('e0'));
  expect(() => populated.index.historyPage({ anchorId: 'e1', direction: 'after', cursor: page.afterCursor })).toThrow('Invalid session history cursor');
  expect(() => populated.index.historyPage({ anchorId: 'e0', direction: 'before', cursor: page.afterCursor })).toThrow('Invalid session history cursor');
});
