import { TaggedError } from 'better-result';
import { z } from 'zod';

export const AgentFailureSchema = z.object({
  domain: z.literal('agent'),
  code: z.enum(['AGENT_WORKSPACE_UNAVAILABLE', 'AGENT_PROJECT_UNAVAILABLE', 'AGENT_POSSESSION_DENIED', 'AGENT_RUNTIME_FAILED', 'AGENT_DISCONNECTED', 'AGENT_EXECUTION_FAILED', 'AGENT_RECOVERY_FAILED', 'AGENT_ARTIFACT_SYNC_FAILED', 'AGENT_NOT_READY', 'AGENT_HISTORY_INVALID', 'AGENT_HISTORY_UNAVAILABLE']),
  message: z.string(),
  context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
}).strict();
export type AgentFailure = z.infer<typeof AgentFailureSchema>;

export class SessionWorkspaceUnavailable extends TaggedError('SessionWorkspaceUnavailable')<{ workspaceId: string; message: string }> {
  readonly code = 'AGENT_WORKSPACE_UNAVAILABLE';
  toJSON(): AgentFailure { return { domain: 'agent', code: this.code, message: this.message, context: { workspaceId: this.workspaceId } }; }
}
export class SessionProjectUnavailable extends TaggedError('SessionProjectUnavailable')<{ projectId: string; message: string }> {
  readonly code = 'AGENT_PROJECT_UNAVAILABLE';
  toJSON(): AgentFailure { return { domain: 'agent', code: this.code, message: this.message, context: { projectId: this.projectId } }; }
}
export class SessionPossessionDenied extends TaggedError('SessionPossessionDenied')<{ workspaceId: string; message: string }> {
  readonly code = 'AGENT_POSSESSION_DENIED';
  toJSON(): AgentFailure { return { domain: 'agent', code: this.code, message: this.message, context: { workspaceId: this.workspaceId } }; }
}
export class SessionRuntimeError extends TaggedError('SessionRuntimeError')<{ sessionId?: string; operation: string; message: string }> {
  readonly code = 'AGENT_RUNTIME_FAILED';
  toJSON(): AgentFailure { return { domain: 'agent', code: this.code, message: this.message, context: { operation: this.operation, ...(this.sessionId ? { sessionId: this.sessionId } : {}) } }; }
}
export class AgentDomainError extends Error {
  readonly domain = 'agent';
  constructor(readonly failure: AgentFailure) { super(failure.message); this.name = 'AgentDomainError'; }
  get code(): AgentFailure['code'] { return this.failure.code; }
  get context(): AgentFailure['context'] { return this.failure.context; }
  toJSON(): AgentFailure { return this.failure; }
}
export type MachineSessionError = SessionWorkspaceUnavailable | SessionProjectUnavailable | SessionPossessionDenied | SessionRuntimeError | AgentDomainError;

export function agentFailure(error: unknown, code: AgentFailure['code'], context: AgentFailure['context'] = {}): AgentFailure {
  if (error instanceof AgentDomainError || error instanceof SessionRuntimeError || error instanceof SessionWorkspaceUnavailable || error instanceof SessionProjectUnavailable || error instanceof SessionPossessionDenied) return error.toJSON();
  const serialized = AgentFailureSchema.safeParse(error);
  if (serialized.success) return serialized.data;
  return { domain: 'agent', code, message: failureMessage(error), context };
}

export function failureMessage(error: unknown): string {
  if (error instanceof AggregateError) return `${error.message}: ${error.errors.map(failureMessage).join('; ')}`;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return String(error);
}

export function agentHistoryError(code: 'AGENT_HISTORY_INVALID' | 'AGENT_HISTORY_UNAVAILABLE', message: string, context: AgentFailure['context'] = {}): AgentDomainError {
  return new AgentDomainError({ domain: 'agent', code, message, context });
}
