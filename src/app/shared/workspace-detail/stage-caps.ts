/**
 * Stage-as-mode capabilities (mock: data/mock.ts STAGE_CAPS) — what each
 * kanban phase unlocks. Rendered as the sidebar modecaps strip and the stage
 * switcher's per-stage notes.
 */
import type { WorkspacePhase } from '../../../types/config.js';

export interface StageCaps {
  note: string;
  unlocks: string[];
}

export const STAGE_CAPS: Record<WorkspacePhase, StageCaps> = {
  plan: { note: 'spec only · repo read-only', unlocks: ['Goal / rubric / workflow authoring'] },
  code: { note: 'the only mode that edits the repo', unlocks: ['Repo editable ✎', 'Workflows enabled ⟜', 'Agent edits + runs'] },
  review: { note: 'review the change', unlocks: ['Diffs in file browser', 'Change Guide + rubric'] },
  ship: { note: 'post-merge ops', unlocks: ['Crons & triggers live ◷', 'Roll up to project'] },
};

export const STAGE_ORDER: WorkspacePhase[] = ['plan', 'code', 'review', 'ship'];

/** CSS var for a stage's color (defined per-theme in web/index.css). */
export function stageColorVar(phase: WorkspacePhase): string {
  return `var(--gs-stage-${phase})`;
}
