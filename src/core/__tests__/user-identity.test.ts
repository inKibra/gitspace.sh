/**
 * Tests for core/user-identity.ts — keychain-backed mnemonic identity management
 *
 * Mocks Bun.secrets via the secrets module to avoid hitting the real keychain.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// ============================================================================
// Mock the secrets module
// ============================================================================

/** In-memory keychain store */
let keychainStore: Record<string, string> = {};

const mockGetSecret = mock(async (key: string): Promise<string | null> => {
  return keychainStore[key] ?? null;
});

const mockSetSecret = mock(async (key: string, value: string): Promise<void> => {
  keychainStore[key] = value;
});

const mockDeleteSecret = mock(async (key: string): Promise<boolean> => {
  if (key in keychainStore) {
    delete keychainStore[key];
    return true;
  }
  return false;
});

mock.module('../../utils/secrets.js', () => ({
  getSecret: mockGetSecret,
  setSecret: mockSetSecret,
  deleteSecret: mockDeleteSecret,
}));

// Import AFTER mocking
const {
  generateNewMnemonic,
  initFromMnemonic,
  loadUserRootIdentity,
  userRootIdentityExists,
  getUserRootPublicInfo,
  removeUserRootIdentity,
  verifyMnemonicMatchesStored,
  formatFingerprint,
} = await import('../user-identity.js');

const { validateMnemonic, mnemonicToUserIdentity, formatUserRootPublicKey } = await import(
  '../../lib/tmux-lite/crypto/user-identity.js'
);

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
  keychainStore = {};
  mockGetSecret.mockClear();
  mockSetSecret.mockClear();
  mockDeleteSecret.mockClear();
});

afterEach(() => {
  keychainStore = {};
});

// ============================================================================
// generateNewMnemonic
// ============================================================================

describe('generateNewMnemonic', () => {
  test('produces valid 24-word mnemonic', () => {
    const mnemonic = generateNewMnemonic();
    expect(mnemonic.split(' ').length).toBe(24);
    expect(validateMnemonic(mnemonic)).toBe(true);
  });

  test('produces different mnemonics each call', () => {
    const m1 = generateNewMnemonic();
    const m2 = generateNewMnemonic();
    expect(m1).not.toBe(m2);
  });
});

// ============================================================================
// initFromMnemonic
// ============================================================================

describe('initFromMnemonic', () => {
  test('stores mnemonic payload in keychain', async () => {
    const mnemonic = generateNewMnemonic();
    const identity = await initFromMnemonic(mnemonic);

    expect(identity.id).toBeTruthy();
    expect(identity.id.length).toBe(16);
    expect(identity.signing.publicKey.length).toBe(32);
    expect(identity.signing.secretKey.length).toBe(64);
    expect(identity.keyExchange.publicKey.length).toBe(32);
    expect(identity.keyExchange.privateKey.length).toBe(32);

    // Verify setSecret was called
    expect(mockSetSecret).toHaveBeenCalledTimes(1);
    const [key, value] = mockSetSecret.mock.calls[0] as [string, string];
    expect(key).toBe('USER_ROOT_IDENTITY');
    expect(typeof value).toBe('string');

    // Verify stored blob is valid JSON
    const stored = JSON.parse(value);
    expect(stored.version).toBe(2);
    expect(typeof stored.mnemonic).toBe('string');
    expect(stored.mnemonic.split(' ').length).toBe(24);
    expect(stored.createdAt).toBe(identity.createdAt);
  });

  test('throws if identity exists and force is false', async () => {
    const mnemonic = generateNewMnemonic();
    await initFromMnemonic(mnemonic);

    const mnemonic2 = generateNewMnemonic();
    await expect(initFromMnemonic(mnemonic2, false)).rejects.toThrow(
      'User root identity already exists',
    );
  });

  test('overwrites if force is true', async () => {
    const m1 = generateNewMnemonic();
    const id1 = await initFromMnemonic(m1);

    const m2 = generateNewMnemonic();
    const id2 = await initFromMnemonic(m2, true);

    expect(id1.id).not.toBe(id2.id);

    // Stored identity should be id2
    const loaded = await loadUserRootIdentity();
    expect(loaded?.id).toBe(id2.id);
  });

  test('throws on invalid mnemonic', async () => {
    await expect(initFromMnemonic('invalid words here')).rejects.toThrow(
      'Invalid BIP39 mnemonic',
    );
  });

  test('deterministic: same mnemonic produces same identity', async () => {
    const mnemonic = generateNewMnemonic();
    const id1 = await initFromMnemonic(mnemonic);

    // Clear keychain to allow re-init
    keychainStore = {};
    const id2 = await initFromMnemonic(mnemonic);

    expect(id1.id).toBe(id2.id);
    expect(Buffer.from(id1.signing.publicKey).toString('hex')).toBe(
      Buffer.from(id2.signing.publicKey).toString('hex'),
    );
  });
});

