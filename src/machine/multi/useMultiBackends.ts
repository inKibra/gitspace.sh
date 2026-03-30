/**
 * useMultiBackends — React hook wrapping GitSpaceEngine.
 *
 * This is a backwards-compatible adapter: same options, same return type,
 * but delegates all state management and action routing to the pure
 * GitSpaceEngine class. Shells and components that already import this
 * hook continue to work unchanged.
 *
 * New code should prefer `<GitSpaceProvider>` + `useGitSpace()` from
 * `src/sdk/react.tsx` instead.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitSpaceEngine, LOCAL_BACKEND_KEY } from '../../sdk/engine/engine.js';
import type { GitSpaceConfig } from '../../sdk/engine/types.js';
import type { BackendSessionState } from '../../session/types.js';
import type {
  AttachSessionParams,
  BackendKey,
  CreateProjectParams,
  CreateWorkspaceParams,
  DeleteProjectParams,
  DeleteWorkspaceParams,
  FinalizeProjectParams,
  PreparedProjectResult,
  SessionBackend,
} from '../../session/backend.js';
import type { NotificationConfig } from '../../notifications/types.js';
import type { WideEventFilter } from '../../types/events.js';
import type { SessionLinearIssueSummary } from '../../types/lifecycle.js';
import type {
  BundleConfigState,
  BundleConfigSubmission,
} from '../../types/bundle-config.js';
import type { WorkspacePhase } from '../../types/config.js';
import type {
  BundleRefreshPlan,
  BundleRefreshSubmission,
} from '../../types/bundle-refresh.js';
import type { ReviewOperation, ReviewResult } from '../../types/review.js';
import type {
  ReplayFrame,
  ReplayFrameTarget,
  ReplayTimeline,
  TerminalSnapshot,
} from '../../lib/tmux-lite/replay/index.js';
import type { RelayDescriptor, RelaySocketAdapter, RelaySigner } from '../../relay-client/index.js';
import type { Identity } from '../../types/identity.js';
import type {
  BackendScopedAgentSessionRef,
  BackendScopedSessionRef,
  BackendScopedWorkspaceRef,
  MultiMachineState,
} from './types.js';

export { LOCAL_BACKEND_KEY };

export type LocalSessionPtyBackend = SessionBackend & {
  setPtyOutputHandler(handler: ((data: Uint8Array) => void) | null): void;
};

export interface CreateRemoteBackendParams {
  relayUrl: string;
  identity: Identity;
  machineId: string;
  deviceCertificate: string;
  machineLabel?: string;
}

export interface UseMultiBackendsOptions {
  enabled?: boolean;
  relay?: RelayDescriptor | null;
  identity?: Identity | null;
  createLocalBackend?: (() => SessionBackend) | null;
  createRemoteBackend?: (params: CreateRemoteBackendParams) => { backendKey: BackendKey; backend: SessionBackend };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relaySocketAdapter?: RelaySocketAdapter<any>;
  createRelaySigner?: (identity: Identity) => RelaySigner;
  getDeviceCertificate?: (identity: Identity) => Promise<string>;
}

/**
 * useMultiBackends — the top-level multi-machine backend registry.
 *
 * Delegates to GitSpaceEngine internally. Replaces the former 800+ line
 * implementation with a thin lifecycle wrapper.
 */
