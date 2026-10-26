import { z } from 'zod';
import { BrowserOriginPatternSchema, BrowserSiteLevelSchema, browserOriginMatches } from '@gitspace/protocol-environment';
import { RuntimeDispatchSelectionSchema } from './scheduling.js';
import { RuntimeBrowserCaptureSchema } from './browser-capture-tracks.js';
import { RuntimeBrowserCommentStatusSchema, RuntimeBrowserCommentTextSchema, RuntimeBrowserCommentWriteSchema } from './browser-comments.js';
import { BROWSER_DEBUG_DURATION_MS, BROWSER_DEBUG_KINDS, BROWSER_STORAGE_KINDS, BROWSER_STORAGE_OPS, BrowserEverythingSchema, BrowserPowersSchema, BrowserStorageSiteSchema, browserPowerGrantShape } from './browser-powers.js';

const id = z.string().min(1).max(256);
const source = z.enum(['relay', 'headless']).default('headless');
/** `on` puts a headless step on that machine's headless browser instead of the cloud browser. */
const selection = { source, on: RuntimeDispatchSelectionSchema.shape.on.describe('Only for a port with no service URL; prefer the cloud browser.'), pairingId: z.string().uuid().optional() };
const tab = { ...selection, targetId: id };
export const RuntimeBrowserArgumentsSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('open'), ...selection, targetId: id.optional(), url: z.string().max(8192).optional() }),
  z.strictObject({ action: z.literal('tabs'), ...selection }),
  z.strictObject({ action: z.literal('navigate'), ...tab, url: z.string().max(8192) }),
  z.strictObject({ action: z.literal('observe'), ...tab, screenshot: z.boolean().default(false), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(1000).default(400) }),
  z.strictObject({ action: z.literal('act'), ...tab, ref: id, operation: z.enum(['click', 'fill', 'press']), value: z.string().max(16384).optional() }),
  z.strictObject({ action: z.literal('evaluate'), ...tab, expression: z.string().min(1).max(32768) }),
  z.strictObject({ action: z.literal('screenshot'), ...tab }),
  z.strictObject({ action: z.literal('close'), ...tab }),
  /** A Playwright script, the body of an async function of `{ page, context, browser, state, view, act, capture, upload }` (docs/APERTURE-DESIGN.md §6.1).
   * On your Chrome `sites` names the granted sites (exact patterns) the script may use; omitted, every granted site
   * that allows scripts. The cloud browser ignores it. */
  z.strictObject({ action: z.literal('run'), ...selection, script: z.string().min(1).max(65_536), sites: z.array(BrowserOriginPatternSchema).max(32).optional() }),
  // Browser powers (`browser-powers.ts`): on your Chrome each needs its power in the grant, or Everything; the cloud
  // browser needs no approval. Neither runs on a machine's headless browser.
  /** `debug`: a CPU profile, a performance trace or a heap snapshot of the tab, saved to the drive with a summary. */
  z.strictObject({ action: z.literal('debug'), ...tab, kind: z.enum(BROWSER_DEBUG_KINDS), durationMs: z.number().int().min(BROWSER_DEBUG_DURATION_MS.min).max(BROWSER_DEBUG_DURATION_MS.max).optional() }),
  /** `storage`: reads (`get`), sets or clears one approved site's cookies, localStorage, sessionStorage or IndexedDB,
   * through a tab of the workspace group (on `site`, except for cookies). `name`: the cookie, the storage key, or the
   * IndexedDB database; `store` and `key`: the IndexedDB object store and record key; `value`: what `set` writes. */
  z.strictObject({ action: z.literal('storage'), ...tab, op: z.enum(BROWSER_STORAGE_OPS), kind: z.enum(BROWSER_STORAGE_KINDS), site: BrowserStorageSiteSchema, name: z.string().min(1).max(4096).optional(), store: z.string().min(1).max(1024).optional(), key: z.string().max(4096).optional(), value: z.string().max(16_384).optional() }),
]);
export type RuntimeBrowserArguments = z.infer<typeof RuntimeBrowserArgumentsSchema>;
/** `chromes` touches no browser: it lists the project's Chromes (names, pairing ids, online, approved, default) for the
 * agent to choose from. */
export const RuntimeBrowserChromesArgumentsSchema = z.strictObject({ action: z.literal('chromes') });
// Comments for the agent (docs/APERTURE-DESIGN.md §9, `browser-comments.ts`). None touches a browser.
/** `comments`: the workspace's comment threads (`gitspace.page-comments`), newest first; `open` (the default) leaves
 * resolved ones out. Subagents read them too. */
export const RuntimeBrowserCommentsArgumentsSchema = z.strictObject({ action: z.literal('comments'), status: RuntimeBrowserCommentStatusSchema.default('open'), limit: z.number().int().min(1).max(100).default(20) });
/** `commentReply` (main agent only): a reply in a thread, shown as the agent on the page and to the thread's viewers. */
export const RuntimeBrowserCommentReplyArgumentsSchema = z.strictObject({ action: z.literal('commentReply'), threadId: z.string().uuid(), text: RuntimeBrowserCommentTextSchema });
/** `commentResolve` (main agent only): resolves a thread, or with `reopen` reopens it. */
export const RuntimeBrowserCommentResolveArgumentsSchema = z.strictObject({ action: z.literal('commentResolve'), threadId: z.string().uuid(), reopen: z.boolean().optional() });
// Captures for the agent (docs/APERTURE-DESIGN.md §11, `browser-capture-agent.ts`).
/** `captures` touches no browser: the workspace's captures, newest first. */
export const RuntimeBrowserCapturesArgumentsSchema = z.strictObject({ action: z.literal('captures'), limit: z.number().int().min(1).max(100).default(20) });
/** `capture` touches no browser: one capture as a mention of it reads (`captureSummary`). */
export const RuntimeBrowserCaptureArgumentsSchema = z.strictObject({ action: z.literal('capture'), capture: z.string().uuid() });
/** `replay` runs a capture's steps as a `run` script (`captureReplayScript`) where `run` would: `args` holds the value
 * of each parameter the capture's steps need (its secrets, its upload files). */
export const RuntimeBrowserReplayArgumentsSchema = z.strictObject({ action: z.literal('replay'), ...selection, capture: z.string().uuid(), sites: z.array(BrowserOriginPatternSchema).max(32).optional(), args: z.record(z.string().min(1).max(64), z.string().max(16_384)).optional() });
/** `captureSaved` (main agent only) records the repository skill made from a capture, `path` its folder
 * (`.gitspace/skills/<slug>`), at the working copy's commit holding its `SKILL.md`. */
