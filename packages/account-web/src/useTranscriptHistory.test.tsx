// @vitest-environment happy-dom
import { TRANSCRIPT_CACHE_BYTES, TRANSCRIPT_CACHE_ROWS, type TranscriptContentPage, type TranscriptPage, type TranscriptPageRequest, type TranscriptRow } from '@gitspace/blocks';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verticalSliceFixture } from './App.js';
import { GitSpaceShell } from './GitSpaceShell.js';
import { EMPTY_TRANSCRIPT_CACHE, mergeTranscriptPage } from './transcriptHistoryCache.js';
import { useTranscriptHistory, type TranscriptHistory, type TranscriptHistorySource } from './useTranscriptHistory.js';
import { TranscriptContentCache } from './transcriptContentCache.js';

function row(ordinal: number, text = `Message ${ordinal}`): TranscriptRow {
  return {
    id: `row-${ordinal}`, ordinal, turnId: 'turn-a', turnStatus: 'done',
    item: { id: `row-${ordinal}`, type: 'message', role: 'assistant', text },
    truncated: false, contentBytes: text.length,
  };
}

function page(rows: TranscriptRow[], options: Partial<Omit<TranscriptPage, 'rows'>> = {}): TranscriptPage {
  return { generation: 'generation-a', revision: 0, hasBefore: false, hasAfter: false, total: rows.length, ...options, rows };
}

interface ControlledPage {
  promise: Promise<TranscriptPage>;
  finish(error?: Error): void;
}

function controlledPage(value: TranscriptPage): ControlledPage {
  const completion = Promise.withResolvers<TranscriptPage>();
  return { promise: completion.promise, finish(error?: Error) { if (error) completion.reject(error); else completion.resolve(value); } };
}

function sourceFor(key: string, ...loads: ControlledPage[]) {
  const signals: AbortSignal[] = [];
  const requests: TranscriptPageRequest[] = [];
  const source: TranscriptHistorySource = {
    key,
    revision: 0,
    page(request, signal) {
      const load = loads[signals.length];
      signals.push(signal);
      requests.push(request);
      if (!load) throw new Error('Unexpected extra transcript load');
      // Deliberately ignores cancellation, as a transport can settle after abort.
      return load.promise;
    },
    async content() { throw new Error('Unexpected content request'); },
  };
  return { source, signals, requests };
}

let root: Root;
let container: HTMLDivElement;
let history: TranscriptHistory;
let animationDescriptor: PropertyDescriptor | undefined;

