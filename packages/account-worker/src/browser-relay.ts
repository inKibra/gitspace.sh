import { z } from 'zod';
import { browserPairingCode, browserUnbase64, RuntimeBrowserTrustSchema, RuntimeAccountBrowserPairingSchema, RuntimeAccountBrowserPairingCodeSchema, RuntimeAccountBrowserRelayStatusSchema, RuntimeAccountBrowserGrantSchema, RuntimeBrowserCaptureSchema, verifyRuntimeAccountBrowserAuthorization, type RuntimeAccountBrowserAuthorization, type RuntimeAccountBrowserPairing, type RuntimeAccountBrowserSignedGrant, type RuntimeBrowserCapture, type RuntimeBrowserConnectedTab, type RuntimeBrowserPageComment, type RuntimeBrowserShare, type RuntimeBrowserTrust } from '@gitspace/protocol-runtime';
import { BROWSER_EXTENSION_PROTOCOL, browserExtensionUpdateRequired, RuntimeBrowserExtensionSchema, RuntimeBrowserGroupReportSchema, RuntimeBrowserNameSchema, RuntimeBrowserNoteSchema, RuntimeBrowserPlatformSchema, RuntimeProjectBrowserPreferencesSchema, RuntimeProjectBrowserSettingsSchema, RuntimeAccountBrowserGroupRowSchema, type RuntimeBrowserGroupReport, type RuntimeBrowserPlatform, type RuntimeBrowsersDocumentGroup, type RuntimeProjectBrowserPreferences } from '@gitspace/protocol-runtime';
import { browserOriginMatches } from '@gitspace/protocol-environment';
import { AccountBrowserRuntime, type AccountBrowserTransport } from './browser-runtime.js';
import type { BrowserChannel } from './browser-cdp.js';
import { CdpBrowserShim, serveCdpSocket } from './browser-shim.js';
import { RelayBrowser } from './relay-browser.js';
import { extensionFiles, SCRIPT_TAKEN_REFUSAL } from '@gitspace/browser-extension';
import { zipSync, strToU8 } from 'fflate';
import { captureName, readCapture, writeCapture, type CaptureDrive } from './browser-capture.js';
import { BROWSER_DOWNLOAD, BrowserDownloadSchema, BrowserUploads, browserRequestSigner, type BrowserRequestFailure, type BrowserSignedRequest, type BrowserUploadDrive, type BrowserUploadStep } from './browser-upload.js';
import { BrowserShareEventSchema, BrowserShareFrameSchema, BrowserShares, closeOpenSocket, equalSecret, type BrowserShareAccount } from './browser-share.js';
import { BrowserWatches } from './browser-watch.js';

export function browserRelayArchive(endpoint: string): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(extensionFiles(endpoint)).map(([name, content]) => [name, strToU8(content)])));
}
/** `name` is the Chrome's one name; pairings stored before names moved to the pairing have none (see `names`). `note`
 * is its one note for agents; LEGACY: pairings stored before notes moved from project approvals have none until
 * `migrateNotes` gives them one. `chromeVersion` and `platform` are what its last hello said (the OS from extensions 5.8
 * and later), `seenAt` when the relay last heard from it, `pairedAt` when you confirmed its fingerprint (LEGACY: none
 * for pairings confirmed before it was recorded, until they are paired again). */
const identity = { pairingId: z.string().uuid(), generation: z.number().int().nonnegative(), trust: RuntimeBrowserTrustSchema, extension: RuntimeBrowserExtensionSchema.nullable().optional(), name: RuntimeBrowserNameSchema.optional(), note: RuntimeBrowserNoteSchema.optional(),
  chromeVersion: z.number().int().positive().optional(), platform: RuntimeBrowserPlatformSchema.optional(), seenAt: z.iso.datetime().optional(), pairedAt: z.iso.datetime().optional() };
const Pairing = z.discriminatedUnion('state', [
  /** `shortCode` redeems the pairing's details once (`redeemPairingCode`), then is null; `misses` counts the wrong codes
   * tried while it was live. */
  z.object({ ...identity, state: z.literal('awaiting-key'), code: z.string(), expiresAt: z.iso.datetime(), publicKey: z.null(), shortCode: z.string().nullable().default(null), misses: z.number().int().nonnegative().default(0) }),
  z.object({ ...identity, state: z.literal('pending-confirmation'), code: z.null(), expiresAt: z.null(), publicKey: z.string() }),
  z.object({ ...identity, state: z.literal('confirmed'), code: z.null(), expiresAt: z.null(), publicKey: z.string() }),
]);
const Registry = z.object({ pairings: z.array(Pairing) });
const ProjectSettings = z.object({ revision: z.number().int().nonnegative(), defaultPairingId: z.string().uuid().nullable(), approvals: z.array(RuntimeProjectBrowserPreferencesSchema.shape.approvals.element.extend({ generation: z.number().int().nonnegative(), approvalId: z.string().uuid(),
  /** LEGACY: approvals stored before names moved to the pairing carry the name; read only as an unnamed pairing's
   * fallback and dropped on the project's next write. Remove once every stored approval has been rewritten. */
  name: z.string().optional(),
  /** LEGACY: approvals stored before notes moved to the pairing carry a note; `migrateNotes` reads it once, and the
   * project's next write drops it. Remove with `migrateNotes`. */
  note: z.string().optional() })) });
type StoredPairing = z.infer<typeof Pairing>;
const Proof = z.object({ pairing: z.literal('client'), pairingId: z.string().uuid(), clientNonce: z.string().regex(/^[a-f0-9]{64}$/), publicKey: z.string().max(128), proof: z.string().max(128), code: z.string().max(256).optional() });
/** A capture you started on your Chrome (its popup or in-page Capture: `tabCapture` video, or frames), announced
 * before its files upload; `end` follows once every file completed, or says why it failed. */
const CaptureAnnouncement = z.discriminatedUnion('event', [
  z.object({ event: z.literal('start'), captureId: z.string().uuid(), groupId: z.string().uuid(), targetId: z.string().min(1).max(256), track: z.enum(['video', 'frames']), sound: z.boolean(), page: z.object({ url: z.string(), title: z.string() }), startedAt: z.iso.datetime() }),
  z.object({ event: z.literal('end'), captureId: z.string().uuid(), state: z.enum(['saved', 'failed']), reason: z.string().nullable(), endedAt: z.iso.datetime(), tracks: RuntimeBrowserCaptureSchema.shape.tracks }),
]);
const Reply = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.object({ message: z.string() }).optional(), targetId: z.string().optional(), sessionId: z.string().optional(), method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), fenced: z.boolean().optional(), hello: z.boolean().optional(), Browser: z.string().optional(), protocol: z.number().int().nonnegative().optional(), extension: z.string().max(40).optional(), chromeInfo: z.boolean().optional(), controls: z.boolean().optional(), siteLevels: z.boolean().optional(), takeover: z.boolean().optional(),
  /** The OS a 5.8 or later extension says in its hello; one this release does not know is left out, not refused. */
  platform: RuntimeBrowserPlatformSchema.optional().catch(undefined), group: RuntimeBrowserGroupReportSchema.optional(), capture: CaptureAnnouncement.optional(), shareFrame: BrowserShareFrameSchema.optional(), share: BrowserShareEventSchema.optional() });
/** A capture recording on a Chrome: the workspace it belongs to and the files that finished uploading (name → size). */
const CaptureRow = z.object({ pairingId: z.string().uuid(), projectId: z.string(), workspaceId: z.string(), track: z.enum(['video', 'frames']), capture: RuntimeBrowserCaptureSchema, files: z.record(z.string(), z.number().int().nonnegative()) });
type CaptureRow = z.infer<typeof CaptureRow>;
const CAPTURE = 'browser.relay.capture:';
const CaptureStarted = z.object({ url: z.string(), title: z.string() });
const CaptureStopped = z.object({ count: z.number().int().nonnegative(), width: z.number().int().nonnegative(), height: z.number().int().nonnegative() }).partial();
/** The drive as the relay uses it: capture records and the files your Chrome uploads. */
export type BrowserRelayDrive = CaptureDrive & BrowserUploadDrive;
/** Where a workspace's groups are kept for its `gitspace.browsers` document, and the page comments made on its shares. */
export type BrowserWorkspaces = { getByName(name: string): {
  browserGroupReported(identity: { projectId: string; workspaceId: string }, group: RuntimeBrowsersDocumentGroup): Promise<void>;
  pageCommentAdded(identity: { projectId: string; workspaceId: string }, comment: RuntimeBrowserPageComment): Promise<void>;
} };
/** The account's projects, whose names `chromeInfo` tells each Chrome. */
export type BrowserProjects = { getByName(name: string): { list(): Promise<readonly { id: string; name: string }[]> } };
/** Management actions a workspace sends through any Chrome confirmed on the account, online or not: they act on that
 * workspace's shares, and `shareConnect` checks the shared tab's own Chrome. */
const SHARE_MANAGEMENT: Record<string, true> = { shares: true, shareRevoke: true, shareConnect: true };
/** The extension's operation for each control from the Browser tab (`control`). */
const CONTROL_OPERATION: Record<string, 'stopGroup' | 'closeTab' | 'focusTab' | 'takeOver' | 'resume' | undefined> = { stop: 'stopGroup', closeTab: 'closeTab', focusTab: 'focusTab', takeOver: 'takeOver', resume: 'resume' };
/** `informed`: the groups whose project the extension was told (`chromeInfo`), or null for an extension that does not
 * take those notices. `controls`: its hello said it takes Stop, Close tab and Focus in Chrome (`control`). `siteLevels`:
 * its hello said it enforces a grant's `read` sites (from 5.9); an older one never gets a grant with any. `takeover`:
 * its hello said it takes Take over and Resume agent and reports the tabs you hold (from 5.10). `agents`: how many
 * agents act on each of its groups, by group id, as its reports last said (an extension from 5.8 reports them); null
 * until one does. */
type Connection = { socket: WebSocket; product: string; sequence: number; pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void; cancelTimer(): void }>; listeners: Map<string, Set<Parameters<BrowserChannel['subscribe']>[0]>>; authorized: Set<string>; informed: Set<string> | null; controls: boolean; siteLevels: boolean; takeover: boolean; agents: Map<string, number> | null };
/** Why a grant with sites approved read-only is not sent to an extension before 5.9: it would let agents click and type there. */
const READ_SITES_UPDATE = 'Update the GitSpace extension in this Chrome to 5.9 or later: this version cannot keep agents from clicking or typing on the sites this workspace approved read-only:';
/** A script running on a Chrome (`browser.run`): its authority, the connection it began on, and its CDP connection
 * once the script connects. */
