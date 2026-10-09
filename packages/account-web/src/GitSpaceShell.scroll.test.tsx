// @vitest-environment happy-dom
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verticalSliceFixture } from './App.js';
import { GitSpaceShell } from './GitSpaceShell.js';
import { Composer } from './Composer.js';
import type { TranscriptHistory } from './useTranscriptHistory.js';
import type { GitSpaceShellProps, SessionControlsProps } from './GitSpaceShell.js';
import { WorkspaceDraftController } from './workspace-draft.js';

let root: Root;
let container: HTMLDivElement;
let contentHeight: number;
let touchKeyboard: boolean;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ontouchstart', null);
  touchKeyboard = false;
  const matchMedia = window.matchMedia.bind(window);
  vi.stubGlobal('matchMedia', (query: string) => {
    const result = matchMedia(query);
    if (query === '(pointer: coarse)') Object.defineProperty(result, 'matches', { value: true });
    if (query === '(hover: none)') Object.defineProperty(result, 'matches', { value: touchKeyboard });
    return result;
  });
  contentHeight = 2000;
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
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

it('keeps the reading position across transcript updates after mounting the native touch viewport', async () => {
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} />));
  const viewport = container.querySelector<HTMLDivElement>('.conversation-stage [data-slot=scroll-area-viewport]');
  if (!viewport) throw new Error('Transcript viewport did not mount');

  await act(() => {
    viewport.scrollTop = 100;
    viewport.dispatchEvent(new Event('scroll'));
  });
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} turns={[...verticalSliceFixture.turns]} />));

  expect(viewport.scrollTop).toBe(100);
});

it('does not take scroll ownership while a touch gesture is still in progress', async () => {
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} />));
  const viewport = container.querySelector<HTMLDivElement>('.conversation-stage [data-slot=scroll-area-viewport]');
  if (!viewport) throw new Error('Transcript viewport did not mount');

  await act(() => {
    viewport.scrollTop = 1500;
    viewport.dispatchEvent(new Event('scroll'));
    viewport.dispatchEvent(new Event('touchstart', { bubbles: true }));
  });
  contentHeight = 2400;
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} turns={[...verticalSliceFixture.turns]} />));
  expect(viewport.scrollTop).toBe(1500);

  await act(() => {
    viewport.scrollTop = 1200;
    viewport.dispatchEvent(new Event('scroll'));
    viewport.dispatchEvent(new Event('touchend', { bubbles: true }));
  });
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} turns={[...verticalSliceFixture.turns]} />));
  expect(viewport.scrollTop).toBe(1200);
});

it('leaves touch Return to multiline editing and sends only from the explicit button', async () => {
  touchKeyboard = true;
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} onSend={onSend} />));
  const textarea = container.querySelector('textarea')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Keep this draft');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await act(() => { textarea.dispatchEvent(enter); });
  expect(enter.defaultPrevented).toBe(false);
  expect(onSend).not.toHaveBeenCalled();
  expect(textarea.value).toBe('Keep this draft');

  // DOM emulation does not perform the native newline insertion after keydown.
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Keep this draft\nSecond line');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() => { container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(); });
  expect(onSend.mock.calls.map(([text]) => text)).toEqual(['Keep this draft\nSecond line']);
  expect(textarea.value).toBe('');
});
it('preserves newer controlled text when a streaming queued send is accepted', async () => {
  const accepted = Promise.withResolvers<void>();
  const send = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(() => accepted.promise);
  const operation = async () => undefined;
  const controls: SessionControlsProps = {
    value: { sessionId: 'session-a', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, approvalMode: 'write', context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null, history: [], historyAnchorId: null },
    onCycleRole: operation, onSetModel: operation, onSetThinking: operation, onSetFast: operation, onSetApproval: operation, onSetGoal: operation, onCompact: operation, onClearQueue: operation, onRemoveQueuedMessage: operation, onPromoteQueuedMessage: operation, onAnswerAsk: operation, onStop: operation, onNavigateTree: operation,
  };
  const controller = new WorkspaceDraftController({ deviceId: 'device', key: 'test', storage: null, save: async () => { throw new Error('Offline fixture must not save'); } });
  function View() {
    const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
    return <Composer workspace={verticalSliceFixture.workspace} controls={controls} running pending={false} onSend={send}
      draft={{ ...state, onChange: text => controller.edit(text), onBlur: () => undefined, capture: () => controller.capture(), accepted: capture => controller.accepted(capture) }} />;
  }
  await act(() => root.render(<View />));
  const textarea = container.querySelector('textarea')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'queued message');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  expect(send.mock.calls.map(([text, behavior]) => ({ text, behavior }))).toEqual([{ text: 'queued message', behavior: 'followUp' }]);
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'newer unsent message');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { accepted.resolve(); await accepted.promise; });
  expect(textarea.value).toBe('newer unsent message');
  expect(controller.snapshot().text).toBe('newer unsent message');
  controller.dispose();
});

