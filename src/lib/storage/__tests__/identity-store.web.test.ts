/**
 * Tests for the browser device identity store.
 *
 * identity-store.web.ts uses:
 *   - window.crypto.subtle  (Web Crypto — PBKDF2 + AES-256-GCM)
 *   - localStorage
 *
 * Bun provides globalThis.crypto.subtle natively.
 * localStorage is provided by a lightweight in-memory mock below.
 */

import { describe, it, expect, beforeEach } from 'bun:test';

// ─── Browser environment shim ────────────────────────────────────────────────
// identity-store.web.ts calls getCryptoApi() which checks `window.crypto`.
// We alias globalThis.window to the Bun-native globalThis.crypto so the module
// resolves the same SubtleCrypto instance it would get in a real browser.

class InMemoryLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
  get length(): number { return this.store.size; }
  key(index: number): string | null { return [...this.store.keys()][index] ?? null; }
}

let mockLocalStorage: InMemoryLocalStorage;

// Installed once — before any test module is imported — so the identity-store
// module resolves window and localStorage from globalThis at import time.
function installBrowserGlobals(): void {
  mockLocalStorage = new InMemoryLocalStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: mockLocalStorage,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: { crypto: (globalThis as typeof globalThis & { crypto: Crypto }).crypto },
    writable: true,
    configurable: true,
  });
}

installBrowserGlobals();

// ─── Imports (after globals are set) ─────────────────────────────────────────

import {
  hasStoredDeviceIdentity,
  clearStoredDeviceIdentity,
  generateAndStoreDeviceIdentity,
  unlockDeviceIdentity,
  getStoredDeviceCert,
  getUnlockedDeviceIdentity,
  clearUnlockedDeviceIdentity,
  hasLegacyMnemonicStorage,
  clearLegacyMnemonicStorage,
} from '../identity-store.web.js';
import { generateMnemonic, mnemonicToUserIdentity } from '../../tmux-lite/crypto/user-identity.js';
import { generateIdentity } from '../../tmux-lite/crypto/identity.js';
import { verifyDeviceCertificate } from '../../tmux-lite/crypto/device-cert.js';
import type { DeviceCertificate } from '../../../types/identity.js';

const TEST_PIN = 'hunter2';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRootIdentity() {
  return mnemonicToUserIdentity(generateMnemonic());
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('identity-store.web — generateAndStoreDeviceIdentity', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    clearUnlockedDeviceIdentity();
  });

  it('hasStoredDeviceIdentity returns false before any storage', () => {
    expect(hasStoredDeviceIdentity()).toBe(false);
  });

  it('hasStoredDeviceIdentity returns true after storing', async () => {
    const root = makeRootIdentity();
    await generateAndStoreDeviceIdentity(root as ReturnType<typeof generateIdentity>, TEST_PIN);
    expect(hasStoredDeviceIdentity()).toBe(true);
  });

  it('stored device identity can be unlocked with the correct PIN', async () => {
    const root = makeRootIdentity();
    const stored = await generateAndStoreDeviceIdentity(root as ReturnType<typeof generateIdentity>, TEST_PIN);
    clearUnlockedDeviceIdentity();

    const unlocked = await unlockDeviceIdentity(TEST_PIN);
    expect(unlocked.id).toBe(stored.id);
  });

  it('device identity id is stable across multiple unlocks', async () => {
    const root = makeRootIdentity();
    const original = await generateAndStoreDeviceIdentity(root as ReturnType<typeof generateIdentity>, TEST_PIN);
    clearUnlockedDeviceIdentity();

    const unlock1 = await unlockDeviceIdentity(TEST_PIN);
    clearUnlockedDeviceIdentity();
    const unlock2 = await unlockDeviceIdentity(TEST_PIN);

    expect(unlock1.id).toBe(original.id);
    expect(unlock2.id).toBe(original.id);
  });

  it('device identity id differs from root identity id (not self-signed)', async () => {
    const root = makeRootIdentity();
    const device = await generateAndStoreDeviceIdentity(root as ReturnType<typeof generateIdentity>, TEST_PIN);
    expect(device.id).not.toBe(root.id);
  });
});

describe('identity-store.web — wrong PIN rejection', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    clearUnlockedDeviceIdentity();
  });

  it('unlock with wrong PIN throws', async () => {
    const root = makeRootIdentity();
    await generateAndStoreDeviceIdentity(root as ReturnType<typeof generateIdentity>, TEST_PIN);
    clearUnlockedDeviceIdentity();

    await expect(unlockDeviceIdentity('wrongpin')).rejects.toThrow('Invalid PIN');
  });

  it('unlock with empty PIN throws', async () => {
    const root = makeRootIdentity();
    await generateAndStoreDeviceIdentity(root as ReturnType<typeof generateIdentity>, TEST_PIN);
    clearUnlockedDeviceIdentity();

    await expect(unlockDeviceIdentity('')).rejects.toThrow();
  });
});

