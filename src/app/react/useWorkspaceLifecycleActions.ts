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
  deleteWorkspaceSkipScriptsWithPrompt: (target: { ref: BackendScopedWorkspaceRef; workspaceName: string }) => Promise<boolean>;
}

function formatLifecycleError(action: 'set-status' | 'delete', error: AgentSessionCommandError): string {
  if (action === 'set-status') {
    return `Failed to update workspace status: ${error.message}`;
  }
  return `Failed to delete workspace: ${error.message}`;
}


function describeCascade(preview: import('../../types/goals.js').WorkspacePhaseChangePreview): string {
  if (preview.affected.length === 0) {
    return preview.message;
  }
  return `${preview.message}\n\nAlso move:\n${preview.affected.map((item) => `• ${item.workspaceName}: ${item.from} → ${item.to}`).join('\n')}`;
}

export function useWorkspaceLifecycleActions(options: UseWorkspaceLifecycleActionsOptions): UseWorkspaceLifecycleActionsResult {
  const client = useAppClient(options.client ?? null);

  const reportError = useCallback((action: 'set-status' | 'delete', error: AgentSessionCommandError) => {
    options.onError?.(formatLifecycleError(action, error), error);
  }, [options.onError]);

  const setStatus = useCallback(async (workspaceRef: BackendScopedWorkspaceRef, phase: WorkspacePhase): Promise<boolean> => {
    const previewResult = await client.workspaceLifecycle.previewStatus(workspaceRef, phase);
    if (!previewResult.ok) {
      reportError('set-status', previewResult.error);
      return false;
    }

    const apply = async (cascade: boolean): Promise<boolean> => {
      const result = await client.workspaceLifecycle.setStatus(workspaceRef, phase, { cascade });
      if (!result.ok) {
        reportError('set-status', result.error);
        return false;
      }
      return true;
    };
    const preview = previewResult.value;
    if (!preview.allowed) {
      options.flow.showMessage({
        title: 'Phase Change Blocked',
        message: preview.message,
        variant: 'warning',
      });
      return false;
    }
    if (!preview.requiresCascade) {
      return apply(false);
    }
    return new Promise<boolean>((resolve) => {
      options.flow.showConfirm({
        title: 'Move Descendants Back Too?',
        message: describeCascade(preview),
        variant: 'warning',
        confirmLabel: 'Move all',
        cancelLabel: 'Cancel',
        onConfirm: async () => {
          resolve(await apply(true));
        },
        onCancel: async () => {
          resolve(false);
        },
      });
    });
  }, [client, options.flow, reportError]);

  const { deleteWorkspaceWithPrompt, deleteWorkspaceSkipScriptsWithPrompt } = useWorkspaceDeleteFlow({
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
    deleteWorkspaceSkipScriptsWithPrompt,
  };
}
