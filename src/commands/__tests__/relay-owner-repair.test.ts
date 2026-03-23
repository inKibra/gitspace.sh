import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindPersistedOwnerIdentity, ensureControlStore, getPersistedOwnerIdentityId, getVaultMeta, listVaultMachines, setVaultMeta, upsertVaultMachine } from '../../relay/control/store.js';
import { readLocalStoreJson, unlockLocalSecureStore, writeLocalStoreJson } from '../../core/local-secure-store.js';
import { assertRelayOwnerRepairIsSafe, bindRelayOwnerForStartup, takeOverRelayOwnerForStartup } from '../relay.js';

let envLock: Promise<void> = Promise.resolve();

async function withIsolatedEnv(
  run: () => Promise<void>,
  options: { initializeVault?: boolean } = {},
): Promise<void> {
  const previous = envLock;
  let release!: () => void;
  envLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  const originalHome = process.env.HOME;
  const originalControlDir = process.env.GITSPACE_CONTROL_DIR;
  const testDir = mkdtempSync(join(tmpdir(), 'gssh-relay-owner-repair-'));

  try {
    process.env.HOME = testDir;
    process.env.GITSPACE_CONTROL_DIR = join(testDir, '.relay', 'control');
    ensureControlStore();
    if (options.initializeVault !== false) {
      setVaultMeta('vault_initialized', '1');
    }
    await run();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalControlDir === undefined) {
      delete process.env.GITSPACE_CONTROL_DIR;
    } else {
      process.env.GITSPACE_CONTROL_DIR = originalControlDir;
    }

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    release();
  }
}

describe('assertRelayOwnerRepairIsSafe', () => {
  test('allows repair when there are no persisted machine registrations', async () => {
    await withIsolatedEnv(async () => {
      expect(() => assertRelayOwnerRepairIsSafe('owner-a')).not.toThrow();
    });
  });

  test('allows repair when all persisted machine registrations belong to the same owner', async () => {
    await withIsolatedEnv(async () => {
      upsertVaultMachine({
        machineId: 'machine-a',
        ownerUserRootId: 'owner-a',
        signingKey: 'signing-a',
        keyExchangeKey: 'kex-a',
      });

      expect(() => assertRelayOwnerRepairIsSafe('owner-a')).not.toThrow();
    });
  });

  test('rejects repair when persisted machine registrations belong to a different owner', async () => {
    await withIsolatedEnv(async () => {
      upsertVaultMachine({
        machineId: 'machine-a',
        ownerUserRootId: 'owner-b',
        signingKey: 'signing-a',
        keyExchangeKey: 'kex-a',
      });

      expect(() => assertRelayOwnerRepairIsSafe('owner-a')).toThrow(/persisted machine registrations belong to a different owner/i);
    });
  });
});

describe('bindRelayOwnerForStartup', () => {
  test('preserves existing vault initialization metadata while repairing the owner binding', async () => {
    await withIsolatedEnv(async () => {
      const result = bindRelayOwnerForStartup('owner-a');

      expect(result).toEqual({
        repairedOwnerBinding: true,
        missingVaultInitialization: false,
      });
      expect(getPersistedOwnerIdentityId()).toBe('owner-a');
      expect(getVaultMeta('vault_initialized')).toBe('1');
    });
  });

  test('leaves vault initialization unset when startup binds an owner before first unlock', async () => {
    await withIsolatedEnv(async () => {
      const result = bindRelayOwnerForStartup('owner-a');

      expect(result).toEqual({
        repairedOwnerBinding: true,
        missingVaultInitialization: true,
      });
      expect(getPersistedOwnerIdentityId()).toBe('owner-a');
      expect(getVaultMeta('vault_initialized')).toBeUndefined();
      expect(getVaultMeta('vault_salt')).toBeUndefined();
      expect(getVaultMeta('vault_key_check')).toBeUndefined();
    }, { initializeVault: false });
  });

  test('repairs owner binding drift when control owner already matches current identity', async () => {
    await withIsolatedEnv(async () => {
      bindPersistedOwnerIdentity('owner-a');
      setVaultMeta('owner_user_root_id', 'owner-b');

      const result = bindRelayOwnerForStartup('owner-a');

      expect(result).toEqual({
        repairedOwnerBinding: true,
        missingVaultInitialization: false,
      });
      expect(getPersistedOwnerIdentityId()).toBe('owner-a');
    });
  });

  test('reports repaired owner binding when only vault owner metadata exists', async () => {
    await withIsolatedEnv(async () => {
      setVaultMeta('owner_user_root_id', 'owner-a');

      const result = bindRelayOwnerForStartup('owner-a');

      expect(result).toEqual({
        repairedOwnerBinding: true,
        missingVaultInitialization: false,
      });
      expect(getPersistedOwnerIdentityId()).toBe('owner-a');
    });
  });

  test('can explicitly take over relay ownership by clearing persisted control state', async () => {
    await withIsolatedEnv(async () => {
      await unlockLocalSecureStore('test-password');
      writeLocalStoreJson('test', 'preserved', { ok: true });
      setVaultMeta('owner_user_root_id', 'owner-b');
      upsertVaultMachine({
        machineId: 'machine-a',
        ownerUserRootId: 'owner-b',
        signingKey: 'signing-a',
        keyExchangeKey: 'kex-a',
      });

      const result = takeOverRelayOwnerForStartup('owner-a');

      expect(result).toEqual({
        repairedOwnerBinding: true,
        missingVaultInitialization: true,
      });
      expect(getPersistedOwnerIdentityId()).toBe('owner-a');
      expect(getVaultMeta('vault_initialized')).toBeUndefined();
      expect(listVaultMachines()).toHaveLength(0);
      expect(readLocalStoreJson<{ ok: boolean }>('test', 'preserved')).toEqual({ ok: true });
    });
  });
});
