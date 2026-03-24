import type { WorkspacePhase } from '../../../types/config.js';

const WORKSPACE_PHASE_OPTIONS: Array<{ label: string; value: WorkspacePhase }> = [
  { label: 'Plan', value: 'plan' },
  { label: 'Code', value: 'code' },
  { label: 'Review', value: 'review' },
  { label: 'Ship', value: 'ship' },
];

interface WorkspaceStatusSelectConfig {
  title: string;
  options: Array<{ label: string; value: WorkspacePhase }>;
  onSelect: (phase: WorkspacePhase) => void;
}

export function showWorkspaceStatusSelect(args: {
  showSelect: (config: WorkspaceStatusSelectConfig) => void;
  onSelectPhase: (phase: WorkspacePhase) => void;
}): void {
  args.showSelect({
    title: 'Set Workspace Status',
    options: WORKSPACE_PHASE_OPTIONS,
    onSelect: args.onSelectPhase,
  });
}