export function useMultiBackends(options: UseMultiBackendsOptions = {}) {
  const {
    enabled = true,
    relay,
    identity,
    createLocalBackend,
    createRemoteBackend,
    relaySocketAdapter,
    createRelaySigner,
    getDeviceCertificate,
  } = options;

  // Store platform factories in refs so engine creation uses latest values
  // without re-creating the engine when inline callbacks get new references.
  const platformRef = useRef({
    createLocalBackend,
    createRemoteBackend,
    relaySocketAdapter,
    createRelaySigner,
    getDeviceCertificate,
  });
  useEffect(() => {
    platformRef.current = {
      createLocalBackend,
      createRemoteBackend,
      relaySocketAdapter,
      createRelaySigner,
      getDeviceCertificate,
    };
  });

  // Create engine once — config changes handled via updateConfig
  const engineRef = useRef<GitSpaceEngine | null>(null);
  if (!engineRef.current) {
    const config: GitSpaceConfig = {
      platform: {
        createLocalBackend: platformRef.current.createLocalBackend ?? undefined,
        createRemoteBackend: platformRef.current.createRemoteBackend,
        relaySocketAdapter: platformRef.current.relaySocketAdapter,
        createRelaySigner: platformRef.current.createRelaySigner,
        getDeviceCertificate: platformRef.current.getDeviceCertificate,
      },
      relay: enabled ? relay : null,
      identity: enabled ? identity : null,
    };
    engineRef.current = new GitSpaceEngine(config);
  }
  const engine = engineRef.current;

  // Start engine on mount, destroy on unmount
  useEffect(() => {
    engine.start().catch(() => {});
    return () => { engine.destroy().catch(() => {}); };
  }, [engine]);

  // Sync config changes (enabled toggle, relay/identity changes)
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    engine.updateConfig({
      relay: enabled ? relay : null,
      identity: enabled ? identity : null,
    }).catch(() => {});
  }, [enabled, relay?.url, identity?.id, engine]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to state
  const [state, setState] = useState<MultiMachineState>(() => engine.getState());
  useEffect(() => {
    setState(engine.getState());
    return engine.subscribe(setState);
  }, [engine]);

  // ─── Stable action callbacks ──────────────────────────────────────────────
  // These bind to the engine ref so they stay identity-stable across renders.

  const getBackend = useCallback((key: BackendKey): SessionBackend | null => {
    return engine.getBackend(key);
  }, [engine]);

  const getBackendState = useCallback((key: BackendKey): BackendSessionState | null => {
    return engine.getBackendState(key);
  }, [engine]);

  // Fanout
  const listProjects = useCallback(() => engine.listProjects(), [engine]);
  const listWorkspaces = useCallback(() => engine.listWorkspaces(), [engine]);
  const listSessions = useCallback((workspaceId?: string) => engine.listSessions(workspaceId), [engine]);
  const listReplays = useCallback((workspaceId?: string, includeDismissed?: boolean) => engine.listReplays(workspaceId, includeDismissed), [engine]);
  const requestInbox = useCallback(() => engine.requestInbox(), [engine]);
  const clearInbox = useCallback((id?: string) => engine.clearInbox(id), [engine]);
  const markInboxRead = useCallback((id: string) => engine.markInboxRead(id), [engine]);
  const getNotificationConfig = useCallback(() => engine.getNotificationConfig(), [engine]);
  const updateNotificationConfig = useCallback((config: NotificationConfig) => engine.updateNotificationConfig(config), [engine]);

  // Ref-scoped
  const attachSession = useCallback((ref: BackendScopedWorkspaceRef, params: AttachSessionParams) => engine.attachSession(ref, params), [engine]);
  const detachSession = useCallback((ref: BackendScopedWorkspaceRef | BackendScopedSessionRef) => engine.detachSession(ref), [engine]);
  const cancelPendingScripts = useCallback((ref: BackendScopedWorkspaceRef) => engine.cancelPendingScripts(ref), [engine]);
  const killSession = useCallback((ref: BackendScopedSessionRef) => engine.killSession(ref), [engine]);
  const deleteWorkspace = useCallback((ref: BackendScopedWorkspaceRef, params?: DeleteWorkspaceParams) => engine.deleteWorkspace(ref, params), [engine]);
  const setWorkspaceStatus = useCallback((ref: BackendScopedWorkspaceRef, phase: WorkspacePhase) => engine.setWorkspaceStatus(ref, phase), [engine]);
  const startProcess = useCallback((ref: BackendScopedWorkspaceRef, processName: string, instance?: number) => engine.startProcess(ref, processName, instance), [engine]);
  const stopProcess = useCallback((ref: BackendScopedWorkspaceRef, processName: string) => engine.stopProcess(ref, processName), [engine]);
  const requestEvents = useCallback((ref: BackendScopedWorkspaceRef, filter?: WideEventFilter, limit?: number, sinceMs?: number) => engine.requestEvents(ref, filter, limit, sinceMs), [engine]);
  const getBundleRefreshPlan = useCallback((ref: BackendScopedWorkspaceRef) => engine.getBundleRefreshPlan(ref), [engine]);
  const applyBundleRefresh = useCallback((ref: BackendScopedWorkspaceRef, submission: BundleRefreshSubmission) => engine.applyBundleRefresh(ref, submission), [engine]);
  const getBundleConfigState = useCallback((ref: BackendScopedWorkspaceRef) => engine.getBundleConfigState(ref), [engine]);
  const applyBundleConfigUpdate = useCallback((ref: BackendScopedWorkspaceRef, submission: BundleConfigSubmission) => engine.applyBundleConfigUpdate(ref, submission), [engine]);
  const createCheckpoint = useCallback((ref: BackendScopedSessionRef) => engine.createCheckpoint(ref), [engine]);
  const sendReviewRequest = useCallback((ref: BackendScopedWorkspaceRef | BackendScopedSessionRef, operation: ReviewOperation): Promise<ReviewResult> => engine.sendReviewRequest(ref, operation), [engine]);

  // Agent session
  const respondToAgentPermission = useCallback((ref: BackendScopedAgentSessionRef, permissionId: string, response: 'allow' | 'deny') => engine.respondToAgentPermission(ref, permissionId, response), [engine]);
  const createAgentSession = useCallback((ref: BackendScopedWorkspaceRef, title?: string) => engine.createAgentSession(ref, title), [engine]);
  const abortAgentSession = useCallback((ref: BackendScopedAgentSessionRef) => engine.abortAgentSession(ref), [engine]);
  const closeAgentSession = useCallback((ref: BackendScopedAgentSessionRef) => engine.closeAgentSession(ref), [engine]);
  const archiveAgentSession = useCallback((ref: BackendScopedAgentSessionRef) => engine.archiveAgentSession(ref), [engine]);
  const restoreAgentSession = useCallback((ref: BackendScopedAgentSessionRef) => engine.restoreAgentSession(ref), [engine]);
  const attachAgentSession = useCallback((ref: BackendScopedAgentSessionRef, attachOptions?: { viewOnly?: boolean }) => engine.attachAgentSession(ref, attachOptions), [engine]);
  const getAgentSessionPreference = useCallback((ref: BackendScopedWorkspaceRef) => engine.getAgentSessionPreference(ref), [engine]);
  const setAgentSessionPreference = useCallback((ref: BackendScopedWorkspaceRef, sessionId: string) => engine.setAgentSessionPreference(ref, sessionId), [engine]);

  // Backend-targeted
  const createProject = useCallback((backendKey: BackendKey, params: CreateProjectParams) => engine.createProject(backendKey, params), [engine]);
  const prepareProjectCreation = useCallback((backendKey: BackendKey, params: CreateProjectParams): Promise<PreparedProjectResult> => engine.prepareProjectCreation(backendKey, params), [engine]);
  const finalizeProjectCreation = useCallback((backendKey: BackendKey, params: FinalizeProjectParams) => engine.finalizeProjectCreation(backendKey, params), [engine]);
  const cancelProjectCreation = useCallback((backendKey: BackendKey, projectName: string) => engine.cancelProjectCreation(backendKey, projectName), [engine]);
  const createWorkspace = useCallback((backendKey: BackendKey, params: CreateWorkspaceParams) => engine.createWorkspace(backendKey, params), [engine]);
  const deleteProject = useCallback((backendKey: BackendKey, projectName: string, params?: DeleteProjectParams) => engine.deleteProject(backendKey, projectName, params), [engine]);
  const listGithubRepos = useCallback((backendKey: BackendKey, org?: string) => engine.listGithubRepos(backendKey, org), [engine]);
  const listRemoteBranches = useCallback((backendKey: BackendKey, projectName: string) => engine.listRemoteBranches(backendKey, projectName), [engine]);
  const listLinearIssues = useCallback((backendKey: BackendKey, projectName: string) => engine.listLinearIssues(backendKey, projectName), [engine]);

  // Replays
  const getReplaySnapshot = useCallback((backendKey: BackendKey, replayId: string, atMs?: number, scrollbackLines?: number): Promise<TerminalSnapshot> => engine.getReplaySnapshot(backendKey, replayId, atMs, scrollbackLines), [engine]);
  const getReplayText = useCallback((backendKey: BackendKey, replayId: string, atMs?: number, scrollbackLines?: number, includeScrollback?: boolean, trimTrailingBlankRows?: boolean): Promise<string> => engine.getReplayText(backendKey, replayId, atMs, scrollbackLines, includeScrollback, trimTrailingBlankRows), [engine]);
  const getReplayMarkdown = useCallback((backendKey: BackendKey, replayId: string, atMs?: number, scrollbackLines?: number, includeScrollback?: boolean, trimTrailingBlankRows?: boolean): Promise<string> => engine.getReplayMarkdown(backendKey, replayId, atMs, scrollbackLines, includeScrollback, trimTrailingBlankRows), [engine]);
  const getReplayFrame = useCallback((backendKey: BackendKey, replayId: string, target?: ReplayFrameTarget): Promise<ReplayFrame> => engine.getReplayFrame(backendKey, replayId, target), [engine]);
  const getReplayTimeline = useCallback((backendKey: BackendKey, replayId: string): Promise<ReplayTimeline> => engine.getReplayTimeline(backendKey, replayId), [engine]);
  const dismissReplay = useCallback((backendKey: BackendKey, replayId: string) => engine.dismissReplay(backendKey, replayId), [engine]);
  const undismissReplay = useCallback((backendKey: BackendKey, replayId: string) => engine.undismissReplay(backendKey, replayId), [engine]);
  const cancelPendingReplayRequests = useCallback((backendKey: BackendKey) => engine.cancelPendingReplayRequests(backendKey), [engine]);

  return {
    state,
    activeBackendKey: engine.activeBackendKey,
    localBackendKey: LOCAL_BACKEND_KEY,
    getBackend,
    getBackendState,

    listProjects,
    listWorkspaces,
    listSessions,
    listReplays,
    requestInbox,
    clearInbox,
    markInboxRead,
    getNotificationConfig,
    updateNotificationConfig,

    attachSession,
    detachSession,
    cancelPendingScripts,
    killSession,
    deleteWorkspace,
    setWorkspaceStatus,
    startProcess,
    stopProcess,
    requestEvents,
    getBundleRefreshPlan,
    applyBundleRefresh,
    getBundleConfigState,
    applyBundleConfigUpdate,
    createCheckpoint,
    sendReviewRequest,

    respondToAgentPermission,
    createAgentSession,
    abortAgentSession,
    closeAgentSession,
    archiveAgentSession,
    restoreAgentSession,
    attachAgentSession,
    getAgentSessionPreference,
    setAgentSessionPreference,

    createProject,
    prepareProjectCreation,
    finalizeProjectCreation,
    cancelProjectCreation,
    createWorkspace,
    deleteProject,
    listGithubRepos,
    listRemoteBranches,
    listLinearIssues,

    getReplaySnapshot,
    getReplayText,
    getReplayMarkdown,
    getReplayFrame,
    getReplayTimeline,
    dismissReplay,
    undismissReplay,
    cancelPendingReplayRequests,
  };
}

export type UseMultiBackendsResult = ReturnType<typeof useMultiBackends>;
