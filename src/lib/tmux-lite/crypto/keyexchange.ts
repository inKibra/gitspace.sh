/**
 * X25519 ECDH key exchange and HKDF key derivation for secure sessions
 *
 * This module provides:
 * - X25519 ephemeral key generation
 * - ECDH shared secret computation
 * - HKDF-based session key derivation with domain separation
 * - Support for multiple shared secrets (X3DH protocol)
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "node:crypto";
import type { KeyExchangeKeypair, SessionKeys } from "../../../types/identity.js";

// ============================================================================
// Constants
// ============================================================================

/** X25519 key length (32 bytes) */
export const X25519_KEY_LENGTH = 32;

/** Session key length (32 bytes, 256 bits for ChaCha20-Poly1305) */
export const SESSION_KEY_LENGTH = 32;

/** HKDF salt length (32 bytes) */
const HKDF_SALT_LENGTH = 32;

/** HKDF domain separation for send key */
const INFO_SEND = "spaces-v1-send";

/** HKDF domain separation for receive key */
const INFO_RECEIVE = "spaces-v1-receive";

/** HKDF domain separation for session ID */
const INFO_SESSION_ID = "spaces-v1-session-id";

// ============================================================================
// X25519 Operations
// ============================================================================

/**
 * Compute X25519 ECDH shared secret
 *
 * @param ourPrivateKey - Our X25519 private key (32 bytes)
 * @param theirPublicKey - Their X25519 public key (32 bytes)
 * @returns Shared secret (32 bytes)
 * @throws {Error} If key lengths are invalid or computation fails
 *
 * @example
 * ```typescript
 * const alice = generateEphemeralKeypair();
 * const bob = generateEphemeralKeypair();
 * const sharedA = x25519SharedSecret(alice.privateKey, bob.publicKey);
 * const sharedB = x25519SharedSecret(bob.privateKey, alice.publicKey);
 * // sharedA === sharedB
 * ```
 */
export function x25519SharedSecret(
  ourPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array
): Uint8Array {
  if (ourPrivateKey.length !== X25519_KEY_LENGTH) {
    throw new Error(
      `Invalid private key length: expected ${X25519_KEY_LENGTH}, got ${ourPrivateKey.length}`
    );
  }

  if (theirPublicKey.length !== X25519_KEY_LENGTH) {
    throw new Error(
      `Invalid public key length: expected ${X25519_KEY_LENGTH}, got ${theirPublicKey.length}`
    );
  }

  try {
    const sharedSecret = x25519.getSharedSecret(ourPrivateKey, theirPublicKey);
    return sharedSecret;
  } catch (error) {
    throw new Error(
      `X25519 shared secret computation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Generate a random X25519 ephemeral keypair
 *
 * @returns New keypair with 32-byte private and public keys
 * @throws {Error} If random generation fails
 *
 * @example
 * ```typescript
 * const ephemeral = generateEphemeralKeypair();
 * console.log(ephemeral.publicKey.length); // 32
 * console.log(ephemeral.privateKey.length); // 32
 * ```
 */
export function generateEphemeralKeypair(): KeyExchangeKeypair {
  try {
    const privateKey = randomBytes(X25519_KEY_LENGTH);
    const publicKey = x25519.getPublicKey(privateKey);

    return {
      privateKey,
      publicKey,
    };
  } catch (error) {
    throw new Error(
      `Failed to generate ephemeral keypair: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * All 8 known X25519 low-order points (little-endian representation)
 *
 * These points have small order (dividing 8) and can cause security issues:
 * - DH with these points produces predictable outputs
 * - Can enable small-subgroup attacks
 *
 * Security: All of these must be rejected as public keys
 */
const LOW_ORDER_POINTS: Uint8Array[] = [
  // 0 - the identity point (already handled by all-zeros check, but explicit)
  new Uint8Array(32).fill(0),

  // 1 - point (1, *)
  new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),

  // Order-8 points (in little-endian hex):
  // e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205eb80f93f81 (non-canonical, not needed)

  // 0xecffffff...7f = p - 1 (2^255 - 19 - 1)
  new Uint8Array([0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]),

  // Point with high bit set: 0x0000...80
  new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x80]),

  // 1 with high bit set: 0x0100...80
  new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x80]),

  // p - 1 with high bit set
  new Uint8Array([0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),

  // Additional dangerous point: 325606250916557431795983626356110631294008115727848805560023387167927233504
  // In little-endian bytes: 0xe0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205eb80f93f81
  new Uint8Array([0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4, 0x6a, 0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0xeb, 0x80, 0xf9, 0x3f, 0x81]),

  // 5f9c95bca3508c24b1d0b15b72633f78f59b2ab008637a1405f5bf5c20c9b010
  new Uint8Array([0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x5b, 0x72, 0x63, 0x3f, 0x78, 0xf5, 0x9b, 0x2a, 0xb0, 0x08, 0x63, 0x7a, 0x14, 0x05, 0xf5, 0xbf, 0x5c, 0x20, 0xc9, 0xb0, 0x10]),
];

