import type { RuntimeSnapshot, RuntimeWorkspaceStatus } from '@gitspace/protocol-runtime';
import type { WorkspaceStatusColor, WorkspaceStatusSummary } from '@gitspace/protocol-workspace';

type Conversation = RuntimeSnapshot['conversations'][number];

/** What one rebuild of the workspace reads live. A conversation flag stored by an earlier rebuild is never an input. */
export interface LiveAgents {
  conversations: ReadonlyArray<Pick<Conversation, 'id' | 'parentId'> & { failure: string | null }>;
  /** Unfinished tasks the scheduler can still run. Background tasks (commands, process watches, background-agent
   * waits) are work an agent left running, not an agent working. */
  tasks: ReadonlyArray<{ conversationId: string; background: boolean }>;
  questions: ReadonlyArray<Pick<RuntimeSnapshot['questions'][number], 'conversationId' | 'kind' | 'answer' | 'takeover'>>;
}

export type AgentActivity = 'approval' | 'question' | 'working' | 'failed' | 'idle';

/** Each conversation's activity. A pending answer outranks the task waiting on it; a live task outranks an earlier failure. */
export function agentActivity(live: LiveAgents): Map<string, AgentActivity> {
  const approvals = new Set(live.questions.flatMap(question => question.answer === null && question.kind === 'approval' ? [question.conversationId] : []));
  // An ask_takeover card waits on you only while its call waits; left open after, it holds nothing.
  const questions = new Set(live.questions.flatMap(question => question.answer === null && (question.kind === 'ask' || question.kind === 'takeover' && question.takeover?.waiting === true) ? [question.conversationId] : []));
  const working = new Set(live.tasks.flatMap(task => task.background ? [] : [task.conversationId]));
  return new Map(live.conversations.map(conversation => [conversation.id,
    approvals.has(conversation.id) ? 'approval' : questions.has(conversation.id) ? 'question' : working.has(conversation.id) ? 'working' : conversation.failure ? 'failed' : 'idle']));
}

export function conversationStatus(activity: AgentActivity): Conversation['status'] {
  switch (activity) {
    case 'approval': case 'question': return 'waiting';
    case 'working': return 'running';
    case 'failed': return 'failed';
    case 'idle': return 'idle';
  }
}

/** Agent counts by color. A subagent counts only while it works or waits on a person: its result or failure goes to
 * the conversation that started it. */
export function agentCounts(conversations: LiveAgents['conversations'], activity: ReadonlyMap<string, AgentActivity>): WorkspaceStatusSummary['agents'] {
  const agents = { green: 0, blue: 0, orange: 0, red: 0 };
  for (const conversation of conversations) {
    const main = conversation.parentId === null;
    switch (activity.get(conversation.id) ?? 'idle') {
      // Both wait on a person: amber.
      case 'approval': case 'question': agents.orange += 1; break;
      case 'working': agents.green += 1; break;
      case 'failed': if (main) agents.red += 1; break;
      case 'idle': if (main) agents.blue += 1; break;
    }
  }
  return agents;
}

export function workspaceStatusSummary(agents: WorkspaceStatusSummary['agents'], status: Pick<RuntimeWorkspaceStatus, 'cloud' | 'machines'>): WorkspaceStatusSummary {
  const machines = { attached: status.machines.length, online: status.machines.filter(machine => machine.online).length, ready: status.machines.filter(machine => machine.ready).length };
  const sync = { conflicts: status.cloud.conflicts.length, problems: status.machines.filter(machine => machine.sync.problem !== null).length };
  const primaryColor: WorkspaceStatusColor = agents.red ? 'red' : agents.orange || sync.conflicts ? 'orange' : agents.green ? 'green' : agents.blue ? 'blue' : 'dim';
  return { primaryColor, agents, machines, sync };
}
