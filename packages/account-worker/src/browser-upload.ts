import { z } from 'zod';
import { DRIVE_FILE_MAX_BYTES, TENANT_OBJECT_PART_BYTES } from '@gitspace/protocol';
import { BROWSER_DRIVE_PREFIX, browserUnbase64 } from '@gitspace/protocol-runtime';
import { CAPTURE_FILES, captureFolder } from './browser-capture.js';
import { DriveUploadSchema } from './drive-files.js';
import type { WorkspaceDrive } from './workspace-drive.js';

/**
 * Files from your Chrome into the workspace's drive (docs/APERTURE-DESIGN.md §11, Batch 16): downloads a script or step
 * started there, and the media of captures. The extension sends them over HTTPS to the account, never over the relay
 * WebSocket. `POST /api/browser-relay/uploads`, signed with its pairing key, begins one: the relay object checks the
 * signature against the confirmed pairing and keeps the upload session, and the reply carries an upload link
 * (`upload-link.ts`) for its parts, completion and abandonment, so the bytes go straight to the drive part by part. A
 * session lapses 45 minutes after its last part, longer than a capture records.
 */
export const BROWSER_UPLOAD_PATH = '/api/browser-relay/uploads';
export const BROWSER_UPLOAD_HEADER = 'x-gitspace-browser-upload';
export const BROWSER_UPLOAD_PART_BYTES = TENANT_OBJECT_PART_BYTES;
export const BROWSER_UPLOAD_IDLE_MS = 45 * 60_000;
/** A signed request is accepted this long either side of its `issuedAt`; its nonce is remembered twice as long. */
const SIGNATURE_WINDOW_MS = 60_000;
/** Uploads one Chrome may have open at once. */
const UPLOADS_PER_CHROME = 16;
/** A finished download waits this long for its run to collect it. */
const DOWNLOAD_KEEP_MS = 60 * 60_000;
const NONCES = 'browser.relay.upload-nonces';
const UPLOAD = 'browser.relay.upload:';
export const BROWSER_DOWNLOAD = 'browser.relay.download:';

/** What a pairing-key signature on a request to the account is for: `upload` begins an upload, `share` makes, ends or
 * lists share links (`browser-share.ts`), `comment` is the in-page comment tool's (`BROWSER_COMMENT_PATH`),
 * `workspace` lists workspaces or adds a tab to one from the popup (`BROWSER_WORKSPACES_PATH`). The label is part of
 * the signed text, so one never passes as the other. */
export type BrowserSignedLabel = 'upload' | 'share' | 'comment' | 'workspace';
/** The text a pairing key signs for one request. */
export function browserSignedText(label: BrowserSignedLabel, input: { pairingId: string; generation: number; method: string; pathname: string; bodySha256: string; issuedAt: number; nonce: string }): string {
  return `gitspace-browser-relay-v2:${label}:${input.pairingId}:${input.generation}:${input.method}:${input.pathname}:${input.bodySha256}:${input.issuedAt}:${input.nonce}`;
}
/** Error codes and wording per label (`UPLOAD_SIGNATURE_INVALID`, `SHARE_SIGNATURE_INVALID`…), and the largest JSON
 * body each takes: a comment carries its crop. */
const SIGNED: Record<BrowserSignedLabel, { code: string; noun: string; Noun: string; bytes: number }> = {
  upload: { code: 'UPLOAD', noun: 'upload', Noun: 'Upload', bytes: 16 * 1024 },
  share: { code: 'SHARE', noun: 'share request', Noun: 'Share request', bytes: 16 * 1024 },
  comment: { code: 'COMMENT', noun: 'comment request', Noun: 'Comment request', bytes: 640 * 1024 },
  workspace: { code: 'WORKSPACE', noun: 'workspace request', Noun: 'Workspace request', bytes: 16 * 1024 },
};
const Signature = z.object({ pairingId: z.string().uuid(), generation: z.number().int().nonnegative(), issuedAt: z.number().int(), nonce: z.string().regex(/^[a-f0-9]{64}$/u), signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u).max(128) });
const Begin = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('download'), groupId: z.string().uuid(), attemptId: z.string().min(1).max(256), name: z.string().min(1).max(512), mediaType: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal('capture'), groupId: z.string().uuid(), captureId: z.string().uuid(), file: z.enum(['video.webm', 'frames.bin', 'frames.json', 'thumbnail.jpg', 'steps.json', 'layout.jsonl']), mediaType: z.string().min(1).max(128) }),
]);
const Complete = z.strictObject({ parts: z.number().int().positive(), size: z.number().int().positive().max(DRIVE_FILE_MAX_BYTES) });
const Upload = z.object({
  uploadId: z.string().uuid(), pairingId: z.string().uuid(), projectId: z.string(), workspaceId: z.string(), groupId: z.string().uuid(),
  target: z.discriminatedUnion('kind', [z.object({ kind: z.literal('download'), attemptId: z.string() }), z.object({ kind: z.literal('capture'), captureId: z.string().uuid(), file: Begin.options[1].shape.file })]),
  path: z.string(), mediaType: z.string(), parts: z.number().int().nonnegative(), size: z.number().int().nonnegative(), drive: DriveUploadSchema, expiresAt: z.number().int(),
});
export type BrowserUpload = z.infer<typeof Upload>;
/** A finished download, kept for the run that started it (workspace-relative drive path). */
export const BrowserDownloadSchema = z.object({ path: z.string(), size: z.number().int().nonnegative(), mediaType: z.string(), expiresAt: z.number().int() });

