import { z } from 'zod';
import { agentFailure, AgentFailureSchema, type AgentFailure } from './errors.js';
import { WorkspaceDomainError, WorkspaceFailureSchema } from '@gitspace/protocol-workspace';

export const AgentIssueFailureSchema = z.union([AgentFailureSchema, WorkspaceFailureSchema]);
export type AgentIssueFailure = z.infer<typeof AgentIssueFailureSchema>;

/** Normalize tagged RPC wrappers without deriving error identity from their display text. */
export function agentIssueFailure(error: unknown, fallbackCode: AgentFailure['code'], context: AgentFailure['context'] = {}): AgentIssueFailure {
  let candidate = error;
  for (let depth = 0; depth < 4; depth++) {
    if (candidate instanceof WorkspaceDomainError) return candidate.toJSON();
    if (!candidate || typeof candidate !== 'object') break;
    const plain = 'domain' in candidate && 'code' in candidate && 'message' in candidate && 'context' in candidate
      ? { domain: candidate.domain, code: candidate.code, message: candidate.message, context: candidate.context } : candidate;
    const parsed = AgentIssueFailureSchema.safeParse(plain);
    if (parsed.success) return parsed.data;
    if ('failure' in candidate) candidate = candidate.failure;
    else if ('data' in candidate) candidate = candidate.data;
    else break;
  }
  return agentFailure(error, fallbackCode, context);
}

export const AgentIssueSchema = z.enum(['execution', 'connection', 'recovery', 'artifact-sync', 'checkpoint', 'workspace-open', 'workspace-close']);
export type AgentIssue = z.infer<typeof AgentIssueSchema>;
export const AGENT_ISSUE_FAILURE_CODES: Readonly<Record<AgentIssue, AgentFailure['code']>> = {
  execution: 'AGENT_EXECUTION_FAILED',
  connection: 'AGENT_DISCONNECTED',
  recovery: 'AGENT_RECOVERY_FAILED',
  'artifact-sync': 'AGENT_ARTIFACT_SYNC_FAILED',
  checkpoint: 'AGENT_RUNTIME_FAILED',
  'workspace-open': 'AGENT_RUNTIME_FAILED',
  'workspace-close': 'AGENT_RUNTIME_FAILED',
};
export const AgentIssueStateSchema = z.object({
  revision: z.number().int().nonnegative(), operationId: z.string(),
  failure: AgentIssueFailureSchema.nullable(), incidentId: z.string().nullable(),
}).strict();
export const AgentHealthStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  issues: z.partialRecord(AgentIssueSchema, AgentIssueStateSchema),
}).strict();
export type AgentHealthState = z.infer<typeof AgentHealthStateSchema>;
export const AgentIncidentSchema = z.object({
  id: z.string().min(1), sessionId: z.string().min(1).nullable(), spaceId: z.string().min(1),
  issue: AgentIssueSchema, operationId: z.string().min(1), revision: z.number().int().positive(),
  occurredAt: z.string(), failure: AgentIssueFailureSchema,
}).strict();
export type AgentIncident = z.infer<typeof AgentIncidentSchema>;
export const AgentIncidentChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('occurred'), incident: AgentIncidentSchema }).strict(),
  z.object({ type: z.literal('recovered'), incidentId: z.string(), sessionId: z.string().nullable(), spaceId: z.string(), issue: AgentIssueSchema, revision: z.number().int().positive(), recoveredAt: z.string() }).strict(),
]);
export type AgentIncidentChange = z.infer<typeof AgentIncidentChangeSchema>;
export interface AgentOperationToken { issue: AgentIssue; revision: number; operationId: string }

/** The resource writer allocates revisions before I/O, never when a late promise finishes. */
export function beginAgentOperation(state: AgentHealthState, issue: AgentIssue, operationId: string): { state: AgentHealthState; token: AgentOperationToken } {
  const revision = state.revision + 1;
  const previous = state.issues[issue];
  return {
    state: { revision, issues: { ...state.issues, [issue]: { revision, operationId, failure: previous?.failure ?? null, incidentId: previous?.incidentId ?? null } } },
    token: { issue, revision, operationId },
  };
}

/** Apply only the matching operation. Recovery clears this issue, never unrelated failures. */
export function settleAgentOperation(state: AgentHealthState, token: AgentOperationToken, outcome: {
  sessionId: string | null; spaceId: string; now: string; failure: AgentIssueFailure | null;
}): { state: AgentHealthState; changes: AgentIncidentChange[] } {
  const current = state.issues[token.issue];
  if (!current || current.revision !== token.revision || current.operationId !== token.operationId) return { state, changes: [] };
  const revision = state.revision + 1;
  const changes: AgentIncidentChange[] = [];
  if (!outcome.failure && current.incidentId) changes.push({ type: 'recovered', incidentId: current.incidentId, sessionId: outcome.sessionId, spaceId: outcome.spaceId, issue: token.issue, revision, recoveredAt: outcome.now });
  const incidentId = outcome.failure ? `${outcome.sessionId ?? outcome.spaceId}:${token.operationId}:${revision}` : null;
  if (outcome.failure && incidentId) changes.push({ type: 'occurred', incident: { id: incidentId, sessionId: outcome.sessionId, spaceId: outcome.spaceId, issue: token.issue, operationId: token.operationId, revision, occurredAt: outcome.now, failure: outcome.failure } });
  return { state: { revision, issues: { ...state.issues, [token.issue]: { revision, operationId: token.operationId, failure: outcome.failure, incidentId } } }, changes };
}

export function currentAgentFailure(state: AgentHealthState, issue?: AgentIssue): AgentIssueFailure | null {
  if (issue) return state.issues[issue]?.failure ?? null;
  let latest: z.infer<typeof AgentIssueStateSchema> | undefined;
  for (const current of Object.values(state.issues)) if (current.failure && (!latest || current.revision > latest.revision)) latest = current;
  return latest?.failure ?? null;
}

/** Background persistence problems remain visible without masquerading as agent execution. */
export function currentAgentExecutionFailure(state: AgentHealthState): AgentFailure | null {
  for (const issue of ['connection', 'execution', 'recovery'] as const) {
    const failure = state.issues[issue]?.failure;
    if (failure?.domain === 'agent') return failure;
  }
  return null;
}

export function agentOperationIssue(operation: string): AgentIssue {
  switch (operation) {
    case 'open': case 'recover': case 'resume': case 'restart': return 'recovery';
    case 'open space': return 'workspace-open';
    case 'close': case 'close space': case 'release space': return 'workspace-close';
    case 'artifact sync': return 'artifact-sync';
    case 'checkpoint': case 'checkpoint artifacts': return 'checkpoint';
    default: return 'execution';
  }
}
