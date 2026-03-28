import type { AppClientContext } from './context.js';
import { agentSessionFailure, agentSessionSuccess, describeAppClientError, type AgentSessionCommandResult } from './errors.js';
import { resolveWorkspaceRef } from './refs.js';

export interface ProcessActionValue {
  workspaceRef: { backendKey: string; workspaceId: string };
  processName: string;
  instance?: number;
}

export interface AppProcessesClient {
  start: (workspaceId: string, processName: string, instance?: number) => Promise<AgentSessionCommandResult<ProcessActionValue>>;
  stop: (workspaceId: string, processName: string) => Promise<AgentSessionCommandResult<ProcessActionValue>>;
}

export function createAppProcessesClient(context: AppClientContext): AppProcessesClient {
  return {
    start: async (workspaceId, processName, instance) => {
      const workspaceResult = resolveWorkspaceRef(context, workspaceId);
      if (!workspaceResult.ok) {
        return workspaceResult;
      }

      const workspaceRef = workspaceResult.value;
      const backend = context.multi.getBackend(workspaceRef.backendKey);
      if (!backend) {
        return agentSessionFailure({
          code: 'backend-unavailable',
          message: `Backend ${workspaceRef.backendKey} is not available`,
          workspaceId,
          backendKey: workspaceRef.backendKey,
        });
      }
      if (!backend.startProcess) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: 'Process start is unavailable',
          workspaceId,
          backendKey: workspaceRef.backendKey,
        });
      }

      try {
        await backend.startProcess(workspaceId, processName, instance);
        return agentSessionSuccess({ workspaceRef, processName, instance });
      } catch (error) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: describeAppClientError(error, 'Failed to start process'),
          workspaceId,
          backendKey: workspaceRef.backendKey,
          cause: error,
        });
      }
    },
    stop: async (workspaceId, processName) => {
      const workspaceResult = resolveWorkspaceRef(context, workspaceId);
      if (!workspaceResult.ok) {
        return workspaceResult;
      }

      const workspaceRef = workspaceResult.value;
      const backend = context.multi.getBackend(workspaceRef.backendKey);
      if (!backend) {
        return agentSessionFailure({
          code: 'backend-unavailable',
          message: `Backend ${workspaceRef.backendKey} is not available`,
          workspaceId,
          backendKey: workspaceRef.backendKey,
        });
      }
      if (!backend.stopProcess) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: 'Process stop is unavailable',
          workspaceId,
          backendKey: workspaceRef.backendKey,
        });
      }

      try {
        await backend.stopProcess(workspaceId, processName);
        return agentSessionSuccess({ workspaceRef, processName });
      } catch (error) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: describeAppClientError(error, 'Failed to stop process'),
          workspaceId,
          backendKey: workspaceRef.backendKey,
          cause: error,
        });
      }
    },
  };
}
