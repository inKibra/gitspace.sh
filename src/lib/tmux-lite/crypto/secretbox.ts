/**
 * Authenticated encryption using AES-256-GCM
 *
 * This is similar to NaCl secretbox but uses AES-256-GCM
 * which is natively supported in Bun's node:crypto.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

/** Nonce/IV length in bytes (96-bit for AES-GCM) */
export const NONCE_LENGTH = 12;

/** Auth tag length in bytes */
export const AUTH_TAG_LENGTH = 16;

/** Algorithm name */
const ALGORITHM = "aes-256-gcm";

/**
 * Generate a random nonce
 */
export function generateNonce(): Buffer {
  return randomBytes(NONCE_LENGTH);
}

/**
 * Encrypt data using ChaCha20-Poly1305
 *
 * @param data - Plaintext data to encrypt
 * @param key - 256-bit key (from deriveKey)
 * @returns Object with nonce and ciphertext (includes auth tag)
 */
export function encrypt(
  data: Uint8Array | Buffer,
  key: Uint8Array | Buffer
): { nonce: Buffer; ciphertext: Buffer } {
  const nonce = generateNonce();

  const cipher = createCipheriv(ALGORITHM, key, nonce, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Append auth tag to ciphertext
  const ciphertext = Buffer.concat([encrypted, authTag]);

  return { nonce, ciphertext };
}

/**
 * Decrypt data using ChaCha20-Poly1305
 *
 * @param ciphertext - Encrypted data (includes auth tag at end)
 * @param nonce - Nonce used for encryption
 * @param key - 256-bit key (same as used for encryption)
 * @returns Decrypted plaintext, or null if authentication failed
 */
export function decrypt(
  ciphertext: Uint8Array | Buffer,
  nonce: Uint8Array | Buffer,
  key: Uint8Array | Buffer
): Buffer | null {
  try {
    // Extract auth tag from end of ciphertext
    const encrypted = ciphertext.slice(0, -AUTH_TAG_LENGTH);
    const authTag = ciphertext.slice(-AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, nonce, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted;
  } catch {
    // Authentication failed or other error
    return null;
  }
}

/**
 * Encrypt data and return a single buffer with nonce prepended
 *
 * Format: nonce (12 bytes) || ciphertext || authTag (16 bytes)
 */
export function seal(
  data: Uint8Array | Buffer,
  key: Uint8Array | Buffer
): Buffer {
  const { nonce, ciphertext } = encrypt(data, key);
  return Buffer.concat([nonce, ciphertext]);
}

/**
 * Decrypt data from a sealed buffer (nonce prepended)
 *
 * @param sealed - Buffer with format: nonce || ciphertext || authTag
 * @param key - 256-bit key
 * @returns Decrypted plaintext, or null if authentication failed
 */
export function open(
  sealed: Uint8Array | Buffer,
  key: Uint8Array | Buffer
): Buffer | null {
  if (sealed.length < NONCE_LENGTH + AUTH_TAG_LENGTH) {
    return null;
  }

  const nonce = sealed.slice(0, NONCE_LENGTH);
  const ciphertext = sealed.slice(NONCE_LENGTH);

  return decrypt(ciphertext, nonce, key);
}
