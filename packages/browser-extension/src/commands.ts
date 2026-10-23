import { browserOriginMatches } from '@gitspace/protocol-environment/browser-origin';

/** Whether a page at `url` is inside the grant: about:blank, or http(s) on one of its origins. */
export function permitted(grant: { origins: string[] }, url: string): boolean {
  try { const parsed = new URL(url); return url === 'about:blank' || (['http:', 'https:'].includes(parsed.protocol) && grant.origins.some(pattern => browserOriginMatches(pattern, parsed.hostname))); } catch { return false; }
}

/** Whether a tab is on the grant's origins: its committed URL, the URL it is navigating to, and the URL its debugger
 * target reports must all be. Chrome reports the target's URL as empty for a moment during a navigation; that reads as
 * not known yet, not as outside, while the tab's own URLs still decide. */
export function tabWithinGrant(grant: { origins: string[] }, urls: { tabUrl?: string; pendingUrl?: string; targetUrl?: string }): boolean {
  if (!urls.tabUrl || !permitted(grant, urls.tabUrl)) return false;
  if (urls.pendingUrl && !permitted(grant, urls.pendingUrl)) return false;
  return !urls.targetUrl || permitted(grant, urls.targetUrl);
}

/** The site a tab shows: the hostname of an http(s) page, else none. */
export function siteOf(url: string | undefined): string | null {
  if (!url) return null;
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.hostname : null; } catch { return null; }
}

/** A Chrome tab group as `chrome.tabGroups.query` reports it. */
export type ChromeTabGroup = { id: number; title?: string; color: string };
/** Who added a tab to a workspace group, and the site it consents to (a tab you dragged in only). */
export type GroupMember = { by: 'agent' | 'page' | 'you'; site: string | null };

/**
 * The Chrome group a workspace's record adopts after Chrome restored it under a new id: the one group with the
 * workspace group's name and colour that no live record of another workspace holds (`bound`). None when there is no
 * such group or more than one; a new group starts then.
 */
export function restoredGroup(groups: ChromeTabGroup[], title: string, color: string, bound: number[]): number | null {
  const [match, ...others] = groups.filter(group => group.title === title && group.color === color && !bound.includes(group.id));
  return match && !others.length ? match.id : null;
}

/** The members of an adopted group. Chrome does not keep which tabs the agent opened, so each counts as one you
 * dragged in: usable on the site it shows, never closed for you. */
export function restoredMembers(tabs: { id?: number; url?: string }[]): Record<number, GroupMember> {
  const members: Record<number, GroupMember> = {};
  for (const tab of tabs) if (tab.id !== undefined) members[tab.id] = { by: 'you', site: siteOf(tab.url) };
  return members;
}

/** The DevTools commands a grant allows on its tab; enforced inside the installed extension. */
export function relayCommandAllowed(grant: { origins: string[] }, targetId: string, session: string, method: string, params: Record<string, unknown>, sessionId?: string): boolean {
  if (sessionId && sessionId !== session) return false;
  if (['Target.attachToTarget', 'Target.getTargetInfo', 'Target.closeTarget'].includes(method)) return params.targetId === targetId;
  if (method === 'Page.navigate') { try { const url = new URL(String(params.url)); return typeof params.url === 'string' && ['http:', 'https:'].includes(url.protocol) && grant.origins.some(pattern => browserOriginMatches(pattern, url.hostname)) && !params.frameId; } catch { return false; } }
  if (method === 'Runtime.evaluate') return typeof params.expression === 'string' && !params.contextId && !params.uniqueContextId;
  return ['Page.enable', 'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.captureScreenshot', 'DOM.enable', 'DOM.describeNode', 'DOM.getBoxModel', 'DOM.focus', 'DOM.scrollIntoViewIfNeeded', 'Accessibility.enable', 'Accessibility.getFullAXTree', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'GitSpace.screenshotPrepare', 'GitSpace.screenshotRestore', 'GitSpace.validateRef'].includes(method);
}

