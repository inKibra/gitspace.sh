import type { GoalRecordView, RubricView, WorkflowView } from '@gitspace/protocol';

export interface WorkspaceInstructions {
  goal: GoalRecordView | null;
  workflow: WorkflowView | null;
  rubric: RubricView | null;
}

export const INSTRUCTION_NOTICE = 'Workspace instructions changed; the next turn will use the latest Goal, Workflow, and Rubric.';
export const INSTRUCTION_CONTEXT_TYPE = 'gitspace-workspace-instructions';

/** Reads authority only at provider boundaries; notification never queues or starts a turn. */
export class WorkspaceInstructionContext {
  private signature: string | undefined;
  private noticePending = false;

  constructor(
    private readonly load: () => Promise<WorkspaceInstructions>,
    private readonly notice: () => void,
  ) {}

  changed(): void {
    if (this.noticePending) return;
    this.noticePending = true;
    this.notice();
  }

  async nextTurn(): Promise<WorkspaceInstructions> {
    const snapshot = await this.load();
    const signature = JSON.stringify([snapshot.goal?.revision ?? null, snapshot.workflow?.revision ?? null, snapshot.rubric?.revision ?? null]);
    if (this.signature !== undefined && signature !== this.signature && !this.noticePending) this.notice();
    this.signature = signature;
    this.noticePending = false;
    return snapshot;
  }
}

export function workspaceInstructionText(snapshot: WorkspaceInstructions): string {
  return `Current canonical workspace instructions. These replace prior Goal, Workflow, and Rubric instructions. Follow the latest requirements and gates; do not infer acceptance or waive human gates.\n${JSON.stringify(snapshot)}`;
}
