import { platformDeployResponseSchema, type PlatformDeployRequest, type ReleaseStatus } from '@gitspace/protocol/deployment';
import type { WorkerVersion } from './tenant-releases.js';

export async function tenantPlatformFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const target = new URL(`/__platform/tenants/${encodeURIComponent(env.TENANT_ID)}${path}`, env.PLATFORM_URL);
  const request = new Request(target, {
    ...init,
    headers: { authorization: `Bearer ${env.PLATFORM_TOKEN}`, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    redirect: 'manual',
  });
  return env.PLATFORM_SERVICE ? env.PLATFORM_SERVICE.fetch(request) : fetch(request);
}

export async function tenantPlatformJson<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const response = await tenantPlatformFetch(env, path, init);
  if (!response.ok) throw new Error(`Platform request failed (${response.status}): ${(await response.text()).slice(0, 512)}`);
  return await response.json() as T;
}

/** The Worker the platform records for this tenant; a channel version has no release sha. */
export async function tenantWorkerVersion(env: Env, userId: string): Promise<WorkerVersion> {
  if (userId !== env.ACCOUNT_ID) throw new Error('Tenant identity does not match');
  const state = await tenantPlatformJson<{ deployment: { active: string | null } }>(env, '/state');
  const version = state.deployment.active;
  return { sha: version === 'channel' || version?.startsWith('channel:') ? null : version, version };
}

/** A Worker swap as the account records it: applied, or failed with the platform's reason. */
export interface WorkerSwap {
  status: ReleaseStatus;
  error: string | null;
}

/** Asks the platform to swap this account's Worker to a release (`/deploy`); only a healthy swap of it is applied. */
export async function platformDeploy(env: Env, body: PlatformDeployRequest & { accountId: string }): Promise<WorkerSwap> {
  try {
    const response = await tenantPlatformFetch(env, '/deploy', { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) return { status: 'failed', error: `Platform /deploy failed with HTTP ${response.status}: ${(await response.text()).slice(0, 512)}` };
    const result = platformDeployResponseSchema.parse(await response.json());
    if (result.revertedTo !== null) return { status: 'failed', error: `Platform reverted to ${result.revertedTo}: ${result.sha} did not pass its health probe` };
    if (!result.healthy) return { status: 'failed', error: `Platform reported ${result.sha} unhealthy` };
    return { status: 'applied', error: null };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : 'Platform /deploy failed' };
  }
}

/** The platform binds the request to its stored tenant identity, not caller headers. */
export function tenantProvider(env: Env): Pick<Fetcher, 'fetch'> {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init);
      const original = new URL(request.url);
      const url = new URL(`/__platform/tenants/${encodeURIComponent(env.TENANT_ID)}/provider/compute${original.pathname}${original.search}`, env.PLATFORM_URL);
      const headers = new Headers(request.headers);
      headers.set('x-gitspace-provider-token', env.PLATFORM_TOKEN);
      headers.delete('host');
      return (env.PLATFORM_SERVICE ?? { fetch }).fetch(new Request(url, { method: request.method, headers, body: request.body, signal: request.signal, redirect: 'manual' }));
    },
  };
}