/** A request signed with a pairing key, as the route saw it. */
export type BrowserSignedRequest = { method: string; pathname: string; header: string | null; bodySha256: string };
/** `begin` is signed; the rest come through the upload's link, which names the pairing that began it. */
export type BrowserUploadStep =
  | { op: 'begin'; request: BrowserSignedRequest; body: unknown }
  | { op: 'part'; pairingId: string; uploadId: string; index: number }
  | { op: 'stored'; uploadId: string; index: number; size: number; drive: z.infer<typeof DriveUploadSchema> }
  | { op: 'complete'; pairingId: string; uploadId: string; body: unknown }
  | { op: 'abort'; pairingId: string; uploadId: string };
/** A refused request to the account's browser routes: its HTTP status, code and message. */
export type BrowserRequestFailure = { ok: false; status: number; code: string; message: string };
export type BrowserUploadReply = { ok: true; value: Record<string, unknown> } | BrowserRequestFailure;
/** What `part` tells the link's route: store the part in that workspace's drive, continuing `drive`. */
export const BrowserUploadPartSchema = z.object({ projectId: z.string(), workspaceId: z.string(), drive: DriveUploadSchema });
/** What `begin` tells the route, which answers with the upload's link instead of its ids. */
export const BrowserUploadBegunSchema = z.object({ uploadId: z.string().uuid(), pairingId: z.string().uuid(), path: z.string(), expiresAt: z.string() });
/** The drive as uploads use it. */
export type BrowserUploadDrive = Pick<WorkspaceDrive, 'list' | 'upload' | 'append' | 'finish' | 'discard'>;

/** The relay's answers about the signer: its confirmed pairing, its workspace groups, live attempts and captures. */
export type BrowserUploadAuthority = {
  pairing(pairingId: string): Promise<{ generation: number; publicKey: string } | undefined>;
  /** The workspace of a live group of this pairing. */
  group(pairingId: string, groupId: string): Promise<{ projectId: string; workspaceId: string } | undefined>;
  /** Whether a script run or step of this pairing on this group is live now. */
  attempt(pairingId: string, groupId: string, attemptId: string): boolean;
  /** Whether this pairing announced this capture in this group and it is still recording. */
  capture(pairingId: string, groupId: string, captureId: string): Promise<boolean>;
  /** A capture file finished. */
  captured(captureId: string, file: keyof typeof CAPTURE_FILES, size: number): Promise<void>;
};

const fail = (status: number, code: string, message: string): BrowserRequestFailure => ({ ok: false, status, code, message });
const SESSION_GONE = fail(404, 'UPLOAD_UNKNOWN', 'Unknown upload');

/** The confirmed pairing whose key signed this request for `label` (`pairing` gives its key), once per nonce: the nonces
 * of every label are kept together in `storage` while their signatures could still be accepted. */
