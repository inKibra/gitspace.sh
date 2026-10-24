import type { RuntimeProjectBrowserPreferences, RuntimeProjectBrowserSettings } from '@gitspace/protocol-runtime';

/** A project's current approvals as preferences take them. */
export function projectApprovals(settings: RuntimeProjectBrowserSettings): RuntimeProjectBrowserPreferences['approvals'] {
  return settings.browsers.filter(browser => browser.approved).map(({ pairingId, note }) => ({ pairingId, note }));
}

/** Approves one Chrome for a project, keeping its note. The first Chrome approved in a project with no default
 * becomes the default, so agents there can use it without naming it. */
export function approveChrome(settings: RuntimeProjectBrowserSettings, pairingId: string): RuntimeProjectBrowserPreferences {
  const note = settings.browsers.find(browser => browser.pairingId === pairingId)?.note ?? '';
  return { defaultPairingId: settings.defaultPairingId ?? pairingId, approvals: [...projectApprovals(settings).filter(item => item.pairingId !== pairingId), { pairingId, note }] };
}
