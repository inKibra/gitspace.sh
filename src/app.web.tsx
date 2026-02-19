/** @jsxImportSource react */
import { useState, useEffect, useRef, useCallback } from "react";
import { SessionTerminal, type SessionTerminalHandle } from "./components/SessionTerminal.web";
import { ScriptTerminal } from "./components/ScriptTerminal.web";
import {
  TerminalControls,
  applyModifiersToInput,
  type ModifierState,
} from "./components/TerminalControls.web";
import { FloatingControls } from "./components/FloatingControls.web";
import { useTerminal } from "./hooks/useTerminal.web";
import { useRelayConnection } from "./hooks/useRelayConnection.web";
import { useVisualViewport } from "./hooks/useVisualViewport.web";
import { parseInviteFromHash } from "./lib/invite.web";
import { browserPreferencesService } from "./lib/preferences-service.web";
import { Toaster, toast } from "./lib/sonner.web";
import { applyDeviceClasses, isMobileLayout, isTouchDevice } from "./utils/device.web";
import { useUserActivity } from "./hooks/index.js";
import { useBundleRefreshAttachFlow } from './session/useBundleRefreshAttachFlow.js';
import { useAttachController } from './app/session/useAttachController.js';
import { useWorkspaceDeleteFlow } from './app/session/useWorkspaceDeleteFlow.js';
import { ReviewPage } from './pages/ReviewPage.web.js';
import { buildEditProcessesCommand } from './lib/processes/editor.js';

// Import shared components and hooks
import {
  useMachineList,
  useSpacesBrowser,
  useFlow,
  getDefaultShortcuts,
  type MachineInfo,
  type WorkspaceInfo,
} from "./components/index.js";
import { MachineListWeb } from "./components/MachineList.web.js";
import { SpacesBrowserWeb } from "./components/SpacesBrowser.web.js";
import { FlowWeb } from "./components/Flow.web.js";
import { useInbox } from "./components/Inbox.js";
import { InboxWeb } from "./components/Inbox.web.js";
import { useEvents, type WideEventItem } from "./components/Events.js";
import { EventsWeb } from "./components/Events.web.js";
import type { WideEvent, WideEventFilter } from "./types/events.js";
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

type View = "machines" | "terminal" | "review";

const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const DELETE_ERROR_CODES = new Set([
  'REMOVE_SCRIPT_FAILED',
  'DELETE_FAILED',
  'WORKSPACE_NOT_FOUND',
  'RESOURCE_NOT_FOUND',
  'NOT_FOUND',
]);

