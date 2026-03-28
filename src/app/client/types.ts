import type { BackendScopedAgentSessionRef, BackendScopedWorkspaceRef } from '../../machine/multi/types.js';

export interface AppClientAgentSessionSummary {
  id: string;
  title: string;
  updatedAt?: string;
  closedAt?: string;
  archivedAt?: string;
}

export interface AppClientAgentSessionOpenValue {
  workspaceRef: BackendScopedWorkspaceRef;
  agentSessionRef: BackendScopedAgentSessionRef;
}

export interface AppClientAgentSessionMutationValue {
  workspaceRef: BackendScopedWorkspaceRef;
  agentSessionRef: BackendScopedAgentSessionRef;
  sessions?: AppClientAgentSessionSummary[];
}

export type AppClientResult<TValue, TError> =
  | { ok: true; value: TValue }
  | { ok: false; error: TError };
