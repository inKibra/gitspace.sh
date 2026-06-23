/** @jsxImportSource @opentui/react */
/**
 * TUI Application v2 - Using Shared Components
 *
 * Clean implementation using shared hooks and components:
 * - useFlow for modal system
 * - useMachineList for machine selection
 * - useSpacesBrowser for workspace browsing
 */

import { createCliRenderer, decodePasteBytes } from '@opentui/core';
import type { PasteEvent } from '@opentui/core';
import { createRoot, useKeyboard, useRenderer } from '@opentui/react';
import { useState, useEffect, useCallback, useReducer, Fragment, useRef, useMemo } from 'react';
import { Toaster } from '@opentui-ui/toast/react';

// Terminal components
import { SessionTerminal } from './components/SessionTerminal.tui.js';

import { ScriptTerminal } from './components/ScriptTerminal.tui.js';
import { WorkspaceRemovalTaskBar } from './components/WorkspaceRemovalTaskBar.tui.js';
import { ReplayTerminal } from './components/ReplayTerminal.tui.js';
import {
  getReplayFrameOffline,
  getReplayTimelineOffline,
  dismissReplayOffline,
  undismissReplayOffline,
} from './lib/tmux-lite/replay/service.js';

// Shared components and hooks
import {
  useFlow,
  useSpacesBrowser,
  getDefaultShortcuts,
  isFlowInput,
  isFlowConfirmTyped,
  isFlowWizard,
  type ProjectInfo,
  type ReplayInfo,
} from './components/index.js';
import { FlowTUI } from './components/Flow.tui.js';
import { KanbanBoardTUI } from './components/KanbanBoard.tui.js';
import { WorkspaceDetailScreen, WORKSPACE_DETAIL_TERMINAL_RESERVED_COLS, WORKSPACE_DETAIL_TERMINAL_RESERVED_ROWS } from './components/WorkspaceDetailScreen.tui.js';
import type { TreeItem } from './components/SpacesBrowser.js';
import { InboxTUI } from './components/Inbox.tui.js';
import { useInboxPage } from './app/react/index.js';
import { EventsTui } from './components/Events.tui.js';
import { useEvents, toWideEventItem, type WideEventItem } from './components/Events.js';
import type { SavedEventFilter, WideEventFilter } from './types/events.js';
import { toast } from '@opentui-ui/toast';
import {
  useNotifications,
  type ToastNotification,
  DEFAULT_NOTIFICATION_CONFIG,
  getSessionLabel,
} from './notifications/index.js';

// Local state and config
import { localPreferencesService } from './core/preferences-service.js';
import type { NotificationConfig, NotificationTypeConfig, WorkspacePhase } from './types/config.js';

import { extractRepoName } from './utils/sanitize.js';
import { logger } from './utils/logger.js';
import { openBrowserUrl } from './utils/open-browser.js';
import { buildReviewUrl } from './utils/review-url.js';

export type { RelayDescriptor as RelayConfig } from './relay-client/index.js';
import type { RelayDescriptor } from './relay-client/index.js';
import { GitSpaceProvider, useGitSpace, LOCAL_BACKEND_KEY, type SessionBackend } from './sdk/index.js';

/** Local backend with PTY output handler for TUI terminal rendering. */
type LocalSessionPtyBackend = SessionBackend & {
  setPtyOutputHandler(handler: ((data: Uint8Array) => void) | null): void;
  setScriptOutputHandler(handler: ((data: Uint8Array) => void) | null): void;
};
import { toBackendScopedWorkspaceKey } from './machine/multi/types.js';
import { bunPlatform } from './sdk/platforms/bun.js';
import {
  consumeLegacyCleanupReminderForTui,
  initializeSecretRuntime,
} from './core/secret-runtime.js';
import {
  resolveInboxCommand,
  resolveSessionBrowserCommand,
} from './app/input/sessionCommands.js';
import { resolveLocalTerminalSyncAction, type AppView } from './tui/local-terminal-sync.js';
import {
  getKeyboardInputChunk,
  getNumericInputChunk,
  normalizeInputText,
} from './tui/input-text.js';
import {
  applySearchableSelectPaste,
  handleSearchableSelectKey,
} from './tui/flow-select-input.js';
import { showReplayHistorySelect } from './app/shared/workspace-detail/showReplayHistorySelect.js';
import type { WorkspaceDetailReplayRow } from './app/shared/workspace-detail/types.js';
import {
  VT_KITTY_KEYBOARD_CONFIG,
  forceDisableKittyKeyboard,
} from './tui/kitty-keyboard.js';
import { selectAllWorkspaces, selectBackendSnapshot } from './machine/multi/selectors.js';
import type { AgentSessionInfo as BrowserAgentSessionInfo } from './machine/api/list-types.js';
import { useCommandPaletteOrchestration } from './app/react/index.js';
import { useBoardPageModel } from './app/shared/board/useBoardPageModel.js';
import { getShiftArrowPhaseChange } from './app/shared/board/phase-movement.js';
import { showWorkspaceEditorSelect } from './app/shared/command-palette/showWorkspaceEditorSelect.js';
import { useWorkspaceRuntimeModel } from './app/shared/workspace-runtime/useWorkspaceRuntimeModel.js';
import {
  useAgentSessionActions, useWorkspaceLifecycleActions, useProcessActions, useInboxActions,
  useBundleRefreshAttachFlow, useBundleConfigFlow, useReplayReviewActions, useSessionActions,
  useLifecycleActions, useTuiAttachActions, usePreferencesAdapter,
  useUserActivity, buildEditProcessesCommand,
  useWorkspaceController,
} from './app/react/index.js';
import { useWorkspaceRemovalTasks } from './app/react/useWorkspaceRemovalTasks.js';
import {
  agentNotificationToInboxItem, getAgentSessionDisplayTitle,
  readProjectConfig, getProjectBaseDir, projectExists,
  useDaemonStatus, formatRelayStatus,
  loadProcessesConfigWithDiagnostics, buildWorkspaceSessionCommand,
} from './app/react/shell-adapters.tui.js';

// Types
import type { InboxItem } from './lib/tmux-lite/cli.js';
import type { Identity } from './types/identity.js';

// ============================================================================
// Workspace Flow Types (Custom State Machine)
// ============================================================================


// ============================================================================
// Constants
// ============================================================================

/** Settings flow states - explicit state machine for settings modal */
type SettingsFlowState =
  | { type: 'closed' }
  | { type: 'main-menu'; selectedIndex: number; config: NotificationConfig }
  | { type: 'types-menu'; selectedIndex: number; config: NotificationConfig }
  | { type: 'edit-duration'; value: string; config: NotificationConfig }
  | { type: 'edit-hold-duration'; value: string; config: NotificationConfig };

const COLORS = {
  border: '#555555',
  borderFocused: '#00AAFF',
  text: '#FFFFFF',
  textDim: '#888888',
  selected: '#00AAFF',
  title: '#00FF88',
  statusBar: '#333333',
  loading: '#FFAA00',
  error: '#FF4444',
  // ASCII art gradient
  gradient1: '#00FFFF',
  gradient2: '#00DDFF',
  gradient3: '#00BBFF',
  gradient4: '#0099FF',
  gradient5: '#0077FF',
  gradient6: '#0055FF',
  asciiBox: '#444466',
  subtitle: '#888899',
};

// ============================================================================
// App State
// ============================================================================

interface AppState {
  view: AppView;
  isLoading: boolean;
  error: string | null;
}

type AppAction =
  | { type: 'SET_VIEW'; view: AppView }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string | null };

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_VIEW':
      return { ...state, view: action.view };
    case 'SET_LOADING':
      return { ...state, isLoading: action.loading };
    case 'SET_ERROR':
      return { ...state, error: action.error };
    default:
      return state;
  }
}

// ============================================================================
// Props
// ============================================================================

export interface AppProps {
  relayConfig?: RelayDescriptor;
  remoteIdentity?: Identity | null;
  onQuit?: () => void;
  keyboardMode: 'kitty' | 'vt';
}

interface AppInnerProps {
  onQuit?: () => void;
  keyboardMode: 'kitty' | 'vt';
}

// ============================================================================
// Main App Component
// ============================================================================

function App({ relayConfig, remoteIdentity, onQuit, keyboardMode }: AppProps) {
  return (
    <GitSpaceProvider platform={bunPlatform()} relay={relayConfig ?? null} identity={remoteIdentity ?? null}>
      <AppInner onQuit={onQuit} keyboardMode={keyboardMode} />
    </GitSpaceProvider>
  );
}

