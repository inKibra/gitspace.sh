export async function tenantPlatformJson<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const target = new URL(`/__platform/tenants/${encodeURIComponent(env.TENANT_ID)}${path}`, env.PLATFORM_URL);
  const request = new Request(target, {
    ...init,
    headers: { authorization: `Bearer ${env.PLATFORM_TOKEN}`, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    redirect: 'manual',
  });
  const response = env.PLATFORM_SERVICE ? await env.PLATFORM_SERVICE.fetch(request) : await fetch(request);
  if (!response.ok) throw new Error(`Platform request failed (${response.status}): ${(await response.text()).slice(0, 512)}`);
  return await response.json() as T;
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