type ScriptRun = { authorization: RuntimeAccountBrowserAuthorization; grant: RuntimeAccountBrowserSignedGrant; pairingId: string; attemptId: string; deadline: number; connection: Connection; browser?: RelayBrowser; socket?: WebSocket };
/** A capture stop waits this long for the extension to finish uploading the frames. */
const CAPTURE_STOP_MS = 120_000;
/** A script's release waits this long for the extension to finish uploading its downloads. */
const RELEASE_MS = 90_000;
const PreviewReply = z.object({ image: z.string().max(600_000).nullable(), reason: z.string().max(256).nullable() });
const NO_CHROME = 'No Chrome is paired with this account. Ask the user to pair one in Plugins → Browsers.';
const UNCONFIRMED = 'A Chrome is paired with this account but its fingerprint is not confirmed yet. Ask the user to confirm it in Plugins → Browsers.';
const APPROVE_HINT = 'Ask the user to approve one in Plugins → Browsers or in this workspace’s Browser tab.';
/** Where a script's CDP connection reaches the relay object, from the browser session's sandbox binding only. */
export const BROWSER_SCRIPT_PATH = '/browser-relay/script/';
/** Every Chrome extension socket. Its attachment holds the socket's whole pairing state, so the relay hibernates between frames. */
const BROWSER_SOCKET_TAG = 'browser';
/** An admitted socket must finish pairing, through the extension's hello, within this long. */
const PAIRING_DEADLINE_MS = 5000;
/** What the relay's `ready` offers and its socket attachment records, as of this release; bumped whenever either
 * grows (2: `takeover`). A Chrome's socket survives a release, keeping the `ready` an older relay sent and the hello
 * flags it kept, so the relay closes one whose hello was answered by another release, and the extension says hello
 * again on its next connect. */
