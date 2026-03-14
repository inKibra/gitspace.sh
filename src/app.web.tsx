/** @jsxImportSource react */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { SessionTerminal, type SessionTerminalHandle } from "./components/SessionTerminal.web";
import { ReplayTerminalWeb } from './components/ReplayTerminal.web';
import { ScriptTerminal } from "./components/ScriptTerminal.web";
import {
  TerminalControls,
  applyModifiersToInput,
  type ModifierState,
} from "./components/TerminalControls.web";
import { FloatingControls } from "./components/FloatingControls.web";
import { useTerminal } from "./hooks/useTerminal.web";
import { useRelayConnection } from "./hooks/useRelayConnection.web";
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

// Import shared components and hooks
import {
  useMachineList,
  useProjectList,
  useSpacesBrowser,
  useFlow,
  getDefaultShortcuts,
  type MachineInfo,
  type ReplayInfo,
  type WorkspaceInfo,
} from "./components/index.js";
import { MachineListWeb } from "./components/MachineList.web.js";
import { ProjectListWeb } from './components/ProjectList.web.js';
import { SpacesBrowserWeb } from "./components/SpacesBrowser.web.js";
import { FlowWeb } from "./components/Flow.web.js";
import { useInbox } from "./components/Inbox.js";
import { InboxWeb } from "./components/Inbox.web.js";
import { useEvents, toWideEventItem, type WideEventItem } from "./components/Events.js";
import { EventsWeb } from "./components/Events.web.js";
import type { WideEventFilter } from "./types/events.js";
import {
  useNotifications,
  type ToastNotification,
  type NotificationConfig,
  DEFAULT_NOTIFICATION_CONFIG,
  getSessionLabel,
} from "./notifications/index.js";
import {
  resolveInboxCommand,
  resolveMachineListCommand,
  resolveSessionBrowserCommand,
} from './app/input/sessionCommands.js';

type View = "machines" | "terminal" | "review" | 'replay';

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

