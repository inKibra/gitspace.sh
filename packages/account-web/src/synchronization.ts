import { applyStreamEvent, initialStreamState, type StreamEvent, type StreamState } from '@gitspace/protocol-sync';

export type SynchronizationSource<T> = (after: number | null, signal: AbortSignal) => AsyncIterable<{ status: 'ok'; value: StreamEvent<T> } | { status: 'error'; error: Error }>;
export interface SynchronizedValue<T> extends StreamState<T> { connection: 'connecting' | 'open' | 'disconnected'; transportError: Error | null }
interface Channel<T> { value: SynchronizedValue<T>; listeners: Set<() => void>; eventListeners: Set<(event: StreamEvent<T>) => void>; refreshes: Set<() => void>; source: SynchronizationSource<T>; controller: AbortController | null; epoch: number; snapshotRequested: boolean }

/** One channel per authority/resource, irrespective of how many panes observe it. */
export class SynchronizationOwner {
  private readonly channels = new Map<string, unknown>();
  channel<T>(resource: string, source: SynchronizationSource<T>) {
    let channel = this.channels.get(resource) as Channel<T> | undefined;
    if (!channel) {
      channel = { value: { ...initialStreamState<T>(resource), connection: 'connecting', transportError: null }, listeners: new Set(), eventListeners: new Set(), refreshes: new Set(), source, controller: null, epoch: 0, snapshotRequested: false };
      this.channels.set(resource, channel);
    }
    const selected = channel;
    return {
      snapshot: () => selected.value,
      refresh: (): Promise<void> => {
        if (!selected.listeners.size && !selected.eventListeners.size) return Promise.resolve();
        const refreshed = Promise.withResolvers<void>();
        selected.refreshes.add(refreshed.resolve);
        selected.epoch++;
        selected.controller?.abort();
        selected.controller = null;
        selected.snapshotRequested = true;
        selected.value = { ...selected.value, connection: 'connecting', transportError: null };
        for (const listener of selected.listeners) listener();
        this.start(selected);
        return refreshed.promise;
      },
      subscribe: (listener: () => void) => {
        selected.listeners.add(listener);
        if (!selected.controller) this.start(selected);
        return () => {
          selected.listeners.delete(listener);
          if (!selected.listeners.size && !selected.eventListeners.size) this.stop(selected);
        };
      },
      events: (listener: (event: StreamEvent<T>) => void) => {
        selected.eventListeners.add(listener);
        if (!selected.controller) this.start(selected);
        return () => {
          selected.eventListeners.delete(listener);
          if (!selected.listeners.size && !selected.eventListeners.size) this.stop(selected);
        };
      },
    };
  }
  dispose(): void {
    for (const entry of this.channels.values()) this.stop(entry as Channel<unknown>);
    // Preserve handle identities during React's effect teardown/replay. Actual
    // provider unmount releases the owner and its retained values together.
  }
  private stop<T>(channel: Channel<T>): void {
    channel.epoch++;
    channel.controller?.abort();
    channel.controller = null;
    for (const resolve of channel.refreshes) resolve();
    channel.refreshes.clear();
  }
  private start<T>(channel: Channel<T>): void {
    const controller = new AbortController();
    channel.controller = controller;
    const epoch = ++channel.epoch;
    const current = () => channel.epoch === epoch && !controller.signal.aborted;
    const publish = (value: SynchronizedValue<T>) => {
      if (!current()) return;
      channel.value = value;
      for (const listener of channel.listeners) listener();
      if (value.connection !== 'connecting' && !(value.connection === 'open' && value.resync)) {
        for (const resolve of channel.refreshes) resolve();
        channel.refreshes.clear();
      }
    };
    void (async () => {
      let delay = 250;
      while (current()) {
        try {
          const after = channel.snapshotRequested || channel.value.resync ? null : channel.value.cursor;
          channel.snapshotRequested = false;
          for await (const result of channel.source(after, controller.signal)) {
            if (!current()) return;
            if (result.status === 'error') throw result.error;
            const next = applyStreamEvent(channel.value, result.value);
            const accepted = next !== channel.value && !next.resync;
            publish({ ...next, connection: 'open', transportError: null });
            if (accepted) for (const listener of channel.eventListeners) listener(result.value);
            delay = 250;
            // A missing predecessor is not a new state. Request an authoritative
            // snapshot instead of applying a patch across an unavailable range.
            if (next.resync && result.value.type !== 'resync') break;
          }
          if (!current()) return;
          throw new Error('Synchronization delivery disconnected');
        } catch (error) {
          if (!current()) return;
          publish({ ...channel.value, connection: 'disconnected', transportError: error instanceof Error ? error : new Error(String(error)) });
        }
        // This timer retries transport establishment only. It never queries state.
        const retry = Promise.withResolvers<void>();
        const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); retry.resolve(); };
        const timer = setTimeout(finish, delay);
        controller.signal.addEventListener('abort', finish, { once: true });
        if (controller.signal.aborted) finish();
        await retry.promise;
        delay = Math.min(delay * 2, 10_000);
      }
    })();
  }
}
