import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { HostedServiceRoute } from '@gitspace/protocol';
import type { HostedRouteRegistryDO } from '../src/hosted-route-registry.js';

const MACHINE_URL = 'app--alpha-aaaa--workspace--test-srv.gssh.dev';
const WORKSPACE_URL = 'app--workspace--test-srv.gssh.dev';

function route(generation = 2, hostname = MACHINE_URL): HostedServiceRoute {
  return { hostname, workspaceId: 'workspace', serviceName: 'app', source: 'declared', machineId: 'machine-a', ingress: 'http://127.0.0.1:17000', portName: 'http', port: 17000, generation, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'healthy', updatedAt: new Date().toISOString() };
}
it.each(['foreign machine', 'foreign tenant', 'stale generation'])('global hosted registry rejects %s', async kind => {
  const registry = env.HOSTED_ROUTES.getByName(`registry-${kind}`);
  const current = route();
  await registry.lease('tenant-a', 'project', current, 'alpha');
  await runInDurableObject(registry, (owner: HostedRouteRegistryDO) => {
    expect(() => owner.lease(kind === 'foreign tenant' ? 'tenant-b' : 'tenant-a', 'project', { ...current, machineId: kind === 'foreign machine' ? 'machine-b' : 'machine-a', generation: kind === 'stale generation' ? 1 : 3 }, 'alpha')).toThrow();
  });
  expect(await registry.get()).toEqual({ tenant: 'tenant-a', ...current });
});
it('global hosted registry fences stale generation release', async () => {
  const registry = env.HOSTED_ROUTES.getByName('registry-release');
  const current = route();
  await registry.lease('tenant-a', 'project', current, 'alpha');
  expect(await registry.release('tenant-a', 'machine-a', 1)).toBe(false);
  expect(await registry.get()).toEqual({ tenant: 'tenant-a', ...current });
});

it('expired global owner yields to another machine without accepting its stale release', async () => {
  const registry = env.HOSTED_ROUTES.getByName('registry-expired');
  const current = route();
  await registry.lease('tenant-a', 'project', current, 'alpha');
  await runInDurableObject(registry, (_owner, state) => {
    state.storage.sql.exec('UPDATE active_route SET lease_expires_at=?', new Date(0).toISOString());
  });
  const next = { ...current, machineId: 'machine-b', generation: 1 };
  await registry.lease('tenant-a', 'project', next, 'beta');
  expect(await registry.release('tenant-a', 'machine-a', 2)).toBe(false);
  expect(await registry.get()).toEqual({ tenant: 'tenant-a', ...next });
});

it('released generation remains fenced against delayed same-owner renewals', async () => {
  const registry = env.HOSTED_ROUTES.getByName('registry-released-fence');
  const current = route(2);
  await registry.lease('tenant-a', 'project', current, 'alpha');
  expect(await registry.release('tenant-a', 'machine-a', 2)).toBe(true);
  await runInDurableObject(registry, (owner: HostedRouteRegistryDO) => {
    expect(() => owner.lease('tenant-a', 'project', route(1), 'alpha')).toThrow();
  });
  expect(await registry.get()).toBeNull();
});

it('a workspace URL stays with the first machine to start its declared service, refuses another machine, and moves only by a pin', async () => {
  const registry = env.HOSTED_ROUTES.getByName('registry-pointer');
  const alpha = route(1, WORKSPACE_URL);
  const beta = { ...alpha, machineId: 'machine-b', ingress: 'http://127.0.0.1:17001', port: 17001 };
  expect(await registry.lease('tenant-a', 'project', alpha, 'alpha')).toMatchObject({ route: alpha, pointer: { machineId: 'machine-a', machineLabel: 'alpha', serviceName: 'app', source: 'declared', portName: 'http', setBy: 'start' } });
  // Even with alpha's lease lapsed, the pointer (not lease age) decides.
  await runInDurableObject(registry, (_owner, state) => {
    state.storage.sql.exec('UPDATE active_route SET lease_expires_at=?', new Date(0).toISOString());
  });
  expect(await registry.lease('tenant-a', 'project', beta, 'beta')).toMatchObject({ route: null, pointer: { machineId: 'machine-a' } });
  expect(await registry.get()).toBeNull();
  expect(await registry.offline()).toEqual({ tenant: 'tenant-a', machine: 'alpha' });
  await registry.lease('tenant-a', 'project', alpha, 'alpha');
  expect(await registry.get()).toEqual({ tenant: 'tenant-a', ...alpha });
  expect(await registry.pin('tenant-a', 'project', beta, { hostname: WORKSPACE_URL, workspaceId: 'workspace', machineId: 'machine-b', machineLabel: 'beta', serviceName: 'app', source: 'declared', portName: 'http', setAt: new Date().toISOString(), setBy: 'pin' })).toMatchObject({ route: beta, pointer: { machineId: 'machine-b', setBy: 'pin' } });
  expect(await registry.get()).toEqual({ tenant: 'tenant-a', ...beta });
  expect(await registry.lease('tenant-a', 'project', alpha, 'alpha')).toMatchObject({ route: null, pointer: { machineId: 'machine-b' } });
  expect(await registry.get()).toEqual({ tenant: 'tenant-a', ...beta });
});

it('an ad hoc process cannot claim a workspace URL, and a cleared workspace URL points nowhere', async () => {
  const registry = env.HOSTED_ROUTES.getByName('registry-process');
  const process: HostedServiceRoute = { ...route(1, WORKSPACE_URL), source: 'process' };
  expect(await registry.lease('tenant-a', 'project', process, 'alpha')).toEqual({ route: null, pointer: null });
  expect(await registry.get()).toBeNull();
  expect(await registry.offline()).toBeNull();
  await registry.lease('tenant-a', 'project', route(1, WORKSPACE_URL), 'alpha');
  await registry.clear('tenant-a', 'workspace');
  expect(await registry.get()).toBeNull();
  expect(await registry.offline()).toBeNull();
});
