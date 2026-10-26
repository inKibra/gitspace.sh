import { z } from 'zod';
import {
  BROWSER_CAPTURE_SHARE_PATH, RuntimeBrowserCaptureShareAuditSchema, RuntimeBrowserCaptureShareChromeRequestSchema, RuntimeBrowserCaptureShareCommentSchema,
  RuntimeBrowserCaptureShareEndSchema, RuntimeBrowserCaptureShareExpirySchema, RuntimeBrowserCaptureShareOpenSchema, RuntimeBrowserCaptureShareSchema, RuntimeBrowserCommentNameSchema,
  type RuntimeBrowserCapture, type RuntimeBrowserCaptureShare, type RuntimeBrowserCaptureShareAudit, type RuntimeBrowserCaptureShareComment, type RuntimeBrowserCaptureShareOpened,
  type RuntimeBrowserCaptureSharePreview, type RuntimeBrowserCommentAuthor, type RuntimeBrowserCommentFilter, type RuntimeBrowserCommentThread, type RuntimeBrowserCommentWrite,
} from '@gitspace/protocol-runtime';
import { accountAccessResponse, activeAccount } from './account-access.js';
import { ArtifactFileGrantSchema, serveArtifactGrant } from './artifact-file-url.js';
import { captureFolder } from './browser-capture.js';
import { equalSecret } from './browser-share.js';
import { browserRouteReply, readBrowserSignedRequest, type BrowserRequestFailure } from './browser-upload.js';
import { DEVICE_AUTHORITY_UNAVAILABLE, withDeviceAuthority } from './device-authority.js';
import { openToken, sealToken, type SealedTokenKind } from './sealed-token.js';
import { workspaceDrive } from './workspace-drive.js';

/**
 * Capture share links (docs/APERTURE-DESIGN.md §8, §11, B3): one saved capture, played through
 * `<account>/c/<captureShareId>#<secret>`. The relay object keeps each share (`browser.relay.capture-share:<id>`, with
 * its secret, so its link can be copied again) and its audit; the recording stays in its workspace's drive. Opening a
 * share mints a token per file of that capture's folder and nothing else; each file request is served only while the
 * share lives, so revoking or expiring it stops every link at once. Comments go to the workspace's threads, scoped to
 * the capture, so a viewer reaches no other thread.
 */

const RECORD = 'browser.relay.capture-share:';
const AUDIT = 'browser.relay.capture-share-audit:';
const AUDIT_KEPT = 200;
/** Ended shares stay listed, then are forgotten, after this long. */
const ENDED_KEPT_MS = 24 * 60 * 60_000;
const LISTED = 50;
/** Threads an open or a list returns, all of the capture's when it has fewer. */
const THREADS_SHOWN = 500;
/** An open's viewer and file tokens serve at most this long (and never past the share's expiry); the page opens the
 * share again after it. */
const OPEN_MS = 12 * 60 * 60_000;
const BODY_BYTES = 32 * 1024;
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROUTE = new RegExp(`^/api/capture-shares/(${uuidPattern})/(preview|open|comments)$`, 'u');
const FILE_ROUTE = new RegExp(`^/api/capture-shares/(${uuidPattern})/files/([A-Za-z0-9_-]{40,4096})$`, 'u');
const VIEWER_TOKEN: SealedTokenKind = { scope: 'capture-share-viewer:v1', context: 'gitspace-capture-share-viewer-v1' };
const FILE_TOKEN: SealedTokenKind = { scope: 'capture-share-file:v1', context: 'gitspace-capture-share-file-v1' };
const VIEW_ONLY = 'This capture is shared view-only';

