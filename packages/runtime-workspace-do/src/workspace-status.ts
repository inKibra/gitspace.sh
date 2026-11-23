import { questionState, type RuntimeAttachment, type RuntimePlanStep, type RuntimeQuestion, type RuntimeSnapshot, type RuntimeWorkspaceStatus } from '@gitspace/protocol-runtime';
import { WAITING_ITEMS_MAX, WAITING_TITLE_MAX, type WaitingItem, type WorkspacePlanStep, type WorkspaceStatusColor, type WorkspaceStatusSummary, type WorkspaceWaiting } from '@gitspace/protocol-workspace';

type Conversation = RuntimeSnapshot['conversations'][number];

/** What one rebuild of the workspace reads live. A conversation flag stored by an earlier rebuild is never an input. */
export interface LiveAgents {
  conversations: ReadonlyArray<Pick<Conversation, 'id' | 'parentId'> & { failure: string | null }>;
  /** Unfinished tasks the scheduler can still run. Background tasks (commands, process watches, background-agent
   * waits) are work an agent left running, not an agent working. */
  tasks: ReadonlyArray<{ conversationId: string; background: boolean }>;
  questions: ReadonlyArray<Pick<RuntimeSnapshot['questions'][number], 'conversationId' | 'kind' | 'answer' | 'closed'>>;
}

export type AgentActivity = 'approval' | 'question' | 'working' | 'failed' | 'idle';

/** Each conversation's activity. An open question outranks a live task; a live task outranks an earlier failure. Only an
 * open question waits on a person: an answered or closed one holds nothing. */
export function agentActivity(live: LiveAgents): Map<string, AgentActivity> {
  const open = live.questions.filter(question => questionState(question) === 'open');
  const approvals = new Set(open.flatMap(question => question.kind === 'approval' || question.kind === 'lifecycle-approval' ? [question.conversationId] : []));
  const questions = new Set(open.map(question => question.conversationId));
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

/** What one rebuild reads to list the workspace's open items. `agents`: subagent names by conversation id. */
export interface WaitingSources {
  rootId: string;
  agents: ReadonlyMap<string, string>;
  questions: readonly RuntimeQuestion[];
  /** The main conversation's failure. */
  failure: string | null;
  machines: RuntimeWorkspaceStatus['machines'];
  attachments: readonly Pick<RuntimeAttachment, 'attachmentId' | 'updatedAt'>[];
  conflicts: readonly string[];
}

function cut(text: string): { title: string; characters: number } {
  return { title: text.slice(0, WAITING_TITLE_MAX), characters: text.length };
}

function questionItem(question: RuntimeQuestion, agents: ReadonlyMap<string, string>, rootId: string): WaitingItem {
  const base = { key: question.id, since: question.askedAt ?? null, ...cut(question.prompt), conversation: { id: question.conversationId, agent: question.conversationId === rootId ? null : (agents.get(question.conversationId) ?? 'Subagent').slice(0, 80) } };
  const choices = question.choices.slice(0, 9).map(choice => choice.slice(0, 80));
  switch (question.kind) {
    case 'ask': return { kind: 'ask', ...base, choices };
    // A plan's approval has no tool; a permission prompt names its tool.
    case 'approval': return question.tool ? { kind: 'approval', ...base, choices } : { kind: 'plan', ...base, choices };
    case 'lifecycle-approval': {
      const scripts = question.lifecycle?.scripts ?? [];
      return { kind: 'lifecycle-approval', ...base, phase: question.lifecycle?.phase ?? '', more: Math.max(0, scripts.length - 4),
        scripts: scripts.slice(0, 4).map(script => ({ hash: script.hash, label: script.label.slice(0, 80), fileName: script.fileName?.slice(-160) ?? null, phase: script.phase })) };
    }
    case 'takeover': return { kind: 'takeover', ...base };
    case 'secure-input': return { kind: 'secure-input', ...base };
    case 'mcp-elicitation': return { kind: 'mcp-elicitation', ...base };
  }
}

/** Every open item of the workspace, oldest first (items without a time last), at most `WAITING_ITEMS_MAX`: the open
 * questions of every conversation, the main conversation's failure, failed setup steps, conflicted paths. */
export function workspaceWaiting(sources: WaitingSources): WorkspaceWaiting {
  const items: WaitingItem[] = sources.questions.filter(question => questionState(question) === 'open').map(question => questionItem(question, sources.agents, sources.rootId));
  if (sources.failure) items.push({ kind: 'failed', key: `failed:${sources.rootId}`, since: null, ...cut(sources.failure), conversation: { id: sources.rootId, agent: null } });
  for (const machine of sources.machines) {
    const updatedAt = sources.attachments.find(attachment => attachment.attachmentId === machine.attachmentId)?.updatedAt ?? null;
    for (const step of machine.setup) {
      if (step.state !== 'failed') continue;
      const error = step.error ?? 'Setup failed';
      const lastLine = error.split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? error;
      items.push({ kind: 'setup-failed', key: `setup:${machine.machineId}:${step.phase}`, since: updatedAt, ...cut(error), machineId: machine.machineId, phase: step.phase, runId: step.runId, lastLine: lastLine.slice(0, WAITING_TITLE_MAX) });
    }
  }
  if (sources.conflicts.length) items.push({ kind: 'conflict', key: 'conflict', since: null, ...cut(sources.conflicts.join(', ')), paths: sources.conflicts.length });
  // Items without a time sort last.
  items.sort((left, right) => (left.since ?? '9999').localeCompare(right.since ?? '9999'));
  return { items: items.slice(0, WAITING_ITEMS_MAX), more: Math.max(0, items.length - WAITING_ITEMS_MAX) };
}

/** The step being worked on of the plan in effect (an approved plan, or the one approved before a pending proposal):
 * the active step, else the first pending one; null without an approved plan with a step left. */
export function workspacePlanStep(plan: { status: string; steps?: RuntimePlanStep[]; approved?: { steps: RuntimePlanStep[] } | null } | undefined): WorkspacePlanStep | null {
  const steps = plan?.status === 'approved' ? plan.steps ?? [] : plan?.approved?.steps ?? [];
  const index = steps.findIndex(step => step.status === 'active');
  const current = index >= 0 ? index : steps.findIndex(step => step.status === 'pending');
  const step = steps[current];
  return step ? { index: current + 1, count: steps.length, title: step.title.slice(0, 80) } : null;
}
