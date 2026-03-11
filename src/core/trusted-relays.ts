/**
 * Trusted relay management
 *
 * Manages the list of relays this machine trusts for remote connections.
 * Relays are identified by their URL and Ed25519 public key.
 *
 * Storage: ~/.gitspace/.identity/trusted-relays.json
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { getIdentityDir } from "./identity.js";

// ============================================================================
// Types
// ============================================================================

/**
 * A trusted relay entry
 */
export interface TrustedRelay {
  /** Relay WebSocket URL (e.g., wss://relay.example.com) */
  url: string;
  /** Ed25519 signing public key (base64) */
  publicKey: string;
  /** Human-readable fingerprint */
  fingerprint: string;
  /** Optional label from relay */
  label?: string;
  /** When trust was established (Unix ms) */
  trustedAt: number;
}

/**
 * Result of checking relay trust status
 */
export type RelayTrustStatus = "trusted" | "mismatch" | "unknown";

// ============================================================================
// Constants
// ============================================================================

const TRUSTED_RELAYS_FILE = "trusted-relays.json";

// ============================================================================
// Paths
// ============================================================================

/**
 * Get path to trusted relays file
 */
function getTrustedRelaysPath(): string {
  return join(getIdentityDir(), TRUSTED_RELAYS_FILE);
}

// ============================================================================
// Fingerprint Computation
// ============================================================================

/**
 * Compute fingerprint from relay public key
 *
 * Format: "Kx4f:2nB9:mP3q:vR8s" (16 chars with colons)
 */
export function computeRelayFingerprint(publicKey: string): string {
  const keyBytes = Buffer.from(publicKey, "base64");
  const hash = sha256(keyBytes);
  const b64url = Buffer.from(hash).toString("base64url").substring(0, 16);
  return b64url.match(/.{1,4}/g)?.join(":") || b64url;
}

// ============================================================================
// URL Normalization
// ============================================================================

/**
 * Normalize a relay URL for consistent comparison
 *
 * Removes trailing slashes and normalizes protocol
 */
function normalizeUrl(url: string): string {
  // Normalize the URL
  let normalized = url.toLowerCase().trim();

  // Remove trailing slashes
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  // Normalize ws:// to wss:// for non-localhost
  if (normalized.startsWith("ws://") && !isLocalhostUrl(normalized)) {
    normalized = "wss://" + normalized.slice(5);
  }

  return normalized;
}

/**
 * Check if URL is localhost
 */
function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").split("%", 1)[0] ?? host.toLowerCase();
}

