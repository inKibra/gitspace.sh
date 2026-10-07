import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { HostedServiceRoute } from '@gitspace/protocol';
import type { HostedRouteRegistryDO } from '../src/hosted-route-registry.js';

function route(generation = 2): HostedServiceRoute {
  return { hostname: 'app--workspace--test-srv.gssh.dev', workspaceId: 'workspace', serviceName: 'app', machineId: 'machine-a', ingress: 'http://127.0.0.1:17000', portName: 'http', port: 17000, generation, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'healthy', updatedAt: new Date().toISOString() };
}
it.each(['foreign machine', 'foreign tenant', 'stale generation'])('global hosted registry rejects %s', async kind => {
  const registry = env.HOSTED_ROUTES.getByName(`registry-${kind}`);
  const current = route();
  await registry.lease('tenant-a', current);
  await runInDurableObject(registry, (owner: HostedRouteRegistryDO) => {
    expect(() => owner.lease(kind === 'foreign tenant' ? 'tenant-b' : 'tenant-a', { ...current, machineId: kind === 'foreign machine' ? 'machine-b' : 'machine-a', generation: kind === 'stale generation' ? 1 : 3 })).toThrow();
  });
  expect(await registry.get()).toEqual({ tenant: 'tenant-a', ...current });
});
it('global hosted registry fences stale generation release', async () => {
  const registry = env.HOSTED_ROUTES.getByName('registry-release');
  const current = route();
  await registry.lease('tenant-a', current);
  expect(await registry.release('tenant-a', 'machine-a', 1)).toBe(false);
  expect(await registry.get()).toEqual({ tenant: 'tenant-a', ...current });
});

it('expired global owner yields to another machine without accepting its stale release', async () => {
  const registry = env.HOSTED_ROUTES.getByName('registry-expired');
  const current = route();
  await registry.lease('tenant-a', current);
  await runInDurableObject(registry, (_owner, state) => {
    state.storage.sql.exec('UPDATE active_route SET lease_expires_at=?', new Date(0).toISOString());
  });
  const next = { ...current, machineId: 'machine-b', generation: 1 };
  await registry.lease('tenant-a', next);
  expect(await registry.release('tenant-a', 'machine-a', 2)).toBe(false);
  expect(await registry.get()).toEqual({ tenant: 'tenant-a', ...next });
});

it('released generation remains fenced against delayed same-owner renewals', async () => {
  const registry = env.HOSTED_ROUTES.getByName('registry-released-fence');
  const current = route(2);
  await registry.lease('tenant-a', current);
  expect(await registry.release('tenant-a', 'machine-a', 2)).toBe(true);
  await runInDurableObject(registry, (owner: HostedRouteRegistryDO) => {
    expect(() => owner.lease('tenant-a', route(1))).toThrow();
  });
  expect(await registry.get()).toBeNull();
});
