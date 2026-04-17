/**
 * useSessionEngine — internal multi-backend session engine.
 *
 * This is a private internal module used by useRemoteSessionClient.
 * For local TUI use, prefer useMultiBackends (src/machine/multi/useMultiBackends.ts).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { BackendManager } from './backend-manager.js';
import {
  createInitialSessionEngineState,
  sessionEngineReducer,
} from './reducer.js';
import type {
  BackendSessionState,
  SessionEngineState,
} from './types.js';
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
} from './backend.js';
import type { BackendManagerEvent } from './backend-manager.js';
import type { NotificationConfig } from '../notifications/types.js';
import type { WideEventFilter } from '../types/events.js';
import type { SessionLinearIssueSummary } from '../types/lifecycle.js';
import type {
  BundleConfigState,
  BundleConfigSubmission,
} from '../types/bundle-config.js';
import type { WorkspacePhase } from '../types/config.js';
import type {
  BundleRefreshPlan,
  BundleRefreshSubmission,
} from '../types/bundle-refresh.js';
import type { ReviewOperation, ReviewResult } from '../types/review.js';
import type {
  ReplayFrame,
  ReplayFrameTarget,
  ReplayTimeline,
  TerminalSnapshot,
} from '../lib/tmux-lite/replay/index.js';
import type { BackendEvent } from './events.js';
import { SpacesError } from '../types/errors.js';

function dispatchBackendEvent(
  dispatch: React.Dispatch<import('./types.js').SessionEngineAction>,
  backendKey: BackendKey,
  event: BackendEvent
): void {
  switch (event.type) {
    case 'status':
      dispatch({ type: 'SET_BACKEND_STATUS', backendKey, status: event.status, error: event.error ?? null });
      break;
    case 'projects':
      dispatch({ type: 'SET_PROJECTS', backendKey, projects: event.projects });
      break;
    case 'workspaces':
      dispatch({ type: 'SET_WORKSPACES', backendKey, workspaces: event.workspaces });
      if (event.savedEventFilters) {
        dispatch({ type: 'SET_SAVED_EVENT_FILTERS', backendKey, filters: event.savedEventFilters });
      }
      break;
    case 'sessions':
      dispatch({ type: 'SET_SESSIONS', backendKey, sessions: event.sessions });
      break;
    case 'replays':
      dispatch({ type: 'SET_REPLAYS', backendKey, replays: event.replays });
      break;
    case 'inbox':
      dispatch({ type: 'SET_INBOX', backendKey, items: event.items, unreadCount: event.unreadCount });
      break;
    case 'notification_config':
      dispatch({ type: 'SET_NOTIFICATION_CONFIG', backendKey, config: event.config });
      break;
    case 'attached':
      dispatch({
        type: 'SET_ATTACHED_SESSION',
        backendKey,
        sessionId: event.sessionId,
        sessionName: event.sessionName ?? null,
        meta: {
          sessionName: event.sessionName ?? null,
        },
        workspaceId: event.workspaceId ?? null,
        agentSessionId: event.agentSessionId ?? null,
      });
      break;
    case 'session_meta':
      dispatch({ type: 'SET_ATTACHED_SESSION_META', backendKey, meta: event.meta });
      break;
    case 'detached':
      dispatch({ type: 'SET_ATTACHED_SESSION', backendKey, sessionId: null });
      break;
    case 'session_exited':
      dispatch({ type: 'SET_ATTACHED_SESSION', backendKey, sessionId: null, preserveContextOnExit: true });
      break;
    case 'command_error':
      dispatch({ type: 'SET_COMMAND_ERROR', backendKey, commandError: { code: event.code, message: event.message } });
      break;
    case 'error':
      dispatch({ type: 'SET_BACKEND_STATUS', backendKey, status: 'error', error: event.message });
      break;
    case 'script_output':
      dispatch({
        type: 'SET_SCRIPT_STATE',
        backendKey,
        scriptState: event.done && !event.error
          ? null
          : { phase: event.phase, isRunning: !event.done, error: event.error, exitCode: event.exitCode },
      });
      break;
    case 'events':
      dispatch({ type: 'SET_EVENTS', backendKey, events: event.events, liveEventIds: event.liveEventIds });
      if (event.savedEventFilters) {
        dispatch({ type: 'SET_SAVED_EVENT_FILTERS', backendKey, filters: event.savedEventFilters });
      }
      break;
    case 'machine_snapshot':
      dispatch({ type: 'SET_MACHINE_SNAPSHOT', backendKey, snapshot: event.snapshot });
      break;
    case 'host_ui_dialog_request':
      dispatch({ type: 'SET_HOST_UI_DIALOG', backendKey, request: event.request });
      break;
    case 'host_ui_event':
      if (event.event.type === 'working-message') {
        dispatch({ type: 'SET_HOST_UI_WORKING_MESSAGE', backendKey, message: event.event.payload.message });
      }
      break;
    case 'process_started':
      // Process events are reflected in machine_snapshot; no separate dispatch needed
      break;
    case 'process_stopped':
      break;
    default:
      break;
  }
}

export function useSessionEngine() {
  const [state, dispatch] = useReducer(sessionEngineReducer, undefined, createInitialSessionEngineState);
  const stateRef = useRef<SessionEngineState>(state);
  const managerRef = useRef<BackendManager | null>(null);

  useEffect(() => { stateRef.current = state; });

  const getManager = useCallback((): BackendManager => {
    if (!managerRef.current) {
      managerRef.current = new BackendManager((evt: BackendManagerEvent) => {
        dispatchBackendEvent(dispatch, evt.backendKey, evt.event);
      });
    }
    return managerRef.current;
  }, []);

  useEffect(() => {
    return () => {
      managerRef.current?.disconnectAll().catch(() => undefined);
    };
  }, []);

  const registerBackend = useCallback((backend: SessionBackend): void => {
    dispatch({ type: 'REGISTER_BACKEND', descriptor: backend.descriptor });
    getManager().register(backend);
  }, [getManager]);

  const unregisterBackend = useCallback(async (backendKey: BackendKey): Promise<void> => {
    await getManager().unregister(backendKey);
    dispatch({ type: 'UNREGISTER_BACKEND', backendKey });
  }, [getManager]);

  const setActiveBackend = useCallback((backendKey: BackendKey | null): void => {
    dispatch({ type: 'SET_ACTIVE_BACKEND', backendKey });
  }, []);

  const connectBackend = useCallback(async (backendKey: BackendKey): Promise<void> => {
    dispatch({ type: 'SET_BACKEND_STATUS', backendKey, status: 'connecting' });
    await getManager().connect(backendKey);
  }, [getManager]);

  const disconnectBackend = useCallback(async (backendKey: BackendKey): Promise<void> => {
    await getManager().disconnect(backendKey);
    dispatch({ type: 'SET_ATTACHED_SESSION', backendKey, sessionId: null });
    dispatch({ type: 'SET_BACKEND_STATUS', backendKey, status: 'disconnected' });
  }, [getManager]);

  const getBackendState = useCallback((backendKey: BackendKey): BackendSessionState | null => {
    return stateRef.current.backends[backendKey] ?? null;
  }, []);

  function withBackend<T>(backendKey: BackendKey, fn: (b: SessionBackend) => Promise<T>): Promise<T> {
    const backend = managerRef.current?.get(backendKey);
    if (!backend) throw new SpacesError(`Backend not found: ${backendKey}`, 'SYSTEM_ERROR', 2);
    return fn(backend);
  }

  const listProjects = useCallback((backendKey: BackendKey) =>
    withBackend(backendKey, (b) => b.listProjects()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const listGithubRepos = useCallback((backendKey: BackendKey, org?: string) =>
    withBackend(backendKey, (b) => b.listGithubRepos(org)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const listRemoteBranches = useCallback((backendKey: BackendKey, projectName: string) =>
    withBackend(backendKey, (b) => b.listRemoteBranches(projectName)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const listLinearIssues = useCallback((backendKey: BackendKey, projectName: string): Promise<SessionLinearIssueSummary[]> =>
    withBackend(backendKey, (b) => b.listLinearIssues(projectName)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const listWorkspaces = useCallback((backendKey: BackendKey) =>
    withBackend(backendKey, (b) => b.listWorkspaces()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const setWorkspaceStatus = useCallback((backendKey: BackendKey, projectName: string, workspaceName: string, phase: WorkspacePhase) =>
    withBackend(backendKey, (b) => b.setWorkspaceStatus?.(projectName, workspaceName, phase) ?? Promise.resolve()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const listSessions = useCallback((backendKey: BackendKey, workspaceId?: string) =>
    withBackend(backendKey, (b) => b.listSessions(workspaceId)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const listReplays = useCallback((backendKey: BackendKey, workspaceId?: string, includeDismissed?: boolean) =>
    withBackend(backendKey, (b) => b.listReplays?.(workspaceId, includeDismissed) ?? Promise.resolve()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const createProject = useCallback((backendKey: BackendKey, params: CreateProjectParams) =>
    withBackend(backendKey, async (b) => { await b.createProject(params); await b.listProjects(); await b.listWorkspaces(); }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const prepareProjectCreation = useCallback((backendKey: BackendKey, params: CreateProjectParams): Promise<PreparedProjectResult> =>
    withBackend(backendKey, (b) => {
      if (!b.prepareProjectCreation) throw new SpacesError('Project preparation unavailable', 'SYSTEM_ERROR', 2);
      return b.prepareProjectCreation(params);
    }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const finalizeProjectCreation = useCallback((backendKey: BackendKey, params: FinalizeProjectParams) =>
    withBackend(backendKey, async (b) => {
      if (!b.finalizeProjectCreation) throw new SpacesError('Project finalization unavailable', 'SYSTEM_ERROR', 2);
      await b.finalizeProjectCreation(params); await b.listProjects(); await b.listWorkspaces();
    }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const cancelProjectCreation = useCallback((backendKey: BackendKey, projectName: string) =>
    withBackend(backendKey, async (b) => {
      if (!b.cancelProjectCreation) throw new SpacesError('Project cancellation unavailable', 'SYSTEM_ERROR', 2);
      await b.cancelProjectCreation(projectName); await b.listProjects(); await b.listWorkspaces();
    }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const createWorkspace = useCallback((backendKey: BackendKey, params: CreateWorkspaceParams) =>
    withBackend(backendKey, async (b) => { await b.createWorkspace(params); await b.listWorkspaces(); }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteProject = useCallback((backendKey: BackendKey, projectName: string, params?: DeleteProjectParams) =>
    withBackend(backendKey, async (b) => { await b.deleteProject(projectName, params); await b.listProjects(); await b.listWorkspaces(); }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const attachSession = useCallback((backendKey: BackendKey, params: AttachSessionParams) =>
    withBackend(backendKey, (b) => b.attachSession(params)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const detachSession = useCallback((backendKey: BackendKey) =>
    withBackend(backendKey, (b) => b.detachSession()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const cancelPendingScripts = useCallback((backendKey: BackendKey) =>
    withBackend(backendKey, (b) => b.cancelPendingScripts?.() ?? Promise.resolve()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const cancelPendingReplayRequests = useCallback((backendKey: BackendKey): void => {
    managerRef.current?.get(backendKey)?.cancelPendingReplayRequests?.();
  }, []);

  const killSession = useCallback((backendKey: BackendKey, sessionId: string) =>
    withBackend(backendKey, (b) => b.killSession(sessionId)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteWorkspace = useCallback((backendKey: BackendKey, projectName: string, workspaceId: string, params?: DeleteWorkspaceParams) =>
    withBackend(backendKey, (b) => b.deleteWorkspace(projectName, workspaceId, params)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const getBundleRefreshPlan = useCallback((backendKey: BackendKey, projectName: string, workspaceId: string): Promise<BundleRefreshPlan> =>
    withBackend(backendKey, (b) => b.getBundleRefreshPlan(projectName, workspaceId)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyBundleRefresh = useCallback((backendKey: BackendKey, projectName: string, workspaceId: string, submission: BundleRefreshSubmission) =>
    withBackend(backendKey, (b) => b.applyBundleRefresh(projectName, workspaceId, submission)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const getBundleConfigState = useCallback((backendKey: BackendKey, projectName: string, workspaceId: string): Promise<BundleConfigState> =>
    withBackend(backendKey, (b) => b.getBundleConfigState(projectName, workspaceId)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyBundleConfigUpdate = useCallback((backendKey: BackendKey, projectName: string, workspaceId: string, submission: BundleConfigSubmission) =>
    withBackend(backendKey, (b) => b.applyBundleConfigUpdate(projectName, workspaceId, submission)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const requestInbox = useCallback((backendKey: BackendKey) =>
    withBackend(backendKey, (b) => b.requestInbox()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const clearInbox = useCallback((backendKey: BackendKey, id?: string) =>
    withBackend(backendKey, (b) => b.clearInbox(id)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const markInboxRead = useCallback((backendKey: BackendKey, id: string) =>
    withBackend(backendKey, (b) => b.markInboxRead(id)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const getNotificationConfig = useCallback((backendKey: BackendKey) =>
    withBackend(backendKey, (b) => b.getNotificationConfig()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const updateNotificationConfig = useCallback((backendKey: BackendKey, config: NotificationConfig) =>
    withBackend(backendKey, (b) => b.updateNotificationConfig(config)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const sendReviewRequest = useCallback((backendKey: BackendKey, operation: ReviewOperation): Promise<ReviewResult> =>
    withBackend(backendKey, (b) => b.sendReviewRequest(operation)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const startProcess = useCallback((backendKey: BackendKey, workspaceId: string, processName: string, instance?: number) =>
    withBackend(backendKey, (b) => b.startProcess?.(workspaceId, processName, instance) ?? Promise.resolve()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const stopProcess = useCallback((backendKey: BackendKey, workspaceId: string, processName: string) =>
    withBackend(backendKey, (b) => b.stopProcess?.(workspaceId, processName) ?? Promise.resolve()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const requestEvents = useCallback((backendKey: BackendKey, workspacePath: string, filter?: WideEventFilter, limit?: number, sinceMs?: number) =>
    withBackend(backendKey, (b) => b.requestEvents?.(workspacePath, filter, limit, sinceMs) ?? Promise.resolve()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const getReplaySnapshot = useCallback((backendKey: BackendKey, replayId: string, atMs?: number, scrollbackLines?: number): Promise<TerminalSnapshot> =>
    withBackend(backendKey, (b) => {
      if (!b.getReplaySnapshot) throw new SpacesError('Replay snapshot unavailable', 'SYSTEM_ERROR', 2);
      return b.getReplaySnapshot(replayId, atMs, scrollbackLines);
    }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const getReplayText = useCallback((backendKey: BackendKey, replayId: string, atMs?: number, scrollbackLines?: number, includeScrollback?: boolean, trimTrailingBlankRows?: boolean): Promise<string> =>
    withBackend(backendKey, (b) => {
      if (!b.getReplayText) throw new SpacesError('Replay text unavailable', 'SYSTEM_ERROR', 2);
      return b.getReplayText(replayId, atMs, scrollbackLines, includeScrollback, trimTrailingBlankRows);
    }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const getReplayMarkdown = useCallback((backendKey: BackendKey, replayId: string, atMs?: number, scrollbackLines?: number, includeScrollback?: boolean, trimTrailingBlankRows?: boolean): Promise<string> =>
    withBackend(backendKey, (b) => {
      if (!b.getReplayMarkdown) throw new SpacesError('Replay markdown unavailable', 'SYSTEM_ERROR', 2);
      return b.getReplayMarkdown(replayId, atMs, scrollbackLines, includeScrollback, trimTrailingBlankRows);
    }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const getReplayFrame = useCallback((backendKey: BackendKey, replayId: string, target?: ReplayFrameTarget): Promise<ReplayFrame> =>
    withBackend(backendKey, (b) => {
      if (!b.getReplayFrame) throw new SpacesError('Replay frame unavailable', 'SYSTEM_ERROR', 2);
      return b.getReplayFrame(replayId, target);
    }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const getReplayTimeline = useCallback((backendKey: BackendKey, replayId: string): Promise<ReplayTimeline> =>
    withBackend(backendKey, (b) => {
      if (!b.getReplayTimeline) throw new SpacesError('Replay timeline unavailable', 'SYSTEM_ERROR', 2);
      return b.getReplayTimeline(replayId);
    }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const dismissReplay = useCallback((backendKey: BackendKey, replayId: string) =>
    withBackend(backendKey, (b) => b.dismissReplay?.(replayId) ?? Promise.resolve()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const undismissReplay = useCallback((backendKey: BackendKey, replayId: string) =>
    withBackend(backendKey, (b) => b.undismissReplay?.(replayId) ?? Promise.resolve()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const activeBackendState = useMemo(() => {
    if (!state.activeBackendKey) return null;
    return state.backends[state.activeBackendKey] ?? null;
  }, [state]);

  return {
    state,
    activeBackendKey: state.activeBackendKey,
    activeBackendState,
    backendKeys: state.backendOrder,
    getBackendState,
    registerBackend,
    unregisterBackend,
    setActiveBackend,
    connectBackend,
    disconnectBackend,
    listProjects,
    listGithubRepos,
    listRemoteBranches,
    listLinearIssues,
    listWorkspaces,
    setWorkspaceStatus,
    listSessions,
    listReplays,
    createProject,
    prepareProjectCreation,
    finalizeProjectCreation,
    cancelProjectCreation,
    createWorkspace,
    deleteProject,
    attachSession,
    detachSession,
    cancelPendingScripts,
    cancelPendingReplayRequests,
    killSession,
    deleteWorkspace,
    getBundleRefreshPlan,
    applyBundleRefresh,
    getBundleConfigState,
    applyBundleConfigUpdate,
    requestInbox,
    clearInbox,
    markInboxRead,
    getNotificationConfig,
    updateNotificationConfig,
    sendReviewRequest,
    startProcess,
    stopProcess,
    requestEvents,
    getReplaySnapshot,
    getReplayText,
    getReplayMarkdown,
    getReplayFrame,
    getReplayTimeline,
    dismissReplay,
    undismissReplay,
  };
}

export type UseSessionEngineResult = ReturnType<typeof useSessionEngine>;
