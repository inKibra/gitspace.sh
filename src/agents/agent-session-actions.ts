import type { UseFlowReturn } from '../components/Flow.js';

interface AgentSessionSummaryLike {
  id: string;
  updatedAt?: string;
}

interface AttachAgentSessionOptions {
  workspaceId: string;
  agentSessionId: string;
  persistAgentSessionSelection: (workspaceId: string, sessionId: string) => void;
  clearViewOnly: () => void;
  attachAgentSession: (workspaceId: string, agentSessionId: string) => Promise<void>;
  afterAttach?: (agentSessionId: string) => void | Promise<void>;
}

interface PromptCreateAgentSessionOptions {
  flow: Pick<UseFlowReturn, 'showInput'>;
  workspaceId: string;
  getCurrentSessions: (workspaceId: string) => AgentSessionSummaryLike[];
  createAgentSession: (workspaceId: string, title?: string) => Promise<AgentSessionSummaryLike[]>;
  attachOptions: Omit<AttachAgentSessionOptions, 'agentSessionId'>;
}

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
  respondToPermission: (
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

export function findCreatedAgentSession(
  previousIds: Set<string>,
  sessions: AgentSessionSummaryLike[],
): AgentSessionSummaryLike | undefined {
  return sessions.find((session) => !previousIds.has(session.id))
    ?? [...sessions].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
}

export async function openAgentSession(options: AttachAgentSessionOptions): Promise<void> {
  options.persistAgentSessionSelection(options.workspaceId, options.agentSessionId);
  options.clearViewOnly();
  await options.attachAgentSession(options.workspaceId, options.agentSessionId);
  await options.afterAttach?.(options.agentSessionId);
}

export function promptCreateAgentSession(options: PromptCreateAgentSessionOptions): void {
  options.flow.showInput({
    title: 'New Agent Session',
    label: 'Session name:',
    placeholder: 'Investigate auth bug',
    onSubmit: async (value) => {
      const previousIds = new Set(options.getCurrentSessions(options.workspaceId).map((session) => session.id));
      const title = value.trim() || undefined;
      const sessions = await options.createAgentSession(options.workspaceId, title);
      const created = findCreatedAgentSession(previousIds, sessions);
      if (!created) {
        return;
      }
      await openAgentSession({
        ...options.attachOptions,
        workspaceId: options.workspaceId,
        agentSessionId: created.id,
      });
    },
  });
}

export async function handleInboxSessionSelection(options: HandleAgentInboxSessionOptions): Promise<void> {
  const agentItem = options.agentInboxItems.find((item) => item.sessionId === options.sessionId && item.agentAction);
  if (agentItem?.agentAction) {
    const { workspaceId, agentSessionId, permissionId, permissionTitle } = agentItem.agentAction;
    await options.beforeAgentAction?.();
    if (permissionId) {
      options.flow.showSelect<'allow' | 'deny' | 'dismiss'>({
        title: `Permission: ${permissionTitle ?? 'Action requested'}`,
        options: [
          { label: 'Allow', value: 'allow', description: 'Grant the agent permission to proceed' },
          { label: 'Deny', value: 'deny', description: 'Deny the agent and stop this action' },
          { label: 'Dismiss', value: 'dismiss', description: 'Close without responding (agent keeps waiting)' },
        ],
        onSelect: async (choice) => {
          if (choice === 'allow' || choice === 'deny') {
            await options.respondToPermission(workspaceId, agentSessionId, permissionId, choice);
          }
          options.markAgentInboxItemRead(options.sessionId);
        },
      });
      return;
    }

    await options.openAgentSession(workspaceId, agentSessionId);
    return;
  }

  await options.beforeRegularAttach?.();
  await options.attachRegularSession(options.sessionId);
}