function isPrivateIpv4Host(host: string): boolean {
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function isPrivateIpv6Host(host: string): boolean {
  if (host === "::1") {
    return true;
  }

  if (host.startsWith("::ffff:")) {
    const mappedIpv4 = host.slice("::ffff:".length);
    return isPrivateIpv4Host(mappedIpv4);
  }

  return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

export function isCloudReachableRelayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = normalizeHost(parsed.hostname);

    if (host === "localhost" || host.endsWith(".local")) {
      return false;
    }

    const ipVersion = isIP(host);
    if (ipVersion === 4) {
      return !isPrivateIpv4Host(host);
    }

    if (ipVersion === 6) {
      return !isPrivateIpv6Host(host);
    }

    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Storage Operations
// ============================================================================

/**
 * Load trusted relays from disk
 */
export function getTrustedRelays(): TrustedRelay[] {
  const path = getTrustedRelaysPath();

  if (!existsSync(path)) {
    return [];
  }

  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as TrustedRelay[];
  } catch {
    console.warn("[trusted-relays] Failed to parse trusted relays file");
    return [];
  }
}

/**
 * Save trusted relays to disk
 */
function saveTrustedRelays(relays: TrustedRelay[]): void {
  const identityDir = getIdentityDir();

  // Create directory if needed (should already exist from identity setup)
  if (!existsSync(identityDir)) {
    const { mkdirSync } = require("node:fs");
    mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  }

  writeFileSync(
    getTrustedRelaysPath(),
    JSON.stringify(relays, null, 2),
    { encoding: "utf-8", mode: 0o600 }
  );
}

// ============================================================================
// Trust Management
// ============================================================================

/**
 * Add a relay to the trusted list
 *
 * If the URL already exists, updates the public key and label.
 *
 * @param url - Relay WebSocket URL
 * @param publicKey - Ed25519 public key (base64)
 * @param label - Optional relay label
 * @returns The created/updated entry
 */
export function addTrustedRelay(
  url: string,
  publicKey: string,
  label?: string
): TrustedRelay {
  const relays = getTrustedRelays();
  const normalizedUrl = normalizeUrl(url);

  // Check if already exists by URL
  const existing = relays.find((r) => normalizeUrl(r.url) === normalizedUrl);

  if (existing) {
    // Update existing entry
    existing.publicKey = publicKey;
    existing.fingerprint = computeRelayFingerprint(publicKey);
    existing.label = label ?? existing.label;
    existing.trustedAt = Date.now();
    saveTrustedRelays(relays);
    return existing;
  }

  // Create new entry
  const entry: TrustedRelay = {
    url: normalizedUrl,
    publicKey,
    fingerprint: computeRelayFingerprint(publicKey),
    label,
    trustedAt: Date.now(),
  };

  relays.push(entry);
  saveTrustedRelays(relays);

  return entry;
}

/**
 * Remove a relay from the trusted list
 *
 * @param urlOrFingerprint - URL or fingerprint (or prefix) to match
 * @returns The removed entry, or null if not found
 */
export function removeTrustedRelay(
  urlOrFingerprint: string
): TrustedRelay | null {
  const relays = getTrustedRelays();
  const searchLower = urlOrFingerprint.toLowerCase();

  const index = relays.findIndex((r) => {
    const urlLower = normalizeUrl(r.url);
    const fingerprintLower = r.fingerprint.toLowerCase();
    const labelLower = r.label?.toLowerCase();

    return (
      urlLower === searchLower ||
      urlLower.includes(searchLower) ||
      fingerprintLower === searchLower ||
      fingerprintLower.startsWith(searchLower) ||
      labelLower === searchLower
    );
  });

  if (index === -1) {
    return null;
  }

  const [removed] = relays.splice(index, 1);
  saveTrustedRelays(relays);

  return removed;
}

/**
 * Get a trusted relay by URL
 *
 * @param url - Relay WebSocket URL
 * @returns The relay entry if found, null otherwise
 */
export function getTrustedRelay(url: string): TrustedRelay | null {
  const relays = getTrustedRelays();
  const normalizedUrl = normalizeUrl(url);

  return relays.find((r) => normalizeUrl(r.url) === normalizedUrl) ?? null;
}

/**
 * Find a trusted relay by fingerprint or label
 *
 * @param fingerprintOrLabel - Fingerprint (or prefix) or label to match
 * @returns The relay entry if found, null otherwise
 */
export function findTrustedRelay(
  fingerprintOrLabel: string
): TrustedRelay | null {
  const relays = getTrustedRelays();
  const searchLower = fingerprintOrLabel.toLowerCase();

  return (
    relays.find((r) => {
      const fingerprintLower = r.fingerprint.toLowerCase();
      const labelLower = r.label?.toLowerCase();

      return (
        fingerprintLower === searchLower ||
        fingerprintLower.startsWith(searchLower) ||
        labelLower === searchLower
      );
    }) ?? null
  );
}

/**
 * Check if a relay is trusted
 *
 * @param url - Relay WebSocket URL
 * @param publicKey - Ed25519 public key (base64) from relay
 * @returns Trust status: 'trusted', 'mismatch', or 'unknown'
 */
export function isRelayTrusted(
  url: string,
  publicKey: string
): RelayTrustStatus {
  // Localhost is always auto-trusted
  if (isLocalhostUrl(url)) {
    return "trusted";
  }

  const trustedRelay = getTrustedRelay(url);

  if (!trustedRelay) {
    return "unknown";
  }

  // Check if public key matches
  if (trustedRelay.publicKey === publicKey) {
    return "trusted";
  }

  // URL known but key doesn't match - SECURITY WARNING
  return "mismatch";
}

/**
 * Check if a URL is localhost (for auto-trust)
 */
export function isLocalhost(url: string): boolean {
  return isLocalhostUrl(url);
}
