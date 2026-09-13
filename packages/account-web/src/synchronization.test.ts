import { afterEach, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@gitspace/protocol-sync';
import { SynchronizationOwner, type SynchronizationSource } from './synchronization.js';

type Frame = { status: 'ok'; value: StreamEvent<string> } | { status: 'error'; error: Error };
interface Connection { after: number | null; signal: AbortSignal; send(frame: Frame): void }
const snapshot = (cursor: number, value: string): Frame => ({ status: 'ok', value: { type: 'snapshot', resource: 'state', cursor, revision: cursor, previous: null, value } });
const change = (previous: number, cursor: number, value: string): Frame => ({ status: 'ok', value: { type: 'change', resource: 'state', cursor, revision: cursor, previous, value } });
function controlledSource(ignoreAbort = false) {
  const connections: Connection[] = [];
  const source: SynchronizationSource<string> = async function* (after, signal) {
    const frames: Frame[] = [];
    let wake: (() => void) | undefined;
    const notify = () => wake?.();
    connections.push({ after, signal, send: (frame) => { frames.push(frame); notify(); } });
    if (!ignoreAbort) signal.addEventListener('abort', notify, { once: true });
    try {
      while (ignoreAbort || !signal.aborted) {
        const pending = Promise.withResolvers<void>();
        wake = pending.resolve;
        if (frames.length) yield frames.shift()!;
        else await pending.promise;
      }
    } finally { signal.removeEventListener('abort', notify); }
  };
  return { source, connections };
}
const owners: SynchronizationOwner[] = [];
function owner() { const value = new SynchronizationOwner(); owners.push(value); return value; }
afterEach(() => { for (const value of owners.splice(0)) value.dispose(); vi.useRealTimers(); });

it('shares delivery and emits every accepted fact even when renders would coalesce', async () => {
  const stream = controlledSource();
  const channel = owner().channel('state', stream.source);
  const received: string[] = [];
  const settled = Promise.withResolvers<void>();
  const stopFirst = channel.subscribe(() => undefined);
  const stopSecond = channel.events((event) => { if (event.type !== 'resync') received.push(event.value); if (received.length === 3) settled.resolve(); });
  stream.connections[0]!.send(snapshot(1, 'accepted'));
  stream.connections[0]!.send(change(1, 2, 'running'));
  stream.connections[0]!.send(change(2, 4, 'ready'));
  await settled.promise;
  expect(received).toEqual(['accepted', 'running', 'ready']);
  expect(stream.connections).toHaveLength(1);
  stopFirst();
  expect(stream.connections[0]!.signal.aborted).toBe(false);
  stopSecond();
  expect(stream.connections[0]!.signal.aborted).toBe(true);
});

it('reconnects from the last accepted cursor without clearing the last good value', async () => {
  vi.useFakeTimers();
  const stream = controlledSource();
  const channel = owner().channel('state', stream.source);
  const disconnected = Promise.withResolvers<void>();
  channel.subscribe(() => { if (channel.snapshot().connection === 'disconnected') disconnected.resolve(); });
  stream.connections[0]!.send(snapshot(8, 'ready'));
  stream.connections[0]!.send({ status: 'error', error: new Error('Connection lost') });
  await disconnected.promise;
  expect(channel.snapshot()).toMatchObject({ value: 'ready', cursor: 8, connection: 'disconnected' });
  await vi.advanceTimersByTimeAsync(250);
  expect(stream.connections[1]!.after).toBe(8);
  const recovered = Promise.withResolvers<void>();
  channel.subscribe(() => { if (channel.snapshot().connection === 'open') recovered.resolve(); });
  stream.connections[1]!.send(change(8, 10, 'working'));
  await recovered.promise;
  expect(channel.snapshot()).toMatchObject({ value: 'working', cursor: 10, transportError: null });
});

it('fences late errors from a replaced transport and stale explicit-refresh snapshots', async () => {
  const stream = controlledSource(true);
  const channel = owner().channel('state', stream.source);
  const ready = Promise.withResolvers<void>();
  channel.subscribe(() => { if (channel.snapshot().cursor === 9) ready.resolve(); });
  stream.connections[0]!.send(snapshot(9, 'ready'));
  await ready.promise;
  const refreshed = channel.refresh();
  expect(stream.connections[1]!.after).toBeNull();
  stream.connections[1]!.send(snapshot(8, 'failed'));
  await refreshed;
  stream.connections[0]!.send({ status: 'error', error: new Error('Old request failed') });
  await Promise.resolve();
  await Promise.resolve();
  expect(channel.snapshot()).toMatchObject({ value: 'ready', cursor: 9, connection: 'open', transportError: null });
});