export const RuntimeBrowserCaptureSavedArgumentsSchema = z.strictObject({ action: z.literal('captureSaved'), capture: z.string().uuid(), path: z.string().min(1).max(1024) });
/** The browser tool as agents call it: every browser action, plus `chromes`, `comments` and the capture actions. */
export const RuntimeBrowserToolArgumentsSchema = z.discriminatedUnion('action', [...RuntimeBrowserArgumentsSchema.options, RuntimeBrowserChromesArgumentsSchema, RuntimeBrowserCommentsArgumentsSchema, RuntimeBrowserCommentReplyArgumentsSchema, RuntimeBrowserCommentResolveArgumentsSchema,
  RuntimeBrowserCapturesArgumentsSchema, RuntimeBrowserCaptureArgumentsSchema, RuntimeBrowserReplayArgumentsSchema, RuntimeBrowserCaptureSavedArgumentsSchema]);
export type RuntimeBrowserToolArguments = z.infer<typeof RuntimeBrowserToolArgumentsSchema>;
const executionScope = { projectId: id, workspaceId: id, machineId: id, attachmentId: id, generation: z.number().int().nonnegative() };
export const RuntimeBrowserGrantSchema = z.strictObject({ ...executionScope, groupId: z.string().uuid(), groupName: id, source: z.enum(['relay', 'headless']), origins: z.array(BrowserOriginPatternSchema), expiresAt: z.iso.datetime() });
export type RuntimeBrowserGrant = z.infer<typeof RuntimeBrowserGrantSchema>;
export const RuntimeBrowserPreparationSchema = RuntimeBrowserGrantSchema.extend({ id, action: z.enum(['open', 'tabs', 'navigate', 'observe', 'act', 'evaluate', 'screenshot', 'close', 'run', 'debug', 'storage']) });
export type RuntimeBrowserPreparation = z.infer<typeof RuntimeBrowserPreparationSchema>;
export const RuntimeAccountBrowserPlacementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cloud'), accountId: id }),
  z.strictObject({ kind: z.literal('account-relay'), accountId: id, pairingId: z.string().uuid(), generation: z.number().int().nonnegative(), approvalId: z.string().uuid().optional() }),
]);
export type RuntimeAccountBrowserPlacement = z.infer<typeof RuntimeAccountBrowserPlacementSchema>;
/** A group grant: each of `origins` at its site level (`browser-site-level.ts` in protocol-environment). `stepsOnly`:
 * the patterns at `interact` (single steps, no scripts); `read`: those at `read` (looking only, no scripts), omitted
 * when there are none, so an extension before 5.9, which verifies `stepsOnly` and knows no `read`, gets the grant shape
 * it knows; any other pattern is at `full`. Both are empty for the cloud browser, which has no levels. The relay sends
 * a grant with `read` only to an extension whose hello says `siteLevels`. `powers` and `everything`
 * (`browser-powers.ts`) are omitted when none is on; the relay sends a grant with either only to an extension whose
 * hello says `powers`. */
export const RuntimeAccountBrowserGrantSchema = RuntimeBrowserGrantSchema.omit({ machineId: true, attachmentId: true, generation: true }).extend({ placement: RuntimeAccountBrowserPlacementSchema, stepsOnly: z.array(BrowserOriginPatternSchema), read: z.array(BrowserOriginPatternSchema).min(1).optional(), ...browserPowerGrantShape });
export type RuntimeAccountBrowserGrant = z.infer<typeof RuntimeAccountBrowserGrantSchema>;
/** A group grant as the relay, the browser session and the workspace store it: rows stored before site levels have no
 * `stepsOnly`, because none of their sites was at `interact`. */
export const RuntimeAccountBrowserGroupRowSchema = RuntimeAccountBrowserGrantSchema.extend({ stepsOnly: RuntimeAccountBrowserGrantSchema.shape.stepsOnly.default([]) });
export const RuntimeAccountBrowserPreparationSchema = RuntimeAccountBrowserGrantSchema.extend({ id, action: RuntimeBrowserPreparationSchema.shape.action });
export const RuntimeBrowserApprovalCardSchema = z.union([RuntimeBrowserPreparationSchema, RuntimeAccountBrowserPreparationSchema]);
export type RuntimeBrowserApprovalCard = z.infer<typeof RuntimeBrowserApprovalCardSchema>;
/** `overview`: the workspace's browsers for the Inspector's Browser tab; `preview`: a small image of one tab
 * (`groupId` and `targetId`; the group names the browser); `captures`: the workspace's captures, newest first;
 * `captureStart` (`groupId`, `targetId`): you start recording a tab's screencast frames; `captureStop` (`captureId`).
 * Share links (`browser-share.ts`): `shares` lists the workspace's shares; `shareCreate` (`groupId`, `targetId`,
 * `comment`, `expiresInMinutes`) shares a tab of the workspace's Chrome group; `shareRevoke` (`shareId`) ends one;
 * `shareConnect` (`shareId`, `secret`, `groupId`) moves a pasted share's tab into the workspace's group on its Chrome;
 * Comments (`browser-comments.ts`): `comments` (`status`, `captureId`, `limit`) lists the workspace's threads, newest
 * first; `commentWrite` (`write`) makes a thread, replies in one or resolves one, as you. Your Chrome's workspace
 * group from the Browser tab:
 * `stop` (`groupId`) ends its scripts and its single step, as Stop in Chrome does; `closeTab` (`groupId`, `targetId`)
 * closes a tab of the group (on the cloud browser, one of its tabs); `focusTab` (`groupId`, `targetId`) brings a tab of
 * the group to the front of its window. Take over (docs/APERTURE-DESIGN.md §7.2), on your Chrome's group or the cloud
 * browser's (`groupId` names the browser, as for `closeTab`): `takeOver` (`groupId`, `targetId`, `device`: the signed-in
 * device taking it) makes you the tab's holder, so none of the agent's commands reach it; `resume` hands it back.
 * Comments: `commentShow` (`groupId`, `targetId`, `threadId`) brings your Chrome's tab to the front with
 * comment mode on and that thread open. Everything (`browser-powers.ts`): `everything` (`pairingId`, `on`) allows it
 * on the workspace's group on that Chrome for an hour, or ends it. Adding a tab from your Chrome's popup
 * (`browser-workspaces.ts`): `tabGroup` (`pairingId`) makes or renews the workspace's group on that Chrome, as the
 * agent's `tabs` there does, and answers the group's id. */
