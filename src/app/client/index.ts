import type { AppClientContext } from './context.js';
import { createAppAgentSessionsClient, type AppAgentSessionsClient } from './agent-sessions.js';
import { createAppWorkspaceLifecycleClient, type AppWorkspaceLifecycleClient } from './workspace-lifecycle.js';
import { createAppProcessesClient, type AppProcessesClient } from './processes.js';
import { createAppInboxClient, type AppInboxClient } from './inbox.js';
import { createAppBundlesClient, type AppBundlesClient } from './bundles.js';
import { createAppReplayReviewClient, type AppReplayReviewClient } from './replays-reviews.js';
import { createAppSessionsClient, type AppSessionsClient } from './sessions.js';
import { createAppLifecycleClient, type AppLifecycleClient } from './lifecycle.js';

export interface AppClient {
  agentSessions: AppAgentSessionsClient;
  workspaceLifecycle: AppWorkspaceLifecycleClient;
  processes: AppProcessesClient;
  inbox: AppInboxClient;
  bundles: AppBundlesClient;
  replayReview: AppReplayReviewClient;
  sessions: AppSessionsClient;
  lifecycle: AppLifecycleClient;
}

export function createAppClient(context: AppClientContext): AppClient {
  return {
    agentSessions: createAppAgentSessionsClient(context),
    workspaceLifecycle: createAppWorkspaceLifecycleClient(context),
    processes: createAppProcessesClient(context),
    inbox: createAppInboxClient(context),
    bundles: createAppBundlesClient(context),
    replayReview: createAppReplayReviewClient(context),
    sessions: createAppSessionsClient(context),
    lifecycle: createAppLifecycleClient(context),
  };
}

export type { AppClientContext, AppClientMulti } from './context.js';
export type {
  AppClientAgentSessionSummary,
  AppClientAgentSessionOpenValue,
  AppClientAgentSessionMutationValue,
  AppClientResult,
} from './types.js';
export type {
  AgentSessionCommandError,
  AgentSessionCommandErrorCode,
  AgentSessionCommandResult,
} from './errors.js';
export { describeAppClientError } from './errors.js';
export {
  resolveWorkspaceRef,
  resolveAgentSessionRef,
  toAppClientWorkspaceKey,
  getCurrentAgentSessions,
} from './refs.js';
export {
  createAppAgentSessionsClient,
  findCreatedAgentSession,
} from './agent-sessions.js';
export type {
  WorkspaceStatusChangeValue,
  WorkspaceDeleteValue,
} from './workspace-lifecycle.js';
export {
  createAppWorkspaceLifecycleClient,
} from './workspace-lifecycle.js';
export type { ProcessActionValue } from './processes.js';
export { createAppProcessesClient } from './processes.js';
export type { InboxActionValue, PermissionResponseValue } from './inbox.js';
export { createAppInboxClient } from './inbox.js';
export { createAppBundlesClient } from './bundles.js';
export { createAppReplayReviewClient } from './replays-reviews.js';
export { createAppSessionsClient } from './sessions.js';
export { createAppLifecycleClient } from './lifecycle.js';
