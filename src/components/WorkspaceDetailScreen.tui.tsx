/**
 * WorkspaceDetailScreen - Full-screen workspace detail view for TUI.
 *
 * Matches the Figma "Workspace Detail View - Editor" design (node 1:1776).
 * Layout: header (workspace pill switcher) + sidebar (agents/terminals/services/system) + main (attached terminal).
 *
 * Focus model:
 *   'sidebar'  → ↑/↓ navigate items; Enter activates; Tab → 'workspace-pills'; Esc → onBack
 *   'terminal' → full PTY focus (entered via onAttachSession); Shift+Esc → 'sidebar'
 *   'status'   → status picker overlay; ↑/↓ pick phase; Enter apply; Esc close
 *
 * Creating a new session:
 *   Press [n] or [N] from sidebar focus → calls onAttachSession({ workspaceId })
 *   which triggers the session-name prompt then creates+attaches.
 */

import type { ScrollBoxRenderable } from '@opentui/core';
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useKeyboard } from '@opentui/react';
import type { WorkspaceDetailPaneProps } from './WorkspaceDetailPane.js';
import type { SessionInfo } from './SpacesBrowser.js';
import { formatTime, getAgentSessionDisplayState } from './SpacesBrowser.js';
import { SessionTerminal } from './SessionTerminal.tui.js';
import { ScriptTerminal } from './ScriptTerminal.tui.js';
import type { WorkspaceStatusInput } from '../app/workspaces/workspace-status.js';
import { PHASES, PHASE_LABELS } from '../app/shared/board/types.js';
import type { WorkspacePhase } from '../types/config.js';
import type { UseFlowReturn } from './Flow.js';
import type { WorkspaceDetailStripStatus } from './WorkspaceDetailPane.js';
import { useWorkspaceDetailModel } from '../app/shared/workspace-detail/useWorkspaceDetailModel.js';
import { openBrowserUrl } from '../utils/open-browser.js';
import { showServiceLauncherSelect } from '../app/shared/workspace-detail/showServiceLauncherSelect.js';

const COLORS = {
  bg: '#0b0b0c',
  bgSidebar: '#161618',
  bgSelected: '#1c1c1e',
  bgOpen: '#11261a',
  border: '#2c2c2e',
  borderFocused: '#00AAFF',
  text: '#c9d1d9',
  textDim: '#52525b',
  textMid: '#a1a1aa',
  title: '#00FF88',
  selected: '#00AAFF',
  statusBar: '#161618',
  sectionHeader: '#52525b',
  green: '#10b981',
  amber: '#f59e0b',
  red: '#ef4444',
  blue: '#3b82f6',
};

/** Layout chrome reserved when embedding terminals inline (sidebar + borders + main padding + terminal border + terminal padding). */
export const WORKSPACE_DETAIL_TERMINAL_RESERVED_COLS = 46;
/** Layout chrome reserved when embedding terminals inline (header + main padding + terminal border + terminal padding + status bar). */
export const WORKSPACE_DETAIL_TERMINAL_RESERVED_ROWS = 8;



type ScreenFocus = 'sidebar' | 'workspace-pills' | 'terminal' | 'status-picker';

function getStatusColor(status: WorkspaceDetailStripStatus | undefined): string {
  switch (status?.primaryColor) {
    case 'green':
      return COLORS.green;
    case 'blue':
      return COLORS.blue;
    case 'orange':
      return COLORS.amber;
    case 'red':
      return COLORS.red;
    case 'dim':
    default:
      return COLORS.textDim;
  }
}

export interface WorkspaceDetailScreenProps extends WorkspaceDetailPaneProps {
  /** Label for the machine this workspace is running on */
  machineLabel?: string;
  /** Called when user presses Esc to return to kanban board */
  onBack: () => void;
  /** Called when user selects a new kanban phase via the status picker */
  onChangeStatus?: (workspaceId: string, phase: WorkspacePhase) => void;
  /** All workspaces for sibling pills in the header */
  allWorkspaces?: (WorkspaceStatusInput & { name: string; projectName: string })[];
  /** Shared workspace status summary for sibling pills. */
  workspaceStatusById?: Record<string, WorkspaceDetailStripStatus>;
  /** Select another workspace from top pills */
  onSelectWorkspace?: (workspaceSelectionKey: string) => void;
  /** Inline terminal bindings for active attached session */
  terminalBindings?: {
    attachedSessionId: string | null;
    attachedWorkspaceId?: string | null;
    attachedAgentSessionId?: string | null;
    attachedSessionName?: string | null;
    attachedSessionMeta?: {
      processTitle?: string | null;
      terminalTitle?: string | null;
      lastAlertKind?: string | null;
      unreadAlertCount?: number | null;
    } | null;
    onData: (data: Uint8Array) => void;
    onResize: (cols: number, rows: number) => void;
    onDetach: () => void | Promise<void>;
    setWriteCallback: (fn: ((data: Uint8Array) => void) | null) => void;
    modalOpen?: boolean;
    readOnly?: boolean;
  };
  scriptBindings?: {
    workspaceId: string | null;
    workspaceName: string;
    scriptState: { phase: 'pre' | 'setup' | 'select' | 'remove'; isRunning: boolean; error?: string; exitCode?: number } | null;
    modalOpen?: boolean;
    setWriteCallback: (fn: ((data: Uint8Array) => void) | null) => void;
    canAttachAnyway?: boolean;
    onAttachAnyway?: () => void | Promise<void>;
  };
  onAbortAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
  onCloseAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
  onArchiveAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
  onRestoreAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
  /** Flow for confirmation modals and service launcher dialogs. */
  flow?: Pick<UseFlowReturn, 'showConfirm' | 'showSelect' | 'showMessage'>;
}

