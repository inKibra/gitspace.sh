import type { LifecyclePhase } from '@gitspace/protocol';
import type { LifecycleLedger } from './types.js';

export const LIFECYCLE_PHASES = ['cloud/provision', 'machine/prepare', 'workspace/materialize', 'workspace/dematerialize', 'cloud/destroy'] as const;
export const PHASE_LABEL: Record<LifecyclePhase, string> = {
  'cloud/provision': 'Provision cloud resources',
  'machine/prepare': 'Prepare machine',
  'workspace/materialize': 'Materialize checkout',
  'workspace/dematerialize': 'Dematerialize checkout',
  'cloud/destroy': 'Retire cloud resources',
};
export const PHASE_SCOPE: Record<LifecyclePhase, string> = {
  'cloud/provision': 'Once per durable workspace. Moving machines never provisions again.',
  'machine/prepare': 'Per machine, profile, and approved script content.',
  'workspace/materialize': 'Per fresh checkout generation, after machine preparation.',
  'workspace/dematerialize': 'Before checkpoint and local checkout removal.',
  'cloud/destroy': 'Explicit retirement only. Closing or moving does not destroy resources.',
};

export function latestLifecycleRun(state: LifecycleLedger, phase: LifecyclePhase, scope?: { profile: string; machineId: string; generation?: number | null }): LifecycleLedger['runs'][number] | undefined {
  let latest: LifecycleLedger['runs'][number] | undefined;
  for (const run of state.runs) {
    if (run.phase !== phase) continue;
    if (scope && phase === 'machine/prepare' && (run.machineId !== scope.machineId || run.profile !== scope.profile)) continue;
    if (scope && phase.startsWith('workspace/') && scope.generation != null && run.generation !== scope.generation) continue;
    if (!latest || run.startedAt > latest.startedAt) latest = run;
  }
  return latest;
}

export function lifecycleSummary(state: LifecycleLedger): { label: string; attention: boolean } {
  if (state.destroyedAt) return { label: 'Resources retired', attention: false };
  if (state.runs.some((run) => run.status === 'running')) return { label: 'Environment running', attention: false };
  if (state.claim?.status === 'blocked') return { label: 'Environment needs attention', attention: true };
  for (const phase of LIFECYCLE_PHASES) {
    const latest = latestLifecycleRun(state, phase);
    if (latest?.status === 'failed' || latest?.status === 'abandoned') return { label: 'Environment needs attention', attention: true };
  }
  if (!state.policy.automatic) return { label: 'Environment not initialized', attention: false };
  return { label: 'Environment', attention: false };
}
