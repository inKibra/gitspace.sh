import type { LifecyclePhase as ProtocolLifecyclePhase } from '@gitspace/protocol';
import type { LifecycleStateCodec } from '@gitspace/protocol/rpc-contract';
import type { InputOf } from 'result-rpc';

export type LifecycleLedger = InputOf<typeof LifecycleStateCodec>;

export type CheckSource = 'catalog' | 'custom';
export type Platform = 'darwin' | 'linux' | 'win32';
export type TrustState =
  | { status: 'approved'; approvedBy: string; approvedAt: string; commandHash: string }
  | { status: 'pending'; commandHash: string }
  | { status: 'changed'; commandHash: string; approvedCommand: string; currentCommand: string; approvedBy: string; approvedAt: string };

export interface EnvironmentCheckDefinition {
  id: string;
  label: string;
  source: CheckSource;
  requirement?: string;
  command?: string;
  probe?: string;
  version?: string;
  fix?: string;
  url?: string;
  platform?: Platform;
  trust?: TrustState;
}

export interface EnvironmentProfileDefinition {
  checks: readonly string[];
  secrets: readonly string[];
  inputs: readonly string[];
  notes: string;
}

export interface EnvironmentInputDefinition {
  default?: string;
  choices?: readonly string[];
  description?: string;
}

export interface EnvironmentBundle {
  profiles: Record<string, EnvironmentProfileDefinition>;
  default: string;
  checks: Record<string, EnvironmentCheckDefinition>;
  inputs: Record<string, EnvironmentInputDefinition>;
}

export type CapabilityResult =
  | { status: 'pass'; output: string }
  | { status: 'fail'; output: string; fix?: string }
  | { status: 'unprobed' };

export interface EnvironmentMachine {
  id: string;
  label: string;
  platform: Platform;
  current: boolean;
  capabilities: Record<string, CapabilityResult>;
}

export type LifecyclePhase = ProtocolLifecyclePhase;
export type LifecycleRun =
  | { status: 'succeeded'; relativeTime: string; duration: string; output?: string }
  | { status: 'failed'; relativeTime: string; duration: string; output: string }
  | { status: 'running'; relativeTime: string; output?: string }
  | { status: 'never' };

export interface LifecycleScript {
  id: string;
  phase: LifecyclePhase;
  path: string;
  command: string;
  profiles?: readonly string[];
  trust: TrustState;
  lastRun: LifecycleRun;
}

export interface EnvironmentSecret {
  name: string;
  source: 'user' | 'project';
  granted: boolean;
  requiredBy: readonly string[];
  unused?: boolean;
}

export interface EnvironmentInputValue {
  name: string;
  value: string;
  source: 'project' | 'workspace';
}

export interface UserSecretView {
  name: string;
  updated: string;
  projects: readonly string[];
  unused?: boolean;
}

export interface ProjectSecretView {
  name: string;
  updated: string;
  project: string;
  requiredBy: readonly string[];
}

export interface ProjectValueView {
  name: string;
  value: string;
  updated: string;
  project: string;
  requiredBy: readonly string[];
}

export interface SecretsPageViewModel {
  projects: readonly string[];
  selectedProject: string;
  userSecrets: readonly UserSecretView[];
  projectSecrets: readonly ProjectSecretView[];
  projectValues: readonly ProjectValueView[];
  missing: readonly EnvironmentSecret[];
}

export interface EnvironmentViewModel {
  project: { name: string; repository: string };
  workspace: { name: string; profile: string; machineId: string; generation?: number | null };
  bundle: EnvironmentBundle;
  machines: readonly EnvironmentMachine[];
  lifecycle: readonly LifecycleScript[];
  ledger?: LifecycleLedger;
  configured?: boolean;
  migrationRequired?: readonly string[];
  secrets: readonly EnvironmentSecret[];
  inputValues: readonly EnvironmentInputValue[];
}

export interface EnvironmentViewProps {
  model: EnvironmentViewModel;
  busy?: boolean;
  runtimeAvailable?: boolean;
  cloudRunnerAvailable?: boolean;
  onConfigure?(): void;
  onRecoverRun?(runId: string): void;
  onOpenRunLog?(runId: string): void;
  onProfileChange(profile: string): void;
  onApprove(targetId: string): void;
  onRevoke(targetId: string): void;
  onGrantSecret(name: string): void;
  onInputChange(name: string, value: string): void;
  onFixCheck?(checkId: string): void;
  onUpdateCheck(checkId: string, patch: Partial<Pick<EnvironmentCheckDefinition, 'label' | 'probe' | 'requirement'>>): void;
  onDeleteCheck(checkId: string): void;
  onAddCheck(check: EnvironmentCheckDefinition): void;
  onAddValue(name: string, defaultValue: string): void;
  onOpenSecrets(): void;
  onOpenLifecycleFile?(scriptId: string): void;
  onOpenLifecycleOutput?(scriptId: string): void;
  onRunChecks(): void;
  onRunLifecycle(phase: LifecyclePhase, options?: { rerun?: boolean; retire?: boolean }): void;
}
