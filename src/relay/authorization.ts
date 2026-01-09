/**
 * Relay machine authorization
 *
 * Manages the list of machines authorized to connect to this relay.
 * Machines are identified by their public keys (spaces-pub format).
 *
 * Storage: ~/.gitspace/.relay/authorized-machines.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { getRelayDir } from "./identity.js";

// ============================================================================
// Types
// ============================================================================

/**
 * An authorized machine entry
 */
export interface AuthorizedMachine {
  /** Ed25519 signing public key (base64) */
  signingKey: string;
  /** X25519 key exchange public key (base64) */
  keyExchangeKey: string;
  /** Human-readable fingerprint */
  fingerprint: string;
  /** Optional label */
  label?: string;
  /** When authorization was granted (Unix ms) */
  authorizedAt: number;
}

// ============================================================================
// Constants
// ============================================================================

const AUTHORIZED_MACHINES_FILE = "authorized-machines.json";

// ============================================================================
// Paths
// ============================================================================

/**
 * Get path to authorized machines file
 */
function getAuthorizedMachinesPath(): string {
  return join(getRelayDir(), AUTHORIZED_MACHINES_FILE);
}

/**
 * Ensure relay directory exists
 */
function ensureRelayDir(): void {
  const relayDir = getRelayDir();
  if (!existsSync(relayDir)) {
    mkdirSync(relayDir, { recursive: true, mode: 0o700 });
  }
}

// ============================================================================
// Fingerprint / ID Computation
// ============================================================================

/**
 * Compute fingerprint from signing public key
 *
 * Format: "Kx4f:2nB9:mP3q:vR8s" (16 chars with colons)
 */
export function computeMachineFingerprint(signingKey: string): string {
  const keyBytes = Buffer.from(signingKey, "base64");
  const hash = sha256(keyBytes);
  const b64url = Buffer.from(hash).toString("base64url").substring(0, 16);
  return b64url.match(/.{1,4}/g)?.join(":") || b64url;
}

// ============================================================================
// spaces-pub Format Parsing
// ============================================================================

/**
 * Parsed spaces-pub key
 */
export interface ParsedSpacesPubKey {
  signingKey: string;
  keyExchangeKey: string;
}

/**
 * Parse a gssh-pub:SIGNING:KEYEXCHANGE format key
 *
 * @param spacesPubKey - Key in format "gssh-pub:BASE64_SIGNING:BASE64_KEYEXCHANGE"
 * @returns Parsed keys or null if invalid format
 */
export function parseSpacesPubKey(spacesPubKey: string): ParsedSpacesPubKey | null {
  const prefix = "gssh-pub:";

  if (!spacesPubKey.startsWith(prefix)) {
    return null;
  }

  const keysStr = spacesPubKey.slice(prefix.length);
  const parts = keysStr.split(":");

  if (parts.length !== 2) {
    return null;
  }

  const [signingKey, keyExchangeKey] = parts;

  // Validate base64 format (basic check)
  try {
    const signingBytes = Buffer.from(signingKey, "base64");
    const keyExchangeBytes = Buffer.from(keyExchangeKey, "base64");

    // Ed25519 public key should be 32 bytes
    if (signingBytes.length !== 32) {
      return null;
    }

    // X25519 public key should be 32 bytes
    if (keyExchangeBytes.length !== 32) {
      return null;
    }
  } catch {
    return null;
  }

  return { signingKey, keyExchangeKey };
}

/**
 * Format keys as spaces-pub format
 */
export function formatSpacesPubKey(signingKey: string, keyExchangeKey: string): string {
  return `gssh-pub:${signingKey}:${keyExchangeKey}`;
}

// ============================================================================
// Storage Operations
// ============================================================================

/**
 * Load authorized machines from disk
 */
export function getAuthorizedMachines(): AuthorizedMachine[] {
  const path = getAuthorizedMachinesPath();

  if (!existsSync(path)) {
    return [];
  }

  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as AuthorizedMachine[];
  } catch {
    console.warn("[relay] Failed to parse authorized machines file");
    return [];
  }
}

