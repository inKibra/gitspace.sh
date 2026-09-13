import type { LifecyclePhase } from '@gitspace/protocol-environment';

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

