import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  InboxItem,
  ProjectInfo,
  ReplayFrameTarget,
  ReplayInfo,
  ReplayTimeline,
  SessionInfo,
  WorkspaceInfo,
} from '../lib/remote-session/protocol.js';
import type { NotificationConfig } from '../notifications/types.js';
import type { OpenCodeBridgeRequest, OpenCodeBridgeResponse, OpenCodeBridgeStreamEvent, OpenCodeBridgeStreamOpen } from '../agents/opencode-bridge.js';
import type { OpenCodeRuntimeInfo } from '../agents/opencode-types.js';
import type {
  AttachSessionParams,
  BackendKey,
  CreateProjectParams,
  FinalizeProjectParams,
  PreparedProjectResult,
  CreateWorkspaceParams,
  DeleteProjectParams,
  DeleteWorkspaceParams,
  OpenCodeBridgeBackend,
  SessionBackend,
} from './backend.js';
import type { ScriptRuntimeState, BackendSessionState } from './types.js';
import type {
  BundleRefreshPlan,
  BundleRefreshSubmission,
} from '../types/bundle-refresh.js';
import type {
  BundleConfigState,
  BundleConfigSubmission,
} from '../types/bundle-config.js';
import type { ReviewOperation, ReviewResult } from '../types/review.js';
import { SpacesError } from '../types/errors.js';
import type { WideEvent, SavedEventFilter, WideEventFilter } from '../types/events.js';
import type { SessionLinearIssueSummary } from '../types/lifecycle.js';
import { useSessionEngine } from './useSessionEngine.js';
import { logger } from '../utils/logger.js';

function createMissingBackendError(context: string): SpacesError {
	logger.error(`[remote-session] ${context}: no active backend connection`);
	return new SpacesError('No active backend connection', 'SYSTEM_ERROR', 2);
}

export type RemoteSessionConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'established'
  | 'error';

export interface RemoteSessionPtyBackend extends SessionBackend {
  setPtyOutputHandler?: (handler: ((data: Uint8Array) => void) | null) => void;
  writePtyData?: (data: Uint8Array) => Promise<void>;
  resizePty?: (cols: number, rows: number) => Promise<void>;
  getOpenCodeRuntimeInfo?: OpenCodeBridgeBackend['getOpenCodeRuntimeInfo'];
  requestOpenCode?: OpenCodeBridgeBackend['requestOpenCode'];
  subscribeOpenCode?: OpenCodeBridgeBackend['subscribeOpenCode'];
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
  replays: ReplayInfo[];
  attachedSessionId: string | null;
  attachedSessionName: string | null;
  selectedProjectName: string | null;

  connect: (params: ConnectParams) => Promise<void>;
  disconnect: () => void;

  requestProjects: () => void;
  listGithubRepos: (org?: string) => Promise<string[]>;
  listRemoteBranches: (projectName: string) => Promise<string[]>;
  listLinearIssues: (projectName: string) => Promise<SessionLinearIssueSummary[]>;
  requestWorkspaces: () => void;
  requestSessions: (workspaceId?: string) => void;
  requestReplays: (workspaceId?: string, includeDismissed?: boolean) => void;
  createProject: (params: CreateProjectParams) => Promise<void>;
  prepareProjectCreation: (params: CreateProjectParams) => Promise<PreparedProjectResult>;
  finalizeProjectCreation: (params: FinalizeProjectParams) => Promise<void>;
  cancelProjectCreation: (projectName: string) => Promise<void>;
  createWorkspace: (params: CreateWorkspaceParams) => Promise<void>;
  deleteProject: (projectName: string, params?: DeleteProjectParams) => Promise<void>;
  attachSession: (params: AttachSessionParams) => void;
  detachSession: () => void;
  cancelPendingScripts: () => void;
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
  getBundleConfigState: (projectName: string, workspaceId: string) => Promise<BundleConfigState>;
  applyBundleConfigUpdate: (
    projectName: string,
    workspaceId: string,
    submission: BundleConfigSubmission
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
  startProcess: (workspaceId: string, processName: string, instance?: number) => Promise<void>;
  stopProcess: (workspaceId: string, processName: string) => Promise<void>;
  requestEvents: (workspacePath: string, filter?: WideEventFilter, limit?: number, sinceMs?: number) => void;
  getReplayAnsi: (replayId: string, target?: ReplayFrameTarget) => Promise<Uint8Array>;
  getReplayTimeline: (replayId: string) => Promise<ReplayTimeline>;
  dismissReplay: (replayId: string) => Promise<void>;
  undismissReplay: (replayId: string) => Promise<void>;
  hasOpenCodeBridge: boolean;
  requestOpenCode: (request: Omit<OpenCodeBridgeRequest, 'requestId'>) => Promise<OpenCodeBridgeResponse>;
  subscribeOpenCode: (
    request: Omit<OpenCodeBridgeStreamOpen, 'requestId'>,
    handler: (event: OpenCodeBridgeStreamEvent) => void,
  ) => Promise<() => Promise<void>>;
  getOpenCodeRuntimeInfo: (workspaceId: string) => Promise<OpenCodeRuntimeInfo>;
  /** The underlying SessionBackend for agent hooks that need the full interface */
  sessionBackend: SessionBackend | null;
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
  const registerBackend = engine.registerBackend;
  const setActiveBackend = engine.setActiveBackend;
  const connectBackend = engine.connectBackend;
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
        await disconnectBackend(previousBackendKey);
        await unregisterBackend(previousBackendKey);
        activeBackendKeyRef.current = null;
        backendRef.current = null;
      }

