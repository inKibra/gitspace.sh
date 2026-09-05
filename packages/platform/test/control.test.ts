import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';

function operatorRequest(tenant: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://platform.test/__platform/operator/tenants/${tenant}`, {
    ...init,
    headers: {
      authorization: 'Bearer test-bootstrap-token',
      ...init?.headers,
    },
  }), env);
}

describe('operator tenant controls', () => {
  it('requires the platform operator credential', async () => {
    const response = await worker.fetch(new Request('https://platform.test/__platform/operator/tenants/controlled'), env);
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

    const blocked = await worker.fetch(new Request(`https://${tenant}-test.invalid/health`), env);
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
