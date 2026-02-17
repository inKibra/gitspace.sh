import { useCallback } from 'react';
import type { UseFlowReturn } from '../../components/Flow.js';
import type { DeleteWorkspaceParams } from '../../session/backend.js';

export interface WorkspaceDeleteTarget {
  projectName: string;
  workspaceId: string;
  workspaceName: string;
}

export interface WorkspaceDeleteContext {
  target: WorkspaceDeleteTarget;
  params: DeleteWorkspaceParams;
  isRetry: boolean;
}

export interface WorkspaceDeleteErrorContext extends WorkspaceDeleteContext {
  error: unknown;
  message: string;
}

export interface UseWorkspaceDeleteFlowOptions {
  flow: Pick<UseFlowReturn, 'showLoading' | 'showConfirm' | 'showMessage' | 'close'>;
  deleteWorkspace: (
    projectName: string,
    workspaceId: string,
    params?: DeleteWorkspaceParams
  ) => Promise<void>;
  onBeforeDelete?: (context: WorkspaceDeleteContext) => void | Promise<void>;
  onDeleteSuccess?: (context: WorkspaceDeleteContext) => void | Promise<void>;
  onDeleteCancelled?: (context: WorkspaceDeleteContext) => void | Promise<void>;
  onDeleteError?: (context: WorkspaceDeleteErrorContext) => void | Promise<void>;
  showLoadingDuringDelete?: boolean;
}

export interface UseWorkspaceDeleteFlowResult {
  deleteWorkspaceWithPrompt: (target: WorkspaceDeleteTarget) => Promise<boolean>;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = error as { code?: unknown };
  return typeof candidate.code === 'string' ? candidate.code : undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.length > 0) {
    return error;
  }

  return 'Failed to delete workspace';
}

function promptRemoveScriptFailure(
  flow: UseWorkspaceDeleteFlowOptions['flow'],
  workspaceName: string,
  message: string
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    flow.showConfirm({
      title: 'Remove Scripts Failed',
      message:
        `Cleanup scripts failed for workspace "${workspaceName}".\n\n${message}\n\nRemove anyway and skip cleanup scripts?`,
      variant: 'warning',
      confirmLabel: 'Remove anyway',
      cancelLabel: 'Keep workspace',
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

export function useWorkspaceDeleteFlow(
  options: UseWorkspaceDeleteFlowOptions
): UseWorkspaceDeleteFlowResult {
  const {
    flow,
    deleteWorkspace,
    onBeforeDelete,
    onDeleteSuccess,
    onDeleteCancelled,
    onDeleteError,
    showLoadingDuringDelete = false,
  } = options;

  const executeDelete = useCallback(async (
    target: WorkspaceDeleteTarget,
    params: DeleteWorkspaceParams,
    isRetry: boolean
  ): Promise<boolean> => {
    const context: WorkspaceDeleteContext = {
      target,
      params,
      isRetry,
    };

    await onBeforeDelete?.(context);
    if (showLoadingDuringDelete) {
      flow.showLoading({
        title: 'Deleting Workspace',
        message:
          params.scriptPolicy === 'skip'
            ? 'Removing workspace without cleanup scripts...'
            : `Running cleanup scripts for "${target.workspaceName}"...`,
      });
    } else {
      flow.close();
    }

    try {
      await deleteWorkspace(target.projectName, target.workspaceId, params);
      flow.close();
      await onDeleteSuccess?.(context);
      return true;
    } catch (error) {
      const message = toErrorMessage(error);
      const code = getErrorCode(error);

      if (code === 'REMOVE_SCRIPT_FAILED' && params.scriptPolicy !== 'skip') {
        const removeAnyway = await promptRemoveScriptFailure(flow, target.workspaceName, message);
        if (!removeAnyway) {
          await onDeleteCancelled?.(context);
          return false;
        }

        return executeDelete(target, { scriptPolicy: 'skip' }, true);
      }

      flow.close();
      if (onDeleteError) {
        await onDeleteError({
          ...context,
          error,
          message,
        });
      } else {
        flow.showMessage({
          title: 'Delete Failed',
          message,
          variant: 'error',
        });
      }

      return false;
    }
  }, [
    deleteWorkspace,
    flow,
    onBeforeDelete,
    onDeleteCancelled,
    onDeleteError,
    onDeleteSuccess,
    showLoadingDuringDelete,
  ]);

  const deleteWorkspaceWithPrompt = useCallback(async (target: WorkspaceDeleteTarget): Promise<boolean> => {
    return executeDelete(target, { scriptPolicy: 'auto' }, false);
  }, [executeDelete]);

  return {
    deleteWorkspaceWithPrompt,
  };
}
