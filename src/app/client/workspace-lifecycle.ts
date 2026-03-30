import type { DeleteWorkspaceParams } from '../../session/backend.js';
import type { WorkspacePhase } from '../../types/config.js';
import type { AppClientContext } from './context.js';
import {
  agentSessionFailure,
  agentSessionSuccess,
  describeAppClientError,
  type AgentSessionCommandResult,
} from './errors.js';
import type { BackendScopedWorkspaceRef } from '../../machine/multi/types.js';

export interface WorkspaceStatusChangeValue {
  workspaceRef: BackendScopedWorkspaceRef;
  phase: WorkspacePhase;
}

export interface WorkspaceDeleteValue {
  workspaceRef: BackendScopedWorkspaceRef;
  params: DeleteWorkspaceParams;
}

export interface AppWorkspaceLifecycleClient {
  setStatus: (
    workspaceRef: BackendScopedWorkspaceRef,
    phase: WorkspacePhase,
  ) => Promise<AgentSessionCommandResult<WorkspaceStatusChangeValue>>;
  deleteWorkspace: (
    workspaceRef: BackendScopedWorkspaceRef,
    params?: DeleteWorkspaceParams,
  ) => Promise<AgentSessionCommandResult<WorkspaceDeleteValue>>;
}

export function createAppWorkspaceLifecycleClient(context: AppClientContext): AppWorkspaceLifecycleClient {
  return {
    setStatus: async (workspaceRef, phase) => {
      const backend = context.multi.getBackend(workspaceRef.backendKey);
      if (!backend) {
        return agentSessionFailure({
          code: 'backend-unavailable',
          message: `Backend ${workspaceRef.backendKey} is not available`,
          workspaceId: workspaceRef.workspaceId,
          backendKey: workspaceRef.backendKey,
        });
      }

      if (!backend.setWorkspaceStatus) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: 'Workspace status changes are unavailable',
          workspaceId: workspaceRef.workspaceId,
          backendKey: workspaceRef.backendKey,
        });
      }

      try {
        await backend.setWorkspaceStatus(workspaceRef.workspaceId.split(':')[0] ?? '', workspaceRef.workspaceId.split(':')[1] ?? workspaceRef.workspaceId, phase);
        return agentSessionSuccess({ workspaceRef, phase });
      } catch (error) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: describeAppClientError(error, 'Failed to update workspace status'),
          workspaceId: workspaceRef.workspaceId,
          backendKey: workspaceRef.backendKey,
          cause: error,
        });
      }
    },
    deleteWorkspace: async (workspaceRef, params = { scriptPolicy: 'auto' }) => {
      const backend = context.multi.getBackend(workspaceRef.backendKey);
      if (!backend) {
        return agentSessionFailure({
          code: 'backend-unavailable',
          message: `Backend ${workspaceRef.backendKey} is not available`,
          workspaceId: workspaceRef.workspaceId,
          backendKey: workspaceRef.backendKey,
        });
      }

      try {
        const projectName = workspaceRef.workspaceId.split(':')[0] ?? '';
        await backend.deleteWorkspace(projectName, workspaceRef.workspaceId, params);
        await context.multi.listWorkspaces?.();
        await context.multi.listSessions?.();
        await context.multi.listReplays?.(undefined, false);
        return agentSessionSuccess({ workspaceRef, params });
      } catch (error) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: describeAppClientError(error, 'Failed to delete workspace'),
          workspaceId: workspaceRef.workspaceId,
          backendKey: workspaceRef.backendKey,
          cause: error,
        });
      }
    },
  };
}
