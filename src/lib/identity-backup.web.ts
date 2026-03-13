/**
 * Browser-side cloud identity backup recovery.
 *
 * Fetches the encrypted identity backup from api.gitspace.sh and decrypts it
 * using Web Crypto API (PBKDF2 + AES-256-GCM), matching the server-side
 * encryption in core/identity-backup.ts.
 */

const API_BASE = 'https://api.gitspace.sh';

export interface CloudBackupEnvelope {
  version: 1;
  algorithm: 'PBKDF2-AES-GCM';
  iterations: number;
  salt: string;       // base64
  iv: string;         // base64
  ciphertext: string; // base64
  createdAt: number;
  updatedAt: number;
}

export interface CloudBackup {
  version: number;
  kind: string;
  ownerUserRootId: string;
  envelope: CloudBackupEnvelope;
  createdAt: number;
  updatedAt: number;
}

export interface BackupStatus {
  enabled: boolean;
  ownerUserRootId?: string;
  createdAt?: number;
  updatedAt?: number;
}

function base64ToBytes(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Check if a cloud backup exists for the authenticated user.
 */
export async function fetchBackupStatus(token: string): Promise<BackupStatus> {
  const res = await fetch(`${API_BASE}/identity/backup/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to check backup status: ${res.status}`);
  }

  return res.json() as Promise<BackupStatus>;
}

/**
 * Fetch the encrypted identity backup from the cloud.
 */
export async function fetchCloudBackup(token: string): Promise<CloudBackup | null> {
  const res = await fetch(`${API_BASE}/identity/backup`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch backup: ${res.status}`);
  }

  return res.json() as Promise<CloudBackup>;
}

/**
 * Decrypt a cloud backup envelope with the user's backup password.
 * Returns the plaintext mnemonic string.
 *
 * Uses the same PBKDF2-AES-GCM scheme as the server-side encryption:
 * - PBKDF2 with SHA-256 to derive AES key from password + salt
 * - AES-256-GCM to decrypt the mnemonic
 */
export async function decryptBackupEnvelope(
  envelope: CloudBackupEnvelope,
  password: string,
): Promise<string> {
  if (envelope.algorithm !== 'PBKDF2-AES-GCM') {
    throw new Error(`Unsupported backup algorithm: ${envelope.algorithm}`);
  }

  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);

  // Derive AES key from password using PBKDF2
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations: envelope.iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );

  // Decrypt
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      aesKey,
      toArrayBuffer(ciphertext),
    );
  } catch (err) {
    console.debug('[identity-backup] Decryption failed:', err);
    throw new Error('Invalid backup password.');
  }

  return new TextDecoder().decode(plaintext);
}