export default function App() {
  const [view, setView] = useState<View>("machines");
  const [selectedMachine, setSelectedMachine] = useState<MachineInfo | null>(null);
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
  const [activeReplayAnsi, setActiveReplayAnsi] = useState<Uint8Array | null>(null);
  const [showDismissedReplays, setShowDismissedReplays] = useState(false);
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
    workspaceLabel?: string;
  } | null>(null);

  // Identity state (resolved by IdentityGate before relay connection)
  const [resolvedIdentity, setResolvedIdentity] = useState<Identity | null>(null);

  // Relay connection (for machine list)
  const relay = useRelayConnection({ identity: resolvedIdentity });

  // Terminal connection (for PTY)
  const terminal = useTerminal();
  const activeNotificationConfig =
    terminal.notificationConfig ?? localNotificationConfig ?? DEFAULT_NOTIFICATION_CONFIG;

  // Visual viewport hook for keyboard detection
  const keyboardVisible = useVisualViewport();

  // Apply device-specific CSS classes and detect mobile on mount
  useEffect(() => {
    applyDeviceClasses();
    // Show mobile controls on touch devices or mobile layout
    setShowMobileControls(isTouchDevice() || isMobileLayout());

    // Listen for layout changes
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const handleChange = (e: MediaQueryListEvent) => {
      setShowMobileControls(e.matches || isTouchDevice());
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Flow/Modal system
  const flow = useFlow({
    onError: (error) => console.error('Flow error:', error),
  });

  const resolveWebWorkspaceProjectName = useCallback((workspaceId: string) => {
    const index = workspaceId.indexOf(':');
    if (index > 0) {
      return workspaceId.slice(0, index);
    }
    return terminal.selectedProjectName;
  }, [terminal.selectedProjectName]);

  const bundleRefreshAttach = useBundleRefreshAttachFlow({
    flow,
    commandError: terminal.commandError,
    attachSession: (params) => terminal.attachSession(params),
    getBundleRefreshPlan: terminal.getBundleRefreshPlan,
    applyBundleRefresh: terminal.applyBundleRefresh,
    resolveProjectName: resolveWebWorkspaceProjectName,
  });

  const bundleConfigFlow = useBundleConfigFlow({
    flow,
    getBundleConfigState: terminal.getBundleConfigState,
    applyBundleConfigUpdate: terminal.applyBundleConfigUpdate,
    resolveProjectName: resolveWebWorkspaceProjectName,
    onApplied: async () => {
      terminal.requestWorkspaces();
      terminal.requestSessions();
      terminal.requestReplays(undefined, showDismissedReplays);
    },
  });

  const getWebAttachSize = useCallback(() => {
    return terminalRef.current?.getSize() ?? { cols: 80, rows: 24 };
  }, []);

  const attachController = useAttachController({
    flow,
    attachSessionWithBundleRefresh: bundleRefreshAttach.attachSessionWithBundleRefresh,
    defaultProjectName: terminal.selectedProjectName,
    getAttachSize: getWebAttachSize,
    resolveProjectName: resolveWebWorkspaceProjectName,
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
      if (target === 'workspace' && showScriptTerminal) {
        return;
      }
      if (target === 'workspace') {
        setShowScriptTerminal(false);
      }
    },
    onAttachError: ({ target, message }) => {
      const isWorkspaceScriptFailure = message.startsWith('Workspace scripts failed during');
      const hasScriptRuntimeState = Boolean(terminal.scriptState);

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
    deleteWorkspace: terminal.deleteWorkspace,
    onBeforeDelete: ({ target }) => {
      suppressDeleteScriptFailureModalRef.current = true;
      setShowInbox(false);
      setScriptWorkspaceName(target.workspaceName);
      setShowScriptTerminal(true);
    },
    onDeleteSuccess: async () => {
      suppressDeleteScriptFailureModalRef.current = false;
      setShowScriptTerminal(false);
      terminal.requestWorkspaces();
      terminal.requestSessions();
      terminal.requestReplays(undefined, showDismissedReplays);
    },
    onDeleteCancelled: async () => {
      suppressDeleteScriptFailureModalRef.current = false;
      setShowScriptTerminal(false);
    },
    onDeleteError: async ({ message }) => {
      suppressDeleteScriptFailureModalRef.current = false;
      setShowScriptTerminal(false);
      flow.showMessage({
        title: 'Delete Failed',
        message,
        variant: 'error',
      });
    },
  });

  const lifecycleController = useLifecycleController({
    flow,
    listGithubRepos: terminal.listGithubRepos,
    listRemoteBranches: terminal.listRemoteBranches,
    listLinearIssues: terminal.listLinearIssues,
    createProject: terminal.createProject,
    prepareProjectCreation: terminal.prepareProjectCreation,
    finalizeProjectCreation: terminal.finalizeProjectCreation,
    cancelProjectCreation: terminal.cancelProjectCreation,
    createWorkspace: terminal.createWorkspace,
    deleteProject: terminal.deleteProject,
    getProjectNames: () => terminal.projects.map((project) => project.name),
    refreshProjects: () => terminal.requestProjects(),
    refreshWorkspaces: () => terminal.requestWorkspaces(),
    refreshSessions: () => terminal.requestSessions(),
    onProjectCreated: ({ projectName }) => {
      terminal.selectProject(projectName);
    },
    onWorkspaceCreated: ({ projectName }) => {
      terminal.selectProject(projectName);
    },
  });

  useEffect(() => {
    let mounted = true;
    void browserPreferencesService.getNotificationConfig().then((config) => {
      if (mounted) {
        setLocalNotificationConfig(config);
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!terminal.notificationConfig) {
      return;
    }
    void browserPreferencesService.updateNotificationConfig(terminal.notificationConfig);
    setLocalNotificationConfig(terminal.notificationConfig);
  }, [terminal.notificationConfig]);

  // Parse review params from query string on load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'review') {
      const ws = params.get('workspace');
      const proj = params.get('project');
      if (ws && proj) {
        setReviewWorkspace({ projectName: proj, workspaceId: ws, workspaceLabel: ws });
        setView('review');
      }
    }
  }, []);

  // Auto-connect when identity becomes available.
  // relay.status is intentionally omitted — including it would cause reconnect
  // loops on every status transition. We only want to trigger on identity change.
  useEffect(() => {
    if (resolvedIdentity && relay.status === "disconnected") {
      relay.connect();
    }
  }, [resolvedIdentity, relay.connect]);

  useEffect(() => {
    if (terminal.scriptState?.isRunning) {
      setShowScriptTerminal(true);
    }

    if (terminal.mode === 'attached' || terminal.status !== 'established') {
      setShowScriptTerminal(false);
    }
  }, [terminal.mode, terminal.scriptState?.isRunning, terminal.status]);

  useEffect(() => {
    if (
      !pendingProcessEditWorkspaceId ||
      !pendingProcessEditValidationArmedRef.current ||
      terminal.mode !== 'browsing'
    ) {
      return;
    }
    terminal.requestWorkspaces();
  }, [pendingProcessEditWorkspaceId, terminal.mode, terminal.requestWorkspaces]);

  useEffect(() => {
    if (
      !pendingProcessEditWorkspaceId ||
      !pendingProcessEditValidationArmedRef.current ||
      terminal.mode !== 'browsing'
    ) {
      return;
    }

    if (
      pendingProcessEditWorkspacesRef.current &&
      pendingProcessEditWorkspacesRef.current === terminal.workspaces
    ) {
      return;
    }
    pendingProcessEditWorkspacesRef.current = null;

    const workspace = terminal.workspaces.find((item) => item.id === pendingProcessEditWorkspaceId);
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
  }, [flow, pendingProcessEditWorkspaceId, terminal.mode, terminal.workspaces]);

  useEffect(() => {
    const scriptError = terminal.scriptState?.error;
    if (!scriptError) {
      lastScriptErrorRef.current = null;
      return;
    }

    if (suppressDeleteScriptFailureModalRef.current) {
      lastScriptErrorRef.current = scriptError;
      return;
    }

    if (terminal.commandError?.code && SCRIPT_ERROR_CODES.has(terminal.commandError.code)) {
      lastScriptErrorRef.current = scriptError;
      return;
    }

    if (lastScriptErrorRef.current === scriptError) {
      return;
    }

    lastScriptErrorRef.current = scriptError;
    flow.showMessage({
      title: 'Workspace Script Failed',
      message: scriptError,
      variant: 'error',
    });
  }, [flow, terminal.commandError?.code, terminal.scriptState?.error]);

  useEffect(() => {
    if (!terminal.commandError) {
      lastCommandErrorRef.current = null;
      return;
    }

    const key = `${terminal.commandError.code ?? ''}:${terminal.commandError.message}`;
    if (lastCommandErrorRef.current === key) {
      return;
    }
    lastCommandErrorRef.current = key;

    if (
      suppressDeleteScriptFailureModalRef.current &&
      terminal.commandError.code &&
      DELETE_ERROR_CODES.has(terminal.commandError.code)
    ) {
      return;
    }

    const isScriptFailure = terminal.commandError.code
      ? SCRIPT_ERROR_CODES.has(terminal.commandError.code)
      : false;

    if (isScriptFailure) {
      if (!terminal.scriptState) {
        flow.showMessage({
          title: 'Workspace Script Failed',
          message: terminal.commandError.message,
          variant: 'error',
        });
        setShowScriptTerminal(false);
      }
      return;
    }

    if (terminal.commandError.code === 'BUNDLE_REFRESH_REQUIRED') {
      return;
    }

    flow.showMessage({
      title: 'Session Failed',
      message: terminal.commandError.message,
      variant: 'error',
    });

    if (terminal.scriptState?.isRunning !== true) {
      setShowScriptTerminal(false);
    }
  }, [flow, terminal.commandError, terminal.scriptState?.isRunning]);

  // Handle machine selection - go directly to terminal/workspaces view
  const handleMachineConnect = async (machine: MachineInfo) => {
    if (!machine.online) return;

    // Get WebSocket and identity from relay connection
    const ws = relay.getWebSocket();
    const identity = relay.identity;
    const deviceCertificate = relay.deviceCertificate;
    if (!ws || !identity || !deviceCertificate) {
      console.error("No WebSocket, identity, or device certificate available");
      return;
    }

    setSelectedMachine(machine);
    setView("terminal");
    setShowScriptTerminal(false);
    setScriptWorkspaceName('workspace');

    // Connect to the machine using existing WebSocket (no new connection needed)
    await terminal.connect({
      ws,
      identity,
      machineId: machine.machineId,
      deviceCertificate,
    });
  };

  // Handle back to machine list
  const handleBackToMachines = () => {
    terminal.disconnect();
    setSelectedMachine(null);
    setShowScriptTerminal(false);
    setShowEvents(false);
    setInputMode(false); // Reset input mode when leaving terminal
    setView("machines");
  };

  // Handle full disconnect (just refresh the page for simplicity)
  const handleDisconnect = () => {
    terminal.disconnect();
    relay.disconnect();
    setSelectedMachine(null);
    setShowScriptTerminal(false);
    setShowEvents(false);
    setView("machines");
    // Reconnect automatically
    relay.connect();
  };

  // ========== Shared Hooks ==========

  // Machine list hook - convert relay machines to shared MachineInfo format
  const machineListProps = useMachineList({
    machines: relay.machines,
    status: relay.status,
    error: relay.error,
    publicKey: relay.publicKey,
    onConnect: handleMachineConnect,
    onRefresh: relay.refreshMachines,
  });

  // Handle attach session - show modal for new sessions
  const handleAttachSession = useCallback(async (params: { sessionId?: string; workspaceId?: string; viewOnly?: boolean }) => {
    setIsViewOnlySession(params.viewOnly ?? false);
    await attachController.attachFromSelection(params);
  }, [attachController]);

  const processActions = useProcessActions({
    sessions: terminal.sessions,
    startProcess: terminal.startProcess,
    stopProcess: terminal.stopProcess,
    attachSession: handleAttachSession,
    onStartProcessError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
    onStopProcessError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
    onStartProcessAttachError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
    onAttachError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
    onAttachTimeout: (target) => {
      toast.error(`Process started but no active session appeared for ${target.processName}#${target.instance}.`);
    },
    pendingAttachCancelSignal: terminal.commandError,
  });

  // Handle opening review for a workspace
  const handleOpenReview = useCallback((workspace: WorkspaceInfo) => {
    setReviewWorkspace({
      projectName: workspace.projectName,
      workspaceId: workspace.id,
      workspaceLabel: workspace.name,
    });
    setView('review');
  }, []);

  // Open editor on .gitspace/processes.json in the workspace
  const handleEditProcesses = useCallback(({ workspaceId }: { workspaceId: string }) => {
    setIsViewOnlySession(false);
    pendingProcessEditValidationArmedRef.current = false;
    pendingProcessEditWorkspacesRef.current = terminal.workspaces;
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
  }, [attachController, terminal.workspaces]);

  const handleProcessDisabled = useCallback((params: { workspaceId: string; processName: string }) => {
    const workspace = terminal.workspaces.find((item) => item.id === params.workspaceId);
    const workspaceLabel = workspace?.name ?? params.workspaceId;
    toast.error(`Process "${params.processName}" is disabled in ${workspaceLabel} (instances: 0).`);
  }, [terminal.workspaces]);

  const handleManageBundleConfig = useCallback(async ({ workspaceId }: { workspaceId: string }) => {
    const workspace = terminal.workspaces.find((item) => item.id === workspaceId);
    const projectName = workspace?.projectName ?? terminal.selectedProjectName;
    await bundleConfigFlow.openBundleConfig({ workspaceId, projectName });
  }, [bundleConfigFlow, terminal.selectedProjectName, terminal.workspaces]);

  const selectedProjectName = terminal.selectedProjectName;
  const filteredWorkspaces = useMemo(
    () => selectedProjectName
      ? terminal.workspaces.filter((workspace) => workspace.projectName === selectedProjectName)
      : [],
    [selectedProjectName, terminal.workspaces]
  );
  const filteredWorkspaceIds = useMemo(
    () => new Set(filteredWorkspaces.map((workspace) => workspace.id)),
    [filteredWorkspaces]
  );
  const filteredSessions = useMemo(
    () => selectedProjectName
      ? terminal.sessions.filter((session) => filteredWorkspaceIds.has(session.workspaceId))
      : [],
    [filteredWorkspaceIds, selectedProjectName, terminal.sessions]
  );

  const filteredReplays = useMemo(
    () => selectedProjectName
      ? terminal.replays.filter((replay) => replay.projectName === selectedProjectName)
      : [],
    [selectedProjectName, terminal.replays]
  );

  const refreshReplayList = useCallback(() => {
    terminal.requestReplays(undefined, showDismissedReplays);
  }, [terminal, showDismissedReplays]);

  useEffect(() => {
    showDismissedReplaysRef.current = showDismissedReplays;
  }, [showDismissedReplays]);

  const toggleShowDismissedReplayFilter = useCallback(() => {
    setShowDismissedReplays((value) => {
      const next = !value;
      terminal.requestReplays(undefined, next);
      return next;
    });
  }, [terminal]);

  const handleOpenReplay = useCallback(async ({ replayId }: { replayId: string; workspaceId: string }) => {
    const replay = terminal.replays.find((item) => item.replayId === replayId);
    if (!replay) {
      flow.showMessage({ title: 'Replay Missing', message: 'Could not find replay metadata.', variant: 'error' });
      return;
    }

    try {
      const ansi = await terminal.getReplayAnsi(replayId);
      setActiveReplay(replay);
      setActiveReplayAnsi(ansi);
      setView('replay');
    } catch (error) {
      flow.showMessage({
        title: 'Replay Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    }
  }, [flow, terminal]);

  const toggleReplayDismissed = useCallback(async (replay: ReplayInfo) => {
    try {
      if (replay.dismissedAt) {
        await terminal.undismissReplay(replay.replayId);
        if (activeReplay?.replayId === replay.replayId) {
          setActiveReplay({
            ...activeReplay,
            dismissedAt: undefined,
            dismissedBy: undefined,
          });
        }
      } else {
        await terminal.dismissReplay(replay.replayId);
        if (activeReplay?.replayId === replay.replayId) {
          setActiveReplay(null);
          setActiveReplayAnsi(null);
          setView('terminal');
        }
      }
      refreshReplayList();
    } catch (error) {
      flow.showMessage({
        title: replay.dismissedAt ? 'Restore Failed' : 'Dismiss Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    }
  }, [activeReplay?.replayId, flow, refreshReplayList, terminal]);

  // Spaces browser hook
  const spacesBrowserProps = useSpacesBrowser({
    workspaces: filteredWorkspaces,
    sessions: filteredSessions,
    replays: filteredReplays,
    onRequestSessions: () => terminal.requestSessions(),
    onAttachSession: handleAttachSession,
    onOpenReplay: handleOpenReplay,
    onEditProcesses: handleEditProcesses,
    onManageBundleConfig: handleManageBundleConfig,
    onStartProcess: (params) => processActions.handleStartProcess(params),
    onStartProcessAttach: (params) => processActions.handleStartProcessAttach(params),
    onStopProcess: (params) => processActions.handleStopProcess(params),
    onProcessDisabled: handleProcessDisabled,
    onOpenEvents: (workspaceId) => {
      const workspace = terminal.workspaces.find(w => w.id === workspaceId);
      if (workspace) {
        setEventsWorkspacePath(workspace.path);
        setEventsWorkspaceLabel(workspace.name);
        setShowEvents(true);
        terminal.requestEvents(workspace.path, undefined, undefined, undefined);
      }
    },
    onRefresh: () => { terminal.requestWorkspaces(); refreshReplayList(); },
    onRefreshSessions: () => { terminal.requestSessions(); refreshReplayList(); },
    onBack: handleBackToMachines,
    machineName: selectedProjectName
      ? `${selectedProjectName} - ${selectedMachine?.label || selectedMachine?.machineId || 'machine'}`
      : selectedMachine?.label || selectedMachine?.machineId,
    showProjectHeaders: false,
  });

  const handleOpenHelp = useCallback(() => {
    flow.showHelp(getDefaultShortcuts());
  }, [flow]);

  const handleOpenCreateMenu = useCallback(() => {
    lifecycleController.openCreateMenu(selectedProjectName);
  }, [lifecycleController, selectedProjectName]);

  const handleCreateWorkspaceForProject = useCallback((projectName: string) => {
    lifecycleController.openCreateWorkspaceFlow(projectName);
  }, [lifecycleController]);

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
        terminal.killSession(sessionId);
      },
    });
  }, [flow, terminal]);

  const handleDeleteWorkspace = useCallback((workspace: WorkspaceInfo) => {
    const sessionCount = workspace.sessionCount || 0;
    flow.showConfirmTyped({
      title: 'Delete Workspace',
      message: `Are you sure you want to delete workspace "${workspace.name}"?`,
      confirmText: workspace.name,
      warning: sessionCount > 0 ? `This will kill ${sessionCount} active session(s)!` : undefined,
      onConfirm: async () => {
        await deleteWorkspaceWithPrompt({
          projectName: workspace.projectName,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        });
      },
    });
  }, [deleteWorkspaceWithPrompt, flow]);

  const projectListProps = useProjectList({
    projects: terminal.projects,
    selectedProjectName,
    onSelect: (project) => {
      terminal.selectProject(project.name);
    },
    onCreateNew: lifecycleController.openCreateProjectFlow,
    onDelete: (project) => {
      handleDeleteProject(project.name);
    },
    onRefresh: () => terminal.requestProjects(),
  });

  // Inbox hook
  const inboxProps = useInbox({
    items: terminal.inbox,
    unreadCount: terminal.inboxUnreadCount,
    onClearItem: async (id) => terminal.clearInboxItem(id),
    onClearAll: async () => terminal.clearInboxItem(),
    onMarkRead: async (id) => terminal.markInboxItemRead(id),
    onAttachSession: async (sessionId) => {
      setShowInbox(false);
      await attachController.attach({ sessionId });
    },
    onClose: () => setShowInbox(false),
  });

  // Events hook
  const eventsItems: WideEventItem[] = terminal.events.map(toWideEventItem);

  const eventsProps = useEvents({
    events: eventsItems,
    liveEventIds: terminal.liveEventIds,
    savedFilters: terminal.savedEventFilters,
    onSelectFilter: (filter) => {
      if (!eventsWorkspacePath) return;
      if (filter) {
        const sinceMs = filter.sinceMinutes
          ? Date.now() - filter.sinceMinutes * 60 * 1000
          : undefined;
        terminal.requestEvents(
          eventsWorkspacePath,
          filter.filter as WideEventFilter,
          undefined,
          sinceMs
        );
      } else {
        terminal.requestEvents(eventsWorkspacePath);
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

  // Events polling when events view is active
  useEffect(() => {
    if (!showEvents || !eventsWorkspacePath) return;

    const interval = setInterval(() => {
      const activeFilter = eventsProps.activeFilterName
        ? terminal.savedEventFilters.find((filter) => filter.name === eventsProps.activeFilterName) ?? null
        : null;

      if (activeFilter) {
        const sinceMs = activeFilter.sinceMinutes
          ? Date.now() - activeFilter.sinceMinutes * 60 * 1000
          : undefined;
        terminal.requestEvents(
          eventsWorkspacePath,
          activeFilter.filter as WideEventFilter,
          undefined,
          sinceMs
        );
      } else {
        terminal.requestEvents(eventsWorkspacePath);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [showEvents, eventsWorkspacePath, eventsProps.activeFilterName, terminal.savedEventFilters, terminal.requestEvents]);

  // ========== Activity Tracking for Notifications ==========

  const holdWhenIdleMs = activeNotificationConfig.toast.holdWhenIdleMs ?? 15000;
  const { isUserActive, markActivity: handleTerminalActivity } = useUserActivity({
    isActivityTracked: view === "terminal" && terminal.mode === "attached",
    holdWhenIdleMs,
  });

  // ========== Notification Toasts ==========

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
          void attachController.attach({ sessionId: notification.sessionId });
        },
      },
    });
  }, [attachController]);

  const notifications = useNotifications({
    items: terminal.inbox,
    config: activeNotificationConfig,
    onShowToast: handleShowToast,
    onAttachSession: (sessionId) => {
      void attachController.attach({ sessionId });
    },
    onMarkRead: async (itemId) => {
      terminal.markInboxItemRead(itemId);
    },
    pollIntervalMs: 5000,
    onRefreshInbox: async () => {
      if (terminal.status === "established") {
        terminal.requestInbox();
      }
    },
    isUserActive,
    currentSessionId: terminal.attachedSessionId ?? undefined,
  });

  // Request workspaces when connection is established and view is "terminal"
  useEffect(() => {
    if (view === "terminal" && terminal.status === "established" && terminal.mode === "browsing") {
      terminal.requestProjects();
      terminal.requestWorkspaces();
      terminal.requestSessions();
      terminal.requestNotificationConfig();
    }
  }, [
    view,
    terminal.status,
    terminal.mode,
    terminal.requestProjects,
    terminal.requestWorkspaces,
    terminal.requestSessions,
    terminal.requestNotificationConfig,
  ]);

  useEffect(() => {
    if (view === "terminal" && terminal.status === "established" && terminal.mode === "browsing") {
      terminal.requestReplays(undefined, showDismissedReplaysRef.current);
    }
  }, [
    view,
    terminal.status,
    terminal.mode,
    terminal.requestReplays,
  ]);

  // Reset view-only state when detached
  useEffect(() => {
    if (terminal.mode !== 'attached') {
      setIsViewOnlySession(false);
    }
  }, [terminal.mode]);

  // ========== Keyboard Handlers ==========

  // Machine list keyboard navigation
  useEffect(() => {
    if (view !== "machines") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const command = resolveMachineListCommand({ key: e.key, shift: e.shiftKey });
      if (!command) {
        return;
      }

      e.preventDefault();
      if (command === 'move-up') {
        machineListProps.moveUp();
      } else if (command === 'move-down') {
        machineListProps.moveDown();
      } else if (command === 'activate') {
        machineListProps.connectSelected();
      } else if (command === 'refresh') {
        void machineListProps.refresh();
      } else if (command === 'copy') {
        machineListProps.copyPublicKey();
      } else if (command === 'help') {
        flow.showHelp(getDefaultShortcuts());
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [view, machineListProps, flow]);

  // Inbox keyboard navigation
  useEffect(() => {
    if (!showInbox) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const command = resolveInboxCommand({ key: e.key, shift: e.shiftKey });
      if (!command) {
        return;
      }

      e.preventDefault();
      if (command === 'move-up') {
        inboxProps.moveUp();
      } else if (command === 'move-down') {
        inboxProps.moveDown();
      } else if (command === 'activate') {
        if (inboxProps.isViewingThread) {
          inboxProps.attachToSession();
        } else {
          inboxProps.openThread();
        }
      } else if (command === 'back') {
        if (inboxProps.isViewingThread) {
          inboxProps.closeThread();
        } else {
          setShowInbox(false);
        }
      } else if (command === 'delete') {
        if (inboxProps.isViewingThread) {
          inboxProps.deleteThread();
        } else {
          inboxProps.deleteSelected();
        }
      } else if (command === 'clear') {
        inboxProps.clearAll();
      } else if (command === 'attach') {
        inboxProps.attachToSession();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showInbox, inboxProps.moveUp, inboxProps.moveDown, inboxProps.openThread, inboxProps.closeThread, inboxProps.deleteSelected, inboxProps.deleteThread, inboxProps.clearAll, inboxProps.attachToSession, inboxProps.isViewingThread]);

  // Events keyboard navigation
  useEffect(() => {
    if (!showEvents) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'Escape' || e.key === 'q') {
        e.preventDefault();
        setShowEvents(false);
        setEventsWorkspacePath(null);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        const state = eventsKeyboardStateRef.current;
        if (!state) return;
        state.selectIndex(state.selectedIndex - 1);
      } else if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        const state = eventsKeyboardStateRef.current;
        if (!state) return;
        state.selectIndex(state.selectedIndex + 1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showEvents]);

  // Spaces browser keyboard navigation
  useEffect(() => {
    if (view !== "terminal" || terminal.status !== "established" || terminal.mode !== "browsing" || showInbox || showScriptTerminal || showEvents) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const command = resolveSessionBrowserCommand({ key: e.key, shift: e.shiftKey });
      if (!command) {
        return;
      }

      e.preventDefault();
      if (command === 'move-up') {
        spacesBrowserProps.moveUp();
      } else if (command === 'move-down') {
        spacesBrowserProps.moveDown();
      } else if (command === 'activate') {
        spacesBrowserProps.activateSelected();
      } else if (command === 'new') {
        lifecycleController.openCreateMenu(selectedProjectName);
      } else if (command === 'bundle') {
        const selected = spacesBrowserProps.selectedItem;
        const workspaceId = selected?.type === 'workspace'
          ? selected.workspace.id
          : selected && 'workspaceId' in selected && selected.type !== 'replay'
            ? selected.workspaceId
            : null;
        if (workspaceId) {
          void handleManageBundleConfig({ workspaceId });
        }
      } else if (command === 'refresh') {
        spacesBrowserProps.refresh();
      } else if (command === 'back') {
        spacesBrowserProps.back();
      } else if (command === 'help') {
        flow.showHelp(getDefaultShortcuts());
      } else if (command === 'kill') {
        const selected = spacesBrowserProps.selectedItem;
        if (selected?.type === 'session') {
          flow.showConfirm({
            title: 'Kill Session',
            message: `Kill session "${selected.session.name}"?`,
            variant: 'warning',
            confirmLabel: 'Kill',
            onConfirm: () => {
              terminal.killSession(selected.session.id);
            },
          });
        } else if (selected?.type === 'process' && selected.status === 'running') {
          flow.showConfirm({
            title: 'Stop Process',
            message: `Stop process "${selected.processName}"?`,
            variant: 'warning',
            confirmLabel: 'Stop',
            onConfirm: () => {
              processActions.handleStopProcess({
                workspaceId: selected.workspaceId,
                processName: selected.processName,
              });
            },
          });
        }
      } else if (command === 'delete') {
        const selected = spacesBrowserProps.selectedItem;
        if (selected?.type === 'project') {
          lifecycleController.openDeleteProjectFlow(selected.name);
        } else if (selected?.type === 'workspace') {
          const sessionCount = selected.workspace.sessionCount || 0;
          flow.showConfirmTyped({
            title: 'Delete Workspace',
            message: `Are you sure you want to delete workspace "${selected.workspace.name}"?`,
            confirmText: selected.workspace.name,
            warning: sessionCount > 0 ? `This will kill ${sessionCount} active session(s)!` : undefined,
            onConfirm: async () => {
              await deleteWorkspaceWithPrompt({
                projectName: selected.workspace.projectName,
                workspaceId: selected.workspace.id,
                workspaceName: selected.workspace.name,
              });
            },
          });
        } else if (selected?.type === 'replay') {
          void toggleReplayDismissed(selected.replay);
        }
      } else if (command === 'toggle-hidden') {
        toggleShowDismissedReplayFilter();
      } else if (command === 'open-inbox') {
        terminal.requestInbox();
        setShowInbox(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    view,
    terminal.status,
    terminal.mode,
    showInbox,
    showScriptTerminal,
    showEvents,
    spacesBrowserProps,
    selectedProjectName,
    flow,
    lifecycleController,
    handleManageBundleConfig,
    deleteWorkspaceWithPrompt,
    toggleReplayDismissed,
    toggleShowDismissedReplayFilter,
  ]);

  useEffect(() => {
    if (view !== 'replay' || !activeReplay) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'Escape' || e.key === 'q') {
        e.preventDefault();
        setView('terminal');
        setActiveReplay(null);
        setActiveReplayAnsi(null);
      } else if (e.key === 'd') {
        e.preventDefault();
        void toggleReplayDismissed(activeReplay);
      } else if (e.key === 'h') {
        e.preventDefault();
        toggleShowDismissedReplayFilter();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeReplay, toggleReplayDismissed, toggleShowDismissedReplayFilter, view]);

  // Attached terminal mode keyboard handler (Shift+Esc to detach)
  useEffect(() => {
    if (view !== "terminal" || terminal.status !== "established" || terminal.mode !== "attached") {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Shift+Esc to detach from session
      if (e.shiftKey && e.key === "Escape") {
        e.preventDefault();
        terminal.detachSession();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [view, terminal.status, terminal.mode, terminal.detachSession]);

  useEffect(() => {
    if (view !== 'terminal' || terminal.status !== 'established' || terminal.mode !== 'browsing' || !showScriptTerminal) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if ((e.key === 'Escape' || e.key === 'q') && !terminal.scriptState?.isRunning) {
        e.preventDefault();
        setShowScriptTerminal(false);
      } else if ((e.key === 'c' || e.key === 'C') && terminal.scriptState?.isRunning) {
        e.preventDefault();
        terminal.cancelPendingScripts();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showScriptTerminal, terminal.mode, terminal.scriptState?.isRunning, terminal.status, view]);

  // Global hotkey for toast-only attach (Shift+Tab)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Shift+Tab: attach to active toast's session (with confirmation)
      if (e.shiftKey && e.key === "Tab" && notifications.activeToast) {
        e.preventDefault();
        const sessionLabel = getSessionLabel(notifications.activeToast.sessionName);
        flow.showConfirm({
          title: 'Switch Session',
          message: `Switch to "${sessionLabel}"?`,
          confirmLabel: 'Switch',
          onConfirm: () => {
            notifications.attachToActiveToast();
          },
        });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [notifications.activeToast, notifications.attachToActiveToast, flow]);

  // Show identity gate before any view (including review deep links)
  if (!resolvedIdentity) {
    return <IdentityGate onIdentityReady={setResolvedIdentity} />;
  }

  // ========== Review View ==========
  if (view === 'review' && reviewWorkspace) {
    if (terminal.status === 'established') {
      return (
        <>
          <ReviewPage
            projectName={reviewWorkspace.projectName}
            workspaceName={reviewWorkspace.workspaceId}
            workspaceLabel={reviewWorkspace.workspaceLabel}
            machineName={selectedMachine?.label || selectedMachine?.machineId}
            sendReviewRequest={terminal.sendReviewRequest}
            onBack={() => {
              setView('terminal');
              setReviewWorkspace(null);
            }}
          />
          <Toaster theme="dark" position="top-right" richColors />
        </>
      );
    }

    // Connection not yet established — show a targeted connecting screen
    // rather than falling through to the generic machine list.
    const statusMessage = {
      disconnected: "Disconnected",
      connecting: "Connecting to relay...",
      connected: "Connected, authenticating...",
      handshaking: "Establishing secure connection...",
      established: "Connected!",
      error: "Connection failed",
    }[terminal.status];

    return (
      <>
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0d1117] px-4">
          <div className="text-center">
            <div className="text-lg text-[#e6edf3] mb-2">
              Loading review for <span className="text-[#58a6ff]">{reviewWorkspace.workspaceLabel ?? reviewWorkspace.workspaceId}</span>
            </div>
            <div className="text-sm text-[#8b949e]">{statusMessage}</div>
            <button
              onClick={() => { setView('machines'); setReviewWorkspace(null); }}
              className="mt-4 px-6 py-3 text-base bg-[#21262d] hover:bg-[#30363d] rounded-lg text-[#e6edf3] min-h-[48px] border border-[#30363d]"
            >
              Back to Machines
            </button>
          </div>
        </div>
        <Toaster theme="dark" position="top-right" richColors />
      </>
    );
  }

  if (view === 'replay' && activeReplay) {
    return (
      <>
        <div className="w-screen h-screen flex flex-col bg-[#0d1117] overflow-hidden">
          <div className="bg-[#161b22] px-4 py-2 flex items-center justify-between border-b border-[#30363d] min-h-[52px] gap-2 flex-shrink-0">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
              <button
                onClick={() => {
                  setView('terminal');
                  setActiveReplay(null);
                  setActiveReplayAnsi(null);
                }}
                className="text-sm text-[#8b949e] hover:text-[#e6edf3] py-2 pr-2 -ml-2 min-h-[44px] flex items-center flex-shrink-0"
              >
                ← <span className="hidden sm:inline ml-1">Workspaces</span>
              </button>
              <div className="text-sm text-[#8b949e] truncate">
                <span className={activeReplay.status === 'crashed' ? 'text-[#ff7b72]' : 'text-[#79c0ff]'}>↺</span>{' '}
                <span className="hidden sm:inline">{selectedMachine?.label || selectedMachine?.machineId}</span>
                <span className="hidden sm:inline text-[#6e7681] mx-1">/</span>
                <span className="text-[#e6edf3]">{activeReplay.sessionName}</span>
                {activeReplay.workspaceName && (
                  <span className="text-[#6e7681]"> · {activeReplay.workspaceName}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => void toggleReplayDismissed(activeReplay)}
                className="px-3 py-2 text-sm bg-[#21262d] hover:bg-[#30363d] rounded text-[#e6edf3] min-h-[44px] border border-[#30363d]"
              >
                {activeReplay.dismissedAt ? 'Restore' : 'Dismiss'}
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <ReplayTerminalWeb ansi={activeReplayAnsi} />
          </div>
        </div>
        <FlowWeb flow={flow} />
        <Toaster theme="dark" position="top-right" richColors />
      </>
    );
  }

  // ========== Spaces Browser View (browsing mode) ==========
  if (
    view === 'terminal' &&
    terminal.status === 'established' &&
    terminal.mode === 'browsing' &&
    showScriptTerminal
  ) {
    const isRunning = terminal.scriptState?.isRunning ?? true;
    return (
      <>
        <ScriptTerminal
          phase={terminal.scriptState?.phase ?? 'pre'}
          workspaceName={scriptWorkspaceName}
          isRunning={isRunning}
          error={terminal.scriptState?.error}
          exitCode={terminal.scriptState?.exitCode}
          setWriteCallback={terminal.setWriteCallback}
          canAttachAnyway={Boolean(!isRunning && terminal.scriptState?.error && lastScriptWorkspaceIdRef.current)}
          onAttachAnyway={async () => {
            const workspaceId = lastScriptWorkspaceIdRef.current;
            if (!workspaceId) {
              return;
            }

            await attachController.attach({
              workspaceId,
              scriptPolicy: 'skip',
            });
          }}
          onBack={() => {
            lastScriptWorkspaceIdRef.current = null;
            setShowScriptTerminal(false);
          }}
          onCancel={() => {
            terminal.cancelPendingScripts();
          }}
        />
        {!isRunning && <FlowWeb flow={flow} />}
        <Toaster theme="dark" position="top-right" richColors />
      </>
    );
  }

  if (view === "terminal" && terminal.status === "established" && terminal.mode === "browsing") {
    // Show inbox if open
    if (showInbox) {
      return (
        <>
          <InboxWeb {...inboxProps} />
          <FlowWeb flow={flow} />
          <Toaster theme="dark" position="top-right" richColors />
        </>
      );
    }

    // Show events if open
    if (showEvents) {
      return (
        <>
          <EventsWeb {...eventsProps} workspaceLabel={eventsWorkspaceLabel} />
          <FlowWeb flow={flow} />
          <Toaster theme="dark" position="top-right" richColors />
        </>
      );
    }

    return (
      <>
        <div className="h-screen w-screen flex flex-col md:flex-row bg-[#0d1117]">
          <div className="h-[34vh] min-h-[240px] border-b border-[#30363d] md:h-full md:w-[320px] md:flex-shrink-0 md:border-b-0 md:border-r">
            <ProjectListWeb
              {...projectListProps}
              embedded={true}
              title={selectedMachine?.label || selectedMachine?.machineId || 'Projects'}
            />
          </div>
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="px-3 py-2 border-b border-[#30363d] bg-[#11161d] flex items-center justify-between gap-2">
              <div className="text-xs text-[#8b949e]">
                Replay history: <span className="text-[#e6edf3]">{showDismissedReplays ? 'showing dismissed' : 'hiding dismissed'}</span>
              </div>
              <button
                onClick={toggleShowDismissedReplayFilter}
                className="px-3 py-2 text-xs bg-[#21262d] hover:bg-[#30363d] rounded text-[#e6edf3] min-h-[36px] border border-[#30363d]"
              >
                {showDismissedReplays ? 'Hide Dismissed' : 'Show Dismissed'}
              </button>
            </div>
            <div className="flex-1 min-h-0">
            <SpacesBrowserWeb
              {...spacesBrowserProps}
              embedded={true}
              emptyTitle={selectedProjectName ? `No workspaces in ${selectedProjectName}` : 'No project selected'}
              emptyDescription={selectedProjectName
                ? 'Create the first workspace for this project.'
                : terminal.projects.length > 0
                  ? 'Pick a project from the list to browse its workspaces.'
                  : 'Create a project to start working from the web UI.'}
              emptyActionLabel={selectedProjectName ? 'New Workspace' : 'New Project'}
              onEmptyAction={selectedProjectName
                ? () => handleCreateWorkspaceForProject(selectedProjectName)
                : lifecycleController.openCreateProjectFlow}
              onReview={handleOpenReview}
              onCreate={selectedProjectName ? () => handleCreateWorkspaceForProject(selectedProjectName) : handleOpenCreateMenu}
              onHelp={handleOpenHelp}
              onOpenInbox={() => {
                terminal.requestInbox();
                setShowInbox(true);
              }}
              inboxUnreadCount={terminal.inboxUnreadCount}
              onDisconnect={handleDisconnect}
              onCreateWorkspaceForProject={handleCreateWorkspaceForProject}
              onDeleteWorkspace={handleDeleteWorkspace}
              onDeleteSession={handleDeleteSession}
            />
            </div>
          </div>
        </div>
        <FlowWeb flow={flow} />
        <Toaster theme="dark" position="top-right" richColors />
      </>
    );
  }

  // ========== Terminal View (attached mode) ==========
  if (view === "terminal" && terminal.status === "established" && terminal.mode === "attached") {
    // Handler for sending data from mobile controls (already processed)
    const handleSendData = (data: string) => {
      if (data === PAGE_UP && terminalRef.current?.pageUp()) {
        return;
      }

      if (data === PAGE_DOWN && terminalRef.current?.pageDown()) {
        return;
      }

      if (isViewOnlySession) {
        return;
      }

      terminal.send(new TextEncoder().encode(data));
    };

    // Handler for keyboard input - applies virtual modifiers then resets them
    const handleKeyboardData = (data: Uint8Array) => {
      if (isViewOnlySession) {
        return;
      }

      const hasModifiers = modifiers.ctrl || modifiers.shift || modifiers.alt;
      if (hasModifiers) {
        // Apply modifiers and reset
        const modified = applyModifiersToInput(data, modifiers);
        terminal.send(modified);
        setModifiers({ ctrl: false, shift: false, alt: false });
      } else {
        terminal.send(data);
      }
    };

    // Handler for focusing terminal from mobile controls
    const handleFocusTerminal = () => {
      terminalRef.current?.focus();
    };

    // Toggle input mode - focus/blur terminal accordingly
    const toggleInputMode = () => {
      const newInputMode = !inputMode;
      setInputMode(newInputMode);
      if (newInputMode) {
        // Entering input mode - focus terminal to show keyboard
        terminalRef.current?.focus();
      } else {
        // Exiting input mode - blur to hide keyboard
        terminalRef.current?.blur();
      }
    };

    // Show floating controls when keyboard is hidden on mobile
    const showFloatingControls = showMobileControls && !keyboardVisible;

    // Determine terminal container classes based on mode
    const getTerminalContainerClass = () => {
      if (!showMobileControls) {
        // Desktop - simple flex
        return 'flex-1';
      }
      if (inputMode) {
        // Input mode - has padding for TerminalControls bar
        return 'terminal-input-mode-container';
      }
      // Not input mode - add bottom padding for floating controls
      return 'flex-1 terminal-with-floating-controls';
    };

    return (
      <>
        <div className="w-screen h-screen flex flex-col bg-[#0d1117] overflow-hidden">
          <div className="bg-[#161b22] px-4 py-2 flex items-center justify-between border-b border-[#30363d] min-h-[52px] gap-2 flex-shrink-0">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
              <button
                onClick={terminal.detachSession}
                className="text-sm text-[#8b949e] hover:text-[#e6edf3] active:text-[#22c55e] py-2 pr-2 -ml-2 min-h-[44px] flex items-center flex-shrink-0"
              >
                ← <span className="hidden sm:inline ml-1">Workspaces</span>
              </button>
              <div className="text-sm text-[#8b949e] truncate">
                <span className="text-[#3fb950] shadow-glow">●</span>{" "}
                <span className="hidden sm:inline">{selectedMachine?.label || selectedMachine?.machineId}</span>
                {terminal.attachedSessionName && (
                  <span className="text-[#e6edf3]">
                    <span className="hidden sm:inline text-[#6e7681] mx-1">/</span>
                    {terminal.attachedSessionName.split(':').pop()}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Input mode toggle for mobile */}
              {showMobileControls && (
                <button
                  onClick={toggleInputMode}
                  className={`px-3 py-2 text-sm rounded min-h-[44px] transition-all ${
                    inputMode
                      ? 'bg-[#22c55e] text-[#0d1117] shadow-glow font-medium'
                      : 'bg-[#21262d] text-[#e6edf3] hover:bg-[#30363d]'
                  }`}
                >
                  Input
                </button>
              )}
              <span className="text-xs text-[#6e7681] hidden sm:inline">Shift+Esc</span>
              <button
                onClick={terminal.detachSession}
                className="px-3 py-2 text-sm bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] rounded text-[#e6edf3] min-h-[44px] border border-[#30363d]"
              >
                Detach
              </button>
            </div>
          </div>
          <div className={getTerminalContainerClass()}>
          <SessionTerminal
              ref={terminalRef}
              onData={handleKeyboardData}
              setWriteCallback={terminal.setWriteCallback}
              onResize={terminal.resize}
              allowTapFocus={inputMode || !showMobileControls}
              allowTouchScroll={!inputMode}
              onActivity={handleTerminalActivity}
              readOnly={isViewOnlySession}
            />
          </div>
          {/* Mobile controls toolbar - show in input mode */}
          {showMobileControls && inputMode && (
            <TerminalControls
              onSendData={handleSendData}
              onFocusTerminal={handleFocusTerminal}
              keyboardVisible={keyboardVisible}
              modifiers={modifiers}
              onModifiersChange={setModifiers}
            />
          )}
          {/* Floating controls - show when keyboard is hidden on mobile */}
          {showFloatingControls && (
            <FloatingControls
              onSendData={handleSendData}
              showJogWheel={inputMode}
            />
          )}
        </div>
        <Toaster theme="dark" position="top-right" richColors />
      </>
    );
  }

  // ========== Terminal Connecting View ==========
  if (view === "terminal") {
    const statusMessage = {
      disconnected: "Disconnected",
      connecting: "Connecting to relay...",
      connected: "Connected, authenticating...",
      handshaking: "Establishing secure connection...",
      established: "Connected!",
      error: "Connection failed",
    }[terminal.status];

    return (
      <>
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0d1117] px-4">
          <div className="text-center">
            <div className="text-lg text-[#e6edf3] mb-2 break-words">
              Connecting to {selectedMachine?.label || selectedMachine?.machineId}
            </div>
            <div className="text-sm text-[#8b949e]">{statusMessage}</div>
            {terminal.status === "error" && (
              <button
                onClick={handleBackToMachines}
                className="mt-4 px-6 py-3 text-base bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] rounded-lg text-[#e6edf3] min-h-[48px] border border-[#30363d]"
              >
                Back to Machines
              </button>
            )}
          </div>
        </div>
        <Toaster theme="dark" position="top-right" richColors />
      </>
    );
  }

  // ========== Machine List View ==========
  // This is now the main/default view - shows machines and your identity
  // (Identity gate is handled above, before any view rendering)

  return (
    <>
      <div className="h-screen w-screen flex flex-col bg-[#0d1117]">
        {/* Header with identity info */}
        <div className="bg-[#161b22] px-4 py-3 border-b border-[#30363d]">
          <div className="max-w-2xl mx-auto">
            {/* Connection status */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${
                  relay.status === "connected" ? "bg-[#3fb950] shadow-glow" :
                  relay.status === "connecting" ? "bg-[#d29922] animate-pulse" :
                  "bg-[#f85149]"
                }`} />
                <span className="text-sm text-[#8b949e]">
                  {relay.status === "connected" ? "Connected" :
                   relay.status === "connecting" ? "Connecting..." :
                   "Disconnected"}
                </span>
              </div>
              <button
                onClick={handleOpenHelp}
                className="text-xs text-[#6e7681] hover:text-[#e6edf3] px-2 py-1"
              >
                Help
              </button>
              <button
                onClick={relay.refreshMachines}
                className="text-xs text-[#6e7681] hover:text-[#e6edf3] px-2 py-1"
              >
                Refresh
              </button>
            </div>

            {/* Your identity - prominent display */}
            {relay.publicKey && (
              <div className="bg-[#0d1117] rounded-lg p-3 border border-[#30363d]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-[#8b949e]">Your Browser Identity</span>
                </div>
                <code className="block text-xs text-[#3fb950] break-all font-mono leading-relaxed mb-3">
                  {relay.publicKey}
                </code>
                <p className="text-xs text-[#6e7681] mb-2">
                  Owner-only access is enabled. This browser key must match the machine owner identity:
                </p>
                <p className="text-xs text-[#8b949e]">
                  If this key does not match your machine owner identity, switch to the owner identity and reconnect.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Machine list */}
        <div className="flex-1 overflow-auto">
          {machineListProps.isLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-[#8b949e]">Connecting to relay...</div>
            </div>
          ) : machineListProps.hasError ? (
            <div className="flex items-center justify-center h-full p-4">
              <div className="text-center max-w-xl">
                <div className="text-[#f85149] mb-2">Could not list machines</div>
                <p className="text-sm text-[#8b949e] mb-3">
                  {machineListProps.error ?? 'The relay rejected or failed the machine listing request.'}
                </p>
                <p className="text-sm text-[#6e7681] mb-4">
                  This usually means the browser identity is not the relay owner identity, or the relay is connected but not authorized to show any machines for this identity.
                </p>
                <button
                  onClick={() => {
                    if (machineListProps.status === 'disconnected') {
                      void relay.connect();
                      return;
                    }

                    relay.refreshMachines();
                  }}
                  className="px-6 py-3 text-base bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] border border-[#30363d] rounded-lg min-h-[48px] text-[#e6edf3]"
                >
                  {machineListProps.status === 'disconnected' ? 'Reconnect' : 'Retry'}
                </button>
              </div>
            </div>
          ) : machineListProps.status === "disconnected" && relay.machines.length === 0 ? (
            <div className="flex items-center justify-center h-full p-4">
              <div className="text-center max-w-xl">
                <div className="text-[#8b949e] mb-2">Unable to connect to relay</div>
                <p className="text-sm text-[#6e7681] mb-4">
                  Check that your hosted or local relay is running, then reconnect and try again.
                </p>
                <button
                  onClick={relay.connect}
                  className="px-6 py-3 text-base bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] border border-[#30363d] rounded-lg min-h-[48px] text-[#e6edf3]"
                >
                  Reconnect
                </button>
              </div>
            </div>
          ) : machineListProps.isEmpty ? (
            <div className="flex items-center justify-center h-full p-4">
              <div className="text-center max-w-xl">
                <div className="text-[#8b949e] mb-2">No machines available</div>
                <p className="text-sm text-[#6e7681] mb-3">
                  The relay connection succeeded, but no machines are visible to this browser identity.
                </p>
                <p className="text-sm text-[#6e7681] mb-4">
                  Make sure your machine is running `gssh machine serve start` and that this browser is using the same owner identity as the machine.
                </p>
                <button
                  onClick={relay.refreshMachines}
                  className="px-6 py-3 text-base bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] text-[#0d1117] font-medium shadow-glow rounded-lg min-h-[48px]"
                >
                  Refresh
                </button>
              </div>
            </div>
          ) : (
            <MachineListWeb {...machineListProps} />
          )}
        </div>

        {/* Footer */}
        <div className="bg-[#161b22] px-4 py-2 border-t border-[#30363d]">
          <p className="text-xs text-[#6e7681] text-center">
            End-to-end encrypted via X3DH • ↑↓ Navigate • Enter Connect • ? Help
          </p>
        </div>
      </div>
      <FlowWeb flow={flow} />
      <Toaster theme="dark" position="top-right" richColors />
    </>
  );
}