const Workspace = z.object({ projectId: z.string(), workspaceId: z.string() });
type Workspace = z.infer<typeof Workspace>;
const CaptureShareRecord = z.object({
  captureShareId: z.string().uuid(), secret: z.string(), captureId: z.string().uuid(), workspace: Workspace,
  /** The Chrome that made it from its saved card, which may end it; null for one made in the Browser tab. */
  pairingId: z.string().uuid().nullable(),
  name: z.string(), page: z.object({ url: z.string(), title: z.string() }), durationMs: z.number().int().nonnegative(), comment: z.boolean(),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable(), endReason: RuntimeBrowserCaptureShareEndSchema.nullable(),
});
type CaptureShareRecord = z.infer<typeof CaptureShareRecord>;
/** What an open's viewer token holds: comment requests present it. */
const ViewerToken = z.object({ captureShareId: z.string().uuid(), name: RuntimeBrowserCommentNameSchema, guest: z.boolean(), expiresAt: z.number().int() });
/** What a file token holds: one version of one file of the shared capture's folder. */
const FileToken = z.object({ captureShareId: z.string().uuid(), grant: ArtifactFileGrantSchema, expiresAt: z.number().int() });
type Viewer = { name: string; guest: boolean };
type Reply = { ok: true; value: Record<string, unknown> } | BrowserRequestFailure;
/** An open as the relay answers it; the route mints the tokens. */
export type BrowserCaptureShareOpen =
  | { status: 'ok'; workspace: Workspace; captureId: string; capture: RuntimeBrowserCapture; threads: RuntimeBrowserCommentThread[]; sharer: string; comment: boolean; expiresAt: string }
  | { status: 'unknown' } | { status: 'ended' } | { status: 'gone' };

/** What capture shares need from the relay object holding them: workspaces' captures and threads, its Chromes' groups. */
export type BrowserCaptureShareHost = {
  /** A workspace's `capture.json`, null when it is not in the drive. */
  capture(workspace: Workspace, captureId: string): Promise<RuntimeBrowserCapture | null>;
  threads(workspace: Workspace, filter: RuntimeBrowserCommentFilter): Promise<RuntimeBrowserCommentThread[]>;
  /** Writes to a workspace's threads within the capture's (`scope`): anything else is refused with an Error. */
  write(workspace: Workspace, write: RuntimeBrowserCommentWrite, by: RuntimeBrowserCommentAuthor, scope: { captureId: string }): Promise<RuntimeBrowserCommentThread>;
  /** The workspace of a live group on this Chrome. */
  group(pairingId: string, groupId: string): Promise<Workspace | undefined>;
  /** A confirmed Chrome's name. */
  chrome(pairingId: string): Promise<string | undefined>;
  /** Re-arms the host's alarm at its earliest deadline, `nextDeadline` among them, or clears it. */
  schedule(): Promise<void>;
};

function iso(ms: number) { return new Date(ms).toISOString(); }
function described(error: unknown) { return error instanceof Error ? error.message : String(error); }
function refusal(status: number, code: string, message: string): BrowserRequestFailure { return { ok: false, status, code, message }; }
const UNKNOWN = refusal(404, 'CAPTURE_SHARE_UNKNOWN', 'This capture link is unknown or its secret is wrong');
const ENDED = refusal(410, 'CAPTURE_SHARE_ENDED', 'This share has ended');
const GONE = refusal(410, 'CAPTURE_SHARE_GONE', 'This capture is no longer in its workspace');

/**
 * The capture share routes, public before device authority: `POST /api/capture-shares/<id>/preview` (the greeting, for
 * the secret), `/open` (the capture, its file links and threads, and a viewer token), `/comments` (with that token),
 * `GET /api/capture-shares/<id>/files/<token>` (one file's bytes, with ranges), and `POST BROWSER_CAPTURE_SHARE_PATH`,
 * your Chrome's signed requests. Opened by one of the account's devices, the viewer is the owner under the account's
 * name, who may resolve threads. An unknown share and a wrong secret get the same answer.
 */