export const RuntimeBrowserManagementSchema = z.strictObject({ action: z.enum(['status', 'revoke', 'reconcile', 'discard', 'artifact', 'overview', 'preview', 'captures', 'captureStart', 'captureStop', 'captureShares', 'captureShareCreate', 'captureShareRevoke', 'shares', 'shareCreate', 'shareRevoke', 'shareConnect', 'comments', 'commentWrite', 'stop', 'closeTab', 'focusTab', 'takeOver', 'resume', 'commentShow', 'everything', 'tabGroup']), groupId: z.string().uuid().optional(), recordId: id.optional(), artifactId: id.optional(), targetId: id.optional(), captureId: z.string().uuid().optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(65536).optional(),
  shareId: z.string().uuid().optional(), secret: z.string().min(16).max(128).optional(), comment: z.boolean().optional(), expiresInMinutes: z.number().int().positive().max(43_200).optional(), device: z.string().min(1).max(256).nullable().optional(),
  /** Capture share links (`browser-capture-share.ts`): `captureShares` lists the workspace's; `captureShareCreate`
   * (`captureId`, `comment`, `expiresInMinutes`) shares a saved capture; `captureShareRevoke` (`captureShareId`) ends one. */
  captureShareId: z.string().uuid().optional(),
  /** A comment thread (`browser-comments.ts`, the root comment's id). */
  threadId: z.string().uuid().optional(),
  /** `comments`: open threads only (the default) or every one; `commentWrite`: the change. */
  status: RuntimeBrowserCommentStatusSchema.optional(), write: RuntimeBrowserCommentWriteSchema.optional(),
  /** `everything` and `tabGroup`: the Chrome; `everything`: whether Everything begins (true) or ends. */
  pairingId: z.string().uuid().optional(), on: z.boolean().optional() });
export type RuntimeBrowserManagement = z.infer<typeof RuntimeBrowserManagementSchema>;
export const RuntimeBrowserAuthorityCertificateBodySchema = z.strictObject({
  accountId: id, projectId: id, workspaceId: id,
  publicKey: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(128),
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
});
export type RuntimeBrowserAuthorityCertificateBody = z.infer<typeof RuntimeBrowserAuthorityCertificateBodySchema>;
export const RuntimeBrowserAuthorityCertificateSchema = z.strictObject({ body: RuntimeBrowserAuthorityCertificateBodySchema, signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(128) });
export type RuntimeBrowserAuthorityCertificate = z.infer<typeof RuntimeBrowserAuthorityCertificateSchema>;
export const RuntimeBrowserSignedGrantSchema = z.strictObject({ body: RuntimeBrowserGrantSchema, signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(128), authority: RuntimeBrowserAuthorityCertificateSchema });
export type RuntimeBrowserSignedGrant = z.infer<typeof RuntimeBrowserSignedGrantSchema>;
export const RuntimeBrowserAuthorizationBodySchema = z.strictObject({
  scope: z.strictObject({ ...executionScope, conversationId: id, taskId: id, requestId: id, attemptId: id }),
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  dispatch: z.strictObject({ version: z.literal(1), tool: z.enum(['browser', 'browser_control']), deadlineAt: z.iso.datetime(), replay: z.enum(['safe', 'unsafe']), parentAttemptId: id.optional() }),
  command: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('prepare'), args: RuntimeBrowserArgumentsSchema, groupId: z.string().uuid() }),
    z.strictObject({ type: z.literal('execute'), args: RuntimeBrowserArgumentsSchema, grant: RuntimeBrowserSignedGrantSchema }),
    z.strictObject({ type: z.literal('manage'), ...RuntimeBrowserManagementSchema.shape }),
    z.strictObject({ type: z.literal('tabs'), groupId: z.string().uuid() }),
  ]),
});
export type RuntimeBrowserAuthorizationBody = z.infer<typeof RuntimeBrowserAuthorizationBodySchema>;
export const RuntimeBrowserAuthorizationSchema = z.strictObject({ body: RuntimeBrowserAuthorizationBodySchema, signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(128), authority: RuntimeBrowserAuthorityCertificateSchema });
export const RuntimeAccountBrowserSignedGrantSchema = RuntimeBrowserSignedGrantSchema.extend({ body: RuntimeAccountBrowserGrantSchema });
export type RuntimeAccountBrowserSignedGrant = z.infer<typeof RuntimeAccountBrowserSignedGrantSchema>;
export const RuntimeAccountBrowserAuthorizationBodySchema = RuntimeBrowserAuthorizationBodySchema.extend({
  scope: RuntimeBrowserAuthorizationBodySchema.shape.scope.omit({ machineId: true, attachmentId: true, generation: true }).extend({ placement: RuntimeAccountBrowserPlacementSchema, conversationKind: z.enum(['main', 'subagent']) }),
  command: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('execute'), args: RuntimeBrowserArgumentsSchema, grant: RuntimeAccountBrowserSignedGrantSchema }),
    z.strictObject({ type: z.literal('manage'), ...RuntimeBrowserManagementSchema.shape }),
    z.strictObject({ type: z.literal('tabs'), groupId: z.string().uuid() }),
  ]),
});
export type RuntimeAccountBrowserAuthorizationBody = z.infer<typeof RuntimeAccountBrowserAuthorizationBodySchema>;
export const RuntimeAccountBrowserAuthorizationSchema = RuntimeBrowserAuthorizationSchema.extend({ body: RuntimeAccountBrowserAuthorizationBodySchema });
export type RuntimeAccountBrowserAuthorization = z.infer<typeof RuntimeAccountBrowserAuthorizationSchema>;
export type RuntimeBrowserAuthorization = z.infer<typeof RuntimeBrowserAuthorizationSchema>;
export const RuntimeBrowserPublicKeySchema = z.strictObject({ algorithm: z.literal('Ed25519'), publicKey: z.string().max(128) });
export const RuntimeBrowserTrustSchema = RuntimeBrowserPublicKeySchema.extend({ accountId: id });
export type RuntimeBrowserTrust = z.infer<typeof RuntimeBrowserTrustSchema>;
/** The pairing details a short pairing code stands for: the extension redeems the code (`/api/browser-relay/pairing-code`)
 * for them, then proves its new key to `endpoint` with `code`. */
export const RuntimeAccountBrowserPairingSchema = z.strictObject({ code: z.string().min(1), pairingId: z.string().uuid(), generation: z.number().int().nonnegative(), trust: RuntimeBrowserTrustSchema, endpoint: z.url(), expiresAt: z.iso.datetime() });
export type RuntimeAccountBrowserPairing = z.infer<typeof RuntimeAccountBrowserPairingSchema>;
/** A short pairing code's characters: digits and capitals without 0, 1, I, L, O and U, which read alike. */
const BROWSER_PAIRING_CODE = /^[2-9A-HJKMNP-TV-Z]{6}$/;
/** A short pairing code as typed, with case, spaces and hyphens ignored; null when the text cannot be one. */
export function browserPairingCode(text: string): string | null {
  const code = text.toUpperCase().replace(/[\s-]/g, '');
  return BROWSER_PAIRING_CODE.test(code) ? code : null;
}
/** A pairing GitSpace started (Plugins → Browsers → Pair a Chrome): its short single-use code to type into the
 * extension's popup, until `expiresAt`. */
