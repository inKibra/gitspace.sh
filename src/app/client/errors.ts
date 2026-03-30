import type { BackendKey } from '../../session/backend.js';
import type { AppClientResult } from './types.js';

export type AgentSessionCommandErrorCode =
  | 'workspace-not-found'
  | 'ambiguous-backend'
  | 'backend-unavailable'
  | 'operation-unavailable'
  | 'create-failed'
  | 'attach-failed'
  | 'abort-failed'
  | 'close-failed'
  | 'archive-failed'
  | 'restore-failed';

export interface AgentSessionCommandError {
  code: AgentSessionCommandErrorCode;
  message: string;
  workspaceId: string;
  agentSessionId?: string;
  backendKey?: BackendKey;
  candidateBackendKeys?: BackendKey[];
  cause?: unknown;
}

export type AgentSessionCommandResult<TValue> = AppClientResult<TValue, AgentSessionCommandError>;

export function agentSessionSuccess<TValue>(value: TValue): AgentSessionCommandResult<TValue> {
  return { ok: true, value };
}

export function agentSessionFailure<TValue>(error: AgentSessionCommandError): AgentSessionCommandResult<TValue> {
  return { ok: false, error };
}

export function describeAppClientError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.length > 0) {
    return error;
  }

  return fallback;
}
