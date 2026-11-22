// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import type { GhostQuery, GhostServerMessage } from '@gitspace/protocol-runtime';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@gitspace/ui';
import { renderHook } from '@testing-library/react';
import { askGhost, citeGhost, closeGhost, dismissGhost, setGhostPlacement, summonGhost, useGhostRequest, useGhosts, type GhostSocket, type GhostSubject } from './ghost-store.js';
import { GhostDock, GhostLayer } from './GhostWindow.js';
import { GhostEntry, GhostMainTranscript, GhostWorkspace } from './GhostEntry.js';

/** A ghost socket the test plays the object's side of. */
class FakeSocket extends EventTarget {
  readyState: WebSocket['readyState'] = WebSocket.OPEN;
  sent: unknown[] = [];
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')); }
  play(message: GhostServerMessage): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
}
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const subject: GhostSubject = { projectId: 'project', workspaceId: 'workspace', workspaceName: 'exports', archived: false, conversationId: null, title: null, until: null };
const ready = (until: number | null = null): GhostServerMessage => ({ type: 'ready', ghostId: 'g', conversationId: '1', title: 'Main', main: true, entries: 3, until, archived: false, driveAsOf: at(0), expiresAt: at(10), model: 'openai/fast' });
const answer = (draft: string | null): GhostServerMessage => ({ type: 'answer', turn: 1, parts: ['The archive bucket ', { kind: 'entry', from: 2 }], draft, rounds: 1, truncated: false, expiresAt: at(10) });

/** Summons a ghost on a fake socket; the query it opened with is kept. */
async function open(of: GhostSubject = subject, options: { about?: number; question?: string } = {}): Promise<{ socket: FakeSocket; query: GhostQuery | null }> {
  const socket = new FakeSocket();
  const opened: GhostSocket = socket;
  const seen: { query: GhostQuery | null } = { query: null };
  summonGhost(of, options, async query => { seen.query = query; return opened; });
  await Promise.resolve();
  return { socket, query: seen.query };
}
const state = () => renderHook(() => useGhosts()).result.current;
afterEach(() => {
  for (const ghost of state().ghosts) dismissGhost(ghost.key);
  setGhostPlacement('float');
  document.body.innerHTML = '';
});

it('asks through the socket, builds the answer from its stream, and a citation asks the workspace view to show it', async () => {
  const { socket } = await open();
  const key = state().active!;
  socket.play(ready());
  askGhost(key, 'Where do exports go?');
  expect(socket.sent).toEqual([{ type: 'ask', text: 'Where do exports go?' }]);
  socket.play({ type: 'text', turn: 1, round: 1, delta: 'The archive ' });
  // Asking again while it answers sends nothing.
  askGhost(key, 'And why?');
  expect(socket.sent).toHaveLength(1);
  socket.play(answer(null));
  expect(citeGhost(key, { kind: 'entry', from: 2 })).toEqual(subject);
  expect(renderHook(() => useGhostRequest('workspace')).result.current).toMatchObject({ kind: 'entry', ordinal: 2048 });
});

it('entry points open a ghost scoped to them: about an entry, from a point in time, of another conversation', async () => {
  const about = await open(subject, { about: 7 });
  const aboutKey = state().active!;
  expect(state().ghosts.find(ghost => ghost.key === aboutKey)).toMatchObject({ about: 7, input: 'Why did the agent do this?' });
  about.socket.play(ready());
  askGhost(aboutKey, 'Why did the agent do this?');
  expect(about.socket.sent).toEqual([{ type: 'ask', text: 'Why did the agent do this?', about: 7 }]);

  expect((await open({ ...subject, until: 88 })).query).toEqual({ projectId: 'project', workspaceId: 'workspace', until: '88' });
  expect((await open({ ...subject, conversationId: 'subagent-1', title: 'tests' })).query).toEqual({ projectId: 'project', workspaceId: 'workspace', conversationId: 'subagent-1' });
});

