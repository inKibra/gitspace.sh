import { useCallback, useEffect, useState } from 'react';
import type { ChatterFileAction, ChatterPost, ChatterTopic, ChatterTopicAction } from '@gitspace/protocol/chatter-contract';
import { projectLiveKey } from '@gitspace/protocol/live-notice';
import { liveTicks } from '../live-notices.js';
import { rpcClient } from '../rpc-client.js';
import { rpcErrorMessage } from '../rpc-error-message.js';

/** Without a notice (a device the account directory socket does not admit), the issues are read again this often. */
const ISSUES_FALLBACK_MS = 60_000;

export type WorkspaceIssues = { topics: readonly ChatterTopic[]; posts: readonly ChatterPost[] };

/** A workspace's issues, as its Issues tab shows them: the Chatter issue topics it posted in and GitSpace's runtime
 * topics for it (`chatter.issues`), read again after each project `chatter` notice; actions act on the topic rows. */
export function useWorkspaceIssues(projectId: string, workspaceId: string) {
  const [issues, setIssues] = useState<WorkspaceIssues | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async (signal?: AbortSignal) => {
    const result = await rpcClient.chatter.issues({ projectId, workspaceId }, { signal });
    if (result.status === 'error') throw result.error;
    setIssues(result.value);
    setError(null);
  }, [projectId, workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    setIssues(null);
    setError(null);
    void (async () => {
      try {
        for await (const _tick of liveTicks([projectLiveKey(projectId, 'chatter')], controller.signal, undefined, () => ISSUES_FALLBACK_MS)) {
          try { await read(controller.signal); }
          catch (cause) { if (!controller.signal.aborted) setError(rpcErrorMessage(cause, 'Read the workspace\'s issues')); }
        }
      } catch (cause) { if (!controller.signal.aborted) setError(rpcErrorMessage(cause, 'Read the workspace\'s issues')); }
    })();
    return () => controller.abort();
  }, [projectId, read]);

  /** Resolves, dismisses, reopens or merges a topic; throws why not. */
  const act = useCallback(async (key: string, action: ChatterTopicAction) => {
    const result = await rpcClient.chatter.topicAct({ projectId, key, action });
    if (result.status === 'error') throw result.error;
    await read();
  }, [projectId, read]);

  /** Files a topic with GitSpace or returns its GitHub draft link; throws why not. */
  const file = useCallback(async (key: string, action: ChatterFileAction) => {
    const result = await rpcClient.chatter.fileIssue({ projectId, workspaceId, key, action });
    if (result.status === 'error') throw result.error;
    await read();
    return result.value.shareDraft;
  }, [projectId, workspaceId, read]);

  return { issues, error, act, file };
}
