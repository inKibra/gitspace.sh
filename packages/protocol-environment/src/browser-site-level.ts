/** What an approved browser site lets agents do on your Chrome: `read` only looks (open, observe, screenshot), `interact`
 * also takes single steps that change the page (click, type, press) but no scripts, `full` also runs scripts. The cloud
 * browser has no levels. Imports nothing, so the browser extension bundles it alone. */
export const BROWSER_SITE_LEVELS = ['read', 'interact', 'full'] as const;
export type BrowserSiteLevel = (typeof BROWSER_SITE_LEVELS)[number];

/**
 * Whether each browser action only reads a site, and so is allowed on a `read` site: opening and navigating to it
 * (navigation within the read site included), listing tabs, observing (the accessibility snapshot, its text and refs),
 * screenshots, closing a tab the agent opened, and recording a profile or trace (`debug`). `act` (click, fill, press),
 * `evaluate` (page JavaScript), `run` (scripts) and `storage` (cookies and page storage) can change the page, submit or
 * reach credentials, so a `read` site refuses them.
 */
export const READ_SITE_ACTIONS: Record<'open' | 'tabs' | 'navigate' | 'observe' | 'act' | 'evaluate' | 'screenshot' | 'close' | 'run' | 'debug' | 'storage', boolean> = {
  open: true, tabs: true, navigate: true, observe: true, screenshot: true, close: true, debug: true,
  act: false, evaluate: false, run: false, storage: false,
};

/** Why an agent may not change a page on `site`, which is approved `read`: the message agents see. */
export function readSiteRefusal(site: string): string {
  return `${site} is read-only for agents in this workspace: you may open, observe and screenshot it, not click or type`;
}
