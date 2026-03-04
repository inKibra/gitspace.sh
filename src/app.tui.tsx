/**
 * TUI Application v2 - Using Shared Components
 *
 * Clean implementation using shared hooks and components:
 * - useFlow for modal system
 * - useMachineList for machine selection
 * - useSpacesBrowser for workspace browsing
 * - useProjectList for project selection
 */

import { createCliRenderer } from '@opentui/core';
import type { PasteEvent } from '@opentui/core';
import { createRoot, useKeyboard, useRenderer } from '@opentui/react';
import { useState, useEffect, useCallback, useReducer, Fragment, useRef } from 'react';
import { Toaster } from '@opentui-ui/toast/react';

// Terminal components
import { SessionTerminal } from './components/SessionTerminal.tui.js';
import { RemoteMachineScreen } from './components/RemoteMachineScreen.tui.js';
import { ScriptTerminal, type ScriptTerminalHandle } from './components/ScriptTerminal.tui.js';
import { ProjectOnboardingStepTUI } from './components/ProjectOnboardingStep.tui.js';

// Shared components and hooks
import {
  useFlow,
  useMachineList,
  useSpacesBrowser,
  useProjectList,
  getDefaultShortcuts,
  isFlowInput,
  isFlowConfirmTyped,
  isFlowWizard,
  type MachineInfo,
  type ProjectInfo,
} from './components/index.js';
import { FlowTUI } from './components/Flow.tui.js';
import { MachineListTUI } from './components/MachineList.tui.js';
import { SpacesBrowserTUI } from './components/SpacesBrowser.tui.js';
import type { TreeItem } from './components/SpacesBrowser.js';
import { ProjectListTUI } from './components/ProjectList.tui.js';
import { InboxTUI } from './components/Inbox.tui.js';
import { useInbox } from './components/Inbox.js';
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
import { useDaemonStatus, formatUptime, formatRelayStatus } from './hooks/useDaemonStatus.tui.js';
import {
  setCurrentProject,
  readProjectConfig,
  getProjectBaseDir,
  createProject,
  projectExists,
} from './core/config.js';
import { localPreferencesService } from './core/preferences-service.js';
import type { NotificationConfig, NotificationTypeConfig } from './types/config.js';

// Git and workspace operations
import { getDefaultBranch } from './core/git.js';
import { extractRepoName } from './utils/sanitize.js';
import { logger } from './utils/logger.js';

// Script execution
import { listAllRepos, cloneRepository } from './core/github.js';
import { detectBundleInRepo, loadBundleFromPath } from './core/bundle.js';
import { applyProjectBundleState } from './core/project-lifecycle.js';
import { checkCommandExists } from './utils/deps.js';
import type { OnboardingStep } from './types/bundle.js';

// TUI hooks
import { useRemoteMachines, type RelayConfig } from './hooks/useRemoteMachines.tui.js';
import { useLocalSession } from './hooks/useLocalSession.tui.js';
import { useUserActivity } from './hooks/index.js';
import { useBundleRefreshAttachFlow } from './session/index.js';
import { useAttachController } from './app/session/useAttachController.js';
import { useProcessActions } from './app/session/useProcessActions.js';
import { useWorkspaceDeleteFlow } from './app/session/useWorkspaceDeleteFlow.js';
import { useLifecycleController } from './app/session/useLifecycleController.js';
import { buildEditProcessesCommand } from './lib/processes/editor.js';
import { loadProcessesConfigWithDiagnostics } from './lib/processes/config.js';
import {
  consumeLegacyCleanupReminderForTui,
  initializeSecretRuntime,
} from './core/secret-runtime.js';
import {
  resolveInboxCommand,
  resolveMachineListCommand,
  resolveSessionBrowserCommand,
} from './app/input/sessionCommands.js';
import { resolveLocalTerminalSyncAction, type AppView } from './tui/local-terminal-sync.js';
import {
  getKeyboardInputChunk,
  getNumericInputChunk,
  normalizeInputText,
} from './tui/input-text.js';
import {
  VT_KITTY_KEYBOARD_CONFIG,
  forceDisableKittyKeyboard,
} from './tui/kitty-keyboard.js';

// Types
import type { InboxItem } from './lib/tmux-lite/cli.js';

// ============================================================================
// Workspace Flow Types (Custom State Machine)
// ============================================================================

/** Project flow states - explicit state machine for project creation */
type ProjectFlowState =
  | { type: 'closed' }
  | { type: 'loading-repos' }
  | { type: 'repo-select'; repos: string[]; selectedIndex: number }
  | { type: 'cloning'; repo: string }
  | { type: 'onboarding';
      repo: string;
      projectName: string;
      baseBranch: string;
      bundleDir: string;
      bundleName: string;
      steps: OnboardingStep[];
      currentStep: number;
      collectedValues: Record<string, string>;
      collectedSecrets: Record<string, string>;
      inputValue: string;
      confirmStatus?: 'checking' | 'found' | 'missing' | null;
    }
  | { type: 'creating'; projectName: string };

/** Settings flow states - explicit state machine for settings modal */
type SettingsFlowState =
  | { type: 'closed' }
  | { type: 'main-menu'; selectedIndex: number; config: NotificationConfig }
  | { type: 'types-menu'; selectedIndex: number; config: NotificationConfig }
  | { type: 'edit-duration'; value: string; config: NotificationConfig }
  | { type: 'edit-hold-duration'; value: string; config: NotificationConfig };

// ============================================================================
// Constants
// ============================================================================

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

// ASCII art header
const ASCII_LINES = [
  { text: '╔══════════════════════════════════════════════════════════════╗', color: COLORS.asciiBox },
  { text: '║                                                              ║', color: COLORS.asciiBox },
  { text: '║   ███████╗██████╗  █████╗  ██████╗███████╗███████╗           ║', color: COLORS.gradient1 },
  { text: '║   ██╔════╝██╔══██╗██╔══██╗██╔════╝██╔════╝██╔════╝           ║', color: COLORS.gradient2 },
  { text: '║   ███████╗██████╔╝███████║██║     █████╗  ███████╗           ║', color: COLORS.gradient3 },
  { text: '║   ╚════██║██╔═══╝ ██╔══██║██║     ██╔══╝  ╚════██║           ║', color: COLORS.gradient4 },
  { text: '║   ███████║██║     ██║  ██║╚██████╗███████╗███████║           ║', color: COLORS.gradient5 },
  { text: '║   ╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝╚══════╝╚══════╝           ║', color: COLORS.gradient6 },
  { text: '║                                                              ║', color: COLORS.asciiBox },
  { text: '║                    worktree manager                          ║', color: COLORS.subtitle },
  { text: '║                                                              ║', color: COLORS.asciiBox },
  { text: '╚══════════════════════════════════════════════════════════════╝', color: COLORS.asciiBox },
];

