import type { BundleRefreshPlan, BundleRefreshSubmission } from '../../types/bundle-refresh.js';
import type { BundleConfigState, BundleConfigSubmission } from '../../types/bundle-config.js';
import type { BackendScopedWorkspaceRef } from '../../machine/multi/types.js';
import type { AppClientContext } from './context.js';
import { agentSessionFailure, agentSessionSuccess, describeAppClientError, type AgentSessionCommandResult } from './errors.js';

export interface AppBundlesClient {
  getRefreshPlan: (ref: BackendScopedWorkspaceRef) => Promise<AgentSessionCommandResult<BundleRefreshPlan>>;
  applyRefresh: (ref: BackendScopedWorkspaceRef, submission: BundleRefreshSubmission) => Promise<AgentSessionCommandResult<BackendScopedWorkspaceRef>>;
  getConfigState: (ref: BackendScopedWorkspaceRef) => Promise<AgentSessionCommandResult<BundleConfigState>>;
  applyConfigUpdate: (ref: BackendScopedWorkspaceRef, submission: BundleConfigSubmission) => Promise<AgentSessionCommandResult<BackendScopedWorkspaceRef>>;
}

function splitWorkspaceId(workspaceId: string): { projectName: string; resolvedWorkspaceId: string } {
  const [projectName, ...rest] = workspaceId.split(':');
  return { projectName: projectName ?? '', resolvedWorkspaceId: rest.length > 0 ? `${projectName}:${rest.join(':')}` : workspaceId };
}

export function createAppBundlesClient(context: AppClientContext): AppBundlesClient {
  return {
    getRefreshPlan: async (ref) => {
      const backend = context.multi.getBackend(ref.backendKey);
      if (!backend) {
        return agentSessionFailure({ code: 'backend-unavailable', message: `Backend ${ref.backendKey} is not available`, workspaceId: ref.workspaceId, backendKey: ref.backendKey });
      }
      try {
        const parts = splitWorkspaceId(ref.workspaceId);
        const plan = await backend.getBundleRefreshPlan(parts.projectName, parts.resolvedWorkspaceId);
        return agentSessionSuccess(plan);
      } catch (error) {
        return agentSessionFailure({ code: 'operation-unavailable', message: describeAppClientError(error, 'Failed to load bundle refresh plan'), workspaceId: ref.workspaceId, backendKey: ref.backendKey, cause: error });
      }
    },
    applyRefresh: async (ref, submission) => {
      const backend = context.multi.getBackend(ref.backendKey);
      if (!backend) {
        return agentSessionFailure({ code: 'backend-unavailable', message: `Backend ${ref.backendKey} is not available`, workspaceId: ref.workspaceId, backendKey: ref.backendKey });
      }
      try {
        const parts = splitWorkspaceId(ref.workspaceId);
        await backend.applyBundleRefresh(parts.projectName, parts.resolvedWorkspaceId, submission);
        return agentSessionSuccess(ref);
      } catch (error) {
        return agentSessionFailure({ code: 'operation-unavailable', message: describeAppClientError(error, 'Failed to apply bundle refresh'), workspaceId: ref.workspaceId, backendKey: ref.backendKey, cause: error });
      }
    },
    getConfigState: async (ref) => {
      const backend = context.multi.getBackend(ref.backendKey);
      if (!backend) {
        return agentSessionFailure({ code: 'backend-unavailable', message: `Backend ${ref.backendKey} is not available`, workspaceId: ref.workspaceId, backendKey: ref.backendKey });
      }
      try {
        const parts = splitWorkspaceId(ref.workspaceId);
        const state = await backend.getBundleConfigState(parts.projectName, parts.resolvedWorkspaceId);
        return agentSessionSuccess(state);
      } catch (error) {
        return agentSessionFailure({ code: 'operation-unavailable', message: describeAppClientError(error, 'Failed to load bundle config state'), workspaceId: ref.workspaceId, backendKey: ref.backendKey, cause: error });
      }
    },
    applyConfigUpdate: async (ref, submission) => {
      const backend = context.multi.getBackend(ref.backendKey);
      if (!backend) {
        return agentSessionFailure({ code: 'backend-unavailable', message: `Backend ${ref.backendKey} is not available`, workspaceId: ref.workspaceId, backendKey: ref.backendKey });
      }
      try {
        const parts = splitWorkspaceId(ref.workspaceId);
        await backend.applyBundleConfigUpdate(parts.projectName, parts.resolvedWorkspaceId, submission);
        return agentSessionSuccess(ref);
      } catch (error) {
        return agentSessionFailure({ code: 'operation-unavailable', message: describeAppClientError(error, 'Failed to apply bundle config update'), workspaceId: ref.workspaceId, backendKey: ref.backendKey, cause: error });
      }
    },
  };
}
