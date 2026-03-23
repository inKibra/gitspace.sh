/**
 * Browser device identity storage.
 *
 * Stores a random device keypair (PIN-encrypted) and a root-signed device
 * certificate (plaintext — it's public, not secret). The owner's mnemonic
 * is only used transiently during first-time setup to sign the device cert;
 * it is never stored.
 *
 * Flow:
 *   First time:
 *     mnemonic → root identity → generate random device identity →
 *     root signs device cert → encrypt device keys with PIN → store
 *
 *   Subsequent unlock:
 *     PIN → decrypt device keys → load device cert → ready
 */

import type { Identity, StoredIdentity } from '../../types/identity.js';
import {
  generateIdentity,
  serializeIdentity,
  deserializeIdentity,
  createRootSignedDeviceCertificate,
} from '../../session/crypto/identity.web.js';
import {
  base64ToBytes,
  bytesToBase64,
  toArrayBuffer,
  deriveAesKey,
} from '../browser-crypto.js';

const STORAGE_KEY = 'gssh.browser.device.v1';
const PBKDF2_ITERATIONS = 210_000;

interface DeviceIdentityBlob {
  version: 1;
  algorithm: 'PBKDF2-AES-GCM';
  iterations: number;
  salt: string;
  iv: string;
  /** Encrypted JSON of StoredIdentity (device keypair) */
  ciphertext: string;
  /** Plaintext root-signed device certificate JSON (not secret) */
  deviceCert: string;
  createdAt: number;
  updatedAt: number;
}

let unlockedDeviceIdentity: Identity | null = null;

function getCryptoApi(): Crypto {
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    throw new Error('Secure browser crypto APIs are unavailable.');
  }
  return window.crypto;
}

function readBlob(): DeviceIdentityBlob | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<DeviceIdentityBlob>;
    if (
      parsed.version !== 1 ||
      parsed.algorithm !== 'PBKDF2-AES-GCM' ||
      typeof parsed.iterations !== 'number' ||
      typeof parsed.salt !== 'string' ||
      typeof parsed.iv !== 'string' ||
      typeof parsed.ciphertext !== 'string' ||
      typeof parsed.deviceCert !== 'string' ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null;
    }
    return parsed as DeviceIdentityBlob;
  } catch {
    return null;
  }
}

function writeBlob(blob: DeviceIdentityBlob): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
}

export function hasStoredDeviceIdentity(): boolean {
  return readBlob() !== null;
}

export function clearStoredDeviceIdentity(): void {
  localStorage.removeItem(STORAGE_KEY);
  unlockedDeviceIdentity = null;
}

/** Clear in-memory unlocked state without touching localStorage */
export function clearUnlockedDeviceIdentity(): void {
  unlockedDeviceIdentity = null;
}

/**
 * Generate a new random device identity, sign a device cert with the given
 * root identity, then encrypt and store the device keypair with a PIN.
 *
 * @param rootIdentity - The user's root identity (from mnemonic). Used only
 *   to sign the device cert; it is NOT persisted.
 * @param pin - PIN to encrypt the device private key at rest.
 * @returns The new device identity (in memory for current session).
 */
export async function generateAndStoreDeviceIdentity(
  rootIdentity: Identity,
  pin: string,
): Promise<Identity> {
  if (!pin.trim()) {
    throw new Error('PIN is required.');
  }

  const deviceIdentity = generateIdentity('Browser Device');
  const deviceCert = createRootSignedDeviceCertificate(rootIdentity, deviceIdentity);

  await encryptAndStore(deviceIdentity, deviceCert, pin);
  unlockedDeviceIdentity = deviceIdentity;
  return deviceIdentity;
}

/**
 * Unlock the stored device identity using the PIN.
 *
 * @param pin - The PIN used when the device identity was stored.
 * @returns The device identity.
 */
