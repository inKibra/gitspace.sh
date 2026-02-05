/** @jsxImportSource react */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Terminal, type TerminalHandle } from "./components/Terminal";
import {
  TerminalControls,
  applyModifiersToInput,
  type ModifierState,
} from "./components/TerminalControls";
import { FloatingControls } from "./components/FloatingControls";
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
    useProjectList,
    useFlow,
    getDefaultShortcuts,
    type MachineInfo,
    type ProjectInfo,
  } from "../../shared/components/index.js";

import { MachineListWeb } from "../../shared/components/MachineList.web.js";
import { SpacesBrowserWeb } from "../../shared/components/SpacesBrowser.web.js";
import { ProjectListWeb } from "../../shared/components/ProjectList.web.js";
import { FlowWeb } from "../../shared/components/Flow.web.js";
import { useInbox } from "../../shared/components/Inbox.js";
import { InboxWeb } from "../../shared/components/Inbox.web.js";
import { useEvents } from "../../shared/components/Events.js";
import { EventsWeb } from "../../shared/components/Events.web.js";
import type { WideEvent } from "../../types/events.js";
import {
  useNotifications,
  type ToastNotification,
  DEFAULT_NOTIFICATION_CONFIG,
  getSessionLabel,
} from "../../shared/notifications/index.js";

type View = "machines" | "terminal";

