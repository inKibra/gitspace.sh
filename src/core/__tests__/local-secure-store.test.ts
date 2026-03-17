import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lockLocalSecureStore,
  readLocalStoreJson,
  readLocalStoreSecretJson,
  unlockLocalSecureStore,
  writeLocalStoreJson,
  writeLocalStoreSecretJson,
} from '../local-secure-store.js';
import {
  clearRelayConfig,
  generateAndSaveKeypair,
  getKeypairPath,
  getPublicKeyWithoutPassword,
  loadKeypair,
  readMachineIdentity,
  readRelayConfig,
  writeMachineIdentity,
  writeRelayConfig,
} from '../identity.js';

let originalHome: string | undefined;
let testDir: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  testDir = mkdtempSync(join(tmpdir(), 'gssh-local-store-'));
  process.env.HOME = testDir;
});

afterEach(() => {
  lockLocalSecureStore();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('local secure store', () => {
  test('persists plain and encrypted JSON records', async () => {
    await unlockLocalSecureStore('secret-password');

    writeLocalStoreJson('test', 'plain', { hello: 'world' });
    writeLocalStoreSecretJson('test', 'secret', { token: 'abc123' });

    expect(readLocalStoreJson<{ hello: string }>('test', 'plain')).toEqual({ hello: 'world' });
    expect(readLocalStoreSecretJson<{ token: string }>('test', 'secret')).toEqual({ token: 'abc123' });

    lockLocalSecureStore();
    await unlockLocalSecureStore('secret-password');
    expect(readLocalStoreSecretJson<{ token: string }>('test', 'secret')?.token).toBe('abc123');
  });

  test('stores keypairs and configs in control db with legacy fallback retained', async () => {
    const created = await generateAndSaveKeypair('secret-password', 'test-device');
    expect(getPublicKeyWithoutPassword()?.id).toBe(created.id);

    const keypairPath = getKeypairPath();
    expect(existsSync(keypairPath)).toBe(true);
    unlinkSync(keypairPath);

    const loaded = await loadKeypair('secret-password');
    expect(loaded.id).toBe(created.id);

    writeMachineIdentity({
      machineId: 'machine-1',
      machineName: 'My Machine',
      relayUrl: 'wss://relay.example.test/ws',
      registeredAt: '2026-03-16T00:00:00.000Z',
    });
    expect(readMachineIdentity()?.machineId).toBe('machine-1');

    writeRelayConfig({
      relayUrl: 'wss://relay.example.test/ws',
      cloudRelayUrl: 'wss://cloud.example.test/ws',
      machineId: 'machine-1',
      savedAt: Date.now(),
    });
    expect(readRelayConfig()?.machineId).toBe('machine-1');

    clearRelayConfig();
    expect(readRelayConfig()).toBeNull();
  });
});
