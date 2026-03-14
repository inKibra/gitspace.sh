import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  useSessionEngine,
  type AttachSessionParams,
  type CreateProjectParams,
  type FinalizeProjectParams,
  type PreparedProjectResult,
  type CreateWorkspaceParams,
  type DeleteProjectParams,
  type DeleteWorkspaceParams,
  type BundleRefreshPlan,
  type BundleRefreshSubmission,
  type BackendKey,
  type SessionBackend,
} from '../session/index.js';
import type { NotificationConfig } from '../notifications/types.js';
import type { WideEventFilter } from '../types/events.js';
import type { SessionLinearIssueSummary } from '../types/lifecycle.js';
import type { BundleConfigState, BundleConfigSubmission } from '../types/bundle-config.js';
import { createBunLocalSessionBackend } from '../app/session/createSessionBackend.bun.js';
import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';

const LOCAL_BACKEND_KEY: BackendKey = 'local';

type SessionEngineApi = ReturnType<typeof useSessionEngine>;

type LocalSessionPtyBackend = SessionBackend & {
  setPtyOutputHandler(handler: ((data: Uint8Array) => void) | null): void;
};

function createBackendNotFoundError(backendKey: BackendKey): SpacesError {
  return new SpacesError(`Backend not found: ${backendKey}`, 'SYSTEM_ERROR', 2);
}

function isBackendNotFoundError(error: unknown, backendKey: BackendKey): boolean {
  if (!(error instanceof SpacesError)) {
    return false;
  }

  if (error.code !== 'SYSTEM_ERROR') {
    return false;
  }

  return error.message === `Backend not found: ${backendKey}`;
}

export interface UseLocalSessionOptions {
  enabled?: boolean;
  engine?: SessionEngineApi;
  backendKey?: BackendKey;
  createBackend?: () => LocalSessionPtyBackend;
}