export async function unlockDeviceIdentity(pin: string): Promise<Identity> {
  if (unlockedDeviceIdentity) {
    return unlockedDeviceIdentity;
  }
  if (!pin.trim()) {
    throw new Error('PIN is required.');
  }

  const blob = readBlob();
  if (!blob) {
    throw new Error('No stored browser device identity found.');
  }

  const cryptoApi = getCryptoApi();
  const salt = base64ToBytes(blob.salt);
  const iv = base64ToBytes(blob.iv);
  const ciphertext = base64ToBytes(blob.ciphertext);
  const key = await deriveAesKey(pin, salt, blob.iterations);

  let plaintextBuffer: ArrayBuffer;
  try {
    plaintextBuffer = await cryptoApi.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext),
    );
  } catch {
    throw new Error('Invalid PIN.');
  }

  const stored = JSON.parse(new TextDecoder().decode(plaintextBuffer)) as StoredIdentity;
  const identity = deserializeIdentity(stored);
  unlockedDeviceIdentity = identity;
  return identity;
}

/**
 * Get the device certificate (plaintext, not sensitive).
 * Returns null if no device identity is stored.
 */
export function getStoredDeviceCert(): string | null {
  const blob = readBlob();
  return blob?.deviceCert ?? null;
}

/**
 * Get the currently unlocked device identity (if unlocked this session).
 * Returns null if PIN unlock has not been performed yet.
 */
export function getUnlockedDeviceIdentity(): Identity | null {
  return unlockedDeviceIdentity;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function encryptAndStore(
  deviceIdentity: Identity,
  deviceCert: string,
  pin: string,
): Promise<void> {
  const cryptoApi = getCryptoApi();
  const salt = cryptoApi.getRandomValues(new Uint8Array(16));
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveAesKey(pin, salt, PBKDF2_ITERATIONS);

  const stored = serializeIdentity(deviceIdentity);
  const plaintext = new TextEncoder().encode(JSON.stringify(stored));

  const ciphertextBuffer = await cryptoApi.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    aesKey,
    plaintext,
  );

  const now = Date.now();
  const existing = readBlob();

  writeBlob({
    version: 1,
    algorithm: 'PBKDF2-AES-GCM',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuffer)),
    deviceCert,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

// ─── Legacy compat: old storage key used encrypted mnemonic ─────────────────

const LEGACY_STORAGE_KEY = 'gssh.browser.identity.v1';

/** Returns true if old mnemonic-based storage exists (for migration prompt). */
export function hasLegacyMnemonicStorage(): boolean {
  return localStorage.getItem(LEGACY_STORAGE_KEY) !== null;
}

/** Remove the legacy mnemonic storage blob. */
export function clearLegacyMnemonicStorage(): void {
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

// ─── Retained for IdentityGate compat: mnemonic unlock path ─────────────────
// The IdentityGate still needs to decrypt old-format mnemonic storage
// during the one-time migration to the new device keypair model.

import {
  isValidMnemonic,
  normalizeMnemonic,
  deriveIdentityFromMnemonic,
} from '../../session/crypto/identity.web.js';

interface LegacyEncryptedMnemonicBlob {
  version: 1;
  algorithm: 'PBKDF2-AES-GCM';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  createdAt: number;
  updatedAt: number;
}

/** Decrypt the legacy mnemonic blob with its PIN. Returns the mnemonic string. */
export async function decryptLegacyMnemonic(pin: string): Promise<string> {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) throw new Error('No legacy mnemonic storage found.');

  const blob = JSON.parse(raw) as LegacyEncryptedMnemonicBlob;
  const cryptoApi = getCryptoApi();
  const salt = base64ToBytes(blob.salt);
  const iv = base64ToBytes(blob.iv);
  const ciphertext = base64ToBytes(blob.ciphertext);
  const key = await deriveAesKey(pin, salt, blob.iterations);

  let plaintextBuffer: ArrayBuffer;
  try {
    plaintextBuffer = await cryptoApi.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext),
    );
  } catch {
    throw new Error('Invalid PIN.');
  }

  const mnemonic = normalizeMnemonic(new TextDecoder().decode(plaintextBuffer));
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Stored browser identity is corrupted.');
  }
  return mnemonic;
}

/**
 * Derive and return root identity from mnemonic (never stored).
 * Used transiently during setup to sign a device cert.
 */
export function deriveRootIdentityFromMnemonic(mnemonic: string): Identity {
  return deriveIdentityFromMnemonic(mnemonic, 'Browser Root');
}
