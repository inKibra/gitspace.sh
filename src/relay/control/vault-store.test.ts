/**
 * Tests for vault CRUD operations in the control store (schema v5).
 *
 * Uses real SQLite with a temp directory per test for isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureControlStore,
  getVaultMeta,
  setVaultMeta,
  isVaultInitialized,
  getVaultCategory,
  listVaultCategories,
  removeVaultCategory,
  upsertVaultCategory,
  upsertVaultMachine,
  getVaultMachine,
  getVaultMachineBySigningKey,
  listVaultMachines,
  updateVaultMachineLastConnected,
  removeVaultMachine,
  setVaultMachineUnlockKey,
  getVaultMachineUnlockKey,
  removeVaultMachineUnlockKey,
  listVaultMachineUnlockKeys,
  grantVaultAccess,
  revokeVaultAccess,
  listVaultAccessList,
  isVaultAccessGranted,
} from './store.js';
import type { VaultSyncCategory } from './types.js';

let originalHome: string | undefined;
let originalControlDirOverride: string | undefined;
let testHomeDir: string;

describe('vault store (schema v5)', () => {
  beforeEach(() => {
    originalHome = process.env.HOME;
    originalControlDirOverride = process.env.GITSPACE_CONTROL_DIR;
    testHomeDir = mkdtempSync(join(tmpdir(), 'gssh-vault-store-'));
    process.env.HOME = testHomeDir;
    process.env.GITSPACE_CONTROL_DIR = join(testHomeDir, '.relay', 'control');
  });

  afterEach(() => {
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
  // Schema v5 migration
  // ========================================================================

  test('schema v5 tables are created on ensureControlStore', () => {
    const meta = ensureControlStore();
    expect(meta.schemaVersion).toBe(5);
  });

  // ========================================================================
  // Vault Meta
  // ========================================================================

  describe('vault meta', () => {
    test('get/set vault meta round-trip', () => {
      ensureControlStore();
      expect(getVaultMeta('vault_salt')).toBeUndefined();

      setVaultMeta('vault_salt', 'test-salt-value');
      expect(getVaultMeta('vault_salt')).toBe('test-salt-value');
    });

    test('set vault meta overwrites existing value', () => {
      ensureControlStore();
      setVaultMeta('vault_salt', 'first');
      setVaultMeta('vault_salt', 'second');
      expect(getVaultMeta('vault_salt')).toBe('second');
    });

    test('isVaultInitialized returns false initially', () => {
      ensureControlStore();
      expect(isVaultInitialized()).toBe(false);
    });

    test('isVaultInitialized returns true after setting flag', () => {
      ensureControlStore();
      setVaultMeta('vault_initialized', '1');
      expect(isVaultInitialized()).toBe(true);
    });
  });

  // ========================================================================
  // Vault Sync Categories CRUD
  // ========================================================================

  describe('vault sync categories', () => {
    const categories: VaultSyncCategory[] = [
      'fundamental',
      'integrations',
      'project/workspace',
      'preferences',
    ];

    test('upsert and get category record', () => {
      ensureControlStore();

      const record = upsertVaultCategory({
        category: 'fundamental',
        encryptedEnvelope: 'enc-1',
        writerId: 'writer-1',
        checksum: 'checksum-1',
      });

      expect(record.category).toBe('fundamental');
      expect(record.encryptedEnvelope).toBe('enc-1');
      expect(record.revision).toBe(1);
      expect(record.writerId).toBe('writer-1');
      expect(record.checksum).toBe('checksum-1');

      const loaded = getVaultCategory('fundamental');
      expect(loaded).toBeDefined();
      expect(loaded?.revision).toBe(1);
    });

    test('upsert increments revision', () => {
      ensureControlStore();

      const first = upsertVaultCategory({
        category: 'preferences',
        encryptedEnvelope: 'enc-a',
        writerId: 'writer-a',
        checksum: 'checksum-a',
      });

      const second = upsertVaultCategory({
        category: 'preferences',
        encryptedEnvelope: 'enc-b',
        writerId: 'writer-b',
        checksum: 'checksum-b',
        expectedRevision: first.revision,
      });

      expect(second.revision).toBe(first.revision + 1);
      expect(second.encryptedEnvelope).toBe('enc-b');
      expect(second.writerId).toBe('writer-b');
    });

    test('upsert enforces expected revision', () => {
      ensureControlStore();

      upsertVaultCategory({
        category: 'integrations',
        encryptedEnvelope: 'enc-1',
        writerId: 'writer-1',
        checksum: 'checksum-1',
      });

      expect(() => upsertVaultCategory({
        category: 'integrations',
        encryptedEnvelope: 'enc-2',
        writerId: 'writer-2',
        checksum: 'checksum-2',
        expectedRevision: 0,
      })).toThrow(/revision mismatch/i);
    });

    test('list returns all categories', () => {
      ensureControlStore();

      for (const category of categories) {
        upsertVaultCategory({
          category,
          encryptedEnvelope: `enc-${category}`,
          writerId: `writer-${category}`,
          checksum: `checksum-${category}`,
        });
      }

      const all = listVaultCategories();
      expect(all.length).toBe(4);
    });

    test('remove category record', () => {
      ensureControlStore();

      upsertVaultCategory({
        category: 'project/workspace',
        encryptedEnvelope: 'enc',
        writerId: 'writer',
        checksum: 'checksum',
      });

      expect(removeVaultCategory('project/workspace')).toBe(true);
      expect(getVaultCategory('project/workspace')).toBeUndefined();
      expect(removeVaultCategory('project/workspace')).toBe(false);
    });
  });

  // ========================================================================
  // Vault Machines CRUD
  // ========================================================================

  describe('vault machines', () => {
    const machine1 = {
      machineId: 'machine-1',
      ownerUserRootId: 'owner-root-abc',
      signingKey: 'signing-key-1-base64',
      keyExchangeKey: 'kex-key-1-base64',
      label: 'My Machine',
    };

    test('upsert creates new machine', () => {
      ensureControlStore();
      const result = upsertVaultMachine(machine1);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.record.machineId).toBe('machine-1');
        expect(result.record.ownerUserRootId).toBe('owner-root-abc');
        expect(result.record.signingKey).toBe('signing-key-1-base64');
        expect(result.record.label).toBe('My Machine');
        expect(result.record.registeredAt).toBeTruthy();
        expect(result.record.lastConnectedAt).toBeTruthy();
      }
    });

    test('upsert re-registration with same owner updates connection time', () => {
      ensureControlStore();
      upsertVaultMachine(machine1);

      const result = upsertVaultMachine({
        ...machine1,
        keyExchangeKey: 'updated-kex-key',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.record.keyExchangeKey).toBe('updated-kex-key');
      }
    });

    test('upsert rejects different owner', () => {
      ensureControlStore();
      upsertVaultMachine(machine1);

      const result = upsertVaultMachine({
        ...machine1,
        ownerUserRootId: 'different-owner',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/different owner/i);
      }
    });

    test('upsert rejects changed signing key', () => {
      ensureControlStore();
      upsertVaultMachine(machine1);

      const result = upsertVaultMachine({
        ...machine1,
        signingKey: 'different-signing-key',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/signing key mismatch/i);
      }
    });

    test('get returns machine by ID', () => {
      ensureControlStore();
      upsertVaultMachine(machine1);

      const m = getVaultMachine('machine-1');
      expect(m).toBeDefined();
      expect(m!.machineId).toBe('machine-1');
      expect(m!.label).toBe('My Machine');
    });

    test('get returns undefined for nonexistent machine', () => {
      ensureControlStore();
      expect(getVaultMachine('nonexistent')).toBeUndefined();
    });

    test('get by signing key', () => {
      ensureControlStore();
      upsertVaultMachine(machine1);

      const m = getVaultMachineBySigningKey('signing-key-1-base64');
      expect(m).toBeDefined();
      expect(m!.machineId).toBe('machine-1');
    });

    test('list machines returns all', () => {
      ensureControlStore();
      upsertVaultMachine(machine1);
      upsertVaultMachine({
        machineId: 'machine-2',
        ownerUserRootId: 'owner-root-abc',
        signingKey: 'signing-key-2-base64',
        keyExchangeKey: 'kex-key-2-base64',
      });

      const all = listVaultMachines();
      expect(all.length).toBe(2);
    });

    test('list machines filtered by owner', () => {
      ensureControlStore();
      upsertVaultMachine(machine1);
      upsertVaultMachine({
        machineId: 'machine-2',
        ownerUserRootId: 'other-owner',
        signingKey: 'signing-key-2-base64',
        keyExchangeKey: 'kex-key-2-base64',
      });

      const ownerMachines = listVaultMachines('owner-root-abc');
      expect(ownerMachines.length).toBe(1);
      expect(ownerMachines[0].machineId).toBe('machine-1');
    });

    test('update last connected', () => {
      ensureControlStore();
      upsertVaultMachine(machine1);

      const before = getVaultMachine('machine-1')!;
      // Small delay to ensure timestamp difference
      updateVaultMachineLastConnected('machine-1');
      const after = getVaultMachine('machine-1')!;

      expect(after.lastConnectedAt).toBeTruthy();
      // lastConnectedAt should be >= before (same or later)
      expect(Date.parse(after.lastConnectedAt)).toBeGreaterThanOrEqual(
        Date.parse(before.lastConnectedAt)
      );
    });

    test('remove machine', () => {
      ensureControlStore();
      upsertVaultMachine(machine1);

      expect(removeVaultMachine('machine-1')).toBe(true);
      expect(getVaultMachine('machine-1')).toBeUndefined();
    });

    test('remove nonexistent machine returns false', () => {
      ensureControlStore();
      expect(removeVaultMachine('nonexistent')).toBe(false);
    });
  });

  // ========================================================================
  // Vault Machine Unlock Keys CRUD
  // ========================================================================

  describe('vault machine unlock keys', () => {
    beforeEach(() => {
      ensureControlStore();
      upsertVaultMachine({
        machineId: 'machine-1',
        ownerUserRootId: 'owner-root',
        signingKey: 'sk-1',
        keyExchangeKey: 'kex-1',
      });
    });

    test('set and get encrypted unlock key', () => {
      setVaultMachineUnlockKey('machine-1', 'encrypted-data-base64');

      const record = getVaultMachineUnlockKey('machine-1');
      expect(record).toBeDefined();
      expect(record!.machineId).toBe('machine-1');
      expect(record!.encryptedUnlockKey).toBe('encrypted-data-base64');
      expect(record!.createdAt).toBeTruthy();
      expect(record!.updatedAt).toBeTruthy();
    });

    test('upsert overwrites existing unlock key', () => {
      setVaultMachineUnlockKey('machine-1', 'first-data');
      setVaultMachineUnlockKey('machine-1', 'second-data');

      const record = getVaultMachineUnlockKey('machine-1');
      expect(record!.encryptedUnlockKey).toBe('second-data');
    });

    test('get returns undefined for nonexistent machine', () => {
      expect(getVaultMachineUnlockKey('nonexistent')).toBeUndefined();
    });

    test('remove unlock key', () => {
      setVaultMachineUnlockKey('machine-1', 'data');
      expect(removeVaultMachineUnlockKey('machine-1')).toBe(true);
      expect(getVaultMachineUnlockKey('machine-1')).toBeUndefined();
    });

    test('remove nonexistent returns false', () => {
      expect(removeVaultMachineUnlockKey('nonexistent')).toBe(false);
    });

    test('list all unlock keys', () => {
      upsertVaultMachine({
        machineId: 'machine-2',
        ownerUserRootId: 'owner-root',
        signingKey: 'sk-2',
        keyExchangeKey: 'kex-2',
      });

      setVaultMachineUnlockKey('machine-1', 'data-1');
      setVaultMachineUnlockKey('machine-2', 'data-2');

      const all = listVaultMachineUnlockKeys();
      expect(all.length).toBe(2);
    });

    test('cascade delete removes unlock key when machine is removed', () => {
      setVaultMachineUnlockKey('machine-1', 'data');
      removeVaultMachine('machine-1');
      expect(getVaultMachineUnlockKey('machine-1')).toBeUndefined();
    });
  });

  // ========================================================================
  // Vault Access List CRUD
  // ========================================================================

  describe('vault access list', () => {
    test('grant and list access', () => {
      ensureControlStore();

      const entry = grantVaultAccess({
        ownerUserRootId: 'owner-1',
        clientUserRootId: 'client-1',
        label: 'Alice',
      });

      expect(entry.ownerUserRootId).toBe('owner-1');
      expect(entry.clientUserRootId).toBe('client-1');
      expect(entry.label).toBe('Alice');
      expect(entry.grantedAt).toBeTruthy();
      expect(entry.id).toBeGreaterThan(0);

      const list = listVaultAccessList('owner-1');
      expect(list.length).toBe(1);
      expect(list[0].clientUserRootId).toBe('client-1');
    });

    test('grant upserts existing access (updates label)', () => {
      ensureControlStore();

      grantVaultAccess({
        ownerUserRootId: 'owner-1',
        clientUserRootId: 'client-1',
        label: 'Old Label',
      });

      grantVaultAccess({
        ownerUserRootId: 'owner-1',
        clientUserRootId: 'client-1',
        label: 'New Label',
      });

      const list = listVaultAccessList('owner-1');
      expect(list.length).toBe(1);
      expect(list[0].label).toBe('New Label');
    });

    test('isVaultAccessGranted returns correct values', () => {
      ensureControlStore();

      expect(isVaultAccessGranted('owner-1', 'client-1')).toBe(false);

      grantVaultAccess({
        ownerUserRootId: 'owner-1',
        clientUserRootId: 'client-1',
      });

      expect(isVaultAccessGranted('owner-1', 'client-1')).toBe(true);
      expect(isVaultAccessGranted('owner-1', 'client-2')).toBe(false);
      expect(isVaultAccessGranted('owner-2', 'client-1')).toBe(false);
    });

    test('revoke access', () => {
      ensureControlStore();

      grantVaultAccess({
        ownerUserRootId: 'owner-1',
        clientUserRootId: 'client-1',
      });

      expect(revokeVaultAccess('owner-1', 'client-1')).toBe(true);
      expect(isVaultAccessGranted('owner-1', 'client-1')).toBe(false);
      expect(listVaultAccessList('owner-1').length).toBe(0);
    });

    test('revoke nonexistent returns false', () => {
      ensureControlStore();
      expect(revokeVaultAccess('owner-1', 'client-1')).toBe(false);
    });

    test('multiple clients for same owner', () => {
      ensureControlStore();

      grantVaultAccess({ ownerUserRootId: 'owner-1', clientUserRootId: 'client-1', label: 'Alice' });
      grantVaultAccess({ ownerUserRootId: 'owner-1', clientUserRootId: 'client-2', label: 'Bob' });
      grantVaultAccess({ ownerUserRootId: 'owner-1', clientUserRootId: 'client-3' });

      const list = listVaultAccessList('owner-1');
      expect(list.length).toBe(3);
    });

    test('access lists are isolated per owner', () => {
      ensureControlStore();

      grantVaultAccess({ ownerUserRootId: 'owner-1', clientUserRootId: 'client-shared' });
      grantVaultAccess({ ownerUserRootId: 'owner-2', clientUserRootId: 'client-shared' });

      expect(listVaultAccessList('owner-1').length).toBe(1);
      expect(listVaultAccessList('owner-2').length).toBe(1);

      revokeVaultAccess('owner-1', 'client-shared');
      expect(isVaultAccessGranted('owner-1', 'client-shared')).toBe(false);
      expect(isVaultAccessGranted('owner-2', 'client-shared')).toBe(true);
    });
  });
});