export const RuntimeAccountBrowserPairingCodeSchema = z.strictObject({ pairingId: z.string().uuid(), code: z.string().regex(BROWSER_PAIRING_CODE), expiresAt: z.iso.datetime() });
export type RuntimeAccountBrowserPairingCode = z.infer<typeof RuntimeAccountBrowserPairingCodeSchema>;
/**
 * The Chrome extension's protocol (docs/APERTURE-DESIGN.md §12a), independent of release ids. A release accepts
 * extensions at this protocol and the one before; an extension from before protocols were reported counts as 0.
 * Protocol 2 adds scripts (`browser.run`) on your Chrome; protocol 1 extensions keep single steps. Protocol 3 adds tab
 * previews (`manage` `preview`) and running-script counts in group reports. Protocol 4 adds captures (your Capture
 * click records the tab with `chrome.tabCapture`; `captureStart`/`captureStop` record screencast frames), downloads of
 * agent tabs saved to the drive, and uploads into pages from sealed `/files/` links, all moving bytes over HTTPS
 * (`/api/browser-relay/uploads`), never the relay connection. Protocol 5 sends those uploads through upload links: only
 * the begin request is signed with the pairing key, and its parts, completion and abandonment go to the link it answers.
 * Protocol 6 adds share links: `shareTab`/`shareWatch`/`shareUnwatch`/`shareHit`/`shareAnchor`/`adoptTab`,
 * `sharePointers`/`shares`/`shareEnded` notifications, `shareFrame` and share `page`/`closed` messages, and signed
 * `/api/browser-relay/shares` requests. Within protocol 6, an extension from 5.9 says `siteLevels` in its hello: it
 * enforces a grant's `read` sites (`RuntimeAccountBrowserGrantSchema`). Within protocol 6, an extension from 5.10 says
 * `takeover` in its hello: it takes `takeOver`/`resume`, reports `held`, and refuses the agent's commands on a tab you
 * hold. Within protocol 6, an extension from 5.11 says `powers` in its hello: it enforces a grant's `powers` and
 * `everything` (`browser-powers.ts`) and takes `everything` notices; an older one never gets a grant with either.
 */
export const BROWSER_EXTENSION_PROTOCOL = 6;
/** The longest one `browser.run` script runs before it is stopped, in the cloud browser and on your Chrome. */
export const BROWSER_RUN_LIMIT_MS = 120_000;
/** Whether a release at protocol `current` refuses an extension at `protocol` as too old. */
export function browserExtensionUpdateRequired(protocol: number, current = BROWSER_EXTENSION_PROTOCOL): boolean {
  return protocol < current - 1;
}
/** What a paired extension last reported, and whether this release refused it as too old. */
export const RuntimeBrowserExtensionSchema = z.strictObject({ version: z.string().max(40).nullable(), protocol: z.number().int().nonnegative(), updateRequired: z.boolean() });
/** A paired Chrome's name, one per Chrome, shown everywhere it appears (Plugins, the Browser tab, the agent's list). */
export const RuntimeBrowserNameSchema = z.string().trim().min(1).max(128);
/** A paired Chrome's note for agents (the account it is signed in to, say), one per Chrome, in every project. */
export const RuntimeBrowserNoteSchema = z.string().trim().max(2048);
/** The operating system a Chrome's extension reports in its hello. */
export const RuntimeBrowserPlatformSchema = z.enum(['Windows', 'macOS', 'Linux', 'ChromeOS']);
export type RuntimeBrowserPlatform = z.infer<typeof RuntimeBrowserPlatformSchema>;
const browserPairingStatus = {
  connected: z.boolean(), pairingId: z.string().uuid(), generation: z.number().int().nonnegative(), name: RuntimeBrowserNameSchema, note: RuntimeBrowserNoteSchema, extension: RuntimeBrowserExtensionSchema.nullable(),
  /** Chrome's major version and OS as the Chrome last said them at its hello, kept while it is offline; null before
   * it said them (the OS comes from extensions 5.8 and later). */
  chromeVersion: z.number().int().positive().nullable(), platform: RuntimeBrowserPlatformSchema.nullable(),
  /** When the relay last heard from the Chrome, coarsely: its connect, its disconnect, and its messages at most every
   * ten minutes. Null before it was first heard from since this was recorded. */
  seenAt: z.iso.datetime().nullable(),
  /** When you confirmed its fingerprint. LEGACY: null for Chromes confirmed before this was recorded; drop the null
   * once each of them has been paired again. */
  pairedAt: z.iso.datetime().nullable(),
  /** Agents using the Chrome now, in every workspace of the account. */
  agentsUsing: z.number().int().nonnegative(),
};
export const RuntimeAccountBrowserIdentitySchema = z.discriminatedUnion('state', [
  z.strictObject({ ...browserPairingStatus, state: z.literal('awaiting-key'), pairedKeyFingerprint: z.null(), expiresAt: z.iso.datetime() }),
  z.strictObject({ ...browserPairingStatus, state: z.literal('pending-confirmation'), pairedKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.null() }),
  z.strictObject({ ...browserPairingStatus, state: z.literal('confirmed'), pairedKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.null() }),
]);
/** The account's paired Chromes for Plugins → Browsers, and `cloudWorkspaces`: how many of its workspaces have their
 * cloud browser open now. */
export const RuntimeAccountBrowserRelayStatusSchema = z.strictObject({ pairings: z.array(RuntimeAccountBrowserIdentitySchema), cloudWorkspaces: z.number().int().nonnegative() });
export type RuntimeAccountBrowserRelayStatus = z.infer<typeof RuntimeAccountBrowserRelayStatusSchema>;
/** A project's approval of one Chrome, with the powers it gives agents there (`browser-powers.ts`). Its name and note
 * belong to the Chrome. */
const projectBrowserApproval = z.strictObject({ pairingId: z.string().uuid(), powers: BrowserPowersSchema.default([]) });
export const RuntimeProjectBrowserPreferencesSchema = z.strictObject({ defaultPairingId: z.string().uuid().nullable(), approvals: z.array(projectBrowserApproval).max(32) }).superRefine((value, ctx) => {
  if (new Set(value.approvals.map(item => item.pairingId)).size !== value.approvals.length) ctx.addIssue({ code: 'custom', message: 'Browser approvals must be unique', path: ['approvals'] });
  if (value.defaultPairingId && !value.approvals.some(item => item.pairingId === value.defaultPairingId)) ctx.addIssue({ code: 'custom', message: 'Default Chrome must be approved for this project', path: ['defaultPairingId'] });
});
export type RuntimeProjectBrowserPreferences = z.infer<typeof RuntimeProjectBrowserPreferencesSchema>;
/** A project's Chromes. `takeover`: the Chrome is online with an extension whose hello said it can be taken over
 * (`takeover`, from 5.10); `powersSupported`: online with one whose hello said `powers` (from 5.11). */
