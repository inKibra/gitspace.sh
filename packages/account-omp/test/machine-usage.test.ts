import { describe, expect, it } from 'bun:test';
import { AuthStorage } from '@oh-my-pi/pi-ai';
import { AuthBrokerClient, RemoteAuthCredentialStore, type SnapshotResponse } from '@oh-my-pi/pi-ai/auth-broker';
import { claudeUsageProvider } from '@oh-my-pi/pi-ai/usage/claude';
import { openaiCodexUsageProvider } from '@oh-my-pi/pi-ai/usage/openai-codex';

const providers = ['openai-codex', 'anthropic'] as const;

function transport(handler: (request: Request) => Response): typeof fetch {
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => handler(new Request(input, init)),
    { preconnect: fetch.preconnect },
  );
}

async function fixture(expiresInMs = 3_600_000) {
  const now = Date.now();
  const snapshot: SnapshotResponse = {
    generation: 1,
    generatedAt: now,
    serverNowMs: now,
    refresher: { enabled: false, intervalMs: 60_000, skewMs: 60_000, nextSweepInMs: 60_000 },
    credentials: providers.flatMap((provider, index) => ['hot', 'cool'].map((temperature, offset) => ({
      id: index * 2 + offset + 1,
      provider,
      identityKey: `${provider}-${temperature}`,
      rotatesInMs: null,
      credential: {
        type: 'oauth' as const,
        access: `${provider}-${temperature}`,
        refresh: '__remote__' as const,
        expires: now + expiresInMs,
        accountId: `${provider}-${temperature}`,
        email: `${provider}-${temperature}@example.test`,
      },
    }))),
  };
  const brokerRequests: string[] = [];
  const providerRequests: { url: string; token: string }[] = [];
  const client = new AuthBrokerClient({
    url: 'https://broker.example.test', token: 'broker-token', maxRetries: 0,
    fetchImpl: transport(request => {
      const path = new URL(request.url).pathname;
      brokerRequests.push(`${request.method} ${path}`);
      if (path === '/v1/usage') return new Response('Cloud quota lookup unavailable', { status: 503 });
      if (request.method === 'GET' && path === '/v1/snapshot') return Response.json(snapshot);
      const match = /^\/v1\/credential\/(\d+)\/refresh$/u.exec(path);
      if (request.method === 'POST' && match) {
        const entry = snapshot.credentials.find(candidate => candidate.id === Number(match[1]));
        if (!entry || entry.credential.type !== 'oauth') return new Response('Unknown credential', { status: 404 });
        entry.credential = { ...entry.credential, access: `${entry.credential.accountId}-renewed`, expires: Date.now() + 3_600_000 };
        snapshot.generation++;
        return Response.json({ entry: { id: entry.id, provider: entry.provider, identityKey: entry.identityKey, credential: entry.credential } });
      }
      return new Response('Unexpected broker request', { status: 404 });
    }),
  });
  // Park background sync: foreground snapshot/refresh traffic still uses the real client.
  const store = new RemoteAuthCredentialStore({ client, streamSnapshots: false, backgroundIdleMs: 0 });
  const auth = new AuthStorage(store, {
    // Keep ambient API-key environment variables out while retaining the real provider implementations.
    usageProviderResolver: provider => provider === 'openai-codex' ? openaiCodexUsageProvider : provider === 'anthropic' ? claudeUsageProvider : undefined,
    usageFetch: transport(request => {
      const token = request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? '';
      providerRequests.push({ url: request.url, token });
      const entry = snapshot.credentials.find(candidate => candidate.credential.type === 'oauth' && candidate.credential.access === token);
      if (!entry || entry.credential.type !== 'oauth') return new Response('Invalid bearer', { status: 401 });
      const used = entry.credential.accountId?.endsWith('-hot') ? 95 : 20;
      if (entry.provider === 'openai-codex' && request.url === 'https://chatgpt.com/backend-api/wham/usage') {
        return Response.json({ plan_type: 'pro', rate_limit: {
          allowed: true, limit_reached: false,
          primary_window: { used_percent: used, limit_window_seconds: 18_000, reset_at: Math.floor(now / 1000) + 3600 },
        } });
      }
      if (entry.provider === 'anthropic' && request.url === 'https://api.anthropic.com/api/oauth/usage') {
        return Response.json({ five_hour: { utilization: used, resets_at: new Date(now + 3_600_000).toISOString() } });
      }
      return new Response('Unexpected provider request', { status: 404 });
    }),
  });
  try {
    await store.refreshSnapshot();
    await auth.reload();
    return { auth, brokerRequests, providerRequests };
  } catch (error) {
    auth.close();
    throw error;
  }
}

