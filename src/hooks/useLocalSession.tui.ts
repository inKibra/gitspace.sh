import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  useSessionEngine,
  type AttachSessionParams,
  type BundleRefreshPlan,
  type BundleRefreshSubmission,
  type BackendKey,
  type SessionBackend,
} from '../session/index.js';
import type { NotificationConfig } from '../notifications/types.js';
import { createBunLocalSessionBackend } from '../app/session/createSessionBackend.bun.js';

const LOCAL_BACKEND_KEY: BackendKey = 'local';

type SessionEngineApi = ReturnType<typeof useSessionEngine>;

type LocalSessionPtyBackend = SessionBackend & {
  setPtyOutputHandler(handler: ((data: Uint8Array) => void) | null): void;
};

function isBackendNotFoundError(error: unknown, backendKey: BackendKey): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes(`Backend not found: ${backendKey}`);
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
      console.error(`[tui] Failed to recover local backend: ${message}`);
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
        throw new Error(`Backend not found: ${backendKey}`);
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
      const missingError = new Error(`Backend not found: ${backendKey}`);
      if (strict) {
        throw missingError;
      }
      console.error(`[tui] ${missingError.message}`);
      return;
    }

    try {
      await runOnce();
    } catch (error) {
      if (strict || !isBackendNotFoundError(error, backendKey)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tui] Failed local backend operation after recovery: ${message}`);
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
        console.error(`[tui] Local session backend init failed: ${message}`);
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

  const killSession = useCallback(async (sessionId: string) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.killSession(backendKey, sessionId);
      await sessionEngine.listSessions(backendKey);
      await sessionEngine.listWorkspaces(backendKey);
    }, { strict: true });
  }, [backendKey, runWithBackend]);

  const deleteWorkspace = useCallback(async (projectName: string, workspaceId: string) => {
    await runWithBackend(async (sessionEngine) => {
      await sessionEngine.deleteWorkspace(backendKey, projectName, workspaceId);
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
      throw new Error('Bundle refresh plan unavailable');
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
      console.error(`[tui] Failed to write PTY data: ${message}`);
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
      console.error(`[tui] Failed to resize PTY: ${message}`);
    });
  }, [enabled]);

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
    inbox: localState?.inbox ?? [],
    inboxUnreadCount: localState?.inboxUnreadCount ?? 0,
    notificationConfig: localState?.notificationConfig ?? null,
    attachedSessionId: localState?.attachedSessionId ?? null,
    attachedSessionName: localState?.attachedSessionName ?? null,
    scriptState: localState?.scriptState ?? null,
    commandError: localState?.commandError ?? null,
    requestProjects,
    requestWorkspaces,
    requestSessions,
    requestInbox,
    clearInbox,
    markInboxRead,
    getNotificationConfig,
    updateNotificationConfig,
    attachSession,
    detachSession,
    killSession,
    deleteWorkspace,
    getBundleRefreshPlan,
    applyBundleRefresh,
    send,
    resize,
    setWriteCallback,
  };
}