export const RuntimeProjectBrowserSettingsSchema = z.strictObject({ projectId: id, revision: z.number().int().nonnegative(), defaultPairingId: z.string().uuid().nullable(), browsers: z.array(projectBrowserApproval.extend({ name: RuntimeBrowserNameSchema, note: RuntimeBrowserNoteSchema, generation: z.number().int().nonnegative(), connected: z.boolean(), approved: z.boolean(), takeover: z.boolean().default(false), powersSupported: z.boolean().default(false) })).max(32) });
export type RuntimeProjectBrowserSettings = z.infer<typeof RuntimeProjectBrowserSettingsSchema>;
export const RuntimeBrowserArtifactSchema = z.strictObject({ id, url: z.string().max(8192), mediaType: z.string().max(128), bytes: z.number().int().nonnegative(), expiresAt: z.iso.datetime() });
export const RuntimeBrowserArtifactPageSchema = z.strictObject({ artifact: RuntimeBrowserArtifactSchema, offset: z.number().int().nonnegative(), data: z.string().max(90000), nextOffset: z.number().int().nonnegative().nullable() });
export type RuntimeBrowserArtifact = z.infer<typeof RuntimeBrowserArtifactSchema>;
export type RuntimeBrowserArtifactPage = z.infer<typeof RuntimeBrowserArtifactPageSchema>;
export const RuntimeBrowserStatusSchema = z.strictObject({
  browsers: RuntimeProjectBrowserSettingsSchema.shape.browsers.optional(),
  groups: z.array(z.union([
    RuntimeBrowserGrantSchema.extend({ state: z.enum(['active', 'revoked', 'expired', 'fenced', 'closed']), reason: z.string().max(1024).optional() }),
    RuntimeAccountBrowserGrantSchema.extend({ state: z.enum(['active', 'revoked', 'expired', 'fenced', 'closed']), reason: z.string().max(1024).optional() }),
  ])).max(200),
  records: z.array(z.strictObject({ id, groupId: z.string().uuid().optional(), projectId: id, workspaceId: id, state: z.enum(['uncertain', 'fenced', 'stopped']), reason: z.string().max(1024), expiresAt: z.iso.datetime().optional(), actions: z.array(z.enum(['reconcile', 'discard'])).max(2) })).max(200),
});
export type RuntimeBrowserStatus = z.infer<typeof RuntimeBrowserStatusSchema>;
/** Who put a tab in a workspace's Chrome group: the agent opened it, a tab already in the group opened it, or you
 * added it (dragged it in or opened it there). */
export const RuntimeBrowserTabOriginSchema = z.enum(['agent', 'page', 'you']);
/** A tab in a workspace's Chrome group as the extension reports it. `site` is the host a tab you dragged in showed
 * at that moment: dragging it in consents to that site for that tab. */
export const RuntimeBrowserGroupTabSchema = z.strictObject({ targetId: id, url: z.string().max(8192), title: z.string().max(500), addedBy: RuntimeBrowserTabOriginSchema, site: z.string().max(253).nullable() });
/** Who holds one tab (docs/APERTURE-DESIGN.md §7.2): the agent, or you. While you hold it none of the agent's commands
 * reach it. `by`: where you took it (`chrome`: its in-page toolbar, or your first click or key on a tab the agent was
 * using; `gitspace`: the Watch dialog or the agent's ask_takeover card); `device`: the signed-in device that took it from
 * GitSpace, the only one whose input reaches the tab (null when taken in Chrome). Reports and documents list only tabs
 * you hold; every other tab is the agent's. */
