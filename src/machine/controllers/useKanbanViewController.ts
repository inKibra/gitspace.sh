import { useCallback, useMemo, useState } from 'react';
import type { WorkspacePhase } from '../../types/config.js';
import {
  type MultiMachineState,
  type BackendScopedWorkspaceRef,
  toBackendScopedWorkspaceKey,
} from '../multi/types.js';
import type {
  MachineWorkspaceLinearRecord,
  MachineWorkspacePullRequestRecord,
} from '../../lib/tmux-lite/machine/types.js';
import { selectAllWorkspaces } from '../multi/selectors.js';

export const PHASES: WorkspacePhase[] = ['plan', 'code', 'review', 'ship'];
export const PHASE_LABELS: Record<WorkspacePhase, string> = {
  plan: 'Plan', code: 'Code', review: 'Review', ship: 'Ship',
};

/** A workspace item as projected by useKanbanViewController for rendering. */
export interface KanbanWorkspaceItem {
  id: string;
  selectionKey: string;
  name: string;
  path: string;
  projectName: string;
  branch?: string;
  sessionCount: number;
  /** Number of running or idle (non-archived, non-closed) agent sessions */
  agentCount: number;
  /** Number of agent sessions waiting for user permission (drives orange indicator) */
  pendingPermissionCount: number;
  isStale?: boolean;
  serveDomain?: string;
  processes?: { name: string; instances?: number; ports?: import('../../types/processes.js').ProcessPortConfig[] }[];
  processConfigError?: string;
  phase: WorkspacePhase;
  pullRequest?: MachineWorkspacePullRequestRecord;
  linear?: MachineWorkspaceLinearRecord;
  backendKey: string;
  /** Human-readable label for the machine this workspace lives on (e.g. 'Local', 'My MacBook') */
  machineLabel: string;
  /** True when this workspace is on a remote machine (not the local one) */
  isRemote: boolean;
}

export interface WorkspaceBoardGroup {
  phase: WorkspacePhase;
  workspaces: KanbanWorkspaceItem[];
}

/** Moving-mode state: the user is repositioning a workspace between lanes. */
export interface MovingState {
  workspaceKey: string;
  originPhase: WorkspacePhase;
  targetPhase: WorkspacePhase;
}

export interface UseKanbanViewControllerArgs {
  state: MultiMachineState;
  selectedRef: BackendScopedWorkspaceRef | null;
  onSelectRef: (ref: BackendScopedWorkspaceRef | null) => void;
  onSetWorkspacePhase?: (ref: BackendScopedWorkspaceRef, phase: WorkspacePhase) => void | Promise<void>;
}

export function useKanbanViewController(args: UseKanbanViewControllerArgs) {
  const [moving, setMoving] = useState<MovingState | null>(null);
  const workspaces = useMemo(() => {
    return selectAllWorkspaces(args.state).map(({ backendKey, workspace }) => {
      const backendState = args.state.byBackend[backendKey];
      return {
        id: workspace.id,
        selectionKey: toBackendScopedWorkspaceKey({ backendKey, workspaceId: workspace.id }),
        name: workspace.name,
        path: workspace.path,
        projectName: workspace.projectName,
        branch: workspace.branch,
        sessionCount: workspace.summary.terminalCount,
        agentCount: workspace.summary.agentCount,
        pendingPermissionCount: workspace.summary.permissionAgentCount,
        isStale: workspace.isStale,
        serveDomain: workspace.serveDomain,
        processes: workspace.processes,
        processConfigError: workspace.processConfigError,
        phase: (workspace.phase ?? 'code') as WorkspacePhase,
        pullRequest: workspace.pullRequest,
        linear: workspace.linear,
        backendKey,
        machineLabel: backendState?.label ?? backendKey,
        isRemote: backendKey !== 'local',
      };
    });
  }, [args.state]);

  const setPhase = useCallback((workspaceKey: string, phase: WorkspacePhase) => {
    const workspace = workspaces.find((item) => item.selectionKey === workspaceKey);
    if (!workspace) return;
    return args.onSetWorkspacePhase?.({ backendKey: workspace.backendKey, workspaceId: workspace.id }, phase);
  }, [args, workspaces]);

  const startMoving = useCallback((workspaceKey: string, currentPhase: WorkspacePhase) => {
    setMoving({ workspaceKey, originPhase: currentPhase, targetPhase: currentPhase });
  }, []);

  const shiftMovingTarget = useCallback((delta: -1 | 1) => {
    setMoving((prev) => {
      if (!prev) return prev;
      const currentIndex = PHASES.indexOf(prev.targetPhase);
      const nextIndex = currentIndex + delta;
      if (nextIndex < 0 || nextIndex >= PHASES.length) return prev;
      return { ...prev, targetPhase: PHASES[nextIndex]! };
    });
  }, []);

  const confirmMoving = useCallback(() => {
    if (!moving) return;
    if (moving.targetPhase !== moving.originPhase) {
      void setPhase(moving.workspaceKey, moving.targetPhase);
    }
    setMoving(null);
  }, [moving, setPhase]);

  const cancelMoving = useCallback(() => setMoving(null), []);

  const groups = useMemo(() => PHASES.map((phase) => ({
    phase,
    workspaces: workspaces.filter((workspace) => workspace.phase === phase),
  })), [workspaces]);

  return {
    groups,
    selectedRef: args.selectedRef,
    selectedWorkspaceId: args.selectedRef ? toBackendScopedWorkspaceKey(args.selectedRef) : null,
    setSelectedWorkspaceId: (workspaceKey: string | null) => {
      if (!workspaceKey) {
        args.onSelectRef(null);
        return;
      }
      const workspace = workspaces.find((item) => item.selectionKey === workspaceKey);
      args.onSelectRef(workspace ? { backendKey: workspace.backendKey, workspaceId: workspace.id } : null);
    },
    moving,
    startMoving,
    shiftMovingTarget,
    confirmMoving,
    cancelMoving,
    setPhase,
  };
}
