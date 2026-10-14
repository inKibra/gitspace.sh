import { useEffect, useRef, useState } from 'react';
import { applyImmutable } from '@earendil-works/chord/delta';
import { workspaceLiveKey } from '@gitspace/protocol/live-notice';
import { RuntimeIdentitySchema, RuntimeSnapshotSchema, RuntimeWatchEventsSchema, type RuntimeSnapshot, type RuntimeWatchEvent } from '@gitspace/protocol-runtime';
import { liveTicks } from './live-notices.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

/** One ordered cloud replica per selected workspace, refetched after its cursor on every `runtime` notice burst. A gap
 * requests a fresh snapshot, never a replayed mutation. */
export function useWorkspaceRuntime(projectId: string, workspaceId: string) {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [revision, retry] = useState(0);
  const latest = useRef<RuntimeSnapshot | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (latest.current?.projectId !== projectId || latest.current?.workspaceId !== workspaceId) {
      latest.current = null;
      setSnapshot(null);
    }
    setError(null);
    setConnected(false);
    const identity = RuntimeIdentitySchema.parse({ projectId, workspaceId });
    const accept = (value: RuntimeSnapshot) => {
      if (value.projectId !== identity.projectId || value.workspaceId !== identity.workspaceId) throw new Error('Runtime snapshot belongs to another workspace.');
      latest.current = value;
      setSnapshot(value);
    };
    /** Applies one read in order; false when a delta does not chain onto the replica, which then needs a snapshot. */
    const apply = (events: readonly RuntimeWatchEvent[]) => {
      for (const event of events) {
        if (event.type !== 'delta') { accept(event.snapshot); continue; }
        const cursor = latest.current?.cursor;
        if (cursor !== undefined && event.cursor <= cursor) continue;
        if (cursor === undefined || event.baseCursor !== cursor || event.cursor !== cursor + 1) return false;
        const next = RuntimeSnapshotSchema.parse(applyImmutable(latest.current, event.ops));
        if (next.cursor !== event.cursor) throw new Error('Runtime delta cursor does not match its committed snapshot.');
        accept(next);
      }
      return true;
    };
    const read = async (after: number | null) => {
      const result = await rpcClient.runtime.watch({ ...identity, after }, { signal: controller.signal });
      if (result.status === 'error') throw result.error;
      return RuntimeWatchEventsSchema.parse(result.value);
    };
    const run = async () => {
      let delay = 250;
      while (!controller.signal.aborted) {
        try {
          for await (const _tick of liveTicks([workspaceLiveKey(workspaceId, 'runtime', projectId)], controller.signal)) {
            const events = await read(latest.current?.cursor ?? null);
            if (controller.signal.aborted) return;
            if (!apply(events)) {
              const replacement = await read(null);
              if (controller.signal.aborted) return;
              if (!apply(replacement)) throw new Error('Runtime snapshot read did not return a snapshot.');
            }
            delay = 250;
            setConnected(true);
            setError(null);
          }
          return;
        } catch (cause) {
          if (controller.signal.aborted) return;
          setConnected(false);
          setError(rpcErrorMessage(cause, 'Watch cloud workspace'));
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener('abort', finish);
              resolve();
            };
            const timer = setTimeout(finish, Math.floor(delay * (0.5 + Math.random() * 0.5)));
            controller.signal.addEventListener('abort', finish, { once: true });
          });
          delay = Math.min(delay * 2, 10_000);
        }
      }
    };
    void run();
    const reconnect = () => retry((value) => value + 1);
    window.addEventListener('online', reconnect);
    return () => { controller.abort(); window.removeEventListener('online', reconnect); };
  }, [projectId, workspaceId, revision]);
  return { snapshot, connected, error, retry: () => retry((value) => value + 1) };
}
