import { useCallback, useMemo } from 'react';
import { useKanbanViewController } from '../../../machine/controllers/useKanbanViewController.js';
import type { BackendScopedWorkspaceRef, MultiMachineState } from '../../../machine/multi/types.js';

export interface UseBoardPageModelArgs {
  state: MultiMachineState;
  selectedRef: BackendScopedWorkspaceRef | null;
  setSelectedRef: (ref: BackendScopedWorkspaceRef | null) => void;
  clearSelectedRef: () => void;
  onSetWorkspacePhase?: (ref: BackendScopedWorkspaceRef, phase: import('../../../types/config.js').WorkspacePhase) => void | Promise<void>;
  connected?: boolean;
  mode?: 'browsing' | 'attached' | 'idle' | null;
  activeBackendKey?: string | null;
  activeBackendHasSnapshot?: boolean;
  /** Snapshot load failure (e.g. initial snapshot timed out) — see BackendSessionState.snapshotError. */
  activeBackendSnapshotError?: string | null;
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
  }, [boardState]);

  const worktreeCount = useMemo(
    () => boardState.groups.reduce((count, group) => count + group.workspaces.length, 0),
    [boardState.groups],
  );

  const selectedWorkspaceProjectName = useMemo(() => {
    const selectedWorkspaceId = boardState.selectedWorkspaceId;
    if (!selectedWorkspaceId) return null;
    for (const group of boardState.groups) {
      const workspace = group.workspaces.find((item) => item.selectionKey === selectedWorkspaceId);
      if (workspace) return workspace.projectName;
    }
    return null;
  }, [boardState.groups, boardState.selectedWorkspaceId]);

  const loading =
    args.connected === true &&
    args.mode === 'browsing' &&
    args.activeBackendKey != null &&
    args.activeBackendHasSnapshot === false;

  // While the board would otherwise spin, surface a snapshot load failure so
  // the UI can render a real error state (reason + retry) instead of an
  // infinite "Loading worktrees..." spinner.
  const loadError = loading ? (args.activeBackendSnapshotError ?? null) : null;

  return {
    boardState,
    handleSelectWorkspace,
    worktreeCount,
    loading,
    loadError,
    selectedWorkspaceProjectName,
  };
}
