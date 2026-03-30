import type { AppClientContext } from './context.js';
import { agentSessionFailure, agentSessionSuccess, describeAppClientError, type AgentSessionCommandResult } from './errors.js';
import { resolveAgentSessionRef } from './refs.js';

export interface InboxActionValue {
  itemId?: string;
}

export interface PermissionResponseValue {
  workspaceId: string;
  agentSessionId: string;
  permissionId: string;
  response: 'allow' | 'deny';
}

export interface AppInboxClient {
  request: () => Promise<AgentSessionCommandResult<InboxActionValue>>;
  clear: (itemId?: string) => Promise<AgentSessionCommandResult<InboxActionValue>>;
  markRead: (itemId: string) => Promise<AgentSessionCommandResult<InboxActionValue>>;
  respondToPermission: (
    workspaceId: string,
    agentSessionId: string,
    permissionId: string,
    response: 'allow' | 'deny',
  ) => Promise<AgentSessionCommandResult<PermissionResponseValue>>;
}

export function createAppInboxClient(context: AppClientContext): AppInboxClient {
  return {
    request: async () => {
      try {
        await context.multi.requestInbox?.();
        return agentSessionSuccess({});
      } catch (error) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: describeAppClientError(error, 'Failed to request inbox'),
          workspaceId: '',
          cause: error,
        });
      }
    },
    clear: async (itemId) => {
      try {
        await context.multi.clearInbox?.(itemId);
        return agentSessionSuccess({ itemId });
      } catch (error) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: describeAppClientError(error, 'Failed to clear inbox'),
          workspaceId: '',
          cause: error,
        });
      }
    },
    markRead: async (itemId) => {
      try {
        await context.multi.markInboxRead?.(itemId);
        return agentSessionSuccess({ itemId });
      } catch (error) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: describeAppClientError(error, 'Failed to mark inbox item read'),
          workspaceId: '',
          cause: error,
        });
      }
    },
    respondToPermission: async (workspaceId, agentSessionId, permissionId, response) => {
      const refResult = resolveAgentSessionRef(context, workspaceId, agentSessionId);
      if (!refResult.ok) {
        return refResult;
      }

      try {
        const granted = await context.multi.respondToAgentPermission?.(refResult.value.agentSessionRef, permissionId, response);
        if (!granted) {
          return agentSessionFailure({
            code: 'operation-unavailable',
            message: 'Permission response was not accepted',
            workspaceId,
            agentSessionId,
            backendKey: refResult.value.workspaceRef.backendKey,
          });
        }
        return agentSessionSuccess({ workspaceId, agentSessionId, permissionId, response });
      } catch (error) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: describeAppClientError(error, 'Failed to respond to permission request'),
          workspaceId,
          agentSessionId,
          backendKey: refResult.value.workspaceRef.backendKey,
          cause: error,
        });
      }
    },
  };
}
