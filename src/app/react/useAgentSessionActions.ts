import { useCallback } from 'react';
import type { UseFlowReturn } from '../../components/Flow.js';
import type {
  AgentSessionCommandError,
  AppClient,
  AppClientAgentSessionMutationValue,
  AppClientAgentSessionOpenValue,
  AppClientContext,
} from '../client/index.js';
import { useAppClient } from './useAppClient.js';

export interface AgentSessionOpenCallbacks {
  beforeOpen?: () => void | Promise<void>;
  onOpenSuccess?: (value: AppClientAgentSessionOpenValue) => void | Promise<void>;
  onOpenError?: (error: AgentSessionCommandError) => void | Promise<void>;
  attachOptions?: { viewOnly?: boolean; cols?: number; rows?: number; paneId?: string };
}

export interface UseAgentSessionActionsOptions extends AgentSessionOpenCallbacks {
  client?: AppClient | AppClientContext | null;
  flow: Pick<UseFlowReturn, 'showInput'> & Partial<Pick<UseFlowReturn, 'showLoading' | 'close'>>;
  onError?: (message: string, error: AgentSessionCommandError) => void;
}

export interface UseAgentSessionActionsResult {
  open: (
    workspaceId: string,
    agentSessionId: string,
    callbacks?: AgentSessionOpenCallbacks,
  ) => Promise<AppClientAgentSessionOpenValue | null>;
  createAndOpen: (workspaceId: string, callbacks?: AgentSessionOpenCallbacks) => void;
  kill: (workspaceId: string, agentSessionId: string) => Promise<AppClientAgentSessionMutationValue | null>;
  stopAgentTurn: (workspaceId: string, agentSessionId: string) => Promise<AppClientAgentSessionMutationValue | null>;
  close: (workspaceId: string, agentSessionId: string) => Promise<AppClientAgentSessionMutationValue | null>;
  archive: (workspaceId: string, agentSessionId: string) => Promise<AppClientAgentSessionMutationValue | null>;
  restore: (workspaceId: string, agentSessionId: string) => Promise<AppClientAgentSessionMutationValue | null>;
}

type AgentSessionActionName = 'open' | 'create' | 'kill' | 'stopAgentTurn' | 'close' | 'archive' | 'restore';

function getActionLabel(action: AgentSessionActionName): string {
  if (action === 'create') return 'create agent session';
  if (action === 'kill') return 'kill agent session';
  if (action === 'stopAgentTurn') return 'stop agent turn';
  return `${action} agent session`;
}

function formatAgentSessionError(action: AgentSessionActionName, error: AgentSessionCommandError): string {
  const label = getActionLabel(action);
  switch (error.code) {
    case 'workspace-not-found':
      return `Failed to ${label}: workspace ${error.workspaceId} is not available.`;
    case 'ambiguous-backend':
      return `Failed to ${label}: workspace ${error.workspaceId} exists on multiple machines; select the workspace's machine first.`;
    case 'backend-unavailable':
    case 'operation-unavailable':
      return `Failed to ${label}: ${error.message}.`;
    default:
      return `Failed to ${label}: ${error.message}`;
  }
}

function composeCallbacks<TArgs extends unknown[]>(
  base: ((...args: TArgs) => void | Promise<void>) | undefined,
  override: ((...args: TArgs) => void | Promise<void>) | undefined,
  order: 'base-first' | 'override-first' = 'base-first',
): ((...args: TArgs) => Promise<void>) | undefined {
  if (!base && !override) {
    return undefined;
  }
  return async (...args: TArgs) => {
    if (order === 'override-first') {
      await override?.(...args);
      await base?.(...args);
      return;
    }
    await base?.(...args);
    await override?.(...args);
  };
}

