import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { CreditLedgerRecord } from '../src/credit-ledger.js';
import worker from '../src/index.js';

const dispatchPaths = [
  { route: 'tenant', upgrade: false },
  { route: 'tenant', upgrade: true },
  { route: 'service', upgrade: false },
  { route: 'service', upgrade: true },
  { route: 'application', upgrade: false },
  { route: 'application', upgrade: true },
] as const;

function dispatchFixture(tenant: string, route: 'tenant' | 'service' | 'application', upgrade: boolean) {
  const pair = upgrade ? new WebSocketPair() : null;
  if (pair) {
    pair[1].accept();
    pair[1].addEventListener('message', (event) => pair[1].send(`received:${event.data}`));
  }
  const upstream = pair
    ? new Response(null, { status: 101, webSocket: pair[0] })
    : new Response('tenant response', { status: 201 });
  const bindings: Env = {
    ...env,
    DISPATCHER: {
      get() { return { async fetch() { return upstream; } }; },
    } as unknown as DispatchNamespace,
  };
  const hostname = route === 'tenant' ? `${tenant}-test.invalid` : route === 'application' ? `${tenant}.gitspace.sh` : `web--space-a--${tenant}-srv-test.invalid`;
  const request = new Request(`https://${hostname}/health`, upgrade ? { headers: { upgrade: 'websocket' } } : undefined);
  return { bindings, request, pair };
}

afterEach(() => vi.restoreAllMocks());

