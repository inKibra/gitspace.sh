import { toBackendScopedWorkspaceKey, type BackendScopedAgentSessionRef, type BackendScopedWorkspaceRef } from '../../machine/multi/types.js';
import { agentSessionFailure, agentSessionSuccess, type AgentSessionCommandResult } from './errors.js';
import type { AppClientContext } from './context.js';
import type { AppClientAgentSessionSummary } from './types.js';

export function toAppClientWorkspaceKey(ref: BackendScopedWorkspaceRef): string {
  return toBackendScopedWorkspaceKey(ref);
}

export function getCurrentAgentSessions(
  context: AppClientContext,
  workspaceRef: BackendScopedWorkspaceRef,
): readonly AppClientAgentSessionSummary[] {
  return context.agentSessionsByWorkspaceKey?.[toAppClientWorkspaceKey(workspaceRef)] ?? [];
}

function getWorkspaceCandidates(
  context: AppClientContext,
  workspaceId: string,
): BackendScopedWorkspaceRef[] {
  return context.workspaceRefs.filter((ref) => ref.workspaceId === workspaceId);
}

export function resolveWorkspaceRef(
  context: AppClientContext,
  workspaceId: string,
): AgentSessionCommandResult<BackendScopedWorkspaceRef> {
  if (context.detailWorkspaceRef?.workspaceId === workspaceId) {
    return agentSessionSuccess(context.detailWorkspaceRef);
  }

  if (context.selectedWorkspaceRef?.workspaceId === workspaceId) {
    return agentSessionSuccess(context.selectedWorkspaceRef);
  }

  const candidates = getWorkspaceCandidates(context, workspaceId);
  if (candidates.length === 0) {
    return agentSessionFailure({
      code: 'workspace-not-found',
      message: `Workspace ${workspaceId} is not available`,
      workspaceId,
    });
  }

  if (context.preferredBackendKey) {
    const preferred = candidates.find((candidate) => candidate.backendKey === context.preferredBackendKey);
    if (preferred) {
      return agentSessionSuccess(preferred);
    }
  }

  if (candidates.length === 1) {
    return agentSessionSuccess(candidates[0]!);
  }

  return agentSessionFailure({
    code: 'ambiguous-backend',
    message: `Workspace ${workspaceId} exists on multiple backends`,
    workspaceId,
    candidateBackendKeys: candidates.map((candidate) => candidate.backendKey),
  });
}

export function resolveAgentSessionRef(
  context: AppClientContext,
  workspaceId: string,
  agentSessionId: string,
): AgentSessionCommandResult<{ workspaceRef: BackendScopedWorkspaceRef; agentSessionRef: BackendScopedAgentSessionRef }> {
  const workspaceResult = resolveWorkspaceRef(context, workspaceId);
  if (!workspaceResult.ok) {
    return workspaceResult;
  }

  return agentSessionSuccess({
    workspaceRef: workspaceResult.value,
    agentSessionRef: {
      ...workspaceResult.value,
      agentSessionId,
    },
  });
}
