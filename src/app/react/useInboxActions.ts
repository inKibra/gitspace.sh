import { useCallback } from 'react';
import type { UseFlowReturn } from '../../components/Flow.js';
import type { AppClient, AppClientContext, AgentSessionCommandError } from '../client/index.js';
import { useAppClient } from './useAppClient.js';
import { handleInboxSessionSelection } from '../../agents/agent-session-actions.js';
import { useAgentSessionActions } from './useAgentSessionActions.js';

export interface UseInboxActionsOptions {
  client?: AppClient | AppClientContext | null;
  flow: Pick<UseFlowReturn, 'showSelect' | 'showInput'>;
  onError?: (message: string, error: AgentSessionCommandError) => void;
}

export function useInboxActions(options: UseInboxActionsOptions) {
  const client = useAppClient(options.client ?? null);
  const agentActions = useAgentSessionActions({ client, flow: { showInput: options.flow.showInput }, onError: options.onError });

  const reportError = useCallback((result: { ok: false; error: AgentSessionCommandError } | null, fallback: string) => {
    if (!result) return;
    options.onError?.(result.error.message || fallback, result.error);
  }, [options.onError]);

  const requestInbox = useCallback(async () => {
    const result = await client.inbox.request();
    if (!result.ok) reportError(result, 'Failed to request inbox');
  }, [client, reportError]);

  const clearInbox = useCallback(async (itemId?: string) => {
    const result = await client.inbox.clear(itemId);
    if (!result.ok) reportError(result, 'Failed to clear inbox');
  }, [client, reportError]);

  const markInboxRead = useCallback(async (itemId: string) => {
    const result = await client.inbox.markRead(itemId);
    if (!result.ok) reportError(result, 'Failed to mark inbox item read');
  }, [client, reportError]);

  const respondToPermission = useCallback(async (
    workspaceId: string,
    agentSessionId: string,
    permissionId: string,
    response: 'allow' | 'deny',
  ) => {
    const result = await client.inbox.respondToPermission(workspaceId, agentSessionId, permissionId, response);
    if (!result.ok) reportError(result, 'Failed to respond to permission request');
  }, [client, reportError]);

  const attachFromInboxSessionSelection = useCallback(async (args: {
    sessionId: string;
    agentInboxItems: Array<{ sessionId?: string; agentAction?: { workspaceId: string; agentSessionId: string; permissionId?: string; permissionTitle?: string } }>;
    markAgentInboxItemRead: (sessionId: string) => void;
    attachRegularSession: (sessionId: string) => Promise<void>;
    beforeAgentAction?: () => void | Promise<void>;
    beforeRegularAttach?: () => void | Promise<void>;
    onOpenAgentSuccess?: () => void | Promise<void>;
  }) => {
    await handleInboxSessionSelection({
      sessionId: args.sessionId,
      agentInboxItems: args.agentInboxItems,
      flow: { showSelect: options.flow.showSelect },
      respondToPermission,
      markAgentInboxItemRead: args.markAgentInboxItemRead,
      openAgentSession: (workspaceId, agentSessionId) =>
        agentActions.open(workspaceId, agentSessionId, { onOpenSuccess: args.onOpenAgentSuccess }).then(() => undefined),
      attachRegularSession: args.attachRegularSession,
      beforeAgentAction: args.beforeAgentAction,
      beforeRegularAttach: args.beforeRegularAttach,
    });
  }, [agentActions, options.flow.showSelect, respondToPermission]);

  return {
    requestInbox,
    clearInbox,
    markInboxRead,
    respondToPermission,
    attachFromInboxSessionSelection,
  };
}
