import { z } from 'zod';
import { DRIVE_FILE_MAX_BYTES, TENANT_OBJECT_PART_BYTES } from '@gitspace/protocol';
import { BROWSER_DRIVE_PREFIX, browserUnbase64 } from '@gitspace/protocol-runtime';
import { CAPTURE_FILES, captureFolder } from './browser-capture.js';
import { DriveUploadSchema } from './drive-files.js';
import type { WorkspaceDrive } from './workspace-drive.js';

/**
 * Files from your Chrome into the workspace's drive (docs/APERTURE-DESIGN.md §11, Batch 16): downloads a script or step
 * started there, and the media of captures. The extension sends them over HTTPS to the account, never over the relay
 * WebSocket, each request signed with its pairing key; the relay object checks the signature against the confirmed
 * pairing and keeps each upload session, and the bytes go straight to the drive part by part.
 *
 * `POST /api/browser-relay/uploads` begins one; `PUT …/<uploadId>/parts/<index>` sends parts in order, each exactly
 * 32 MiB but the last (the drive's multipart part size; resending the last part with the same bytes only keeps the
 * session alive); `POST …/<uploadId>/complete` names the file in the drive; `DELETE …/<uploadId>` abandons it. A session
 * lapses 45 minutes after its last request, longer than a capture records.
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
const JSON_BODY_BYTES = 16 * 1024;
const NONCES = 'browser.relay.upload-nonces';
const UPLOAD = 'browser.relay.upload:';
export const BROWSER_DOWNLOAD = 'browser.relay.download:';

/** The text a pairing key signs for one upload request. */
export function browserUploadSignedText(input: { pairingId: string; generation: number; method: string; pathname: string; bodySha256: string; issuedAt: number; nonce: string }): string {
  return `gitspace-browser-relay-v2:upload:${input.pairingId}:${input.generation}:${input.method}:${input.pathname}:${input.bodySha256}:${input.issuedAt}:${input.nonce}`;
}
const Signature = z.object({ pairingId: z.string().uuid(), generation: z.number().int().nonnegative(), issuedAt: z.number().int(), nonce: z.string().regex(/^[a-f0-9]{64}$/u), signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u).max(128) });
const Begin = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('download'), groupId: z.string().uuid(), attemptId: z.string().min(1).max(256), name: z.string().min(1).max(512), mediaType: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal('capture'), groupId: z.string().uuid(), captureId: z.string().uuid(), file: z.enum(['video.webm', 'frames.bin', 'frames.json', 'thumbnail.jpg']), mediaType: z.string().min(1).max(128) }),
]);
const Complete = z.strictObject({ parts: z.number().int().positive(), size: z.number().int().positive().max(DRIVE_FILE_MAX_BYTES) });
const Upload = z.object({
  uploadId: z.string().uuid(), pairingId: z.string().uuid(), projectId: z.string(), workspaceId: z.string(), groupId: z.string().uuid(),
  target: z.discriminatedUnion('kind', [z.object({ kind: z.literal('download'), attemptId: z.string() }), z.object({ kind: z.literal('capture'), captureId: z.string().uuid(), file: Begin.options[1].shape.file })]),
  path: z.string(), mediaType: z.string(), parts: z.number().int().nonnegative(), size: z.number().int().nonnegative(), last: z.string().nullable(), drive: DriveUploadSchema, expiresAt: z.number().int(),
});
export type BrowserUpload = z.infer<typeof Upload>;
/** A finished download, kept for the run that started it (workspace-relative drive path). */
export const BrowserDownloadSchema = z.object({ path: z.string(), size: z.number().int().nonnegative(), mediaType: z.string(), expiresAt: z.number().int() });

/** One signed request as the route saw it. */
export type BrowserUploadRequest = { method: string; pathname: string; header: string | null; bodySha256: string };
export type BrowserUploadStep =
  | { op: 'begin'; request: BrowserUploadRequest; body: unknown }
  | { op: 'part'; request: BrowserUploadRequest; uploadId: string; index: number }
  | { op: 'stored'; uploadId: string; index: number; bodySha256: string; size: number; drive: z.infer<typeof DriveUploadSchema> }
  | { op: 'complete'; request: BrowserUploadRequest; uploadId: string; body: unknown }
  | { op: 'abort'; request: BrowserUploadRequest; uploadId: string };
type Failure = { ok: false; status: number; code: string; message: string };
export type BrowserUploadReply = { ok: true; value: Record<string, unknown> } | Failure;
/** What `part` tells the route: store the part from `drive` in that workspace's drive, or nothing to store. */
export const BrowserUploadPartSchema = z.discriminatedUnion('store', [
  z.object({ store: z.literal(true), projectId: z.string(), workspaceId: z.string(), drive: DriveUploadSchema }),
  z.object({ store: z.literal(false), index: z.number().int(), received: z.number().int() }),
]);
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