describe('machine-side usage with broker-owned credentials', () => {
  it('reports Codex and Anthropic quota without cloud usage and reuses the local cache', async () => {
    const f = await fixture();
    try {
      const [reports, concurrentReports] = await Promise.all([
        f.auth.fetchUsageReports(),
        f.auth.fetchUsageReports(),
      ]);
      expect(concurrentReports).toEqual(reports);
      expect(reports?.map(report => ({
        provider: report.provider,
        accountId: report.metadata?.accountId,
        used: report.limits[0]?.amount?.used,
      })).sort((left, right) => String(left.accountId).localeCompare(String(right.accountId)))).toEqual([
        { provider: 'anthropic', accountId: 'anthropic-cool', used: 20 },
        { provider: 'anthropic', accountId: 'anthropic-hot', used: 95 },
        { provider: 'openai-codex', accountId: 'openai-codex-cool', used: 20 },
        { provider: 'openai-codex', accountId: 'openai-codex-hot', used: 95 },
      ]);
      // Each account's quota endpoints are hit once, even across concurrent callers; the endpoint count is upstream's.
      expect(new Set(f.providerRequests.map(request => `${request.token} ${request.url}`)).size).toBe(f.providerRequests.length);
      expect([...new Set(f.providerRequests.map(request => request.token))].sort()).toEqual([
        'anthropic-cool', 'anthropic-hot', 'openai-codex-cool', 'openai-codex-hot',
      ]);
      const requests = [...f.providerRequests];
      expect(await f.auth.fetchUsageReports()).toEqual(reports);
      expect(f.providerRequests).toEqual(requests);
      expect(f.brokerRequests).toEqual(['GET /v1/snapshot']);
    } finally {
      f.auth.close();
    }
  });

  it('selects the cooler account from local quota on a cold cache for both providers', async () => {
    const f = await fixture();
    try {
      for (const provider of providers) {
        const selected = await f.auth.getOAuthAccess(provider, `${provider}-session`);
        expect(selected?.accountId).toBe(`${provider}-cool`);
        expect(selected?.accessToken).toBe(`${provider}-cool`);
      }
      expect(new Set(f.providerRequests.map(request => `${request.token} ${request.url}`)).size).toBe(f.providerRequests.length);
      expect([...new Set(f.providerRequests.map(request => request.token))].sort()).toEqual([
        'anthropic-cool', 'anthropic-hot', 'openai-codex-cool', 'openai-codex-hot',
      ]);
      const requests = [...f.providerRequests];
      for (const provider of providers) {
        expect((await f.auth.getOAuthAccess(provider, `${provider}-next-session`))?.accountId).toBe(`${provider}-cool`);
      }
      expect(f.providerRequests).toEqual(requests);
      expect(f.brokerRequests).toEqual(['GET /v1/snapshot']);
    } finally {
      f.auth.close();
    }
  });

  it('keeps OAuth refresh broker-coordinated when quota is fetched locally', async () => {
    const f = await fixture(-1);
    try {
      for (const provider of providers) {
        const selected = await f.auth.getOAuthAccess(provider, `${provider}-session`);
        expect(selected?.accountId).toBe(`${provider}-cool`);
        expect(selected?.accessToken).toBe(`${provider}-cool-renewed`);
      }
      expect(f.brokerRequests.filter(request => request.startsWith('POST ')).sort()).toEqual([
        'POST /v1/credential/1/refresh', 'POST /v1/credential/2/refresh',
        'POST /v1/credential/3/refresh', 'POST /v1/credential/4/refresh',
      ]);
      expect(f.brokerRequests).not.toContain('GET /v1/usage');
    } finally {
      f.auth.close();
    }
  });
});
