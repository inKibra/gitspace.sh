/**
 * User root identity management — keychain-backed mnemonic storage
 *
 * The user root identity is derived from a 24-word BIP39 mnemonic.
 * The mnemonic is the master credential and is stored in the OS keychain
 * via the secrets module (Bun.secrets API). Keys are derived on demand.
 *
 * Flow:
 *   gssh user identity init
 *     → generate mnemonic
 *     → store mnemonic in keychain
 *     → derive keys on demand when needed
 *     → display mnemonic ONCE to user
 *
 *   gssh user identity recover
 *     → prompt for mnemonic
 *     → derive keys
 *     → store in keychain
 *
 * The stored format is a JSON blob under the global secret key
 * "USER_ROOT_IDENTITY" containing the mnemonic and metadata.
 *
 * @module core/user-identity
 */

import { setSecret, getSecret, deleteSecret } from '../utils/secrets.js';
import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToUserIdentity,
  formatUserRootPublicKey,
} from '../lib/tmux-lite/crypto/user-identity.js';
import { createDeviceCertificate } from '../lib/tmux-lite/crypto/device-cert.js';
import type { Identity } from '../types/identity.js';
import type { UserRootIdentity } from '../types/identity.js';
import { SpacesError } from '../types/errors.js';

// ============================================================================
// Constants
// ============================================================================

/** Keychain key for the user root identity blob */
const KEYCHAIN_KEY = 'USER_ROOT_IDENTITY';

// ============================================================================
// Stored Format
// ============================================================================

/** JSON-serializable format stored in keychain */
interface StoredUserRootIdentity {
  /** Schema version for forward compatibility */
  version: 2;
  /** 24-word BIP39 mnemonic (master credential) */
  mnemonic: string;
  /** When the identity was created (Unix ms) */
  createdAt: number;
}

// ============================================================================
// Serialization helpers
// ============================================================================

function mnemonicToStored(mnemonic: string, createdAt: number): StoredUserRootIdentity {
  return {
    version: 2,
    mnemonic,
    createdAt,
  };
}

