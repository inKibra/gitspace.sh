// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verticalSliceFixture } from './App.js';
import { GitSpaceShell } from './GitSpaceShell.js';
import { Composer } from './Composer.js';
import type { TranscriptHistory } from './useTranscriptHistory.js';

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
  const onSend = vi.fn(async () => undefined);
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
  expect(onSend).toHaveBeenCalledExactlyOnceWith('Keep this draft\nSecond line', 'followUp', []);
  expect(textarea.value).toBe('');
});

it('preserves desktop Enter submission without consuming Shift+Enter or IME confirmation', async () => {
  const onSend = vi.fn(async () => undefined);
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
  expect(onSend).toHaveBeenCalledExactlyOnceWith('Desktop draft', 'followUp', []);
  expect(textarea.value).toBe('');
});

it('keeps failure details and transcript through an explicit retry failure while close remains usable', async () => {
  const retry = Promise.withResolvers<void>();
  const onRetryAgent = vi.fn(() => retry.promise);
  const onCloseSpace = vi.fn(async () => undefined);
  const failedAgent = { ...verticalSliceFixture.mainAgent!, state: 'waiting' as const, controlsAvailable: false, failed: true, errorMessage: 'Restore agent: saved runtime could not start' };
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} mainAgent={failedAgent} onRetryAgent={onRetryAgent} onCloseSpace={onCloseSpace} />));
  const transcript = container.querySelector('.conversation-stage [data-slot=scroll-area-viewport]');
  const transcriptText = transcript?.textContent;
  expect(container.querySelector('textarea')).toBeNull();
  const retryButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry agent')!;
  await act(() => retryButton.click());
  expect(retryButton.disabled).toBe(true);
  expect(container.textContent).toContain(failedAgent.errorMessage);
  const closeButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Close')!;
  expect(closeButton.disabled).toBe(false);
  await act(async () => { retry.reject(new Error('Retry failed: provider credentials are unavailable')); });
  expect(container.textContent).toContain('Retry failed: provider credentials are unavailable');
  expect(container.textContent).toContain(failedAgent.errorMessage);
  expect(container.querySelector('.conversation-stage [data-slot=scroll-area-viewport]')).toBe(transcript);
  expect(transcript?.textContent).toBe(transcriptText);
  expect(onRetryAgent).toHaveBeenCalledTimes(1);
  await act(() => closeButton.click());
  expect(onCloseSpace).toHaveBeenCalledExactlyOnceWith(verticalSliceFixture.workspace.id);
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
