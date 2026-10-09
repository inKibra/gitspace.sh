import { env, runInDurableObject } from 'cloudflare:test';
import { http } from 'msw';
import { afterEach, expect, it, vi } from 'vitest';
import { controlFleetMachine } from '../src/application.js';
import { MACHINE_OPERATION_LEASE_MS, type FleetCatalogDO } from '../src/fleet-catalog.js';
import { SANDBOX_PROVIDER_DEADLINE_MS, controlCloudflareSandboxMachine } from '../src/sandbox-provisioner.js';
import { network } from './network.js';

const sandbox = { id: 'sandbox-a', label: 'Sandbox A', state: 'online' as const, rpcEndpoint: 'https://sandbox.example/rpc', kind: 'sandbox' as const, provider: 'cloudflare-sandbox' as const, notes: '', desiredState: 'online' as const, lifecycleRevision: 1, operationId: null, error: null };
function mockProvider(fetch: (action: string) => Promise<Response>) {
  network.use(http.all(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/*`, ({ request }) => fetch(new URL(request.url).pathname.split('/').at(-1) ?? '')));
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('fails a provider call that never answers at its deadline instead of hanging', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const reached = Promise.withResolvers<void>();
  const status = controlCloudflareSandboxMachine({ env, userId: env.ACCOUNT_ID, machineId: sandbox.id, action: 'status', service: { fetch: () => { reached.resolve(); return new Promise<Response>(() => {}); } } });
  const outcome = status.catch((error: unknown) => error);
  await reached.promise;
  await vi.advanceTimersByTimeAsync(SANDBOX_PROVIDER_DEADLINE_MS.status - 1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await outcome).toMatchObject({ name: 'SandboxProviderTimeout', message: 'Cloudflare Sandbox status timed out after 30 s' });
});

it('records a hung checkpoint on the machine and ends the stop request, clearing its operation', async () => {
  const catalog = env.FLEET_CATALOG.getByName(env.ACCOUNT_ID);
  await catalog.putMachine(sandbox);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const preparing = Promise.withResolvers<void>();
  const actions: string[] = [];
  mockProvider(async action => {
    actions.push(action);
    if (action === 'prepare-replacement') { preparing.resolve(); return new Promise<Response>(() => {}); }
    if (action === 'cancel-replacement') return Response.json({ prepared: false });
    return Response.json({ status: 'ok', value: sandbox });
  });
  const stop = controlFleetMachine(env, env.ACCOUNT_ID, sandbox.id, 'sleep').catch((error: unknown) => error);
  await preparing.promise;
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'sleeping', operationId: expect.any(String) });
  await vi.advanceTimersByTimeAsync(SANDBOX_PROVIDER_DEADLINE_MS['prepare-replacement']);
  expect(await stop).toMatchObject({ message: 'Cloudflare Sandbox prepare-replacement timed out after 600 s' });
  expect(actions).toEqual(['status', 'prepare-replacement', 'cancel-replacement', 'status']);
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'online', desiredState: 'online', operationId: null, error: 'Cloudflare Sandbox prepare-replacement timed out after 600 s' });
});

it.each([
  { provider: 'answers', response: () => Response.json({ status: 'ok', value: { ...sandbox, state: 'offline', rpcEndpoint: null } }), state: 'offline', detail: 'the provider reports it offline' },
  { provider: 'is unreachable', response: () => Response.json({ status: 'error', error: 'Container is starting' }, { status: 503 }), state: 'error', detail: 'the provider could not be reached' },
])('settles a power transition whose request died once its lease lapses, when the provider $provider', async ({ response, state, detail }) => {
  const catalog = env.FLEET_CATALOG.getByName(env.ACCOUNT_ID);
  await catalog.putMachine(sandbox);
  // The request wrote its transition and then died (isolate evicted, client gone): nothing will ever finish it.
  const started = Date.now();
  await catalog.putMachine({ ...sandbox, state: 'sleeping', lifecycleRevision: 2, operationId: 'dead-request' });
  const deadline = await runInDurableObject(catalog, (_instance: FleetCatalogDO, state) => state.storage.sql.exec<{ timestamp: number }>("SELECT timestamp FROM fleet_alarms WHERE owner='operations'").one().timestamp);
  expect(deadline - started).toBeGreaterThanOrEqual(MACHINE_OPERATION_LEASE_MS);
  mockProvider(async action => { expect(action).toBe('status'); return response(); });
  vi.spyOn(Date, 'now').mockReturnValue(deadline - 1);
  await runInDurableObject(catalog, (instance: FleetCatalogDO) => instance.alarm());
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'sleeping', operationId: 'dead-request' });
  vi.spyOn(Date, 'now').mockReturnValue(deadline);
  await runInDurableObject(catalog, (instance: FleetCatalogDO) => instance.alarm());
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state, operationId: null, error: `Machine stop operation timed out after 20 minutes; ${detail}. Retry the action.` });
  expect(await runInDurableObject(catalog, (_instance: FleetCatalogDO, storage) => storage.storage.sql.exec("SELECT owner FROM fleet_alarms WHERE owner='operations'").toArray())).toEqual([]);
});

it('keeps the lease of a transition that is still the current operation and drops it once the operation finishes', async () => {
  const catalog = env.FLEET_CATALOG.getByName(env.ACCOUNT_ID);
  await catalog.putMachine({ ...sandbox, state: 'resuming', operationId: 'live-request' });
  const lease = () => runInDurableObject(catalog, (_instance: FleetCatalogDO, state) => state.storage.sql.exec<{ operation_id: string; deadline_at: number }>('SELECT operation_id,deadline_at FROM machine_operations').toArray());
  const [first] = await lease();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  await catalog.putMachine({ ...sandbox, state: 'resuming', lifecycleRevision: 2, operationId: 'live-request' });
  expect(await lease()).toEqual([first]);
  await catalog.putMachine({ ...sandbox, lifecycleRevision: 3 });
  expect(await lease()).toEqual([]);
});