export const RuntimeBrowserHolderSchema = z.strictObject({ targetId: id, holder: z.enum(['agent', 'you']), since: z.iso.datetime(), by: z.enum(['chrome', 'gitspace']), device: z.string().max(256).nullable() });
export type RuntimeBrowserHolder = z.infer<typeof RuntimeBrowserHolderSchema>;
/** Chrome's tab-group colours, by the names Chrome gives them (`chrome.tabGroups.Color`). */
export const RuntimeBrowserGroupColorSchema = z.enum(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
export type RuntimeBrowserGroupColor = z.infer<typeof RuntimeBrowserGroupColorSchema>;
/** One agent acting on a workspace group now, as the extension reports it: a script (`tool` `run`) or a single step
 * (`tool` its action) whose signed authority lasts; who acts (`main`: only the main agent uses your Chrome); the
 * commands it sent so far; when it began; what it is doing in a few words (`browser-extension/src/activity.ts`,
 * never what is typed); and the tab of its latest command (`targetId`: from 5.10, to a relay whose `ready` said
 * `takeover`; null before its first). */
export const RuntimeBrowserGroupAgentSchema = z.strictObject({ agent: z.enum(['main', 'subagent']), tool: RuntimeBrowserPreparationSchema.shape.action, commands: z.number().int().nonnegative(), startedAt: z.iso.datetime(), doing: z.string().max(120).nullable(), targetId: id.nullable().optional() });
export type RuntimeBrowserGroupAgent = z.infer<typeof RuntimeBrowserGroupAgentSchema>;
/** The extension's report of one workspace group's tabs, sent whenever membership, a URL or a title changes, and
 * while agents act there at most every few seconds. `color` and `agents` come from extensions from 5.8, and only to a
 * relay whose `ready` said it takes them (`groupActivity`); `held` from extensions from 5.10, at once whenever a tab's
 * holder changes, and only to a relay whose `ready` said `takeover`. */
export const RuntimeBrowserGroupReportSchema = z.strictObject({ groupId: z.string().uuid(), tabs: z.array(RuntimeBrowserGroupTabSchema).max(200),
  /** Scripts running on the group. */
  running: z.number().int().nonnegative(),
  /** The group's colour in Chrome's tab strip. */
  color: RuntimeBrowserGroupColorSchema.optional(),
  agents: z.array(RuntimeBrowserGroupAgentSchema).max(32).optional(),
  /** The group's tabs you hold. */
  held: z.array(RuntimeBrowserHolderSchema).max(200).optional() });
export type RuntimeBrowserGroupReport = z.infer<typeof RuntimeBrowserGroupReportSchema>;
/** The `gitspace.browsers` workspace document (docs/APERTURE-DESIGN.md §4.2): each Chrome group with the tabs the
 * workspace may use (`usable`: on the grant's origins or the site you consented to). `color` is null and `agents`
 * empty from an extension that does not report them; `held` lists the tabs you hold. */
export const RuntimeBrowsersDocumentSchema = z.strictObject({
  chrome: z.array(z.strictObject({
    pairingId: z.string().uuid(), browser: z.string().max(128), groupId: z.string().uuid(), groupName: id,
    origins: z.array(BrowserOriginPatternSchema), expiresAt: z.iso.datetime(), reportedAt: z.iso.datetime(),
    tabs: z.array(RuntimeBrowserGroupTabSchema.extend({ usable: z.boolean() })).max(200),
    /** LEGACY: rows stored before running counts have none; remove the default once they have been rewritten. */
    running: z.number().int().nonnegative().default(0),
    color: RuntimeBrowserGroupColorSchema.nullable().default(null),
    agents: z.array(RuntimeBrowserGroupAgentSchema).max(32).default([]),
    /** LEGACY: rows stored before take over have none; remove the default once they have been rewritten. */
    held: z.array(RuntimeBrowserHolderSchema).max(200).default([]),
  })).max(32),
});
export type RuntimeBrowsersDocument = z.infer<typeof RuntimeBrowsersDocumentSchema>;
export type RuntimeBrowsersDocumentGroup = RuntimeBrowsersDocument['chrome'][number];
/** A tab as the Inspector's Browser tab shows it. `addedBy` is null on the cloud browser, where only agents open tabs.
 * `holder`: `you` while you hold it (its group's `held` says since when and from where), else `agent`. */
export const RuntimeBrowserTabViewSchema = z.strictObject({ targetId: id, url: z.string().max(8192), title: z.string().max(500), addedBy: RuntimeBrowserTabOriginSchema.nullable(), usable: z.boolean(), holder: RuntimeBrowserHolderSchema.shape.holder.default('agent') });
/** One browser call of the workspace in its recent runs: when it began, where it ran (a Chrome by name, null when
 * it was refused before one was chosen; the cloud browser; or a machine's headless browser), the call, a short summary
 * of what it did (an action, an element's name, a host and path: never what was typed, a value, a query or a script's
 * text), how it ended (`refused`: before it reached a browser), how long it took, and a few lines more for Details. */
export const RuntimeBrowserRunSchema = z.strictObject({
  attemptId: id, at: z.iso.datetime(),
  where: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('chrome'), name: RuntimeBrowserNameSchema.nullable() }),
    z.strictObject({ kind: z.literal('cloud') }),
    z.strictObject({ kind: z.literal('machine'), machineId: id }),
  ]),
  tool: RuntimeBrowserPreparationSchema.shape.action, summary: z.string().max(200), outcome: z.enum(['ok', 'failed', 'refused']),
  durationMs: z.number().int().nonnegative(), details: z.array(z.string().max(300)).max(12),
});
export type RuntimeBrowserRun = z.infer<typeof RuntimeBrowserRunSchema>;
/** The workspace's browser runs the Browser tab lists, newest first: at most this many, from the last `BROWSER_RUNS_DAYS`. */
export const BROWSER_RUNS_KEPT = 50;
export const BROWSER_RUNS_DAYS = 7;
/** The workspace's browsers for the Inspector's Browser tab (`manage` `overview`): the approved sites (`revision`: the
 * commit their `.gitspace/bundle.json` was read at, null when there is none), the cloud browser, the attached
 * machines' headless browsers, every Chrome confirmed on the account with whether this project approved it, and the
 * workspace's recent runs. `groupId` is the workspace's group on that browser, null until one exists; on a Chrome,
 * `groupColor` is its colour in Chrome's tab strip (null until its extension reports it) and `agents` who acts there
 * now (empty while it is offline). `held`: the tabs you hold (§7.2); `takeover`: the Chrome's extension can be taken over
 * from GitSpace (from 5.10; offer "Update the extension" instead where it cannot). The cloud browser always can.
 * `powers`: what this project's approval gives agents on that Chrome; `powersSupported`: its extension enforces powers
 * (from 5.11); `everything`: Everything is on for this workspace there until `expiresAt`, else null. */
export const RuntimeBrowserOverviewSchema = z.strictObject({
  sites: z.strictObject({ origins: z.array(z.strictObject({ pattern: BrowserOriginPatternSchema, level: BrowserSiteLevelSchema })), revision: z.string().max(64).nullable() }),
  cloud: z.strictObject({ groupId: z.string().uuid().nullable(), running: z.number().int().nonnegative(), tabs: z.array(RuntimeBrowserTabViewSchema).max(200), held: z.array(RuntimeBrowserHolderSchema).max(200).default([]) }),
  chromes: z.array(z.strictObject({
    pairingId: z.string().uuid(), name: RuntimeBrowserNameSchema, note: z.string().max(2048), connected: z.boolean(), approved: z.boolean(), isDefault: z.boolean(),
    groupId: z.string().uuid().nullable(), groupName: id.nullable(), groupColor: RuntimeBrowserGroupColorSchema.nullable(), running: z.number().int().nonnegative(), agents: z.array(RuntimeBrowserGroupAgentSchema).max(32), tabs: z.array(RuntimeBrowserTabViewSchema).max(200),
    held: z.array(RuntimeBrowserHolderSchema).max(200).default([]), takeover: z.boolean().default(false),
    powers: BrowserPowersSchema.default([]), powersSupported: z.boolean().default(false), everything: BrowserEverythingSchema.nullable().default(null),
  })).max(32),
  /** Headless browsers on the workspace's attached machines (agents' headless steps run there when one is ready);
   * `error` when that machine could not answer. */
  machines: z.array(z.strictObject({ machineId: id, groupId: z.string().uuid().nullable(), tabs: z.array(RuntimeBrowserTabViewSchema).max(200), error: z.string().max(1024).nullable() })).max(16),
  runs: z.array(RuntimeBrowserRunSchema).max(BROWSER_RUNS_KEPT),
});
export type RuntimeBrowserOverview = z.infer<typeof RuntimeBrowserOverviewSchema>;
/** Where browser files live in the workspace's drive (`drive://workspace/<path>`). */
export const BROWSER_DRIVE_PREFIX = { captures: 'browser/captures/', downloads: 'browser/downloads/' } as const;
/** `frames.json`: each frame's time since the capture started and its bytes in `frames.bin`. */
export const RuntimeBrowserFramesIndexSchema = z.strictObject({ version: z.literal(1), frames: z.array(z.strictObject({ t: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), length: z.number().int().positive() })).max(100_000) });
export type RuntimeBrowserFramesIndex = z.infer<typeof RuntimeBrowserFramesIndexSchema>;
/** A capture as the Browser tab lists it, with sealed `/files/` links for its media and folder in the drive. */
export const RuntimeBrowserCaptureViewSchema = z.strictObject({ capture: RuntimeBrowserCaptureSchema, files: z.record(z.string().max(256), z.string().max(4096)) });
export type RuntimeBrowserCaptureView = z.infer<typeof RuntimeBrowserCaptureViewSchema>;

