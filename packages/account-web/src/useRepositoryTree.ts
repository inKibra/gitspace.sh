import { useCallback, useEffect, useRef, useState } from 'react';
import type { RepositoryMode, RepositoryTreeEntry } from '@gitspace/protocol';
import { rpcClient } from './rpc-client.js';

type RepositoryTreeState =
  | { state: 'pending' }
  | { state: 'success'; value: RepositoryTreeEntry[] }
  | { state: 'failure'; error: Error };
const pending: RepositoryTreeState = { state: 'pending' };

/** Publish only complete trees; partial chunks never replace an accepted snapshot. */
export function useRepositoryTree(spaceId: string, expectedGeneration: number, mode: RepositoryMode, scopeKey: string, enabled: boolean) {
  const key = JSON.stringify([spaceId, expectedGeneration, mode, scopeKey, enabled]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const active = useRef<{ key: string; controller: AbortController; promise: Promise<void> } | null>(null);
  const [snapshot, setSnapshot] = useState<{ key: string; result: RepositoryTreeState }>({ key, result: pending });
  const refetch = useCallback((): Promise<void> => {
    if (!enabled) return Promise.resolve();
    if (active.current?.key === key && !active.current.controller.signal.aborted) return active.current.promise;
    active.current?.controller.abort();
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && currentKey.current === key;
    setSnapshot({ key, result: pending });
    const promise = Promise.resolve().then(async () => {
      try {
        const entries: RepositoryTreeEntry[] = [];
        for await (const chunk of rpcClient.inspector.repository.tree({ spaceId, expectedGeneration, mode, path: null }, { signal: controller.signal })) {
          if (!current()) return;
          if (chunk.status === 'error') throw chunk.error;
          for (const entry of chunk.value) entries.push(entry);
        }
        if (current()) setSnapshot({ key, result: { state: 'success', value: entries } });
      } catch (error) {
        if (current()) setSnapshot({ key, result: { state: 'failure', error: error instanceof Error ? error : new Error('Repository tree stream failed.') } });
      } finally {
        if (active.current?.controller === controller) active.current = null;
      }
    });
    active.current = { key, controller, promise };
    return promise;
  }, [key, enabled, spaceId, expectedGeneration, mode]);
  useEffect(() => {
    void refetch();
    return () => { active.current?.controller.abort(); };
  }, [refetch]);
  return { ...(snapshot.key === key ? snapshot.result : pending), refetch };
}
