import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  BROWSER_SHARE_PER_CHROME, BROWSER_SHARE_VIEWERS, RuntimeBrowserPageCommentSchema, RuntimeBrowserShareAuditSchema, RuntimeBrowserShareBoxSchema,
  RuntimeBrowserShareChromeRequestSchema, RuntimeBrowserShareEndSchema, RuntimeBrowserShareExpirySchema, RuntimeBrowserShareJoinSchema, RuntimeBrowserShareNameSchema,
  RuntimeBrowserSharePointSchema, RuntimeBrowserShareSchema, RuntimeBrowserShareTargetSchema, RuntimeBrowserShareViewerMessageSchema, RuntimeBrowserShareViewerSchema,
  browserSharePointerColor, browserUnbase64,
  type RuntimeBrowserConnectedTab, type RuntimeBrowserPageComment, type RuntimeBrowserShare, type RuntimeBrowserShareAudit, type RuntimeBrowserSharePreview,
  type RuntimeBrowserShareServerMessage, type RuntimeBrowserShareViewer, type RuntimeBrowserShareViewerMessage,
} from '@gitspace/protocol-runtime';
import { accountAccessResponse, activeAccount } from './account-access.js';
import { browserRouteReply, readBrowserSignedRequest, type BrowserRequestFailure } from './browser-upload.js';
import { DEVICE_AUTHORITY_UNAVAILABLE, withDeviceAuthority } from './device-authority.js';
import { openToken, sealToken, type SealedTokenKind } from './sealed-token.js';
import type { WorkspaceDrive } from './workspace-drive.js';

/**
 * Share links (docs/APERTURE-DESIGN.md §8, B1): a tab on your Chrome, watched through `<account>/s/<shareId>#<secret>`.
 * The relay object keeps each share (`browser.relay.share:<shareId>`, with its secret, so its link can be copied again),
 * its audit and the comments made on it. Viewers' live sockets hibernate with the relay, each holding its viewer in its
 * attachment. While anyone watches, the extension streams the tab's frames over its relay socket and draws the viewers'
 * named pointers; on a comment share it also says what is under a point, and each comment lands in the share's
 * workspace: its crop in the drive, the comment in the workspace's runtime storage.
 */

/** The first extension protocol that shares tabs. */
export const SHARE_PROTOCOL = 6;
/** Where your Chrome's extension makes, ends and lists its shares, signed with its pairing key. */
export const BROWSER_SHARE_PATH = '/api/browser-relay/shares';
const UPDATE_REQUIRED = 'Update the GitSpace extension in Chrome to share tabs';
const VIEW_ONLY = 'This share is view-only: you can watch and point';
const SHARE = 'browser.relay.share:';
const AUDIT = 'browser.relay.share-audit:';
const COMMENT = 'browser.relay.share-comment:';
/** Where comment crops land in the workspace's drive. */
const CROPS = 'browser/comments/';
/** Every viewer socket has this tag and `share-viewer:<shareId>`. */
const VIEWER_TAG = 'share-viewer';
/** A viewer socket says hello within this long. */
const HELLO_MS = 10_000;
/** A join's token opens the live socket within this long. */
const TOKEN_MS = 5 * 60_000;
/** Pointers reach the extension, and the viewer list the viewers, at most once per this long. */
const POINTERS_MS = 100;
const AUDIT_KEPT = 200;
const COMMENTS_KEPT = 100;
/** Ended shares stay listed, then are forgotten, after this long. */
const ENDED_KEPT_MS = 24 * 60 * 60_000;
const LISTED = 50;
/** The largest frame the extension is asked for, in each dimension. */
const FRAME_MAX = 1280;
const CROP_MAX_BYTES = 400 * 1024;
const VIEWER_MESSAGE_MAX = 16 * 1024;
const SHARE_ROUTE = /^\/api\/shares\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(preview|join|live)$/u;
const SHARE_VIEWER: SealedTokenKind = { scope: 'share-viewer:v1', context: 'gitspace-share-viewer-v1' };
const JOIN_BODY_BYTES = 4096;

/** CSS pixels as the extension measures them, whole and at least one. */
const pixels = z.number().positive().transform(value => Math.max(1, Math.round(value)));
const Page = z.object({ url: z.string(), title: z.string() });
const Viewport = z.object({ width: pixels, height: pixels });
const ShareWorkspace = z.object({ projectId: z.string(), workspaceId: z.string(), groupId: z.string().uuid() });
type ShareWorkspace = z.infer<typeof ShareWorkspace>;
const ShareRecord = z.object({
  shareId: z.string().uuid(), secret: z.string(), pairingId: z.string().uuid(), targetId: z.string(), workspace: ShareWorkspace.nullable(),
  page: Page, viewport: Viewport.nullable(), comment: z.boolean(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(), endReason: RuntimeBrowserShareEndSchema.nullable(),
});
type ShareRecord = z.infer<typeof ShareRecord>;
type ShareEnd = NonNullable<ShareRecord['endReason']>;
type Point = z.infer<typeof RuntimeBrowserSharePointSchema>;
/** A viewer socket's attachment: its id (per-socket state in memory is keyed by it: each event may hand over a new
 * object for the same socket), its share, and once it said hello its viewer, pointer and screen area. */
const ViewerSocket = z.object({ socketId: z.string().uuid(), shareId: z.string().uuid(), deadline: z.number(), viewer: RuntimeBrowserShareViewerSchema.nullable(), at: RuntimeBrowserSharePointSchema.nullable(), size: Viewport.nullable() });
type ViewerSocket = z.infer<typeof ViewerSocket>;
/** What a join's sealed token holds. */
const ShareViewerToken = z.object({ shareId: z.string().uuid(), viewerId: z.string().uuid(), name: RuntimeBrowserShareNameSchema, guest: z.boolean(), expiresAt: z.iso.datetime() });
type ShareViewerToken = z.infer<typeof ShareViewerToken>;
/** The extension's answers. */
const SharedTab = z.object({ url: z.string(), title: z.string(), groupId: z.string().uuid().nullable() });
const Watched = z.object({ url: z.string(), title: z.string(), width: pixels, height: pixels });
const Hit = z.object({ target: RuntimeBrowserShareTargetSchema.nullable() });
const Anchor = z.object({ page: Page, target: RuntimeBrowserShareTargetSchema.nullable(), region: RuntimeBrowserShareBoxSchema, viewport: Viewport, scroll: z.object({ x: z.number(), y: z.number() }), crop: z.string().nullable() });
/** One JPEG frame of a shared tab, from the extension (`{shareFrame}`). */
export const BrowserShareFrameSchema = z.object({ shareId: z.string().uuid(), data: z.string().max(1_500_000), width: z.number().int().positive(), height: z.number().int().positive() });
/** A shared tab's page changed, or the tab closed (`{share}` from the extension). */
export const BrowserShareEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('page'), shareId: z.string().uuid(), url: z.string(), title: z.string(), width: pixels, height: pixels }),
  z.object({ event: z.literal('closed'), shareId: z.string().uuid() }),
]);
/** A join as the relay answers it; the route seals the viewer's token. */
export type BrowserShareJoin = { status: 'ok'; viewerId: string; expiresAt: string } | { status: 'unknown' } | { status: 'ended' } | { status: 'full' };
type ShareReply = { ok: true; value: Record<string, unknown> } | BrowserRequestFailure;

