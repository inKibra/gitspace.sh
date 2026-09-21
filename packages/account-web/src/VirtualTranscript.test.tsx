// @vitest-environment happy-dom
import { TRANSCRIPT_CONTENT_CHARACTERS, type TranscriptContentPage, type TranscriptItem, type TranscriptPage, type TranscriptRow } from '@gitspace/blocks';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VirtualTranscript, type VirtualTranscriptProps } from './VirtualTranscript.js';
import type { TranscriptHistory } from './useTranscriptHistory.js';

let container: HTMLDivElement;
let root: Root;
let viewport: HTMLDivElement;
const heights = new Map<string, number>();
const observers = new Set<{ callback: ResizeObserverCallback; elements: Set<Element> }>();

function rows(start: number, count: number): TranscriptRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${start + index}`, ordinal: start + index, turnId: 'one-huge-turn', turnStatus: 'running', truncated: false, contentBytes: 100,
    item: { id: `row-${start + index}`, type: 'message', role: 'user', text: `Block ${start + index}` },
  }));
}

function historyFor(items: TranscriptRow[], extra: Partial<TranscriptHistory> = {}): TranscriptHistory {
  return {
    rows: items, generation: 'session-generation', loading: false, initialLoading: false, error: null,
    navigation: null,
    hasBefore: false, hasAfter: false, total: items.length,
    refresh: vi.fn(), loadOlder: vi.fn(), loadNewer: vi.fn(), jumpToLatest: vi.fn(), jumpToRow: vi.fn(), setViewport: vi.fn(),
    content: vi.fn(async () => ({ text: '{}', offset: 0, nextOffset: null, totalCharacters: 2 })),
    executionPage: vi.fn(async () => ({ generation: 'session-generation', revision: 0, rows: [], hasBefore: false, hasAfter: false, total: 0 })), ...extra,
  };
}

async function render(history: TranscriptHistory, onAnswer?: VirtualTranscriptProps['onAnswer']): Promise<void> {
  await act(() => root.render(<div data-slot="scroll-area-viewport"><VirtualTranscript history={history} transport={[]} onAnswer={onAnswer} /></div>));
  viewport = container.querySelector<HTMLDivElement>('[data-slot=scroll-area-viewport]')!;
}

async function scroll(top: number): Promise<void> {
  await act(() => { viewport.scrollTop = top; viewport.dispatchEvent(new Event('scroll')); });
}

function firstVisible(): HTMLElement {
  const node = [...container.querySelectorAll<HTMLElement>('[data-transcript-row]')].find((item) => {
    const rect = item.getBoundingClientRect();
    return rect.top <= 0 && rect.bottom > 0;
  });
  if (!node) throw new Error('No transcript block at the reading anchor');
  return node;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  heights.clear();
  observers.clear();
  vi.stubGlobal('ResizeObserver', class {
    entry: { callback: ResizeObserverCallback; elements: Set<Element> };
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, elements: new Set() }; observers.add(this.entry); }
    observe(element: Element) { this.entry.elements.add(element); }
    unobserve(element: Element) { this.entry.elements.delete(element); }
    disconnect() { observers.delete(this.entry); }
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return Number.parseFloat(this.querySelector<HTMLElement>('[data-transcript-items]')?.style.height ?? '0') + 144;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const scroller = this.closest<HTMLElement>('[data-slot=scroll-area-viewport]');
    const id = this.dataset.transcriptRow;
    const top = id ? 72 + Number.parseFloat(this.style.top) - (scroller?.scrollTop ?? 0)
      : this.hasAttribute('data-transcript-items') ? 72 - (scroller?.scrollTop ?? 0) : 0;
    const height = id ? heights.get(id) ?? 100 : 500;
    return new DOMRect(0, top, 800, height);
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('mounts only visible blocks and overscan inside a single enormous turn', async () => {
  const history = historyFor(rows(0, 10_000));
  await render(history);
  expect(container.querySelectorAll('[data-transcript-row]').length).toBeLessThan(30);
  expect(container.textContent).toContain('Block 9999');
  expect(container.textContent).not.toContain('Block 1000');
  await scroll(80_000);
  expect(container.querySelectorAll('[data-transcript-row]').length).toBeLessThan(30);
  expect(container.textContent).not.toContain('Block 9999');
  expect(firstVisible()).toBeTruthy();
});

it('lands explicit historical jumps on their requested row and restores latest following', async () => {
  let history = historyFor(rows(1000, 64), { total: 1064 });
  await render(history);
  history = { ...history, rows: rows(0, 64), hasAfter: true, navigation: { rowId: 'row-11' } };
  await render(history);
  expect(firstVisible().dataset.transcriptRow).toBe('row-11');
  await scroll(3000);
  await render({ ...history, navigation: { rowId: 'row-11' } });
  expect(firstVisible().dataset.transcriptRow).toBe('row-11');
  await render({ ...history, rows: rows(1000, 64), hasAfter: false, navigation: { rowId: null } });
  expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
});

it('holds the visible block and offset through prepend, eviction, updates and image-height changes', async () => {
  let history = historyFor(rows(100, 150));
  await render(history);
  await scroll(4000);
  const anchor = firstVisible();
  const id = anchor.dataset.transcriptRow!;
  const top = anchor.getBoundingClientRect().top;
  history = { ...history, rows: [...rows(80, 20), ...history.rows] };
  await render(history);
  expect(container.querySelector(`[data-transcript-row="${id}"]`)!.getBoundingClientRect().top).toBe(top);
  history = { ...history, rows: history.rows.slice(30) };
  await render(history);
  expect(container.querySelector(`[data-transcript-row="${id}"]`)!.getBoundingClientRect().top).toBe(top);
  const preceding = [...container.querySelectorAll<HTMLElement>('[data-transcript-row]')].find((node) => node.getBoundingClientRect().bottom <= 0)!;
  heights.set(preceding.dataset.transcriptRow!, 340);
  await act(() => {
    for (const entry of [...observers]) if (entry.elements.has(preceding)) entry.callback([], {} as ResizeObserver);
  });
  expect(container.querySelector(`[data-transcript-row="${id}"]`)!.getBoundingClientRect().top).toBe(top);
  history = { ...history, rows: history.rows.map((row) => row.id === id ? { ...row, item: { id, type: 'message', role: 'user', text: 'Updated while reading' } } : row) };
  await render(history);
  expect(container.querySelector(`[data-transcript-row="${id}"]`)!.getBoundingClientRect().top).toBe(top);
  expect(container.textContent).toContain('Updated while reading');
});

it('follows new blocks only at the bottom and exposes new activity while reading', async () => {
  let history = historyFor(rows(0, 80));
  await render(history);
  history = { ...history, rows: rows(0, 90), total: 90 };
  await render(history);
  expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
  await scroll(2000);
  const readingTop = viewport.scrollTop;
  history = { ...history, rows: rows(0, 100), total: 100 };
  await render(history);
  expect(viewport.scrollTop).toBe(readingTop);
  const jump = [...container.querySelectorAll('button')].find((button) => button.textContent === 'New activity · Jump to latest')!;
  expect(jump).toBeTruthy();
  await act(() => jump.click());
  expect(history.jumpToLatest).toHaveBeenCalledOnce();
  expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
});

it('does not write scrollTop or cancel native gestures while a touch is moving', async () => {
  let history = historyFor(rows(0, 80));
  await render(history);
  const initialTop = viewport.scrollTop;
  const touchStart = new Event('touchstart', { bubbles: true, cancelable: true });
  await act(() => { viewport.dispatchEvent(touchStart); });
  history = { ...history, rows: rows(0, 90), total: 90 };
  await render(history);
  expect(viewport.scrollTop).toBe(initialTop);
  expect(touchStart.defaultPrevented).toBe(false);
  await scroll(initialTop - 200);
  await act(() => { viewport.dispatchEvent(new Event('touchend', { bubbles: true })); });
  const readingTop = viewport.scrollTop;
  history = { ...history, rows: rows(0, 100), total: 100 };
  await render(history);
  expect(viewport.scrollTop).toBe(readingTop);
});

it('preserves tool expansion and drafts through virtual unmount and cache eviction without moving the visible viewport to an offscreen focused question', async () => {
  const items = rows(0, 100);
  items[20] = { ...items[20]!, item: { id: 'row-20', type: 'tool-call', toolCallId: 'tool-20', tool: 'read', status: 'done', result: [{ id: 'result', type: 'code', text: 'retained output' }] } };
  items[21] = { ...items[21]!, item: { id: 'row-21', type: 'ask', toolCallId: 'ask-21', status: 'pending', questions: [{ id: 'question', prompt: 'What should happen next?' }] } };
  const history = historyFor(items);
  await render(history);
  await scroll(1700);
  const tool = container.querySelector<HTMLElement>('[data-transcript-row="row-20"]')!;
  await act(() => { tool.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
  await act(() => { tool.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')[1]!.click(); });
  const input = container.querySelector<HTMLTextAreaElement>('[data-transcript-row="row-21"] textarea')!;
  await act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep this unsent answer');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await scroll(viewport.scrollHeight - viewport.clientHeight);
  expect(document.activeElement).toBe(input);
  expect(input.isConnected).toBe(true);
  expect(vi.mocked(history.setViewport).mock.lastCall?.[0]).toBe(firstVisible().dataset.transcriptRow);
  expect(vi.mocked(history.setViewport).mock.lastCall?.[0]).not.toBe('row-21');
  await act(() => input.blur());
  await scroll(0);
  expect(container.querySelector('[data-transcript-row="row-20"]')).toBeNull();
  expect(container.querySelector('[data-transcript-row="row-21"]')).toBeNull();
  await render({ ...history, rows: rows(1000, 100), total: 1100 });
  expect(container.querySelector('[data-transcript-row="row-20"]')).toBeNull();
  expect(container.querySelector('[data-transcript-row="row-21"]')).toBeNull();
  await render(history);
  await scroll(1700);
  const restored = container.querySelector<HTMLElement>('[data-transcript-row="row-20"]')!;
  expect(restored.querySelector('button[aria-expanded]')!.getAttribute('aria-expanded')).toBe('true');
  expect(restored.querySelectorAll('button[aria-expanded]')[1]!.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector<HTMLTextAreaElement>('[data-transcript-row="row-21"] textarea')!.value).toBe('Keep this unsent answer');
});

it('automatically renders complete text above 256 Ki characters and attachments inline', async () => {
  const item: TranscriptItem = { id: 'row-0', type: 'message', role: 'user', text: 'A readable complete message.\n'.repeat(12_000), images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }] };
  const serialized = JSON.stringify(item);
  const items = [{ ...rows(0, 1)[0]!, truncated: true, contentRevision: 1, contentBytes: serialized.length }];
  const history = historyFor(items, { content: vi.fn(async (_id, offset) => ({
    text: serialized.slice(offset, offset + TRANSCRIPT_CONTENT_CHARACTERS), offset,
    nextOffset: offset + TRANSCRIPT_CONTENT_CHARACTERS < serialized.length ? offset + TRANSCRIPT_CONTENT_CHARACTERS : null,
    totalCharacters: serialized.length, contentRevision: 1,
  })) });
  await render(history);
  const complete = container.querySelector('[data-transcript-row="row-0"]')!;
  expect(complete.textContent).toContain(item.text);
  expect(complete.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aW1hZ2U=');
  expect(history.content).toHaveBeenCalledTimes(Math.ceil(serialized.length / TRANSCRIPT_CONTENT_CHARACTERS));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('loads every question before offering inline answers and submits the complete ask', async () => {
  const item: TranscriptItem = {
    id: 'row-0', type: 'ask', toolCallId: 'ask-0', status: 'pending',
    questions: [
      { id: 'first', prompt: 'First question', options: [{ id: 'one', title: 'First choice' }] },
      { id: 'second', prompt: 'Second question', options: [{ id: 'two', title: 'Second choice' }] },
    ],
  };
  const serialized = JSON.stringify(item);
  const items = [{ ...rows(0, 1)[0]!, item: { ...item, questions: item.questions.slice(0, 1) }, truncated: true, contentBytes: serialized.length }];
  const full = Promise.withResolvers<TranscriptContentPage>();
  const history = historyFor(items, { content: vi.fn(() => full.promise) });
  const onAnswer = vi.fn(async () => undefined);
  await render(history, onAnswer);
  expect(container.querySelector('[role="radio"]')).toBeNull();
  expect(container.textContent).not.toContain('First question');
  await act(() => full.resolve({ text: serialized, offset: 0, nextOffset: null, totalCharacters: serialized.length }));
  await act(() => { container.querySelector<HTMLElement>('[role="radio"]')!.click(); });
  expect(onAnswer).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Second question');
  await act(() => { container.querySelector<HTMLElement>('[role="radio"]')!.click(); });
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith([
    { id: 'first', selectedOptions: ['one'], customInput: null },
    { id: 'second', selectedOptions: ['two'], customInput: null },
  ]);
});

it('keeps complete content through same-size revisions and ignores an obsolete completion', async () => {
  const complete = (text: string): TranscriptContentPage => {
    const serialized = JSON.stringify({ id: 'row-0', type: 'message', role: 'user', text });
    return { text: serialized, offset: 0, nextOffset: null, totalCharacters: serialized.length };
  };
  const second = Promise.withResolvers<TranscriptContentPage>();
  const third = Promise.withResolvers<TranscriptContentPage>();
  const content = vi.fn<TranscriptHistory['content']>()
    .mockResolvedValueOnce(complete('First complete version'))
    .mockImplementationOnce(() => second.promise)
    .mockImplementationOnce(() => third.promise);
  const row = { ...rows(0, 1)[0]!, truncated: true, contentRevision: 1 };
  const history = historyFor([row], { content });
  await render(history);
  const node = container.querySelector('[data-transcript-row="row-0"]');
  expect(node?.textContent).toContain('First complete version');
  await render({ ...history, rows: [{ ...row, contentRevision: 2 }] });
  expect(node?.textContent).toContain('First complete version');
  await render({ ...history, rows: [{ ...row, contentRevision: 3 }] });
  expect(content.mock.calls[1]![2].aborted).toBe(true);
  await act(async () => { third.resolve(complete('Third complete version')); await third.promise; });
  expect(node?.textContent).toContain('Third complete version');
  await act(async () => { second.resolve(complete('Other complete version')); await second.promise; });
  expect(node?.textContent).toContain('Third complete version');
  expect(container.querySelector('[data-transcript-row="row-0"]')).toBe(node);
});

it('keeps the existing inline message when streaming grows beyond the page payload', async () => {
  // The page's truncated flag triggers hydration, independently of text length.
  const text = 'Existing streamed text. ';
  const item: TranscriptItem = { id: 'row-0', type: 'message', role: 'assistant', text, pending: true };
  const row = { ...rows(0, 1)[0]!, item, contentRevision: 1, contentBytes: text.length };
  const full = Promise.withResolvers<TranscriptContentPage>();
  const history = historyFor([row], { content: vi.fn(() => full.promise) });
  await render(history);
  const node = container.querySelector('[data-transcript-row="row-0"]')!;
  await render({ ...history, rows: [{ ...row, truncated: true, contentRevision: 2 }] });
  expect(node.textContent).toContain(text.trim());
  const completeText = `${text}More streamed output. COMPLETE_STREAM_END`;
  const serialized = JSON.stringify({ ...item, text: completeText });
  await act(async () => {
    full.resolve({ text: serialized, offset: 0, nextOffset: null, totalCharacters: serialized.length, contentRevision: 2 });
    await full.promise;
  });
  expect(container.querySelector('[data-transcript-row="row-0"]')).toBe(node);
  expect(node.textContent).toContain(completeText);
});

it('reuses hydrated items across virtual unmount and native viewport replacement', async () => {
  const items = rows(0, 100);
  items[20] = { ...items[20]!, truncated: true, contentRevision: 1 };
  const serialized = JSON.stringify({ ...items[20]!.item, text: 'Complete retained content' });
  const history = historyFor(items, { content: vi.fn(async () => ({ text: serialized, offset: 0, nextOffset: null, totalCharacters: serialized.length })) });
  await render(history);
  expect(history.content).not.toHaveBeenCalled();
  await scroll(1700);
  expect(container.textContent).toContain('Complete retained content');
  await scroll(0);
  expect(container.querySelector('[data-transcript-row="row-20"]')).toBeNull();
  await scroll(1700);
  expect(container.textContent).toContain('Complete retained content');
  await act(() => root.render(<div key="native-touch" data-slot="scroll-area-viewport"><VirtualTranscript history={history} transport={[]} /></div>));
  viewport = container.querySelector<HTMLDivElement>('[data-slot=scroll-area-viewport]')!;
  expect(container.textContent).toContain('Complete retained content');
  expect(history.content).toHaveBeenCalledOnce();
});

it('does not reuse complete items across generations or sources sharing row identifiers', async () => {
  const row = { ...rows(0, 1)[0]!, truncated: true, contentRevision: 1 };
  const full = (text: string) => {
    const serialized = JSON.stringify({ ...row.item, text });
    return { text: serialized, offset: 0, nextOffset: null, totalCharacters: serialized.length };
  };
  const generation = Promise.withResolvers<TranscriptContentPage>();
  const content = vi.fn<TranscriptHistory['content']>().mockResolvedValueOnce(full('Original source content')).mockImplementationOnce(() => generation.promise);
  const history = historyFor([row], { content });
  await render(history);
  expect(container.textContent).toContain('Original source content');
  await render({ ...history, generation: 'different-generation' });
  expect(container.textContent).not.toContain('Original source content');
  const other = historyFor([row], { generation: 'different-generation', content: vi.fn(async () => full('Replacement source content')) });
  await render(other);
  expect(content.mock.calls[1]![2].aborted).toBe(true);
  await act(() => generation.resolve(full('Obsolete generation content')));
  expect(container.textContent).toContain('Replacement source content');
  expect(container.textContent).not.toContain('Obsolete generation content');
});

it('restores the reading anchor when ScrollArea replaces its native viewport', async () => {
  const history = historyFor(rows(0, 100));
  await render(history);
  await scroll(3000);
  const anchor = firstVisible();
  const id = anchor.dataset.transcriptRow!;
  const top = anchor.getBoundingClientRect().top;
  const previousViewport = viewport;
  await act(() => root.render(<div key="native-touch" data-slot="scroll-area-viewport"><VirtualTranscript history={history} transport={[]} /></div>));
  viewport = container.querySelector<HTMLDivElement>('[data-slot=scroll-area-viewport]')!;
  expect(viewport).not.toBe(previousViewport);
  expect(container.querySelector(`[data-transcript-row="${id}"]`)!.getBoundingClientRect().top).toBe(top);
});

it('requests bounded pages at the loaded history boundaries', async () => {
  const history = historyFor(rows(100, 100), { hasBefore: true, hasAfter: true });
  await render(history);
  await scroll(0);
  expect(history.loadOlder).toHaveBeenCalledOnce();
  await scroll(50);
  expect(history.loadOlder).toHaveBeenCalledOnce();
  await scroll(viewport.scrollHeight - viewport.clientHeight);
  expect(history.loadNewer).toHaveBeenCalledOnce();
});

it('keeps execution history inline, paged and expanded after completion and a native viewport remount', async () => {
  const execution: TranscriptRow = {
    id: 'execution-process-run-1', ordinal: 1, turnId: 'turn-1', turnStatus: 'running', truncated: false, contentBytes: 200,
    item: { id: 'execution-process-run-1', executionId: 'execution-process-run-1', type: 'execution', kind: 'process', label: 'Development server', status: 'running', historyCount: 2, hasFailures: false },
  };
  const observation = (ordinal: number): TranscriptRow => ({
    id: `observation-${ordinal}`, ordinal, turnId: 'turn-1', turnStatus: 'done', truncated: false, contentBytes: 200,
    item: { id: `observation-${ordinal}`, type: 'tool-call', toolCallId: `call-${ordinal}`, tool: 'hub', target: `Log observation ${ordinal}`, status: 'error', args: { op: 'logs', name: 'Development server', cursor: ordinal },
      result: [{ id: `log-${ordinal}`, type: 'code', text: `Complete original output ${ordinal}`, language: 'text' }] },
  });
  const executionPage = vi.fn<TranscriptHistory['executionPage']>(async (_id, request) => ({
    generation: 'session-generation', revision: 1, rows: request.around ? [observation(10), observation(90)] : [observation(request.before === null ? 90 : 10)],
    hasBefore: request.before === null && request.around === null, hasAfter: request.before !== null, total: 2,
  }));
  let history = historyFor([execution], { executionPage });
  await render(history);
  expect(executionPage).not.toHaveBeenCalled();
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Expand process history: Development server"]')!.click());
  const region = container.querySelector<HTMLElement>('[aria-label="Development server execution history"]')!;
  expect(region.textContent).toContain('"cursor": 90');
  expect(region.textContent).toContain('Complete original output 90');
  expect(region.querySelector('[data-virtual-transcript]')).not.toBeNull();
  await act(() => [...region.querySelectorAll('button')].find((button) => button.textContent === 'Load earlier calls')!.click());
  expect(region.textContent).toContain('Complete original output 10');
  expect(region.textContent).toContain('Complete original output 90');
  expect(container.querySelectorAll('[data-execution-id]')).toHaveLength(1);
  history = { ...history, rows: [{ ...execution, item: { ...execution.item, type: 'execution', executionId: execution.id, kind: 'process', label: 'Development server', status: 'done', historyCount: 2, hasFailures: true } }] };
  await render(history);
  expect(container.querySelector('[aria-label="Collapse process history: Development server"]')?.getAttribute('aria-expanded')).toBe('true');
  expect(container.textContent).toContain('Failure in history');
  await act(() => root.render(<div key="replacement-viewport" data-slot="scroll-area-viewport"><VirtualTranscript history={history} transport={[]} /></div>));
  expect(container.querySelector('[aria-label="Collapse process history: Development server"]')?.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('[aria-label="Development server execution history"]')?.textContent).toContain('Complete original output 90');
});

it('holds the nested reading anchor while a remounted execution fetches its first page', async () => {
  const execution: TranscriptRow = {
    id: 'execution-remount', ordinal: 1, turnId: 'turn-1', turnStatus: 'done', truncated: false, contentBytes: 200,
    item: { id: 'execution-remount', executionId: 'execution-remount', type: 'execution', kind: 'job', label: 'Build', status: 'done', historyCount: 64, hasFailures: false },
  };
  const page: TranscriptPage = { generation: 'session-generation', revision: 0, rows: rows(100, 64), hasBefore: false, hasAfter: false, total: 64 };
  const executionPage = vi.fn<TranscriptHistory['executionPage']>().mockResolvedValue(page);
  const history = historyFor([execution], { executionPage });
  await render(history);
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Expand background job history: Build"]')!.click());
  const region = container.querySelector<HTMLElement>('[aria-label="Build execution history"]')!;
  await act(() => { region.scrollTop = 2000; region.dispatchEvent(new Event('scroll')); });
  const held = [...region.querySelectorAll<HTMLElement>('[data-transcript-row]')].find((node) => node.getBoundingClientRect().top <= 0 && node.getBoundingClientRect().bottom > 0)!;
  const heldId = held.dataset.transcriptRow;
  const heldOffset = held.getBoundingClientRect().top;
  const pending = Promise.withResolvers<TranscriptPage>();
  executionPage.mockImplementationOnce(() => pending.promise);
  await act(() => root.render(<div key="replacement-viewport" data-slot="scroll-area-viewport"><VirtualTranscript history={history} transport={[]} /></div>));
  await act(() => pending.resolve(page));
  const restored = container.querySelector<HTMLElement>(`[aria-label="Build execution history"] [data-transcript-row="${heldId}"]`)!;
  expect(restored.getBoundingClientRect().top).toBe(heldOffset);
});
