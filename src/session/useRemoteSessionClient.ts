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
import type {
  AttachSessionParams,
  BackendKey,
  CreateProjectParams,
  FinalizeProjectParams,
  PreparedProjectResult,
  CreateWorkspaceParams,
  DeleteProjectParams,
  DeleteWorkspaceParams,
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
  | 'reconnecting'
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
  /**
   * Optional transform applied to ConnectParams before storing them for
   * reconnection. Use this to strip transport-specific state (e.g. a
   * pre-opened WebSocket) that would be dead on subsequent attempts.
   */
  toReconnectParams?: (params: ConnectParams) => ConnectParams;
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
  cancelPendingReplayRequests: () => void;
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
  getReplayFrame: (replayId: string, target?: ReplayFrameTarget) => Promise<import('../lib/tmux-lite/replay/types.js').ReplayFrame>;
  getReplayTimeline: (replayId: string) => Promise<ReplayTimeline>;
  dismissReplay: (replayId: string) => Promise<void>;
  undismissReplay: (replayId: string) => Promise<void>;
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
  const { createBackend, mapConnectionStatus = defaultStatusMapper, toReconnectParams } = options;
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

  // -------------------------------------------------------------------------
  // Reconnection state
  //
  // When the backend transitions established→disconnected while a session is
  // attached, we automatically reconnect and re-attach to the same tmux-lite
  // session (terminal state is preserved server-side by xterm-headless).
  //
  // Key design choices:
  //   - connectParamsRef stores a reconnect-safe copy of params (transient
  //     transport objects like a pre-opened WebSocket are stripped via
  //     toReconnectParams so every retry gets a fresh socket)
  //   - lastAttachedSessionIdRef is only populated from the 'attached' event
  //     and cleared on explicit detach — so reconnect only fires when the user
  //     was actually in attached mode when the drop happened
  //   - lastModeRef preserves the mode across the gap so the UI doesn't flash
  //     back to browsing while the reconnect loop is in flight
  //   - abort ref prevents races between concurrent connect() calls and loops,
  //     and is aborted on component unmount so the async loop never outlives
  //     the component
  //   - lastDimensionsRef tracks the most recent PTY cols/rows so reconnect
  //     can pass the current terminal size to attachSession
  // -------------------------------------------------------------------------
  const [isReconnecting, setIsReconnecting] = useState(false);
  const connectParamsRef = useRef<ConnectParams | null>(null);
  const lastAttachedSessionIdRef = useRef<string | null>(null);
  const lastModeRef = useRef<'browsing' | 'attached'>('browsing');
  const reconnectAbortRef = useRef<{ aborted: boolean }>({ aborted: false });
  const lastDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);

  const activeBackendState = useMemo(() => {
    const backendKey = activeBackendKeyRef.current;
    if (!backendKey) {
      return null;
    }
    return engine.getBackendState(backendKey);
  }, [engine, engine.state]);

  // backendStatus reflects the raw underlying connection state, NOT overlaid
  // with isReconnecting. This is what the reconnect useEffect watches via
  // [backendStatus], so that setIsReconnecting(true) inside the effect doesn't
  // change backendStatus → doesn't re-trigger the effect cleanup → doesn't
  // abort the in-flight reconnect loop.
  const backendStatus = useMemo<RemoteSessionConnectionStatus>(() => {
    if (!activeBackendState) {
      return 'disconnected';
    }
    return mapConnectionStatus(activeBackendState.status);
  }, [activeBackendState, mapConnectionStatus]);

  // status is the value exposed to consumers — overlays 'reconnecting' on top
  // of backendStatus, but is NOT used as the useEffect dependency.
  const status = useMemo<RemoteSessionConnectionStatus>(() => {
    if (isReconnecting) {
      return 'reconnecting';
    }
    return backendStatus;
  }, [backendStatus, isReconnecting]);

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
      // Cancel any in-flight reconnect loop before starting fresh.
      reconnectAbortRef.current.aborted = true;
      reconnectAbortRef.current = { aborted: false };
      setIsReconnecting(false);

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
      // Save reconnect-safe params (strip dead transports like a closed WebSocket).
      connectParamsRef.current = toReconnectParams ? toReconnectParams(params) : params;
      lastAttachedSessionIdRef.current = null;

      registerBackend(backend);
      setActiveBackend(backendKey);

      try {
        await connectBackend(backendKey);
      } catch (error) {
        await unregisterBackend(backendKey);
        activeBackendKeyRef.current = null;
        backendRef.current = null;
        connectParamsRef.current = null;
        throw error;
      }
    },
    [connectBackend, createBackend, disconnectBackend, registerBackend, setActiveBackend, toReconnectParams, unregisterBackend]
  );

  const disconnect = useCallback(() => {
    // Cancel any in-flight reconnect loop — this is an intentional disconnect.
    reconnectAbortRef.current.aborted = true;
    reconnectAbortRef.current = { aborted: false };
    setIsReconnecting(false);
    connectParamsRef.current = null;
    lastAttachedSessionIdRef.current = null;

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
    // Clear the saved session ID — an explicit detach means we should NOT
    // re-attach to this session if the connection drops later in browsing mode.
    lastAttachedSessionIdRef.current = null;
    void withActiveBackend((backendKey) => engine.detachSession(backendKey));
  }, [engine, withActiveBackend]);

  const cancelPendingScripts = useCallback(() => {
    void withActiveBackend((backendKey) => engine.cancelPendingScripts(backendKey));
  }, [engine, withActiveBackend]);

  const cancelPendingReplayRequests = useCallback(() => {
    void withActiveBackend(async (backendKey) => engine.cancelPendingReplayRequests(backendKey));
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

  // Track the most recently attached session ID so reconnect can re-attach.
  // Only update when we have a real session ID; cleared on explicit detach above.
  useEffect(() => {
    const attachedId = activeBackendState?.attachedSessionId;
    if (attachedId) {
      lastAttachedSessionIdRef.current = attachedId;
    }
  }, [activeBackendState?.attachedSessionId]);

  // Preserve last-known mode so UI doesn't flash to browsing during reconnect.
  useEffect(() => {
    const mode = activeBackendState?.mode;
    if (mode) {
      lastModeRef.current = mode;
    }
  }, [activeBackendState?.mode]);

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

  // -------------------------------------------------------------------------
  // Automatic reconnection on unexpected disconnect
  // -------------------------------------------------------------------------
  useEffect(() => {
    // Only trigger when:
    //   1. We are now disconnected (not reconnecting/connecting)
    //   2. We have saved connect params (i.e. connect() was called before)
    //   3. We had an active tmux session at the time of disconnect
    //      (lastAttachedSessionIdRef is cleared on explicit detach, so this
    //       prevents re-attach when the user is in browsing mode)
    if (
      backendStatus !== 'disconnected' ||
      !connectParamsRef.current ||
      !lastAttachedSessionIdRef.current
    ) {
      return;
    }

    const params = connectParamsRef.current;
    const sessionId = lastAttachedSessionIdRef.current;
    const abort = reconnectAbortRef.current;

    const MAX_RECONNECT_ATTEMPTS = 10;
    const BASE_DELAY_MS = 1_000;
    const MAX_DELAY_MS = 30_000;

    setIsReconnecting(true);

    const run = async () => {
      for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        if (abort.aborted) return;

        const delay = attempt === 1
          ? 0
          : Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 2) + Math.random() * 1_000, MAX_DELAY_MS);

        if (delay > 0) {
          logger.log(`[session] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})...`);
          await new Promise<void>((r) => setTimeout(r, delay));
        } else {
          logger.log(`[session] Reconnecting... (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})`);
        }

        if (abort.aborted) return;

        try {
          // Tear down the old (disconnected) backend.
          const oldBackendKey = activeBackendKeyRef.current;
          if (oldBackendKey) {
            await disconnectBackend(oldBackendKey);
            await unregisterBackend(oldBackendKey);
            activeBackendKeyRef.current = null;
            backendRef.current = null;
          }

          if (abort.aborted) return;

          // Build and connect a fresh backend with the saved (reconnect-safe) params.
          const { backendKey, backend } = createBackend(params);
          if (backend.setPtyOutputHandler) {
            backend.setPtyOutputHandler(writeCallbackRef.current);
          }

          backendRef.current = backend;
          activeBackendKeyRef.current = backendKey;
          registerBackend(backend);
          setActiveBackend(backendKey);

          await connectBackend(backendKey);

          if (abort.aborted) {
            await disconnectBackend(backendKey);
            await unregisterBackend(backendKey);
            activeBackendKeyRef.current = null;
            backendRef.current = null;
            return;
          }

          // Re-attach to the same tmux-lite session (terminal state preserved).
          // Pass the last known terminal dimensions so the server-side PTY
          // gets the correct size immediately rather than waiting for the next
          // browser resize event (which may never come if dimensions haven't changed).
          const dims = lastDimensionsRef.current;
          await backend.attachSession({
            sessionId,
            ...(dims ? { cols: dims.cols, rows: dims.rows } : {}),
          });

          if (!abort.aborted) {
            logger.log(`[session] Reconnected and re-attached to session ${sessionId}`);
            setIsReconnecting(false);
          }
          return;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          logger.log(`[session] Reconnect attempt ${attempt} failed: ${detail}`);

          // Clean up failed backend before next attempt.
          const failedKey = activeBackendKeyRef.current;
          if (failedKey) {
            await disconnectBackend(failedKey).catch(() => {});
            await unregisterBackend(failedKey).catch(() => {});
            activeBackendKeyRef.current = null;
            backendRef.current = null;
          }
        }
      }

      // All attempts exhausted.
      if (!abort.aborted) {
        logger.log('[session] Reconnect failed after all attempts.');
        setIsReconnecting(false);
        connectParamsRef.current = null;
        lastAttachedSessionIdRef.current = null;
      }
    };

    void run();

    // Abort the loop if backendStatus changes again or the component unmounts
    // before the loop finishes.
    return () => {
      abort.aborted = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendStatus]);

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
    // Track dimensions so the reconnect path can pass the current terminal
    // size to attachSession instead of relying on a subsequent resize event.
    lastDimensionsRef.current = { cols, rows };
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

  const getReplayFrame = useCallback(async (replayId: string, target?: ReplayFrameTarget): Promise<import('../lib/tmux-lite/replay/types.js').ReplayFrame> => {
    const backendKey = activeBackendKeyRef.current;
    if (!backendKey) {
      throw createMissingBackendError(`getReplayFrame(${replayId})`);
    }
    return engine.getReplayFrame(backendKey, replayId, target);
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

  useEffect(() => {
    return () => {
      // Abort any in-flight reconnect loop so async callbacks don't call
      // React state setters or create new backends after unmount.
      reconnectAbortRef.current.aborted = true;

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
    // During reconnect, preserve the last known mode so the UI doesn't flash
    // back to the browsing state while the reconnect loop is in flight.
    mode: isReconnecting ? lastModeRef.current : (activeBackendState?.mode ?? 'browsing'),

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
    cancelPendingReplayRequests,
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
    getReplayFrame,
    getReplayTimeline,
    dismissReplay,
    undismissReplay,
    /** Expose the underlying SessionBackend for agent hooks that need the full interface */
    sessionBackend: backendRef.current as SessionBackend | null,
  }), [
    status,
    isReconnecting,
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
    cancelPendingReplayRequests,
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
    getReplayFrame,
    getReplayTimeline,
    dismissReplay,
    undismissReplay,
  ]);
}