/**
 * Save authorized machines to disk
 */
function saveAuthorizedMachines(machines: AuthorizedMachine[]): void {
  ensureRelayDir();

  writeFileSync(
    getAuthorizedMachinesPath(),
    JSON.stringify(machines, null, 2),
    { encoding: "utf-8", mode: 0o600 }
  );
}

// ============================================================================
// Authorization Management
// ============================================================================

/**
 * Add a machine to the authorized list
 *
 * @param spacesPubKey - Key in gssh-pub:SIGNING:KEYEXCHANGE format
 * @param label - Optional human-readable label
 * @returns The created entry, or null if key format is invalid
 */
export function addAuthorizedMachine(
  spacesPubKey: string,
  label?: string
): AuthorizedMachine | null {
  const parsed = parseSpacesPubKey(spacesPubKey);

  if (!parsed) {
    return null;
  }

  const machines = getAuthorizedMachines();

  // Check if already exists
  const existing = machines.find((m) => m.signingKey === parsed.signingKey);
  if (existing) {
    // Update existing entry
    existing.keyExchangeKey = parsed.keyExchangeKey;
    existing.label = label ?? existing.label;
    saveAuthorizedMachines(machines);
    return existing;
  }

  // Create new entry
  const entry: AuthorizedMachine = {
    signingKey: parsed.signingKey,
    keyExchangeKey: parsed.keyExchangeKey,
    fingerprint: computeMachineFingerprint(parsed.signingKey),
    label,
    authorizedAt: Date.now(),
  };

  machines.push(entry);
  saveAuthorizedMachines(machines);

  return entry;
}

/**
 * Remove a machine from the authorized list
 *
 * @param fingerprintOrLabel - Fingerprint or label to match
 * @returns The removed entry, or null if not found
 */
export function removeAuthorizedMachine(
  fingerprintOrLabel: string
): AuthorizedMachine | null {
  const machines = getAuthorizedMachines();
  const searchLower = fingerprintOrLabel.toLowerCase();

  const index = machines.findIndex((m) => {
    const fingerprintLower = m.fingerprint.toLowerCase();
    const labelLower = m.label?.toLowerCase();

    return (
      fingerprintLower === searchLower ||
      fingerprintLower.startsWith(searchLower) ||
      labelLower === searchLower
    );
  });

  if (index === -1) {
    return null;
  }

  const [removed] = machines.splice(index, 1);
  saveAuthorizedMachines(machines);

  return removed;
}

/**
 * Check if a machine is authorized by its signing key
 *
 * @param signingKey - Base64 Ed25519 public key
 * @returns true if authorized
 */
export function isAuthorized(signingKey: string): boolean {
  const machines = getAuthorizedMachines();
  return machines.some((m) => m.signingKey === signingKey);
}

/**
 * Get an authorized machine by its signing key
 *
 * @param signingKey - Base64 Ed25519 public key
 * @returns The machine entry if found, null otherwise
 */
export function getAuthorizedMachine(signingKey: string): AuthorizedMachine | null {
  const machines = getAuthorizedMachines();
  return machines.find((m) => m.signingKey === signingKey) ?? null;
}

/**
 * Get an authorized machine by fingerprint or label
 *
 * @param fingerprintOrLabel - Fingerprint (or prefix) or label to match
 * @returns The machine entry if found, null otherwise
 */
export function findAuthorizedMachine(
  fingerprintOrLabel: string
): AuthorizedMachine | null {
  const machines = getAuthorizedMachines();
  const searchLower = fingerprintOrLabel.toLowerCase();

  return (
    machines.find((m) => {
      const fingerprintLower = m.fingerprint.toLowerCase();
      const labelLower = m.label?.toLowerCase();

      return (
        fingerprintLower === searchLower ||
        fingerprintLower.startsWith(searchLower) ||
        labelLower === searchLower
      );
    }) ?? null
  );
}
