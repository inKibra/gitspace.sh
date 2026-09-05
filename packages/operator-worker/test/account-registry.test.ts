import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AccountRegistryDO } from '../src/account-registry.js';

describe('AccountRegistryDO', () => {
  it('tracks provisioning, active tenancy, operator controls, and audit events', async () => {
    const registry = env.ACCOUNTS.getByName('global');
    const userId = `u-${crypto.randomUUID().replaceAll('-', '')}`;
    const createdAt = Date.now() - 1_000;

    await registry.upsertProvisioning({ userId, handle: 'registry-test', createdAt });
    expect(await registry.get(userId)).toMatchObject({ userId, handle: 'registry-test', status: 'provisioning', createdAt });

    await registry.markActive({ userId, release: 'stable' });
    expect(await registry.get(userId)).toMatchObject({ status: 'active', tenantHostname: 'registry-test.gssh.dev', tenantRelease: 'stable' });

    await registry.setStatus({ userId, status: 'quarantined', reason: 'abuse review', actor: 'operator@example.com', action: 'quarantine' });
    await registry.setStatus({ userId, status: 'active', reason: null, actor: 'operator@example.com', action: 'restore' });

    expect(await registry.list()).toEqual(expect.arrayContaining([expect.objectContaining({ userId, status: 'active' })]));
    expect(await registry.listEvents(userId)).toEqual([
      expect.objectContaining({ action: 'restore', actor: 'operator@example.com' }),
      expect.objectContaining({ action: 'quarantine', reason: 'abuse review', actor: 'operator@example.com' }),
    ]);
  });

  it('records failed provisioning for operator diagnosis', async () => {
    const registry = env.ACCOUNTS.getByName('global');
    const userId = `u-${crypto.randomUUID().replaceAll('-', '')}`;
    await registry.upsertProvisioning({ userId, handle: 'failed-test', createdAt: Date.now() });
    await registry.markFailed({ userId, message: 'tenant bootstrap failed' });
    expect(await registry.get(userId)).toMatchObject({ status: 'failed', lastError: 'tenant bootstrap failed' });
    await registry.upsertProvisioning({ userId, handle: 'failed-test' });
    expect((await registry.get(userId))?.status).toBe('provisioning');
    await registry.markActive({ userId, release: 'retried' });
    expect((await registry.get(userId))?.status).toBe('active');
  });

  it('keeps the permanent handle and rejects late provisioning completion after suspension', async () => {
    const registry = env.ACCOUNTS.getByName('global');
    const userId = `u-${crypto.randomUUID().replaceAll('-', '')}`;
    await registry.upsertProvisioning({ userId, handle: 'race-test' });
    await runInDurableObject(registry, (authority: AccountRegistryDO) => {
      expect(() => authority.upsertProvisioning({ userId, handle: 'foreign-handle' })).toThrow();
    });
    await registry.setStatus({ userId, status: 'suspended', reason: 'hold during bootstrap', actor: 'operator', action: 'suspend' });
    await runInDurableObject(registry, (authority: AccountRegistryDO) => {
      expect(() => authority.markActive({ userId, release: 'late' })).toThrow();
      expect(() => authority.upsertProvisioning({ userId, handle: 'race-test' })).toThrow();
    });
    expect(await registry.get(userId)).toMatchObject({ handle: 'race-test', status: 'suspended', tenantRelease: null });
  });
});
