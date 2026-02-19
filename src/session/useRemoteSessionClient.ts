import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  InboxItem,
  ProjectInfo,
  SessionInfo,
  WorkspaceInfo,
} from '../lib/remote-session/protocol.js';
import type { NotificationConfig } from '../notifications/types.js';
import type {
  AttachSessionParams,
  BackendKey,
  DeleteWorkspaceParams,
  SessionBackend,
} from './backend.js';
import type { ScriptRuntimeState, BackendSessionState } from './types.js';
import type {
  BundleRefreshPlan,
  BundleRefreshSubmission,
} from '../types/bundle-refresh.js';
import type { ReviewOperation, ReviewResult } from '../types/review.js';
import { SpacesError } from '../types/errors.js';
import type { WideEvent, SavedEventFilter, WideEventFilter } from '../types/events.js';
import { useSessionEngine } from './useSessionEngine.js';

export type RemoteSessionConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'established'
  | 'error';

export interface RemoteSessionPtyBackend extends SessionBackend {
  setPtyOutputHandler?: (handler: ((data: Uint8Array) => void) | null) => void;
  writePtyData?: (data: Uint8Array) => Promise<void>;
  resizePty?: (cols: number, rows: number) => Promise<void>;
}

export interface UseRemoteSessionClientOptions<ConnectParams> {
  createBackend: (params: ConnectParams) => {
    backendKey: BackendKey;
    backend: RemoteSessionPtyBackend;
  };
  mapConnectionStatus?: (
    status: BackendSessionState['status']
  ) => RemoteSessionConnectionStatus;
}

export interface UseRemoteSessionClientReturn<ConnectParams> {
  status: RemoteSessionConnectionStatus;
  mode: 'browsing' | 'attached';

  projects: ProjectInfo[];
  workspaces: WorkspaceInfo[];
  sessions: SessionInfo[];
  attachedSessionId: string | null;
  attachedSessionName: string | null;
  selectedProjectName: string | null;

  connect: (params: ConnectParams) => Promise<void>;
  disconnect: () => void;

  requestProjects: () => void;
  requestWorkspaces: () => void;
  requestSessions: (workspaceId?: string) => void;
  attachSession: (params: AttachSessionParams) => void;
  detachSession: () => void;
  selectProject: (projectName: string | null) => void;

  killSession: (sessionId: string) => void;
  deleteWorkspace: (
    projectName: string,
    workspaceId: string,
    params?: DeleteWorkspaceParams
  ) => Promise<void>;
  getBundleRefreshPlan: (projectName: string, workspaceId: string) => Promise<BundleRefreshPlan>;
  applyBundleRefresh: (
    projectName: string,
    workspaceId: string,
    submission: BundleRefreshSubmission
  ) => Promise<void>;