export async function browserRequestSigner(storage: Pick<DurableObjectStorage, 'get' | 'put'>, pairing: (pairingId: string) => Promise<{ generation: number; publicKey: string } | undefined>, label: BrowserSignedLabel, request: BrowserSignedRequest): Promise<{ ok: true; pairingId: string } | BrowserRequestFailure> {
  const { code, noun, Noun } = SIGNED[label];
  if (!request.header || request.header.length > 1024) return fail(401, `${code}_SIGNATURE_REQUIRED`, `A signed ${noun} is required`);
  let claim: z.infer<typeof Signature>;
  try { claim = Signature.parse(JSON.parse(atob(request.header.replaceAll('-', '+').replaceAll('_', '/')))); }
  catch { return fail(401, `${code}_SIGNATURE_INVALID`, `Invalid ${noun} signature`); }
  const now = Date.now();
  if (Math.abs(now - claim.issuedAt) > SIGNATURE_WINDOW_MS) return fail(401, `${code}_SIGNATURE_EXPIRED`, `${Noun} signature expired; check this computer’s clock`);
  const signer = await pairing(claim.pairingId);
  if (!signer || signer.generation !== claim.generation) return fail(401, 'BROWSER_PAIRING_UNCONFIRMED', 'This Chrome is not paired and confirmed with this account');
  try {
    const key = await crypto.subtle.importKey('raw', browserUnbase64(signer.publicKey), 'Ed25519', false, ['verify']);
    if (!await crypto.subtle.verify('Ed25519', key, browserUnbase64(claim.signature), new TextEncoder().encode(browserSignedText(label, { ...claim, method: request.method, pathname: request.pathname, bodySha256: request.bodySha256 })))) return fail(401, `${code}_SIGNATURE_INVALID`, `Invalid ${noun} signature`);
  } catch { return fail(401, `${code}_SIGNATURE_INVALID`, `Invalid ${noun} signature`); }
  const nonces = z.record(z.string(), z.number()).parse(await storage.get(NONCES) ?? {});
  const key = `${claim.pairingId}:${claim.nonce}`;
  if (nonces[key] !== undefined) return fail(401, `${code}_NONCE_REUSED`, `${Noun} signature already used`);
  const kept = Object.fromEntries(Object.entries(nonces).filter(([, until]) => until > now));
  await storage.put(NONCES, { ...kept, [key]: claim.issuedAt + 2 * SIGNATURE_WINDOW_MS });
  return { ok: true, pairingId: claim.pairingId };
}

/** A signed request's JSON body as a route reads it: a POST of at most its label's bytes with its Content-Length, and
 * the body's SHA-256 the signature covers. */
export async function readBrowserSignedRequest(request: Request, label: BrowserSignedLabel): Promise<{ ok: true; request: BrowserSignedRequest; body: unknown } | BrowserRequestFailure> {
  const { code, noun, Noun, bytes: limit } = SIGNED[label];
  if (request.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', `Send a ${noun} with POST`);
  const declared = Number(request.headers.get('content-length'));
  if (!request.headers.has('content-length') || !Number.isSafeInteger(declared) || declared > limit) return fail(413, `${code}_INVALID`, `Send a ${noun} with at most ${limit} bytes of JSON and its Content-Length`);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength !== declared) return fail(400, `${code}_INVALID`, 'The request does not match its Content-Length');
  const bodySha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return fail(400, `${code}_INVALID`, `${Noun} must be JSON`); }
  return { ok: true, request: { method: request.method, pathname: new URL(request.url).pathname, header: request.headers.get(BROWSER_UPLOAD_HEADER), bodySha256 }, body };
}

/** The answer of the account's browser routes (your Chrome's signed requests, share links): `{status:'ok', value}` or
 * `{status:'error', error:{code, message}}`. */
export function browserRouteReply(reply: { ok: true; value: unknown } | BrowserRequestFailure): Response {
  const body = reply.ok ? { status: 'ok', value: reply.value } : { status: 'error', error: { code: reply.code, message: reply.message } };
  return Response.json(body, { status: reply.ok ? 200 : reply.status, headers: { 'cache-control': 'no-store' } });
}

/**
 * Where a download lands in the workspace's drive (`drive://workspace/<path>`): `browser/downloads/<YYYY-MM-DD>/<name>`
 * under the day it finished, its name made one safe file name, and a name taken there (or `reserved` by an upload still
 * running) getting ` (2)`, ` (3)`… before its extension. Downloads on either browser are named this way.
 */
export async function browserDownloadPath(drive: Pick<WorkspaceDrive, 'list'>, name: string, now: number, reserved: Iterable<string> = []): Promise<string> {
  const folder = `${BROWSER_DRIVE_PREFIX.downloads}${new Date(now).toISOString().slice(0, 10)}/`;
  const taken = new Set([...(await drive.list(folder)).map(entry => entry.path), ...reserved]);
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]+/gu, '_').trim().slice(0, 200);
  const file = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'download';
  const dot = file.lastIndexOf('.'), stem = dot > 0 ? file.slice(0, dot) : file, extension = dot > 0 ? file.slice(dot) : '';
  let path = `${folder}${file}`;
  for (let copy = 2; taken.has(path); copy++) path = `${folder}${stem} (${copy})${extension}`;
  return path;
}

