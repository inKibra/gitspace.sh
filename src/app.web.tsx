/** @jsxImportSource react */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { flushSync } from "react-dom";
import type { SessionTerminalHandle } from "./components/SessionTerminal.web";
import { ReplayTerminalWeb } from './components/ReplayTerminal.web';
import { ScriptTerminal } from "./components/ScriptTerminal.web";
import {
  applyModifiersToInput,
  type ModifierState,
} from "./components/TerminalControls.web";
import { AttachedTerminalPaneWeb } from './components/AttachedTerminalPane.web.js';
import { DockviewWorkspaceShell } from './components/DockviewWorkspaceShell.web.js';
import { IdentityGate } from "./components/IdentityGate.web";
import type { Identity } from "./types/identity";
import { useVisualViewport } from "./hooks/useVisualViewport.web";
import { browserPreferencesService } from "./lib/preferences-service.web";
import { Toaster, toast } from "./lib/sonner.web";
import { ReviewPage } from './pages/ReviewPage.web.js';

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
import { useInboxPage } from './app/react/index.js';
import { InboxWeb } from "./components/Inbox.web.js";
import { useEvents, toWideEventItem, type WideEventItem } from "./components/Events.js";
import { EventsWeb } from "./components/Events.web.js";
import type { WideEventFilter } from "./types/events.js";
import type { WorkspacePhase } from './types/config.js';
import {
  useNotifications,
  type ToastNotification,
  DEFAULT_NOTIFICATION_CONFIG,
  getSessionLabel,
} from "./notifications/index.js";
import { useWorkspaceRuntimeModel } from './app/shared/workspace-runtime/useWorkspaceRuntimeModel.js';
import { useCommandPaletteOrchestration } from './app/react/index.js';
import { showReplayHistorySelect } from './app/shared/workspace-detail/showReplayHistorySelect.js';
import { showWorkspaceStatusSelect } from './app/shared/command-palette/workspace-status.js';
import type { WorkspaceDetailReplayRow } from './app/shared/workspace-detail/types.js';

// Multi-backend layer (browser-side)
import { GitSpaceProvider, useGitSpace } from './sdk/index.js';
import {
  type BackendScopedWorkspaceRef,
  toBackendScopedWorkspaceKey,
} from './machine/multi/types.js';
import { useBoardPageModel } from './app/shared/board/useBoardPageModel.js';
import { getShiftArrowPhaseChange } from './app/shared/board/phase-movement.js';
import { selectBackendSnapshot } from './machine/multi/selectors.js';
import type { BackendKey } from './session/backend.js';
import type { RemoteSessionPtyBackend } from './session/useRemoteSessionClient.js';
import { useAgentSessionActions, useWorkspaceLifecycleActions, useProcessActions, useInboxActions, useBundleRefreshAttachFlow, useBundleConfigFlow, useReplayReviewActions, useSessionActions, useLifecycleActions, useAttachActions, usePreferencesAdapter, useUserActivity, buildEditProcessesCommand, useWorkspaceController } from './app/react/index.js';

import { browserPlatform } from './sdk/platforms/browser.web.js';
import { NativeAgentSurfaceConnected } from './components/NativeAgentSurfaceConnected.web.js';
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


// ─── App component ───────────────────────────────────────────────────────────

type AppInnerProps = {
  resolvedIdentity: Identity | null;
  setResolvedIdentity: (identity: Identity | null) => void;
};