describe('identity-store.web — device cert storage', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    clearUnlockedDeviceIdentity();
  });

  it('getStoredDeviceCert returns null before storage', () => {
    expect(getStoredDeviceCert()).toBeNull();
  });

  it('getStoredDeviceCert returns a cert string after storage', async () => {
    const root = makeRootIdentity();
    await generateAndStoreDeviceIdentity(root as ReturnType<typeof generateIdentity>, TEST_PIN);
    const cert = getStoredDeviceCert();
    expect(typeof cert).toBe('string');
    expect(cert!.length).toBeGreaterThan(0);
  });

  it('stored cert is valid JSON with expected DeviceCertificate fields', async () => {
    const root = makeRootIdentity();
    await generateAndStoreDeviceIdentity(root as ReturnType<typeof generateIdentity>, TEST_PIN);
    const certJson = getStoredDeviceCert()!;
    const cert = JSON.parse(certJson) as DeviceCertificate;

    expect(typeof cert.deviceSigningPublicKey).toBe('string');
    expect(typeof cert.userRootSigningPublicKey).toBe('string');
    expect(typeof cert.signature).toBe('string');
    expect(typeof cert.issuedAt).toBe('number');
  });

  it('stored cert passes verifyDeviceCertificate', async () => {
    const root = makeRootIdentity();
    await generateAndStoreDeviceIdentity(root as ReturnType<typeof generateIdentity>, TEST_PIN);
    const certJson = getStoredDeviceCert()!;
    const cert = JSON.parse(certJson) as DeviceCertificate;

    expect(verifyDeviceCertificate(cert)).toBe(true);
  });

  it('stored cert has device key != root key (not self-signed)', async () => {
    const root = makeRootIdentity();
    await generateAndStoreDeviceIdentity(root as ReturnType<typeof generateIdentity>, TEST_PIN);
    const certJson = getStoredDeviceCert()!;
    const cert = JSON.parse(certJson) as DeviceCertificate;

    expect(cert.deviceSigningPublicKey).not.toBe(cert.userRootSigningPublicKey);
  });

  it('stored blob does NOT contain the mnemonic', async () => {
    const mnemonic = generateMnemonic();
    const root = mnemonicToUserIdentity(mnemonic);
    await generateAndStoreDeviceIdentity(root as ReturnType<typeof generateIdentity>, TEST_PIN);

    // Check the raw stored string — the full mnemonic must never be persisted.
    const raw = mockLocalStorage.getItem('gssh.browser.device.v1')!;
    expect(raw).not.toContain(mnemonic);
  });
});

describe('identity-store.web — clear and reset', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    clearUnlockedDeviceIdentity();
  });

  it('clearStoredDeviceIdentity removes stored data', async () => {
    const root = makeRootIdentity();
    await generateAndStoreDeviceIdentity(root as ReturnType<typeof generateIdentity>, TEST_PIN);
    expect(hasStoredDeviceIdentity()).toBe(true);

    clearStoredDeviceIdentity();
    expect(hasStoredDeviceIdentity()).toBe(false);
    expect(getStoredDeviceCert()).toBeNull();
  });

  it('getUnlockedDeviceIdentity returns null after clearUnlockedDeviceIdentity', async () => {
    const root = makeRootIdentity();
    await generateAndStoreDeviceIdentity(root as ReturnType<typeof generateIdentity>, TEST_PIN);
    expect(getUnlockedDeviceIdentity()).not.toBeNull();

    clearUnlockedDeviceIdentity();
    expect(getUnlockedDeviceIdentity()).toBeNull();
  });

  it('getUnlockedDeviceIdentity returns the identity after unlock', async () => {
    const root = makeRootIdentity();
    const original = await generateAndStoreDeviceIdentity(root as ReturnType<typeof generateIdentity>, TEST_PIN);
    clearUnlockedDeviceIdentity();

    expect(getUnlockedDeviceIdentity()).toBeNull();
    await unlockDeviceIdentity(TEST_PIN);
    const inMemory = getUnlockedDeviceIdentity();
    expect(inMemory?.id).toBe(original.id);
  });
});

describe('identity-store.web — legacy mnemonic storage detection', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    clearUnlockedDeviceIdentity();
  });

  it('hasLegacyMnemonicStorage returns false with no legacy data', () => {
    expect(hasLegacyMnemonicStorage()).toBe(false);
  });

  it('hasLegacyMnemonicStorage returns true when legacy key is present', () => {
    mockLocalStorage.setItem('gssh.browser.identity.v1', '{"version":1}');
    expect(hasLegacyMnemonicStorage()).toBe(true);
  });

  it('clearLegacyMnemonicStorage removes the legacy key', () => {
    mockLocalStorage.setItem('gssh.browser.identity.v1', '{"version":1}');
    expect(hasLegacyMnemonicStorage()).toBe(true);

    clearLegacyMnemonicStorage();
    expect(hasLegacyMnemonicStorage()).toBe(false);
  });
});