/** Upload sessions, kept in the relay object's storage. */
export class BrowserUploads {
  constructor(private readonly storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>, private readonly authority: BrowserUploadAuthority, private readonly drive: (identity: { projectId: string; workspaceId: string }) => BrowserUploadDrive) {}

  async step(step: BrowserUploadStep): Promise<BrowserUploadReply> {
    if (step.op === 'stored') return this.stored(step);
    if (step.op === 'begin') {
      const signer = await browserRequestSigner(this.storage, pairingId => this.authority.pairing(pairingId), 'upload', step.request);
      return signer.ok ? this.begin(signer.pairingId, step.body) : signer;
    }
    const upload = await this.session(step.pairingId, step.uploadId);
    if (!upload.ok) return upload;
    if (step.op === 'abort') { await this.forget(upload.value); return { ok: true, value: {} }; }
    if (step.op === 'complete') return this.complete(upload.value, step.body);
    const row = upload.value;
    if (step.index !== row.parts) return fail(409, 'UPLOAD_PART_OUT_OF_ORDER', `Expected part ${row.parts + 1}`);
    // Only the last part may be short: a short part ends the drive's upload.
    if (row.size % BROWSER_UPLOAD_PART_BYTES !== 0) return fail(409, 'UPLOAD_PART_SHORT', `Every part but the last is exactly ${BROWSER_UPLOAD_PART_BYTES / 1024 / 1024} MiB; complete this upload`);
    return { ok: true, value: { projectId: row.projectId, workspaceId: row.workspaceId, drive: row.drive } };
  }

  private async session(pairingId: string, uploadId: string): Promise<{ ok: true; value: BrowserUpload } | BrowserRequestFailure> {
    const stored = await this.storage.get(`${UPLOAD}${uploadId}`);
    if (!stored) return SESSION_GONE;
    const row = Upload.parse(stored);
    if (row.pairingId !== pairingId) return SESSION_GONE;
    if (row.expiresAt <= Date.now()) { await this.forget(row); return fail(410, 'UPLOAD_EXPIRED', 'This upload expired; start it again'); }
    return { ok: true, value: row };
  }

  private async forget(row: BrowserUpload): Promise<void> {
    await this.storage.delete(`${UPLOAD}${row.uploadId}`);
    await this.drive(row).discard(row.drive).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_upload_discard_failed', uploadId: row.uploadId, error: String(error) })));
  }

