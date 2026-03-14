import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindControlOwner,
  ensureControlStore,
  getControlOwnerIdentityId,
  getVaultMeta,
  listVaultMachines,
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
  test('binds empty control state to the requested owner', async () => {
    await withIsolatedEnv(async () => {
      const result = await ensureServeOwnerBindingForStartup('owner-a');

      expect(result).toEqual({ tookOver: false });
      expect(getControlOwnerIdentityId()).toBe('owner-a');
      expect(getVaultMeta('owner_user_root_id')).toBe('owner-a');
    });
  });

  test('throws a helpful mismatch error without takeover', async () => {
    await withIsolatedEnv(async () => {
      bindControlOwner('owner-b');
      setVaultMeta('owner_user_root_id', 'owner-b');

      await expect(ensureServeOwnerBindingForStartup('owner-a')).rejects.toThrow(/machine serve start --takeover/i);
    });
  });

  test('takeover clears persisted control state and rebinds to the recovered owner', async () => {
    await withIsolatedEnv(async () => {
      bindControlOwner('owner-b');
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
      expect(getControlOwnerIdentityId()).toBe('owner-a');
      expect(getVaultMeta('owner_user_root_id')).toBe('owner-a');
      expect(listVaultMachines()).toHaveLength(0);
    });
  });
});