  send: (data: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  setWriteCallback: (fn: ((data: Uint8Array) => void) | null) => void;

  inbox: InboxItem[];
  inboxUnreadCount: number;
  requestInbox: () => void;
  clearInboxItem: (id?: string) => void;
  markInboxItemRead: (id: string) => void;
  requestNotificationConfig: () => void;
  updateNotificationConfig: (config: NotificationConfig) => void;
  notificationConfig: NotificationConfig | null;

  sendReviewRequest: (operation: ReviewOperation) => Promise<ReviewResult>;

  scriptState: ScriptRuntimeState | null;
  commandError: { code?: string; message: string } | null;

  events: WideEvent[];
  liveEventIds: string[];
  savedEventFilters: SavedEventFilter[];
  startProcess: (workspaceId: string, processName: string, instance?: number) => void;
  stopProcess: (workspaceId: string, processName: string) => void;
  requestEvents: (workspacePath: string, filter?: WideEventFilter, limit?: number, sinceMs?: number) => void;
}

function defaultStatusMapper(
  status: BackendSessionState['status']
): RemoteSessionConnectionStatus {
  if (status === 'connected') {
    return 'established';
  }
  return status;
}

export function useRemoteSessionClient<ConnectParams>(
  options: UseRemoteSessionClientOptions<ConnectParams>
): UseRemoteSessionClientReturn<ConnectParams> {
  const { createBackend, mapConnectionStatus = defaultStatusMapper } = options;
  const engine = useSessionEngine();
  const disconnectBackend = engine.disconnectBackend;
  const unregisterBackend = engine.unregisterBackend;

  const [selectedProjectName, setSelectedProjectName] = useState<string | null>(null);
  const activeBackendKeyRef = useRef<BackendKey | null>(null);
  const backendRef = useRef<RemoteSessionPtyBackend | null>(null);
  const writeCallbackRef = useRef<((data: Uint8Array) => void) | null>(null);

  const activeBackendState = useMemo(() => {
    const backendKey = activeBackendKeyRef.current;
    if (!backendKey) {
      return null;
    }
    return engine.getBackendState(backendKey);
  }, [engine, engine.state]);

  const status = useMemo<RemoteSessionConnectionStatus>(() => {
    if (!activeBackendState) {
      return 'disconnected';
    }
    return mapConnectionStatus(activeBackendState.status);
  }, [activeBackendState, mapConnectionStatus]);

  const withActiveBackend = useCallback(
    async <T>(fn: (backendKey: BackendKey) => Promise<T>): Promise<T | null> => {
      const backendKey = activeBackendKeyRef.current;
      if (!backendKey) {
        return null;
      }
      return fn(backendKey);
    },
    []
  );

  const connect = useCallback(
    async (params: ConnectParams) => {
      const previousBackendKey = activeBackendKeyRef.current;
      if (previousBackendKey) {
        await engine.disconnectBackend(previousBackendKey);
        await engine.unregisterBackend(previousBackendKey);
        activeBackendKeyRef.current = null;
        backendRef.current = null;
      }

      const { backendKey, backend } = createBackend(params);
      if (backend.setPtyOutputHandler) {
        backend.setPtyOutputHandler(writeCallbackRef.current);
      }

      backendRef.current = backend;
      activeBackendKeyRef.current = backendKey;

      engine.registerBackend(backend);
      engine.setActiveBackend(backendKey);

      try {
        await engine.connectBackend(backendKey);
      } catch (error) {
        await engine.unregisterBackend(backendKey);
        activeBackendKeyRef.current = null;
        backendRef.current = null;
        throw error;
      }
    },
    [createBackend, engine]
  );

  const disconnect = useCallback(() => {
    const backendKey = activeBackendKeyRef.current;
    if (!backendKey) {
      return;
    }

    void engine.disconnectBackend(backendKey).then(async () => {
      await engine.unregisterBackend(backendKey);
      activeBackendKeyRef.current = null;
      backendRef.current = null;
      setSelectedProjectName(null);
    });
  }, [engine]);

  const requestProjects = useCallback(() => {
    void withActiveBackend((backendKey) => engine.listProjects(backendKey));
  }, [engine, withActiveBackend]);

  const requestWorkspaces = useCallback(() => {
    void withActiveBackend((backendKey) => engine.listWorkspaces(backendKey));
  }, [engine, withActiveBackend]);

  const requestSessions = useCallback((workspaceId?: string) => {
    void withActiveBackend((backendKey) => engine.listSessions(backendKey, workspaceId));
  }, [engine, withActiveBackend]);

  const attachSession = useCallback((params: AttachSessionParams) => {
    void withActiveBackend((backendKey) => engine.attachSession(backendKey, params));
  }, [engine, withActiveBackend]);

  const detachSession = useCallback(() => {
    void withActiveBackend((backendKey) => engine.detachSession(backendKey));
  }, [engine, withActiveBackend]);

  const selectProject = useCallback(
    (projectName: string | null) => {
      setSelectedProjectName(projectName);
      if (projectName) {
        requestWorkspaces();
      }
    },
    [requestWorkspaces]
  );

  const killSession = useCallback((sessionId: string) => {
    void withActiveBackend((backendKey) => engine.killSession(backendKey, sessionId));
  }, [engine, withActiveBackend]);

  const deleteWorkspace = useCallback(async (
    projectName: string,
    workspaceId: string,
    params?: DeleteWorkspaceParams
  ) => {
    const result = await withActiveBackend((backendKey) =>
      engine.deleteWorkspace(backendKey, projectName, workspaceId, params)
    );
    if (result === null) {
      throw new Error('No active backend connection');
    }
  }, [engine, withActiveBackend]);

  const getBundleRefreshPlan = useCallback(
    async (projectName: string, workspaceId: string): Promise<BundleRefreshPlan> => {
      const backendKey = activeBackendKeyRef.current;
      if (!backendKey) {
        throw new Error('No active backend connection');
      }

      return engine.getBundleRefreshPlan(backendKey, projectName, workspaceId);
    },
    [engine]
  );

  const applyBundleRefresh = useCallback(
    async (
      projectName: string,
      workspaceId: string,
      submission: BundleRefreshSubmission
    ): Promise<void> => {
      const backendKey = activeBackendKeyRef.current;
      if (!backendKey) {
        throw new Error('No active backend connection');
      }

      await engine.applyBundleRefresh(backendKey, projectName, workspaceId, submission);
    },
    [engine]
  );

  const send = useCallback((data: Uint8Array) => {
    const backend = backendRef.current;
    if (!backend || !backend.writePtyData) {
      return;
    }
    void backend.writePtyData(data);
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    const backend = backendRef.current;
    if (!backend || !backend.resizePty) {
      return;
    }
    void backend.resizePty(cols, rows);
  }, []);

  const setWriteCallback = useCallback((fn: ((data: Uint8Array) => void) | null) => {
    writeCallbackRef.current = fn;
    backendRef.current?.setPtyOutputHandler?.(fn);
  }, []);

  const requestInbox = useCallback(() => {
    void withActiveBackend((backendKey) => engine.requestInbox(backendKey));
  }, [engine, withActiveBackend]);

  const clearInboxItem = useCallback((id?: string) => {
    void withActiveBackend((backendKey) => engine.clearInbox(backendKey, id));
  }, [engine, withActiveBackend]);

  const markInboxItemRead = useCallback((id: string) => {
    void withActiveBackend((backendKey) => engine.markInboxRead(backendKey, id));
  }, [engine, withActiveBackend]);

  const requestNotificationConfig = useCallback(() => {
    void withActiveBackend((backendKey) => engine.getNotificationConfig(backendKey));
  }, [engine, withActiveBackend]);

  const updateNotificationConfig = useCallback((config: NotificationConfig) => {
    void withActiveBackend((backendKey) =>
      engine.updateNotificationConfig(backendKey, config)
    );
  }, [engine, withActiveBackend]);

  const sendReviewRequest = useCallback(
    async (operation: ReviewOperation): Promise<ReviewResult> => {
      const backendKey = activeBackendKeyRef.current;
      if (!backendKey) {
        throw new SpacesError('No active backend connection', 'SYSTEM_ERROR', 2);
      }
      return engine.sendReviewRequest(backendKey, operation);
    },
    [engine]
  );

  const startProcess = useCallback((workspaceId: string, processName: string, instance?: number) => {
    void withActiveBackend((backendKey) =>
      engine.startProcess(backendKey, workspaceId, processName, instance)
    );
  }, [engine, withActiveBackend]);

  const stopProcess = useCallback((workspaceId: string, processName: string) => {
    void withActiveBackend((backendKey) =>
      engine.stopProcess(backendKey, workspaceId, processName)
    );
  }, [engine, withActiveBackend]);

  const requestEvents = useCallback((
    workspacePath: string,
    filter?: WideEventFilter,
    limit?: number,
    sinceMs?: number,
  ) => {
    void withActiveBackend((backendKey) =>
      engine.requestEvents(backendKey, workspacePath, filter, limit, sinceMs)
    );
  }, [engine, withActiveBackend]);

  useEffect(() => {
    return () => {
      const backendKey = activeBackendKeyRef.current;
      if (!backendKey) {
        return;
      }
      void disconnectBackend(backendKey);
      void unregisterBackend(backendKey);
      activeBackendKeyRef.current = null;
      backendRef.current = null;
    };
  }, [disconnectBackend, unregisterBackend]);

  return {
    status,
    mode: activeBackendState?.mode ?? 'browsing',

    projects: activeBackendState?.projects ?? [],
    workspaces: activeBackendState?.workspaces ?? [],
    sessions: activeBackendState?.sessions ?? [],
    attachedSessionId: activeBackendState?.attachedSessionId ?? null,
    attachedSessionName: activeBackendState?.attachedSessionName ?? null,
    selectedProjectName,

    connect,
    disconnect,

    requestProjects,
    requestWorkspaces,
    requestSessions,
    attachSession,
    detachSession,
    selectProject,

    killSession,
    deleteWorkspace,
    getBundleRefreshPlan,
    applyBundleRefresh,

    send,
    resize,
    setWriteCallback,

    inbox: activeBackendState?.inbox ?? [],
    inboxUnreadCount: activeBackendState?.inboxUnreadCount ?? 0,
    requestInbox,
    clearInboxItem,
    markInboxItemRead,
    requestNotificationConfig,
    updateNotificationConfig,
    notificationConfig: activeBackendState?.notificationConfig ?? null,

    sendReviewRequest,

    scriptState: activeBackendState?.scriptState ?? null,
    commandError: activeBackendState?.commandError ?? null,

    events: activeBackendState?.events ?? [],
    liveEventIds: activeBackendState?.liveEventIds ?? [],
    savedEventFilters: activeBackendState?.savedEventFilters ?? [],
    startProcess,
    stopProcess,
    requestEvents,
  };
}
