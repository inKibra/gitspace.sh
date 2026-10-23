// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IssuesView, type IssuesViewProps } from './IssuesView.js';

const item = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, description: `${title}\n\nDetails`, historyRef: 'history://workspace-a', tool: 'proc', model: 'opus', runtimeVersion: 'pi-1.0',
  state: 'open', duplicateOf: null, createdAt: '2026-10-22T10:00:00.000Z', ...extra,
});
const commit = '0123456789abcdef0123456789abcdef01234567';

// happy-dom has no Web Animations; the scroll area's viewport asks for them on a timer.
if (!('getAnimations' in Element.prototype)) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (props: IssuesViewProps) => act(async () => root.render(<IssuesView {...props} />));
const button = (label: string) => {
  const found = [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
};
const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
});

it('shows the workspace\'s issues with their state, and an invalid document as an alert', async () => {
  await render({ document: { items: [item('a', 'Proc watch failed'), item('b', 'Diff view broken', { state: 'fixed', fixedIn: commit, filedAt: '2026-10-22T11:00:00.000Z' })] }, onAct: vi.fn() });
  const cards = [...container.querySelectorAll('[data-issue-id]')];
  expect(cards).toHaveLength(2);
  expect(cards[0]?.textContent).toContain('Proc watch failed');
  expect(cards[0]?.textContent).toContain('proc · opus');
  expect(cards[0]?.textContent).toContain('history://workspace-a');
  expect(cards[1]?.textContent).toContain('Fixed in 01234567');
  expect(cards[1]?.textContent).toContain('Filed');
  expect(container.querySelector('[role="alert"]')).toBeNull();

  await render({ document: { items: [{ id: 'broken' }] }, onAct: vi.fn() });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('invalid');
  expect(container.querySelector('[data-issue-id]')).toBeNull();
});

it('marks an issue fixed only with a full commit hash', async () => {
  const onAct = vi.fn(async () => ({}));
  await render({ document: { items: [item('a', 'Proc watch failed')] }, onAct });
  await act(async () => button('Mark fixed…').click());
  const input = container.querySelector<HTMLInputElement>('[data-issue-id="a"] input');
  if (!input) throw new Error('No commit input');
  await type(input, 'abc123');
  expect(button('Mark fixed').disabled).toBe(true);
  await act(async () => button('Mark fixed').click());
  expect(onAct).not.toHaveBeenCalled();
  await type(input, commit);
  expect(button('Mark fixed').disabled).toBe(false);
  await act(async () => button('Mark fixed').click());
  expect(onAct).toHaveBeenCalledWith('a', { kind: 'fixed', commit });
});

it('files the excerpt as reviewed, not the original report', async () => {
  const onAct = vi.fn(async () => ({}));
  await render({ document: { items: [item('a', 'Proc watch failed')] }, onAct });
  await act(async () => button('Review').click());
  const excerpt = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Excerpt to send"]');
  if (!excerpt) throw new Error('No excerpt editor');
  expect(excerpt.value).toBe('Proc watch failed\n\nDetails');
  await type(excerpt, '  Proc watch failed (token removed)  ');
  await act(async () => button('File with GitSpace').click());
  expect(onAct).toHaveBeenCalledWith('a', { kind: 'file', excerpt: 'Proc watch failed (token removed)' });
});
