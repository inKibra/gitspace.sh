import { useCallback } from 'react';
import type { AttachSessionParams } from '../../session/backend.js';
import type { BackendScopedWorkspaceRef } from '../../machine/multi/types.js';
import type { AppClient, AppClientContext, AgentSessionCommandError } from '../client/index.js';
import { useAppClient } from './useAppClient.js';

export interface UseSessionActionsOptions {
  client?: AppClient | AppClientContext | null;
  onError?: (message: string, error: AgentSessionCommandError) => void;
}

export function useSessionActions(options: UseSessionActionsOptions) {
  const client = useAppClient(options.client ?? null);

  const attachSession = useCallback(async (ref: BackendScopedWorkspaceRef, params: AttachSessionParams) => {
    const result = await client.sessions.attach(ref, params);
    if (!result.ok) {
      options.onError?.(result.error.message, result.error);
      throw result.error.cause ?? new Error(result.error.message);
    }
  }, [client, options]);

  const cancelPendingScripts = useCallback(async (ref: BackendScopedWorkspaceRef) => {
    const result = await client.sessions.cancelPendingScripts(ref);
    if (!result.ok) {
      options.onError?.(result.error.message, result.error);
      throw result.error.cause ?? new Error(result.error.message);
    }
  }, [client, options]);

  return { attachSession, cancelPendingScripts };
}