/**
 * Compare two Uint8Arrays in constant time
 * Security: Prevents timing attacks when comparing keys
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/**
 * Check if a public key is a known low-order point
 * Security: Returns true if the key is dangerous and should be rejected
 */
function isLowOrderPoint(publicKey: Uint8Array): boolean {
  for (const lowOrderPoint of LOW_ORDER_POINTS) {
    if (constantTimeEqual(publicKey, lowOrderPoint)) {
      return true;
    }
  }
  return false;
}

/**
 * Validate an X25519 public key
 *
 * Security checks:
 * - Correct length (32 bytes)
 * - Not all zeros (identity point)
 * - Not any of the 8 known low-order points (prevents small-subgroup attacks)
 * - Valid for scalar multiplication (library check)
 *
 * @param publicKey - Public key to validate
 * @returns True if valid, false otherwise
 *
 * @example
 * ```typescript
 * const keypair = generateEphemeralKeypair();
 * console.log(validateX25519PublicKey(keypair.publicKey)); // true
 * console.log(validateX25519PublicKey(new Uint8Array(32))); // false (all zeros)
 * ```
 */
export function validateX25519PublicKey(publicKey: Uint8Array): boolean {
  // Check length
  if (publicKey.length !== X25519_KEY_LENGTH) {
    return false;
  }

  // Check not a low-order point (includes all zeros, 1, p-1, and other dangerous points)
  if (isLowOrderPoint(publicKey)) {
    return false;
  }

  // Additional check: try to use it in a scalar multiplication
  // If it's invalid, @noble/curves will throw
  try {
    const testPrivate = new Uint8Array(32);
    testPrivate[0] = 9; // Small non-zero scalar
    const result = x25519.getSharedSecret(testPrivate, publicKey);

    // Security: Check result is not all zeros (indicates small-order point)
    const isAllZeros = result.every((byte: number) => byte === 0);
    if (isAllZeros) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// HKDF Key Derivation
// ============================================================================

/**
 * Derive session keys from a single shared secret using HKDF-SHA256
 *
 * Uses domain separation to derive independent send/receive keys:
 * - sendKey = HKDF(secret, salt, "spaces-v1-send")
 * - receiveKey = HKDF(secret, salt, "spaces-v1-receive")
 *
 * If isInitiator=false, send and receive keys are swapped (for peer).
 *
 * @param sharedSecret - ECDH shared secret (32 bytes)
 * @param salt - Optional salt (default: random 32 bytes)
 * @param isInitiator - Whether we initiated the handshake (default: true)
 * @returns Session keys with send/receive keys and session ID
 * @throws {Error} If shared secret is invalid or derivation fails
 *
 * @example
 * ```typescript
 * const alice = generateEphemeralKeypair();
 * const bob = generateEphemeralKeypair();
 * const salt = generateSessionSalt();
 *
 * const sharedSecret = x25519SharedSecret(alice.privateKey, bob.publicKey);
 * const aliceKeys = deriveSessionKeys(sharedSecret, salt, true);
 * const bobKeys = deriveSessionKeys(sharedSecret, salt, false);
 *
 * // Alice's sendKey === Bob's receiveKey
 * // Alice's receiveKey === Bob's sendKey
 * ```
 */
export function deriveSessionKeys(
  sharedSecret: Uint8Array,
  salt?: Uint8Array,
  isInitiator: boolean = true
): SessionKeys {
  if (sharedSecret.length !== X25519_KEY_LENGTH) {
    throw new Error(
      `Invalid shared secret length: expected ${X25519_KEY_LENGTH}, got ${sharedSecret.length}`
    );
  }

  // Generate random salt if not provided
  // HKDF accepts any salt length; we use 32 bytes as default
  const actualSalt = salt ?? randomBytes(HKDF_SALT_LENGTH);

  if (actualSalt.length === 0) {
    throw new Error("Salt cannot be empty");
  }

  try {
    // Derive send key
    const sendKeyInfo = new TextEncoder().encode(INFO_SEND);
    const sendKey = hkdf(
      sha256,
      sharedSecret,
      actualSalt,
      sendKeyInfo,
      SESSION_KEY_LENGTH
    );

    // Derive receive key
    const receiveKeyInfo = new TextEncoder().encode(INFO_RECEIVE);
    const receiveKey = hkdf(
      sha256,
      sharedSecret,
      actualSalt,
      receiveKeyInfo,
      SESSION_KEY_LENGTH
    );

    // Derive session ID (for key rotation tracking)
    const sessionIdInfo = new TextEncoder().encode(INFO_SESSION_ID);
    const sessionIdBytes = hkdf(
      sha256,
      sharedSecret,
      actualSalt,
      sessionIdInfo,
      16 // 128-bit session ID
    );
    const sessionId = Buffer.from(sessionIdBytes).toString("base64url");

    // If not initiator, swap send/receive keys
    if (!isInitiator) {
      return {
        sendKey: receiveKey,
        receiveKey: sendKey,
        sessionId,
      };
    }

    return {
      sendKey,
      receiveKey,
      sessionId,
    };
  } catch (error) {
    throw new Error(
      `Session key derivation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Derive session keys from multiple shared secrets (X3DH protocol)
 *
 * Combines multiple ECDH outputs into a single master secret:
 * - masterSecret = HKDF(concat(DH1, DH2, ...), salt, "spaces-v1-master")
 * - Then derives send/receive keys from masterSecret
 *
 * This is used in X3DH handshake which computes multiple DH operations:
 * - DH(ephemeral, signedPreKey)
 * - DH(identity, ephemeral)
 * - DH(ephemeral, ephemeral)
 * - DH(ephemeral, identityKey)
 *
 * @param sharedSecrets - Array of ECDH shared secrets (each 32 bytes)
 * @param salt - Optional salt (default: random 32 bytes)
 * @param isInitiator - Whether we initiated the handshake (default: true)
 * @returns Session keys with send/receive keys and session ID
 * @throws {Error} If any shared secret is invalid or derivation fails
 *
 * @example
 * ```typescript
 * const dh1 = x25519SharedSecret(ephemeral1, preKey);
 * const dh2 = x25519SharedSecret(identity, ephemeral2);
 * const dh3 = x25519SharedSecret(ephemeral1, ephemeral2);
 *
 * const keys = deriveSessionKeysFromMultiple([dh1, dh2, dh3]);
 * ```
 */
export function deriveSessionKeysFromMultiple(
  sharedSecrets: Uint8Array[],
  salt?: Uint8Array,
  isInitiator: boolean = true
): SessionKeys {
  if (sharedSecrets.length === 0) {
    throw new Error("At least one shared secret is required");
  }

  // Validate all shared secrets
  for (let i = 0; i < sharedSecrets.length; i++) {
    if (sharedSecrets[i].length !== X25519_KEY_LENGTH) {
      throw new Error(
        `Invalid shared secret at index ${i}: expected ${X25519_KEY_LENGTH} bytes, got ${sharedSecrets[i].length}`
      );
    }
  }

  // Generate random salt if not provided
  // HKDF accepts any salt length; we use 32 bytes as default
  const actualSalt = salt ?? randomBytes(HKDF_SALT_LENGTH);

  if (actualSalt.length === 0) {
    throw new Error("Salt cannot be empty");
  }

  try {
    // Concatenate all shared secrets
    const totalLength = sharedSecrets.length * X25519_KEY_LENGTH;
    const concatenated = new Uint8Array(totalLength);
    for (let i = 0; i < sharedSecrets.length; i++) {
      concatenated.set(sharedSecrets[i], i * X25519_KEY_LENGTH);
    }

    // Derive master secret from concatenated secrets
    const masterInfo = new TextEncoder().encode("spaces-v1-master");
    const masterSecret = hkdf(
      sha256,
      concatenated,
      actualSalt,
      masterInfo,
      X25519_KEY_LENGTH
    );

    // Now derive session keys from master secret
    return deriveSessionKeys(masterSecret, actualSalt, isInitiator);
  } catch (error) {
    throw new Error(
      `Multi-secret session key derivation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Generate a random salt for session key derivation
 *
 * @returns Random 32-byte salt
 * @throws {Error} If random generation fails
 *
 * @example
 * ```typescript
 * const salt = generateSessionSalt();
 * const keys = deriveSessionKeys(sharedSecret, salt);
 * ```
 */
export function generateSessionSalt(): Uint8Array {
  try {
    return randomBytes(HKDF_SALT_LENGTH);
  } catch (error) {
    throw new Error(
      `Failed to generate session salt: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