function Probe({ source, shell = false }: { source: TranscriptHistorySource | null; shell?: boolean }) {
  history = useTranscriptHistory(source);
  if (shell) return <GitSpaceShell {...verticalSliceFixture} turns={[]} transcript={history} transport={[]}
    history={{ loading: history.initialLoading || (history.loading && history.error !== null), error: history.error, onRetry: history.refresh }}
    renderInspector={() => <p>Repository files are available</p>} />;
  return <output>{history.rows.map(({ item }) => item.type === 'message' ? item.text : null).filter(Boolean).join('|')}</output>;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('finishes in-flight pages under repeated invalidation and publishes updated rows without duplicates', async () => {
  const first = controlledPage(page([row(1, 'question'), row(2, 'partial')]));
  const second = controlledPage(page([row(1, 'question'), row(2, 'final'), row(3, 'reply')], { revision: 1 }));
  const { source, signals } = sourceFor('running:workspace-a:session-a', first, second);
  await act(() => root.render(<Probe source={source} />));
  expect(history.initialLoading).toBe(true);
  for (let revision = 1; revision <= 5; revision++) {
    await act(() => root.render(<Probe source={{ ...source, revision }} />));
  }
  await act(() => { history.refresh(); history.refresh(); });
  expect(signals[0]?.aborted).toBe(false);
  await act(() => first.finish());
  expect(container.textContent).toBe('question|partial');
  expect(history.loading).toBe(true);
  expect(history.initialLoading).toBe(false);
  await act(() => second.finish());
  expect(container.textContent).toBe('question|final|reply');
  expect(history.loading).toBe(false);
  expect(history.error).toBeNull();
  expect(signals).toHaveLength(2);
});

it('hides changed workspace/session sources immediately and ignores late completions even when cancellation is ignored', async () => {
  const original = controlledPage(page([row(1, 'Workspace A history')]));
  const obsolete = controlledPage(page([row(1, 'Late workspace A history')], { revision: 1 }));
  const replacement = controlledPage(page([row(1, 'Workspace B history')], { generation: 'generation-b' }));
  const a = sourceFor('running:workspace-a:session-a', original, obsolete);
  const b = sourceFor('saved:workspace-b:session-b', replacement);
  await act(() => root.render(<Probe source={a.source} />));
  await act(() => original.finish());
  await act(() => history.refresh());
  await act(() => root.render(<Probe source={b.source} />));
  expect(a.signals[1]?.aborted).toBe(true);
  expect(container.textContent).toBe('');
  expect(history.generation).toBeNull();
  await act(() => replacement.finish());
  await act(() => obsolete.finish());
  expect(container.textContent).toBe('Workspace B history');
  expect(history.generation).toBe('generation-b');
  expect(history.loading).toBe(false);
});

it('retains usable rows after a failed refresh and permits an empty transcript on retry', async () => {
  const original = controlledPage(page([row(1, 'Preserved history')]));
  const failing = controlledPage(page([row(1, 'Not committed')], { revision: 1 }));
  const retry = controlledPage(page([], { revision: 2 }));
  const { source } = sourceFor('running:workspace-a:session-a', original, failing, retry);
  await act(() => root.render(<Probe source={source} />));
  await act(() => original.finish());
  await act(() => history.refresh());
  await act(() => failing.finish(new Error('Connection lost')));
  expect(container.textContent).toBe('Preserved history');
  expect(history.error).toBe('Connection lost');
  expect(history.loading).toBe(false);
  await act(() => history.refresh());
  expect(history.initialLoading).toBe(false);
  expect(container.textContent).toBe('Preserved history');
  await act(() => retry.finish());
  expect(history.rows).toEqual([]);
  expect(history.total).toBe(0);
  expect(history.error).toBeNull();
});

it('refreshes the visible history anchor and keeps appended activity available without jumping to it', async () => {
  const original = controlledPage(page([row(10), row(20), row(30)], { total: 3 }));
  const updated = controlledPage(page([row(10), row(20, 'Updated old row')], { revision: 1, hasAfter: true, total: 5 }));
  const { source, requests } = sourceFor('running:workspace-a:session-a', original, updated);
  await act(() => root.render(<Probe source={source} />));
  await act(() => original.finish());
  history.setViewport('row-20', 'row-30', false);
  await act(() => root.render(<Probe source={{ ...source, revision: 1 }} />));
  expect(requests[1]).toEqual({ generation: 'generation-a', around: 'row-20', before: null, after: null });
  await act(() => updated.finish());
  expect(history.rows.map(({ id }) => id)).toEqual(['row-10', 'row-20', 'row-30']);
  expect(container.textContent).toContain('Updated old row');
  expect(history.hasAfter).toBe(true);
  expect(history.total).toBe(5);
});

it('refreshes an offscreen tool when it becomes visible after source updates have stopped', async () => {
  const running: TranscriptRow = {
    ...row(1),
    item: { id: 'row-1', type: 'tool-call', toolCallId: 'tool-1', tool: 'bash', status: 'running' },
  };
  const finished: TranscriptRow = {
    ...running,
    item: { id: 'row-1', type: 'tool-call', toolCallId: 'tool-1', tool: 'bash', status: 'done' },
  };
  const initial = controlledPage(page([running, row(2), row(3)]));
  const tail = controlledPage(page([row(3), row(4)], { revision: 1, hasBefore: true, total: 4 }));
  const older = controlledPage(page([finished, row(2)], { revision: 1, hasAfter: true, total: 4 }));
  const { source, requests, signals } = sourceFor('session-a', initial, tail, older);
  await act(() => root.render(<Probe source={source} />));
  await act(() => initial.finish());
  history.setViewport('row-3', 'row-3', true);
  await act(() => root.render(<Probe source={{ ...source, revision: 1 }} />));
  await act(() => tail.finish());
  expect(history.rows.find(({ id }) => id === 'row-1')?.item).toMatchObject({ status: 'running' });
  // No further metadata invalidation: entering the stale cached row must be
  // enough to discover the final tool state through a bounded around read.
  await act(() => {
    history.setViewport('row-1', 'row-2', false);
    history.setViewport('row-1', 'row-2', false);
  });
  expect(requests[2]).toEqual({ generation: 'generation-a', before: null, after: null, around: 'row-1' });
  expect(signals[2]?.aborted).toBe(false);
  await act(() => older.finish());
  expect(history.rows.find(({ id }) => id === 'row-1')?.item).toMatchObject({ status: 'done' });
  await act(() => history.setViewport('row-1', 'row-2', false));
  expect(requests).toHaveLength(3);
});

it('keeps a newly visible reading anchor when an already requested latest page arrives far away', async () => {
  const original = controlledPage(page([row(10), row(20)]));
  const distant = controlledPage(page([row(900)], { revision: 1, hasBefore: true, total: 90 }));
  const visible = controlledPage(page([row(10), row(20, 'Updated visible row')], { revision: 1, hasAfter: true, total: 90 }));
  const { source, requests } = sourceFor('session-a', original, distant, visible);
  await act(() => root.render(<Probe source={source} />));
  await act(() => original.finish());
  await act(() => history.refresh());
  history.setViewport('row-10', 'row-20', false);
  await act(() => distant.finish());
  expect(history.rows.map(({ ordinal }) => ordinal)).toEqual([10, 20]);
  expect(requests[2]?.around).toBe('row-10');
  await act(() => visible.finish());
  expect(container.textContent).toBe('Message 10|Updated visible row');
  expect(history.hasAfter).toBe(true);
});

it('pages both directions across ordinal gaps and replaces distant windows for explicit navigation', async () => {
  const initial = controlledPage(page([row(20), row(40)], { hasBefore: true, hasAfter: true, total: 5 }));
  const older = controlledPage(page([row(3)], { hasAfter: true, total: 5 }));
  const newer = controlledPage(page([row(70)], { hasBefore: true, hasAfter: true, total: 5 }));
  const target = controlledPage(page([row(99)], { hasBefore: true, total: 5 }));
  const latest = controlledPage(page([row(70), row(99)], { hasBefore: true, total: 5 }));
  const { source, requests } = sourceFor('session-a', initial, older, newer, target, latest);
  await act(() => root.render(<Probe source={source} />));
  await act(() => initial.finish());
  await act(() => { history.loadOlder(); history.loadOlder(); });
  expect(requests[1]?.before).toBe(20);
  await act(() => older.finish());
  expect(history.rows.map(({ ordinal }) => ordinal)).toEqual([3, 20, 40]);
  expect(history.hasBefore).toBe(false);
  await act(() => history.loadNewer());
  expect(requests[2]?.after).toBe(40);
  await act(() => newer.finish());
  expect(history.rows.map(({ ordinal }) => ordinal)).toEqual([3, 20, 40, 70]);
  await act(() => history.jumpToRow('row-99'));
  expect(requests[3]?.around).toBe('row-99');
  await act(() => target.finish());
  expect(history.rows.map(({ ordinal }) => ordinal)).toEqual([99]);
  await act(() => history.jumpToLatest());
  await act(() => latest.finish());
  expect(history.rows.map(({ ordinal }) => ordinal)).toEqual([70, 99]);
  expect(history.hasAfter).toBe(false);
});

it('fences superseded navigation and resets a changed generation instead of merging an old cursor', async () => {
  const initial = controlledPage(page([row(40)], { hasBefore: true, total: 2 }));
  const obsolete = controlledPage(page([row(3)], { hasAfter: true, total: 2 }));
  const reset = controlledPage(page([row(1, 'New generation')], { generation: 'generation-b' }));
  const { source, signals } = sourceFor('session-a', initial, obsolete, reset);
  await act(() => root.render(<Probe source={source} />));
  await act(() => initial.finish());
  await act(() => history.loadOlder());
  await act(() => history.jumpToLatest());
  expect(signals[1]?.aborted).toBe(true);
  await act(() => reset.finish());
  await act(() => obsolete.finish());
  expect(container.textContent).toBe('New generation');
  expect(history.generation).toBe('generation-b');
  expect(history.hasBefore).toBe(false);
  expect(history.hasAfter).toBe(false);
});

it('loads full content separately and rejects late content after the source generation changes', async () => {
  const initial = controlledPage(page([{ ...row(1, 'Preview'), truncated: true, contentBytes: 1_000_000 }]));
  const reset = controlledPage(page([row(1, 'Different row')], { generation: 'generation-b' }));
  const full = Promise.withResolvers<{ text: string; offset: number; nextOffset: number | null; totalCharacters: number }>();
  let contentSignal: AbortSignal | undefined;
  const { source } = sourceFor('session-a', initial, reset);
  source.content = vi.fn((_request, signal) => { contentSignal = signal; return full.promise; });
  await act(() => root.render(<Probe source={source} />));
  await act(() => initial.finish());
  const pending = history.content('row-1', 16_384, new AbortController().signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await act(() => history.refresh());
  await act(() => reset.finish());
  expect(contentSignal?.aborted).toBe(true);
  full.resolve({ text: 'Obsolete full content', offset: 16_384, nextOffset: null, totalCharacters: 16_405 });
  await rejected;
  expect(container.textContent).toBe('Different row');
});

it('allows independently visible content reads and aborts all remaining reads on source disposal', async () => {
  const initial = controlledPage(page([row(1), row(2), row(3)]));
  const { source } = sourceFor('session-a', initial);
  const loads = Array.from({ length: 3 }, () => Promise.withResolvers<TranscriptContentPage>());
  const signals: AbortSignal[] = [];
  source.content = vi.fn((_request, signal) => {
    signals.push(signal);
    return loads[signals.length - 1]!.promise;
  });
  await act(() => root.render(<Probe source={source} />));
  await act(() => initial.finish());
  const firstController = new AbortController();
  const first = history.content('row-1', 0, firstController.signal);
  const second = history.content('row-2', 0, new AbortController().signal);
  expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
  const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  firstController.abort();
  expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
  const result = { text: 'Complete content', offset: 0, nextOffset: null, totalCharacters: 16 };
  loads[0]!.resolve(result);
  loads[1]!.resolve(result);
  await firstRejected;
  await expect(second).resolves.toEqual(result);
  const third = history.content('row-3', 0, new AbortController().signal);
  const thirdRejected = expect(third).rejects.toMatchObject({ name: 'AbortError' });
  await act(() => root.render(<Probe source={null} />));
  expect(signals[2]!.aborted).toBe(true);
  loads[2]!.resolve(result);
  await thirdRejected;
});

it('invalidates same-size legacy full content by page revision while preserving explicit item revisions', async () => {
  const legacy = { ...row(1, 'Identical preview'), truncated: true };
  const stable = { ...row(2, 'Identical preview'), truncated: true, contentRevision: 7 };
  const initial = controlledPage(page([legacy, stable], { revision: 1 }));
  const refreshed = controlledPage(page([legacy, stable], { revision: 2 }));
  const { source } = sourceFor('session-a', initial, refreshed);
  let version = 'First complete content';
  source.content = vi.fn(async ({ rowId }) => {
    const serialized = JSON.stringify({ id: rowId, type: 'message', role: 'user', text: version });
    return { text: serialized, offset: 0, nextOffset: null, totalCharacters: serialized.length };
  });
  await act(() => root.render(<Probe source={source} />));
  await act(() => initial.finish());
  const content = new TranscriptContentCache(history.generation);
  content.setNeeded(history.rows, history.content);
  await vi.waitFor(() => expect(content.get(history.rows[0]!).item).toMatchObject({ text: 'First complete content' }));
  version = 'Other complete content';
  await act(() => history.refresh());
  await act(() => refreshed.finish());
  content.setNeeded(history.rows, history.content);
  await vi.waitFor(() => expect(content.get(history.rows[0]!).item).toMatchObject({ text: 'Other complete content' }));
  expect(content.get(history.rows[1]!).item).toMatchObject({ text: 'First complete content' });
  expect(vi.mocked(source.content).mock.calls.map(([request]) => request.rowId)).toEqual(['row-1', 'row-2', 'row-1']);
  content.suspend();
});

it('keeps Inspector usable through initial loading, failure and an actionable retry', async () => {
  const failing = controlledPage(page([]));
  const retry = controlledPage(page([row(1, 'Recovered history')]));
  const { source } = sourceFor('session-a', failing, retry);
  await act(() => root.render(<Probe source={source} shell />));
  const inspectorButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open Inspector"]');
  if (!inspectorButton) throw new Error('Inspector action is missing');
  expect(inspectorButton.disabled).toBe(false);
  await act(() => inspectorButton.click());
  await act(() => failing.finish(new Error('History transfer failed')));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('History transfer failed');
  expect(container.querySelector('aside[aria-label="Inspector"]')?.textContent).toBe('Repository files are available');
  const retryButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Retry transcript');
  if (!retryButton) throw new Error('Transcript retry is missing');
  await act(() => retryButton.click());
  await act(() => retry.finish());
  expect(container.textContent).toContain('Recovered history');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('aside[aria-label="Inspector"]')?.textContent).toBe('Repository files are available');
});

it('does not replace the reading viewport or Inspector with an in-flow loading strip on refresh', async () => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
  const original = controlledPage(page([row(1, 'Read this conversation')]));
  const refreshed = controlledPage(page([row(1, 'Read this conversation'), row(2, 'New response')], { revision: 1 }));
  const { source } = sourceFor('session-a', original, refreshed);
  await act(() => root.render(<Probe source={source} shell />));
  await act(() => original.finish());
  const viewport = container.querySelector<HTMLDivElement>('.conversation-stage [data-slot=scroll-area-viewport]');
  const inspectorButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open Inspector"]');
  if (!viewport || !inspectorButton) throw new Error('Conversation controls did not mount');
  await act(() => {
    inspectorButton.click();
    viewport.scrollTop = 100;
    viewport.dispatchEvent(new Event('scroll'));
    history.setViewport('row-1', 'row-1', false);
  });
  const inspector = container.querySelector('aside[aria-label="Inspector"]');
  await act(() => root.render(<Probe source={{ ...source, revision: 1 }} shell />));
  expect(container.textContent).toContain('Read this conversation');
  expect(container.querySelector('.conversation-stage [data-slot=scroll-area-viewport]')).toBe(viewport);
  expect(container.querySelector('aside[aria-label="Inspector"]')).toBe(inspector);
  await act(() => refreshed.finish());
  expect(container.textContent).toContain('New response');
  expect(container.querySelector('aside[aria-label="Inspector"]')).toBe(inspector);
  expect(viewport.scrollTop).toBe(100);
});

