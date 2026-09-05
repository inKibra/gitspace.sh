import { describe, expect, it } from 'vitest';
import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { network } from './network.js';
import { machineBrokerToken } from '../src/account-access.js';
import type { CredentialRefreshResponse, CredentialUploadResponse, SnapshotResponse } from '@oh-my-pi/pi-ai/auth-broker';

async function seedVault(credentials: Array<{ id: string; provider: 'anthropic' | 'openai-codex'; access: string; accountId?: string; email?: string }>): Promise<string> {
  const userId = `omp-${crypto.randomUUID()}`;
  const vault = env.CREDENTIALS.get(env.CREDENTIALS.idFromName(userId));
  await env.ACCOUNTS.getByName('global').upsertProvisioning({ userId, handle: `broker-${crypto.randomUUID().slice(0, 8)}` });
  await env.ACCOUNTS.getByName('global').markActive({ userId, release: null });
  expect((await vault.bootstrap({
    userId,
    rootPublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(1)),
    vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(2)),
  })).status).toBe('ok');
  await vault.registerManagedDevice({ userId, machineId: 'broker-machine', signingPublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(3)), exchangePublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(4)), capabilities: ['credential.access'] });
  for (const { id, ...credential } of credentials) {
    expect((await vault.putCredential({
      id,
      credential: { ...credential, refresh: `${id}-refresh`, expires: Date.now() + 60 * 60_000 },
    })).status).toBe('ok');
  }
  return userId;
}

async function fetchUsage(userId: string): Promise<Response> {
  return SELF.fetch(`https://auth.test/omp/users/${userId}/v1/usage`, { headers: { authorization: `Bearer ${await machineBrokerToken('test-omp-broker-token', userId, 'broker-machine', 1)}` } });
}

