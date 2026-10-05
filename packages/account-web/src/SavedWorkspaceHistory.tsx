import { useRef } from 'react';
import { useResultQuery } from 'result-rpc/react';
import { ScrollArea } from '@gitspace/ui';
import { rpcClient } from './rpc-client.js';
import { useRetainedQueryValue } from './useRetainedRead.js';
import { useTranscriptHistory, type TranscriptHistorySource } from './useTranscriptHistory.js';
import { EmptyState, TranscriptHistoryNotice } from './GitSpaceShell.js';
import { VirtualTranscript } from './VirtualTranscript.js';
import { rpcErrorMessage } from './rpc-error-message.js';

/** Legacy transcripts remain inspectable, but never resume the retired machine agent. */
export function SavedWorkspaceHistory({ projectId, workspaceId }: { projectId: string; workspaceId: string | null }) {
  const query = useResultQuery(rpcClient.inspector.view, { projectId, workspaceId });
  const saved = useRetainedQueryValue(query, JSON.stringify([projectId, workspaceId]));
  const source = useRef<TranscriptHistorySource | null>(null);
  source.current = saved && saved.savedTranscript.status !== 'none' ? {
    key: JSON.stringify(['saved', projectId, workspaceId, saved.checkpoint?.sessionId, saved.checkpoint?.generation, saved.checkpoint?.createdAt]),
    revision: saved,
    page: async (request, signal) => { const result = await rpcClient.inspector.transcriptPage({ projectId, workspaceId, ...request }, { signal }); if (result.status === 'error') throw result.error; return result.value; },
    content: async (request, signal) => { const result = await rpcClient.inspector.transcriptContent({ projectId, workspaceId, ...request }, { signal }); if (result.status === 'error') throw result.error; return result.value; },
  } : null;
  const history = useTranscriptHistory(source.current);
  return <div className="flex min-h-0 flex-1 flex-col"><TranscriptHistoryNotice loading={history.initialLoading || query.state === 'pending'} error={query.state === 'failure' ? rpcErrorMessage(query.error, 'Read saved history') : history.error} onRetry={() => { history.refresh(); void query.refetch(); }} /><ScrollArea className="min-h-0 flex-1" viewportClassName="h-full">{source.current ? <VirtualTranscript history={history} transport={[]} /> : saved ? <EmptyState title="No saved OMP transcript" description="New conversations are stored in the cloud workspace. This view only reads previously saved OMP history." /> : null}</ScrollArea></div>;
}