describe('dispatch without billing authorization', () => {
  it.each(dispatchPaths)('serves $route upgrade=$upgrade while accounting is pending, then records usage despite exhausted/quarantined credits', async ({ route, upgrade }) => {
    const tenant = `dispatch-${crypto.randomUUID().slice(0, 8)}`;
    const credits = env.CREDITS.getByName(tenant);
    await credits.configure({ balanceMicros: 0, riskReserveMicros: 100 });
    await credits.quarantine('legacy billing hold');
    const fixture = dispatchFixture(tenant, route, upgrade);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    onTestFinished(release);
    fixture.bindings.CREDITS = {
      getByName() {
        return {
          async getAccount() { await pending; return credits.getAccount(); },
          applyUsage(record: CreditLedgerRecord) { return credits.applyUsage(record); },
        };
      },
    } as unknown as Env['CREDITS'];
    const ctx = createExecutionContext();
    let accepted = false;
    try {
      const response = await worker.fetch(fixture.request, fixture.bindings, ctx);
      expect(response.status).toBe(upgrade ? 101 : 201);
      if (upgrade) {
        const socket = response.webSocket!;
        socket.accept();
        accepted = true;
        const message = new Promise<unknown>((resolve) => socket.addEventListener('message', (event) => resolve(event.data), { once: true }));
        socket.send('probe');
        expect(await message).toBe('received:probe');
      } else {
        expect(await response.text()).toBe('tenant response');
      }
      expect(await credits.usageSummary()).toEqual({ records: 0, debitedMicros: 0 });
    } finally {
      release();
      await waitOnExecutionContext(ctx);
      if (fixture.pair) {
        if (!accepted) fixture.pair[0].accept();
        fixture.pair[0].close(1000);
        fixture.pair[1].close(1000);
      }
    }
    expect(await credits.usageSummary()).toEqual({ records: 1, debitedMicros: Number(env.DISPATCH_SETTLEMENT_MICROS) });
    expect(await credits.listLedger()).toEqual([expect.objectContaining({ resource: 'worker-request', quantity: '1' })]);
    expect(await credits.getAccount()).toMatchObject({ status: 'ok', value: { balanceMicros: -Number(env.DISPATCH_SETTLEMENT_MICROS), reservedMicros: 0, status: 'quarantined' } });
    expect(await env.TENANT_CONTROL.getByName(tenant).get()).toMatchObject({ status: 'active' });
  });

  it.each(['lookup', 'read', 'write', 'result'] as const)('preserves the dispatched response when accounting fails at %s', async (failure) => {
    const tenant = `outage-${crypto.randomUUID().slice(0, 8)}`;
    const credits = env.CREDITS.getByName(tenant);
    await credits.configure({ balanceMicros: 1_000, riskReserveMicros: 0 });
    const fixture = dispatchFixture(tenant, 'tenant', false);
    fixture.bindings.CREDITS = {
      getByName() {
        if (failure === 'lookup') throw new Error('Credit namespace unavailable');
        return {
          async getAccount() {
            if (failure === 'read') throw new Error('Credit authority unavailable');
            return credits.getAccount();
          },
          async applyUsage() {
            if (failure === 'result') return { status: 'error', error: { code: 'INVALID_CREDIT_INPUT', message: 'Accounting unavailable' } };
            throw new Error('Credit write unavailable');
          },
        };
      },
    } as unknown as Env['CREDITS'];
    const ctx = createExecutionContext();
    const response = await worker.fetch(fixture.request, fixture.bindings, ctx);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('tenant response');
    await waitOnExecutionContext(ctx);
    expect(await credits.usageSummary()).toEqual({ records: 0, debitedMicros: 0 });
  });

  it('skips accounting for unconfigured credit accounts without blocking dispatch', async () => {
    const tenant = `unconfigured-${crypto.randomUUID().slice(0, 8)}`;
    const fixture = dispatchFixture(tenant, 'tenant', false);
    const ctx = createExecutionContext();
    const response = await worker.fetch(fixture.request, fixture.bindings, ctx);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('tenant response');
    await waitOnExecutionContext(ctx);
    expect(await env.CREDITS.getByName(tenant).listLedger()).toEqual([]);
  });

  it.each(dispatchPaths)('enforces tenant control on $route upgrade=$upgrade even during billing outages', async ({ route, upgrade }) => {
    const tenant = `blocked-${crypto.randomUUID().slice(0, 8)}`;
    const fixture = dispatchFixture(tenant, route, upgrade);
    fixture.bindings.CREDITS = { getByName() { throw new Error('Credit authority unavailable'); } } as unknown as Env['CREDITS'];
    try {
      for (const status of ['suspended', 'quarantined'] as const) {
        await env.TENANT_CONTROL.getByName(tenant).set({ status, reason: 'operator hold' });
        const response = await worker.fetch(fixture.request.clone(), fixture.bindings, createExecutionContext());
        expect(response.status).toBe(423);
        expect(await response.json()).toMatchObject({ error: { code: `TENANT_${status.toUpperCase()}` } });
      }
      fixture.bindings.TENANT_CONTROL = {
        getByName() { return { async get() { throw new Error('Tenant control unavailable'); } }; },
      } as unknown as Env['TENANT_CONTROL'];
      const unavailable = await worker.fetch(fixture.request.clone(), fixture.bindings, createExecutionContext());
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ error: { code: 'TENANT_AUTHORITY_UNAVAILABLE' } });
    } finally {
      if (fixture.pair) {
        fixture.pair[0].accept();
        fixture.pair[0].close(1000);
        fixture.pair[1].close(1000);
      }
    }
  });

  it.each([
    { message: 'Worker not found: missing', status: 404, code: 'RELAY_NOT_DEPLOYED', upgrade: false },
    { message: 'Worker threw during upgrade', status: 502, code: 'RELAY_DISPATCH_FAILED', upgrade: true },
  ])('preserves dispatch failure $code and meters the attempted request', async ({ message, status, code, upgrade }) => {
    const tenant = `failure-${crypto.randomUUID().slice(0, 8)}`;
    const credits = env.CREDITS.getByName(tenant);
    await credits.configure({ balanceMicros: 1_000, riskReserveMicros: 0 });
    const bindings: Env = {
      ...env,
      DISPATCHER: { get() { return { async fetch() { throw new Error(message); } }; } } as unknown as DispatchNamespace,
    };
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`https://${tenant}-test.invalid/health`, upgrade ? { headers: { upgrade: 'websocket' } } : undefined), bindings, ctx);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    await waitOnExecutionContext(ctx);
    expect(await credits.usageSummary()).toEqual({ records: 1, debitedMicros: Number(env.DISPATCH_SETTLEMENT_MICROS) });
  });
});
