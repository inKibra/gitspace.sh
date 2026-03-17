import { deriveKey, generateSalt } from '../lib/tmux-lite/crypto/keys.js';
import { open, seal } from '../lib/tmux-lite/crypto/secretbox.js';
import {
  getLocalStoreMeta,
  getLocalStoreRecord,
  getLocalStoreSecret,
  removeLocalStoreRecord,
  setLocalStoreMeta,
  upsertLocalStoreRecord,
  upsertLocalStoreSecret,
} from '../relay/control/store.js';
import { InvalidPasswordError, SpacesError } from '../types/errors.js';

const META_KEY_PASSWORD_SALT = 'store_password_salt';
const META_KEY_PASSWORD_KEY_CHECK = 'store_password_key_check';
const META_KEY_LEGACY_STORAGE_MIGRATED_AT = 'legacy_storage_migrated_at';
const META_KEY_LEGACY_STORAGE_RETAINED = 'legacy_storage_retained';
const PASSWORD_CHECK_PLAINTEXT = 'gitspace-local-secure-store-v1';

let unlockedStoreKey: Buffer | null = null;

function parseJsonRecord<T>(valueJson: string, context: string): T {
  try {
    return JSON.parse(valueJson) as T;
  } catch (error) {
    throw new SpacesError(
      `Failed to parse ${context}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2,
    );
  }
}

function requireUnlockedStoreKey(): Buffer {
  if (!unlockedStoreKey) {
    throw new SpacesError(
      'Local secure store is locked. Unlock it before accessing encrypted records.',
      'USER_ERROR',
      1,
    );
  }

  return unlockedStoreKey;
}

function hasStorePasswordMetadata(): boolean {
  return Boolean(getLocalStoreMeta(META_KEY_PASSWORD_SALT) && getLocalStoreMeta(META_KEY_PASSWORD_KEY_CHECK));
}

export function localSecureStoreExists(): boolean {
  return hasStorePasswordMetadata();
}

export function isLocalSecureStoreUnlocked(): boolean {
  return unlockedStoreKey !== null;
}

export function lockLocalSecureStore(): void {
  if (unlockedStoreKey) {
    unlockedStoreKey.fill(0);
    unlockedStoreKey = null;
  }
}

export async function unlockLocalSecureStore(password: string): Promise<void> {
  const saltBase64 = getLocalStoreMeta(META_KEY_PASSWORD_SALT);
  const keyCheckBase64 = getLocalStoreMeta(META_KEY_PASSWORD_KEY_CHECK);

  if (!saltBase64 || !keyCheckBase64) {
    const salt = generateSalt();
    const key = await deriveKey(password, salt);
    const keyCheck = seal(Buffer.from(PASSWORD_CHECK_PLAINTEXT, 'utf-8'), key);

    setLocalStoreMeta(META_KEY_PASSWORD_SALT, salt.toString('base64'));
    setLocalStoreMeta(META_KEY_PASSWORD_KEY_CHECK, keyCheck.toString('base64'));
    unlockedStoreKey = Buffer.from(key);
    return;
  }

  const key = await deriveKey(password, Buffer.from(saltBase64, 'base64'));
  const plaintext = open(Buffer.from(keyCheckBase64, 'base64'), key);
  if (!plaintext || plaintext.toString('utf-8') !== PASSWORD_CHECK_PLAINTEXT) {
    throw new InvalidPasswordError();
  }

  unlockedStoreKey = Buffer.from(key);
}

export function readLocalStoreJson<T>(namespace: string, key: string): T | undefined {
  const record = getLocalStoreRecord(namespace, key);
  if (!record) {
    return undefined;
  }

  return parseJsonRecord<T>(record.valueJson, `${namespace}/${key}`);
}

export function writeLocalStoreJson(namespace: string, key: string, value: unknown): void {
  upsertLocalStoreRecord(namespace, key, JSON.stringify(value));
}

export function deleteLocalStoreJson(namespace: string, key: string): boolean {
  return removeLocalStoreRecord(namespace, key);
}

export function readLocalStoreSecretJson<T>(namespace: string, key: string): T | undefined {
  const record = getLocalStoreSecret(namespace, key);
  if (!record) {
    return undefined;
  }

  const plaintext = open(Buffer.from(record.ciphertext, 'base64'), requireUnlockedStoreKey());
  if (!plaintext) {
    throw new InvalidPasswordError();
  }

  return parseJsonRecord<T>(plaintext.toString('utf-8'), `${namespace}/${key}`);
}

export function writeLocalStoreSecretJson(namespace: string, key: string, value: unknown): void {
  const ciphertext = seal(
    Buffer.from(JSON.stringify(value), 'utf-8'),
    requireUnlockedStoreKey(),
  ).toString('base64');
  upsertLocalStoreSecret(namespace, key, ciphertext);
}

export function markLegacyLocalStorageMigrated(retained: boolean = true): void {
  setLocalStoreMeta(META_KEY_LEGACY_STORAGE_MIGRATED_AT, new Date().toISOString());
  setLocalStoreMeta(META_KEY_LEGACY_STORAGE_RETAINED, retained ? '1' : '0');
}