export async function serveBrowserCaptureShare(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), relay = env.RELAY.getByName(env.RELAY_NAME);
  if (url.pathname === BROWSER_CAPTURE_SHARE_PATH) {
    const read = await readBrowserSignedRequest(request, 'share');
    return browserRouteReply(read.ok ? await relay.browserCaptureShareChrome(read.request, read.body) : read);
  }
  const file = FILE_ROUTE.exec(url.pathname);
  if (file) {
    const [, captureShareId = '', token = ''] = file;
    const missing = new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    let opened: z.infer<typeof FileToken>;
    try { opened = FileToken.parse(await openToken(env, FILE_TOKEN, token)); } catch { return missing; }
    if (opened.captureShareId !== captureShareId || opened.expiresAt <= Date.now()) return missing;
    if (!await relay.browserCaptureShareLive(captureShareId)) return new Response('This share has ended', { status: 410, headers: { 'cache-control': 'no-store' } });
    return serveArtifactGrant(request, env, opened.grant, opened.expiresAt);
  }
  const route = ROUTE.exec(url.pathname);
  if (!route) return browserRouteReply(UNKNOWN);
  const denied = accountAccessResponse(await activeAccount(env, env.ACCOUNT_ID));
  if (denied) return denied;
  if (request.method !== 'POST') return browserRouteReply(refusal(405, 'METHOD_NOT_ALLOWED', 'Send this with POST'));
  const [, captureShareId = '', action] = route;
  const bytes = new Uint8Array(await request.arrayBuffer());
  let body: unknown;
  try {
    if (bytes.byteLength > BODY_BYTES) throw new Error('Too large');
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch { return browserRouteReply(refusal(400, 'CAPTURE_SHARE_INVALID', `Send at most ${BODY_BYTES} bytes of JSON`)); }
  if (action === 'comments') {
    const parsed = RuntimeBrowserCaptureShareCommentSchema.safeParse(body);
    if (!parsed.success) return browserRouteReply(refusal(400, 'CAPTURE_SHARE_INVALID', 'Invalid comment request'));
    let viewer: z.infer<typeof ViewerToken>;
    try { viewer = ViewerToken.parse(await openToken(env, VIEWER_TOKEN, parsed.data.token)); } catch { return browserRouteReply(refusal(401, 'CAPTURE_SHARE_TOKEN', 'Open the capture again')); }
    if (viewer.captureShareId !== captureShareId || viewer.expiresAt <= Date.now()) return browserRouteReply(refusal(401, 'CAPTURE_SHARE_TOKEN', 'Open the capture again'));
    return browserRouteReply(await relay.browserCaptureShareComment(captureShareId, { name: viewer.name, guest: viewer.guest }, parsed.data));
  }
  const device = request.headers.get('x-gitspace-device');
  if (device !== null) {
    const auth = await withDeviceAuthority(env, (view, now) => view.authorizeRequest({ header: device, method: 'POST', target: `${url.pathname}${url.search}`, body: bytes, capabilities: [], accountScope: true }, now));
    if (auth.status === 'error') return Response.json(auth, { status: auth.error.code === DEVICE_AUTHORITY_UNAVAILABLE ? 503 : 401 });
  }
  if (action === 'preview') {
    const secret = z.object({ secret: z.string().max(128) }).safeParse(body);
    const preview = secret.success ? await relay.browserCaptureSharePreview(captureShareId, secret.data.secret) : null;
    return browserRouteReply(preview ? { ok: true, value: preview } : UNKNOWN);
  }
  const open = RuntimeBrowserCaptureShareOpenSchema.safeParse(body);
  if (!open.success) return browserRouteReply(refusal(400, 'CAPTURE_SHARE_INVALID', 'An open names the secret and your name'));
  const opened = await relay.browserCaptureShareOpen(captureShareId, open.data.secret, { name: open.data.name, guest: device === null });
  if (opened.status !== 'ok') return browserRouteReply({ unknown: UNKNOWN, ended: ENDED, gone: GONE }[opened.status]);
  const guest = device === null, name = guest ? open.data.name : opened.sharer.slice(0, 60).trim() || open.data.name;
  const expiresAt = Math.min(Date.parse(opened.expiresAt), Date.now() + OPEN_MS);
  const drive = workspaceDrive(env, opened.workspace), folder = captureFolder(opened.captureId);
  const names = (await drive.list(folder)).map(entry => entry.path.slice(folder.length)).filter(entry => entry && entry !== 'capture.json' && !entry.includes('/'));
  const files = Object.fromEntries(await Promise.all(names.map(async entry => {
    const token = await sealToken(env, FILE_TOKEN, { captureShareId, grant: await drive.grant(`${folder}${entry}`), expiresAt } satisfies z.infer<typeof FileToken>);
    return [entry, new URL(`/api/capture-shares/${captureShareId}/files/${token}`, env.ACCOUNT_URL).href] as const;
  })));
  const token = await sealToken(env, VIEWER_TOKEN, { captureShareId, name, guest, expiresAt } satisfies z.infer<typeof ViewerToken>);
  return browserRouteReply({ ok: true, value: {
    token, name, guest, expiresAt: iso(expiresAt), sharer: opened.sharer, comment: opened.comment, shareExpiresAt: opened.expiresAt,
    capture: opened.capture, files, threads: opened.threads,
  } satisfies RuntimeBrowserCaptureShareOpened });
}

