/** @jsxImportSource react */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Terminal, type TerminalHandle } from "./components/Terminal";
import { TerminalControls } from "./components/TerminalControls";
import { FloatingJogWheel } from "./components/FloatingJogWheel";
import { useTerminal } from "./hooks/useTerminal";
import { useRelayConnection } from "./hooks/useRelayConnection";
import { useVisualViewport } from "./hooks/useVisualViewport";
import { parseInviteFromHash } from "./lib/invite";
import { applyDeviceClasses, isMobileLayout, isTouchDevice } from "./utils/device";
import { Toaster, toast } from "sonner";

// Import shared components and hooks
import {
  useMachineList,
  useSpacesBrowser,
  useFlow,
  getDefaultShortcuts,
  type MachineInfo,
} from "../../shared/components/index.js";
import { MachineListWeb } from "../../shared/components/MachineList.web.js";
import { SpacesBrowserWeb } from "../../shared/components/SpacesBrowser.web.js";
import { FlowWeb } from "../../shared/components/Flow.web.js";
import { useInbox } from "../../shared/components/Inbox.js";
import { InboxWeb } from "../../shared/components/Inbox.web.js";
import {
  useNotifications,
  type ToastNotification,
  DEFAULT_NOTIFICATION_CONFIG,
} from "../../shared/notifications/index.js";

type View = "machines" | "terminal";

