import { browserPowers, type BrowserPower, type RuntimeProjectBrowserPreferences, type RuntimeProjectBrowserSettings } from '@gitspace/protocol-runtime';

/** A project's current approvals as preferences take them, each with its powers. */
export function projectApprovals(settings: RuntimeProjectBrowserSettings): RuntimeProjectBrowserPreferences['approvals'] {
  return settings.browsers.filter(browser => browser.approved).map(({ pairingId, powers }) => ({ pairingId, powers }));
}

/** Approves one Chrome for a project. The first Chrome approved in a project with no default becomes the default, so
 * agents there can use it without naming it. A new approval gives no powers; an existing one keeps its own. */
export function approveChrome(settings: RuntimeProjectBrowserSettings, pairingId: string): RuntimeProjectBrowserPreferences {
  const approvals = projectApprovals(settings);
  return { defaultPairingId: settings.defaultPairingId ?? pairingId, approvals: approvals.some(item => item.pairingId === pairingId) ? approvals : [...approvals, { pairingId, powers: [] }] };
}

/** Turns one power on or off on a project's approval of one Chrome; every other approval stays as it is. */
export function withPower(settings: RuntimeProjectBrowserSettings, pairingId: string, power: BrowserPower, on: boolean): RuntimeProjectBrowserPreferences {
  return {
    defaultPairingId: settings.defaultPairingId,
    approvals: projectApprovals(settings).map(item => item.pairingId === pairingId ? { pairingId, powers: browserPowers(on ? [...item.powers, power] : item.powers.filter(other => other !== power)) } : item),
  };
}
