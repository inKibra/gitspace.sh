// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatterEvent, ChatterKind, ChatterTopic } from '@gitspace/protocol/chatter-contract';
import { TooltipProvider, badgeColors } from '@gitspace/ui';
import { ChatterPane, type ChatterPaneProps } from './ChatterPane.js';
import { EMPTY_CHATTER, mergeChatter } from './chatter-state.js';

let root: Root;
/** The workspace panel the button sits in: the header holds the React root, the composer sits at its bottom. */
let panel: HTMLDivElement;
let composer: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  panel = document.createElement('div');
  panel.dataset.workspacePanel = '';
  const header = document.createElement('div');
  composer = document.createElement('div');
  composer.dataset.composerOverlay = '';
  panel.append(header, composer);
  document.body.append(panel);
  root = createRoot(header);
});

afterEach(async () => {
  await act(() => root.unmount());
  panel.remove();
  vi.unstubAllGlobals();
});

const ada = { kind: 'person' as const, id: 'device-1', name: 'Ada' };
const bo = { kind: 'workspace' as const, id: 'ws-2', name: 'Bo' };
const at = new Date('2026-11-21T10:00:00Z');

function topic(key: string, display: string, posts: number, state: ChatterTopic['state'] = null): ChatterTopic {
  return { key, display, firstAt: at, lastAt: at, posts, participants: [ada], state, stateBy: null, stateAt: null, fixedIn: null, repeats: 0, filed: null };
}

function post(offset: number, topicKey: string, text: string, kind: ChatterKind = 'status', author: ChatterEvent['author'] = ada): ChatterEvent {
  return { type: 'post', offset, id: `post-${offset}`, at, topicKey, topic: topicKey, author, phase: null, kind, text, spot: null };
}

const topics = [topic('bun test hang', 'bun test hang', 2, 'open'), topic('sqlite 2 mb cap', 'SQLite 2 MB cap', 2)];
const events = [post(1, 'bun test hang', 'bun test never exits.', 'tooling'), post(2, 'sqlite 2 mb cap', 'Writes over 2 MB fail.'), post(3, 'bun test hang', 'The watcher keeps it alive.'), post(4, 'sqlite 2 mb cap', 'Split the blob into rows.', 'workaround')];

async function render(props: Partial<ChatterPaneProps> = {}) {
  const onPost = vi.fn<ChatterPaneProps['onPost']>(async input => ({ status: 'ok', topic: topic(input.topic.toLowerCase(), input.topic, 1), similar: null }));
  const all: ChatterPaneProps = {
    projectName: 'demo', workspaceCount: 3, workspaceId: 'ws-1', state: mergeChatter(EMPTY_CHATTER, events, topics, { cursor: 4 }), active: topics, error: null,
    onPost, onAct: vi.fn(async () => null), onLoadOlder: vi.fn(async () => undefined), ...props,
  };
  await act(() => root.render(<TooltipProvider><ChatterPane {...all} /></TooltipProvider>));
  return all;
}

const button = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
const pane = () => document.querySelector<HTMLElement>('section[aria-label="Chatter"]');

async function open(props: Partial<ChatterPaneProps> = {}) {
  const all = await render(props);
  await act(() => button().click());
  return all;
}