// ============================================================================
// loadUserRootIdentity
// ============================================================================

describe('loadUserRootIdentity', () => {
  test('returns null when no identity stored', async () => {
    const result = await loadUserRootIdentity();
    expect(result).toBeNull();
  });

  test('returns full identity with secret keys', async () => {
    const mnemonic = generateNewMnemonic();
    const original = await initFromMnemonic(mnemonic);

    const loaded = await loadUserRootIdentity();
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(original.id);
    expect(Buffer.from(loaded!.signing.publicKey).toString('hex')).toBe(
      Buffer.from(original.signing.publicKey).toString('hex'),
    );
    expect(Buffer.from(loaded!.signing.secretKey).toString('hex')).toBe(
      Buffer.from(original.signing.secretKey).toString('hex'),
    );
    expect(Buffer.from(loaded!.keyExchange.publicKey).toString('hex')).toBe(
      Buffer.from(original.keyExchange.publicKey).toString('hex'),
    );
    expect(Buffer.from(loaded!.keyExchange.privateKey).toString('hex')).toBe(
      Buffer.from(original.keyExchange.privateKey).toString('hex'),
    );
  });

  test('loaded identity can sign and verify', async () => {
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const mnemonic = generateNewMnemonic();
    await initFromMnemonic(mnemonic);

    const loaded = await loadUserRootIdentity();
    const message = new TextEncoder().encode('test message');
    const privateKey = loaded!.signing.secretKey.slice(0, 32);
    const signature = ed25519.sign(message, privateKey);

    expect(ed25519.verify(signature, message, loaded!.signing.publicKey)).toBe(true);
  });

  test('rejects legacy v1 identity payload', async () => {
    keychainStore.USER_ROOT_IDENTITY = JSON.stringify({
      version: 1,
      id: 'legacy-id',
      signingPublicKey: 'legacy',
      signingSecretKey: 'legacy',
      keyExchangePublicKey: 'legacy',
      keyExchangePrivateKey: 'legacy',
      createdAt: Date.now(),
    });

    await expect(loadUserRootIdentity()).rejects.toThrow('Legacy identity format detected');
  });
});

// ============================================================================
// userRootIdentityExists
// ============================================================================

describe('userRootIdentityExists', () => {
  test('returns false when no identity', async () => {
    expect(await userRootIdentityExists()).toBe(false);
  });

  test('returns true when identity exists', async () => {
    await initFromMnemonic(generateNewMnemonic());
    expect(await userRootIdentityExists()).toBe(true);
  });
});

// ============================================================================
// getUserRootPublicInfo
// ============================================================================

