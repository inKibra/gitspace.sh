import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { BackendManager } from '../../session/backend-manager.js';
import {
  createInitialSessionEngineState,
  sessionEngineReducer,
} from '../../session/reducer.js';
import type {
  BackendSessionState,
  SessionEngineState,
} from '../../session/types.js';
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
import type { BackendManagerEvent } from '../../session/backend-manager.js';
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
import { buildRemoteBackendKey } from '../../session/backend-key.js';
import { logger } from '../../utils/logger.js';
import { toMultiMachineState } from './selectors.js';
import { RelayMachineDirectoryClient } from '../../relay-client/machine-directory-client.js';
import type { RelayDescriptor, RelaySocketAdapter, RelaySigner } from '../../relay-client/index.js';
import type { Identity } from '../../types/identity.js';
import type {
  BackendScopedAgentSessionRef,
  BackendScopedSessionRef,
  BackendScopedWorkspaceRef,
  MultiMachineState,
} from './types.js';

export const LOCAL_BACKEND_KEY: BackendKey = 'local';

/**
 * LocalSessionPtyBackend extends SessionBackend with the PTY output handler
 * used to pipe terminal data to the local UI.
 */
export type LocalSessionPtyBackend = SessionBackend & {
  setPtyOutputHandler(handler: ((data: Uint8Array) => void) | null): void;
};

/** Parameters passed to createRemoteBackend when registering a relay-discovered machine. */
export interface CreateRemoteBackendParams {
  relayUrl: string;
  identity: Identity;
  machineId: string;
  deviceCertificate: string;
  machineLabel?: string;
}

export interface UseMultiBackendsOptions {
  enabled?: boolean;
  /**
   * When provided along with `identity`, auto-discovers all accessible remote
   * machines via the relay and registers them as backends.
   */
  relay?: RelayDescriptor | null;
  /**
   * Unlocked local identity used to authenticate with the relay and remote machines.
   */
  identity?: Identity | null;

  /**
   * Factory to create the local session backend (e.g. Bun Unix socket).
   * Pass `null` explicitly to skip local backend registration (browser context).
   * When omitted, no local backend is registered.
   */
  createLocalBackend?: (() => SessionBackend) | null;

  /**
   * Factory to create remote session backends for relay-discovered machines.
   * Required when `relay` is provided.
   */
  createRemoteBackend?: (params: CreateRemoteBackendParams) => { backendKey: BackendKey; backend: SessionBackend };

  /**
   * Socket adapter for relay directory connections.
   * Required when `relay` is provided.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relaySocketAdapter?: RelaySocketAdapter<any>;

  /**
   * Creates a relay message signer from an identity.
   * Required when `relay` is provided.
   */
  createRelaySigner?: (identity: Identity) => RelaySigner;

  /**
   * Creates a device certificate string from an identity.
   * Required when `relay` is provided.
   * In the browser this loads from localStorage; in Bun it signs via the keychain.
   */
  getDeviceCertificate?: (identity: Identity) => Promise<string>;
}

function dispatchBackendEvent(
  dispatch: React.Dispatch<import('../../session/types.js').SessionEngineAction>,
  backendKey: BackendKey,
  event: import('../../session/events.js').BackendEvent
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
        meta: { sessionName: event.sessionName ?? null },
      });
      break;
    case 'session_meta':
      dispatch({ type: 'SET_ATTACHED_SESSION_META', backendKey, meta: event.meta });
      break;
    case 'detached':
    case 'session_exited':
      dispatch({ type: 'SET_ATTACHED_SESSION', backendKey, sessionId: null });
      break;
    case 'command_error':
      dispatch({
        type: 'SET_COMMAND_ERROR',
        backendKey,
        commandError: { code: event.code, message: event.message },
      });
      break;
    case 'error':
      dispatch({ type: 'SET_BACKEND_STATUS', backendKey, status: 'error', error: event.message });
      break;
    case 'script_output':
      dispatch({
        type: 'SET_SCRIPT_STATE',
        backendKey,
        scriptState:
          event.done && !event.error
            ? null
            : {
                phase: event.phase,
                isRunning: !event.done,
                error: event.error,
                exitCode: event.exitCode,
              },
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
    default:
      break;
  }
}

