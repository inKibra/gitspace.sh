/**
 * Optional, account-backed encrypted user-root identity backup.
 *
 * The API stores only ciphertext. Encryption/decryption happens locally.
 */

import { createCipheriv, createDecipheriv, pbkdf2 as pbkdf2Callback, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { getSecret } from '../utils/secrets.js';
import { getPublicKeyWithoutPassword } from './identity.js';
import {
  initFromMnemonic,
  loadUserRootIdentity,
  loadUserRootMnemonic,
  userRootIdentityExists,
} from './user-identity.js';
import { mnemonicToUserIdentity, validateMnemonic } from '../lib/tmux-lite/crypto/user-identity.js';
import type { UserRootIdentity } from '../types/identity.js';
import { SpacesError } from '../types/errors.js';
import { logger } from '../utils/logger.js';

const API_BASE = process.env.GITSPACE_API_URL || 'https://api.gitspace.sh';
const BACKUP_ENDPOINT = `${API_BASE}/identity/backup`;
const BACKUP_STATUS_ENDPOINT = `${API_BASE}/identity/backup/status`;

const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_MAX_ITERATIONS = 1_000_000;
const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_DIGEST = 'sha256';
const AES_ALGORITHM = 'aes-256-gcm';
const AES_IV_BYTES = 12;
const AES_AUTH_TAG_BYTES = 16;

const pbkdf2 = promisify(pbkdf2Callback);

export interface EncryptedMnemonicEnvelope {
  version: 1;
  algorithm: 'PBKDF2-AES-GCM';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  createdAt: number;
  updatedAt: number;
}

export interface CloudIdentityBackupRecord {
  version: 1;
  kind: 'user-root-mnemonic';
  ownerUserRootId: string;
  envelope: EncryptedMnemonicEnvelope;
  createdAt: number;
  updatedAt: number;
}

export interface CloudIdentityBackupStatus {
  enabled: boolean;
  ownerUserRootId?: string;
  createdAt?: number;
  updatedAt?: number;
}

function normalizeMnemonicInput(mnemonic: string): string {
  return mnemonic
    .normalize('NFKD')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function encodeBase64(input: Uint8Array): string {
  return Buffer.from(input).toString('base64');
}

function decodeBase64(input: string): Buffer {
  return Buffer.from(input, 'base64');
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<Buffer> {
  return pbkdf2(passphrase, salt, iterations, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST);
}

function normalizeRecord(value: unknown): CloudIdentityBackupRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as Partial<CloudIdentityBackupRecord>;
  const envelope = raw.envelope as Partial<EncryptedMnemonicEnvelope> | undefined;
  if (
    raw.version !== 1 ||
    raw.kind !== 'user-root-mnemonic' ||
    typeof raw.ownerUserRootId !== 'string' ||
    !envelope ||
    envelope.version !== 1 ||
    envelope.algorithm !== 'PBKDF2-AES-GCM' ||
    typeof envelope.iterations !== 'number' ||
    typeof envelope.salt !== 'string' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.ciphertext !== 'string' ||
    typeof envelope.createdAt !== 'number' ||
    typeof envelope.updatedAt !== 'number' ||
    typeof raw.createdAt !== 'number' ||
    typeof raw.updatedAt !== 'number'
  ) {
    return null;
  }

  return {
    version: 1,
    kind: 'user-root-mnemonic',
    ownerUserRootId: raw.ownerUserRootId,
    envelope: {
      version: 1,
      algorithm: 'PBKDF2-AES-GCM',
      iterations: envelope.iterations,
      salt: envelope.salt,
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt,
    },
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function normalizeStatus(value: unknown): CloudIdentityBackupStatus | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as Partial<CloudIdentityBackupStatus>;
  if (typeof raw.enabled !== 'boolean') {
    return null;
  }

  return {
    enabled: raw.enabled,
    ownerUserRootId: typeof raw.ownerUserRootId === 'string' ? raw.ownerUserRootId : undefined,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined,
  };
}

async function getAuthHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await getSecret('GITSPACE_TOKEN');
  if (!token) {
    throw new SpacesError('Not logged in. Run `gssh user auth login` first.', 'USER_ERROR', 1);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extra,
  };

  const identity = getPublicKeyWithoutPassword();
  if (identity?.signingPublicKey) {
    headers['X-Device-Fingerprint'] = identity.signingPublicKey;
  }

  return headers;
}

function parseApiError(status: number, statusText: string, body: string): string {
  if (!body) {
    return `${status} ${statusText}`;
  }

  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    return parsed.error || parsed.message || `${status} ${statusText}`;
  } catch {
    return body;
  }
}

async function fetchBackupApi(url: string, init: RequestInit, context: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`${context}: ${detail}`);
    throw new SpacesError(`${context}: ${detail}`, 'SERVICE_ERROR', 3);
  }
}

