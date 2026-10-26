/**
 * Browser powers and Everything on your Chrome (docs/SIMPLIFICATION.md Batch 16 items 5–6; `browser-powers.ts` in
 * protocol-runtime). A group grant carries the powers its project turned on for this Chrome (`powers`) and Everything
 * while you allow it (`everything`, its expiry signed in); the extension holds agents to them here.
 *
 * Debug and storage steps: the single-step allowlist admits a debug or storage step's own DevTools commands only while
 * its grant has that power or Everything is on (`stepReach`), and each must be exactly what the workspace's step sends
 * (`powerStepCommand`): a trace through the Tracing domain read back through `IO`, a site's cookies through the
 * Network domain by the site's URL, or its page storage through one page script on a tab showing that site. A storage
 * step's site is one of the grant's unless Everything is on.
 *
 * Everything (`ChromeEverything`): the main agent's for one hour from when you allow it, in the popup, on the in-page
 * toolbar or in GitSpace. While it lasts the allowlists drop to a short denylist of hard limits (`everythingRefusal`):
 * only tabs of the workspace group, pages only about:blank or http(s), never another tab or session, another browser
 * context, Chrome itself, extensions or service workers, files on your computer, the extension's own screencast, or
 * site data named by a URL or origin that is not http(s) (Chrome's pages, extensions and this one's storage, your
 * disk). End now ends it in this Chrome at once, kept across restarts, so a grant still carrying that expiry counts as
 * without Everything.
 */
import type { RuntimeBrowserArguments } from '@gitspace/protocol-runtime';
import { BROWSER_TRACE_READ_BYTES, browserCookieRead, browserCookieUrl, browserEverythingActive, browserStorageExpression, browserTraceStart } from '@gitspace/protocol-runtime/browser-power-rules';
import { browserOriginMatches } from '@gitspace/protocol-environment/browser-origin';

/** A group grant as powers read it: its sites, its powers and Everything (`RuntimeAccountBrowserGrant`). */
export type PowersGrant = { groupId: string; origins: string[]; powers?: readonly string[]; everything?: { expiresAt: string } };

/** What a single step reaches beyond the commands every step sends (`relayCommandAllowed`): any http(s) page while
 * Everything is on, and the DevTools methods of its debug or storage power. `readOnly`: a debug step only records the
 * page, so a tab on a site at read takes its commands. */
export type StepReach = { everything: boolean; methods: Record<string, true>; readOnly: boolean };

/** The sites a grant reaches while Everything is on: every http(s) site (`browserOriginMatches('*', …)`), at full. */
export const EVERYTHING_ORIGINS = ['*'];

/** A debug step's commands: a trace, read back as a stream. */
const DEBUG_METHODS: Record<string, true> = { 'Tracing.start': true, 'Tracing.end': true, 'IO.read': true, 'IO.close': true };
/** A cookie step's commands. A page storage step sends `Runtime.evaluate`, which every step may. */
const COOKIE_METHODS: Record<string, true> = { 'Network.getCookies': true, 'Network.setCookie': true, 'Network.deleteCookies': true };
const NO_METHODS: Record<string, true> = {};

/** Whether a grant gives `power`: it carries it, or Everything is on (`ChromeEverything.on`). */
function hasPower(grant: PowersGrant, power: 'debug' | 'storage', everything: boolean): boolean {
  return everything || (grant.powers ?? []).includes(power);
}

/** What a single step reaches (`StepReach`): the methods of its debug or storage power while the grant has it. */
export function stepReach(args: RuntimeBrowserArguments, grant: PowersGrant, everything: boolean): StepReach {
  if (args.action === 'debug' && hasPower(grant, 'debug', everything)) return { everything, methods: DEBUG_METHODS, readOnly: true };
  if (args.action === 'storage' && args.kind === 'cookies' && hasPower(grant, 'storage', everything)) return { everything, methods: COOKIE_METHODS, readOnly: false };
  return { everything, methods: NO_METHODS, readOnly: false };
}

/** JSON with keys in order and undefined left out, so parameters compare whatever order they were built in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
const same = (params: Record<string, unknown>, expected: object) => canonical(params) === canonical(expected);

/** The hostname of an http(s) page, else none. */
function hostOf(url: string | undefined): string | null {
  const parsed = url ? URL.parse(url) : null;
  return parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.hostname : null;
}

/** What a debug or storage step has done so far on its authorization: the commands it sent once (`used`, as
 * `constrainCommand` keeps them) and the trace stream Chrome reported (`Tracing.tracingComplete`). */
export type PowerStepUse = { used: Set<string>; stream?: string };
/** A power step command's verdict: whether it is exactly the step's, and whether the step sends it once. */
export type PowerStepVerdict = { accepted: boolean; once: boolean };
const REFUSED: PowerStepVerdict = { accepted: false, once: false };

