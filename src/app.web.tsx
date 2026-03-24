/** @jsxImportSource react */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { SessionTerminalHandle } from "./components/SessionTerminal.web";
import { ReplayTerminalWeb } from './components/ReplayTerminal.web';
import { ScriptTerminal } from "./components/ScriptTerminal.web";
import {
  applyModifiersToInput,
  type ModifierState,
} from "./components/TerminalControls.web";
import { AttachedTerminalPaneWeb } from './components/AttachedTerminalPane.web.js';
import { IdentityGate } from "./components/IdentityGate.web";
import type { Identity } from "./types/identity";
import { useVisualViewport } from "./hooks/useVisualViewport.web";
import { browserPreferencesService } from "./lib/preferences-service.web";
import { Toaster, toast } from "./lib/sonner.web";
import { applyDeviceClasses, isMobileLayout, isTouchDevice } from "./utils/device.web";
import { useUserActivity } from "./hooks/index.js";
import { useBundleRefreshAttachFlow } from './session/useBundleRefreshAttachFlow.js';
import { useBundleConfigFlow } from './session/useBundleConfigFlow.js';
import { useAttachController } from './app/session/useAttachController.js';
import { useProcessActions } from './app/session/useProcessActions.js';
import { useWorkspaceDeleteFlow } from './app/session/useWorkspaceDeleteFlow.js';
import { useLifecycleController } from './app/session/useLifecycleController.js';
import { ReviewPage } from './pages/ReviewPage.web.js';
import { buildEditProcessesCommand } from './lib/processes/editor.js';

// Shared components and hooks
import {
  useFlow,
  getDefaultShortcuts,
  type ReplayInfo,
  type WorkspaceInfo,
} from "./components/index.js";
// ProjectListWeb and SpacesBrowserWeb removed — browsing view now uses full-width kanban board
import { BoardPage } from "./pages/BoardPage.web.js";
import { WorkspaceDetailPage } from "./pages/WorkspaceDetailPage.web.js";
import { FlowWeb } from "./components/Flow.web.js";
import { useInboxPageModel } from './app/shared/inbox/useInboxPageModel.js';
import { InboxWeb } from "./components/Inbox.web.js";
import { useEvents, toWideEventItem, type WideEventItem } from "./components/Events.js";
import { EventsWeb } from "./components/Events.web.js";
import type { WideEventFilter } from "./types/events.js";
import type { WorkspacePhase } from './types/config.js';
import {
  useNotifications,
  type ToastNotification,
  type NotificationConfig,
  DEFAULT_NOTIFICATION_CONFIG,
  getSessionLabel,
} from "./notifications/index.js";
import {
  resolveInboxCommand,
} from './app/input/sessionCommands.js';
import {
  useCommandPaletteState,
  COMMAND_PALETTE_COMMAND_DEFS,
} from './app/workspaces/index.js';
import { useWorkspaceRuntimeModel } from './app/shared/workspace-runtime/useWorkspaceRuntimeModel.js';
import { ProcessStartCancelledError, isPortConflictError, promptToResolveProcessStartConflict } from './app/session/resolveProcessStartConflict.js';
import { executeCommandPaletteAction } from './app/shared/command-palette/executeCommandPaletteAction.js';
import { resolveSelectedProjectName, resolveSelectedWorkspace } from './app/shared/command-palette/workspace-selection.js';
import { showWorkspaceStatusSelect } from './app/shared/command-palette/workspace-status.js';
import { showReplayHistorySelect } from './app/shared/workspace-detail/showReplayHistorySelect.js';
import type { WorkspaceDetailReplayRow } from './app/shared/workspace-detail/types.js';

// Multi-backend layer (browser-side)
import {
  useMultiBackends,
} from './machine/multi/useMultiBackends.js';
import type { BackendScopedWorkspaceRef, BackendScopedAgentSessionRef } from './machine/multi/types.js';
import { useWorkspaceController } from './machine/controllers/useWorkspaceController.js';
import { useBoardPageModel } from './app/shared/board/useBoardPageModel.js';
import { selectBackendSnapshot, selectAllWorkspaces } from './machine/multi/selectors.js';
import type { BackendKey } from './session/backend.js';
import type { RemoteSessionPtyBackend } from './session/useRemoteSessionClient.js';

// Agent session helpers (platform-neutral)
import { openAgentSession, promptCreateAgentSession } from './agents/agent-session-actions.js';

// Browser-specific factories for useMultiBackends
import {
  createBrowserRemoteSessionBackend,
} from './app/session/createSessionBackend.web.js';
import { browserRelaySocketAdapter } from './relay-client/adapters/browser.js';
import { signRelayMessage } from './session/crypto/relay-signing.web.js';
import { getStoredDeviceCert } from './lib/storage/identity-store.web.js';
import type { RelayDescriptor } from './relay-client/index.js';

// Replay helper
import type { ReplayFrame, ReplayFrameTarget, ReplayTimeline } from './lib/tmux-lite/replay/index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

type View = "terminal" | "review" | "replay";

const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const DELETE_ERROR_CODES = new Set([
  'REMOVE_SCRIPT_FAILED',
  'DELETE_FAILED',
  'WORKSPACE_NOT_FOUND',
  'RESOURCE_NOT_FOUND',
  'NOT_FOUND',
]);

const SCRIPT_ERROR_CODES = new Set([
  'SCRIPT_CANCELLED',
  'SCRIPT_FAILED',
  'PRE_SCRIPT_FAILED',
  'SETUP_SCRIPT_FAILED',
  'SELECT_SCRIPT_FAILED',
  'REMOVE_SCRIPT_FAILED',
]);

// ─── Browser relay signer factory ────────────────────────────────────────────

function createBrowserRelaySigner(identity: Identity) {
  return <T extends object>(message: T): T => signRelayMessage(message, identity);
}

// ─── Browser device cert getter ───────────────────────────────────────────────

async function getBrowserDeviceCert(_identity: Identity): Promise<string> {
  const cert = getStoredDeviceCert();
  if (!cert) {
    throw new Error('No device certificate found. Re-run identity setup.');
  }
  return cert;
}

