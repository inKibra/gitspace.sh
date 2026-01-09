/**
 * Relay identity management
 *
 * The relay has its own Ed25519 identity for signing messages to machines.
 * Private key is stored in the OS keychain (or env var override).
 * Public identity is stored in ~/.gitspace/.relay/identity.json.
 *
 * Unlike machine identity, relay identity:
 * - Only uses Ed25519 signing (no X25519 key exchange - relay doesn't encrypt)
 * - No password encryption (uses keychain directly or env var)
 * - Used to sign control messages to machines
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { setSecret, getSecret } from "../utils/secrets.js";
import { getSpacesDir } from "../core/config.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Relay public identity (safe to share)
 */
export interface RelayPublicIdentity {
  /** Identity ID (derived from public key hash) */
  id: string;
  /** Ed25519 signing public key (base64) */
  signingPublicKey: string;
  /** Human-readable label */
  label?: string;
  /** When identity was created (Unix ms) */
  createdAt: number;
}

/**
 * Full relay identity with private key
 */
export interface RelayIdentity extends RelayPublicIdentity {
  /** Ed25519 signing private key (32 bytes) */
  signingPrivateKey: Uint8Array;
}

// ============================================================================
// Constants
// ============================================================================

/** Keychain key for relay private key */
const KEYCHAIN_KEY = "relay:signingPrivateKey";

/** Environment variable for private key override */
const ENV_PRIVATE_KEY = "RELAY_PRIVATE_KEY";

/** Identity file name */
const IDENTITY_FILENAME = "identity.json";

// ============================================================================
// Paths
// ============================================================================

/**
 * Get the relay directory path
 * @returns Path to ~/.gitspace/.relay/
 */
export function getRelayDir(): string {
  return join(getSpacesDir(), ".relay");
}

/**
 * Get the relay identity file path
 * @returns Path to ~/.gitspace/.relay/identity.json
 */
export function getRelayIdentityPath(): string {
  return join(getRelayDir(), IDENTITY_FILENAME);
}

/**
 * Ensure relay directory exists with proper permissions
 */
function ensureRelayDir(): void {
  const relayDir = getRelayDir();
  if (!existsSync(relayDir)) {
    mkdirSync(relayDir, { recursive: true, mode: 0o700 });
  }
}

// ============================================================================
// Fingerprint Formatting
// ============================================================================

/**
 * Format a public key as a human-readable fingerprint
 *
 * Takes first 16 characters of base64url-encoded hash and adds colons every 4 chars.
 * Example: "Kx4f:2nB9:mP3q:vR8s"
 *
 * @param publicKey - Base64 encoded Ed25519 public key
 * @returns Formatted fingerprint string
 */
export function formatRelayFingerprint(publicKey: string): string {
  // Decode public key and hash it
  const pubKeyBytes = Buffer.from(publicKey, "base64");
  const hash = sha256(pubKeyBytes);

  // Convert to base64url and take first 16 chars
  const b64url = Buffer.from(hash).toString("base64url").substring(0, 16);

  // Insert colons every 4 characters
  return b64url.match(/.{1,4}/g)?.join(":") || b64url;
}

/**
 * Compute identity ID from public key
 *
 * Uses first 22 characters of base64url-encoded hash.
 *
 * @param publicKey - Base64 encoded Ed25519 public key
 * @returns Identity ID string
 */
function computeIdentityId(publicKey: string): string {
  const pubKeyBytes = Buffer.from(publicKey, "base64");
  const hash = sha256(pubKeyBytes);
  return Buffer.from(hash).toString("base64url").substring(0, 22);
}

// ============================================================================
// Identity Operations
// ============================================================================

/**
 * Generate a new relay identity
 *
 * Creates Ed25519 keypair and returns the identity.
 * Does NOT save to disk - call saveRelayIdentity separately.
 *
 * @param label - Optional human-readable label
 * @returns New relay identity with private key
 */
export function generateRelayIdentity(label?: string): RelayIdentity {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  const publicKeyB64 = Buffer.from(publicKey).toString("base64");

  const id = computeIdentityId(publicKeyB64);

  return {
    id,
    signingPublicKey: publicKeyB64,
    signingPrivateKey: privateKey,
    label,
    createdAt: Date.now(),
  };
}

/**
 * Save relay identity to keychain and disk
 *
 * Private key goes to keychain, public identity to JSON file.
 *
 * @param identity - Relay identity to save
 */
export async function saveRelayIdentity(identity: RelayIdentity): Promise<void> {
  ensureRelayDir();

  // Save private key to keychain
  const privateKeyB64 = Buffer.from(identity.signingPrivateKey).toString("base64");
  await setSecret(KEYCHAIN_KEY, privateKeyB64);

  // Save public identity to disk
  const publicIdentity: RelayPublicIdentity = {
    id: identity.id,
    signingPublicKey: identity.signingPublicKey,
    label: identity.label,
    createdAt: identity.createdAt,
  };

  writeFileSync(
    getRelayIdentityPath(),
    JSON.stringify(publicIdentity, null, 2),
    { encoding: "utf-8", mode: 0o600 }
  );
}