const BROWSER_SOCKET_RELEASE = 2;
const BrowserSocket = z.object({
  /** The server challenge the pairing proof signs. */
  nonce: z.string(),
  budget: z.string(),
  network: z.string().nullable(),
  /** The identity an admission proof admitted; the pairing proof must name it. */
  admittedPairingId: z.string().uuid().nullable(),
  deadline: z.number(),
  /** Set once the pairing proof is accepted. */
  pairingId: z.string().uuid().optional(),
  /** Set by the extension's hello; until then the socket is a candidate. */
  product: z.string().optional(),
  /** Set by a hello saying the extension takes `chromeInfo` notices. */
  chromeInfo: z.boolean().optional(),
  /** Set by a hello saying the extension takes `stopGroup`, `closeTab` and `focusTab` (`control`). */
  controls: z.boolean().optional(),
  /** Set by a hello saying the extension enforces a grant's `read` sites. */
  siteLevels: z.boolean().optional(),
  /** Set by a hello saying the extension takes `takeOver` and `resume` and reports the tabs you hold. */
  takeover: z.boolean().optional(),
  /** The `BROWSER_SOCKET_RELEASE` that answered the hello. */
  release: z.number().int().optional(),
});
type BrowserSocketState = z.infer<typeof BrowserSocket>;
async function fingerprint(publicKey: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', browserUnbase64(publicKey)))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
const AdmissionProof = z.object({ pairingId: z.string().uuid(), generation: z.number().int().nonnegative(), issuedAt: z.number().int(), nonce: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().max(128) });
const AdmissionWindows = z.object({
  prefixes: z.array(z.object({ prefix: z.string(), start: z.number(), count: z.number() })).max(1024),
  identities: z.array(z.object({ pairingId: z.string(), start: z.number(), nonces: z.array(z.string()).max(8) })).max(32),
});
const RevocationIntent = z.object({ pairingId: z.string().uuid(), groupId: z.string().uuid() });
/** How long a pairing's codes work. */
const PAIRING_CODE_MS = 10 * 60_000;
/** A short pairing code's characters (`browserPairingCode`). */
const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Wrong short codes allowed within one code's lifetime: from one address (/32, /64), from one network (/24, /48),
 * and while a code is live: past that, the code is withdrawn with its pairing. */
const CODE_TRIES = { address: 10, network: 30, live: 10 } as const;
const CodeTries = z.array(z.object({ prefix: z.string(), start: z.number(), count: z.number() })).max(1024);
/** A connected Chrome's messages renew when it was last seen at most this often. */
const SEEN_MS = 10 * 60_000;
/** A cloud browser session says its browser is open when it opens and again at least this often while it is used. */
export const BROWSER_CLOUD_RENEW_MS = 4 * 60_000;
/** A workspace's cloud browser counts as open this long after its session last said so, so a closing notice that never
 * arrived is forgotten. */
const CLOUD_OPEN_MS = 10 * 60_000;
/** Each cloud browser session that said its browser is open, by object name, with when it last said so. */
const CloudSessions = z.record(z.string(), z.number());
/** A random short pairing code, every character equally likely. */
function shortPairingCode(): string {
  let code = '';
  while (code.length < 6) for (const byte of crypto.getRandomValues(new Uint8Array(8))) if (byte < 240 && code.length < 6) code += PAIRING_CODE_ALPHABET.charAt(byte % 30);
  return code;
}
function admissionPrefix(ip: string): { prefix: string; network: string } | null {
  if (z.ipv4().safeParse(ip).success) return { prefix: `${ip}/32`, network: `${ip.split('.').slice(0, 3).join('.')}.0/24` };
  if (!z.ipv6().safeParse(ip).success) return null;
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [left = '', right] = normalized.split('::');
  const first = left ? left.split(':') : [], last = right ? right.split(':') : [];
  const groups = right === undefined ? first : [...first, ...Array<string>(8 - first.length - last.length).fill('0'), ...last];
  return { prefix: `${groups.slice(0, 4).map(group => Number.parseInt(group, 16).toString(16)).join(':')}::/64`, network: `${groups.slice(0, 3).map(group => Number.parseInt(group, 16).toString(16)).join(':')}::/48` };
}
/** Account-owned transport. Each independently confirmed Chrome owns its connection. */
export class AccountBrowserRelay implements AccountBrowserTransport {
  /** Request state for each ready Chrome, rebuilt from its socket after the relay wakes from hibernation. */
  private readonly connections = new Map<string, Connection>();
  /** Sockets whose single pairing proof is being verified. */
  private readonly verifying = new WeakSet<WebSocket>();
  /** Scripts running on a Chrome, by token: each lives in memory until its run ends, its deadline passes or its Chrome
   * disconnects. */
  private readonly scripts = new Map<string, ScriptRun>();
  /** Scripts the extension stopped because you took one of their tabs over (docs/APERTURE-DESIGN.md §7.2), by token,
   * until the browser session ends them (`scriptEnd`), which reports why: their attempt for their downloads. */
  private readonly takenScripts = new Map<string, { attemptId: string }>();
  /** Single steps on a Chrome by attempt, while their authority lasts: a download one starts uploads under it. */
  private readonly steps = new Map<string, { pairingId: string; groupId: string; deadline: number }>();
  /** When this object last heard from each Chrome, so its messages renew `seenAt` only now and then (`seen`). */
  private readonly heardAt = new Map<string, number>();
  private readonly runtime: AccountBrowserRuntime;
  private readonly uploads: BrowserUploads;
  private readonly shareLinks: BrowserShares;
  /** The Watch dialog's sockets on this Chrome's tabs (owner watch, `browser-watch.ts`). */
  private readonly watches: BrowserWatches;
  /** `drive` opens a workspace's drive, for capture records, comment crops and the files your Chrome uploads; `account`
   * names the account to share links' viewers; `schedule` re-arms the host's alarm when a share deadline changes;
   * `deviceActive` says whether a watching device still verifies. */
  constructor(private readonly ctx: DurableObjectState, private readonly env: { ACCOUNT_ID: string; SPACE_AUTHORITY: BrowserWorkspaces; USER_PROJECTS: BrowserProjects }, private readonly drive: (identity: { projectId: string; workspaceId: string }) => BrowserRelayDrive, account: BrowserShareAccount, schedule: () => Promise<void>, deviceActive: (deviceId: string) => Promise<boolean>) {
    this.runtime = new AccountBrowserRuntime({ storage: ctx.storage, relay: this });
    this.uploads = new BrowserUploads(ctx.storage, {
      pairing: pairingId => this.signingKey(pairingId),
      group: async (pairingId, groupId) => {
        const stored = await ctx.storage.get(`browser.account.group:${groupId}`);
        if (!stored || await ctx.storage.get(`browser.account.revoked:${groupId}`)) return undefined;
        const group = RuntimeAccountBrowserGroupRowSchema.parse(stored);
        return group.placement.kind === 'account-relay' && group.placement.pairingId === pairingId ? { projectId: group.projectId, workspaceId: group.workspaceId } : undefined;
      },
      attempt: (pairingId, groupId, attemptId) => {
        const step = this.steps.get(attemptId);
        if (step && step.pairingId === pairingId && step.groupId === groupId && step.deadline > Date.now()) return true;
        return [...this.scripts.keys()].some(token => { const run = this.liveScript(token); return run?.pairingId === pairingId && run.attemptId === attemptId && run.grant.body.groupId === groupId; });
      },
      capture: async (pairingId, groupId, captureId) => {
        const stored = await ctx.storage.get(`${CAPTURE}${captureId}`);
        const row = stored ? CaptureRow.parse(stored) : undefined;
        return row?.pairingId === pairingId && row.capture.target?.groupId === groupId;
      },
      captured: async (captureId, file, size) => {
        const stored = await ctx.storage.get(`${CAPTURE}${captureId}`);
        if (stored) { const row = CaptureRow.parse(stored); await ctx.storage.put(`${CAPTURE}${captureId}`, { ...row, files: { ...row.files, [file]: size } } satisfies CaptureRow); }
      },
    }, drive);
    this.shareLinks = new BrowserShares(ctx, {
      pairing: async pairingId => {
        const pairing = (await this.registry()).pairings.find(item => item.pairingId === pairingId);
        return pairing?.state === 'confirmed' ? { name: (await this.names([pairing]))(pairing), generation: pairing.generation, protocol: pairing.extension?.protocol ?? 0 } : undefined;
      },
      online: pairingId => !!this.connection(pairingId),
      request: async (pairingId, command) => this.request(pairingId, command),
      notify: (pairingId, message) => { this.connection(pairingId)?.socket.send(JSON.stringify(message)); },
      group: groupId => this.liveGroup(groupId),
      approved: async (projectId, pairingId) => {
        const pairing = (await this.registry()).pairings.find(item => item.pairingId === pairingId && item.state === 'confirmed');
        if (!pairing) throw new Error('The shared tab’s Chrome is no longer paired with this account');
        await this.approved(projectId, pairingId, pairing.generation);
      },
      commented: (workspace, comment) => env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspace.workspaceId}`).pageCommentAdded(workspace, comment),
      drive,
      schedule,
    }, account);
    // Owner watch: frames through the extension's share screencast, input as `remoteInput`.
    this.watches = new BrowserWatches(ctx, {
      online: pairingId => !!this.connection(pairingId),
      protocol: async pairingId => (await this.registry()).pairings.find(item => item.pairingId === pairingId)?.extension?.protocol ?? 0,
      request: async (pairingId, command) => this.request(pairingId, command),
      group: groupId => this.liveGroup(groupId),
      deviceActive,
    });
  }
  /** Whether the host's socket is a Chrome extension socket, a share viewer's or an owner watch's. */
  owns(socket: WebSocket) { return this.ctx.getTags(socket).includes(BROWSER_SOCKET_TAG) || this.shareLinks.owns(socket) || this.watches.owns(socket); }
  /** A confirmed pairing's key, for the requests its extension signs. */
  private async signingKey(pairingId: string) {
    const pairing = (await this.registry()).pairings.find(item => item.pairingId === pairingId);
    return pairing?.state === 'confirmed' ? { generation: pairing.generation, publicKey: pairing.publicKey } : undefined;
  }
  private sockets() {
    const open: { socket: WebSocket; state: BrowserSocketState }[] = [];
    for (const socket of this.ctx.getWebSockets(BROWSER_SOCKET_TAG)) {
      const state = BrowserSocket.safeParse(socket.deserializeAttachment());
      if (socket.readyState === 1 && state.success) open.push({ socket, state: state.data });
    }
    return open;
  }
  /** Sockets still pairing. One past its deadline is closed here, so it neither waits on a timer nor holds a budget. */
  private candidates() {
    return this.sockets().filter(({ socket, state }) => {
      if (state.product) return false;
      if (state.deadline > Date.now()) return true;
      socket.close(1008, 'Pairing timed out');
      return false;
    });
  }
  /** The socket bound to a pairing, ready or still saying hello. */
  private bound(pairingId: string) { return this.sockets().find(({ state }) => state.pairingId === pairingId); }
  /** The ready Chrome for a pairing. One whose hello an older release answered is closed, to say hello again. */
  private connection(pairingId: string): Connection | undefined {
    const bound = this.bound(pairingId), product = bound?.state.product;
    if (!bound || !product) return undefined;
    if (bound.state.release !== BROWSER_SOCKET_RELEASE) { bound.socket.close(1012, 'GitSpace was updated: connect again'); return undefined; }
    const cached = this.connections.get(pairingId);
    if (cached?.socket === bound.socket) { cached.product = product; return cached; }
    if (cached) this.disconnect(pairingId);
    // Request ids continue past any reply still in flight from before the relay hibernated.
    const connection: Connection = { socket: bound.socket, product, sequence: Date.now(), pending: new Map(), listeners: new Map(), authorized: new Set(), informed: bound.state.chromeInfo ? new Set() : null, controls: bound.state.controls === true, siteLevels: bound.state.siteLevels === true, takeover: bound.state.takeover === true, agents: null };
    this.connections.set(pairingId, connection);
    return connection;
  }
  private async registry() { return Registry.parse(await this.ctx.storage.get('browser.relay.pairings') ?? { pairings: [] }); }
  private async projectPreferences(projectId: string) { return ProjectSettings.parse(await this.ctx.storage.get(`browser.relay.project:${projectId}`) ?? { revision: 0, defaultPairingId: null, approvals: [] }); }
  /** Each pairing's name: its own, else (LEGACY: pairings named before names moved from project approvals to the
   * pairing; remove with `ProjectSettings`' `name`) the first stored approval's, else `Chrome <id prefix>`. */
  private async names(pairings: StoredPairing[]) {
    const legacy = new Map<string, string>();
    if (pairings.some(pairing => !pairing.name)) for (const stored of (await this.ctx.storage.list({ prefix: 'browser.relay.project:' })).values()) {
      for (const approval of ProjectSettings.parse(stored).approvals) if (approval.name && !legacy.has(approval.pairingId)) legacy.set(approval.pairingId, approval.name);
    }
    return (pairing: StoredPairing) => pairing.name ?? legacy.get(pairing.pairingId) ?? `Chrome ${pairing.pairingId.slice(0, 8)}`;
  }
  /** LEGACY: notes were per project approval before each Chrome had one. A pairing without a note takes its current
   * approvals' distinct notes, joined, once; pairings made since start with an empty one. Remove with
   * `ProjectSettings`' `note` once every account's relay has served this release. */
  private async migrateNotes() {
    if ((await this.registry()).pairings.every(pairing => pairing.note !== undefined)) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      const registry = await this.registry(), unnoted = registry.pairings.filter(pairing => pairing.note === undefined);
      if (!unnoted.length) return;
      const notes = new Map<string, string[]>();
      for (const stored of (await this.ctx.storage.list({ prefix: 'browser.relay.project:' })).values()) for (const approval of ProjectSettings.parse(stored).approvals) {
        const note = approval.note?.trim(), current = notes.get(approval.pairingId) ?? [];
        if (note && unnoted.some(pairing => pairing.pairingId === approval.pairingId && pairing.generation === approval.generation) && !current.includes(note)) notes.set(approval.pairingId, [...current, note]);
      }
      for (const pairing of unnoted) pairing.note = (notes.get(pairing.pairingId) ?? []).join('; ').slice(0, 2048).trim();
      await this.ctx.storage.put('browser.relay.pairings', registry);
    });
  }
  /** A Chrome as refusals name it, so the agent can pass its `pairingId` or tell the user which Chrome to open. */
  private describe(pairing: StoredPairing, name: (pairing: StoredPairing) => string) { return `"${name(pairing)}" (${pairing.pairingId}, ${this.connection(pairing.pairingId) ? 'online' : 'offline'})`; }
  async projectSettings(projectId: string) {
    await this.migrateNotes();
    const [preferences, registry] = await Promise.all([this.projectPreferences(projectId), this.registry()]);
    const confirmed = registry.pairings.filter(pairing => pairing.state === 'confirmed'), name = await this.names(confirmed);
    // A default whose Chrome was forgotten, re-paired or reset is no default: the project has none until one is chosen.
    const defaultPairingId = preferences.approvals.some(item => item.pairingId === preferences.defaultPairingId && confirmed.some(pairing => pairing.pairingId === item.pairingId && pairing.generation === item.generation)) ? preferences.defaultPairingId : null;
    return RuntimeProjectBrowserSettingsSchema.parse({ projectId, revision: preferences.revision, defaultPairingId, browsers: confirmed.map(pairing => {
      const approval = preferences.approvals.find(item => item.pairingId === pairing.pairingId && item.generation === pairing.generation);
      return { pairingId: pairing.pairingId, generation: pairing.generation, name: name(pairing), note: pairing.note ?? '', connected: !!this.connection(pairing.pairingId), approved: !!approval, takeover: this.connection(pairing.pairingId)?.takeover === true };
    }) });
  }
  async setProjectSettings(projectId: string, expectedRevision: number, value: RuntimeProjectBrowserPreferences) {
    const preferences = RuntimeProjectBrowserPreferencesSchema.parse(value);
    const ended: string[] = [];
    // Notes this write drops from the project's approvals are on their Chromes first.
    await this.migrateNotes();
    const error = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.projectPreferences(projectId);
      if (current.revision !== expectedRevision) return 'Project Chrome settings revision conflict';
      const registry = await this.registry();
      const approvals: z.infer<typeof ProjectSettings>['approvals'] = [];
      for (const approval of preferences.approvals) {
        const pairing = registry.pairings.find(item => item.pairingId === approval.pairingId && item.state === 'confirmed');
        if (!pairing) return 'Browser fingerprint confirmation required';
        const prior = current.approvals.find(item => item.pairingId === approval.pairingId && item.generation === pairing.generation);
        approvals.push({ pairingId: approval.pairingId, generation: pairing.generation, approvalId: prior?.approvalId ?? crypto.randomUUID() });
      }
      const removed = current.approvals.filter(prior => !approvals.some(next => next.pairingId === prior.pairingId && next.generation === prior.generation));
      // LEGACY: a name this write drops from an approval moves to its unnamed pairing first; remove with
      // `ProjectSettings`' `name`.
      const named = registry.pairings.filter(pairing => !pairing.name && current.approvals.some(item => item.pairingId === pairing.pairingId && item.name));
      for (const pairing of named) pairing.name = current.approvals.find(item => item.pairingId === pairing.pairingId && item.name)?.name;
      await this.ctx.storage.transaction(async tx => {
        await tx.put(`browser.relay.project:${projectId}`, { revision: current.revision + 1, defaultPairingId: preferences.defaultPairingId, approvals });
        if (named.length) await tx.put('browser.relay.pairings', registry);
        if (removed.length) for (const stored of (await tx.list({ prefix: 'browser.account.group:' })).values()) {
          const group = RuntimeAccountBrowserGroupRowSchema.parse(stored), placement = group.placement;
          if (group.projectId === projectId && placement.kind === 'account-relay' && removed.some(item => item.pairingId === placement.pairingId)) {
            await tx.put(`browser.account.revoked:${group.groupId}`, true);
            ended.push(group.groupId);
            await tx.put(`browser.relay.revoke:${placement.pairingId}:${group.groupId}`, { pairingId: placement.pairingId, groupId: group.groupId });
          }
        }
      });
      return null;
    });
    if (error) throw new Error(error);
    for (const groupId of ended) { await this.shareLinks.endGroup(groupId); this.watches.endGroup(groupId); }
    await this.retryRevocations();
    // Approvals changed: each Chrome that takes them hears its approving projects again.
    for (const pairing of (await this.registry()).pairings) this.ctx.waitUntil(this.inform(pairing.pairingId));
    return this.projectSettings(projectId);
  }
  private async approved(projectId: string, pairingId: string, generation: number) {
    const approval = (await this.projectPreferences(projectId)).approvals.find(item => item.pairingId === pairingId && item.generation === generation);
    if (approval) return approval;
    const pairing = (await this.registry()).pairings.find(item => item.pairingId === pairingId);
    throw new Error(`${pairing ? this.describe(pairing, await this.names([pairing])) : `Chrome ${pairingId}`} is not approved for this project. ${APPROVE_HINT}`);
  }
  /** Why a Chrome the project approved cannot take the call now. */
  private offline(pairing: StoredPairing, name: (pairing: StoredPairing) => string, others: StoredPairing[]) {
    const alternatives = others.filter(other => other.pairingId !== pairing.pairingId);
    const why = pairing.extension?.updateRequired ? 'its GitSpace extension is too old to connect. Ask the user to update the extension in that Chrome' : 'its GitSpace extension is not connected. Ask the user to open that Chrome';
    return new Error(`"${name(pairing)}" (${pairing.pairingId}) is approved but offline: ${why}${alternatives.length ? `, or pass another approved pairingId: ${alternatives.map(other => this.describe(other, name)).join(', ')}` : ''}.`);
  }
  private async dispatchApproval(authorization: RuntimeAccountBrowserAuthorization) {
    const { scope, command } = authorization.body, placement = scope.placement;
    if (placement.kind !== 'account-relay') throw new Error('Account relay placement required');
    const approval = await this.approved(scope.projectId, placement.pairingId, placement.generation);
    if (placement.approvalId !== approval.approvalId) throw new Error('Project Chrome approval changed; previous browser authority is revoked');
    const groupId = command.type === 'execute' ? command.grant.body.groupId : command.groupId;
    if (groupId && await this.ctx.storage.get(`browser.account.revoked:${groupId}`)) throw new Error('Browser group revoked');
    return approval;
  }
  /** Starts pairing a Chrome: its short single-use code, which the extension redeems for the pairing's details. */
  async pair(trust: RuntimeBrowserTrust) {
    if (trust.accountId !== this.env.ACCOUNT_ID) throw new Error('Browser pairing account mismatch');
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      const registry = await this.registry();
      registry.pairings = registry.pairings.filter(item => item.state !== 'awaiting-key' || Date.parse(item.expiresAt) > Date.now());
      if (registry.pairings.length >= 32) return null;
      const live = new Set(registry.pairings.flatMap(item => item.state === 'awaiting-key' && item.shortCode ? [item.shortCode] : []));
      let shortCode = shortPairingCode();
      while (live.has(shortCode)) shortCode = shortPairingCode();
      const pairing = Pairing.parse({ pairingId: crypto.randomUUID(), generation: 1, state: 'awaiting-key', code: crypto.randomUUID() + crypto.randomUUID(), expiresAt: new Date(Date.now() + PAIRING_CODE_MS).toISOString(), publicKey: null, trust, note: '', shortCode, misses: 0 });
      registry.pairings.push(pairing); await this.ctx.storage.put('browser.relay.pairings', registry);
      return RuntimeAccountBrowserPairingCodeSchema.parse({ pairingId: pairing.pairingId, code: shortCode, expiresAt: pairing.expiresAt });
    });
    if (!result) throw new Error('Browser pairing capacity reached');
    return result;
  }
  /** The pairing details a short code stands for (public: the extension asks with the code you typed), once. A wrong
   * code counts against the caller's address and network and against every live code; a code tried wrongly
   * `CODE_TRIES.live` times is withdrawn with its pairing. Codes compare in constant time. Text that cannot be a code
   * matches none, so it is refused without counting. */
  async redeemPairingCode(text: string, ip: string, endpoint: string): Promise<{ ok: true; value: RuntimeAccountBrowserPairing } | BrowserRequestFailure> {
    const address = admissionPrefix(ip);
    if (!address) return { ok: false, status: 403, code: 'CLIENT_ADDRESS_REQUIRED', message: 'Client address required' };
    const code = browserPairingCode(text);
    if (!code) return { ok: false, status: 400, code: 'PAIRING_CODE_INVALID', message: 'A pairing code is six letters and digits, like K7P-2QX.' };
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now(), registry = await this.registry();
      const tries = (CodeTries.optional().parse(await this.ctx.storage.get('browser.relay.code-tries')) ?? []).filter(window => now - window.start < PAIRING_CODE_MS);
      const limits = [{ prefix: address.prefix, limit: CODE_TRIES.address }, { prefix: address.network, limit: CODE_TRIES.network }];
      if (limits.some(item => (tries.find(window => window.prefix === item.prefix)?.count ?? 0) >= item.limit)) return { ok: false, status: 429, code: 'PAIRING_CODE_LIMITED', message: 'Too many wrong pairing codes from here. Try again in a few minutes.' };
      let found: Extract<StoredPairing, { state: 'awaiting-key' }> | undefined;
      for (const pairing of registry.pairings) if (pairing.state === 'awaiting-key' && pairing.shortCode && Date.parse(pairing.expiresAt) > now && equalSecret(pairing.shortCode, code)) found = pairing;
      if (found) {
        found.shortCode = null;
        await this.ctx.storage.put('browser.relay.pairings', registry);
        return { ok: true, value: RuntimeAccountBrowserPairingSchema.parse({ code: found.code, pairingId: found.pairingId, generation: found.generation, trust: found.trust, endpoint, expiresAt: found.expiresAt }) };
      }
      for (const item of limits) {
        const window = tries.find(entry => entry.prefix === item.prefix);
        if (window) window.count++;
        else tries.push({ prefix: item.prefix, start: now, count: 1 });
      }
      registry.pairings = registry.pairings.filter(pairing => {
        if (pairing.state !== 'awaiting-key' || !pairing.shortCode || Date.parse(pairing.expiresAt) <= now) return true;
        pairing.misses++;
        return pairing.misses < CODE_TRIES.live;
      });
      await this.ctx.storage.transaction(async tx => {
        await tx.put('browser.relay.code-tries', tries.slice(-1024));
        await tx.put('browser.relay.pairings', registry);
      });
      return { ok: false, status: 404, code: 'PAIRING_CODE_REJECTED', message: 'That code is wrong, used or expired. Get a new one in GitSpace: Plugins → Browsers → Pair a Chrome.' };
    });
  }
  /** A workspace's cloud browser session (`BrowserSessionDO`, by its object name) opened or is still in use (`open`),
   * or closed; the account counts the workspaces whose cloud browser is open. */
  async cloudOpen(session: string, open: boolean) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now(), sessions = Object.fromEntries(Object.entries(CloudSessions.parse(await this.ctx.storage.get('browser.relay.cloud') ?? {})).filter(([name, at]) => name !== session && now - at < CLOUD_OPEN_MS));
      if (open) sessions[session] = now;
      await this.ctx.storage.put('browser.relay.cloud', sessions);
    });
  }
  /** Each pairing as Plugins → Browsers shows it, and how many workspaces have their cloud browser open. */
  async status() {
    await this.migrateNotes();
    const registry = await this.registry(), name = await this.names(registry.pairings), now = Date.now();
    const cloudWorkspaces = Object.values(CloudSessions.parse(await this.ctx.storage.get('browser.relay.cloud') ?? {})).filter(at => now - at < CLOUD_OPEN_MS).length;
    return RuntimeAccountBrowserRelayStatusSchema.parse({ cloudWorkspaces, pairings: await Promise.all(registry.pairings.map(async pairing => {
      // An unconfirmed pairing reports nothing its extension said: its hello could claim anything.
      const confirmed = pairing.state === 'confirmed';
      return { pairingId: pairing.pairingId, generation: pairing.generation, name: name(pairing), note: pairing.note ?? '', state: pairing.state, expiresAt: pairing.expiresAt, pairedKeyFingerprint: pairing.publicKey ? await fingerprint(pairing.publicKey) : null, connected: !!this.connection(pairing.pairingId), extension: pairing.extension ?? null,
        chromeVersion: confirmed ? pairing.chromeVersion ?? null : null, platform: confirmed ? pairing.platform ?? null : null, seenAt: pairing.seenAt ?? null, pairedAt: pairing.pairedAt ?? null, agentsUsing: this.agentsUsing(pairing.pairingId) };
    })) });
  }
  /** Names a paired Chrome or sets its note for agents; each shows wherever the Chrome appears, in every project. */
  async setChrome(pairingId: string, change: { name?: string; note?: string }) {
    const name = change.name === undefined ? undefined : RuntimeBrowserNameSchema.parse(change.name), note = change.note === undefined ? undefined : RuntimeBrowserNoteSchema.parse(change.note);
    await this.migrateNotes();
    const found = await this.ctx.blockConcurrencyWhile(async () => {
      const registry = await this.registry(), pairing = registry.pairings.find(item => item.pairingId === pairingId);
      if (!pairing) return false;
      if (name !== undefined) pairing.name = name;
      if (note !== undefined) pairing.note = note;
      await this.ctx.storage.put('browser.relay.pairings', registry);
      return true;
    });
    if (!found) throw new Error('Unknown browser pairing');
    if (name !== undefined) this.ctx.waitUntil(this.inform(pairingId));
    return this.status();
  }
  async confirm(pairingId: string, expectedFingerprint: string) {
    const confirmed = await this.ctx.blockConcurrencyWhile(async () => {
      const registry = await this.registry(), pairing = registry.pairings.find(item => item.pairingId === pairingId);
      if (!pairing || pairing.state === 'awaiting-key' || !equalSecret(await fingerprint(pairing.publicKey), expectedFingerprint)) return false;
      if (pairing.state === 'pending-confirmation') pairing.pairedAt = new Date().toISOString();
      pairing.state = 'confirmed';
      await this.ctx.storage.put('browser.relay.pairings', registry);
      return true;
    });
    if (!confirmed) throw new Error('Browser fingerprint mismatch');
    // A Chrome confirmed while connected hears about itself now, not at its next hello.
    this.ctx.waitUntil(this.inform(pairingId));
    return this.status();
  }
  /** The Chrome a relay call uses: `pairingId`, else the project default, else the only approved Chrome. Each refusal
   * says what the agent can do about it (pass a pairingId, or ask the user to pair, approve or open a Chrome). */
  async placement(projectId: string, pairingId?: string) {
    const [preferences, registry] = await Promise.all([this.projectPreferences(projectId), this.registry()]);
    const confirmed = registry.pairings.filter(item => item.state === 'confirmed');
    if (!confirmed.length) throw new Error(registry.pairings.some(item => item.state === 'pending-confirmation') ? UNCONFIRMED : NO_CHROME);
    const name = await this.names(confirmed), list = (pairings: StoredPairing[]) => pairings.map(item => this.describe(item, name)).join(', ');
    const approved = confirmed.filter(item => preferences.approvals.some(approval => approval.pairingId === item.pairingId && approval.generation === item.generation));
    if (!approved.length) throw new Error(`No Chrome is approved for this project. Paired: ${list(confirmed)}. ${APPROVE_HINT}`);
    // A default whose Chrome was forgotten, re-paired or reset is no default (as `projectSettings` reports it).
    const fallback = approved.some(item => item.pairingId === preferences.defaultPairingId) ? preferences.defaultPairingId : null;
    const selected = pairingId ?? fallback ?? (approved.length === 1 ? approved[0]?.pairingId : undefined);
    if (!selected) throw new Error(`Several Chromes are approved for this project and none is its default: ${list(approved)}. Pass the pairingId of the one to use.`);
    const pairing = approved.find(item => item.pairingId === selected);
    if (!pairing) throw new Error(`${pairingId ? `Chrome ${pairingId}` : 'The project default Chrome'} is not approved for this project. Approved: ${list(approved)}. Pass one of their pairingIds, or ask the user to approve that Chrome in Plugins → Browsers or in this workspace’s Browser tab.`);
    if (!this.connection(pairing.pairingId)) throw this.offline(pairing, name, approved);
    const approval = await this.approved(projectId, pairing.pairingId, pairing.generation);
    return { kind: 'account-relay' as const, accountId: this.env.ACCOUNT_ID, pairingId: pairing.pairingId, generation: pairing.generation, approvalId: approval.approvalId };
  }
  async unpair(pairingId: string) {
    await this.ctx.blockConcurrencyWhile(async () => { const registry = await this.registry(); registry.pairings = registry.pairings.filter(item => item.pairingId !== pairingId); await this.ctx.storage.put('browser.relay.pairings', registry); this.bound(pairingId)?.socket.close(1008, 'Browser unpaired'); this.disconnect(pairingId); });
    await this.shareLinks.endPairing(pairingId);
    this.watches.endPairing(pairingId);
    return this.status();
  }
  async fetch(request: Request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !/^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.get('origin') ?? '') || new URL(request.url).search) return new Response('Forbidden', { status: 403 });
    const address = admissionPrefix(request.headers.get('cf-connecting-ip') ?? '');
    if (!address) return new Response('Client address required', { status: 403 });
    const { prefix, network } = address;
    const protocol = request.headers.get('sec-websocket-protocol');
    let admissionProof: z.infer<typeof AdmissionProof> | undefined;
    if (protocol) {
      try {
        if (protocol.length > 1024 || !/^gitspace-admission\.[A-Za-z0-9_-]+$/.test(protocol)) return new Response('Invalid admission proof', { status: 403 });
        admissionProof = AdmissionProof.parse(JSON.parse(atob(protocol.slice('gitspace-admission.'.length).replaceAll('-', '+').replaceAll('_', '/'))));
      } catch { return new Response('Invalid admission proof', { status: 403 }); }
    }
    const admission = await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now(), registry = await this.registry();
      if (!registry.pairings.length) return { status: 403 } as const;
      const stored = AdmissionWindows.optional().parse(await this.ctx.storage.get('browser.relay.admission'));
      const windows = stored ?? { prefixes: [], identities: [] };
      windows.prefixes = windows.prefixes.filter(window => now - window.start < 60_000);
      windows.identities = windows.identities.filter(window => now - window.start < 60_000 && registry.pairings.some(pairing => pairing.pairingId === window.pairingId));
      if (admissionProof) {
        const proof = admissionProof, pairing = registry.pairings.find(item => item.pairingId === proof.pairingId);
        if (!pairing || pairing.state !== 'confirmed' || pairing.generation !== proof.generation || proof.issuedAt > now || now - proof.issuedAt > 30_000) return { status: 403 } as const;
        try {
          const key = await crypto.subtle.importKey('raw', browserUnbase64(pairing.publicKey), 'Ed25519', false, ['verify']);
          if (!await crypto.subtle.verify('Ed25519', key, browserUnbase64(proof.signature), new TextEncoder().encode(`gitspace-browser-relay-v2:admission:${proof.pairingId}:${proof.generation}:${proof.issuedAt}:${proof.nonce}`))) return { status: 403 } as const;
        } catch { return { status: 403 } as const; }
        let window = windows.identities.find(item => item.pairingId === pairing.pairingId);
        if (window?.nonces.includes(proof.nonce) || this.bound(pairing.pairingId)) return { status: 403 } as const;
        if (window && window.nonces.length >= 8) return { status: 429 } as const;
        if (!window) { window = { pairingId: pairing.pairingId, start: now, nonces: [] }; windows.identities.push(window); }
        window.nonces.push(proof.nonce);
        // Keep every consumed nonce beyond its proof's lifetime, including late-window arrivals.
        window.start = now;
      } else {
        if (!registry.pairings.some(pairing => pairing.state === 'awaiting-key' && Date.parse(pairing.expiresAt) > now)) return { status: 403 } as const;
        const limits = [{ prefix, limit: 8 }, { prefix: network, limit: 32 }];
        if (limits.some(item => (windows.prefixes.find(window => window.prefix === item.prefix)?.count ?? 0) >= item.limit)) return { status: 429 } as const;
        for (const item of limits) {
          let window = windows.prefixes.find(window => window.prefix === item.prefix);
          if (!window) {
            if (windows.prefixes.length >= 1024) {
              // Never evict the aggregate history protecting a live candidate network.
              const active = new Set(this.candidates().map(({ state }) => state.network));
              const evict = windows.prefixes.findIndex(window => window.prefix !== network && !active.has(window.prefix));
              windows.prefixes.splice(evict, 1);
            }
            window = { prefix: item.prefix, start: now, count: 0 }; windows.prefixes.push(window);
          }
          window.count++;
        }
      }
      await this.ctx.storage.put('browser.relay.admission', windows);
      return { status: 101 } as const;
    });
    if (admission.status !== 101) return new Response('Browser admission rejected', { status: admission.status });
    // Proven identities never compete with the unauthenticated candidate pool.
    const budget = admissionProof ? `identity:${admissionProof.pairingId}` : prefix;
    let pending = 0, aggregate = 0;
    const anonymous = new Map<string, WebSocket[]>();
    for (const { socket, state } of this.candidates()) {
      if (state.budget === budget) pending++;
      if (state.network === network) aggregate++;
      if (state.network) { const entries = anonymous.get(state.network) ?? []; entries.push(socket); anonymous.set(state.network, entries); }
    }
    if (pending >= (admissionProof ? 1 : 4) || (!admissionProof && aggregate >= 16)) return new Response('Browser candidate capacity reached', { status: 429 });
    if (!admissionProof && [...anonymous.values()].reduce((total, entries) => total + entries.length, 0) >= 128) {
      // Bounded memory without letting existing anonymous networks exclude a new one.
      let largest: WebSocket[] = [];
      for (const entries of anonymous.values()) if (entries.length > largest.length) largest = entries;
      largest[0]?.close(1008, 'Browser candidate replaced');
    }
    const [client, socket] = Object.values(new WebSocketPair());
    const nonce = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    socket.serializeAttachment({ nonce, budget, network: admissionProof ? null : network, admittedPairingId: admissionProof?.pairingId ?? null, deadline: Date.now() + PAIRING_DEADLINE_MS } satisfies BrowserSocketState);
    this.ctx.acceptWebSocket(socket, [BROWSER_SOCKET_TAG]);
    socket.send(JSON.stringify({ pairing: 'challenge', serverNonce: nonce }));
    return new Response(null, { status: 101, webSocket: client, ...(protocol ? { headers: { 'sec-websocket-protocol': protocol } } : {}) });
  }
  /** The host relay forwards every message on a socket it `owns`. */
  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    if (this.shareLinks.owns(socket)) return this.shareLinks.message(socket, data).catch(() => closeOpenSocket(socket, 1011, 'Share message failed'));
    if (this.watches.owns(socket)) return this.watches.message(socket, data).catch(() => closeOpenSocket(socket, 1011, 'Watch message failed'));
    try { await this.receive(socket, data); }
    catch { closeOpenSocket(socket, 1008, 'Invalid browser message'); }
  }
  async webSocketClose(socket: WebSocket) {
    // A viewer's leaving reads its socket before the socket closes.
    const left = this.shareLinks.owns(socket) ? this.shareLinks.closed(socket) : this.watches.owns(socket) ? this.watches.closed(socket) : this.release(socket);
    socket.close();
    await left;
  }
  async webSocketError(socket: WebSocket) {
    const left = this.shareLinks.owns(socket) ? this.shareLinks.closed(socket) : this.watches.owns(socket) ? this.watches.closed(socket) : this.release(socket);
    closeOpenSocket(socket, 1011, 'Browser transport error');
    await left;
  }
  /** A Chrome's socket closed: its requests fail and, once it had said hello, its share viewers see it offline. */
  private async release(socket: WebSocket) {
    const state = BrowserSocket.safeParse(socket.deserializeAttachment());
    const pairingId = state.success ? state.data.pairingId : undefined;
    if (!state.success || !pairingId) return;
    if (this.connections.get(pairingId)?.socket === socket) this.disconnect(pairingId);
    if (!state.data.product) return;
    await this.seen(pairingId, false);
    await this.shareLinks.offline(pairingId);
    this.watches.offline(pairingId);
  }
  private async receive(socket: WebSocket, data: string | ArrayBuffer) {
    const state = BrowserSocket.parse(socket.deserializeAttachment());
    if (typeof data !== 'string' || data.length > 2_000_000) throw new Error('Invalid browser frame');
    if (!state.product && state.deadline <= Date.now()) return socket.close(1008, 'Pairing timed out');
    const raw: unknown = JSON.parse(data);
    if (!state.pairingId) {
      if (this.verifying.has(socket)) throw new Error('Pairing unavailable');
      this.verifying.add(socket);
      const proof = Proof.parse(raw);
      if (state.admittedPairingId && proof.pairingId !== state.admittedPairingId) throw new Error('Admission identity mismatch');
      const key = await crypto.subtle.importKey('raw', browserUnbase64(proof.publicKey), 'Ed25519', false, ['verify']);
      if (!await crypto.subtle.verify('Ed25519', key, browserUnbase64(proof.proof), new TextEncoder().encode(`gitspace-browser-relay-v2:client:${state.nonce}:${proof.clientNonce}`))) throw new Error('Invalid pairing signature');
      const accepted = await this.ctx.blockConcurrencyWhile(async () => {
        const registry = await this.registry(), pairing = registry.pairings.find(item => item.pairingId === proof.pairingId);
        if (!pairing || socket.readyState !== 1) return false;
        if (pairing.state === 'awaiting-key') {
          if (Date.parse(pairing.expiresAt) <= Date.now() || !proof.code || !equalSecret(pairing.code, proof.code)) return false;
          registry.pairings = registry.pairings.map(item => item === pairing ? { ...pairing, state: 'pending-confirmation', publicKey: proof.publicKey, code: null, expiresAt: null } : item);
          await this.ctx.storage.put('browser.relay.pairings', registry);
        } else if (!equalSecret(pairing.publicKey, proof.publicKey)) return false;
        if (this.bound(pairing.pairingId)) return false;
        socket.serializeAttachment({ ...state, pairingId: pairing.pairingId } satisfies BrowserSocketState);
        return true;
      });
      if (!accepted) throw new Error('Pairing rejected');
      socket.send(JSON.stringify({ pairing: 'server' }));
      return;
    }
    const message = Reply.parse(raw);
    if (message.hello && message.Browser) {
      const extension = { version: message.extension ?? null, protocol: message.protocol ?? 0, updateRequired: browserExtensionUpdateRequired(message.protocol ?? 0) };
      // The product is `Chrome/<version>` (navigator.userAgent's); extensions 5.8 and later also say their OS.
      await this.recordHello(state.pairingId, { extension, chromeVersion: Number(/^Chrome\/(\d+)/.exec(message.Browser)?.[1]) || undefined, platform: message.platform });
      if (extension.updateRequired) {
        socket.send(JSON.stringify({ updateRequired: { protocol: extension.protocol, minimum: BROWSER_EXTENSION_PROTOCOL - 1 } }));
        return socket.close(1008, 'Extension update required');
      }
      socket.serializeAttachment({ ...state, product: message.Browser.slice(0, 100), ...(message.chromeInfo ? { chromeInfo: true } : {}), ...(message.controls ? { controls: true } : {}), ...(message.siteLevels ? { siteLevels: true } : {}), ...(message.takeover ? { takeover: true } : {}), release: BROWSER_SOCKET_RELEASE } satisfies BrowserSocketState);
      // `groupActivity`: this relay takes each group's colour and agents in the extension's reports; `takeover`: the tabs
      // you hold (`held`) and each agent's tab (`targetId`) too.
      socket.send(JSON.stringify({ ready: true, protocol: BROWSER_EXTENSION_PROTOCOL, groupActivity: true, takeover: true }));
      this.ctx.waitUntil(this.retryRevocations(state.pairingId));
      this.ctx.waitUntil(this.shareLinks.online(state.pairingId).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_share_online_failed', pairingId: state.pairingId, error: String(error) }))));
      this.ctx.waitUntil(this.watches.online(state.pairingId).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_watch_online_failed', pairingId: state.pairingId, error: String(error) }))));
      this.ctx.waitUntil(this.inform(state.pairingId));
      return;
    }
    if (!state.product) throw new Error('Browser hello required');
    const connection = this.connection(state.pairingId);
    if (connection?.socket !== socket) throw new Error('Stale browser connection');
    this.ctx.waitUntil(this.seen(state.pairingId, true));
    if (message.group) {
      const report = message.group;
      if (report.agents) { connection.agents ??= new Map(); if (report.agents.length) connection.agents.set(report.groupId, report.agents.length); else connection.agents.delete(report.groupId); }
      this.ctx.waitUntil(this.groupReported(state.pairingId, report).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_group_report_failed', groupId: report.groupId, error: String(error) }))));
      // Owner watch: viewers of the group learn who holds their tab.
      this.ctx.waitUntil(this.watches.reported(state.pairingId, report.groupId, report.held).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_watch_holders_failed', groupId: report.groupId, error: String(error) }))));
      return;
    }
    if (message.capture) { const announcement = message.capture; this.ctx.waitUntil(this.captureAnnounced(state.pairingId, announcement).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_capture_announcement_failed', captureId: announcement.captureId, error: String(error) })))); return; }
    if (message.shareFrame) {
      const frame = message.shareFrame;
      // Owner watch: frames under a watch's id go to its viewers, not a share's.
      if (this.watches.has(frame.shareId)) return this.watches.frame(state.pairingId, frame);
      this.ctx.waitUntil(this.shareLinks.frame(state.pairingId, frame).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_share_frame_failed', shareId: frame.shareId, error: String(error) }))));
      return;
    }
    if (message.share) {
      const event = message.share;
      if (this.watches.has(event.shareId)) return this.watches.event(state.pairingId, event);
      this.ctx.waitUntil(this.shareLinks.event(state.pairingId, event).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_share_event_failed', shareId: event.shareId, error: String(error) }))));
      return;
    }
    if (message.id !== undefined) { const pending = connection.pending.get(message.id); if (!pending) return; connection.pending.delete(message.id); pending.cancelTimer(); if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result); }
    else if (message.targetId) for (const listener of connection.listeners.get(message.targetId) ?? []) listener(message.fenced ? { method: 'disconnected' } : { method: message.method, params: message.params, sessionId: message.sessionId });
  }
  /** Keeps what a pairing's Chrome said in its hello (extension, Chrome version, OS) and that it was seen now. */
  private async recordHello(pairingId: string, hello: { extension: z.infer<typeof RuntimeBrowserExtensionSchema>; chromeVersion: number | undefined; platform: RuntimeBrowserPlatform | undefined }) {
    this.heardAt.set(pairingId, Date.now());
    await this.ctx.blockConcurrencyWhile(async () => {
      const registry = await this.registry(), pairing = registry.pairings.find(item => item.pairingId === pairingId);
      if (!pairing) return;
      pairing.extension = hello.extension;
      if (hello.chromeVersion) pairing.chromeVersion = hello.chromeVersion;
      if (hello.platform) pairing.platform = hello.platform;
      pairing.seenAt = new Date().toISOString();
      await this.ctx.storage.put('browser.relay.pairings', registry);
    });
  }
  /** A Chrome was heard from: a message on its connection (`recent`), which renews `seenAt` at most every `SEEN_MS`,
   * or its connection closing, which always does. */
  private async seen(pairingId: string, recent: boolean) {
    const now = Date.now();
    if (recent && now - (this.heardAt.get(pairingId) ?? 0) < SEEN_MS) return;
    this.heardAt.set(pairingId, now);
    await this.ctx.blockConcurrencyWhile(async () => {
      const registry = await this.registry(), pairing = registry.pairings.find(item => item.pairingId === pairingId);
      if (!pairing || (recent && pairing.seenAt && now - Date.parse(pairing.seenAt) < SEEN_MS)) return;
      pairing.seenAt = new Date(now).toISOString();
      await this.ctx.storage.put('browser.relay.pairings', registry);
    });
  }
  /** A paired Chrome reported one of its workspace groups. The workspace keeps the tabs, each marked usable when it is
   * on the grant's origins or on the site you consented to by dragging it in, the scripts running there, and from an
   * extension that reports them the group's colour, the agents acting there and the tabs you hold. The agent's refs on
   * a tab you hold no longer apply. */
  private async groupReported(pairingId: string, report: RuntimeBrowserGroupReport) {
    const stored = await this.ctx.storage.get(`browser.account.group:${report.groupId}`);
    if (!stored || await this.ctx.storage.get(`browser.account.revoked:${report.groupId}`)) return;
    const grant = RuntimeAccountBrowserGroupRowSchema.parse(stored), placement = grant.placement;
    if (placement.kind !== 'account-relay' || placement.pairingId !== pairingId) return;
    const pairing = (await this.registry()).pairings.find(item => item.pairingId === pairingId);
    if (!pairing) return;
    for (const holder of report.held ?? []) this.runtime.invalidate(holder.targetId);
    const usable = (url: string, site: string | null) => {
      if (url === 'about:blank') return true;
      try { const { protocol, hostname } = new URL(url); return ['http:', 'https:'].includes(protocol) && [...grant.origins, ...(site ? [site] : [])].some(origin => browserOriginMatches(origin, hostname)); } catch { return false; }
    };
    await this.env.SPACE_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${grant.workspaceId}`).browserGroupReported({ projectId: grant.projectId, workspaceId: grant.workspaceId }, {
      pairingId, browser: (await this.names([pairing]))(pairing), groupId: grant.groupId, groupName: grant.groupName, origins: grant.origins, expiresAt: grant.expiresAt, reportedAt: new Date().toISOString(),
      tabs: report.tabs.map(tab => ({ ...tab, usable: usable(tab.url, tab.site) })), running: report.running, color: report.color ?? null, agents: report.agents ?? [], held: report.held ?? [],
    });
  }
  /** An archived or deleted workspace's groups lose their authority now; each Chrome closes the agent's tabs and lets
   * yours go now or when it next connects. */
  async retireWorkspace(projectId: string, workspaceId: string) {
    const ended: string[] = [];
    await this.ctx.storage.transaction(async tx => {
      for (const stored of (await tx.list({ prefix: 'browser.account.group:' })).values()) {
        const group = RuntimeAccountBrowserGroupRowSchema.parse(stored), placement = group.placement;
        if (group.projectId !== projectId || group.workspaceId !== workspaceId || placement.kind !== 'account-relay' || await tx.get(`browser.account.revoked:${group.groupId}`)) continue;
        await tx.put(`browser.account.revoked:${group.groupId}`, true);
        await tx.put(`browser.relay.revoke:${placement.pairingId}:${group.groupId}`, { pairingId: placement.pairingId, groupId: group.groupId });
        ended.push(group.groupId);
      }
    });
    for (const groupId of ended) { await this.shareLinks.endGroup(groupId); this.watches.endGroup(groupId); }
    await this.retryRevocations();
  }
  /** Tells a Chrome whose extension takes `chromeInfo` (its hello said so; older ones never get it) its name, when you
   * paired it (null for Chromes paired before that was recorded), the names of the projects that approved it, and the
   * project of each of its live workspace groups, for its popup. A project the account no longer lists is left out. */
  private async inform(pairingId: string): Promise<void> {
    const connection = this.connection(pairingId);
    if (!connection?.informed) return;
    try {
      const pairing = (await this.registry()).pairings.find(item => item.pairingId === pairingId && item.state === 'confirmed');
      if (!pairing) return;
      const [projects, settings, rows, revoked] = await Promise.all([this.env.USER_PROJECTS.getByName(this.env.ACCOUNT_ID).list(), this.ctx.storage.list({ prefix: 'browser.relay.project:' }), this.ctx.storage.list({ prefix: 'browser.account.group:' }), this.ctx.storage.list({ prefix: 'browser.account.revoked:' })]);
      const names = new Map(projects.map(project => [project.id, project.name]));
      const approved = [...settings].filter(([, stored]) => ProjectSettings.parse(stored).approvals.some(item => item.pairingId === pairingId && item.generation === pairing.generation)).flatMap(([key]) => names.get(key.slice('browser.relay.project:'.length)) ?? []);
      const live = [...rows.values()].map(stored => RuntimeAccountBrowserGroupRowSchema.parse(stored)).filter(group => group.placement.kind === 'account-relay' && group.placement.pairingId === pairingId && Date.parse(group.expiresAt) > Date.now() && !revoked.has(`browser.account.revoked:${group.groupId}`));
      const groups = live.flatMap(group => { const project = names.get(group.projectId); return project ? [{ groupId: group.groupId, project }] : []; });
      if (this.connection(pairingId) !== connection) return;
      connection.informed = new Set(live.map(group => group.groupId));
      connection.socket.send(JSON.stringify({ operation: 'chromeInfo', name: (await this.names([pairing]))(pairing), pairedAt: pairing.pairedAt ?? null, projects: approved, groups }));
    } catch (error) { console.warn(JSON.stringify({ event: 'browser_chrome_info_failed', pairingId, error: String(error) })); }
  }
  /** A group the Chrome was not told about yet (a new one): it hears `chromeInfo` again before the group's authority. */
  private async informGroup(pairingId: string, connection: Connection, groupId: string): Promise<void> {
    if (connection.informed && !connection.informed.has(groupId)) await this.inform(pairingId);
  }
  private disconnect(pairingId: string) {
    const connection = this.connections.get(pairingId); if (!connection) return; this.connections.delete(pairingId);
    for (const pending of connection.pending.values()) { pending.cancelTimer(); pending.reject(new Error('Browser extension disconnected; effect outcome uncertain')); }
    for (const listeners of connection.listeners.values()) for (const listener of listeners) listener({ method: 'disconnected' });
    for (const [token, run] of this.scripts) if (run.connection === connection) this.dropScript(token, run, 1011, 'Chrome disconnected');
  }
  private request(pairingId: string, command: Record<string, unknown>, timeoutMs = 30_000) {
    const connection = this.connection(pairingId);
    if (!connection) throw new Error('Account Chrome extension is not connected');
    const id = ++connection.sequence, deferred = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => { connection.pending.delete(id); deferred.reject(new Error('Browser relay timeout; effect outcome uncertain')); }, timeoutMs);
    connection.pending.set(id, { ...deferred, cancelTimer: () => clearTimeout(timer) }); connection.socket.send(JSON.stringify({ ...command, id })); return deferred.promise;
  }
  async execute(authorization: RuntimeAccountBrowserAuthorization) {
    const placement = authorization.body.scope.placement;
    if (placement.kind !== 'account-relay') throw new Error('Account relay placement required');
    const pairing = (await this.registry()).pairings.find(item => item.pairingId === placement.pairingId);
    if (!pairing || pairing.state !== 'confirmed') throw new Error('Browser fingerprint confirmation required');
    const body = await verifyRuntimeAccountBrowserAuthorization(authorization, pairing.trust);
    if (placement.generation !== pairing.generation) throw new Error('Browser pairing changed');
    // A workspace's own shares, and a pasted share link, name no Chrome of the call (`SHARE_MANAGEMENT`).
    const anyChrome = authorization.body.command.type === 'manage' && SHARE_MANAGEMENT[authorization.body.command.action] === true;
    if (!anyChrome) await this.dispatchApproval(authorization);
    const name = (await this.names([pairing]))(pairing);
    if (!anyChrome && !this.connection(placement.pairingId)) throw this.offline(pairing, () => name, []);
    const result = await this.runtime.execute(authorization, AbortSignal.timeout(Math.max(1, Date.parse(body.expiresAt) - Date.now())));
    return { ...result, browser: { pairingId: placement.pairingId, name } };
  }
  private async authorize(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal) {
    signal.throwIfAborted(); const placement = authorization.body.scope.placement;
    if (placement.kind !== 'account-relay') throw new Error('Account relay placement required');
    await this.dispatchApproval(authorization);
    const connection = this.connection(placement.pairingId);
    if (!connection) throw new Error('Account Chrome extension is not connected');
    if (!connection.authorized.has(authorization.body.scope.attemptId)) {
      if (authorization.body.command.type === 'execute') {
        const { read, groupId } = authorization.body.command.grant.body;
        if (read && !connection.siteLevels) throw new Error(`${READ_SITES_UPDATE} ${read.join(', ')}`);
        await this.informGroup(placement.pairingId, connection, groupId);
      }
      await this.request(placement.pairingId, { operation: 'authorize', authorization }); connection.authorized.add(authorization.body.scope.attemptId);
    }
    // A single step's download uploads under its attempt while the step's authority lasts.
    const { body } = authorization, now = Date.now();
    if (body.command.type === 'execute' && body.command.args.action !== 'run') {
      for (const [attemptId, step] of this.steps) if (step.deadline <= now) this.steps.delete(attemptId);
      this.steps.set(body.scope.attemptId, { pairingId: placement.pairingId, groupId: body.command.grant.body.groupId, deadline: Math.min(Date.parse(body.expiresAt), Date.parse(body.dispatch.deadlineAt)) });
    }
    return { pairingId: placement.pairingId, connection };
  }
  async tabs(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal) { const { pairingId } = await this.authorize(authorization, signal); const command = authorization.body.command; if (command.type === 'manage') throw new Error('Tabs authorization required'); await this.dispatchApproval(authorization); return this.request(pairingId, { operation: 'tabs', groupId: command.type === 'execute' ? command.grant.body.groupId : command.groupId }); }
  /** One tab's preview (`manage` `preview`). The extension captures only a tab of the group the agent is already
   * using, so a preview never attaches Chrome's debugger on its own. */
  async preview(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal): Promise<z.infer<typeof PreviewReply>> {
    const { scope, command } = authorization.body, placement = scope.placement;
    if (command.type !== 'manage' || command.action !== 'preview' || !command.groupId || !command.targetId || placement.kind !== 'account-relay') throw new Error('Preview authorization required');
    const { pairingId } = await this.authorize(authorization, signal);
    return PreviewReply.parse(await this.request(pairingId, { operation: 'preview', groupId: command.groupId, targetId: command.targetId }));
  }
  /** Stop, Close tab, Focus in Chrome, Take over and Resume agent from the Browser tab on this Chrome's workspace group
   * (`stop`, `closeTab`, `focusTab`, `takeOver`, `resume`), checked and handed to the extension as any management
   * request, and sent only to an extension whose hello said it takes them. */
  async control(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal): Promise<Record<string, never>> {
    const { scope, command } = authorization.body, placement = scope.placement;
    const operation = command.type === 'manage' ? CONTROL_OPERATION[command.action] : undefined;
    if (command.type !== 'manage' || !operation || !command.groupId || (command.action !== 'stop' && !command.targetId) || placement.kind !== 'account-relay') throw new Error('Browser control authorization required');
    const connection = this.connection(placement.pairingId);
    if (!connection?.controls) throw new Error('Update the GitSpace extension in this Chrome to stop, close or focus its tabs from GitSpace');
    if ((operation === 'takeOver' || operation === 'resume') && !connection.takeover) throw new Error('Update the GitSpace extension in this Chrome to 5.10 or later to take over its tabs from GitSpace');
    const { pairingId } = await this.authorize(authorization, signal);
    // The extension matches each field to the signed command, `device` included.
    await this.request(pairingId, { operation, groupId: command.groupId, ...(command.action === 'stop' ? {} : { targetId: command.targetId }), ...(command.action === 'takeOver' ? { device: command.device } : {}) });
    return {};
  }
  /** How many agents use a Chrome now: the scripts and single steps its extension's reports last counted on its
   * groups, or, until its extension reports them (from 5.8, since this object last woke), its running scripts; none
   * while it is offline. */
  agentsUsing(pairingId: string): number {
    const connection = this.connection(pairingId);
    if (!connection) return 0;
    if (connection.agents) return [...connection.agents.values()].reduce((sum, count) => sum + count, 0);
    return [...this.scripts.keys()].filter(token => this.liveScript(token)?.pairingId === pairingId).length;
  }
  /** Records a tab you started capturing from the Browser tab (`captureStart`), or stops a capture on this Chrome,
   * yours from the extension included (`captureStop`). The extension records the tab's screencast frames and uploads
   * them through the upload API; a stop returns once they are in the drive. */
  async capture(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal): Promise<RuntimeBrowserCapture> {
    const { scope, command } = authorization.body, placement = scope.placement;
    if (command.type !== 'manage' || (command.action !== 'captureStart' && command.action !== 'captureStop') || !command.groupId || !command.captureId || placement.kind !== 'account-relay') throw new Error('Capture authorization required');
    const { captureId, groupId } = command, drive = this.drive(scope);
    const registry = await this.registry(), pairing = registry.pairings.find(item => item.pairingId === placement.pairingId);
    if (command.action === 'captureStop') {
      const stored = await this.ctx.storage.get(`${CAPTURE}${captureId}`);
      if (!stored) {
        const capture = await readCapture(drive, captureId);
        if (!capture) throw new Error('Unknown capture');
        return capture.state === 'recording' ? writeCapture(drive, { ...capture, endedAt: new Date().toISOString(), state: 'failed', reason: 'The recording on this Chrome was lost' }) : capture;
      }
      const row = CaptureRow.parse(stored);
      if (row.pairingId !== placement.pairingId || row.projectId !== scope.projectId || row.workspaceId !== scope.workspaceId) throw new Error('Capture outside this Chrome');
      const { pairingId } = await this.authorize(authorization, signal);
      let stopped: z.infer<typeof CaptureStopped>;
      try { stopped = CaptureStopped.parse(await this.request(pairingId, { operation: 'captureStop', captureId }, CAPTURE_STOP_MS)); }
      catch (error) { return await this.finishCapture(captureId, { state: 'failed', reason: error instanceof Error ? error.message : String(error), endedAt: new Date().toISOString(), tracks: {} }) ?? await readCapture(drive, captureId) ?? row.capture; }
      // A video ends with the extension's `end` once its file is in; frames end here.
      if (row.track === 'video') return await readCapture(drive, captureId) ?? row.capture;
      const frames = stopped.count && stopped.width && stopped.height ? { path: 'frames.bin', index: 'frames.json', count: stopped.count, width: stopped.width, height: stopped.height } : undefined;
      return await this.finishCapture(captureId, { state: frames ? 'saved' : 'failed', reason: frames ? null : 'The tab showed nothing to record', endedAt: new Date().toISOString(), tracks: frames ? { frames } : {} }) ?? await readCapture(drive, captureId) ?? row.capture;
    }
    if (!command.targetId) throw new Error('A capture names its tab');
    const group = await this.ctx.storage.get(`browser.account.group:${groupId}`);
    if (!group || await this.ctx.storage.get(`browser.account.revoked:${groupId}`)) throw new Error('This tab’s group has ended');
    const grant = RuntimeAccountBrowserGroupRowSchema.parse(group);
    if (grant.projectId !== scope.projectId || grant.workspaceId !== scope.workspaceId || grant.placement.kind !== 'account-relay' || grant.placement.pairingId !== placement.pairingId) throw new Error('Browser group outside this Chrome');
    const { pairingId } = await this.authorize(authorization, signal);
    const page = CaptureStarted.parse(await this.request(pairingId, { operation: 'captureStart', captureId, groupId, targetId: command.targetId }));
    const startedAt = new Date().toISOString(), browser = pairing ? (await this.names([pairing]))(pairing) : 'Chrome';
    const capture = RuntimeBrowserCaptureSchema.parse({ version: 1, captureId, name: captureName(page.title, startedAt), by: 'you', source: 'relay', browser, target: { groupId, targetId: command.targetId }, page: { url: page.url.slice(0, 8192), title: page.title.slice(0, 500) }, startedAt, endedAt: null, state: 'recording', reason: null, tracks: {} });
    await this.ctx.storage.put(`${CAPTURE}${captureId}`, { pairingId, projectId: scope.projectId, workspaceId: scope.workspaceId, track: 'frames', capture, files: {} } satisfies CaptureRow);
    return writeCapture(drive, capture);
  }
  /** A capture you started in the extension began (`start`: listed as recording from now) or ended (`end`). */
  private async captureAnnounced(pairingId: string, announcement: z.infer<typeof CaptureAnnouncement>): Promise<void> {
    if (announcement.event === 'end') {
      const stored = await this.ctx.storage.get(`${CAPTURE}${announcement.captureId}`);
      if (stored && CaptureRow.parse(stored).pairingId === pairingId) await this.finishCapture(announcement.captureId, { state: announcement.state, reason: announcement.reason?.slice(0, 1024) ?? null, endedAt: announcement.endedAt, tracks: announcement.tracks });
      return;
    }
    if (await this.ctx.storage.get(`${CAPTURE}${announcement.captureId}`)) return;
    const group = await this.ctx.storage.get(`browser.account.group:${announcement.groupId}`);
    if (!group || await this.ctx.storage.get(`browser.account.revoked:${announcement.groupId}`)) return;
    const grant = RuntimeAccountBrowserGroupRowSchema.parse(group), pairing = (await this.registry()).pairings.find(item => item.pairingId === pairingId);
    if (grant.placement.kind !== 'account-relay' || grant.placement.pairingId !== pairingId || !pairing) return;
    const capture = RuntimeBrowserCaptureSchema.parse({ version: 1, captureId: announcement.captureId, name: captureName(announcement.page.title, announcement.startedAt), by: 'you', source: 'relay', browser: (await this.names([pairing]))(pairing),
      target: { groupId: announcement.groupId, targetId: announcement.targetId }, page: { url: announcement.page.url.slice(0, 8192), title: announcement.page.title.slice(0, 500) },
      startedAt: announcement.startedAt, endedAt: null, state: 'recording', reason: null, tracks: {} });
    await this.ctx.storage.put(`${CAPTURE}${announcement.captureId}`, { pairingId, projectId: grant.projectId, workspaceId: grant.workspaceId, track: announcement.track, capture, files: {} } satisfies CaptureRow);
    await writeCapture(this.drive(grant), capture);
  }
  /** Saves a capture once: its tracks are those whose files completed; saved with none, it failed. Null when another
   * stop already saved it. */
  private async finishCapture(captureId: string, outcome: Pick<RuntimeBrowserCapture, 'state' | 'reason' | 'endedAt' | 'tracks'>): Promise<RuntimeBrowserCapture | null> {
    const stored = await this.ctx.storage.get(`${CAPTURE}${captureId}`);
    if (!stored) return null;
    await this.ctx.storage.delete(`${CAPTURE}${captureId}`);
    const row = CaptureRow.parse(stored), { image, frames, video } = outcome.tracks;
    const tracks = {
      ...(image && row.files['image.jpg'] !== undefined ? { image: { ...image, path: 'image.jpg' } } : {}),
      ...(frames && row.files['frames.bin'] !== undefined && row.files['frames.json'] !== undefined ? { frames: { ...frames, path: 'frames.bin', index: 'frames.json' } } : {}),
      ...(video && row.files['video.webm'] !== undefined ? { video: { ...video, path: 'video.webm' } } : {}),
    };
    const saved = outcome.state === 'saved' && Object.keys(tracks).length > 0;
    const reason = saved ? outcome.reason : outcome.reason ?? (outcome.state === 'saved' ? 'The recording’s files did not reach the drive' : 'The recording failed');
    return writeCapture(this.drive(row), { ...row.capture, endedAt: outcome.endedAt ?? new Date().toISOString(), state: saved ? 'saved' : 'failed', reason, tracks: saved ? tracks : {} });
  }
  /** One step of an upload from a Chrome (`browser-upload.ts`). */
  upload(step: BrowserUploadStep) { return this.uploads.step(step); }
  /** A request your Chrome's extension signed with its pairing key to make, end or list its share links. */
  async shareRequest(request: BrowserSignedRequest, body: unknown) {
    const signer = await browserRequestSigner(this.ctx.storage, pairingId => this.signingKey(pairingId), 'share', request);
    return signer.ok ? this.shareLinks.chromeRequest(signer.pairingId, body) : signer;
  }
  /** A workspace's share links, live and ended in the last day, newest first. */
  shares(projectId: string, workspaceId: string): Promise<RuntimeBrowserShare[]> { return this.shareLinks.list(projectId, workspaceId); }
  /** You share a tab of a workspace's Chrome group from its Browser tab: the group must be live on an approved Chrome
   * whose extension shares tabs, and the tab must be in it. */
  async shareCreate(input: { projectId: string; workspaceId: string; groupId: string; targetId: string; comment: boolean; expiresInMinutes: number }): Promise<RuntimeBrowserShare> {
    const group = await this.liveGroup(input.groupId);
    if (!group || group.projectId !== input.projectId || group.workspaceId !== input.workspaceId) throw new Error('This workspace has no live Chrome group with that id');
    await this.approved(input.projectId, group.pairingId, group.generation);
    return this.shareLinks.create(group.pairingId, input, { projectId: input.projectId, workspaceId: input.workspaceId, groupId: input.groupId });
  }
  /** You end one of a workspace's share links. */
  shareRevoke(projectId: string, workspaceId: string, shareId: string): Promise<RuntimeBrowserShare> { return this.shareLinks.revoke(projectId, workspaceId, shareId); }
  /** A share link you pasted into a workspace connects its tab to that workspace's group on its Chrome (`groupId`); with
   * no live group there yet, `needsGroup` names the Chrome to make one on. */
  shareConnect(input: { projectId: string; workspaceId: string; shareId: string; secret: string; groupId?: string }): Promise<{ connected: RuntimeBrowserConnectedTab } | { needsGroup: { pairingId: string } }> { return this.shareLinks.connect(input); }
  /** A share link's greeting, for its secret; null for an unknown share or a wrong secret alike. `owner`: asked by one
   * of the account's devices, which also learn the Chrome's name. */
  sharePreview(shareId: string, secret: string, owner: boolean) { return this.shareLinks.preview(shareId, secret, owner); }
  /** Room for one more viewer of a live share, for its secret. */
  shareJoin(shareId: string, secret: string) { return this.shareLinks.join(shareId, secret); }
  /** A viewer's live socket (`GET /api/shares/<shareId>/live`). */
  shareFetch(request: Request) { return this.shareLinks.accept(request); }
  /** The Watch dialog's socket on one of this account's Chrome tabs, checked by the route (`serveBrowserWatch`). */
  watchFetch(request: Request) { return this.watches.accept(request); }
  /** The host relay's alarm: shares past their expiry end and viewer sockets that never said hello close. */
  alarm() { return this.shareLinks.alarm(); }
  /** The earliest share deadline the host's alarm must wake for; null when none. */
  nextDeadline() { return this.shareLinks.nextDeadline(); }
  /** A workspace group that is neither revoked nor expired, on a Chrome, with that Chrome's pairing. */
  private async liveGroup(groupId: string) {
    const stored = await this.ctx.storage.get(`browser.account.group:${groupId}`);
    if (!stored || await this.ctx.storage.get(`browser.account.revoked:${groupId}`)) return undefined;
    const group = RuntimeAccountBrowserGroupRowSchema.parse(stored), placement = group.placement;
    return placement.kind === 'account-relay' && Date.parse(group.expiresAt) > Date.now() ? { projectId: group.projectId, workspaceId: group.workspaceId, pairingId: placement.pairingId, generation: placement.generation } : undefined;
  }
  async open(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal) {
    const { pairingId, connection } = await this.authorize(authorization, signal);
    const command = authorization.body.command; if (command.type !== 'execute') throw new Error('Browser execution authorization required');
    await this.dispatchApproval(authorization);
    const opened = z.object({ targetId: z.string(), sessionId: z.string() }).parse(await this.request(pairingId, { operation: 'open', grant: command.grant }));
    if (command.args.action !== 'tabs' && command.args.action !== 'run' && command.args.targetId && opened.targetId !== command.args.targetId) throw new Error('Browser target mismatch');
    let listeners = connection.listeners.get(opened.targetId); if (!listeners) { listeners = new Set(); connection.listeners.set(opened.targetId, listeners); }
    const registered = listeners;
    const channel: BrowserChannel = { send: async (method, params = {}, sessionId) => { if (Date.parse(command.grant.body.expiresAt) <= Date.now() || sessionId && sessionId !== opened.sessionId || this.connection(pairingId) !== connection) throw new Error('Browser channel expired or outside session'); await this.dispatchApproval(authorization); return this.request(pairingId, { operation: 'command', targetId: opened.targetId, sessionId: opened.sessionId, method, params }); }, subscribe: listener => { registered.add(listener); return () => { registered.delete(listener); }; }, close: async () => { registered.clear(); } };
    return { targetId: opened.targetId, channel };
  }
  /** Begins a script on a Chrome (`browser.run`, docs/APERTURE-DESIGN.md §6.1). The run's authority is checked as for
   * a single step, the extension stores it by attempt, and the returned token admits the script's CDP connection
   * (`BROWSER_SCRIPT_PATH`) until the run ends or its deadline passes. */
  async scriptBegin(authorization: RuntimeAccountBrowserAuthorization): Promise<{ token: string }> {
    const now = Date.now();
    for (const [token, run] of this.scripts) if (run.deadline <= now) await this.endScript(token, run, 'Script run expired');
    const { scope, command } = authorization.body, placement = scope.placement;
    if (placement.kind !== 'account-relay') throw new Error('Account relay placement required');
    if (command.type !== 'execute' || command.args.action !== 'run') throw new Error('Browser script authorization required');
    const pairing = (await this.registry()).pairings.find(item => item.pairingId === placement.pairingId);
    if (!pairing || pairing.state !== 'confirmed') throw new Error('Browser fingerprint confirmation required');
    const body = await verifyRuntimeAccountBrowserAuthorization(authorization, pairing.trust);
    if (placement.generation !== pairing.generation) throw new Error('Browser pairing changed');
    await this.dispatchApproval(authorization);
    const connection = this.connection(placement.pairingId);
    if (!connection) throw this.offline(pairing, await this.names([pairing]), []);
    const read = command.grant.body.read;
    if (read && !connection.siteLevels) throw new Error(`${READ_SITES_UPDATE} ${read.join(', ')}`);
    const claim = `browser.account.claim:${scope.projectId}:${scope.workspaceId}:${scope.attemptId}`;
    if (await this.ctx.storage.get(claim)) throw new Error('Browser authorization already consumed');
    await this.ctx.storage.put(claim, body.expiresAt);
    await this.runtime.recordGroup(scope, RuntimeAccountBrowserGrantSchema.parse(command.grant.body));
    await this.informGroup(placement.pairingId, connection, command.grant.body.groupId);
    await this.request(placement.pairingId, { operation: 'authorize', authorization });
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    this.scripts.set(token, { authorization, grant: command.grant, pairingId: placement.pairingId, attemptId: scope.attemptId, deadline: Math.min(Date.parse(body.expiresAt), Date.parse(body.dispatch.deadlineAt)), connection });
    return { token };
  }
  /** Ends a script: its CDP connection closes and the extension refuses its attempt from now on, having finished
   * uploading the run's downloads, which are returned (workspace-relative drive paths). */
  async scriptEnd(token: string): Promise<{ downloads: { path: string; size: number; mediaType: string }[]; stopped: string | null }> {
    const run = this.scripts.get(token), taken = this.takenScripts.get(token);
    this.takenScripts.delete(token);
    if (run) await this.endScript(token, run, 'Script ended');
    const attemptId = run?.attemptId ?? taken?.attemptId;
    if (!attemptId) return { downloads: [], stopped: null };
    const downloads: { path: string; size: number; mediaType: string }[] = [];
    for (const [key, stored] of await this.ctx.storage.list({ prefix: `${BROWSER_DOWNLOAD}${attemptId}:` })) {
      const { path, size, mediaType } = BrowserDownloadSchema.parse(stored);
      downloads.push({ path, size, mediaType });
      await this.ctx.storage.delete(key);
    }
    return { downloads, stopped: taken ? SCRIPT_TAKEN_REFUSAL : null };
  }
  /** A script's CDP connection, from its sandbox through `BrowserSessionCdp`: `BROWSER_SCRIPT_PATH<token>/<cursor
   * label>`. Public requests never reach this path (index.ts forwards only `/ws` and `/tunnel/` to the relay object);
   * the token admits one connection, only while its run is live. The script sees the workspace group as a browser,
   * with the ghost cursor on its tabs. */
  async scriptFetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a CDP WebSocket', { status: 426 });
    const [token = '', label = ''] = new URL(request.url).pathname.slice(BROWSER_SCRIPT_PATH.length).split('/');
    const run = this.liveScript(token);
    if (!run || run.browser) return new Response('Unknown or ended script run', { status: 404 });
    const browser = new RelayBrowser({
      product: run.connection.product, grant: run.grant, attemptId: run.attemptId,
      request: async message => {
        if (this.liveScript(token) !== run) throw new Error('The script run ended');
        await this.dispatchApproval(run.authorization);
        try { return await this.request(run.pairingId, message); }
        catch (error) {
          // You took one of its tabs over: the script ends now, its connection closing with why, rather than its
          // Playwright retrying the refused command until it times out.
          if (error instanceof Error && error.message === SCRIPT_TAKEN_REFUSAL && this.scripts.get(token) === run) {
            this.takenScripts.set(token, { attemptId: run.attemptId });
            await this.endScript(token, run, SCRIPT_TAKEN_REFUSAL);
          }
          throw error;
        }
      },
      listen: (targetId, listener) => {
        let listeners = run.connection.listeners.get(targetId);
        if (!listeners) { listeners = new Set(); run.connection.listeners.set(targetId, listeners); }
        const registered = listeners.add(listener);
        return () => { registered.delete(listener); };
      },
    });
    run.browser = browser;
    const shim = await CdpBrowserShim.open(browser);
    if (this.scripts.get(token) !== run) return new Response('Unknown or ended script run', { status: 404 });
    const { socket, response } = serveCdpSocket(shim, { cursor: { label: decodeURIComponent(label).slice(0, 64) || 'Agent' } }, () => { void browser.close(); });
    run.socket = socket;
    return response;
  }
  /** A running script, or none once its run ended, its deadline passed or its Chrome reconnected. */
  private liveScript(token: string): ScriptRun | undefined {
    const run = this.scripts.get(token);
    if (!run) return undefined;
    if (run.deadline > Date.now() && this.connections.get(run.pairingId) === run.connection) return run;
    this.ctx.waitUntil(this.endScript(token, run, 'Script run expired'));
    return undefined;
  }
  private async endScript(token: string, run: ScriptRun, reason: string): Promise<void> {
    this.dropScript(token, run, 1000, reason);
    // The extension refuses the attempt from now on and lets the run's tabs go; they stay in the workspace group.
    if (this.connections.get(run.pairingId) === run.connection) await this.request(run.pairingId, { operation: 'release', attemptId: run.attemptId }, RELEASE_MS).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_script_release_failed', pairingId: run.pairingId, error: String(error) })));
  }
  private dropScript(token: string, run: ScriptRun, code: number, reason: string): void {
    this.scripts.delete(token);
    void run.browser?.close();
    if (run.socket) closeOpenSocket(run.socket, code, reason);
  }
  private async retryRevocations(pairingId?: string) {
    const prefix = pairingId ? `browser.relay.revoke:${pairingId}:` : 'browser.relay.revoke:';
    for (const [key, stored] of await this.ctx.storage.list({ prefix })) {
      const intent = RevocationIntent.parse(stored);
      if (!this.connection(intent.pairingId)) continue;
      try {
        await this.revoke(intent.groupId, intent.pairingId);
        await this.ctx.storage.delete(key);
      } catch { /* Authority stays revoked; retain the durable closure intent for the next hello. */ }
    }
  }
  /** A workspace group was revoked: shares of its tabs end, and its Chrome, when connected, lets the group go. */
  async revoke(groupId: string, pairingId: string) {
    await this.shareLinks.endGroup(groupId);
    this.watches.endGroup(groupId);
    if (this.connection(pairingId)) await this.request(pairingId, { operation: 'revoke', groupId });
  }
}
