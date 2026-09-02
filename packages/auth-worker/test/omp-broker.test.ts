import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { network } from './network.js';

async function seedVault(credentials: Array<{ id: string; provider: 'anthropic' | 'openai-codex'; access: string; accountId?: string; email?: string }>): Promise<string> {
  const userId = `omp-${crypto.randomUUID()}`;
  const vault = env.CREDENTIALS.get(env.CREDENTIALS.idFromName(userId));
  expect((await vault.bootstrap({
    userId,
    rootPublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(1)),
    vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(2)),
  })).status).toBe('ok');
  for (const { id, ...credential } of credentials) {
    expect((await vault.putCredential({
      id,
      credential: { ...credential, refresh: `${id}-refresh`, expires: Date.now() + 60 * 60_000 },
    })).status).toBe('ok');
  }
  return userId;
}

function fetchUsage(userId: string): Promise<Response> {
  return SELF.fetch(`https://auth.test/omp/users/${userId}/v1/usage`, { headers: { authorization: 'Bearer test-omp-broker-token' } });
}


describe('OMP native auth broker adapter', () => {
  it('feeds broker-only credentials into OMP AuthStorage', async () => {
    const userId = `omp-${crypto.randomUUID()}`;
    const vault = env.CREDENTIALS.get(env.CREDENTIALS.idFromName(userId));
    expect((await vault.bootstrap({
      userId,
      rootPublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(1)),
      vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(2)),
    })).status).toBe('ok');
    expect((await vault.putCredential({
      id: 'openai-primary',
      credential: {
        provider: 'openai-codex',
        access: 'broker-only-access-token',
        refresh: 'broker-only-refresh-token',
        expires: Date.now() + 60 * 60_000,
        accountId: 'account-a',
      },
    })).status).toBe('ok');
    const health = await SELF.fetch(`https://auth.test/omp/users/${userId}/v1/healthz`);
    expect(await health.json()).toMatchObject({ ok: true });
    const response = await SELF.fetch(`https://auth.test/omp/users/${userId}/v1/snapshot`, {
      headers: { authorization: 'Bearer test-omp-broker-token' },
    });
    expect(response.status).toBe(200);
    const snapshot = await response.json() as {
      credentials: Array<{ provider: string; identityKey: string | null; credential: { type: string; access: string; refresh: string } }>;
    };
    expect(snapshot.credentials).toHaveLength(1);
    expect(snapshot.credentials[0]).toMatchObject({
      provider: 'openai-codex',
      identityKey: 'account-a',
      credential: {
        type: 'oauth',
        access: 'broker-only-access-token',
        refresh: '__remote__',
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('broker-only-refresh-token');
  });

  it('serves provider usage reports for vault credentials', async () => {
    const userId = await seedVault([
      { id: 'anthropic-primary', provider: 'anthropic', access: 'anthropic-access-token', email: 'claude@example.com' },
      { id: 'openai-primary', provider: 'openai-codex', access: 'codex-access-token', accountId: 'account-a', email: 'codex@example.com' },
    ]);
    const seen: string[] = [];
    network.use(
      http.get('https://api.anthropic.com/api/oauth/usage', ({ request }) => {
        seen.push(request.headers.get('authorization') ?? '');
        return HttpResponse.json({
          five_hour: { utilization: 42, resets_at: '2026-09-01T12:00:00Z' },
          seven_day: { utilization: 91, resets_at: '2026-09-05T00:00:00Z' },
          account: { uuid: 'acct-claude' },
        });
      }),
      http.get('https://chatgpt.com/backend-api/wham/usage', ({ request }) => {
        seen.push(request.headers.get('chatgpt-account-id') ?? '');
        return HttpResponse.json({
          plan_type: 'pro',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 3600 },
            secondary_window: { used_percent: 100, limit_window_seconds: 604_800, reset_at: 1_790_000_000 },
          },
          rate_limit_reset_credits: { available_count: 2 },
        });
      }),
    );
    const response = await fetchUsage(userId);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json() as { generatedAt: number; reports: Array<Record<string, unknown>> };
    expect(typeof body.generatedAt).toBe('number');
    expect(seen.sort()).toEqual(['Bearer anthropic-access-token', 'account-a']);
    expect(body.reports).toHaveLength(2);
    const anthropic = body.reports.find((report) => report.provider === 'anthropic');
    expect(anthropic).toMatchObject({
      metadata: { email: 'claude@example.com', accountId: 'acct-claude' },
      limits: [
        { id: 'anthropic:5h', status: 'ok', amount: { used: 42, unit: 'percent' }, window: { id: '5h', resetsAt: Date.parse('2026-09-01T12:00:00Z') } },
        { id: 'anthropic:7d', status: 'warning', amount: { used: 91 } },
      ],
    });
    const codex = body.reports.find((report) => report.provider === 'openai-codex');
    expect(codex).toMatchObject({
      metadata: { email: 'codex@example.com', accountId: 'account-a', planType: 'pro' },
      resetCredits: { availableCount: 2 },
      limits: [
        { id: 'openai-codex:primary', label: '5 hours', status: 'ok', window: { id: '5h', durationMs: 18_000_000 } },
        { id: 'openai-codex:secondary', label: '7 days', status: 'warning', window: { id: '7d', resetsAt: 1_790_000_000_000 } },
      ],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('access-token');
    expect(serialized).not.toContain('"raw"');
  });

  it('omits credentials whose usage endpoint fails and still answers 200', async () => {
    const userId = await seedVault([
      { id: 'openai-primary', provider: 'openai-codex', access: 'codex-access-token', accountId: 'account-a', email: 'codex@example.com' },
    ]);
    network.use(http.get('https://chatgpt.com/backend-api/wham/usage', () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
    const response = await fetchUsage(userId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reports: [] });
  });

  it('rejects unauthenticated usage requests', async () => {
    const userId = await seedVault([]);
    const response = await SELF.fetch(`https://auth.test/omp/users/${userId}/v1/usage`);
    expect(response.status).toBe(401);
  });
});