/** What shares need from the relay object holding them: its Chromes, workspace groups and workspaces. */
export type BrowserShareHost = {
  /** A confirmed Chrome: its name, generation and the protocol its extension last reported. */
  pairing(pairingId: string): Promise<{ name: string; generation: number; protocol: number } | undefined>;
  /** Whether the Chrome's extension is connected now. */
  online(pairingId: string): boolean;
  /** A command to the Chrome's extension, answered with its result. */
  request(pairingId: string, command: Record<string, unknown>): Promise<unknown>;
  /** A message to the Chrome's extension that has no answer; dropped while it is offline. */
  notify(pairingId: string, message: Record<string, unknown>): void;
  /** A workspace group neither revoked nor expired, with the Chrome it is on. */
  group(groupId: string): Promise<{ projectId: string; workspaceId: string; pairingId: string } | undefined>;
  /** Throws, saying why, unless the Chrome at its current pairing is approved for the project. */
  approved(projectId: string, pairingId: string): Promise<void>;
  /** Keeps a page comment in its workspace. */
  commented(workspace: { projectId: string; workspaceId: string }, comment: RuntimeBrowserPageComment): Promise<void>;
  /** The workspace's drive, for comment crops. */
  drive(workspace: { projectId: string; workspaceId: string }): Pick<WorkspaceDrive, 'write'>;
};
/** What shares need from the account: its origin for links, its name, and the viewer tokens its joins sealed. */
export type BrowserShareAccount = { url: string; name(): Promise<string>; viewer(token: string): Promise<ShareViewerToken | null> };

export function equalSecret(left: string, right: string) { const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right); return a.length === b.length && timingSafeEqual(a, b); }
export function closeOpenSocket(socket: WebSocket, code: number, reason: string) { if (socket.readyState === 1) socket.close(code, reason); }
function iso(ms: number) { return new Date(ms).toISOString(); }
function described(error: unknown) { return error instanceof Error ? error.message : String(error); }
function refusal(status: number, code: string, message: string): BrowserRequestFailure { return { ok: false, status, code, message }; }

/** The account's display name from its settings, or null while none is set. */
async function accountDisplayName(env: Env): Promise<string | null> {
  return (await env.USER_SETTINGS.getByName(env.ACCOUNT_ID).get('share-link')).profile.displayName.trim() || null;
}

/** The account as the relay's shares see it: links on `ACCOUNT_URL`, shared by its display name (else its handle). */
export function browserShareAccount(env: Env): BrowserShareAccount {
  return {
    url: env.ACCOUNT_URL,
    name: async () => (await accountDisplayName(env))?.slice(0, 128) ?? env.TENANT_ID,
    viewer: async token => {
      try { return ShareViewerToken.parse(await openToken(env, SHARE_VIEWER, token)); } catch { return null; }
    },
  };
}

/**
 * The share routes, public before device authority: `POST /api/shares/<shareId>/preview` (the greeting, for the secret),
 * `POST /api/shares/<shareId>/join` (a viewer's token; signed by one of the account's devices, its owner joins under the
 * account's name, not as a guest), `GET /api/shares/<shareId>/live` (the viewer's socket, to the relay object), and
 * `POST BROWSER_SHARE_PATH`, your Chrome's signed requests. An unknown share and a wrong secret get the same answer.
 */