describe('getUserRootPublicInfo', () => {
  test('returns null when no identity', async () => {
    expect(await getUserRootPublicInfo()).toBeNull();
  });

  test('returns public info with all fields', async () => {
    const mnemonic = generateNewMnemonic();
    const identity = await initFromMnemonic(mnemonic);

    const info = await getUserRootPublicInfo();
    expect(info).not.toBeNull();
    expect(info!.id).toBe(identity.id);
    expect(info!.publicKeyString).toMatch(/^gssh-user:/);
    expect(info!.fingerprint).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){7}$/);
    expect(typeof info!.createdAt).toBe('number');
  });

  test('public key string roundtrips', async () => {
    const mnemonic = generateNewMnemonic();
    const identity = await initFromMnemonic(mnemonic);

    const info = await getUserRootPublicInfo();
    const expectedKeyString = formatUserRootPublicKey(identity);
    expect(info!.publicKeyString).toBe(expectedKeyString);
  });
});

// ============================================================================
// removeUserRootIdentity
// ============================================================================

describe('removeUserRootIdentity', () => {
  test('returns false when no identity', async () => {
    expect(await removeUserRootIdentity()).toBe(false);
  });

  test('removes identity from keychain', async () => {
    await initFromMnemonic(generateNewMnemonic());
    expect(await userRootIdentityExists()).toBe(true);

    const deleted = await removeUserRootIdentity();
    expect(deleted).toBe(true);
    expect(await userRootIdentityExists()).toBe(false);
    expect(await loadUserRootIdentity()).toBeNull();
  });
});

// ============================================================================
// verifyMnemonicMatchesStored
// ============================================================================

describe('verifyMnemonicMatchesStored', () => {
  test('returns false when no identity stored', async () => {
    const mnemonic = generateNewMnemonic();
    expect(await verifyMnemonicMatchesStored(mnemonic)).toBe(false);
  });

  test('returns true for matching mnemonic', async () => {
    const mnemonic = generateNewMnemonic();
    await initFromMnemonic(mnemonic);
    expect(await verifyMnemonicMatchesStored(mnemonic)).toBe(true);
  });

  test('returns false for non-matching mnemonic', async () => {
    const m1 = generateNewMnemonic();
    const m2 = generateNewMnemonic();
    await initFromMnemonic(m1);
    expect(await verifyMnemonicMatchesStored(m2)).toBe(false);
  });

  test('returns false for invalid mnemonic', async () => {
    await initFromMnemonic(generateNewMnemonic());
    expect(await verifyMnemonicMatchesStored('not a valid mnemonic')).toBe(false);
  });
});

// ============================================================================
// formatFingerprint
// ============================================================================

describe('formatFingerprint', () => {
  test('produces colon-separated hex pairs', () => {
    const key = new Uint8Array(32);
    key.fill(0x42);
    const fp = formatFingerprint(key);

    // 8 hex pairs separated by colons
    expect(fp).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){7}$/);
  });

  test('deterministic for same key', () => {
    const key = new Uint8Array(32);
    key.fill(0xab);
    expect(formatFingerprint(key)).toBe(formatFingerprint(key));
  });

  test('different keys produce different fingerprints', () => {
    const key1 = new Uint8Array(32);
    key1.fill(0x01);
    const key2 = new Uint8Array(32);
    key2.fill(0x02);
    expect(formatFingerprint(key1)).not.toBe(formatFingerprint(key2));
  });
});

// ============================================================================
// Full roundtrip
// ============================================================================

describe('full roundtrip', () => {
  test('init → load → verify → remove → recover', async () => {
    // 1. Init
    const mnemonic = generateNewMnemonic();
    const original = await initFromMnemonic(mnemonic);

    // 2. Load
    const loaded = await loadUserRootIdentity();
    expect(loaded!.id).toBe(original.id);

    // 3. Verify mnemonic matches
    expect(await verifyMnemonicMatchesStored(mnemonic)).toBe(true);

    // 4. Remove
    await removeUserRootIdentity();
    expect(await userRootIdentityExists()).toBe(false);

    // 5. Recover with same mnemonic
    const recovered = await initFromMnemonic(mnemonic);
    expect(recovered.id).toBe(original.id);
    expect(Buffer.from(recovered.signing.publicKey).toString('hex')).toBe(
      Buffer.from(original.signing.publicKey).toString('hex'),
    );
  });
});