  private async begin(pairingId: string, body: unknown): Promise<BrowserUploadReply> {
    const parsed = Begin.safeParse(body);
    if (!parsed.success) return fail(400, 'UPLOAD_INVALID', `Invalid upload: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
    const input = parsed.data, now = Date.now();
    const group = await this.authority.group(pairingId, input.groupId);
    if (!group) return fail(403, 'UPLOAD_GROUP_UNKNOWN', 'This tab group is not a workspace group of this Chrome');
    if (input.kind === 'download' && !this.authority.attempt(pairingId, input.groupId, input.attemptId)) return fail(403, 'UPLOAD_ATTEMPT_ENDED', 'No script or step of this workspace is running on this group');
    if (input.kind === 'capture' && !await this.authority.capture(pairingId, input.groupId, input.captureId)) return fail(403, 'UPLOAD_CAPTURE_UNKNOWN', 'This capture was not announced on this group, or it ended');
    // Sessions that lapsed go now; those still open count against this Chrome and reserve their names.
    const open: BrowserUpload[] = [];
    for (const stored of (await this.storage.list({ prefix: UPLOAD })).values()) {
      const row = Upload.parse(stored);
      if (row.expiresAt <= now) await this.forget(row); else open.push(row);
    }
    for (const [key, stored] of await this.storage.list({ prefix: BROWSER_DOWNLOAD })) if (BrowserDownloadSchema.parse(stored).expiresAt <= now) await this.storage.delete(key);
    if (open.filter(row => row.pairingId === pairingId).length >= UPLOADS_PER_CHROME) return fail(429, 'UPLOAD_CAPACITY', 'Too many uploads from this Chrome at once');
    const drive = this.drive(group);
    const sameWorkspace = open.filter(row => row.projectId === group.projectId && row.workspaceId === group.workspaceId).map(row => row.path);
    const path = input.kind === 'capture' ? `${captureFolder(input.captureId)}${input.file}` : await browserDownloadPath(drive, input.name, now, sameWorkspace);
    if (input.kind === 'capture' && sameWorkspace.includes(path)) return fail(409, 'UPLOAD_IN_PROGRESS', `${input.file} of this capture is already being uploaded`);
    const uploadId = crypto.randomUUID(), expiresAt = now + BROWSER_UPLOAD_IDLE_MS;
    const row: BrowserUpload = { uploadId, pairingId, ...group, groupId: input.groupId, target: input.kind === 'download' ? { kind: 'download', attemptId: input.attemptId } : { kind: 'capture', captureId: input.captureId, file: input.file }, path, mediaType: input.mediaType, parts: 0, size: 0, drive: await drive.upload(), expiresAt };
    await this.storage.put(`${UPLOAD}${uploadId}`, row);
    return { ok: true, value: { uploadId, pairingId, expiresAt: new Date(expiresAt).toISOString(), path: `drive://workspace/${path.split('/').map(encodeURIComponent).join('/')}` } satisfies z.infer<typeof BrowserUploadBegunSchema> };
  }

  /** The link's route stored part `index` in the drive; the session moves on to the next. */
  private async stored(step: Extract<BrowserUploadStep, { op: 'stored' }>): Promise<BrowserUploadReply> {
    const stored = await this.storage.get(`${UPLOAD}${step.uploadId}`);
    if (!stored) return SESSION_GONE;
    const row = Upload.parse(stored);
    if (row.parts !== step.index) return fail(409, 'UPLOAD_PART_OUT_OF_ORDER', `Expected part ${row.parts + 1}`);
    if (row.size + step.size > DRIVE_FILE_MAX_BYTES) { await this.forget(row); return fail(413, 'UPLOAD_TOO_LARGE', `Drive files are limited to ${DRIVE_FILE_MAX_BYTES / 1024 / 1024 / 1024} GiB`); }
    const next = { ...row, parts: row.parts + 1, size: row.size + step.size, drive: step.drive, expiresAt: Date.now() + BROWSER_UPLOAD_IDLE_MS };
    await this.storage.put(`${UPLOAD}${row.uploadId}`, next);
    return { ok: true, value: { received: next.size } };
  }

  private async complete(row: BrowserUpload, body: unknown): Promise<BrowserUploadReply> {
    const parsed = Complete.safeParse(body);
    if (!parsed.success) return fail(400, 'UPLOAD_INVALID', 'A completed upload names its parts and size');
    if (parsed.data.parts !== row.parts || parsed.data.size !== row.size) return fail(409, 'UPLOAD_INCOMPLETE', `Received ${row.parts} parts, ${row.size} bytes`);
    const file = await this.drive(row).finish(row.drive, row.path, row.mediaType);
    await this.storage.delete(`${UPLOAD}${row.uploadId}`);
    if (row.target.kind === 'download') await this.storage.put(`${BROWSER_DOWNLOAD}${row.target.attemptId}:${row.uploadId}`, { path: row.path, size: file.size, mediaType: row.mediaType, expiresAt: Date.now() + DOWNLOAD_KEEP_MS } satisfies z.infer<typeof BrowserDownloadSchema>);
    else await this.authority.captured(row.target.captureId, row.target.file, file.size);
    return { ok: true, value: { path: `drive://workspace/${row.path.split('/').map(encodeURIComponent).join('/')}`, size: file.size, mediaType: row.mediaType } };
  }
}

/** `POST BROWSER_UPLOAD_PATH`, signed with the pairing key: begins an upload and answers with its link (`upload-link.ts`),
 * the drive path it will have and when its session lapses if no part arrives. */
export async function serveBrowserUpload(request: Request, dependencies: { relay: { browserRelayUpload(step: BrowserUploadStep): Promise<BrowserUploadReply> }; link(target: { pairingId: string; uploadId: string }): Promise<string> }): Promise<Response> {
  if (new URL(request.url).pathname !== BROWSER_UPLOAD_PATH) return browserRouteReply(fail(404, 'UPLOAD_ROUTE_UNKNOWN', 'Unknown upload request'));
  const read = await readBrowserSignedRequest(request, 'upload');
  if (!read.ok) return browserRouteReply(read);
  const begun = await dependencies.relay.browserRelayUpload({ op: 'begin', request: read.request, body: read.body });
  if (!begun.ok) return browserRouteReply(begun);
  const { uploadId, pairingId, path, expiresAt } = BrowserUploadBegunSchema.parse(begun.value);
  return browserRouteReply({ ok: true, value: { link: await dependencies.link({ pairingId, uploadId }), path, expiresAt } });
}
