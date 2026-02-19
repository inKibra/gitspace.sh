import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { NotificationConfig } from '../notifications/types.js';
import type {
  BackendKey,
  SessionBackend,
  AttachSessionParams,
  DeleteWorkspaceParams,
} from './backend.js';
import type {
  BundleRefreshPlan,
  BundleRefreshSubmission,
} from '../types/bundle-refresh.js';
import type { ReviewOperation, ReviewResult } from '../types/review.js';
import type { ScriptPhase } from '../types/script-phase.js';
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
          break;
        case 'sessions':
          dispatch({ type: 'SET_SESSIONS', backendKey, sessions: event.sessions });
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

  const listWorkspaces = useCallback(async (backendKey: BackendKey) => {
    await withBackend(backendKey, (backend) => backend.listWorkspaces());
  }, [withBackend]);

  const listSessions = useCallback(async (backendKey: BackendKey, workspaceId?: string) => {
    await withBackend(backendKey, (backend) => backend.listSessions(workspaceId));
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
    listWorkspaces,
    listSessions,
    attachSession,
    detachSession,
    killSession,
    deleteWorkspace,
    getBundleRefreshPlan,
    applyBundleRefresh,

    requestInbox,
    clearInbox,
    markInboxRead,
    getNotificationConfig,
    updateNotificationConfig,
    sendReviewRequest,
  }), [
    state,
    registerBackend,
    unregisterBackend,
    setActiveBackend,
    connectBackend,
    disconnectBackend,
    listProjects,
    listWorkspaces,
    listSessions,
    attachSession,
    detachSession,
    killSession,
    deleteWorkspace,
    getBundleRefreshPlan,
    applyBundleRefresh,
    requestInbox,
    clearInbox,
    markInboxRead,
    getNotificationConfig,
    updateNotificationConfig,
    sendReviewRequest,
  ]);
}
