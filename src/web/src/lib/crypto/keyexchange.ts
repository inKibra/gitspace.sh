/**
 * Browser-compatible X25519 key exchange and HKDF key derivation
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { KeyExchangeKeypair, SessionKeys } from "../../types/identity";

// Constants
export const X25519_KEY_LENGTH = 32;
export const SESSION_KEY_LENGTH = 32;
const HKDF_SALT_LENGTH = 32;

const INFO_SEND = "spaces-v1-send";
const INFO_RECEIVE = "spaces-v1-receive";
const INFO_SESSION_ID = "spaces-v1-session-id";

/**
 * Generate random bytes using Web Crypto API
 */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Compute X25519 ECDH shared secret
 */
export function x25519SharedSecret(
  ourPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array
): Uint8Array {
  if (ourPrivateKey.length !== X25519_KEY_LENGTH) {
    throw new Error(`Invalid private key length: expected ${X25519_KEY_LENGTH}, got ${ourPrivateKey.length}`);
  }
  if (theirPublicKey.length !== X25519_KEY_LENGTH) {
    throw new Error(`Invalid public key length: expected ${X25519_KEY_LENGTH}, got ${theirPublicKey.length}`);
  }

  try {
    return x25519.getSharedSecret(ourPrivateKey, theirPublicKey);
  } catch (error) {
    throw new Error(`X25519 shared secret computation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Generate a random X25519 ephemeral keypair
 */
export function generateEphemeralKeypair(): KeyExchangeKeypair {
  const privateKey = randomBytes(X25519_KEY_LENGTH);
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
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
  // 0 - the identity point
  new Uint8Array(32).fill(0),

  // 1 - point (1, *)
  new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),

  // 0xecffffff...7f = p - 1 (2^255 - 19 - 1)
  new Uint8Array([0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]),

  // Point with high bit set: 0x0000...80
  new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x80]),

  // 1 with high bit set: 0x0100...80
  new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x80]),

  // p - 1 with high bit set
  new Uint8Array([0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),

  // Additional dangerous point: 325606250916557431795983626356110631294008115727848805560023387167927233504
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
 * - Not any of the 8 known low-order points (prevents small-subgroup attacks)
 * - Valid for scalar multiplication (library check)
 */
export function validateX25519PublicKey(publicKey: Uint8Array): boolean {
  if (publicKey.length !== X25519_KEY_LENGTH) {
    return false;
  }

  // Check not a low-order point (includes all zeros, 1, p-1, and other dangerous points)
  if (isLowOrderPoint(publicKey)) {
    return false;
  }

  // Try to use it in scalar multiplication
  try {
    const testPrivate = new Uint8Array(32);
    testPrivate[0] = 9;
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

/**
 * Base64url encode
 */
function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Derive session keys from a single shared secret using HKDF-SHA256
 */
export function deriveSessionKeys(
  sharedSecret: Uint8Array,
  salt?: Uint8Array,
  isInitiator: boolean = true
): SessionKeys {
  if (sharedSecret.length !== X25519_KEY_LENGTH) {
    throw new Error(`Invalid shared secret length: expected ${X25519_KEY_LENGTH}, got ${sharedSecret.length}`);
  }

  const actualSalt = salt ?? randomBytes(HKDF_SALT_LENGTH);

  if (actualSalt.length === 0) {
    throw new Error("Salt cannot be empty");
  }

  // Derive send key
  const sendKeyInfo = new TextEncoder().encode(INFO_SEND);
  const sendKey = hkdf(sha256, sharedSecret, actualSalt, sendKeyInfo, SESSION_KEY_LENGTH);

  // Derive receive key
  const receiveKeyInfo = new TextEncoder().encode(INFO_RECEIVE);
  const receiveKey = hkdf(sha256, sharedSecret, actualSalt, receiveKeyInfo, SESSION_KEY_LENGTH);

  // Derive session ID
  const sessionIdInfo = new TextEncoder().encode(INFO_SESSION_ID);
  const sessionIdBytes = hkdf(sha256, sharedSecret, actualSalt, sessionIdInfo, 16);
  const sessionId = toBase64Url(sessionIdBytes);

  if (!isInitiator) {
    return { sendKey: receiveKey, receiveKey: sendKey, sessionId };
  }

  return { sendKey, receiveKey, sessionId };
}

/**
 * Derive session keys from multiple shared secrets (X3DH protocol)
 */
export function deriveSessionKeysFromMultiple(
  sharedSecrets: Uint8Array[],
  salt?: Uint8Array,
  isInitiator: boolean = true
): SessionKeys {
  if (sharedSecrets.length === 0) {
    throw new Error("At least one shared secret is required");
  }

  for (let i = 0; i < sharedSecrets.length; i++) {
    if (sharedSecrets[i].length !== X25519_KEY_LENGTH) {
      throw new Error(`Invalid shared secret at index ${i}: expected ${X25519_KEY_LENGTH} bytes, got ${sharedSecrets[i].length}`);
    }
  }

  const actualSalt = salt ?? randomBytes(HKDF_SALT_LENGTH);

  if (actualSalt.length === 0) {
    throw new Error("Salt cannot be empty");
  }

  // Concatenate all shared secrets
  const totalLength = sharedSecrets.length * X25519_KEY_LENGTH;
  const concatenated = new Uint8Array(totalLength);
  for (let i = 0; i < sharedSecrets.length; i++) {
    concatenated.set(sharedSecrets[i], i * X25519_KEY_LENGTH);
  }

  // Derive master secret
  const masterInfo = new TextEncoder().encode("spaces-v1-master");
  const masterSecret = hkdf(sha256, concatenated, actualSalt, masterInfo, X25519_KEY_LENGTH);

  return deriveSessionKeys(masterSecret, actualSalt, isInitiator);
}

/**
 * Generate a random salt for session key derivation
 */
export function generateSessionSalt(): Uint8Array {
  return randomBytes(HKDF_SALT_LENGTH);
}