function AppInner({ resolvedIdentity, setResolvedIdentity }: AppInnerProps) {
  const [view, setView] = useState<View>("terminal");
  const [showInbox, setShowInbox] = useState(false);
  const [showScriptTerminal, setShowScriptTerminal] = useState(false);
  const [scriptWorkspaceName, setScriptWorkspaceName] = useState('workspace');
  const [showMobileControls] = useState(false);
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
  const lastScriptWorkspaceRef = useRef<BackendScopedWorkspaceRef | null>(null);
  const suppressDeleteScriptFailureModalRef = useRef(false);

  // Review workspace/project state
  const [reviewWorkspace, setReviewWorkspace] = useState<{
    projectName: string;
    workspaceId: string;
    backendKey: BackendKey | null;
    workspaceLabel?: string;
  } | null>(null);

  const { engine: multi, state: multiMachineState } = useGitSpace();

  const keyboardVisible = useVisualViewport();
  // ─── Active backend (the one currently attached / first connected) ─────────

  const activeBackendKey = multiMachineState.activeBackendKey;
  const activeBackendState = activeBackendKey ? multi.getBackendState(activeBackendKey) : null;
  const reviewBackendState = reviewWorkspace?.backendKey ? multi.getBackendState(reviewWorkspace.backendKey) : null;

  // Find the backend that is currently in "attached" mode
  const attachedBackendKey = useMemo(() => {
    for (const key of multiMachineState.backendOrder) {
      const st = multi.getBackendState(key);
      if (st?.mode === 'attached') return key;
    }
    return null;
  }, [multi, multiMachineState]);

  const attachedBackendState = attachedBackendKey ? multi.getBackendState(attachedBackendKey) : null;
  const terminalStatus = activeBackendState?.status ?? 'disconnected';
  const reviewTerminalStatus = reviewBackendState?.status ?? 'disconnected';
  const terminalMode = attachedBackendState?.mode ?? (activeBackendState?.mode ?? 'browsing');
  const attachedSessionName = attachedBackendState?.attachedSessionName ?? null;
  const attachedSessionMeta = attachedBackendState?.attachedSessionMeta ?? null;
  const commandError = attachedBackendState?.commandError ?? activeBackendState?.commandError ?? null;
  // Always-current ref so callbacks can read commandError without it in their dep array.
  const commandErrorRef = useRef(commandError);
  commandErrorRef.current = commandError;
  const scriptState = attachedBackendState?.scriptState ?? activeBackendState?.scriptState ?? null;
  const notificationConfig = activeBackendState?.notificationConfig ?? null;

  // ─── PTY backend ref ──────────────────────────────────────────────────────

  const ptyBackendRef = useRef<RemoteSessionPtyBackend | null>(null);
  const writeCallbackRef = useRef<((data: Uint8Array) => void) | null>(null);
  const scriptWriteCallbackRef = useRef<((data: Uint8Array) => void) | null>(null);
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

  const setScriptWriteCallback = useCallback((fn: ((data: Uint8Array) => void) | null) => {
    scriptWriteCallbackRef.current = fn;
    ptyBackendRef.current?.setScriptOutputHandler?.(fn);
  }, []);

  // Re-attach write callback when backend changes
  useEffect(() => {
    const key = attachedBackendKey ?? activeBackendKey;
    if (!key) return;
    const b = multi.getBackend(key) as RemoteSessionPtyBackend | null;
    ptyBackendRef.current = b;
    b?.setPtyOutputHandler?.(writeCallbackRef.current);
    b?.setScriptOutputHandler?.(scriptWriteCallbackRef.current);
  }, [attachedBackendKey, activeBackendKey, multi]);

  // ─── Flow / Modal system ───────────────────────────────────────────────────
  const flow = useFlow({
    onError: (error) => console.error('Flow error:', error),
  });


  const workspaceLifecycleClient = useMemo(() => ({
    multi,
    workspaceRefs: [],
  }), [multi]);

  const { setStatus: setWorkspaceStatusAction } = useWorkspaceLifecycleActions({
    client: workspaceLifecycleClient,
    flow,
    onError: (message) => {
      toast.error(message);
    },
  });

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
      await setWorkspaceStatusAction(ref, phase);
    },
    connected: terminalStatus === 'connected',
    mode: terminalMode,
    activeBackendKey,
    activeBackendHasSnapshot: activeBackendState?.machineSnapshot != null,
  });
  const workspaceRuntime = useWorkspaceRuntimeModel(multiMachineState);

  // ─── Session / replay data (from the selected backend) ──────────────────────
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
  const attachedTerminalInstanceKey = [
    attachedBackendKey ?? 'none',
    backendAttachedSessionId ?? 'none',
    attachedBackendState?.attachedAgentSessionId ?? 'none',
  ].join(':');

  const filteredWorkspaces = useMemo(
    () => workspaceRuntime.workspaces.filter((workspace) => workspace.backendKey === selectedBackendKey),
    [workspaceRuntime.workspaces, selectedBackendKey],
  );
  const filteredReplays = useMemo(() => backendReplays, [backendReplays]);

  const findWorkspaceEntry = useCallback((workspaceId: string, backendKey?: BackendKey | null) => {
    const preferredBackendKey =
      backendKey ?? workspaceController.selectedRef?.backendKey ?? selectedBackendKey ?? activeBackendKey ?? null;
    if (preferredBackendKey) {
      const preferredMatch = workspaceRuntime.workspaces.find(
        (workspace) => workspace.id === workspaceId && workspace.backendKey === preferredBackendKey,
      );
      if (preferredMatch) {
        return preferredMatch;
      }
    }
    return workspaceRuntime.workspaces.find(
      (workspace) => workspace.id === workspaceId && (backendKey == null || workspace.backendKey === backendKey),
    ) ?? null;
  }, [activeBackendKey, selectedBackendKey, workspaceController.selectedRef, workspaceRuntime.workspaces]);

  const getWorkspaceRef = useCallback((workspaceId: string, backendKey?: BackendKey | null): BackendScopedWorkspaceRef => {
    const workspace = findWorkspaceEntry(workspaceId, backendKey);
    if (workspace) {
      return { backendKey: workspace.backendKey as BackendKey, workspaceId: workspace.id };
    }
    return {
      backendKey: backendKey ?? workspaceController.selectedRef?.backendKey ?? selectedBackendKey ?? activeBackendKey ?? 'local',
      workspaceId,
    };
  }, [activeBackendKey, findWorkspaceEntry, selectedBackendKey, workspaceController.selectedRef]);

  const getSessionRef = useCallback((sessionId: string, preferredBackendKey?: BackendKey | null) => {
    const candidateKeys = [
      preferredBackendKey,
      selectedBackendKey,
      attachedBackendKey,
      activeBackendKey,
      ...multiMachineState.backendOrder,
    ].filter((value, index, values): value is BackendKey =>
      typeof value === 'string' && values.indexOf(value) === index,
    );

    if (preferredBackendKey) {
      const preferredState = multi.getBackendState(preferredBackendKey);
      if (preferredState?.sessions?.some((session) => session.id === sessionId)) {
        return { backendKey: preferredBackendKey, sessionId };
      }
    }

    let match: BackendKey | null = null;

    for (const backendKey of candidateKeys) {
      if (backendKey === preferredBackendKey) continue;
      const state = multi.getBackendState(backendKey);
      if (state?.sessions?.some((session) => session.id === sessionId)) {
        if (match !== null) {
          return null;
        }

        match = backendKey;
      }
    }

    if (!match) {
      return null;
    }

    return { backendKey: match, sessionId };
  }, [activeBackendKey, attachedBackendKey, multi, multiMachineState.backendOrder, selectedBackendKey]);


  // ─── Selected workspace detail ───────────────────────────────────────────────
  const selectedRef = workspaceController.selectedRef;
  const backendAttachedWorkspaceId = attachedBackendState?.attachedWorkspaceId ?? null;
  const attachedWorkspaceSelectionKey = attachedBackendKey && backendAttachedWorkspaceId
    ? toBackendScopedWorkspaceKey({ backendKey: attachedBackendKey, workspaceId: backendAttachedWorkspaceId })
    : null;
  const selectedWorkspaceForDetail = useMemo(
    () => selectedRef
      ? filteredWorkspaces.find((w) => w.id === selectedRef.workspaceId) ?? null
      : null,
    [filteredWorkspaces, selectedRef],
  );

  useEffect(() => {
    if (!selectedWorkspaceForDetail || flow.isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingField = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target?.isContentEditable === true;
      if (isTypingField || event.defaultPrevented || !event.shiftKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

      const change = getShiftArrowPhaseChange({
        groups: workspaceBoardState.groups,
        selectedWorkspaceId: selectedWorkspaceForDetail.selectionKey,
        direction: event.key === 'ArrowLeft' ? -1 : 1,
      });
      if (!change) return;

      event.preventDefault();
      workspaceBoardState.setPhase(change.workspaceKey, change.phase);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [flow.isOpen, selectedWorkspaceForDetail, workspaceBoardState]);

  useEffect(() => {
    if (!attachedWorkspaceSelectionKey) return;
    if (terminalMode !== 'attached') return;
    if (workspaceBoardState.selectedWorkspaceId === attachedWorkspaceSelectionKey) return;
    handleBoardSelectWorkspace(attachedWorkspaceSelectionKey);
  }, [attachedWorkspaceSelectionKey, handleBoardSelectWorkspace, terminalMode, workspaceBoardState.selectedWorkspaceId]);

  const detailSessions = useMemo(
    () => selectedRef ? backendSessions.filter((session) => session.workspaceId === selectedRef.workspaceId) : [],
    [backendSessions, selectedRef],
  );

  const detailReplays = useMemo(
    () => selectedRef
      ? filteredReplays.filter((replay) => replay.workspaceId === selectedRef.workspaceId)
      : [],
    [filteredReplays, selectedRef],
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

  // ─── Agent session data ────────────────────────────────────────────────────
  const agentSessionsByWorkspace = workspaceRuntime.agentSessionsByWorkspace;
  const allWorkspaceEntries = workspaceRuntime.workspaces;
  const workspaceStatusById = workspaceRuntime.stripStatusById;


  // ─── Notifications & preferences ──────────────────────────────────────────

  const { activeNotificationConfig } = usePreferencesAdapter({
    service: browserPreferencesService,
    backendNotificationConfig: notificationConfig,
    defaultConfig: DEFAULT_NOTIFICATION_CONFIG,
  });


  // ─── Agent session actions that need flow ─────────────────────────────────
  const agentSessionClientContext = useMemo(() => ({
    multi,
    workspaceRefs: allWorkspaceEntries.map((workspace) => ({
      backendKey: workspace.backendKey as BackendKey,
      workspaceId: workspace.id,
    })),
    agentSessionsByWorkspaceKey: agentSessionsByWorkspace,
    selectedWorkspaceRef: selectedRef
      ? { backendKey: selectedRef.backendKey, workspaceId: selectedRef.workspaceId }
      : null,
    detailWorkspaceRef: selectedWorkspaceForDetail
      ? { backendKey: selectedWorkspaceForDetail.backendKey as BackendKey, workspaceId: selectedWorkspaceForDetail.id }
      : null,
    preferredBackendKey: selectedBackendKey ?? activeBackendKey ?? null,
  }), [activeBackendKey, agentSessionsByWorkspace, allWorkspaceEntries, multi, selectedBackendKey, selectedRef, selectedWorkspaceForDetail]);
  const {
    open: openAgentSessionAction,
    createAndOpen: createAgentSessionAction,
    kill: killAgentSessionAction,
    stopAgentTurn: stopAgentTurnAction,
    close: closeAgentSessionAction,
    archive: archiveAgentSessionAction,
    restore: restoreAgentSessionAction,
  } = useAgentSessionActions({
    client: agentSessionClientContext,
    flow,
    beforeOpen: () => setIsViewOnlySession(false),
    onError: (message) => {
      toast.error(message);
    },
  });
  const [agentAttachPending, setAgentAttachPending] = useState(false);
  const [pendingAgentAttachTarget, setPendingAgentAttachTarget] = useState<{ workspaceId: string; agentSessionId: string } | null>(null);
  // Refs that prevent two failure modes:
  //   1. Stale commandError from a prior operation immediately clearing a fresh pending attach.
  //   2. Stuck pending when open() returns null before any backend attach begins.
  const attachPendingCommandErrorSnapshotRef = useRef<typeof commandError>(null);
  const pendingAgentAttachTargetRef = useRef<{ workspaceId: string; agentSessionId: string } | null>(null);
  // Clear pending only when the requested target actually attaches, or a *fresh* error arrives.
  useEffect(() => {
    const attachedAgentSessionId = attachedBackendState?.attachedAgentSessionId ?? null;
    const attachedWorkspaceId = attachedBackendState?.attachedWorkspaceId ?? null;
    const targetReached = !!pendingAgentAttachTarget
      && terminalMode === 'attached'
      && attachedAgentSessionId === pendingAgentAttachTarget.agentSessionId
      && attachedWorkspaceId === pendingAgentAttachTarget.workspaceId;
    // Ignore commandError that already existed when this attach was requested.
    const isFreshError = commandError != null && commandError !== attachPendingCommandErrorSnapshotRef.current;
    if (agentAttachPending && (targetReached || isFreshError)) {
      setAgentAttachPending(false);
      setPendingAgentAttachTarget(null);
      pendingAgentAttachTargetRef.current = null;
    }
  }, [agentAttachPending, pendingAgentAttachTarget, terminalMode, attachedBackendState, commandError]);
  /** Estimate terminal cols/rows from viewport for initial agent session size. */
  const getWebAgentAttachSize = useCallback(() => {
    // Approximate: 8px per char, 18px per row (monospace at 14px font).
    // Subtract ~260px for sidebar (hidden on mobile, but the resize will fix it).
    const sidebarWidth = window.innerWidth >= 640 ? 260 : 0;
    const availableWidth = Math.max(window.innerWidth - sidebarWidth - 32, 200);
    const availableHeight = Math.max(window.innerHeight - 120, 200);
    const cols = Math.max(Math.floor(availableWidth / 8), 40);
    const rows = Math.max(Math.floor(availableHeight / 18), 10);
    return { cols, rows };
  }, []);

  const handleOpenAgentSession = useCallback((workspaceId: string, agentSessionId: string) => {
    const target = { workspaceId, agentSessionId };
    // Snapshot current commandError so a stale error from a prior operation cannot
    // immediately clear this pending attach before the backend has a chance to respond.
    attachPendingCommandErrorSnapshotRef.current = commandErrorRef.current;
    pendingAgentAttachTargetRef.current = target;
    flushSync(() => {
      setAgentAttachPending(true);
      setPendingAgentAttachTarget(target);
    });
    openAgentSessionAction(workspaceId, agentSessionId, { attachOptions: getWebAgentAttachSize() })
      .then((result) => {
        // open() returning null means the call failed before any backend attach was initiated.
        // Clear pending only if no rapid session switch has since overtaken this request.
        if (result === null) {
          const cur = pendingAgentAttachTargetRef.current;
          if (cur?.workspaceId === workspaceId && cur?.agentSessionId === agentSessionId) {
            pendingAgentAttachTargetRef.current = null;
            setAgentAttachPending(false);
            setPendingAgentAttachTarget(null);
          }
        }
      })
      .catch(() => {
        const cur = pendingAgentAttachTargetRef.current;
        if (cur?.workspaceId === workspaceId && cur?.agentSessionId === agentSessionId) {
          pendingAgentAttachTargetRef.current = null;
          setAgentAttachPending(false);
          setPendingAgentAttachTarget(null);
        }
      });
  }, [openAgentSessionAction, getWebAgentAttachSize]);

  const handleKillAgentSession = useCallback(async (workspaceId: string, agentSessionId: string) => {
    await killAgentSessionAction(workspaceId, agentSessionId);
  }, [killAgentSessionAction]);

  const handleStopAgentTurn = useCallback(async (workspaceId: string, agentSessionId: string) => {
    await stopAgentTurnAction(workspaceId, agentSessionId);
  }, [stopAgentTurnAction]);

  const handleCloseAgentSession = useCallback(async (workspaceId: string, agentSessionId: string) => {
    await closeAgentSessionAction(workspaceId, agentSessionId);
  }, [closeAgentSessionAction]);

  const handleCreateAgentSession = useCallback((workspaceId: string) => {
    createAgentSessionAction(workspaceId, {
      attachOptions: getWebAgentAttachSize(),
      beforeOpen: () => {
        setIsViewOnlySession(false);
        attachPendingCommandErrorSnapshotRef.current = commandErrorRef.current;
        pendingAgentAttachTargetRef.current = null;
        flushSync(() => {
          setAgentAttachPending(true);
          setPendingAgentAttachTarget(null);
        });
      },
      onOpenSuccess: () => {
        pendingAgentAttachTargetRef.current = null;
        setAgentAttachPending(false);
        setPendingAgentAttachTarget(null);
      },
      onOpenError: () => {
        pendingAgentAttachTargetRef.current = null;
        setAgentAttachPending(false);
        setPendingAgentAttachTarget(null);
      },
    });
  }, [createAgentSessionAction, getWebAgentAttachSize]);

  const handleArchiveAgentSession = useCallback(async (workspaceId: string, agentSessionId: string) => {
    await archiveAgentSessionAction(workspaceId, agentSessionId);
  }, [archiveAgentSessionAction]);

  const handleRestoreAgentSession = useCallback(async (workspaceId: string, agentSessionId: string) => {
    await restoreAgentSessionAction(workspaceId, agentSessionId);
  }, [restoreAgentSessionAction]);

  // ─── Resolve project name from workspaceId ────────────────────────────────

  const resolveWorkspaceProjectName = useCallback((workspaceId: string) => {
    const idx = workspaceId.indexOf(':');
    if (idx > 0) return workspaceId.slice(0, idx);
    return null;
  }, []);

  // ─── Bundle flows ──────────────────────────────────────────────────────────
  const sessionClient = useMemo(() => ({
    multi,
    workspaceRefs: [],
  }), [multi]);
  const { attachSession: attachSessionAction, cancelPendingScripts } = useSessionActions({
    client: sessionClient,
    onError: (message) => {
      flow.showMessage({ title: 'Session Failed', message, variant: 'error' });
    },
  });

  const bundleRefreshAttach = useBundleRefreshAttachFlow({
    client: workspaceLifecycleClient,
    flow,
    commandError,
    attachSession: (params) => {
      const backendKey = (params as { backendKey?: BackendKey }).backendKey;
      const workspaceId = params.workspaceId ?? '';
      return attachSessionAction(
        backendKey ? { backendKey, workspaceId } : getWorkspaceRef(workspaceId),
        params,
      );
    },
  });

  const bundleConfigFlow = useBundleConfigFlow({
    client: workspaceLifecycleClient,
    flow,
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

  const attachController = useAttachActions({
    flow,
    attachSessionWithBundleRefresh: bundleRefreshAttach.attachSessionWithBundleRefresh,
    recoverableAttachParams: bundleRefreshAttach.recoverableParams,
    defaultProjectName: selectedWorkspaceProjectName,
    defaultBackendKey: selectedBackendKey ?? getTargetBackendKey(),
    resolveWorkspaceRef: (workspaceId) => getWorkspaceRef(workspaceId),
    getAttachSize: getWebAttachSize,
    resolveProjectName: resolveWorkspaceProjectName,
    onBeforeAttach: ({ target, params, workspaceRef }) => {
      if (target === 'session') {
        lastScriptWorkspaceIdRef.current = null;
        lastScriptWorkspaceRef.current = null;
        setShowScriptTerminal(false);
        return;
      }
      if (params.workspaceId && !params.command) {
        lastScriptWorkspaceIdRef.current = params.workspaceId;
        lastScriptWorkspaceRef.current = workspaceRef ?? null;
        setShowInbox(false);
        setScriptWorkspaceName(params.workspaceId.split(':').slice(-1)[0] ?? params.workspaceId);
        setShowScriptTerminal(true);
      } else {
        lastScriptWorkspaceIdRef.current = null;
        lastScriptWorkspaceRef.current = null;
      }
    },
    onAttachCancelled: ({ target }) => {
      if (target === 'workspace' && showScriptTerminal) return;
      if (target === 'workspace') {
        setShowScriptTerminal(false);
        lastScriptWorkspaceIdRef.current = null;
        lastScriptWorkspaceRef.current = null;
      }
    },
    onAttachError: ({ target, message }) => {
      const isWorkspaceScriptFailure = message.startsWith('Workspace scripts failed during');
      const hasScriptRuntimeState = Boolean(scriptState);
      if (target === 'workspace' && (!isWorkspaceScriptFailure || !hasScriptRuntimeState)) {
        setShowScriptTerminal(false);
        lastScriptWorkspaceIdRef.current = null;
        lastScriptWorkspaceRef.current = null;
      }
      flow.showMessage({
        title: isWorkspaceScriptFailure ? 'Workspace Script Failed' : 'Session Failed',
        message,
        variant: 'error',
      });
    },
  });

  const { deleteWorkspaceWithPrompt } = useWorkspaceLifecycleActions({
    client: workspaceLifecycleClient,
    flow,
    onBeforeDelete: ({ target }) => {
      suppressDeleteScriptFailureModalRef.current = true;
      setShowInbox(false);
      setScriptWorkspaceName(target.workspaceName);
      setShowScriptTerminal(true);
    },
    onDeleteSuccess: async ({ target }) => {
      suppressDeleteScriptFailureModalRef.current = false;
      setShowScriptTerminal(false);
      if (workspaceBoardState.selectedWorkspaceId === toBackendScopedWorkspaceKey(target.ref)) {
        workspaceBoardState.setSelectedWorkspaceId(null);
      }
      workspaceController.clearSelectedRef();
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

  const lifecycleController = useLifecycleActions({
    client: sessionClient,
    backendKey: getTargetBackendKey(),
    flow,
    getProjectNames: () => allProjects.map((p) => p.name),
    refreshProjects: () => undefined,
    refreshWorkspaces: () => undefined,
    refreshSessions: () => undefined,
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
          backendKey: null,
          workspaceLabel: ws,
        });
        setView('review');
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!reviewWorkspace || reviewWorkspace.backendKey !== null) return;
    const workspace = workspaceRuntime.workspaces.find(
      (item) => item.projectName === reviewWorkspace.projectName && item.id === reviewWorkspace.workspaceId,
    );
    if (!workspace) return;
    setReviewWorkspace((current) => {
      if (!current || current.backendKey !== null) return current;
      if (current.projectName !== workspace.projectName || current.workspaceId !== workspace.id) return current;
      return {
        ...current,
        backendKey: workspace.backendKey as BackendKey,
        workspaceLabel: current.workspaceLabel ?? workspace.name,
      };
    });
  }, [reviewWorkspace, workspaceRuntime.workspaces]);

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
      if (!showScriptTerminal && !scriptState) {
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
    await attachController.attachFromSelection({
      ...params,
      backendKey: params.sessionId ? (selectedBackendKey ?? attachedBackendKey ?? activeBackendKey ?? undefined) : undefined,
    });
  }, [activeBackendKey, attachController, attachedBackendKey, selectedBackendKey]);

  // ─── Process actions ───────────────────────────────────────────────────────

  const processClientContext = useMemo(() => ({
    multi,
    workspaceRefs: allWorkspaceEntries.map((workspace) => ({
      backendKey: workspace.backendKey as BackendKey,
      workspaceId: workspace.id,
    })),
    selectedWorkspaceRef: selectedRef
      ? { backendKey: selectedRef.backendKey, workspaceId: selectedRef.workspaceId }
      : null,
    detailWorkspaceRef: selectedWorkspaceForDetail
      ? { backendKey: selectedWorkspaceForDetail.backendKey as BackendKey, workspaceId: selectedWorkspaceForDetail.id }
      : null,
    preferredBackendKey: selectedBackendKey ?? activeBackendKey ?? null,
  }), [activeBackendKey, allWorkspaceEntries, multi, selectedBackendKey, selectedRef, selectedWorkspaceForDetail]);

  const processActions = useProcessActions({
    client: processClientContext,
    flow,
    sessions: backendSessions,
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

  const replayReviewClient = useMemo(() => ({
    multi,
    workspaceRefs: [],
  }), [multi]);
  const handleReplayReviewError = useCallback((message: string) => {
    flow.showMessage({ title: 'Replay/Review Failed', message, variant: 'error' });
  }, [flow]);

  const {
    sendReviewRequest: sendReviewRequestAction,
    toggleReplayDismissed: toggleReplayDismissedAction,
    cancelReplayRequests,
    loadReplayFrame: loadReplayFrameAction,
    loadReplayTimeline: loadReplayTimelineAction,
  } = useReplayReviewActions({
    client: replayReviewClient,
    onError: handleReplayReviewError,
  });

  // Stable callback for ReviewPage — avoids infinite re-render loop from
  // unstable inline arrow creating new sendReviewRequest identity each render.
  const reviewSendRequest = useCallback(
    (operation: import('./types/review.js').ReviewOperation) => {
      if (!reviewWorkspace?.backendKey) return Promise.reject(new Error('No backend'));
      return sendReviewRequestAction(reviewWorkspace.backendKey, reviewWorkspace.workspaceId, operation);
    },
    [sendReviewRequestAction, reviewWorkspace?.backendKey, reviewWorkspace?.workspaceId],
  );

  const replayBackendKey = selectedBackendKey ?? getTargetBackendKey();

  const toggleReplayDismissed = useCallback(async (replay: ReplayInfo): Promise<boolean> => {
    try {
      if (!replay.dismissedAt && replay.status === 'running') {
        flow.showMessage({
          title: 'Replay Still Running',
          message: 'Running replays cannot be dismissed.',
          variant: 'info',
        });
        return false;
      }
      const dismissed = await toggleReplayDismissedAction(replayBackendKey, replay.replayId, Boolean(replay.dismissedAt));
      setActiveReplay((current) => {
        if (!current || current.replayId !== replay.replayId) return current;
        return dismissed
          ? { ...current, dismissedAt: Date.now() }
          : { ...current, dismissedAt: undefined, dismissedBy: undefined };
      });
      return dismissed;
    } catch {
      return false;
    } finally {
      refreshReplayList();
    }
  }, [flow, refreshReplayList, replayBackendKey, toggleReplayDismissedAction]);

  const loadReplayFrame = useCallback((replayId: string, target?: ReplayFrameTarget): Promise<ReplayFrame> => {
    return loadReplayFrameAction(replayBackendKey, replayId, target);
  }, [loadReplayFrameAction, replayBackendKey]);

  const loadReplayTimeline = useCallback((replayId: string): Promise<ReplayTimeline> => {
    return loadReplayTimelineAction(replayBackendKey, replayId);
  }, [loadReplayTimelineAction, replayBackendKey]);

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
        const sessionRef = getSessionRef(sessionId, selectedBackendKey ?? attachedBackendKey ?? activeBackendKey);
        if (!sessionRef) {
          toast.error(`Could not resolve session backend for ${sessionName}.`);
          return;
        }
        if (attachedBackendState?.attachedSessionId === sessionId && attachedBackendKey === sessionRef.backendKey) {
          void multi.detachSession({ backendKey: sessionRef.backendKey, workspaceId: '' });
        }
        void multi.killSession(sessionRef);
      },
    });
  }, [activeBackendKey, attachedBackendKey, attachedBackendState?.attachedSessionId, flow, getSessionRef, multi, selectedBackendKey]);

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
      backendKey: workspace.backendKey as BackendKey,
      workspaceLabel: workspace.name,
    });
    setView('review');
  }, [filteredWorkspaces]);

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
  const { commandPalette } = useCommandPaletteOrchestration({
    selectedBoardWorkspaceId: workspaceBoardState.selectedWorkspaceId,
    selectedDetailWorkspaceId: selectedRef?.workspaceId ?? selectedWorkspaceForDetail?.id ?? null,
    workspaces: filteredWorkspaces as any,
    selectedProjectName: selectedWorkspaceProjectName,
    showSelect: (config) => flow.showSelect<string>(config),
    showMessage: ({ message, variant }) => {
      if (variant === 'error') toast.error(message);
      else if (variant === 'warning') toast.warning(message);
      else if (variant === 'success') toast.success(message);
      else toast.info(message);
    },
    onOpenUrl: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    onAddRepo: () => lifecycleController.openCreateProjectFlow(),
    onAddWorkspace: () => lifecycleController.openCreateMenu(null),
    onSetWorkspacePhase: (workspace, phase) => {
      workspaceBoardState.setPhase(workspace.selectionKey ?? workspace.id, phase);
      flow.close();
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

  const inboxActions = useInboxActions({
    client: agentSessionClientContext,
    flow,
    onError: (message) => {
      toast.error(message);
    },
  });


  // ─── Inbox ─────────────────────────────────────────────────────────────────

  const { inboxProps, handleInboxCommand } = useInboxPage({
    items: backendInbox,
    unreadCount: backendInboxUnreadCount,
    onClearItem: async (id) => { await inboxActions.clearInbox(id); },
    onClearAll: async () => { await inboxActions.clearInbox(); },
    onMarkRead: async (id) => { await inboxActions.markInboxRead(id); },
    onAttachSession: async (sessionId) => {
      setShowInbox(false);
      const sessionRef = getSessionRef(sessionId);
      if (!sessionRef) {
        toast.error(`Could not resolve session backend for ${sessionId}.`);
        return;
      }
      await attachController.attachFromSelection({ sessionId, backendKey: sessionRef.backendKey });
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
      const ref = getWorkspaceRef(ws.id, ws.backendKey as BackendKey);
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
      const ref = getWorkspaceRef(ws.id, ws.backendKey as BackendKey);
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
        onClick: () => {
          const sessionRef = getSessionRef(notification.sessionId);
          if (!sessionRef) {
            toast.error(`Could not resolve session backend for ${notification.title ?? notification.sessionId}.`);
            return;
          }
          void attachController.attachFromSelection({ sessionId: notification.sessionId, backendKey: sessionRef.backendKey });
        },
      },
    });
  }, [attachController, getSessionRef]);

  const notifications = useNotifications({
    items: backendInbox,
    config: activeNotificationConfig,
    onShowToast: handleShowToast,
    onAttachSession: (sessionId) => {
      const sessionRef = getSessionRef(sessionId);
      if (!sessionRef) {
        toast.error(`Could not resolve session backend for ${sessionId}.`);
        return;
      }
      void attachController.attachFromSelection({ sessionId, backendKey: sessionRef.backendKey });
    },
    onMarkRead: async (itemId) => {
      await inboxActions.markInboxRead(itemId);
    },
    pollIntervalMs: 5000,
    onRefreshInbox: async () => {
      if (terminalStatus === "connected") {
        await inboxActions.requestInbox();
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
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const handled = await handleInboxCommand({ key: e.key, shift: e.shiftKey });
      if (!handled) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showInbox, handleInboxCommand]);

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
        if (attachedBackendKey) {
          void multi.detachSession({ backendKey: attachedBackendKey, workspaceId: '' });
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [view, terminalStatus, terminalMode, attachedBackendKey, multi]);

  // Script terminal keyboard
  useEffect(() => {
    if (view !== 'terminal' || terminalStatus !== 'connected' || terminalMode !== 'browsing' || !showScriptTerminal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.key === 'Escape' || e.key === 'q') && !scriptState?.isRunning) {
        e.preventDefault();
        setShowScriptTerminal(false);
        lastScriptWorkspaceIdRef.current = null;
        lastScriptWorkspaceRef.current = null;
      } else if ((e.key === 'c' || e.key === 'C') && scriptState?.isRunning) {
        e.preventDefault();
        const workspaceRef = lastScriptWorkspaceRef.current;
        if (!workspaceRef) return;
        void multi.cancelPendingScripts(workspaceRef);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [scriptState?.isRunning, showScriptTerminal, terminalMode, terminalStatus, view, multi]);

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
    if (reviewTerminalStatus === 'connected' && reviewWorkspace.backendKey) {
      return (
        <>
          <ReviewPage
            projectName={reviewWorkspace.projectName}
            workspaceName={reviewWorkspace.workspaceId}
            workspaceLabel={reviewWorkspace.workspaceLabel}
            sendReviewRequest={reviewSendRequest}
            onBack={() => { setView('terminal'); setReviewWorkspace(null); }}
          />
          <Toaster theme="dark" position="top-right" richColors />
        </>
      );
    }

    return (
      <>
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-[var(--gs-bg)] px-4">
          <div className="text-center">
            <div className="text-lg text-[var(--gs-text)] mb-2">
              Loading review for <span className="text-[var(--gs-info)]">{reviewWorkspace.workspaceLabel ?? reviewWorkspace.workspaceId}</span>
            </div>
            <div className="text-sm text-[var(--gs-text-muted)]">
              {reviewTerminalStatus !== 'connected' ? 'Connecting...' : 'Resolving workspace backend...'}
            </div>
            <button
              onClick={() => { setView('terminal'); setReviewWorkspace(null); }}
              className="mt-4 px-6 py-3 text-base bg-[var(--gs-btn-secondary-bg)] hover:bg-[var(--gs-border)] rounded-lg text-[var(--gs-text)] min-h-[48px] border border-[var(--gs-border)]"
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
          <div className="h-screen w-screen flex flex-col items-center justify-center bg-[var(--gs-bg)] px-4">
            <div className="text-center">
              <div className="text-lg text-[var(--gs-text)] mb-2">
                Loading replay for <span className="text-[var(--gs-info)]">{activeReplay.sessionName}</span>
              </div>
              <div className="text-sm text-[var(--gs-text-muted)]">Connecting...</div>
              <button
                onClick={() => { setView('terminal'); setActiveReplay(null); }}
                className="mt-4 px-6 py-3 text-base bg-[var(--gs-btn-secondary-bg)] hover:bg-[var(--gs-border)] rounded-lg text-[var(--gs-text)] min-h-[48px] border border-[var(--gs-border)]"
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
          onCleanup={() => cancelReplayRequests(replayBackendKey)}
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
          key={lastScriptWorkspaceIdRef.current ?? 'none'}
          phase={scriptState?.phase ?? 'pre'}
          workspaceName={scriptWorkspaceName}
          isRunning={isRunning}
          error={scriptState?.error}
          exitCode={scriptState?.exitCode}
          setWriteCallback={setScriptWriteCallback}
          canAttachAnyway={attachController.canAttachAnyway}
          onAttachAnyway={async () => {
            await attachController.attachAnyway();
          }}
          onBack={() => {
            lastScriptWorkspaceIdRef.current = null;
            lastScriptWorkspaceRef.current = null;
            setShowScriptTerminal(false);
          }}
          onCancel={() => {
            const workspaceRef = lastScriptWorkspaceRef.current;
            if (!workspaceRef) return;
            void cancelPendingScripts(workspaceRef);
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
            className="gs-overlay-root"
            role="dialog"
            aria-label="Command palette"
            onClick={() => commandPalette.close()}
          >
            <div className="absolute inset-0 gs-overlay-backdrop" />
            <div
              className="gs-shell-card gs-shell-card--compact gs-shell-card--headerless"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="gs-shell-body gs-shell-body--flush">
                <div className="border-b border-[var(--gs-border)] px-4 py-3">
                  <div className="gs-shell-kicker">Command palette</div>
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
                    className="gs-field mt-2 min-h-[44px]"
                    autoFocus
                  />
                </div>
                <ul className="max-h-[50vh] overflow-y-auto">
                  {commandPalette.filteredCommands.map((cmd, i) => (
                    <li
                      key={cmd.id}
                      className={`gs-command-item cursor-pointer ${i === commandPalette.selectedIndex ? 'gs-command-item--active' : ''}` }
                      onClick={() => { commandPalette.setSelectedIndex(i); commandPalette.selectCurrent(); }}
                    >
                      <span>{cmd.label}</span>
                      {cmd.shortcut ? <span className="text-[var(--gs-text-dim)]">{cmd.shortcut}</span> : null}
                    </li>
                  ))}
                </ul>
                <div className="border-t border-[var(--gs-border)] px-4 py-2 text-[11px] uppercase tracking-[0.16em] text-[var(--gs-text-dim)]">
                  ↑↓ select · enter run · esc close
                </div>
              </div>
            </div>
          </div>
        )}
      </>
    );

    const inlineAttachedRef: BackendScopedWorkspaceRef = {
      backendKey: attachedBackendKey ?? selectedBackendKey ?? activeBackendKey ?? 'local',
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
    const attachedAgentSessionId = attachedBackendState?.attachedAgentSessionId ?? null;
    const switchingAgentSession = !!pendingAgentAttachTarget
      && agentAttachPending
      && (attachedAgentSessionId !== pendingAgentAttachTarget.agentSessionId
        || backendAttachedWorkspaceId !== pendingAgentAttachTarget.workspaceId);
    const inlineTerminalOutlet = switchingAgentSession ? (
      <div className="flex-1 flex items-center justify-center bg-[var(--gs-bg)]">
        <div className="text-sm text-[var(--gs-text-muted)]" style={{ animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' }}>Attaching agent session…</div>
      </div>
    ) : (terminalMode === 'attached' && attachedMatchesSelected) ? (
      <div className="flex-1 min-h-0 flex flex-col">
        <AttachedTerminalPaneWeb
          key={attachedTerminalInstanceKey}
          rootClassName="flex-1 min-h-0 flex flex-col bg-[var(--gs-bg)] overflow-hidden"
          headerClassName="flex-shrink-0 px-3 py-2 border-b border-[var(--gs-border-muted)] bg-[var(--gs-bg-elevated)] flex items-center justify-between gap-2"
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
              ? 'bg-[var(--gs-accent)] text-[var(--gs-text-on-accent)] font-medium'
              : 'bg-[var(--gs-btn-secondary-bg)] text-[var(--gs-text)] hover:bg-[var(--gs-border)]'
          }`}
          onDetach={() => multi.detachSession(inlineAttachedRef)}
          detachButtonClassName="px-2 py-1 text-xs rounded border border-[var(--gs-border)] text-[var(--gs-text)] hover:bg-[var(--gs-border)]"
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
        <NativeAgentSurfaceConnected backendKey={attachedBackendKey ?? activeBackendKey ?? undefined} />
      </div>
    ) : agentAttachPending ? (
      <div className="flex-1 flex items-center justify-center bg-[var(--gs-bg)]">
        <div className="text-sm text-[var(--gs-text-muted)]" style={{ animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' }}>Attaching agent session…</div>
      </div>
    ) : null;
    const handleSelectWorkspaceFromDetail = async (workspaceSelectionKey: string) => {
      if (workspaceSelectionKey === selectedWorkspaceForDetail?.selectionKey) return;
      if (terminalMode === 'attached' && attachedBackendKey) {
        try {
          await multi.detachSession({ backendKey: attachedBackendKey, workspaceId: '' });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Failed to detach session');
          return;
        }
      }
      handleBoardSelectWorkspace(workspaceSelectionKey);
    };

    const handleBackToBoard = async () => {
      if (terminalMode === 'attached' && attachedBackendKey) {
        try {
          await multi.detachSession({ backendKey: attachedBackendKey, workspaceId: '' });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Failed to detach session');
          return;
        }
      }

      handleBoardSelectWorkspace(null);
    };

    // ── Workspace detail page (full-screen, replaces board) ────────────────
    if (selectedWorkspaceForDetail) {
      return (
        <>
          <WorkspaceDetailPage
            workspace={selectedWorkspaceForDetail}
            sessions={detailSessions}
            replays={detailReplays}
            agentSessions={selectedWorkspaceForDetail ? (workspaceRuntime.runtimeByWorkspace[selectedWorkspaceForDetail.selectionKey]?.agentSessions ?? []) : []}
            agentSessionCount={selectedWorkspaceForDetail ? (workspaceRuntime.runtimeByWorkspace[selectedWorkspaceForDetail.selectionKey]?.agentSessionCount ?? 0) : 0}
            pendingPermissions={selectedWorkspaceForDetail ? (workspaceRuntime.runtimeByWorkspace[selectedWorkspaceForDetail.selectionKey]?.pendingPermissionCount ?? 0) : 0}
            attachedSessionId={backendAttachedSessionId}
            attachedAgentSessionId={attachedBackendState?.attachedAgentSessionId ?? null}
            pendingAgentAttach={agentAttachPending}
            allWorkspaces={allWorkspaceEntries}
            workspaceStatusById={workspaceStatusById}
            runtime={selectedWorkspaceForDetail ? (workspaceRuntime.runtimeByWorkspace[selectedWorkspaceForDetail.selectionKey] ?? null) : null}
            onSelectWorkspace={handleSelectWorkspaceFromDetail}
            onOpenAgentSession={handleOpenAgentSession}
            onCreateAgentSession={handleCreateAgentSession}
            onKillAgentSession={handleKillAgentSession}
            onStopAgentTurn={handleStopAgentTurn}
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
            onRequestStatusChange={() => {
              showWorkspaceStatusSelect({
                showSelect: (config) => flow.showSelect<WorkspacePhase>(config),
                onSelectPhase: (phase) => {
                  workspaceBoardState.setPhase(selectedWorkspaceForDetail.selectionKey, phase);
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
                void multi.requestEvents(getWorkspaceRef(workspaceId, w.backendKey as BackendKey));
              }
            }}
            onDeleteSession={handleDeleteSession}
            onClose={() => {
              void handleBackToBoard();
            }}
          >
            {inlineTerminalOutlet ? (
              <DockviewWorkspaceShell
                backendKey={selectedWorkspaceForDetail.backendKey}
                workspaceId={selectedWorkspaceForDetail.id}
                showTerminal={true}
                renderTerminal={() => inlineTerminalOutlet}
              />
            ) : null}
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
          onOpenInbox={() => { void inboxActions.requestInbox(); setShowInbox(true); }}
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

    const attachedRef: BackendScopedWorkspaceRef = {
      backendKey: attachedBackendKey ?? selectedBackendKey ?? activeBackendKey ?? 'local',
      workspaceId: ''
    };

    return (
      <>
        <AttachedTerminalPaneWeb
          key={attachedTerminalInstanceKey}
          rootClassName="w-screen h-screen flex flex-col bg-[var(--gs-bg)] overflow-hidden"
          headerClassName="bg-[var(--gs-bg-elevated)] px-4 py-2 flex items-center justify-between border-b border-[var(--gs-border)] min-h-[52px] gap-2 flex-shrink-0"
          leadingContent={(
            <button
              onClick={() => void multi.detachSession(attachedRef)}
              className="text-sm text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] active:text-[var(--gs-accent)] py-2 pr-2 -ml-2 min-h-[44px] flex items-center flex-shrink-0"
            >
              ← <span className="hidden sm:inline ml-1">Workspaces</span>
            </button>
          )}
          trailingContent={<span className="text-xs text-[var(--gs-text-dim)] hidden sm:inline">Shift+Esc</span>}
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
              ? 'bg-[var(--gs-accent)] text-[var(--gs-text-on-accent)] shadow-glow font-medium'
              : 'bg-[var(--gs-btn-secondary-bg)] text-[var(--gs-text)] hover:bg-[var(--gs-border)]'
          }`}
          onDetach={() => multi.detachSession(attachedRef)}
          detachButtonClassName="px-3 py-2 text-sm bg-[var(--gs-btn-secondary-bg)] hover:bg-[var(--gs-border)] active:bg-[var(--gs-bg-elevated)] rounded text-[var(--gs-text)] min-h-[44px] border border-[var(--gs-border)]"
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
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-[var(--gs-bg)] px-4">
        <div className="text-center">
          <h1 className="text-xl font-bold text-[var(--gs-text)] mb-4">GitSpace</h1>
          <div className="text-sm text-[var(--gs-text-muted)] mb-4">{statusMessage}</div>
          {!isError && (
            <div className="flex gap-1 justify-center">
              {[0, 1, 2].map((i) => (
                <div key={i} className="w-1.5 h-1.5 rounded-full bg-[var(--gs-success)] animate-pulse" style={{ animationDelay: `${i * 0.2}s` }} />
              ))}
            </div>
          )}
          {isError && (
            <button
              onClick={() => window.location.reload()}
              className="mt-4 px-6 py-3 text-base bg-[var(--gs-btn-secondary-bg)] hover:bg-[var(--gs-border)] active:bg-[var(--gs-bg-elevated)] rounded-lg text-[var(--gs-text)] min-h-[48px] border border-[var(--gs-border)]"   
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

// ─── Outer shell ────────────────────────────────────────────────────────────

export default function App() {
  const [resolvedIdentity, setResolvedIdentity] = useState<Identity | null>(null);
  const relayDescriptor = useMemo<RelayDescriptor | null>(() => {
    if (!resolvedIdentity) return null;
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return { url: `${wsProtocol}//${location.host}/ws`, source: 'local' };
  }, [resolvedIdentity]);

  return (
    <GitSpaceProvider platform={browserPlatform()} relay={relayDescriptor} identity={resolvedIdentity}>
      <AppInner resolvedIdentity={resolvedIdentity} setResolvedIdentity={setResolvedIdentity} />
    </GitSpaceProvider>
  );
}