it('evicts on 10,000 incoming updates without any viewport or scroll calls', () => {
  let cache = EMPTY_TRANSCRIPT_CACHE;
  const following = { firstId: null, lastId: null, following: true };
  for (let ordinal = 0; ordinal < 10_000; ordinal++) {
    const rows = ordinal === 0 ? [row(ordinal)] : [row(ordinal - 1, `Final ${ordinal - 1}`), row(ordinal)];
    cache = mergeTranscriptPage(cache, page(rows, { revision: ordinal, hasBefore: ordinal > 1, total: ordinal + 1 }),
      { generation: cache.generation, before: null, after: null, around: null }, following);
    if (cache.rows.length > TRANSCRIPT_CACHE_ROWS || cache.bytes > TRANSCRIPT_CACHE_BYTES) throw new Error(`Cache exceeded its budget at update ${ordinal}`);
  }
  expect(cache.rows.map(({ ordinal }) => ordinal)).toEqual(Array.from({ length: TRANSCRIPT_CACHE_ROWS }, (_, index) => 10_000 - TRANSCRIPT_CACHE_ROWS + index));
  expect(cache.hasBefore).toBe(true);
  expect(cache.hasAfter).toBe(false);
  expect(cache.total).toBe(10_000);
  expect(cache.rows[cache.rows.length - 2]?.item).toMatchObject({ text: 'Final 9998' });
});

