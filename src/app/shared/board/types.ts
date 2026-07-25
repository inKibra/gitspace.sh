import type { WorkspacePhase } from '../../../types/config.js';
import type {
  MachineWorkspaceLinearRecord,
  MachineWorkspacePullRequestRecord,
} from '../../../lib/tmux-lite/machine/types.js';

export const PHASES: WorkspacePhase[] = ['plan', 'code', 'review', 'ship'];
export const PHASE_LABELS: Record<WorkspacePhase, string> = {
  plan: 'Plan',
  code: 'Code',
  review: 'Review',
  ship: 'Ship',
};

export interface KanbanWorkspaceItem {
  id: string;
  selectionKey: string;
  name: string;
  path: string;
  projectName: string;
  branch?: string;
  sessionCount: number;
  agentCount: number;
  pendingPermissionCount: number;
  isStale?: boolean;
  serveDomain?: string;
  processes?: import('../../../types/processes.js').RuntimeProcessDefinition[];
  processConfigError?: string;
  phase: WorkspacePhase;
  pullRequest?: MachineWorkspacePullRequestRecord;
  linear?: MachineWorkspaceLinearRecord;
  goal?: import('../../../lib/tmux-lite/machine/types.js').MachineGoalRecord;
  backendKey: string;
  machineLabel: string;
  isRemote: boolean;
}

export interface KanbanGoalItem {
  id: string;
  selectionKey: string;
  chainId: string;
  chainTitle: string;
  title: string;
  projectName: string;
  phase: WorkspacePhase;
  plannedWorkspaceName?: string;
  workspaceName?: string;
  status: 'planned' | 'workspace-backed' | 'archived';
  chainPosition: number;
  chainLength: number;
  previousGoalId?: string;
  previousWorkspaceName?: string;
  blockedReason?: string;
  doc?: import('../../../types/goals.js').GoalDoc;
  validation?: import('../../../types/goals.js').GoalValidation;
  sourceRefs?: import('../../../types/goals.js').SourceRef[];
  updatedAt?: string;
  stackStatus?: import('../../../types/goals.js').ChainStackEdgeStatus['status'];
  stackStatusMessage?: string;
  backendKey: string;
  machineLabel: string;
  isRemote: boolean;
}


export interface WorkspaceBoardGroup {
  phase: WorkspacePhase;
  workspaces: KanbanWorkspaceItem[];
  plannedGoals?: KanbanGoalItem[];
}
