import { useResultQuery } from 'result-rpc/react';
import { Button } from '@gitspace/ui';
import { rpcClient } from './rpc-client.js';
import { useRetainedQueryValue } from './useRetainedRead.js';
import { useEventRefresh, useProjectSynchronization } from './SynchronizationProvider.js';
import { WorkspaceCreationPanel } from './WorkspaceCreationPanel.js';
import { ACCOUNT_DIRECTORY_CHANGED } from './routes.js';
import { rpcErrorMessage } from './rpc-error-message.js';

export function CloudCreationProgress({ projectId, workspaceId, onDeleted }: { projectId: string; workspaceId: string; onDeleted(): void }) {
  const query = useResultQuery(rpcClient.inspector.view, { projectId, workspaceId });
  const saved = useRetainedQueryValue(query, JSON.stringify([projectId, workspaceId]));
  const project = useProjectSynchronization(projectId);
  useEventRefresh(project.cursor, () => query.refetch());
  const state = saved?.workspace.kind === 'worktree' && (saved.workspace.lifecycle === 'provisioning' || saved.workspace.lifecycle === 'failed') ? saved.workspace.lifecycle : null;
  if (!state || !saved) return query.state === 'failure' ? <p role="alert" className="px-4 py-2 text-caption text-destructive">Creation state: {rpcErrorMessage(query.error, 'Read creation progress')}<Button variant="ghost" onClick={() => void query.refetch()}>Retry</Button></p> : null;
  return <div className="flex shrink-0 justify-center overflow-auto p-4"><WorkspaceCreationPanel name={saved.workspace.name} state={state} creation={saved.creation}
    onRetry={async () => { const result = await rpcClient.workspace.retryCreate({ workspaceId }); if (result.status === 'error') throw result.error; await query.refetch(); window.dispatchEvent(new Event(ACCOUNT_DIRECTORY_CHANGED)); }}
    onDelete={async () => { const result = await rpcClient.workspace.delete({ workspaceId }); if (result.status === 'error') throw result.error; window.dispatchEvent(new Event(ACCOUNT_DIRECTORY_CHANGED)); onDeleted(); }} /></div>;
}