// ============================================================================
// App State
// ============================================================================

type PanelFocus = 'projects' | 'workspaces';

interface AppState {
  view: AppView;
  panelFocus: PanelFocus;
  selectedMachine: MachineInfo | null;
  isLoading: boolean;
  error: string | null;
}

type AppAction =
  | { type: 'SET_VIEW'; view: AppView }
  | { type: 'SET_PANEL_FOCUS'; focus: PanelFocus }
  | { type: 'SET_MACHINE'; machine: MachineInfo | null }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SWITCH_PANEL' };

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_VIEW':
      return { ...state, view: action.view };
    case 'SET_PANEL_FOCUS':
      return { ...state, panelFocus: action.focus };
    case 'SET_MACHINE':
      return { ...state, selectedMachine: action.machine };
    case 'SET_LOADING':
      return { ...state, isLoading: action.loading };
    case 'SET_ERROR':
      return { ...state, error: action.error };
    case 'SWITCH_PANEL':
      return { ...state, panelFocus: state.panelFocus === 'projects' ? 'workspaces' : 'projects' };
    default:
      return state;
  }
}

// ============================================================================
// Props
// ============================================================================

export interface AppProps {
  relayConfig?: RelayConfig;
  onQuit?: () => void;
  keyboardMode: 'kitty' | 'vt';
}

// ============================================================================
// Main App Component
// ============================================================================

