/**
 * Tests for the Relay Vault — encryption, locked mode, unlock key management.
 *
 * Uses real SQLite with a temp directory per test for isolation.
 * Uses real crypto (no mocks) since these test the actual seal/open cycle.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  ensureControlStore,
  isVaultInitialized,
  upsertVaultCategory,
  upsertVaultMachine,
} from './control/store.js';
import {
  initializeVault,
  unlockVault,
  lockVault,
  isVaultUnlocked,
  getVaultLockState,
  generateMachineUnlockKey,
  sealMachineUnlockKey,
  openMachineUnlockKey,
  removeMachineUnlockKey,
  listMachinesWithUnlockKeys,
  openAllMachineUnlockKeys,
  listVaultSyncCategoryMetadata,
  MACHINE_UNLOCK_KEY_LENGTH,
  readVaultCategoryText,
  removeVaultSyncCategory,
  _resetVaultState,
  writeVaultCategory,
} from './vault.js';
import type { VaultSyncCategory } from './control/types.js';

let originalHome: string | undefined;
let originalControlDirOverride: string | undefined;
let testHomeDir: string;

/** Generate a fake "user root private key" (32 bytes) for testing */
function fakePrivateKey(): Uint8Array {
  return randomBytes(32);
}

describe('relay vault', () => {
  beforeEach(() => {
    originalHome = process.env.HOME;
    originalControlDirOverride = process.env.GITSPACE_CONTROL_DIR;
    testHomeDir = mkdtempSync(join(tmpdir(), 'gssh-vault-'));
    process.env.HOME = testHomeDir;
    process.env.GITSPACE_CONTROL_DIR = join(testHomeDir, '.relay', 'control');

    // Ensure schema is up to date
    ensureControlStore();
    // Reset vault state from any prior test
    _resetVaultState();
  });

  afterEach(() => {
    _resetVaultState();

    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalControlDirOverride === undefined) {
      delete process.env.GITSPACE_CONTROL_DIR;
    } else {
      process.env.GITSPACE_CONTROL_DIR = originalControlDirOverride;
    }

    if (testHomeDir && existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true, force: true });
    }
  });

  // ========================================================================
  // Initialization
  // ========================================================================

  describe('initialization', () => {
    test('vault starts locked', () => {
      expect(isVaultUnlocked()).toBe(false);
      expect(getVaultLockState()).toBe('locked');
    });

    test('initializeVault succeeds and unlocks', () => {
      const key = fakePrivateKey();
      const result = initializeVault(key);

      expect(result).toBe(true);
      expect(isVaultInitialized()).toBe(true);
      expect(isVaultUnlocked()).toBe(true);
      expect(getVaultLockState()).toBe('unlocked');
    });

    test('initializeVault returns false if already initialized', () => {
      const key = fakePrivateKey();
      initializeVault(key);

      const result = initializeVault(key);
      expect(result).toBe(false);
    });

    test('initializeVault with different keys creates different vaults', () => {
      const key1 = fakePrivateKey();
      initializeVault(key1);

      // Lock and verify we can't unlock with wrong key
      lockVault();

      const wrongKey = fakePrivateKey();
      const unlocked = unlockVault(wrongKey);
      expect(unlocked).toBe(false);
      expect(isVaultUnlocked()).toBe(false);
    });
  });

  // ========================================================================
  // Lock / Unlock cycle
  // ========================================================================

  describe('lock / unlock', () => {
    test('lock wipes vault key from memory', () => {
      const key = fakePrivateKey();
      initializeVault(key);
      expect(isVaultUnlocked()).toBe(true);

      lockVault();
      expect(isVaultUnlocked()).toBe(false);
      expect(getVaultLockState()).toBe('locked');
    });

    test('unlock with correct key succeeds', () => {
      const key = fakePrivateKey();
      initializeVault(key);
      lockVault();

      const result = unlockVault(key);
      expect(result).toBe(true);
      expect(isVaultUnlocked()).toBe(true);
    });

    test('unlock with wrong key fails', () => {
      const key = fakePrivateKey();
      initializeVault(key);
      lockVault();

      const wrongKey = fakePrivateKey();
      const result = unlockVault(wrongKey);
      expect(result).toBe(false);
      expect(isVaultUnlocked()).toBe(false);
    });

    test('unlock throws if vault not initialized', () => {
      const key = fakePrivateKey();
      expect(() => unlockVault(key)).toThrow(/not initialized/i);
    });

    test('multiple lock/unlock cycles with same key', () => {
      const key = fakePrivateKey();
      initializeVault(key);

      for (let i = 0; i < 5; i++) {
        lockVault();
        expect(isVaultUnlocked()).toBe(false);

        const result = unlockVault(key);
        expect(result).toBe(true);
        expect(isVaultUnlocked()).toBe(true);
      }
    });

    test('lock is idempotent', () => {
      const key = fakePrivateKey();
      initializeVault(key);

      lockVault();
      lockVault(); // Should not throw
      expect(isVaultUnlocked()).toBe(false);
    });
  });

  // ========================================================================
  // Machine unlock keys
  // ========================================================================

  describe('machine unlock keys', () => {
    let ownerKey: Uint8Array;

    beforeEach(() => {
      ownerKey = fakePrivateKey();
      initializeVault(ownerKey);

      // Create a machine for FK reference
      upsertVaultMachine({
        machineId: 'machine-1',
        ownerUserRootId: 'owner-root',
        signingKey: 'sk-1',
        keyExchangeKey: 'kex-1',
      });
    });

    test('generateMachineUnlockKey produces correct length', () => {
      const key = generateMachineUnlockKey();
      expect(key.length).toBe(MACHINE_UNLOCK_KEY_LENGTH);
    });

    test('generateMachineUnlockKey produces unique keys', () => {
      const key1 = generateMachineUnlockKey();
      const key2 = generateMachineUnlockKey();
      expect(Buffer.from(key1).toString('hex')).not.toBe(
        Buffer.from(key2).toString('hex')
      );
    });

    test('seal and open roundtrip', () => {
      const unlockKey = generateMachineUnlockKey();
      sealMachineUnlockKey('machine-1', unlockKey);

      const recovered = openMachineUnlockKey('machine-1');
      expect(recovered).not.toBeNull();
      expect(Buffer.from(recovered!).toString('hex')).toBe(
        Buffer.from(unlockKey).toString('hex')
      );
    });

    test('seal throws when vault is locked', () => {
      lockVault();
      const unlockKey = generateMachineUnlockKey();
      expect(() => sealMachineUnlockKey('machine-1', unlockKey)).toThrow(/locked/i);
    });

    test('open throws when vault is locked', () => {
      const unlockKey = generateMachineUnlockKey();
      sealMachineUnlockKey('machine-1', unlockKey);
      lockVault();

      expect(() => openMachineUnlockKey('machine-1')).toThrow(/locked/i);
    });

    test('open returns null for nonexistent machine', () => {
      expect(openMachineUnlockKey('nonexistent')).toBeNull();
    });

    test('seal overwrites previous unlock key', () => {
      const key1 = generateMachineUnlockKey();
      const key2 = generateMachineUnlockKey();

      sealMachineUnlockKey('machine-1', key1);
      sealMachineUnlockKey('machine-1', key2);

      const recovered = openMachineUnlockKey('machine-1');
      expect(Buffer.from(recovered!).toString('hex')).toBe(
        Buffer.from(key2).toString('hex')
      );
    });

    test('remove machine unlock key', () => {
      const unlockKey = generateMachineUnlockKey();
      sealMachineUnlockKey('machine-1', unlockKey);

      expect(removeMachineUnlockKey('machine-1')).toBe(true);
      expect(openMachineUnlockKey('machine-1')).toBeNull();
    });

    test('list machines with unlock keys', () => {
      upsertVaultMachine({
        machineId: 'machine-2',
        ownerUserRootId: 'owner-root',
        signingKey: 'sk-2',
        keyExchangeKey: 'kex-2',
      });

      sealMachineUnlockKey('machine-1', generateMachineUnlockKey());
      sealMachineUnlockKey('machine-2', generateMachineUnlockKey());

      const ids = listMachinesWithUnlockKeys();
      expect(ids).toContain('machine-1');
      expect(ids).toContain('machine-2');
      expect(ids.length).toBe(2);
    });

    test('open all machine unlock keys', () => {
      upsertVaultMachine({
        machineId: 'machine-2',
        ownerUserRootId: 'owner-root',
        signingKey: 'sk-2',
        keyExchangeKey: 'kex-2',
      });

      const key1 = generateMachineUnlockKey();
      const key2 = generateMachineUnlockKey();

      sealMachineUnlockKey('machine-1', key1);
      sealMachineUnlockKey('machine-2', key2);

      const all = openAllMachineUnlockKeys();
      expect(all.size).toBe(2);
      expect(Buffer.from(all.get('machine-1')!).toString('hex')).toBe(
        Buffer.from(key1).toString('hex')
      );
      expect(Buffer.from(all.get('machine-2')!).toString('hex')).toBe(
        Buffer.from(key2).toString('hex')
      );
    });

    test('open all throws when vault is locked', () => {
      lockVault();
      expect(() => openAllMachineUnlockKeys()).toThrow(/locked/i);
    });

    test('seal, lock, unlock, open cycle', () => {
      const unlockKey = generateMachineUnlockKey();
      sealMachineUnlockKey('machine-1', unlockKey);

      // Lock vault
      lockVault();
      expect(isVaultUnlocked()).toBe(false);

      // Unlock vault with owner key
      const result = unlockVault(ownerKey);
      expect(result).toBe(true);

      // Recover the unlock key
      const recovered = openMachineUnlockKey('machine-1');
      expect(recovered).not.toBeNull();
      expect(Buffer.from(recovered!).toString('hex')).toBe(
        Buffer.from(unlockKey).toString('hex')
      );
    });
  });

  // ========================================================================
  // Sync category envelopes
  // ========================================================================

  describe('sync categories', () => {
    const categories: VaultSyncCategory[] = [
      'fundamental',
      'integrations',
      'project/workspace',
      'preferences',
    ];

    test('write/read roundtrip for all categories', () => {
      const ownerKey = fakePrivateKey();
      initializeVault(ownerKey);

      for (const category of categories) {
        writeVaultCategory({
          category,
          payload: `payload-${category}`,
          writerId: 'writer-a',
        });
      }

      for (const category of categories) {
        expect(readVaultCategoryText(category)).toBe(`payload-${category}`);
      }
    });

    test('write increments revision and tracks metadata', () => {
      const ownerKey = fakePrivateKey();
      initializeVault(ownerKey);

      const first = writeVaultCategory({
        category: 'preferences',
        payload: 'v1',
        writerId: 'writer-a',
      });
      const second = writeVaultCategory({
        category: 'preferences',
        payload: 'v2',
        writerId: 'writer-b',
        expectedRevision: first.revision,
      });

      expect(second.revision).toBe(first.revision + 1);
      expect(second.writerId).toBe('writer-b');
      expect(second.checksum).not.toBe(first.checksum);

      const all = listVaultSyncCategoryMetadata();
      expect(all.length).toBe(1);
      expect(all[0]?.category).toBe('preferences');
    });

    test('write/read throw when vault is locked', () => {
      const ownerKey = fakePrivateKey();
      initializeVault(ownerKey);
      lockVault();

      expect(() => writeVaultCategory({
        category: 'fundamental',
        payload: 'data',
        writerId: 'writer-a',
      })).toThrow(/locked/i);

      expect(() => readVaultCategoryText('fundamental')).toThrow(/locked/i);
    });

    test('remove category metadata', () => {
      const ownerKey = fakePrivateKey();
      initializeVault(ownerKey);

      writeVaultCategory({
        category: 'integrations',
        payload: 'integration-data',
        writerId: 'writer-a',
      });

      expect(removeVaultSyncCategory('integrations')).toBe(true);
      expect(readVaultCategoryText('integrations')).toBeNull();
      expect(removeVaultSyncCategory('integrations')).toBe(false);
    });

    test('checksum mismatch is rejected', () => {
      const ownerKey = fakePrivateKey();
      initializeVault(ownerKey);

      const written = writeVaultCategory({
        category: 'fundamental',
        payload: 'expected-payload',
        writerId: 'writer-a',
      });

      upsertVaultCategory({
        category: 'fundamental',
        encryptedEnvelope: written.encryptedEnvelope,
        writerId: written.writerId,
        checksum: 'deadbeef',
      });

      expect(() => readVaultCategoryText('fundamental')).toThrow(/checksum mismatch/i);
    });
  });

  // ========================================================================
  // Full lifecycle test
  // ========================================================================

  describe('full lifecycle', () => {
    test('init → seal keys → lock → unlock → recover keys', () => {
      const ownerKey = fakePrivateKey();

      // 1. Initialize vault
      initializeVault(ownerKey);
      expect(isVaultUnlocked()).toBe(true);

      // 2. Register machines and seal unlock keys
      upsertVaultMachine({
        machineId: 'prod-1',
        ownerUserRootId: 'owner',
        signingKey: 'sk-prod-1',
        keyExchangeKey: 'kex-prod-1',
        label: 'Production',
      });
      upsertVaultMachine({
        machineId: 'dev-1',
        ownerUserRootId: 'owner',
        signingKey: 'sk-dev-1',
        keyExchangeKey: 'kex-dev-1',
        label: 'Development',
      });

      const prodKey = generateMachineUnlockKey();
      const devKey = generateMachineUnlockKey();
      sealMachineUnlockKey('prod-1', prodKey);
      sealMachineUnlockKey('dev-1', devKey);

      // 3. Simulate relay restart (lock vault)
      lockVault();
      expect(isVaultUnlocked()).toBe(false);

      // 4. Owner unlocks from device
      expect(unlockVault(ownerKey)).toBe(true);
      expect(isVaultUnlocked()).toBe(true);

      // 5. Recover all unlock keys
      const all = openAllMachineUnlockKeys();
      expect(all.size).toBe(2);
      expect(Buffer.from(all.get('prod-1')!).toString('hex')).toBe(
        Buffer.from(prodKey).toString('hex')
      );
      expect(Buffer.from(all.get('dev-1')!).toString('hex')).toBe(
        Buffer.from(devKey).toString('hex')
      );

      // 6. Machines persist across lock/unlock (SQLite)
      const machines = require('./control/store.js').listVaultMachines();
      expect(machines.length).toBe(2);
    });
  });
});