const fail = (status: number, code: string, message: string): Failure => ({ ok: false, status, code, message });
const SESSION_GONE = fail(404, 'UPLOAD_UNKNOWN', 'Unknown upload');

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
    const signer = await this.signer(step.request);
    if (!signer.ok) return signer;
    if (step.op === 'begin') return this.begin(signer.pairingId, step.body);
    const upload = await this.session(signer.pairingId, step.uploadId);
    if (!upload.ok) return upload;
    if (step.op === 'abort') { await this.forget(upload.value); return { ok: true, value: {} }; }
    if (step.op === 'complete') return this.complete(upload.value, step.body);
    const row = upload.value;
    if (step.index === row.parts) {
      // Only the last part may be short: a short part ends the drive's upload.
      if (row.size % BROWSER_UPLOAD_PART_BYTES !== 0) return fail(409, 'UPLOAD_PART_SHORT', `Every part but the last is exactly ${BROWSER_UPLOAD_PART_BYTES / 1024 / 1024} MiB; complete this upload`);
      return { ok: true, value: { store: true, projectId: row.projectId, workspaceId: row.workspaceId, drive: row.drive } };
    }
    // The same last part again keeps the session alive (the extension's keep-alive while a recording is quiet).
    if (step.index === row.parts - 1 && step.request.bodySha256 === row.last) {
      await this.storage.put(`${UPLOAD}${row.uploadId}`, { ...row, expiresAt: Date.now() + BROWSER_UPLOAD_IDLE_MS });
      return { ok: true, value: { store: false, index: step.index, received: row.size } };
    }
    return fail(409, 'UPLOAD_PART_OUT_OF_ORDER', `Expected part ${row.parts}`);
  }

  /** The confirmed pairing whose key signed this request, once per nonce. */
  private async signer(request: BrowserUploadRequest): Promise<{ ok: true; pairingId: string } | Failure> {
    if (!request.header || request.header.length > 1024) return fail(401, 'UPLOAD_SIGNATURE_REQUIRED', 'A signed upload is required');
    let claim: z.infer<typeof Signature>;
    try { claim = Signature.parse(JSON.parse(atob(request.header.replaceAll('-', '+').replaceAll('_', '/')))); }
    catch { return fail(401, 'UPLOAD_SIGNATURE_INVALID', 'Invalid upload signature'); }
    const now = Date.now();
    if (Math.abs(now - claim.issuedAt) > SIGNATURE_WINDOW_MS) return fail(401, 'UPLOAD_SIGNATURE_EXPIRED', 'Upload signature expired; check this computer’s clock');
    const pairing = await this.authority.pairing(claim.pairingId);
    if (!pairing || pairing.generation !== claim.generation) return fail(401, 'BROWSER_PAIRING_UNCONFIRMED', 'This Chrome is not paired and confirmed with this account');
    try {
      const key = await crypto.subtle.importKey('raw', browserUnbase64(pairing.publicKey), 'Ed25519', false, ['verify']);
      if (!await crypto.subtle.verify('Ed25519', key, browserUnbase64(claim.signature), new TextEncoder().encode(browserUploadSignedText({ ...claim, method: request.method, pathname: request.pathname, bodySha256: request.bodySha256 })))) return fail(401, 'UPLOAD_SIGNATURE_INVALID', 'Invalid upload signature');
    } catch { return fail(401, 'UPLOAD_SIGNATURE_INVALID', 'Invalid upload signature'); }
    const nonces = z.record(z.string(), z.number()).parse(await this.storage.get(NONCES) ?? {});
    const key = `${claim.pairingId}:${claim.nonce}`;
    if (nonces[key] !== undefined) return fail(401, 'UPLOAD_NONCE_REUSED', 'Upload signature already used');
    const kept = Object.fromEntries(Object.entries(nonces).filter(([, until]) => until > now));
    await this.storage.put(NONCES, { ...kept, [key]: claim.issuedAt + 2 * SIGNATURE_WINDOW_MS });
    return { ok: true, pairingId: claim.pairingId };
  }

  private async session(pairingId: string, uploadId: string): Promise<{ ok: true; value: BrowserUpload } | Failure> {
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
    const row: BrowserUpload = { uploadId, pairingId, ...group, groupId: input.groupId, target: input.kind === 'download' ? { kind: 'download', attemptId: input.attemptId } : { kind: 'capture', captureId: input.captureId, file: input.file }, path, mediaType: input.mediaType, parts: 0, size: 0, last: null, drive: await drive.upload(), expiresAt };
    await this.storage.put(`${UPLOAD}${uploadId}`, row);
    return { ok: true, value: { uploadId, expiresAt: new Date(expiresAt).toISOString(), path: `drive://workspace/${path.split('/').map(encodeURIComponent).join('/')}` } };
  }

  /** The route stored part `index` in the drive; the session moves on to the next. */
  private async stored(step: Extract<BrowserUploadStep, { op: 'stored' }>): Promise<BrowserUploadReply> {
    const stored = await this.storage.get(`${UPLOAD}${step.uploadId}`);
    if (!stored) return SESSION_GONE;
    const row = Upload.parse(stored);
    if (row.parts !== step.index) return fail(409, 'UPLOAD_PART_OUT_OF_ORDER', `Expected part ${row.parts}`);
    if (row.size + step.size > DRIVE_FILE_MAX_BYTES) { await this.forget(row); return fail(413, 'UPLOAD_TOO_LARGE', `Drive files are limited to ${DRIVE_FILE_MAX_BYTES / 1024 / 1024 / 1024} GiB`); }
    const next = { ...row, parts: row.parts + 1, size: row.size + step.size, last: step.bodySha256, drive: step.drive, expiresAt: Date.now() + BROWSER_UPLOAD_IDLE_MS };
    await this.storage.put(`${UPLOAD}${row.uploadId}`, next);
    return { ok: true, value: { index: step.index, received: next.size } };
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

/** Reads a request body of at most `limit` bytes, or null when it is longer. */
async function boundedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) return null;
  if (!request.body) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    parts.push(read.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return body;
}

