const TENANT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function tenantFromHostname(hostname: string, suffix: string): string | null {
  const normalized = hostname.toLowerCase();
  const expectedSuffix = suffix.toLowerCase();
  if (!normalized.endsWith(expectedSuffix)) return null;
  const tenant = normalized.slice(0, -expectedSuffix.length);
  return TENANT_SLUG.test(tenant) ? tenant : null;
}

function platformError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__platform/health') return Response.json({ status: 'ok' });

    const tenant = tenantFromHostname(url.hostname, env.TENANT_HOST_SUFFIX);
    if (!tenant) return platformError(404, 'TENANT_NOT_FOUND', 'Relay tenant hostname is not registered');

    try {
      const userWorker = env.DISPATCHER.get(
        `tenant-${tenant}`,
        {},
        {
          limits: {
            cpuMs: Number(env.DEFAULT_CPU_MS),
            subRequests: Number(env.DEFAULT_SUBREQUESTS),
          },
        },
      );
      return await userWorker.fetch(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return message.startsWith('Worker not found')
        ? platformError(404, 'RELAY_NOT_DEPLOYED', 'Tenant relay is not deployed')
        : platformError(502, 'RELAY_DISPATCH_FAILED', 'Tenant relay dispatch failed');
    }
  },
} satisfies ExportedHandler<Env>;
