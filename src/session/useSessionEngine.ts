import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { NotificationConfig } from '../notifications/types.js';
import type {
  BackendKey,
  SessionBackend,
  AttachSessionParams,
  CreateProjectParams,
  FinalizeProjectParams,
  PreparedProjectResult,
  CreateWorkspaceParams,
  DeleteProjectParams,
  DeleteWorkspaceParams,
} from './backend.js';
import type {
  BundleRefreshPlan,
  BundleRefreshSubmission,
} from '../types/bundle-refresh.js';
import type {
  BundleConfigState,
  BundleConfigSubmission,
} from '../types/bundle-config.js';
import type { ReviewOperation, ReviewResult } from '../types/review.js';
import type { ScriptPhase } from '../types/script-phase.js';
import type { WideEventFilter } from '../types/events.js';
import type { SessionLinearIssueSummary } from '../types/lifecycle.js';
import { BackendManager } from './backend-manager.js';
import {
  createInitialSessionEngineState,
  sessionEngineReducer,
} from './reducer.js';
import {
  getActiveBackendKey,
  getActiveBackendState,
  getBackendKeys,
  getBackendState,
} from './selectors.js';
import type { ScriptRuntimeState } from './types.js';
import { SpacesError } from '../types/errors.js';

function toScriptRuntimeState(event: {
  phase: ScriptPhase;
  done?: boolean;
  error?: string;
  exitCode?: number;
}): ScriptRuntimeState {
  return {
    phase: event.phase,
    isRunning: !event.done,
    error: event.error,
    exitCode: event.exitCode,
  };
}

