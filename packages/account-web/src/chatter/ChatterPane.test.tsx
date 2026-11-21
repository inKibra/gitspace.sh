// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatterEvent, ChatterKind, ChatterTopic } from '@gitspace/protocol/chatter-contract';
import { TooltipProvider } from '@gitspace/ui';
import { ChatterPane, type ChatterPaneProps } from './ChatterPane.js';
import { EMPTY_CHATTER, mergeChatter } from './chatter-state.js';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const ada = { kind: 'person' as const, id: 'device-1', name: 'Ada' };
const at = new Date('2026-11-21T10:00:00Z');

function topic(key: string, display: string, posts: number, state: ChatterTopic['state'] = null): ChatterTopic {
  return { key, display, firstAt: at, lastAt: at, posts, participants: [ada], state, stateBy: null, stateAt: null, fixedIn: null };
}

function post(offset: number, topicKey: string, text: string, kind: ChatterKind = 'status'): ChatterEvent {
  return { type: 'post', offset, id: `post-${offset}`, at, topicKey, topic: topicKey, author: ada, kind, text };
}

const topics = [topic('bun test hang', 'bun test hang', 2, 'open'), topic('sqlite 2 mb cap', 'SQLite 2 MB cap', 2)];
const events = [post(1, 'bun test hang', 'bun test never exits.', 'tooling'), post(2, 'sqlite 2 mb cap', 'Writes over 2 MB fail.'), post(3, 'bun test hang', 'The watcher keeps it alive.'), post(4, 'sqlite 2 mb cap', 'Split the blob into rows.', 'workaround')];

async function render(props: Partial<ChatterPaneProps> = {}) {
  const onPost = vi.fn<ChatterPaneProps['onPost']>(async input => ({ status: 'ok', topic: topic(input.topic.toLowerCase(), input.topic, 1), similar: null }));
  const all: ChatterPaneProps = {
    projectName: 'demo', workspaceCount: 3, state: mergeChatter(EMPTY_CHATTER, events, topics, { cursor: 4 }), active: topics, error: null,
    collapsed: false, onCollapsed: vi.fn(), onPost, onAct: vi.fn(async () => null), onLoadOlder: vi.fn(async () => undefined), ...props,
  };
  await act(() => root.render(<TooltipProvider><ChatterPane {...all} /></TooltipProvider>));
  return all;
}

async function type(input: HTMLInputElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const field = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

it('groups posts under their topic, the most recently active topic last', async () => {
  await render();
  const groups = [...container.querySelectorAll<HTMLElement>('[data-topic]')];
  expect(groups.map(group => group.dataset.topic)).toEqual(['bun test hang', 'sqlite 2 mb cap']);
  expect([...groups[1]!.querySelectorAll('[data-post]')].map(element => element.getAttribute('data-post'))).toEqual(['post-2', 'post-4']);
  expect(groups[0]!.querySelector('[data-state="open"]')?.textContent).toBe('open issue');
  expect(groups[0]!.textContent).toContain('2 posts');
});

it('filters to one kind, dropping topics without it', async () => {
  await render();
  const workaround = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('workaround'))!;
  await act(() => workaround.click());
  expect([...container.querySelectorAll<HTMLElement>('[data-topic]')].map(group => group.dataset.topic)).toEqual(['sqlite 2 mb cap']);
  expect(container.querySelectorAll('[data-post]')).toHaveLength(1);
});

it('suggests a topic from the text, autocompletes active topics, and names a similar one', async () => {
  const props = await render();
  await type(field('Post'), 'Deploy dry run is 9 MB. Startup is close to the limit.');
  expect(field('Topic').value).toBe('Deploy dry run is 9');
  await act(() => field('Topic').dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
  await type(field('Topic'), 'sqlite');
  const options = [...container.querySelectorAll('[role="option"]')].map(option => option.textContent);
  expect(options).toEqual([expect.stringContaining('SQLite 2 MB cap')]);
  await type(field('Topic'), 'bun test hangs');
  expect(container.textContent).toContain('Similar active topic: bun test hang (2 posts)');
  const postThere = [...container.querySelectorAll('button')].find(button => button.textContent === 'Post there')!;
  await act(() => postThere.click());
  expect(field('Topic').value).toBe('bun test hang');
  expect(container.textContent).not.toContain('Similar active topic');
  await act(() => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(props.onPost).toHaveBeenCalledWith({ topic: 'bun test hang', kind: 'status', text: 'Deploy dry run is 9 MB. Startup is close to the limit.' });
});

it('collapses to a pill counting posts that arrived while collapsed', async () => {
  const props = await render({ collapsed: true });
  expect(container.querySelector('[data-unread]')).toBeNull();
  await render({ ...props, state: mergeChatter(props.state, [post(5, 'sqlite 2 mb cap', 'Also on R2.', 'tooling')], [], { cursor: 5 }) });
  const pill = container.querySelector<HTMLButtonElement>('button[aria-label^="Open Chatter"]')!;
  expect(pill.getAttribute('aria-label')).toBe('Open Chatter, 1 unread');
  expect(pill.textContent).toContain('Ada: Also on R2.');
});

it('moves the events it holds under a merged topic to the topic it went into', () => {
  const merged = mergeChatter(mergeChatter(EMPTY_CHATTER, [post(1, 'bun test hangs', 'one'), post(2, 'bun test hang', 'two')], [topic('bun test hangs', 'bun test hangs', 1), topic('bun test hang', 'bun test hang', 1)]), [
    { type: 'topic', offset: 3, id: 'line', at, topicKey: 'bun test hang', author: ada, change: { kind: 'merge', from: 'bun test hangs', fromDisplay: 'bun test hangs' } },
  ], [topic('bun test hang', 'bun test hang', 2)]);
  expect(merged.events.map(event => event.topicKey)).toEqual(['bun test hang', 'bun test hang', 'bun test hang']);
  expect([...merged.topics.keys()]).toEqual(['bun test hang']);
});
