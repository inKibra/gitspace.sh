import type { SessionControlView } from '@gitspace/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rpcClient } from './rpc-client.js';
import { useRetainedRead } from './useRetainedRead.js';

type ControlQuery = { state: 'pending' } | { state: 'success'; value: SessionControlView } | { state: 'failure'; error: Error };

/** Controls belong to one live lease, not the persisted session ID used by the RPC. */
export function useLiveSessionControls(sessionId: string, ompSessionId: string, runtimeKey: string | null, revision: unknown) {
  const [snapshot, setSnapshot] = useState<{ key: string | null; query: ControlQuery; fetching: boolean }>({ key: null, query: { state: 'pending' }, fetching: false });
  const active = useRef(runtimeKey);
  active.current = runtimeKey;
  const request = useRef<AbortController | null>(null);
  const refetch = useCallback(async (): Promise<void> => {
    if (runtimeKey === null || active.current !== runtimeKey) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSnapshot((current) => ({ key: runtimeKey, query: current.key === runtimeKey ? current.query : { state: 'pending' }, fetching: true }));
    try {
      const result = await rpcClient.session.control({ sessionId }, { signal: controller.signal });
      if (controller.signal.aborted || active.current !== runtimeKey) return;
      const query: ControlQuery = result.status === 'error'
        ? { state: 'failure', error: result.error }
        : result.value.sessionId === ompSessionId ? { state: 'success', value: result.value }
          : { state: 'failure', error: new Error('Agent controls returned a different session. Refresh the workspace.') };
      setSnapshot({ key: runtimeKey, query, fetching: false });
    } catch (cause) {
      if (controller.signal.aborted || active.current !== runtimeKey) return;
      setSnapshot({ key: runtimeKey, query: { state: 'failure', error: cause instanceof Error ? cause : new Error(String(cause)) }, fetching: false });
    }
  }, [sessionId, ompSessionId, runtimeKey]);
  useEffect(() => {
    void refetch();
    return () => { request.current?.abort(); };
  }, [refetch, revision]);
  const query: ControlQuery = snapshot.key === runtimeKey && runtimeKey !== null ? snapshot.query : { state: 'pending' };
  const read = useRetainedRead({ ...query, fetch: snapshot.fetching ? 'fetching' : 'idle' }, runtimeKey);
  return { ...read, refetch };
}