export async function serveBrowserShare(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), relay = env.RELAY.getByName(env.RELAY_NAME);
  if (url.pathname === BROWSER_SHARE_PATH) {
    const read = await readBrowserSignedRequest(request, 'share');
    return browserRouteReply(read.ok ? await relay.browserRelayShare(read.request, read.body) : read);
  }
  const unknown = refusal(404, 'SHARE_UNKNOWN', 'This share link is unknown or its secret is wrong');
  const route = SHARE_ROUTE.exec(url.pathname);
  if (!route) return browserRouteReply(unknown);
  const denied = accountAccessResponse(await activeAccount(env, env.ACCOUNT_ID));
  if (denied) return denied;
  const [, shareId = '', action] = route;
  if (action === 'live') return relay.fetch(request);
  if (request.method !== 'POST') return browserRouteReply(refusal(405, 'METHOD_NOT_ALLOWED', 'Send this with POST'));
  const bytes = new Uint8Array(await request.arrayBuffer());
  let body: unknown;
  try {
    if (bytes.byteLength > JOIN_BODY_BYTES) throw new Error('Too large');
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch { return browserRouteReply(refusal(400, 'SHARE_INVALID', `Send at most ${JOIN_BODY_BYTES} bytes of JSON`)); }
  if (action === 'preview') {
    const secret = z.object({ secret: z.string().max(128) }).safeParse(body);
    const preview = secret.success ? await relay.browserSharePreview(shareId, secret.data.secret) : null;
    return browserRouteReply(preview ? { ok: true, value: preview } : unknown);
  }
  const join = RuntimeBrowserShareJoinSchema.safeParse(body);
  if (!join.success) return browserRouteReply(refusal(400, 'SHARE_INVALID', 'A join names the secret and your name'));
  let name = join.data.name, guest = true;
  const device = request.headers.get('x-gitspace-device');
  if (device !== null) {
    const auth = await withDeviceAuthority(env, (view, now) => view.authorizeRequest({ header: device, method: 'POST', target: `${url.pathname}${url.search}`, body: bytes, capabilities: [], accountScope: true }, now));
    if (auth.status === 'error') return Response.json(auth, { status: auth.error.code === DEVICE_AUTHORITY_UNAVAILABLE ? 503 : 401 });
    name = (await accountDisplayName(env))?.slice(0, 60).trim() || name;
    guest = false;
  }
  const joined = await relay.browserShareJoin(shareId, join.data.secret);
  const refused: Record<Exclude<BrowserShareJoin['status'], 'ok'>, BrowserRequestFailure> = {
    unknown, ended: refusal(410, 'SHARE_ENDED', 'This share has ended'), full: refusal(429, 'SHARE_FULL', `This share is full: ${BROWSER_SHARE_VIEWERS} people are watching`),
  };
  if (joined.status !== 'ok') return browserRouteReply(refused[joined.status]);
  const viewer: ShareViewerToken = { shareId, viewerId: joined.viewerId, name, guest, expiresAt: joined.expiresAt };
  const token = await sealToken(env, SHARE_VIEWER, viewer);
  return browserRouteReply({ ok: true, value: { token, viewerId: viewer.viewerId, name, guest, expiresAt: viewer.expiresAt } });
}

/** The relay object's shares: records, viewer sockets, and what passes between viewers and the Chrome. */
export class BrowserShares {
  /** The frame size each watched share last asked of its extension; forgotten when its Chrome disconnects. */
  private readonly watching = new Map<string, { width: number; height: number }>();
  /** Each share's pointer and viewer broadcasts, at most one per `POINTERS_MS`. */
  private readonly throttles = new Map<string, { last: number; pending: boolean }>();
  /** A viewer socket's hit test in flight, and the latest point asked while it runs. */
  private readonly hits = new Map<string, { next: Point | null }>();
  /** A viewer socket's hello being checked: the object takes other messages while it awaits the token's key, and a
   * viewer sends its size and pointer right after hello, so those wait for it. */
  private readonly helloing = new Map<string, Promise<void>>();
  constructor(private readonly ctx: DurableObjectState, private readonly host: BrowserShareHost, private readonly account: BrowserShareAccount) {}

  /** Whether the host's socket is a viewer's. */
  owns(socket: WebSocket) { return this.ctx.getTags(socket).includes(VIEWER_TAG); }

