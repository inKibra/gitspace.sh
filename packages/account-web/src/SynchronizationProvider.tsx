import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StreamEvent } from '@gitspace/protocol-sync';
import { SynchronizationOwner, type SynchronizationSource, type SynchronizedValue } from './synchronization.js';
import { rpcClient, routedTransport } from './rpc-client.js';
import { flushIncidentOutbox } from './incident-outbox.js';

export const SynchronizationContext = createContext<SynchronizationOwner | null>(null);
export function useSynchronizationOwner(): SynchronizationOwner {
  const owner = useContext(SynchronizationContext);
  if (!owner) throw new Error('SynchronizationProvider is required');
  return owner;
}
export function useSynchronizedResource<T>(resource: string, source: SynchronizationSource<T>) {
  const owner = useSynchronizationOwner();
  const channel = useMemo(() => owner.channel(resource, source), [owner, resource]);
  const value = useSyncExternalStore(channel.subscribe, channel.snapshot, channel.snapshot);
  return { ...value, refetch: channel.refresh };
}
export function useEnvironmentSynchronization(spaceId: string) {
  return useSynchronizedResource(`environment:${spaceId}`, (after, signal) => rpcClient.environment.events({ spaceId, after }, { signal }));
}
/** Event consumers see every accepted frame, including frames React batches into one render. */
export function useSynchronizedEvents<T>(resource: string, source: SynchronizationSource<T>, consume: (event: StreamEvent<T>) => void): void {
  const owner = useSynchronizationOwner();
  const callback = useRef(consume);
  callback.current = consume;
  useEffect(() => owner.channel(resource, source).events((event) => callback.current(event)), [owner, resource]);
}
export function useSpaceSynchronization(spaceId: string) {
  return useSynchronizedResource(`space:${spaceId}`, (after, signal) => rpcClient.space.events({ spaceId, after }, { signal }));
}
export function useProjectSynchronization(projectId: string) {
  return useSynchronizedResource(`project:${projectId}`, (after, signal) => rpcClient.project.events({ projectId, after }, { signal }));
}
export function useRuntimeSynchronization(projectId: string) {
  return useSynchronizedResource(`runtime:${projectId}`, (after, signal) => rpcClient.events({ projectId, after }, { signal }));
}
function readSnapshot<T, Value>(snapshot: SynchronizedValue<T> & { refetch(): Promise<void> }, select: (value: T) => Value) {
  const previous = snapshot.value === undefined ? undefined : select(snapshot.value);
  if (snapshot.transportError) return { state: 'failure' as const, error: snapshot.transportError, previous, refetch: snapshot.refetch };
  if (snapshot.value === undefined) return { state: 'pending' as const, refetch: snapshot.refetch };
  return { state: 'success' as const, value: select(snapshot.value), refetch: snapshot.refetch };
}
export function useAccountSettings() {
  const snapshot = useSynchronizedResource('settings', (after, signal) => rpcClient.settings.events({ after }, { signal }));
  return readSnapshot(snapshot, (value) => value.user);
}
export function useAccountGitIdentity() {
  const snapshot = useSynchronizedResource('settings', (after, signal) => rpcClient.settings.events({ after }, { signal }));
  return readSnapshot(snapshot, (value) => value.git);
}
export function useAccountOmpConfiguration() {
  const snapshot = useSynchronizedResource('settings', (after, signal) => rpcClient.settings.events({ after }, { signal }));
  return readSnapshot(snapshot, (value) => value.omp);
}
export function useAccountMachines() {
  const snapshot = useSynchronizedResource('machines', (after, signal) => rpcClient.machine.events({ after }, { signal }));
  return readSnapshot(snapshot, (value) => value);
}
export function useAccountCloudImages() {
  const snapshot = useSynchronizedResource('cloud-images', (after, signal) => rpcClient.machine.image.events({ after }, { signal }));
  return readSnapshot(snapshot, (value) => value);
}
export function useAccountProjects() {
  const snapshot = useSynchronizedResource('projects', (after, signal) => rpcClient.project.directoryEvents({ after }, { signal }));
  return readSnapshot(snapshot, (value) => value);
}
/** Coalesce event-triggered authoritative reads: at most one read plus one dirty bit. */
export function useEventRefresh(cursor: number | null, refresh: () => Promise<unknown> | void, enabled = true): void {
  const current = useRef(refresh);
  current.current = refresh;
  const work = useRef({ busy: false, dirty: false, active: true });
  useEffect(() => { work.current.active = true; return () => { work.current.active = false; }; }, []);
  useEffect(() => {
    if (!enabled || cursor === null) return;
    work.current.dirty = true;
    if (work.current.busy) return;
    work.current.busy = true;
    void (async () => {
      try {
        while (work.current.dirty && work.current.active) {
          work.current.dirty = false;
          try { await current.current(); } catch { /* The retained query owns its readable error. */ }
        }
      } finally { work.current.busy = false; }
    })();
  }, [cursor, enabled]);
}

function AccountSynchronization() {
  const settings = useSynchronizedResource('settings', (after, signal) => rpcClient.settings.events({ after }, { signal }));
  const machines = useSynchronizedResource('machines', (after, signal) => rpcClient.machine.events({ after }, { signal }));
  useEffect(() => {
    if (!machines.value) return;
    routedTransport.invalidate();
  }, [machines.cursor]);
  useEffect(() => {
    const flush = () => { void flushIncidentOutbox(); };
    window.addEventListener('online', flush);
    if (settings.connection === 'open') flush();
    return () => window.removeEventListener('online', flush);
  }, [settings.connection]);
  return null;
}
export function SynchronizationProvider({ children }: { children: ReactNode }) {
  const [owner] = useState(() => new SynchronizationOwner());
  useEffect(() => () => owner.dispose(), [owner]);
  return <SynchronizationContext.Provider value={owner}><AccountSynchronization />{children}</SynchronizationContext.Provider>;
}
