import { z } from 'zod';
import { credentialProtocolBase64, deriveArtifactScopeKey } from '@gitspace/protocol';
import { readArtifactObject, type ArtifactByteRange } from './artifact-object-reader.js';

/** How long a minted file URL serves its file. A media element keeps requesting ranges while it plays, so a URL
 * outlasts a viewing; the inspector mints a new one each time a file is opened. */
export const ARTIFACT_FILE_URL_MS = 2 * 60 * 60_000;

/** What a file URL grants: one stored version of one drive file, until `expiresAt`. The device that asked for it was
 * authorized for the file at the time, exactly as a preview read is. */
const FileGrantSchema = z.object({
  version: z.literal(1),
  scopeId: z.string().min(1),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  size: z.number().int().nonnegative().safe(),
  mediaType: z.string().nullable(),
  name: z.string().max(255),
  expiresAt: z.number().int(),
});
export type ArtifactFileGrant = Omit<z.infer<typeof FileGrantSchema>, 'version' | 'expiresAt'>;

const GRANT_CONTEXT = new TextEncoder().encode('gitspace-artifact-file-url-v1');

/** Sealing key for file URLs, derived under a label no artifact scope can take (scopes are `space:<id>`), so a URL
 * shares no key with stored bytes. */
async function grantKey(env: Env): Promise<CryptoKey> {
  const projectKey = credentialProtocolBase64.decode(await env.CREDENTIALS.getByName(env.ACCOUNT_ID).artifactKey(env.ACCOUNT_ID));
  return crypto.subtle.importKey('raw', new Uint8Array(await deriveArtifactScopeKey(projectKey, 'file-url:v1')), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** A sealed URL for one file version: it names nothing readable and cannot be altered or extended. */
export async function mintArtifactFileUrl(env: Env, grant: ArtifactFileGrant): Promise<{ url: string; downloadUrl: string; expiresAt: string }> {
  const expiresAt = Date.now() + ARTIFACT_FILE_URL_MS;
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const body = new TextEncoder().encode(JSON.stringify(FileGrantSchema.parse({ version: 1, ...grant, expiresAt })));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: GRANT_CONTEXT }, await grantKey(env), body));
  const token = Buffer.concat([nonce, sealed]).toString('base64url');
  return { url: `/files/${token}`, downloadUrl: `/files/${token}?download=1`, expiresAt: new Date(expiresAt).toISOString() };
}

async function openFileGrant(env: Env, token: string): Promise<z.infer<typeof FileGrantSchema>> {
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.byteLength <= 12 + 16) throw new Error('Malformed file URL');
  const body = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: GRANT_CONTEXT }, await grantKey(env), bytes.subarray(12));
  return FileGrantSchema.parse(JSON.parse(new TextDecoder().decode(body)));
}

/** One `bytes=` range of a file of `size` bytes; null serves the whole file (no range, or several, which HTTP lets a
 * server answer in full). */
function requestedRange(header: string | null, size: number): ArtifactByteRange | null | 'unsatisfiable' {
  const match = header ? /^bytes=(\d*)-(\d*)$/u.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  if (size === 0) return 'unsatisfiable';
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

/** `GET /files/<token>`: the granted file's bytes with byte ranges, for media elements and downloads. The response
 * can never act as a page of this origin: it is sandboxed, never sniffed, and anything but inert media downloads. */
export async function serveArtifactFile(request: Request, env: Env): Promise<Response> {
  const headers = new Headers({
    'content-security-policy': "sandbox; default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow, noarchive', 'accept-ranges': 'bytes',
  });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { ...Object.fromEntries(headers), allow: 'GET, HEAD' } });
  const url = new URL(request.url);
  const match = /^\/files\/([A-Za-z0-9_-]{40,2048})$/u.exec(url.pathname);
  if (!match) return new Response('Not found', { status: 404, headers });
  let grant: z.infer<typeof FileGrantSchema>;
  try { grant = await openFileGrant(env, match[1]!); }
  catch { return new Response('Not found', { status: 404, headers }); }
  const remaining = grant.expiresAt - Date.now();
  if (remaining <= 0) return new Response('This file link expired; open the file again', { status: 404, headers });
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
  headers.set('content-length', String(range ? range.end - range.start + 1 : grant.size));
  if (range) headers.set('content-range', `bytes ${range.start}-${range.end}/${grant.size}`);
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  let parts: AsyncIterable<Uint8Array<ArrayBuffer>>;
  try {
    const projectKey = credentialProtocolBase64.decode(await env.CREDENTIALS.getByName(env.ACCOUNT_ID).artifactKey(env.ACCOUNT_ID));
    parts = await readArtifactObject(env, env.ACCOUNT_ID, grant.hash, await deriveArtifactScopeKey(projectKey, grant.scopeId), grant.size, range ?? undefined);
  } catch {
    headers.delete('content-length'); headers.delete('content-range');
    return new Response('File is unavailable', { status: 404, headers });
  }
  const iterator = parts[Symbol.asyncIterator]();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        await iterator.return?.();
        controller.error(error);
      }
    },
    async cancel() { await iterator.return?.(); },
  }, { highWaterMark: 0 }), { status, headers });
}
