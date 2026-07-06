/** @jsxImportSource react */
import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { SessionTerminalHandle } from "./components/SessionTerminal.web";
import { ReplayTerminalWeb } from './components/ReplayTerminal.web';
import { ScriptTerminal } from "./components/ScriptTerminal.web";
import { WorkspaceRemovalTaskBar } from './components/WorkspaceRemovalTaskBar.web.js';
import {
  applyModifiersToInput,
  type ModifierState,
} from "./components/TerminalControls.web";
import { AttachedTerminalPaneWeb } from './components/AttachedTerminalPane.web.js';
import { getAgentSessionDisplayTitle } from './agents/session-display.js';
import { DockviewWorkspaceShell } from './components/DockviewWorkspaceShell.web.js';
import { PaneTerminalPanel } from './components/PaneTerminalPanel.web.js';
import { GoalDetailPanel } from './components/GoalDetailPanel.web.js';
import { IdentityGate } from "./components/IdentityGate.web";
import type { Identity } from "./types/identity";
import { useVisualViewport } from "./hooks/useVisualViewport.web";
import { browserPreferencesService } from "./lib/preferences-service.web";
import { Toaster, toast } from "./lib/sonner.web";
import { ReviewPage } from './pages/ReviewPage.web.js';
import { terminalMemoryDebugGauge, terminalMemoryDebugIncrement } from './utils/terminal-memory-debug.js';

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
import { ArtifactPanel } from "./components/ArtifactPanel.web.js";
import { DashboardPanel } from "./components/DashboardPanel.web.js";
import { NotePanel } from "./components/NotePanel.web.js";
import { GoalDocPanel } from "./components/GoalDocPanel.web.js";
import { ChangeGuidePane } from "./components/ChangeGuide.web.js";
import { ReviewRubric } from "./components/ReviewRubric.web.js";
import { EvidencePanel } from "./components/EvidencePanel.web.js";
import { ReportPanel } from "./components/ReportPanel.web.js";
import { WorkflowPanel } from "./components/WorkflowPanel.web.js";
import { EventLogPane } from "./components/EventLogPane.web.js";
import { CronsPanel } from "./components/CronsPanel.web.js";
import { decodeBase64Utf8, encodeBase64Utf8 } from "./components/artifact-kinds.js";
import { GlobalChromeBar, type ChromeWorkspaceChip } from "./components/GlobalChromeBar.web.js";
import { GlobalTaskbar } from "./components/GlobalTaskbar.web.js";
import { RightRail, RepoFilePanel, type RepoFileOpen } from "./components/RightRail.web.js";
import { ProjectHomePage } from "./pages/ProjectHomePage.web.js";
import { useInboxPage } from './app/react/index.js';
import { InboxWeb } from "./components/Inbox.web.js";
import { useEvents, toWideEventItem, type WideEventItem } from "./components/Events.js";
import { EventsWeb } from "./components/Events.web.js";
import type { WideEventFilter } from "./types/events.js";
import type { WorkspacePhase } from './types/config.js';
import type { ChainStackStatus, GoalValidation, Requirement } from './types/goals.js';
import {
  useNotifications,
  type ToastNotification,
  DEFAULT_NOTIFICATION_CONFIG,
  getSessionLabel,
} from "./notifications/index.js";
import { useWorkspaceRuntimeModel } from './app/shared/workspace-runtime/useWorkspaceRuntimeModel.js';
import { useCommandPaletteOrchestration } from './app/react/index.js';
import { showWorkspaceEditorSelect } from './app/shared/command-palette/showWorkspaceEditorSelect.js';
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
import { computeReadiness } from './app/shared/goal-validation/readiness.js';
import { getShiftArrowPhaseChange } from './app/shared/board/phase-movement.js';
import { selectBackendSnapshot } from './machine/multi/selectors.js';
import type { KanbanGoalItem, WorkspaceBoardGroup } from './app/shared/board/types.js';
import type { BackendKey } from './session/backend.js';
import type { RemoteSessionPtyBackend } from './session/useRemoteSessionClient.js';
import { useAgentSessionActions, useWorkspaceLifecycleActions, useProcessActions, useInboxActions, useBundleRefreshAttachFlow, useBundleConfigFlow, useReplayReviewActions, useSessionActions, useLifecycleActions, useAttachActions, usePreferencesAdapter, useUserActivity, buildEditProcessesCommand, useWorkspaceController } from './app/react/index.js';
import { useWorkspaceRemovalTasks, workspaceOperationsToRemovalTasks } from './app/react/useWorkspaceRemovalTasks.js';
import { useWorkspaceCreationTasks, workspaceOperationsToCreationTasks } from './app/react/useWorkspaceCreationTasks.js';

import { browserPlatform } from './sdk/platforms/browser.web.js';
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

