/**
 * Message signing utilities for relay protocol
 *
 * Provides Ed25519 signatures for security-critical protocol messages
 * to prevent tampering and verify sender identity.
 */

import { ed25519 } from "@noble/curves/ed25519.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Signature block added to signed messages
 */
export interface SignatureBlock {
  /** Ed25519 signature of canonical message (base64) */
  sig: string;
  /** Signer's public key (base64) */
  pub: string;
  /** Timestamp (Unix ms) for replay prevention */
  ts: number;
}

/**
 * Message with optional signature
 */
export type SignedMessage<T> = T & { signature?: SignatureBlock };

// ============================================================================
// Configuration
// ============================================================================

/**
 * Maximum timestamp drift allowed (5 minutes)
 * Messages with timestamps outside this window are rejected
 */
const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

// ============================================================================
// Canonicalization
// ============================================================================

/**
 * Create canonical JSON representation for signing
 *
 * Produces a deterministic string from an object by:
 * 1. Sorting keys alphabetically
 * 2. Excluding the 'signature' field
 * 3. Using consistent JSON formatting
 *
 * @param obj - Object to canonicalize
 * @returns Deterministic JSON string
 */
export function canonicalize(obj: object): string {
  return JSON.stringify(obj, (key, value) => {
    // Exclude signature field from canonical form
    if (key === "signature") return undefined;

    // Sort object keys for deterministic output
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = value[k];
      }
      return sorted;
    }
    return value;
  });
}

// ============================================================================
// Signing
// ============================================================================

/**
 * Sign a protocol message with Ed25519
 *
 * Adds a signature block containing:
 * - The Ed25519 signature of the canonical message
 * - The signer's public key (for verification)
 * - A timestamp (for replay prevention)
 *
 * @param message - Message to sign
 * @param privateKey - Ed25519 private key (32 bytes)
 * @param publicKey - Ed25519 public key (32 bytes)
 * @returns Message with signature block
 */
export function signMessage<T extends object>(
  message: T,
  privateKey: Uint8Array,
  publicKey: Uint8Array
): T & { signature: SignatureBlock } {
  const ts = Date.now();

  // Create message with timestamp for signing
  const msgWithTs = { ...message, signature: { ts } };
  const canonical = canonicalize(msgWithTs);
  const messageBytes = new TextEncoder().encode(canonical);

  // Sign
  const signatureBytes = ed25519.sign(messageBytes, privateKey);

  // Create signature block
  const signature: SignatureBlock = {
    sig: Buffer.from(signatureBytes).toString("base64"),
    pub: Buffer.from(publicKey).toString("base64"),
    ts,
  };

  return { ...message, signature };
}

// ============================================================================
// Verification
// ============================================================================

/**
 * Verify a signed message
 *
 * Checks:
 * 1. Signature block is present and well-formed
 * 2. Timestamp is within acceptable drift window
 * 3. Ed25519 signature is valid
 * 4. Signer's public key matches expected (if provided)
 *
 * @param message - Message with signature block
 * @param expectedPublicKey - Optional: expected signer's public key
 * @returns Message without signature if valid, null if invalid
 */
export function verifySignedMessage<T extends object>(
  message: SignedMessage<T>,
  expectedPublicKey?: Uint8Array
): T | null {
  const { signature, ...messageWithoutSig } = message;

  // Check signature block exists
  if (!signature || typeof signature !== "object") {
    return null;
  }

  // Validate signature block fields
  if (
    typeof signature.sig !== "string" ||
    typeof signature.pub !== "string" ||
    typeof signature.ts !== "number"
  ) {
    return null;
  }

  // Check timestamp is within acceptable drift
  const now = Date.now();
  const drift = Math.abs(now - signature.ts);
  if (drift > MAX_TIMESTAMP_DRIFT_MS) {
    return null;
  }

  // Decode signature and public key
  let signatureBytes: Uint8Array;
  let publicKeyBytes: Uint8Array;
  try {
    signatureBytes = new Uint8Array(Buffer.from(signature.sig, "base64"));
    publicKeyBytes = new Uint8Array(Buffer.from(signature.pub, "base64"));
  } catch {
    return null;
  }

  // Check lengths
  if (signatureBytes.length !== 64 || publicKeyBytes.length !== 32) {
    return null;
  }

  // Check expected public key matches (if provided)
  if (expectedPublicKey) {
    if (expectedPublicKey.length !== 32) {
      return null;
    }
    // Compare byte-by-byte
    for (let i = 0; i < 32; i++) {
      if (publicKeyBytes[i] !== expectedPublicKey[i]) {
        return null;
      }
    }
  }

  // Reconstruct canonical message for verification
  const msgWithTs = { ...messageWithoutSig, signature: { ts: signature.ts } };
  const canonical = canonicalize(msgWithTs);
  const messageBytes = new TextEncoder().encode(canonical);

  // Verify signature
  try {
    const valid = ed25519.verify(signatureBytes, messageBytes, publicKeyBytes);
    if (!valid) {
      return null;
    }
  } catch {
    return null;
  }

  return messageWithoutSig as T;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Check if a message has a signature block (without verifying)
 */
export function hasSignature<T extends object>(
  message: T
): message is T & { signature: SignatureBlock } {
  const msg = message as SignedMessage<T>;
  return (
    msg.signature !== undefined &&
    typeof msg.signature === "object" &&
    typeof msg.signature.sig === "string" &&
    typeof msg.signature.pub === "string" &&
    typeof msg.signature.ts === "number"
  );
}

/**
 * Extract public key from a signed message (without verifying)
 */
export function getSignerPublicKey(message: SignedMessage<object>): Uint8Array | null {
  if (!message.signature || typeof message.signature.pub !== "string") {
    return null;
  }
  try {
    const bytes = new Uint8Array(Buffer.from(message.signature.pub, "base64"));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}
