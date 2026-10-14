import { liveKeyId, MAX_LIVE_SUBSCRIPTIONS, type LiveKey, type LiveNotice } from '@gitspace/protocol/live-notice';
import type { StreamEvent } from '@gitspace/protocol-sync';
import type { SynchronizationSource } from './synchronization.js';

/** `null`: the socket (re)opened, so notices sent while it was down are lost and every watcher refetches. */
type NoticeListener = (version: number | null) => void;
type LiveRead<T> = (after: number | null, signal: AbortSignal) => Promise<{ status: 'ok'; value: readonly StreamEvent<T>[] } | { status: 'error'; error: Error }>;

/** The tab's subscriptions, multiplexed over whichever account directory socket is open. Keys outlive sockets. */
export class LiveNotices {
  private readonly watched = new Map<string, { key: LiveKey; listeners: Set<NoticeListener> }>();
  private socket: WebSocket | null = null;

  watch(key: LiveKey, listener: NoticeListener): () => void {
    const id = liveKeyId(key);
    let entry = this.watched.get(id);
    if (!entry) {
      entry = { key, listeners: new Set() };
      this.watched.set(id, entry);
      this.send('subscribe', [key]);
    }
    entry.listeners.add(listener);
    return () => {
      const current = this.watched.get(id);
      if (!current?.listeners.delete(listener) || current.listeners.size > 0) return;
      this.watched.delete(id);
      this.send('unsubscribe', [current.key]);
    };
  }

  /** The socket is open: subscribe every watched key again, then have every watcher refetch. */
  attach(socket: WebSocket): void {
    this.socket = socket;
    const keys = [...this.watched.values()].map(entry => entry.key);
    for (let start = 0; start < keys.length; start += MAX_LIVE_SUBSCRIPTIONS) this.send('subscribe', keys.slice(start, start + MAX_LIVE_SUBSCRIPTIONS));
    for (const entry of [...this.watched.values()]) for (const listener of [...entry.listeners]) listener(null);
  }

  detach(socket: WebSocket): void {
    if (this.socket === socket) this.socket = null;
  }

  receive(notice: LiveNotice): void {
    const entry = this.watched.get(liveKeyId(notice));
    for (const listener of [...entry?.listeners ?? []]) listener(notice.version);
  }

  private send(type: 'subscribe' | 'unsubscribe', keys: LiveKey[]): void {
    // 1 = OPEN. A closed or connecting socket learns every key on `attach`.
    if (this.socket?.readyState === 1 && keys.length > 0) this.socket.send(JSON.stringify({ type, keys }));
  }
}

export const liveNotices = new LiveNotices();

/** Yields once now, then once per burst of notices for `keys` or socket reopen. Notices arriving while the consumer works
 * between yields queue exactly one more yield: one refetch in flight plus at most one more. */
export async function* liveTicks(keys: readonly LiveKey[], signal: AbortSignal, notices: LiveNotices = liveNotices): AsyncGenerator<void> {
  let pending = true;
  let wake: (() => void) | null = null;
  const notify = () => { pending = true; wake?.(); };
  const stops = keys.map(key => notices.watch(key, notify));
  signal.addEventListener('abort', notify);
  try {
    while (!signal.aborted) {
      if (!pending) {
        const ready = Promise.withResolvers<void>();
        wake = ready.resolve;
        await ready.promise;
        wake = null;
        continue;
      }
      pending = false;
      yield;
    }
  } finally {
    signal.removeEventListener('abort', notify);
    for (const stop of stops) stop();
  }
}

/** A synchronized resource read with a cursor query: refetched after its cursor on every notice burst for `keys`. */
export function liveSource<T>(keys: readonly LiveKey[], read: LiveRead<T>, notices: LiveNotices = liveNotices): SynchronizationSource<T> {
  return async function* (after, signal) {
    let cursor = after;
    for await (const _tick of liveTicks(keys, signal, notices)) {
      const result = await read(cursor, signal);
      if (signal.aborted) return;
      if (result.status === 'error') {
        yield result;
        return;
      }
      if (result.value.length === 0) yield { status: 'open' };
      for (const event of result.value) {
        yield { status: 'ok', value: event };
        cursor = event.cursor;
      }
    }
  };
}