async function writer(userId: string) {
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.registerManagedDevice({
    userId, machineId: 'writer',
    signingPublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(5)),
    exchangePublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(6)),
    capabilities: ['credential.access', 'credential.manage'],
  });
  const token = await machineBrokerToken('test-omp-broker-token', userId, 'writer', 1);
  return (operation: string, body?: unknown, headers: Record<string, string> = {}) => SELF.fetch(`https://auth.test/omp/users/${userId}/v1/${operation}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}


describe('OMP native auth broker adapter', () => {
  it('feeds broker-only credentials into OMP AuthStorage', async () => {
    const userId = `omp-${crypto.randomUUID()}`;
    const vault = env.CREDENTIALS.get(env.CREDENTIALS.idFromName(userId));
    await env.ACCOUNTS.getByName('global').upsertProvisioning({ userId, handle: `broker-${crypto.randomUUID().slice(0, 8)}` });
    await env.ACCOUNTS.getByName('global').markActive({ userId, release: null });
    expect((await vault.bootstrap({
      userId,
      rootPublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(1)),
      vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(2)),
    })).status).toBe('ok');
    await vault.registerManagedDevice({ userId, machineId: 'broker-machine', signingPublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(3)), exchangePublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(4)), capabilities: ['credential.access'] });
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
      headers: { authorization: `Bearer ${await machineBrokerToken('test-omp-broker-token', userId, 'broker-machine', 1)}` },
    });
    expect(response.status).toBe(200);
    const snapshot = await response.json() as {
      credentials: Array<{ provider: string; identityKey: string | null; credential: { type: string; access: string; refresh: string } }>;
    };
    expect(snapshot.credentials).toHaveLength(1);
    expect(snapshot.credentials[0]).toMatchObject({
      provider: 'openai-codex',
      identityKey: 'account:account-a',
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

  it('requires explicit credential management authority without elevating read-only bearers', async () => {
    const userId = await seedVault([{ id: 'existing', provider: 'openai-codex', access: 'existing-access' }]);
    const vault = env.CREDENTIALS.getByName(userId);
    const request = await writer(userId);
    const readToken = await machineBrokerToken('test-omp-broker-token', userId, 'broker-machine', 1);
    const upload = { provider: 'anthropic', credential: { type: 'api_key', key: 'api-secret' } };
    expect((await request('credential', upload, { authorization: `Bearer ${readToken}` })).status).toBe(403);
    expect((await request('credential/1/disable', { cause: 'deleted' }, { authorization: `Bearer ${readToken}` })).status).toBe(403);
    expect((await request('snapshot', undefined, { authorization: `Bearer ${readToken}` })).status).toBe(200);
    expect((await request('credential', upload)).status).toBe(200);
    await env.ACCOUNTS.getByName('global').setStatus({ userId, status: 'suspended', reason: 'hold', actor: 'operator', action: 'suspend' });
    expect((await request('credential', upload)).status).toBe(403);
    expect((await request('credential/1/disable', { cause: 'deleted' })).status).toBe(403);
    await env.ACCOUNTS.getByName('global').setStatus({ userId, status: 'active', reason: 'release', actor: 'operator', action: 'activate' });
    await vault.registerManagedDevice({
      userId, machineId: 'writer',
      signingPublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)),
      exchangePublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(8)),
      capabilities: ['credential.access', 'credential.manage'],
    });
    expect((await request('credential', upload)).status).toBe(401);
    expect((await request('credential/1/disable', { cause: 'deleted' })).status).toBe(401);
  });

  it('stores API keys canonically without OAuth refresh or usage and invalidates snapshots after the last removal', async () => {
    const userId = await seedVault([]);
    const request = await writer(userId);
    const before = await request('snapshot');
    const initial = await before.json() as SnapshotResponse;
    const upload = { provider: 'anthropic', credential: { type: 'api_key', key: 'canonical-api-secret' } };
    const response = await request('credential', upload);
    expect(response.status).toBe(200);
    const uploaded = await response.json() as CredentialUploadResponse;
    const id = uploaded.entries[0]!.id;
    expect(uploaded.entries).toEqual([{ id, provider: 'anthropic', identityKey: null, credential: upload.credential }]);
    const snapshot = await request('snapshot', undefined, { 'if-none-match': before.headers.get('etag')! });
    expect(snapshot.status).toBe(200);
    const stored = await snapshot.json() as SnapshotResponse;
    expect(stored.generation).toBeGreaterThan(initial.generation);
    expect(stored.credentials).toEqual([{ ...uploaded.entries[0], rotatesInMs: null }]);
    const vault = env.CREDENTIALS.getByName(userId);
    const encrypted = await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec<{ sealed_json: string }>('SELECT sealed_json FROM oauth_credentials').toArray());
    expect(JSON.stringify(encrypted)).not.toContain(upload.credential.key);
    let providerRequests = 0;
    network.use(http.all('https://api.anthropic.com/*', () => { providerRequests += 1; return new HttpResponse(null, { status: 500 }); }));
    expect(await (await request(`credential/${id}/refresh`, {})).json()).toEqual({ entry: uploaded.entries[0] });
    expect(await (await request('usage')).json()).toMatchObject({ reports: [] });
    expect(providerRequests).toBe(0);
    expect((await request(`credential/${id}/disable`, { cause: 'deleted by user' })).status).toBe(200);
    const removed = await request('snapshot', undefined, { 'if-none-match': snapshot.headers.get('etag')! });
    expect(removed.status).toBe(200);
    const empty = await removed.json() as SnapshotResponse;
    expect(empty.credentials).toEqual([]);
    expect(empty.generation).toBeGreaterThan(stored.generation);
    const replacement = await (await request('credential', upload)).json() as CredentialUploadResponse;
    expect(replacement.entries[0]!.id).not.toBe(id);
    expect((await request(`credential/${id}/disable`, { cause: 'delayed logout' })).status).toBe(404);
    expect((await (await request('snapshot')).json() as SnapshotResponse).credentials[0]!.id).toBe(replacement.entries[0]!.id);
  });

  it('upserts OAuth identities separately by organization and retains rotating refresh tokens only in the vault', async () => {
    const userId = await seedVault([]);
    const request = await writer(userId);
    const credential = { type: 'oauth', access: 'access-original', refresh: 'refresh-original', expires: Date.now() + 3_600_000, email: 'person@example.com', orgId: 'org-a', orgName: 'Organization A' };
    const first = await (await request('credential', { provider: 'openai-codex', credential })).json() as CredentialUploadResponse;
    const id = first.entries[0]!.id;
    const second = await (await request('credential', { provider: 'openai-codex', credential: { ...credential, orgId: 'org-b' } })).json() as CredentialUploadResponse;
    expect(second.entries.map((entry) => entry.identityKey)).toEqual(['email:person@example.com|org:org-a', 'email:person@example.com|org:org-b']);
    const updated = await (await request('credential', { provider: 'openai-codex', credential: { ...credential, access: 'access-updated' } })).json() as CredentialUploadResponse;
    expect(updated.entries.map((entry) => entry.id)).toEqual(second.entries.map((entry) => entry.id));
    expect(updated.entries.find((entry) => entry.id === id)?.credential).toMatchObject({ access: 'access-updated', refresh: '__remote__', orgName: 'Organization A' });
    const invalid = await request('credential', { provider: 'openai-codex', credential: { ...credential, refresh: '__remote__' } });
    expect(invalid.status).toBe(400);
    const seenRefresh: string[] = [];
    network.use(http.post('https://auth.openai.com/oauth/token', async ({ request: upstream }) => {
      const body = new URLSearchParams(await upstream.text());
      seenRefresh.push(body.get('refresh_token')!);
      return HttpResponse.json({ access_token: 'access-rotated', refresh_token: 'refresh-rotated', expires_in: 3600 });
    }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refreshed = await request(`credential/${id}/refresh`, {});
      expect(refreshed.status).toBe(200);
      const result = await refreshed.json() as CredentialRefreshResponse;
      expect(result.entry.credential).toMatchObject({ access: 'access-rotated', refresh: '__remote__', orgName: 'Organization A' });
      expect(JSON.stringify(result)).not.toContain('refresh-original');
      expect(JSON.stringify(result)).not.toContain('refresh-rotated');
    }
    expect(seenRefresh).toEqual(['refresh-original', 'refresh-rotated']);
    const snapshot = await (await request('snapshot')).text();
    expect(snapshot).not.toContain('refresh-original');
    expect(snapshot).not.toContain('refresh-rotated');
  });

  it('does not resurrect a credential disabled while its rotating refresh is in flight', async () => {
    const userId = await seedVault([{ id: 'racing', provider: 'openai-codex', access: 'access-before' }]);
    const request = await writer(userId);
    const snapshot = await (await request('snapshot')).json() as SnapshotResponse;
    const id = snapshot.credentials[0]!.id;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    network.use(http.post('https://auth.openai.com/oauth/token', async () => {
      entered.resolve();
      await release.promise;
      return HttpResponse.json({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600 });
    }));
    const refreshing = request(`credential/${id}/refresh`, {});
    await entered.promise;
    try {
      expect((await request(`credential/${id}/disable`, { cause: 'deleted by user' })).status).toBe(200);
    } finally {
      release.resolve();
    }
    expect((await refreshing).ok).toBe(false);
    expect((await (await request('snapshot')).json() as SnapshotResponse).credentials).toEqual([]);
  });
});