it('accounts for retained wire bytes rather than full content size and preserves visible anchors', () => {
  let cache = EMPTY_TRANSCRIPT_CACHE;
  const following = { firstId: null, lastId: null, following: true };
  for (let start = 0; start < 320; start += 8) {
    const rows = Array.from({ length: 8 }, (_, offset) => ({ ...row(start + offset, '界'.repeat(3_000)), contentBytes: 100_000_000, truncated: true }));
    cache = mergeTranscriptPage(cache, page(rows, { revision: start, hasBefore: start > 0, hasAfter: start < 312, total: 320 }),
      { generation: cache.generation, before: null, after: start === 0 ? null : start - 1, around: null }, following);
  }
  const growingRows = Array.from({ length: 6 }, (_, offset) => ({ ...row(159 + offset, '界'.repeat(5_000)), contentBytes: 100_000_000, truncated: true }));
  cache = mergeTranscriptPage(cache, page(growingRows, { revision: 320, hasBefore: true, hasAfter: true, total: 320 }),
    { generation: cache.generation, before: null, after: null, around: 'row-160' },
    { firstId: 'row-160', lastId: 'row-164', following: false });
  expect(cache.rows.some(({ id }) => id === 'row-160')).toBe(true);
  expect(cache.rows.some(({ id }) => id === 'row-164')).toBe(true);
  const actualBytes = cache.rows.reduce((total, value) => total + new TextEncoder().encode(JSON.stringify(value)).byteLength, 0);
  expect(actualBytes).toBeLessThanOrEqual(TRANSCRIPT_CACHE_BYTES);
  expect(cache.bytes).toBe(actualBytes);
});

