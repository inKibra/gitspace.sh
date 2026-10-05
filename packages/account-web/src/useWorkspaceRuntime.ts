import { useEffect, useRef, useState } from 'react';
import { applyImmutable } from '@earendil-works/chord/delta';
import { RuntimeIdentitySchema, RuntimeSnapshotSchema, RuntimeWatchEventSchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

/** One ordered cloud replica per selected workspace. A gap requests a fresh snapshot, never a replayed mutation. */
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
    const run = async () => {
      let needsSnapshot = latest.current === null;
      let delay = 250;
      while (!controller.signal.aborted) {
        try {
          if (needsSnapshot) {
            const initial = await rpcClient.runtime.snapshot(identity, { signal: controller.signal });
            if (controller.signal.aborted) return;
            if (initial.status === 'error') throw initial.error;
            accept(RuntimeSnapshotSchema.parse(initial.value));
            needsSnapshot = false;
          }
          setConnected(true);
          setError(null);
          for await (const result of rpcClient.runtime.watch({ ...identity, after: latest.current?.cursor ?? null }, { signal: controller.signal })) {
            if (controller.signal.aborted) return;
            if (result.status === 'error') throw result.error;
            const event = RuntimeWatchEventSchema.parse(result.value);
            if (event.type === 'delta') {
              const cursor = latest.current?.cursor;
              if (cursor !== undefined && event.cursor <= cursor) continue;
              if (cursor === undefined || event.baseCursor !== cursor || event.cursor !== cursor + 1) { needsSnapshot = true; break; }
              const next = RuntimeSnapshotSchema.parse(applyImmutable(latest.current, event.ops));
              if (next.cursor !== event.cursor) throw new Error('Runtime delta cursor does not match its committed snapshot.');
              accept(next);
            } else accept(event.snapshot);
            delay = 250;
            setConnected(true);
            setError(null);
          }
          if (controller.signal.aborted) return;
          if (needsSnapshot) {
            setConnected(false);
            continue;
          }
          throw new Error('Workspace stream disconnected. Reconnecting automatically.');
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