function App({ relayConfig, onQuit, keyboardMode }: AppProps) {
  const isRemoteMode = !!relayConfig;
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
    view: isRemoteMode ? 'machines' : 'projects',
    panelFocus: 'projects',
    selectedMachine: null,
    isLoading: true,
    error: null,
  });

  // Track when we're switching sessions (to prevent detach handler from navigating away)
  const sessionSwitchingRef = useRef(false);
  const scriptTerminalRef = useRef<ScriptTerminalHandle | null>(null);
  const lastScriptWorkspaceIdRef = useRef<string | null>(null);
  const renderer = useRenderer();

  // Shared Flow hook (for non-workspace flows)
  const flow = useFlow({
    onError: (error) => dispatch({ type: 'SET_ERROR', error: error.message }),
  });

  const [scriptWorkspaceName, setScriptWorkspaceName] = useState<string>('workspace');

  // Project creation flow (custom state machine)
  const [projectFlow, setProjectFlow] = useState<ProjectFlowState>({ type: 'closed' });

  // Settings flow (custom state machine)
  const [settingsFlow, setSettingsFlow] = useState<SettingsFlowState>({ type: 'closed' });
  const [notificationConfig, setNotificationConfig] = useState<NotificationConfig>(DEFAULT_NOTIFICATION_CONFIG);

  // Events view state
  const [eventsWorkspaceId, setEventsWorkspaceId] = useState<string | null>(null);

  // View-only session state (true when attached to a running process session)
  const [isViewOnlySession, setIsViewOnlySession] = useState(false);
  const [pendingProcessEditWorkspaceId, setPendingProcessEditWorkspaceId] = useState<string | null>(null);
  const pendingProcessEditWorkspacesRef = useRef<unknown[] | null>(null);

  // Remote machines hook
  const remoteMachines = useRemoteMachines({
    relayConfig,
    onError: (error) => dispatch({ type: 'SET_ERROR', error: error.message }),
  });

  const isLocalMachineContext = !isRemoteMode || state.selectedMachine?.machineId === 'local';

  // Local machine session engine hook
  const localSession = useLocalSession({ enabled: isLocalMachineContext });
  const {
    status: localSessionStatus,
    mode: localSessionMode,
    requestProjects: requestLocalProjects,
    listGithubRepos: listLocalGithubRepos,
    listRemoteBranches: listLocalRemoteBranches,
    listLinearIssues: listLocalLinearIssues,
    requestWorkspaces: requestLocalWorkspaces,
    requestSessions: requestLocalSessions,
    createProject: createLocalProject,
    createWorkspace: createLocalWorkspace,
    deleteProject: deleteLocalProject,
    requestInbox: requestLocalInbox,
    clearInbox: clearLocalInbox,
    markInboxRead: markLocalInboxRead,
    attachSession: attachLocalSession,
    detachSession: detachLocalSession,
    cancelPendingScripts: cancelLocalPendingScripts,
    killSession: killLocalSession,
    deleteWorkspace: deleteLocalWorkspace,
    send: sendLocalPty,
    resize: resizeLocalPty,
    setWriteCallback: setLocalWriteCallback,
    projects: localProjects,
    workspaces: localWorkspaces,
    sessions: localSessions,
    inbox: localInbox,
    inboxUnreadCount: localInboxUnreadCount,
    attachedSessionId: localAttachedSessionId,
    attachedSessionName: localAttachedSessionName,
    scriptState: localScriptState,
    commandError: localCommandError,
    getBundleRefreshPlan: getLocalBundleRefreshPlan,
    applyBundleRefresh: applyLocalBundleRefresh,
    startProcess: startLocalProcess,
    stopProcess: stopLocalProcess,
    requestEvents: requestLocalEvents,
    events: localEvents,
    liveEventIds: localLiveEventIds,
    savedEventFilters: localSavedEventFilters,
  } = localSession;

  const currentProject =
    localProjects.find((project) => project.isCurrent)?.name ?? localProjects[0]?.name ?? null;

  const getLocalAttachSize = useCallback(() => {
    let cols = process.stdout.columns || 0;
    let rows = process.stdout.rows || 0;
    if (cols <= 0 || rows <= 0) {
      const size = (process.stdout as { getWindowSize?: () => number[] }).getWindowSize?.();
      if (Array.isArray(size) && size.length >= 2) {
        cols = size[0];
        rows = size[1];
      }
    }

    return {
      cols: cols > 0 ? cols : 80,
      rows: Math.max(1, (rows > 0 ? rows : 24) - 1),
    };
  }, []);

  const bundleRefreshAttach = useBundleRefreshAttachFlow({
    flow,
    commandError: localCommandError,
    attachSession: (params) => attachLocalSession(params),
    getBundleRefreshPlan: getLocalBundleRefreshPlan,
    applyBundleRefresh: applyLocalBundleRefresh,
    resolveProjectName: (workspaceId) => {
      const separator = workspaceId.indexOf(':');
      if (separator > 0) {
        return workspaceId.slice(0, separator);
      }
      return currentProject;
    },
  });

  const {
    attach: attachLocal,
    attachFromSelection: attachLocalFromSelection,
  } = useAttachController({
    flow,
    attachSessionWithBundleRefresh: bundleRefreshAttach.attachSessionWithBundleRefresh,
    defaultProjectName: currentProject,
    getAttachSize: getLocalAttachSize,
    resolveProjectName: (workspaceId) => {
      const separator = workspaceId.indexOf(':');
      if (separator > 0) {
        return workspaceId.slice(0, separator);
      }
      return currentProject;
    },
    preflightSessionAttach: async (sessionId) => {
      const sessionInfo = localSessions.find((session) => session.id === sessionId);
      if (!sessionInfo) {
        await refreshWorkspaces();
        dispatch({ type: 'SET_ERROR', error: 'Session no longer exists. The session list has been refreshed.' });
        return false;
      }

      if (!sessionInfo.attached) {
        return true;
      }

      return new Promise<boolean>((resolve) => {
        flow.showConfirm({
          title: 'Session In Use',
          message: 'This session is currently attached. Steal it?',
          variant: 'warning',
          confirmLabel: 'Steal',
          onConfirm: () => {
            resolve(true);
          },
          onCancel: () => {
            resolve(false);
          },
        });
      });
    },
    onBeforeAttach: ({ target, params }) => {
      sessionSwitchingRef.current = true;

      if (target === 'workspace' && params.workspaceId && !params.command) {
        lastScriptWorkspaceIdRef.current = params.workspaceId;
        setScriptWorkspaceName(params.workspaceId.split(':').slice(-1)[0] ?? params.workspaceId);
        dispatch({ type: 'SET_VIEW', view: 'scripts' });
      }
    },
    onAttachSuccess: () => {
      dispatch({ type: 'SET_VIEW', view: 'terminal' });
    },
    onAttachCancelled: ({ target }) => {
      if (target === 'workspace') {
        return;
      }
      dispatch({ type: 'SET_VIEW', view: 'projects' });
    },
    onAttachError: ({ target, message }) => {
      const isWorkspaceScriptFailure = message.startsWith('Workspace scripts failed during');
      const showScriptView = target === 'workspace';

      if (!isWorkspaceScriptFailure || !showScriptView) {
        dispatch({ type: 'SET_VIEW', view: 'projects' });
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
    deleteWorkspace: deleteLocalWorkspace,
    onBeforeDelete: ({ target }) => {
      setScriptWorkspaceName(target.workspaceName);
      dispatch({ type: 'SET_VIEW', view: 'scripts' });
    },
    onDeleteSuccess: async () => {
      dispatch({ type: 'SET_VIEW', view: 'projects' });
      await refreshWorkspaces();
    },
    onDeleteError: async ({ message }) => {
      dispatch({ type: 'SET_VIEW', view: 'projects' });
      flow.showMessage({
        title: 'Delete Failed',
        message,
        variant: 'error',
      });
    },
  });

  // Daemon status hook (tmux-lite and serve)
  const { status: daemonStatus } = useDaemonStatus({ pollInterval: 5000 });

  // Load persisted notification preferences.
  useEffect(() => {
    let mounted = true;
    void localPreferencesService.getNotificationConfig().then((config) => {
      if (mounted) {
        setNotificationConfig(config);
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

  // ========== Data Loading ==========

  // Load projects
  const refreshProjects = useCallback(async () => {
    if (!isLocalMachineContext) {
      return;
    }
    await requestLocalProjects();
  }, [isLocalMachineContext, requestLocalProjects]);

  // Load workspaces for current project
  const refreshWorkspaces = useCallback(async () => {
    if (!isLocalMachineContext) {
      return;
    }
    await Promise.all([
      requestLocalWorkspaces(),
      requestLocalSessions(),
    ]);
  }, [isLocalMachineContext, requestLocalSessions, requestLocalWorkspaces]);

  // Load inbox
  const refreshInbox = useCallback(async () => {
    if (!isLocalMachineContext) {
      return;
    }
    await requestLocalInbox();
  }, [isLocalMachineContext, requestLocalInbox]);

  const lifecycleController = useLifecycleController({
    flow,
    listGithubRepos: listLocalGithubRepos,
    listRemoteBranches: listLocalRemoteBranches,
    listLinearIssues: listLocalLinearIssues,
    createProject: createLocalProject,
    createWorkspace: createLocalWorkspace,
    deleteProject: deleteLocalProject,
    getProjectNames: () => localProjects.map((project) => project.name),
    refreshProjects,
    refreshWorkspaces,
    refreshSessions: requestLocalSessions,
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

  // Select a project
  const handleSelectProject = useCallback((project: ProjectInfo) => {
    setCurrentProject(project.name);
    void requestLocalProjects().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[tui] Failed to refresh projects after project select:', message);
    });
    void requestLocalWorkspaces().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[tui] Failed to refresh workspaces after project select:', message);
    });
    void requestLocalSessions().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[tui] Failed to refresh sessions after project select:', message);
    });
    dispatch({ type: 'SET_PANEL_FOCUS', focus: 'workspaces' });
  }, [requestLocalProjects, requestLocalSessions, requestLocalWorkspaces]);

  // Delete project
  const handleDeleteProject = useCallback((project: ProjectInfo) => {
    lifecycleController.openDeleteProjectFlow(project.name);
  }, [lifecycleController]);

  // Attach to session using embedded terminal
  const handleAttachSession = useCallback(async (params: { sessionId?: string; workspaceId?: string; viewOnly?: boolean }) => {
    setIsViewOnlySession(params.viewOnly ?? false);
    await attachLocalFromSelection(params);
  }, [attachLocalFromSelection]);

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
    await detachLocalSession();
    dispatch({ type: 'SET_VIEW', view: 'projects' });
    await refreshWorkspaces();
  }, [detachLocalSession, refreshWorkspaces]);

  // Delete workspace
  const handleDeleteWorkspace = useCallback((workspace: { id: string; name: string; sessionCount: number }) => {
    flow.showConfirmTyped({
      title: 'Delete Workspace',
      message: `Are you sure you want to delete workspace "${workspace.name}"?`,
      confirmText: workspace.name,
      warning: workspace.sessionCount > 0 ? `This will kill ${workspace.sessionCount} active session(s)!` : undefined,
      onConfirm: async () => {
        if (!currentProject) return;
        await deleteWorkspaceWithPrompt({
          projectName: currentProject,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        });
      },
    });
  }, [currentProject, flow, deleteWorkspaceWithPrompt]);

  // Delete session
  const handleDeleteSession = useCallback((sessionId: string, sessionName: string) => {
    flow.showConfirm({
      title: 'Kill Session',
      message: `Kill session "${sessionName}"?`,
      variant: 'warning',
      confirmLabel: 'Kill',
      onConfirm: async () => {
        try {
          await killLocalSession(sessionId);
        } catch (err) {
          dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Failed to kill session' });
        }
      },
    });
  }, [flow, killLocalSession]);

  // ========== Workspace Creation ==========
  const handleNewWorkspaceFlow = useCallback(() => {
    lifecycleController.openCreateWorkspaceFlow(currentProject);
  }, [currentProject, lifecycleController]);

  // ========== Project Creation (Custom State Machine) ==========

  // Finalize project creation
  const finalizeProject = useCallback(async (projectName: string) => {
    setCurrentProject(projectName);
    await refreshProjects();
    setProjectFlow({ type: 'closed' });
    flow.showMessage({
      title: 'Project Created',
      message: `Project "${projectName}" has been created successfully!`,
      variant: 'success',
    });
  }, [refreshProjects, flow]);

  // Check if a command exists (for onboarding confirm steps)
  const checkCommand = useCallback(
    (command: string) => checkCommandExists(command),
    []
  );

  // Advance to the next onboarding step
  const advanceOnboardingStep = useCallback(async () => {
    if (projectFlow.type !== 'onboarding') return;

    const currentStep = projectFlow.steps[projectFlow.currentStep];
    const newValues = { ...projectFlow.collectedValues };
    const newSecrets = { ...projectFlow.collectedSecrets };

    // Save current step's value if applicable
    if (currentStep && (currentStep.type === 'input' || currentStep.type === 'secret')) {
      const stepWithKey = currentStep as { configKey: string; defaultValue?: string };
      const value = projectFlow.inputValue.trim() || stepWithKey.defaultValue || '';

      if (currentStep.type === 'secret') {
        newSecrets[stepWithKey.configKey] = value;
      } else {
        newValues[stepWithKey.configKey] = value;
      }
    }

    const nextStepIndex = projectFlow.currentStep + 1;

    if (nextStepIndex >= projectFlow.steps.length) {
        // All steps done - create the project
        setProjectFlow({ type: 'creating', projectName: projectFlow.projectName });

        try {
          createProject(projectFlow.projectName, projectFlow.repo, projectFlow.baseBranch);

          await applyProjectBundleState({
            projectName: projectFlow.projectName,
            bundle: {
              version: '1.0',
              name: projectFlow.bundleName,
              onboarding: projectFlow.steps,
            },
            inputValues: newValues,
            secretValues: newSecrets,
          });

          await finalizeProject(projectFlow.projectName);
        } catch (err) {
        flow.showMessage({
          title: 'Error',
          message: err instanceof Error ? err.message : 'Failed to create project',
          variant: 'error',
        });
        setProjectFlow({ type: 'closed' });
      }
    } else {
      // Move to next step
      const nextStep = projectFlow.steps[nextStepIndex];

      // If it's a confirm step with checkCommand, start checking
      if (nextStep.type === 'confirm' && (nextStep as { checkCommand?: string }).checkCommand) {
        setProjectFlow({
          ...projectFlow,
          currentStep: nextStepIndex,
          collectedValues: newValues,
          collectedSecrets: newSecrets,
          inputValue: '',
          confirmStatus: 'checking',
        });

        const found = await checkCommand((nextStep as { checkCommand: string }).checkCommand);
        setProjectFlow(prev =>
          prev.type === 'onboarding'
            ? { ...prev, confirmStatus: found ? 'found' : 'missing' }
            : prev
        );
      } else {
        const defaultValue = (nextStep as { defaultValue?: string }).defaultValue || '';
        setProjectFlow({
          ...projectFlow,
          currentStep: nextStepIndex,
          collectedValues: newValues,
          collectedSecrets: newSecrets,
          inputValue: defaultValue,
          confirmStatus: null,
        });
      }
    }
  }, [projectFlow, checkCommand, finalizeProject, flow]);

  // Handle repository selection
  const handleSelectRepo = useCallback(async (repo: string) => {
    const projectName = extractRepoName(repo);

    // Check if project already exists
    if (projectExists(projectName)) {
      flow.showMessage({
        title: 'Project Exists',
        message: `Project "${projectName}" already exists`,
        variant: 'error',
      });
      setProjectFlow({ type: 'closed' });
      return;
    }

    setProjectFlow({ type: 'cloning', repo });

    try {
      const baseDir = getProjectBaseDir(projectName);
      await cloneRepository(repo, baseDir);
      const baseBranch = await getDefaultBranch(baseDir);

      // Check for bundle
      const bundleDir = detectBundleInRepo(baseDir);
      if (bundleDir) {
        const loadedBundle = loadBundleFromPath(bundleDir);

        if (loadedBundle.bundle.onboarding && loadedBundle.bundle.onboarding.length > 0) {
          // Start onboarding flow
          const firstStep = loadedBundle.bundle.onboarding[0];
          const initialInputValue = (firstStep as { defaultValue?: string }).defaultValue || '';

          // If first step is a confirm with checkCommand, start checking
          if (firstStep.type === 'confirm' && (firstStep as { checkCommand?: string }).checkCommand) {
            setProjectFlow({
              type: 'onboarding',
              repo,
              projectName,
              baseBranch,
              bundleDir: loadedBundle.bundleDir,
              bundleName: loadedBundle.bundle.name,
              steps: loadedBundle.bundle.onboarding,
              currentStep: 0,
              collectedValues: {},
              collectedSecrets: {},
              inputValue: '',
              confirmStatus: 'checking',
            });

            const found = await checkCommand((firstStep as { checkCommand: string }).checkCommand);
            setProjectFlow(prev =>
              prev.type === 'onboarding'
                ? { ...prev, confirmStatus: found ? 'found' : 'missing' }
                : prev
            );
          } else {
            setProjectFlow({
              type: 'onboarding',
              repo,
              projectName,
              baseBranch,
              bundleDir: loadedBundle.bundleDir,
              bundleName: loadedBundle.bundle.name,
              steps: loadedBundle.bundle.onboarding,
              currentStep: 0,
              collectedValues: {},
              collectedSecrets: {},
              inputValue: initialInputValue,
              confirmStatus: null,
            });
          }
          return;
        }

        // No onboarding, just create project (scripts are in workspace .gitspace/scripts/)
        createProject(projectName, repo, baseBranch);
        await applyProjectBundleState({
          projectName,
          bundle: loadedBundle.bundle,
        });
      } else {
        // No bundle, just create project
        createProject(projectName, repo, baseBranch);
      }

      await finalizeProject(projectName);
    } catch (err) {
      flow.showMessage({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to clone repository',
        variant: 'error',
      });
      setProjectFlow({ type: 'closed' });
    }
  }, [flow, checkCommand, finalizeProject]);

  // Start new project flow
  const handleNewProjectFlow = useCallback(async () => {
    setProjectFlow({ type: 'loading-repos' });

    try {
      const repos = await listAllRepos();

      if (repos.length === 0) {
        flow.showMessage({
          title: 'No Repositories',
          message: 'No GitHub repositories found. You can still create projects by entering a git remote URL.',
          variant: 'warning',
        });
        setProjectFlow({ type: 'closed' });
        return;
      }

      setProjectFlow({ type: 'repo-select', repos, selectedIndex: 0 });
    } catch (err) {
      flow.showMessage({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to fetch repositories',
        variant: 'error',
      });
      setProjectFlow({ type: 'closed' });
    }
  }, [flow]);

  // ========== Shared Hooks ==========

  // Convert local backend state into panel data.
  const projectInfos: ProjectInfo[] = localProjects.map((project) => ({
    name: project.name,
    repository: project.repository,
    workspaceCount: project.workspaceCount,
    isCurrent: project.name === currentProject,
  }));

  const workspaceInfos = localWorkspaces
    .filter((workspace) => workspace.projectName === currentProject)
    .map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
      projectName: workspace.projectName,
      branch: workspace.branch,
      sessionCount: localSessions.filter((session) => session.workspaceId === workspace.id).length,
      isStale: workspace.isStale,
      processes: workspace.processes,
      processConfigError: workspace.processConfigError,
      serveDomain: workspace.serveDomain,
    }));

  const sessionInfos = currentProject
    ? localSessions.filter(
        (session) =>
          session.workspaceId !== 'unknown' &&
          session.workspaceId.startsWith(`${currentProject}:`)
      )
    : [];

  const inboxItems = localInbox as InboxItem[];
  const inboxUnreadCount = localInboxUnreadCount;

  // Project list hook
  const projectListProps = useProjectList({
    projects: projectInfos,
    onSelect: handleSelectProject,
    onCreateNew: lifecycleController.openCreateProjectFlow,
    onDelete: handleDeleteProject,
    onRefresh: refreshProjects,
  });

  const processActions = useProcessActions({
    sessions: sessionInfos,
    startProcess: startLocalProcess,
    stopProcess: stopLocalProcess,
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
    // Find workspace path for events request
    const workspace = localWorkspaces.find(w => w.id === workspaceId);
    if (workspace) {
      void requestLocalEvents(workspace.path);
    }
    dispatch({ type: 'SET_VIEW', view: 'events' });
  }, [localWorkspaces, requestLocalEvents]);

  // Spaces browser hook
  const spacesBrowserProps = useSpacesBrowser({
    workspaces: workspaceInfos,
    sessions: sessionInfos,
    onRequestSessions: () => {}, // Sessions already loaded
    onAttachSession: handleAttachSession,
    onEditProcesses: handleEditProcesses,
    onStartProcess: handleStartProcess,
    onStartProcessAttach: handleStartProcessAttach,
    onStopProcess: handleStopProcess,
    onProcessDisabled: handleProcessDisabled,
    onOpenEvents: handleOpenEvents,
    onRefresh: refreshWorkspaces,
    onBack: () => dispatch({ type: 'SET_PANEL_FOCUS', focus: 'projects' }),
    onCreateWorkspace: handleNewWorkspaceFlow,
    machineName: currentProject || undefined,
    showProjectHeaders: false, // Don't show project headers since we're already filtered
  });

  // Machine list hook (for remote mode)
  const machineListProps = useMachineList({
    machines: remoteMachines.machines,
    status: remoteMachines.status,
    error: remoteMachines.error,
    publicKey: undefined,
    onConnect: async (machine) => {
      dispatch({ type: 'SET_MACHINE', machine });
      dispatch({ type: 'SET_VIEW', view: 'projects' });
    },
    onRefresh: remoteMachines.refreshMachines,
  });

  // Inbox hook
  const inboxProps = useInbox({
    items: inboxItems,
    unreadCount: inboxUnreadCount,
    onClearItem: async (id) => {
      await clearLocalInbox(id);
      await refreshInbox();
    },
    onClearAll: async () => {
      await clearLocalInbox();
      await refreshInbox();
    },
    onMarkRead: async (id) => {
      await markLocalInboxRead(id);
      await refreshInbox();
    },
    onAttachSession: async (sessionId) => {
      dispatch({ type: 'SET_VIEW', view: 'projects' });
      await handleAttachSession({ sessionId });
    },
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
      const workspace = localWorkspaces.find(w => w.id === eventsWorkspaceId);
      if (!workspace) return;
      if (filter) {
        const sinceMs = filter.sinceMinutes
          ? Date.now() - filter.sinceMinutes * 60 * 1000
          : undefined;
        void requestLocalEvents(
          workspace.path,
          filter.filter as WideEventFilter,
          undefined,
          sinceMs
        );
      } else {
        void requestLocalEvents(workspace.path);
      }
    },
    onClose: () => {
      setEventsWorkspaceId(null);
      dispatch({ type: 'SET_VIEW', view: 'projects' });
    },
  });

  // Events polling when events view is active
  useEffect(() => {
    if (state.view !== 'events' || !eventsWorkspaceId) return;
    const workspace = localWorkspaces.find(w => w.id === eventsWorkspaceId);
    if (!workspace) return;

    const interval = setInterval(() => {
      const activeFilter = eventsProps.activeFilterName
        ? localSavedEventFilters.find((filter) => filter.name === eventsProps.activeFilterName) ?? null
        : null;

      if (activeFilter) {
        const sinceMs = activeFilter.sinceMinutes
          ? Date.now() - activeFilter.sinceMinutes * 60 * 1000
          : undefined;
        void requestLocalEvents(
          workspace.path,
          activeFilter.filter as WideEventFilter,
          undefined,
          sinceMs
        );
      } else {
        void requestLocalEvents(workspace.path);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [
    state.view,
    eventsWorkspaceId,
    localWorkspaces,
    eventsProps.activeFilterName,
    localSavedEventFilters,
    requestLocalEvents,
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
      void handleAttachSession({ sessionId }).catch((error) => {
        flow.showMessage({
          title: 'Attach Failed',
          message: error instanceof Error ? error.message : String(error),
          variant: 'error',
        });
      });
    },
    onMarkRead: async (itemId) => {
      await markLocalInboxRead(itemId);
      await refreshInbox();
    },
    pollIntervalMs: 5000,
    onRefreshInbox: refreshInbox,
    isUserActive,
    currentSessionId: localAttachedSessionId ?? undefined,
  });

  useEffect(() => {
    if (state.view !== 'scripts') {
      return;
    }

    setLocalWriteCallback((data) => {
      scriptTerminalRef.current?.feed(data);
    });

    return () => {
      setLocalWriteCallback(null);
    };
  }, [setLocalWriteCallback, state.view]);

  useEffect(() => {
    const handlePaste = (event: PasteEvent) => {
      const text = normalizeInputText(event.text ?? '');
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

        if (flow.flow.type === 'select' && flow.flow.searchable) {
          const currentQuery = flow.flow.searchQuery ?? '';
          flow.updateSelectQuery(currentQuery + text);
          event.preventDefault();
          return;
        }
      }

      if (projectFlow.type === 'onboarding') {
        const step = projectFlow.steps[projectFlow.currentStep];
        if (step?.type === 'input' || step?.type === 'secret') {
          setProjectFlow({
            ...projectFlow,
            inputValue: projectFlow.inputValue + text,
          });
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
  }, [flow, projectFlow, renderer, settingsFlow]);

  // ========== Keyboard Handlers ==========

  useKeyboard(async (key) => {
    const localScriptTerminalRunning =
      state.view === 'scripts' &&
      (localScriptState?.isRunning ?? true);

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
        (key.raw === 'a' || key.name === 'a')
      ) {
        const workspaceId = lastScriptWorkspaceIdRef.current;
        if (!workspaceId) {
          return;
        }

        flow.close();
        await attachLocal({
          workspaceId,
          scriptPolicy: 'skip',
        });
        return;
      }

      // Handle other modals (select, message, etc.)
      if (flow.flow.type === 'select' && flow.flow.searchable) {
        if (key.name === 'escape') {
          flow.handleCancel();
        } else if (key.name === 'return') {
          await flow.handleConfirm();
        } else if (key.name === 'up') {
          flow.moveUp();
        } else if (key.name === 'down') {
          flow.moveDown();
        } else if (key.name === 'backspace') {
          const current = flow.flow.searchQuery ?? '';
          flow.updateSelectQuery(current.slice(0, -1));
        } else {
          const chunk = getKeyboardInputChunk(key);
          if (!chunk) {
            return;
          }
          const current = flow.flow.searchQuery ?? '';
          flow.updateSelectQuery(current + chunk);
        }
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

    // Remote machine screen handles its own keyboard bindings.
    if (
      isRemoteMode &&
      state.view === 'projects' &&
      state.selectedMachine &&
      state.selectedMachine.machineId !== 'local'
    ) {
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
    if (state.view === 'terminal') {
      return;
    }

    // Read-only script terminal view.
    if (state.view === 'scripts') {
      if (localScriptState?.isRunning && (key.raw === 'c' || key.name === 'c')) {
        await cancelLocalPendingScripts();
        return;
      }

      if (
        !localScriptState?.isRunning &&
        (key.raw === 'a' || key.name === 'a') &&
        !!localScriptState?.error &&
        !!lastScriptWorkspaceIdRef.current
      ) {
        const workspaceId = lastScriptWorkspaceIdRef.current;
        if (!workspaceId) {
          return;
        }

        await attachLocal({
          workspaceId,
          scriptPolicy: 'skip',
        });
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
        dispatch({ type: 'SET_VIEW', view: 'projects' });
      } else if (key.name === 'up' || key.raw === 'k') {
        eventsProps.selectIndex(eventsProps.selectedIndex - 1);
      } else if (key.name === 'down' || key.raw === 'j') {
        eventsProps.selectIndex(eventsProps.selectedIndex + 1);
      }
      return;
    }

    // Handle project creation flow (custom state machine)
    if (projectFlow.type !== 'closed') {
      if (key.name === 'escape') {
        setProjectFlow({ type: 'closed' });
        return;
      }

      if (projectFlow.type === 'repo-select') {
        if (key.name === 'up' || key.raw === 'k') {
          setProjectFlow({
            ...projectFlow,
            selectedIndex: Math.max(0, projectFlow.selectedIndex - 1),
          });
        } else if (key.name === 'down' || key.raw === 'j') {
          setProjectFlow({
            ...projectFlow,
            selectedIndex: Math.min(projectFlow.repos.length - 1, projectFlow.selectedIndex + 1),
          });
        } else if (key.name === 'return') {
          const repo = projectFlow.repos[projectFlow.selectedIndex];
          if (repo) {
            await handleSelectRepo(repo);
          }
        }
        return;
      }

      if (projectFlow.type === 'onboarding') {
        const step = projectFlow.steps[projectFlow.currentStep];

        if (step.type === 'info' || step.type === 'confirm') {
          // For info/confirm steps, Enter to continue (if not checking)
          if (key.name === 'return' && projectFlow.confirmStatus !== 'checking') {
            await advanceOnboardingStep();
          }
          return;
        }

        if (step.type === 'input' || step.type === 'secret') {
          if (key.name === 'return') {
            await advanceOnboardingStep();
          } else if (key.name === 'backspace') {
            setProjectFlow({
              ...projectFlow,
              inputValue: projectFlow.inputValue.slice(0, -1),
            });
          } else {
            const chunk = getKeyboardInputChunk(key);
            if (!chunk) {
              return;
            }
            setProjectFlow({
              ...projectFlow,
              inputValue: projectFlow.inputValue + chunk,
            });
          }
          return;
        }
        return;
      }

      // For loading/cloning/creating states, just wait (escape to cancel handled above)
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
      const config = await localPreferencesService.getNotificationConfig();
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
            await localPreferencesService.updateNotificationConfig(newConfig);
            setNotificationConfig(newConfig);
            setSettingsFlow({ ...settingsFlow, config: newConfig });
          } else if (selected === 'toast-enabled') {
            const newConfig = {
              ...settingsFlow.config,
              toast: { ...settingsFlow.config.toast, enabled: !settingsFlow.config.toast.enabled },
            };
            await localPreferencesService.updateNotificationConfig(newConfig);
            setNotificationConfig(newConfig);
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
            await localPreferencesService.updateNotificationConfig(DEFAULT_NOTIFICATION_CONFIG);
            setNotificationConfig(DEFAULT_NOTIFICATION_CONFIG);
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
              await localPreferencesService.updateNotificationConfig(newConfig);
              setNotificationConfig(newConfig);
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
            await localPreferencesService.updateNotificationConfig(newConfig);
            setNotificationConfig(newConfig);
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
      const command = resolveInboxCommand({
        name: key.name,
        raw: key.raw,
        shift: key.shift,
      });

      if (command === 'back') {
        if (inboxProps.isViewingThread) {
          inboxProps.closeThread();
        } else {
          inboxProps.close();
        }
      } else if (command === 'move-up') {
        inboxProps.moveUp();
      } else if (command === 'move-down') {
        inboxProps.moveDown();
      } else if (command === 'activate') {
        await inboxProps.openThread();
      } else if (command === 'delete') {
        if (inboxProps.isViewingThread) {
          await inboxProps.deleteThread();
        } else {
          await inboxProps.deleteSelected();
        }
      } else if (command === 'clear') {
        await inboxProps.clearAll();
      } else if (command === 'attach' && inboxProps.isViewingThread) {
        await inboxProps.attachToSession();
      }
      return;
    }

    // View-specific shortcuts
    if (state.view === 'machines') {
      const command = resolveMachineListCommand({
        name: key.name,
        raw: key.raw,
        shift: key.shift,
      });

      if (command === 'move-up') {
        machineListProps.moveUp();
      } else if (command === 'move-down') {
        machineListProps.moveDown();
      } else if (command === 'activate') {
        machineListProps.connectSelected();
      } else if (command === 'refresh') {
        try {
          await machineListProps.refresh();
        } catch (error) {
          flow.showMessage({
            title: 'Refresh Failed',
            message: error instanceof Error ? error.message : String(error),
            variant: 'error',
          });
        }
      } else if (command === 'help') {
        flow.showHelp(getDefaultShortcuts());
      }
      return;
    }

    if (state.view === 'projects') {
      // Panel switching
      if (key.name === 'tab') {
        dispatch({ type: 'SWITCH_PANEL' });
        return;
      }

      if (state.panelFocus === 'projects') {
        if (key.name === 'up' || key.raw === 'k') {
          projectListProps.moveUp();
        } else if (key.name === 'down' || key.raw === 'j') {
          projectListProps.moveDown();
        } else if (key.name === 'return') {
          projectListProps.selectProject();
        } else if (key.raw === 'n') {
          // In projects panel, 'n' creates new project
          lifecycleController.openCreateProjectFlow();
        } else if (key.raw === 'd') {
          projectListProps.deleteSelected();
        } else if (key.raw === 'r') {
          try {
            await projectListProps.refresh();
          } catch (error) {
            flow.showMessage({
              title: 'Refresh Failed',
              message: error instanceof Error ? error.message : String(error),
              variant: 'error',
            });
          }
        }
      } else {
        // Workspaces panel
        const command = resolveSessionBrowserCommand({
          name: key.name,
          raw: key.raw,
          shift: key.shift,
        });

        if (command === 'move-up') {
          spacesBrowserProps.moveUp();
        } else if (command === 'move-down') {
          spacesBrowserProps.moveDown();
        } else if (command === 'activate') {
          // Let the hook handle it:
          // - workspace: toggle expand/collapse
          // - session: attach via onAttachSession
          // - new-session: create via onAttachSession
          try {
            await spacesBrowserProps.activateSelected();
          } catch (error) {
            flow.showMessage({
              title: 'Attach Failed',
              message: error instanceof Error ? error.message : String(error),
              variant: 'error',
            });
          }
        } else if (command === 'new') {
          // In workspaces panel, 'n' always creates new workspace
          // Sessions are created via expand (Enter) → "+ New session" (Enter)
          lifecycleController.openCreateWorkspaceFlow(currentProject);
        } else if (command === 'delete') {
          // Delete workspace
          const selected = spacesBrowserProps.selectedItem;
          if (selected?.type === 'workspace') {
            const workspace = workspaceInfos.find((item) => item.id === selected.workspace.id);
            if (workspace) {
              handleDeleteWorkspace(workspace);
            }
          }
        } else if (command === 'kill') {
          // Kill session or stop running process
          const selected = spacesBrowserProps.selectedItem;
          if (selected?.type === 'session') {
            handleDeleteSession(selected.session.id, selected.session.name);
          } else if (selected?.type === 'process' && selected.status === 'running') {
            flow.showConfirm({
              title: 'Stop Process',
              message: `Stop process "${selected.processName}"?`,
              variant: 'warning',
              confirmLabel: 'Stop',
              onConfirm: () => {
                void handleStopProcess({
                  workspaceId: selected.workspaceId,
                  processName: selected.processName,
                });
              },
            });
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
        } else if (command === 'back') {
          dispatch({ type: 'SET_PANEL_FOCUS', focus: 'projects' });
        }
      }
      return;
    }
  });

  useEffect(() => {
    if (!sessionSwitchingRef.current) {
      return;
    }

    if (state.view === 'projects' || state.view === 'machines' || state.view === 'inbox') {
      sessionSwitchingRef.current = false;
      return;
    }

    if (state.view === 'terminal' && localSessionMode === 'attached') {
      sessionSwitchingRef.current = false;
    }
  }, [localSessionMode, state.view]);

  // Keep local terminal view in sync with backend session lifecycle.
  useEffect(() => {
    const action = resolveLocalTerminalSyncAction({
      isLocalMachineContext,
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
    isLocalMachineContext,
    localScriptState,
    localSessionMode,
    localSessionStatus,
    refreshWorkspaces,
    state.view,
  ]);

  // ========== Render ==========

  // Loading state
  if (state.isLoading) {
    return (
      <Fragment>
        <Toaster position="top-right" />
        <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={COLORS.loading}>Loading...</text>
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

  // Machine list view (remote mode)
  if (state.view === 'machines') {
    return (
      <Fragment>
        <Toaster position="top-right" />
        <box flexDirection="column" flexGrow={1}>
          <MachineListTUI {...machineListProps} focused={true} />
          <StatusBar hint="[↑↓] Navigate  [Enter] Connect  [r] Refresh  [?] Help  [q] Quit" rightHint={keyboardModeHint} />
          <FlowTUI flow={flow} />
        </box>
      </Fragment>
    );
  }

  // Remote machine view (uses shared remote session engine + backend).
  if (
    isRemoteMode &&
    state.view === 'projects' &&
    state.selectedMachine &&
    state.selectedMachine.machineId !== 'local'
  ) {
    if (!relayConfig || !remoteMachines.identity) {
      return (
        <Fragment>
          <Toaster position="top-right" />
          <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
            <text fg={COLORS.error}>Missing remote identity</text>
            <text fg={COLORS.textDim} marginTop={1}>Set GITSPACE_IDENTITY_PASSWORD and reconnect</text>
          </box>
        </Fragment>
      );
    }

    return (
      <Fragment>
        <Toaster position="top-right" />
        <RemoteMachineScreen
          machine={state.selectedMachine}
          relayUrl={relayConfig.url}
          identity={remoteMachines.identity}
          onBack={() => {
            dispatch({ type: 'SET_MACHINE', machine: null });
            dispatch({ type: 'SET_VIEW', view: 'machines' });
          }}
        />
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
            ref={scriptTerminalRef}
            phase={phase}
            workspaceName={scriptWorkspaceName}
            isRunning={isRunning}
            error={localScriptState?.error}
            exitCode={localScriptState?.exitCode}
            modalOpen={flow.isOpen}
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

  // Main project/workspace view
  return (
    <Fragment>
      <Toaster position="top-right" />
      <box flexDirection="column" flexGrow={1} width="100%">
        {/* ASCII Art Header */}
      <box flexDirection="row" width="100%" height={13}>
        {/* ASCII art on left - fixed width */}
        <box flexDirection="column" alignItems="flex-start" paddingLeft={1} width={68}>
          {ASCII_LINES.map((line, i) => (
            <text key={i} fg={line.color}>{line.text}</text>
          ))}
        </box>

        {/* Status & Notifications on right */}
        <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingTop={1}>
          {/* Daemon status line */}
          <box flexDirection="row" gap={2}>
            <text fg={daemonStatus.tmux.running ? COLORS.title : COLORS.textDim}>
              tmux: {daemonStatus.tmux.running ? '●' : '○'} {daemonStatus.tmux.sessions ?? 0} sessions
            </text>
            <text fg={daemonStatus.serve.running ? COLORS.title : COLORS.textDim}>
              relay: {formatRelayStatus(daemonStatus.serve.relayStatus)} {daemonStatus.serve.running ? (daemonStatus.serve.clients ?? 0) + ' clients' : 'off'}
            </text>
          </box>

          {/* Uptime info */}
          {(daemonStatus.tmux.running || daemonStatus.serve.running) && (
            <text fg={COLORS.textDim}>
              {daemonStatus.tmux.uptime ? `tmux: ${formatUptime(daemonStatus.tmux.uptime)}` : ''}
              {daemonStatus.tmux.uptime && daemonStatus.serve.uptime ? '  ' : ''}
              {daemonStatus.serve.uptime ? `serve: ${formatUptime(daemonStatus.serve.uptime)}` : ''}
            </text>
          )}

          {/* Version mismatch warning */}
          {daemonStatus.versionMismatch && (
            <text fg={COLORS.error}>⚠ Version mismatch - restart daemons</text>
          )}

          {/* Notifications */}
          <box marginTop={1}>
            {inboxUnreadCount > 0 ? (
              <box flexDirection="column">
                <text fg={COLORS.loading}>{'📥'} {inboxUnreadCount} notification{inboxUnreadCount > 1 ? 's' : ''}</text>
                <text fg={COLORS.textDim}>[i] view inbox</text>
              </box>
            ) : (
              <text fg={COLORS.textDim}>No notifications</text>
            )}
          </box>
        </box>
      </box>

      {/* Main content - two panel layout */}
      <box flexDirection="row" flexGrow={1} width="100%" gap={1} paddingLeft={1} paddingRight={1}>
        <ProjectListTUI {...projectListProps} focused={state.panelFocus === 'projects'} />
        <SpacesBrowserTUI {...spacesBrowserProps} focused={state.panelFocus === 'workspaces'} />
      </box>

      {/* Status bar */}
      <StatusBar
        hint={state.panelFocus === 'projects'
          ? '[Tab] Switch  [Enter] Select  [n] New Project  [d] Delete  [,] Settings  [?] Help  [q] Quit'
          : getWorkspacesPanelHint(spacesBrowserProps.selectedItem)
        }
        rightHint={keyboardModeHint}
      />

      {/* Flow modal overlay */}
      <FlowTUI flow={flow} />

      {/* Project creation flow modal */}
      <ProjectFlowModal flow={projectFlow} />

      {/* Settings flow modal */}
      <SettingsFlowModal flow={settingsFlow} />
      </box>
    </Fragment>
  );
}

// ============================================================================
// Project Flow Modal Component
// ============================================================================

function ProjectFlowModal({ flow }: { flow: ProjectFlowState }) {
  if (flow.type === 'closed') {
    return null;
  }

  const modalWidth = 70;
  const modalHeight = flow.type === 'repo-select' ? 18 :
                      flow.type === 'onboarding' ? 14 :
                      8;

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
        {/* Loading repos state */}
        {flow.type === 'loading-repos' && (
          <>
            <text fg={COLORS.title} height={1}>New Project</text>
            <text fg={COLORS.loading} height={1} marginTop={1}>Fetching repositories...</text>
          </>
        )}

        {/* Repository selection */}
        {flow.type === 'repo-select' && (
          <>
            <text fg={COLORS.title} height={1}>Select Repository</text>
            <box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
              {flow.repos.slice(
                Math.max(0, flow.selectedIndex - 5),
                Math.max(0, flow.selectedIndex - 5) + 10
              ).map((repo, i) => {
                const actualIndex = Math.max(0, flow.selectedIndex - 5) + i;
                return (
                  <text key={repo} height={1} fg={actualIndex === flow.selectedIndex ? COLORS.selected : COLORS.text}>
                    {actualIndex === flow.selectedIndex ? '▸ ' : '  '}{repo}
                  </text>
                );
              })}
            </box>
            <text fg={COLORS.textDim} height={1}>[↑↓] Navigate  [Enter] Select  [Esc] Cancel</text>
          </>
        )}

        {/* Cloning state */}
        {flow.type === 'cloning' && (
          <>
            <text fg={COLORS.title} height={1}>Cloning Repository</text>
            <text fg={COLORS.loading} height={1} marginTop={1}>Cloning {flow.repo}...</text>
          </>
        )}

        {/* Onboarding steps */}
        {flow.type === 'onboarding' && (
          <ProjectOnboardingStepTUI flow={flow} colors={COLORS} />
        )}

        {/* Creating state */}
        {flow.type === 'creating' && (
          <>
            <text fg={COLORS.title} height={1}>Creating Project</text>
            <text fg={COLORS.loading} height={1} marginTop={1}>Setting up {flow.projectName}...</text>
          </>
        )}
      </box>
    </box>
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
    return '[Tab] Switch  [Enter] Attach  [x] Kill  [n] New Workspace  [d] Delete  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'process') {
    if (selectedItem.status === 'running') {
      return '[Tab] Switch  [Enter] View  [x] Stop  [,] Settings  [?] Help  [q] Quit';
    }
    return '[Tab] Switch  [Enter] Start  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'workspace') {
    return '[Tab] Switch  [Enter] Expand  [n] New Workspace  [d] Delete  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'process-disabled') {
    return '[Tab] Switch  [Enter] Disabled  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'process-config-error') {
    return '[Tab] Switch  [Enter] Fix Process Config  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'edit-processes') {
    return '[Tab] Switch  [Enter] Edit Processes Config  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'events') {
    return '[Tab] Switch  [Enter] Open Events  [,] Settings  [?] Help  [q] Quit';
  }
  if (selectedItem?.type === 'new-session') {
    return '[Tab] Switch  [Enter] New Session  [,] Settings  [?] Help  [q] Quit';
  }
  return '[Tab] Switch  [Enter] Open  [n] New Workspace  [,] Settings  [?] Help  [q] Quit';
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

/** @deprecated Use RelayConfig instead */
export type TUIRelayConfig = RelayConfig;

export async function launchTUI(
  relayConfig?: RelayConfig,
  options: { ignoreKeychainAndSkipSecrets?: boolean } = {}
): Promise<void> {
  await initializeSecretRuntime({
    ignoreKeychainAndSkipSecrets: options.ignoreKeychainAndSkipSecrets,
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
    root.render(<App relayConfig={relayConfig} onQuit={handleQuit} keyboardMode={resolvedKeyboardMode} />);
    renderer.start();
    return;
  }

  root.render(<App relayConfig={relayConfig} onQuit={handleQuit} keyboardMode={resolvedKeyboardMode} />);
}
