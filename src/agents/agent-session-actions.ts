import type { UseFlowReturn } from '../components/Flow.js';

interface AgentInboxItemLike {
  sessionId?: string;
  agentAction?: {
    workspaceId: string;
    agentSessionId: string;
    permissionId?: string;
    permissionTitle?: string;
  };
}

interface HandleAgentInboxSessionOptions {
  sessionId: string;
  agentInboxItems: AgentInboxItemLike[];
  flow: Pick<UseFlowReturn, 'showSelect'>;
  /**
   * Kept for API compatibility with existing inbox integrations.
   * Permission responses are display-only and handled elsewhere.
   */
  respondToPermission?: (
    workspaceId: string,
    agentSessionId: string,
    permissionId: string,
    response: 'allow' | 'deny',
  ) => Promise<void>;
  markAgentInboxItemRead: (sessionId: string) => void;
  openAgentSession: (workspaceId: string, agentSessionId: string) => Promise<void>;
  attachRegularSession: (sessionId: string) => Promise<void>;
  beforeAgentAction?: () => void | Promise<void>;
  beforeRegularAttach?: () => void | Promise<void>;
}

export async function handleInboxSessionSelection(options: HandleAgentInboxSessionOptions): Promise<void> {
  const agentItem = options.agentInboxItems.find((item) => item.sessionId === options.sessionId && item.agentAction);
  if (agentItem?.agentAction) {
    const { workspaceId, agentSessionId, permissionId } = agentItem.agentAction;
    if (permissionId) {
      options.markAgentInboxItemRead(options.sessionId);
      return;
    }

    await options.beforeAgentAction?.();
    await options.openAgentSession(workspaceId, agentSessionId);
    return;
  }

  await options.beforeRegularAttach?.();
  await options.attachRegularSession(options.sessionId);
}