/**
 * Whether a debug or storage step sends `method` with `params` exactly as the workspace sends it, or null for a method
 * that is not its power's. Debug: `Tracing.start` (`browserTraceStart`), `Tracing.end`, then `IO.read` of the stream
 * Chrome reported, repeatedly, and `IO.close`; never a heap snapshot. Storage on a site of the grant (any site under
 * Everything): its cookies read (`browserCookieRead`), set by the site's URL, or read and deleted one by one (only
 * the one named, when the step names one); its localStorage, sessionStorage or IndexedDB through one page script
 * (`browserStorageExpression`) while the tab (`urls`: its URL, the one it is going to and its target's) shows the site.
 */
export function powerStepCommand(args: RuntimeBrowserArguments, grant: PowersGrant, everything: boolean, urls: (string | undefined)[], use: PowerStepUse, method: string, params: Record<string, unknown>): PowerStepVerdict | null {
  if (args.action === 'debug') {
    if (!DEBUG_METHODS[method]) return null;
    if (!hasPower(grant, 'debug', everything) || args.kind === 'heap') return REFUSED;
    if (method === 'Tracing.start') return { accepted: same(params, browserTraceStart(args.kind)), once: true };
    if (method === 'Tracing.end') return { accepted: use.used.has('Tracing.start') && same(params, {}), once: true };
    if (use.stream === undefined) return REFUSED;
    if (method === 'IO.read') return { accepted: same(params, { handle: use.stream, size: BROWSER_TRACE_READ_BYTES }), once: false };
    return { accepted: same(params, { handle: use.stream }), once: true };
  }
  if (args.action !== 'storage' || (!COOKIE_METHODS[method] && method !== 'Runtime.evaluate')) return null;
  const site = args.site;
  if (!hasPower(grant, 'storage', everything) || !(everything || grant.origins.some(pattern => browserOriginMatches(pattern, site)))) return REFUSED;
  if (args.kind !== 'cookies') {
    const [tabUrl, ...others] = urls;
    const showing = hostOf(tabUrl) === site && others.every(url => !url || hostOf(url) === site);
    return method === 'Runtime.evaluate' && showing ? { accepted: same(params, { expression: browserStorageExpression(args), returnByValue: true, awaitPromise: true }), once: true } : REFUSED;
  }
  if (method === 'Network.getCookies') return { accepted: args.op !== 'set' && same(params, browserCookieRead(site)), once: true };
  if (method === 'Network.setCookie') return { accepted: args.op === 'set' && typeof args.name === 'string' && typeof args.value === 'string' && same(params, { name: args.name, value: args.value, url: browserCookieUrl(site) }), once: true };
  if (method === 'Network.deleteCookies') return { accepted: args.op === 'clear' && use.used.has('Network.getCookies') && typeof params.name === 'string' && (args.name === undefined || params.name === args.name) && same(params, { name: params.name, url: browserCookieUrl(site) }), once: false };
  return REFUSED;
}

/** Domains whose commands reach cookies, storage or other site data by URL or origin. */
const SITE_DATA: Record<string, true> = { Storage: true, Network: true, Fetch: true, IndexedDB: true, CacheStorage: true, DOMStorage: true };
const SITE_DATA_METHODS: Record<string, true> = { 'Page.getCookies': true, 'Page.deleteCookie': true };
/** The Target commands a script sends for its own tab; the run allowlist checks the tab each names. */
const OWN_TARGET: Record<string, true> = { 'Target.attachToTarget': true, 'Target.getTargetInfo': true, 'Target.closeTarget': true };
const PAINTING = 'is the extension’s: its screencast keeps a background tab painting; use page.screenshot';
const YOUR_FILES = 'reads files on your computer; pass file contents (buffers) instead';
/** Commands Everything never allows, and why. */
const HARD_LIMITS: Record<string, string> = {
  'Target.createBrowserContext': 'is refused: your Chrome has one context, the workspace group',
  'Page.navigateToHistoryEntry': 'could reach pages Everything never opens; use page.goto',
  'DOM.setFileInputFiles': YOUR_FILES, 'DOM.getFileInfo': 'reveals paths on your computer',
  'Page.startScreencast': PAINTING, 'Page.stopScreencast': PAINTING, 'Page.screencastFrameAck': PAINTING,
};
/** Domains Everything never allows, and why. */
const HARD_DOMAINS: Record<string, string> = {
  Browser: 'controls your whole Chrome, not one tab',
  Extensions: 'reaches your extensions',
  ServiceWorker: 'reaches the service workers of your extensions, this one’s too',
};

