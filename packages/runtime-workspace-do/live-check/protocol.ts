import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { validateSnapshotPath, type ArtifactsFetch } from '../src/artifacts-snapshot.js';

const repository = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
export const authorizationSchema = z.object({
  authorize: z.literal('create-disposable-fork-and-push-snapshot'),
  namespace: z.string().min(1), sourceRepository: repository, forkRepository: repository,
  checkpoint: RuntimeGitCheckpointSchema, probePath: z.string().min(1),
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
  const parsed = authorizationSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid live-check authorization');
  return run(parsed.data);
}
export const maxBytes = 1024 * 1024;
export function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
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
/** Reject all redirects: credentials can never follow a redirect. */
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

/** Git smart HTTP v0 upload-pack discovery is the wire equivalent of ls-remote. */
export async function verifyPublishedRef(repo: Pick<ArtifactsRepo, 'info' | 'createToken' | 'revokeToken'>, ref: string, commit: string, rememberSecret: (value: string) => void, request: ArtifactsFetch = fetch): Promise<void> {
  const remote = httpsURL((await repo.info()).remote);
  if (remote.search) throw new Error('Git remote must not contain a query');
  const token = await repo.createToken('read', 60);
  rememberSecret(token.plaintext);
  rememberSecret(token.id);
  try {
    const response = await boundedFetch(request)(`${remote.href.replace(/\/$/u, '')}/info/refs?service=git-upload-pack`, {
      headers: { Authorization: `Bearer ${token.plaintext}`, Accept: 'application/x-git-upload-pack-advertisement' },
    });
    if (!response.ok) throw new Error(`Git ls-remote failed (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const decoder = new TextDecoder();
    let found: string | undefined;
    let service = false;
    for (let offset = 0; offset < bytes.length;) {
      const prefix = decoder.decode(bytes.subarray(offset, offset + 4));
      if (!/^[0-9a-f]{4}$/u.test(prefix)) throw new Error('Invalid Git ls-remote packet');
      const size = Number.parseInt(prefix, 16);
      offset += 4;
      if (size === 0) continue;
      if (size < 4 || offset + size - 4 > bytes.length) throw new Error('Truncated Git ls-remote packet');
      const line = decoder.decode(bytes.subarray(offset, offset + size - 4));
      offset += size - 4;
      if (line === '# service=git-upload-pack\n') { service = true; continue; }
      const advertised = /^([0-9a-f]{40}) ([^\0\n]+)(?:\0[^\n]*)?\n?$/u.exec(line);
      if (!advertised) throw new Error('Invalid Git ls-remote advertisement');
      if (advertised[2] === ref) found = advertised[1];
    }
    if (!service || found !== commit) throw new Error('Published checkpoint ref differs or is absent');
  } finally {
    if (!await repo.revokeToken(token.id)) throw new Error('Git verification token revocation failed');
  }
}

export function scrubFailure(error: unknown, secrets: Iterable<string> = []): string {
  let message = error instanceof Error ? error.message : 'Unknown live-check failure';
  for (const secret of secrets) {
    if (secret) for (const value of [secret, encodeURIComponent(secret)]) message = message.split(value).join('[redacted]');
  }
  return message
    .replace(/https?:\/\/[^\s<>"']+/giu, '[redacted-url]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/giu, '[redacted-authorization]')
    .replace(/\b(?:token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/giu, '[redacted-credential]')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 1000);
}
