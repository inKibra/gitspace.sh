import { useResultQuery } from 'result-rpc/react';
import { useToasts } from './toasts.js';
import { rpcClient } from './rpc-client.js';
import { useRetainedQueryValue } from './useRetainedRead.js';
import { useEventRefresh, useProjectChanges } from './SynchronizationProvider.js';
import { WorkspaceCreationPanel } from './WorkspaceCreationPanel.js';
import { ACCOUNT_DIRECTORY_CHANGED } from './routes.js';
import { rpcErrorMessage } from './rpc-error-message.js';

export function CloudCreationProgress({ projectId, workspaceId, onDeleted }: { projectId: string; workspaceId: string; onDeleted(): void }) {
  const query = useResultQuery(rpcClient.inspector.view, { projectId, workspaceId });
  const saved = useRetainedQueryValue(query, JSON.stringify([projectId, workspaceId]));
  useEventRefresh(useProjectChanges(projectId), () => query.refetch());
  const state = saved?.workspace.kind === 'worktree' && (saved.workspace.lifecycle === 'provisioning' || saved.workspace.lifecycle === 'failed') ? saved.workspace.lifecycle : null;
  const failure = query.state === 'failure' && (!state || !saved) ? rpcErrorMessage(query.error, 'Read creation progress') : null;
  useToasts([failure === null ? null : { key: `creation-state:${workspaceId}:${failure}`, tone: 'error', persistent: true, message: `Creation state: ${failure}`, action: { label: 'Retry', onClick: () => void query.refetch() } }]);
  if (!state || !saved) return null;
  return <div className="flex shrink-0 justify-center overflow-auto p-4"><WorkspaceCreationPanel name={saved.workspace.name} state={state} creation={saved.creation}
    onRetry={async () => { const result = await rpcClient.workspace.retryCreate({ workspaceId }); if (result.status === 'error') throw result.error; await query.refetch(); window.dispatchEvent(new Event(ACCOUNT_DIRECTORY_CHANGED)); }}
    onDelete={async () => { const result = await rpcClient.workspace.delete({ workspaceId }); if (result.status === 'error') throw result.error; window.dispatchEvent(new Event(ACCOUNT_DIRECTORY_CHANGED)); onDeleted(); }} /></div>;
}
