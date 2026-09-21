import { z } from 'zod';
import type { AgentFailure } from './errors.js';

export const SessionStatusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('idle') }),
  z.object({ type: z.literal('busy') }),
  z.object({ type: z.literal('compacting'), detail: z.string().optional() }),
  z.object({ type: z.literal('retry'), attempt: z.number(), message: z.string(), next: z.number() }),
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ActivityReasonSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('turn') }),
  z.object({ kind: z.literal('compacting'), detail: z.string().optional() }),
  z.object({ kind: z.literal('retry'), attempt: z.number(), next: z.number() }),
  z.object({ kind: z.literal('human'), questions: z.number(), permissions: z.number() }),
  z.object({ kind: z.literal('queued'), steering: z.number(), followUp: z.number() }),
  z.object({ kind: z.literal('subagents'), count: z.number() }),
]);
export type ActivityReason = z.infer<typeof ActivityReasonSchema>;
export const SessionActivitySchema = z.object({ active: z.boolean(), reasons: z.array(ActivityReasonSchema) });
export type SessionActivity = z.infer<typeof SessionActivitySchema>;

export interface WorkspaceAgentActivityState {
  statuses?: Record<string, SessionStatus>;
  pendingPermissions?: Record<string, unknown[]>;
  pendingQuestions?: Record<string, unknown[]>;
  queuedMessages?: Record<string, { steering: string[]; followUp: string[] }>;
  subagentCounts?: Record<string, number>;
}

export const AgentSessionRenderStateSchema = z.enum(['closed', 'dormant', 'waiting', 'running', 'permission-needed', 'retrying', 'archived']);
export type AgentSessionRenderState = z.infer<typeof AgentSessionRenderStateSchema>;

export function computeSessionActivity(state: WorkspaceAgentActivityState, sessionId: string): SessionActivity {
  const reasons: ActivityReason[] = [];
  const status = state.statuses?.[sessionId];
  if (status?.type === 'busy') reasons.push({ kind: 'turn' });
  if (status?.type === 'compacting') reasons.push({ kind: 'compacting', ...(status.detail === undefined ? {} : { detail: status.detail }) });
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
  failure?: AgentFailure | null,
): AgentSessionRenderState {
  if (lifecycle.archivedAt) return 'archived';
  if (lifecycle.closedAt) return 'closed';
  if (lifecycle.dormantSince) return 'dormant';
  if (failure && failure.code !== 'AGENT_ARTIFACT_SYNC_FAILED') return 'retrying';
  if (activity.reasons.some((reason) => reason.kind === 'retry')) return 'retrying';
  if (activity.reasons.some((reason) => reason.kind === 'human')) return 'permission-needed';
  if (activity.reasons.some((reason) => reason.kind === 'turn' || reason.kind === 'compacting' || reason.kind === 'queued' || reason.kind === 'subagents')) return 'running';
  return 'waiting';
}

export function sessionStatusFromActivity(activity: SessionActivity | undefined, failure?: AgentFailure | null): SessionStatus | undefined {
  if (!activity) return undefined;
  const compaction = activity.reasons.find((reason) => reason.kind === 'compacting');
  if (compaction?.kind === 'compacting') return { type: 'compacting', ...(compaction.detail === undefined ? {} : { detail: compaction.detail }) };
  if (activity.reasons.some((reason) => reason.kind === 'turn')) return { type: 'busy' };
  const retry = activity.reasons.find((reason) => reason.kind === 'retry');
  if (retry?.kind === 'retry') return { type: 'retry', attempt: retry.attempt, message: failure?.message ?? 'retrying', next: retry.next };
  return { type: 'idle' };
}