export function WorkspaceDetailScreen(props: WorkspaceDetailScreenProps) {
  const {
    workspace,
    sessions,
    replays,
    agentSessions = [],
    agentSessionCount = 0,
    pendingPermissions = 0,
    onAttachSession,
    onOpenReplay,
    onOpenReplayHistory,
    onStartProcess,
    onStartProcessAttach,
    onStopProcess,
    onManageBundleConfig,
    onEditProcesses,
    onOpenReview,
    onOpenGitHubPullRequest,
    onOpenEvents,
    onOpenAgentSession,
    onCreateAgentSession,
    onDeleteSession,
    machineLabel = 'local',
    onBack,
    onChangeStatus,
    onLaunchCommit,
    allWorkspaces = [],
    workspaceStatusById = {},
    onSelectWorkspace,
    terminalBindings,
    scriptBindings,
    onAbortAgentSession,
    onCloseAgentSession,
    onArchiveAgentSession,
    onRestoreAgentSession,
    flow,
  } = props;

  const [focus, setFocus] = useState<ScreenFocus>('sidebar');
  const [sidebarCursor, setSidebarCursor] = useState(0);
  const [statusPickerCursor, setStatusPickerCursor] = useState(0);
  const [workspacePillCursor, setWorkspacePillCursor] = useState(0);
  const pullRequest = workspace.pullRequest;
  const workspacePillScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const detailModel = useWorkspaceDetailModel({
    workspace,
    sessions,
    replays,
    agentSessions,
    allWorkspaces,
    workspaceStatusById,
    actions: {
      onSelectWorkspace,
      onAttachSession,
      onOpenReplay,
      onOpenReplayHistory,
      onStartProcessAttach: onStartProcessAttach ?? onStartProcess,
      onStopProcess,
      onManageBundleConfig,
      onEditProcesses,
      onOpenReview,
      onOpenGitHubPullRequest,
      onLaunchCommit,
      onRequestStatusChange: onChangeStatus ? (workspaceId) => onChangeStatus(workspaceId, PHASES[statusPickerCursor] ?? 'code') : undefined,
      onOpenAgentSession,
      onCreateAgentSession,
      onAbortAgentSession,
      onCloseAgentSession,
      onArchiveAgentSession,
      onRestoreAgentSession,
      onDeleteSession,
    },
  });
  const {
    phase: phaseStr,
    workspaceSessions,
    workspaceReplays,
    visibleStripWorkspaces: siblingWorkspaces,
    stripDisplayItems: pillDisplayItems,
    currentWorkspaceStripIndex,
    activeAgentSessions,
    archivedAgentSessions,
    showArchivedAgents,
    toggleArchivedAgents,
    agentRows,
    agentTodoPhases,
    sessionRows,
    replayRows,
    visibleReplayRows,
    hasMoreReplayRows,
    seeAllReplayLabel,
    notesSummary,
    visibleTodoRows,
    visibleRecentNoteRows,
    serviceRows,
    pmRows,
    footerActions,
    actions: detailActions,
  } = detailModel;

  useEffect(() => {
    setWorkspacePillCursor(currentWorkspaceStripIndex);
  }, [currentWorkspaceStripIndex]);

  useEffect(() => {
    const scrollbox = workspacePillScrollRef.current;
    if (!scrollbox || focus !== 'workspace-pills') {
      return;
    }
    const targetWorkspace = siblingWorkspaces[workspacePillCursor];
    let offset = 0;
    for (const di of pillDisplayItems) {
      if (di.type === 'workspace' && di.workspace.id === targetWorkspace?.id) break;
      // project-label: "ProjectName: " — name + colon + leading space
      if (di.type === 'project-label') offset += di.projectName.length + 2;
      // workspace pill: "● name  " — dot + space + name + padding(2)
      else offset += di.workspace.name.length + 4;
    }
    scrollbox.scrollTo({ x: Math.max(0, offset - 2), y: 0 });
  }, [focus, pillDisplayItems, siblingWorkspaces, workspacePillCursor]);

  const attachedWorkspaceSession = useMemo(
    () => workspaceSessions.find((session) => session.id === terminalBindings?.attachedSessionId) ?? null,
    [workspaceSessions, terminalBindings?.attachedSessionId],
  );
  const attachedAgentSession = useMemo(
    () => agentSessions.find((session) => session.id === terminalBindings?.attachedAgentSessionId) ?? null,
    [agentSessions, terminalBindings?.attachedAgentSessionId],
  );
  const attachedWorkspaceMatchesCurrent = Boolean(
    terminalBindings?.attachedWorkspaceId === workspace.id
      && (terminalBindings.attachedSessionId || terminalBindings.attachedSessionName),
  );
  const showInlineScriptTerminal = Boolean(
    scriptBindings?.scriptState && scriptBindings.workspaceId === workspace.id
  );
  const showInlineSessionTerminal = Boolean(
    terminalBindings && !showInlineScriptTerminal && (attachedWorkspaceSession || attachedAgentSession || attachedWorkspaceMatchesCurrent)
  );

  const activeInlineTerminalKey = useMemo(
    () => attachedWorkspaceSession?.id
      ?? attachedAgentSession?.id
      ?? (showInlineScriptTerminal ? `${workspace.id}:${scriptBindings?.scriptState?.phase ?? 'script'}` : null),
    [attachedAgentSession?.id, attachedWorkspaceSession?.id, scriptBindings?.scriptState?.phase, showInlineScriptTerminal, workspace.id],
  );

  const previousInlineTerminalKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeInlineTerminalKey) {
      previousInlineTerminalKeyRef.current = null;
      return;
    }
    if (previousInlineTerminalKeyRef.current === activeInlineTerminalKey) {
      return;
    }
    previousInlineTerminalKeyRef.current = activeInlineTerminalKey;
    setFocus('terminal');
  }, [activeInlineTerminalKey]);
  const attachedServiceIdentity = useMemo(
    () => attachedWorkspaceSession?.processName
      ? {
          processName: attachedWorkspaceSession.processName,
          instance: attachedWorkspaceSession.processInstance ?? 1,
        }
      : null,
    [attachedWorkspaceSession],
  );

  // Build flat sidebar items list for keyboard navigation
  type SidebarItem =
    | { kind: 'agent'; id: string; label: string; closedAt?: string }
    | { kind: 'archived-agents-toggle' }
    | { kind: 'archived-agent'; id: string; label: string }
    | { kind: 'new-agent-session' }
    | { kind: 'session'; session: SessionInfo }
    | { kind: 'new-session' }
    | { kind: 'service'; name: string; instance: number; port: string }
     | { kind: 'history'; replayId: string; label: string }
     | { kind: 'history-see-all'; label: string }
     | { kind: 'open-github-pr' }
     | { kind: 'open-review' }
     | { kind: 'launch-commit' }
     | { kind: 'event-logs' }
     | { kind: 'bundle-config' }
     | { kind: 'process-config' }
    | { kind: 'change-status' };

  const sidebarItems = useMemo((): SidebarItem[] => {
    const items: SidebarItem[] = [];
    for (const a of agentRows.filter((row) => row.bucket === 'active' || row.bucket === 'closed')) {
      items.push({ kind: 'agent', id: a.id, label: a.title, closedAt: a.bucket === 'closed' ? 'closed' : undefined });
    }
    if (archivedAgentSessions.length > 0) {
      items.push({ kind: 'archived-agents-toggle' });
      if (showArchivedAgents) {
        for (const a of agentRows.filter((row) => row.bucket === 'archived')) {
          items.push({ kind: 'archived-agent', id: a.id, label: a.title });
        }
      }
    }
    items.push({ kind: 'new-agent-session' });
    for (const s of workspaceSessions.filter((session) => sessionRows.some((row) => row.id === session.id) && !session.processName)) {
      items.push({ kind: 'session', session: s });
    }
    items.push({ kind: 'new-session' });
    for (const service of serviceRows.filter((row) => row.state !== 'disabled')) {
      items.push({
        kind: 'service',
        name: service.processName,
        instance: service.instance,
        port: service.portLabel ?? '',
      });
    }
    for (const replay of visibleReplayRows) {
      items.push({ kind: 'history', replayId: replay.replayId, label: replay.label });
    }
    if (hasMoreReplayRows && seeAllReplayLabel) {
      items.push({ kind: 'history-see-all', label: seeAllReplayLabel });
    }
    items.push({ kind: 'event-logs' });
    for (const action of footerActions) {
      if (action.id === 'open-github-pr') items.push({ kind: 'open-github-pr' });
      else if (action.id === 'open-review' && onOpenReview) items.push({ kind: 'open-review' });
      else if (action.id === 'launch-commit' && onLaunchCommit) items.push({ kind: 'launch-commit' });
      else if (action.id === 'edit-bundle-config') items.push({ kind: 'bundle-config' });
      else if (action.id === 'edit-process-config') items.push({ kind: 'process-config' });
      else if (action.id === 'change-status') items.push({ kind: 'change-status' });
    }
    return items;
  }, [agentRows, archivedAgentSessions.length, footerActions, hasMoreReplayRows, onLaunchCommit, onOpenReview, seeAllReplayLabel, showArchivedAgents, visibleReplayRows, workspace.processes, workspaceSessions, sessionRows]);

  const clampSidebar = useCallback(
    (idx: number) => Math.max(0, Math.min(sidebarItems.length - 1, idx)),
    [sidebarItems.length]
  );

  const getSidebarIndex = useCallback(
    (predicate: (item: SidebarItem) => boolean) => sidebarItems.findIndex(predicate),
    [sidebarItems]
  );

  const isSidebarItemSelected = useCallback(
    (predicate: (item: SidebarItem) => boolean) =>
      focus === 'sidebar' && sidebarCursor === getSidebarIndex(predicate),
    [focus, sidebarCursor, getSidebarIndex]
  );

  const activateCurrentSidebarItem = useCallback(() => {
    const item = sidebarItems[sidebarCursor];
    if (!item) return;

    switch (item.kind) {
      case 'session': {
        void detailActions.attachSession(item.session.id);
        setFocus('terminal');
        break;
      }
      case 'agent': {
        void detailActions.openAgentSession(item.id);
        setFocus('terminal');
        break;
      }
      case 'archived-agents-toggle':
        toggleArchivedAgents();
        break;
      case 'archived-agent':
        void detailActions.restoreAgentSession(item.id);
        break;
      case 'new-session':
        void detailActions.createSession();
        break;
      case 'new-agent-session':
        void detailActions.createAgentSession();
        break;
      case 'service': {
        const matchingSessions = workspaceSessions.filter(
          (s) => s.processName === item.name && (s.processInstance ?? 1) === item.instance && s.exitCode === undefined
        );
        if (matchingSessions.length > 0) {
          void onAttachSession({ sessionId: matchingSessions[0]!.id, viewOnly: true });
          setFocus('terminal');
        } else {
          void detailActions.activateService(item.name, item.instance, 'stopped');
        }
        break;
      }
      case 'history': {
        void detailActions.openReplay(item.replayId);
        break;
      }
      case 'history-see-all': {
        void detailActions.openReplayHistory();
        break;
      }
      case 'open-github-pr':
        void detailActions.footerAction('open-github-pr');
        break;
      case 'open-review':
        void detailActions.footerAction('open-review');
        break;
      case 'launch-commit':
        void detailActions.footerAction('launch-commit');
        setFocus('terminal');
        break;
      case 'event-logs':
        onOpenEvents(workspace.id);
        break;
      case 'bundle-config':
        void detailActions.footerAction('edit-bundle-config');
        break;
      case 'process-config':
        void detailActions.footerAction('edit-process-config');
        break;
      case 'change-status':
        setStatusPickerCursor(PHASES.indexOf(phaseStr as WorkspacePhase) >= 0
          ? PHASES.indexOf(phaseStr as WorkspacePhase)
          : 0);
        setFocus('status-picker');
        break;
    }
  }, [
    sidebarItems,
    sidebarCursor,
    detailActions,
    onAttachSession,
    onOpenEvents,
    workspaceSessions,
    phaseStr,
  ]);

  const applyStatusPicker = useCallback(() => {
    const phase = PHASES[statusPickerCursor];
    if (phase && onChangeStatus) {
      onChangeStatus(workspace.id, phase);
    }
    setFocus('sidebar');
  }, [statusPickerCursor, onChangeStatus, workspace.id]);

  const moveWorkspacePhase = useCallback((delta: -1 | 1) => {
    if (!onChangeStatus) return;
    const currentIndex = PHASES.indexOf(phaseStr as WorkspacePhase);
    if (currentIndex < 0) return;
    const nextPhase = PHASES[currentIndex + delta];
    if (!nextPhase) return;
    onChangeStatus(workspace.id, nextPhase);
  }, [onChangeStatus, phaseStr, workspace.id]);

  const activateWorkspacePill = useCallback(() => {
    const selected = siblingWorkspaces[workspacePillCursor];
    const selectionKey = selected?.selectionKey;
    if (!selectionKey) {
      return;
    }
    detailActions.selectWorkspace(selectionKey);
  }, [siblingWorkspaces, workspacePillCursor, detailActions]);

  const openSelectedServiceLauncher = useCallback(() => {
    const item = sidebarItems[sidebarCursor];
    if (item?.kind !== 'service' || !flow) {
      return false;
    }

    const shown = showServiceLauncherSelect({
      workspace,
      processName: item.name,
      instance: item.instance,
      showSelect: (config) => flow.showSelect<string>(config),
      onSelectUrl: async (url) => {
        const result = await openBrowserUrl(url);
        if (!result.ok) {
          flow.showMessage({
            title: 'Open Service',
            message: result.message,
            variant: 'error',
          });
        }
      },
    });

    if (!shown) {
      flow.showMessage({
        title: 'Open Service',
        message: `${item.name}#${item.instance} has no browser-openable HTTP ports.`,
        variant: 'info',
      });
    }

    return true;
  }, [flow, sidebarCursor, sidebarItems, workspace]);

  useKeyboard(
    useCallback(
      (key) => {
        if (
          key.raw === 'a' &&
          focus !== 'status-picker' &&
          scriptBindings?.canAttachAnyway
        ) {
          void scriptBindings.onAttachAnyway?.();
          return;
        }

        // When a flow modal is open, don't handle keys — let the app process them (confirm, input, etc.)
        if (terminalBindings?.modalOpen || scriptBindings?.modalOpen) {
          return;
        }

        // Status picker overlay — highest priority
        if (focus === 'status-picker') {
          if (key.name === 'escape') {
            setFocus('sidebar');
          } else if (key.name === 'up' || (key.raw === 'k' && !key.shift)) {
            setStatusPickerCursor((i) => Math.max(0, i - 1));
          } else if (key.name === 'down' || key.raw === 'j') {
            setStatusPickerCursor((i) => Math.min(PHASES.length - 1, i + 1));
          } else if (key.name === 'return') {
            applyStatusPicker();
          }
          return;
        }
        // Shift+Esc: release terminal PTY back to sidebar
        if (key.shift && key.name === 'escape') {
          if (focus === 'terminal') setFocus('sidebar');
          return;
        }

        // Global: n/N to create a new ad-hoc session
        if (focus !== 'terminal' && (key.raw === 'n' || key.raw === 'N')) {
          void onAttachSession({ workspaceId: workspace.id });
          return;
        }

        if (focus === 'sidebar' || focus === 'workspace-pills') {
          if (key.name === 'escape') {
            onBack();
            return;
          }
          if (key.shift && (key.name === 'left' || key.name === 'right')) {
            moveWorkspacePhase(key.name === 'left' ? -1 : 1);
            return;
          }
        }
        if (focus === 'sidebar' || focus === 'workspace-pills') {
          if (key.name === 'tab') {
            if (focus === 'sidebar') {
              setFocus('workspace-pills');
            } else {
              setFocus('sidebar');
            }
            return;
          }
        }

        if (focus === 'sidebar') {
          if (key.raw === 'o') {
            if (openSelectedServiceLauncher()) {
              return;
            }
          }
          if (key.raw === 'x') {
            const item = sidebarItems[sidebarCursor];
            if (item?.kind === 'session' && onDeleteSession) {
              onDeleteSession(item.session.id, item.session.name);
            } else if (item?.kind === 'agent' && flow) {
              if (item.closedAt && onArchiveAgentSession) {
                flow.showConfirm({
                  title: 'Archive Agent Session',
                  message: `Archive agent session "${item.label}"? It will be hidden from the list.`,
                  variant: 'warning',
                  confirmLabel: 'Archive',
                  onConfirm: () => void onArchiveAgentSession(workspace.id, item.id),
                });
              } else if (onCloseAgentSession) {
                flow.showConfirm({
                  title: 'Close Agent Session',
                  message: `Close agent session "${item.label}"? It will remain in history as closed.`,
                  variant: 'warning',
                  confirmLabel: 'Close',
                  onConfirm: () => void onCloseAgentSession(workspace.id, item.id),
                });
              }
            } else if (item?.kind === 'archived-agent' && onRestoreAgentSession) {
              void onRestoreAgentSession(workspace.id, item.id);
            } else if (item?.kind === 'service') {
              onStopProcess({ workspaceId: workspace.id, processName: item.name });
            }
            return;
          }
          if (key.raw === 'K') {
            const item = sidebarItems[sidebarCursor];
            if (item?.kind === 'agent' && !item.closedAt && onAbortAgentSession) {
              void onAbortAgentSession(workspace.id, item.id);
              return;
            }
          }
          if (key.shift && key.name?.toLowerCase() === 'x') {
            const item = sidebarItems[sidebarCursor];
            if (item?.kind === 'agent' && onArchiveAgentSession && flow) {
              flow.showConfirm({
                title: 'Archive Agent Session',
                message: `Archive agent session "${item.label}"?`,
                variant: 'warning',
                confirmLabel: 'Archive',
                onConfirm: () => void onArchiveAgentSession(workspace.id, item.id),
              });
            }
            return;
          }
          if (key.name === 'up' || (key.raw === 'k' && !key.shift)) {
            setSidebarCursor((i) => clampSidebar(i - 1));
          } else if (key.name === 'down' || key.raw === 'j') {
            setSidebarCursor((i) => clampSidebar(i + 1));
          } else if (key.name === 'return') {
            activateCurrentSidebarItem();
          }
          return;
        }

        if (focus === 'workspace-pills') {
          if (key.name === 'left') {
            setWorkspacePillCursor((i) => Math.max(0, i - 1));
          } else if (key.name === 'right') {
            setWorkspacePillCursor((i) => Math.min(Math.max(0, siblingWorkspaces.length - 1), i + 1));
          } else if (key.name === 'return') {
            activateWorkspacePill();
          }
          return;
        }
      },
      [
        terminalBindings?.modalOpen,
        scriptBindings?.modalOpen,
        focus,
        onBack,
        onAttachSession,
        scriptBindings?.canAttachAnyway,
        scriptBindings?.onAttachAnyway,
        onDeleteSession,
        clampSidebar,
        activateCurrentSidebarItem,
        applyStatusPicker,
        moveWorkspacePhase,
        onAbortAgentSession,
        onCloseAgentSession,
        onArchiveAgentSession,
        onRestoreAgentSession,
        workspace.id,
        siblingWorkspaces.length,
        activateWorkspacePill,
        openSelectedServiceLauncher,
      ]
    )
  );

  const focusIsOverlay = focus === 'status-picker';
  const sessionTerminalModalOpen =
    Boolean(terminalBindings?.modalOpen) || focus !== 'terminal' || focusIsOverlay;
  const scriptTerminalModalOpen =
    Boolean(scriptBindings?.modalOpen) || focus !== 'terminal' || focusIsOverlay;

  const selectedSidebarItem = focus === 'sidebar' ? sidebarItems[sidebarCursor] : null;
  const sidebarXHint = (() => {
    if (!selectedSidebarItem) return null;
    if (selectedSidebarItem.kind === 'session') return '[x] Kill';
    if (selectedSidebarItem.kind === 'agent') return selectedSidebarItem.closedAt ? '[x] Archive' : '[x] Close';
    if (selectedSidebarItem.kind === 'archived-agent') return '[x] Restore';
    if (selectedSidebarItem.kind === 'archived-agents-toggle') return '[Enter] Toggle archived';
    if (selectedSidebarItem.kind === 'service') return '[o] Open';
    return null;
  })();
  const baseSidebarHint = '[↑↓] Navigate  [Enter] Open  [n] New  [Tab] Workspaces  [Esc] Back';
  const sidebarHint = sidebarXHint ? `${baseSidebarHint.replace('[n]', `${sidebarXHint}  [n]`)}` : baseSidebarHint;
  const attachAnywayHint = scriptBindings?.canAttachAnyway ? '  [a] Attach anyway' : '';

  const focusHint =
    focus === 'status-picker'
        ? '[↑↓] Pick status  [Enter] Apply  [Esc] Cancel'
        : focus === 'terminal'
          ? `[Shift+Esc] UI${attachAnywayHint}`
          : focus === 'workspace-pills'
            ? `[←→] Switch workspace  [Shift+←/→] Move phase  [Enter] Open  [Tab] Sidebar  [Esc] Back${attachAnywayHint}`
            : `${sidebarHint}  [Shift+←/→] Move phase  [x] Close/Stop  [X] Archive  [K] Abort${attachAnywayHint}`;

  return (
    <box flexDirection="column" flexGrow={1} width="100%" backgroundColor={COLORS.bg}>

      {/* ── Header: sibling workspace pills ── */}
      <scrollbox
        ref={(node: ScrollBoxRenderable | null) => {
          workspacePillScrollRef.current = node;
        }}
        scrollX={true}
        width="100%"
        height={1}
        backgroundColor={COLORS.bgSidebar}
      >
        <box
          flexDirection="row"
          minWidth="100%"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={0}
          paddingBottom={0}
          height={1}
        >
          {pillDisplayItems.length > 0 ? (
            pillDisplayItems.map((di, idx) => {
              if (di.type === 'project-label') {
                return (
                  <text
                    key={`label-${di.tier}-${di.projectName}`}
                    fg={COLORS.textDim}
                    paddingLeft={idx === 0 ? 0 : 1}
                  >
                    {`${di.projectName}:`}
                  </text>
                );
              }
              const w = di.workspace;
              const isCurrent = w.id === workspace.id;
              const isFocused = focus === 'workspace-pills' && siblingWorkspaces[workspacePillCursor]?.id === w.id;
              const status = workspaceStatusById[w.selectionKey ?? w.id];
              const dotColor = getStatusColor(status);
              const labelColor = isFocused
                ? COLORS.selected
                : isCurrent
                  ? dotColor
                  : COLORS.textMid;
              return (
                <box
                  key={w.id}
                  flexDirection="row"
                  gap={0}
                  paddingRight={2}
                  backgroundColor={isFocused ? COLORS.bgSelected : undefined}
                  height={1}
                >
                  <text fg={dotColor}>●</text>
                  <text fg={labelColor}>
                    {` ${w.name}`}
                  </text>
                </box>
              );
            })
          ) : (
            <text fg={COLORS.title}>{workspace.name}</text>
          )}
        </box>
      </scrollbox>

      {/* ── Body: sidebar + main ── */}
      <box flexDirection="row" flexGrow={1} width="100%">

        {/* ── Left sidebar ── */}
          <box
            flexDirection="column"
            width={38}
            backgroundColor={COLORS.bgSidebar}
          borderStyle="single"
          borderColor={focus === 'sidebar' ? COLORS.borderFocused : COLORS.border}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
        >
          {/* AI AGENTS section */}
          <box flexDirection="column" marginBottom={1}>
            <box flexDirection="row">
              <text fg={COLORS.sectionHeader}>AI AGENTS</text>
              {agentSessionCount > 0 && (
                <text fg={COLORS.textDim}>  {agentSessionCount} active</text>
              )}
              {pendingPermissions > 0 && (
                <text fg={COLORS.amber}>  ⚡{pendingPermissions}</text>
              )}
            </box>
            {agentRows.filter((row) => row.bucket === 'active' || row.bucket === 'closed').length === 0 ? (
              <text fg={COLORS.textDim}>  No agents</text>
            ) : (
              activeAgentSessions.map((a) => {
                const isSelected = isSidebarItemSelected(
                  (item) => item.kind === 'agent' && item.id === a.id
                );
                const agentState = getAgentSessionDisplayState(a);
                const dotColor =
                  agentState === 'closed'
                    ? COLORS.textDim
                    : agentState === 'needs-permission'
                      ? COLORS.amber
                      : agentState === 'running'
                        ? COLORS.green
                        : agentState === 'waiting'
                          ? COLORS.blue
                          : agentState === 'retrying' || agentState === 'error'
                            ? COLORS.red
                            : COLORS.textDim;
                const lastActive = a.lastActivityAt
                  ? formatTime(a.lastActivityAt)
                  : a.updatedAt
                    ? formatTime(new Date(a.updatedAt).getTime())
                    : null;
                const isOpen = attachedAgentSession?.id === a.id;
                return (
                  <box
                    key={a.id}
                    flexDirection="row"
                    gap={1}
                    backgroundColor={isSelected ? COLORS.bgSelected : isOpen ? COLORS.bgOpen : undefined}
                  >
                    <text fg={dotColor}>●</text>
                    <text fg={isSelected ? COLORS.selected : agentState === 'closed' ? COLORS.textDim : COLORS.textMid}>{a.title}</text>
                    {a.modelInfo && <text fg={COLORS.textDim}> [{a.modelInfo.name}]</text>}
                    {lastActive && <text fg={COLORS.textDim}> {lastActive}</text>}
                  </box>
                );
              })
            )}
            {agentRows.filter((row) => row.bucket === 'closed').map((row) => {
              const isSelected = isSidebarItemSelected(
                (item) => item.kind === 'agent' && item.id === row.id,
              );
              return (
                <box
                  key={`closed:${row.id}`}
                  flexDirection="row"
                  gap={1}
                  backgroundColor={isSelected ? COLORS.bgSelected : undefined}
                >
                  <text fg={COLORS.textDim}>●</text>
                  <text fg={isSelected ? COLORS.selected : COLORS.textDim}>{row.title}</text>
                  <text fg={COLORS.textDim}>closed</text>
                </box>
              );
            })}
            {archivedAgentSessions.length > 0 && (
              <box flexDirection="column" marginTop={1}>
                {(() => {
                  const isSelected = isSidebarItemSelected((item) => item.kind === 'archived-agents-toggle');
                  return (
                    <box
                      flexDirection="row"
                      gap={1}
                      backgroundColor={isSelected ? COLORS.bgSelected : undefined}
                    >
                      <text fg={isSelected ? COLORS.selected : COLORS.textDim}>{showArchivedAgents ? '▾' : '▸'}</text>
                      <text fg={isSelected ? COLORS.selected : COLORS.textDim}>{`Archived ${archivedAgentSessions.length}`}</text>
                    </box>
                  );
                })()}
                {showArchivedAgents && archivedAgentSessions.map((a) => {
                  const isSelected = isSidebarItemSelected(
                    (item) => item.kind === 'archived-agent' && item.id === a.id,
                  );
                  const lastActive = a.lastActivityAt
                    ? formatTime(a.lastActivityAt)
                    : a.updatedAt
                      ? formatTime(new Date(a.updatedAt).getTime())
                      : null;
                  return (
                    <box
                      key={`archived:${a.id}`}
                      flexDirection="row"
                      gap={1}
                      backgroundColor={isSelected ? COLORS.bgSelected : undefined}
                    >
                      <text fg={COLORS.textDim}>●</text>
                      <text fg={isSelected ? COLORS.selected : COLORS.textDim}>{a.title}</text>
                      {lastActive && <text fg={COLORS.textDim}> {lastActive}</text>}
                    </box>
                  );
                })}
              </box>
            )}
            {(() => {
              const isSelected = isSidebarItemSelected(
                (item) => item.kind === 'new-agent-session'
              );
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  backgroundColor={isSelected ? COLORS.bgSelected : undefined}
                >
                  <text fg={isSelected ? COLORS.selected : COLORS.textDim}>+</text>
                  <text fg={isSelected ? COLORS.selected : COLORS.textMid}>New agent session</text>
                </box>
              );
            })()}
          </box>

          {/* AGENT TASKS — from in-process SDK todo state */}
          {agentTodoPhases && agentTodoPhases.length > 0 && (
            <box flexDirection="column" marginBottom={1}>
              <box flexDirection="row" gap={1}>
                <text fg={COLORS.sectionHeader}>AGENT TASKS</text>
                <text fg={COLORS.textDim}>
                  {agentTodoPhases.reduce((n, p) => n + p.tasks.filter(t => t.status === 'completed').length, 0)}/
                  {agentTodoPhases.reduce((n, p) => n + p.tasks.length, 0)}
                </text>
              </box>
              {agentTodoPhases.map((phase) => (
                <box key={phase.name} flexDirection="column">
                  <text fg={COLORS.textDim}> {phase.name}</text>
                  {phase.tasks.map((task, i) => {
                    const dot =
                      task.status === 'completed' ? '\u2713'
                      : task.status === 'in_progress' ? '\u25B6'
                      : task.status === 'abandoned' ? '\u00D7'
                      : '\u25CB';
                    const fg =
                      task.status === 'completed' ? COLORS.green
                      : task.status === 'in_progress' ? COLORS.blue
                      : task.status === 'abandoned' ? COLORS.textDim
                      : COLORS.textMid;
                    return (
                      <box key={`${phase.name}-${i}`} flexDirection="row" gap={1}>
                        <text fg={fg}>{dot}</text>
                        <text fg={fg}>{task.content}</text>
                      </box>
                    );
                  })}
                </box>
              ))}
            </box>
          )}

          {/* TERMINALS section */}
          <box flexDirection="column" marginBottom={1}>
            <text fg={COLORS.sectionHeader}>TERMINALS</text>
            {sessionRows.length === 0 ? (
              <text fg={COLORS.textDim}>  No sessions  [n] New</text>
            ) : (
              sessionRows.map((row) => {
                  const isSelected = isSidebarItemSelected(
                    (item) => item.kind === 'session' && item.session.id === row.id
                  );
                  const isOpen = attachedWorkspaceSession?.id === row.id && !attachedWorkspaceSession?.processName;
                return (
                  <box
                    key={row.id}
                    flexDirection="row"
                    gap={1}
                    backgroundColor={isSelected ? COLORS.bgSelected : isOpen ? COLORS.bgOpen : undefined}
                  >
                    <text fg={isOpen ? COLORS.green : row.attached ? COLORS.amber : COLORS.green}>●</text>
                    <text fg={isSelected ? COLORS.selected : COLORS.textMid}>{row.label}</text>
                    {row.subtitle && <text fg={COLORS.textDim}> {row.subtitle}</text>}
                    <box flexGrow={1} />
                    <text fg={COLORS.textDim}>{row.alertLabel ?? row.statusLabel}</text>
                  </box>
                );
              })
            )}
            {(() => {
              const isSelected = isSidebarItemSelected((item) => item.kind === 'new-session');
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  backgroundColor={isSelected ? COLORS.bgSelected : undefined}
                >
                  <text fg={isSelected ? COLORS.selected : COLORS.textDim}>+</text>
                  <text fg={isSelected ? COLORS.selected : COLORS.textMid}>New session</text>
                </box>
              );
            })()}
          </box>

          {/* SERVICES section */}
          {serviceRows.length > 0 && (
            <box flexDirection="column" marginBottom={1}>
              <text fg={COLORS.sectionHeader}>SERVICES</text>
              {serviceRows.map((service) => {
                  const isSelected = isSidebarItemSelected(
                    (item) =>
                      item.kind === 'service' &&
                      item.name === service.processName &&
                      item.instance === service.instance
                  );
                  const isOpen = attachedServiceIdentity?.processName === service.processName
                    && attachedServiceIdentity.instance === service.instance;
                  return (
                    <box
                      key={service.key}
                      flexDirection="row"
                      gap={1}
                      backgroundColor={isSelected ? COLORS.bgSelected : isOpen ? COLORS.bgOpen : undefined}
                    >
                      <text fg={isOpen ? COLORS.green : service.state === 'running' ? COLORS.green : COLORS.textDim}>●</text>
                      <text fg={isSelected ? COLORS.selected : COLORS.textMid}>{service.label}</text>
                      {service.subtitle && <text fg={COLORS.textDim}> {service.subtitle}</text>}
                      {service.portLabel ? (
                        <text fg={service.hostedUrl ? COLORS.blue : COLORS.textDim}>{service.portLabel}</text>
                      ) : null}
                      {service.alertLabel && (
                        <text fg={COLORS.amber}> {service.alertLabel}</text>
                      )}
                    </box>
                  );
              })}
            </box>
          )}

          {/* HISTORY section */}
          <box flexDirection="column" marginBottom={1}>
            <text fg={COLORS.sectionHeader}>HISTORY</text>
            {workspaceReplays.length === 0 ? (
              <text fg={COLORS.textDim}>  No history</text>
            ) : (
               visibleReplayRows.map((replay) => {
                   const isSelected = isSidebarItemSelected(
                     (item) => item.kind === 'history' && item.replayId === replay.replayId
                   );
                 return (
                    <box
                      key={replay.replayId}
                      flexDirection="row"
                      gap={1}
                      backgroundColor={isSelected ? COLORS.bgSelected : undefined}
                    >
                      <text fg={replay.tone === 'red' ? COLORS.red : COLORS.green}>↺</text>
                      <text fg={isSelected ? COLORS.selected : COLORS.textMid}>
                        {replay.label}
                      </text>
                     </box>
                   );
                 })
            )}
            {hasMoreReplayRows && seeAllReplayLabel && (() => {
              const isSelected = isSidebarItemSelected((item) => item.kind === 'history-see-all');
              return (
                <box flexDirection="row" gap={1} backgroundColor={isSelected ? COLORS.bgSelected : undefined}>
                  <text fg={COLORS.textDim}>↺</text>
                  <text fg={isSelected ? COLORS.selected : COLORS.textMid}>{seeAllReplayLabel}</text>
                </box>
              );
            })()}
          </box>

          {(notesSummary?.total ?? 0) > 0 && (
            <box flexDirection="column" marginBottom={1}>
              <text fg={COLORS.sectionHeader}>NOTES</text>
              {visibleTodoRows.map((note) => (
                <box key={note.id} flexDirection="row" gap={1}>
                  <text fg={note.priority === 'high' ? COLORS.red : note.priority === 'medium' ? COLORS.amber : COLORS.blue}>•</text>
                  <text fg={COLORS.textMid}>{note.label}</text>
                  {note.priority ? <text fg={COLORS.textDim}>{note.priority}</text> : null}
                </box>
              ))}
              {visibleRecentNoteRows.map((note) => (
                <box key={note.id} flexDirection="row" gap={1}>
                  <text fg={COLORS.textDim}>-</text>
                  <text fg={COLORS.textDim}>{note.label}</text>
                </box>
              ))}
            </box>
          )}

          {pmRows.length > 0 && (
            <box flexDirection="column" marginBottom={1}>
              <text fg={COLORS.sectionHeader}>PM</text>
              {pmRows.map((row) => (
                <text key={row.id} fg={row.tone === 'red' ? COLORS.red : row.tone === 'green' ? COLORS.green : row.tone === 'blue' ? COLORS.blue : COLORS.textDim}>
                  {row.label}
                  {row.detail ? ` · ${row.detail}` : ''}
                </text>
              ))}
            </box>
          )}

          {/* SYSTEM section */}
          <box flexDirection="column" marginBottom={1}>
            <text fg={COLORS.sectionHeader}>SYSTEM</text>
            {(() => {
              const isSelected = isSidebarItemSelected((item) => item.kind === 'event-logs');
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  backgroundColor={isSelected ? COLORS.bgSelected : undefined}
                >
                  <text fg={COLORS.green}>●</text>
                  <text fg={isSelected ? COLORS.selected : COLORS.textMid}>Event Logs</text>
                  <box flexGrow={1} />
                  <text fg={COLORS.textDim}>live</text>
                </box>
              );
            })()}
          </box>

          {/* Footer */}
          <box flexGrow={1} />
          <box flexDirection="column">
            <text fg={COLORS.textDim}>──────────────────────────</text>
            {pendingPermissions > 0 && (
              <text fg={COLORS.amber}>⚡ {pendingPermissions} pending permission{pendingPermissions !== 1 ? 's' : ''}</text>
            )}
            {footerActions.map((action) => {
              const selected = isSidebarItemSelected((item) => {
                if (action.id === 'open-github-pr') return item.kind === 'open-github-pr';
                if (action.id === 'open-review') return item.kind === 'open-review';
                if (action.id === 'launch-commit') return item.kind === 'launch-commit';
                if (action.id === 'edit-bundle-config') return item.kind === 'bundle-config';
                if (action.id === 'edit-process-config') return item.kind === 'process-config';
                return item.kind === 'change-status';
              });

              if (action.id === 'open-github-pr') {
                if (!pullRequest?.url) return null;
                return (
                  <box key={action.id} backgroundColor={selected ? COLORS.bgSelected : undefined}>
                    <text fg={selected ? COLORS.selected : COLORS.textMid}>{action.label}</text>
                  </box>
                );
              }

              if (action.id === 'change-status') {
                return (
                  <box key={action.id} flexDirection="row" gap={1} backgroundColor={selected ? COLORS.bgSelected : undefined}>
                    <text fg={selected ? COLORS.selected : COLORS.textMid}>{action.label}</text>
                    <text fg={COLORS.blue}>{action.rightLabel?.replace(/^[\[]|[\]]$/g, '') ?? phaseStr}</text>
                  </box>
                );
              }

              return (
                <box key={action.id} backgroundColor={selected ? COLORS.bgSelected : undefined}>
                  <text fg={selected ? COLORS.selected : COLORS.textMid}>{action.label}</text>
                </box>
              );
            })}
          </box>
        </box>

          {/* ── Main: attached session info ── */}
        <box flexDirection="column" flexGrow={1}>
          {/* Session detail / empty state */}
          <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingTop={1}>
            {showInlineSessionTerminal && terminalBindings ? (
              <box
                flexDirection="column"
                flexGrow={1}
                borderStyle="single"
                borderColor={focus === 'terminal' ? COLORS.borderFocused : COLORS.border}
                paddingLeft={focus === 'terminal' ? 1 : 0}
                paddingRight={focus === 'terminal' ? 1 : 0}
                paddingTop={focus === 'terminal' ? 1 : 0}
                paddingBottom={focus === 'terminal' ? 1 : 0}
              >
                <SessionTerminal
                  sessionName={terminalBindings.attachedSessionName ?? attachedWorkspaceSession?.name ?? attachedAgentSession?.title ?? workspace.name}
                  processTitle={terminalBindings.attachedSessionMeta?.processTitle ?? attachedWorkspaceSession?.processTitle ?? null}
                  terminalTitle={terminalBindings.attachedSessionMeta?.terminalTitle ?? attachedWorkspaceSession?.terminalTitle ?? null}
                  lastAlertLabel={terminalBindings.attachedSessionMeta?.lastAlertKind
                    ? `${terminalBindings.attachedSessionMeta.lastAlertKind}${terminalBindings.attachedSessionMeta.unreadAlertCount ? ` (${terminalBindings.attachedSessionMeta.unreadAlertCount})` : ''}`
                    : null}
                  endpointLabel={machineLabel}
                  onData={terminalBindings.onData}
                  onResize={terminalBindings.onResize}
                  onDetach={() => {
                    void terminalBindings.onDetach();
                  }}
                  setWriteCallback={terminalBindings.setWriteCallback}
                  modalOpen={sessionTerminalModalOpen}
                  readOnly={terminalBindings.readOnly ?? false}
                  showTopBanner={false}
                  reservedCols={WORKSPACE_DETAIL_TERMINAL_RESERVED_COLS}
                  reservedRowsExtra={WORKSPACE_DETAIL_TERMINAL_RESERVED_ROWS}
                  onShiftEsc={() => setFocus('sidebar')}
                />
              </box>
            ) : showInlineScriptTerminal && scriptBindings?.scriptState ? (
              <box
                flexDirection="column"
                flexGrow={1}
                borderStyle="single"
                borderColor={focus === 'terminal' ? COLORS.borderFocused : COLORS.border}
                paddingLeft={focus === 'terminal' ? 1 : 0}
                paddingRight={focus === 'terminal' ? 1 : 0}
                paddingTop={focus === 'terminal' ? 1 : 0}
                paddingBottom={focus === 'terminal' ? 1 : 0}
              >
                <ScriptTerminal
                  phase={scriptBindings.scriptState.phase}
                  workspaceName={scriptBindings.workspaceName}
                  isRunning={scriptBindings.scriptState.isRunning}
                  error={scriptBindings.scriptState.error}
                  exitCode={scriptBindings.scriptState.exitCode}
                  modalOpen={scriptTerminalModalOpen}
                  setWriteCallback={scriptBindings.setWriteCallback}
                  showTopBanner={false}
                  showHintBar={!scriptBindings.scriptState.isRunning}
                  reservedCols={WORKSPACE_DETAIL_TERMINAL_RESERVED_COLS}
                  reservedRowsExtra={WORKSPACE_DETAIL_TERMINAL_RESERVED_ROWS}
                />
              </box>
            ) : attachedWorkspaceSession ? (() => {
              const s = attachedWorkspaceSession;
              const label = s.name.split(':').pop() ?? s.name;
              return (
                <box flexDirection="column" gap={0}>
                  <box flexDirection="row" gap={1}>
                    <text fg={s.attached ? COLORS.amber : COLORS.green}>●</text>
                    <text fg={COLORS.text}>{label}</text>
                    <text fg={COLORS.textDim}>{s.attached ? 'attached' : 'idle'}</text>
                  </box>
                  <text fg={COLORS.textDim}>Created {formatTime(s.createdAt)}</text>
                  {s.processTitle && (
                    <text fg={COLORS.textDim}>Process: {s.processTitle}</text>
                  )}
                  <text fg={COLORS.textDim} marginTop={1}>Press [Enter] on a sidebar item to attach it inline.</text>
                </box>
              );
            })() : attachedAgentSession ? (
              <box flexDirection="column" gap={0}>
                <text fg={COLORS.text}>Agent attached: {attachedAgentSession.title}</text>
                <text fg={COLORS.textDim}>Live terminal is ready inline.</text>
              </box>
            ) : (
              <box flexDirection="column" gap={0}>
                <text fg={COLORS.textDim}>No active session selected.</text>
                <text fg={COLORS.textDim}>Attach a terminal or agent from the sidebar.</text>
              </box>
            )}
          </box>
        </box>
      </box>

      {/* ── Status bar ── */}
      <box
        width="100%"
        height={1}
        backgroundColor={COLORS.statusBar}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={COLORS.textDim}>{focusHint}</text>
        <box flexGrow={1} />
        <text fg={COLORS.textDim}>{workspace.name}  {machineLabel}</text>
      </box>

      {/* ── Status picker overlay ── */}
      {focus === 'status-picker' && (
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
            width="50%"
            borderStyle="single"
            borderColor={COLORS.borderFocused}
            backgroundColor="#1a1a1a"
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            marginTop={2}
            zIndex={10}
          >
            <text fg={COLORS.text}>Change Status</text>
            <box flexDirection="column" marginTop={1}>
              {PHASES.map((phase, i) => (
                <text
                  key={phase}
                  fg={i === statusPickerCursor ? COLORS.selected : COLORS.textMid}
                >
                  {i === statusPickerCursor ? '▸ ' : '  '}
                  {PHASE_LABELS[phase]}
                  {phase === phaseStr ? ' (current)' : ''}
                </text>
              ))}
            </box>
            <text fg={COLORS.textDim} marginTop={1}>↑/↓ select  Enter apply  Esc close</text>
          </box>
        </box>
      )}
    </box>
  );
}
