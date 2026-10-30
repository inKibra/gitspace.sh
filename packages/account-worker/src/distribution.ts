import { machineNativePlatformSchema } from '@gitspace/protocol/deployment';
import { formatInstallMetadata, installScript } from '@gitspace/protocol/install-script';
import { nativeMirrorKey, portableFileKey, portableManifestSchema, type PortableManifest } from '@gitspace/protocol/machine-release';
import { releaseFile } from './channel.js';

const PUBLIC_HEADERS = { 'x-content-type-options': 'nosniff' };
/** The release's client, the one portable file a computer downloads before it is paired. */
const CLIENT_PATH = 'cli/gitspace.js';

/** The release new computers install (`TenantReleasesDO.installRelease`) and its portable manifest, as the account holds
 * it: in its storage, or in the channel for a published release. */
async function installSource(env: Env): Promise<{ sha: string; manifest: PortableManifest; manifestSha256: string; portableKey: string } | null> {
  const release = await env.TENANT_RELEASES.getByName(env.ACCOUNT_ID).installRelease();
  if (!release) return null;
  const file = await releaseFile(env, env.ACCOUNT_ID, release.portable.key, 'GET');
  if (!file?.body) return null;
  const bytes = new Uint8Array(await new Response(file.body).arrayBuffer());
  const manifestSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (`sha256:${manifestSha256}` !== release.portable.hash) return null;
  return { sha: release.sha, manifest: portableManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes))), manifestSha256, portableKey: release.portable.key };
}

function stream(body: ReadableStream<Uint8Array> | null, size: number | null, immutable: boolean): Response {
  const headers = new Headers({ ...PUBLIC_HEADERS, 'content-type': 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  if (size !== null) headers.set('content-length', String(size));
  return new Response(body, { headers });
}

/**
 * The account's installer, entirely from the account's own release (`installSource`): `/install`, the script; and under
 * `/distribution/v1/`, what it downloads before the computer is paired: `install/<platform>.txt` (the release, its
 * portable manifest's digest, the platform's pinned Bun and the client's digest), `natives/<sha256>` (a pinned upstream
 * archive that release names, from the account's copy) and `releases/<release>/cli/gitspace.js`. Everything else a
 * machine needs it reads once paired, through the signed data endpoint. Public: a computer runs it before pairing.
 */
export async function accountDistributionResponse(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname !== '/install' && !pathname.startsWith('/distribution/')) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  const head = request.method === 'HEAD';
  if (pathname === '/install') {
    return new Response(head ? null : installScript(new URL('/distribution/v1', env.ACCOUNT_URL).href), {
      headers: { ...PUBLIC_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' },
    });
  }
  const metadata = /^\/distribution\/v1\/install\/([a-z0-9-]+)\.txt$/u.exec(pathname);
  const native = /^\/distribution\/v1\/natives\/([a-f0-9]{64})$/u.exec(pathname);
  const client = /^\/distribution\/v1\/releases\/([A-Za-z0-9][A-Za-z0-9._-]{0,159})\/cli\/gitspace\.js$/u.exec(pathname);
  if (!metadata && !native && !client) return new Response('Not found', { status: 404, headers: PUBLIC_HEADERS });
  const platform = metadata ? machineNativePlatformSchema.safeParse(metadata[1]) : null;
  if (platform && !platform.success) return new Response('Not found', { status: 404, headers: PUBLIC_HEADERS });
  const source = await installSource(env);
  if (!source) return new Response('This account has no machine release to install yet: launch one with the machine target.', { status: 503, headers: PUBLIC_HEADERS });
  const cli = source.manifest.files.find(file => file.path === CLIENT_PATH);
  if (!cli) return new Response('This account\'s release has no client', { status: 503, headers: PUBLIC_HEADERS });
  if (platform?.success) {
    const bun = source.manifest.natives[platform.data].bun;
    const metadata = formatInstallMetadata({ release: source.sha, portableSha256: source.manifestSha256, bun: { sha256: bun.sha256, size: bun.size, executableSha256: bun.executable.sha256, executableSize: bun.executable.size, member: bun.member }, cli: { sha256: cli.sha256, size: cli.size } });
    return new Response(head ? null : metadata, { headers: { ...PUBLIC_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' } });
  }
  if (native) {
    const named = Object.values(source.manifest.natives).some(files => Object.values(files).some(file => file.sha256 === native[1]));
    const file = named ? await releaseFile(env, env.ACCOUNT_ID, nativeMirrorKey(native[1]!), head ? 'HEAD' : 'GET') : null;
    return file ? stream(file.body, file.size, true) : new Response('Not found', { status: 404, headers: PUBLIC_HEADERS });
  }
  if (client?.[1] !== source.sha) return new Response('Not found', { status: 404, headers: PUBLIC_HEADERS });
  const file = await releaseFile(env, env.ACCOUNT_ID, portableFileKey(source.portableKey, CLIENT_PATH), head ? 'HEAD' : 'GET');
  return file ? stream(file.body, file.size, true) : new Response('Not found', { status: 404, headers: PUBLIC_HEADERS });
}
