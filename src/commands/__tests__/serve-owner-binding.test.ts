import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindControlRelayIdentity,
  bindPersistedOwnerIdentity,
  ensureControlStore,
  getPersistedOwnerIdentityId,
  listVaultMachines,
  readControlMeta,
  setVaultMeta,
  upsertVaultMachine,
} from '../../relay/control/store.js';
import { ensureServeOwnerBindingForStartup } from '../serve.js';

let envLock: Promise<void> = Promise.resolve();

async function withIsolatedEnv(run: () => Promise<void>): Promise<void> {
  const previous = envLock;
  let release!: () => void;
  envLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  const originalHome = process.env.HOME;
  const originalControlDir = process.env.GITSPACE_CONTROL_DIR;
  const testDir = mkdtempSync(join(tmpdir(), 'gssh-serve-owner-binding-'));

  try {
    process.env.HOME = testDir;
    process.env.GITSPACE_CONTROL_DIR = join(testDir, '.relay', 'control');
    ensureControlStore();
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

describe('ensureServeOwnerBindingForStartup', () => {
  const currentRelay = {
    publicKey: Buffer.alloc(32, 1).toString('base64'),
    fingerprint: 'curr:relay:fpr1',
  };

  test('binds empty control state to the requested owner', async () => {
    await withIsolatedEnv(async () => {
      const result = await ensureServeOwnerBindingForStartup('owner-a');

      expect(result).toEqual({ tookOver: false });
      expect(getPersistedOwnerIdentityId()).toBe('owner-a');
    });
  });

  test('throws a helpful mismatch error without takeover', async () => {
    await withIsolatedEnv(async () => {
      bindPersistedOwnerIdentity('owner-b');
      setVaultMeta('owner_user_root_id', 'owner-b');

      await expect(ensureServeOwnerBindingForStartup('owner-a')).rejects.toThrow(/machine serve start --takeover/i);
    });
  });

  test('repairs owner binding drift without takeover when one persisted binding matches current identity', async () => {
    await withIsolatedEnv(async () => {
      bindPersistedOwnerIdentity('owner-a');
      setVaultMeta('owner_user_root_id', 'owner-b');

      const result = await ensureServeOwnerBindingForStartup('owner-a');

      expect(result).toEqual({ tookOver: false });
      expect(getPersistedOwnerIdentityId()).toBe('owner-a');
    });
  });

  test('takeover clears persisted control state and rebinds to the recovered owner', async () => {
    await withIsolatedEnv(async () => {
      bindPersistedOwnerIdentity('owner-b');
      setVaultMeta('owner_user_root_id', 'owner-b');
      upsertVaultMachine({
        machineId: 'machine-a',
        ownerUserRootId: 'owner-b',
        signingKey: 'signing-a',
        keyExchangeKey: 'kex-a',
      });

      const result = await ensureServeOwnerBindingForStartup('owner-a', {
        takeover: true,
        yes: true,
      });

      expect(result).toEqual({ tookOver: true });
      expect(getPersistedOwnerIdentityId()).toBe('owner-a');
      expect(listVaultMachines()).toHaveLength(0);
    });
  });

  test('throws a helpful relay mismatch error without takeover', async () => {
    await withIsolatedEnv(async () => {
      bindPersistedOwnerIdentity('owner-a');
      bindControlRelayIdentity({
        relayIdentityId: 'old-relay-id',
        relaySigningPublicKey: Buffer.alloc(32, 2).toString('base64'),
        relayFingerprint: 'old:relay:fpr0',
      });

      await expect(
        ensureServeOwnerBindingForStartup('owner-a', { currentRelay }),
      ).rejects.toThrow(/Pinned relay:.*old:relay:fpr0[\s\S]*Current relay:.*curr:relay:fpr1[\s\S]*--takeover/i);
    });
  });

  test('takeover clears persisted relay pin and rebinds owner state', async () => {
    await withIsolatedEnv(async () => {
      bindPersistedOwnerIdentity('owner-a');
      bindControlRelayIdentity({
        relayIdentityId: 'old-relay-id',
        relaySigningPublicKey: Buffer.alloc(32, 2).toString('base64'),
        relayFingerprint: 'old:relay:fpr0',
      });

      const result = await ensureServeOwnerBindingForStartup('owner-a', {
        takeover: true,
        yes: true,
        currentRelay,
      });

      expect(result).toEqual({ tookOver: true });
      expect(getPersistedOwnerIdentityId()).toBe('owner-a');
      expect(readControlMeta().relayIdentityId).toBeUndefined();
      expect(readControlMeta().relayFingerprint).toBeUndefined();
    });
  });

  test('takeover also clears pinned relay identity even when owner already matches', async () => {
    await withIsolatedEnv(async () => {
      bindPersistedOwnerIdentity('owner-a');
      bindControlRelayIdentity({
        relayIdentityId: 'relay-old',
        relaySigningPublicKey: 'old-key',
        relayFingerprint: 'old:fingerprint',
      });

      const result = await ensureServeOwnerBindingForStartup('owner-a', {
        takeover: true,
        yes: true,
      });

      expect(result).toEqual({ tookOver: true });
      expect(getPersistedOwnerIdentityId()).toBe('owner-a');
      expect(readControlMeta().relayIdentityId).toBeUndefined();
      expect(readControlMeta().relayFingerprint).toBeUndefined();
    });
  });
});
