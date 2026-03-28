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
  backendKey: string;
  machineLabel: string;
  isRemote: boolean;
}

export interface WorkspaceBoardGroup {
  phase: WorkspacePhase;
  workspaces: KanbanWorkspaceItem[];
}