export function useSessionEngine() {
  const [state, dispatch] = useReducer(sessionEngineReducer, undefined, createInitialSessionEngineState);

  const managerRef = useRef<BackendManager | null>(null);
  if (!managerRef.current) {
    managerRef.current = new BackendManager(({ backendKey, event }) => {
      switch (event.type) {
        case 'status':
          dispatch({
            type: 'SET_BACKEND_STATUS',
            backendKey,
            status: event.status,
            error: event.error ?? null,
          });
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
          dispatch({
            type: 'SET_INBOX',
            backendKey,
            items: event.items,
            unreadCount: event.unreadCount,
          });
          break;
        case 'notification_config':
          dispatch({
            type: 'SET_NOTIFICATION_CONFIG',
            backendKey,
            config: event.config,
          });
          break;
        case 'script_output':
          dispatch({
            type: 'SET_SCRIPT_STATE',
            backendKey,
            scriptState:
              event.done && !event.error
                ? null
                : toScriptRuntimeState(event),
          });
          break;
        case 'attached':
          dispatch({
            type: 'SET_ATTACHED_SESSION',
            backendKey,
            sessionId: event.sessionId,
            sessionName: event.sessionName ?? null,
          });
          break;
        case 'detached':
          dispatch({
            type: 'SET_ATTACHED_SESSION',
            backendKey,
            sessionId: null,
            sessionName: null,
          });
          break;
        case 'session_exited':
          dispatch({
            type: 'SET_ATTACHED_SESSION',
            backendKey,
            sessionId: null,
            sessionName: null,
          });
          break;
        case 'command_error':
          dispatch({
            type: 'SET_COMMAND_ERROR',
            backendKey,
            commandError: {
              code: event.code,
              message: event.message,
            },
          });
          break;
        case 'error':
          dispatch({
            type: 'SET_BACKEND_STATUS',
            backendKey,
            status: 'error',
            error: event.message,
          });
          break;
        case 'review_response':
          // Handled directly by RemoteSessionBackend's pending map — no state dispatch needed.
          break;
        case 'events':
          dispatch({
            type: 'SET_EVENTS',
            backendKey,
            events: event.events,
            liveEventIds: event.liveEventIds,
          });
          if (event.savedEventFilters) {
            dispatch({ type: 'SET_SAVED_EVENT_FILTERS', backendKey, filters: event.savedEventFilters });
          }
          break;
        case 'process_started':
        case 'process_stopped':
          // Refresh workspaces and sessions to reflect process state changes.
          // Important for remote/web clients that don't immediately call refresh.
          {
            const backend = managerRef.current?.get(backendKey);
            if (backend) {
              void backend.listWorkspaces().catch(() => undefined);
              void backend.listSessions().catch(() => undefined);
            }
          }
          break;
        default:
          break;
      }
    });
  }

  const manager = managerRef.current;

  useEffect(() => {
    return () => {
      void manager.disconnectAll();
    };
  }, [manager]);

  const registerBackend = useCallback((backend: SessionBackend) => {
    manager.register(backend);
    dispatch({ type: 'REGISTER_BACKEND', descriptor: backend.descriptor });
  }, [manager]);

  const unregisterBackend = useCallback(async (backendKey: BackendKey) => {
    await manager.unregister(backendKey);
    dispatch({ type: 'UNREGISTER_BACKEND', backendKey });
  }, [manager]);

  const setActiveBackend = useCallback((backendKey: BackendKey | null) => {
    dispatch({ type: 'SET_ACTIVE_BACKEND', backendKey });
  }, []);

  const connectBackend = useCallback(async (backendKey: BackendKey) => {
    dispatch({ type: 'SET_BACKEND_STATUS', backendKey, status: 'connecting', error: null });
    await manager.connect(backendKey);
  }, [manager]);

  const disconnectBackend = useCallback(async (backendKey: BackendKey) => {
    await manager.disconnect(backendKey);
    dispatch({ type: 'SET_BACKEND_STATUS', backendKey, status: 'disconnected', error: null });
  }, [manager]);

  const withBackend = useCallback(async (backendKey: BackendKey, fn: (backend: SessionBackend) => Promise<void>) => {
    const backend = manager.get(backendKey);
    if (!backend) {
      throw new SpacesError(`Backend not found: ${backendKey}`, 'SYSTEM_ERROR', 2);
    }
    await fn(backend);
  }, [manager]);

  const listProjects = useCallback(async (backendKey: BackendKey) => {
    await withBackend(backendKey, (backend) => backend.listProjects());
  }, [withBackend]);

  const listGithubRepos = useCallback(async (backendKey: BackendKey, org?: string): Promise<string[]> => {
    let repos: string[] | null = null;
    await withBackend(backendKey, async (backend) => {
      repos = await backend.listGithubRepos(org);
    });

    if (!repos) {
      throw new SpacesError('GitHub repository list was not returned by backend', 'SYSTEM_ERROR', 2);
    }

    return repos;
  }, [withBackend]);

  const listRemoteBranches = useCallback(async (
    backendKey: BackendKey,
    projectName: string
  ): Promise<string[]> => {
    let branches: string[] | null = null;
    await withBackend(backendKey, async (backend) => {
      branches = await backend.listRemoteBranches(projectName);
    });

    if (!branches) {
      throw new SpacesError('Remote branch list was not returned by backend', 'SYSTEM_ERROR', 2);
    }

    return branches;
  }, [withBackend]);

  const listLinearIssues = useCallback(async (
    backendKey: BackendKey,
    projectName: string
  ): Promise<SessionLinearIssueSummary[]> => {
    let issues: SessionLinearIssueSummary[] | null = null;
    await withBackend(backendKey, async (backend) => {
      issues = await backend.listLinearIssues(projectName);
    });

    if (!issues) {
      throw new SpacesError('Linear issue list was not returned by backend', 'SYSTEM_ERROR', 2);
    }

    return issues;
  }, [withBackend]);

  const listWorkspaces = useCallback(async (backendKey: BackendKey) => {
    await withBackend(backendKey, (backend) => backend.listWorkspaces());
  }, [withBackend]);

  const listSessions = useCallback(async (backendKey: BackendKey, workspaceId?: string) => {
    await withBackend(backendKey, (backend) => backend.listSessions(workspaceId));
  }, [withBackend]);

  const listReplays = useCallback(async (backendKey: BackendKey, workspaceId?: string) => {
    await withBackend(backendKey, async (backend) => {
      if (!backend.listReplays) {
        throw new SpacesError('Replay listing is not supported by this backend', 'SYSTEM_ERROR', 2);
      }
      await backend.listReplays(workspaceId);
    });
  }, [withBackend]);

  const createProject = useCallback(async (backendKey: BackendKey, params: CreateProjectParams) => {
    dispatch({
      type: 'SET_COMMAND_ERROR',
      backendKey,
      commandError: null,
    });
    await withBackend(backendKey, (backend) => backend.createProject(params));
  }, [withBackend]);

  const prepareProjectCreation = useCallback(async (
    backendKey: BackendKey,
    params: CreateProjectParams
  ): Promise<PreparedProjectResult> => {
    let result: PreparedProjectResult | null = null;
    await withBackend(backendKey, async (backend) => {
      if (!backend.prepareProjectCreation) {
        throw new SpacesError('Project preparation is not supported by this backend', 'SYSTEM_ERROR', 2);
      }
      result = await backend.prepareProjectCreation(params);
    });

    if (!result) {
      throw new SpacesError('Project preparation was not returned by backend', 'SYSTEM_ERROR', 2);
    }

    return result;
  }, [withBackend]);

  const finalizeProjectCreation = useCallback(async (
    backendKey: BackendKey,
    params: FinalizeProjectParams
  ) => {
    dispatch({
      type: 'SET_COMMAND_ERROR',
      backendKey,
      commandError: null,
    });
    await withBackend(backendKey, async (backend) => {
      if (!backend.finalizeProjectCreation) {
        throw new SpacesError('Project finalization is not supported by this backend', 'SYSTEM_ERROR', 2);
      }
      await backend.finalizeProjectCreation(params);
    });
  }, [withBackend]);

  const cancelProjectCreation = useCallback(async (backendKey: BackendKey, projectName: string) => {
    await withBackend(backendKey, async (backend) => {
      if (!backend.cancelProjectCreation) {
        return;
      }
      await backend.cancelProjectCreation(projectName);
    });
  }, [withBackend]);

  const createWorkspace = useCallback(async (backendKey: BackendKey, params: CreateWorkspaceParams) => {
    dispatch({
      type: 'SET_COMMAND_ERROR',
      backendKey,
      commandError: null,
    });
    await withBackend(backendKey, (backend) => backend.createWorkspace(params));
  }, [withBackend]);

  const deleteProject = useCallback(async (
    backendKey: BackendKey,
    projectName: string,
    params?: DeleteProjectParams
  ) => {
    dispatch({
      type: 'SET_COMMAND_ERROR',
      backendKey,
      commandError: null,
    });
    await withBackend(backendKey, (backend) => backend.deleteProject(projectName, params));
  }, [withBackend]);

  const attachSession = useCallback(async (backendKey: BackendKey, params: AttachSessionParams) => {
    dispatch({
      type: 'SET_COMMAND_ERROR',
      backendKey,
      commandError: null,
    });
    dispatch({
      type: 'SET_SCRIPT_STATE',
      backendKey,
      scriptState: null,
    });
    await withBackend(backendKey, (backend) => backend.attachSession(params));
  }, [withBackend]);

  const detachSession = useCallback(async (backendKey: BackendKey) => {
    await withBackend(backendKey, (backend) => backend.detachSession());
  }, [withBackend]);

  const cancelPendingScripts = useCallback(async (backendKey: BackendKey) => {
    await withBackend(backendKey, async (backend) => {
      if (!backend.cancelPendingScripts) {
        return;
      }
      await backend.cancelPendingScripts();
    });
  }, [withBackend]);

  const killSession = useCallback(async (backendKey: BackendKey, sessionId: string) => {
    await withBackend(backendKey, (backend) => backend.killSession(sessionId));
  }, [withBackend]);

  const deleteWorkspace = useCallback(async (
    backendKey: BackendKey,
    projectName: string,
    workspaceId: string,
    params?: DeleteWorkspaceParams
  ) => {
    dispatch({
      type: 'SET_COMMAND_ERROR',
      backendKey,
      commandError: null,
    });
    dispatch({
      type: 'SET_SCRIPT_STATE',
      backendKey,
      scriptState: {
        phase: 'remove',
        isRunning: true,
      },
    });
    try {
      await withBackend(backendKey, (backend) => backend.deleteWorkspace(projectName, workspaceId, params));
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== 'REMOVE_SCRIPT_FAILED') {
        dispatch({
          type: 'SET_SCRIPT_STATE',
          backendKey,
          scriptState: null,
        });
      }
      throw error;
    }
  }, [withBackend]);

  const getBundleRefreshPlan = useCallback(async (
    backendKey: BackendKey,
    projectName: string,
    workspaceId: string
  ): Promise<BundleRefreshPlan> => {
    let plan: BundleRefreshPlan | null = null;
    await withBackend(backendKey, async (backend) => {
      plan = await backend.getBundleRefreshPlan(projectName, workspaceId);
    });

    if (!plan) {
      throw new SpacesError('Bundle refresh plan was not returned by backend', 'SYSTEM_ERROR', 2);
    }

    return plan;
  }, [withBackend]);

  const applyBundleRefresh = useCallback(async (
    backendKey: BackendKey,
    projectName: string,
    workspaceId: string,
    submission: BundleRefreshSubmission
  ) => {
    await withBackend(backendKey, (backend) =>
      backend.applyBundleRefresh(projectName, workspaceId, submission)
    );
  }, [withBackend]);

  const getBundleConfigState = useCallback(async (
    backendKey: BackendKey,
    projectName: string,
    workspaceId: string
  ): Promise<BundleConfigState> => {
    let stateResult: BundleConfigState | null = null;
    await withBackend(backendKey, async (backend) => {
      stateResult = await backend.getBundleConfigState(projectName, workspaceId);
    });

    if (!stateResult) {
      throw new SpacesError('Bundle config state was not returned by backend', 'SYSTEM_ERROR', 2);
    }

    return stateResult;
  }, [withBackend]);

  const applyBundleConfigUpdate = useCallback(async (
    backendKey: BackendKey,
    projectName: string,
    workspaceId: string,
    submission: BundleConfigSubmission
  ) => {
    await withBackend(backendKey, (backend) =>
      backend.applyBundleConfigUpdate(projectName, workspaceId, submission)
    );
  }, [withBackend]);

  const requestInbox = useCallback(async (backendKey: BackendKey) => {
    await withBackend(backendKey, (backend) => backend.requestInbox());
  }, [withBackend]);

  const clearInbox = useCallback(async (backendKey: BackendKey, id?: string) => {
    await withBackend(backendKey, (backend) => backend.clearInbox(id));
  }, [withBackend]);

  const markInboxRead = useCallback(async (backendKey: BackendKey, id: string) => {
    await withBackend(backendKey, (backend) => backend.markInboxRead(id));
  }, [withBackend]);

  const getNotificationConfig = useCallback(async (backendKey: BackendKey) => {
    await withBackend(backendKey, (backend) => backend.getNotificationConfig());
  }, [withBackend]);

  const updateNotificationConfig = useCallback(async (backendKey: BackendKey, config: NotificationConfig) => {
    await withBackend(backendKey, (backend) => backend.updateNotificationConfig(config));
  }, [withBackend]);

  const sendReviewRequest = useCallback(async (
    backendKey: BackendKey,
    operation: ReviewOperation
  ): Promise<ReviewResult> => {
    let result: ReviewResult | null = null;
    await withBackend(backendKey, async (backend) => {
      result = await backend.sendReviewRequest(operation);
    });
    if (!result) {
      throw new SpacesError('Review request was not handled by backend', 'SYSTEM_ERROR', 2);
    }
    return result;
  }, [withBackend]);

  const startProcess = useCallback(async (backendKey: BackendKey, workspaceId: string, processName: string, instance?: number) => {
    await withBackend(backendKey, async (backend) => {
      if (backend.startProcess) {
        await backend.startProcess(workspaceId, processName, instance);
      }
    });
  }, [withBackend]);

  const stopProcess = useCallback(async (backendKey: BackendKey, workspaceId: string, processName: string) => {
    await withBackend(backendKey, async (backend) => {
      if (backend.stopProcess) {
        await backend.stopProcess(workspaceId, processName);
      }
    });
  }, [withBackend]);

  const requestEvents = useCallback(async (
    backendKey: BackendKey,
    workspacePath: string,
    filter?: WideEventFilter,
    limit?: number,
    sinceMs?: number,
  ) => {
    await withBackend(backendKey, async (backend) => {
      if (backend.requestEvents) {
        await backend.requestEvents(workspacePath, filter, limit, sinceMs);
      }
    });
  }, [withBackend]);

  const createCheckpoint = useCallback(async (backendKey: BackendKey, sessionId: string) => {
    await withBackend(backendKey, async (backend) => {
      if (!backend.createCheckpoint) {
        throw new SpacesError('Checkpoint creation is not supported by this backend', 'SYSTEM_ERROR', 2);
      }
      await backend.createCheckpoint(sessionId);
    });
  }, [withBackend]);

  const getReplaySnapshot = useCallback(async (
    backendKey: BackendKey,
    replayId: string,
    atMs?: number,
    scrollbackLines?: number,
  ) => {
    let snapshot = null;
    await withBackend(backendKey, async (backend) => {
      if (!backend.getReplaySnapshot) {
        throw new SpacesError('Replay snapshots are not supported by this backend', 'SYSTEM_ERROR', 2);
      }
      snapshot = await backend.getReplaySnapshot(replayId, atMs, scrollbackLines);
    });
    if (!snapshot) {
      throw new SpacesError('Replay snapshot was not returned by backend', 'SYSTEM_ERROR', 2);
    }
    return snapshot;
  }, [withBackend]);

  const getReplayText = useCallback(async (
    backendKey: BackendKey,
    replayId: string,
    atMs?: number,
    scrollbackLines?: number,
    includeScrollback?: boolean,
    trimTrailingBlankRows?: boolean,
  ) => {
    let text: string | null = null;
    await withBackend(backendKey, async (backend) => {
      if (!backend.getReplayText) {
        throw new SpacesError('Replay text rendering is not supported by this backend', 'SYSTEM_ERROR', 2);
      }
      text = await backend.getReplayText(replayId, atMs, scrollbackLines, includeScrollback, trimTrailingBlankRows);
    });
    if (text === null) {
      throw new SpacesError('Replay text was not returned by backend', 'SYSTEM_ERROR', 2);
    }
    return text;
  }, [withBackend]);

  const getReplayMarkdown = useCallback(async (
    backendKey: BackendKey,
    replayId: string,
    atMs?: number,
    scrollbackLines?: number,
    includeScrollback?: boolean,
    trimTrailingBlankRows?: boolean,
  ) => {
    let markdown: string | null = null;
    await withBackend(backendKey, async (backend) => {
      if (!backend.getReplayMarkdown) {
        throw new SpacesError('Replay markdown rendering is not supported by this backend', 'SYSTEM_ERROR', 2);
      }
      markdown = await backend.getReplayMarkdown(replayId, atMs, scrollbackLines, includeScrollback, trimTrailingBlankRows);
    });
    if (markdown === null) {
      throw new SpacesError('Replay markdown was not returned by backend', 'SYSTEM_ERROR', 2);
    }
    return markdown;
  }, [withBackend]);

  return useMemo(() => ({
    state,
    activeBackendKey: getActiveBackendKey(state),
    activeBackendState: getActiveBackendState(state),
    backendKeys: getBackendKeys(state),
    getBackendState: (backendKey: BackendKey) => getBackendState(state, backendKey),

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
    createCheckpoint,
    getReplaySnapshot,
    getReplayText,
    getReplayMarkdown,
  }), [
    state,
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
    createCheckpoint,
    getReplaySnapshot,
    getReplayText,
    getReplayMarkdown,
  ]);
}