function storedToIdentity(stored: StoredUserRootIdentity): UserRootIdentity {
  const identity = mnemonicToUserIdentity(stored.mnemonic);
  return {
    ...identity,
    createdAt: stored.createdAt,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Generate a new 24-word BIP39 mnemonic.
 * This does NOT store anything — it only generates the words.
 *
 * @returns 24-word mnemonic string
 */
export function generateNewMnemonic(): string {
  return generateMnemonic();
}

/**
 * Initialize a user root identity from a mnemonic and store in keychain.
 *
 * Derives Ed25519 + X25519 keypairs from the mnemonic, then stores
 * the full key material in the OS keychain.
 *
 * @param mnemonic - 24-word BIP39 mnemonic
 * @param force - If true, overwrite existing identity
 * @returns The derived identity
 * @throws {SpacesError} If identity exists and force is false
 * @throws {Error} If mnemonic is invalid
 */
export async function initFromMnemonic(
  mnemonic: string,
  force: boolean = false,
): Promise<UserRootIdentity> {
  const normalizedMnemonic = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');

  // Validate mnemonic
  if (!validateMnemonic(normalizedMnemonic)) {
    throw new SpacesError('Invalid BIP39 mnemonic', 'USER_ERROR', 1);
  }

  // Check for existing identity
  if (!force) {
    const existing = await loadUserRootIdentity();
    if (existing) {
      throw new SpacesError(
        'User root identity already exists. Use --force to overwrite.',
        'USER_ERROR',
        1,
      );
    }
  }

  // Derive keys from mnemonic
  const identity = mnemonicToUserIdentity(normalizedMnemonic);

  // Store mnemonic in keychain (keys are derived on demand)
  const stored = mnemonicToStored(normalizedMnemonic, identity.createdAt);
  await setSecret(KEYCHAIN_KEY, JSON.stringify(stored));

  return identity;
}

/**
 * Load the user root identity from keychain.
 *
 * @returns The full identity (with secret keys), or null if not initialized
 */
export async function loadUserRootIdentity(): Promise<UserRootIdentity | null> {
  const raw = await getSecret(KEYCHAIN_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { version?: unknown };

    // Clean cutover: v1 stored key blobs are no longer supported
    if (parsed.version === 1) {
      throw new SpacesError(
        'Legacy identity format detected. Recover your identity with `gssh user identity recover` using your 24-word mnemonic.',
        'USER_ERROR',
        1,
      );
    }

    if (parsed.version !== 2) {
      throw new SpacesError(
        `Unsupported user root identity version: ${String(parsed.version)}`,
        'SYSTEM_ERROR',
        2,
      );
    }

    const stored = parsed as StoredUserRootIdentity;
    if (typeof stored.mnemonic !== 'string' || typeof stored.createdAt !== 'number') {
      throw new SpacesError('Invalid user root identity payload in keychain', 'SYSTEM_ERROR', 2);
    }

    return storedToIdentity(stored);
  } catch (error) {
    if (error instanceof SpacesError) throw error;
    throw new SpacesError(
      `Failed to parse user root identity from keychain: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2,
    );
  }
}

/**
 * Check if a user root identity exists in keychain.
 *
 * @returns true if identity is stored
 */
export async function userRootIdentityExists(): Promise<boolean> {
  const raw = await getSecret(KEYCHAIN_KEY);
  return raw !== null;
}

/**
 * Get public information about the user root identity without loading secrets.
 *
 * Actually loads the full blob from keychain (secrets are protected by OS),
 * but only returns public fields.
 *
 * @returns Public identity info, or null if not initialized
 */
export async function getUserRootPublicInfo(): Promise<{
  id: string;
  signingPublicKey: string;
  keyExchangePublicKey: string;
  publicKeyString: string;
  fingerprint: string;
  createdAt: number;
} | null> {
  const identity = await loadUserRootIdentity();
  if (!identity) {
    return null;
  }

  const publicKeyString = formatUserRootPublicKey(identity);
  const fingerprint = formatFingerprint(identity.signing.publicKey);

  return {
    id: identity.id,
    signingPublicKey: Buffer.from(identity.signing.publicKey).toString('base64'),
    keyExchangePublicKey: Buffer.from(identity.keyExchange.publicKey).toString('base64'),
    publicKeyString,
    fingerprint,
    createdAt: identity.createdAt,
  };
}

/**
 * Remove the user root identity from keychain.
 *
 * After removal, the identity can only be recovered by re-entering
 * the original 24-word mnemonic.
 *
 * @returns true if an identity was deleted, false if none existed
 */
export async function removeUserRootIdentity(): Promise<boolean> {
  return deleteSecret(KEYCHAIN_KEY);
}

/**
 * Verify that a mnemonic matches the currently stored identity.
 *
 * Derives keys from the mnemonic and compares the identity ID
 * with the stored identity. Useful for confirming the user has
 * the correct recovery phrase before destructive operations.
 *
 * @param mnemonic - Mnemonic to verify
 * @returns true if mnemonic matches stored identity
 */
export async function verifyMnemonicMatchesStored(mnemonic: string): Promise<boolean> {
  if (!validateMnemonic(mnemonic)) {
    return false;
  }

  const stored = await loadUserRootIdentity();
  if (!stored) {
    return false;
  }

  const derived = mnemonicToUserIdentity(mnemonic);
  return derived.id === stored.id;
}

/**
 * Create a JSON-serialized device certificate for a device identity using
 * the locally stored user root identity.
 */
export async function createLocalDeviceCertificate(identity: Identity): Promise<string> {
  const userRoot = await loadUserRootIdentity();
  if (!userRoot) {
    throw new SpacesError(
      'No user root identity found. Run `gssh user identity init` or `gssh user identity recover` first.',
      'USER_ERROR',
      1,
    );
  }

  const cert = createDeviceCertificate(
    userRoot,
    identity.signing.publicKey,
    identity.keyExchange.publicKey,
  );

  return JSON.stringify(cert);
}

// ============================================================================
// Formatting helpers
// ============================================================================

/**
 * Format a fingerprint from a signing public key.
 * SHA-256 hash, first 16 hex chars, colon-separated pairs.
 *
 * @param signingPublicKey - 32-byte Ed25519 public key
 * @returns Fingerprint string like "ab:cd:ef:12:34:56:78:90"
 */
export function formatFingerprint(signingPublicKey: Uint8Array): string {
  const { createHash } = require('crypto') as typeof import('crypto');
  const hash = createHash('sha256').update(signingPublicKey).digest('hex');
  const first16 = hash.substring(0, 16);

  const parts: string[] = [];
  for (let i = 0; i < first16.length; i += 2) {
    parts.push(first16.substring(i, i + 2));
  }

  return parts.join(':');
}
