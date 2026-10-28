import { machineNativePlatformSchema } from '@gitspace/protocol/deployment';
import { machineClientSchema } from '@gitspace/protocol/default-release';
import { installScript } from '@gitspace/protocol/install-script';
import { tenantPlatformFetch, tenantPlatformJson } from './tenant-platform.js';

const PUBLIC_HEADERS = { 'x-content-type-options': 'nosniff' };

/**
 * The account's installer: `/install` installs from this account's address, whose `stable/<platform>.txt` names the
 * client of the account's release (the platform's stable client where that release has none) and whose
 * `releases/<release>/<platform>/gitspace` serves those bytes. Public: a computer runs it before pairing.
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
  const stable = /^\/distribution\/v1\/stable\/([a-z0-9-]+)\.txt$/u.exec(pathname);
  const download = /^\/distribution\/v1\/releases\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([a-z0-9-]+)\/gitspace$/u.exec(pathname);
  const platform = machineNativePlatformSchema.safeParse(stable?.[1] ?? download?.[2]);
  if (!platform.success) return new Response('Not found', { status: 404, headers: PUBLIC_HEADERS });
  if (!download) {
    const answer = await tenantPlatformJson<unknown>(env, `/machine-release/client/${platform.data}`).then(value => machineClientSchema.safeParse(value), () => null);
    if (!answer?.success || answer.data.platform !== platform.data) return new Response('Release channel unavailable', { status: 503, headers: PUBLIC_HEADERS });
    return new Response(head ? null : `gitspace-distribution-v1\n${answer.data.release}\n${answer.data.sha256}\n`, {
      headers: { ...PUBLIC_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' },
    });
  }
  const response = await tenantPlatformFetch(env, `/machine-release/client/${platform.data}/${download[1]}`, { method: request.method, signal: request.signal });
  if (!response.ok) {
    await response.body?.cancel();
    return response.status === 404 ? new Response('Not found', { status: 404, headers: PUBLIC_HEADERS }) : new Response('Client unavailable', { status: 503, headers: PUBLIC_HEADERS });
  }
  const headers = new Headers({ ...PUBLIC_HEADERS, 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' });
  const length = response.headers.get('content-length');
  if (length !== null) headers.set('content-length', length);
  return new Response(head ? null : response.body, { headers });
}
