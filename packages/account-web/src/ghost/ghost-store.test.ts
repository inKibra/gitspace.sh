// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import type { GhostServerMessage } from '@gitspace/protocol-runtime';
import { askGhost, citeGhost, closeGhost, dismissGhost, summonGhost, useGhost, useGhostRequest, type Ghost, type GhostSocket } from './ghost-store.js';
import { renderHook } from '@testing-library/react';

/** A ghost socket the test plays the object's side of. */
class FakeSocket extends EventTarget {
  readyState: WebSocket['readyState'] = WebSocket.OPEN;
  sent: unknown[] = [];
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')); }
  play(message: GhostServerMessage): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
}
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const subject = { projectId: 'project', workspaceId: 'workspace', workspaceName: 'exports', archived: false };

async function open(): Promise<{ socket: FakeSocket; ghost(): Ghost | null }> {
  const socket = new FakeSocket();
  const opened: GhostSocket = socket;
  summonGhost(subject, async () => opened);
  await Promise.resolve();
  const view = renderHook(() => useGhost());
  return { socket, ghost: () => { view.rerender(); return view.result.current; } };
}
afterEach(() => { dismissGhost(); });

it('asks through the socket, builds the answer from its stream, and a citation asks the workspace view to show it', async () => {
  const { socket, ghost } = await open();
  socket.play({ type: 'ready', ghostId: 'g', conversationId: '1', title: 'Main', entries: 3, archived: false, driveAsOf: at(0), expiresAt: at(10), model: 'openai/fast' });
  askGhost('Where do exports go?');
  expect(socket.sent).toEqual([{ type: 'ask', text: 'Where do exports go?' }]);
  socket.play({ type: 'read', turn: 1, index: 0, read: { kind: 'search', query: 'bucket', hits: null }, done: false });
  socket.play({ type: 'read', turn: 1, index: 0, read: { kind: 'search', query: 'bucket', hits: 2 }, done: true });
  socket.play({ type: 'text', turn: 1, round: 1, delta: 'The archive ' });
  socket.play({ type: 'text', turn: 1, round: 1, delta: 'bucket' });
  expect(ghost()?.turns.at(-1)).toMatchObject({ role: 'ghost', text: 'The archive bucket', parts: null, reads: [{ index: 0, done: true, read: { hits: 2 } }] });
  // Asking again while it answers sends nothing.
  askGhost('And why?');
  expect(socket.sent).toHaveLength(1);
  socket.play({ type: 'answer', turn: 1, parts: ['The archive bucket ', { kind: 'entry', from: 2 }], draft: null, rounds: 1, truncated: false, expiresAt: at(10) });
  expect(ghost()?.turns.at(-1)).toMatchObject({ parts: ['The archive bucket ', { kind: 'entry', from: 2 }] });
  expect(citeGhost({ kind: 'entry', from: 2 })).toEqual(subject);
  const request = renderHook(() => useGhostRequest('workspace'));
  expect(request.result.current).toMatchObject({ kind: 'entry', ordinal: 2048 });
});

it('closing ends the ghost at once, tells its object, and leaves a tombstone', async () => {
  const { socket, ghost } = await open();
  socket.play({ type: 'ready', ghostId: 'g', conversationId: '1', title: 'Main', entries: 3, archived: false, driveAsOf: at(0), expiresAt: at(10), model: 'openai/fast' });
  closeGhost();
  expect(socket.sent).toEqual([{ type: 'close' }]);
  expect(socket.readyState).toBe(WebSocket.CLOSED);
  expect(ghost()?.ended).toMatchObject({ reason: 'closed', questions: 0 });
});