/**
 * useMultiBackends — the top-level multi-machine backend registry for the TUI.
 *
 * Replaces both useLocalSession and useSessionEngine as the primary connection point
 * between the UI and backend(s). When `enabled`, auto-registers and connects the
 * local backend. Additional backends (remote machines) can be registered later.
 *
 * Action API:
 * - Fanout ops (listProjects, listWorkspaces, etc.) fan out to ALL connected backends.
 * - Ref-scoped ops (attachSession, deleteWorkspace, etc.) use BackendScopedWorkspaceRef
 *   or BackendScopedSessionRef to route to the correct backend.
 * - Backend-targeted ops (createProject, createWorkspace, listGithubRepos, etc.) take
 *   an explicit backendKey since they're backend-specific (e.g., creating on the local machine).
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

  const [engineState, dispatch] = useReducer(
    sessionEngineReducer,
    undefined,
    createInitialSessionEngineState
  );

  // Keep a ref to the latest engine state for use inside action callbacks
  const engineStateRef = useRef<SessionEngineState>(engineState);
  useEffect(() => {
    engineStateRef.current = engineState;
  });

  // BackendManager singleton ref
  const managerRef = useRef<BackendManager | null>(null);

  const getManager = useCallback((): BackendManager => {
    if (!managerRef.current) {
      managerRef.current = new BackendManager((evt: BackendManagerEvent) => {
        dispatchBackendEvent(dispatch, evt.backendKey, evt.event);
      });
    }
    return managerRef.current;
  }, []);

  // ─── Stable refs for factory callbacks ───────────────────────────────────
  // Storing factory callbacks in refs decouples effect re-runs from callback
  // reference identity. Callers may define factories inline (new reference each
  // render) and the effects must only re-run when the *intent* changes (enabled
  // toggled, relay URL changed, identity changed) — not when a function literal
  // is recreated. The ref is updated on every render so the effect always calls
  // the latest version.
  const createLocalBackendRef = useRef(createLocalBackend);
  const createRemoteBackendRef = useRef(createRemoteBackend);
  const relaySocketAdapterRef = useRef(relaySocketAdapter);
  const createRelaySignerRef = useRef(createRelaySigner);
  const getDeviceCertificateRef = useRef(getDeviceCertificate);
  useEffect(() => {
    createLocalBackendRef.current = createLocalBackend;
    createRemoteBackendRef.current = createRemoteBackend;
    relaySocketAdapterRef.current = relaySocketAdapter;
    createRelaySignerRef.current = createRelaySigner;
    getDeviceCertificateRef.current = getDeviceCertificate;
  });

  // Register and connect the local backend when enabled and factory is provided
  useEffect(() => {
    if (!enabled || !createLocalBackendRef.current) return;
    const factory = createLocalBackendRef.current;
    const manager = getManager();
    const backend = factory();
    dispatch({ type: 'REGISTER_BACKEND', descriptor: backend.descriptor });
    manager.register(backend);
    void manager.connect(LOCAL_BACKEND_KEY).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[multiBackends] Local backend connect failed: ${message}`);
      dispatch({ type: 'SET_BACKEND_STATUS', backendKey: LOCAL_BACKEND_KEY, status: 'error', error: message });
    });
    return () => {
      void manager.unregister(LOCAL_BACKEND_KEY).catch(() => undefined);
      dispatch({ type: 'UNREGISTER_BACKEND', backendKey: LOCAL_BACKEND_KEY });
    };
  // createLocalBackend is intentionally excluded — reference changes must not
  // trigger re-registration. Only enabled/getManager (structural changes) do.
  }, [enabled, getManager]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Relay discovery — register/unregister remote backends automatically ────

  /** Tracks which remote backend keys are currently registered, keyed by machineId */
  const registeredRemoteBackendsRef = useRef<Map<string, BackendKey>>(new Map());
  /** Cached device certificate, computed from identity once available */
  const deviceCertRef = useRef<string | null>(null);

  // Compute device cert whenever identity changes
  useEffect(() => {
    if (!identity || !getDeviceCertificateRef.current) {
      deviceCertRef.current = null;
      return;
    }
    const getCert = getDeviceCertificateRef.current;
    let cancelled = false;
    void getCert(identity).then((cert) => {
      if (!cancelled) deviceCertRef.current = cert;
    });
    return () => { cancelled = true; };
  }, [identity?.id]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const createRemoteBackend = createRemoteBackendRef.current;
    const relaySocketAdapter = relaySocketAdapterRef.current;
    const createRelaySigner = createRelaySignerRef.current;
    if (!enabled || !relay || !identity || !createRemoteBackend || !relaySocketAdapter || !createRelaySigner) return;

    const relayUrl = relay.url;
    const signer = createRelaySigner(identity);
    const manager = getManager();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let directoryClient: RelayMachineDirectoryClient<any> | null = null;
    let stopped = false;

    const connect = async () => {
      // Ensure we have a device certificate
      if (!deviceCertRef.current) {
        const getCert = getDeviceCertificateRef.current;
        if (!getCert) {
          logger.warning('[multiBackends] No getDeviceCertificate factory; cannot create relay directory client');
          return;
        }
        deviceCertRef.current = await getCert(identity);
      }
      const deviceCertificate = deviceCertRef.current;
      if (!deviceCertificate) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      directoryClient = new RelayMachineDirectoryClient<any>({
        relayUrl,
        clientIdentityId: identity.id,
        deviceCertificate,
        socketAdapter: relaySocketAdapter,
        signer: (msg) => signer(msg),
        pingIntervalMs: 20000,
        onMachineList: (machines) => {
          if (stopped) return;
          const onlineMachines = machines.filter((m) => m.online && m.isAuthorized);
          const localMachineId = engineStateRef.current.backends[LOCAL_BACKEND_KEY]?.descriptor.machineId;
          const visibleRemoteMachines = localMachineId
            ? onlineMachines.filter((machine) => machine.machineId !== localMachineId)
            : onlineMachines;
          const onlineIds = new Set(visibleRemoteMachines.map((m) => m.machineId));

          // Register new backends for machines that just appeared
          for (const machine of visibleRemoteMachines) {
            if (registeredRemoteBackendsRef.current.has(machine.machineId)) continue;
            const backendKey = buildRemoteBackendKey(relayUrl, machine.machineId);
            try {
              const { backend } = createRemoteBackend({
                relayUrl,
                identity,
                machineId: machine.machineId,
                deviceCertificate,
                machineLabel: machine.label,
              });
              dispatch({ type: 'REGISTER_BACKEND', descriptor: backend.descriptor });
              manager.register(backend);
              registeredRemoteBackendsRef.current.set(machine.machineId, backendKey);
              void manager.connect(backendKey).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warning(`[multiBackends] Remote backend connect failed (${machine.machineId}): ${msg}`);
                dispatch({ type: 'SET_BACKEND_STATUS', backendKey, status: 'error', error: msg });
              });
            } catch (err) {
              logger.warning(`[multiBackends] Failed to create remote backend for ${machine.machineId}: ${err}`);
            }
          }

          // Unregister backends for machines that went offline / lost auth
          for (const [machineId, backendKey] of registeredRemoteBackendsRef.current) {
            if (!onlineIds.has(machineId)) {
              registeredRemoteBackendsRef.current.delete(machineId);
              void manager.unregister(backendKey).catch(() => undefined);
              dispatch({ type: 'UNREGISTER_BACKEND', backendKey });
            }
          }
        },
        onError: (msg) => {
          logger.warning(`[multiBackends] Relay directory error: ${msg}`);
        },
      });

      directoryClient.connect().catch((err: unknown) => {
        logger.warning(`[multiBackends] Relay directory connect failed: ${err}`);
      });
    };

    void connect();

    return () => {
      stopped = true;
      directoryClient?.disconnect();
      directoryClient = null;

      // Unregister all remote backends registered by this relay
      for (const [, backendKey] of registeredRemoteBackendsRef.current) {
        void manager.unregister(backendKey).catch(() => undefined);
        dispatch({ type: 'UNREGISTER_BACKEND', backendKey });
      }
      registeredRemoteBackendsRef.current.clear();
    };
  // Factory callbacks (createRemoteBackend, relaySocketAdapter, createRelaySigner,
  // getDeviceCertificate) are intentionally excluded — reference changes must not
  // trigger relay reconnection. Only structural changes (relay URL, identity, enabled)
  // should reconnect.
  }, [enabled, relay?.url, identity?.id, getManager]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup all backends on unmount
  useEffect(() => {
    return () => {
      managerRef.current?.disconnectAll().catch(() => undefined);
    };
  }, []);

  // ─── Core accessors ─────────────────────────────────────────────────────────

  /** Get the raw SessionBackend instance for a given key. Useful for PTY operations. */
  const getBackend = useCallback((key: BackendKey): SessionBackend | null => {
    return managerRef.current?.get(key) ?? null;
  }, []);

  /** Get the full BackendSessionState for a given key (non-snapshot state: inbox, sessions, script state, etc.). */
  const getBackendState = useCallback((key: BackendKey): BackendSessionState | null => {
    return engineStateRef.current.backends[key] ?? null;
  }, []);

  // ─── Internal helpers ────────────────────────────────────────────────────────

  function withBackend<T>(key: BackendKey, fn: (b: SessionBackend) => Promise<T>): Promise<T> {
    const backend = managerRef.current?.get(key);
    if (!backend) return Promise.reject(new Error(`No backend registered: ${key}`));
    return fn(backend);
  }

  function withRefBackend<T>(
    ref: BackendScopedWorkspaceRef | BackendScopedSessionRef | BackendScopedAgentSessionRef,
    fn: (b: SessionBackend) => Promise<T>
  ): Promise<T> {
    return withBackend(ref.backendKey, fn);
  }

  function getWorkspaceRecord(ref: BackendScopedWorkspaceRef) {
    const snapshot = engineStateRef.current.backends[ref.backendKey]?.machineSnapshot;
    return snapshot?.workspacesById[ref.workspaceId] ?? null;
  }

  // ─── Fanout actions (run on ALL connected backends) ──────────────────────────

  const listProjects = useCallback((): void => {
    const manager = managerRef.current;
    if (!manager) return;
    for (const key of manager.keys()) {
      void withBackend(key, (b) => b.listProjects()).catch((e: unknown) =>
        logger.error(`[${key}] listProjects: ${e}`)
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const listWorkspaces = useCallback((): void => {
    const manager = managerRef.current;
    if (!manager) return;
    for (const key of manager.keys()) {
      void withBackend(key, (b) => b.listWorkspaces()).catch((e: unknown) =>
        logger.error(`[${key}] listWorkspaces: ${e}`)
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const listSessions = useCallback((workspaceId?: string): void => {
    const manager = managerRef.current;
    if (!manager) return;
    for (const key of manager.keys()) {
      void withBackend(key, (b) => b.listSessions(workspaceId)).catch((e: unknown) =>
        logger.error(`[${key}] listSessions: ${e}`)
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const listReplays = useCallback((workspaceId?: string, includeDismissed?: boolean): void => {
    const manager = managerRef.current;
    if (!manager) return;
    for (const key of manager.keys()) {
      void withBackend(key, (b) => b.listReplays?.(workspaceId, includeDismissed) ?? Promise.resolve()).catch(
        (e: unknown) => logger.error(`[${key}] listReplays: ${e}`)
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const requestInbox = useCallback((): void => {
    const manager = managerRef.current;
    if (!manager) return;
    for (const key of manager.keys()) {
      void withBackend(key, (b) => b.requestInbox()).catch((e: unknown) =>
        logger.error(`[${key}] requestInbox: ${e}`)
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const clearInbox = useCallback((id?: string): Promise<void> => {
    return withBackend(LOCAL_BACKEND_KEY, (b) => b.clearInbox(id));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const markInboxRead = useCallback((id: string): Promise<void> => {
    return withBackend(LOCAL_BACKEND_KEY, (b) => b.markInboxRead(id));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const getNotificationConfig = useCallback((): void => {
    const manager = managerRef.current;
    if (!manager) return;
    for (const key of manager.keys()) {
      void withBackend(key, (b) => b.getNotificationConfig()).catch((e: unknown) =>
        logger.error(`[${key}] getNotificationConfig: ${e}`)
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const updateNotificationConfig = useCallback(
    (config: NotificationConfig): Promise<void> => {
      return withBackend(LOCAL_BACKEND_KEY, (b) => b.updateNotificationConfig(config));
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ─── Ref-scoped actions (backendKey embedded in ref) ─────────────────────────

  const attachSession = useCallback(
    (ref: BackendScopedWorkspaceRef, params: AttachSessionParams): Promise<void> => {
      return withRefBackend(ref, (b) =>
        b.attachSession({ workspaceId: ref.workspaceId, ...params })
      );
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const detachSession = useCallback(
    (ref: BackendScopedWorkspaceRef | BackendScopedSessionRef): Promise<void> => {
      return withRefBackend(ref, (b) => b.detachSession());
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const cancelPendingScripts = useCallback(
    (ref: BackendScopedWorkspaceRef): Promise<void> => {
      return withRefBackend(ref, (b) => b.cancelPendingScripts?.() ?? Promise.resolve());
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const killSession = useCallback(
    (ref: BackendScopedSessionRef): Promise<void> => {
      return withRefBackend(ref, (b) => b.killSession(ref.sessionId));
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const deleteWorkspace = useCallback(
    (ref: BackendScopedWorkspaceRef, params?: DeleteWorkspaceParams): Promise<void> => {
      const workspace = getWorkspaceRecord(ref);
      const projectName = workspace?.projectName ?? ref.workspaceId.split(':')[0] ?? ref.workspaceId;
      return withRefBackend(ref, (b) => b.deleteWorkspace(projectName, ref.workspaceId, params));
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const setWorkspaceStatus = useCallback(
    (ref: BackendScopedWorkspaceRef, phase: WorkspacePhase): Promise<void> => {
      const workspace = getWorkspaceRecord(ref);
      const projectName = workspace?.projectName ?? ref.workspaceId.split(':')[0] ?? ref.workspaceId;
      const workspaceName = workspace?.name ?? ref.workspaceId.split(':')[1] ?? ref.workspaceId;
      return withRefBackend(ref, (b) =>
        b.setWorkspaceStatus?.(projectName, workspaceName, phase) ?? Promise.resolve()
      );
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const startProcess = useCallback(
    (ref: BackendScopedWorkspaceRef, processName: string, instance?: number): Promise<void> => {
      return withRefBackend(ref, (b) =>
        b.startProcess?.(ref.workspaceId, processName, instance) ?? Promise.resolve()
      );
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const stopProcess = useCallback(
    (ref: BackendScopedWorkspaceRef, processName: string): Promise<void> => {
      return withRefBackend(ref, (b) =>
        b.stopProcess?.(ref.workspaceId, processName) ?? Promise.resolve()
      );
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const requestEvents = useCallback(
    (
      ref: BackendScopedWorkspaceRef,
      filter?: WideEventFilter,
      limit?: number,
      sinceMs?: number
    ): Promise<void> => {
      const workspace = getWorkspaceRecord(ref);
      if (!workspace) return Promise.resolve();
      return withRefBackend(ref, (b) =>
        b.requestEvents?.(workspace.path, filter, limit, sinceMs) ?? Promise.resolve()
      );
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const getBundleRefreshPlan = useCallback(
    (ref: BackendScopedWorkspaceRef): Promise<BundleRefreshPlan> => {
      const workspace = getWorkspaceRecord(ref);
      const projectName = workspace?.projectName ?? ref.workspaceId.split(':')[0] ?? ref.workspaceId;
      return withRefBackend(ref, (b) => b.getBundleRefreshPlan(projectName, ref.workspaceId));
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const applyBundleRefresh = useCallback(
    (ref: BackendScopedWorkspaceRef, submission: BundleRefreshSubmission): Promise<void> => {
      const workspace = getWorkspaceRecord(ref);
      const projectName = workspace?.projectName ?? ref.workspaceId.split(':')[0] ?? ref.workspaceId;
      return withRefBackend(ref, (b) => b.applyBundleRefresh(projectName, ref.workspaceId, submission));
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const getBundleConfigState = useCallback(
    (ref: BackendScopedWorkspaceRef): Promise<BundleConfigState> => {
      const workspace = getWorkspaceRecord(ref);
      const projectName = workspace?.projectName ?? ref.workspaceId.split(':')[0] ?? ref.workspaceId;
      return withRefBackend(ref, (b) => b.getBundleConfigState(projectName, ref.workspaceId));
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const applyBundleConfigUpdate = useCallback(
    (ref: BackendScopedWorkspaceRef, submission: BundleConfigSubmission): Promise<void> => {
      const workspace = getWorkspaceRecord(ref);
      const projectName = workspace?.projectName ?? ref.workspaceId.split(':')[0] ?? ref.workspaceId;
      return withRefBackend(ref, (b) =>
        b.applyBundleConfigUpdate(projectName, ref.workspaceId, submission)
      );
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const createCheckpoint = useCallback(
    (ref: BackendScopedSessionRef): Promise<void> => {
      return withRefBackend(ref, (b) => b.createCheckpoint?.(ref.sessionId) ?? Promise.resolve());
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const sendReviewRequest = useCallback(
    (ref: BackendScopedWorkspaceRef | BackendScopedSessionRef, operation: ReviewOperation): Promise<ReviewResult> => {
      return withRefBackend(ref, (b) => b.sendReviewRequest(operation));
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ─── Agent session actions (ref-scoped) ──────────────────────────────────────

  const respondToAgentPermission = useCallback(
    (
      ref: BackendScopedAgentSessionRef,
      permissionId: string,
      response: 'allow' | 'deny'
    ): Promise<boolean> => {
      return withRefBackend(ref, (b) =>
        b.respondToAgentPermission(ref.workspaceId, ref.agentSessionId, permissionId, response)
      );
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const createAgentSession = useCallback(
    (ref: BackendScopedWorkspaceRef, title?: string) => {
      return withRefBackend(ref, (b) =>
        b.createAgentSession?.(ref.workspaceId, title) ?? Promise.resolve([])
      );
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const abortAgentSession = useCallback(
    (ref: BackendScopedAgentSessionRef): Promise<boolean> => {
      return withRefBackend(ref, (b) =>
        b.abortAgentSession?.(ref.workspaceId, ref.agentSessionId) ?? Promise.resolve(false)
      );
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const closeAgentSession = useCallback(
    (ref: BackendScopedAgentSessionRef) => {
      return withRefBackend(ref, (b) =>
        b.closeAgentSession?.(ref.workspaceId, ref.agentSessionId) ?? Promise.resolve([])
      );
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const archiveAgentSession = useCallback(
    (ref: BackendScopedAgentSessionRef) => {
      return withRefBackend(ref, (b) =>
        b.archiveAgentSession?.(ref.workspaceId, ref.agentSessionId) ?? Promise.resolve([])
      );
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const restoreAgentSession = useCallback(
    (ref: BackendScopedAgentSessionRef) => {
      return withRefBackend(ref, (b) =>
        b.restoreAgentSession?.(ref.workspaceId, ref.agentSessionId) ?? Promise.resolve([])
      );
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const attachAgentSession = useCallback(
    (ref: BackendScopedAgentSessionRef, attachOptions?: { viewOnly?: boolean }): Promise<void> => {
      return withRefBackend(ref, (b) =>
        b.attachAgentSession?.(ref.workspaceId, ref.agentSessionId, attachOptions) ?? Promise.resolve()
      );
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const getAgentSessionPreference = useCallback(
    (ref: BackendScopedWorkspaceRef): Promise<string | null> => {
      return withRefBackend(ref, (b) => b.getAgentSessionPreference(ref.workspaceId));
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const setAgentSessionPreference = useCallback(
    (ref: BackendScopedWorkspaceRef, sessionId: string): Promise<void> => {
      return withRefBackend(ref, (b) => b.setAgentSessionPreference(ref.workspaceId, sessionId));
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ─── Backend-targeted creation/discovery (explicit backendKey) ───────────────

  const createProject = useCallback(
    (backendKey: BackendKey, params: CreateProjectParams): Promise<void> => {
      return withBackend(backendKey, async (b) => {
        await b.createProject(params);
        await b.listProjects();
        await b.listWorkspaces();
        await b.listSessions();
      });
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const prepareProjectCreation = useCallback(
    (backendKey: BackendKey, params: CreateProjectParams): Promise<PreparedProjectResult> => {
      return withBackend(backendKey, (b) => {
        if (!b.prepareProjectCreation) return Promise.reject(new Error('Project preparation unavailable'));
        return b.prepareProjectCreation(params);
      });
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const finalizeProjectCreation = useCallback(
    (backendKey: BackendKey, params: FinalizeProjectParams): Promise<void> => {
      return withBackend(backendKey, async (b) => {
        if (!b.finalizeProjectCreation) throw new Error('Project finalization unavailable');
        await b.finalizeProjectCreation(params);
        await b.listProjects();
        await b.listWorkspaces();
        await b.listSessions();
      });
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const cancelProjectCreation = useCallback(
    (backendKey: BackendKey, projectName: string): Promise<void> => {
      return withBackend(backendKey, async (b) => {
        if (!b.cancelProjectCreation) throw new Error('Project cancellation unavailable');
        await b.cancelProjectCreation(projectName);
        await b.listProjects();
        await b.listWorkspaces();
        await b.listSessions();
      });
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const createWorkspace = useCallback(
    (backendKey: BackendKey, params: CreateWorkspaceParams): Promise<void> => {
      return withBackend(backendKey, async (b) => {
        await b.createWorkspace(params);
        await b.listWorkspaces();
        await b.listSessions();
      });
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const deleteProject = useCallback(
    (backendKey: BackendKey, projectName: string, params?: DeleteProjectParams): Promise<void> => {
      return withBackend(backendKey, async (b) => {
        await b.deleteProject(projectName, params);
        await b.listProjects();
        await b.listWorkspaces();
        await b.listSessions();
      });
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const listGithubRepos = useCallback(
    (backendKey: BackendKey, org?: string): Promise<string[]> => {
      return withBackend(backendKey, (b) => b.listGithubRepos(org));
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const listRemoteBranches = useCallback(
    (backendKey: BackendKey, projectName: string): Promise<string[]> => {
      return withBackend(backendKey, (b) => b.listRemoteBranches(projectName));
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const listLinearIssues = useCallback(
    (backendKey: BackendKey, projectName: string): Promise<SessionLinearIssueSummary[]> => {
      return withBackend(backendKey, (b) => b.listLinearIssues(projectName));
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ─── Replay actions (backendKey-targeted) ────────────────────────────────────

  const getReplaySnapshot = useCallback(
    (backendKey: BackendKey, replayId: string, atMs?: number, scrollbackLines?: number): Promise<TerminalSnapshot> => {
      return withBackend(backendKey, (b) => {
        if (!b.getReplaySnapshot) return Promise.reject(new Error('Replay snapshot unavailable'));
        return b.getReplaySnapshot(replayId, atMs, scrollbackLines);
      });
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const getReplayText = useCallback(
    (
      backendKey: BackendKey,
      replayId: string,
      atMs?: number,
      scrollbackLines?: number,
      includeScrollback?: boolean,
      trimTrailingBlankRows?: boolean
    ): Promise<string> => {
      return withBackend(backendKey, (b) => {
        if (!b.getReplayText) return Promise.reject(new Error('Replay text unavailable'));
        return b.getReplayText(replayId, atMs, scrollbackLines, includeScrollback, trimTrailingBlankRows);
      });
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const getReplayMarkdown = useCallback(
    (
      backendKey: BackendKey,
      replayId: string,
      atMs?: number,
      scrollbackLines?: number,
      includeScrollback?: boolean,
      trimTrailingBlankRows?: boolean
    ): Promise<string> => {
      return withBackend(backendKey, (b) => {
        if (!b.getReplayMarkdown) return Promise.reject(new Error('Replay markdown unavailable'));
        return b.getReplayMarkdown(replayId, atMs, scrollbackLines, includeScrollback, trimTrailingBlankRows);
      });
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const getReplayFrame = useCallback(
    (backendKey: BackendKey, replayId: string, target?: ReplayFrameTarget): Promise<ReplayFrame> => {
      return withBackend(backendKey, (b) => {
        if (!b.getReplayFrame) return Promise.reject(new Error('Replay frame unavailable'));
        return b.getReplayFrame(replayId, target);
      });
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const getReplayTimeline = useCallback(
    (backendKey: BackendKey, replayId: string): Promise<ReplayTimeline> => {
      return withBackend(backendKey, (b) => {
        if (!b.getReplayTimeline) return Promise.reject(new Error('Replay timeline unavailable'));
        return b.getReplayTimeline(replayId);
      });
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const dismissReplay = useCallback(
    (backendKey: BackendKey, replayId: string): Promise<void> => {
      return withBackend(backendKey, (b) => b.dismissReplay?.(replayId) ?? Promise.resolve());
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const undismissReplay = useCallback(
    (backendKey: BackendKey, replayId: string): Promise<void> => {
      return withBackend(backendKey, (b) => b.undismissReplay?.(replayId) ?? Promise.resolve());
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const cancelPendingReplayRequests = useCallback(
    (backendKey: BackendKey): void => {
      managerRef.current?.get(backendKey)?.cancelPendingReplayRequests?.();
    },
    []
  );

  // ─── Projected state ─────────────────────────────────────────────────────────

  const state = useMemo<MultiMachineState>(
    () => toMultiMachineState(engineState),
    [engineState]
  );

  return {
    // ── State ──
    state,
    activeBackendKey: engineState.activeBackendKey,
    localBackendKey: LOCAL_BACKEND_KEY,
    /** Raw SessionBackend for a given key. Use for PTY send/resize/setWriteCallback. */
    getBackend,
    /** Full BackendSessionState for a given key (inbox, sessions, script state, replays, etc.). */
    getBackendState,

    // ── Fanout ──
    listProjects,
    listWorkspaces,
    listSessions,
    listReplays,
    requestInbox,
    clearInbox,
    markInboxRead,
    getNotificationConfig,
    updateNotificationConfig,

    // ── Ref-scoped ──
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

    // ── Agent session (ref-scoped) ──
    respondToAgentPermission,
    createAgentSession,
    abortAgentSession,
    closeAgentSession,
    archiveAgentSession,
    restoreAgentSession,
    attachAgentSession,
    getAgentSessionPreference,
    setAgentSessionPreference,

    // ── Backend-targeted creation/discovery ──
    createProject,
    prepareProjectCreation,
    finalizeProjectCreation,
    cancelProjectCreation,
    createWorkspace,
    deleteProject,
    listGithubRepos,
    listRemoteBranches,
    listLinearIssues,

    // ── Replays (backend-targeted) ──
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