/** One tab's preview (`manage` `preview`): a small JPEG, or why there is none (on your Chrome, a tab shows one only
 * while the agent is using it, so previews never start Chrome's debugging bar on their own). */
export const RuntimeBrowserPreviewSchema = z.strictObject({ targetId: id, capturedAt: z.iso.datetime(), image: z.strictObject({ mediaType: z.literal('image/jpeg'), data: z.string().max(600_000) }).nullable(), reason: z.string().max(256).nullable() });
export type RuntimeBrowserPreview = z.infer<typeof RuntimeBrowserPreviewSchema>;

/** Domain-separated canonical JSON: signatures never accept a key supplied by the command. */
export function canonicalBrowserAuthorization(value: unknown): string {
  const encode = (input: unknown): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(encode).join(',')}]`;
    return `{${Object.entries(input).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`).join(',')}}`;
  };
  return `gitspace.browser.authorization.v1\n${encode(value)}`;
}
export function browserBase64(bytes: Uint8Array): string { return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')); }
export function browserUnbase64(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
export function canonicalBrowserAuthorityCertificate(value: unknown): string {
  return canonicalBrowserAuthorization(value).replace('gitspace.browser.authorization.v1\n', 'gitspace.browser.authority.v1\n');
}
export async function signRuntimeBrowserAuthorityCertificate(body: RuntimeBrowserAuthorityCertificateBody, privateKey: CryptoKey): Promise<RuntimeBrowserAuthorityCertificate> {
  const parsed = RuntimeBrowserAuthorityCertificateBodySchema.parse(body);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(canonicalBrowserAuthorityCertificate(parsed)));
  return { body: parsed, signature: browserBase64(new Uint8Array(signature)) };
}
export function canonicalBrowserGrant(value: unknown): string {
  return canonicalBrowserAuthorization(value).replace('gitspace.browser.authorization.v1\n', 'gitspace.browser.grant.v1\n');
}
export async function signRuntimeBrowserGrant(body: RuntimeBrowserGrant, privateKey: CryptoKey, authority: RuntimeBrowserAuthorityCertificate): Promise<RuntimeBrowserSignedGrant> {
  const parsed = RuntimeBrowserGrantSchema.parse(body);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(canonicalBrowserGrant(parsed)));
  return { body: parsed, signature: browserBase64(new Uint8Array(signature)), authority: RuntimeBrowserAuthorityCertificateSchema.parse(authority) };
}
export async function verifyRuntimeBrowserGrant(grant: unknown, trustedKey: CryptoKey, now = Date.now()): Promise<RuntimeBrowserGrant> {
  const { body, signature, authority } = RuntimeBrowserSignedGrantSchema.parse(grant);
  if (!await crypto.subtle.verify('Ed25519', trustedKey, browserUnbase64(authority.signature), new TextEncoder().encode(canonicalBrowserAuthorityCertificate(authority.body)))) throw new Error('Invalid browser authority signature');
  if (authority.body.projectId !== body.projectId || authority.body.workspaceId !== body.workspaceId) throw new Error('Browser authority scope mismatch');
  if (Date.parse(authority.body.issuedAt) - now > 120_000) throw new Error('Browser clock skew: cloud authority exceeds maximum 120 seconds');
  if (Date.parse(authority.body.expiresAt) <= now || Date.parse(authority.body.expiresAt) <= Date.parse(authority.body.issuedAt) || Date.parse(body.expiresAt) > Date.parse(authority.body.expiresAt)) throw new Error('Browser authority expired or not yet valid');
  const workspaceKey = await crypto.subtle.importKey('raw', browserUnbase64(authority.body.publicKey), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', workspaceKey, browserUnbase64(signature), new TextEncoder().encode(canonicalBrowserGrant(body)))) throw new Error('Invalid browser grant signature');
  if (Date.parse(body.expiresAt) <= now) throw new Error('Browser grant expired');
  return body;
}
export async function signRuntimeBrowserAuthorization(body: RuntimeBrowserAuthorizationBody, privateKey: CryptoKey, authority: RuntimeBrowserAuthorityCertificate): Promise<RuntimeBrowserAuthorization> {
  const parsed = RuntimeBrowserAuthorizationBodySchema.parse(body);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(canonicalBrowserAuthorization(parsed)));
  return { body: parsed, signature: browserBase64(new Uint8Array(signature)), authority: RuntimeBrowserAuthorityCertificateSchema.parse(authority) };
}
export async function verifyRuntimeBrowserAuthorization(authorization: unknown, dispatch: { projectId: string; workspaceId: string; conversationId: string; machineId: string; attachmentId: string; generation: number; taskId: string; requestId: string; attemptId: string; version: number; tool: string; args: unknown; deadlineAt: string; replay: string; parentAttemptId?: string }, trustedKey: CryptoKey, now = Date.now()): Promise<RuntimeBrowserAuthorizationBody> {
  const { body, signature, authority } = RuntimeBrowserAuthorizationSchema.parse(authorization);
  const maxIssuedAtSkewMs = 120_000;
  if (!await crypto.subtle.verify('Ed25519', trustedKey, browserUnbase64(authority.signature), new TextEncoder().encode(canonicalBrowserAuthorityCertificate(authority.body)))) throw new Error('Invalid browser authority signature');
  if (authority.body.projectId !== body.scope.projectId || authority.body.workspaceId !== body.scope.workspaceId) throw new Error('Browser authority scope mismatch');
  if (Date.parse(authority.body.issuedAt) - now > maxIssuedAtSkewMs) throw new Error(`Browser clock skew: cloud authority is ${Math.ceil((Date.parse(authority.body.issuedAt) - now) / 1000)} seconds ahead (maximum 120 seconds). Synchronize the machine and browser clocks.`);
  if (Date.parse(authority.body.expiresAt) <= now || Date.parse(authority.body.expiresAt) <= Date.parse(authority.body.issuedAt) || Date.parse(body.expiresAt) > Date.parse(authority.body.expiresAt)) throw new Error('Browser authority expired or not yet valid');
  const workspaceKey = await crypto.subtle.importKey('raw', browserUnbase64(authority.body.publicKey), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', workspaceKey, browserUnbase64(signature), new TextEncoder().encode(canonicalBrowserAuthorization(body)))) throw new Error('Invalid browser authorization signature');
  if (Date.parse(body.issuedAt) - now > maxIssuedAtSkewMs) throw new Error(`Browser clock skew: cloud authorization is ${Math.ceil((Date.parse(body.issuedAt) - now) / 1000)} seconds ahead (maximum 120 seconds). Synchronize the machine and browser clocks.`);
  if (Date.parse(body.expiresAt) <= now || Date.parse(body.expiresAt) <= Date.parse(body.issuedAt)) throw new Error('Browser authorization expired or not yet valid');
  for (const key of ['projectId', 'workspaceId', 'conversationId', 'machineId', 'attachmentId', 'generation', 'taskId', 'requestId', 'attemptId'] as const) if (dispatch[key] !== body.scope[key]) throw new Error('Browser authorization scope mismatch');
  for (const key of ['version', 'tool', 'deadlineAt', 'replay', 'parentAttemptId'] as const) if (body.dispatch[key] !== dispatch[key]) throw new Error('Browser dispatch mismatch');
  const { type: commandType, ...commandFields } = body.command;
  const expected = commandType === 'manage' ? RuntimeBrowserManagementSchema.parse(commandFields) : commandType === 'tabs' ? commandFields : 'args' in body.command ? body.command.args : null;
  if (canonicalBrowserAuthorization(expected) !== canonicalBrowserAuthorization(dispatch.args)) throw new Error('Browser authorization arguments mismatch');
  if (body.dispatch.tool !== (commandType === 'execute' ? 'browser' : 'browser_control')) throw new Error('Browser command tool mismatch');
  if (body.command.type === 'execute') {
    const grant = await verifyRuntimeBrowserGrant(body.command.grant, trustedKey, now);
    if (body.command.grant.authority.body.accountId !== authority.body.accountId) throw new Error('Browser grant account mismatch');
    for (const key of ['projectId', 'workspaceId', 'machineId', 'attachmentId', 'generation'] as const) if (grant[key] !== body.scope[key]) throw new Error('Browser grant scope mismatch');
    if (Date.parse(body.expiresAt) > Date.parse(grant.expiresAt)) throw new Error('Browser grant expired');
    const args = body.command.args;
    if (args.source !== grant.source) throw new Error('Browser grant source mismatch');
    if (grant.source === 'relay' && (args.action === 'navigate' || args.action === 'open') && args.url && args.url !== 'about:blank') {
      const url = new URL(args.url);
      if (!['http:', 'https:'].includes(url.protocol) || !grant.origins.some(pattern => browserOriginMatches(pattern, url.hostname))) throw new Error('Browser origin outside approved patterns');
    }
  }
  return body;
}


export async function signRuntimeAccountBrowserGrant(body: RuntimeAccountBrowserGrant, privateKey: CryptoKey, authority: RuntimeBrowserAuthorityCertificate): Promise<RuntimeAccountBrowserSignedGrant> {
  const parsed = RuntimeAccountBrowserGrantSchema.parse(body);
  return { body: parsed, authority, signature: browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(canonicalBrowserGrant(parsed))))) };
}