/** Every string in a command's parameters, however deep. */
function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (typeof value === 'object' && value !== null) for (const item of Object.values(value)) yield* strings(item);
}
/** The first URL, origin or storage key in `params` whose scheme is not http(s), anywhere in a string (a storage key
 * or cache id carries its origin inside it), else none. */
function foreignUrl(params: Record<string, unknown>): string | null {
  for (const text of strings(params)) for (const match of text.matchAll(/([a-z][a-z0-9+.-]*):\/\//giu)) {
    const scheme = match[1]?.toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return text.slice(0, 200);
  }
  return null;
}

/** Why a script's command is refused while Everything is on, or none: the hard limits, which always hold. A command
 * naming another tab or session, or loading a page that is not about:blank or http(s), the run allowlist refuses. */
export function everythingRefusal(method: string, params: Record<string, unknown>, targetId: string): string | null {
  const domain = method.split('.')[0] ?? '';
  const refusal = HARD_LIMITS[method] ?? HARD_DOMAINS[domain];
  if (refusal) return refusal;
  if (domain === 'Target' && !OWN_TARGET[method]) return 'reaches tabs outside the workspace group';
  if (typeof params.targetId === 'string' && params.targetId !== targetId) return 'names another tab';
  if (method === 'Input.dispatchDragEvent' && typeof params.data === 'object' && params.data !== null && 'files' in params.data) return YOUR_FILES;
  if (SITE_DATA[domain] || SITE_DATA_METHODS[method]) {
    const named = foreignUrl(params);
    if (named) return `names ${named}: Everything reaches the cookies and storage of http(s) sites only`;
  }
  return null;
}

/** What Everything needs of the extension. */
export type EverythingHost = {
  /** The extension's own state (IndexedDB), read and written by key. */
  stored(key: string): Promise<unknown>;
  persist(key: string, value: unknown): Promise<unknown>;
  /** Sends the relay a request (`BrowserEverythingRequest` under `everything`); nothing while disconnected. */
  send(message: { everything: { groupId: string; action: 'grant' | 'end' } }): void;
  /** Everything began or ended on a group as this Chrome shows it: its title, its tabs' toolbars and the tabs the
   * agent uses there follow. */
  changed(groupId: string): void;
  /** Chrome's alarm at the next expiry, which wakes the worker (`chrome.alarms.create` with `when`); null clears it. */
  alarm(when: number | null): Promise<unknown>;
};

/** Where Everything is kept: each group's shown expiry, and the expiries ended in this Chrome. */
const STATE_KEY = 'everything';
/** How long allowing Everything waits for the relay's answer. */
const ASK_MS = 10_000;

/** Everything on each workspace group in this Chrome: what it shows (from the relay's notices and the newest grant)
 * and what agents may do (`on`, from the signed grant, without the expiries you ended here). */
export class ChromeEverything {
  /** Each group's Everything as the title, the popup and the in-page toolbar show it: its expiry. */
  private readonly shown = new Map<string, string>();
  /** The expiries ended in this Chrome (End now), in ms, by group: a grant carrying one counts as without Everything. */
  private readonly ended = new Map<string, Set<number>>();
  /** What waits for the relay's answer to Everything you allowed, by group (`ask`). */
  private readonly asked = new Map<string, (() => void)[]>();
  /** Clears the timer at the next expiry. */
  private cancel = () => {};
  /** Settles once the kept state is read: every enforcement waits for it (`authorize`), so an expiry ended before
   * the worker stopped never counts as on. */
  readonly restored: Promise<void>;

  constructor(private readonly host: EverythingHost) {
    this.restored = host.stored(STATE_KEY).then(saved => this.load(saved));
    // Waited on where it matters; a failure there refuses the authorization.
    this.restored.catch(() => {});
  }

  /** Whether Everything is on in a signed grant at `now`: its expiry has not passed and you did not end it here. */
  on(grant: { groupId: string; everything?: { expiresAt: string } }, now: number): boolean {
    const everything = grant.everything;
    return everything !== undefined && browserEverythingActive({ everything }, now) && !this.ended.get(grant.groupId)?.has(Date.parse(everything.expiresAt));
  }

  /** The expiry of Everything a group shows at `now`, or none. */
  until(groupId: string, now: number): string | null {
    const expiresAt = this.shown.get(groupId);
    return expiresAt !== undefined && Date.parse(expiresAt) > now ? expiresAt : null;
  }

  /** The relay's `everything` notice: Everything began on a group, or ended (`expiresAt` null). */
  async notice(message: { groupId?: unknown; expiresAt?: unknown }): Promise<void> {
    const { groupId, expiresAt } = message;
    if (typeof groupId !== 'string' || !(expiresAt === null || (typeof expiresAt === 'string' && Number.isFinite(Date.parse(expiresAt))))) return;
    await this.restored;
    await this.show(groupId, expiresAt);
    for (const answered of this.asked.get(groupId) ?? []) answered();
    this.asked.delete(groupId);
  }

  /** A grant the extension accepted: the newest says Everything is on, until its expiry. */
  async granted(grant: PowersGrant): Promise<void> {
    await this.restored;
    if (grant.everything && this.on(grant, Date.now())) await this.show(grant.groupId, grant.everything.expiresAt);
  }

  /** You allow Everything on a group: settles when the relay's notice for it arrives (also when the relay refuses),
   * or after `ASK_MS` without one. */
  ask(groupId: string): Promise<void> {
    const answered = Promise.withResolvers<void>();
    const timer = setTimeout(answered.resolve, ASK_MS);
    this.asked.set(groupId, [...this.asked.get(groupId) ?? [], () => { clearTimeout(timer); answered.resolve(); }]);
    this.host.send({ everything: { groupId, action: 'grant' } });
    return answered.promise;
  }

  /** You end Everything on a group now: kept at once, so no grant carrying its expiry counts from here on, then the
   * relay hears it. */
  async end(groupId: string): Promise<void> {
    await this.restored;
    const expiresAt = this.shown.get(groupId);
    if (expiresAt !== undefined) this.ended.set(groupId, (this.ended.get(groupId) ?? new Set()).add(Date.parse(expiresAt)));
    this.shown.delete(groupId);
    await this.save();
    this.host.send({ everything: { groupId, action: 'end' } });
    this.schedule();
    this.host.changed(groupId);
  }

  /** The next expiry came (its timer, or Chrome's alarm after the worker slept): each group past it shows none. */
  async expire(): Promise<void> {
    await this.restored;
    const gone = this.prune(Date.now());
    if (gone.length) await this.save();
    this.schedule();
    for (const groupId of gone) this.host.changed(groupId);
  }

  private async show(groupId: string, expiresAt: string | null): Promise<void> {
    const at = expiresAt === null ? Number.NaN : Date.parse(expiresAt);
    const next = expiresAt !== null && at > Date.now() && !this.ended.get(groupId)?.has(at) ? expiresAt : null;
    if ((this.shown.get(groupId) ?? null) === next) return;
    if (next === null) this.shown.delete(groupId); else this.shown.set(groupId, next);
    await this.save();
    this.schedule();
    this.host.changed(groupId);
  }

  /** Drops what expired by `now`; answers the groups whose Everything that ended. */
  private prune(now: number): string[] {
    const gone: string[] = [];
    for (const [groupId, expiresAt] of this.shown) if (Date.parse(expiresAt) <= now) { this.shown.delete(groupId); gone.push(groupId); }
    for (const [groupId, expiries] of this.ended) {
      for (const at of expiries) if (at <= now) expiries.delete(at);
      if (!expiries.size) this.ended.delete(groupId);
    }
    return gone;
  }

  private load(saved: unknown): void {
    const shown: unknown = typeof saved === 'object' && saved !== null && 'shown' in saved ? saved.shown : null;
    const ended: unknown = typeof saved === 'object' && saved !== null && 'ended' in saved ? saved.ended : null;
    if (typeof shown === 'object' && shown !== null) for (const [groupId, expiresAt] of Object.entries(shown)) if (typeof expiresAt === 'string' && Number.isFinite(Date.parse(expiresAt))) this.shown.set(groupId, expiresAt);
    if (Array.isArray(ended)) for (const entry of ended) if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') this.ended.set(entry[0], (this.ended.get(entry[0]) ?? new Set()).add(entry[1]));
    const groups = [...this.shown.keys()];
    this.prune(Date.now());
    this.schedule();
    // Titles and toolbars follow what was kept: marked while it lasts, unmarked where it expired while the worker slept.
    for (const groupId of groups) this.host.changed(groupId);
  }

  private save(): Promise<unknown> {
    return this.host.persist(STATE_KEY, { shown: Object.fromEntries(this.shown), ended: [...this.ended].flatMap(([groupId, expiries]) => [...expiries].map(at => [groupId, at])) });
  }

  /** An exact deadline at the next expiry: a timer while the worker runs, and Chrome's alarm, which wakes it. */
  private schedule(): void {
    this.cancel();
    this.cancel = () => {};
    const next = Math.min(...[...this.shown.values()].map(expiresAt => Date.parse(expiresAt)));
    if (Number.isFinite(next)) { const timer = setTimeout(() => { void this.expire().catch(() => {}); }, Math.max(0, next - Date.now())); this.cancel = () => clearTimeout(timer); }
    void this.host.alarm(Number.isFinite(next) ? next : null).catch(() => {});
  }
}
