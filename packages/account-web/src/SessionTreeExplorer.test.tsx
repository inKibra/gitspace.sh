// @vitest-environment happy-dom
import type { SessionHistoryEntry, SessionHistoryPage, SessionHistoryPageRequest } from '@gitspace/protocol-agent';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verticalSliceFixture } from './App.js';
import { Composer } from './Composer.js';
import type { SessionControlsProps } from './GitSpaceShell.js';
import { SessionTreeExplorer } from './SessionTreeExplorer.js';

function entry(id: string, sequence: number, options: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return { id, parentId: null, role: 'user', preview: `Prompt ${id}`, tools: 0, sequence, current: false, childCount: 1, ...options };
}

function page(anchorId: string | null, entries: SessionHistoryEntry[], options: Partial<SessionHistoryPage> = {}): SessionHistoryPage {
  return { anchorId, entries, beforeCursor: null, afterCursor: null, ...options };
}

function controls(onReadHistory?: SessionControlsProps['onReadHistory'], historyAnchorId = 'current'): SessionControlsProps {
  const operation = async () => undefined;
  return {
    value: { sessionId: 'session-a', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, approvalMode: 'write', context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null, history: [], historyAnchorId },
    onCycleRole: operation, onSetModel: operation, onSetThinking: operation, onSetFast: operation, onSetApproval: operation, onSetGoal: operation, onCompact: operation, onClearQueue: operation, onRemoveQueuedMessage: operation, onPromoteQueuedMessage: operation, onAnswerAsk: operation, onStop: operation, onNavigateTree: operation, onReadHistory,
  };
}

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.getAttribute('aria-label') === name || candidate.textContent === name);
  if (!match) throw new Error(`Missing button: ${name}`);
  return match;
}

function inspect(preview: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.title === preview);
  if (!match) throw new Error(`Missing entry: ${preview}`);
  return match;
}

async function openComposerHistory(): Promise<void> {
  await act(() => button('More agent controls').click());
  const menuItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(candidate => candidate.textContent?.includes('Session history'));
  if (!menuItem) throw new Error('Missing history menu item');
  await act(() => menuItem.click());
}

let root: Root;
let container: HTMLDivElement;
let animationDescriptor: PropertyDescriptor | undefined;

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

it('loads only while open, keeps the inspected window through live updates, and separates inspection from a failed resume', async () => {
  const read = vi.fn(async (request: SessionHistoryPageRequest) => page(request.anchorId, [
    entry('earlier', 1), entry('current', 2, { role: 'assistant', preview: 'Current answer', current: true }),
  ]));
  const navigate = vi.fn(async () => { throw new Error('Agent is busy'); });
  const view = controls(read);
  view.onNavigateTree = navigate;
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} controls={view} running pending={false} />));
  expect(read).not.toHaveBeenCalled();
  await openComposerHistory();
  expect(inspect('Current answer').getAttribute('aria-pressed')).toBe('true');
  const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
  viewport.scrollTop = 160;
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} controls={{ ...view, value: { ...view.value, historyAnchorId: 'new-current', cost: 20 } }} running pending={false} />));
  expect(read).toHaveBeenCalledTimes(1);
  expect(viewport.scrollTop).toBe(160);
  expect(inspect('Current answer').getAttribute('aria-pressed')).toBe('true');
  await act(() => inspect('Prompt earlier').click());
  expect(inspect('Prompt earlier').getAttribute('aria-pressed')).toBe('true');
  expect(navigate).not.toHaveBeenCalled();
  await act(() => button('Resume from here').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Agent is busy');
  expect(navigate).toHaveBeenCalledTimes(1);
  await act(() => button('Close session history').click());
  expect(container.querySelector('[aria-label="Loaded session history"]')).toBeNull();
  await openComposerHistory();
  expect(read.mock.calls.at(-1)?.[0].anchorId).toBe('new-current');
});

it('disables history without a remote reader instead of opening local controls history', async () => {
  const view = controls();
  view.value = { ...view.value, history: [{ entryId: 'local', text: 'Local prompt recall' }] };
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} controls={view} running={false} pending={false} />));
  await act(() => button('More agent controls').click());
  const menuItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(candidate => candidate.textContent?.includes('Session history'))!;
  expect(menuItem.getAttribute('aria-disabled')).toBe('true');
  await act(() => menuItem.click());
  expect(container.querySelector('[aria-label="Loaded session history"]')).toBeNull();
});

