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
  afterAttach?: () => void | Promise<void>;
}

interface PromptCreateAgentSessionOptions {
  flow: Pick<UseFlowReturn, 'showInput'>;
  workspaceId: string;
  getCurrentSessions: (workspaceId: string) => AgentSessionSummaryLike[];
  createAgentSession: (workspaceId: string, title?: string) => Promise<AgentSessionSummaryLike[]>;
  attachOptions: Omit<AttachAgentSessionOptions, 'agentSessionId'>;
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
  await options.afterAttach?.();
}

export function promptCreateAgentSession(options: PromptCreateAgentSessionOptions): void {
  options.flow.showInput({
    title: 'New Agent Session',
    label: 'Session name:',
    placeholder: 'Investigate auth bug',
    validation: (value) => value.trim() ? null : 'Session name is required',
    onSubmit: async (value) => {
      const previousIds = new Set(options.getCurrentSessions(options.workspaceId).map((session) => session.id));
      const sessions = await options.createAgentSession(options.workspaceId, value.trim());
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
