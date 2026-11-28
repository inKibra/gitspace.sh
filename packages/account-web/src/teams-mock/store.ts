// A value the mock's pages share and change (memberships, step-ups, audit entries): read it now, set it, or subscribe
// a component so it re-renders when it changes.
import { useSyncExternalStore } from 'react';

export interface Store<T> {
  get(): T;
  set(next: T): void;
  use(): T;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener); };
  const get = (): T => value;
  return {
    get,
    set(next) { value = next; for (const listener of listeners) listener(); },
    use: () => useSyncExternalStore(subscribe, get),
  };
}
