import { z } from 'zod';
import { DriveFiles } from './drive-files.js';
import { openToken, sealToken, type SealedTokenKind } from './sealed-token.js';
import { tenantStore, type TenantRange } from './tenant-store.js';

/** How long a minted file URL serves its file. A media element keeps requesting ranges while it plays, so a URL
 * outlasts a viewing; the inspector mints a new one each time a file is opened. */
export const ARTIFACT_FILE_URL_MS = 2 * 60 * 60_000;

/** What a file URL grants: one stored version of one drive file, until `expiresAt`. The device that asked for it was
 * authorized for the file at the time, exactly as a preview read is. */
const FileGrantSchema = z.object({
  version: z.literal(1),
  scopeId: z.string().min(1),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  /** The manifest entry's `object`: set for a file streamed before its digest was known. */
  object: z.string().uuid().optional(),
  size: z.number().int().nonnegative().safe(),
  mediaType: z.string().nullable(),
  name: z.string().max(255),
  expiresAt: z.number().int(),
});
export type ArtifactFileGrant = Omit<z.infer<typeof FileGrantSchema>, 'version' | 'expiresAt'>;
/** A grant as another route's token holds it. */
export const ArtifactFileGrantSchema = FileGrantSchema.omit({ version: true, expiresAt: true });

const FILE_URL: SealedTokenKind = { scope: 'file-url:v1', context: 'gitspace-artifact-file-url-v1' };

/** A sealed URL for one file version: it names nothing readable and cannot be altered or extended. */
export async function mintArtifactFileUrl(env: Env, grant: ArtifactFileGrant): Promise<{ url: string; downloadUrl: string; expiresAt: string }> {
  const expiresAt = Date.now() + ARTIFACT_FILE_URL_MS;
  const token = await sealToken(env, FILE_URL, FileGrantSchema.parse({ version: 1, ...grant, expiresAt }));
  return { url: `/files/${token}`, downloadUrl: `/files/${token}?download=1`, expiresAt: new Date(expiresAt).toISOString() };
}

/** One `bytes=` range of a file of `size` bytes; null serves the whole file (no range, or several, which HTTP lets a
 * server answer in full). */
function requestedRange(header: string | null, size: number): TenantRange | null | 'unsatisfiable' {
  const match = header ? /^bytes=(\d*)-(\d*)$/u.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  if (size === 0) return 'unsatisfiable';
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || start >= size || end < start) return 'unsatisfiable';
  return { offset: start, length: end - start + 1 };
}

/** The headers every served file carries: it can never act as a page of this origin. */
function fileHeaders(): Headers {
  return new Headers({
    'content-security-policy': "sandbox; default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow, noarchive', 'accept-ranges': 'bytes',
  });
}

/** `GET /files/<token>`: the granted file's bytes with byte ranges, for media elements and downloads. The response
 * can never act as a page of this origin: it is sandboxed, never sniffed, and anything but inert media downloads. */
export async function serveArtifactFile(request: Request, env: Env): Promise<Response> {
  const headers = fileHeaders();
  const url = new URL(request.url);
  const match = /^\/files\/([A-Za-z0-9_-]{40,2048})$/u.exec(url.pathname);
  if (!match) return new Response('Not found', { status: 404, headers });
  let grant: z.infer<typeof FileGrantSchema>;
  try { grant = FileGrantSchema.parse(await openToken(env, FILE_URL, match[1]!)); }
  catch { return new Response('Not found', { status: 404, headers }); }
  if (grant.expiresAt <= Date.now()) return new Response('This file link expired; open the file again', { status: 404, headers });
  return serveArtifactGrant(request, env, grant, grant.expiresAt);
}

/** A granted file version's bytes with byte ranges (GET or HEAD), cacheable until `expiresAt` (epoch ms), for a route
 * that checked its own token. */
export async function serveArtifactGrant(request: Request, env: Env, grant: ArtifactFileGrant, expiresAt: number): Promise<Response> {
  const headers = fileHeaders();
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { ...Object.fromEntries(headers), allow: 'GET, HEAD' } });
  const url = new URL(request.url);
  const remaining = Math.max(0, expiresAt - Date.now());
  const etag = `"${grant.hash}"`;
  const mediaType = grant.mediaType && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n]*)?$/u.test(grant.mediaType) ? grant.mediaType : 'application/octet-stream';
  const filename = encodeURIComponent(grant.name).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  headers.set('content-type', mediaType);
  // Only media a browser shows without running anything is inline; HTML, SVG, XML and scripts always download.
  const inline = !url.searchParams.has('download') && ((/^(image|audio|video)\//u.test(mediaType) && mediaType !== 'image/svg+xml') || mediaType === 'application/pdf' || mediaType === 'text/plain');
  headers.set('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="file"; filename*=UTF-8''${filename}`);
  // One version's bytes never change, so a browser keeps them for as long as the URL works.
  headers.set('cache-control', `private, max-age=${Math.floor(remaining / 1000)}, immutable`);
  headers.set('etag', etag);
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  const range = requestedRange(request.headers.get('range'), grant.size);
  if (range === 'unsatisfiable') {
    headers.set('content-range', `bytes */${grant.size}`);
    return new Response('Requested range not satisfiable', { status: 416, headers });
  }
  headers.set('content-length', String(range ? range.length : grant.size));
  if (range) headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${grant.size}`);
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  let body: ReadableStream<Uint8Array>;
  try {
    const file = await new DriveFiles(tenantStore(env), env.ACCOUNT_ID).get(grant.scopeId, { blobHash: grant.hash, size: grant.size, object: grant.object }, range ?? undefined);
    if (file?.size !== grant.size) {
      await file?.body.cancel();
      throw new Error('File is unavailable');
    }
    // A verified whole body has no length of its own; a fixed length keeps the Content-Length set above.
    body = file.body.pipeThrough(new FixedLengthStream(range ? range.length : grant.size));
  } catch {
    headers.delete('content-length'); headers.delete('content-range');
    return new Response('File is unavailable', { status: 404, headers });
  }
  return new Response(body, { status, headers });
}