export default function App() {
  const [view, setView] = useState<View>("machines");
  const [selectedMachine, setSelectedMachine] = useState<MachineInfo | null>(null);
  const [showInbox, setShowInbox] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showMobileControls, setShowMobileControls] = useState(false);
  const [inputMode, setInputMode] = useState(false);

  // Terminal ref for external control (focus, sendData)
  const terminalRef = useRef<TerminalHandle>(null);

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
    setInputMode(false); // Reset input mode when leaving terminal
    setView("machines");
  };

  // Handle full disconnect (just refresh the page for simplicity)
  const handleDisconnect = () => {
    terminal.disconnect();
    relay.disconnect();
    setSelectedMachine(null);
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
  const handleAttachSession = (params: { sessionId?: string; workspaceId?: string }) => {
    console.log('[App] handleAttachSession called with:', params);
    if (params.sessionId) {
      // Existing session - attach directly
      console.log('[App] Attaching to existing session:', params.sessionId);
      terminal.attachSession(params);
    } else if (params.workspaceId) {
      // New session - show input modal for name
      flow.showInput({
        title: 'New Session',
        label: 'Session name (optional):',
        placeholder: 'Leave empty for auto-generated name',
        onSubmit: (name) => {
          terminal.attachSession({
            workspaceId: params.workspaceId,
            sessionName: name || undefined
          });
        },
      });
    }
  };

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
      terminal.attachSession({ sessionId });
    },
    onClose: () => setShowInbox(false),
  });

  // ========== Activity Tracking for Notifications ==========

  // Track last activity time for idle detection
  const [lastActivityAt, setLastActivityAt] = useState(Date.now());
  const [activityTick, setActivityTick] = useState(0); // Forces re-evaluation

  // Callback to update activity timestamp (passed to Terminal)
  const handleTerminalActivity = useCallback(() => {
    setLastActivityAt(Date.now());
  }, []);

  // Re-evaluate isUserActive periodically (every 1 second)
  useEffect(() => {
    const interval = setInterval(() => {
      setActivityTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Compute whether user is active based on view and last activity
  const holdWhenIdleMs = DEFAULT_NOTIFICATION_CONFIG.toast.holdWhenIdleMs || 15000;
  const isUserActive = useMemo(() => {
    // Always "active" when not in attached terminal mode
    if (view !== "terminal" || terminal.mode !== "attached") return true;
    // In attached mode, check if activity is recent
    return Date.now() - lastActivityAt < holdWhenIdleMs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, terminal.mode, lastActivityAt, holdWhenIdleMs, activityTick]);

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
          terminal.attachSession({ sessionId: notification.sessionId });
        },
      },
    });
  }, [terminal]);

  const notifications = useNotifications({
    items: terminal.inbox,
    config: DEFAULT_NOTIFICATION_CONFIG,
    onShowToast: handleShowToast,
    onAttachSession: (sessionId) => {
      terminal.attachSession({ sessionId });
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
      terminal.requestWorkspaces();
    }
  }, [view, terminal.status, terminal.mode, terminal.requestWorkspaces]);

  // ========== Keyboard Handlers ==========

  // Machine list keyboard navigation
  useEffect(() => {
    if (view !== "machines") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const key = e.key;
      if (key === "ArrowUp" || key === "k") {
        e.preventDefault();
        machineListProps.moveUp();
      } else if (key === "ArrowDown" || key === "j") {
        e.preventDefault();
        machineListProps.moveDown();
      } else if (key === "Enter") {
        e.preventDefault();
        machineListProps.connectSelected();
      } else if (key === "r") {
        e.preventDefault();
        machineListProps.refresh();
      } else if (key === "c") {
        e.preventDefault();
        machineListProps.copyPublicKey();
      } else if (key === "?") {
        e.preventDefault();
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

      const key = e.key;
      if (key === "ArrowUp" || key === "k") {
        e.preventDefault();
        inboxProps.moveUp();
      } else if (key === "ArrowDown" || key === "j") {
        e.preventDefault();
        inboxProps.moveDown();
      } else if (key === "Enter") {
        e.preventDefault();
        if (inboxProps.isViewingThread) {
          // In thread view, attach to session
          inboxProps.attachToSession();
        } else {
          // In list view, open thread
          inboxProps.openThread();
        }
      } else if (key === "Escape" || key === "q") {
        e.preventDefault();
        if (inboxProps.isViewingThread) {
          inboxProps.closeThread();
        } else {
          setShowInbox(false);
        }
      } else if (key === "x") {
        e.preventDefault();
        if (inboxProps.isViewingThread) {
          inboxProps.deleteThread();
        } else {
          inboxProps.deleteSelected();
        }
      } else if (key === "c") {
        e.preventDefault();
        inboxProps.clearAll();
      } else if (key === "a") {
        e.preventDefault();
        inboxProps.attachToSession();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showInbox, inboxProps.moveUp, inboxProps.moveDown, inboxProps.openThread, inboxProps.closeThread, inboxProps.deleteSelected, inboxProps.deleteThread, inboxProps.clearAll, inboxProps.attachToSession, inboxProps.isViewingThread]);

  // Spaces browser keyboard navigation
  useEffect(() => {
    if (view !== "terminal" || terminal.status !== "established" || terminal.mode !== "browsing" || showInbox) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const key = e.key;
      if (key === "ArrowUp" || key === "k") {
        e.preventDefault();
        spacesBrowserProps.moveUp();
      } else if (key === "ArrowDown" || key === "j") {
        e.preventDefault();
        spacesBrowserProps.moveDown();
      } else if (key === "Enter") {
        e.preventDefault();
        spacesBrowserProps.activateSelected();
      } else if (key === "n") {
        // New session - uses same flow as clicking "+ New Session"
        e.preventDefault();
        spacesBrowserProps.createNewSession();
      } else if (key === "r") {
        e.preventDefault();
        spacesBrowserProps.refresh();
      } else if (key === "Escape" || key === "q") {
        e.preventDefault();
        spacesBrowserProps.back();
      } else if (key === "?") {
        e.preventDefault();
        flow.showHelp(getDefaultShortcuts());
      } else if (key === "x") {
        // Kill session
        e.preventDefault();
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
      } else if (key === "d") {
        // Delete workspace - require typing name to confirm
        e.preventDefault();
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
      } else if (key === "i") {
        // Open inbox
        e.preventDefault();
        terminal.requestInbox();
        setShowInbox(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [view, terminal.status, terminal.mode, spacesBrowserProps, flow]);

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

  // Global hotkey for toast-only attach (Shift+Tab)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Shift+Tab: attach to active toast's session
      if (e.shiftKey && e.key === "Tab" && notifications.activeToast) {
        e.preventDefault();
        notifications.attachToActiveToast();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [notifications.activeToast, notifications.attachToActiveToast]);

  // ========== Spaces Browser View (browsing mode) ==========
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
    // Handler for sending data from mobile controls
    const handleSendData = (data: string) => {
      terminal.send(new TextEncoder().encode(data));
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

    // Show floating jog wheel when in input mode but keyboard is hidden
    const showFloatingJogWheel = showMobileControls && inputMode && !keyboardVisible;

    return (
      <>
        <div className={`w-screen flex flex-col bg-[#0d1117] ${inputMode ? 'h-visual-viewport' : 'h-screen'}`}>
          <div className="bg-[#161b22] px-4 py-2 flex items-center justify-between border-b border-[#30363d] min-h-[52px] gap-2">
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
            {/* Mobile controls toolbar */}
            {showMobileControls && (
              <TerminalControls
                onSendData={handleSendData}
                onFocusTerminal={handleFocusTerminal}
              />
            )}
          </div>
          <div className={`flex-1 ${showMobileControls && inputMode ? 'terminal-with-controls' : ''}`}>
            <Terminal
              ref={terminalRef}
              onData={terminal.send}
              setWriteCallback={terminal.setWriteCallback}
              onResize={terminal.resize}
              allowTapFocus={inputMode || !showMobileControls}
              onActivity={handleTerminalActivity}
            />
          </div>
          {/* Mobile controls toolbar - only show in input mode */}
          {showMobileControls && inputMode && (
            <TerminalControls
              onSendData={handleSendData}
              onFocusTerminal={handleFocusTerminal}
            />
          )}
          {/* Floating jog wheel - show when input mode is on but keyboard is hidden */}
          {showFloatingJogWheel && (
            <FloatingJogWheel onDirection={handleSendData} />
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