export async function encryptMnemonicEnvelope(
  mnemonic: string,
  passphrase: string,
  now: number = Date.now(),
): Promise<EncryptedMnemonicEnvelope> {
  const normalizedMnemonic = normalizeMnemonicInput(mnemonic);
  if (!validateMnemonic(normalizedMnemonic)) {
    throw new SpacesError('Invalid 24-word recovery phrase.', 'USER_ERROR', 1);
  }
  if (!passphrase.trim()) {
    throw new SpacesError('Backup password is required.', 'USER_ERROR', 1);
  }

  const salt = randomBytes(16);
  const iv = randomBytes(AES_IV_BYTES);
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);

  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(normalizedMnemonic, 'utf-8')),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: 'PBKDF2-AES-GCM',
    iterations: PBKDF2_ITERATIONS,
    salt: encodeBase64(salt),
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(Buffer.concat([ciphertext, authTag])),
    createdAt: now,
    updatedAt: now,
  };
}

export async function decryptMnemonicEnvelope(
  envelope: EncryptedMnemonicEnvelope,
  passphrase: string,
): Promise<string> {
  if (!passphrase.trim()) {
    throw new SpacesError('Backup password is required.', 'USER_ERROR', 1);
  }

  if (
    !Number.isSafeInteger(envelope.iterations)
    || envelope.iterations < PBKDF2_ITERATIONS
    || envelope.iterations > PBKDF2_MAX_ITERATIONS
  ) {
    throw new SpacesError('Cloud backup payload uses unsupported key derivation parameters.', 'USER_ERROR', 1);
  }

  const salt = decodeBase64(envelope.salt);
  const iv = decodeBase64(envelope.iv);
  const packedCiphertext = decodeBase64(envelope.ciphertext);
  if (packedCiphertext.byteLength <= AES_AUTH_TAG_BYTES) {
    throw new SpacesError('Cloud backup payload is corrupted.', 'USER_ERROR', 1);
  }

  const ciphertext = packedCiphertext.subarray(0, packedCiphertext.byteLength - AES_AUTH_TAG_BYTES);
  const authTag = packedCiphertext.subarray(packedCiphertext.byteLength - AES_AUTH_TAG_BYTES);
  const key = await deriveKey(passphrase, salt, envelope.iterations);

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SpacesError('Invalid backup password.', 'USER_ERROR', 1);
  }

  const mnemonic = normalizeMnemonicInput(plaintext.toString('utf-8'));
  if (!validateMnemonic(mnemonic)) {
    throw new SpacesError('Decrypted backup mnemonic is invalid.', 'USER_ERROR', 1);
  }

  return mnemonic;
}

export async function getCloudIdentityBackup(): Promise<CloudIdentityBackupRecord | null> {
  const headers = await getAuthHeaders();
  const response = await fetchBackupApi(BACKUP_ENDPOINT, { method: 'GET', headers }, 'Failed to fetch identity backup');

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new SpacesError(
      `Failed to fetch identity backup: ${parseApiError(response.status, response.statusText, body)}`,
      'SYSTEM_ERROR',
      2,
    );
  }

  const payload = await response.json().catch(() => null);
  const record = normalizeRecord(payload)
    ?? normalizeRecord((payload as { backup?: unknown } | null)?.backup ?? null)
    ?? normalizeRecord((payload as { data?: unknown } | null)?.data ?? null);

  if (!record) {
    throw new SpacesError('Identity backup response is malformed.', 'SYSTEM_ERROR', 2);
  }

  return record;
}

