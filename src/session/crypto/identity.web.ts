/**
 * Browser-compatible identity generation using noble-curves
 */

import { generateMnemonic as bip39GenerateMnemonic, mnemonicToSeedSync, validateMnemonic as bip39ValidateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type {
  DeviceCertificate,
  Identity,
  StoredIdentity,
  SigningKeypair,
  KeyExchangeKeypair,
} from "../../types/identity";

const IDENTITY_ID_LENGTH = 16;
const CERT_DOMAIN = new TextEncoder().encode("gitspace-device-cert-v1");
const HKDF_SALT = new TextEncoder().encode('gitspace');
const HKDF_INFO_SIGNING = new TextEncoder().encode('user-signing');
const HKDF_INFO_KEYEXCHANGE = new TextEncoder().encode('user-keyexchange');
const KEY_LENGTH = 32;
const DEVICE_CERT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function buildDeviceCertPayload(
  deviceSigningPublicKey: Uint8Array,
  deviceKeyExchangePublicKey: Uint8Array,
  issuedAt: number,
  expiresAt: number,
): Uint8Array {
  const timestampBytes = new Uint8Array(16);
  const view = new DataView(timestampBytes.buffer);
  view.setBigUint64(0, BigInt(issuedAt), false);
  view.setBigUint64(8, BigInt(expiresAt), false);

  const payload = new Uint8Array(CERT_DOMAIN.length + 32 + 32 + 16);
  let offset = 0;
  payload.set(CERT_DOMAIN, offset);
  offset += CERT_DOMAIN.length;
  payload.set(deviceSigningPublicKey, offset);
  offset += 32;
  payload.set(deviceKeyExchangePublicKey, offset);
  offset += 32;
  payload.set(timestampBytes, offset);

  return payload;
}

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
 * Generate a new 24-word BIP39 mnemonic.
 */
export function generateMnemonic(): string {
  return bip39GenerateMnemonic(wordlist, 256);
}

/**
 * Normalize mnemonic input (trim + lowercase + single spaces).
 */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Validate a BIP39 mnemonic string.
 */
export function isValidMnemonic(mnemonic: string): boolean {
  return bip39ValidateMnemonic(normalizeMnemonic(mnemonic), wordlist);
}

/**
 * Derive deterministic user-root identity from a BIP39 mnemonic.
 */
export function deriveIdentityFromMnemonic(mnemonic: string, label?: string): Identity {
  const normalized = normalizeMnemonic(mnemonic);
  if (!bip39ValidateMnemonic(normalized, wordlist)) {
    throw new Error('Invalid BIP39 mnemonic');
  }

  const seed = mnemonicToSeedSync(normalized);

  const signingPrivateKey = hkdf(sha256, seed, HKDF_SALT, HKDF_INFO_SIGNING, KEY_LENGTH);
  const signingPublicKey = ed25519.getPublicKey(signingPrivateKey);
  const signingSecretKey = new Uint8Array(64);
  signingSecretKey.set(signingPrivateKey, 0);
  signingSecretKey.set(signingPublicKey, 32);

  const keyExchangePrivateKey = hkdf(sha256, seed, HKDF_SALT, HKDF_INFO_KEYEXCHANGE, KEY_LENGTH);
  const keyExchangePublicKey = x25519.getPublicKey(keyExchangePrivateKey);

  return {
    id: deriveIdentityId(signingPublicKey),
    signing: {
      publicKey: signingPublicKey,
      secretKey: signingSecretKey,
    },
    keyExchange: {
      publicKey: keyExchangePublicKey,
      privateKey: keyExchangePrivateKey,
    },
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
 * Export identity as a user-root public key string.
 * Format: gssh-user:BASE64_SIGNING_KEY
 */
export function exportUserRootPublicKey(identity: Identity): string {
  return `gssh-user:${bytesToBase64(identity.signing.publicKey)}`;
}

/**
 * Create a serialized device certificate for browser clients.
 *
 * Browser owner auth uses a user-root identity derived from mnemonic.
 * This signs the browser device keypair and applies a 90-day expiry.
 */
export function createSelfSignedDeviceCertificate(identity: Identity): string {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + DEVICE_CERT_TTL_MS;
  const payload = buildDeviceCertPayload(
    identity.signing.publicKey,
    identity.keyExchange.publicKey,
    issuedAt,
    expiresAt,
  );
  const signature = sign(payload, identity.signing.secretKey);

  const cert: DeviceCertificate = {
    deviceSigningPublicKey: bytesToBase64(identity.signing.publicKey),
    deviceKeyExchangePublicKey: bytesToBase64(identity.keyExchange.publicKey),
    userRootSigningPublicKey: bytesToBase64(identity.signing.publicKey),
    signature: bytesToBase64(signature),
    issuedAt,
    expiresAt,
  };

  return JSON.stringify(cert);
}

/**
 * Serialize identity for storage
 */
export function serializeIdentity(identity: Identity): StoredIdentity {
  return {
    id: identity.id,
    signingPublicKey: bytesToBase64(identity.signing.publicKey),
    signingSecretKey: bytesToBase64(identity.signing.secretKey),
    keyExchangePublicKey: bytesToBase64(identity.keyExchange.publicKey),
    keyExchangePrivateKey: bytesToBase64(identity.keyExchange.privateKey),
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
