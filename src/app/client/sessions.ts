import type { AttachSessionParams } from '../../session/backend.js';
import type { BackendScopedWorkspaceRef } from '../../machine/multi/types.js';
import type { AppClientContext } from './context.js';
import { agentSessionFailure, agentSessionSuccess, describeAppClientError, type AgentSessionCommandResult } from './errors.js';

export interface AppSessionsClient {
  attach: (ref: BackendScopedWorkspaceRef, params: AttachSessionParams) => Promise<AgentSessionCommandResult<BackendScopedWorkspaceRef>>;
  cancelPendingScripts: (ref: BackendScopedWorkspaceRef) => Promise<AgentSessionCommandResult<BackendScopedWorkspaceRef>>;
}

export function createAppSessionsClient(context: AppClientContext): AppSessionsClient {
  return {
    attach: async (ref, params) => {
      const backend = context.multi.getBackend(ref.backendKey);
      if (!backend) {
        return agentSessionFailure({ code: 'backend-unavailable', message: `Backend ${ref.backendKey} is not available`, workspaceId: ref.workspaceId, backendKey: ref.backendKey });
      }
      try {
        await backend.attachSession(params);
        return agentSessionSuccess(ref);
      } catch (error) {
        return agentSessionFailure({ code: 'attach-failed', message: describeAppClientError(error, 'Failed to attach session'), workspaceId: ref.workspaceId, backendKey: ref.backendKey, cause: error });
      }
    },
    cancelPendingScripts: async (ref) => {
      const backend = context.multi.getBackend(ref.backendKey);
      if (!backend?.cancelPendingScripts) {
        return agentSessionFailure({ code: 'operation-unavailable', message: 'Pending script cancellation unavailable', workspaceId: ref.workspaceId, backendKey: ref.backendKey });
      }
      try {
        await backend.cancelPendingScripts();
        return agentSessionSuccess(ref);
      } catch (error) {
        return agentSessionFailure({ code: 'operation-unavailable', message: describeAppClientError(error, 'Failed to cancel pending scripts'), workspaceId: ref.workspaceId, backendKey: ref.backendKey, cause: error });
      }
    },
  };
}