/** One tab a script (`browser.run`) drives on your Chrome. */
export type RelayRunTab = {
  /** The grant as it applies to this tab (a tab you dragged in also allows the site it showed then). */
  grant: { origins: string[] };
  targetId: string;
  /** The tab's lease session; a command naming another session is refused. */
  session: string;
  sessionId?: string;
  /** Who put the tab in the workspace group: only tabs the agent added may be closed. */
  addedBy: string;
};
/** What the extension does with one script command: send it (with these parameters), answer `{}` without effect, or refuse it. */
export type RelayRunVerdict = { send: Record<string, unknown> } | { noop: true } | { refused: string };

const CREDENTIALS = 'reaches the cookies, storage or credentials of your Chrome';
/** Whole domains a script uses on its tab. */
const RUN_DOMAINS: Record<string, true> = { Page: true, Runtime: true, DOM: true, DOMSnapshot: true, CSS: true, Overlay: true, Input: true, Accessibility: true, Log: true };
/** Single commands a script uses outside those domains. */
const RUN_METHODS: Record<string, true> = {
  'Network.enable': true, 'Network.disable': true, 'Network.getResponseBody': true, 'Network.getRequestPostData': true, 'Network.setCacheDisabled': true, 'Network.setBypassServiceWorker': true,
  'Emulation.setFocusEmulationEnabled': true,
};
/** Answered `{}` without effect: a script never resizes, restyles, raises or re-identifies the tab you see, and never downloads to your disk. */
const RUN_NOOPS: Record<string, true> = {
  'Emulation.setDeviceMetricsOverride': true, 'Emulation.clearDeviceMetricsOverride': true, 'Emulation.setUserAgentOverride': true, 'Emulation.setEmulatedMedia': true, 'Emulation.setTouchEmulationEnabled': true, 'Emulation.setScrollbarsHidden': true,
  'Page.setFontFamilies': true, 'Page.setFontSizes': true, 'Page.setDownloadBehavior': true, 'Page.bringToFront': true, 'Browser.setWindowBounds': true,
  // Child sessions (workers, out-of-process frames) are not supported; the tab's own session is.
  'Target.setAutoAttach': true,
};
/** Domains refused whole, and why. */
const REFUSED_DOMAINS: Record<string, string> = { Storage: CREDENTIALS, Fetch: CREDENTIALS, Security: CREDENTIALS, ServiceWorker: CREDENTIALS, IndexedDB: CREDENTIALS, CacheStorage: CREDENTIALS, DOMStorage: CREDENTIALS, Browser: 'controls your whole Chrome, not one tab' };
/** Commands refused inside otherwise allowed domains, and why. */
const REFUSED_METHODS: Record<string, string> = {
  'Network.getCookies': CREDENTIALS, 'Network.getAllCookies': CREDENTIALS, 'Network.setCookie': CREDENTIALS, 'Network.setCookies': CREDENTIALS, 'Network.deleteCookies': CREDENTIALS, 'Network.clearBrowserCookies': CREDENTIALS,
  'Network.setExtraHTTPHeaders': CREDENTIALS, 'Network.setRequestInterception': CREDENTIALS, 'Network.replayXHR': CREDENTIALS, 'Network.loadNetworkResource': CREDENTIALS,
  'Page.getCookies': CREDENTIALS, 'Page.deleteCookie': CREDENTIALS,
  'Page.setSPCTransactionMode': 'would confirm payments in your Chrome', 'Page.setRPHRegistrationMode': 'would register protocol handlers in your Chrome',
  'DOM.setFileInputFiles': 'would upload files from your computer; pass file contents (buffers) instead', 'DOM.getFileInfo': 'reveals paths on your computer',
  'Page.crash': 'would crash your tab', 'Page.navigateToHistoryEntry': 'could reach sites outside the workspace origins; use page.goto', 'Page.resetNavigationHistory': 'would erase your tab history',
  'Page.addScriptToEvaluateOnLoad': 'would run on sites outside the workspace origins; use page.evaluate',
  'Target.createBrowserContext': 'is refused: your Chrome has one context, the workspace group',
};

/** A destination a script may load: about:blank, or an http(s) page on the grant's origins. */
function destinationAllowed(grant: { origins: string[] }, value: unknown): boolean {
  if (value === 'about:blank') return true;
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && grant.origins.some(pattern => browserOriginMatches(pattern, url.hostname)); } catch { return false; }
}