async function type(input: HTMLInputElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

it('groups posts under their topic, the most recently active topic last', async () => {
  await open();
  const groups = [...document.querySelectorAll<HTMLElement>('[data-topic]')];
  expect(groups.map(group => group.dataset.topic)).toEqual(['bun test hang', 'sqlite 2 mb cap']);
  expect([...groups[1]!.querySelectorAll('[data-post]')].map(element => element.getAttribute('data-post'))).toEqual(['post-2', 'post-4']);
  expect(groups[0]!.querySelector('[data-state="open"]')?.textContent).toBe('open issue');
  expect(groups[0]!.textContent).toContain('2 posts');
});

it('filters to one kind, dropping topics without it', async () => {
  await open();
  const workaround = [...document.querySelectorAll('button')].find(element => element.textContent?.includes('workaround'))!;
  await act(() => workaround.click());
  expect([...document.querySelectorAll<HTMLElement>('[data-topic]')].map(group => group.dataset.topic)).toEqual(['sqlite 2 mb cap']);
  expect(document.querySelectorAll('[data-post]')).toHaveLength(1);
});

it('shows a returned post on its own between the topics, in order, and not under a kind filter', async () => {
  const returned: ChatterEvent = { type: 'returned', offset: 5, id: 'returned-5', at, topicKey: '', topic: 'deploy', author: bo, kind: 'coordination', text: 'relay-hardening, please redeploy.', to: 'relay-hardening' };
  await open({ state: mergeChatter(EMPTY_CHATTER, [...events, returned, post(6, 'bun test hang', 'Fixed by the flag.')], topics, { cursor: 6 }) });
  expect([...document.querySelectorAll<HTMLElement>('[data-topic],[data-returned]')].map(element => element.dataset.topic ?? element.dataset.returned)).toEqual(['sqlite 2 mb cap', 'returned-5', 'bun test hang']);
  expect(document.querySelector('[data-returned]')!.textContent).toContain('Returned to Bo: it asked relay-hardening to do work.');
  await act(() => [...document.querySelectorAll('button')].find(element => element.textContent?.includes('workaround'))!.click());
  expect(document.querySelector('[data-returned]')).toBeNull();
  expect([...document.querySelectorAll<HTMLElement>('[data-topic]')].map(element => element.dataset.topic)).toEqual(['sqlite 2 mb cap']);
});

it('suggests a topic from the text, autocompletes active topics, and names a similar one', async () => {
  const props = await open();
  await type(field('Post'), 'Deploy dry run is 9 MB. Startup is close to the limit.');
  expect(field('Topic').value).toBe('Deploy dry run is 9');
  await act(() => field('Topic').dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
  await type(field('Topic'), 'sqlite');
  const options = [...document.querySelectorAll('[role="option"]')].map(option => option.textContent);
  expect(options).toEqual([expect.stringContaining('SQLite 2 MB cap')]);
  await type(field('Topic'), 'bun test hangs');
  expect(pane()!.textContent).toContain('Similar active topic: bun test hang (2 posts)');
  const postThere = [...document.querySelectorAll('button')].find(element => element.textContent === 'Post there')!;
  await act(() => postThere.click());
  expect(field('Topic').value).toBe('bun test hang');
  expect(pane()!.textContent).not.toContain('Similar active topic');
  await act(() => pane()!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(props.onPost).toHaveBeenCalledWith({ topic: 'bun test hang', kind: 'status', text: 'Deploy dry run is 9 MB. Startup is close to the limit.' });
});

it('badges the button with the unread posts of other authors, rose when one is a tooling post', async () => {
  const props = await render();
  expect(button().getAttribute('aria-label')).toBe('Chatter');
  expect(button().querySelector('[data-unread]')).toBeNull();
  const own = { kind: 'workspace' as const, id: 'ws-1', name: 'this workspace' };
  const state = mergeChatter(props.state, [post(5, 'sqlite 2 mb cap', 'Moved it to R2.', 'tooling', own), post(6, 'sqlite 2 mb cap', 'Also on R2.', 'workaround', bo)], [], { cursor: 6 });
  await render({ ...props, state });
  expect(button().getAttribute('aria-label')).toBe('Chatter, 1 unread');
  const badge = () => button().querySelector<HTMLElement>('[data-unread]')!;
  expect(badge().textContent).toBe('1');
  expect(badge().style.background).toBe(badgeColors.blue);
  await render({ ...props, state: mergeChatter(state, [post(7, 'bun test hang', 'And on CI.', 'tooling', bo)], [], { cursor: 7 }) });
  expect(badge().textContent).toBe('2');
  expect(badge().style.background).toBe(badgeColors.rose);
});

it('drops the pane under the button, right-aligned to it, above the composer; a narrow panel gets it panel-wide', async () => {
  panel.getBoundingClientRect = () => new DOMRect(200, 0, 1000, 900);
  composer.getBoundingClientRect = () => new DOMRect(200, 700, 1000, 200);
  await render();
  button().getBoundingClientRect = () => new DOMRect(1000, 10, 80, 28);
  await act(() => button().click());
  expect(pane()!.style.cssText).toBe('top: 44px; height: 540px; width: 392px; left: 688px;');
  await act(() => button().click());
  panel.getBoundingClientRect = () => new DOMRect(0, 0, 390, 844);
  composer.getBoundingClientRect = () => new DOMRect(0, 500, 390, 344);
  await act(() => button().click());
  expect(pane()!.style.cssText).toBe('top: 44px; height: 444px; width: 366px; left: 12px;');
});

it('opens on click, marking posts read; Escape or a click outside closes it and returns focus to the button', async () => {
  const props = await render();
  await render({ ...props, state: mergeChatter(props.state, [post(5, 'sqlite 2 mb cap', 'Also on R2.', 'tooling', bo)], [], { cursor: 5 }) });
  expect(button().getAttribute('aria-label')).toBe('Chatter, 1 unread');
  await act(() => button().click());
  expect(button().getAttribute('aria-expanded')).toBe('true');
  expect(pane()!.textContent).toContain('Also on R2.');
  expect(button().getAttribute('aria-label')).toBe('Chatter');
  await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(pane()).toBeNull();
  expect(document.activeElement).toBe(button());
  expect(button().querySelector('[data-unread]')).toBeNull();
  await act(() => button().dispatchEvent(new Event('pointerdown', { bubbles: true })));
  await act(() => button().click());
  await act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(pane()).toBeNull();
  await act(() => button().click());
  await act(() => pane()!.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(pane()).not.toBeNull();
  await act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(pane()).toBeNull();
});

it('moves the events it holds under a merged topic to the topic it went into', () => {
  const merged = mergeChatter(mergeChatter(EMPTY_CHATTER, [post(1, 'bun test hangs', 'one'), post(2, 'bun test hang', 'two')], [topic('bun test hangs', 'bun test hangs', 1), topic('bun test hang', 'bun test hang', 1)]), [
    { type: 'topic', offset: 3, id: 'line', at, topicKey: 'bun test hang', author: ada, change: { kind: 'merge', from: 'bun test hangs', fromDisplay: 'bun test hangs' } },
  ], [topic('bun test hang', 'bun test hang', 2)]);
  expect(merged.events.map(event => event.topicKey)).toEqual(['bun test hang', 'bun test hang', 'bun test hang']);
  expect([...merged.topics.keys()]).toEqual(['bun test hang']);
});
