import { useCallback, useMemo } from 'react';
import { useKanbanViewController } from '../../../machine/controllers/useKanbanViewController.js';
import type { BackendScopedWorkspaceRef, MultiMachineState } from '../../../machine/multi/types.js';

export interface UseBoardPageModelArgs {
  state: MultiMachineState;
  selectedRef: BackendScopedWorkspaceRef | null;
  setSelectedRef: (ref: BackendScopedWorkspaceRef | null) => void;
  clearSelectedRef: () => void;
  onSetWorkspacePhase?: (ref: BackendScopedWorkspaceRef, phase: import('../../../types/config.js').WorkspacePhase) => void | Promise<void>;
  resolveRefForWorkspaceId: (workspaceId: string) => BackendScopedWorkspaceRef | null;
  connected?: boolean;
  mode?: 'browsing' | 'attached' | 'idle' | null;
  activeBackendKey?: string | null;
  activeBackendHasSnapshot?: boolean;
}

export function useBoardPageModel(args: UseBoardPageModelArgs) {
  const boardState = useKanbanViewController({
    state: args.state,
    selectedRef: args.selectedRef,
    onSelectRef: args.setSelectedRef,
    onSetWorkspacePhase: args.onSetWorkspacePhase,
  });

  const handleSelectWorkspace = useCallback((workspaceId: string | null) => {
    boardState.setSelectedWorkspaceId(workspaceId);
    if (!workspaceId) {
      args.clearSelectedRef();
      return;
    }
    const ref = args.resolveRefForWorkspaceId(workspaceId);
    if (ref) {
      args.setSelectedRef(ref);
    }
  }, [args, boardState]);

  const worktreeCount = useMemo(
    () => boardState.groups.reduce((count, group) => count + group.workspaces.length, 0),
    [boardState.groups],
  );

  const selectedWorkspaceProjectName = useMemo(() => {
    const selectedWorkspaceId = boardState.selectedWorkspaceId;
    if (!selectedWorkspaceId) return null;
    for (const group of boardState.groups) {
      const workspace = group.workspaces.find((item) => item.id === selectedWorkspaceId);
        if (workspace) return workspace.projectName;
      }
      return null;
    }, [boardState.groups, boardState.selectedWorkspaceId]);

  const loading =
    args.connected === true &&
    args.mode === 'browsing' &&
    args.activeBackendKey != null &&
    args.activeBackendHasSnapshot === false;

  return {
    boardState,
    handleSelectWorkspace,
    worktreeCount,
    loading,
    selectedWorkspaceProjectName,
  };
}
