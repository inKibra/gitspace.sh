import { z } from 'zod';
import { browserOriginMatches } from '@gitspace/protocol-environment';
import { BROWSER_POWERS } from './browser-power-rules.js';

export * from './browser-power-rules.js';

/**
 * Browser powers (docs/SIMPLIFICATION.md Batch 16 items 5–6). A project gives agents powers on one of your Chromes
 * beyond its approved sites: you turn each on per project and Chrome (Plugins → Browsers → Manage Chrome, or the
 * Chrome's card in a workspace's Browser tab). They are stored on the project's approval of that Chrome and signed into each
 * group grant (`powers`). Everything (`everything`) is the main agent's for one hour at a time, granted from the popup
 * or GitSpace, its expiry signed into the grant: while it lasts the extension's allowlist drops to a short denylist.
 * The relay sends a grant with either only to an extension whose hello says `powers` (from 5.11). Hard limits always
 * hold: nothing outside the workspace group, never other extensions or Chrome's own pages, never the extension's
 * storage or keys. The cloud browser is the workspace's own profile: debug and storage work there without approval.
 */

export const BrowserPowerSchema = z.enum(BROWSER_POWERS);
export type BrowserPower = z.infer<typeof BrowserPowerSchema>;
/** Each power as its toggle names it. */
export const BROWSER_POWER_LABELS: Record<BrowserPower, string> = { record: 'Record video', debug: 'Debug (profiles, traces, heap snapshots)', storage: 'Cookies and storage for approved sites' };

/** A set of powers as an approval stores it and a grant carries it: each once, in `BROWSER_POWERS` order. */
export const BrowserPowersSchema = z.array(BrowserPowerSchema).max(BROWSER_POWERS.length)
  .refine(powers => powers.every((power, index) => index === 0 || BROWSER_POWERS.indexOf(powers[index - 1] ?? power) < BROWSER_POWERS.indexOf(power)), 'Browser powers are listed once each, in order');
/** `list` as `BrowserPowersSchema` takes it. */
export function browserPowers(list: Iterable<BrowserPower>): BrowserPower[] {
  const chosen = new Set(list);
  return BROWSER_POWERS.filter(power => chosen.has(power));
}

export const BrowserEverythingSchema = z.strictObject({ expiresAt: z.iso.datetime() });
export type BrowserEverything = z.infer<typeof BrowserEverythingSchema>;

/** What a group grant on your Chrome carries for powers: `powers` omitted when the approval has none and `everything`
 * omitted when it is not on, so an extension before 5.11 gets the grant shape it verifies. */
export const browserPowerGrantShape = { powers: BrowserPowersSchema.min(1).optional(), everything: BrowserEverythingSchema.optional() };

/** Why an agent's call on your Chrome needs a power the project has not turned on for it, and how to turn it on. */
export function browserPowerRefusal(power: BrowserPower, chrome: string): string {
  return `${power === 'storage' ? 'Cookies and storage are' : power === 'debug' ? 'Debugging is' : 'Recording video is'} not turned on for Chrome "${chrome}" in this project. Ask the user to turn on "${BROWSER_POWER_LABELS[power]}" for that Chrome in Plugins → Browsers → Manage Chrome, or on that Chrome's card in this workspace's Browser tab, then call again. On the cloud browser (source:"headless") it needs no approval.`;
}
/** Why a grant with powers or Everything is not sent to an extension before 5.11: it could not keep them to their limits. */
export const BROWSER_POWERS_UPDATE = 'Update the GitSpace extension in this Chrome to 5.11 or later: this version cannot keep browser powers and Everything to their limits.';

// Debug: `web_browser {action:'debug', kind, durationMs?}` on a tab of the workspace group.