/** The relay object's capture shares: records, audit, and what viewers may read and write. */
export class BrowserCaptureShares {
  constructor(private readonly storage: DurableObjectStorage, private readonly host: BrowserCaptureShareHost, private readonly account: { url: string; name(): Promise<string> }) {}

  /** Shares a saved capture of a workspace (from its Browser tab, `by` `you`; or a Chrome's saved card). While a share of
   * the capture lives, that one is the answer. */
  async create(workspace: Workspace, input: { captureId: string; comment: boolean; expiresInMinutes: number }, by: { name: string; pairingId: string | null }): Promise<RuntimeBrowserCaptureShare> {
    const minutes = RuntimeBrowserCaptureShareExpirySchema.safeParse(input.expiresInMinutes);
    if (!minutes.success) throw new Error('A capture share lasts 1 hour, 1 day, 7 days or 30 days');
    const live = (await this.records()).find(record => !record.endedAt && record.captureId === input.captureId && record.workspace.projectId === workspace.projectId && record.workspace.workspaceId === workspace.workspaceId);
    if (live) return this.view(live);
    const capture = await this.host.capture(workspace, input.captureId);
    if (!capture) throw new Error('This capture is not in the workspace');
    if (capture.state !== 'saved') throw new Error(capture.state === 'recording' ? 'This capture is still recording: share it once it is saved' : 'This capture failed and has nothing to share');
    const now = Date.now();
    const record: CaptureShareRecord = {
      captureShareId: crypto.randomUUID(), secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'), captureId: input.captureId, workspace: { projectId: workspace.projectId, workspaceId: workspace.workspaceId },
      // The recording's length: its video's, else from its start to its end.
      pairingId: by.pairingId, name: capture.name, page: capture.page, durationMs: capture.tracks.video?.durationMs ?? (capture.endedAt ? Math.max(0, Date.parse(capture.endedAt) - Date.parse(capture.startedAt)) : 0), comment: input.comment,
      createdAt: iso(now), expiresAt: iso(now + minutes.data * 60_000), endedAt: null, endReason: null,
    };
    await this.storage.put(`${RECORD}${record.captureShareId}`, record);
    await this.audit(record.captureShareId, 'created', by.name, false, `${input.comment ? 'View and comment' : 'View'} for ${minutes.data} minutes`);
    await this.host.schedule();
    return this.view(record);
  }