it('does not fabricate contiguous history from distant pages or resurrect a lower revision', () => {
  const following = { firstId: null, lastId: null, following: true };
  const latest = { generation: null, before: null, after: null, around: null };
  let cache = mergeTranscriptPage(EMPTY_TRANSCRIPT_CACHE, page([row(1), row(20)], { hasAfter: true, total: 4 }), latest, following);
  cache = mergeTranscriptPage(cache, page([row(900), row(2_000)], { revision: 5, hasBefore: true, total: 4 }),
    { ...latest, generation: 'generation-a' }, following);
  expect(cache.rows.map(({ ordinal }) => ordinal)).toEqual([900, 2_000]);
  expect(cache.hasBefore).toBe(true);
  expect(cache.hasAfter).toBe(false);
  cache = mergeTranscriptPage(cache, page([row(1, 'Stale')], { revision: 4, hasAfter: true, total: 4 }),
    { ...latest, generation: 'generation-a' }, following);
  expect(cache.rows.map(({ ordinal }) => ordinal)).toEqual([900, 2_000]);
});

it('removes hidden calls from an authoritative page interval and its now-empty tail', () => {
  const following = { firstId: null, lastId: null, following: true };
  const request = { generation: 'generation-a', before: null, after: null, around: null };
  let cache = mergeTranscriptPage(EMPTY_TRANSCRIPT_CACHE, page([row(1), row(10), row(20), row(30), row(50)]), request, following);
  cache = mergeTranscriptPage(cache, page([row(10), row(30)], { revision: 1, hasBefore: true, hasAfter: true, total: 4 }),
    { ...request, around: 'row-20' }, { firstId: 'row-20', lastId: 'row-30', following: false });
  expect(cache.rows.map(({ ordinal }) => ordinal)).toEqual([1, 10, 30, 50]);
  cache = mergeTranscriptPage(cache, page([row(1), row(10)], { revision: 2, total: 2 }), request, following);
  expect(cache.rows.map(({ ordinal }) => ordinal)).toEqual([1, 10]);
  expect(cache.hasAfter).toBe(false);
  expect(cache.total).toBe(2);
});
