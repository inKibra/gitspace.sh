/**
 * Tests for machine-access command implementations.
 *
 * Uses a real temporary SQLite store (relay auth store) and mocked identity
 * helpers so tests are deterministic and don't touch the real filesystem.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic, mnemonicToUserIdentity } from '../../lib/tmux-lite/crypto/user-identity.js';
import { formatUserRootPublicKey } from '../../lib/tmux-lite/crypto/user-identity.js';

// ── test identities ───────────────────────────────────────────────────────────

const OWNER_IDENTITY = mnemonicToUserIdentity(generateMnemonic());
const CLIENT_IDENTITY = mnemonicToUserIdentity(generateMnemonic());
const CLIENT2_IDENTITY = mnemonicToUserIdentity(generateMnemonic());
const TEST_MACHINE_ID = 'test-machine-access-001';
const RELAY_MACHINE_ID = 'relay-machine-in-config';

// ── module mocks ──────────────────────────────────────────────────────────────

mock.module('../../core/user-identity.js', () => ({
  loadUserRootIdentity: async () => OWNER_IDENTITY,
}));

mock.module('../../core/identity.js', () => ({
  readRelayConfig: () => ({ machineId: RELAY_MACHINE_ID, relayUrl: 'wss://relay.test/ws' }),
  keypairExists: () => true,
  getPublicKeyWithoutPassword: () => ({ id: OWNER_IDENTITY.id }),
}));

// Mock prompts to avoid interactive terminal in tests
mock.module('../../utils/prompts.js', () => ({
  promptConfirm: async () => true,
  promptInput: async () => '',
}));

// ── imports after mocks ───────────────────────────────────────────────────────

import { addAccessKey, listAccessKeys, removeAccessKey } from '../machine-access.js';
import { listMachineAccessList } from '../../relay/auth/store.js';
import {
  ensureControlStore,
  bindControlOwner,
  upsertVaultMachine,
} from '../../relay/control/store.js';

// ── env setup ─────────────────────────────────────────────────────────────────

let originalHome: string | undefined;
let originalControlDir: string | undefined;
let testDir: string;

const FAKE_SIGNING_KEY = 'A'.repeat(64);
const FAKE_EXCHANGE_KEY = 'B'.repeat(64);

function setup() {
  originalHome = process.env.HOME;
  originalControlDir = process.env.GITSPACE_CONTROL_DIR;
  testDir = mkdtempSync(join(tmpdir(), 'gssh-machine-access-'));
  process.env.HOME = testDir;
  process.env.GITSPACE_CONTROL_DIR = join(testDir, '.relay', 'control');

  // Initialize control store (creates all tables including vault_machines)
  ensureControlStore();
  bindControlOwner(OWNER_IDENTITY.id);

  // Pre-register both test machines so grantMachineAccess FK constraint is satisfied
  upsertVaultMachine({
    machineId: TEST_MACHINE_ID,
    ownerUserRootId: OWNER_IDENTITY.id,
    signingKey: FAKE_SIGNING_KEY,
    keyExchangeKey: FAKE_EXCHANGE_KEY,
    label: 'Test Machine',
  });
  upsertVaultMachine({
    machineId: RELAY_MACHINE_ID,
    ownerUserRootId: OWNER_IDENTITY.id,
    signingKey: FAKE_SIGNING_KEY + '1',
    keyExchangeKey: FAKE_EXCHANGE_KEY + '1',
    label: 'Relay Machine',
  });
}

function teardown() {
  if (originalHome === undefined) { delete process.env.HOME; } else { process.env.HOME = originalHome; }
  if (originalControlDir === undefined) { delete process.env.GITSPACE_CONTROL_DIR; } else { process.env.GITSPACE_CONTROL_DIR = originalControlDir; }
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function clientKey(identity: typeof CLIENT_IDENTITY): string {
  return formatUserRootPublicKey(identity);
}

// ── addAccessKey ──────────────────────────────────────────────────────────────

describe('addAccessKey', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('adds grant to the store for an explicit machine ID', async () => {
    await addAccessKey(CLIENT_IDENTITY.id, { machine: TEST_MACHINE_ID });

    const entries = listMachineAccessList(TEST_MACHINE_ID, OWNER_IDENTITY.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].clientUserRootId).toBe(CLIENT_IDENTITY.id);
  });

  test('uses relay config machineId when --machine is omitted', async () => {
    await addAccessKey(CLIENT_IDENTITY.id, {});

    const entries = listMachineAccessList(RELAY_MACHINE_ID, OWNER_IDENTITY.id);
    expect(entries).toHaveLength(1);
  });

  test('stores label when provided', async () => {
    await addAccessKey(CLIENT_IDENTITY.id, { machine: TEST_MACHINE_ID, label: 'alice' });

    const entries = listMachineAccessList(TEST_MACHINE_ID, OWNER_IDENTITY.id);
    expect(entries[0].label).toBe('alice');
  });

  test('accepts gssh-user: prefixed key format', async () => {
    const gsshKey = clientKey(CLIENT_IDENTITY);
    await addAccessKey(gsshKey, { machine: TEST_MACHINE_ID });

    const entries = listMachineAccessList(TEST_MACHINE_ID, OWNER_IDENTITY.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].clientUserRootId).toBe(CLIENT_IDENTITY.id);
  });

  test('throws SpacesError when granting access to the owner themselves', async () => {
    await expect(
      addAccessKey(OWNER_IDENTITY.id, { machine: TEST_MACHINE_ID })
    ).rejects.toThrow(/owner does not need/i);
  });

  test('throws SpacesError when machine ID is missing and relay config has no machineId', async () => {
    mock.module('../../core/identity.js', () => ({
      readRelayConfig: () => null,
      keypairExists: () => true,
      getPublicKeyWithoutPassword: () => ({ id: OWNER_IDENTITY.id }),
    }));

    await expect(addAccessKey(CLIENT_IDENTITY.id, {})).rejects.toThrow(/machine id is required/i);

    // Restore
    mock.module('../../core/identity.js', () => ({
      readRelayConfig: () => ({ machineId: RELAY_MACHINE_ID, relayUrl: 'wss://relay.test/ws' }),
      keypairExists: () => true,
      getPublicKeyWithoutPassword: () => ({ id: OWNER_IDENTITY.id }),
    }));
  });
});

// ── listAccessKeys ────────────────────────────────────────────────────────────

describe('listAccessKeys', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('returns empty result when no grants exist', async () => {
    // Should not throw; just prints "No machine access grants"
    await expect(listAccessKeys({ machine: TEST_MACHINE_ID })).resolves.toBeUndefined();
  });

  test('lists all grants for a machine', async () => {
    // Seed two grants directly via the store
    const { grantMachineAccess } = await import('../../relay/auth/store.js');
    grantMachineAccess({ machineId: TEST_MACHINE_ID, ownerUserRootId: OWNER_IDENTITY.id, clientUserRootId: CLIENT_IDENTITY.id });
    grantMachineAccess({ machineId: TEST_MACHINE_ID, ownerUserRootId: OWNER_IDENTITY.id, clientUserRootId: CLIENT2_IDENTITY.id });

    const entries = listMachineAccessList(TEST_MACHINE_ID, OWNER_IDENTITY.id);
    expect(entries).toHaveLength(2);

    // Calling listAccessKeys should not throw
    await expect(listAccessKeys({ machine: TEST_MACHINE_ID })).resolves.toBeUndefined();
  });

  test('outputs JSON when --json flag is set', async () => {
    const { grantMachineAccess } = await import('../../relay/auth/store.js');
    grantMachineAccess({ machineId: TEST_MACHINE_ID, ownerUserRootId: OWNER_IDENTITY.id, clientUserRootId: CLIENT_IDENTITY.id, label: 'alice' });

    // listAccessKeys writes to logger.log, not stdout — we just verify no throw
    await expect(listAccessKeys({ machine: TEST_MACHINE_ID, json: true })).resolves.toBeUndefined();
  });
});

// ── removeAccessKey ───────────────────────────────────────────────────────────

describe('removeAccessKey', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('removes an existing grant by exact clientUserRootId', async () => {
    const { grantMachineAccess } = await import('../../relay/auth/store.js');
    grantMachineAccess({ machineId: TEST_MACHINE_ID, ownerUserRootId: OWNER_IDENTITY.id, clientUserRootId: CLIENT_IDENTITY.id });

    await removeAccessKey(CLIENT_IDENTITY.id, { force: true, machine: TEST_MACHINE_ID });

    const remaining = listMachineAccessList(TEST_MACHINE_ID, OWNER_IDENTITY.id);
    expect(remaining).toHaveLength(0);
  });

  test('removes an existing grant by label', async () => {
    const { grantMachineAccess } = await import('../../relay/auth/store.js');
    grantMachineAccess({ machineId: TEST_MACHINE_ID, ownerUserRootId: OWNER_IDENTITY.id, clientUserRootId: CLIENT_IDENTITY.id, label: 'alice' });

    await removeAccessKey('alice', { force: true, machine: TEST_MACHINE_ID });

    const remaining = listMachineAccessList(TEST_MACHINE_ID, OWNER_IDENTITY.id);
    expect(remaining).toHaveLength(0);
  });

  test('removes an existing grant by ID prefix', async () => {
    const { grantMachineAccess } = await import('../../relay/auth/store.js');
    grantMachineAccess({ machineId: TEST_MACHINE_ID, ownerUserRootId: OWNER_IDENTITY.id, clientUserRootId: CLIENT_IDENTITY.id });

    const prefix = CLIENT_IDENTITY.id.slice(0, 8);
    await removeAccessKey(prefix, { force: true, machine: TEST_MACHINE_ID });

    const remaining = listMachineAccessList(TEST_MACHINE_ID, OWNER_IDENTITY.id);
    expect(remaining).toHaveLength(0);
  });

  test('throws SpacesError when grant is not found', async () => {
    await expect(
      removeAccessKey('nonexistent-user-id', { force: true, machine: TEST_MACHINE_ID })
    ).rejects.toThrow(/no machine access grant found/i);
  });

  test('removes by gssh-user: prefixed key format', async () => {
    const { grantMachineAccess } = await import('../../relay/auth/store.js');
    grantMachineAccess({ machineId: TEST_MACHINE_ID, ownerUserRootId: OWNER_IDENTITY.id, clientUserRootId: CLIENT_IDENTITY.id });

    const gsshKey = clientKey(CLIENT_IDENTITY);
    await removeAccessKey(gsshKey, { force: true, machine: TEST_MACHINE_ID });

    const remaining = listMachineAccessList(TEST_MACHINE_ID, OWNER_IDENTITY.id);
    expect(remaining).toHaveLength(0);
  });

  test('prompts for confirmation when --force is not set', async () => {
    const { grantMachineAccess } = await import('../../relay/auth/store.js');
    grantMachineAccess({ machineId: TEST_MACHINE_ID, ownerUserRootId: OWNER_IDENTITY.id, clientUserRootId: CLIENT_IDENTITY.id });

    // promptConfirm is mocked to return true, so should proceed
    await removeAccessKey(CLIENT_IDENTITY.id, { force: false, machine: TEST_MACHINE_ID });

    const remaining = listMachineAccessList(TEST_MACHINE_ID, OWNER_IDENTITY.id);
    expect(remaining).toHaveLength(0);
  });
});