  /** A request your Chrome's extension signed (`BROWSER_CAPTURE_SHARE_PATH`): share a capture it recorded into one of its
   * workspace groups, or end a share it made. */
  async chromeRequest(pairingId: string, body: unknown): Promise<Reply> {
    const parsed = RuntimeBrowserCaptureShareChromeRequestSchema.safeParse(body);
    if (!parsed.success) return refusal(400, 'CAPTURE_SHARE_INVALID', `Invalid capture share request: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
    const input = parsed.data;
    if (input.op === 'revoke') {
      const record = await this.current(input.captureShareId);
      if (!record || record.pairingId !== pairingId) return refusal(404, 'CAPTURE_SHARE_UNKNOWN', 'Unknown capture share');
      return { ok: true, value: { captureShare: await this.view(await this.end(record, 'revoked', (await this.host.chrome(pairingId)) ?? 'Chrome')) } };
    }
    const workspace = await this.host.group(pairingId, input.groupId);
    if (!workspace) return refusal(409, 'CAPTURE_SHARE_REFUSED', 'This capture’s workspace group is no longer on this Chrome: share it from the workspace’s Browser tab');
    try {
      const capture = await this.host.capture(workspace, input.captureId);
      if (capture && capture.target?.groupId !== input.groupId) throw new Error('This capture was not recorded in that group');
      return { ok: true, value: { captureShare: await this.create(workspace, input, { name: (await this.host.chrome(pairingId)) ?? 'Chrome', pairingId }) } };
    } catch (error) { return refusal(409, 'CAPTURE_SHARE_REFUSED', described(error)); }
  }

  /** A workspace's capture shares: live, and ended in the last day; newest first. */
  async list(workspace: Workspace): Promise<RuntimeBrowserCaptureShare[]> {
    const since = Date.now() - ENDED_KEPT_MS;
    const records = (await this.records()).filter(record => record.workspace.projectId === workspace.projectId && record.workspace.workspaceId === workspace.workspaceId && (!record.endedAt || Date.parse(record.endedAt) > since));
    return Promise.all(records.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, LISTED).map(record => this.view(record)));
  }

  /** You end one of a workspace's capture shares. */
  async revoke(workspace: Workspace, captureShareId: string): Promise<RuntimeBrowserCaptureShare> {
    const record = await this.current(captureShareId);
    if (!record || record.workspace.projectId !== workspace.projectId || record.workspace.workspaceId !== workspace.workspaceId) throw new Error('Unknown capture share');
    return this.view(await this.end(record, 'revoked', 'you'));
  }

  /** The greeting before anyone opens the recording; null for an unknown share or a wrong secret alike. */
  async preview(captureShareId: string, secret: string): Promise<RuntimeBrowserCaptureSharePreview | null> {
    const record = await this.current(captureShareId);
    if (!record || !equalSecret(record.secret, secret)) return null;
    const comments = record.endedAt ? 0 : (await this.host.threads(record.workspace, { captureId: record.captureId, status: 'all', limit: THREADS_SHOWN })).length;
    return {
      sharer: (await this.account.name()).slice(0, 128), capture: { name: record.name, page: record.page, durationMs: record.durationMs, comments },
      comment: record.comment, expiresAt: record.expiresAt, ended: record.endReason,
    };
  }

  /** A viewer opens a live share: the capture as its workspace holds it now, with its threads. */
  async open(captureShareId: string, secret: string, viewer: Viewer): Promise<BrowserCaptureShareOpen> {
    const record = await this.current(captureShareId);
    if (!record || !equalSecret(record.secret, secret)) return { status: 'unknown' };
    if (record.endedAt) return { status: 'ended' };
    const capture = await this.host.capture(record.workspace, record.captureId);
    if (!capture) return { status: 'gone' };
    const sharer = (await this.account.name()).slice(0, 128);
    const threads = await this.host.threads(record.workspace, { captureId: record.captureId, status: 'all', limit: THREADS_SHOWN });
    await this.audit(captureShareId, 'opened', viewer.guest ? viewer.name : sharer, viewer.guest, null);
    return { status: 'ok', workspace: record.workspace, captureId: record.captureId, capture, threads, sharer, comment: record.comment, expiresAt: record.expiresAt };
  }

  /** Whether a share still serves its files. */
  async live(captureShareId: string): Promise<boolean> {
    const record = await this.current(captureShareId);
    return !!record && !record.endedAt;
  }

  /** A viewer's comment request: a comment at a moment of the recording, a reply, resolving (the owner only), or the
   * threads now. Each touches only the shared capture's threads. */
  async comment(captureShareId: string, viewer: Viewer, request: RuntimeBrowserCaptureShareComment): Promise<Reply> {
    const record = await this.current(captureShareId);
    if (!record) return UNKNOWN;
    if (record.endedAt) return ENDED;
    if (request.op === 'list') return { ok: true, value: { threads: await this.host.threads(record.workspace, { captureId: record.captureId, status: 'all', limit: THREADS_SHOWN }) } };
    if (!record.comment) return refusal(403, 'CAPTURE_SHARE_VIEW_ONLY', VIEW_ONLY);
    if (request.op === 'resolve' && viewer.guest) return refusal(403, 'CAPTURE_SHARE_RESOLVE', `Only ${(await this.account.name()).slice(0, 128)} resolves threads`);
    const write: RuntimeBrowserCommentWrite = request.op === 'comment'
      ? { op: 'comment', source: { kind: 'capture', captureId: record.captureId, atMs: request.atMs }, page: request.page, anchor: request.anchor, text: request.text }
      : request.op === 'reply' ? { op: 'reply', threadId: request.threadId, text: request.text }
        : { op: 'resolve', threadId: request.threadId, ...(request.reopen === undefined ? {} : { reopen: request.reopen }) };
    let thread: RuntimeBrowserCommentThread;
    try { thread = await this.host.write(record.workspace, write, { kind: 'person', name: viewer.name, guest: viewer.guest }, { captureId: record.captureId }); }
    catch (error) { return refusal(409, 'CAPTURE_SHARE_COMMENT_REFUSED', `Your comment was not saved: ${described(error)}`.slice(0, 1024)); }
    const event: RuntimeBrowserCaptureShareAudit['event'] = request.op === 'comment' ? 'commented' : request.op === 'reply' ? 'replied' : request.reopen ? 'reopened' : 'resolved';
    await this.audit(captureShareId, event, viewer.name, viewer.guest, request.op === 'resolve' ? null : request.text);
    return { ok: true, value: { thread } };
  }

  /** The relay's alarm: shares past their expiry end and ended shares older than a day are forgotten. */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const record of await this.records()) if (record.endedAt && Date.parse(record.endedAt) <= now - ENDED_KEPT_MS) await this.forget(record.captureShareId);
  }

  /** The earliest live share's expiry or ended share's forgetting; null when none. */
  async nextDeadline(): Promise<number | null> {
    let next = Infinity;
    for (const stored of (await this.storage.list({ prefix: RECORD })).values()) {
      const record = CaptureShareRecord.parse(stored);
      next = Math.min(next, record.endedAt ? Date.parse(record.endedAt) + ENDED_KEPT_MS : Date.parse(record.expiresAt));
    }
    return Number.isFinite(next) ? next : null;
  }

  /** Ends a share once. */
  private async end(record: CaptureShareRecord, reason: z.infer<typeof RuntimeBrowserCaptureShareEndSchema>, by: string): Promise<CaptureShareRecord> {
    const stored = await this.storage.get(`${RECORD}${record.captureShareId}`);
    const latest = stored ? CaptureShareRecord.parse(stored) : record;
    if (latest.endedAt) return latest;
    const ended: CaptureShareRecord = { ...latest, endedAt: iso(Date.now()), endReason: reason };
    await this.storage.put(`${RECORD}${record.captureShareId}`, ended);
    await this.audit(record.captureShareId, 'ended', by, false, reason);
    await this.host.schedule();
    return ended;
  }

  /** Every share, each ended first if its expiry passed. */
  private async records(): Promise<CaptureShareRecord[]> {
    const records: CaptureShareRecord[] = [];
    for (const stored of (await this.storage.list({ prefix: RECORD })).values()) records.push(await this.expired(CaptureShareRecord.parse(stored)));
    return records;
  }

  private async current(captureShareId: string): Promise<CaptureShareRecord | undefined> {
    const stored = await this.storage.get(`${RECORD}${captureShareId}`);
    return stored ? this.expired(CaptureShareRecord.parse(stored)) : undefined;
  }

  private expired(record: CaptureShareRecord): Promise<CaptureShareRecord> | CaptureShareRecord {
    return !record.endedAt && Date.parse(record.expiresAt) <= Date.now() ? this.end(record, 'expired', 'you') : record;
  }

  private async forget(captureShareId: string): Promise<void> {
    await this.storage.delete(`${RECORD}${captureShareId}`);
    const keys = [...(await this.storage.list({ prefix: `${AUDIT}${captureShareId}:` })).keys()];
    for (let start = 0; start < keys.length; start += 128) await this.storage.delete(keys.slice(start, start + 128));
  }

  private async audit(captureShareId: string, event: RuntimeBrowserCaptureShareAudit['event'], by: string, guest: boolean, detail: string | null): Promise<void> {
    const keys = [...(await this.storage.list({ prefix: `${AUDIT}${captureShareId}:` })).keys()], last = keys.at(-1);
    const at = iso(Date.now()), n = last ? Number(last.slice(last.lastIndexOf(':') + 1)) + 1 : 0;
    await this.storage.put(`${AUDIT}${captureShareId}:${at}:${String(n).padStart(6, '0')}`, { at, event, by: by.slice(0, 128), guest, detail: detail?.slice(0, 512) ?? null } satisfies RuntimeBrowserCaptureShareAudit);
    if (keys.length >= AUDIT_KEPT) await this.storage.delete(keys.slice(0, keys.length - AUDIT_KEPT + 1));
  }

  private async view(record: CaptureShareRecord): Promise<RuntimeBrowserCaptureShare> {
    const audit = [...(await this.storage.list({ prefix: `${AUDIT}${record.captureShareId}:`, reverse: true, limit: 50 })).values()].map(row => RuntimeBrowserCaptureShareAuditSchema.parse(row));
    return RuntimeBrowserCaptureShareSchema.parse({
      captureShareId: record.captureShareId, captureId: record.captureId, link: `${new URL(`/c/${record.captureShareId}`, this.account.url).href}#${record.secret}`,
      workspace: record.workspace, name: record.name.slice(0, 200), comment: record.comment,
      createdAt: record.createdAt, expiresAt: record.expiresAt, endedAt: record.endedAt, endReason: record.endReason, audit,
    } satisfies RuntimeBrowserCaptureShare);
  }
}