      const { backendKey, backend } = createBackend(params);
      if (backend.setPtyOutputHandler) {
        backend.setPtyOutputHandler(writeCallbackRef.current);
      }

      backendRef.current = backend;
      activeBackendKeyRef.current = backendKey;

      registerBackend(backend);
      setActiveBackend(backendKey);

      try {
        await connectBackend(backendKey);
      } catch (error) {
        await unregisterBackend(backendKey);
        activeBackendKeyRef.current = null;
        backendRef.current = null;
        throw error;
      }
    },
    [connectBackend, createBackend, disconnectBackend, registerBackend, setActiveBackend, unregisterBackend]
  );

  const disconnect = useCallback(() => {
    const backendKey = activeBackendKeyRef.current;
    if (!backendKey) {
      return;
    }

    void disconnectBackend(backendKey).then(async () => {
      await unregisterBackend(backendKey);
      activeBackendKeyRef.current = null;
      backendRef.current = null;
      setSelectedProjectName(null);
    });
  }, [disconnectBackend, unregisterBackend]);

  const requestProjects = useCallback(() => {
    void withActiveBackend((backendKey) => engine.listProjects(backendKey));
  }, [engine, withActiveBackend]);

  const listGithubRepos = useCallback(async (org?: string): Promise<string[]> => {
    const backendKey = activeBackendKeyRef.current;
    if (!backendKey) {
      throw createMissingBackendError('listGithubRepos');
    }

    return engine.listGithubRepos(backendKey, org);
  }, [engine]);

  const listRemoteBranches = useCallback(async (projectName: string): Promise<string[]> => {
    const backendKey = activeBackendKeyRef.current;
    if (!backendKey) {
      throw createMissingBackendError(`listRemoteBranches(${projectName})`);
    }

    return engine.listRemoteBranches(backendKey, projectName);
  }, [engine]);

  const listLinearIssues = useCallback(async (
    projectName: string
  ): Promise<SessionLinearIssueSummary[]> => {
    const backendKey = activeBackendKeyRef.current;
    if (!backendKey) {
      throw createMissingBackendError(`listLinearIssues(${projectName})`);
    }

    return engine.listLinearIssues(backendKey, projectName);
  }, [engine]);

  const requestWorkspaces = useCallback(() => {
    void withActiveBackend((backendKey) => engine.listWorkspaces(backendKey));
  }, [engine, withActiveBackend]);

  const requestSessions = useCallback((workspaceId?: string) => {
    void withActiveBackend((backendKey) => engine.listSessions(backendKey, workspaceId));
  }, [engine, withActiveBackend]);

  const requestReplays = useCallback((workspaceId?: string, includeDismissed?: boolean) => {
    void withActiveBackend((backendKey) => engine.listReplays(backendKey, workspaceId, includeDismissed));
  }, [engine, withActiveBackend]);

  const createProject = useCallback(async (params: CreateProjectParams): Promise<void> => {
    const result = await withActiveBackend((backendKey) => engine.createProject(backendKey, params));
    if (result === null) {
      throw createMissingBackendError(`createProject(${params.projectName ?? params.repository})`);
    }
  }, [engine, withActiveBackend]);

  const prepareProjectCreation = useCallback(async (
    params: CreateProjectParams
  ): Promise<PreparedProjectResult> => {
    const backendKey = activeBackendKeyRef.current;
    if (!backendKey) {
      throw createMissingBackendError(`prepareProjectCreation(${params.projectName ?? params.repository})`);
    }

    return engine.prepareProjectCreation(backendKey, params);
  }, [engine]);

  const finalizeProjectCreation = useCallback(async (params: FinalizeProjectParams): Promise<void> => {
    const result = await withActiveBackend((backendKey) => engine.finalizeProjectCreation(backendKey, params));
    if (result === null) {
      throw createMissingBackendError(`finalizeProjectCreation(${params.projectName})`);
    }
  }, [engine, withActiveBackend]);

  const cancelProjectCreation = useCallback(async (projectName: string): Promise<void> => {
    const result = await withActiveBackend((backendKey) => engine.cancelProjectCreation(backendKey, projectName));
    if (result === null) {
      throw createMissingBackendError(`cancelProjectCreation(${projectName})`);
    }
  }, [engine, withActiveBackend]);

  const createWorkspace = useCallback(async (params: CreateWorkspaceParams): Promise<void> => {
    const result = await withActiveBackend((backendKey) => engine.createWorkspace(backendKey, params));
    if (result === null) {
      throw new Error('No active backend connection');
    }
  }, [engine, withActiveBackend]);

  const deleteProject = useCallback(async (
    projectName: string,
    params?: DeleteProjectParams
  ): Promise<void> => {
    const result = await withActiveBackend((backendKey) =>
      engine.deleteProject(backendKey, projectName, params)
    );
    if (result === null) {
      throw new Error('No active backend connection');
    }
  }, [engine, withActiveBackend]);

  const attachSession = useCallback((params: AttachSessionParams) => {
    void withActiveBackend((backendKey) => engine.attachSession(backendKey, params));
  }, [engine, withActiveBackend]);

  const detachSession = useCallback(() => {
    void withActiveBackend((backendKey) => engine.detachSession(backendKey));
  }, [engine, withActiveBackend]);

  const cancelPendingScripts = useCallback(() => {
    void withActiveBackend((backendKey) => engine.cancelPendingScripts(backendKey));
  }, [engine, withActiveBackend]);

  const selectProject = useCallback(
    (projectName: string | null) => {
      setSelectedProjectName(projectName);
      if (projectName) {
        requestWorkspaces();
        requestSessions();
      }
    },
    [requestSessions, requestWorkspaces]
  );

  useEffect(() => {
    const projects = activeBackendState?.projects ?? [];

    if (projects.length === 0) {
      if (selectedProjectName !== null) {
        selectProject(null);
      }
      return;
    }

    if (selectedProjectName && projects.some((project) => project.name === selectedProjectName)) {
      return;
    }

    const preferredProjectName = projects.find((project) => project.isCurrent)?.name ?? projects[0]?.name ?? null;
    if (preferredProjectName && preferredProjectName !== selectedProjectName) {
      selectProject(preferredProjectName);
    }
  }, [activeBackendState?.projects, selectProject, selectedProjectName]);

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

  const getBundleConfigState = useCallback(
    async (projectName: string, workspaceId: string): Promise<BundleConfigState> => {
      const backendKey = activeBackendKeyRef.current;
      if (!backendKey) {
        throw new Error('No active backend connection');
      }

      return engine.getBundleConfigState(backendKey, projectName, workspaceId);
    },
    [engine]
  );

  const applyBundleConfigUpdate = useCallback(
    async (
      projectName: string,
      workspaceId: string,
      submission: BundleConfigSubmission
    ): Promise<void> => {
      const backendKey = activeBackendKeyRef.current;
      if (!backendKey) {
        throw new Error('No active backend connection');
      }

      await engine.applyBundleConfigUpdate(backendKey, projectName, workspaceId, submission);
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

  const startProcess = useCallback(async (workspaceId: string, processName: string, instance?: number) => {
    const result = await withActiveBackend((backendKey) =>
      engine.startProcess(backendKey, workspaceId, processName, instance)
    );
    if (result === null) {
      throw new Error('No active backend connection');
    }
  }, [engine, withActiveBackend]);

  const stopProcess = useCallback(async (workspaceId: string, processName: string) => {
    const result = await withActiveBackend((backendKey) =>
      engine.stopProcess(backendKey, workspaceId, processName)
    );
    if (result === null) {
      throw new Error('No active backend connection');
    }
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

  const getReplayAnsi = useCallback(async (replayId: string, target?: ReplayFrameTarget): Promise<Uint8Array> => {
    const backendKey = activeBackendKeyRef.current;
    if (!backendKey) {
      throw createMissingBackendError(`getReplayAnsi(${replayId})`);
    }
    return engine.getReplayAnsi(backendKey, replayId, target);
  }, [engine]);

  const getReplayTimeline = useCallback(async (replayId: string): Promise<ReplayTimeline> => {
    const backendKey = activeBackendKeyRef.current;
    if (!backendKey) {
      throw createMissingBackendError(`getReplayTimeline(${replayId})`);
    }
    return engine.getReplayTimeline(backendKey, replayId);
  }, [engine]);

  const dismissReplay = useCallback(async (replayId: string): Promise<void> => {
    const backendKey = activeBackendKeyRef.current;
    if (!backendKey) {
      throw createMissingBackendError(`dismissReplay(${replayId})`);
    }
    await engine.dismissReplay(backendKey, replayId);
  }, [engine]);

  const undismissReplay = useCallback(async (replayId: string): Promise<void> => {
    const backendKey = activeBackendKeyRef.current;
    if (!backendKey) {
      throw createMissingBackendError(`undismissReplay(${replayId})`);
    }
    await engine.undismissReplay(backendKey, replayId);
  }, [engine]);

  const requestOpenCode = useCallback(async (
    request: Omit<OpenCodeBridgeRequest, 'requestId'>,
  ): Promise<OpenCodeBridgeResponse> => {
    const backend = backendRef.current;
    if (!backend?.requestOpenCode) {
      throw new Error('OpenCode bridge unavailable for current backend');
    }
    return backend.requestOpenCode(request);
  }, []);

  const subscribeOpenCode = useCallback(async (
    request: Omit<OpenCodeBridgeStreamOpen, 'requestId'>,
    handler: (event: OpenCodeBridgeStreamEvent) => void,
  ): Promise<() => Promise<void>> => {
    const backend = backendRef.current;
    if (!backend?.subscribeOpenCode) {
      throw new Error('OpenCode bridge unavailable for current backend');
    }
    return backend.subscribeOpenCode(request, handler);
  }, []);

  const getOpenCodeRuntimeInfo = useCallback(async (workspaceId: string): Promise<OpenCodeRuntimeInfo> => {
    const backend = backendRef.current;
    if (!backend?.getOpenCodeRuntimeInfo) {
      throw new Error('OpenCode runtime info unavailable for current backend');
    }
    return backend.getOpenCodeRuntimeInfo(workspaceId);
  }, []);

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

  return useMemo(() => ({
    status,
    mode: activeBackendState?.mode ?? 'browsing',

    projects: activeBackendState?.projects ?? [],
    workspaces: activeBackendState?.workspaces ?? [],
    sessions: activeBackendState?.sessions ?? [],
    replays: activeBackendState?.replays ?? [],
    attachedSessionId: activeBackendState?.attachedSessionId ?? null,
    attachedSessionName: activeBackendState?.attachedSessionName ?? null,
    selectedProjectName,

    connect,
    disconnect,

    requestProjects,
    listGithubRepos,
    listRemoteBranches,
    listLinearIssues,
    requestWorkspaces,
    requestSessions,
    requestReplays,
    createProject,
    prepareProjectCreation,
    finalizeProjectCreation,
    cancelProjectCreation,
    createWorkspace,
    deleteProject,
    attachSession,
    detachSession,
    cancelPendingScripts,
    selectProject,

    killSession,
    deleteWorkspace,
    getBundleRefreshPlan,
    applyBundleRefresh,
    getBundleConfigState,
    applyBundleConfigUpdate,

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
    getReplayAnsi,
    getReplayTimeline,
    dismissReplay,
    undismissReplay,
    hasOpenCodeBridge: Boolean(backendRef.current?.requestOpenCode && backendRef.current?.subscribeOpenCode),
    requestOpenCode,
    subscribeOpenCode,
    getOpenCodeRuntimeInfo,
    /** Expose the underlying SessionBackend for agent hooks that need the full interface */
    sessionBackend: backendRef.current as SessionBackend | null,
  }), [
    status,
    activeBackendState,
    selectedProjectName,
    connect,
    disconnect,
    requestProjects,
    listGithubRepos,
    listRemoteBranches,
    listLinearIssues,
    requestWorkspaces,
    requestSessions,
    requestReplays,
    createProject,
    prepareProjectCreation,
    finalizeProjectCreation,
    cancelProjectCreation,
    createWorkspace,
    deleteProject,
    attachSession,
    detachSession,
    cancelPendingScripts,
    selectProject,
    killSession,
    deleteWorkspace,
    getBundleRefreshPlan,
    applyBundleRefresh,
    getBundleConfigState,
    applyBundleConfigUpdate,
    send,
    resize,
    setWriteCallback,
    requestInbox,
    clearInboxItem,
    markInboxItemRead,
    requestNotificationConfig,
    updateNotificationConfig,
    sendReviewRequest,
    startProcess,
    stopProcess,
    requestEvents,
    getReplayAnsi,
    getReplayTimeline,
    dismissReplay,
    undismissReplay,
    requestOpenCode,
    subscribeOpenCode,
    getOpenCodeRuntimeInfo,
  ]);
}