  /** Shares a tab of a Chrome, from its extension or, for a tab in `workspace`'s group, from that workspace's Browser tab. */
  async create(pairingId: string, input: { targetId: string; comment: boolean; expiresInMinutes: number }, workspace?: ShareWorkspace): Promise<RuntimeBrowserShare> {
    const minutes = RuntimeBrowserShareExpirySchema.safeParse(input.expiresInMinutes);
    if (!minutes.success) throw new Error('A share lasts 15 minutes, 1 hour, 8 hours or 24 hours');
    const pairing = await this.ready(pairingId);
    if ((await this.live(pairingId)).length >= BROWSER_SHARE_PER_CHROME) throw new Error(`"${pairing.name}" already shares ${BROWSER_SHARE_PER_CHROME} tabs; stop one of them first`);
    const tab = SharedTab.parse(await this.host.request(pairingId, { operation: 'shareTab', targetId: input.targetId }));
    if (!/^https?:\/\//u.test(tab.url)) throw new Error('Only web pages (http or https) can be shared');
    const group = tab.groupId ? await this.host.group(tab.groupId) : undefined;
    const held = tab.groupId && group?.pairingId === pairingId ? { projectId: group.projectId, workspaceId: group.workspaceId, groupId: tab.groupId } : null;
    if (workspace && (!held || held.groupId !== workspace.groupId || held.projectId !== workspace.projectId || held.workspaceId !== workspace.workspaceId)) throw new Error('This tab is not in the workspace’s group on that Chrome');
    if (input.comment && !held) throw new Error('Comments need the tab in a workspace group');
    const now = Date.now();
    const record: ShareRecord = {
      shareId: crypto.randomUUID(), secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'), pairingId, targetId: input.targetId, workspace: held,
      page: { url: tab.url.slice(0, 8192), title: tab.title.slice(0, 500) }, viewport: null, comment: input.comment,
      createdAt: iso(now), expiresAt: iso(now + minutes.data * 60_000), endedAt: null, endReason: null,
    };
    await this.ctx.storage.put(`${SHARE}${record.shareId}`, record);
    await this.audit(record.shareId, 'created', 'you', false, `${input.comment ? 'View, point and comment' : 'View and point'} for ${minutes.data} minutes`);
    await this.publish(pairingId);
    await this.schedule();
    return this.view(record);
  }

  /** A request your Chrome's extension signed (`BROWSER_SHARE_PATH`): make a share, end one of its own, or list its live shares. */
  async chromeRequest(pairingId: string, body: unknown): Promise<ShareReply> {
    const parsed = RuntimeBrowserShareChromeRequestSchema.safeParse(body);
    if (!parsed.success) return refusal(400, 'SHARE_INVALID', `Invalid share request: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
    const input = parsed.data;
    if (input.op === 'list') return { ok: true, value: { shares: await Promise.all((await this.live(pairingId)).map(record => this.view(record))) } };
    if (input.op === 'revoke') {
      const record = await this.current(input.shareId);
      if (!record || record.pairingId !== pairingId) return refusal(404, 'SHARE_UNKNOWN', 'Unknown share');
      return { ok: true, value: { share: await this.view(await this.end(record, 'revoked', 'you')) } };
    }
    try { return { ok: true, value: { share: await this.create(pairingId, input) } }; }
    catch (error) { return refusal(409, 'SHARE_REFUSED', described(error)); }
  }

  /** A workspace's shares: live, and ended in the last day; newest first. */
  async list(projectId: string, workspaceId: string): Promise<RuntimeBrowserShare[]> {
    const since = Date.now() - ENDED_KEPT_MS;
    const records = (await this.records()).filter(record => record.workspace?.projectId === projectId && record.workspace.workspaceId === workspaceId && (!record.endedAt || Date.parse(record.endedAt) > since));
    return Promise.all(records.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, LISTED).map(record => this.view(record)));
  }

  /** You end one of a workspace's shares. */
  async revoke(projectId: string, workspaceId: string, shareId: string): Promise<RuntimeBrowserShare> {
    const record = await this.current(shareId);
    if (!record || record.workspace?.projectId !== projectId || record.workspace.workspaceId !== workspaceId) throw new Error('Unknown share');
    return this.view(await this.end(record, 'revoked', 'you'));
  }

  /** A share link you pasted into a workspace: its tab joins that workspace's group on its Chrome (`groupId`), and its
   * comments land there from now on. Without a live group of the workspace on that Chrome, `needsGroup` names the
   * Chrome to make one on. */
  async connect(input: { projectId: string; workspaceId: string; shareId: string; secret: string; groupId?: string }): Promise<{ connected: RuntimeBrowserConnectedTab } | { needsGroup: { pairingId: string } }> {
    const record = await this.current(input.shareId);
    if (!record || !equalSecret(record.secret, input.secret)) throw new Error('This share link is unknown or its secret is wrong');
    if (record.endedAt) throw new Error('This share has ended');
    await this.host.approved(input.projectId, record.pairingId);
    const pairing = await this.ready(record.pairingId);
    const group = input.groupId ? await this.host.group(input.groupId) : undefined;
    if (!input.groupId || !group) return { needsGroup: { pairingId: record.pairingId } };
    if (group.projectId !== input.projectId || group.workspaceId !== input.workspaceId || group.pairingId !== record.pairingId) throw new Error('That group is not this workspace’s group on the shared tab’s Chrome');
    const adopted = Page.parse(await this.host.request(record.pairingId, { operation: 'adoptTab', groupId: input.groupId, targetId: record.targetId }));
    const page = { url: adopted.url.slice(0, 8192), title: adopted.title.slice(0, 500) };
    const latest = await this.current(record.shareId);
    if (!latest || latest.endedAt) throw new Error('This share has ended');
    await this.ctx.storage.put(`${SHARE}${record.shareId}`, { ...latest, workspace: { projectId: input.projectId, workspaceId: input.workspaceId, groupId: input.groupId }, page } satisfies ShareRecord);
    await this.audit(record.shareId, 'connected', 'you', false, `Workspace ${input.workspaceId}`);
    await this.publish(record.pairingId);
    return { connected: { pairingId: record.pairingId, browser: pairing.name, groupId: input.groupId, targetId: record.targetId, ...page } };
  }

  /** The greeting before anyone joins; null for an unknown share or a wrong secret alike. */
  async preview(shareId: string, secret: string): Promise<RuntimeBrowserSharePreview | null> {
    const record = await this.current(shareId);
    return record && equalSecret(record.secret, secret) ? this.greeting(record) : null;
  }

  /** A viewer may join a live share with room: their id and when the token the route seals for them lapses. */
  async join(shareId: string, secret: string): Promise<BrowserShareJoin> {
    const record = await this.current(shareId);
    if (!record || !equalSecret(record.secret, secret)) return { status: 'unknown' };
    if (record.endedAt) return { status: 'ended' };
    if (this.viewers(shareId).length >= BROWSER_SHARE_VIEWERS) return { status: 'full' };
    return { status: 'ok', viewerId: crypto.randomUUID(), expiresAt: iso(Date.now() + TOKEN_MS) };
  }

  /** A viewer's live socket (`GET /api/shares/<shareId>/live`), for a live share: it says hello with its token next. */
  async accept(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const shareId = SHARE_ROUTE.exec(new URL(request.url).pathname)?.[1];
    const record = shareId ? await this.current(shareId) : undefined;
    if (!record || record.endedAt) return new Response('Unknown or ended share', { status: 404 });
    // Sockets yet to say hello count too, so the share's sockets stay bounded.
    if (this.sockets(record.shareId).length >= 2 * BROWSER_SHARE_VIEWERS) return new Response('This share is full', { status: 429 });
    const [client, socket] = Object.values(new WebSocketPair());
    socket.serializeAttachment({ socketId: crypto.randomUUID(), shareId: record.shareId, deadline: Date.now() + HELLO_MS, viewer: null, at: null, size: null } satisfies ViewerSocket);
    this.ctx.acceptWebSocket(socket, [VIEWER_TAG, `${VIEWER_TAG}:${record.shareId}`]);
    await this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A message on a viewer's socket. */
  async message(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const { socketId } = ViewerSocket.parse(socket.deserializeAttachment());
    await this.helloing.get(socketId);
    const state = ViewerSocket.parse(socket.deserializeAttachment());
    let message: RuntimeBrowserShareViewerMessage;
    try {
      if (typeof data !== 'string' || data.length > VIEWER_MESSAGE_MAX) throw new Error('Invalid share message');
      message = RuntimeBrowserShareViewerMessageSchema.parse(JSON.parse(data));
    } catch { return closeOpenSocket(socket, 1008, 'Invalid share message'); }
    if (!state.viewer) {
      const hello = this.hello(socket, state, message);
      this.helloing.set(socketId, hello);
      try { return await hello; } finally { if (this.helloing.get(socketId) === hello) this.helloing.delete(socketId); }
    }
    const viewer = state.viewer, record = await this.current(state.shareId);
    if (!record || record.endedAt) {
      if (record?.endReason) this.send(socket, { type: 'ended', reason: record.endReason });
      return closeOpenSocket(socket, 1000, 'Share ended');
    }
    if (message.type === 'hello') return this.send(socket, { type: 'error', message: 'You already joined this share' });
    // Other messages may have changed the attachment while this one awaited the share.
    const latest = ViewerSocket.parse(socket.deserializeAttachment());
    if (message.type === 'pointer') { socket.serializeAttachment({ ...latest, at: message.at } satisfies ViewerSocket); return this.changed(record); }
    if (message.type === 'size') { socket.serializeAttachment({ ...latest, size: { width: message.width, height: message.height } } satisfies ViewerSocket); return this.watch(record); }
    if (!record.comment) return this.send(socket, { type: 'error', message: VIEW_ONLY });
    if (message.type === 'hit') return this.hit(socket, socketId, record, message.at);
    return this.comment(socket, viewer, record, message);
  }

  /** A viewer's socket closed: they left. */
  async closed(socket: WebSocket): Promise<void> {
    const state = ViewerSocket.safeParse(socket.deserializeAttachment());
    if (!state.success) return;
    this.hits.delete(state.data.socketId);
    this.helloing.delete(state.data.socketId);
    if (!state.data.viewer) return;
    const viewer = state.data.viewer, record = await this.current(state.data.shareId);
    if (!record || record.endedAt) return;
    await this.audit(record.shareId, 'left', viewer.name, viewer.guest, null);
    this.changed(record, socket);
    await this.publish(record.pairingId);
    await this.watch(record, socket);
  }

  /** A frame of a shared tab, from its Chrome, for everyone watching. */
  async frame(pairingId: string, frame: z.infer<typeof BrowserShareFrameSchema>): Promise<void> {
    const viewers = this.viewers(frame.shareId);
    if (!viewers.length) return;
    const record = await this.current(frame.shareId);
    if (!record || record.endedAt || record.pairingId !== pairingId) return;
    const text = JSON.stringify({ type: 'frame', data: frame.data, width: frame.width, height: frame.height } satisfies RuntimeBrowserShareServerMessage);
    for (const { socket } of viewers) if (socket.readyState === 1) socket.send(text);
  }

  /** A shared tab's page changed, or the tab closed (which ends the share). */
  async event(pairingId: string, event: z.infer<typeof BrowserShareEventSchema>): Promise<void> {
    const record = await this.current(event.shareId);
    if (!record || record.endedAt || record.pairingId !== pairingId) return;
    if (event.event === 'closed') { await this.end(record, 'closed', (await this.host.pairing(pairingId))?.name ?? 'Chrome'); return; }
    await this.pageChanged(record.shareId, event);
  }

  /** A Chrome said hello: its viewers learn it is back, it learns its shares, and watched shares stream again. */
  async online(pairingId: string): Promise<void> {
    if (((await this.host.pairing(pairingId))?.protocol ?? 0) < SHARE_PROTOCOL) return;
    const live = await this.live(pairingId);
    for (const record of live) for (const { socket } of this.viewers(record.shareId)) this.send(socket, { type: 'presence', online: true });
    await this.publish(pairingId);
    for (const record of live) { this.watching.delete(record.shareId); await this.watch(record); }
  }

  /** A Chrome disconnected: its viewers see it offline, and its watches are asked again when it is back. */
  async offline(pairingId: string): Promise<void> {
    for (const record of await this.live(pairingId)) {
      this.watching.delete(record.shareId);
      for (const { socket } of this.viewers(record.shareId)) this.send(socket, { type: 'presence', online: false });
    }
  }

  /** The Chrome was unpaired: its shares end as revoked. */
  async endPairing(pairingId: string): Promise<void> {
    for (const record of await this.live(pairingId)) await this.end(record, 'revoked', 'you');
  }

  /** A workspace group ended (revoked, or its workspace retired): shares of its tabs end as closed. */
  async endGroup(groupId: string): Promise<void> {
    for (const record of await this.records()) if (!record.endedAt && record.workspace?.groupId === groupId) await this.end(record, 'closed', 'you');
  }

  /** The relay's alarm: shares past their expiry end, ended shares older than a day are forgotten, and sockets that
   * never said hello close. */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const record of await this.records()) if (record.endedAt && Date.parse(record.endedAt) <= now - ENDED_KEPT_MS) await this.forget(record.shareId);
    for (const { socket, state } of this.sockets()) if (!state.viewer && state.deadline <= now) socket.close(1008, 'Share hello timed out');
    await this.schedule();
  }

  private async hello(socket: WebSocket, state: ViewerSocket, message: RuntimeBrowserShareViewerMessage): Promise<void> {
    if (message.type !== 'hello' || state.deadline <= Date.now()) return closeOpenSocket(socket, 1008, 'Share hello required');
    const token = await this.account.viewer(message.token);
    if (!token || token.shareId !== state.shareId || Date.parse(token.expiresAt) <= Date.now()) return closeOpenSocket(socket, 1008, 'Invalid share token');
    const record = await this.current(state.shareId);
    if (!record) return closeOpenSocket(socket, 1008, 'Unknown share');
    if (record.endedAt) {
      if (record.endReason) this.send(socket, { type: 'ended', reason: record.endReason });
      return closeOpenSocket(socket, 1000, 'Share ended');
    }
    const others = this.viewers(record.shareId, socket);
    if (others.some(({ viewer }) => viewer.viewerId === token.viewerId)) return closeOpenSocket(socket, 1008, 'This viewer is already watching');
    if (others.length >= BROWSER_SHARE_VIEWERS) return closeOpenSocket(socket, 1008, 'This share is full');
    const viewer: RuntimeBrowserShareViewer = { viewerId: token.viewerId, name: token.name, guest: token.guest, joinedAt: iso(Date.now()) };
    socket.serializeAttachment({ ...state, viewer } satisfies ViewerSocket);
    this.send(socket, { type: 'joined', viewerId: viewer.viewerId, share: await this.greeting(record), viewers: [...others.map(other => other.viewer), viewer], comments: await this.comments(record.shareId) });
    if (record.viewport) this.send(socket, { type: 'page', ...record.page, ...record.viewport });
    this.send(socket, { type: 'presence', online: this.host.online(record.pairingId) });
    await this.audit(record.shareId, 'joined', viewer.name, viewer.guest, null);
    this.changed(record);
    await this.publish(record.pairingId);
    await this.watch(record);
  }

  /** What is under a viewer's point; while one test runs, only the latest point asked is tested next and answered. */
  private async hit(socket: WebSocket, socketId: string, record: ShareRecord, at: Point): Promise<void> {
    const running = this.hits.get(socketId);
    if (running) { running.next = at; return; }
    const flight: { next: Point | null } = { next: at };
    this.hits.set(socketId, flight);
    try {
      for (let point = flight.next; point; point = flight.next) {
        flight.next = null;
        let answer: RuntimeBrowserShareServerMessage;
        try { answer = { type: 'hit', at: point, target: Hit.parse(await this.host.request(record.pairingId, { operation: 'shareHit', shareId: record.shareId, at: point })).target }; }
        catch (error) { answer = { type: 'error', message: `Nothing could be found there: ${described(error)}`.slice(0, 1024) }; }
        if (!flight.next) this.send(socket, answer);
      }
    } finally { this.hits.delete(socketId); }
  }

  /** A viewer's comment on a comment share: the extension anchors it, its crop goes to the workspace's drive and the
   * comment to the workspace, and everyone watching sees it. */
  private async comment(socket: WebSocket, viewer: RuntimeBrowserShareViewer, record: ShareRecord, message: Extract<RuntimeBrowserShareViewerMessage, { type: 'comment' }>): Promise<void> {
    const workspace = record.workspace;
    if (!workspace) return this.send(socket, { type: 'error', message: 'Comments need the tab in a workspace group' });
    if (!message.at && !message.region) return this.send(socket, { type: 'error', message: 'Point at something or drag over an area to comment on it' });
    try {
      const anchor = Anchor.parse(await this.host.request(record.pairingId, { operation: 'shareAnchor', shareId: record.shareId, ...(message.at ? { at: message.at } : {}), ...(message.region ? { region: message.region } : {}) }));
      const commentId = crypto.randomUUID(), createdAt = iso(Date.now()), crop = anchor.crop ? browserUnbase64(anchor.crop) : null;
      const cropPath = crop && crop.byteLength <= CROP_MAX_BYTES ? `${CROPS}${commentId}.jpg` : null;
      if (crop && cropPath) await this.host.drive(workspace).write(cropPath, 'image/jpeg', crop);
      const comment = RuntimeBrowserPageCommentSchema.parse({
        version: 1, commentId, shareId: record.shareId, by: { name: viewer.name, guest: viewer.guest }, text: message.text,
        page: { url: anchor.page.url.slice(0, 8192), title: anchor.page.title.slice(0, 500) }, target: anchor.target, region: anchor.region,
        viewport: anchor.viewport, scroll: anchor.scroll, crop: cropPath, createdAt,
      } satisfies RuntimeBrowserPageComment);
      await this.host.commented({ projectId: workspace.projectId, workspaceId: workspace.workspaceId }, comment);
      await this.ctx.storage.put(`${COMMENT}${record.shareId}:${createdAt}:${commentId}`, comment);
      const kept = [...(await this.ctx.storage.list({ prefix: `${COMMENT}${record.shareId}:` })).keys()];
      if (kept.length > COMMENTS_KEPT) await this.ctx.storage.delete(kept.slice(0, kept.length - COMMENTS_KEPT));
      const comments = await this.comments(record.shareId);
      for (const { socket: watching } of this.viewers(record.shareId)) this.send(watching, { type: 'comments', comments });
      await this.audit(record.shareId, 'commented', viewer.name, viewer.guest, message.text);
    } catch (error) { this.send(socket, { type: 'error', message: `Your comment was not saved: ${described(error)}`.slice(0, 1024) }); }
  }

  /** Asks the extension for frames at the largest viewer's size (at most `FRAME_MAX`), or to stop once nobody watches. */
  private async watch(record: ShareRecord, gone?: WebSocket): Promise<void> {
    const viewers = this.viewers(record.shareId, gone), watching = this.watching.get(record.shareId);
    if (!viewers.length) {
      this.watching.delete(record.shareId);
      if (this.host.online(record.pairingId)) await this.host.request(record.pairingId, { operation: 'shareUnwatch', shareId: record.shareId }).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_share_unwatch_failed', shareId: record.shareId, error: described(error) })));
      return;
    }
    const sizes = viewers.flatMap(({ state }) => state.size ? [state.size] : []);
    const width = Math.min(FRAME_MAX, Math.max(0, ...sizes.map(size => size.width)) || FRAME_MAX), height = Math.min(FRAME_MAX, Math.max(0, ...sizes.map(size => size.height)) || FRAME_MAX);
    if ((watching && watching.width === width && watching.height === height) || !this.host.online(record.pairingId)) return;
    this.watching.set(record.shareId, { width, height });
    try {
      const page = Watched.parse(await this.host.request(record.pairingId, { operation: 'shareWatch', shareId: record.shareId, targetId: record.targetId, maxWidth: width, maxHeight: height }));
      await this.pageChanged(record.shareId, page);
    } catch (error) {
      this.watching.delete(record.shareId);
      for (const { socket } of this.viewers(record.shareId)) this.send(socket, { type: 'error', message: `The shared tab cannot be shown: ${described(error)}`.slice(0, 1024) });
    }
  }

  private async pageChanged(shareId: string, page: { url: string; title: string; width: number; height: number }): Promise<void> {
    const record = await this.current(shareId);
    if (!record || record.endedAt) return;
    const next: ShareRecord = { ...record, page: { url: page.url.slice(0, 8192), title: page.title.slice(0, 500) }, viewport: { width: page.width, height: page.height } };
    await this.ctx.storage.put(`${SHARE}${shareId}`, next);
    for (const { socket } of this.viewers(shareId)) this.send(socket, { type: 'page', ...next.page, width: page.width, height: page.height });
  }

  /** Viewers or pointers changed: everyone watching gets the viewer list, the extension the pointers to draw, at most
   * once per `POINTERS_MS` and always with the latest. */
  private changed(record: ShareRecord, gone?: WebSocket): void {
    let throttle = this.throttles.get(record.shareId);
    if (!throttle) { throttle = { last: 0, pending: false }; this.throttles.set(record.shareId, throttle); }
    if (throttle.pending) return;
    const current = throttle, wait = current.last + POINTERS_MS - Date.now();
    if (wait <= 0) { current.last = Date.now(); return this.flush(record, gone); }
    current.pending = true;
    // A share that ended meanwhile dropped its throttle, and is not flushed.
    setTimeout(() => { if (this.throttles.get(record.shareId) !== current) return; current.pending = false; current.last = Date.now(); this.flush(record); }, wait);
  }

  private flush(record: ShareRecord, gone?: WebSocket): void {
    const viewers = this.viewers(record.shareId, gone);
    const listed = viewers.map(({ state, viewer }) => ({ ...viewer, at: state.at }));
    for (const { socket } of viewers) this.send(socket, { type: 'viewers', viewers: listed });
    this.host.notify(record.pairingId, { operation: 'sharePointers', shareId: record.shareId, pointers: viewers.flatMap(({ state, viewer }) => state.at ? [{ viewerId: viewer.viewerId, name: viewer.name, color: browserSharePointerColor(viewer.viewerId), at: state.at }] : []) });
  }

  /** Ends a share once: everyone watching is told why and disconnected, and its Chrome stops streaming and drawing. */
  private async end(record: ShareRecord, reason: ShareEnd, by: string): Promise<ShareRecord> {
    const stored = await this.ctx.storage.get(`${SHARE}${record.shareId}`);
    const latest = stored ? ShareRecord.parse(stored) : record;
    if (latest.endedAt) return latest;
    const ended: ShareRecord = { ...latest, endedAt: iso(Date.now()), endReason: reason };
    await this.ctx.storage.put(`${SHARE}${record.shareId}`, ended);
    await this.audit(record.shareId, 'ended', by, false, reason);
    for (const { socket, state } of this.sockets(record.shareId)) {
      if (state.viewer) this.send(socket, { type: 'ended', reason });
      socket.close(1000, 'Share ended');
    }
    this.watching.delete(record.shareId);
    this.throttles.delete(record.shareId);
    if (this.host.online(record.pairingId)) {
      this.host.notify(record.pairingId, { operation: 'shareEnded', shareId: record.shareId, reason });
      this.ctx.waitUntil(this.host.request(record.pairingId, { operation: 'shareUnwatch', shareId: record.shareId }).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_share_unwatch_failed', shareId: record.shareId, error: described(error) }))));
    }
    await this.publish(record.pairingId);
    await this.schedule();
    return ended;
  }

  /** Tells a Chrome's extension its live shares. */
  private async publish(pairingId: string): Promise<void> {
    if (!this.host.online(pairingId) || ((await this.host.pairing(pairingId))?.protocol ?? 0) < SHARE_PROTOCOL) return;
    this.host.notify(pairingId, { operation: 'shares', shares: await Promise.all((await this.live(pairingId)).map(record => this.view(record))) });
  }

  /** A Chrome that can share now: confirmed, its extension at `SHARE_PROTOCOL`, and connected. */
  private async ready(pairingId: string) {
    const pairing = await this.host.pairing(pairingId);
    if (!pairing) throw new Error('This Chrome is not paired and confirmed with this account');
    if (pairing.protocol < SHARE_PROTOCOL) throw new Error(UPDATE_REQUIRED);
    if (!this.host.online(pairingId)) throw new Error(`"${pairing.name}" is offline: open that Chrome to share its tabs`);
    return pairing;
  }

  /** Every share, each ended first if its expiry passed. */
  private async records(): Promise<ShareRecord[]> {
    const records: ShareRecord[] = [];
    for (const stored of (await this.ctx.storage.list({ prefix: SHARE })).values()) records.push(await this.expired(ShareRecord.parse(stored)));
    return records;
  }

  /** A Chrome's live shares, newest first. */
  private async live(pairingId: string): Promise<ShareRecord[]> {
    return (await this.records()).filter(record => record.pairingId === pairingId && !record.endedAt).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async current(shareId: string): Promise<ShareRecord | undefined> {
    const stored = await this.ctx.storage.get(`${SHARE}${shareId}`);
    return stored ? this.expired(ShareRecord.parse(stored)) : undefined;
  }

  private expired(record: ShareRecord): Promise<ShareRecord> | ShareRecord {
    return !record.endedAt && Date.parse(record.expiresAt) <= Date.now() ? this.end(record, 'expired', 'you') : record;
  }

  private async forget(shareId: string): Promise<void> {
    await this.ctx.storage.delete(`${SHARE}${shareId}`);
    for (const prefix of [`${AUDIT}${shareId}:`, `${COMMENT}${shareId}:`]) {
      const keys = [...(await this.ctx.storage.list({ prefix })).keys()];
      for (let start = 0; start < keys.length; start += 128) await this.ctx.storage.delete(keys.slice(start, start + 128));
    }
  }

  /** The relay's alarm is due by the earliest live expiry and hello deadline. */
  private async schedule(): Promise<void> {
    let next = Infinity;
    for (const stored of (await this.ctx.storage.list({ prefix: SHARE })).values()) {
      const record = ShareRecord.parse(stored);
      if (!record.endedAt) next = Math.min(next, Date.parse(record.expiresAt));
    }
    for (const { state } of this.sockets()) if (!state.viewer) next = Math.min(next, state.deadline);
    if (!Number.isFinite(next)) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current <= Date.now() || current > next) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
  }

  private async audit(shareId: string, event: RuntimeBrowserShareAudit['event'], by: string, guest: boolean, detail: string | null): Promise<void> {
    const keys = [...(await this.ctx.storage.list({ prefix: `${AUDIT}${shareId}:` })).keys()], last = keys.at(-1);
    const at = iso(Date.now()), n = last ? Number(last.slice(last.lastIndexOf(':') + 1)) + 1 : 0;
    await this.ctx.storage.put(`${AUDIT}${shareId}:${at}:${String(n).padStart(6, '0')}`, { at, event, by: by.slice(0, 128), guest, detail: detail?.slice(0, 512) ?? null } satisfies RuntimeBrowserShareAudit);
    if (keys.length >= AUDIT_KEPT) await this.ctx.storage.delete(keys.slice(0, keys.length - AUDIT_KEPT + 1));
  }

  /** A share's comments, oldest first. */
  private async comments(shareId: string): Promise<RuntimeBrowserPageComment[]> {
    return [...(await this.ctx.storage.list({ prefix: `${COMMENT}${shareId}:` })).values()].map(row => RuntimeBrowserPageCommentSchema.parse(row));
  }

  private async greeting(record: ShareRecord): Promise<RuntimeBrowserSharePreview> {
    let site = '';
    try { site = new URL(record.page.url).hostname.slice(0, 253); } catch { /* A page with no URL names no site. */ }
    return { sharer: (await this.account.name()).slice(0, 128), page: { title: record.page.title, site }, comment: record.comment, expiresAt: record.expiresAt, ended: record.endReason };
  }

  private async view(record: ShareRecord): Promise<RuntimeBrowserShare> {
    const pairing = await this.host.pairing(record.pairingId);
    const audit = [...(await this.ctx.storage.list({ prefix: `${AUDIT}${record.shareId}:`, reverse: true, limit: 50 })).values()].map(row => RuntimeBrowserShareAuditSchema.parse(row));
    return RuntimeBrowserShareSchema.parse({
      shareId: record.shareId, link: `${new URL(`/s/${record.shareId}`, this.account.url).href}#${record.secret}`, pairingId: record.pairingId,
      browser: pairing?.name ?? `Chrome ${record.pairingId.slice(0, 8)}`, targetId: record.targetId, workspace: record.workspace, page: record.page, comment: record.comment,
      createdAt: record.createdAt, expiresAt: record.expiresAt, endedAt: record.endedAt, endReason: record.endReason,
      viewers: record.endedAt ? [] : this.viewers(record.shareId).map(({ viewer }) => viewer), audit,
    } satisfies RuntimeBrowserShare);
  }

  /** Open viewer sockets, of one share or all; `gone` is one closing now. */
  private sockets(shareId?: string, gone?: WebSocket): { socket: WebSocket; state: ViewerSocket }[] {
    const goneId = gone ? ViewerSocket.safeParse(gone.deserializeAttachment()).data?.socketId : undefined;
    const open: { socket: WebSocket; state: ViewerSocket }[] = [];
    for (const socket of this.ctx.getWebSockets(shareId ? `${VIEWER_TAG}:${shareId}` : VIEWER_TAG)) {
      const state = ViewerSocket.safeParse(socket.deserializeAttachment());
      if (socket.readyState === 1 && state.success && state.data.socketId !== goneId) open.push({ socket, state: state.data });
    }
    return open;
  }

  /** A share's viewers: its sockets that said hello. */
  private viewers(shareId: string, gone?: WebSocket) {
    return this.sockets(shareId, gone).flatMap(({ socket, state }) => state.viewer ? [{ socket, state, viewer: state.viewer }] : []);
  }

  private send(socket: WebSocket, message: RuntimeBrowserShareServerMessage): void {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  }
}