export default function App() {
  const [view, setView] = useState<View>("machines");
  const [selectedMachine, setSelectedMachine] = useState<MachineInfo | null>(null);
  const [showInbox, setShowInbox] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [eventsWorkspacePath, setEventsWorkspacePath] = useState<string | null>(null);
  const [eventsWorkspaceLabel, setEventsWorkspaceLabel] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showMobileControls, setShowMobileControls] = useState(false);
  const [inputMode, setInputMode] = useState(false);
  const [showProjectsDrawer, setShowProjectsDrawer] = useState(false);
  const [showProjectsPanel, setShowProjectsPanel] = useState(!isMobileLayout());
  const [modifiers, setModifiers] = useState<ModifierState>({
    ctrl: false,
    shift: false,
    alt: false,
  });

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
    const mobileLayout = isMobileLayout();
    setShowMobileControls(isTouchDevice() || mobileLayout);
    setShowProjectsPanel(!mobileLayout);

    // Listen for layout changes
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const handleChange = (e: MediaQueryListEvent) => {
      setShowMobileControls(e.matches || isTouchDevice());
      setShowProjectsPanel(!e.matches);
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
    setShowEvents(false);
    setView("machines");
  };

  // Handle full disconnect (just refresh the page for simplicity)
  const handleDisconnect = () => {
    terminal.disconnect();
    relay.disconnect();
    setSelectedMachine(null);
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

  const projectListProps = useProjectList({
    projects: terminal.projects,
    onSelect: (project: ProjectInfo) => {
      terminal.selectProject(project.name);
      terminal.requestWorkspaces();
      terminal.requestSessions();
      setShowProjectsDrawer(false);
      setShowProjectsPanel(true);
    },
    onCreateNew: () => {
      flow.showMessage({
        title: 'New Project',
        message: 'Use "gssh add project" from the CLI to add a project.',
        variant: 'info',
      });
    },
    onDelete: (project: ProjectInfo) => {
      flow.showMessage({
        title: 'Delete Project',
        message: `Delete ${project.name} from the CLI for now.`,
        variant: 'warning',
      });
    },
    onRefresh: terminal.requestProjects,
  });

  const activeProjectName = useMemo(() => {
    return terminal.selectedProjectName ?? terminal.projects.find((project) => project.isCurrent)?.name ?? null;
  }, [terminal.selectedProjectName, terminal.projects]);

  useEffect(() => {
    if (!terminal.selectedProjectName && activeProjectName) {
      terminal.selectProject(activeProjectName);
      terminal.requestSessions();
    }
  }, [terminal.selectedProjectName, activeProjectName, terminal.selectProject, terminal.requestSessions]);

  const visibleWorkspaces = useMemo(() => {
    if (!activeProjectName) return terminal.workspaces;
    return terminal.workspaces.filter((workspace) => workspace.projectName === activeProjectName);
  }, [terminal.workspaces, activeProjectName]);

  const visibleWorkspaceIds = useMemo(() => new Set(visibleWorkspaces.map((workspace) => workspace.id)), [visibleWorkspaces]);

  const visibleSessions = useMemo(() => {
    if (!activeProjectName) return terminal.sessions;
    return terminal.sessions.filter((session) => visibleWorkspaceIds.has(session.workspaceId));
  }, [terminal.sessions, visibleWorkspaceIds, activeProjectName]);

  useEffect(() => {
    if (terminal.status === "established" && showProjectsDrawer) {
      terminal.requestProjects();
    }
  }, [terminal.status, showProjectsDrawer, terminal.requestProjects]);

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
    workspaces: visibleWorkspaces,
    sessions: visibleSessions,
    onRequestSessions: terminal.requestSessions,
    onAttachSession: handleAttachSession,
    onStartProcess: ({ workspaceId, processName }) => {
      terminal.startProcess(workspaceId, processName);
    },
    onStartProcessAttach: ({ workspaceId, processName, instance }) => {
      void instance;
      terminal.startProcess(workspaceId, processName);
    },
    onStopProcess: ({ workspaceId, processName }) => {
      terminal.stopProcess(workspaceId, processName);
    },
    onOpenEvents: (workspaceId) => {
      const workspace = terminal.workspaces.find((item) => item.id === workspaceId);
      const label = workspace ? `${workspace.projectName}/${workspace.name}` : workspaceId;
      setEventsWorkspacePath(workspace?.path ?? null);
      setEventsWorkspaceLabel(label);
      setShowEvents(true);
      terminal.resetEvents();
      if (workspace?.path) {
        terminal.requestEvents(workspace.path, { kind: 'wide' }, 200);
      }
    },
    onRefresh: terminal.requestWorkspaces,
    onRefreshSessions: (workspaceIds) => {
      workspaceIds.forEach(id => terminal.requestSessions(id));
    },
    onBack: handleBackToMachines,
    machineName: selectedMachine?.label || selectedMachine?.machineId,
    showProjectHeaders: false,
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

  const eventsProps = useEvents({
    events: (terminal.events as unknown as WideEvent[]).map((event) => ({
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
    })),
    liveEventIds: terminal.liveEventIds,
    savedFilters: terminal.savedEventFilters,
    onSelectFilter: (filter) => {
      if (!eventsWorkspacePath) return;
      terminal.resetEvents();
      const sinceMs = filter?.sinceMinutes ? Date.now() - filter.sinceMinutes * 60_000 : undefined;
      terminal.requestEvents(eventsWorkspacePath, { ...filter?.filter, kind: 'wide' }, 200, sinceMs);
    },
    onClose: () => setShowEvents(false),
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

  useEffect(() => {
    if (!showEvents) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === "Escape" || e.key === "q") {
        e.preventDefault();
        setShowEvents(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showEvents]);

  useEffect(() => {
    if (!showEvents || !eventsWorkspacePath) return;
    const pollIntervalMs = 2000;

    const poll = () => {
      terminal.requestEvents(eventsWorkspacePath, { kind: 'wide' }, 200);
    };

    poll();
    const interval = window.setInterval(poll, pollIntervalMs);
    return () => window.clearInterval(interval);
  }, [showEvents, eventsWorkspacePath, terminal.requestEvents]);


  // Spaces browser keyboard navigation
  useEffect(() => {
    if (view !== "terminal" || terminal.status !== "established" || terminal.mode !== "browsing" || showInbox || showEvents) {
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

    if (showEvents) {
        return (
          <>
            <div className="h-visual-viewport overflow-hidden">
              <EventsWeb {...eventsProps} workspaceLabel={eventsWorkspaceLabel} />
            </div>
            <FlowWeb flow={flow} />
            <Toaster theme="dark" position="top-right" richColors />
          </>
        );

    }

        return (
      <>
        <div className="h-screen w-screen flex flex-col bg-[#0d1117]">
          <div className="bg-[#161b22] px-4 py-2 flex items-center justify-end border-b border-[#30363d] min-h-[52px] gap-2">
            <div className="flex items-center gap-2 sm:gap-4">
              <button
                onClick={() => {
                  setShowProjectsDrawer(true);
                  terminal.requestProjects();
                }}
                className="sm:hidden text-sm text-[#8b949e] hover:text-[#e6edf3] active:text-[#22c55e] flex items-center gap-1 py-2 px-2 min-h-[44px]"
              >
                Projects
              </button>
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
            <div className="h-full flex flex-col sm:flex-row">
              {showProjectsPanel && (
                <div className="hidden sm:flex sm:w-[320px] sm:border-r sm:border-[#30363d] sm:bg-[#0d1117]">
                  <ProjectListWeb {...projectListProps} />
                </div>
              )}
              <div className="flex-1">
                <SpacesBrowserWeb {...spacesBrowserProps} />
              </div>
            </div>
          </div>
        </div>
        {showProjectsDrawer && (
          <div className="fixed inset-0 z-40 sm:hidden">
            <div
              className="absolute inset-0 bg-black/60"
              onClick={() => setShowProjectsDrawer(false)}
            />
            <div className="absolute inset-y-0 left-0 w-[85%] max-w-[320px] bg-[#0d1117] border-r border-[#30363d] shadow-xl animate-[drawerIn_160ms_ease-out]">
              <ProjectListWeb
                {...projectListProps}
                onClose={() => setShowProjectsDrawer(false)}
              />
            </div>
          </div>
        )}
        <FlowWeb flow={flow} />
        <Toaster theme="dark" position="top-right" richColors />
      </>
    );

  }

  // ========== Terminal View (attached mode) ==========
  if (view === "terminal" && terminal.status === "established" && terminal.mode === "attached") {
    // Handler for sending data from mobile controls (already processed)
    const handleSendData = (data: string) => {
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
            <Terminal
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
