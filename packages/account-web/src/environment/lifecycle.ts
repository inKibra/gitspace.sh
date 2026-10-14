import type { LifecycleRunPhase } from '@gitspace/protocol-environment';

export const STEP_LABEL: Record<LifecycleRunPhase, string> = {
  'machine/prepare': 'Prepare machine',
  'workspace/materialize': 'Prepare checkout',
  checks: 'Checks',
  'cloud/provision': 'Provision cloud resources',
  'workspace/dematerialize': 'Remove checkout',
  'cloud/destroy': 'Retire cloud resources',
};

/** Setup steps every workspace shows, in order; the other phases appear only when the repository has scripts for them. */
export const SETUP_STEPS = ['machine/prepare', 'workspace/materialize', 'checks'] as const satisfies readonly LifecycleRunPhase[];
export const OPTIONAL_STEPS = ['cloud/provision', 'workspace/dematerialize', 'cloud/destroy'] as const satisfies readonly LifecycleRunPhase[];
