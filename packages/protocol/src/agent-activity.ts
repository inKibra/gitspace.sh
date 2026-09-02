export type SessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'compacting' }
  | { type: 'retry'; attempt: number; message: string; next: number };

export type ActivityReason =
  | { kind: 'turn' }
  | { kind: 'compacting' }
  | { kind: 'retry'; attempt: number; next: number }
  | { kind: 'human'; questions: number; permissions: number }
  | { kind: 'queued'; steering: number; followUp: number }
  | { kind: 'subagents'; count: number };

export interface SessionActivity {
  active: boolean;
  reasons: ActivityReason[];
}

export interface WorkspaceAgentActivityState {
  statuses?: Record<string, SessionStatus>;
  pendingPermissions?: Record<string, unknown[]>;
  pendingQuestions?: Record<string, unknown[]>;
  queuedMessages?: Record<string, { steering: string[]; followUp: string[] }>;
  subagentCounts?: Record<string, number>;
}

export type AgentSessionRenderState =
  | 'closed'
  | 'dormant'
  | 'waiting'
  | 'running'
  | 'permission-needed'
  | 'retrying'
  | 'archived';

export function computeSessionActivity(state: WorkspaceAgentActivityState, sessionId: string): SessionActivity {
  const reasons: ActivityReason[] = [];
  const status = state.statuses?.[sessionId];
  if (status?.type === 'busy') reasons.push({ kind: 'turn' });
  if (status?.type === 'compacting') reasons.push({ kind: 'compacting' });
  if (status?.type === 'retry') reasons.push({ kind: 'retry', attempt: status.attempt, next: status.next });
  const questions = state.pendingQuestions?.[sessionId]?.length ?? 0;
  const permissions = state.pendingPermissions?.[sessionId]?.length ?? 0;
  if (questions > 0 || permissions > 0) reasons.push({ kind: 'human', questions, permissions });
  const queued = state.queuedMessages?.[sessionId];
  const steering = queued?.steering.length ?? 0;
  const followUp = queued?.followUp.length ?? 0;
  if (steering > 0 || followUp > 0) reasons.push({ kind: 'queued', steering, followUp });
  const subagents = state.subagentCounts?.[sessionId] ?? 0;
  if (subagents > 0) reasons.push({ kind: 'subagents', count: subagents });
  return { active: reasons.length > 0, reasons };
}

export function withHumanReason(activity: SessionActivity, questions: number, permissions: number): SessionActivity {
  const withoutHuman = activity.reasons.filter((reason) => reason.kind !== 'human');
  const reasons: ActivityReason[] = questions > 0 || permissions > 0
    ? [...withoutHuman, { kind: 'human', questions, permissions }]
    : withoutHuman;
  return { active: reasons.length > 0, reasons };
}

export function determineAgentState(
  activity: SessionActivity,
  lifecycle: { closedAt?: string; dormantSince?: string; archivedAt?: string },
  errorMessage: string | undefined,
): AgentSessionRenderState {
  if (lifecycle.archivedAt) return 'archived';
  if (lifecycle.closedAt) return 'closed';
  if (lifecycle.dormantSince) return 'dormant';
  if (activity.reasons.some((reason) => reason.kind === 'human')) return 'permission-needed';
  if (errorMessage || activity.reasons.some((reason) => reason.kind === 'retry')) return 'retrying';
  if (activity.reasons.some((reason) => reason.kind === 'turn' || reason.kind === 'compacting')) return 'running';
  return 'waiting';
}

export function sessionStatusFromActivity(activity: SessionActivity | undefined, errorMessage?: string): SessionStatus | undefined {
  if (!activity) return undefined;
  if (activity.reasons.some((reason) => reason.kind === 'turn')) return { type: 'busy' };
  if (activity.reasons.some((reason) => reason.kind === 'compacting')) return { type: 'compacting' };
  const retry = activity.reasons.find((reason) => reason.kind === 'retry');
  if (retry?.kind === 'retry') return { type: 'retry', attempt: retry.attempt, message: errorMessage ?? 'retrying', next: retry.next };
  return { type: 'idle' };
}