function toGoalCacheKey(backendKey: string, projectName: string, goalId: string): string {
  return `${backendKey}:${projectName}:${goalId}`;
}

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
  const [projectHomeName, setProjectHomeName] = useState<string | null>(null);
  /** Repo files + artifacts opened as dock tabs, keyed by workspace selectionKey. */
  type DockExtraPane = ({ kind: 'file' } & RepoFileOpen) | { kind: 'artifact'; path: string } | { kind: 'dashboard'; path: string } | { kind: 'note'; noteId: string | null; title: string; nonce?: number } | { kind: 'goal' } | { kind: 'guide' } | { kind: 'rubric' } | { kind: 'evidence'; requirementId: string; evidenceId: string } | { kind: 'report'; path: string } | { kind: 'workflow' } | { kind: 'crons' } | { kind: 'eventlog' };
  const [dockExtraPanes, setDockExtraPanes] = useState<Record<string, DockExtraPane[]>>({});
  const openSingletonPane = useCallback((wsKey: string, pane: DockExtraPane) => {
    setDockExtraPanes((prev) => {
      const cur = prev[wsKey] ?? [];
      if (cur.some((x) => x.kind === pane.kind && (pane.kind !== 'evidence' || (x.kind === 'evidence' && x.evidenceId === (pane as { evidenceId: string }).evidenceId)))) return prev;
      return { ...prev, [wsKey]: [...cur, pane] };
    });
  }, []);
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
  const activeDeleteTaskIdRef = useRef<string | null>(null);
  const activeScriptWorkspaceIdRef = useRef<string | null>(null);
  const activeScriptTaskIdRef = useRef<string | null>(null);
  const dockviewLayoutsRef = useRef<Record<string, unknown>>({});
  const cachedTerminalPanelsRef = useRef<Record<string, Array<{ id: string; title: string; render: () => ReactNode }>>>({});
  const dockviewApiByWorkspaceRef = useRef<Record<string, { toJSON: () => unknown } | null>>({});
  const scriptRunInFlightRef = useRef<Set<string>>(new Set());

  // Review workspace/project state
  const [showBoardWhileDetailMounted, setShowBoardWhileDetailMounted] = useState(false);
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
  const workspaceRemovalTasks = useWorkspaceRemovalTasks();
  const workspaceCreationTasks = useWorkspaceCreationTasks();
  const dismissedWorkspaceTaskStorageKey = 'gitspace.dismissedWorkspaceTaskIds';
  const readDismissedWorkspaceTaskIds = (): Set<string> => {
    try {
      const raw = globalThis.localStorage?.getItem(dismissedWorkspaceTaskStorageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
    } catch {
      return new Set();
    }
  };
  const writeDismissedWorkspaceTaskIds = (ids: Set<string>): void => {
    try {
      globalThis.localStorage?.setItem(dismissedWorkspaceTaskStorageKey, JSON.stringify([...ids]));
    } catch {
      // Ignore storage failures; in-memory dismissal still applies.
    }
  };
  const [dismissedWorkspaceTaskIds, setDismissedWorkspaceTaskIds] = useState<Set<string>>(readDismissedWorkspaceTaskIds);
  const [selectedWorkspaceTaskId, setSelectedWorkspaceTaskId] = useState<string | null>(null);
  const machineWorkspaceTasks = useMemo(() => {
    const tasks: ReturnType<typeof workspaceOperationsToRemovalTasks> = [];
    for (const backendKey of multiMachineState.backendOrder) {
      const state = multi.getBackendState(backendKey);
      tasks.push(...workspaceOperationsToRemovalTasks(state?.operations ?? {}, backendKey)
        .filter((task) => !dismissedWorkspaceTaskIds.has(task.id)));
    }
    return tasks;
  }, [multi, multiMachineState, dismissedWorkspaceTaskIds]);
  const machineWorkspaceCreationTasks = useMemo(() => {
    const tasks: ReturnType<typeof workspaceOperationsToCreationTasks> = [];
    for (const backendKey of multiMachineState.backendOrder) {
      const state = multi.getBackendState(backendKey);
      tasks.push(...workspaceOperationsToCreationTasks(state?.operations ?? {}));
    }
    return tasks;
  }, [multi, multiMachineState]);
  const taskBarTasks = useMemo(() => {
    const operationTaskIds = new Set(machineWorkspaceTasks.map((task) => task.id));
    const operationWorkspaceKeys = new Set(machineWorkspaceTasks.map((task) => `${task.operationKind}:${toBackendScopedWorkspaceKey(task.ref)}`));
    return [
      ...machineWorkspaceTasks,
      ...workspaceRemovalTasks.tasks.filter((task) => {
        if (operationTaskIds.has(task.id)) return false;
        const inferredKind = task.phase === 'remove' || task.phase === 'git-worktree-remove' || task.phase === 'cleanup-leftovers'
          ? 'workspace.delete'
          : 'workspace.scripts';
        return !operationWorkspaceKeys.has(`${inferredKind}:${toBackendScopedWorkspaceKey(task.ref)}`);
      }),
    ];
  }, [machineWorkspaceTasks, workspaceRemovalTasks.tasks]);

  useEffect(() => {
    setSelectedWorkspaceTaskId((current) => {
      if (current && taskBarTasks.some((task) => task.id === current)) return current;
      return taskBarTasks.find((task) => task.status === 'running' || task.status === 'queued')?.id ?? taskBarTasks[0]?.id ?? null;
    });
  }, [taskBarTasks]);
  const handleDismissWorkspaceTask = useCallback((taskId: string) => {
    const task = taskBarTasks.find((candidate) => candidate.id === taskId);
    const backend = task?.operationKind ? multi.getBackend(task.ref.backendKey) : null;
    if (backend?.dismissOperation) {
      void backend.dismissOperation(taskId).catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Failed to dismiss operation');
      });
    }
    workspaceRemovalTasks.dismissTask(taskId);
    setDismissedWorkspaceTaskIds((current) => {
      if (current.has(taskId)) return current;
      const next = new Set(current);
      next.add(taskId);
      writeDismissedWorkspaceTaskIds(next);
      return next;
    });
    setSelectedWorkspaceTaskId((current) => {
      if (current !== taskId) return current;
      const remaining = taskBarTasks.filter((candidate) => candidate.id !== taskId);
      return remaining.find((candidate) => candidate.status === 'running' || candidate.status === 'queued')?.id ?? remaining[0]?.id ?? null;
    });
  }, [multi, taskBarTasks, workspaceRemovalTasks.dismissTask]);
  const deletingWorkspaceTasksByKey = useMemo(() => {
    const result: Record<string, { status: string; progressLabel?: string }> = {};
    for (const [key, task] of Object.entries(workspaceRemovalTasks.tasksByWorkspaceKey)) {
      if (task.operationKind && task.operationKind !== 'workspace.delete') continue;
      if (task.phase !== 'remove' && task.phase !== 'git-worktree-remove' && task.phase !== 'cleanup-leftovers') continue;
      result[key] = { status: task.status, progressLabel: task.progressLabel };
    }
    for (const task of machineWorkspaceTasks) {
      if (task.operationKind !== 'workspace.delete') continue;
      result[toBackendScopedWorkspaceKey(task.ref)] = { status: task.status, progressLabel: task.progressLabel };
    }
    return result;
  }, [machineWorkspaceTasks, workspaceRemovalTasks.tasksByWorkspaceKey]);
  const creatingWorkspaceTasksById = useMemo(() => {
    const result = { ...workspaceCreationTasks.tasksByWorkspaceId };
    for (const task of machineWorkspaceCreationTasks) {
      result[task.workspaceId] = task;
    }
    return result;
  }, [machineWorkspaceCreationTasks, workspaceCreationTasks.tasksByWorkspaceId]);
  const scriptState = attachedBackendState?.scriptState ?? activeBackendState?.scriptState ?? null;
  const notificationConfig = activeBackendState?.notificationConfig ?? null;

  // ─── PTY backend ref ──────────────────────────────────────────────────────

  const ptyBackendRef = useRef<RemoteSessionPtyBackend | null>(null);
  const writeCallbackRef = useRef<((data: Uint8Array) => void) | null>(null);
  const scriptWriteCallbackRef = useRef<((data: Uint8Array) => void) | null>(null);
  const nextPaneIdRef = useRef(1);

  useEffect(() => {
    if (scriptState) {
      const isRemove = scriptState.phase === 'remove';
      const phaseLabel = scriptState.phase === 'setup'
        ? 'setup'
        : scriptState.phase === 'select'
          ? 'select'
          : scriptState.phase === 'pre'
            ? 'prepare'
            : 'workspace';
      workspaceRemovalTasks.updatePhase(
        scriptState.workspaceId,
        scriptState.phase,
        scriptState.isRunning
          ? isRemove ? 'Running cleanup scripts...' : `Running ${phaseLabel} scripts...`
          : isRemove ? 'Cleanup scripts finished' : `${phaseLabel[0]?.toUpperCase() ?? 'Workspace'}${phaseLabel.slice(1)} scripts finished`,
      );
      if (scriptState.error) {
        const taskId = scriptState.phase === 'remove' ? activeDeleteTaskIdRef.current : activeScriptTaskIdRef.current;
        if (taskId) workspaceRemovalTasks.completeFailure(taskId, scriptState.error, scriptState.exitCode);
      }
      return;
    }
    if (activeScriptTaskIdRef.current && activeScriptWorkspaceIdRef.current) {
      workspaceRemovalTasks.completeSuccess(activeScriptTaskIdRef.current, 'Workspace scripts finished');
      activeScriptTaskIdRef.current = null;
      activeScriptWorkspaceIdRef.current = null;
    }
  }, [scriptState, workspaceRemovalTasks.updatePhase, workspaceRemovalTasks.completeFailure, workspaceRemovalTasks.completeSuccess]);

  const buildScriptOutputHandler = useCallback((fn: ((data: Uint8Array) => void) | null) => {
    if (!fn && !workspaceRemovalTasks.activeTask) return null;
    return (data: Uint8Array) => {
      workspaceRemovalTasks.appendOutput(undefined, data);
      fn?.(data);
    };
  }, [workspaceRemovalTasks.activeTask, workspaceRemovalTasks.appendOutput]);
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
    ptyBackendRef.current?.setScriptOutputHandler?.(buildScriptOutputHandler(fn));
  }, [buildScriptOutputHandler]);

  const allocatePaneId = useCallback((prefix: string) => {
    nextPaneIdRef.current += 1;
    return `${prefix}-${Date.now().toString(36)}-${nextPaneIdRef.current.toString(36)}`;
  }, []);

  // Re-attach write callback when backend changes
  useEffect(() => {
    const key = attachedBackendKey ?? activeBackendKey;
    if (!key) return;
    const b = multi.getBackend(key) as RemoteSessionPtyBackend | null;
    ptyBackendRef.current = b;
    b?.setPtyOutputHandler?.(writeCallbackRef.current);
    b?.setScriptOutputHandler?.(buildScriptOutputHandler(scriptWriteCallbackRef.current));
  }, [attachedBackendKey, activeBackendKey, multi, buildScriptOutputHandler]);

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
    handleSelectWorkspace: rawHandleBoardSelectWorkspace,
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

  const [goalEdgeStatusByKey, setGoalEdgeStatusByKey] = useState<Record<string, { status: ChainStackStatus['edges'][number]['status']; message?: string }>>({});
  const applyGoalEdgeStatus = useCallback((goal: KanbanGoalItem): KanbanGoalItem => {
    const persistedGoalId = goal.id.startsWith(`${goal.projectName}:`) ? goal.id.slice(goal.projectName.length + 1) : goal.id;
    const edgeStatus = goalEdgeStatusByKey[toGoalCacheKey(goal.backendKey, goal.projectName, persistedGoalId)];
    if (!edgeStatus) {
      return goal;
    }
    return {
      ...goal,
      stackStatus: edgeStatus.status,
      stackStatusMessage: edgeStatus.message,
      blockedReason: edgeStatus.status === 'aligned' ? goal.blockedReason : (edgeStatus.message ?? edgeStatus.status),
    };
  }, [goalEdgeStatusByKey]);
  const boardGroupsWithGoalStatus = useMemo<WorkspaceBoardGroup[]>(() => (
    workspaceBoardState.groups.map((group) => ({
      ...group,
      plannedGoals: group.plannedGoals?.map(applyGoalEdgeStatus),
      workspaces: group.workspaces.map((workspace) => {
        if (!workspace.goal) {
          return workspace;
        }
        return {
          ...workspace,
          goal: applyGoalEdgeStatus({
            ...workspace.goal,
            selectionKey: `${workspace.backendKey}:goal:${workspace.goal.id}`,
            backendKey: workspace.backendKey,
            machineLabel: workspace.machineLabel,
            isRemote: workspace.isRemote,
          }),
        };
      }),
    }))
  ), [applyGoalEdgeStatus, workspaceBoardState.groups]);
  const allGoalItems = useMemo(() => {
    const planned = boardGroupsWithGoalStatus.flatMap((group) => group.plannedGoals ?? []);
    const backed = boardGroupsWithGoalStatus.flatMap((group) =>
      group.workspaces
        .map((workspace) => workspace.goal ? {
          ...workspace.goal,
          selectionKey: `${workspace.backendKey}:goal:${workspace.goal.id}`,
          backendKey: workspace.backendKey,
          machineLabel: workspace.machineLabel,
          isRemote: workspace.isRemote,
        } : null)
        .filter((goal): goal is KanbanGoalItem => Boolean(goal)),
    );
    return [...planned, ...backed];
  }, [boardGroupsWithGoalStatus]);
  const [selectedGoalKey, setSelectedGoalKey] = useState<string | null>(null);
  const [goalDetailMessage, setGoalDetailMessage] = useState<string | null>(null);
  const [goalStackStatus, setGoalStackStatus] = useState<ChainStackStatus | null>(null);
  const [goalSaving, setGoalSaving] = useState(false);
  const [boardGoalOrderMessage, setBoardGoalOrderMessage] = useState<string | null>(null);
  const mergeGoalValidation = useCallback((goal: KanbanGoalItem): KanbanGoalItem => {
    if (!goal.validation) return goal;
    return { ...goal, validation: { ...goal.validation, readiness: computeReadiness(goal.validation) } };
  }, []);
  const selectedGoal = useMemo(
    () => selectedGoalKey ? (() => {
      const goal = allGoalItems.find((item) => item.selectionKey === selectedGoalKey) ?? null;
      return goal ? mergeGoalValidation(goal) : null;
    })() : null,
    [allGoalItems, mergeGoalValidation, selectedGoalKey],
  );
  const selectedGoalChainGoals = useMemo(
    () => selectedGoal
      ? allGoalItems.filter((goal) => goal.backendKey === selectedGoal.backendKey && goal.projectName === selectedGoal.projectName && goal.chainId === selectedGoal.chainId)
      : [],
    [allGoalItems, selectedGoal],
  );

  const handleBoardSelectWorkspace = useCallback((workspaceKey: string | null) => {
    if (workspaceKey === null) {
      if (showBoardWhileDetailMounted && workspaceController.selectedRef) {
        setShowBoardWhileDetailMounted(false);
        return;
      }
      rawHandleBoardSelectWorkspace(null);
      return;
    }
    setSelectedGoalKey(null);
    setGoalDetailMessage(null);
    setGoalStackStatus(null);
    setShowBoardWhileDetailMounted(false);
    rawHandleBoardSelectWorkspace(workspaceKey);
  }, [rawHandleBoardSelectWorkspace, showBoardWhileDetailMounted, workspaceController.selectedRef]);

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
      const preferredSession = preferredState?.sessions?.find((session) => session.id === sessionId);
      if (preferredSession) {
        return { backendKey: preferredBackendKey, sessionId, workspaceId: preferredSession.workspaceId };
      }
    }

    let match: { backendKey: BackendKey; workspaceId?: string } | null = null;

    for (const backendKey of candidateKeys) {
      if (backendKey === preferredBackendKey) continue;
      const state = multi.getBackendState(backendKey);
      const session = state?.sessions?.find((candidate) => candidate.id === sessionId);
      if (session) {
        if (match !== null) {
          return null;
        }

        match = { backendKey, workspaceId: session.workspaceId };
      }
    }

    if (!match) {
      return null;
    }

    return { backendKey: match.backendKey, sessionId, workspaceId: match.workspaceId };
  }, [activeBackendKey, attachedBackendKey, multi, multiMachineState.backendOrder, selectedBackendKey]);


  // ─── Selected workspace detail ───────────────────────────────────────────────
  const selectedRef = workspaceController.selectedRef;
  const backendAttachedWorkspaceId = attachedBackendState?.attachedWorkspaceId ?? null;
  const attachedPaneWorkspaceId = Object.values(attachedBackendState?.attachedPanes ?? {}).find((pane) => pane.workspaceId)?.workspaceId ?? null;
  const effectiveAttachedWorkspaceId = attachedPaneWorkspaceId ?? backendAttachedWorkspaceId;
  const attachedWorkspaceSelectionKey = attachedBackendKey && effectiveAttachedWorkspaceId
    ? toBackendScopedWorkspaceKey({ backendKey: attachedBackendKey, workspaceId: effectiveAttachedWorkspaceId })
    : null;
  const selectedWorkspaceForDetail = useMemo(
    () => selectedRef
      ? filteredWorkspaces.find((w) => w.id === selectedRef.workspaceId) ?? null
      : null,
    [filteredWorkspaces, selectedRef],
  );

  const DETAIL_VIEW_CACHE_LIMIT = 3;
  const [detailWorkspaceCacheKeys, setDetailWorkspaceCacheKeys] = useState<string[]>([]);

  useEffect(() => {
    if (!selectedWorkspaceForDetail?.selectionKey) return;
    setDetailWorkspaceCacheKeys((current) => [
      selectedWorkspaceForDetail.selectionKey,
      ...current.filter((key) => key !== selectedWorkspaceForDetail.selectionKey),
    ].slice(0, DETAIL_VIEW_CACHE_LIMIT));
  }, [selectedWorkspaceForDetail?.selectionKey]);

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
    if (selectedRef) return;
    if (workspaceBoardState.selectedWorkspaceId === attachedWorkspaceSelectionKey) return;
    handleBoardSelectWorkspace(attachedWorkspaceSelectionKey);
  }, [attachedWorkspaceSelectionKey, handleBoardSelectWorkspace, selectedRef, terminalMode, workspaceBoardState.selectedWorkspaceId]);


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

  /** Global chrome bar (mock topbar + ActivityStrip) — shared by board + shell. */
  const CHIP_COLOR: Record<string, string> = { red: 'var(--gs-danger)', orange: 'var(--gs-warning)', blue: 'var(--gs-info)', dim: 'var(--gs-text-ghost)' };
  const chromeChips: ChromeWorkspaceChip[] = workspaceRuntime.workspaces.map((w) => {
    const st = workspaceRuntime.workspaceStatusById[w.selectionKey ?? w.id];
    return {
      key: w.selectionKey ?? w.id,
      name: w.name,
      phase: ((w as { phase?: string }).phase as import('./types/config.js').WorkspacePhase | undefined) ?? 'code',
      statusColor: CHIP_COLOR[st?.primaryColor ?? 'dim'] ?? 'var(--gs-text-ghost)',
    };
  });
  const renderChromeBar = (opts: { boardActive?: boolean; activeKey?: string | null; onBoard?: () => void }) => (
    <GlobalChromeBar
      projectName={allProjects.length === 1 ? allProjects[0]?.name : undefined}
      workspaces={chromeChips}
      activeKey={opts.activeKey}
      boardActive={opts.boardActive}
      onBoard={opts.onBoard ?? (() => {})}
      onProject={allProjects.length > 0 ? () => setProjectHomeName(allProjects[0]!.name) : undefined}
      onSelectWorkspace={(key) => handleBoardSelectWorkspace(key)}
      inboxCount={backendInboxUnreadCount}
      onOpenInbox={() => { void inboxActions.requestInbox(); setShowInbox(true); }}
      onOpenPalette={() => commandPalette.toggle()}
    />
  );


  /** Workspaces whose default pane set (goal/workflow/guide) was already seeded. */
  const seededDockRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const key = workspaceBoardState.selectedWorkspaceId;
    if (!key || seededDockRef.current.has(key)) return;
    seededDockRef.current.add(key);
    setDockExtraPanes((prev) => {
      const cur = prev[key] ?? [];
      const missing: DockExtraPane[] = [];
      if (!cur.some((x) => x.kind === 'goal')) missing.push({ kind: 'goal' });
      if (!cur.some((x) => x.kind === 'workflow')) missing.push({ kind: 'workflow' });
      if (!cur.some((x) => x.kind === 'guide')) missing.push({ kind: 'guide' });
      return missing.length ? { ...prev, [key]: [...cur, ...missing] } : prev;
    });
  }, [workspaceBoardState.selectedWorkspaceId]);


  /** *.dashboard.json artifacts for the selected workspace (sidebar Dashboards group). */
  const [wsDashboards, setWsDashboards] = useState<Record<string, Array<{ path: string; name: string; panels: number }>>>({});
  useEffect(() => {
    const key = workspaceBoardState.selectedWorkspaceId;
    if (!key) return;
    const entry = workspaceRuntime.workspaces.find((w) => w.selectionKey === key || w.id === key);
    if (!entry) return;
    const be = multi.getBackend(entry.backendKey);
    if (!be?.listWorkspaceArtifacts) return;
    let alive = true;
    void (async () => {
      try {
        const arts = await be.listWorkspaceArtifacts!(entry.id);
        const dashes = arts.filter((a) => a.path.endsWith('.dashboard.json'));
        const detailed = await Promise.all(dashes.map(async (d) => {
          let name = (d.path.split('/').pop() ?? d.path).replace('.dashboard.json', '');
          let panels = 0;
          try {
            const raw = await be.readWorkspaceArtifact!(entry.id, d.path);
            const doc = JSON.parse(decodeBase64Utf8(raw.base64)) as { name?: string; panels?: unknown[] };
            if (doc.name) name = doc.name;
            panels = Array.isArray(doc.panels) ? doc.panels.length : 0;
          } catch { /* count stays 0 */ }
          return { path: d.path, name, panels };
        }));
        if (alive) setWsDashboards((prev) => ({ ...prev, [key]: detailed }));
      } catch { /* additive */ }
    })();
    return () => { alive = false; };
  }, [workspaceBoardState.selectedWorkspaceId, workspaceRuntime.workspaces, multi]);

  const workspaceStatusById = workspaceRuntime.stripStatusById;

  const workspaceBySelectionKey = useMemo(() => {
    const entries = new Map<string, WorkspaceInfo>();
    for (const workspace of allWorkspaceEntries) {
      if (workspace.selectionKey) {
        entries.set(workspace.selectionKey, workspace);
      }
    }
    return entries;
  }, [allWorkspaceEntries]);

  const backendKeyFromSelectionKey = useCallback((selectionKey: string): BackendKey => {
    return JSON.parse(selectionKey)[0] as BackendKey;
  }, []);



  const attachedWorkspaceForDetail = useMemo(
    () => attachedWorkspaceSelectionKey ? (workspaceBySelectionKey.get(attachedWorkspaceSelectionKey) ?? null) : null,
    [attachedWorkspaceSelectionKey, workspaceBySelectionKey],
  );

  const currentDetailWorkspace = selectedWorkspaceForDetail ?? attachedWorkspaceForDetail;
  useEffect(() => {
    setDetailWorkspaceCacheKeys((current) => current.filter((key) => workspaceBySelectionKey.has(key)).slice(0, DETAIL_VIEW_CACHE_LIMIT));
  }, [workspaceBySelectionKey]);


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
    const attachedPanes = Object.values(attachedBackendState?.attachedPanes ?? {});
    const targetReached = !!pendingAgentAttachTarget
      && terminalMode === 'attached'
      && attachedPanes.some((pane) =>
        pane.agentSessionId === pendingAgentAttachTarget.agentSessionId
        && pane.workspaceId === pendingAgentAttachTarget.workspaceId
      );
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
    openAgentSessionAction(workspaceId, agentSessionId, { attachOptions: { ...getWebAgentAttachSize(), paneId: allocatePaneId('agent') } })
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
  }, [openAgentSessionAction, getWebAgentAttachSize, allocatePaneId]);

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
      attachOptions: { ...getWebAgentAttachSize(), paneId: allocatePaneId('agent') },
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
  }, [createAgentSessionAction, getWebAgentAttachSize, allocatePaneId]);

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
        setScriptWorkspaceName(params.workspaceId.split(':').slice(-1)[0] ?? params.workspaceId);
        activeScriptTaskIdRef.current = workspaceRemovalTasks.startLifecycleTask({
          ref: workspaceRef ?? getWorkspaceRef(params.workspaceId),
          workspaceName: params.workspaceId.split(':').slice(-1)[0] ?? params.workspaceId,
        });
        setShowScriptTerminal(false);
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
        const taskId = activeScriptTaskIdRef.current;
        if (taskId) workspaceRemovalTasks.completeFailure(taskId, 'Workspace scripts cancelled.');
        activeScriptTaskIdRef.current = null;
      }
    },
    onAttachSuccess: ({ target }) => {
      if (target !== 'workspace') return;
      const taskId = activeScriptTaskIdRef.current;
      if (taskId) workspaceRemovalTasks.completeSuccess(taskId, 'Workspace scripts complete');
      activeScriptTaskIdRef.current = null;
      setShowScriptTerminal(false);
    },
    onAttachError: ({ target, message }) => {
      const isWorkspaceScriptFailure = message.startsWith('Workspace scripts failed during');
      const hasScriptRuntimeState = Boolean(scriptState);
      if (target === 'workspace' && (!isWorkspaceScriptFailure || !hasScriptRuntimeState)) {
        setShowScriptTerminal(false);
        lastScriptWorkspaceIdRef.current = null;
        lastScriptWorkspaceRef.current = null;
      }
      if (target === 'workspace') {
        const taskId = activeScriptTaskIdRef.current;
        if (taskId) workspaceRemovalTasks.completeFromError(taskId, message);
        activeScriptTaskIdRef.current = null;
      }
      flow.showMessage({
        title: isWorkspaceScriptFailure ? 'Workspace Script Failed' : 'Session Failed',
        message,
        variant: 'error',
      });
    },
  });

  const { deleteWorkspaceWithPrompt, deleteWorkspaceSkipScriptsWithPrompt } = useWorkspaceLifecycleActions({
    client: workspaceLifecycleClient,
    flow,
    onBeforeDelete: ({ target, params }) => {
      suppressDeleteScriptFailureModalRef.current = true;
      activeDeleteTaskIdRef.current = workspaceRemovalTasks.startTask(target);
      workspaceRemovalTasks.updatePhase(
        target.ref.workspaceId,
        params.scriptPolicy === 'skip' ? 'git-worktree-remove' : 'remove',
        params.scriptPolicy === 'skip' ? 'Removing workspace directory without cleanup scripts...' : 'Running cleanup scripts...'
      );
      if (workspaceBoardState.selectedWorkspaceId === toBackendScopedWorkspaceKey(target.ref)) {
        workspaceBoardState.setSelectedWorkspaceId(null);
      }
      workspaceController.clearSelectedRef();
    },
    onDeleteSuccess: async ({ target }) => {
      suppressDeleteScriptFailureModalRef.current = false;
      const taskId = activeDeleteTaskIdRef.current;
      if (taskId) workspaceRemovalTasks.completeSuccess(taskId);
      activeDeleteTaskIdRef.current = null;
      if (workspaceBoardState.selectedWorkspaceId === toBackendScopedWorkspaceKey(target.ref)) {
        workspaceBoardState.setSelectedWorkspaceId(null);
      }
      workspaceController.clearSelectedRef();
    },
    onDeleteCancelled: async () => {
      suppressDeleteScriptFailureModalRef.current = false;
      const taskId = activeDeleteTaskIdRef.current;
      if (taskId) workspaceRemovalTasks.completeFailure(taskId, 'Workspace removal cancelled.');
      activeDeleteTaskIdRef.current = null;
    },
    onDeleteError: async ({ message }) => {
      suppressDeleteScriptFailureModalRef.current = false;
      const taskId = activeDeleteTaskIdRef.current;
      if (taskId) workspaceRemovalTasks.completeFromError(taskId, message);
      activeDeleteTaskIdRef.current = null;
      flow.showMessage({ title: 'Delete Failed', message, variant: 'error' });
    },
  });


  const openCreateGoalFlow = useCallback((projectName?: string | null) => {
    const candidateWorkspaces = allWorkspaceEntries.filter((workspace) => !projectName || workspace.projectName === projectName);
    if (candidateWorkspaces.length === 0) {
      flow.showMessage({
        title: 'Create Goal',
        message: 'Create a workspace first, then add goals before or after it.',
        variant: 'info',
      });
      return;
    }

    flow.showSelect<string>({
      title: 'Anchor Goal To Workspace',
      searchable: true,
      options: candidateWorkspaces.map((workspace) => ({
        label: workspace.name,
        description: `${workspace.projectName} · ${workspace.branch ?? workspace.path}`,
        value: workspace.selectionKey ?? workspace.id,
      })),
      onSelect: (workspaceKey) => {
        const workspace = candidateWorkspaces.find((item) => (item.selectionKey ?? item.id) === workspaceKey);
        if (!workspace) return;
        flow.showInput({
          title: 'Goal Title',
          placeholder: 'e.g. Billing UI polish',
          onSubmit: (title) => {
            const trimmed = title.trim();
            if (!trimmed) return;
            flow.showSelect<'before' | 'after'>({
              title: 'Goal Position',
              options: [
                { label: 'After workspace', description: `Add after ${workspace.name}`, value: 'after' },
                { label: 'Before workspace', description: `Add before ${workspace.name}`, value: 'before' },
              ],
              onSelect: async (position) => {
                try {
                  await multi.addGoalNearWorkspace(workspace.backendKey as BackendKey, workspace.projectName, workspace.name, trimmed, position);
                  flow.close();
                  toast.success(`Added goal "${trimmed}"`);
                } catch (error) {
                  flow.showMessage({
                    title: 'Create Goal Failed',
                    message: error instanceof Error ? error.message : String(error),
                    variant: 'error',
                  });
                }
              },
            });
          },
        });
      },
    });
  }, [allWorkspaceEntries, flow, multi]);

  const lifecycleController = useLifecycleActions({
    client: sessionClient,
    backendKey: getTargetBackendKey(),
    flow,
    getProjectNames: () => allProjects.map((p) => p.name),
	    refreshProjects: () => multi.listProjects(),
	    refreshWorkspaces: () => multi.listWorkspaces(),
	    refreshSessions: () => multi.listSessions(),
	    openCreateGoalFlow,
	    onProjectCreated: () => undefined,
	    onWorkspaceCreating: ({ workspaceName, projectName }) => {
	      workspaceCreationTasks.startTask({ projectName, workspaceName, phase: 'code', progressLabel: 'Creating workspace...' });
	    },
	    onWorkspaceCreated: ({ workspaceId }) => {
	      workspaceCreationTasks.completeTaskByWorkspaceId(workspaceId);
	    },
	    onWorkspaceCreateFailed: ({ workspaceId }, _error) => {
	      workspaceCreationTasks.failTaskByWorkspaceId(workspaceId, 'Creation failed');
	    },
  });

  const handleCreatePlannedGoalWorkspace = useCallback(async (goal: KanbanGoalItem) => {
    const workspaceName = goal.plannedWorkspaceName ?? goal.title;
    const taskId = workspaceCreationTasks.startTask({
      projectName: goal.projectName,
      workspaceName,
      phase: goal.phase,
      progressLabel: goal.previousWorkspaceName
        ? `Creating from ${goal.previousWorkspaceName}...`
        : 'Creating workspace...',
    });
    try {
      await multi.createWorkspace(goal.backendKey as BackendKey, {
        projectName: goal.projectName,
        workspaceName,
        branchName: workspaceName,
        parentWorkspaceName: goal.previousWorkspaceName,
      });
      await multi.listWorkspaces();
      await multi.listSessions();
      workspaceCreationTasks.completeTaskByWorkspaceId(`${goal.projectName}:${workspaceName}`);
      toast.success(`Created workspace ${workspaceName}`);
    } catch (error) {
      workspaceCreationTasks.failTask(taskId, error instanceof Error ? error.message : String(error));
      flow.showMessage({
        title: 'Create Workspace Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    }
  }, [flow, multi, workspaceCreationTasks]);

  const getPersistedGoalId = useCallback((goal: KanbanGoalItem) => {
    const prefix = `${goal.projectName}:`;
    return goal.id.startsWith(prefix) ? goal.id.slice(prefix.length) : goal.id;
  }, []);

  const getGoalMoveToken = useCallback((goal: KanbanGoalItem) => (
    goal.workspaceName ?? goal.plannedWorkspaceName ?? getPersistedGoalId(goal)
  ), [getPersistedGoalId]);

  const handleSelectPlannedGoal = useCallback((goal: KanbanGoalItem) => {
    setSelectedGoalKey(goal.selectionKey);
    setGoalDetailMessage(null);
    setGoalStackStatus(null);
  }, []);

  const showGoalChainsCommand = useCallback(() => {
    const chains = Array.from(
      allGoalItems.reduce((map, goal) => {
        const existing = map.get(goal.chainId);
        const goals = [...(existing?.goals ?? []), goal].sort((a, b) => a.chainPosition - b.chainPosition);
        map.set(goal.chainId, {
          chainId: goal.chainId,
          title: goal.chainTitle,
          goals,
        });
        return map;
      }, new Map<string, { chainId: string; title: string; goals: KanbanGoalItem[] }>()),
      ([, value]) => value,
    );

    if (chains.length === 0) {
      flow.showMessage({
        title: 'Goal Chains',
        message: 'No goal chains are planned in this project yet.',
        variant: 'info',
      });
      return;
    }

    flow.showSelect<string>({
      title: 'Goal Chains',
      searchable: true,
      options: chains.map((chain) => ({
        label: chain.title,
        description: `${chain.goals.length} goal${chain.goals.length === 1 ? '' : 's'} · ${chain.goals.map((goal) => goal.workspaceName ?? goal.plannedWorkspaceName ?? goal.title).join(' → ')}`,
        value: chain.chainId,
      })),
      onSelect: (chainId) => {
        const firstGoal = chains.find((chain) => chain.chainId === chainId)?.goals[0];
        if (firstGoal) {
          handleSelectPlannedGoal(firstGoal);
        }
        flow.close();
      },
    });
  }, [allGoalItems, flow, handleSelectPlannedGoal]);

  const resolveGoalCommandWorkspace = useCallback((goal: KanbanGoalItem) => {
    if (goal.workspaceName) {
      return allWorkspaceEntries.find((workspace) =>
        workspace.backendKey === goal.backendKey &&
        workspace.projectName === goal.projectName &&
        workspace.name === goal.workspaceName,
      ) ?? null;
    }
    if (selectedWorkspaceForDetail && selectedWorkspaceForDetail.backendKey === goal.backendKey && selectedWorkspaceForDetail.projectName === goal.projectName) {
      return selectedWorkspaceForDetail;
    }
    return allWorkspaceEntries.find((workspace) =>
      workspace.backendKey === goal.backendKey &&
      workspace.projectName === goal.projectName,
    ) ?? null;
  }, [allWorkspaceEntries, selectedWorkspaceForDetail]);


  const getGoalMutationBackend = useCallback((goal: KanbanGoalItem) => {
    const workspace = resolveGoalCommandWorkspace(goal);
    const backendKey =
      (workspace?.backendKey as BackendKey | undefined) ??
      (goal.backendKey as BackendKey | undefined) ??
      activeBackendKey ??
      multiMachineState.backendOrder[0] ??
      multi.localBackendKey;
    return { backend: multi.getBackend(backendKey), workspace };
  }, [activeBackendKey, multi, multiMachineState.backendOrder, resolveGoalCommandWorkspace]);
  const handleSaveGoalDoc = useCallback(async (goal: KanbanGoalItem, bodyMarkdown: string) => {
    setGoalSaving(true);
    try {
      const updated = await multi.updateGoal(goal.backendKey as BackendKey, goal.projectName, getPersistedGoalId(goal), {
        doc: {
          ...(goal.doc ?? { updatedAt: new Date().toISOString(), bodyMarkdown: '' }),
          bodyMarkdown,
          updatedAt: new Date().toISOString(),
        },
      });
      setGoalDetailMessage(`Saved goal doc: ${updated.title}`);
      await multi.listWorkspaces();
    } catch (error) {
      flow.showMessage({
        title: 'Save Goal Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    } finally {
      setGoalSaving(false);
    }
  }, [flow, getPersistedGoalId, multi]);
  // Validation contract mutations

  const handleAddGoalRequirement = useCallback(async (goal: KanbanGoalItem, input: Parameters<NonNullable<import('./session/backend.js').SessionBackend['addGoalRequirement']>>[2]) => {
    setGoalSaving(true);
    try {
      const { backend } = getGoalMutationBackend(goal);
      if (!backend?.addGoalRequirement) throw new Error('This backend does not support declaring requirements.');
      const requirement = await backend.addGoalRequirement(goal.projectName, getPersistedGoalId(goal), input);
      await multi.listWorkspaces();
      setGoalDetailMessage(`Added requirement: ${requirement.title}`);
    } catch (error) {
      flow.showMessage({ title: 'Add Requirement Failed', message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setGoalSaving(false);
    }
  }, [flow, getGoalMutationBackend, getPersistedGoalId, multi]);

  const handleUpdateGoalRequirement = useCallback(async (goal: KanbanGoalItem, requirementId: string, patch: Parameters<NonNullable<import('./session/backend.js').SessionBackend['updateGoalRequirement']>>[3]) => {
    setGoalSaving(true);
    try {
      const { backend } = getGoalMutationBackend(goal);
      if (!backend?.updateGoalRequirement) throw new Error('This backend does not support editing requirements.');
      const requirement = await backend.updateGoalRequirement(goal.projectName, getPersistedGoalId(goal), requirementId, patch);
      await multi.listWorkspaces();
      setGoalDetailMessage(`Updated requirement: ${requirement.title}`);
    } catch (error) {
      flow.showMessage({ title: 'Update Requirement Failed', message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setGoalSaving(false);
    }
  }, [flow, getGoalMutationBackend, getPersistedGoalId, multi]);

  const handleRemoveGoalRequirement = useCallback(async (goal: KanbanGoalItem, requirementId: string) => {
    setGoalSaving(true);
    try {
      const { backend } = getGoalMutationBackend(goal);
      if (!backend?.removeGoalRequirement || !backend?.addGoalRequirement) {
        throw new Error('This backend does not support removing requirements.');
      }
      const snapshot = goal.validation?.requirements?.[requirementId];
      await backend.removeGoalRequirement(goal.projectName, getPersistedGoalId(goal), requirementId);
      await multi.listWorkspaces();
      setGoalDetailMessage('Requirement removed.');
      if (snapshot) {
        toast('Requirement removed', {
          duration: 8000,
          action: {
            label: 'Undo',
            onClick: () => {
              void (async () => {
                try {
                  await backend.addGoalRequirement!(goal.projectName, getPersistedGoalId(goal), {
                    title: snapshot.title,
                    kind: snapshot.kind,
                    rubric: snapshot.rubric,
                    required: snapshot.required,
                    generation: snapshot.generation,
                    judgment: snapshot.judgment,
                  });
                  await multi.listWorkspaces();
                  setGoalDetailMessage(`Restored requirement: ${snapshot.title}`);
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : String(error));
                }
              })();
            },
          },
        });
      }
    } catch (error) {
      flow.showMessage({ title: 'Remove Requirement Failed', message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setGoalSaving(false);
    }
  }, [flow, getGoalMutationBackend, getPersistedGoalId, multi]);

  const handleReorderGoalRequirement = useCallback(async (goal: KanbanGoalItem, requirementId: string, position: number) => {
    setGoalSaving(true);
    try {
      const { backend } = getGoalMutationBackend(goal);
      if (!backend?.reorderGoalRequirement) throw new Error('This backend does not support reordering requirements.');
      await backend.reorderGoalRequirement(goal.projectName, getPersistedGoalId(goal), requirementId, position);
      await multi.listWorkspaces();
    } catch (error) {
      flow.showMessage({ title: 'Reorder Failed', message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setGoalSaving(false);
    }
  }, [flow, getGoalMutationBackend, getPersistedGoalId, multi]);

  const handleReopenGoalRequirement = useCallback(async (goal: KanbanGoalItem, requirementId: string) => {
    setGoalSaving(true);
    try {
      const { backend } = getGoalMutationBackend(goal);
      if (!backend?.reopenGoalRequirement) throw new Error('This backend does not support reopening requirements.');
      const requirement = await backend.reopenGoalRequirement(goal.projectName, getPersistedGoalId(goal), requirementId);
      await multi.listWorkspaces();
      setGoalDetailMessage(`Reopened for review: ${requirement.title}`);
    } catch (error) {
      flow.showMessage({ title: 'Reopen Failed', message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setGoalSaving(false);
    }
  }, [flow, getGoalMutationBackend, getPersistedGoalId, multi]);

  const handleAttachGoalEvidence = useCallback(async (goal: KanbanGoalItem, requirementId: string, input: Parameters<NonNullable<import('./session/backend.js').SessionBackend['attachGoalEvidence']>>[3]) => {
    setGoalSaving(true);
    try {
      const { backend } = getGoalMutationBackend(goal);
      if (!backend?.attachGoalEvidence) throw new Error('This backend does not support attaching evidence.');
      const evidence = await backend.attachGoalEvidence(goal.projectName, getPersistedGoalId(goal), requirementId, input);
      await multi.listWorkspaces();
      setGoalDetailMessage(`Attached evidence: ${evidence.name}`);
    } catch (error) {
      flow.showMessage({ title: 'Attach Evidence Failed', message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setGoalSaving(false);
    }
  }, [flow, getGoalMutationBackend, getPersistedGoalId, multi]);

  const handleRunGoalGeneration = useCallback(async (goal: KanbanGoalItem, requirementId: string) => {
    setGoalSaving(true);
    try {
      const { backend } = getGoalMutationBackend(goal);
      if (!backend?.runGoalGeneration) throw new Error('This backend does not support running generation commands.');
      const result = await backend.runGoalGeneration(goal.projectName, getPersistedGoalId(goal), requirementId);
      await multi.listWorkspaces();
      setGoalDetailMessage(`Generation produced ${result.evidence.name}${result.autoAccepted ? ' (auto-accepted)' : ''}.`);
    } catch (error) {
      flow.showMessage({ title: 'Run Generation Failed', message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setGoalSaving(false);
    }
  }, [flow, getGoalMutationBackend, getPersistedGoalId, multi]);



  const handleSaveChainOrder = useCallback(async (draftGoals: KanbanGoalItem[]) => {
    if (draftGoals.length < 2) return;
    const backendKey = draftGoals[0].backendKey as BackendKey;
    const projectName = draftGoals[0].projectName;
    const currentGoals = allGoalItems
      .filter((goal) => goal.backendKey === draftGoals[0].backendKey && goal.projectName === projectName && goal.chainId === draftGoals[0].chainId)
      .sort((a, b) => a.chainPosition - b.chainPosition);
    const currentOrder = currentGoals.map(getGoalMoveToken);
    const desiredOrder = draftGoals.map(getGoalMoveToken);

    try {
      for (let index = 0; index < desiredOrder.length; index += 1) {
        if (currentOrder[index] === desiredOrder[index]) continue;
        const sourceToken = desiredOrder[index];
        const sourceIndex = currentOrder.indexOf(sourceToken);
        const targetToken = currentOrder[index];
        if (sourceIndex < 0 || !targetToken) continue;
        await multi.moveGoalInChain(backendKey, projectName, sourceToken, targetToken, 'before');
        currentOrder.splice(sourceIndex, 1);
        currentOrder.splice(index, 0, sourceToken);
      }
      setBoardGoalOrderMessage('Goal order saved; git stack unchanged. Run stack status when ready.');
      setGoalDetailMessage('Goal order saved; git stack unchanged. Run stack status when ready.');
      await multi.listWorkspaces();
    } catch (error) {
      flow.showMessage({
        title: 'Save Goal Order Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
      throw error;
    }
  }, [allGoalItems, flow, getGoalMoveToken, multi]);
  const handleRunGoalJudgment = useCallback(async (goal: KanbanGoalItem, requirementId: string) => {
    setGoalSaving(true);
    try {
      const { backend } = getGoalMutationBackend(goal);
      if (!backend?.runGoalJudgment) throw new Error('This backend does not support running judgments.');
      const result = await backend.runGoalJudgment(goal.projectName, getPersistedGoalId(goal), requirementId);
      await multi.listWorkspaces();
      setGoalDetailMessage(`Judgment recorded: ${result.review.tone === 'green' ? 'passed' : result.review.tone === 'amber' ? 'needs changes' : 'failed'}.`);
    } catch (error) {
      flow.showMessage({ title: 'Run Judgment Failed', message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setGoalSaving(false);
    }
  }, [flow, getGoalMutationBackend, getPersistedGoalId, multi]);

  const handleRecordGoalHumanReview = useCallback(async (goal: KanbanGoalItem, requirementId: string, decision: 'pass' | 'changes' | 'fail', note: string) => {
    setGoalSaving(true);
    try {
      const { backend } = getGoalMutationBackend(goal);
      if (!backend?.recordGoalHumanReview) throw new Error('This backend does not support recording reviews.');
      const review = await backend.recordGoalHumanReview(goal.projectName, getPersistedGoalId(goal), requirementId, decision, note);
      await multi.listWorkspaces();
      setGoalDetailMessage(`Review recorded: ${review.tone === 'green' ? 'passed' : review.tone === 'amber' ? 'needs changes' : 'failed'}.`);
    } catch (error) {
      flow.showMessage({ title: 'Record Review Failed', message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setGoalSaving(false);
    }
  }, [flow, getGoalMutationBackend, getPersistedGoalId, multi]);


  const handleRefreshGoalStackStatus = useCallback(async (goal: KanbanGoalItem) => {
    const workspaceName = goal.workspaceName ?? goal.plannedWorkspaceName;
    if (!workspaceName) {
      setGoalDetailMessage('Goal has no workspace name to validate.');
      return;
    }
    try {
      const status = await multi.getGoalStackStatus(goal.backendKey as BackendKey, goal.projectName, workspaceName);
      setGoalStackStatus(status);
      setGoalEdgeStatusByKey((current) => {
        const next = { ...current };
        for (const edge of status.edges) {
          next[toGoalCacheKey(goal.backendKey, goal.projectName, edge.childGoalId)] = {
            status: edge.status,
            message: edge.message,
          };
        }
        return next;
      });
      setGoalDetailMessage(null);
    } catch (error) {
      flow.showMessage({
        title: 'Stack Status Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    }
  }, [flow, multi]);


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
      setShowScriptTerminal(false);
    }
    if (terminalMode === 'attached' || terminalStatus !== 'connected') {
      setShowScriptTerminal(false);
    }
  }, [terminalMode, scriptState?.isRunning, scriptState?.phase, terminalStatus]);





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
    const paneId = allocatePaneId(params.sessionId ? 'session' : 'workspace');
    await attachController.attachFromSelection({
      ...params,
      backendKey: params.sessionId ? (selectedBackendKey ?? attachedBackendKey ?? activeBackendKey ?? undefined) : undefined,
      paneId,
    });
  }, [activeBackendKey, attachController, attachedBackendKey, selectedBackendKey, allocatePaneId]);

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
  const handleOpenCreateMenu = useCallback(() => lifecycleController.openCreateMenu(), [lifecycleController]);
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
        void multi.terminateSession(sessionRef);
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

  const handleDeleteWorkspaceSkipScripts = useCallback((workspace: WorkspaceInfo) => {
    const sessionCount = workspace.sessionCount || 0;
    flow.showConfirmTyped({
      title: 'Delete Workspace (Skip Scripts)',
      message: `Delete workspace \"${workspace.name}\" without running cleanup scripts?`,
      confirmText: workspace.name,
      warning: sessionCount > 0
        ? `This will kill ${sessionCount} active session(s) and skip cleanup scripts.`
        : 'This skips cleanup scripts.',
      onConfirm: async () => {
        const ref = getWorkspaceRef(workspace.id);
        await deleteWorkspaceSkipScriptsWithPrompt({ ref, workspaceName: workspace.name });
      },
    });
  }, [deleteWorkspaceSkipScriptsWithPrompt, flow, getWorkspaceRef]);
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
  const runWorkspaceBundleScripts = useCallback(async (
    workspace: WorkspaceInfo & { selectionKey?: string },
    options?: { announceSuccess?: boolean; mode?: 'open' | 'rerun'; selection?: 'setup' | 'select' | 'setup-select' }
  ): Promise<boolean> => {
    if (!workspace.selectionKey) {
      toast.error('Workspace selection is unavailable.');
      return false;
    }
    const selectionKey = workspace.selectionKey;
    if (scriptRunInFlightRef.current.has(selectionKey)) {
      return false;
    }
    const backendKey = backendKeyFromSelectionKey(selectionKey);
    const backend = multi.getBackend(backendKey);
    if (!backend) {
      toast.error(options?.mode === 'rerun' ? 'This backend does not support workspace script commands.' : 'Workspace open scripts are not supported for this backend.');
      return false;
    }
    const selection = options?.selection ?? 'setup-select';
    if (options?.mode === 'rerun') {
      const canRerun = selection === 'setup-select' ? Boolean(backend.rerunWorkspaceScripts) : Boolean(backend.runWorkspaceScriptSelection);
      if (!canRerun) {
        toast.error('This backend does not support the selected workspace script command.');
        return false;
      }
    } else if (!backend.runWorkspaceOpenScripts) {
      // Passive open on a backend without open-script support is a silent no-op —
      // never fall back to an explicit rerun, and never show a task/toast/modal.
      return false;
    }
    scriptRunInFlightRef.current.add(selectionKey);
    const ref = { backendKey, workspaceId: workspace.id };
    const taskId = workspaceRemovalTasks.startLifecycleTask({ ref, workspaceName: workspace.name }, options?.mode === 'rerun' ? (options.selection === 'select' ? 'select' : 'setup') : 'select');
    activeScriptTaskIdRef.current = taskId;
    activeScriptWorkspaceIdRef.current = workspace.id;
    try {
      if (options?.mode === 'rerun') {
        if (selection === 'setup-select') {
          await backend.rerunWorkspaceScripts?.(workspace.projectName, workspace.id);
        } else {
          await backend.runWorkspaceScriptSelection?.(workspace.projectName, workspace.id, selection);
        }
      } else {
        // Passive open: run only the intentional open-scripts path (no rerun fallback).
        await backend.runWorkspaceOpenScripts?.(workspace.projectName, workspace.id);
      }
      if (activeScriptTaskIdRef.current === taskId) {
        workspaceRemovalTasks.completeSuccess(taskId, 'Workspace scripts complete');
        activeScriptTaskIdRef.current = null;
        activeScriptWorkspaceIdRef.current = null;
      }
      await multi.listWorkspaces();
      if (options?.announceSuccess !== false) {
        const ranLabel = selection === 'setup' ? 'setup scripts' : selection === 'select' ? 'select scripts' : 'setup and select scripts';
        toast.success(`Ran ${ranLabel} for ${workspace.name}.`);
      }
      return true;
    } catch (error) {
      if (activeScriptTaskIdRef.current === taskId) {
        workspaceRemovalTasks.completeFromError(taskId, error instanceof Error ? error.message : String(error));
        activeScriptTaskIdRef.current = null;
        activeScriptWorkspaceIdRef.current = null;
      }
      toast.error(error instanceof Error ? error.message : 'Failed to rerun bundle scripts');
      return false;
    } finally {
      scriptRunInFlightRef.current.delete(selectionKey);
    }
  }, [backendKeyFromSelectionKey, multi, workspaceRemovalTasks]);

  const handleRerunBundleScripts = useCallback(async (workspace: WorkspaceInfo & { selectionKey?: string }) => {
    flow.showSelect<'setup' | 'select' | 'setup-select'>({
      title: 'Run Workspace Scripts',
      options: [
        { label: 'Setup scripts', description: 'Explicitly rerun setup only.', value: 'setup' },
        { label: 'Select scripts', description: 'Run the scripts used whenever this workspace is opened.', value: 'select' },
        { label: 'Setup, then select', description: 'Rerun the full setup/select sequence.', value: 'setup-select' },
      ],
      onSelect: async (selection) => {
        flow.close();
        await runWorkspaceBundleScripts(workspace, { announceSuccess: true, mode: 'rerun', selection });
      },
    });
  }, [flow, runWorkspaceBundleScripts]);

  // NOTE: passive Workspace Detail top-strip A -> B switching must NOT run
  // scripts. Viewing/selecting an already-open workspace is not the same as
  // activating it, so there is deliberately no effect here that runs open
  // scripts on visible-detail change. Lifecycle scripts run only on real session
  // attach (backend side) or via explicit "Run Workspace Scripts".


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
    onAddWorkspace: () => lifecycleController.openCreateMenu(),
    onSetWorkspacePhase: (workspace, phase) => {
      workspaceBoardState.setPhase(workspace.selectionKey ?? workspace.id, phase);
      flow.close();
    },
    onDeleteWorkspace: handleDeleteWorkspace,
    onDeleteWorkspaceSkipScripts: handleDeleteWorkspaceSkipScripts,
    onEditBundleConfig: async (workspace) => {
      await handleManageBundleConfig({ workspaceId: workspace.id });
    },
    onRefreshBundle: async (workspace) => {
      const ref = getWorkspaceRef(workspace.id);
      const refreshed = await bundleRefreshAttach.refreshBundle(ref);
      if (refreshed) {
        multi.listWorkspaces();
        multi.listSessions();
      }
    },
    onRerunBundleScripts: handleRerunBundleScripts,
    onAddNote: async (workspace) => {
      // Notes are dock tabs now (mock NoteView): open the workspace + a composer tab.
      const key = workspace.selectionKey ?? workspace.id;
      handleBoardSelectWorkspace(key);
      setDockExtraPanes((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), { kind: 'note', noteId: null, title: 'New note', nonce: Date.now() }] }));
    },
    onListNotes: async (workspace) => {
      // Notes live in the workspace rail (Artifacts mode) — open the workspace.
      handleBoardSelectWorkspace(workspace.selectionKey ?? workspace.id);
    },
    onEditProcessConfig: async (workspace) => {
      await handleEditProcesses({ workspaceId: workspace.id });
    },
    onDeleteRepo: handleDeleteProject,
    onOpenGitHubPr: (workspace) => handleOpenGitHubPullRequest(workspace.id),
    onOpenReview: (workspace) => handleOpenReview(workspace.id),
    onOpenEditor: async (workspace) => {
      const ref = getWorkspaceRef(workspace.id);
      await showWorkspaceEditorSelect({
        workspace,
        showSelect: (config) => flow.showSelect<string>(config),
        showMessage: ({ message, variant }) => {
          if (variant === 'error') toast.error(message);
          else if (variant === 'warning') toast.warning(message);
          else if (variant === 'success') toast.success(message);
          else toast.info(message);
        },
        listAvailableEditors: () => multi.listAvailableEditors(ref),
        openInEditor: async (editorId) => {
          await multi.openWorkspaceInEditor(ref, editorId);
          toast.success(`Opening ${workspace.name} in editor...`);
        },
      });
    },
    onShowGoalChains: showGoalChainsCommand,
  });

  const inboxActions = useInboxActions({
    client: agentSessionClientContext,
    flow,
    onError: (message) => {
      toast.error(message);
    },
  });

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
      await attachController.attachFromSelection({ sessionId, workspaceId: sessionRef.workspaceId, backendKey: sessionRef.backendKey });
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
          void attachController.attachFromSelection({ sessionId: notification.sessionId, workspaceId: sessionRef.workspaceId, backendKey: sessionRef.backendKey });
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
      void attachController.attachFromSelection({ sessionId, workspaceId: sessionRef.workspaceId, backendKey: sessionRef.backendKey });
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
            onSendToAgent={async (thread) => {
              // Route the finding into the workspace's active agent session.
              const backendKey = reviewWorkspace.backendKey;
              const be = backendKey ? multi.getBackend(backendKey) : null;
              const st = backendKey ? multiMachineState.byBackend[backendKey] : null;
              const wsId = `${reviewWorkspace.projectName}:${reviewWorkspace.workspaceId}`;
              const agentId = Object.entries(st?.snapshot?.agentSessionsById ?? {})
                .find(([, sess]) => (sess as { workspaceId?: string; state?: string }).workspaceId === wsId
                  && (sess as { state?: string }).state !== 'closed')?.[0];
              if (!be?.promptAgentSession || !agentId) {
                toast.error('No active agent session to route this finding to.');
                return;
              }
              const target = thread.target;
              const loc = target.kind === 'workspace' ? 'workspace-wide'
                : target.kind === 'file' ? target.file
                : `${(target as { file: string }).file}`;
              const body = thread.comments.map((c) => c.body).join('\n\n');
              await be.promptAgentSession(wsId, agentId, `Review finding (${loc}) — please fix:\n\n${body}`, undefined, { streamingBehavior: 'followUp' });
              toast.success('Finding routed to the agent.');
            }}
            onBack={() => { setView('terminal'); setReviewWorkspace(null); }}
          />
          <Toaster theme="dark" position="bottom-right" richColors />
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
        <Toaster theme="dark" position="bottom-right" richColors />
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
          <Toaster theme="dark" position="bottom-right" richColors />
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
        <Toaster theme="dark" position="bottom-right" richColors />
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
        <Toaster theme="dark" position="bottom-right" richColors />
      </>
    );
  }

  // ─── Workspace browser / detail (connected + browsing, or inline-attached) ──

  if (
    view === "terminal" &&
    terminalStatus === "connected" &&
    (terminalMode === "browsing" || (terminalMode === "attached" && currentDetailWorkspace))
  ) {
    if (showInbox) {
      return (
        <>
          <InboxWeb {...inboxProps} />
          <FlowWeb flow={flow} />
          <Toaster theme="dark" position="bottom-right" richColors />
        </>
      );
    }

    if (showEvents) {
      return (
        <>
          <EventsWeb {...eventsProps} workspaceLabel={eventsWorkspaceLabel} />
          <FlowWeb flow={flow} />
          <Toaster theme="dark" position="bottom-right" richColors />
        </>
      );
    }


    // Shared overlays (rendered in both board and detail views)
    const overlays = (
      <>
        <FlowWeb flow={flow} />
        <Toaster theme="dark" position="bottom-right" richColors />

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
        {selectedGoal && (
          <GoalDetailPanel
            goal={selectedGoal}
            chainGoals={selectedGoalChainGoals}
            stackStatus={goalStackStatus}
            message={goalDetailMessage}
            saving={goalSaving}
            onClose={() => setSelectedGoalKey(null)}
            onSaveDoc={handleSaveGoalDoc}
            onCreateWorkspace={handleCreatePlannedGoalWorkspace}
            onSaveChainOrder={handleSaveChainOrder}
            onRefreshStackStatus={handleRefreshGoalStackStatus}
            onAddRequirement={handleAddGoalRequirement}
            onUpdateRequirement={handleUpdateGoalRequirement}
            onRemoveRequirement={handleRemoveGoalRequirement}
            onReorderRequirement={handleReorderGoalRequirement}
            onReopenRequirement={handleReopenGoalRequirement}
            onAttachEvidence={handleAttachGoalEvidence}
            onRunGeneration={handleRunGoalGeneration}
            onRunJudgment={handleRunGoalJudgment}
            onRecordHumanReview={handleRecordGoalHumanReview}
          />
        )}
      </>
    );

    const toggleInlineInputMode = () => {
      const newInputMode = !inputMode;
      setInputMode(newInputMode);
    };

    const showInlineFloatingControls = showMobileControls && !keyboardVisible;
    const inlineTerminalContainerClass = (() => {
      if (!showMobileControls) return 'flex-1 min-h-0';
      if (inputMode) return 'terminal-input-mode-container';
      return 'flex-1 min-h-0 terminal-with-floating-controls';
    })();

    const paneBackendKey = attachedBackendKey ?? activeBackendKey ?? selectedBackendKey ?? null;
    const paneBackend = paneBackendKey ? (paneBackendKey ? multi.getBackend(paneBackendKey) : null as RemoteSessionPtyBackend | null) : null;
    const snapshotCurrentDetailLayout = () => {
      const selectionKey = currentDetailWorkspace?.selectionKey;
      if (!selectionKey) return;
      const api = dockviewApiByWorkspaceRef.current[selectionKey];
      if (!api) return;
      dockviewLayoutsRef.current[selectionKey] = api.toJSON();
    };

    const handleSelectWorkspaceFromDetail = async (workspaceSelectionKey: string) => {
      if (workspaceSelectionKey === currentDetailWorkspace?.selectionKey) return;
      snapshotCurrentDetailLayout();
      hideScriptTerminal();
      setShowBoardWhileDetailMounted(false);
      handleBoardSelectWorkspace(workspaceSelectionKey);
    };


    const hideScriptTerminal = () => {
      setShowScriptTerminal(false);
      lastScriptWorkspaceIdRef.current = null;
      lastScriptWorkspaceRef.current = null;
    };

    const handleBackToBoard = async () => {
      snapshotCurrentDetailLayout();
      hideScriptTerminal();
      setShowBoardWhileDetailMounted(true);
    };

    const buildTerminalPanelsForWorkspace = (workspace: WorkspaceInfo) => {
      terminalMemoryDebugIncrement('app.buildTerminalPanels');
      const workspacePaneEntries = Object.values(attachedBackendState?.attachedPanes ?? {})
        .filter((pane) =>
          pane.workspaceId
            ? pane.workspaceId === workspace.id
            : attachedWorkspaceSelectionKey === workspace.selectionKey,
        );
      terminalMemoryDebugGauge('app.workspacePaneEntries', workspacePaneEntries.length);
      const runtime = workspace.selectionKey ? workspaceRuntime.runtimeByWorkspace[workspace.selectionKey] ?? null : null;
      const panels: import('./components/DockviewWorkspaceShell.web.js').DockviewTerminalPanel[] = workspacePaneEntries.map((pane) => {
        const shortSessionName = (pane.sessionName ?? pane.sessionId).split(':').pop() ?? pane.sessionId;
        const agentSession = pane.agentSessionId
          ? runtime?.agentSessions.find((session) => session.id === pane.agentSessionId)
          : null;
        const title = agentSession
          ? getAgentSessionDisplayTitle({ id: agentSession.id, title: agentSession.title })
          : pane.agentSessionId
            ? 'Agent'
            : shortSessionName.slice(0, 18);
        const panelVersion = [
          pane.paneId,
          pane.sessionId,
          pane.sessionName ?? '',
          pane.workspaceId ?? '',
          pane.agentSessionId ?? '',
          title,
          String(showMobileControls),
          inputMode,
          String(keyboardVisible),
          String(showInlineFloatingControls),
          String((agentSession as { state?: string } | null | undefined)?.state === 'running'),
        ].join('|');
        terminalMemoryDebugIncrement('app.terminalPanelDescriptor.created');
        return {
          id: pane.paneId,
          title,
          version: panelVersion,
          running: (agentSession as { state?: string } | null | undefined)?.state === 'running',
          onClose: () => paneBackend?.detachPane?.(pane.paneId).catch(() => undefined),
          render: () => (
            <PaneTerminalPanel
              pane={pane}
              backend={paneBackend}
              backendKey={paneBackendKey}
              showMobileControls={showMobileControls}
              inputMode={inputMode}
              keyboardVisible={keyboardVisible}
              onToggleInputMode={toggleInlineInputMode}
              inputButtonClassName={`px-2 py-1 text-xs rounded transition-all ${
                inputMode
                  ? 'bg-[var(--gs-accent)] text-[var(--gs-text-on-accent)] font-medium'
                  : 'bg-[var(--gs-btn-secondary-bg)] text-[var(--gs-text)] hover:bg-[var(--gs-border)]'
              }`}
              terminalContainerClassName={inlineTerminalContainerClass}
              onActivity={handleTerminalActivity}
              allowTapFocus={inputMode || !showMobileControls}
              allowTouchScroll={!inputMode}
              modifiers={modifiers}
              onModifiersChange={setModifiers}
              showFloatingControls={showInlineFloatingControls}
            />
          ),
        };
      });
      if (
        agentAttachPending &&
        pendingAgentAttachTarget &&
        pendingAgentAttachTarget.workspaceId === workspace.id &&
        !panels.some((panel) => panel.id === `pending:${pendingAgentAttachTarget.agentSessionId}`)
      ) {
        terminalMemoryDebugIncrement('app.terminalPanelDescriptor.pendingCreated');
        panels.push({
          id: `pending:${pendingAgentAttachTarget.agentSessionId}`,
          title: 'Attaching…',
          version: `pending:${pendingAgentAttachTarget.agentSessionId}`,
          render: () => (
            <div className="flex-1 flex items-center justify-center bg-[var(--gs-bg)]">
              <div className="text-sm text-[var(--gs-text-muted)]" style={{ animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' }}>Attaching agent session…</div>
            </div>
          ),
        });
      }
      // Repo files + artifacts opened from the RightRail as dock tabs
      // (mock Shell pane kinds 'file' and 'artifact').
      const wsKey = workspace.selectionKey ?? workspace.id;
      const workspaceGoalForPanels = allGoalItems.find((g) => g.workspaceName === workspace.name && g.projectName === workspace.projectName) ?? null;
      const dockPaneKey = (x: DockExtraPane): string =>
        x.kind === 'note' ? `note:${x.noteId ?? ''}:${x.nonce ?? ''}`
        : x.kind === 'evidence' ? `ev:${x.evidenceId}`
        : 'path' in x ? `${x.kind}:${x.path}`
        : x.kind;
      for (const extra of dockExtraPanes[wsKey] ?? []) {
        const name = extra.kind === 'note' ? extra.title : ('path' in extra ? (extra.path.split('/').pop() ?? extra.path) : extra.kind);
        const closeExtra = () => setDockExtraPanes((prev) => ({
          ...prev,
          [wsKey]: (prev[wsKey] ?? []).filter((x) => dockPaneKey(x) !== dockPaneKey(extra)),
        }));
        if (extra.kind === 'file') {
          panels.push({
            id: `file:${extra.path}`,
            title: `${extra.changed ? '± ' : '▤ '}${name}`,
            version: `file|${extra.path}|${extra.changed}|${extra.prevPath ?? ''}`,
            onClose: closeExtra,
            render: () => (
              <RepoFilePanel
                backend={paneBackend}
                workspaceId={workspace.id}
                projectName={workspace.projectName}
                workspaceName={workspace.name}
                path={extra.path}
                changed={extra.changed}
                prevPath={extra.prevPath}
              />
            ),
          });
        } else if (extra.kind === 'dashboard') {
          panels.push({
            id: `dashboard:${extra.path}`,
            title: `▦ ${name.replace('.dashboard.json', '')}`,
            version: `dashboard|${extra.path}`,
            onClose: closeExtra,
            render: () => (
              <DashboardPanel
                listApps={async () => {
                  const fn = paneBackend?.listWorkspaceArtifacts;
                  if (!fn) return [];
                  const arts = await fn.call(paneBackend, workspace.id);
                  return arts.map((a) => a.path).filter((x) => x.endsWith('.gssh.html'));
                }}
                dashboardPath={extra.path}
                scopeLabel={workspace.name}
                read={(p) => {
                  const fn = paneBackend?.readWorkspaceArtifact;
                  if (!fn) return Promise.reject(new Error('unavailable'));
                  return fn.call(paneBackend, workspace.id, p);
                }}
                write={(p, contentBase64, message) => {
                  const fn = paneBackend?.writeWorkspaceArtifact;
                  if (!fn) return Promise.reject(new Error('unavailable'));
                  return fn.call(paneBackend, workspace.id, p, contentBase64, message);
                }}
              />
            ),
          });
        } else if (extra.kind === 'note') {
          panels.push({
            id: `note:${extra.noteId ?? `new-${extra.nonce ?? 0}`}`,
            title: `✎ ${extra.title.slice(0, 18)}`,
            version: `note|${extra.noteId ?? extra.nonce ?? ''}`,
            onClose: () => setDockExtraPanes((prev) => ({
              ...prev,
              [wsKey]: (prev[wsKey] ?? []).filter((x) => !(x.kind === 'note' && x.noteId === extra.noteId && x.nonce === extra.nonce)),
            })),
            render: () => (
              <NotePanel
                backend={paneBackend}
                projectName={workspace.projectName}
                workspaceName={workspace.name}
                noteId={extra.noteId}
                onCreated={(note) => setDockExtraPanes((prev) => ({
                  ...prev,
                  [wsKey]: (prev[wsKey] ?? []).map((x) =>
                    x.kind === 'note' && x.noteId === null && x.nonce === extra.nonce
                      ? { kind: 'note' as const, noteId: note.id, title: note.body.split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 40) || 'note', nonce: extra.nonce }
                      : x),
                }))}
                onDeleted={closeExtra}
              />
            ),
          });
        } else if (extra.kind === 'goal') {
          const chainGoalsForPane = workspaceGoalForPanels?.chainId
            ? allGoalItems.filter((g) => g.chainId === workspaceGoalForPanels.chainId)
            : (workspaceGoalForPanels ? [workspaceGoalForPanels] : []);
          panels.push({
            id: 'goal',
            title: '◇ Goal',
            version: `goal|${workspaceGoalForPanels?.id ?? ''}|${chainGoalsForPane.length}|${workspaceGoalForPanels?.updatedAt ?? ''}|${(workspaceGoalForPanels?.doc?.exemplarBlockIds ?? []).length}`,
            onClose: closeExtra,
            render: () => (
              chainGoalsForPane.length > 0 && workspaceGoalForPanels
                ? <GoalDocDockPane
                    goals={chainGoalsForPane}
                    initialGoalId={workspaceGoalForPanels.id}
                    onOpenWorkflow={() => openSingletonPane(wsKey, { kind: 'workflow' })}
                    onToggleExemplar={async (goalId, blockId) => {
                      const be = paneBackendKey ? multi.getBackend(paneBackendKey) : null;
                      const g = allGoalItems.find((x) => x.id === goalId);
                      if (!be?.updateGoal || !g?.doc) return;
                      const cur = new Set(g.doc.exemplarBlockIds ?? []);
                      if (cur.has(blockId)) cur.delete(blockId); else cur.add(blockId);
                      await be.updateGoal(g.projectName, getPersistedGoalId(g), { doc: { ...g.doc, exemplarBlockIds: [...cur], updatedAt: new Date().toISOString() } });
                    }}
                  />
                : <div className="flex h-full items-center justify-center text-[12px] text-[var(--gs-text-dim)]">No goal bound to this workspace.</div>
            ),
          });
        } else if (extra.kind === 'guide') {
          panels.push({
            id: 'guide',
            title: '⛓ Change Guide',
            version: `guide|${workspace.id}`,
            onClose: closeExtra,
            render: () => (
              <ChangeGuidePane
                backend={paneBackend}
                projectName={workspace.projectName}
                workspaceName={workspace.name}
                onOpenFile={(path) => openSingletonPane(wsKey, { kind: 'file', path, changed: true })}
                onOpenRubric={() => openSingletonPane(wsKey, { kind: 'rubric' })}
                humanGatePending={workspaceGoalForPanels?.validation
                  ? Object.values(workspaceGoalForPanels.validation.requirements ?? {}).filter((r) =>
                      r.required !== false
                      && r.judgment?.kind === 'human'
                      && r.status !== 'accepted'
                      && !(r.reviews ?? []).some((rv) => (rv as { who?: string }).who === 'human')).length
                  : 0}
              />
            ),
          });
        } else if (extra.kind === 'rubric') {
          panels.push({
            id: 'rubric',
            title: '☰ Review rubric',
            version: `rubric|${workspaceGoalForPanels?.id ?? ''}|${workspaceGoalForPanels?.updatedAt ?? ''}`,
            onClose: closeExtra,
            render: () => (
              <ReviewRubric
                goal={workspaceGoalForPanels?.validation ? { id: workspaceGoalForPanels.id, title: workspaceGoalForPanels.title, validation: workspaceGoalForPanels.validation } : null}
                onRecordHuman={async (requirementId, decision, note, score) => {
                  const be = paneBackendKey ? multi.getBackend(paneBackendKey) : null;
                  const mapped = decision === 'pass' ? 'pass' : decision === 'partial' ? 'changes' : 'fail';
                  await be?.recordGoalHumanReview?.(workspace.projectName, workspaceGoalForPanels!.id, requirementId, mapped, note, score);
                }}
                onRunJudgment={async (requirementId) => {
                  const be = paneBackendKey ? multi.getBackend(paneBackendKey) : null;
                  await be?.runGoalJudgment?.(workspace.projectName, workspaceGoalForPanels!.id, requirementId);
                }}
                onOpenEvidence={(requirementId, evidenceId) => openSingletonPane(wsKey, { kind: 'evidence', requirementId, evidenceId })}
              />
            ),
          });
        } else if (extra.kind === 'workflow') {
          panels.push({
            id: 'workflow',
            title: '⟜ Workflow',
            version: `workflow|${workspace.id}`,
            onClose: closeExtra,
            render: () => (
              <WorkflowPanel
                backend={paneBackend}
                workspaceId={workspace.id}
                onOpenArtifact={(path) => openSingletonPane(wsKey, { kind: 'artifact', path })}
                onOpenRubric={() => openSingletonPane(wsKey, { kind: 'rubric' })}
                onOpenGoal={() => openSingletonPane(wsKey, { kind: 'goal' })}
              />
            ),
          });
        } else if (extra.kind === 'eventlog') {
          panels.push({
            id: 'eventlog',
            title: '⚑ Event logs',
            version: `eventlog|${eventsItems.length}`,
            onClose: closeExtra,
            render: () => (
              <EventLogPane
                events={eventsItems}
                onOpenBrowser={() => {
                  setEventsWorkspacePath(workspace.path);
                  setEventsWorkspaceLabel(workspace.name);
                  setShowEvents(true);
                }}
              />
            ),
          });
        } else if (extra.kind === 'crons') {
          panels.push({
            id: 'crons',
            title: '◷ Crons & triggers',
            version: 'crons',
            onClose: closeExtra,
            render: () => <CronsPanel triggers={[]} live={((workspace as { phase?: string }).phase ?? 'code') === 'ship'} />,
          });
        } else if (extra.kind === 'report') {
          panels.push({
            id: `report:${extra.path}`,
            title: '⚑ Report',
            version: `report|${extra.path}`,
            onClose: closeExtra,
            render: () => (
              <ReportPaneLoader
                path={extra.path}
                read={(p2) => {
                  const fn = paneBackend?.readWorkspaceArtifact;
                  if (!fn) return Promise.reject(new Error('unavailable'));
                  return fn.call(paneBackend, workspace.id, p2);
                }}
                onOpenAttachment={(ref) => openSingletonPane(wsKey, { kind: 'artifact', path: ref })}
              />
            ),
          });
        } else if (extra.kind === 'evidence') {
          const req = workspaceGoalForPanels?.validation?.requirements?.[extra.requirementId];
          const ev = req?.evidence?.find((e) => e.id === extra.evidenceId);
          panels.push({
            id: `evidence:${extra.evidenceId}`,
            title: `▸ ${(ev?.name ?? 'evidence').slice(0, 20)}`,
            version: `evidence|${extra.evidenceId}`,
            onClose: closeExtra,
            render: () => (
              ev ? <EvidencePanel evidence={ev} requirementTitle={req?.title} />
                 : <div className="flex h-full items-center justify-center text-[12px] text-[var(--gs-text-dim)]">Evidence not found.</div>
            ),
          });
        } else {
          panels.push({
            id: `artifact:${extra.path}`,
            title: `◇ ${name}`,
            version: `artifact|${extra.path}`,
            onClose: closeExtra,
            render: () => (
              <ArtifactPanel
                path={extra.path}
                read={(p) => {
                  const fn = paneBackend?.readWorkspaceArtifact;
                  if (!fn) return Promise.reject(new Error('unavailable'));
                  return fn.call(paneBackend, workspace.id, p);
                }}
              />
            ),
          });
        }
      }
      if (panels.length > 0) {
        cachedTerminalPanelsRef.current[workspace.selectionKey ?? workspace.id] = panels;
        terminalMemoryDebugGauge('app.cachedTerminalPanelCount', panels.length);
      }
      return panels;
    };

    const backendKeyFromSelectionKey = (selectionKey: string): BackendKey =>
      JSON.parse(selectionKey)[0] as BackendKey;


    const renderDetailPages = (visibleSelectionKey: string | null) => {
      terminalMemoryDebugIncrement('app.renderDetailPages');
      terminalMemoryDebugGauge('app.detailWorkspaceCacheKeys', detailWorkspaceCacheKeys.length);
      return detailWorkspaceCacheKeys
        .map((selectionKey) => ({ selectionKey, workspace: workspaceBySelectionKey.get(selectionKey) }))
        .filter((entry): entry is { selectionKey: string; workspace: WorkspaceInfo } => Boolean(entry.workspace))
        .map(({ selectionKey, workspace }) => {
          const runtime = workspaceRuntime.runtimeByWorkspace[selectionKey] ?? null;
          const workspaceSessions = runtime?.sessions ?? [];
          const workspaceReplays = filteredReplays.filter((replay) => replay.workspaceId === workspace.id);
          const livePanelsForWorkspace = buildTerminalPanelsForWorkspace(workspace);
          const terminalPanelsForWorkspace = livePanelsForWorkspace.length > 0
            ? livePanelsForWorkspace
            : (cachedTerminalPanelsRef.current[selectionKey] ?? []);
          const workspaceAttachedPanes = Object.values(attachedBackendState?.attachedPanes ?? {})
            .filter((pane) => pane.workspaceId === workspace.id || (!pane.workspaceId && attachedWorkspaceSelectionKey === selectionKey));
          const workspaceAttachedSessionIds = workspaceAttachedPanes.map((pane) => pane.sessionId);
          const workspaceAttachedAgentSessionIds = workspaceAttachedPanes
            .map((pane) => pane.agentSessionId)
            .filter((id): id is string => Boolean(id));
          const isActive = visibleSelectionKey === selectionKey;
          const attachedHere = workspaceAttachedPanes.length > 0 || attachedWorkspaceSelectionKey === selectionKey;
          const workspaceBackendKey = backendKeyFromSelectionKey(selectionKey);
          const workspaceGoal = allGoalItems.find((goal) =>
            goal.backendKey === workspaceBackendKey &&
            goal.projectName === workspace.projectName &&
            goal.workspaceName === workspace.name
          ) ?? null;

          return (
            <div
              key={selectionKey}
              className={isActive ? 'fixed inset-0 z-20' : 'fixed left-[-200vw] top-0 w-screen h-screen invisible pointer-events-none overflow-hidden'}
              aria-hidden={isActive ? undefined : true}
            >
              <WorkspaceDetailPage
                workspace={workspace}
                rightRail={
                  <RightRail
                    backend={multi.getBackend(workspaceBackendKey)}
                    workspaceId={workspace.id}
                    projectName={workspace.projectName}
                    workspaceName={workspace.name}
                    onOpenFile={(file) => {
                      const key = workspace.selectionKey ?? workspace.id;
                      setDockExtraPanes((prev) => {
                        const cur = prev[key] ?? [];
                        const entry = { kind: 'file' as const, ...file };
                        const next = cur.some((x) => x.kind === 'file' && x.path === file.path)
                          ? cur.map((x) => (x.kind === 'file' && x.path === file.path ? entry : x))
                          : [...cur, entry];
                        return { ...prev, [key]: next };
                      });
                    }}
                    onOpenArtifact={(path) => {
                      const key = workspace.selectionKey ?? workspace.id;
                      setDockExtraPanes((prev) => {
                        const cur = prev[key] ?? [];
                        if (cur.some((x) => x.kind === 'artifact' && x.path === path)) return prev;
                        return { ...prev, [key]: [...cur, { kind: 'artifact', path }] };
                      });
                    }}
                    onOpenDashboard={(path) => {
                      const key = workspace.selectionKey ?? workspace.id;
                      setDockExtraPanes((prev) => {
                        const cur = prev[key] ?? [];
                        if (cur.some((x) => x.kind === 'dashboard' && x.path === path)) return prev;
                        return { ...prev, [key]: [...cur, { kind: 'dashboard', path }] };
                      });
                    }}
                    phase={((workspace as { phase?: string }).phase as import('./types/config.js').WorkspacePhase | undefined) ?? 'code'}
                    onOpenEvents={() => {
                      setEventsWorkspacePath(workspace.path);
                      setEventsWorkspaceLabel(workspace.name);
                      openSingletonPane(workspace.selectionKey ?? workspace.id, { kind: 'eventlog' });
                      void multi.requestEvents(getWorkspaceRef(workspace.id, workspaceBackendKey));
                    }}
                    goalEvidence={workspaceGoal?.validation ? Object.values(workspaceGoal.validation.requirements ?? {}).flatMap((r) => (r.evidence ?? []).map((e) => ({ requirementId: r.id, evidenceId: e.id, name: e.name, requirementTitle: r.title }))) : []}
                    onOpenEvidence={(requirementId, evidenceId) => openSingletonPane(workspace.selectionKey ?? workspace.id, { kind: 'evidence', requirementId, evidenceId })}
                    onOpenReport={(path) => openSingletonPane(workspace.selectionKey ?? workspace.id, { kind: 'report', path })}
                    onOpenGoalPane={() => openSingletonPane(workspace.selectionKey ?? workspace.id, { kind: 'goal' })}
                    onOpenRubricPane={() => openSingletonPane(workspace.selectionKey ?? workspace.id, { kind: 'rubric' })}
                    onOpenWorkflowPane={() => openSingletonPane(workspace.selectionKey ?? workspace.id, { kind: 'workflow' })}
                    goalSummary={workspaceGoal ? {
                      chainTitle: workspaceGoal.chainTitle,
                      chainLength: workspaceGoal.chainLength,
                      chainPosition: workspaceGoal.chainPosition,
                      reqCount: workspaceGoal.validation ? Object.keys(workspaceGoal.validation.requirements ?? {}).length : 0,
                    } : undefined}
                    onOpenNote={(noteId, title) => {
                      const key = workspace.selectionKey ?? workspace.id;
                      setDockExtraPanes((prev) => {
                        const cur = prev[key] ?? [];
                        if (noteId !== null && cur.some((x) => x.kind === 'note' && x.noteId === noteId)) return prev;
                        return { ...prev, [key]: [...cur, { kind: 'note', noteId, title, nonce: Date.now() }] };
                      });
                    }}
                  />
                }
                sessions={workspaceSessions}
                replays={workspaceReplays}
                agentSessions={runtime?.agentSessions ?? []}
                agentSessionCount={runtime?.agentSessionCount ?? 0}
                pendingPermissions={runtime?.pendingPermissionCount ?? 0}
                attachedSessionId={workspaceAttachedSessionIds[0] ?? (attachedHere ? backendAttachedSessionId : null)}
                attachedAgentSessionId={workspaceAttachedAgentSessionIds[0] ?? (attachedHere ? (attachedBackendState?.attachedAgentSessionId ?? null) : null)}
                attachedSessionIds={workspaceAttachedSessionIds}
                attachedAgentSessionIds={workspaceAttachedAgentSessionIds}
                pendingAgentAttach={agentAttachPending && pendingAgentAttachTarget?.workspaceId === workspace.id}
                allWorkspaces={allWorkspaceEntries}
                workspaceStatusById={workspaceStatusById}
                runtime={runtime}
                goal={workspaceGoal}
                onOpenGoalDetail={handleSelectPlannedGoal}
                phase={((workspace as { phase?: string }).phase as import('./types/config.js').WorkspacePhase | undefined) ?? 'code'}
                onSwitchStage={(phase) => workspaceBoardState.setPhase(workspace.selectionKey ?? workspace.id, phase)}
                onOpenGoalDoc={() => openSingletonPane(workspace.selectionKey ?? workspace.id, { kind: 'goal' })}
                onOpenChangeGuide={() => openSingletonPane(workspace.selectionKey ?? workspace.id, { kind: 'guide' })}
                onOpenRubric={() => openSingletonPane(workspace.selectionKey ?? workspace.id, { kind: 'rubric' })}
                onOpenWorkflow={() => openSingletonPane(workspace.selectionKey ?? workspace.id, { kind: 'workflow' })}
                onOpenCrons={() => openSingletonPane(workspace.selectionKey ?? workspace.id, { kind: 'crons' })}
                onCreateDashboard={() => {
                  flow.showInput({
                    title: 'New dashboard',
                    message: 'Dashboard name (becomes <name>.dashboard.json on the artifacts branch)',
                    placeholder: 'ops',
                    onSubmit: (name) => {
                      const slug = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
                      if (!slug) return;
                      const be = multi.getBackend(backendKeyFromSelectionKey(workspace.selectionKey ?? workspace.id));
                      const doc = { name: slug, panels: [] };
                      void be?.writeWorkspaceArtifact?.(workspace.id, `${slug}.dashboard.json`, encodeBase64Utf8(JSON.stringify(doc, null, 2)), `dashboard: create ${slug}`)
                        .then(() => {
                          openSingletonPane(workspace.selectionKey ?? workspace.id, { kind: 'dashboard', path: `${slug}.dashboard.json` });
                          toast.success(`Dashboard ${slug} created.`);
                        })
                        .catch((err) => toast.error(err instanceof Error ? err.message : 'Failed to create dashboard.'));
                    },
                  });
                }}
                dashboards={wsDashboards[workspace.selectionKey ?? workspace.id] ?? []}
                onOpenDashboard={(path) => openSingletonPane(workspace.selectionKey ?? workspace.id, { kind: 'dashboard', path })}
                chainGoals={workspaceGoal?.chainId ? allGoalItems.filter((g) => g.chainId === workspaceGoal.chainId) : undefined}
                chainTitle={workspaceGoal?.chainTitle}
                currentChainGoalId={workspaceGoal?.id}
                onSwitchChainWorkspace={handleSelectWorkspaceFromDetail}
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
                      workspaceBoardState.setPhase(selectionKey, phase);
                      flow.close();
                    },
                  });
                }}
                onOpenNotes={() => {
                  const key = workspace.selectionKey ?? workspace.id;
                  setDockExtraPanes((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), { kind: 'note', noteId: null, title: 'New note', nonce: Date.now() }] }));
                }}
                onOpenEvents={(workspaceId) => {
                  setEventsWorkspacePath(workspace.path);
                  setEventsWorkspaceLabel(workspace.name);
                  openSingletonPane(workspace.selectionKey ?? workspace.id, { kind: 'eventlog' });
                  void multi.requestEvents(getWorkspaceRef(workspaceId, workspaceBackendKey));
                }}
                onDeleteSession={handleDeleteSession}
                onDeleteWorkspace={handleDeleteWorkspace}
                onClose={() => {
                  void handleBackToBoard();
                }}
                bottomContent={isActive ? (
                  <WorkspaceRemovalTaskBar
                    tasks={taskBarTasks}
                    selectedTaskId={selectedWorkspaceTaskId}
                    onSelectTask={setSelectedWorkspaceTaskId}
                    onDismiss={handleDismissWorkspaceTask}
                    placement="inline"
                  />
                ) : null}
              >
                {terminalPanelsForWorkspace.length > 0 ? (
                  <DockviewWorkspaceShell
                    key={selectionKey}
                    backendKey={workspaceBackendKey}
                    workspaceId={workspace.id}
                    panels={terminalPanelsForWorkspace}
                    initialLayout={dockviewLayoutsRef.current[selectionKey]}
                    onLayoutChange={(layout) => {
                      dockviewLayoutsRef.current[selectionKey] = layout;
                    }}
                    isActive={isActive}
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-sm text-[var(--gs-text-muted)]">
                    No active session
                  </div>
                )}
              </WorkspaceDetailPage>
            </div>
          );
        });
    };

    // ── Workspace detail page cache (active page + hidden keep-alive pages) ─────
    if (currentDetailWorkspace && !showBoardWhileDetailMounted) {
      return (
        <div className="flex h-screen min-h-0 flex-col">
          {renderChromeBar({ activeKey: currentDetailWorkspace.selectionKey ?? null, onBoard: () => { void handleBackToBoard(); } })}
          <div className="min-h-0 flex-1">
            {renderDetailPages(currentDetailWorkspace.selectionKey ?? null)}
          </div>
          <GlobalTaskbar tasks={taskBarTasks} onDismiss={(id) => workspaceRemovalTasks.dismissTask(id)} />
          {overlays}
        </div>
      );
    }

    // ── Project home (full-screen project view) ────────────────────────────
    if (projectHomeName) {
      const phGoals = allGoalItems.filter((g) => g.projectName === projectHomeName);
      const phWorkspaces = allWorkspaceEntries
        .filter((w) => w.projectName === projectHomeName)
        .map((w) => workspaceRuntime.runtimeByWorkspace[w.selectionKey] ?? workspaceRuntime.runtimeByWorkspace[w.id])
        .filter((e): e is NonNullable<typeof e> => !!e);
      const phBackendKey = phWorkspaces[0]?.workspace.backendKey ?? phGoals[0]?.backendKey ?? getTargetBackendKey();
      return (
        <>
          <ProjectHomePage
            projectName={projectHomeName}
            goals={phGoals}
            workspaces={phWorkspaces}
            backend={phBackendKey ? multi.getBackend(phBackendKey) : null}
            onBack={() => setProjectHomeName(null)}
            onOpenWorkspace={(selectionKey) => {
              setProjectHomeName(null);
              handleBoardSelectWorkspace(selectionKey);
            }}
            onOpenGoal={(goal) => {
              setProjectHomeName(null);
              handleSelectPlannedGoal(goal);
            }}
          />
          <FlowWeb flow={flow} />
          <Toaster theme="dark" position="bottom-right" richColors />
        </>
      );
    }

    // ── Board page (full-screen kanban, no workspace selected) ─────────────
    return (
      <div className="flex h-screen min-h-0 flex-col">
        {renderChromeBar({ boardActive: true })}
        <div className="min-h-0 flex-1 overflow-hidden">
        <BoardPage
          embedded
          groups={boardGroupsWithGoalStatus}
          selectedWorkspaceId={workspaceBoardState.selectedWorkspaceId}
          onSelectWorkspace={handleBoardSelectWorkspace}
          onPhaseChange={workspaceBoardState.setPhase}
          workspaceStatusById={workspaceRuntime.workspaceStatusById}
          worktreeCount={worktreeCount}
          inboxUnreadCount={backendInboxUnreadCount}
          onOpenInbox={() => { void inboxActions.requestInbox(); setShowInbox(true); }}
          onOpenHelp={handleOpenHelp}
          onOpenCreateMenu={handleOpenCreateMenu}
          onOpenProjectHome={() => {
            const names = allProjects.map((project) => project.name);
            if (names.length === 0) return;
            if (names.length === 1) { setProjectHomeName(names[0]); return; }
            flow.showSelect({
              title: 'Project home',
              options: names.map((n) => ({ label: n, value: n })),
              onSelect: (n) => { flow.close(); setProjectHomeName(n); },
            });
          }}
          onOpenCommandPalette={() => commandPalette.toggle()}
          onRefresh={() => { multi.listWorkspaces(); multi.listProjects(); }}
          onDisconnect={() => window.location.reload()}
          deletingWorkspaceIds={deletingWorkspaceTasksByKey}
          creatingWorkspaceIds={creatingWorkspaceTasksById}
          onCreatePlannedGoalWorkspace={handleCreatePlannedGoalWorkspace}
          onSelectPlannedGoal={handleSelectPlannedGoal}
          onSaveChainOrder={handleSaveChainOrder}
          boardMessage={boardGoalOrderMessage}
          loading={boardLoading}
          loadingLabel="Loading worktrees..."
        />
        {renderDetailPages(null)}
        </div>
        <GlobalTaskbar tasks={taskBarTasks} onDismiss={(id) => workspaceRemovalTasks.dismissTask(id)} />
        {overlays}
      </div>
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
        <Toaster theme="dark" position="bottom-right" richColors />
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
      <Toaster theme="dark" position="bottom-right" richColors />
    </>
  );
}

// ─── Outer shell ────────────────────────────────────────────────────────────

function ReportPaneLoader({ path, read, onOpenAttachment }: { path: string; read: (p: string) => Promise<{ base64: string }>; onOpenAttachment?: (ref: string) => void }) {
  const [report, setReport] = useState<unknown>(undefined);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    read(path).then((r) => { if (alive) setReport(JSON.parse(decodeBase64Utf8(r.base64))); }).catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [path, read]);
  if (err) return <div className="flex h-full items-center justify-center text-[12px] text-[var(--gs-danger)]">Failed to load report.</div>;
  if (report === undefined) return <div className="flex h-full items-center justify-center text-[12px] text-[var(--gs-text-dim)]">Loading…</div>;
  return <ReportPanel report={report} onOpenAttachment={onOpenAttachment} />;
}

function GoalDocDockPane({ goals, initialGoalId, onToggleExemplar, onOpenWorkflow }: {
  goals: import("./app/shared/board/types.js").KanbanGoalItem[];
  initialGoalId: string;
  onToggleExemplar?: (goalId: string, blockId: string) => void;
  onOpenWorkflow?: () => void;
}) {
  const [goalId, setGoalId] = useState(initialGoalId);
  return <GoalDocPanel goals={goals} currentGoalId={goalId} onSelectGoal={setGoalId} onToggleExemplar={onToggleExemplar} onOpenWorkflow={onOpenWorkflow} />;
}

export default function App() {
  const [resolvedIdentity, setResolvedIdentity] = useState<Identity | null>(null);
  const relayDescriptor = useMemo<RelayDescriptor | null>(() => {
    if (!resolvedIdentity) return null;
    const explicitRelayUrl = import.meta.env.VITE_RELAY_URL;
    if (explicitRelayUrl) return { url: explicitRelayUrl, source: 'local' };
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return { url: `${wsProtocol}//${location.host}/ws`, source: 'local' };
  }, [resolvedIdentity]);

  return (
    <GitSpaceProvider platform={browserPlatform()} relay={relayDescriptor} identity={resolvedIdentity}>
      <AppInner resolvedIdentity={resolvedIdentity} setResolvedIdentity={setResolvedIdentity} />
    </GitSpaceProvider>
  );
}
