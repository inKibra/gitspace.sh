import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { validateSnapshotPath, type ArtifactsFetch } from '../src/artifacts-snapshot.js';

const repository = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
export const authorizationSchema = z.object({
  authorize: z.literal('create-disposable-fork-and-upload-lfs'),
  namespace: z.string().min(1),
  sourceRepository: repository,
  forkRepository: repository,
  checkpoint: RuntimeGitCheckpointSchema,
  probePath: z.string().min(1),
  probeSha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).superRefine((value, context) => {
  if (value.sourceRepository === value.forkRepository) context.addIssue({ code: 'custom', message: 'Fork must differ from source' });
  try { validateSnapshotPath(value.probePath); }
  catch { context.addIssue({ code: 'custom', message: 'Invalid probe path' }); }
});
export type Authorization = z.infer<typeof authorizationSchema>;

/** The callback is the first point at which bindings, Wrangler or network may be touched. */
export async function authorized<T>(optIn: boolean, input: unknown, run: (authorization: Authorization) => Promise<T>): Promise<T> {
  if (!optIn) throw new Error('Explicit --authorize-live flag is required');
  return run(authorizationSchema.parse(input));
}

export const maxBytes = 1024 * 1024;
export function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function lfsPointer(bytes: Uint8Array): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256(bytes)}\nsize ${bytes.byteLength}\n`;
}
export function httpsURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Unsafe HTTPS action URL');
  return url;
}
export async function boundedBody(response: Response, limit = maxBytes): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new Error('Response exceeds byte limit');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error('Response exceeds byte limit');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Reject all redirects, including same-origin ones: credentials can never follow a redirect. */
export function boundedFetch(request: ArtifactsFetch): ArtifactsFetch {
  return async (input, init) => {
    httpsURL(input);
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(init?.signal ? [init.signal] : [])]);
    const response = await request(input, { ...init, signal, redirect: 'error' });
    if (response.status >= 300 && response.status < 400) throw new Error('HTTP redirect rejected');
    const bytes = await boundedBody(response);
    return new Response(bytes.byteLength ? bytes : null, { status: response.status, headers: response.headers });
  };
}

const actionSchema = z.object({ href: z.string(), header: z.record(z.string(), z.string()).optional() });
const batchSchema = z.object({
  transfer: z.literal('basic').optional(),
  objects: z.array(z.object({
    oid: z.string(), size: z.number().int().nonnegative(),
    error: z.object({ code: z.number(), message: z.string() }).optional(),
    actions: z.object({ upload: actionSchema.optional(), download: actionSchema.optional(), verify: actionSchema.optional() }).optional(),
  })).length(1),
});

export async function lfsRoundTrip(remoteValue: string, token: string, bytes: Uint8Array<ArrayBuffer>, request: ArtifactsFetch = fetch) {
  if (!bytes.byteLength || bytes.byteLength > maxBytes) throw new Error('Invalid LFS payload size');
  const remote = httpsURL(remoteValue);
  if (remote.search) throw new Error('Git remote must not contain a query');
  const endpoint = `${remote.href.replace(/\/$/u, '')}/info/lfs/objects/batch`;
  const oid = sha256(bytes);
  const size = bytes.byteLength;
  const send = boundedFetch(request);
  const batch = async (operation: 'upload' | 'download') => {
    const response = await send(endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
      body: JSON.stringify({ operation, transfers: ['basic'], objects: [{ oid, size }] }),
    });
    if (!response.ok) throw new Error(`LFS ${operation} batch failed (${response.status})`);
    const parsed = batchSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Invalid or unsupported LFS batch response');
    const object = parsed.data.objects[0]!;
    if (object.error) throw new Error(`LFS object rejected (${object.error.code})`);
    if (object.oid !== oid || object.size !== size) throw new Error('LFS batch identity mismatch');
    return object.actions;
  };
  const perform = async (action: z.infer<typeof actionSchema>, method: 'PUT' | 'GET' | 'POST', body?: Uint8Array<ArrayBuffer> | string) => {
    const target = httpsURL(action.href);
    if (target.origin !== remote.origin && decodeURIComponent(target.href).includes(token)) throw new Error('Repository token cannot cross origins');
    const headers = new Headers();
    for (const [name, value] of Object.entries(action.header ?? {})) {
      if (/^(host|cookie|proxy-authorization|connection|transfer-encoding|content-length)$/iu.test(name)) throw new Error('Unsafe LFS action header');
      if (target.origin !== remote.origin && value.includes(token)) throw new Error('Repository token cannot cross origins');
      headers.set(name, value);
    }
    // Action-specific credentials are authoritative; never inherit repository credentials.
    if (method === 'POST') headers.set('Content-Type', 'application/vnd.git-lfs+json');
    const response = await send(target.href, { method, headers, body });
    if (!response.ok) throw new Error(`LFS ${method} action failed (${response.status})`);
    return response;
  };
  const upload = await batch('upload');
  // Synthetic random content must actually upload; missing support is not a pass.
  if (!upload?.upload) throw new Error('LFS upload action missing');
  await perform(upload.upload, 'PUT', bytes);
  if (upload.verify) await perform(upload.verify, 'POST', JSON.stringify({ oid, size }));
  const download = await batch('download');
  if (!download?.download) throw new Error('LFS download action missing');
  const downloaded = await boundedBody(await perform(download.download, 'GET'));
  if (downloaded.byteLength !== size || sha256(downloaded) !== oid) throw new Error('LFS downloaded payload digest or size mismatch');
  return { oid, size, downloadedSha256: sha256(downloaded), downloadedSize: downloaded.byteLength, uploaded: true, verified: upload.verify !== undefined };
}
