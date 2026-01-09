/**
 * Identity management using Ed25519 signing and X25519 key exchange
 *
 * This module provides cryptographic identity generation and management:
 * - Ed25519 for digital signatures (authentication)
 * - X25519 for Diffie-Hellman key exchange (encryption)
 *
 * @module identity
 */

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import type {
  SigningKeypair,
  KeyExchangeKeypair,
  Identity,
  StoredIdentity,
  PublicIdentity,
} from "../../../types/identity.js";

// ============================================================================
// Constants
// ============================================================================

/** Length of identity ID (first 16 chars of base64url encoded public key) */
const IDENTITY_ID_LENGTH = 16;

// ============================================================================
// Keypair Generation
// ============================================================================

/**
 * Generate a new Ed25519 signing keypair
 *
 * Ed25519 is used for digital signatures to authenticate messages and identities.
 * The secret key is 64 bytes (32-byte seed + 32-byte public key).
 *
 * @returns New signing keypair
 */
export function generateSigningKeypair(): SigningKeypair {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);

  // Ed25519 convention: secretKey = privateKey (32 bytes) + publicKey (32 bytes)
  const secretKey = new Uint8Array(64);
  secretKey.set(privateKey, 0);
  secretKey.set(publicKey, 32);

  return {
    publicKey,
    secretKey,
  };
}

/**
 * Generate a new X25519 key exchange keypair
 *
 * X25519 is used for Diffie-Hellman key exchange to establish shared secrets
 * for encryption.
 *
 * @returns New key exchange keypair
 */
export function generateKeyExchangeKeypair(): KeyExchangeKeypair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);

  return {
    publicKey,
    privateKey,
  };
}

/**
 * Generate a complete identity with both signing and key exchange keypairs
 *
 * Creates a new identity with:
 * - Unique ID derived from signing public key
 * - Ed25519 signing keypair
 * - X25519 key exchange keypair
 * - Optional human-readable label
 * - Creation timestamp
 *
 * @param label - Optional human-readable label for this identity
 * @returns Complete identity
 */
export function generateIdentity(label?: string): Identity {
  const signing = generateSigningKeypair();
  const keyExchange = generateKeyExchangeKeypair();
  const id = deriveIdentityId(signing.publicKey);

  return {
    id,
    signing,
    keyExchange,
    label,
    createdAt: Date.now(),
  };
}

// ============================================================================
// Identity ID Derivation
// ============================================================================

/**
 * Derive a short identity ID from a signing public key
 *
 * Takes the first 16 characters of the base64url-encoded public key.
 * This provides a compact, URL-safe identifier while maintaining uniqueness
 * (collision probability ~1 in 2^96).
 *
 * @param signingPublicKey - Ed25519 public key (32 bytes)
 * @returns Identity ID (16 character base64url string)
 */
export function deriveIdentityId(signingPublicKey: Uint8Array): string {
  if (signingPublicKey.length !== 32) {
    throw new Error(
      `Invalid signing public key length: ${signingPublicKey.length}, expected 32`
    );
  }

  const base64url = Buffer.from(signingPublicKey).toString("base64url");
  return base64url.slice(0, IDENTITY_ID_LENGTH);
}

// ============================================================================
// Signing and Verification
// ============================================================================

/**
 * Sign a message using Ed25519
 *
 * Creates a detached signature that can be verified with the corresponding
 * public key. Signatures are deterministic (same message + key = same signature).
 *
 * @param message - Message to sign
 * @param secretKey - Ed25519 secret key (64 bytes)
 * @returns Signature (64 bytes)
 */
export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 64) {
    throw new Error(
      `Invalid secret key length: ${secretKey.length}, expected 64`
    );
  }

  // Extract the 32-byte private key from the 64-byte secret key
  const privateKey = secretKey.slice(0, 32);
  return ed25519.sign(message, privateKey);
}

/**
 * Verify an Ed25519 signature
 *
 * Verifies that a signature was created by the holder of the secret key
 * corresponding to the given public key.
 *
 * @param message - Original message that was signed
 * @param signature - Signature to verify (64 bytes)
 * @param publicKey - Ed25519 public key (32 bytes)
 * @returns True if signature is valid, false otherwise
 */
export function verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): boolean {
  if (signature.length !== 64) {
    throw new Error(
      `Invalid signature length: ${signature.length}, expected 64`
    );
  }
  if (publicKey.length !== 32) {
    throw new Error(
      `Invalid public key length: ${publicKey.length}, expected 32`
    );
  }

  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    // Invalid signature format or verification failed
    return false;
  }
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Serialize an identity for storage
 *
 * Converts binary keys to base64 strings for JSON serialization.
 * WARNING: This does NOT encrypt the secret keys. Use appropriate
 * encryption before storing to disk.
 *
 * @param identity - Identity to serialize
 * @returns Serializable identity with base64-encoded keys
 */
export function serializeIdentity(identity: Identity): StoredIdentity {
  return {
    id: identity.id,
    signingPublicKey: Buffer.from(identity.signing.publicKey).toString(
      "base64"
    ),
    signingSecretKey: Buffer.from(identity.signing.secretKey).toString(
      "base64"
    ),
    keyExchangePublicKey: Buffer.from(
      identity.keyExchange.publicKey
    ).toString("base64"),
    keyExchangePrivateKey: Buffer.from(
      identity.keyExchange.privateKey
    ).toString("base64"),
    label: identity.label,
    createdAt: identity.createdAt,
  };
}

/**
 * Deserialize a stored identity
 *
 * Converts base64 strings back to binary Uint8Arrays.
 * Verifies that the identity ID matches the signing public key.
 *
 * @param stored - Stored identity with base64-encoded keys
 * @returns Identity with binary keys
 * @throws {Error} If identity ID doesn't match signing public key
 */
export function deserializeIdentity(stored: StoredIdentity): Identity {
  const signingPublicKey = new Uint8Array(
    Buffer.from(stored.signingPublicKey, "base64")
  );
  const signingSecretKey = new Uint8Array(
    Buffer.from(stored.signingSecretKey, "base64")
  );
  const keyExchangePublicKey = new Uint8Array(
    Buffer.from(stored.keyExchangePublicKey, "base64")
  );
  const keyExchangePrivateKey = new Uint8Array(
    Buffer.from(stored.keyExchangePrivateKey, "base64")
  );

  // Verify identity ID matches signing public key
  const derivedId = deriveIdentityId(signingPublicKey);
  if (derivedId !== stored.id) {
    throw new Error(
      `Identity ID mismatch: stored=${stored.id}, derived=${derivedId}`
    );
  }

  return {
    id: stored.id,
    signing: {
      publicKey: signingPublicKey,
      secretKey: signingSecretKey,
    },
    keyExchange: {
      publicKey: keyExchangePublicKey,
      privateKey: keyExchangePrivateKey,
    },
    label: stored.label,
    createdAt: stored.createdAt,
  };
}

/**
 * Extract public identity information
 *
 * Returns only the public parts of an identity that are safe to share.
 * This includes public keys but NOT secret/private keys.
 *
 * @param identity - Complete identity
 * @returns Public identity info (safe to share)
 */
export function getPublicIdentity(identity: Identity): PublicIdentity {
  return {
    id: identity.id,
    signingPublicKey: Buffer.from(identity.signing.publicKey).toString(
      "base64"
    ),
    keyExchangePublicKey: Buffer.from(identity.keyExchange.publicKey).toString(
      "base64"
    ),
    label: identity.label,
  };
}
