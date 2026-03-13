/**
 * Browser identity storage backed by encrypted mnemonic in localStorage.
 *
 * The mnemonic is encrypted at rest with a user-provided unlock passphrase
 * (PIN/password). Plaintext mnemonic is kept only in memory for the current
 * tab session after unlock.
 */

import type { Identity } from '../../types/identity.js';
import {
  deriveIdentityFromMnemonic,
  isValidMnemonic,
  normalizeMnemonic,
} from '../../session/crypto/identity.web.js';
import {
  base64ToBytes,
  bytesToBase64,
  toArrayBuffer,
  deriveAesKey,
} from '../browser-crypto.js';

const STORAGE_KEY = 'gssh.browser.identity.v1';
const PBKDF2_ITERATIONS = 210_000;

interface EncryptedMnemonicBlob {
  version: 1;
  algorithm: 'PBKDF2-AES-GCM';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  createdAt: number;
  updatedAt: number;
}

let unlockedMnemonic: string | null = null;

function getCryptoApi(): Crypto {
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    throw new Error('Secure browser crypto APIs are unavailable.');
  }
  return window.crypto;
}

function readBlob(): EncryptedMnemonicBlob | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<EncryptedMnemonicBlob>;
    if (
      parsed.version !== 1 ||
      parsed.algorithm !== 'PBKDF2-AES-GCM' ||
      typeof parsed.iterations !== 'number' ||
      typeof parsed.salt !== 'string' ||
      typeof parsed.iv !== 'string' ||
      typeof parsed.ciphertext !== 'string' ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null;
    }
    return parsed as EncryptedMnemonicBlob;
  } catch {
    return null;
  }
}

function writeBlob(blob: EncryptedMnemonicBlob): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
}

export function hasStoredMnemonic(): boolean {
  return readBlob() !== null;
}

export function clearStoredMnemonic(): void {
  localStorage.removeItem(STORAGE_KEY);
  unlockedMnemonic = null;
}

export function getUnlockedMnemonic(): string | null {
  return unlockedMnemonic;
}

export function clearUnlockedMnemonic(): void {
  unlockedMnemonic = null;
}

export async function storeMnemonic(mnemonic: string, passphrase: string): Promise<void> {
  const normalizedMnemonic = normalizeMnemonic(mnemonic);
  if (!isValidMnemonic(normalizedMnemonic)) {
    throw new Error('Invalid 24-word recovery phrase.');
  }
  if (!passphrase.trim()) {
    throw new Error('Unlock PIN/password is required.');
  }

  const cryptoApi = getCryptoApi();
  const salt = cryptoApi.getRandomValues(new Uint8Array(16));
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);

  const ciphertextBuffer = await cryptoApi.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    new TextEncoder().encode(normalizedMnemonic),
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
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  unlockedMnemonic = normalizedMnemonic;
}

export async function unlockMnemonic(passphrase: string): Promise<string> {
  if (unlockedMnemonic) {
    return unlockedMnemonic;
  }
  if (!passphrase.trim()) {
    throw new Error('Unlock PIN/password is required.');
  }

  const blob = readBlob();
  if (!blob) {
    throw new Error('No stored browser identity found.');
  }

  const cryptoApi = getCryptoApi();
  const salt = base64ToBytes(blob.salt);
  const iv = base64ToBytes(blob.iv);
  const ciphertext = base64ToBytes(blob.ciphertext);
  const key = await deriveAesKey(passphrase, salt, blob.iterations);

  let plaintextBuffer: ArrayBuffer;
  try {
    plaintextBuffer = await cryptoApi.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext),
    );
  } catch {
    throw new Error('Invalid unlock PIN/password.');
  }

  const mnemonic = normalizeMnemonic(new TextDecoder().decode(plaintextBuffer));
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Stored browser identity is corrupted.');
  }

  unlockedMnemonic = mnemonic;
  return mnemonic;
}

/**
 * Derive owner identity for current tab session.
 */
export function getUnlockedIdentity(label?: string): Identity | null {
  if (!unlockedMnemonic) {
    return null;
  }
  return deriveIdentityFromMnemonic(unlockedMnemonic, label);
}