/**
 * The run allowlist (docs/APERTURE-DESIGN.md §6.1): what a script may do on one tab of its workspace group on your
 * Chrome. Enforced inside the installed extension; anything not listed is refused.
 */
export function relayRunCommand(method: string, params: Record<string, unknown>, tab: RelayRunTab): RelayRunVerdict {
  if (tab.sessionId !== undefined && tab.sessionId !== tab.session) return { refused: `${method} names a session outside this tab` };
  if (RUN_NOOPS[method]) return { noop: true };
  const refusal = REFUSED_METHODS[method] ?? REFUSED_DOMAINS[method.split('.')[0] ?? ''];
  if (refusal) return { refused: `${method} ${refusal}` };
  if (method === 'Target.attachToTarget' || method === 'Target.getTargetInfo') return params.targetId === undefined || params.targetId === tab.targetId ? { send: params } : { refused: `${method} names another tab` };
  if (method === 'Target.closeTarget' || method === 'Page.close') {
    if (method === 'Target.closeTarget' && params.targetId !== tab.targetId) return { refused: `${method} names another tab` };
    return tab.addedBy === 'agent' ? { send: params } : { refused: 'Only tabs the agent opened can be closed; this tab is yours' };
  }
  if (method === 'Page.navigate') return destinationAllowed(tab.grant, params.url) ? { send: params } : { refused: `${String(params.url)} is outside the workspace origins` };
  if (method === 'Page.reload' && params.scriptToEvaluateOnLoad !== undefined) return { refused: 'Page.reload scripts would run on sites outside the workspace origins; use page.evaluate' };
  // An init script runs in every later document of the tab, including one outside the workspace origins before the
  // extension sees it leave them. Playwright's own utility world (empty source) is all a script gets.
  if (method === 'Page.addScriptToEvaluateOnNewDocument') return params.source === '' ? { send: params } : { refused: 'Init scripts would run on sites outside the workspace origins; use page.evaluate after each navigation' };
  // Universal access would let the world reach other origins' frames.
  if (method === 'Page.createIsolatedWorld') return { send: { ...params, grantUniveralAccess: false } };
  if (RUN_METHODS[method] || RUN_DOMAINS[method.split('.')[0] ?? '']) return { send: params };
  return { refused: `${method} is not available to scripts on your Chrome` };
}

/** Headers never forwarded from your Chrome. */
const SECRET_HEADERS: Record<string, true> = { cookie: true, 'set-cookie': true, authorization: true, 'proxy-authorization': true };
function withoutSecretHeaders(headers: unknown): unknown {
  if (Array.isArray(headers)) return headers.filter(entry => !(typeof entry === 'object' && entry !== null && 'name' in entry && typeof entry.name === 'string' && SECRET_HEADERS[entry.name.toLowerCase()]));
  if (typeof headers !== 'object' || headers === null) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !SECRET_HEADERS[name.toLowerCase()]));
}
function scrubbed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubbed);
  if (typeof value !== 'object' || value === null) return value;
  return scrubbedRecord(value);
}
function scrubbedRecord(value: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // Raw header text carries the cookies the header maps drop.
    if (key === 'headersText' || key === 'requestHeadersText') continue;
    // The extra-info events are not forwarded; a client waiting for them would wait forever.
    if (key === 'hasExtraInfo' || key === 'redirectHasExtraInfo') result[key] = false;
    else if (key === 'headers' || key === 'requestHeaders') result[key] = withoutSecretHeaders(item);
    else result[key] = scrubbed(item);
  }
  return result;
}

/**
 * The parameters a script receives for one event of its tab, or `null` when the event stays in your Chrome: raw
 * network extra info (cookies, credentials) is dropped and network headers lose cookies and credentials.
 */
export function relayRunEvent(method: string, params: Record<string, unknown>): Record<string, unknown> | null {
  if (method.endsWith('ExtraInfo')) return null;
  return method.startsWith('Network.') ? scrubbedRecord(params) : params;
}
