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

// Import shared components and hooks
import {
  useMachineList,
  useSpacesBrowser,
  useFlow,
  getDefaultShortcuts,
  type MachineInfo,
} from "./components/index.js";
import { MachineListWeb } from "./components/MachineList.web.js";
import { SpacesBrowserWeb } from "./components/SpacesBrowser.web.js";
import { FlowWeb } from "./components/Flow.web.js";
import { useInbox } from "./components/Inbox.js";
import { InboxWeb } from "./components/Inbox.web.js";
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

type View = "machines" | "terminal";

const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';

export default function App() {
  const [view, setView] = useState<View>("machines");
  const [selectedMachine, setSelectedMachine] = useState<MachineInfo | null>(null);
  const [showInbox, setShowInbox] = useState(false);
  const [showScriptTerminal, setShowScriptTerminal] = useState(false);
  const [scriptWorkspaceName, setScriptWorkspaceName] = useState('workspace');
  const [copied, setCopied] = useState(false);
  const [showMobileControls, setShowMobileControls] = useState(false);
  const [inputMode, setInputMode] = useState(false);
  const [modifiers, setModifiers] = useState<ModifierState>({
    ctrl: false,
    shift: false,
    alt: false,
  });
  const [localNotificationConfig, setLocalNotificationConfig] =
    useState<NotificationConfig | null>(null);

  // Terminal ref for external control (focus, sendData)
  const terminalRef = useRef<SessionTerminalHandle>(null);
  const lastScriptErrorRef = useRef<string | null>(null);
  const lastCommandErrorRef = useRef<string | null>(null);

  // Invite params from URL
  const [inviteParams, setInviteParams] = useState<{
    machineId?: string;
    inviteId?: string;
    inviteToken?: string;
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

      if (params.workspaceId) {
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

  // Parse invite from URL hash on load
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
    const scriptError = terminal.scriptState?.error;
    if (!scriptError) {
      lastScriptErrorRef.current = null;
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

    const isScriptFailure =
      terminal.commandError.code === 'SCRIPT_FAILED' ||
      terminal.commandError.code === 'PRE_SCRIPT_FAILED' ||
      terminal.commandError.code === 'SETUP_SCRIPT_FAILED' ||
      terminal.commandError.code === 'SELECT_SCRIPT_FAILED';

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
    setInputMode(false); // Reset input mode when leaving terminal
    setView("machines");
  };

  // Handle full disconnect (just refresh the page for simplicity)
  const handleDisconnect = () => {
    terminal.disconnect();
    relay.disconnect();
    setSelectedMachine(null);
    setShowScriptTerminal(false);
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
  const handleAttachSession = useCallback(async (params: { sessionId?: string; workspaceId?: string }) => {
    await attachController.attachFromSelection(params);
  }, [attachController]);

  // Spaces browser hook
  const spacesBrowserProps = useSpacesBrowser({
    workspaces: terminal.workspaces,
    sessions: terminal.sessions,
    onRequestSessions: terminal.requestSessions,
    onAttachSession: handleAttachSession,
    onRefresh: terminal.requestWorkspaces,
    onRefreshSessions: (workspaceIds) => {
      workspaceIds.forEach(id => terminal.requestSessions(id));
    },
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
      terminal.requestNotificationConfig();
    }
  }, [
    view,
    terminal.status,
    terminal.mode,
    terminal.requestProjects,
    terminal.requestWorkspaces,
    terminal.requestNotificationConfig,
  ]);

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

  // Spaces browser keyboard navigation
  useEffect(() => {
    if (view !== "terminal" || terminal.status !== "established" || terminal.mode !== "browsing" || showInbox || showScriptTerminal) {
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
            onConfirm: () => {
              terminal.deleteWorkspace(selected.workspace.projectName, selected.workspace.id);
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
  }, [view, terminal.status, terminal.mode, showInbox, showScriptTerminal, spacesBrowserProps, flow]);

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

  // ========== Spaces Browser View (browsing mode) ==========
  if (
    view === 'terminal' &&
    terminal.status === 'established' &&
    terminal.mode === 'browsing' &&
    showScriptTerminal
  ) {
    return (
      <>
        <ScriptTerminal
          phase={terminal.scriptState?.phase ?? 'pre'}
          workspaceName={scriptWorkspaceName}
          isRunning={terminal.scriptState?.isRunning ?? true}
          error={terminal.scriptState?.error}
          exitCode={terminal.scriptState?.exitCode}
          setWriteCallback={terminal.setWriteCallback}
          onBack={() => setShowScriptTerminal(false)}
        />
        <FlowWeb flow={flow} />
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
            <SpacesBrowserWeb {...spacesBrowserProps} />
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
