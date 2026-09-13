import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { ed25519 } from '@noble/curves/ed25519.js';

function operatorRequest(tenantPath: string, init?: RequestInit, bindings = env): Promise<Response> {
  return worker.fetch(new Request(`https://platform.test/__platform/operator/tenants/${tenantPath}`, {
    ...init,
    headers: {
      authorization: 'Bearer test-bootstrap-token',
      ...init?.headers,
    },
  }), bindings, createExecutionContext());
}

describe('operator tenant controls', () => {
  it('requires the platform operator credential', async () => {
    const response = await worker.fetch(new Request('https://platform.test/__platform/operator/tenants/controlled'), env, createExecutionContext());
    expect(response.status).toBe(401);
  });

  it('suspends, quarantines, and restores dispatch independently of credits', async () => {
    const tenant = `control-${crypto.randomUUID().slice(0, 8)}`;
    const credits = env.CREDITS.getByName(tenant);
    await credits.configure({ balanceMicros: 1_000, riskReserveMicros: 100 });

    const suspended = await operatorRequest(tenant, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'suspend', reason: 'operator hold' }),
    });
    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toMatchObject({ control: { status: 'suspended', reason: 'operator hold' } });

    const blocked = await worker.fetch(new Request(`https://${tenant}-test.invalid/health`), env, createExecutionContext());
    expect(blocked.status).toBe(423);
    expect(await blocked.json()).toMatchObject({ error: { code: 'TENANT_SUSPENDED' } });

    const quarantined = await operatorRequest(tenant, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'quarantine', reason: 'abuse review' }),
    });
    expect(await quarantined.json()).toMatchObject({ control: { status: 'quarantined', reason: 'abuse review' } });

    await credits.quarantine('credit enforcement');
    const restored = await operatorRequest(tenant, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'restore' }),
    });
    expect(await restored.json()).toMatchObject({ control: { status: 'active', reason: null } });
    expect(await credits.getAccount()).toMatchObject({ status: 'ok', value: { status: 'active', balanceMicros: 1_000 } });

    const state = await operatorRequest(tenant);
    expect(await state.json()).toMatchObject({
      control: { status: 'active' },
      credits: { balanceMicros: 1_000 },
      usage: { records: 0, debitedMicros: 0 },
    });
  });
});

describe('operator tenant access', () => {
  it('requires operator credentials and rejects attempts to mutate access', async () => {
    const tenant = `access-auth-${crypto.randomUUID().slice(0, 8)}`;
    const missing = await worker.fetch(new Request(`https://platform.test/__platform/operator/tenants/${tenant}/access`), env, createExecutionContext());
    expect(missing.status).toBe(401);
    const invalid = await operatorRequest(`${tenant}/access`, { headers: { authorization: 'Bearer wrong-token' } });
    expect(invalid.status).toBe(401);
    const mutation = await operatorRequest(`${tenant}/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'suspend' }),
    });
    expect(mutation.status).toBe(405);
    expect(await env.TENANT_CONTROL.getByName(tenant).get()).toMatchObject({ status: 'active' });
  });

  it('returns only uncached tenant control even when billing and deployment authorities are unavailable', async () => {
    const tenant = `access-state-${crypto.randomUUID().slice(0, 8)}`;
    const bindings: Env = {
      ...env,
      get CREDITS(): Env['CREDITS'] { throw new Error('Billing unavailable'); },
      get DEPLOYMENTS(): Env['DEPLOYMENTS'] { throw new Error('Deployments unavailable'); },
    };
    for (const status of ['active', 'suspended', 'quarantined'] as const) {
      const control = await env.TENANT_CONTROL.getByName(tenant).set({ status, reason: status === 'active' ? null : 'operator hold' });
      const response = await operatorRequest(`${tenant}/access`, undefined, bindings);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({ control });
    }
  });

  it('fails closed when tenant control cannot be read', async () => {
    const response = await operatorRequest('unavailable/access', undefined, {
      ...env,
      TENANT_CONTROL: {
        getByName() {
          return { get() { return Promise.reject(new Error('Tenant control unavailable')); } };
        },
      } as unknown as Env['TENANT_CONTROL'],
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'TENANT_AUTHORITY_UNAVAILABLE' } });
  });
});

describe('tenant resource authorization', () => {
  it('binds temporary object credentials to the verified tenant even when the caller requests another bucket', async () => {
    const tenant = `objects-${crypto.randomUUID().slice(0, 8)}`;
    const other = `foreign-${crypto.randomUUID().slice(0, 8)}`;
    const root = btoa(String.fromCharCode(...ed25519.keygen().publicKey));
    const bucket = `gsp-relay-${tenant}`;
    await env.DEPLOYMENTS.getByName(tenant).configure(root, bucket);
    const token = await env.DEPLOYMENTS.getByName(tenant).providerToken();
    const originalFetch = globalThis.fetch;
    const issued: Array<{ bucket: string; prefixes: string[] }> = [];
    globalThis.fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { bucket: string; prefixes: string[] };
      issued.push(payload);
      return Response.json({ success: true, result: { accessKeyId: 'temporary-access', secretAccessKey: 'temporary-secret', sessionToken: 'temporary-session' } });
    };
    try {
      const request = (target: string) => worker.fetch(new Request(`https://platform.test/__platform/tenants/${target}/storage/credentials`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ bucketName: `gsp-relay-${other}`, prefixes: ['arbitrary.bytes', ''], ttlSeconds: 60 }),
      }), env, createExecutionContext());
      expect((await request(other)).status).toBe(401);
      expect(issued).toEqual([]);
      const allowed = await request(tenant);
      expect(allowed.status).toBe(200);
      expect(issued).toEqual([expect.objectContaining({ bucket, prefixes: ['', 'arbitrary.bytes'] })]);
      await env.TENANT_CONTROL.getByName(tenant).set({ status: 'suspended', reason: 'resource hold' });
      expect((await request(tenant)).status).toBe(423);
      expect(issued).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('replaces caller-supplied compute namespace headers with the root-bound account identity', async () => {
    const tenant = `compute-${crypto.randomUUID().slice(0, 8)}`;
    const publicKey = ed25519.keygen().publicKey;
    await env.DEPLOYMENTS.getByName(tenant).configure(btoa(String.fromCharCode(...publicKey)), `gsp-relay-${tenant}`);
    const token = await env.DEPLOYMENTS.getByName(tenant).providerToken();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey));
    const accountId = `u-${Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const bindings: Env = {
      ...env,
      COMPUTE: {
        async fetch(request: Request) {
          if (request.headers.get('x-gitspace-user-id') !== accountId || request.headers.has('x-gitspace-provider-token')) return new Response('Namespace escaped', { status: 403 });
          return Response.json({ allocated: true });
        },
      } as Fetcher,
    };
    const response = await worker.fetch(new Request(`https://platform.test/__platform/tenants/${tenant}/provider/compute/resources`, {
      method: 'POST', headers: { 'x-gitspace-provider-token': token, 'x-gitspace-user-id': 'foreign-account' }, body: '{}',
    }), bindings, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allocated: true });
  });
});
