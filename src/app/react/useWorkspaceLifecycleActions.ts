import { useCallback } from 'react';
import type { UseFlowReturn } from '../../components/Flow.js';
import type { BackendScopedWorkspaceRef } from '../../machine/multi/types.js';
import type { DeleteWorkspaceParams } from '../../session/backend.js';
import type { WorkspacePhase } from '../../types/config.js';
import { useWorkspaceDeleteFlow, type WorkspaceDeleteContext, type WorkspaceDeleteErrorContext } from '../session/useWorkspaceDeleteFlow.js';
import type { AgentSessionCommandError, AppClient, AppClientContext } from '../client/index.js';
import { useAppClient } from './useAppClient.js';

export interface UseWorkspaceLifecycleActionsOptions {
  client?: AppClient | AppClientContext | null;
  flow: Pick<UseFlowReturn, 'showLoading' | 'showConfirm' | 'showMessage' | 'close'>;
  onError?: (message: string, error: AgentSessionCommandError) => void;
  onBeforeDelete?: (context: WorkspaceDeleteContext) => void | Promise<void>;
  onDeleteSuccess?: (context: WorkspaceDeleteContext) => void | Promise<void>;
  onDeleteCancelled?: (context: WorkspaceDeleteContext) => void | Promise<void>;
  onDeleteError?: (context: WorkspaceDeleteErrorContext) => void | Promise<void>;
  showLoadingDuringDelete?: boolean;
}

export interface UseWorkspaceLifecycleActionsResult {
  setStatus: (workspaceRef: BackendScopedWorkspaceRef, phase: WorkspacePhase) => Promise<boolean>;
  deleteWorkspaceWithPrompt: (target: { ref: BackendScopedWorkspaceRef; workspaceName: string }) => Promise<boolean>;
}

function formatLifecycleError(action: 'set-status' | 'delete', error: AgentSessionCommandError): string {
  if (action === 'set-status') {
    return `Failed to update workspace status: ${error.message}`;
  }
  return `Failed to delete workspace: ${error.message}`;
}

export function useWorkspaceLifecycleActions(options: UseWorkspaceLifecycleActionsOptions): UseWorkspaceLifecycleActionsResult {
  const client = useAppClient(options.client ?? null);

  const reportError = useCallback((action: 'set-status' | 'delete', error: AgentSessionCommandError) => {
    options.onError?.(formatLifecycleError(action, error), error);
  }, [options.onError]);

  const setStatus = useCallback(async (workspaceRef: BackendScopedWorkspaceRef, phase: WorkspacePhase): Promise<boolean> => {
    const result = await client.workspaceLifecycle.setStatus(workspaceRef, phase);
    if (!result.ok) {
      reportError('set-status', result.error);
      return false;
    }
    return true;
  }, [client, reportError]);

  const { deleteWorkspaceWithPrompt } = useWorkspaceDeleteFlow({
    flow: options.flow,
    deleteWorkspace: async (ref, params?: DeleteWorkspaceParams) => {
      const result = await client.workspaceLifecycle.deleteWorkspace(ref, params);
      if (!result.ok) {
        reportError('delete', result.error);
        throw result.error.cause ?? new Error(result.error.message);
      }
    },
    onBeforeDelete: options.onBeforeDelete,
    onDeleteSuccess: options.onDeleteSuccess,
    onDeleteCancelled: options.onDeleteCancelled,
    onDeleteError: options.onDeleteError,
    showLoadingDuringDelete: options.showLoadingDuringDelete,
  });

  return {
    setStatus,
    deleteWorkspaceWithPrompt,
  };
}
