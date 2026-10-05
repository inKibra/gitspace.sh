import { useCallback, useEffect, useRef, useState } from 'react';
import { RuntimeIdentitySchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand, RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

export interface CloudSessionControls {
  result: RuntimeSessionResult | null;
  error: string | null;
  pending: boolean;
  run(command: RuntimeSessionCommand, signal?: AbortSignal): Promise<RuntimeSessionResult>;
}

export function useCloudSessionControls(snapshot: RuntimeSnapshot, conversationId: string | undefined): CloudSessionControls {
  const [accepted, setAccepted] = useState<{ key: string; value: RuntimeSessionResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const live = useRef(true);
  const revision = useRef(0);
  const projectId = snapshot.projectId;
  const workspaceId = snapshot.workspaceId;
  const key = JSON.stringify([projectId, workspaceId, conversationId]);
  const run = useCallback(async (command: RuntimeSessionCommand, signal?: AbortSignal) => {
    const request = ++revision.current;
    if (live.current) { setPending(true); setError(null); }
    try {
      const response = await rpcClient.runtime.session({ ...RuntimeIdentitySchema.parse({ projectId, workspaceId }), ...(conversationId ? { conversationId } : {}), command }, { signal });
      if (response.status === 'error') throw response.error;
      if (live.current && request === revision.current) setAccepted({ key, value: response.value });
      return response.value;
    } catch (cause) {
      if (live.current && !signal?.aborted && request === revision.current) setError(rpcErrorMessage(cause, 'Cloud session control'));
      throw cause;
    } finally { if (live.current && request === revision.current) setPending(false); }
  }, [projectId, workspaceId, conversationId, key]);
  const conversation = snapshot.conversations.find((item) => item.id === conversationId);
  const questionRevision = snapshot.questions.filter((item) => item.conversationId === conversationId).map((item) => `${item.id}:${JSON.stringify(item.answer)}`).join('|');
  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    void run({ type: 'control' }, controller.signal).catch(() => {});
    return () => { controller.abort(); live.current = false; revision.current++; };
  }, [run, conversation?.status, questionRevision]);
  return { result: accepted?.key === key ? accepted.value : null, error, pending, run };
}