it('releases replaced and closed requests and ignores late responses from either window', async () => {
  const obsolete = Promise.withResolvers<SessionHistoryPage>();
  const roots = Promise.withResolvers<SessionHistoryPage>();
  const reopened = Promise.withResolvers<SessionHistoryPage>();
  const signals: AbortSignal[] = [];
  const read = vi.fn((request: SessionHistoryPageRequest, signal: AbortSignal) => {
    signals.push(signal);
    if (request.anchorId === 'current') return Promise.resolve(page('current', [entry('older', 1), entry('current', 2, { current: true })], { beforeCursor: 'before-current' }));
    if (request.anchorId === 'older') return obsolete.promise;
    if (request.anchorId === null) return roots.promise;
    return reopened.promise;
  });
  const props = { onReadHistory: read, onNavigate: async () => undefined, onClose() {} };
  await act(() => root.render(<SessionTreeExplorer {...props} historyAnchorId="current" />));
  await act(() => inspect('Prompt older').click());
  expect(container.textContent).not.toContain('Prompt current');
  expect(button('Older history').disabled).toBe(true);
  await act(() => button('Root branches').click());
  expect(signals[1]?.aborted).toBe(true);
  await act(() => roots.resolve(page(null, [entry('root', 10)])));
  await act(() => obsolete.resolve(page('older', [entry('obsolete', 1)])));
  expect(container.textContent).toContain('Prompt root');
  expect(container.textContent).not.toContain('Prompt obsolete');
  await act(() => inspect('Prompt root').click());
  await act(() => root.render(null));
  expect(signals.at(-1)?.aborted).toBe(true);
  await act(() => root.render(<SessionTreeExplorer {...props} historyAnchorId="current" />));
  await act(() => reopened.resolve(page('root', [entry('closed', 11)])));
  expect(container.textContent).toContain('Prompt current');
  expect(container.textContent).not.toContain('Prompt closed');
});

it('advances through empty bounded windows, pages branch choices, and filters only loaded prompts', async () => {
  const read = vi.fn(async (request: SessionHistoryPageRequest) => {
    if (request.direction === 'children') {
      if (request.cursor === 'more-siblings') return page(null, [entry('second-root', 20)], { beforeCursor: 'prior-siblings' });
      if (request.anchorId === 'fork') return page('fork', [entry('child', 4, { parentId: 'fork' })]);
      return page(null, [entry('root', 1)], { afterCursor: 'more-siblings' });
    }
    if (request.anchorId === 'child') return page('child', [entry('child', 4), entry('reply', 5, { role: 'assistant', preview: 'Loaded answer' })]);
    if (request.direction === 'before' && request.cursor === 'continue-before-raw-gap') return page('current', [], { afterCursor: 'continue-after-raw-gap' });
    if (request.direction === 'after' && request.cursor === 'continue-after-raw-gap') return page('current', [entry('fork', 3, { childCount: 2 })]);
    if (request.direction === 'around') return page('current', [], { beforeCursor: 'continue-before-raw-gap' });
    throw new Error('Unexpected history boundary');
  });
  await act(() => root.render(<SessionTreeExplorer historyAnchorId="current" onReadHistory={read} onNavigate={async () => undefined} onClose={() => undefined} />));
  expect(button('Older history').disabled).toBe(false);
  await act(() => button('Older history').click());
  expect(button('Newer history').disabled).toBe(false);
  await act(() => button('Newer history').click());
  await act(() => button('Show 2 branches after entry 3').click());
  expect(container.textContent).toContain('Prompt child');
  expect(container.textContent).not.toContain('Prompt fork');
  await act(() => inspect('Prompt child').click());
  expect(container.textContent).toContain('Loaded answer');
  const readsBeforeFilter = read.mock.calls.length;
  await act(() => {
    const historyTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(candidate => candidate.textContent?.includes('History'));
    if (!historyTab) throw new Error('Missing history tab');
    historyTab.click();
  });
  expect(container.textContent).toContain('Prompt child');
  expect(container.textContent).not.toContain('Loaded answer');
  const filter = container.querySelector<HTMLInputElement>('input')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter, 'not in this window');
    filter.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(container.textContent).not.toContain('Prompt child');
  expect(read).toHaveBeenCalledTimes(readsBeforeFilter);
  await act(() => button('Root branches').click());
  await act(() => button('More branches').click());
  expect(container.textContent).toContain('Prompt second-root');
  expect(container.textContent).not.toContain('Prompt root');
  await act(() => button('Previous branches').click());
  expect(container.textContent).toContain('Prompt root');
  expect(container.textContent).not.toContain('Prompt second-root');
});
