import { useMemo } from 'react';
import type { RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { Button } from '@gitspace/ui';
import { rpcClient } from './rpc-client.js';
import { useTranscriptHistory, type TranscriptHistorySource } from './useTranscriptHistory.js';
import { VirtualTranscript } from './VirtualTranscript.js';

/** Inspector-only history. No composer, question answers, or conversation selection. */
export function RuntimeSubagentHistory({ snapshot, conversationId }: { snapshot: RuntimeSnapshot; conversationId: string }) {
  const source = useMemo<TranscriptHistorySource>(() => ({
    key: JSON.stringify([snapshot.projectId, snapshot.workspaceId, conversationId]), revision: snapshot.cursor,
    page: async (request, signal) => {
      const result = await rpcClient.runtime.session({ projectId: snapshot.projectId, workspaceId: snapshot.workspaceId, conversationId, command: { type: 'transcriptPage', request } }, { signal });
      if (result.status === 'error') throw result.error;
      if (!result.value.transcriptPage) throw new Error('The runtime did not return subagent history.');
      return result.value.transcriptPage;
    },
    content: async (request, signal) => {
      const result = await rpcClient.runtime.session({ projectId: snapshot.projectId, workspaceId: snapshot.workspaceId, conversationId, command: { type: 'transcriptContent', request } }, { signal });
      if (result.status === 'error') throw result.error;
      if (!result.value.transcriptContent) throw new Error('The runtime did not return subagent content.');
      return result.value.transcriptContent;
    },
  }), [snapshot.projectId, snapshot.workspaceId, snapshot.cursor, conversationId]);
  const history = useTranscriptHistory(source);
  return <div className="h-96 min-w-0 overflow-y-auto overscroll-contain" data-slot="scroll-area-viewport" role="region" aria-label="Subagent transcript" tabIndex={0}>
    {history.error ? <div role="alert">{history.error}<Button variant="ghost" onClick={history.refresh}>Retry history</Button></div> : null}
    {history.initialLoading ? <p role="status">Loading subagent history…</p> : <VirtualTranscript history={history} transport={[]} inline />}
  </div>;
}