export function useAgentSessionActions(options: UseAgentSessionActionsOptions): UseAgentSessionActionsResult {
  const client = useAppClient(options.client ?? null);

  const resolveOpenCallbacks = useCallback((overrides?: AgentSessionOpenCallbacks): AgentSessionOpenCallbacks => ({
    beforeOpen: composeCallbacks(options.beforeOpen, overrides?.beforeOpen),
    onOpenSuccess: composeCallbacks(options.onOpenSuccess, overrides?.onOpenSuccess),
    onOpenError: composeCallbacks(options.onOpenError, overrides?.onOpenError),
    attachOptions: overrides?.attachOptions ?? options.attachOptions,
  }), [options.beforeOpen, options.onOpenSuccess, options.onOpenError, options.attachOptions]);

  const reportError = useCallback((action: AgentSessionActionName, error: AgentSessionCommandError): void => {
    options.onError?.(formatAgentSessionError(action, error), error);
  }, [options.onError]);

  const open = useCallback(async (
    workspaceId: string,
    agentSessionId: string,
    callbacks?: AgentSessionOpenCallbacks,
  ): Promise<AppClientAgentSessionOpenValue | null> => {
    const resolvedCallbacks = resolveOpenCallbacks(callbacks);
    await resolvedCallbacks.beforeOpen?.();

    const result = await client.agentSessions.open({ workspaceId, agentSessionId, attachOptions: resolvedCallbacks.attachOptions });
    if (!result.ok) {
      await resolvedCallbacks.onOpenError?.(result.error);
      reportError('open', result.error);
      return null;
    }

    await resolvedCallbacks.onOpenSuccess?.(result.value);
    return result.value;
  }, [client, reportError, resolveOpenCallbacks]);
  const createAndOpen = useCallback((workspaceId: string, callbacks?: AgentSessionOpenCallbacks): void => {
    const resolvedCallbacks = resolveOpenCallbacks(callbacks);
    options.flow.showInput({
      title: 'New Agent Session',
      label: 'Session name:',
      placeholder: 'Investigate auth bug',
      onSubmit: async (value) => {
        await resolvedCallbacks.beforeOpen?.();
        const title = value.trim() || undefined;
        options.flow.showLoading?.({
          title: 'Creating Agent Session',
          message: title ? `Creating ${title}...` : 'Creating agent session...',
        });
        try {
          const result = await client.agentSessions.createAndOpen({ workspaceId, title, attachOptions: resolvedCallbacks.attachOptions });
          if (!result.ok) {
            options.flow.close?.();
            await resolvedCallbacks.onOpenError?.(result.error);
            reportError('create', result.error);
            return;
          }

          options.flow.close?.();
          await resolvedCallbacks.onOpenSuccess?.(result.value);
        } catch (error) {
          options.flow.close?.();
          throw error;
        }
      },
    });
  }, [client, options.flow, reportError, resolveOpenCallbacks]);

  const kill = useCallback(async (
    workspaceId: string,
    agentSessionId: string,
  ): Promise<AppClientAgentSessionMutationValue | null> => {
    const result = await client.agentSessions.kill({ workspaceId, agentSessionId });
    if (!result.ok) {
      reportError('kill', result.error);
      return null;
    }

    return result.value;
  }, [client, reportError]);

  const stopAgentTurn = useCallback(async (
    workspaceId: string,
    agentSessionId: string,
  ): Promise<AppClientAgentSessionMutationValue | null> => {
    const result = await client.agentSessions.stopAgentTurn({ workspaceId, agentSessionId });
    if (!result.ok) {
      reportError('stopAgentTurn', result.error);
      return null;
    }

    return result.value;
  }, [client, reportError]);

  const close = useCallback(async (
    workspaceId: string,
    agentSessionId: string,
  ): Promise<AppClientAgentSessionMutationValue | null> => {
    const result = await client.agentSessions.close({ workspaceId, agentSessionId });
    if (!result.ok) {
      reportError('close', result.error);
      return null;
    }

    return result.value;
  }, [client, reportError]);

  const archive = useCallback(async (
    workspaceId: string,
    agentSessionId: string,
  ): Promise<AppClientAgentSessionMutationValue | null> => {
    const result = await client.agentSessions.archive({ workspaceId, agentSessionId });
    if (!result.ok) {
      reportError('archive', result.error);
      return null;
    }

    return result.value;
  }, [client, reportError]);

  const restore = useCallback(async (
    workspaceId: string,
    agentSessionId: string,
  ): Promise<AppClientAgentSessionMutationValue | null> => {
    const result = await client.agentSessions.restore({ workspaceId, agentSessionId });
    if (!result.ok) {
      reportError('restore', result.error);
      return null;
    }

    return result.value;
  }, [client, reportError]);

  return {
    open,
    createAndOpen,
    kill,
    stopAgentTurn,
    close,
    archive,
    restore,
  };
}