export const BROWSER_DEBUG_KINDS = ['profile', 'trace', 'heap'] as const;
export type BrowserDebugKind = (typeof BROWSER_DEBUG_KINDS)[number];
/** How long a profile or trace records, by default and at most. A heap snapshot takes no duration. */
export const BROWSER_DEBUG_DURATION_MS = { default: 5000, min: 500, max: 30_000 } as const;
/** How long a debug step's authority lasts: its recording, then the file streaming to the drive. */
export const BROWSER_DEBUG_STEP_MS = BROWSER_DEBUG_DURATION_MS.max + 150_000;
/** Where debug files live in the workspace's drive: `browser/debug/<debugId>.<extension>`. */
export const BROWSER_DEBUG_PREFIX = 'browser/debug/';
export const BROWSER_DEBUG_FILES: Record<BrowserDebugKind, { extension: string; mediaType: string }> = {
  profile: { extension: 'cpuprofile', mediaType: 'application/json' },
  trace: { extension: 'json', mediaType: 'application/json' },
  heap: { extension: 'heapsnapshot', mediaType: 'application/json' },
};
/** Chrome closes the HeapProfiler domain to extensions (only fully trusted DevTools clients get it). */
export const BROWSER_HEAP_ON_CHROME = 'Chrome does not let extensions take heap snapshots (its HeapProfiler is closed to them). Take one on the cloud browser (source:"headless"), or record kind:"profile" or kind:"trace" here.';
/** A task on the page's main thread this long or longer is a long task. */
export const BROWSER_LONG_TASK_MS = 50;

const label = z.string().max(512);
/** The short summary the agent reads beside the file: the top functions by self time (a profile), long tasks (a
 * trace), or heap size by constructor (a heap snapshot), each at most ten rows. */
export const RuntimeBrowserDebugSummarySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('profile'), durationMs: z.number().nonnegative(), samples: z.number().int().nonnegative(), functions: z.array(z.strictObject({ name: label, url: z.string().max(2048), line: z.number().int(), selfMs: z.number().nonnegative(), selfPercent: z.number().nonnegative() })).max(10) }),
  z.strictObject({ kind: z.literal('trace'), durationMs: z.number().nonnegative(), events: z.number().int().nonnegative(), longTasks: z.strictObject({ count: z.number().int().nonnegative(), totalMs: z.number().nonnegative(), longest: z.array(z.strictObject({ startMs: z.number().nonnegative(), durationMs: z.number().nonnegative() })).max(10) }) }),
  z.strictObject({ kind: z.literal('heap'), totalBytes: z.number().int().nonnegative(), nodes: z.number().int().nonnegative(), constructors: z.array(z.strictObject({ name: label, count: z.number().int().nonnegative(), selfBytes: z.number().int().nonnegative() })).max(10) }),
]);
export type RuntimeBrowserDebugSummary = z.infer<typeof RuntimeBrowserDebugSummarySchema>;
/** A debug step's answer: the file in the drive (`drive://workspace/browser/debug/…`) and its summary. */
export const RuntimeBrowserDebugResultSchema = z.strictObject({ debugId: z.string().uuid(), file: z.string().max(512), bytes: z.number().int().nonnegative(), summary: RuntimeBrowserDebugSummarySchema });
export type RuntimeBrowserDebugResult = z.infer<typeof RuntimeBrowserDebugResultSchema>;

// Storage: `web_browser {action:'storage', op, kind, site}` on a tab of the workspace group.

export const BROWSER_STORAGE_OPS = ['get', 'set', 'clear'] as const;
export const BROWSER_STORAGE_KINDS = ['cookies', 'localStorage', 'sessionStorage', 'indexedDB'] as const;
export type BrowserStorageKind = (typeof BROWSER_STORAGE_KINDS)[number];
/** A site whose storage a call reads or changes: one exact hostname. */
export const BrowserStorageSiteSchema = z.string().min(1).max(253).refine(host => browserOriginMatches(host, host), 'Name one lowercase hostname, no scheme, path or port');
/** Why a storage call names a site outside the workspace's approved sites. */
export function browserStorageSiteRefusal(site: string): string {
  return `${site} is not an approved site of this workspace: storage calls reach approved sites only.`;
}

// Everything between the relay and the extension.

/** The relay tells an extension whose hello says `powers` that Everything began or ended on one of its workspace
 * groups (`expiresAt` null: ended), for the group title, the popup and the in-page toolbar. The signed grant alone
 * decides what agents may do. */
export const BrowserEverythingNoticeSchema = z.strictObject({ operation: z.literal('everything'), groupId: z.string().uuid(), expiresAt: z.iso.datetime().nullable() });
export type BrowserEverythingNotice = z.infer<typeof BrowserEverythingNoticeSchema>;
/** You allow Everything on a workspace group, or end it, from the extension's popup or in-page toolbar; the relay
 * answers with a notice. */
export const BrowserEverythingRequestSchema = z.strictObject({ groupId: z.string().uuid(), action: z.enum(['grant', 'end']) });
export type BrowserEverythingRequest = z.infer<typeof BrowserEverythingRequestSchema>;
