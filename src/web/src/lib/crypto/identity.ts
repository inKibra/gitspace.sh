/**
 * Browser-compatible identity generation using noble-curves
 */

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import type { Identity, StoredIdentity, SigningKeypair, KeyExchangeKeypair } from "../../types/identity";

const IDENTITY_ID_LENGTH = 16;

/**
 * Generate a new Ed25519 signing keypair
 */
export function generateSigningKeypair(): SigningKeypair {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);

  // Ed25519 convention: secretKey = privateKey (32 bytes) + publicKey (32 bytes)
  const secretKey = new Uint8Array(64);
  secretKey.set(privateKey, 0);
  secretKey.set(publicKey, 32);

  return { publicKey, secretKey };
}

/**
 * Generate a new X25519 key exchange keypair
 */
export function generateKeyExchangeKeypair(): KeyExchangeKeypair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);

  return { publicKey, privateKey };
}

/**
 * Derive identity ID from signing public key
 */
export function deriveIdentityId(signingPublicKey: Uint8Array): string {
  // Use base64url encoding
  const base64 = btoa(String.fromCharCode(...signingPublicKey))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return base64.slice(0, IDENTITY_ID_LENGTH);
}

/**
 * Generate a complete identity
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

/**
 * Sign a message using Ed25519
 */
export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const privateKey = secretKey.slice(0, 32);
  return ed25519.sign(message, privateKey);
}

/**
 * Verify an Ed25519 signature
 */
export function verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Export identity as a public key string for use with `gssh access add`
 * Format: gssh-pub:SIGNING_KEY:KEYEXCHANGE_KEY (base64)
 */
export function exportPublicKey(identity: Identity): string {
  const signingKey = btoa(String.fromCharCode(...identity.signing.publicKey));
  const keyExchangeKey = btoa(String.fromCharCode(...identity.keyExchange.publicKey));
  return `gssh-pub:${signingKey}:${keyExchangeKey}`;
}

/**
 * Serialize identity for storage
 */
export function serializeIdentity(identity: Identity): StoredIdentity {
  return {
    id: identity.id,
    signingPublicKey: btoa(String.fromCharCode(...identity.signing.publicKey)),
    signingSecretKey: btoa(String.fromCharCode(...identity.signing.secretKey)),
    keyExchangePublicKey: btoa(String.fromCharCode(...identity.keyExchange.publicKey)),
    keyExchangePrivateKey: btoa(String.fromCharCode(...identity.keyExchange.privateKey)),
    label: identity.label,
    createdAt: identity.createdAt,
  };
}

/**
 * Deserialize identity from storage
 */
export function deserializeIdentity(stored: StoredIdentity): Identity {
  const signingPublicKey = Uint8Array.from(atob(stored.signingPublicKey), c => c.charCodeAt(0));
  const signingSecretKey = Uint8Array.from(atob(stored.signingSecretKey), c => c.charCodeAt(0));
  const keyExchangePublicKey = Uint8Array.from(atob(stored.keyExchangePublicKey), c => c.charCodeAt(0));
  const keyExchangePrivateKey = Uint8Array.from(atob(stored.keyExchangePrivateKey), c => c.charCodeAt(0));

  return {
    id: stored.id,
    signing: { publicKey: signingPublicKey, secretKey: signingSecretKey },
    keyExchange: { publicKey: keyExchangePublicKey, privateKey: keyExchangePrivateKey },
    label: stored.label,
    createdAt: stored.createdAt,
  };
}
