import { describe, expect, test } from 'bun:test';
import { applyStreamEvent, decodeChangeStream, initialStreamState, type StreamEvent } from '../src/index.js';

const resource = 'environment:space';
const snapshot = (cursor: number, value: string): StreamEvent<string> => ({ type: 'snapshot', resource, cursor, revision: cursor, previous: null, value });
const change = (previous: number, cursor: number, value: string): StreamEvent<string> => ({ type: 'change', resource, previous, cursor, revision: cursor, value });

describe('authoritative synchronization boundaries', () => {
  test('replay duplicates and delayed failures cannot regress recovered state', () => {
    const failed = applyStreamEvent(initialStreamState<string>(resource), snapshot(12, 'failed'));
    const recovered = applyStreamEvent(failed, change(12, 18, 'ready'));
    expect(applyStreamEvent(recovered, change(12, 18, 'failed'))).toBe(recovered);
    expect(applyStreamEvent(recovered, snapshot(12, 'failed'))).toBe(recovered);
    expect(recovered.value).toBe('ready');
    expect(applyStreamEvent(recovered, { type: 'resync', resource, cursor: 12, revision: 12, reason: 'cursor-expired' })).toBe(recovered);
  });
  test('a missing predecessor retains last good state until an authoritative snapshot', () => {
    const ready = applyStreamEvent(initialStreamState<string>(resource), snapshot(10, 'ready'));
    const gap = applyStreamEvent(ready, change(12, 15, 'failed'));
    expect(gap).toMatchObject({ value: 'ready', cursor: 10, resync: true });
    expect(applyStreamEvent(gap, change(10, 16, 'failed')).value).toBe('ready');
    expect(applyStreamEvent(gap, snapshot(16, 'cancelled'))).toMatchObject({ value: 'cancelled', cursor: 16, resync: false });
  });
  test('a reset is explicit and cannot cross resource identities', () => {
    const ready = applyStreamEvent(initialStreamState<string>(resource), snapshot(20, 'ready'));
    const reset = applyStreamEvent(ready, { type: 'resync', resource, cursor: 2, revision: 2, reason: 'cursor-ahead' });
    expect(reset.value).toBe('ready');
    expect(applyStreamEvent(reset, snapshot(2, 'unconfigured')).value).toBe('unconfigured');
    expect(() => applyStreamEvent(ready, { ...snapshot(21, 'failed'), resource: 'environment:other' })).toThrow('Unexpected stream resource');
  });
  test('private byte framing handles fragmented UTF-8 and cancels only delivery', async () => {
    const encoded = new TextEncoder().encode(`${JSON.stringify(snapshot(1, 'préparé'))}\n${JSON.stringify(change(1, 3, 'ready'))}\n`);
    let offset = 0;
    let cancelled = false;
    const bytes = new ReadableStream<Uint8Array>({
      pull(controller) { if (offset < encoded.length) controller.enqueue(encoded.slice(offset, ++offset)); },
      cancel() { cancelled = true; },
    });
    const abort = new AbortController();
    const events = decodeChangeStream(bytes, abort.signal);
    expect((await events.next()).value).toMatchObject({ type: 'snapshot', value: 'préparé' });
    expect((await events.next()).value).toMatchObject({ type: 'change', previous: 1, cursor: 3, value: 'ready' });
    abort.abort();
    expect((await events.next()).done).toBe(true);
    expect(cancelled).toBe(true);
  });
});