/**
 * Load relay identity from keychain/env and disk
 *
 * Priority for private key:
 * 1. RELAY_PRIVATE_KEY env var (base64)
 * 2. Keychain via Bun.secrets
 *
 * @returns Relay identity if exists, null otherwise
 */
export async function loadRelayIdentity(): Promise<RelayIdentity | null> {
  const identityPath = getRelayIdentityPath();

  // Check if public identity file exists
  if (!existsSync(identityPath)) {
    return null;
  }

  // Load public identity from disk
  let publicIdentity: RelayPublicIdentity;
  try {
    const content = readFileSync(identityPath, "utf-8");
    publicIdentity = JSON.parse(content) as RelayPublicIdentity;
  } catch {
    console.warn("[relay] Failed to parse identity file");
    return null;
  }

  // Try to load private key from env var first
  let privateKeyB64: string | undefined = process.env[ENV_PRIVATE_KEY];
  let source = "env";

  if (!privateKeyB64) {
    // Fall back to keychain
    const keychainValue = await getSecret(KEYCHAIN_KEY);
    privateKeyB64 = keychainValue ?? undefined;
    source = "keychain";
  }

  if (!privateKeyB64) {
    console.warn("[relay] Public identity exists but private key not found");
    return null;
  }

  try {
    const privateKey = new Uint8Array(Buffer.from(privateKeyB64, "base64"));

    // Verify private key matches public key
    const derivedPublicKey = ed25519.getPublicKey(privateKey);
    const derivedPublicKeyB64 = Buffer.from(derivedPublicKey).toString("base64");

    if (derivedPublicKeyB64 !== publicIdentity.signingPublicKey) {
      console.warn(`[relay] Private key (${source}) does not match public identity`);
      return null;
    }

    return {
      ...publicIdentity,
      signingPrivateKey: privateKey,
    };
  } catch (err) {
    console.warn(`[relay] Failed to load private key from ${source}:`, err);
    return null;
  }
}

/**
 * Check if relay identity exists on disk
 */
export function relayIdentityExists(): boolean {
  return existsSync(getRelayIdentityPath());
}

/**
 * Get relay public identity without loading private key
 *
 * Safe to call without keychain access.
 *
 * @returns Public identity if exists, null otherwise
 */
export function getRelayPublicIdentity(): RelayPublicIdentity | null {
  const identityPath = getRelayIdentityPath();

  if (!existsSync(identityPath)) {
    return null;
  }

  try {
    const content = readFileSync(identityPath, "utf-8");
    return JSON.parse(content) as RelayPublicIdentity;
  } catch {
    return null;
  }
}

/**
 * Load or create relay identity
 *
 * If identity exists, loads it. Otherwise generates and saves a new one.
 * This is the main entry point for relay startup.
 *
 * @param label - Optional label for new identity
 * @returns Relay identity (loaded or newly created)
 */
export async function loadOrCreateRelayIdentity(label?: string): Promise<RelayIdentity> {
  // Try to load existing identity
  const existing = await loadRelayIdentity();
  if (existing) {
    console.log(`[relay] Loaded identity: ${formatRelayFingerprint(existing.signingPublicKey)}`);
    return existing;
  }

  // Check if we have env var private key but no identity file
  const envPrivateKey = process.env[ENV_PRIVATE_KEY];
  if (envPrivateKey) {
    try {
      const privateKey = new Uint8Array(Buffer.from(envPrivateKey, "base64"));
      const publicKey = ed25519.getPublicKey(privateKey);
      const publicKeyB64 = Buffer.from(publicKey).toString("base64");
      const id = computeIdentityId(publicKeyB64);

      const identity: RelayIdentity = {
        id,
        signingPublicKey: publicKeyB64,
        signingPrivateKey: privateKey,
        label,
        createdAt: Date.now(),
      };

      // Save public identity to disk (private key stays in env)
      ensureRelayDir();
      const publicIdentity: RelayPublicIdentity = {
        id: identity.id,
        signingPublicKey: identity.signingPublicKey,
        label: identity.label,
        createdAt: identity.createdAt,
      };
      writeFileSync(
        getRelayIdentityPath(),
        JSON.stringify(publicIdentity, null, 2),
        { encoding: "utf-8", mode: 0o600 }
      );

      console.log(`[relay] Created identity from env var: ${formatRelayFingerprint(publicKeyB64)}`);
      return identity;
    } catch (err) {
      console.warn("[relay] Failed to use RELAY_PRIVATE_KEY:", err);
    }
  }

  // Generate new identity
  const identity = generateRelayIdentity(label);
  await saveRelayIdentity(identity);

  console.log(`[relay] Generated new identity: ${formatRelayFingerprint(identity.signingPublicKey)}`);
  return identity;
}

/**
 * Get relay public key as Uint8Array (for signature verification)
 *
 * @param identity - Relay public identity
 * @returns Public key bytes
 */
export function getRelayPublicKeyBytes(identity: RelayPublicIdentity): Uint8Array {
  return new Uint8Array(Buffer.from(identity.signingPublicKey, "base64"));
}
