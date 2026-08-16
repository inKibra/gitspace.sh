import { useCallback } from 'react';
import { ProcessStartCancelledError, isPortConflictError, promptToResolveProcessStartConflict } from '../session/resolveProcessStartConflict.js';
import {
  useProcessActions as useSessionProcessActions,
  type ProcessSessionInfo,
  type UseProcessActionsOptions as SessionUseProcessActionsOptions,
} from '../session/useProcessActions.js';
import type { UseFlowReturn } from '../../components/Flow.js';
import type { AppClient, AppClientContext, AgentSessionCommandError } from '../client/index.js';
import { useAppClient } from './useAppClient.js';

export interface UseProcessActionsOptions extends Omit<SessionUseProcessActionsOptions, 'startProcess' | 'stopProcess'> {
  client?: AppClient | AppClientContext | null;
  flow: Pick<UseFlowReturn, 'showConfirm'>;
  sessions: ProcessSessionInfo[];
  onClientError?: (message: string, error: AgentSessionCommandError) => void;
}

export interface UseProcessActionsResult {
  handleStartProcess: (params: { workspaceId: string; processName: string; instance?: number }) => void;
  handleStopProcess: (params: { workspaceId: string; processName: string }) => void;
  handleStartProcessAttach: (params: { workspaceId: string; processName: string; instance?: number }) => void;
}

export function useProcessActions(options: UseProcessActionsOptions): UseProcessActionsResult {
  const client = useAppClient(options.client ?? null);

  const reportClientError = useCallback((error: AgentSessionCommandError) => {
    options.onClientError?.(error.message, error);
  }, [options.onClientError]);

  const startProcess = useCallback(async (workspaceId: string, processName: string, instance?: number) => {
    const attemptStart = async () => {
      const result = await client.processes.start(workspaceId, processName, instance);
      if (!result.ok) {
        throw result.error.cause ?? new Error(result.error.message);
      }
    };

    try {
      await attemptStart();
    } catch (error) {
      if (isPortConflictError(error)) {
        const resolved = await promptToResolveProcessStartConflict({
          error,
          showConfirm: options.flow.showConfirm,
          resolveConflict: async (conflict) => {
            if (!client.processes.resolveConflict) {
              throw new Error('Port conflict resolution is unavailable');
            }
            await client.processes.resolveConflict(workspaceId, conflict);
          },
        });
        if (resolved) {
          await attemptStart();
          return;
        }
        throw new ProcessStartCancelledError();
      }

      if ((error as { code?: unknown })?.code === 'operation-unavailable') {
        reportClientError({
          code: 'operation-unavailable',
          message: error instanceof Error ? error.message : String(error),
          workspaceId,
        });
      }
      throw error;
    }
  }, [client, options.flow, reportClientError]);

  const stopProcess = useCallback(async (workspaceId: string, processName: string) => {
    const result = await client.processes.stop(workspaceId, processName);
    if (!result.ok) {
      reportClientError(result.error);
      throw result.error.cause ?? new Error(result.error.message);
    }
  }, [client, reportClientError]);

  return useSessionProcessActions({
    ...options,
    startProcess,
    stopProcess,
  });
}
