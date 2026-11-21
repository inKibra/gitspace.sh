// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatterPost, ChatterTopic } from '@gitspace/protocol/chatter-contract';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IssuesView, openIssueCount, type IssuesViewProps } from './IssuesView.js';

const at = new Date('2026-11-21T10:00:00.000Z');
const topic = (key: string, extra: Partial<ChatterTopic> = {}): ChatterTopic => ({
  key, display: key, firstAt: at, lastAt: at, posts: 2, participants: [{ kind: 'workspace', id: 'workspace-a', name: 'Parser' }, { kind: 'workspace', id: 'workspace-b', name: 'Billing' }],
  state: 'open', stateBy: 'Parser', stateAt: at, fixedIn: null, repeats: 0, filed: null, ...extra,
});
const post = (topicKey: string, text: string): ChatterPost => ({
  type: 'post', offset: 1, id: `post-${topicKey}`, at, topicKey, topic: topicKey, author: { kind: 'workspace', id: 'workspace-a', name: 'Parser' }, phase: 'code', kind: 'tooling', text,
  spot: { tool: 'proc', reference: 'history://workspace-a/main#12', machine: 'm-1' },
});

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
const button = (card: string, label: string) => {
  const found = [...container.querySelectorAll(`[data-issue-key="${card}"] button`)].find(candidate => candidate.textContent?.trim() === label);
  if (!found || !(found instanceof HTMLButtonElement)) throw new Error(`No button "${label}"`);
  return found;
};
const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
});
const issues = { topics: [topic('proc watch failed'), topic('diff view broken · blocks', { state: 'resolved', fixedIn: 'abc1234', filed: { at: at.toISOString(), by: 'Ada', target: 'gitspace' } })], posts: [post('proc watch failed', 'proc watch lost the process after a restart')] };

it('lists the workspace\'s issue topics with state, tool, reference and filing, and counts the open ones', async () => {
  await render({ issues, error: null, onAct: vi.fn(), onFile: vi.fn() });
  const cards = [...container.querySelectorAll('[data-issue-key]')];
  expect(cards).toHaveLength(2);
  expect(cards[0]?.textContent).toContain('proc · 2 posts · 1 other workspace');
  expect(cards[0]?.textContent).toContain('proc watch lost the process after a restart');
  expect(cards[0]?.textContent).toContain('history://workspace-a/main#12');
  expect(cards[1]?.textContent).toContain('Resolved in abc1234');
  expect(cards[1]?.textContent).toContain('Filed');
  expect(openIssueCount(issues)).toBe(1);
  expect(openIssueCount(null)).toBeUndefined();
});

it('resolves an open topic with an optional fixed-in, dismisses it, and reopens a resolved one', async () => {
  const onAct = vi.fn(async () => {});
  await render({ issues, error: null, onAct, onFile: vi.fn() });
  await act(async () => button('proc watch failed', 'Resolve…').click());
  const input = container.querySelector<HTMLInputElement>('[data-issue-key="proc watch failed"] input');
  if (!input) throw new Error('No fixed-in input');
  await type(input, ' 0123abc ');
  await act(async () => button('proc watch failed', 'Resolve').click());
  expect(onAct).toHaveBeenLastCalledWith('proc watch failed', { kind: 'state', state: 'resolved', fixedIn: '0123abc' });
  await act(async () => button('proc watch failed', 'Dismiss').click());
  expect(onAct).toHaveBeenLastCalledWith('proc watch failed', { kind: 'state', state: 'dismissed', fixedIn: null });
  await act(async () => button('diff view broken · blocks', 'Reopen').click());
  expect(onAct).toHaveBeenLastCalledWith('diff view broken · blocks', { kind: 'state', state: 'open', fixedIn: null });
});

it('files the excerpt as reviewed, not the original post', async () => {
  const onFile = vi.fn(async () => null);
  await render({ issues, error: null, onAct: vi.fn(), onFile });
  await act(async () => button('proc watch failed', 'Review').click());
  const excerpt = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Excerpt to send"]');
  if (!excerpt) throw new Error('No excerpt editor');
  expect(excerpt.value).toBe('proc watch lost the process after a restart');
  await type(excerpt, '  proc watch lost the process (token removed)  ');
  await act(async () => button('proc watch failed', 'File with GitSpace').click());
  expect(onFile).toHaveBeenCalledWith('proc watch failed', { kind: 'file', excerpt: 'proc watch lost the process (token removed)' });
});

it('says why the issues could not be read', async () => {
  await render({ issues: null, error: 'Project is outside the device scope', onAct: vi.fn(), onFile: vi.fn() });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Project is outside the device scope');
});
