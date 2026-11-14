// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TOAST_HIDE_MS, Toasts, useToasts, type Toast } from './toasts.js';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Report({ toasts }: { toasts: readonly (Toast | null)[] }) {
  useToasts(toasts);
  return null;
}

async function show(...toasts: (Toast | null)[]) {
  await act(() => root.render(<Toasts><Report toasts={toasts} /></Toasts>));
}

function shown(): string[] {
  return [...container.querySelectorAll('section[aria-label="Notifications"] [data-tone]')].map((toast) => toast.textContent ?? '');
}

const standing = (name: string): Toast => ({ key: name, tone: 'warning', persistent: true, message: name });

it('stacks the newest on top, shows three, and counts the rest', async () => {
  await show(standing('first'));
  await show(standing('first'), standing('second'));
  await show(standing('first'), standing('second'), standing('third'), standing('fourth'), standing('fifth'));
  expect(shown()).toEqual(['fifth', 'fourth', 'third']);
  expect(container.querySelector('section[aria-label="Notifications"]')?.textContent).toContain('2 more');
});

it('hides an event toast on its own, keeps a standing one, and shows the event again when it recurs', async () => {
  const failed: Toast = { key: 'save:Disk full', tone: 'error', message: 'Disk full' };
  await show(standing('Offline'), failed);
  await act(async () => { await vi.advanceTimersByTimeAsync(TOAST_HIDE_MS); });
  expect(shown()).toEqual(['Offline']);
  await show(standing('Offline'), failed);
  expect(shown()).toEqual(['Offline']);
  await show(standing('Offline'));
  await show(standing('Offline'), failed);
  expect(shown()).toEqual(['Disk full', 'Offline']);
});

it('keeps the action and the dismissal hook of a toast, and shows the newest report once for a key two callers report', async () => {
  const onClick = vi.fn();
  const onDismiss = vi.fn();
  await act(() => root.render(<Toasts>
    <Report toasts={[{ key: 'shared', tone: 'error', persistent: true, message: 'Read failed' }]} />
    <Report toasts={[{ key: 'shared', tone: 'error', persistent: true, message: 'Read failed', action: { label: 'Retry', onClick }, onDismiss }]} />
  </Toasts>));
  expect(shown()).toHaveLength(1);
  const toast = container.querySelector('section[aria-label="Notifications"] [data-tone]');
  await act(() => [...toast!.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!.click());
  expect(onClick).toHaveBeenCalledTimes(1);
  await act(() => toast!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
  expect(shown()).toEqual([]);
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it('names the action by its full label beside a long message, also while the action runs', async () => {
  const label = 'Retry provider catalog and controls';
  const message = `Transcript history could not be loaded: ${'the transcript page read timed out '.repeat(8)}`;
  await show({ key: 'long', tone: 'error', persistent: true, message, action: { label, onClick: () => undefined, pending: true } });
  const action = [...container.querySelectorAll<HTMLButtonElement>('section[aria-label="Notifications"] button')].find((button) => button.getAttribute('aria-label') !== 'Dismiss');
  expect(action?.getAttribute('aria-label')).toBe(label);
  expect(action?.getAttribute('title')).toBe(label);
  expect(action?.textContent).toBe(label);
  expect(action?.disabled).toBe(true);
  // Running, the label is still shown, not hidden behind a spinner.
  expect(action?.querySelector('.opacity-0')).toBeNull();
  expect(action?.querySelector('svg')).toBeNull();
});
