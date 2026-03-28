import type { BackendScopedWorkspaceRef } from '../../machine/multi/types.js';
import type { AppClient, AppClientContext } from '../client/index.js';
import { useAppClient } from './useAppClient.js';
import {
  useBundleRefreshAttachFlow as useSessionBundleRefreshAttachFlow,
  type UseBundleRefreshAttachFlowOptions,
  type UseBundleRefreshAttachFlowResult,
} from '../../session/useBundleRefreshAttachFlow.js';
import {
  useBundleConfigFlow as useSessionBundleConfigFlow,
  type UseBundleConfigFlowOptions,
  type UseBundleConfigFlowResult,
} from '../../session/useBundleConfigFlow.js';

export interface UseAppBundleRefreshAttachFlowOptions extends Omit<UseBundleRefreshAttachFlowOptions, 'getBundleRefreshPlan' | 'applyBundleRefresh'> {
  client?: AppClient | AppClientContext | null;
}

export interface UseAppBundleConfigFlowOptions extends Omit<UseBundleConfigFlowOptions, 'getBundleConfigState' | 'applyBundleConfigUpdate'> {
  client?: AppClient | AppClientContext | null;
}

export function useBundleRefreshAttachFlow(options: UseAppBundleRefreshAttachFlowOptions): UseBundleRefreshAttachFlowResult {
  const client = useAppClient(options.client ?? null);
  return useSessionBundleRefreshAttachFlow({
    ...options,
    getBundleRefreshPlan: async (ref: BackendScopedWorkspaceRef) => {
      const result = await client.bundles.getRefreshPlan(ref);
      if (!result.ok) throw result.error.cause ?? new Error(result.error.message);
      return result.value;
    },
    applyBundleRefresh: async (ref, submission) => {
      const result = await client.bundles.applyRefresh(ref, submission);
      if (!result.ok) throw result.error.cause ?? new Error(result.error.message);
    },
  });
}

export function useBundleConfigFlow(options: UseAppBundleConfigFlowOptions): UseBundleConfigFlowResult {
  const client = useAppClient(options.client ?? null);
  return useSessionBundleConfigFlow({
    ...options,
    getBundleConfigState: async (ref) => {
      const result = await client.bundles.getConfigState(ref);
      if (!result.ok) throw result.error.cause ?? new Error(result.error.message);
      return result.value;
    },
    applyBundleConfigUpdate: async (ref, submission) => {
      const result = await client.bundles.applyConfigUpdate(ref, submission);
      if (!result.ok) throw result.error.cause ?? new Error(result.error.message);
    },
  });
}