// ─── App component ───────────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState<View>("terminal");
  const [showInbox, setShowInbox] = useState(false);
  const [showScriptTerminal, setShowScriptTerminal] = useState(false);
  const [scriptWorkspaceName, setScriptWorkspaceName] = useState('workspace');
  const [showMobileControls, setShowMobileControls] = useState(false);
  const [inputMode, setInputMode] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [eventsWorkspacePath, setEventsWorkspacePath] = useState<string | null>(null);
  const [eventsWorkspaceLabel, setEventsWorkspaceLabel] = useState<string>('');
  const [pendingProcessEditWorkspaceId, setPendingProcessEditWorkspaceId] = useState<string | null>(null);
  const [modifiers, setModifiers] = useState<ModifierState>({
    ctrl: false,
    shift: false,
    alt: false,
  });
  const [localNotificationConfig, setLocalNotificationConfig] =
    useState<NotificationConfig | null>(null);
  const [isViewOnlySession, setIsViewOnlySession] = useState(false);
  const [activeReplay, setActiveReplay] = useState<ReplayInfo | null>(null);
  const [showDismissedReplays] = useState(false);
  const showDismissedReplaysRef = useRef(showDismissedReplays);
  const pendingProcessEditWorkspacesRef = useRef<unknown[] | null>(null);
  const pendingProcessEditValidationArmedRef = useRef(false);
  const eventsKeyboardStateRef = useRef<{
    selectedIndex: number;
    selectIndex: (index: number) => void;
  } | null>(null);

  // Terminal ref for external control (focus, sendData)
  const terminalRef = useRef<SessionTerminalHandle>(null);
  const lastScriptErrorRef = useRef<string | null>(null);
  const lastCommandErrorRef = useRef<string | null>(null);
  const lastScriptWorkspaceIdRef = useRef<string | null>(null);
  const suppressDeleteScriptFailureModalRef = useRef(false);

  // Review workspace/project state
  const [reviewWorkspace, setReviewWorkspace] = useState<{
    projectName: string;
    workspaceId: string;
    backendKey: BackendKey;
    workspaceLabel?: string;
  } | null>(null);

  // Identity state (resolved by IdentityGate before relay connection)
  const [resolvedIdentity, setResolvedIdentity] = useState<Identity | null>(null);

  // ─── Relay descriptor (same-origin WS) ────────────────────────────────────

  const relayDescriptor = useMemo<RelayDescriptor | null>(() => {
    if (!resolvedIdentity) return null;
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return { url: `${wsProtocol}//${location.host}/ws`, source: 'local' };
  }, [resolvedIdentity]);

  // ─── Multi-backend hook (browser: no local backend, remote via relay) ───────

  const multi = useMultiBackends({
    enabled: Boolean(resolvedIdentity),
    relay: relayDescriptor,
    identity: resolvedIdentity,
    createLocalBackend: null, // No local tmux-lite server in browser
    createRemoteBackend: createBrowserRemoteSessionBackend,
    relaySocketAdapter: browserRelaySocketAdapter,
    createRelaySigner: createBrowserRelaySigner,
    getDeviceCertificate: getBrowserDeviceCert,
  });

  const multiMachineState = multi.state;

  // ─── Active backend (the one currently attached / first connected) ─────────

  const activeBackendKey = multi.activeBackendKey;
  const activeBackendState = activeBackendKey ? multi.getBackendState(activeBackendKey) : null;

  // Find the backend that is currently in "attached" mode
  const attachedBackendKey = useMemo(() => {
    for (const key of multi.state.backendOrder) {
      const st = multi.getBackendState(key);
      if (st?.mode === 'attached') return key;
    }
    return null;
  }, [multi]);

  const attachedBackendState = attachedBackendKey ? multi.getBackendState(attachedBackendKey) : null;
  const terminalStatus = activeBackendState?.status ?? 'disconnected';
  const terminalMode = attachedBackendState?.mode ?? (activeBackendState?.mode ?? 'browsing');
  const attachedSessionName = attachedBackendState?.attachedSessionName ?? null;
  const attachedSessionMeta = attachedBackendState?.attachedSessionMeta ?? null;
  const commandError = attachedBackendState?.commandError ?? activeBackendState?.commandError ?? null;
  const scriptState = attachedBackendState?.scriptState ?? activeBackendState?.scriptState ?? null;
  const notificationConfig = activeBackendState?.notificationConfig ?? null;

  // ─── PTY backend ref ──────────────────────────────────────────────────────

  const ptyBackendRef = useRef<RemoteSessionPtyBackend | null>(null);
  const writeCallbackRef = useRef<((data: Uint8Array) => void) | null>(null);
  useEffect(() => {
    const key = attachedBackendKey ?? activeBackendKey;
    if (!key) return;
    ptyBackendRef.current = multi.getBackend(key) as RemoteSessionPtyBackend | null;
  }, [attachedBackendKey, activeBackendKey, multi]);

  const sendPty = useCallback((data: Uint8Array) => {
    const b = ptyBackendRef.current;
    if (b?.writePtyData) void b.writePtyData(data).catch(() => undefined);
  }, []);

  const resizePty = useCallback((cols: number, rows: number) => {
    const b = ptyBackendRef.current;
    if (b?.resizePty) void b.resizePty(cols, rows).catch(() => undefined);
  }, []);

  const setWriteCallback = useCallback((fn: ((data: Uint8Array) => void) | null) => {
    writeCallbackRef.current = fn;
    ptyBackendRef.current?.setPtyOutputHandler?.(fn);
  }, []);

  // Re-attach write callback when backend changes
  useEffect(() => {
    const key = attachedBackendKey ?? activeBackendKey;
    if (!key) return;
    const b = multi.getBackend(key) as RemoteSessionPtyBackend | null;
    ptyBackendRef.current = b;
    b?.setPtyOutputHandler?.(writeCallbackRef.current);
  }, [attachedBackendKey, activeBackendKey, multi]);

  // ─── Projects & workspaces from snapshot ──────────────────────────────────

  const allProjects = useMemo(() => {
    const key = activeBackendKey;
    if (!key) return [];
    const snapshot = selectBackendSnapshot(multiMachineState, key);
    if (!snapshot) return [];
    return snapshot.projectOrder.map((id) => snapshot.projectsById[id]).filter(Boolean);
  }, [multiMachineState, activeBackendKey]);

  // ─── Workspace / kanban controllers ───────────────────────────────────────

  const workspaceController = useWorkspaceController({ state: multiMachineState });
  const {
    boardState: workspaceBoardState,
    handleSelectWorkspace: handleBoardSelectWorkspace,
    worktreeCount,
    loading: boardLoading,
    selectedWorkspaceProjectName,
  } = useBoardPageModel({
    state: multiMachineState,
    selectedRef: workspaceController.selectedRef,
    setSelectedRef: workspaceController.setSelectedRef,
    clearSelectedRef: workspaceController.clearSelectedRef,
    onSetWorkspacePhase: async (ref, phase) => {
      await multi.setWorkspaceStatus(ref, phase);
    },
    resolveRefForWorkspaceId: (workspaceId) => {
      const ws = selectAllWorkspaces(multiMachineState).find((item) => item.workspace.id === workspaceId);
      return ws ? { backendKey: ws.backendKey, workspaceId } : null;
    },
    connected: terminalStatus === 'connected',
    mode: terminalMode,
    activeBackendKey,
    activeBackendHasSnapshot: activeBackendState?.machineSnapshot != null,
  });
  const workspaceRuntime = useWorkspaceRuntimeModel(multiMachineState);

  // ─── Session / replay data (from active backend) ──────────────────────────

  const selectedBackendKey = workspaceController.selectedRef?.backendKey ?? activeBackendKey;
  const selectedBackendState = selectedBackendKey ? multi.getBackendState(selectedBackendKey) : null;
  const backendSessions = useMemo(() => {
    if (!selectedBackendKey) return [];
    return selectedBackendState?.sessions ?? [];
  }, [selectedBackendState?.sessions, selectedBackendKey]);

  const backendReplays = useMemo(() => {
    if (!selectedBackendKey) return [];
    return selectedBackendState?.replays ?? [];
  }, [selectedBackendState?.replays, selectedBackendKey]);

  const backendInbox = activeBackendState?.inbox ?? [];
  const backendInboxUnreadCount = activeBackendState?.inboxUnreadCount ?? 0;
  const backendEvents = activeBackendState?.events ?? [];
  const backendLiveEventIds = activeBackendState?.liveEventIds ?? [];
  const backendSavedEventFilters = activeBackendState?.savedEventFilters ?? [];
  const backendAttachedSessionId = attachedBackendState?.attachedSessionId ?? null;

  // Filtered to selected project
  const filteredWorkspaces: WorkspaceInfo[] = useMemo(
    () => workspaceRuntime.workspaces.filter((workspace) => workspace.backendKey === selectedBackendKey),
    [workspaceRuntime.workspaces, selectedBackendKey],
  );

  const filteredWorkspaceIds = useMemo(
    () => new Set(filteredWorkspaces.map((w) => w.id)),
    [filteredWorkspaces],
  );

  const filteredSessions = useMemo(
    () => workspaceRuntime.sessions.filter((s) => filteredWorkspaceIds.has(s.workspaceId)),
    [workspaceRuntime.sessions, filteredWorkspaceIds],
  );

  const filteredReplays = useMemo(
    () => backendReplays,
    [backendReplays],
  );

  // Selected workspace detail
  const selectedRef = workspaceController.selectedRef;
  const backendAttachedWorkspaceId = attachedBackendState?.attachedWorkspaceId ?? null;
  const selectedWorkspaceForDetail = useMemo(
    () => selectedRef
      ? filteredWorkspaces.find((w) => w.id === selectedRef.workspaceId) ?? null
      : null,
    [selectedRef, filteredWorkspaces],
  );

  // Auto-navigate to the workspace that owns the attached session.
  // This ensures the detail view stays in sync with the PTY — when a new
  // terminal is created or a service session is selected, the workspace detail
  // view follows rather than requiring the user to manually re-select.
  useEffect(() => {
    if (!backendAttachedWorkspaceId) return;
    if (terminalMode !== 'attached') return;
    // Already viewing the correct workspace
    if (selectedRef?.workspaceId === backendAttachedWorkspaceId) return;
    handleBoardSelectWorkspace(backendAttachedWorkspaceId);
  }, [backendAttachedWorkspaceId, terminalMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const detailSessions = useMemo(
    () => selectedRef ? filteredSessions.filter((s) => s.workspaceId === selectedRef.workspaceId) : [],
    [selectedRef, filteredSessions],
  );

  const detailReplays = useMemo(
    () => selectedRef
      ? filteredReplays.filter((r) => r.workspaceId === selectedRef.workspaceId)
      : [],
    [selectedRef, filteredReplays],
  );

  useEffect(() => {
    if (!selectedRef || terminalStatus !== 'connected') return;
    multi.listSessions(selectedRef.workspaceId);
    multi.listReplays(selectedRef.workspaceId, showDismissedReplaysRef.current);
  }, [selectedRef, terminalStatus, multi.listSessions, multi.listReplays]);

  // ─── Active backend ref for targeting operations ───────────────────────────

  /** Returns the active (first connected) backend key for operations like project creation. */
  const getTargetBackendKey = useCallback((): BackendKey => {
    return activeBackendKey ?? 'local';
  }, [activeBackendKey]);

  /** Returns a BackendScopedWorkspaceRef for a workspace, using its known backendKey. */
  const getWorkspaceRef = useCallback((workspaceId: string): BackendScopedWorkspaceRef => {
    const ws = workspaceBoardState.groups
      .flatMap((g) => g.workspaces)
      .find((w) => w.id === workspaceId);
    return { backendKey: ws?.backendKey ?? getTargetBackendKey(), workspaceId };
  }, [workspaceBoardState.groups, getTargetBackendKey]);

  const getAgentRef = useCallback((workspaceId: string, agentSessionId: string): BackendScopedAgentSessionRef => ({
    ...getWorkspaceRef(workspaceId),
    agentSessionId,
  }), [getWorkspaceRef]);

  // ─── Agent session data ────────────────────────────────────────────────────

  const agentSessionsByWorkspace = workspaceRuntime.agentSessionsByWorkspace;
  const agentSessionCounts = workspaceRuntime.agentSessionCounts;
  const pendingPermissionsByWorkspace = workspaceRuntime.pendingPermissionsByWorkspace;
  const allWorkspaceEntries = workspaceRuntime.workspaces;
  const workspaceStatusById = workspaceRuntime.stripStatusById;

  // ─── Agent session actions ─────────────────────────────────────────────────

  const persistAgentSessionSelection = useCallback((workspaceId: string, sessionId: string) => {
    void multi.setAgentSessionPreference(getWorkspaceRef(workspaceId), sessionId);
  }, [multi, getWorkspaceRef]);



  const handleOpenAgentSession = useCallback(async (workspaceId: string, agentSessionId: string) => {
    await openAgentSession({
      workspaceId,
      agentSessionId,
      persistAgentSessionSelection,
      clearViewOnly: () => setIsViewOnlySession(false),
      attachAgentSession: (wid, aId) =>
        multi.attachAgentSession(getAgentRef(wid, aId)),
    });
  }, [multi, getAgentRef, persistAgentSessionSelection]);

  const handleAbortAgentSession = useCallback(async (workspaceId: string, agentSessionId: string) => {
    await multi.abortAgentSession(getAgentRef(workspaceId, agentSessionId));
  }, [multi, getAgentRef]);

  const handleCloseAgentSession = useCallback(async (workspaceId: string, agentSessionId: string) => {
    await multi.closeAgentSession(getAgentRef(workspaceId, agentSessionId));
  }, [multi, getAgentRef]);

  const handleArchiveAgentSession = useCallback(async (workspaceId: string, agentSessionId: string) => {
    await multi.archiveAgentSession(getAgentRef(workspaceId, agentSessionId));
  }, [multi, getAgentRef]);

  const handleRestoreAgentSession = useCallback(async (workspaceId: string, agentSessionId: string) => {
    await multi.restoreAgentSession(getAgentRef(workspaceId, agentSessionId));
  }, [multi, getAgentRef]);

  // ─── Notifications & preferences ──────────────────────────────────────────

  const activeNotificationConfig =
    notificationConfig ?? localNotificationConfig ?? DEFAULT_NOTIFICATION_CONFIG;

  const keyboardVisible = useVisualViewport();

  useEffect(() => {
    applyDeviceClasses();
    setShowMobileControls(isTouchDevice() || isMobileLayout());
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const handleChange = (e: MediaQueryListEvent) => {
      setShowMobileControls(e.matches || isTouchDevice());
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    let mounted = true;
    void browserPreferencesService.getNotificationConfig().then((config) => {
      if (mounted) setLocalNotificationConfig(config);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!notificationConfig) return;
    void browserPreferencesService.updateNotificationConfig(notificationConfig);
    setLocalNotificationConfig(notificationConfig);
  }, [notificationConfig]);

  // ─── Flow / Modal system ───────────────────────────────────────────────────

  const flow = useFlow({
    onError: (error) => console.error('Flow error:', error),
  });

  // ─── Agent session actions that need flow ─────────────────────────────────

  const handleCreateAgentSession = useCallback((workspaceId: string) => {
    promptCreateAgentSession({
      flow,
      workspaceId,
      getCurrentSessions: (id) => agentSessionsByWorkspace[id] ?? [],
      createAgentSession: async (wid, title) => {
        const sessions = await multi.createAgentSession(getWorkspaceRef(wid), title);
        return (sessions ?? []).map((s) => ({ ...s, workspaceId: wid }));
      },
      attachOptions: {
        workspaceId,
        persistAgentSessionSelection,
        clearViewOnly: () => setIsViewOnlySession(false),
        attachAgentSession: (wid, aId) =>
          multi.attachAgentSession(getAgentRef(wid, aId)),
      },
    });
  }, [flow, multi, agentSessionsByWorkspace, getWorkspaceRef, getAgentRef, persistAgentSessionSelection]);



  // ─── Resolve project name from workspaceId ────────────────────────────────

  const resolveWorkspaceProjectName = useCallback((workspaceId: string) => {
    const idx = workspaceId.indexOf(':');
    if (idx > 0) return workspaceId.slice(0, idx);
    return null;
  }, []);

  // ─── Bundle flows ──────────────────────────────────────────────────────────

  const bundleRefreshAttach = useBundleRefreshAttachFlow({
    flow,
    commandError,
    // useBundleRefreshAttachFlow expects (params) => ... (no ref); we look up the ref from the workspaceId
    attachSession: (params) => multi.attachSession(getWorkspaceRef(params.workspaceId ?? ''), params),
    getBundleRefreshPlan: (ref) => multi.getBundleRefreshPlan(ref),
    applyBundleRefresh: (ref, submission) => multi.applyBundleRefresh(ref, submission),
  });

  const bundleConfigFlow = useBundleConfigFlow({
    flow,
    getBundleConfigState: (ref) => multi.getBundleConfigState(ref),
    applyBundleConfigUpdate: (ref, submission) => multi.applyBundleConfigUpdate(ref, submission),
    onApplied: async () => {
      multi.listWorkspaces();
      multi.listSessions();
      multi.listReplays(undefined, showDismissedReplays);
    },
  });

  // ─── Attach size ───────────────────────────────────────────────────────────

  const getWebAttachSize = useCallback(() => {
    return terminalRef.current?.getSize() ?? { cols: 80, rows: 24 };
  }, []);

  // ─── Attach controller ─────────────────────────────────────────────────────

  const attachController = useAttachController({
    flow,
    attachSessionWithBundleRefresh: bundleRefreshAttach.attachSessionWithBundleRefresh,
    recoverableAttachParams: bundleRefreshAttach.recoverableParams,
    defaultProjectName: selectedWorkspaceProjectName,
    defaultBackendKey: getTargetBackendKey(),
    getAttachSize: getWebAttachSize,
    resolveProjectName: resolveWorkspaceProjectName,
    onBeforeAttach: ({ target, params }) => {
      if (target === 'session') {
        setShowScriptTerminal(false);
        return;
      }
      if (params.workspaceId && !params.command) {
        lastScriptWorkspaceIdRef.current = params.workspaceId;
        setShowInbox(false);
        setScriptWorkspaceName(params.workspaceId.split(':').slice(-1)[0] ?? params.workspaceId);
        setShowScriptTerminal(true);
      }
    },
    onAttachCancelled: ({ target }) => {
      if (target === 'workspace' && showScriptTerminal) return;
      if (target === 'workspace') setShowScriptTerminal(false);
    },
    onAttachError: ({ target, message }) => {
      const isWorkspaceScriptFailure = message.startsWith('Workspace scripts failed during');
      const hasScriptRuntimeState = Boolean(scriptState);
      if (target === 'workspace' && (!isWorkspaceScriptFailure || !hasScriptRuntimeState)) {
        setShowScriptTerminal(false);
      }
      flow.showMessage({
        title: isWorkspaceScriptFailure ? 'Workspace Script Failed' : 'Session Failed',
        message,
        variant: 'error',
      });
    },
  });

  const { deleteWorkspaceWithPrompt } = useWorkspaceDeleteFlow({
    flow,
    deleteWorkspace: (ref, params) => multi.deleteWorkspace(ref, params),
    onBeforeDelete: ({ target }) => {
      suppressDeleteScriptFailureModalRef.current = true;
      setShowInbox(false);
      setScriptWorkspaceName(target.workspaceName);
      setShowScriptTerminal(true);
    },
    onDeleteSuccess: async ({ target }) => {
      suppressDeleteScriptFailureModalRef.current = false;
      setShowScriptTerminal(false);
      if (workspaceBoardState.selectedWorkspaceId === target.ref.workspaceId) {
        workspaceBoardState.setSelectedWorkspaceId(null);
      }
      workspaceController.clearSelectedRef();
      multi.listWorkspaces();
      multi.listSessions();
      multi.listReplays(undefined, showDismissedReplays);
    },
    onDeleteCancelled: async () => {
      suppressDeleteScriptFailureModalRef.current = false;
      setShowScriptTerminal(false);
    },
    onDeleteError: async ({ message }) => {
      suppressDeleteScriptFailureModalRef.current = false;
      setShowScriptTerminal(false);
      flow.showMessage({ title: 'Delete Failed', message, variant: 'error' });
    },
  });

  const lifecycleController = useLifecycleController({
    flow,
    // All operations target the active backend (the machine serving this web app)
    listGithubRepos: (org?: string) => multi.listGithubRepos(getTargetBackendKey(), org),
    listRemoteBranches: (projectName: string) =>
      multi.listRemoteBranches(getTargetBackendKey(), projectName),
    listLinearIssues: (projectName: string) =>
      multi.listLinearIssues(getTargetBackendKey(), projectName),
    createProject: (params) =>
      multi.createProject(getTargetBackendKey(), params),
    prepareProjectCreation: (params) =>
      multi.prepareProjectCreation(getTargetBackendKey(), params),
    finalizeProjectCreation: (params) =>
      multi.finalizeProjectCreation(getTargetBackendKey(), params),
    cancelProjectCreation: (projectName: string) =>
      multi.cancelProjectCreation(getTargetBackendKey(), projectName),
    createWorkspace: (params) =>
      multi.createWorkspace(getTargetBackendKey(), params),
    deleteProject: (projectName: string, params) =>
      multi.deleteProject(getTargetBackendKey(), projectName, params),
    getProjectNames: () => allProjects.map((p) => p.name),
    refreshProjects: () => multi.listProjects(),
    refreshWorkspaces: () => multi.listWorkspaces(),
    refreshSessions: () => multi.listSessions(),
    onProjectCreated: () => undefined,
    onWorkspaceCreated: () => undefined,
  });

  // ─── Parse review deep-link on load ───────────────────────────────────────

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'review') {
      const ws = params.get('workspace');
      const proj = params.get('project');
      if (ws && proj) {
        setReviewWorkspace({
          projectName: proj,
          workspaceId: ws,
          backendKey: getTargetBackendKey(),
          workspaceLabel: ws,
        });
        setView('review');
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Script terminal visibility ────────────────────────────────────────────

  useEffect(() => {
    if (scriptState?.isRunning) {
      setShowScriptTerminal(true);
    }
    if (terminalMode === 'attached' || terminalStatus !== 'connected') {
      setShowScriptTerminal(false);
    }
  }, [terminalMode, scriptState?.isRunning, terminalStatus]);

  // ─── Process edit validation ───────────────────────────────────────────────

  useEffect(() => {
    if (
      !pendingProcessEditWorkspaceId ||
      !pendingProcessEditValidationArmedRef.current ||
      terminalMode !== 'browsing'
    ) return;
    multi.listWorkspaces();
  }, [pendingProcessEditWorkspaceId, terminalMode, multi.listWorkspaces]);

  useEffect(() => {
    if (
      !pendingProcessEditWorkspaceId ||
      !pendingProcessEditValidationArmedRef.current ||
      terminalMode !== 'browsing'
    ) return;

    if (
      pendingProcessEditWorkspacesRef.current &&
      pendingProcessEditWorkspacesRef.current === filteredWorkspaces
    ) return;
    pendingProcessEditWorkspacesRef.current = null;

    const workspace = filteredWorkspaces.find((item) => item.id === pendingProcessEditWorkspaceId);
    if (!workspace) {
      pendingProcessEditValidationArmedRef.current = false;
      setPendingProcessEditWorkspaceId(null);
      return;
    }

    if (workspace.processConfigError) {
      flow.showMessage({
        title: 'Invalid Processes Config',
        message: workspace.processConfigError,
        variant: 'error',
      });
    } else {
      const processCount = workspace.processes?.length ?? 0;
      flow.showMessage({
        title: 'Processes Config Updated',
        message: processCount === 0
          ? 'Config is valid. No processes are defined yet.'
          : `Config is valid. ${processCount} process${processCount === 1 ? '' : 'es'} defined.`,
        variant: 'success',
      });
    }

    pendingProcessEditValidationArmedRef.current = false;
    setPendingProcessEditWorkspaceId(null);
  }, [flow, pendingProcessEditWorkspaceId, terminalMode, filteredWorkspaces]);

  // ─── Script error modals ───────────────────────────────────────────────────

  useEffect(() => {
    const scriptError = scriptState?.error;
    if (!scriptError) { lastScriptErrorRef.current = null; return; }
    if (suppressDeleteScriptFailureModalRef.current) { lastScriptErrorRef.current = scriptError; return; }
    if (commandError?.code && SCRIPT_ERROR_CODES.has(commandError.code)) { lastScriptErrorRef.current = scriptError; return; }
    if (lastScriptErrorRef.current === scriptError) return;
    lastScriptErrorRef.current = scriptError;
    flow.showMessage({ title: 'Workspace Script Failed', message: scriptError, variant: 'error' });
  }, [flow, commandError?.code, scriptState?.error]);

  useEffect(() => {
    if (!commandError) { lastCommandErrorRef.current = null; return; }
    const key = `${commandError.code ?? ''}:${commandError.message}`;
    if (lastCommandErrorRef.current === key) return;
    lastCommandErrorRef.current = key;

    if (suppressDeleteScriptFailureModalRef.current && commandError.code && DELETE_ERROR_CODES.has(commandError.code)) return;

    const isScriptFailure = commandError.code ? SCRIPT_ERROR_CODES.has(commandError.code) : false;
    if (isScriptFailure) {
      if (!scriptState) {
        flow.showMessage({ title: 'Workspace Script Failed', message: commandError.message, variant: 'error' });
        setShowScriptTerminal(false);
      }
      return;
    }

    if (commandError.code === 'BUNDLE_REFRESH_REQUIRED') return;

    flow.showMessage({ title: 'Session Failed', message: commandError.message, variant: 'error' });
    if (scriptState?.isRunning !== true) setShowScriptTerminal(false);
  }, [flow, commandError, scriptState?.isRunning]);

  // ─── Attach session ────────────────────────────────────────────────────────

  const handleAttachSession = useCallback(async (params: { sessionId?: string; workspaceId?: string; viewOnly?: boolean }) => {
    setIsViewOnlySession(params.viewOnly ?? false);
    await attachController.attachFromSelection(params);
  }, [attachController]);

  // ─── Process actions ───────────────────────────────────────────────────────

  const processActions = useProcessActions({
    sessions: backendSessions,
    startProcess: async (workspaceId, processName, instance) => {
      const ref = getWorkspaceRef(workspaceId);
      try {
        await multi.startProcess(ref, processName, instance);
      } catch (error) {
        if (isPortConflictError(error)) {
          const resolved = await promptToResolveProcessStartConflict({ error, showConfirm: flow.showConfirm });
          if (resolved) {
            await multi.startProcess(ref, processName, instance);
            return;
          }
          throw new ProcessStartCancelledError();
        }
        throw error;
      }
    },
    stopProcess: (workspaceId, processName) => {
      const ref = getWorkspaceRef(workspaceId);
      return multi.stopProcess(ref, processName);
    },
    attachSession: handleAttachSession,
    onStartProcessError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
    onStopProcessError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
    onStartProcessAttachError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
    onAttachError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
    onAttachTimeout: (target) => {
      toast.error(`Process started but no active session appeared for ${target.processName}#${target.instance}.`);
    },
    pendingAttachCancelSignal: commandError,
  });

  // ─── Edit processes ────────────────────────────────────────────────────────

  const handleEditProcesses = useCallback(({ workspaceId }: { workspaceId: string }) => {
    setIsViewOnlySession(false);
    pendingProcessEditValidationArmedRef.current = false;
    pendingProcessEditWorkspacesRef.current = filteredWorkspaces;
    setPendingProcessEditWorkspaceId(workspaceId);
    const commandSpec = buildEditProcessesCommand();
    void attachController.attach({
      workspaceId,
      command: commandSpec.command,
      args: commandSpec.args,
    }).then((attached) => {
      if (!attached) {
        pendingProcessEditValidationArmedRef.current = false;
        pendingProcessEditWorkspacesRef.current = null;
        setPendingProcessEditWorkspaceId(null);
        return;
      }
      pendingProcessEditValidationArmedRef.current = true;
    });
  }, [attachController, filteredWorkspaces]);

  const handleManageBundleConfig = useCallback(async ({ workspaceId }: { workspaceId: string }) => {
    const ref = getWorkspaceRef(workspaceId);
    await bundleConfigFlow.openBundleConfig(ref);
  }, [bundleConfigFlow, getWorkspaceRef]);

  // ─── Replay ────────────────────────────────────────────────────────────────

  const refreshReplayList = useCallback(() => {
    multi.listReplays(undefined, showDismissedReplays);
  }, [multi, showDismissedReplays]);

  useEffect(() => { showDismissedReplaysRef.current = showDismissedReplays; }, [showDismissedReplays]);

  const handleOpenReplay = useCallback(async (replayId: string) => {
    const replay = backendReplays.find((item) => item.replayId === replayId);
    if (!replay) {
      flow.showMessage({ title: 'Replay Missing', message: 'Could not find replay metadata.', variant: 'error' });
      return;
    }
    setActiveReplay(replay);
    setView('replay');
  }, [flow, backendReplays]);

  const toggleReplayDismissed = useCallback(async (replay: ReplayInfo): Promise<boolean> => {
    const key = getTargetBackendKey();
    try {
      if (!replay.dismissedAt && replay.status === 'running') {
        flow.showMessage({
          title: 'Replay Still Running',
          message: 'Running replays cannot be dismissed.',
          variant: 'info',
        });
        return false;
      }
      if (replay.dismissedAt) {
        await multi.undismissReplay(key, replay.replayId);
        setActiveReplay((current) =>
          current && current.replayId === replay.replayId
            ? { ...current, dismissedAt: undefined, dismissedBy: undefined }
            : current,
        );
        return false;
      } else {
        await multi.dismissReplay(key, replay.replayId);
        setActiveReplay((current) =>
          current && current.replayId === replay.replayId
            ? { ...current, dismissedAt: Date.now() }
            : current,
        );
        return true;
      }
    } catch (error) {
      flow.showMessage({
        title: replay.dismissedAt ? 'Restore Failed' : 'Dismiss Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
      return false;
    } finally {
      refreshReplayList();
    }
  }, [getTargetBackendKey, flow, multi, refreshReplayList]);

  const loadReplayFrame = useCallback((replayId: string, target?: ReplayFrameTarget): Promise<ReplayFrame> => {
    return multi.getReplayFrame(getTargetBackendKey(), replayId, target);
  }, [multi, getTargetBackendKey]);

  const loadReplayTimeline = useCallback((replayId: string): Promise<ReplayTimeline> => {
    return multi.getReplayTimeline(getTargetBackendKey(), replayId);
  }, [multi, getTargetBackendKey]);

  const handleOpenReplayHistory = useCallback((args: {
    workspaceId: string;
    workspaceName: string;
    replayRows: WorkspaceDetailReplayRow[];
  }) => {
    showReplayHistorySelect({
      workspaceName: args.workspaceName,
      replayRows: args.replayRows,
      showSelect: (config) => flow.showSelect<string>(config),
      onSelectReplay: handleOpenReplay,
    });
  }, [flow, handleOpenReplay]);

  const handleOpenHelp = useCallback(() => flow.showHelp(getDefaultShortcuts()), [flow]);
  const handleOpenCreateMenu = useCallback(() => lifecycleController.openCreateMenu(selectedWorkspaceProjectName), [lifecycleController, selectedWorkspaceProjectName]);
  const handleDeleteProject = useCallback((projectName: string) => {
    lifecycleController.openDeleteProjectFlow(projectName);
  }, [lifecycleController]);
  const handleDeleteSession = useCallback((sessionId: string, sessionName: string) => {
    flow.showConfirm({
      title: 'Kill Session',
      message: `Kill session "${sessionName}"?`,
      variant: 'warning',
      confirmLabel: 'Kill',
      onConfirm: () => {
        if (attachedBackendState?.attachedSessionId === sessionId) {
          const ref: BackendScopedWorkspaceRef = { backendKey: attachedBackendKey ?? getTargetBackendKey(), workspaceId: '' };
          void multi.detachSession(ref);
        }
        const sessionRef = { backendKey: getTargetBackendKey(), sessionId };
        void multi.killSession(sessionRef);
      },
    });
  }, [flow, attachedBackendState, attachedBackendKey, getTargetBackendKey, multi]);

  const handleDeleteWorkspace = useCallback((workspace: WorkspaceInfo) => {
    const sessionCount = workspace.sessionCount || 0;
    flow.showConfirmTyped({
      title: 'Delete Workspace',
      message: `Are you sure you want to delete workspace "${workspace.name}"?`,
      confirmText: workspace.name,
      warning: sessionCount > 0 ? `This will kill ${sessionCount} active session(s)!` : undefined,
      onConfirm: async () => {
        const ref = getWorkspaceRef(workspace.id);
        await deleteWorkspaceWithPrompt({ ref, workspaceName: workspace.name });
      },
    });
  }, [deleteWorkspaceWithPrompt, flow, getWorkspaceRef]);

  const handleOpenReview = useCallback((workspaceId: string) => {
    const workspace = filteredWorkspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      toast.error('Select a workspace first.');
      return;
    }
    setReviewWorkspace({
      projectName: workspace.projectName,
      workspaceId: workspace.id,
      backendKey: getWorkspaceRef(workspace.id).backendKey,
      workspaceLabel: workspace.name,
    });
    setView('review');
  }, [filteredWorkspaces, getWorkspaceRef]);

  const handleOpenGitHubPullRequest = useCallback((workspaceId: string) => {
    const workspace = filteredWorkspaces.find((item) => item.id === workspaceId);
    const url = workspace?.pullRequest?.url;
    if (!url) {
      toast.info('No GitHub pull request found for this workspace.');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [filteredWorkspaces]);

  // ─── Command palette ───────────────────────────────────────────────────────

  const commandPaletteCommands = useMemo(
    () => COMMAND_PALETTE_COMMAND_DEFS.map((d) => ({ id: d.id, label: d.label, shortcut: d.shortcut })),
    [],
  );

  const selectedWorkspaceForCommands = resolveSelectedWorkspace({
    selectedBoardWorkspaceId: workspaceBoardState.selectedWorkspaceId,
    selectedDetailWorkspaceId: selectedRef?.workspaceId ?? selectedWorkspaceForDetail?.id ?? null,
    workspaces: filteredWorkspaces,
  });
  const selectedProjectForCommands = resolveSelectedProjectName({ selectedProjectName: selectedWorkspaceProjectName });

  const handleCommandPaletteSelect = useCallback(
    (id: string) => {
      executeCommandPaletteAction({
        commandId: id as (typeof COMMAND_PALETTE_COMMAND_DEFS)[number]['id'],
        workspace: selectedWorkspaceForCommands,
        projectName: selectedProjectForCommands,
        showSelect: (config) => flow.showSelect<string>(config),
        showMessage: ({ message, variant }) => {
          if (variant === 'error') {
            toast.error(message);
          } else if (variant === 'warning') {
            toast.warning(message);
          } else if (variant === 'success') {
            toast.success(message);
          } else {
            toast.info(message);
          }
        },
        onOpenUrl: async (url) => {
          window.open(url, '_blank', 'noopener,noreferrer');
        },
        onAddRepo: () => lifecycleController.openCreateProjectFlow(),
        onAddWorkspace: () => lifecycleController.openCreateMenu(null),
        onSetStatus: (workspace) => {
          showWorkspaceStatusSelect({
            showSelect: (config) => flow.showSelect<WorkspacePhase>(config),
            onSelectPhase: (phase) => {
              workspaceBoardState.setPhase(workspace.id, phase);
              flow.close();
            },
          });
        },
        onDeleteWorkspace: handleDeleteWorkspace,
        onEditBundleConfig: async (workspace) => {
          await handleManageBundleConfig({ workspaceId: workspace.id });
        },
        onEditProcessConfig: async (workspace) => {
          await handleEditProcesses({ workspaceId: workspace.id });
        },
        onDeleteRepo: handleDeleteProject,
        onOpenGitHubPr: (workspace) => handleOpenGitHubPullRequest(workspace.id),
        onOpenReview: (workspace) => handleOpenReview(workspace.id),
      });
    },
    [
      lifecycleController,
      handleDeleteProject,
      handleDeleteWorkspace,
      handleManageBundleConfig,
      handleEditProcesses,
      handleOpenGitHubPullRequest,
      handleOpenReview,
      workspaceBoardState,
      flow,
      selectedProjectForCommands,
      selectedWorkspaceForCommands,
    ],
  );

  const commandPalette = useCommandPaletteState({
    commands: commandPaletteCommands,
    onSelect: handleCommandPaletteSelect,
  });

  // ─── Inbox ─────────────────────────────────────────────────────────────────

  const inboxProps = useInboxPageModel({
    items: backendInbox,
    unreadCount: backendInboxUnreadCount,
    onClearItem: async (id) => { await multi.clearInbox(id); },
    onClearAll: async () => { await multi.clearInbox(); },
    onMarkRead: async (id) => { await multi.markInboxRead(id); },
    onAttachSession: async (sessionId) => {
      setShowInbox(false);
      await attachController.attachFromSelection({ sessionId });
    },
    onClose: () => setShowInbox(false),
  });

  // ─── Events ────────────────────────────────────────────────────────────────

  const eventsItems: WideEventItem[] = backendEvents.map(toWideEventItem);

  const eventsProps = useEvents({
    events: eventsItems,
    liveEventIds: backendLiveEventIds,
    savedFilters: backendSavedEventFilters,
    onSelectFilter: (filter) => {
      if (!eventsWorkspacePath) return;
      const ws = filteredWorkspaces.find((w) => w.path === eventsWorkspacePath);
      if (!ws) return;
      const ref = getWorkspaceRef(ws.id);
      if (filter) {
        const sinceMs = filter.sinceMinutes
          ? Date.now() - filter.sinceMinutes * 60 * 1000
          : undefined;
        void multi.requestEvents(ref, filter.filter as WideEventFilter, undefined, sinceMs);
      } else {
        void multi.requestEvents(ref);
      }
    },
    onClose: () => {
      setShowEvents(false);
      setEventsWorkspacePath(null);
    },
  });

  useEffect(() => {
    eventsKeyboardStateRef.current = {
      selectedIndex: eventsProps.selectedIndex,
      selectIndex: eventsProps.selectIndex,
    };
  }, [eventsProps.selectedIndex, eventsProps.selectIndex]);

  // Events polling when view is active
  useEffect(() => {
    if (!showEvents || !eventsWorkspacePath) return;
    const interval = setInterval(() => {
      const ws = filteredWorkspaces.find((w) => w.path === eventsWorkspacePath);
      if (!ws) return;
      const ref = getWorkspaceRef(ws.id);
      const activeFilter = eventsProps.activeFilterName
        ? backendSavedEventFilters.find((f) => f.name === eventsProps.activeFilterName) ?? null
        : null;
      if (activeFilter) {
        const sinceMs = activeFilter.sinceMinutes
          ? Date.now() - activeFilter.sinceMinutes * 60 * 1000
          : undefined;
        void multi.requestEvents(ref, activeFilter.filter as WideEventFilter, undefined, sinceMs);
      } else {
        void multi.requestEvents(ref);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [showEvents, eventsWorkspacePath, eventsProps.activeFilterName, backendSavedEventFilters, filteredWorkspaces, getWorkspaceRef, multi.requestEvents]);

  // ─── Activity tracking for notifications ──────────────────────────────────

  const holdWhenIdleMs = activeNotificationConfig.toast.holdWhenIdleMs ?? 15000;
  const { isUserActive, markActivity: handleTerminalActivity } = useUserActivity({
    isActivityTracked: view === "terminal" && terminalMode === "attached",
    holdWhenIdleMs,
  });

  // ─── Notification toasts ───────────────────────────────────────────────────

  const handleShowToast = useCallback((notification: ToastNotification) => {
    const description = notification.preview
      ? `${notification.preview} · Shift+Tab to attach`
      : 'Shift+Tab to attach';
    toast(notification.title, {
      description,
      icon: notification.icon,
      duration: 8000,
      action: {
        label: "Attach",
        onClick: () => { void attachController.attachFromSelection({ sessionId: notification.sessionId }); },
      },
    });
  }, [attachController]);

  const notifications = useNotifications({
    items: backendInbox,
    config: activeNotificationConfig,
    onShowToast: handleShowToast,
    onAttachSession: (sessionId) => {
      void attachController.attachFromSelection({ sessionId });
    },
    onMarkRead: async (itemId) => {
      await multi.markInboxRead(itemId);
    },
    pollIntervalMs: 5000,
    onRefreshInbox: async () => {
      if (terminalStatus === "connected") {
        multi.requestInbox();
      }
    },
    isUserActive,
    currentSessionId: backendAttachedSessionId ?? undefined,
  });

  // ─── Data refresh when connected ───────────────────────────────────────────

  useEffect(() => {
    if (terminalStatus === "connected" && terminalMode === "browsing") {
      multi.listProjects();
      multi.listWorkspaces();
      multi.listSessions();
      multi.getNotificationConfig();
    }
  }, [
    terminalStatus,
    terminalMode,
    multi.listProjects,
    multi.listWorkspaces,
    multi.listSessions,
    multi.getNotificationConfig,
  ]);

  useEffect(() => {
    if (terminalStatus === "connected" && terminalMode === "browsing") {
      multi.listReplays(undefined, showDismissedReplaysRef.current);
    }
  }, [terminalStatus, terminalMode, multi.listReplays]);

  // Reset view-only when detached
  useEffect(() => {
    if (terminalMode !== 'attached') setIsViewOnlySession(false);
  }, [terminalMode]);

  // ─── Keyboard handlers ─────────────────────────────────────────────────────

  // Machine list view is gone — browsing keyboard (spaces browser)
  // Inbox keyboard
  useEffect(() => {
    if (!showInbox) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const command = resolveInboxCommand({ key: e.key, shift: e.shiftKey });
      if (!command) return;
      e.preventDefault();
      if (command === 'move-up') inboxProps.moveUp();
      else if (command === 'move-down') inboxProps.moveDown();
      else if (command === 'activate') {
        if (inboxProps.isViewingThread) inboxProps.attachToSession();
        else inboxProps.openThread();
      } else if (command === 'back') {
        if (inboxProps.isViewingThread) inboxProps.closeThread();
        else setShowInbox(false);
      } else if (command === 'delete') {
        if (inboxProps.isViewingThread) inboxProps.deleteThread();
        else inboxProps.deleteSelected();
      } else if (command === 'clear') {
        inboxProps.clearAll();
      } else if (command === 'attach') {
        inboxProps.attachToSession();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showInbox, inboxProps.moveUp, inboxProps.moveDown, inboxProps.openThread, inboxProps.closeThread, inboxProps.deleteSelected, inboxProps.deleteThread, inboxProps.clearAll, inboxProps.attachToSession, inboxProps.isViewingThread]);

  // Events keyboard
  useEffect(() => {
    if (!showEvents) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Escape' || e.key === 'q') {
        e.preventDefault();
        setShowEvents(false);
        setEventsWorkspacePath(null);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        eventsKeyboardStateRef.current?.selectIndex((eventsKeyboardStateRef.current?.selectedIndex ?? 0) - 1);
      } else if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        eventsKeyboardStateRef.current?.selectIndex((eventsKeyboardStateRef.current?.selectedIndex ?? 0) + 1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showEvents]);

  // Attached terminal (Shift+Esc to detach)
  useEffect(() => {
    if (view !== "terminal" || terminalStatus !== "connected" || terminalMode !== "attached") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === "Escape") {
        e.preventDefault();
        const ref: BackendScopedWorkspaceRef = { backendKey: attachedBackendKey ?? getTargetBackendKey(), workspaceId: '' };
        void multi.detachSession(ref);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [view, terminalStatus, terminalMode, attachedBackendKey, getTargetBackendKey, multi]);

  // Script terminal keyboard
  useEffect(() => {
    if (view !== 'terminal' || terminalStatus !== 'connected' || terminalMode !== 'browsing' || !showScriptTerminal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.key === 'Escape' || e.key === 'q') && !scriptState?.isRunning) {
        e.preventDefault();
        setShowScriptTerminal(false);
      } else if ((e.key === 'c' || e.key === 'C') && scriptState?.isRunning) {
        e.preventDefault();
        const ref: BackendScopedWorkspaceRef = { backendKey: getTargetBackendKey(), workspaceId: '' };
        void multi.cancelPendingScripts(ref);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showScriptTerminal, terminalMode, scriptState?.isRunning, terminalStatus, view, getTargetBackendKey, multi]);

  // Global Shift+Tab for toast attach
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.shiftKey && e.key === "Tab" && notifications.activeToast) {
        e.preventDefault();
        const sessionLabel = getSessionLabel(notifications.activeToast.sessionName);
        flow.showConfirm({
          title: 'Switch Session',
          message: `Switch to "${sessionLabel}"?`,
          confirmLabel: 'Switch',
          onConfirm: () => { notifications.attachToActiveToast(); },
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [notifications.activeToast, notifications.attachToActiveToast, flow]);

  // Global Cmd+K / Ctrl+K for command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commandPalette.toggle();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commandPalette.toggle]);

  // ─── Identity gate ─────────────────────────────────────────────────────────

  if (!resolvedIdentity) {
    return <IdentityGate onIdentityReady={setResolvedIdentity} />;
  }

  // ─── Review view ───────────────────────────────────────────────────────────

  if (view === 'review' && reviewWorkspace) {
    if (terminalStatus === 'connected') {
      const reviewRef: BackendScopedWorkspaceRef = {
        backendKey: reviewWorkspace.backendKey,
        workspaceId: reviewWorkspace.workspaceId,
      };
      return (
        <>
          <ReviewPage
            projectName={reviewWorkspace.projectName}
            workspaceName={reviewWorkspace.workspaceId}
            workspaceLabel={reviewWorkspace.workspaceLabel}
            sendReviewRequest={(operation) => multi.sendReviewRequest(reviewRef, operation)}
            onBack={() => { setView('terminal'); setReviewWorkspace(null); }}
          />
          <Toaster theme="dark" position="top-right" richColors />
        </>
      );
    }

    return (
      <>
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0d1117] px-4">
          <div className="text-center">
            <div className="text-lg text-[#e6edf3] mb-2">
              Loading review for <span className="text-[#58a6ff]">{reviewWorkspace.workspaceLabel ?? reviewWorkspace.workspaceId}</span>
            </div>
            <div className="text-sm text-[#8b949e]">Connecting...</div>
            <button
              onClick={() => { setView('terminal'); setReviewWorkspace(null); }}
              className="mt-4 px-6 py-3 text-base bg-[#21262d] hover:bg-[#30363d] rounded-lg text-[#e6edf3] min-h-[48px] border border-[#30363d]"
            >
              Back to Workspaces
            </button>
          </div>
        </div>
        <Toaster theme="dark" position="top-right" richColors />
      </>
    );
  }

  // ─── Replay view ───────────────────────────────────────────────────────────

  if (view === 'replay' && activeReplay) {
    if (terminalStatus !== 'connected' || terminalMode !== 'browsing') {
      return (
        <>
          <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0d1117] px-4">
            <div className="text-center">
              <div className="text-lg text-[#e6edf3] mb-2">
                Loading replay for <span className="text-[#58a6ff]">{activeReplay.sessionName}</span>
              </div>
              <div className="text-sm text-[#8b949e]">Connecting...</div>
              <button
                onClick={() => { setView('terminal'); setActiveReplay(null); }}
                className="mt-4 px-6 py-3 text-base bg-[#21262d] hover:bg-[#30363d] rounded-lg text-[#e6edf3] min-h-[48px] border border-[#30363d]"
              >
                Back to Workspaces
              </button>
            </div>
          </div>
          <FlowWeb flow={flow} />
          <Toaster theme="dark" position="top-right" richColors />
        </>
      );
    }

    return (
      <>
        <ReplayTerminalWeb
          replay={activeReplay}
          loadReplayFrame={loadReplayFrame}
          loadReplayTimeline={loadReplayTimeline}
          onBack={() => { setView('terminal'); setActiveReplay(null); }}
          onDismiss={activeReplay.status === 'running'
            ? undefined
            : (replayId) => {
              const replay = backendReplays.find((item) => item.replayId === replayId) ?? activeReplay;
              return toggleReplayDismissed(replay);
            }}
          onCleanup={() => multi.cancelPendingReplayRequests(getTargetBackendKey())}
        />
        <FlowWeb flow={flow} />
        <Toaster theme="dark" position="top-right" richColors />
      </>
    );
  }

  // ─── Script terminal (workspace scripts running) ───────────────────────────

  if (
    view === 'terminal' &&
    terminalStatus === 'connected' &&
    terminalMode === 'browsing' &&
    showScriptTerminal
  ) {
    const isRunning = scriptState?.isRunning ?? true;
    return (
      <>
        <ScriptTerminal
          phase={scriptState?.phase ?? 'pre'}
          workspaceName={scriptWorkspaceName}
          isRunning={isRunning}
          error={scriptState?.error}
          exitCode={scriptState?.exitCode}
          setWriteCallback={setWriteCallback}
          canAttachAnyway={Boolean(!isRunning && scriptState?.error && lastScriptWorkspaceIdRef.current)}
          onAttachAnyway={async () => {
            const workspaceId = lastScriptWorkspaceIdRef.current;
            if (!workspaceId) return;
            await attachController.attach({ workspaceId, scriptPolicy: 'skip' });
          }}
          onBack={() => { lastScriptWorkspaceIdRef.current = null; setShowScriptTerminal(false); }}
          onCancel={() => {
            const ref: BackendScopedWorkspaceRef = { backendKey: getTargetBackendKey(), workspaceId: '' };
            void multi.cancelPendingScripts(ref);
          }}
        />
        {!isRunning && <FlowWeb flow={flow} />}
        <Toaster theme="dark" position="top-right" richColors />
      </>
    );
  }

  // ─── Workspace browser / detail (connected + browsing, or inline-attached) ──

  if (
    view === "terminal" &&
    terminalStatus === "connected" &&
    (terminalMode === "browsing" || (terminalMode === "attached" && (selectedWorkspaceForDetail || backendAttachedWorkspaceId)))
  ) {
    if (showInbox) {
      return (
        <>
          <InboxWeb {...inboxProps} />
          <FlowWeb flow={flow} />
          <Toaster theme="dark" position="top-right" richColors />
        </>
      );
    }

    if (showEvents) {
      return (
        <>
          <EventsWeb {...eventsProps} workspaceLabel={eventsWorkspaceLabel} />
          <FlowWeb flow={flow} />
          <Toaster theme="dark" position="top-right" richColors />
        </>
      );
    }

    // Shared overlays (rendered in both board and detail views)
    const overlays = (
      <>
        <FlowWeb flow={flow} />
        <Toaster theme="dark" position="top-right" richColors />
        {commandPalette.isOpen && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[10vh]"
            role="dialog"
            aria-label="Command palette"
            onClick={() => commandPalette.close()}
          >
            <div
              className="w-full max-w-md rounded-lg border border-[#30363d] bg-[#21262d] shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="border-b border-[#30363d] px-3 py-2">
                <input
                  type="text"
                  placeholder="Filter commands..."
                  value={commandPalette.filter}
                  onChange={(e) => commandPalette.setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') commandPalette.close();
                    else if (e.key === 'ArrowDown') { e.preventDefault(); commandPalette.moveSelection(1); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); commandPalette.moveSelection(-1); }
                    else if (e.key === 'Enter') { e.preventDefault(); commandPalette.selectCurrent(); }
                  }}
                  className="w-full bg-transparent text-white placeholder-[#6e7681] outline-none"
                  autoFocus
                />
              </div>
              <ul className="max-h-[50vh] overflow-y-auto py-1">
                {commandPalette.filteredCommands.map((cmd, i) => (
                  <li
                    key={cmd.id}
                    className={`cursor-pointer px-3 py-2 text-sm ${i === commandPalette.selectedIndex ? 'bg-[#388bfd] text-white' : 'text-[#c9d1d9] hover:bg-[#30363d]'}`}
                    onClick={() => { commandPalette.setSelectedIndex(i); commandPalette.selectCurrent(); }}
                  >
                    {cmd.label}
                    {cmd.shortcut ? <span className="ml-2 text-[#6e7681]">{cmd.shortcut}</span> : null}
                  </li>
                ))}
              </ul>
              <div className="border-t border-[#30363d] px-3 py-1.5 text-xs text-[#6e7681]">
                ↑↓ select · Enter run · Esc close
              </div>
            </div>
          </div>
        )}
      </>
    );

    const inlineAttachedRef: BackendScopedWorkspaceRef = {
      backendKey: attachedBackendKey ?? getTargetBackendKey(),
      workspaceId: '',
    };

    const handleInlineSendData = (data: string) => {
      if (data === PAGE_UP && terminalRef.current?.pageUp()) return;
      if (data === PAGE_DOWN && terminalRef.current?.pageDown()) return;
      if (isViewOnlySession) return;
      sendPty(new TextEncoder().encode(data));
    };

    const handleInlineKeyboardData = (data: Uint8Array) => {
      if (isViewOnlySession) return;
      const hasModifiers = modifiers.ctrl || modifiers.shift || modifiers.alt;
      if (hasModifiers) {
        const modified = applyModifiersToInput(data, modifiers);
        sendPty(modified);
        setModifiers({ ctrl: false, shift: false, alt: false });
      } else {
        sendPty(data);
      }
    };

    const handleInlineFocusTerminal = () => terminalRef.current?.focus();
    const toggleInlineInputMode = () => {
      const newInputMode = !inputMode;
      setInputMode(newInputMode);
      if (newInputMode) terminalRef.current?.focus();
      else terminalRef.current?.blur();
    };

    const showInlineFloatingControls = showMobileControls && !keyboardVisible;
    const inlineTerminalContainerClass = (() => {
      if (!showMobileControls) return 'flex-1 min-h-0';
      if (inputMode) return 'terminal-input-mode-container';
      return 'flex-1 min-h-0 terminal-with-floating-controls';
    })();

    // Only show inline terminal when the attached session belongs to the
    // currently selected workspace (or no workspace tracking is available).
    const attachedMatchesSelected = !backendAttachedWorkspaceId
      || !selectedRef
      || selectedRef.workspaceId === backendAttachedWorkspaceId;
    const inlineTerminalOutlet = (terminalMode === 'attached' && attachedMatchesSelected) ? (
      <AttachedTerminalPaneWeb
        rootClassName="flex-1 min-h-0 flex flex-col bg-[#0d1117] overflow-hidden"
        headerClassName="flex-shrink-0 px-3 py-2 border-b border-[#21262d] bg-[#161b22] flex items-center justify-between gap-2"
        sessionName={attachedSessionName}
        processTitle={attachedSessionMeta?.processTitle ?? null}
        terminalTitle={attachedSessionMeta?.terminalTitle ?? null}
        lastAlertLabel={attachedSessionMeta?.lastAlertKind
          ? `${attachedSessionMeta.lastAlertKind}${attachedSessionMeta.unreadAlertCount ? ` (${attachedSessionMeta.unreadAlertCount})` : ''}`
          : null}
        showConnectedLabel={true}
        showMobileControls={showMobileControls}
        inputMode={inputMode}
        keyboardVisible={keyboardVisible}
        onToggleInputMode={toggleInlineInputMode}
        inputButtonClassName={`px-2 py-1 text-xs rounded transition-all ${
          inputMode
            ? 'bg-[#22c55e] text-[#0d1117] font-medium'
            : 'bg-[#21262d] text-[#e6edf3] hover:bg-[#30363d]'
        }`}
        onDetach={() => multi.detachSession(inlineAttachedRef)}
        detachButtonClassName="px-2 py-1 text-xs rounded border border-[#30363d] text-[#e6edf3] hover:bg-[#30363d]"
        terminalContainerClassName={inlineTerminalContainerClass}
        terminalRef={terminalRef}
        onData={handleInlineKeyboardData}
        setWriteCallback={setWriteCallback}
        onResize={resizePty}
        onActivity={handleTerminalActivity}
        readOnly={isViewOnlySession}
        allowTapFocus={inputMode || !showMobileControls}
        allowTouchScroll={!inputMode}
        onSendData={handleInlineSendData}
        onFocusTerminal={handleInlineFocusTerminal}
        modifiers={modifiers}
        onModifiersChange={setModifiers}
        showFloatingControls={showInlineFloatingControls}
      />
    ) : null;

    // ── Workspace detail page (full-screen, replaces board) ────────────────
    if (selectedWorkspaceForDetail) {
      return (
        <>
          <WorkspaceDetailPage
            workspace={selectedWorkspaceForDetail}
            sessions={detailSessions}
            replays={detailReplays}
            agentSessions={selectedRef ? (agentSessionsByWorkspace[selectedRef.workspaceId] ?? []) : []}
            agentSessionCount={selectedRef ? (agentSessionCounts[selectedRef.workspaceId] ?? 0) : 0}
            pendingPermissions={selectedRef ? (pendingPermissionsByWorkspace[selectedRef.workspaceId] ?? 0) : 0}
            attachedSessionId={backendAttachedSessionId}
            allWorkspaces={allWorkspaceEntries}
            workspaceStatusById={workspaceStatusById}
            runtime={selectedRef ? (workspaceRuntime.runtimeByWorkspace[selectedRef.workspaceId] ?? null) : null}
            onSelectWorkspace={(wid) => handleBoardSelectWorkspace(wid)}
            onOpenAgentSession={handleOpenAgentSession}
            onCreateAgentSession={handleCreateAgentSession}
            onAbortAgentSession={handleAbortAgentSession}
            onCloseAgentSession={handleCloseAgentSession}
            onArchiveAgentSession={handleArchiveAgentSession}
            onRestoreAgentSession={handleRestoreAgentSession}
             onAttachSession={handleAttachSession}
             onOpenReplay={handleOpenReplay}
             onOpenReplayHistory={handleOpenReplayHistory}
             onStartProcess={(params) => processActions.handleStartProcess(params)}
            onStartProcessAttach={(params) => processActions.handleStartProcessAttach(params)}
            onStopProcess={(params) => processActions.handleStopProcess(params)}
            onEditProcesses={handleEditProcesses}
            onManageBundleConfig={handleManageBundleConfig}
            onOpenGitHubPullRequest={handleOpenGitHubPullRequest}
            onOpenReview={handleOpenReview}
            onRequestStatusChange={(workspaceId) => {
              showWorkspaceStatusSelect({
                showSelect: (config) => flow.showSelect<WorkspacePhase>(config),
                onSelectPhase: (phase) => {
                  workspaceBoardState.setPhase(workspaceId, phase);
                  flow.close();
                },
              });
            }}
            onOpenEvents={(workspaceId) => {
              const w = filteredWorkspaces.find((x) => x.id === workspaceId);
              if (w) {
                setEventsWorkspacePath(w.path);
                setEventsWorkspaceLabel(w.name);
                setShowEvents(true);
                void multi.requestEvents(getWorkspaceRef(workspaceId));
              }
            }}
            onDeleteSession={handleDeleteSession}
            onClose={() => handleBoardSelectWorkspace(null)}
          >
            {inlineTerminalOutlet}
          </WorkspaceDetailPage>
          {overlays}
        </>
      );
    }

    // ── Board page (full-screen kanban, no workspace selected) ─────────────
    return (
      <>
        <BoardPage
          groups={workspaceBoardState.groups}
          selectedWorkspaceId={workspaceBoardState.selectedWorkspaceId}
          onSelectWorkspace={handleBoardSelectWorkspace}
          onPhaseChange={workspaceBoardState.setPhase}
          workspaceStatusById={workspaceRuntime.workspaceStatusById}
          worktreeCount={worktreeCount}
          inboxUnreadCount={backendInboxUnreadCount}
          onOpenInbox={() => { multi.requestInbox(); setShowInbox(true); }}
          onOpenHelp={handleOpenHelp}
          onOpenCreateMenu={handleOpenCreateMenu}
          onOpenCommandPalette={() => commandPalette.toggle()}
          onRefresh={() => { multi.listWorkspaces(); multi.listProjects(); }}
          onDisconnect={() => window.location.reload()}
          loading={boardLoading}
          loadingLabel="Loading worktrees..."
        />
        {overlays}
      </>
    );
  }

  // ─── Terminal (attached mode) ──────────────────────────────────────────────

  if (view === "terminal" && terminalStatus === "connected" && terminalMode === "attached") {
    const handleSendData = (data: string) => {
      if (data === PAGE_UP && terminalRef.current?.pageUp()) return;
      if (data === PAGE_DOWN && terminalRef.current?.pageDown()) return;
      if (isViewOnlySession) return;
      sendPty(new TextEncoder().encode(data));
    };

    const handleKeyboardData = (data: Uint8Array) => {
      if (isViewOnlySession) return;
      const hasModifiers = modifiers.ctrl || modifiers.shift || modifiers.alt;
      if (hasModifiers) {
        const modified = applyModifiersToInput(data, modifiers);
        sendPty(modified);
        setModifiers({ ctrl: false, shift: false, alt: false });
      } else {
        sendPty(data);
      }
    };

    const handleFocusTerminal = () => terminalRef.current?.focus();
    const toggleInputMode = () => {
      const newInputMode = !inputMode;
      setInputMode(newInputMode);
      if (newInputMode) terminalRef.current?.focus();
      else terminalRef.current?.blur();
    };

    const showFloatingControls = showMobileControls && !keyboardVisible;
    const getTerminalContainerClass = () => {
      if (!showMobileControls) return 'flex-1';
      if (inputMode) return 'terminal-input-mode-container';
      return 'flex-1 terminal-with-floating-controls';
    };

    const attachedRef: BackendScopedWorkspaceRef = { backendKey: attachedBackendKey ?? getTargetBackendKey(), workspaceId: '' };

    return (
      <>
        <AttachedTerminalPaneWeb
          rootClassName="w-screen h-screen flex flex-col bg-[#0d1117] overflow-hidden"
          headerClassName="bg-[#161b22] px-4 py-2 flex items-center justify-between border-b border-[#30363d] min-h-[52px] gap-2 flex-shrink-0"
          leadingContent={(
            <button
              onClick={() => void multi.detachSession(attachedRef)}
              className="text-sm text-[#8b949e] hover:text-[#e6edf3] active:text-[#22c55e] py-2 pr-2 -ml-2 min-h-[44px] flex items-center flex-shrink-0"
            >
              ← <span className="hidden sm:inline ml-1">Workspaces</span>
            </button>
          )}
          trailingContent={<span className="text-xs text-[#6e7681] hidden sm:inline">Shift+Esc</span>}
          sessionName={attachedSessionName}
          processTitle={attachedSessionMeta?.processTitle ?? null}
          terminalTitle={attachedSessionMeta?.terminalTitle ?? null}
          lastAlertLabel={attachedSessionMeta?.lastAlertKind
            ? `${attachedSessionMeta.lastAlertKind}${attachedSessionMeta.unreadAlertCount ? ` (${attachedSessionMeta.unreadAlertCount})` : ''}`
            : null}
          showConnectedLabel={activeBackendState?.status === 'connected'}
          showMobileControls={showMobileControls}
          inputMode={inputMode}
          keyboardVisible={keyboardVisible}
          onToggleInputMode={toggleInputMode}
          inputButtonClassName={`px-3 py-2 text-sm rounded min-h-[44px] transition-all ${
            inputMode
              ? 'bg-[#22c55e] text-[#0d1117] shadow-glow font-medium'
              : 'bg-[#21262d] text-[#e6edf3] hover:bg-[#30363d]'
          }`}
          onDetach={() => multi.detachSession(attachedRef)}
          detachButtonClassName="px-3 py-2 text-sm bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] rounded text-[#e6edf3] min-h-[44px] border border-[#30363d]"
          terminalContainerClassName={getTerminalContainerClass()}
          terminalRef={terminalRef}
          onData={handleKeyboardData}
          setWriteCallback={setWriteCallback}
          onResize={resizePty}
          onActivity={handleTerminalActivity}
          readOnly={isViewOnlySession}
          allowTapFocus={inputMode || !showMobileControls}
          allowTouchScroll={!inputMode}
          onSendData={handleSendData}
          onFocusTerminal={handleFocusTerminal}
          modifiers={modifiers}
          onModifiersChange={setModifiers}
          showFloatingControls={showFloatingControls}
        />
        <Toaster theme="dark" position="top-right" richColors />
      </>
    );
  }

  // ─── Connecting / loading screen ───────────────────────────────────────────

  const statusMessage = {
    disconnected: "Disconnected — waiting for relay...",
    connecting: "Connecting to relay...",
    connected: "Connected, authenticating...",
    error: "Connection failed",
  }[terminalStatus] ?? "Loading...";

  const isError = terminalStatus === "error";

  return (
    <>
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0d1117] px-4">
        <div className="text-center">
          <h1 className="text-xl font-bold text-[#e6edf3] mb-4">GitSpace</h1>
          <div className="text-sm text-[#8b949e] mb-4">{statusMessage}</div>
          {!isError && (
            <div className="flex gap-1 justify-center">
              {[0, 1, 2].map((i) => (
                <div key={i} className="w-1.5 h-1.5 rounded-full bg-[#3fb950] animate-pulse" style={{ animationDelay: `${i * 0.2}s` }} />
              ))}
            </div>
          )}
          {isError && (
            <button
              onClick={() => window.location.reload()}
              className="mt-4 px-6 py-3 text-base bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] rounded-lg text-[#e6edf3] min-h-[48px] border border-[#30363d]"
            >
              Retry
            </button>
          )}
        </div>
      </div>
      <Toaster theme="dark" position="top-right" richColors />
    </>
  );
}
