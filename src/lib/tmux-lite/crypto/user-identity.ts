/**
 * User root identity generation from BIP39 mnemonic
 *
 * Derives a deterministic Ed25519 signing keypair and X25519 key exchange keypair
 * from a 24-word BIP39 mnemonic (256 bits entropy).
 *
 * Key derivation path:
 *   mnemonic → BIP39 PBKDF2 → 64-byte seed
 *   seed → HKDF-SHA256(salt="gitspace", info="user-signing") → Ed25519 keypair
 *   seed → HKDF-SHA256(salt="gitspace", info="user-keyexchange") → X25519 keypair
 *
 * The mnemonic is the master secret. Same mnemonic always produces the same keypairs.
 * The mnemonic should be displayed once during init and never stored on disk.
 *
 * @module user-identity
 */

import { generateMnemonic as bip39GenerateMnemonic, mnemonicToSeedSync, validateMnemonic as bip39ValidateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { UserRootIdentity } from '../../../types/identity.js';
import { deriveIdentityId } from './identity.js';

// ============================================================================
// Constants
// ============================================================================

/** BIP39 entropy bits for 24-word mnemonic */
const MNEMONIC_ENTROPY_BITS = 256;

/** HKDF salt for gitspace key derivation */
const HKDF_SALT = new TextEncoder().encode('gitspace');

/** HKDF info for Ed25519 signing key derivation */
const HKDF_INFO_SIGNING = new TextEncoder().encode('user-signing');

/** HKDF info for X25519 key exchange key derivation */
const HKDF_INFO_KEYEXCHANGE = new TextEncoder().encode('user-keyexchange');

/** Key length in bytes */
const KEY_LENGTH = 32;

// ============================================================================
// Mnemonic Generation & Validation
// ============================================================================

/**
 * Generate a new 24-word BIP39 mnemonic (256 bits entropy)
 *
 * This is the user's master secret. Display it once, never store it.
 * Same entropy level as Ethereum HD wallets.
 *
 * @returns Space-separated 24-word mnemonic string
 */
export function generateMnemonic(): string {
  return bip39GenerateMnemonic(wordlist, MNEMONIC_ENTROPY_BITS);
}

/**
 * Validate a BIP39 mnemonic string
 *
 * Checks word count, wordlist membership, and checksum.
 *
 * @param mnemonic - Space-separated mnemonic words
 * @returns true if valid, false otherwise
 */
export function validateMnemonic(mnemonic: string): boolean {
  return bip39ValidateMnemonic(mnemonic, wordlist);
}

// ============================================================================
// Key Derivation
// ============================================================================

/**
 * Derive a user root identity from a BIP39 mnemonic
 *
 * Deterministic: same mnemonic always produces the same identity.
 *
 * Derivation:
 *   1. BIP39 PBKDF2(mnemonic, "mnemonic", 2048, SHA-512) → 64-byte seed
 *   2. HKDF-SHA256(seed, "gitspace", "user-signing") → 32-byte Ed25519 private key
 *   3. HKDF-SHA256(seed, "gitspace", "user-keyexchange") → 32-byte X25519 private key
 *   4. Derive public keys from private keys
 *
 * @param mnemonic - 24-word BIP39 mnemonic
 * @returns Complete user root identity with signing + key exchange keypairs
 * @throws {Error} If mnemonic is invalid
 */
export function mnemonicToUserIdentity(mnemonic: string): UserRootIdentity {
  if (!validateMnemonic(mnemonic)) {
    throw new Error('Invalid BIP39 mnemonic');
  }

  // Step 1: BIP39 standard seed derivation (PBKDF2 with SHA-512)
  const seed = mnemonicToSeedSync(mnemonic);

  // Step 2: Derive Ed25519 signing key via HKDF
  const signingPrivateKey = hkdf(sha256, seed, HKDF_SALT, HKDF_INFO_SIGNING, KEY_LENGTH);
  const signingPublicKey = ed25519.getPublicKey(signingPrivateKey);

  // Ed25519 convention: secretKey = privateKey (32 bytes) + publicKey (32 bytes)
  const signingSecretKey = new Uint8Array(64);
  signingSecretKey.set(signingPrivateKey, 0);
  signingSecretKey.set(signingPublicKey, 32);

  // Step 3: Derive X25519 key exchange key via HKDF
  const keyExchangePrivateKey = hkdf(sha256, seed, HKDF_SALT, HKDF_INFO_KEYEXCHANGE, KEY_LENGTH);
  const keyExchangePublicKey = x25519.getPublicKey(keyExchangePrivateKey);

  // Step 4: Derive identity ID from signing public key
  const id = deriveIdentityId(signingPublicKey);

  return {
    id,
    signing: {
      publicKey: signingPublicKey,
      secretKey: signingSecretKey,
    },
    keyExchange: {
      publicKey: keyExchangePublicKey,
      privateKey: keyExchangePrivateKey,
    },
    createdAt: Date.now(),
  };
}

// ============================================================================
// Serialization
// ============================================================================

/** Serialized user root identity for JSON storage (base64 encoded keys) */
export interface SerializedUserRootIdentity {
  id: string;
  signingPublicKey: string;
  keyExchangePublicKey: string;
  /** Encrypted blob containing both secret keys */
  encryptedSecrets?: string;
  createdAt: number;
}

/**
 * Serialize user root identity public fields for storage/display
 *
 * NOTE: This does NOT include secret keys. Use encryptUserRoot() for
 * secure storage that includes secrets.
 *
 * @param identity - User root identity
 * @returns Serialized public identity
 */
export function serializeUserRootPublic(identity: UserRootIdentity): SerializedUserRootIdentity {
  return {
    id: identity.id,
    signingPublicKey: Buffer.from(identity.signing.publicKey).toString('base64'),
    keyExchangePublicKey: Buffer.from(identity.keyExchange.publicKey).toString('base64'),
    createdAt: identity.createdAt,
  };
}

/**
 * Format user root public key in the standard exchange format
 *
 * @param identity - User root identity
 * @returns String in format "gssh-user:BASE64_SIGNING_KEY"
 */
export function formatUserRootPublicKey(identity: UserRootIdentity): string {
  const signingKeyBase64 = Buffer.from(identity.signing.publicKey).toString('base64');
  return `gssh-user:${signingKeyBase64}`;
}

/**
 * Format a short fingerprint from a signing public key.
 *
 * SHA-256 hash, first 16 hex chars, colon-separated pairs.
 */
export function formatSigningPublicKeyFingerprint(signingPublicKey: Uint8Array): string {
  const hashHex = Buffer.from(sha256(signingPublicKey)).toString('hex');
  const first16 = hashHex.substring(0, 16);

  const parts: string[] = [];
  for (let i = 0; i < first16.length; i += 2) {
    parts.push(first16.substring(i, i + 2));
  }

  return parts.join(':');
}

/**
 * Parse a user root public key string
 *
 * @param publicKeyStr - String in format "gssh-user:BASE64_SIGNING_KEY"
 * @returns Object with parsed signing public key bytes and derived ID
 * @throws {Error} If format is invalid
 */
export function parseUserRootPublicKey(publicKeyStr: string): {
  signingPublicKey: Uint8Array;
  userRootId: string;
} {
  if (!publicKeyStr.startsWith('gssh-user:')) {
    throw new Error('Invalid user root public key format. Expected "gssh-user:BASE64_KEY"');
  }

  const base64Key = publicKeyStr.slice('gssh-user:'.length);
  const signingPublicKey = new Uint8Array(Buffer.from(base64Key, 'base64'));

  if (signingPublicKey.length !== 32) {
    throw new Error(`Invalid signing public key length: ${signingPublicKey.length}, expected 32`);
  }

  const userRootId = deriveIdentityId(signingPublicKey);

  return { signingPublicKey, userRootId };
}
