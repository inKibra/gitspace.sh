import { PHASES, type WorkspaceBoardGroup } from './types.js';
import type { WorkspacePhase } from '../../../types/config.js';

export function getShiftArrowPhaseChange(args: {
  groups: WorkspaceBoardGroup[];
  selectedWorkspaceId: string | null;
  direction: -1 | 1;
}): { workspaceKey: string; phase: WorkspacePhase } | null {
  if (!args.selectedWorkspaceId) {
    return null;
  }

  const selectedWorkspace = args.groups
    .flatMap((group) => group.workspaces)
    .find((workspace) => workspace.selectionKey === args.selectedWorkspaceId);
  if (!selectedWorkspace) {
    return null;
  }

  const currentPhaseIndex = PHASES.indexOf(selectedWorkspace.phase);
  if (currentPhaseIndex < 0) {
    return null;
  }

  const nextPhase = PHASES[currentPhaseIndex + args.direction];
  if (!nextPhase || nextPhase === selectedWorkspace.phase) {
    return null;
  }

  return {
    workspaceKey: selectedWorkspace.selectionKey,
    phase: nextPhase,
  };
}