export default function App() {
  const [view, setView] = useState<View>("machines");
  const [selectedMachine, setSelectedMachine] = useState<MachineInfo | null>(null);
  const [showInbox, setShowInbox] = useState(false);
  const [showScriptTerminal, setShowScriptTerminal] = useState(false);
  const [scriptWorkspaceName, setScriptWorkspaceName] = useState('workspace');
  const [copied, setCopied] = useState(false);
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
  const pendingProcessEditWorkspacesRef = useRef<unknown[] | null>(null);

  // Terminal ref for external control (focus, sendData)
  const terminalRef = useRef<SessionTerminalHandle>(null);
  const lastScriptErrorRef = useRef<string | null>(null);
  const lastCommandErrorRef = useRef<string | null>(null);
  const suppressDeleteScriptFailureModalRef = useRef(false);

  // Invite params from URL
  const [inviteParams, setInviteParams] = useState<{
    machineId?: string;
    inviteId?: string;
    inviteToken?: string;
  } | null>(null);

  // Review workspace/project state
  const [reviewWorkspace, setReviewWorkspace] = useState<{
    projectName: string;
    workspaceId: string;
    workspaceLabel?: string;
  } | null>(null);

  // Relay connection (for machine list)
  const relay = useRelayConnection();

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

  const bundleRefreshAttach = useBundleRefreshAttachFlow({
    flow,
    commandError: terminal.commandError,
    attachSession: (params) => terminal.attachSession(params),
    getBundleRefreshPlan: terminal.getBundleRefreshPlan,
    applyBundleRefresh: terminal.applyBundleRefresh,
    resolveProjectName: (workspaceId) => {
      const index = workspaceId.indexOf(':');
      if (index > 0) {
        return workspaceId.slice(0, index);
      }
      return terminal.selectedProjectName;
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
    resolveProjectName: (workspaceId) => {
      const index = workspaceId.indexOf(':');
      if (index > 0) {
        return workspaceId.slice(0, index);
      }
      return terminal.selectedProjectName;
    },
    onBeforeAttach: ({ target, params }) => {
      if (target === 'session') {
        setShowScriptTerminal(false);
        return;
      }

      if (params.workspaceId && !params.command) {
        setShowInbox(false);
        setScriptWorkspaceName(params.workspaceId.split(':').slice(-1)[0] ?? params.workspaceId);
        setShowScriptTerminal(true);
      }
    },
    onAttachCancelled: ({ target }) => {
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

  // Parse invite from URL hash on load, and review params from query string
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith("#invite=")) {
      parseInviteFromHash(hash).then((invite) => {
        if (invite) {
          setInviteParams({
            machineId: invite.machineId,
            inviteId: invite.inviteId,
            inviteToken: invite.inviteToken,
          });
        }
      });
    }

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

  // Auto-connect on load (no token required for personal relays)
  useEffect(() => {
    if (relay.status === "disconnected") {
      relay.connect();
    }
  }, []);

  useEffect(() => {
    if (terminal.scriptState?.isRunning) {
      setShowScriptTerminal(true);
    }

    if (terminal.mode === 'attached' || terminal.status !== 'established') {
      setShowScriptTerminal(false);
    }
  }, [terminal.mode, terminal.scriptState?.isRunning, terminal.status]);

  useEffect(() => {
    if (!pendingProcessEditWorkspaceId || terminal.mode !== 'browsing') {
      return;
    }
    terminal.requestWorkspaces();
  }, [pendingProcessEditWorkspaceId, terminal.mode, terminal.requestWorkspaces]);

  useEffect(() => {
    if (!pendingProcessEditWorkspaceId || terminal.mode !== 'browsing') {
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

    if (lastScriptErrorRef.current === scriptError) {
      return;
    }

    lastScriptErrorRef.current = scriptError;
    flow.showMessage({
      title: 'Workspace Script Failed',
      message: scriptError,
      variant: 'error',
    });
  }, [flow, terminal.scriptState?.error]);

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

    const isScriptFailure =
      terminal.commandError.code === 'SCRIPT_FAILED' ||
      terminal.commandError.code === 'PRE_SCRIPT_FAILED' ||
      terminal.commandError.code === 'SETUP_SCRIPT_FAILED' ||
      terminal.commandError.code === 'SELECT_SCRIPT_FAILED' ||
      terminal.commandError.code === 'REMOVE_SCRIPT_FAILED';

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

  // Copy access command to clipboard
  const copyAccessCommand = async () => {
    if (relay.publicKey) {
      const command = `gssh access add "${relay.publicKey}"`;
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Handle machine selection - go directly to terminal/workspaces view
  const handleMachineConnect = async (machine: MachineInfo) => {
    if (!machine.online) return;

    // Get WebSocket and identity from relay connection
    const ws = relay.getWebSocket();
    const identity = relay.identity;
    if (!ws || !identity) {
      console.error("No WebSocket or identity available");
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
      inviteId: inviteParams?.inviteId,
      inviteToken: inviteParams?.inviteToken,
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
    pendingProcessEditWorkspacesRef.current = terminal.workspaces;
    setPendingProcessEditWorkspaceId(workspaceId);
    const commandSpec = buildEditProcessesCommand();
    void attachController.attach({
      workspaceId,
      command: commandSpec.command,
      args: commandSpec.args,
    });
  }, [attachController, terminal.workspaces]);

  const handleStartProcessSelection = useCallback((params: { workspaceId: string; processName: string; instance?: number }) => {
    terminal.startProcess(params.workspaceId, params.processName, params.instance);
  }, [terminal]);

  // Spaces browser hook
  const spacesBrowserProps = useSpacesBrowser({
    workspaces: terminal.workspaces,
    sessions: terminal.sessions,
    onRequestSessions: () => terminal.requestSessions(),
    onAttachSession: handleAttachSession,
    onEditProcesses: handleEditProcesses,
    onStartProcess: (params) => handleStartProcessSelection(params),
    onStartProcessAttach: (params) => handleStartProcessSelection(params),
    onStopProcess: (params) => {
      terminal.stopProcess(params.workspaceId, params.processName);
    },
    onOpenEvents: (workspaceId) => {
      const workspace = terminal.workspaces.find(w => w.id === workspaceId);
      if (workspace) {
        setEventsWorkspacePath(workspace.path);
        setEventsWorkspaceLabel(workspace.name);
        setShowEvents(true);
        terminal.requestEvents(workspace.path, undefined, undefined, undefined);
      }
    },
    onRefresh: terminal.requestWorkspaces,
    onRefreshSessions: () => terminal.requestSessions(),
    onBack: handleBackToMachines,
    machineName: selectedMachine?.label || selectedMachine?.machineId,
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
  const eventsItems: WideEventItem[] = terminal.events.map((event: WideEvent) => ({
    eventId: event.eventId,
    eventName: event.eventName,
    level: event.level,
    timestamp: event.timestamp,
    timestampMs: event.timestampMs,
    message: event.message,
    processName: event.processName,
    processInstance: event.processInstance,
    sessionId: event.sessionId,
    raw: event.raw,
    kind: event.kind,
    correlationId: event.correlationId,
    timeline: event.timeline,
    timelineMap: event.timelineMap,
    timelineOrder: event.timelineOrder,
  }));

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

  // Events polling when events view is active
  useEffect(() => {
    if (!showEvents || !eventsWorkspacePath) return;

    const activeFilter = eventsProps.activeFilterName
      ? terminal.savedEventFilters.find((filter) => filter.name === eventsProps.activeFilterName) ?? null
      : null;

    const interval = setInterval(() => {
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
        eventsProps.selectIndex(eventsProps.selectedIndex - 1);
      } else if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        eventsProps.selectIndex(eventsProps.selectedIndex + 1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showEvents, eventsProps]);

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
        spacesBrowserProps.createNewSession();
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
              terminal.stopProcess(selected.workspaceId, selected.processName);
            },
          });
        }
      } else if (command === 'delete') {
        const selected = spacesBrowserProps.selectedItem;
        if (selected?.type === 'workspace') {
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
        }
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
    flow,
    deleteWorkspaceWithPrompt,
  ]);

  // Attached terminal mode keyboard handler (Ctrl+Esc to detach)
  useEffect(() => {
    if (view !== "terminal" || terminal.status !== "established" || terminal.mode !== "attached") {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Esc to detach from session
      if (e.ctrlKey && e.key === "Escape") {
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
          onBack={() => setShowScriptTerminal(false)}
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
        <div className="h-screen w-screen flex flex-col bg-[#0d1117]">
          <div className="bg-[#161b22] px-4 py-2 flex items-center justify-between border-b border-[#30363d] min-h-[52px] gap-2">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
              <button
                onClick={handleBackToMachines}
                className="text-sm text-[#8b949e] hover:text-[#e6edf3] active:text-[#22c55e] py-2 pr-2 -ml-2 min-h-[44px] flex items-center flex-shrink-0"
              >
                ← <span className="hidden sm:inline ml-1">Machines</span>
              </button>
              <div className="text-sm text-[#8b949e] truncate hidden sm:block">
                <span className="text-[#3fb950] shadow-glow">●</span>{" "}
                {selectedMachine?.label || selectedMachine?.machineId}
              </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
              <button
                onClick={() => {
                  terminal.requestInbox();
                  setShowInbox(true);
                }}
                className="text-sm text-[#8b949e] hover:text-[#e6edf3] active:text-[#22c55e] flex items-center gap-1 py-2 px-2 min-h-[44px]"
              >
                <span className="hidden sm:inline text-xs text-[#6e7681]">[i]</span>
                <span>Inbox</span>
                {terminal.inboxUnreadCount > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 text-xs bg-[#58a6ff] rounded-full text-[#0d1117] font-medium">
                    {terminal.inboxUnreadCount}
                  </span>
                )}
              </button>
              <button
                onClick={handleDisconnect}
                className="px-3 py-2 text-sm bg-[#f85149] hover:bg-[#ff7b72] active:bg-[#da3633] rounded text-white min-h-[44px] border border-[#f85149]"
              >
                <span className="hidden sm:inline">Disconnect</span>
                <span className="sm:hidden">×</span>
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            <SpacesBrowserWeb {...spacesBrowserProps} onReview={handleOpenReview} />
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

      terminal.send(new TextEncoder().encode(data));
    };

    // Handler for keyboard input - applies virtual modifiers then resets them
    const handleKeyboardData = (data: Uint8Array) => {
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
              <span className="text-xs text-[#6e7681] hidden sm:inline">Ctrl+Esc</span>
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
                  To get access, have the machine owner run:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs text-[#e6edf3] bg-[#161b22] px-2 py-2 rounded font-mono overflow-x-auto border border-[#30363d]">
                    gssh access add "{relay.publicKey.slice(0, 20)}..."
                  </code>
                  <button
                    onClick={copyAccessCommand}
                    className="text-xs text-[#22c55e] hover:text-[#3fb950] bg-[#161b22] border border-[#30363d] px-3 py-2 rounded whitespace-nowrap hover:border-[#22c55e] transition-colors"
                  >
                    {copied ? "Copied!" : "Copy Command"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Machine list */}
        <div className="flex-1 overflow-auto">
          {relay.status === "connecting" ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-[#8b949e]">Connecting to relay...</div>
            </div>
          ) : relay.machines.length === 0 ? (
            <div className="flex items-center justify-center h-full p-4">
              <div className="text-center max-w-md">
                <div className="text-[#8b949e] mb-2">No machines available</div>
                <p className="text-sm text-[#6e7681]">
                  {relay.status === "connected"
                    ? "The machine may not be online. Check if 'gssh serve' is running."
                    : "Unable to connect to relay."}
                </p>
              </div>
            </div>
          ) : (
            <MachineListWeb {...machineListProps} />
          )}
        </div>

        {/* Footer */}
        <div className="bg-[#161b22] px-4 py-2 border-t border-[#30363d]">
          <p className="text-xs text-[#6e7681] text-center">
            End-to-end encrypted via X3DH
          </p>
        </div>
      </div>
      <FlowWeb flow={flow} />
      <Toaster theme="dark" position="top-right" richColors />
    </>
  );
}
