/**
 * Key derivation for encrypted secret storage
 *
 * Uses scrypt for password-based key derivation.
 */

import { scrypt, randomBytes } from "node:crypto";

/** Salt length in bytes */
export const SALT_LENGTH = 16;

/** Derived key length in bytes (256-bit for chacha20-poly1305) */
export const KEY_LENGTH = 32;

/** scrypt parameters (N=2^15, r=8, p=1) - balance of security and performance */
export const SCRYPT_PARAMS = {
  N: 2 ** 15, // CPU/memory cost
  r: 8, // Block size
  p: 1, // Parallelization
  maxmem: 64 * 1024 * 1024, // 64MB max memory
};

/**
 * Generate a random salt for key derivation
 */
export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}

/**
 * Derive a 256-bit key from a secret and salt using scrypt
 *
 * @param secret - The secret/password to derive from
 * @param salt - Random salt (use generateSalt())
 * @returns 32-byte key suitable for chacha20-poly1305
 */
export function deriveKey(
  secret: string,
  salt: Buffer | Uint8Array
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, KEY_LENGTH, SCRYPT_PARAMS, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}
