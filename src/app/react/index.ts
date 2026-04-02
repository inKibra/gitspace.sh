export { AppClientProvider, type AppClientProviderProps } from './AppClientProvider.js';
export { useAppClient } from './useAppClient.js';
export {
  useAgentSessionActions,
  type AgentSessionOpenCallbacks,
  type UseAgentSessionActionsOptions,
  type UseAgentSessionActionsResult,
} from './useAgentSessionActions.js';

export {
  useWorkspaceLifecycleActions,
  type UseWorkspaceLifecycleActionsOptions,
  type UseWorkspaceLifecycleActionsResult,
} from './useWorkspaceLifecycleActions.js';
export {
  useProcessActions,
  type UseProcessActionsOptions,
  type UseProcessActionsResult,
} from './useProcessActions.js';
export { useInboxActions, type UseInboxActionsOptions } from './useInboxActions.js';
export {
  useBundleRefreshAttachFlow,
  useBundleConfigFlow,
  type UseAppBundleRefreshAttachFlowOptions,
  type UseAppBundleConfigFlowOptions,
} from './useBundleFlows.js';
export { useReplayReviewActions, type UseReplayReviewActionsOptions } from './useReplayReviewActions.js';
export { useSessionActions, type UseSessionActionsOptions } from './useSessionActions.js';
export { useLifecycleActions, type UseLifecycleActionsOptions } from './useLifecycleActions.js';
export { useAttachActions, useTuiAttachActions, type UseAttachActionsOptions, type UseTuiAttachActionsOptions } from './useAttachActions.js';
export { useCommandPaletteOrchestration, type UseCommandPaletteOrchestrationOptions } from './useCommandPaletteOrchestration.js';
export { useInboxPage, type UseInboxPageOptions } from './useInboxPage.js';
export { useReview, type UseReviewOptions, type UseReviewReturn } from './useReview.js';
export { usePreferencesAdapter, type PreferencesService, type UsePreferencesAdapterOptions, type UsePreferencesAdapterResult } from './usePreferencesAdapter.js';
// Web-safe shell adapters
export {
  useUserActivity,
  buildEditProcessesCommand,
} from './shell-adapters.js';

export { useWorkspaceController, type UseWorkspaceControllerArgs } from './useWorkspaceSelection.js';