export function useLocalSession(options: UseLocalSessionOptions = {}) {
  const {
    enabled = true,
    engine: injectedEngine,
    backendKey = LOCAL_BACKEND_KEY,
    createBackend: createBackendOverride,
  } = options;
  const sessionEngine = useSessionEngine();
  const engine = injectedEngine ?? sessionEngine;
  const engineRef = useRef(engine);
  const backendRef = useRef<LocalSessionPtyBackend | null>(null);
  const writeCallbackRef = useRef<((data: Uint8Array) => void) | null>(null);

  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

  const recoverBackend = useCallback(async (sessionEngine: SessionEngineApi): Promise<boolean> => {
    const backend = backendRef.current;
    if (!backend) {
      return false;
    }

    try {
      sessionEngine.registerBackend(backend);
      sessionEngine.setActiveBackend(backendKey);
      await sessionEngine.connectBackend(backendKey);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[tui] Failed to recover local backend: ${message}`);
      return false;
    }
  }, [backendKey]);

  const runWithBackend = useCallback(async (
    run: (sessionEngine: SessionEngineApi) => Promise<void>,
    options: { strict?: boolean } = {}
  ) => {
    const { strict = false } = options;

    if (!enabled) {
      return;
    }

    const sessionEngine = engineRef.current;
    if (!backendRef.current) {
      if (strict) {
        throw createBackendNotFoundError(backendKey);
      }
      return;
    }

    const runOnce = async () => {
      sessionEngine.setActiveBackend(backendKey);
      await run(sessionEngine);
    };

    try {
      await runOnce();
      return;
    } catch (error) {
      if (!isBackendNotFoundError(error, backendKey)) {
        throw error;
      }
    }

    const recovered = await recoverBackend(sessionEngine);
    if (!recovered) {
      const missingError = createBackendNotFoundError(backendKey);
      if (strict) {
        throw missingError;
      }
      logger.error(`[tui] ${missingError.message}`);
      return;
    }

    try {
      await runOnce();
    } catch (error) {
      if (strict || !isBackendNotFoundError(error, backendKey)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[tui] Failed local backend operation after recovery: ${message}`);
    }
  }, [backendKey, enabled, recoverBackend]);

  const createBackend = useCallback((): LocalSessionPtyBackend => {
    if (createBackendOverride) {
      return createBackendOverride();
    }

    return createBunLocalSessionBackend(backendKey);
  }, [backendKey, createBackendOverride]);

  const localState = useMemo(() => {
    return engine.getBackendState(backendKey);
  }, [backendKey, engine, engine.state]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (backendRef.current) {
      return;
    }

    const backend = createBackend();
    backend.setPtyOutputHandler(writeCallbackRef.current);

    backendRef.current = backend;
    const sessionEngine = engineRef.current;
    sessionEngine.registerBackend(backend);
    sessionEngine.setActiveBackend(backendKey);
    void (async () => {
      try {
        await sessionEngine.connectBackend(backendKey);
        await sessionEngine.listProjects(backendKey);
        await sessionEngine.listWorkspaces(backendKey);
        await sessionEngine.requestInbox(backendKey);
        await sessionEngine.getNotificationConfig(backendKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[tui] Local session backend init failed: ${message}`);
      }
    })();

    return () => {
      backend.setPtyOutputHandler(null);
      const currentEngine = engineRef.current;
      void currentEngine.disconnectBackend(backendKey);
      void currentEngine.unregisterBackend(backendKey);
      backendRef.current = null;
    };
  }, [backendKey, createBackend, enabled]);

  const requestProjects = useCallback(async () => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.listProjects(backendKey);
    });
  }, [backendKey, runWithBackend]);

  const listGithubRepos = useCallback(async (org?: string): Promise<string[]> => {
    let repos: string[] | null = null;
    await runWithBackend(async (sessionEngine) => {
      repos = await sessionEngine.listGithubRepos(backendKey, org);
    }, { strict: true });

    if (!repos) {
      throw new SpacesError('GitHub repository list unavailable', 'SYSTEM_ERROR', 2);
    }

    return repos;
  }, [backendKey, runWithBackend]);

  const listRemoteBranches = useCallback(async (projectName: string): Promise<string[]> => {
    let branches: string[] | null = null;
    await runWithBackend(async (sessionEngine) => {
      branches = await sessionEngine.listRemoteBranches(backendKey, projectName);
    }, { strict: true });

    if (!branches) {
      throw new SpacesError('Remote branch list unavailable', 'SYSTEM_ERROR', 2);
    }

    return branches;
  }, [backendKey, runWithBackend]);

  const listLinearIssues = useCallback(async (
    projectName: string
  ): Promise<SessionLinearIssueSummary[]> => {
    let issues: SessionLinearIssueSummary[] | null = null;
    await runWithBackend(async (sessionEngine) => {
      issues = await sessionEngine.listLinearIssues(backendKey, projectName);
    }, { strict: true });

    if (!issues) {
      throw new SpacesError('Linear issue list unavailable', 'SYSTEM_ERROR', 2);
    }

    return issues;
  }, [backendKey, runWithBackend]);

  const requestWorkspaces = useCallback(async () => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.listWorkspaces(backendKey);
    });
  }, [backendKey, runWithBackend]);

  const requestSessions = useCallback(async (workspaceId?: string) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.listSessions(backendKey, workspaceId);
    });
  }, [backendKey, runWithBackend]);

  const requestReplays = useCallback(async (workspaceId?: string, includeDismissed?: boolean) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.listReplays(backendKey, workspaceId, includeDismissed);
    }, { strict: true });
  }, [backendKey, runWithBackend]);

  const createProject = useCallback(async (params: CreateProjectParams) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.createProject(backendKey, params);
      await sessionEngine.listProjects(backendKey);
      await sessionEngine.listWorkspaces(backendKey);
      await sessionEngine.listSessions(backendKey);
    }, { strict: true });
  }, [backendKey, runWithBackend]);

  const prepareProjectCreation = useCallback(async (
    params: CreateProjectParams
  ): Promise<PreparedProjectResult> => {
    let result: PreparedProjectResult | null = null;
    await runWithBackend(async (sessionEngine) => {
      result = await sessionEngine.prepareProjectCreation(backendKey, params);
    }, { strict: true });

    if (!result) {
      throw new SpacesError('Project preparation unavailable', 'SYSTEM_ERROR', 2);
    }

    return result;
  }, [backendKey, runWithBackend]);

  const finalizeProjectCreation = useCallback(async (params: FinalizeProjectParams) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.finalizeProjectCreation(backendKey, params);
      await sessionEngine.listProjects(backendKey);
      await sessionEngine.listWorkspaces(backendKey);
      await sessionEngine.listSessions(backendKey);
    }, { strict: true });
  }, [backendKey, runWithBackend]);

  const cancelProjectCreation = useCallback(async (projectName: string) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.cancelProjectCreation(backendKey, projectName);
      await sessionEngine.listProjects(backendKey);
      await sessionEngine.listWorkspaces(backendKey);
      await sessionEngine.listSessions(backendKey);
    }, { strict: true });
  }, [backendKey, runWithBackend]);

  const createWorkspace = useCallback(async (params: CreateWorkspaceParams) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.createWorkspace(backendKey, params);
      await sessionEngine.listWorkspaces(backendKey);
      await sessionEngine.listSessions(backendKey);
    }, { strict: true });
  }, [backendKey, runWithBackend]);

  const deleteProject = useCallback(async (projectName: string, params?: DeleteProjectParams) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.deleteProject(backendKey, projectName, params);
      await sessionEngine.listProjects(backendKey);
      await sessionEngine.listWorkspaces(backendKey);
      await sessionEngine.listSessions(backendKey);
    }, { strict: true });
  }, [backendKey, runWithBackend]);

  const requestInbox = useCallback(async () => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.requestInbox(backendKey);
    });
  }, [backendKey, runWithBackend]);

  const clearInbox = useCallback(async (id?: string) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.clearInbox(backendKey, id);
    });
  }, [backendKey, runWithBackend]);

  const markInboxRead = useCallback(async (id: string) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.markInboxRead(backendKey, id);
    });
  }, [backendKey, runWithBackend]);

  const getNotificationConfig = useCallback(() => {
    void runWithBackend(async (sessionEngine) => {
      await sessionEngine.getNotificationConfig(backendKey);
    });
  }, [backendKey, runWithBackend]);

  const updateNotificationConfig = useCallback((config: NotificationConfig) => {
    void runWithBackend(async (sessionEngine) => {
      await sessionEngine.updateNotificationConfig(backendKey, config);
    });
  }, [backendKey, runWithBackend]);

  const attachSession = useCallback(async (params: AttachSessionParams) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.attachSession(backendKey, params);
      await sessionEngine.listSessions(backendKey);
      await sessionEngine.listWorkspaces(backendKey);
    }, { strict: true });
  }, [backendKey, runWithBackend]);

  const detachSession = useCallback(async () => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.detachSession(backendKey);
      await sessionEngine.listSessions(backendKey);
      await sessionEngine.listWorkspaces(backendKey);
    }, { strict: true });
  }, [backendKey, runWithBackend]);

  const cancelPendingScripts = useCallback(async () => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.cancelPendingScripts(backendKey);
    });
  }, [backendKey, runWithBackend]);

  const killSession = useCallback(async (sessionId: string) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.killSession(backendKey, sessionId);
      await sessionEngine.listSessions(backendKey);
      await sessionEngine.listWorkspaces(backendKey);
    }, { strict: true });
  }, [backendKey, runWithBackend]);

  const deleteWorkspace = useCallback(async (
    projectName: string,
    workspaceId: string,
    params?: DeleteWorkspaceParams
  ) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.deleteWorkspace(backendKey, projectName, workspaceId, params);
      await sessionEngine.listWorkspaces(backendKey);
      await sessionEngine.listSessions(backendKey);
    }, { strict: true });
  }, [backendKey, runWithBackend]);

  const getBundleRefreshPlan = useCallback(async (
    projectName: string,
    workspaceId: string
  ): Promise<BundleRefreshPlan> => {
    let plan: BundleRefreshPlan | null = null;
    await runWithBackend(async (sessionEngine) => {
      plan = await sessionEngine.getBundleRefreshPlan(backendKey, projectName, workspaceId);
    }, { strict: true });

    if (!plan) {
      throw new SpacesError('Bundle refresh plan unavailable', 'SYSTEM_ERROR', 2);
    }

    return plan;
  }, [backendKey, runWithBackend]);

  const applyBundleRefresh = useCallback(async (
    projectName: string,
    workspaceId: string,
    submission: BundleRefreshSubmission
  ) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.applyBundleRefresh(backendKey, projectName, workspaceId, submission);
      await sessionEngine.listWorkspaces(backendKey);
      await sessionEngine.listSessions(backendKey, workspaceId);
    }, { strict: true });
  }, [backendKey, runWithBackend]);

  const getBundleConfigState = useCallback(async (
    projectName: string,
    workspaceId: string
  ): Promise<BundleConfigState> => {
    let stateResult: BundleConfigState | null = null;
    await runWithBackend(async (sessionEngine) => {
      stateResult = await sessionEngine.getBundleConfigState(backendKey, projectName, workspaceId);
    }, { strict: true });

    if (!stateResult) {
      throw new SpacesError('Bundle config state unavailable', 'SYSTEM_ERROR', 2);
    }

    return stateResult;
  }, [backendKey, runWithBackend]);

  const applyBundleConfigUpdate = useCallback(async (
    projectName: string,
    workspaceId: string,
    submission: BundleConfigSubmission
  ) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.applyBundleConfigUpdate(backendKey, projectName, workspaceId, submission);
      await sessionEngine.listWorkspaces(backendKey);
      await sessionEngine.listSessions(backendKey, workspaceId);
    }, { strict: true });
  }, [backendKey, runWithBackend]);

  const send = useCallback((data: Uint8Array) => {
    const backend = backendRef.current;
    if (!enabled || !backend?.writePtyData) {
      return;
    }
    void backend.writePtyData(data).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('No attached local session')) {
        return;
      }
      logger.error(`[tui] Failed to write PTY data: ${message}`);
    });
  }, [enabled]);

  const resize = useCallback((cols: number, rows: number) => {
    const backend = backendRef.current;
    if (!enabled || !backend?.resizePty) {
      return;
    }
    void backend.resizePty(cols, rows).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('No attached local session')) {
        return;
      }
      logger.error(`[tui] Failed to resize PTY: ${message}`);
    });
  }, [enabled]);

  const startProcess = useCallback(async (workspaceId: string, processName: string, instance?: number) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.startProcess(backendKey, workspaceId, processName, instance);
      await sessionEngine.listWorkspaces(backendKey);
      await sessionEngine.listSessions(backendKey);
    });
  }, [backendKey, runWithBackend]);

  const stopProcess = useCallback(async (workspaceId: string, processName: string) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.stopProcess(backendKey, workspaceId, processName);
      await sessionEngine.listWorkspaces(backendKey);
      await sessionEngine.listSessions(backendKey);
    });
  }, [backendKey, runWithBackend]);

  const requestEvents = useCallback(async (
    workspacePath: string,
    filter?: WideEventFilter,
    limit?: number,
    sinceMs?: number,
  ) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.requestEvents(backendKey, workspacePath, filter, limit, sinceMs);
    });
  }, [backendKey, runWithBackend]);

  const createCheckpoint = useCallback(async (sessionId: string) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.createCheckpoint(backendKey, sessionId);
    }, { strict: true });
  }, [backendKey, runWithBackend]);

  const getReplaySnapshot = useCallback(async (replayId: string, atMs?: number, scrollbackLines?: number) => {
    let snapshot = null;
    await runWithBackend(async (sessionEngine) => {
      snapshot = await sessionEngine.getReplaySnapshot(backendKey, replayId, atMs, scrollbackLines);
    }, { strict: true });

    if (!snapshot) {
      throw new SpacesError('Replay snapshot unavailable', 'SYSTEM_ERROR', 2);
    }

    return snapshot;
  }, [backendKey, runWithBackend]);

  const getReplayText = useCallback(async (
    replayId: string,
    atMs?: number,
    scrollbackLines?: number,
    includeScrollback?: boolean,
    trimTrailingBlankRows?: boolean,
  ) => {
    let text: string | null = null;
    await runWithBackend(async (sessionEngine) => {
      text = await sessionEngine.getReplayText(
        backendKey,
        replayId,
        atMs,
        scrollbackLines,
        includeScrollback,
        trimTrailingBlankRows,
      );
    }, { strict: true });

    if (text === null) {
      throw new SpacesError('Replay text unavailable', 'SYSTEM_ERROR', 2);
    }

    return text;
  }, [backendKey, runWithBackend]);

  const getReplayMarkdown = useCallback(async (
    replayId: string,
    atMs?: number,
    scrollbackLines?: number,
    includeScrollback?: boolean,
    trimTrailingBlankRows?: boolean,
  ) => {
    let markdown: string | null = null;
    await runWithBackend(async (sessionEngine) => {
      markdown = await sessionEngine.getReplayMarkdown(
        backendKey,
        replayId,
        atMs,
        scrollbackLines,
        includeScrollback,
        trimTrailingBlankRows,
      );
    }, { strict: true });

    if (markdown === null) {
      throw new SpacesError('Replay markdown unavailable', 'SYSTEM_ERROR', 2);
    }

    return markdown;
  }, [backendKey, runWithBackend]);

  const setWriteCallback = useCallback((fn: ((data: Uint8Array) => void) | null) => {
    writeCallbackRef.current = fn;
    backendRef.current?.setPtyOutputHandler(fn);
  }, []);

  return {
    status: enabled ? (localState?.status ?? 'disconnected') : 'disconnected',
    mode: localState?.mode ?? 'browsing',
    projects: localState?.projects ?? [],
    workspaces: localState?.workspaces ?? [],
    sessions: localState?.sessions ?? [],
    replays: localState?.replays ?? [],
    inbox: localState?.inbox ?? [],
    inboxUnreadCount: localState?.inboxUnreadCount ?? 0,
    notificationConfig: localState?.notificationConfig ?? null,
    attachedSessionId: localState?.attachedSessionId ?? null,
    attachedSessionName: localState?.attachedSessionName ?? null,
    scriptState: localState?.scriptState ?? null,
    commandError: localState?.commandError ?? null,
    events: localState?.events ?? [],
    liveEventIds: localState?.liveEventIds ?? [],
    savedEventFilters: localState?.savedEventFilters ?? [],
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
    getBundleRefreshPlan,
    applyBundleRefresh,
    getBundleConfigState,
    applyBundleConfigUpdate,
    startProcess,
    stopProcess,
    requestEvents,
    createCheckpoint,
    getReplaySnapshot,
    getReplayText,
    getReplayMarkdown,
    send,
    resize,
    setWriteCallback,
  };
}