function AppInner({ onQuit, keyboardMode }: AppInnerProps) {
  const keyboardModeHint = `kbd: ${keyboardMode}`;

  // Force re-render counter for resize
  const [, forceUpdate] = useState(0);

  // Handle terminal resize
  useEffect(() => {
    const handleResize = () => {
      // Force React to re-render by updating state
      forceUpdate(n => n + 1);
    };

    process.on('SIGWINCH', handleResize);
    return () => {
      process.removeListener('SIGWINCH', handleResize);
    };
  }, []);

  // App state
  const [state, dispatch] = useReducer(appReducer, {
    view: 'projects',
    isLoading: true,
    error: null,
  });

  // Track when we're switching sessions (to prevent detach handler from navigating away)
  const sessionSwitchingRef = useRef(false);
  const lastScriptWorkspaceIdRef = useRef<string | null>(null);
  const renderer = useRenderer();

  // Shared Flow hook (for non-workspace flows)
  const flow = useFlow({
    onError: (error) => dispatch({ type: 'SET_ERROR', error: error.message }),
  });


  const [scriptWorkspaceName, setScriptWorkspaceName] = useState<string>('workspace');

  // Project creation flow (custom state machine)

  // Settings flow (custom state machine)
  const [settingsFlow, setSettingsFlow] = useState<SettingsFlowState>({ type: 'closed' });

  // Events view state
  const [eventsWorkspaceId, setEventsWorkspaceId] = useState<string | null>(null);
  const [eventsReturnView, setEventsReturnView] = useState<AppView>('projects');
  const [activeReplay, setActiveReplay] = useState<ReplayInfo | null>(null);
  const [showDismissedReplays, setShowDismissedReplays] = useState(false);
  const activeReplayDismissedRef = useRef(false);
  const activeDeleteTaskIdRef = useRef<string | null>(null);
  const [attachedAgentSession, setAttachedAgentSession] = useState<{
    workspaceId: string;
    sessionId: string;
  } | null>(null);

  // View-only session state (true when attached to a running process session)
  const [isViewOnlySession, setIsViewOnlySession] = useState(false);
  const [pendingProcessEditWorkspaceId, setPendingProcessEditWorkspaceId] = useState<string | null>(null);
  const pendingProcessEditWorkspacesRef = useRef<unknown[] | null>(null);
  const [focusedLaneIndex, setFocusedLaneIndex] = useState(0);

  // Multi-backend hook — manages local backend + auto-discovers remote machines via relay
  const { engine: multi, state: multiMachineState } = useGitSpace();
  const workspaceRemovalTasks = useWorkspaceRemovalTasks();
  const workspaceLifecycleClient = useMemo(() => ({
    multi,
    workspaceRefs: [],
  }), [multi]);

  const { setStatus: setWorkspaceStatusAction } = useWorkspaceLifecycleActions({
    client: workspaceLifecycleClient,
    flow,
    onError: (message) => {
      dispatch({ type: 'SET_ERROR', error: message });
    },
  });

  // Per-backend state for the local machine (inbox, sessions, replays, attached session, etc.)
  const localState = multi.getBackendState(LOCAL_BACKEND_KEY);
  const localSessionStatus = localState?.status ?? 'disconnected';
  const localSessionMode = localState?.mode ?? 'browsing';
  const localSessions = localState?.sessions ?? [];
  const localReplays = localState?.replays ?? [];
  const localInbox = localState?.inbox ?? [];
  const localInboxUnreadCount = localState?.inboxUnreadCount ?? 0;
  const localAttachedSessionId = localState?.attachedSessionId ?? null;
  const localAttachedWorkspaceId = localState?.attachedWorkspaceId ?? null;
  const localAttachedSessionName = localState?.attachedSessionName ?? null;
  const localAttachedSessionMeta = localState?.attachedSessionMeta ?? null;
  const localScriptState = localState?.scriptState ?? null;
  const localCommandError = localState?.commandError ?? null;
  const localEvents = localState?.events ?? [];
  const localLiveEventIds = localState?.liveEventIds ?? [];
  const localSavedEventFilters = localState?.savedEventFilters ?? [];

  // Raw backend for PTY operations (send/resize/setWriteCallback)
  const localBackend = multi.getBackend(LOCAL_BACKEND_KEY) as LocalSessionPtyBackend | null;
  const localBackendRef = useRef<LocalSessionPtyBackend | null>(null);
  const writeCallbackRef = useRef<((data: Uint8Array) => void) | null>(null);
  const scriptWriteCallbackRef = useRef<((data: Uint8Array) => void) | null>(null);
  const buildLocalScriptOutputHandler = useCallback((fn: ((data: Uint8Array) => void) | null) => {
    if (!fn && !workspaceRemovalTasks.activeTask) return null;
    return (data: Uint8Array) => {
      workspaceRemovalTasks.appendOutput(undefined, data);
      fn?.(data);
    };
  }, [workspaceRemovalTasks.activeTask, workspaceRemovalTasks.appendOutput]);
  useEffect(() => { localBackendRef.current = localBackend; }, [localBackend]);

  const sendLocalPty = useCallback((data: Uint8Array) => {
    const b = localBackendRef.current;
    if (b?.writePtyData) void b.writePtyData(data).catch(() => undefined);
  }, []);
  const resizeLocalPty = useCallback((cols: number, rows: number) => {
    const b = localBackendRef.current;
    if (b?.resizePty) void b.resizePty(cols, rows).catch(() => undefined);
  }, []);
  const setLocalWriteCallback = useCallback((fn: ((data: Uint8Array) => void) | null) => {
    writeCallbackRef.current = fn;
    localBackendRef.current?.setPtyOutputHandler(fn);
  }, []);
  const setLocalScriptWriteCallback = useCallback((fn: ((data: Uint8Array) => void) | null) => {
    scriptWriteCallbackRef.current = fn;
    localBackendRef.current?.setScriptOutputHandler(buildLocalScriptOutputHandler(fn));
  }, [buildLocalScriptOutputHandler]);

  useEffect(() => {
    localBackendRef.current?.setScriptOutputHandler(buildLocalScriptOutputHandler(scriptWriteCallbackRef.current));
  }, [buildLocalScriptOutputHandler]);

  useEffect(() => {
    if (localScriptState?.phase === 'remove') {
      workspaceRemovalTasks.updatePhase(localScriptState.workspaceId, 'remove', localScriptState.isRunning ? 'Running cleanup scripts...' : 'Cleanup scripts finished');
      if (localScriptState.error) {
        const taskId = activeDeleteTaskIdRef.current;
        if (taskId) workspaceRemovalTasks.completeFailure(taskId, localScriptState.error, localScriptState.exitCode);
      }
    }
  }, [localScriptState, workspaceRemovalTasks.updatePhase, workspaceRemovalTasks.completeFailure]);

  // Derive projects from the machine snapshot for the local backend
  const localProjects = useMemo(() => {
    const snapshot = selectBackendSnapshot(multiMachineState, LOCAL_BACKEND_KEY);
    if (!snapshot) return localState?.projects ?? [];
    return snapshot.projectOrder.map((id) => snapshot.projectsById[id]).filter(Boolean);
  }, [multiMachineState, localState?.projects]);

  // Derive workspaces from the machine snapshot for the local backend
  const localWorkspaces = useMemo(() => {
    return selectAllWorkspaces(multiMachineState)
      .filter(({ backendKey }) => backendKey === LOCAL_BACKEND_KEY)
      .map(({ workspace }) => workspace);
  }, [multiMachineState]);

  const workspaceController = useWorkspaceController({
    state: multiMachineState,
  });

  /** Shared kanban controller over multi-machine state */
  const {
    boardState: workspaceBoardState,
    handleSelectWorkspace: handleBoardSelectWorkspace,
    worktreeCount: totalWorktrees,
    selectedWorkspaceProjectName,
  } = useBoardPageModel({
    state: multiMachineState,
    selectedRef: workspaceController.selectedRef,
    setSelectedRef: workspaceController.setSelectedRef,
    clearSelectedRef: workspaceController.clearSelectedRef,
    onSetWorkspacePhase: async (ref, phase) => {
      await setWorkspaceStatusAction(ref, phase);
    },
  });

  const workspaceRuntime = useWorkspaceRuntimeModel(multiMachineState);

  const currentProject =
    localProjects.find((project) => project.isCurrent)?.name ?? localProjects[0]?.name ?? null;

  const getTerminalViewportSize = useCallback((reservedCols = 0, reservedRows = 0) => {
    let cols = process.stdout.columns || 0;
    let rows = process.stdout.rows || 0;
    if (cols <= 0 || rows <= 0) {
      const size = (process.stdout as { getWindowSize?: () => number[] }).getWindowSize?.();
      if (Array.isArray(size) && size.length >= 2) {
        cols = size[0];
        rows = size[1];
      }
    }

    const viewportCols = cols > 0 ? cols : 80;
    const viewportRows = rows > 0 ? rows : 24;
    return {
      cols: Math.max(40, viewportCols - reservedCols),
      rows: Math.max(1, viewportRows - reservedRows),
    };
  }, []);

  const getLocalAttachSize = useCallback(() => {
    return getTerminalViewportSize(0, 1);
  }, [getTerminalViewportSize]);

  const getWorkspaceDetailAgentAttachSize = useCallback(() => {
    return getTerminalViewportSize(
      WORKSPACE_DETAIL_TERMINAL_RESERVED_COLS,
      WORKSPACE_DETAIL_TERMINAL_RESERVED_ROWS,
    );
  }, [getTerminalViewportSize]);

  const resolveLocalWorkspaceProjectName = useCallback((workspaceId: string) => {
    const separator = workspaceId.indexOf(':');
    if (separator > 0) {
      return workspaceId.slice(0, separator);
    }
    return currentProject;
  }, [currentProject]);

  const sessionClient = useMemo(() => ({
    multi,
    workspaceRefs: [],
  }), [multi]);
  const { attachSession: attachSessionAction, cancelPendingScripts } = useSessionActions({
    client: sessionClient,
    onError: (message) => {
      dispatch({ type: 'SET_ERROR', error: message });
    },
  });
  const bundleRefreshAttach = useBundleRefreshAttachFlow({
    client: workspaceLifecycleClient,
    flow,
    commandError: localCommandError,
    attachSession: (params) => attachSessionAction({ backendKey: LOCAL_BACKEND_KEY, workspaceId: params.workspaceId ?? '' }, params),
  });

  const {
    attach: attachLocal,
    attachFromSelection: attachLocalFromSelection,
    canAttachAnyway: canAttachLocalAnyway,
    attachAnyway: attachLocalAnyway,
  } = useTuiAttachActions({
    base: {
      flow,
      attachSessionWithBundleRefresh: bundleRefreshAttach.attachSessionWithBundleRefresh,
      recoverableAttachParams: bundleRefreshAttach.recoverableParams,
      defaultProjectName: currentProject,
      defaultBackendKey: LOCAL_BACKEND_KEY,
      getAttachSize: getLocalAttachSize,
      resolveProjectName: resolveLocalWorkspaceProjectName,
    },
    view: state.view,
    dispatch,
    setAttachedAgentSession,
    setScriptWorkspaceName,
    refreshWorkspaces: async () => {
      multi.listWorkspaces();
      multi.listSessions();
      multi.listReplays(undefined, showDismissedReplays);
    },
    localSessions,
  });

  const { deleteWorkspaceWithPrompt } = useWorkspaceLifecycleActions({
    client: workspaceLifecycleClient,
    flow,
    onBeforeDelete: ({ target }) => {
      activeDeleteTaskIdRef.current = workspaceRemovalTasks.startTask(target);
      workspaceRemovalTasks.updatePhase(target.ref.workspaceId, 'remove', 'Running cleanup scripts...');
    },
    onDeleteSuccess: async ({ target }) => {
      const taskId = activeDeleteTaskIdRef.current;
      if (taskId) workspaceRemovalTasks.completeSuccess(taskId);
      activeDeleteTaskIdRef.current = null;
      if (workspaceBoardState.selectedWorkspaceId === toBackendScopedWorkspaceKey(target.ref)) {
        workspaceBoardState.setSelectedWorkspaceId(null);
      }
      workspaceController.clearSelectedRef();
    },
    onDeleteCancelled: () => {
      const taskId = activeDeleteTaskIdRef.current;
      if (taskId) workspaceRemovalTasks.completeFailure(taskId, 'Workspace removal cancelled.');
      activeDeleteTaskIdRef.current = null;
      lastScriptWorkspaceIdRef.current = null;
    },
    onDeleteError: async ({ message }) => {
      const taskId = activeDeleteTaskIdRef.current;
      if (taskId) workspaceRemovalTasks.completeFromError(taskId, message);
      activeDeleteTaskIdRef.current = null;
      flow.showMessage({
        title: 'Delete Failed',
        message,
        variant: 'error',
      });
    },
  });

  // Daemon status hook (tmux-lite and serve)
  const { status: daemonStatus } = useDaemonStatus({ pollInterval: 5000 });

  const { activeNotificationConfig: notificationConfig, loadConfig: loadPreferencesConfig, updateConfig: updatePreferencesConfig } = usePreferencesAdapter({
    service: localPreferencesService,
    backendNotificationConfig: null,
    defaultConfig: DEFAULT_NOTIFICATION_CONFIG,
  });

  // ========== Data Loading ==========

  // Load projects
  const refreshProjects = useCallback(async () => {
    multi.listProjects();
  }, [multi]);

  // Load workspaces for current project
  const refreshWorkspaces = useCallback(async () => {
    multi.listWorkspaces();
    multi.listSessions();
    multi.listReplays(undefined, showDismissedReplays);
  }, [multi, showDismissedReplays]);

  const bundleConfigFlow = useBundleConfigFlow({
    client: workspaceLifecycleClient,
    flow,
    onApplied: async () => {
      await refreshWorkspaces();
    },
  });


  const lifecycleController = useLifecycleActions({
    client: sessionClient,
    backendKey: LOCAL_BACKEND_KEY,
    flow,
    getProjectNames: () => localProjects.map((project: { name: string }) => project.name),
    refreshProjects: () => refreshProjects(),
    refreshWorkspaces: () => refreshWorkspaces(),
    refreshSessions: () => multi.listSessions(),
    onWorkspaceCreated: async ({ workspaceId, workspaceName }) => {
      setScriptWorkspaceName(workspaceName);
      dispatch({ type: 'SET_VIEW', view: 'scripts' });

      const attached = await attachLocal({
        workspaceId,
        sessionName: String(Date.now()),
      });

      if (!attached) {
        dispatch({ type: 'SET_VIEW', view: 'projects' });
      }
    },
    showCreateWorkspaceSuccessMessage: false,
  });

  // Initial load
  useEffect(() => {
    const load = async () => {
      dispatch({ type: 'SET_LOADING', loading: true });
      try {
        await refreshProjects();
        // Load inbox in background (don't block initial render)
        refreshInbox().catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          logger.error(`[tui] Background inbox refresh failed: ${detail}`);
        });
      } catch (err) {
        dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Failed to load' });
      } finally {
        dispatch({ type: 'SET_LOADING', loading: false });
      }
    };
    load();
  }, []);

  // Load workspaces when project changes
  useEffect(() => {
    if (currentProject) {
      refreshWorkspaces();
    }
  }, [currentProject, refreshWorkspaces]);

  // ========== Action Handlers ==========

  // Delete project
  const handleDeleteProject = useCallback((project: ProjectInfo) => {
    lifecycleController.openDeleteProjectFlow(project.name);
  }, [lifecycleController]);

  // Attach to session using embedded terminal
  const handleAttachSession = useCallback(async (params: { sessionId?: string; workspaceId?: string; viewOnly?: boolean }) => {
    setIsViewOnlySession(params.viewOnly ?? false);
    setAttachedAgentSession(null);
    await attachLocalFromSelection(params);
  }, [attachLocalFromSelection]);

  const handleAttachLocalAnyway = useCallback(async () => {
    if (flow.flow.type === 'message') {
      flow.close();
    }
    await attachLocalAnyway();
  }, [attachLocalAnyway, flow]);

  // Open editor on .gitspace/processes.json in the workspace
  const handleEditProcesses = useCallback(({ workspaceId }: { workspaceId: string }) => {
    setIsViewOnlySession(false);
    pendingProcessEditWorkspacesRef.current = localWorkspaces;
    setPendingProcessEditWorkspaceId(workspaceId);
    const commandSpec = buildEditProcessesCommand();
    void attachLocal({
      workspaceId,
      command: commandSpec.command,
      args: commandSpec.args,
    }).then((attached) => {
      if (!attached) {
        pendingProcessEditWorkspacesRef.current = null;
        setPendingProcessEditWorkspaceId(null);
      }
    });
  }, [attachLocal, localWorkspaces]);

  const handleLaunchCommit = useCallback(async (workspaceId: string) => {
    setIsViewOnlySession(false);
    setAttachedAgentSession(null);
    const commandSpec = buildWorkspaceSessionCommand(['commit']);
    await attachLocal({
      workspaceId,
      command: commandSpec.command,
      args: commandSpec.args,
    });
  }, [attachLocal]);

  const handleManageBundleConfig = useCallback(async ({ workspaceId }: { workspaceId: string }) => {
    await bundleConfigFlow.openBundleConfig({ backendKey: LOCAL_BACKEND_KEY, workspaceId });
  }, [bundleConfigFlow]);

  useEffect(() => {
    if (!pendingProcessEditWorkspaceId) {
      return;
    }
    if (state.view !== 'projects' || localSessionMode !== 'browsing') {
      return;
    }

    if (
      pendingProcessEditWorkspacesRef.current &&
      pendingProcessEditWorkspacesRef.current === localWorkspaces
    ) {
      return;
    }
    pendingProcessEditWorkspacesRef.current = null;

    const workspace = localWorkspaces.find((item) => item.id === pendingProcessEditWorkspaceId);
    if (!workspace) {
      setPendingProcessEditWorkspaceId(null);
      return;
    }

    const diagnostics = loadProcessesConfigWithDiagnostics(workspace.path);
    if (diagnostics.error) {
      flow.showMessage({
        title: 'Invalid Processes Config',
        message: diagnostics.error,
        variant: 'error',
      });
    } else {
      const processCount = diagnostics.config.processes.length;
      flow.showMessage({
        title: 'Processes Config Updated',
        message: processCount === 0
          ? 'Config is valid. No processes are defined yet.'
          : `Config is valid. ${processCount} process${processCount === 1 ? '' : 'es'} defined.`,
        variant: 'success',
      });
    }

    setPendingProcessEditWorkspaceId(null);
    void refreshWorkspaces();
  }, [
    flow,
    localSessionMode,
    localWorkspaces,
    pendingProcessEditWorkspaceId,
    refreshWorkspaces,
    state.view,
  ]);

  // Handle terminal detach
  const handleTerminalDetach = useCallback(async () => {
    // Don't navigate away if we're in the middle of switching sessions
    if (sessionSwitchingRef.current) return;

    setIsViewOnlySession(false);
    setAttachedAgentSession(null);
    await multi.detachSession({ backendKey: LOCAL_BACKEND_KEY, workspaceId: '' });
    dispatch({ type: 'SET_VIEW', view: 'projects' });
    await refreshWorkspaces();
  }, [multi, refreshWorkspaces]);

  const handleSelectWorkspaceFromDetail = useCallback(async (workspaceSelectionKey: string) => {
    if (workspaceSelectionKey === workspaceBoardState.selectedWorkspaceId) return;
    if (localSessionMode === 'attached') {
      setIsViewOnlySession(false);
      setAttachedAgentSession(null);
      await multi.detachSession({ backendKey: LOCAL_BACKEND_KEY, workspaceId: '' });
    }
    handleBoardSelectWorkspace(workspaceSelectionKey);
  }, [handleBoardSelectWorkspace, localSessionMode, multi, workspaceBoardState.selectedWorkspaceId]);

  // Delete workspace
  const handleDeleteWorkspace = useCallback((workspace: { id: string; name: string; sessionCount: number }) => {
    flow.showConfirmTyped({
      title: 'Delete Workspace',
      message: `Are you sure you want to delete workspace "${workspace.name}"?`,
      confirmText: workspace.name,
      warning: workspace.sessionCount > 0 ? `This will kill ${workspace.sessionCount} active session(s)!` : undefined,
      onConfirm: async () => {
        await deleteWorkspaceWithPrompt({
          ref: { backendKey: LOCAL_BACKEND_KEY, workspaceId: workspace.id },
          workspaceName: workspace.name,
        });
      },
    });
  }, [flow, deleteWorkspaceWithPrompt]);

  // Delete session
  const handleDeleteSession = useCallback((sessionId: string, sessionName: string) => {
    flow.showConfirm({
      title: 'Kill Session',
      message: `Kill session "${sessionName}"?`,
      variant: 'warning',
      confirmLabel: 'Kill',
      onConfirm: async () => {
        try {
          if (localAttachedSessionId === sessionId) {
            await multi.detachSession({ backendKey: LOCAL_BACKEND_KEY, workspaceId: '' });
          }
          await multi.terminateSession({ backendKey: LOCAL_BACKEND_KEY, sessionId });
        } catch (err) {
          dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Failed to terminate session' });
        }
      },
    });
  }, [flow, multi, localAttachedSessionId]);

  // ========== Workspace Creation ==========
  const handleNewWorkspaceFlow = useCallback(() => {
    lifecycleController.openCreateWorkspaceFlow(selectedWorkspaceProjectName);
  }, [selectedWorkspaceProjectName, lifecycleController]);

  const handleNewProjectFlow = useCallback(() => {
    lifecycleController.openCreateProjectFlow();
  }, [lifecycleController]);

  // ========== Shared Hooks ==========

  // Convert local backend state into panel data.
  const projectInfos: ProjectInfo[] = localProjects.map((project) => ({
    name: project.name,
    repository: project.repository,
    workspaceCount: project.workspaceCount,
    isCurrent: project.name === currentProject,
  }));

  const workspaceInfos = useMemo(
    () =>
      workspaceRuntime.workspaces
        .filter((workspace) => workspace.backendKey === LOCAL_BACKEND_KEY)
        .filter((workspace) => workspace.projectName === currentProject)
        .map((workspace) => ({
          id: workspace.id,
          selectionKey: workspace.selectionKey,
          name: workspace.name,
          path: workspace.path,
          projectName: workspace.projectName,
          branch: workspace.branch,
          phase: workspace.phase ?? ('code' as import('./types/config.js').WorkspacePhase),
          sessionCount: workspaceRuntime.runtimeByWorkspace[workspace.selectionKey]?.sessions.length ?? 0,
          isStale: workspace.isStale,
          processes: workspace.processes,
          processConfigError: workspace.processConfigError,
          serveDomain: workspace.serveDomain,
        })),
    [workspaceRuntime, currentProject]
  );

  const sessionInfos = useMemo(
    () => currentProject
      ? workspaceRuntime.sessions.filter(
          (session) =>
            session.workspaceId !== 'unknown' &&
            session.workspaceId.startsWith(`${currentProject}:`)
        )
      : [],
    [currentProject, workspaceRuntime.sessions],
  );

  const replayInfos = currentProject
    ? localReplays.filter((replay) => replay.projectName === currentProject)
    : [];

  const selectedWorkspaceForDetail = useMemo(() => {
    const selectedRef = workspaceController.selectedRef;
    if (!selectedRef) {
      return null;
    }
    const runtimeWorkspace = workspaceRuntime.workspaces.find(
      (item) => item.selectionKey === toBackendScopedWorkspaceKey(selectedRef),
    );
    if (!runtimeWorkspace) {
      return null;
    }
    return {
      ...runtimeWorkspace,
      sessionCount: workspaceRuntime.runtimeByWorkspace[runtimeWorkspace.selectionKey]?.sessions.length ?? 0,
    };
  }, [workspaceController.selectedRef, workspaceRuntime]);

  const attachedDetailOwnsKeyboard = Boolean(
    state.view === 'workspace-detail'
      && selectedWorkspaceForDetail
      && (
        (localAttachedSessionId && localAttachedWorkspaceId === selectedWorkspaceForDetail.id)
        || attachedAgentSession?.workspaceId === selectedWorkspaceForDetail.id
        || (localScriptState?.isRunning && lastScriptWorkspaceIdRef.current === selectedWorkspaceForDetail.id)
      ),
  );
  const detailSessions = useMemo(
    () => selectedWorkspaceForDetail
      ? workspaceRuntime.runtimeByWorkspace[selectedWorkspaceForDetail.selectionKey]?.sessions ?? []
      : [],
    [selectedWorkspaceForDetail, workspaceRuntime.runtimeByWorkspace]
  );
  const detailReplays = useMemo(
    () => selectedWorkspaceForDetail
      ? localReplays.filter((r) => (r as { workspaceId?: string }).workspaceId === selectedWorkspaceForDetail.id)
      : [],
    [localReplays, selectedWorkspaceForDetail]
  );

  // Agent inbox items — generated from useWorkspaceAgentEvents notifications
  const [agentInboxItems, setAgentInboxItems] = useState<InboxItem[]>([]);

  const inboxItems = useMemo(
    () => [...(localInbox as InboxItem[]), ...agentInboxItems],
    [localInbox, agentInboxItems],
  );
  const inboxUnreadCount = localInboxUnreadCount + agentInboxItems.filter((i) => !i.read).length;

  const processClientContext = useMemo(() => ({
    multi,
    workspaceRefs: localWorkspaces.map((workspace) => ({
      backendKey: LOCAL_BACKEND_KEY,
      workspaceId: workspace.id,
    })),
    selectedWorkspaceRef: workspaceController.selectedRef ?? null,
    detailWorkspaceRef: selectedWorkspaceForDetail
      ? { backendKey: selectedWorkspaceForDetail.backendKey, workspaceId: selectedWorkspaceForDetail.id }
      : null,
    preferredBackendKey: LOCAL_BACKEND_KEY,
  }), [localWorkspaces, multi, selectedWorkspaceForDetail, workspaceController.selectedRef]);

  const processActions = useProcessActions({
    client: processClientContext,
    flow,
    sessions: sessionInfos,
    attachSession: handleAttachSession,
    onStartProcessError: (error) => {
      flow.showMessage({
        title: 'Process Start Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    },
    onStopProcessError: (error) => {
      flow.showMessage({
        title: 'Process Stop Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    },
    onStartProcessAttachError: (error) => {
      flow.showMessage({
        title: 'Process Start Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    },
    onAttachError: (error) => {
      flow.showMessage({
        title: 'Attach Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    },
    onAttachTimeout: (target) => {
      flow.showMessage({
        title: 'Attach Timeout',
        message: `Process started but no active session was found for ${target.processName}#${target.instance}.`,
        variant: 'warning',
      });
    },
    onStartProcessAttachFinally: () => {
      void refreshWorkspaces();
    },
  });

  const handleStartProcess = processActions.handleStartProcess;
  const handleStartProcessAttach = processActions.handleStartProcessAttach;
  const handleStopProcess = processActions.handleStopProcess;

  const handleProcessDisabled = useCallback((params: { workspaceId: string; processName: string }) => {
    const workspace = localWorkspaces.find((item) => item.id === params.workspaceId);
    const workspaceLabel = workspace?.name ?? params.workspaceId;
    toast.error(`Process "${params.processName}" is disabled in ${workspaceLabel} (instances: 0).`);
  }, [localWorkspaces]);

  const handleOpenEvents = useCallback((workspaceId: string) => {
    setEventsWorkspaceId(workspaceId);
    setEventsReturnView(state.view === 'workspace-detail' ? 'workspace-detail' : 'projects');
    void multi.requestEvents({ backendKey: LOCAL_BACKEND_KEY, workspaceId });
    dispatch({ type: 'SET_VIEW', view: 'events' });
  }, [multi, state.view]);

  const handleOpenReplay = useCallback(async (replayId: string) => {
    const replay = localReplays.find((item) => item.replayId === replayId);
    if (!replay) {
      flow.showMessage({
        title: 'Replay Missing',
        message: 'That replay is no longer available.',
        variant: 'error',
      });
      return;
    }

    setActiveReplay(replay);
    dispatch({ type: 'SET_VIEW', view: 'replay' });
  }, [flow, localReplays]);

  const handleReplayDismiss = useCallback((replayId: string) => {
    try {
      const replay = localReplays.find((item: { replayId: string; status: string }) => item.replayId === replayId) ?? activeReplay;
      if (!activeReplayDismissedRef.current && replay?.status === 'running') {
        flow.showMessage({
          title: 'Replay Still Running',
          message: 'Running replays cannot be dismissed.',
          variant: 'info',
        });
        return false;
      }

      if (activeReplayDismissedRef.current) {
        undismissReplayOffline(replayId);
        activeReplayDismissedRef.current = false;
        setActiveReplay((current) => current && current.replayId === replayId
          ? {
            ...current,
            dismissedAt: undefined,
            dismissedBy: undefined,
          }
          : current);
        return false;
      }

      dismissReplayOffline(replayId);
      activeReplayDismissedRef.current = true;
      return true;
    } catch (error) {
      flow.showMessage({
        title: 'Replay Update Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
      return false;
    } finally {
      multi.listReplays(undefined, showDismissedReplays);
    }
  }, [activeReplay, flow, localReplays, multi, showDismissedReplays]);

  useEffect(() => {
    activeReplayDismissedRef.current = Boolean(activeReplay?.dismissedAt);
  }, [activeReplay?.dismissedAt]);

  const loadReplayFrame = useCallback((replayId: string, target?: { atMs?: number; atSeq?: number }) => {
    return Promise.resolve(getReplayFrameOffline(replayId, target));
  }, []);

  const loadReplayTimeline = useCallback((replayId: string) => {
    return Promise.resolve(getReplayTimelineOffline(replayId));
  }, []); 

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

  const toAgentSessionInfo = useCallback((agent: typeof workspaceController.agents[number]): BrowserAgentSessionInfo => ({
    id: agent.id,
    workspaceId: agent.workspaceId,
    title: getAgentSessionDisplayTitle({ id: agent.id, title: agent.title }),
    updatedAt: agent.updatedAt,
    closedAt: agent.closedAt,
    archivedAt: agent.archivedAt,
    status: agent.state === 'running'
      ? { type: 'busy' }
      : agent.state === 'retrying'
        ? { type: 'retry', attempt: 1, message: agent.errorMessage ?? 'retrying', next: Date.now() + 1000 }
        : !agent.closedAt && agent.state !== 'archived'
          ? { type: 'idle' }
          : undefined,
    pendingPermissionCount: agent.pendingPermissionCount,
    errorMessage: agent.errorMessage,
  }), []);


  const agentSessionsByWorkspace = workspaceRuntime.agentSessionsByWorkspace;
  const agentSessionCounts = workspaceRuntime.agentSessionCounts;
  const pendingPermissionsByWorkspace = workspaceRuntime.pendingPermissionsByWorkspace;

  // Build status entries for every workspace across all backends so the kanban
  // board (which shows all workspaces) always has a status entry per card.
  const allWorkspaceEntries = workspaceRuntime.workspaces;
  const workspaceStatusById = workspaceRuntime.workspaceStatusById;
  const agentSessionClientContext = useMemo(() => ({
    multi,
    workspaceRefs: allWorkspaceEntries.map((workspace) => ({
      backendKey: workspace.backendKey,
      workspaceId: workspace.id,
    })),
    agentSessionsByWorkspaceKey: agentSessionsByWorkspace,
    selectedWorkspaceRef: workspaceController.selectedRef ?? null,
    detailWorkspaceRef: selectedWorkspaceForDetail
      ? { backendKey: selectedWorkspaceForDetail.backendKey, workspaceId: selectedWorkspaceForDetail.id }
      : null,
    preferredBackendKey: LOCAL_BACKEND_KEY,
  }), [agentSessionsByWorkspace, allWorkspaceEntries, multi, selectedWorkspaceForDetail, workspaceController.selectedRef]);
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
    onOpenSuccess: async ({ agentSessionRef }) => {
      setAttachedAgentSession({
        workspaceId: agentSessionRef.workspaceId,
        sessionId: agentSessionRef.agentSessionId,
      });
      if (state.view !== 'workspace-detail') {
        dispatch({ type: 'SET_VIEW', view: 'terminal' });
      }
    },
    onError: (message) => {
      dispatch({ type: 'SET_ERROR', error: message });
    },
  });

  const {
    requestInbox,
    clearInbox,
    markInboxRead,
    respondToPermission,
    attachFromInboxSessionSelection,
  } = useInboxActions({
    client: agentSessionClientContext,
    flow,
    onError: (message) => {
      dispatch({ type: 'SET_ERROR', error: message });
    },
  });

  const attachFromInboxSessionId = useCallback(async (sessionId: string) => {
    await attachFromInboxSessionSelection({
      sessionId,
      agentInboxItems,
      markAgentInboxItemRead: (id) => {
        setAgentInboxItems((prev) => prev.map((item) => item.sessionId === id ? { ...item, read: true } : item));
      },
      attachRegularSession: async (id) => {
        await handleAttachSession({ sessionId: id });
      },
      beforeAgentAction: async () => {
        dispatch({ type: 'SET_VIEW', view: 'projects' });
      },
      beforeRegularAttach: async () => {
        dispatch({ type: 'SET_VIEW', view: 'projects' });
      },
      onOpenAgentSuccess: async () => {
        setAttachedAgentSession(null);
        dispatch({ type: 'SET_VIEW', view: 'terminal' });
      },
    });
  }, [agentInboxItems, attachFromInboxSessionSelection, dispatch, handleAttachSession]);

  const handleOpenAgents = useCallback(async (workspaceId: string) => {
    void workspaceId;
  }, []);

  const handleOpenReview = useCallback(async (workspaceId: string) => {
    const workspace = allWorkspaceEntries.find((item) => item.id === workspaceId);
    if (!workspace) {
      flow.showMessage({ title: 'Open Review', message: 'Select a workspace first.', variant: 'info' });
      return;
    }
    const result = await openBrowserUrl(buildReviewUrl({
      projectName: workspace.projectName,
      workspaceName: workspace.name,
    }));
    if (!result.ok) {
      flow.showMessage({ title: 'Open Review', message: result.message, variant: 'error' });
    }
  }, [allWorkspaceEntries, flow]);

  const handleOpenGitHubPullRequest = useCallback(async (workspaceId: string) => {
    const workspace = allWorkspaceEntries.find((item) => item.id === workspaceId);
    const url = workspace?.pullRequest?.url;
    if (!url) {
      flow.showMessage({ title: 'Open GitHub PR', message: 'No GitHub pull request found for this workspace.', variant: 'info' });
      return;
    }
    const result = await openBrowserUrl(url);
    if (!result.ok) {
      flow.showMessage({ title: 'Open GitHub PR', message: result.message, variant: 'error' });
    }
  }, [allWorkspaceEntries, flow]);

  const handleKillAgentSession = useCallback(async (workspaceId: string, agentSessionId: string) => {
    await killAgentSessionAction(workspaceId, agentSessionId);
  }, [killAgentSessionAction]);

  const handleStopAgentTurn = useCallback(async (workspaceId: string, agentSessionId: string) => {
    await stopAgentTurnAction(workspaceId, agentSessionId);
  }, [stopAgentTurnAction]);

  const handleCloseAgentSession = useCallback(async (workspaceId: string, agentSessionId: string) => {
    const closed = await closeAgentSessionAction(workspaceId, agentSessionId);
    if (!closed) {
      return;
    }
    if (attachedAgentSession?.workspaceId === workspaceId && attachedAgentSession.sessionId === agentSessionId) {
      setAttachedAgentSession(null);
    }
  }, [attachedAgentSession, closeAgentSessionAction]);

  const handleArchiveAgentSession = useCallback(async (workspaceId: string, agentSessionId: string) => {
    const archived = await archiveAgentSessionAction(workspaceId, agentSessionId);
    if (!archived) {
      return;
    }
    if (attachedAgentSession?.workspaceId === workspaceId && attachedAgentSession.sessionId === agentSessionId) {
      setAttachedAgentSession(null);
    }
  }, [archiveAgentSessionAction, attachedAgentSession]);

  const handleRestoreAgentSession = useCallback(async (workspaceId: string, agentSessionId: string) => {
    await restoreAgentSessionAction(workspaceId, agentSessionId);
  }, [restoreAgentSessionAction]);

  const handleOpenAgentSession = useCallback(async (workspaceId: string, agentSessionId: string) => {
    await openAgentSessionAction(workspaceId, agentSessionId, {
      attachOptions: getWorkspaceDetailAgentAttachSize(),
    });
  }, [openAgentSessionAction, getWorkspaceDetailAgentAttachSize]);

  const handleCreateAgentSession = useCallback((workspaceId: string) => {
    createAgentSessionAction(workspaceId, {
      attachOptions: getWorkspaceDetailAgentAttachSize(),
    });
  }, [createAgentSessionAction, getWorkspaceDetailAgentAttachSize]);

  // Spaces browser hook (full project list; when a workspace is selected we show WorkspaceDetailPaneTUI instead)
  const spacesBrowserProps = useSpacesBrowser({
    workspaces: workspaceInfos,
    sessions: sessionInfos,
    replays: replayInfos,
    onAttachSession: handleAttachSession,
    onOpenReplay: handleOpenReplay,
    onEditProcesses: handleEditProcesses,
    onManageBundleConfig: handleManageBundleConfig,
    onStartProcessAttach: handleStartProcessAttach,
    onStopProcess: handleStopProcess,
    onProcessDisabled: handleProcessDisabled,
    onOpenEvents: handleOpenEvents,
    onOpenAgents: handleOpenAgents,
    onOpenAgentSession: handleOpenAgentSession,
    onCreateAgentSession: handleCreateAgentSession,
    agentSessionsByWorkspace,
    agentSessionCounts: agentSessionCounts,
    pendingPermissionsByWorkspace,
    runtimeByWorkspace: workspaceRuntime.runtimeByWorkspace,
    onRefresh: refreshWorkspaces,
    onRefreshSessions: () => {
      multi.listSessions();
      multi.listReplays(undefined, showDismissedReplays);
    },
    onBack: () => undefined,
    onCreateWorkspace: handleNewWorkspaceFlow,
    machineName: currentProject || undefined,
    showProjectHeaders: false, // Don't show project headers since we're already filtered
  });

  // Command palette (shared state + handler)
  const { commandPalette } = useCommandPaletteOrchestration({
    selectedBoardWorkspaceId: workspaceBoardState.selectedWorkspaceId,
    selectedDetailWorkspaceId: selectedWorkspaceForDetail?.id ?? null,
    workspaces: allWorkspaceEntries as any,
    selectedProjectName: selectedWorkspaceProjectName,
    showSelect: (config) => flow.showSelect<string>(config),
    showMessage: (config) => flow.showMessage(config),
    onOpenUrl: async (url) => {
      const result = await openBrowserUrl(url);
      if (!result.ok) {
        flow.showMessage({ title: 'Open Service', message: result.message, variant: 'error' });
      }
    },
    onAddRepo: () => lifecycleController.openCreateProjectFlow(),
    onAddWorkspace: () => lifecycleController.openCreateMenu(),
    onSetWorkspacePhase: (workspace, phase) => {
      workspaceBoardState.setPhase(workspace.selectionKey ?? workspace.id, phase);
      flow.close();
    },
    onDeleteWorkspace: handleDeleteWorkspace,
    onDeleteWorkspaceSkipScripts: async () => {
      flow.showMessage({ title: 'Skip Scripts Delete Unsupported', message: 'Deleting a workspace without scripts is not implemented in the TUI yet.', variant: 'info' });
    },
    onEditBundleConfig: async (workspace) => {
      await handleManageBundleConfig({ workspaceId: workspace.id });
    },
    onRefreshBundle: async (workspace) => {
      const refreshed = await bundleRefreshAttach.refreshBundle({
        backendKey: LOCAL_BACKEND_KEY,
        workspaceId: workspace.id,
      });
      if (refreshed) {
        multi.listWorkspaces();
        multi.listSessions();
      }
    },
    onRerunBundleScripts: async () => {
      flow.showMessage({ title: 'Rerun Bundle Scripts Unsupported', message: 'Rerunning bundle scripts is not implemented in the TUI yet.', variant: 'info' });
    },
    onAddNote: async () => {
      flow.showMessage({ title: 'Notes Unsupported', message: 'Workspace notes editing is not implemented in the TUI yet.', variant: 'info' });
    },
    onListNotes: async () => {
      flow.showMessage({ title: 'Notes Unsupported', message: 'Workspace notes editing is not implemented in the TUI yet.', variant: 'info' });
    },
    onEditProcessConfig: async (workspace) => {
      await handleEditProcesses({ workspaceId: workspace.id });
    },
    onDeleteRepo: (projectName) => {
      const project = projectInfos.find((item) => item.name === projectName);
      if (project) handleDeleteProject(project);
    },
    onOpenGitHubPr: (workspace) => handleOpenGitHubPullRequest(workspace.id),
    onOpenReview: (workspace) => handleOpenReview(workspace.id),
    onOpenEditor: async (workspace) => {
      await showWorkspaceEditorSelect({
        workspace,
        showSelect: (config) => flow.showSelect<string>(config),
        showMessage: (config) => flow.showMessage(config),
        listAvailableEditors: () => multi.listAvailableEditors({ backendKey: LOCAL_BACKEND_KEY, workspaceId: workspace.id }),
        openInEditor: async (editorId) => {
          await multi.openWorkspaceInEditor({ backendKey: LOCAL_BACKEND_KEY, workspaceId: workspace.id }, editorId);
          flow.showMessage({ title: 'Open in Editor', message: `Opening ${workspace.name} in editor...`, variant: 'success' });
        },
      });
    },
  });

  // Inbox hook
  const refreshInbox = useCallback(async () => {
    await requestInbox();
  }, [requestInbox]);

  // Inbox hook
  const { inboxProps, handleInboxCommand } = useInboxPage({
    items: inboxItems,
    unreadCount: inboxUnreadCount,
    onClearItem: async (id) => {
      await clearInbox(id);
      await refreshInbox();
    },
    onClearAll: async () => {
      await clearInbox();
      await refreshInbox();
    },
    onMarkRead: async (id) => {
      await markInboxRead(id);
      await refreshInbox();
    },
    onAttachSession: attachFromInboxSessionId,
    onClose: () => {
      dispatch({ type: 'SET_VIEW', view: 'projects' });
    },
  });

  // Events hook
  const eventsItems: WideEventItem[] = localEvents.map(toWideEventItem);

  const eventsProps = useEvents({
    events: eventsItems,
    liveEventIds: localLiveEventIds,
    savedFilters: localSavedEventFilters,
    onSelectFilter: (filter) => {
      if (!eventsWorkspaceId) return;
      const ref = { backendKey: LOCAL_BACKEND_KEY, workspaceId: eventsWorkspaceId };
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
      setEventsWorkspaceId(null);
      dispatch({ type: 'SET_VIEW', view: eventsReturnView });
    },
  });

  // Events polling when events view is active
  useEffect(() => {
    if (state.view !== 'events' || !eventsWorkspaceId) return;
    const ref = { backendKey: LOCAL_BACKEND_KEY, workspaceId: eventsWorkspaceId };

    const interval = setInterval(() => {
      const activeFilter = eventsProps.activeFilterName
        ? localSavedEventFilters.find((filter: { name: string }) => filter.name === eventsProps.activeFilterName) ?? null
        : null;

      if (activeFilter) {
        const sinceMs = (activeFilter as { sinceMinutes?: number }).sinceMinutes
          ? Date.now() - (activeFilter as { sinceMinutes: number }).sinceMinutes * 60 * 1000
          : undefined;
        void multi.requestEvents(ref, (activeFilter as { filter: WideEventFilter }).filter, undefined, sinceMs);
      } else {
        void multi.requestEvents(ref);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [
    state.view,
    eventsWorkspaceId,
    eventsProps.activeFilterName,
    localSavedEventFilters,
    multi,
  ]);

  // ========== Activity Tracking for Notifications ==========

  const holdWhenIdleMs = notificationConfig.toast.holdWhenIdleMs ?? 15000;
  const { isUserActive, markActivity: handleTerminalActivity } = useUserActivity({
    isActivityTracked: state.view === 'terminal',
    holdWhenIdleMs,
  });

  // ========== Notification Toasts ==========

  const handleShowToast = useCallback((notification: ToastNotification) => {
    const description = notification.preview
      ? `${notification.preview} · [Shift+Tab to attach]`
      : '[Shift+Tab to attach]';
    toast.info(`${notification.icon} ${notification.title}`, {
      description,
      duration: 8000,
    });
  }, []);

  const notifications = useNotifications({
    items: inboxItems,
    config: notificationConfig,
    onShowToast: handleShowToast,
    onAttachSession: (sessionId) => {
      void attachFromInboxSessionId(sessionId).catch((error) => {
        flow.showMessage({
          title: 'Attach Failed',
          message: error instanceof Error ? error.message : String(error),
          variant: 'error',
        });
      });
    },
    onMarkRead: async (itemId) => {
      await markInboxRead(itemId);
      await refreshInbox();
    },
    pollIntervalMs: 5000,
    onRefreshInbox: refreshInbox,
    isUserActive,
    currentSessionId: localAttachedSessionId ?? undefined,
  });

  useEffect(() => {
    const handlePaste = (event: PasteEvent) => {
      const rawText = decodePasteBytes(event.bytes);

      if (flow.isOpen && applySearchableSelectPaste(flow, rawText)) {
        event.preventDefault();
        return;
      }

      const text = normalizeInputText(rawText);
      if (!text) {
        return;
      }

      if (flow.isOpen) {
        const isWizardTextStep =
          isFlowWizard(flow.flow) &&
          (() => {
            const step = flow.flow.steps[flow.flow.currentStep];
            return step?.type === 'input' || step?.type === 'secret';
          })();

        if (isFlowInput(flow.flow) || isFlowConfirmTyped(flow.flow) || isWizardTextStep) {
          const current = 'inputValue' in flow.flow ? flow.flow.inputValue || '' : '';
          flow.handleInput(current + text);
          event.preventDefault();
          return;
        }

      }
      if (settingsFlow.type === 'edit-duration' || settingsFlow.type === 'edit-hold-duration') {
        const digits = getNumericInputChunk(text);
        if (!digits) {
          return;
        }
        setSettingsFlow({
          ...settingsFlow,
          value: settingsFlow.value + digits,
        });
        event.preventDefault();
      }
    };

    renderer.keyInput.on('paste', handlePaste);
    return () => {
      renderer.keyInput.off('paste', handlePaste);
    };
  }, [flow, renderer, settingsFlow]);

  // ========== Keyboard Handlers ==========

  useKeyboard(async (key) => {
    const localScriptTerminalRunning =
      state.view === 'scripts' &&
      (localScriptState?.isRunning ?? true);

    // Command palette: Ctrl+Shift+P toggles; when open, handle palette keys
    if (key.ctrl && key.shift && (key.name === 'p' || key.raw === 'P' || key.raw === 'p')) {
      commandPalette.toggle();
      return;
    }
    if (commandPalette.isOpen) {
      if (key.name === 'escape') {
        commandPalette.close();
      } else if (key.name === 'up' || key.raw === 'k') {
        commandPalette.moveSelection(-1);
      } else if (key.name === 'down' || key.raw === 'j') {
        commandPalette.moveSelection(1);
      } else if (key.name === 'return') {
        commandPalette.selectCurrent();
      } else if (key.name === 'backspace') {
        commandPalette.setFilter(commandPalette.filter.slice(0, -1));
      } else {
        const chunk = getKeyboardInputChunk(key);
        if (chunk) commandPalette.setFilter(commandPalette.filter + chunk);
      }
      return;
    }

    // Handle flow modals FIRST - even in terminal view
    // This ensures y/n work in confirmation modals when terminal is underneath
    if (flow.isOpen && !localScriptTerminalRunning) {
      // Handle confirm modal with y/n shortcuts
      if (flow.flow.type === 'confirm') {
        if (key.raw === 'y' || key.name === 'return') {
          await flow.handleConfirm();
        } else if (key.raw === 'n' || key.name === 'escape') {
          flow.handleCancel();
        }
        return;
      }

      // Handle text input modals (before j/k navigation)
      const isWizardTextStep =
        isFlowWizard(flow.flow) &&
        (() => {
          const step = flow.flow.steps[flow.flow.currentStep];
          return step?.type === 'input' || step?.type === 'secret';
        })();

      if (isFlowInput(flow.flow) || isFlowConfirmTyped(flow.flow) || isWizardTextStep) {
        if (key.name === 'escape') {
          flow.handleCancel();
        } else if (key.name === 'return') {
          await flow.handleConfirm();
        } else if (key.name === 'backspace') {
          const current = 'inputValue' in flow.flow ? flow.flow.inputValue || '' : '';
          flow.handleInput(current.slice(0, -1));
        } else {
          const chunk = getKeyboardInputChunk(key);
          if (!chunk) {
            return;
          }
          const current = 'inputValue' in flow.flow ? flow.flow.inputValue || '' : '';
          flow.handleInput(current + chunk);
        }
        return;
      }

      if (
        state.view === 'scripts' &&
        !localScriptState?.isRunning &&
        !!localScriptState?.error &&
        flow.flow.type === 'message' &&
        (key.raw === 'a' || key.name === 'a') &&
        canAttachLocalAnyway
      ) {
        await handleAttachLocalAnyway();
        return;
      }

      // Handle searchable select modal input/navigation.
      if (await handleSearchableSelectKey(flow, key)) {
        return;
      }

      // Handle other modals (select, message, etc.)
      if (key.name === 'escape') {
        flow.handleCancel();
      } else if (key.name === 'return') {
        await flow.handleConfirm();
      } else if (key.name === 'up' || key.raw === 'k') {
        flow.moveUp();
      } else if (key.name === 'down' || key.raw === 'j') {
        flow.moveDown();
      }
      return;
    }

    // Shift+Tab attach hotkey - check FIRST, even in terminal view
    // This allows attaching to a different session while in a terminal
    if (key.shift && key.name === 'tab' && notifications.activeToast && state.view !== 'scripts') {
      // Show confirmation before switching sessions
      const sessionLabel = getSessionLabel(notifications.activeToast.sessionName);
      flow.showConfirm({
        title: 'Switch Session',
        message: `Switch to "${sessionLabel}"?`,
        confirmLabel: 'Switch',
        onConfirm: () => {
          notifications.attachToActiveToast();
        },
      });
      return;
    }

    // Don't handle keys when in terminal view (Terminal component handles input)
    if (state.view === 'terminal' || state.view === 'replay') {
      return;
    }

    // Read-only script terminal view.
    if (state.view === 'scripts') {
      if (localScriptState?.isRunning && (key.raw === 'c' || key.name === 'c')) {
        if (workspaceController.selectedRef) {
            await cancelPendingScripts(workspaceController.selectedRef);
          } else {
            // No selected workspace ref — detach any pending scripts
            await multi.detachSession({ backendKey: LOCAL_BACKEND_KEY, workspaceId: '' });
          }
        return;
      }

      if (
        !localScriptState?.isRunning &&
        (key.raw === 'a' || key.name === 'a') &&
        !!localScriptState?.error &&
        canAttachLocalAnyway
      ) {
        await handleAttachLocalAnyway();
        return;
      }

      if (
        !localScriptState?.isRunning &&
        (
          key.name === 'escape' ||
          key.name === 'n' ||
          key.raw === 'n'
        )
      ) {
        lastScriptWorkspaceIdRef.current = null;
        dispatch({ type: 'SET_VIEW', view: 'projects' });
      }
      return;
    }

    // Events view keyboard handling
    if (state.view === 'events') {
      if (key.name === 'escape' || key.raw === 'q') {
        setEventsWorkspaceId(null);
        dispatch({ type: 'SET_VIEW', view: eventsReturnView });
      } else if (key.name === 'up' || key.raw === 'k') {
        eventsProps.selectIndex(eventsProps.selectedIndex - 1);
      } else if (key.name === 'down' || key.raw === 'j') {
        eventsProps.selectIndex(eventsProps.selectedIndex + 1);
      }
      return;
    }


    // When a workspace-detail inline terminal/script is attached, it owns the keyboard.
    // Global app shortcuts must not steal input until the user explicitly releases focus.
    if (attachedDetailOwnsKeyboard) {
      return;
    }

    // Global shortcuts
    if (key.raw === '?') {
      flow.showHelp(getDefaultShortcuts());
      return;
    }

    if (key.raw === 'q' || (key.ctrl && key.raw === 'c')) {
      onQuit?.();
      return;
    }

    // Inbox shortcut (global) - open full-screen inbox view
    if (key.raw === 'i') {
      dispatch({ type: 'SET_VIEW', view: 'inbox' });
      return;
    }

    // Settings shortcut (global) - open settings modal
    if (key.raw === ',') {
      const config = await loadPreferencesConfig();
      setSettingsFlow({ type: 'main-menu', selectedIndex: 0, config });
      return;
    }

    // Settings flow keyboard handling
    if (settingsFlow.type !== 'closed') {
      if (key.name === 'escape') {
        if (settingsFlow.type === 'types-menu') {
          // Go back to main menu
          setSettingsFlow({ type: 'main-menu', selectedIndex: 4, config: settingsFlow.config });
        } else if (settingsFlow.type === 'edit-duration' || settingsFlow.type === 'edit-hold-duration') {
          // Go back to main menu
          setSettingsFlow({ type: 'main-menu', selectedIndex: settingsFlow.type === 'edit-duration' ? 2 : 3, config: settingsFlow.config });
        } else {
          setSettingsFlow({ type: 'closed' });
        }
        return;
      }

      if (settingsFlow.type === 'main-menu') {
        const menuItems = [
          'notifications-enabled',
          'toast-enabled',
          'min-duration',
          'hold-duration',
          'types',
          'reset',
        ];

        if (key.name === 'up' || key.raw === 'k') {
          setSettingsFlow({
            ...settingsFlow,
            selectedIndex: Math.max(0, settingsFlow.selectedIndex - 1),
          });
        } else if (key.name === 'down' || key.raw === 'j') {
          setSettingsFlow({
            ...settingsFlow,
            selectedIndex: Math.min(menuItems.length - 1, settingsFlow.selectedIndex + 1),
          });
        } else if (key.name === 'return') {
          const selected = menuItems[settingsFlow.selectedIndex];
          if (selected === 'notifications-enabled') {
            const newConfig = { ...settingsFlow.config, enabled: !settingsFlow.config.enabled };
            await updatePreferencesConfig(newConfig);
            setSettingsFlow({ ...settingsFlow, config: newConfig });
          } else if (selected === 'toast-enabled') {
            const newConfig = {
              ...settingsFlow.config,
              toast: { ...settingsFlow.config.toast, enabled: !settingsFlow.config.toast.enabled },
            };
            await updatePreferencesConfig(newConfig);
            setSettingsFlow({ ...settingsFlow, config: newConfig });
          } else if (selected === 'min-duration') {
            const currentSec = Math.round(settingsFlow.config.minCommandDurationMs / 1000);
            setSettingsFlow({ type: 'edit-duration', value: String(currentSec), config: settingsFlow.config });
          } else if (selected === 'hold-duration') {
            const currentSec = Math.round(settingsFlow.config.toast.holdWhenIdleMs / 1000);
            setSettingsFlow({ type: 'edit-hold-duration', value: String(currentSec), config: settingsFlow.config });
          } else if (selected === 'types') {
            setSettingsFlow({ type: 'types-menu', selectedIndex: 0, config: settingsFlow.config });
          } else if (selected === 'reset') {
            await updatePreferencesConfig(DEFAULT_NOTIFICATION_CONFIG);
            setSettingsFlow({ ...settingsFlow, config: DEFAULT_NOTIFICATION_CONFIG });
          }
        }
        return;
      }

      if (settingsFlow.type === 'types-menu') {
        const typeKeys: (keyof NotificationTypeConfig)[] = ['exit', 'idle', 'bell', 'title', 'osc'];
        const menuItems = [...typeKeys, 'back'];

        if (key.name === 'up' || key.raw === 'k') {
          setSettingsFlow({
            ...settingsFlow,
            selectedIndex: Math.max(0, settingsFlow.selectedIndex - 1),
          });
        } else if (key.name === 'down' || key.raw === 'j') {
          setSettingsFlow({
            ...settingsFlow,
            selectedIndex: Math.min(menuItems.length - 1, settingsFlow.selectedIndex + 1),
          });
        } else if (key.name === 'return') {
          if (settingsFlow.selectedIndex === menuItems.length - 1) {
            // Back
            setSettingsFlow({ type: 'main-menu', selectedIndex: 4, config: settingsFlow.config });
          } else {
            // Toggle type
            const typeKey = typeKeys[settingsFlow.selectedIndex];
            if (typeKey) {
              const newConfig = {
                ...settingsFlow.config,
                types: { ...settingsFlow.config.types, [typeKey]: !settingsFlow.config.types[typeKey] },
              };
              await updatePreferencesConfig(newConfig);
              setSettingsFlow({ ...settingsFlow, config: newConfig });
            }
          }
        }
        return;
      }

      if (settingsFlow.type === 'edit-duration' || settingsFlow.type === 'edit-hold-duration') {
        if (key.name === 'return') {
          const num = parseInt(settingsFlow.value, 10);
          if (!isNaN(num) && num >= 0) {
            const newConfig = settingsFlow.type === 'edit-duration'
              ? { ...settingsFlow.config, minCommandDurationMs: num * 1000 }
              : { ...settingsFlow.config, toast: { ...settingsFlow.config.toast, holdWhenIdleMs: num * 1000 } };
            await updatePreferencesConfig(newConfig);
            setSettingsFlow({ type: 'main-menu', selectedIndex: settingsFlow.type === 'edit-duration' ? 2 : 3, config: newConfig });
          }
        } else if (key.name === 'backspace') {
          setSettingsFlow({
            ...settingsFlow,
            value: settingsFlow.value.slice(0, -1),
          });
        } else {
          const chunk = getKeyboardInputChunk(key);
          if (!chunk) {
            return;
          }
          const digits = getNumericInputChunk(chunk);
          if (!digits) {
            return;
          }
          setSettingsFlow({
            ...settingsFlow,
            value: settingsFlow.value + digits,
          });
        }
        return;
      }

      return;
    }

    // Inbox view keyboard handling
    if (state.view === 'inbox') {
      const handled = await handleInboxCommand({
        name: key.name,
        raw: key.raw,
        shift: key.shift,
      });
      if (handled) {
        return;
      }
      return;
    }

    // Workspace detail view: q goes back to kanban board.
    // Escape is handled by the WorkspaceDetailScreen component itself (onBack prop)
    // to allow internal focus management (closing pickers, releasing terminal, etc.)
    if (state.view === 'workspace-detail') {
      if (key.raw === 'q') {
        dispatch({ type: 'SET_VIEW', view: 'projects' });
      }
      // All other keys (including Escape) are handled by WorkspaceDetailScreen
      return;
    }

    if (state.view === 'projects') {
      const moveFocusedLane = (delta: number) => {
        const laneCount = Math.max(1, workspaceBoardState.groups.length);
        const nextIndex = delta < 0
          ? focusedLaneIndex <= 0
            ? laneCount - 1
            : focusedLaneIndex - 1
          : focusedLaneIndex >= laneCount - 1
            ? 0
            : focusedLaneIndex + 1;
        setFocusedLaneIndex(nextIndex);
        handleBoardSelectWorkspace(
          workspaceBoardState.groups[nextIndex]?.workspaces[0]?.selectionKey ?? null
        );
      };

      // Tab cycles lanes only; command palette is Ctrl+Shift+P only
      if (key.name === 'tab') {
        moveFocusedLane(key.shift ? -1 : 1);
        return;
      }

      if (key.shift && (key.name === 'left' || key.name === 'right')) {
        const change = getShiftArrowPhaseChange({
          groups: workspaceBoardState.groups,
          selectedWorkspaceId: workspaceBoardState.selectedWorkspaceId,
          direction: key.name === 'left' ? -1 : 1,
        });
        if (change) {
          workspaceBoardState.setPhase(change.workspaceKey, change.phase);
        }
        return;
      }

      if (key.name === 'left') {
        moveFocusedLane(-1);
        return;
      }

      if (key.name === 'right') {
        moveFocusedLane(1);
        return;
      }

      // Workspaces panel
        const laneWorkspaces =
          workspaceBoardState.groups[focusedLaneIndex]?.workspaces ?? [];
        const moveLaneSelection = (delta: number) => {
          if (laneWorkspaces.length === 0) return;
          const currentIndex = laneWorkspaces.findIndex(
            (w) => w.selectionKey === workspaceBoardState.selectedWorkspaceId
          );
          const nextIndex =
            currentIndex < 0
              ? delta >= 0
                ? 0
                : laneWorkspaces.length - 1
              : Math.max(0, Math.min(laneWorkspaces.length - 1, currentIndex + delta));
          handleBoardSelectWorkspace(laneWorkspaces[nextIndex]?.selectionKey ?? null);
        };
        const command = resolveSessionBrowserCommand({
          name: key.name,
          raw: key.raw,
          shift: key.shift,
        });

        if (command === 'move-up') {
          moveLaneSelection(-1);
        } else if (command === 'move-down') {
          moveLaneSelection(1);
        } else if (command === 'activate') {
          if (laneWorkspaces.length > 0) {
            const currentIndex = laneWorkspaces.findIndex(
              (w) => w.selectionKey === workspaceBoardState.selectedWorkspaceId
            );
            const targetEntry =
              currentIndex >= 0
                ? laneWorkspaces[currentIndex]
                : laneWorkspaces[0];
            handleBoardSelectWorkspace(targetEntry?.selectionKey ?? null);
            // Always navigate to workspace-detail; sessions are managed
            // from the sidebar once the workspace detail view is open.
            dispatch({ type: 'SET_VIEW', view: 'workspace-detail' });
          }
        } else if (command === 'new') {
          // In workspaces panel, 'n' always creates new workspace
          // Sessions are created via expand (Enter) → "+ New session" (Enter)
          lifecycleController.openCreateWorkspaceFlow(selectedWorkspaceProjectName);
        } else if (command === 'bundle') {
          // Requires a workspace to be selected on the board
          const selectedId = workspaceBoardState.selectedWorkspaceId;
          if (selectedId) {
            const entry = laneWorkspaces.find((w) => w.selectionKey === selectedId);
            if (entry) {
              await handleManageBundleConfig({ workspaceId: entry.id });
            }
          }
        } else if (command === 'delete') {
          // Requires a workspace to be selected on the board
          const selectedId = workspaceBoardState.selectedWorkspaceId;
          if (selectedId) {
            const entry = laneWorkspaces.find((w) => w.selectionKey === selectedId);
            if (entry) {
              const workspace = workspaceInfos.find((item) => item.id === entry.id);
              if (workspace) {
                handleDeleteWorkspace(workspace);
              }
            }
          }
        } else if (command === 'refresh') {
          try {
            await spacesBrowserProps.refresh();
          } catch (error) {
            flow.showMessage({
              title: 'Refresh Failed',
              message: error instanceof Error ? error.message : String(error),
              variant: 'error',
            });
          }
        } else if (command === 'toggle-hidden') {
          setShowDismissedReplays((value) => {
            const next = !value;
            multi.listReplays(undefined, next);
            return next;
          });
        } else if (command === 'back') {
          if (workspaceController.selectedRef) {
            handleBoardSelectWorkspace(null);
          } else {
            onQuit?.();
          }
        }
      return;
    }
  });

  useEffect(() => {
    if (!sessionSwitchingRef.current) {
      return;
    }

    if (state.view === 'projects' || state.view === 'inbox') {
      sessionSwitchingRef.current = false;
      return;
    }

    if (state.view === 'terminal' && localSessionMode === 'attached') {
      sessionSwitchingRef.current = false;
    }
  }, [localSessionMode, state.view]);

  useEffect(() => {
    if (localSessionMode === 'browsing') {
      setAttachedAgentSession(null);
    }
  }, [localSessionMode]);

  // Keep local terminal view in sync with backend session lifecycle.
  useEffect(() => {
    const action = resolveLocalTerminalSyncAction({
      isLocalMachineContext: true,
      view: state.view,
      localSessionStatus,
      localSessionMode,
      localScriptState,
      isSessionSwitching: sessionSwitchingRef.current,
    });

    if (action === 'show-connection-error') {
      dispatch({ type: 'SET_VIEW', view: 'projects' });
      dispatch({ type: 'SET_ERROR', error: 'Local session connection failed' });
      return;
    }

    if (action === 'return-to-projects') {
      dispatch({ type: 'SET_VIEW', view: 'projects' });
      void refreshWorkspaces();
    }
  }, [
    localScriptState,
    localSessionMode,
    localSessionStatus,
    refreshWorkspaces,
    state.view,
  ]);

  // ========== Render ==========

  // Loading state
  if (state.isLoading || localSessionStatus === 'connecting') {
    return (
      <Fragment>
        <Toaster position="top-right" />
        <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={COLORS.loading}>
            {localSessionStatus === 'connecting'
              ? 'Starting local machine runtime...'
              : 'Loading...'}
          </text>
        </box>
      </Fragment>
    );
  }

  // Error state
  if (state.error) {
    return (
      <Fragment>
        <Toaster position="top-right" />
        <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={COLORS.error}>Error: {state.error}</text>
          <text fg={COLORS.textDim} marginTop={1}>Press 'q' to quit</text>
        </box>
      </Fragment>
    );
  }

  // Events view
  if (state.view === 'events') {
    return (
      <Fragment>
        <Toaster position="top-right" />
        <EventsTui {...eventsProps} />
        <FlowTUI flow={flow} />
        <StatusBar hint="[Esc/q] Back  [j/k] Navigate" rightHint={keyboardModeHint} />
      </Fragment>
    );
  }

  if (state.view === 'replay' && activeReplay) {
    return (
      <Fragment>
        <Toaster position="top-right" />
        <ReplayTerminal
          replay={activeReplay}
          loadReplayFrame={loadReplayFrame}
          loadReplayTimeline={loadReplayTimeline}
          onBack={() => {
            setActiveReplay(null);
            dispatch({ type: 'SET_VIEW', view: 'projects' });
          }}
          onDismiss={activeReplay.status === 'running' ? undefined : handleReplayDismiss}
        />
        <FlowTUI flow={flow} />
      </Fragment>
    );
  }

  // Local terminal view (backend-driven attach lifecycle)
  if (state.view === 'scripts') {
    const phase = localScriptState?.phase ?? 'pre';
    const isRunning = localScriptState?.isRunning ?? true;
    const scriptHint = isRunning
      ? '[Running scripts... c: cancel + attach anyway]'
      : localScriptState?.error
        ? '[←/→ or [/] Phase  [↑/↓ PgUp/PgDn] Scroll  [a] Attach anyway  [Esc/n] Back'
        : '[←/→ or [/] Phase  [↑/↓ PgUp/PgDn] Scroll  [Esc/n] Back';

    return (
      <Fragment>
        <Toaster position="top-right" />
        <box flexDirection="column" flexGrow={1} width="100%" height="100%">
          <ScriptTerminal
            key={lastScriptWorkspaceIdRef.current ?? 'none'}
            phase={phase}
            workspaceName={scriptWorkspaceName}
            isRunning={isRunning}
            error={localScriptState?.error}
            exitCode={localScriptState?.exitCode}
            modalOpen={flow.isOpen}
            setWriteCallback={setLocalScriptWriteCallback}
          />
          <StatusBar hint={scriptHint} rightHint={keyboardModeHint} />
          {!isRunning && <FlowTUI flow={flow} />}
        </box>
      </Fragment>
    );
  }

  // Local terminal view (backend-driven attach lifecycle)
  if (state.view === 'terminal') {
    const sessionLabel = localAttachedSessionName
      ?? (localScriptState?.isRunning
        ? `Preparing session (${localScriptState.phase})`
        : 'Connecting session');

    return (
      <Fragment>
        <Toaster position="top-right" />
        <SessionTerminal
          sessionName={sessionLabel}
          processTitle={localAttachedSessionMeta?.processTitle ?? null}
          terminalTitle={localAttachedSessionMeta?.terminalTitle ?? null}
          lastAlertLabel={localAttachedSessionMeta?.lastAlertKind
            ? `${localAttachedSessionMeta.lastAlertKind}${localAttachedSessionMeta.unreadAlertCount ? ` (${localAttachedSessionMeta.unreadAlertCount})` : ''}`
            : null}
          endpointLabel="local"
          onData={sendLocalPty}
          onResize={resizeLocalPty}
          onDetach={handleTerminalDetach}
          setWriteCallback={setLocalWriteCallback}
          interceptShiftTab={!!notifications.activeToast}
          modalOpen={flow.isOpen}
          onActivity={handleTerminalActivity}
          readOnly={isViewOnlySession}
        />
        <WorkspaceRemovalTaskBar tasks={workspaceRemovalTasks.tasks} modalOpen={flow.isOpen} />
        <FlowTUI flow={flow} />
      </Fragment>
    );
  }

  // Inbox view (full-screen)
  if (state.view === 'inbox') {
    return (
      <Fragment>
        <Toaster position="top-right" />
        <InboxTUI {...inboxProps} focused={true} />
      </Fragment>
    );
  }

  const machineLabel = 'local';

  // Workspace detail view — full-screen, navigated to from kanban board via Enter
  if (state.view === 'workspace-detail' && selectedWorkspaceForDetail) {
    return (
      <Fragment>
        <Toaster position="top-right" />
        <WorkspaceDetailScreen
          key={selectedWorkspaceForDetail.id}
          workspace={selectedWorkspaceForDetail}
          sessions={detailSessions}
          replays={detailReplays}
          agentSessions={workspaceRuntime.runtimeByWorkspace[selectedWorkspaceForDetail.selectionKey]?.agentSessions ?? []}
          agentSessionCount={workspaceRuntime.runtimeByWorkspace[selectedWorkspaceForDetail.selectionKey]?.agentSessionCount ?? 0}
          pendingPermissions={workspaceRuntime.runtimeByWorkspace[selectedWorkspaceForDetail.selectionKey]?.pendingPermissionCount ?? 0}
           onAttachSession={handleAttachSession}
           onOpenReplay={handleOpenReplay}
           onOpenReplayHistory={handleOpenReplayHistory}
           onStartProcess={handleStartProcess}
          onStartProcessAttach={handleStartProcessAttach}
          onStopProcess={handleStopProcess}
          onEditProcesses={handleEditProcesses}
          onManageBundleConfig={handleManageBundleConfig}
          onOpenGitHubPullRequest={handleOpenGitHubPullRequest}
          onOpenReview={handleOpenReview}
          onLaunchCommit={handleLaunchCommit}
          onOpenEvents={handleOpenEvents}
          onOpenAgentSession={handleOpenAgentSession}
          onCreateAgentSession={handleCreateAgentSession}
          onDeleteSession={handleDeleteSession}
          onClose={() => handleBoardSelectWorkspace(null)}
          machineLabel={machineLabel}
          onBack={() => handleBoardSelectWorkspace(null)}
          onChangeStatus={(_, phase) => workspaceBoardState.setPhase(selectedWorkspaceForDetail.selectionKey, phase)}
          allWorkspaces={allWorkspaceEntries}
          workspaceStatusById={workspaceStatusById}
          runtime={workspaceRuntime.runtimeByWorkspace[selectedWorkspaceForDetail.selectionKey] ?? null}
          onSelectWorkspace={handleSelectWorkspaceFromDetail}
          onKillAgentSession={handleKillAgentSession}
          onStopAgentTurn={handleStopAgentTurn}
          onCloseAgentSession={handleCloseAgentSession}
          onArchiveAgentSession={handleArchiveAgentSession}
          onRestoreAgentSession={handleRestoreAgentSession}
          flow={flow}
          terminalBindings={{
             attachedSessionId: localAttachedSessionId,
             attachedWorkspaceId: localAttachedWorkspaceId,
             attachedAgentSessionId: attachedAgentSession?.sessionId ?? null,
             attachedSessionName: localAttachedSessionName,
             attachedSessionMeta: localAttachedSessionMeta,
             onData: sendLocalPty,
            onResize: resizeLocalPty,
            onDetach: handleTerminalDetach,
            setWriteCallback: setLocalWriteCallback,
            modalOpen: flow.isOpen,
            readOnly: isViewOnlySession || localSessionMode !== 'attached',
          }}
          scriptBindings={{
            workspaceId: lastScriptWorkspaceIdRef.current,
            workspaceName: scriptWorkspaceName,
            scriptState: localScriptState,
            modalOpen: flow.isOpen,
            setWriteCallback: setLocalScriptWriteCallback,
            canAttachAnyway: canAttachLocalAnyway,
            onAttachAnyway: handleAttachLocalAnyway,
          }}
        />
        <WorkspaceRemovalTaskBar tasks={workspaceRemovalTasks.tasks} modalOpen={flow.isOpen} />
        <FlowTUI flow={flow} />
      </Fragment>
    );
  }

  // Fallback: if workspace-detail was requested but no workspace selected yet, go back to board
  if (state.view === 'workspace-detail') {
    dispatch({ type: 'SET_VIEW', view: 'projects' });
  }

  // Main project/workspace view — Figma layout: board header, command bar, then board + detail
  const daemonRightHint = [
    `tmux:${daemonStatus.tmux.running ? '●' : '○'}`,
    `serve:${daemonStatus.serve.running ? '●' : formatRelayStatus(daemonStatus.serve.relayStatus)}`,
    inboxUnreadCount > 0 ? `📥 ${inboxUnreadCount}` : '',
    keyboardModeHint,
  ]
    .filter(Boolean)
    .join('  ');

  return (
    <Fragment>
      <Toaster position="top-right" />
      <box flexDirection="column" flexGrow={1} width="100%">
        {/* Board header: Project Board · N worktrees active */}
        <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1} paddingTop={0} paddingBottom={0}>
          <text fg={COLORS.title}>Project Board</text>
          <text fg={COLORS.textDim}>  ·  </text>
          <text fg={COLORS.textDim}>{totalWorktrees} worktree{totalWorktrees !== 1 ? 's' : ''} active</text>
        </box>

        {/* Persistent command bar - Ctrl+Shift+P only, not in Tab cycle */}
        <box
          flexDirection="row"
          width="100%"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={0}
          paddingBottom={1}
          borderStyle="single"
          borderColor={COLORS.border}
        >
          <text fg={COLORS.textDim}>🔍 Type a command or search...  [Ctrl+Shift+P]</text>
          <box flexGrow={1} />
        </box>

        {/* Main content: board + workspace detail (full width, no sidebar) */}
        <box flexDirection="column" flexGrow={1} width="100%" gap={1} paddingLeft={1} paddingRight={1}>
          <KanbanBoardTUI
            groups={workspaceBoardState.groups}
            selectedWorkspaceId={workspaceBoardState.selectedWorkspaceId}
            onSelectWorkspace={handleBoardSelectWorkspace}
            workspaceStatusById={workspaceStatusById}
            machineLabel={machineLabel}
            focused={true}
            focusedLaneIndex={focusedLaneIndex}
          />
          {/* Detail pane removed: Enter on a card now navigates to 'workspace-detail' view */}
        </box>

        {/* Status bar: hints left, daemon + notifications right */}
        <WorkspaceRemovalTaskBar tasks={workspaceRemovalTasks.tasks} modalOpen={flow.isOpen || commandPalette.isOpen} />
        <StatusBar
          hint="[←→/Tab] Lanes  [↑↓] Select  [Shift+←/→] Move Phase  [Enter] Open  [Ctrl+Shift+P] Palette  [q] Quit"
          rightHint={daemonRightHint}
        />

      {/* Flow modal overlay */}
      <FlowTUI flow={flow} />

      {/* Command palette overlay */}
      {commandPalette.isOpen && (
        <box
          position="absolute"
          top={0}
          left={0}
          width="100%"
          height="100%"
          justifyContent="flex-start"
          alignItems="center"
        >
          <box
            position="absolute"
            top={0}
            left={0}
            width="100%"
            height="100%"
            backgroundColor="#111111"
          />
          <box
            flexDirection="column"
            width="90%"
            borderStyle="single"
            borderColor={COLORS.borderFocused}
            backgroundColor="#1a1a1a"
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            marginTop={1}
            zIndex={10}
          >
            <text fg={COLORS.title}>Command palette</text>
            <text fg={COLORS.textDim}>Filter: {commandPalette.filter || '(none)'}</text>
            <box flexDirection="column" marginTop={1}>
              {commandPalette.filteredCommands.map((cmd, i) => (
                <text
                  key={cmd.id}
                  fg={i === commandPalette.selectedIndex ? COLORS.selected : COLORS.text}
                >
                  {i === commandPalette.selectedIndex ? '▸ ' : '  '}
                  {cmd.label}
                  {cmd.shortcut ? `  ${cmd.shortcut}` : ''}
                </text>
              ))}
            </box>
            <text fg={COLORS.textDim} marginTop={1}>↑/↓ select  Enter run  Esc close</text>
          </box>
        </box>
      )}


      {/* Settings flow modal */}
      <SettingsFlowModal flow={settingsFlow} />
      </box>
    </Fragment>
  );
}

// ============================================================================
// Settings Flow Modal Component
// ============================================================================

function SettingsFlowModal({ flow }: { flow: SettingsFlowState }) {
  if (flow.type === 'closed') {
    return null;
  }

  const modalWidth = 50;
  const modalHeight = flow.type === 'main-menu' ? 14 :
                      flow.type === 'types-menu' ? 12 :
                      8;

  const typeLabels: Record<keyof NotificationTypeConfig, string> = {
    exit: 'Exit (process completion)',
    idle: 'Idle (terminal idle)',
    bell: 'Bell (terminal bell)',
    title: 'Title (title change)',
    osc: 'OSC (escape sequences)',
  };

  return (
    <box
      position="absolute"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
    >
      <box
        flexDirection="column"
        width={modalWidth}
        height={modalHeight}
        borderStyle="rounded"
        borderColor={COLORS.borderFocused}
        backgroundColor="#1a1a2e"
        padding={1}
      >
        {/* Main menu */}
        {flow.type === 'main-menu' && (
          <>
            <text fg={COLORS.title} height={1}>Notification Settings</text>
            <box height={1} />
            <text fg={flow.selectedIndex === 0 ? COLORS.selected : COLORS.text} height={1}>
              {flow.selectedIndex === 0 ? '▸ ' : '  '}{flow.config.enabled ? '✓' : '✗'} Notifications Enabled
            </text>
            <text fg={flow.selectedIndex === 1 ? COLORS.selected : COLORS.text} height={1}>
              {flow.selectedIndex === 1 ? '▸ ' : '  '}{flow.config.toast.enabled ? '✓' : '✗'} Toast Notifications
            </text>
            <text fg={flow.selectedIndex === 2 ? COLORS.selected : COLORS.text} height={1}>
              {flow.selectedIndex === 2 ? '▸ ' : '  '}Min Command Duration: {Math.round(flow.config.minCommandDurationMs / 1000)}s
            </text>
            <text fg={flow.selectedIndex === 3 ? COLORS.selected : COLORS.text} height={1}>
              {flow.selectedIndex === 3 ? '▸ ' : '  '}Toast Hold Duration: {Math.round(flow.config.toast.holdWhenIdleMs / 1000)}s
            </text>
            <text fg={flow.selectedIndex === 4 ? COLORS.selected : COLORS.text} height={1}>
              {flow.selectedIndex === 4 ? '▸ ' : '  '}Notification Types...
            </text>
            <text fg={flow.selectedIndex === 5 ? COLORS.selected : COLORS.text} height={1}>
              {flow.selectedIndex === 5 ? '▸ ' : '  '}↺ Reset to Defaults
            </text>
            <box height={1} />
            <text fg={COLORS.textDim} height={1}>[↑↓] Navigate  [Enter] Toggle/Select  [Esc] Close</text>
          </>
        )}

        {/* Types submenu */}
        {flow.type === 'types-menu' && (
          <>
            <text fg={COLORS.title} height={1}>Notification Types</text>
            <box height={1} />
            {(Object.keys(typeLabels) as Array<keyof NotificationTypeConfig>).map((key, i) => (
              <text key={key} fg={flow.selectedIndex === i ? COLORS.selected : COLORS.text} height={1}>
                {flow.selectedIndex === i ? '▸ ' : '  '}{flow.config.types[key] ? '✓' : '✗'} {typeLabels[key]}
              </text>
            ))}
            <text fg={flow.selectedIndex === 5 ? COLORS.selected : COLORS.text} height={1}>
              {flow.selectedIndex === 5 ? '▸ ' : '  '}← Back
            </text>
            <box height={1} />
            <text fg={COLORS.textDim} height={1}>[↑↓] Navigate  [Enter] Toggle  [Esc] Back</text>
          </>
        )}

        {/* Edit duration */}
        {flow.type === 'edit-duration' && (
          <>
            <text fg={COLORS.title} height={1}>Min Command Duration</text>
            <text fg={COLORS.text} height={1} marginTop={1}>Duration in seconds before exit notification:</text>
            <box
              marginTop={1}
              borderStyle="rounded"
              borderColor={COLORS.border}
              padding={0}
              width="100%"
            >
              <text fg={COLORS.text} height={1}>{flow.value || '0'}_</text>
            </box>
            <text fg={COLORS.textDim} height={1} marginTop={1}>[Enter] Save  [Esc] Cancel</text>
          </>
        )}

        {/* Edit hold duration */}
        {flow.type === 'edit-hold-duration' && (
          <>
            <text fg={COLORS.title} height={1}>Toast Hold Duration</text>
            <text fg={COLORS.text} height={1} marginTop={1}>Hold toasts when idle (seconds, 0 to disable):</text>
            <box
              marginTop={1}
              borderStyle="rounded"
              borderColor={COLORS.border}
              padding={0}
              width="100%"
            >
              <text fg={COLORS.text} height={1}>{flow.value || '0'}_</text>
            </box>
            <text fg={COLORS.textDim} height={1} marginTop={1}>[Enter] Save  [Esc] Cancel</text>
          </>
        )}
      </box>
    </box>
  );
}

// ============================================================================
// Status Bar Helpers
// ============================================================================

function getWorkspacesPanelHint(selectedItem: TreeItem | null | undefined): string {
  if (selectedItem?.type === 'session') {
    return '[Tab] Switch  [Enter] Attach  [x] Kill  [b] Bundle  [n] New Workspace  [h] Hidden  [d] Delete  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'replay') {
    return '[Tab] Switch  [Enter] Open  [d] Dismiss/Restore  [h] Hidden  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'replay-section' || selectedItem?.type === 'orphaned-replay-section') {
    return '[Tab] Switch  [Enter] Expand  [h] Hidden  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'process') {
    if (selectedItem.status === 'running') {
      return '[Tab] Switch  [Enter] View  [x] Stop  [,] Settings  [?] Help  [q] Quit';
    }
    return '[Tab] Switch  [Enter] Start  [b] Bundle  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'workspace') {
    return '[Tab] Switch  [Enter] Expand  [b] Bundle  [n] New Workspace  [d] Delete  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'process-disabled') {
    return '[Tab] Switch  [Enter] Disabled  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'process-config-error') {
    return '[Tab] Switch  [Enter] Fix Process Config  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'edit-processes') {
    return '[Tab] Switch  [Enter] Edit Processes Config  [b] Bundle  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'bundle-config') {
    return '[Tab] Switch  [Enter] Edit Bundle Config  [b] Bundle  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'agents') {
    return '[Tab] Switch  [Enter] Agent Sessions  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'events') {
    return '[Tab] Switch  [Enter] Open Events  [b] Bundle  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'new-session') {
    return '[Tab] Switch  [Enter] New Session  [b] Bundle  [,] Settings  [?] Help  [q] Quit';
  }
  return '[Tab] Switch  [Enter] Open  [b] Bundle  [n] New Workspace  [,] Settings  [?] Help  [q] Quit';
}

// ============================================================================
// Status Bar Component
// ============================================================================

function StatusBar({ hint, rightHint }: { hint: string; rightHint?: string }) {
  return (
    <box width="100%" height={1} backgroundColor={COLORS.statusBar} flexDirection="row" paddingLeft={1} paddingRight={1}>
      <box flexGrow={1}>
        <text fg={COLORS.textDim}>{hint}</text>
      </box>
      {!!rightHint && <text fg={COLORS.textDim}>{rightHint}</text>}
    </box>
  );
}

type RequestedKeyboardMode = 'auto' | 'kitty' | 'vt';
type ResolvedKeyboardMode = 'kitty' | 'vt';

const TUI_KEYBOARD_MODE_ENV = 'GSSH_TUI_KEYBOARD_MODE';

function resolveRequestedKeyboardMode(): RequestedKeyboardMode {
  const raw = process.env[TUI_KEYBOARD_MODE_ENV]?.trim().toLowerCase();
  if (!raw) {
    return 'auto';
  }

  if (raw === 'auto' || raw === 'kitty' || raw === 'vt') {
    return raw;
  }

  logger.warning(
    `Ignoring invalid ${TUI_KEYBOARD_MODE_ENV}=${JSON.stringify(raw)} (expected auto|kitty|vt)`
  );
  return 'auto';
}

function looksLikeKittyEnterLeak(buffer: string): boolean {
  return (
    /\x1b\[(?:13|127)(?::\d+)*(?:;\d+(?::\d+)*)?u$/.test(buffer) ||
    /;(?:\d+(?::\d+)*)u$/.test(buffer)
  );
}

async function createRendererForKeyboardMode(mode: ResolvedKeyboardMode) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    useMouse: true,
    useKittyKeyboard: mode === 'vt' ? VT_KITTY_KEYBOARD_CONFIG : undefined,
  });

  if (mode === 'vt') {
    forceDisableKittyKeyboard(renderer);
  }

  return renderer;
}

function KeyboardWelcomeGate({
  requestedMode,
  onResolve,
}: {
  requestedMode: RequestedKeyboardMode;
  onResolve: (mode: ResolvedKeyboardMode) => void;
}) {
  const resolvedRef = useRef(false);
  const observedBufferRef = useRef('');
  const preferredMode: ResolvedKeyboardMode = requestedMode === 'vt' ? 'vt' : 'kitty';

  const resolveOnce = useCallback((mode: ResolvedKeyboardMode) => {
    if (resolvedRef.current) {
      return;
    }

    resolvedRef.current = true;
    onResolve(mode);
  }, [onResolve]);

  useKeyboard((key) => {
    if (resolvedRef.current) {
      return;
    }

    if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed') {
      key.preventDefault?.();
      resolveOnce(preferredMode);
      return;
    }

    if (requestedMode !== 'auto') {
      return;
    }

    const chunk = key.raw || key.sequence || '';
    if (!chunk) {
      return;
    }

    observedBufferRef.current = (observedBufferRef.current + chunk).slice(-128);
    if (looksLikeKittyEnterLeak(observedBufferRef.current)) {
      key.preventDefault?.();
      resolveOnce('vt');
    }
  });

  const modeText =
    requestedMode === 'auto'
      ? 'auto (trying kitty first)'
      : requestedMode === 'kitty'
        ? 'kitty (forced)'
        : 'vt compatibility (forced)';

  return (
    <box width="100%" height="100%" justifyContent="center" alignItems="center">
      <box flexDirection="column" alignItems="center" gap={1} borderStyle="rounded" borderColor={COLORS.border} paddingLeft={3} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <text fg={COLORS.title}>Welcome to GitSpace</text>
        <text fg={COLORS.text}>Press Enter to start</text>
        <text fg={COLORS.textDim}>Keyboard mode: {modeText}</text>
        {requestedMode === 'auto' && (
          <text fg={COLORS.textDim}>If Enter decoding looks broken, we auto-switch to VT mode.</text>
        )}
      </box>
    </box>
  );
}

// ============================================================================
// Entry Point
// ============================================================================


export async function launchTUI(
  relayConfig?: RelayDescriptor,
  options: { ignoreKeychainAndSkipSecrets?: boolean; remoteIdentity?: Identity | null } = {}
): Promise<void> {
  await initializeSecretRuntime({
    ignoreKeychainAndSkipSecrets: options.ignoreKeychainAndSkipSecrets,
    preloadSecrets: false,
  });

  const requestedKeyboardMode = resolveRequestedKeyboardMode();
  const initialKeyboardMode: ResolvedKeyboardMode = requestedKeyboardMode === 'vt' ? 'vt' : 'kitty';

  let renderer = await createRendererForKeyboardMode(initialKeyboardMode);
  let root = createRoot(renderer);
  let activeRenderer = renderer;

  // Clean exit handler
  const handleQuit = () => {
    activeRenderer.destroy();

    const legacyReminder = consumeLegacyCleanupReminderForTui();
    if (legacyReminder) {
      logger.warning(legacyReminder);
    }

    process.exit(0);
  };

  // Handle SIGINT
  process.on('SIGINT', handleQuit);

  // Cleanup on exit
  process.on('exit', () => {
    // Reset terminal state
    process.stdout.write('\x1b[?25h'); // Show cursor
    process.stdout.write('\x1b[?1049l'); // Exit alternate screen
    process.stdout.write('\x1b[0m'); // Reset colors
  });

  const resolvedKeyboardMode = await new Promise<ResolvedKeyboardMode>((resolve) => {
    root.render(
      <KeyboardWelcomeGate
        requestedMode={requestedKeyboardMode}
        onResolve={(mode) => resolve(mode)}
      />
    );
    activeRenderer.start();
  });

  if (
    requestedKeyboardMode === 'auto' &&
    resolvedKeyboardMode === 'vt' &&
    initialKeyboardMode !== 'vt'
  ) {
    activeRenderer.destroy();
    renderer = await createRendererForKeyboardMode('vt');
    activeRenderer = renderer;
    root = createRoot(renderer);
    root.render(
      <App
        relayConfig={relayConfig}
        remoteIdentity={options.remoteIdentity}
        onQuit={handleQuit}
        keyboardMode={resolvedKeyboardMode}
      />,
    );
    renderer.start();
    return;
  }

  root.render(
    <App
      relayConfig={relayConfig}
      remoteIdentity={options.remoteIdentity}
      onQuit={handleQuit}
      keyboardMode={resolvedKeyboardMode}
    />,
  );
}
