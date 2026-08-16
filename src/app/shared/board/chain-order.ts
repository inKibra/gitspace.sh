import { PHASES, type KanbanGoalItem } from './types.js';

function effectivePhaseIndex(goal: Pick<KanbanGoalItem, 'phase' | 'status'>): number {
  const phase = goal.status === 'planned' ? 'plan' : goal.phase;
  return PHASES.indexOf(phase);
}

export function isChainOrderPhaseAllowed(goals: Array<Pick<KanbanGoalItem, 'phase' | 'status'>>): boolean {
  for (let ancestorIndex = 0; ancestorIndex < goals.length; ancestorIndex += 1) {
    const ancestorPhase = effectivePhaseIndex(goals[ancestorIndex]!);
    if (ancestorPhase < 0) continue;
    for (let descendantIndex = ancestorIndex + 1; descendantIndex < goals.length; descendantIndex += 1) {
      const descendantPhase = effectivePhaseIndex(goals[descendantIndex]!);
      if (descendantPhase > ancestorPhase) {
        return false;
      }
    }
  }
  return true;
}

export function canShiftGoalInChainOrder(goals: KanbanGoalItem[], index: number, direction: -1 | 1): boolean {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= goals.length) {
    return false;
  }
  const next = [...goals];
  [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
  return isChainOrderPhaseAllowed(next);
}