export async function signRuntimeAccountBrowserAuthorization(body: RuntimeAccountBrowserAuthorizationBody, privateKey: CryptoKey, authority: RuntimeBrowserAuthorityCertificate): Promise<RuntimeAccountBrowserAuthorization> {
  const parsed = RuntimeAccountBrowserAuthorizationBodySchema.parse(body);
  return { body: parsed, authority, signature: browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(canonicalBrowserAuthorization(parsed))))) };
}

export async function verifyRuntimeAccountBrowserAuthorization(value: unknown, trust: RuntimeBrowserTrust, now = Date.now()): Promise<RuntimeAccountBrowserAuthorizationBody> {
  const authorization = RuntimeAccountBrowserAuthorizationSchema.parse(value);
  const { body, authority } = authorization;
  const root = await crypto.subtle.importKey('raw', browserUnbase64(trust.publicKey), 'Ed25519', false, ['verify']);
  const verifyAuthority = async (certificate: RuntimeBrowserAuthorityCertificate) => {
    if (certificate.body.accountId !== trust.accountId || certificate.body.projectId !== body.scope.projectId || certificate.body.workspaceId !== body.scope.workspaceId
      || Date.parse(certificate.body.issuedAt) > now + 120_000 || Date.parse(certificate.body.expiresAt) <= now || Date.parse(certificate.body.expiresAt) <= Date.parse(certificate.body.issuedAt)
      || !await crypto.subtle.verify('Ed25519', root, browserUnbase64(certificate.signature), new TextEncoder().encode(canonicalBrowserAuthorityCertificate(certificate.body)))) throw new Error('Untrusted account browser authority');
    return crypto.subtle.importKey('raw', browserUnbase64(certificate.body.publicKey), 'Ed25519', false, ['verify']);
  };
  const key = await verifyAuthority(authority);
  if (body.scope.placement.accountId !== trust.accountId || Date.parse(body.issuedAt) > now + 120_000 || Date.parse(body.expiresAt) <= now
    || Date.parse(body.expiresAt) > Date.parse(authority.body.expiresAt) || Date.parse(body.expiresAt) <= Date.parse(body.issuedAt) || Date.parse(body.dispatch.deadlineAt) <= now
    || !await crypto.subtle.verify('Ed25519', key, browserUnbase64(authorization.signature), new TextEncoder().encode(canonicalBrowserAuthorization(body)))) throw new Error('Invalid account browser authorization');
  if (body.scope.placement.kind === 'account-relay' && body.scope.conversationKind !== 'main') throw new Error('Logged-in Chrome relay is main-agent-only');
  if (body.dispatch.tool !== (body.command.type === 'execute' ? 'browser' : 'browser_control')) throw new Error('Browser dispatch command mismatch');
  if (body.command.type === 'execute') {
    const signed = body.command.grant;
    const grantKey = await verifyAuthority(signed.authority);
    const grant = signed.body;
    if (grant.projectId !== body.scope.projectId || grant.workspaceId !== body.scope.workspaceId
      || canonicalBrowserAuthorization(grant.placement) !== canonicalBrowserAuthorization(body.scope.placement)
      || Date.parse(grant.expiresAt) < Date.parse(body.expiresAt) || Date.parse(grant.expiresAt) > Date.parse(signed.authority.body.expiresAt)
      || !await crypto.subtle.verify('Ed25519', grantKey, browserUnbase64(signed.signature), new TextEncoder().encode(canonicalBrowserGrant(grant)))) throw new Error('Invalid account browser group grant');
    if (grant.source !== body.command.args.source || (grant.source === 'relay') !== (grant.placement.kind === 'account-relay')) throw new Error('Browser source placement mismatch');
    const args = body.command.args;
    if (grant.source === 'relay' && (args.action === 'open' || args.action === 'navigate') && args.url && args.url !== 'about:blank') {
      const hostname = new URL(args.url).hostname;
      if (!grant.origins.some(pattern => browserOriginMatches(pattern, hostname))) throw new Error('Browser origin outside approved patterns');
    }
  }
  return body;
}