it('preserves desktop Enter submission without consuming Shift+Enter or IME confirmation', async () => {
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} onSend={onSend} />));
  const textarea = container.querySelector('textarea')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Desktop draft');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  for (const modifiers of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifiers });
    await act(() => { textarea.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('Desktop draft');
  }
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await act(() => { textarea.dispatchEvent(enter); });
  expect(enter.defaultPrevented).toBe(true);
  expect(onSend.mock.calls.map(([text]) => text)).toEqual(['Desktop draft']);
  expect(textarea.value).toBe('');
});

it('keeps failure details and transcript through an explicit retry failure', async () => {
  const retry = Promise.withResolvers<void>();
  const onRetryAgent = vi.fn(() => retry.promise);
  const failedAgent = { ...verticalSliceFixture.mainAgent!, state: 'waiting' as const, controlsAvailable: false, failed: true, errorMessage: 'Restore agent: saved runtime could not start' };
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} mainAgent={failedAgent} onRetryAgent={onRetryAgent} />));
  const transcript = container.querySelector('.conversation-stage [data-slot=scroll-area-viewport]');
  const transcriptText = transcript?.textContent;
  expect(container.querySelector('textarea')).toBeNull();
  const retryButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry agent')!;
  await act(() => retryButton.click());
  expect(retryButton.disabled).toBe(true);
  expect(container.textContent).toContain(failedAgent.errorMessage);
  await act(async () => { retry.reject(new Error('Retry failed: provider credentials are unavailable')); });
  expect(container.textContent).toContain('Retry failed: provider credentials are unavailable');
  expect(container.textContent).toContain(failedAgent.errorMessage);
  expect(container.querySelector('.conversation-stage [data-slot=scroll-area-viewport]')).toBe(transcript);
  expect(transcript?.textContent).toBe(transcriptText);
  expect(onRetryAgent).toHaveBeenCalledTimes(1);
});

it('presents legacy missing failure details honestly and removes the retry affordance after recovery', async () => {
  const inactive = { ...verticalSliceFixture.mainAgent!, state: 'waiting' as const, controlsAvailable: false, failed: true, errorMessage: null };
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} mainAgent={inactive} onRetryAgent={async () => undefined} />));
  expect(container.querySelector('[role=alert]')?.textContent).toContain('No failure reason was recorded');
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} mainAgent={{ ...inactive, controlsAvailable: true, failed: false }} onSend={async () => undefined} />));
  expect(container.textContent).not.toContain('Retry agent');
  expect(container.querySelector('[role=alert]')).toBeNull();
  expect(container.querySelector('textarea')).not.toBeNull();
});

it('leaves virtual transcript scroll ownership with its native viewport renderer', async () => {
  const transcript: TranscriptHistory = {
    generation: 'virtual-generation', loading: false, initialLoading: false, error: null,
    navigation: null,
    hasBefore: false, hasAfter: false, total: 100,
    rows: Array.from({ length: 100 }, (_, ordinal) => ({
      id: `row-${ordinal}`, ordinal, turnId: 'long-turn', turnStatus: 'running', truncated: false, contentBytes: 100,
      item: { id: `row-${ordinal}`, type: 'message', role: 'user', text: `Virtual block ${ordinal}` },
    })),
    refresh: vi.fn(), loadOlder: vi.fn(), loadNewer: vi.fn(), jumpToLatest: vi.fn(), jumpToRow: vi.fn(), setViewport: vi.fn(),
    content: vi.fn(async () => ({ text: '{}', offset: 0, nextOffset: null, totalCharacters: 2 })),
    executionPage: vi.fn(async () => ({ generation: 'virtual-generation', revision: 0, rows: [], hasBefore: false, hasAfter: false, total: 0 })),
  };
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} transcript={transcript} />));
  const viewport = container.querySelector<HTMLDivElement>('.conversation-stage [data-slot=scroll-area-viewport]')!;
  await act(() => {
    viewport.scrollTop = 100;
    viewport.dispatchEvent(new Event('scroll'));
  });
  contentHeight = 3000;
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} turns={[...verticalSliceFixture.turns]} transcript={{ ...transcript, rows: [...transcript.rows] }} />));
  expect(container.querySelector('.conversation-stage [data-slot=scroll-area-viewport]')).toBe(viewport);
  expect(viewport.scrollTop).toBe(100);
  expect(container.querySelectorAll('[data-transcript-row]').length).toBeLessThan(30);
});

it('forwards global navigation without rendering a workspace-scoped fallback page', async () => {
  const onNavigateView = vi.fn();
  await act(async () => { root.render(<GitSpaceShell {...verticalSliceFixture} onNavigateView={onNavigateView} />); });
  const conversation = container.querySelector('.conversation-stage');
  const kanban = [...container.querySelectorAll<HTMLElement>('[data-sidebar="menu-button"]')].find((button) => button.textContent?.startsWith('Kanban'))!;
  await act(() => kanban.click());
  expect(onNavigateView).toHaveBeenCalledWith('kanban');
  expect(container.querySelector('.conversation-stage')).toBe(conversation);
  expect(container.querySelector('[aria-label="Kanban view"]')).toBeNull();
});
