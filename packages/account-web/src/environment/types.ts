import type { ReactNode } from 'react';
import type { LifecycleRunPhase } from '@gitspace/protocol-environment';
import type { WorkspaceStatusColor } from '@gitspace/protocol-workspace';
import type { MachineStatus } from '../workspace-status.js';

/** The result of one script or check on the machine the Setup section shows. */
export type ScriptRun =
  | { status: 'succeeded' | 'failed'; runId: string; detail: string }
  | { status: 'running' | 'interrupted' | 'not-started'; runId: string }
  | { status: 'never' };

export interface EnvironmentScript {
  /** Execution id: the check id, or `<phase>:<fileName>` for a script. */
  id: string;
  label: string;
  /** Prompts for input, so it runs only in a terminal on the machine. */
  interactive: boolean;
  approval: { approved: true; by: string; at: string } | { approved: false };
  lastRun: ScriptRun;
}

export interface EnvironmentStep {
  phase: LifecycleRunPhase;
  label: string;
  scripts: readonly EnvironmentScript[];
}

/** One attached machine as the gitspace.status document reports it; nothing here is derived in the browser. */
export interface EnvironmentMachine {
  id: string;
  name: string;
  /** `Linux · online`, `Linux · starting`, `Offline` or `Paused`. */
  status: string;
  color: WorkspaceStatusColor;
  online: boolean;
  ready: boolean;
  setup: MachineStatus['setup'];
  sync: MachineStatus['sync'];
  /** `terminalName` is set while an interactive run is running in that terminal. */
  runs: readonly { id: string; phase: LifecycleRunPhase; status: string; startedAt: string; active: boolean; terminalName: string | null }[];
}

export interface EnvironmentViewModel {
  project: string;
  workspace: string;
  profile: { selected: string; options: readonly string[] };
  /** The repository has an environment bundle or lifecycle scripts. */
  configured: boolean;
  notes: string;
  bindings: Readonly<Record<string, string>>;
  machines: readonly EnvironmentMachine[];
  attachable: readonly { id: string; label: string }[];
  /** The machine whose results the Setup section shows and whose runs it starts. */
  setupMachineId: string | null;
  steps: readonly EnvironmentStep[];
  browserOrigins: readonly { hash: string; pattern: string; approved: boolean }[];
  /** The routes `.gitspace/services.json` opens to signed callers: approved like a script, never run. */
  signedCallers: readonly { id: string; label: string; approved: boolean }[];
  /** Conflicted paths in the cloud working copy. */
  conflicts: readonly string[];
  secrets: readonly { name: string; source: 'account' | 'project'; granted: boolean }[];
  values: readonly { name: string; source: 'workspace' | 'project' | 'account' | 'default'; value: string }[];
}

export interface EnvironmentViewProps {
  model: EnvironmentViewModel;
  busy?: boolean;
  /** Rendered at the end of the Machines section: browser groups and held-back LFS changes. */
  machinesFooter?: ReactNode;
  onProfileChange(profile: string): void;
  onConfigure?(): void;
  onAttach(machineId: string): void;
  onDetach(machineId: string): void;
  onOpenTerminal?(machineId: string): void;
  /** Shows the terminal an interactive run is running in. */
  onOpenRunTerminal?(machineId: string, terminalName: string): void;
  onSelectSetupMachine(machineId: string): void;
  onRunPhase(machineId: string, phase: LifecycleRunPhase, options?: { rerun?: boolean; interactive?: boolean; retire?: boolean }): void;
  onApprove(targetId: string): void;
  onRevoke(targetId: string): void;
  onOpenScript(scriptId: string): void;
  onOpenLog(runId: string, script: { id: string; label: string }): void;
  onCancelRun(runId: string): void;
  onSyncNow(machineId: string): void;
  onShowUnsent(machineId: string): void;
  onResolveConflict(path: string, keep: 'cloud' | 'machine'): void;
  onOpenSecrets(): void;
  onEditValue(name: string, value: string): void;
  onOpenAgentSetup?(): void;
}
