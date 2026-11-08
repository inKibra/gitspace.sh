import type { BrowserSiteLevel, LifecycleRunPhase } from '@gitspace/protocol-environment';

export const STEP_LABEL: Record<LifecycleRunPhase, string> = {
  'machine/prepare': 'Prepare machine',
  'workspace/materialize': 'Prepare checkout',
  checks: 'Checks',
  'cloud/provision': 'Provision cloud resources',
  'workspace/dematerialize': 'Remove checkout',
  'cloud/destroy': 'Retire cloud resources',
};

/** What each browser site level lets agents do on your Chrome. */
export const BROWSER_SITE_LEVEL_LABEL: Record<BrowserSiteLevel, string> = { read: 'Read: open, observe, screenshot', interact: 'Interact: single steps, no scripts', full: 'Full: scripts and single steps' };

/** Setup steps every workspace shows, in order; the other phases appear only when the repository has scripts for them. */
export const SETUP_STEPS = ['machine/prepare', 'workspace/materialize', 'checks'] as const satisfies readonly LifecycleRunPhase[];
export const OPTIONAL_STEPS = ['cloud/provision', 'workspace/dematerialize', 'cloud/destroy'] as const satisfies readonly LifecycleRunPhase[];
