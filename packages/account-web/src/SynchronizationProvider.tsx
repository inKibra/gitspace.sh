import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StreamEvent } from '@gitspace/protocol-sync';
import { accountLiveKey, projectLiveKey, workspaceLiveKey } from '@gitspace/protocol/live-notice';
import { SynchronizationOwner, type SynchronizationSource, type SynchronizedValue } from './synchronization.js';
import { rpcClient } from './rpc-client.js';
import { flushIncidentOutbox } from './incident-outbox.js';
import { accountDirectorySource } from './account-directory-transport.js';
import { liveNotices, liveState, useLiveChanges } from './live-notices.js';
import { accountDirectorySnapshotSchema, type AccountDirectorySnapshot } from '@gitspace/protocol/account-directory';
import { InferenceStateCodec } from '@gitspace/protocol/inference';
import { settingsStateContract } from '@gitspace/protocol/rpc-contract';
import { ACCOUNT_GROUP, savedCopy, schemaForm, type SavedCopy } from './first-paint-cache.js';

// Account-wide states every page reads once on load: the tab's first socket opening does not read them again.
const settingsSource = liveState('settings', [accountLiveKey('settings')], signal => rpcClient.settings.state({}, { signal }), liveNotices, false);
/** The shell's first paint: what this browser saved of the account's settings, inference profiles and directory. */
const savedSettings = savedCopy(ACCOUNT_GROUP, 'settings', settingsStateContract._def.output);
const savedInference = savedCopy(ACCOUNT_GROUP, 'inference', InferenceStateCodec);
const savedDirectory = savedCopy(ACCOUNT_GROUP, 'directory', schemaForm(accountDirectorySnapshotSchema));

export const SynchronizationContext = createContext<SynchronizationOwner | null>(null);
export function useSynchronizationOwner(): SynchronizationOwner {
  const owner = useContext(SynchronizationContext);
  if (!owner) throw new Error('SynchronizationProvider is required');
  return owner;
}
export function useSynchronizedResource<T>(resource: string, source: SynchronizationSource<T>, saved?: SavedCopy<T>) {
  const owner = useSynchronizationOwner();
  const channel = useMemo(() => owner.channel(resource, source, saved), [owner, resource]);
  const value = useSyncExternalStore(channel.subscribe, channel.snapshot, channel.snapshot);
  return { ...value, refetch: channel.refresh };
}
export function useEnvironmentSynchronization(spaceId: string) {
  return useSynchronizedResource(`environment:${spaceId}`, liveState(`environment:${spaceId}`, [workspaceLiveKey(spaceId, 'environment')], signal => rpcClient.environment.state({ spaceId }, { signal })));
}
/** Event consumers see every accepted frame, including frames React batches into one render. */
export function useSynchronizedEvents<T>(resource: string, source: SynchronizationSource<T>, consume: (event: StreamEvent<T>) => void): void {
  const owner = useSynchronizationOwner();
  const callback = useRef(consume);
  callback.current = consume;
  useEffect(() => owner.channel(resource, source).events((event) => callback.current(event)), [owner, resource]);
}
/** Counts the project's change notices; a consumer refreshes its own reads when the count changes. */
export function useProjectChanges(projectId: string): number | null {
  return useLiveChanges(projectLiveKey(projectId, 'project'));
}
export function useAccountDirectorySnapshot(source: SynchronizationSource<AccountDirectorySnapshot> = accountDirectorySource) {
  return useSynchronizedResource('account-directory', source, source === accountDirectorySource ? savedDirectory : undefined);
}
function readSnapshot<T, Value>(snapshot: SynchronizedValue<T> & { refetch(): Promise<void> }, select: (value: T) => Value) {
  const previous = snapshot.value === undefined ? undefined : select(snapshot.value);
  if (snapshot.transportError) return { state: 'failure' as const, error: snapshot.transportError, previous, refetch: snapshot.refetch };
  if (snapshot.value === undefined) return { state: 'pending' as const, refetch: snapshot.refetch };
  return { state: 'success' as const, value: select(snapshot.value), refetch: snapshot.refetch };
}
export function useAccountSettings() {
  const snapshot = useSynchronizedResource('settings', settingsSource, savedSettings);
  return readSnapshot(snapshot, (value) => value.user);
}
export function useAccountGitIdentity() {
  const snapshot = useSynchronizedResource('settings', settingsSource, savedSettings);
  return readSnapshot(snapshot, (value) => value.git);
}
export function useAccountRuntimeConfiguration() {
  const snapshot = useSynchronizedResource('settings', settingsSource, savedSettings);
  return readSnapshot(snapshot, (value) => value.runtime);
}
export function useAccountInference() {
  const snapshot = useSynchronizedResource('inference', liveState('inference', [accountLiveKey('inference')], signal => rpcClient.inference.list({}, { signal }), liveNotices, false), savedInference);
  return readSnapshot(snapshot, (value) => value);
}
export function useAccountMachines() {
  const snapshot = useAccountDirectorySnapshot();
  return readSnapshot(snapshot, (value) => value.machines);
}
export function useAccountCloudImages() {
  const snapshot = useSynchronizedResource('cloud-images', liveState('cloud-images', [accountLiveKey('cloud-images')], signal => rpcClient.machine.image.list({}, { signal }), liveNotices, false));
  return readSnapshot(snapshot, (value) => value);
}
export function useAccountProjects() {
  const snapshot = useAccountDirectorySnapshot();
  const projects = useMemo(() => snapshot.value?.projects.map((project) => ({
    ...project, archivedAt: project.archivedAt === null ? null : new Date(project.archivedAt), updatedAt: new Date(project.updatedAt),
  })), [snapshot.value?.projects]);
  return readSnapshot(snapshot, () => projects!);
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
  const settings = useSynchronizedResource('settings', settingsSource, savedSettings);
  // The account directory stays connected for the app's lifetime; pages read its retained snapshot.
  useAccountDirectorySnapshot();
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
