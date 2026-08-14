import { useCallback, useMemo } from 'react';
import type { WorkspacePhase } from '../../types/config.js';
import {
  type MultiMachineState,
  type BackendScopedWorkspaceRef,
  toBackendScopedWorkspaceKey,
} from '../multi/types.js';
import { selectAllGoals, selectAllWorkspaces } from '../multi/selectors.js';
import { PHASES } from '../../app/shared/board/types.js';


export interface UseKanbanViewControllerArgs {
  state: MultiMachineState;
  selectedRef: BackendScopedWorkspaceRef | null;
  onSelectRef: (ref: BackendScopedWorkspaceRef | null) => void;
  onSetWorkspacePhase?: (ref: BackendScopedWorkspaceRef, phase: WorkspacePhase) => void | Promise<void>;
}

export function useKanbanViewController(args: UseKanbanViewControllerArgs) {
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
        goal: workspace.goal,
        backendKey,
        machineLabel: backendState?.label ?? backendKey,
        isRemote: backendKey !== 'local',
      };
    });
  }, [args.state]);

  const plannedGoals = useMemo(() => {
    return selectAllGoals(args.state)
      .filter(({ goal }) => goal.status === 'planned')
      .map(({ backendKey, goal }) => {
        const backendState = args.state.byBackend[backendKey];
        return {
          ...goal,
          selectionKey: `${backendKey}:goal:${goal.id}`,
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

  const groups = useMemo(() => PHASES.map((phase) => ({
    phase,
    workspaces: workspaces.filter((workspace) => workspace.phase === phase),
    plannedGoals: phase === 'plan' ? plannedGoals : [],
  })), [plannedGoals, workspaces]);

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
      // Only `null` deselects. A key that resolves to nothing is a caller bug or
      // a workspace this client cannot see; clearing the selection there turns a
      // failed navigation into an eviction from the workspace you were in — which
      // is how chain clicks appeared to "sometimes" work. Stay put instead.
      if (!workspace) return;
      args.onSelectRef({ backendKey: workspace.backendKey, workspaceId: workspace.id });
    },
    setPhase,
  };
}