export async function putCloudIdentityBackup(record: CloudIdentityBackupRecord): Promise<void> {
  const headers = await getAuthHeaders();
  const response = await fetchBackupApi(BACKUP_ENDPOINT, {
    method: 'PUT',
    headers,
    body: JSON.stringify(record),
  }, 'Failed to save identity backup');

  if (!response.ok) {
    const body = await response.text();
    throw new SpacesError(
      `Failed to save identity backup: ${parseApiError(response.status, response.statusText, body)}`,
      'SYSTEM_ERROR',
      2,
    );
  }
}

export async function deleteCloudIdentityBackup(): Promise<boolean> {
  const headers = await getAuthHeaders();
  const response = await fetchBackupApi(BACKUP_ENDPOINT, { method: 'DELETE', headers }, 'Failed to delete identity backup');

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new SpacesError(
      `Failed to delete identity backup: ${parseApiError(response.status, response.statusText, body)}`,
      'SYSTEM_ERROR',
      2,
    );
  }

  return true;
}

export async function getCloudIdentityBackupStatus(): Promise<CloudIdentityBackupStatus> {
  const headers = await getAuthHeaders();
  const response = await fetchBackupApi(BACKUP_STATUS_ENDPOINT, { method: 'GET', headers }, 'Failed to fetch backup status');

  if (response.status === 404) {
    const backup = await getCloudIdentityBackup();
    if (!backup) {
      return { enabled: false };
    }
    return {
      enabled: true,
      ownerUserRootId: backup.ownerUserRootId,
      createdAt: backup.createdAt,
      updatedAt: backup.updatedAt,
    };
  }

  if (!response.ok) {
    const body = await response.text();
    throw new SpacesError(
      `Failed to fetch backup status: ${parseApiError(response.status, response.statusText, body)}`,
      'SYSTEM_ERROR',
      2,
    );
  }

  const payload = await response.json().catch(() => null);
  const status = normalizeStatus(payload)
    ?? normalizeStatus((payload as { status?: unknown } | null)?.status ?? null)
    ?? normalizeStatus((payload as { data?: unknown } | null)?.data ?? null);
  if (!status) {
    throw new SpacesError('Identity backup status response is malformed.', 'SYSTEM_ERROR', 2);
  }
  return status;
}

export async function backupCurrentUserRootToCloud(passphrase: string): Promise<CloudIdentityBackupRecord> {
  const userRoot = await loadUserRootIdentity();
  if (!userRoot) {
    throw new SpacesError(
      'No user root identity found. Run `gssh user identity init` first.',
      'USER_ERROR',
      1,
    );
  }

  const mnemonic = await loadUserRootMnemonic();
  if (!mnemonic) {
    throw new SpacesError('Stored user root mnemonic could not be loaded.', 'SYSTEM_ERROR', 2);
  }

  const now = Date.now();
  const envelope = await encryptMnemonicEnvelope(mnemonic, passphrase, now);
  const record: CloudIdentityBackupRecord = {
    version: 1,
    kind: 'user-root-mnemonic',
    ownerUserRootId: userRoot.id,
    envelope,
    createdAt: now,
    updatedAt: now,
  };

  await putCloudIdentityBackup(record);
  return record;
}

export async function recoverUserRootFromCloudBackup(
  passphrase: string,
  options: { force?: boolean } = {},
): Promise<UserRootIdentity> {
  const backup = await getCloudIdentityBackup();
  if (!backup) {
    throw new SpacesError('No cloud identity backup found for this account.', 'USER_ERROR', 1);
  }

  const mnemonic = await decryptMnemonicEnvelope(backup.envelope, passphrase);
  const derived = mnemonicToUserIdentity(mnemonic);
  if (backup.ownerUserRootId && backup.ownerUserRootId !== derived.id) {
    throw new SpacesError(
      'Cloud backup ownership mismatch. The decrypted mnemonic does not match backup metadata.',
      'SYSTEM_ERROR',
      2,
    );
  }

  const exists = await userRootIdentityExists();
  // Default recovery behavior overwrites an existing local identity unless the
  // caller explicitly passes force: false.
  const force = options.force ?? exists;
  return initFromMnemonic(mnemonic, force);
}