it('keeps several ghosts: a session already read is brought back, not opened twice, and a question asked before it is ready waits for it', async () => {
  const first = await open();
  first.socket.play(ready());
  const firstKey = state().active!;
  const second = await open({ ...subject, workspaceId: 'billing', workspaceName: 'billing' }, { question: 'What is it doing now?' });
  expect(state().ghosts).toHaveLength(2);
  expect(second.socket.sent).toEqual([]);
  second.socket.play(ready());
  expect(second.socket.sent).toEqual([{ type: 'ask', text: 'What is it doing now?' }]);
  // Summoning the first session again focuses it and makes it glow.
  summonGhost(subject, {}, async () => { throw new Error('opened twice'); });
  expect(state()).toMatchObject({ active: firstKey });
  expect(state().ghosts).toHaveLength(2);
  expect(state().ghosts.find(ghost => ghost.key === firstKey)?.pulse).toBe(1);
  closeGhost(firstKey);
  expect(first.socket.sent).toContainEqual({ type: 'close' });
  expect(state().ghosts.find(ghost => ghost.key === firstKey)?.ended).toMatchObject({ reason: 'closed' });
});

/** Renders `node` and returns its container. */
async function render(node: ReactElement): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  await act(async () => createRoot(container).render(createElement(TooltipProvider, null, node)));
  return container;
}

it('floating, the open ghost is a window and the others pills with a ring; docked, a column with a tab per ghost and a start page', async () => {
  const one = await open();
  one.socket.play(ready());
  const two = await open({ ...subject, workspaceId: 'billing', workspaceName: 'billing' });
  two.socket.play(ready());
  const floating = await render(createElement(GhostLayer, { onOpenWorkspace: () => undefined }));
  expect(floating.querySelector('[aria-label="Ghost of billing"]')?.tagName).toBe('SECTION');
  expect(floating.querySelectorAll('[data-ghost-pill]')).toHaveLength(1);
  expect(floating.querySelector('[data-ghost-pill] [data-idle-ring]')).not.toBeNull();

  await act(async () => setGhostPlacement('dock'));
  expect(floating.querySelector('[data-ghosts="float"]')).toBeNull();
  const docked = await render(createElement(GhostDock, { here: subject }));
  expect([...docked.querySelectorAll('[role="tab"]')].map(tab => tab.getAttribute('aria-label'))).toEqual(['Ghost of exports', 'Ghost of billing', 'New ghost']);
  await act(async () => docked.querySelector<HTMLButtonElement>('[aria-label="New ghost"]')?.click());
  await vi.waitFor(() => expect(docked.querySelector('[data-ghost-start]')?.textContent).toContain('Ask a ghost about exports'));
});

it('a draft offers Put in composer and Copy, for the agent in its workspace', async () => {
  const { socket } = await open();
  socket.play(ready());
  askGhost(state().active!, 'Merge it.');
  socket.play(answer('Please merge the export change.'));
  const shown = await render(createElement(GhostLayer, { onOpenWorkspace: () => undefined }));
  await vi.waitFor(() => expect(shown.querySelector('[aria-label="Draft"]')?.textContent).toContain('for the agent in exports'));
  expect([...shown.querySelectorAll('[aria-label="Draft"] button')].map(button => button.textContent)).toEqual(['Put in composer', 'Copy']);
});

it('a transcript entry of the main conversation asks a ghost about itself; a compaction row starts one from that point', async () => {
  const entry = (compaction: boolean, main: boolean) => createElement(GhostWorkspace.Provider, { value: subject }, createElement(GhostMainTranscript.Provider, { value: main }, createElement(GhostEntry, { ordinal: 5 * 1024 + 3, compaction, children: 'entry' })));
  const shown = await render(entry(true, true));
  await act(async () => shown.querySelector<HTMLButtonElement>('[aria-label="Ask a ghost about this"]')?.click());
  expect(state().ghosts.at(-1)).toMatchObject({ subject: { workspaceId: 'workspace', until: null }, about: 5 });
  await act(async () => shown.querySelector<HTMLButtonElement>('[aria-label="Ask a ghost from here"]')?.click());
  expect(state().ghosts.at(-1)).toMatchObject({ subject: { until: 5 }, about: null });
  // Another transcript (a subagent's, in the Inspector) offers nothing.
  const other = await render(entry(false, false));
  expect(other.querySelector('[aria-label="Ask a ghost about this"]')).toBeNull();
});