/** The public route (`BROWSER_UPLOAD_PATH`): parses and hashes each request, has the relay check and keep the session,
 * and stores each part's bytes in the workspace's drive from here, so they never pass through the relay object. */
export async function serveBrowserUpload(request: Request, dependencies: { relay: { browserRelayUpload(step: BrowserUploadStep): Promise<BrowserUploadReply> }; drive(identity: { projectId: string; workspaceId: string }): Pick<WorkspaceDrive, 'append'> }): Promise<Response> {
  const reply = (result: BrowserUploadReply) => result.ok ? Response.json({ status: 'ok', value: result.value }, { headers: { 'cache-control': 'no-store' } }) : Response.json({ status: 'error', error: { code: result.code, message: result.message } }, { status: result.status, headers: { 'cache-control': 'no-store' } });
  const url = new URL(request.url);
  const [uploadId, kind, index, ...rest] = url.pathname.slice(BROWSER_UPLOAD_PATH.length).split('/').filter(Boolean);
  const route = !uploadId ? (request.method === 'POST' ? 'begin' : null)
    : !z.string().uuid().safeParse(uploadId).success || rest.length ? null
      : kind === 'parts' && index !== undefined && /^(0|[1-9][0-9]{0,5})$/u.test(index) ? (request.method === 'PUT' ? 'part' : null)
        : kind === 'complete' && index === undefined ? (request.method === 'POST' ? 'complete' : null)
          : kind === undefined ? (request.method === 'DELETE' ? 'abort' : null) : null;
  if (!route || !uploadId && route !== 'begin') return reply(fail(404, 'UPLOAD_ROUTE_UNKNOWN', 'Unknown upload request'));
  const body = await boundedBody(request, route === 'part' ? BROWSER_UPLOAD_PART_BYTES : JSON_BODY_BYTES);
  if (!body) return reply(fail(413, 'UPLOAD_PART_TOO_LARGE', route === 'part' ? `Upload parts are at most ${BROWSER_UPLOAD_PART_BYTES / 1024 / 1024} MiB` : 'Upload request too large'));
  const bodySha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const signed = { method: request.method, pathname: url.pathname, header: request.headers.get(BROWSER_UPLOAD_HEADER), bodySha256 };
  let json: unknown = null;
  if (route === 'begin' || route === 'complete') {
    try { json = JSON.parse(new TextDecoder().decode(body)); } catch { return reply(fail(400, 'UPLOAD_INVALID', 'Upload request must be JSON')); }
  }
  if (route === 'begin') return reply(await dependencies.relay.browserRelayUpload({ op: 'begin', request: signed, body: json }));
  if (!uploadId) return reply(SESSION_GONE);
  if (route === 'complete') return reply(await dependencies.relay.browserRelayUpload({ op: 'complete', request: signed, uploadId, body: json }));
  if (route === 'abort') return reply(await dependencies.relay.browserRelayUpload({ op: 'abort', request: signed, uploadId }));
  if (!body.byteLength) return reply(fail(400, 'UPLOAD_PART_EMPTY', 'An upload part holds at least one byte'));
  const part = Number(index);
  const checked = await dependencies.relay.browserRelayUpload({ op: 'part', request: signed, uploadId, index: part });
  if (!checked.ok) return reply(checked);
  const next = BrowserUploadPartSchema.parse(checked.value);
  if (!next.store) return reply({ ok: true, value: { index: next.index, received: next.received } });
  const drive = await dependencies.drive(next).append(next.drive, body);
  return reply(await dependencies.relay.browserRelayUpload({ op: 'stored', uploadId, index: part, bodySha256, size: body.byteLength, drive }));
}
