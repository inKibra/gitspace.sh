/**
 * Access control list management
 * Provides file-based storage and management of authorized identities
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import type { AccessEntry, AccessType, PublicIdentity } from '../types/identity.js';
import { deriveIdentityId } from '../lib/tmux-lite/crypto/identity.js';
import { getSpacesDir } from './config.js';
import { SpacesError } from '../types/errors.js';

/**
 * Get the access list file path
 */
export function getAccessListPath(): string {
  return join(getSpacesDir(), '.access.json');
}

/**
 * Read the access list from disk
 * @returns Array of access entries
 */
export function readAccessList(): AccessEntry[] {
  const accessPath = getAccessListPath();

  if (!existsSync(accessPath)) {
    return [];
  }

  try {
    const content = readFileSync(accessPath, 'utf-8');
    return JSON.parse(content) as AccessEntry[];
  } catch (error) {
    throw new SpacesError(
      `Failed to read access list: ${error instanceof Error ? error.message : String(error)}`,
      'SYSTEM_ERROR',
      2
    );
  }
}

/**
 * Write the access list to disk
 * @param entries - Array of access entries to write
 */
export function writeAccessList(entries: AccessEntry[]): void {
  const accessPath = getAccessListPath();
  const spacesDir = dirname(accessPath);

  // Ensure spaces directory exists
  if (!existsSync(spacesDir)) {
    mkdirSync(spacesDir, { recursive: true });
  }

  try {
    writeFileSync(accessPath, JSON.stringify(entries, null, 2), 'utf-8');
    chmodSync(accessPath, 0o600);
  } catch (error) {
    throw new SpacesError(
      `Failed to write access list: ${error instanceof Error ? error.message : String(error)}`,
      'SYSTEM_ERROR',
      2
    );
  }
}

/**
 * Add a new access entry
 * @param publicIdentity - Public identity to add
 * @param label - Human-readable label
 * @param accessType - Access type to grant (default: 'full')
 * @param sessionId - For session-invite: the specific session ID
 * @returns The created access entry
 */
export function addAccess(
  publicIdentity: PublicIdentity,
  label?: string,
  accessType: AccessType = 'full',
  sessionId?: string
): AccessEntry {
  const entries = readAccessList();

  // Check if identity already exists
  const existingIndex = entries.findIndex(
    (e) => e.identityId === publicIdentity.id
  );

  const entry: AccessEntry = {
    identityId: publicIdentity.id,
    signingPublicKey: publicIdentity.signingPublicKey,
    keyExchangePublicKey: publicIdentity.keyExchangePublicKey,
    label: label || publicIdentity.label,
    grantedAt: Date.now(),
    accessType,
    sessionId,
  };

  if (existingIndex >= 0) {
    // Replace existing entry
    entries[existingIndex] = entry;
  } else {
    // Add new entry
    entries.push(entry);
  }

  writeAccessList(entries);
  return entry;
}

/**
 * Remove an access entry by identity ID or label
 * @param identityIdOrLabel - Identity ID (full or prefix) or label (case-insensitive)
 * @returns The removed entry, or null if not found
 */
export function removeAccess(identityIdOrLabel: string): AccessEntry | null {
  const entries = readAccessList();
  const searchTerm = identityIdOrLabel.toLowerCase();

  // Try to find by identity ID prefix or exact label match
  const index = entries.findIndex((e) => {
    const matchesId = e.identityId.toLowerCase().startsWith(searchTerm);
    const matchesLabel = e.label?.toLowerCase() === searchTerm;
    return matchesId || matchesLabel;
  });

  if (index < 0) {
    return null;
  }

  const removed = entries[index];
  entries.splice(index, 1);
  writeAccessList(entries);

  return removed;
}

/**
 * Get an access entry by identity ID or label
 * @param identityIdOrLabel - Identity ID (full or prefix) or label (case-insensitive)
 * @returns The access entry, or null if not found
 */
export function getAccessEntry(identityIdOrLabel: string): AccessEntry | null {
  const entries = readAccessList();
  const searchTerm = identityIdOrLabel.toLowerCase();

  // Try to find by identity ID prefix or exact label match
  return (
    entries.find((e) => {
      const matchesId = e.identityId.toLowerCase().startsWith(searchTerm);
      const matchesLabel = e.label?.toLowerCase() === searchTerm;
      return matchesId || matchesLabel;
    }) || null
  );
}

/**
 * Parse a public key string
 * Supports formats:
 * - Full format: gssh-pub:SIGNING_KEY:KEYEXCHANGE_KEY
 * - Just signing key: BASE64_SIGNING_KEY
 *
 * @param pubkeyString - Public key string to parse
 * @returns Public identity
 * @throws {SpacesError} If format is invalid
 */
export function parsePublicKey(pubkeyString: string): PublicIdentity {
  const trimmed = pubkeyString.trim();

  if (trimmed.startsWith('gssh-pub:')) {
    // Full format: gssh-pub:SIGNING_KEY:KEYEXCHANGE_KEY
    const parts = trimmed.split(':');
    if (parts.length !== 3) {
      throw new SpacesError(
        'Invalid public key format. Expected: gssh-pub:SIGNING_KEY:KEYEXCHANGE_KEY',
        'USER_ERROR',
        1
      );
    }

    const [, signingKey, keyExchangeKey] = parts;

    // Validate base64
    if (!isValidBase64(signingKey) || !isValidBase64(keyExchangeKey)) {
      throw new SpacesError(
        'Invalid base64 encoding in public key',
        'USER_ERROR',
        1
      );
    }

    // Derive identity ID from signing key
    try {
      const signingPublicKey = Buffer.from(signingKey, 'base64');
      if (signingPublicKey.length !== 32) {
        throw new Error('Signing key must be 32 bytes');
      }

      const identityId = deriveIdentityId(new Uint8Array(signingPublicKey));

      return {
        id: identityId,
        signingPublicKey: signingKey,
        keyExchangePublicKey: keyExchangeKey,
      };
    } catch (error) {
      throw new SpacesError(
        `Failed to parse public key: ${error instanceof Error ? error.message : String(error)}`,
        'USER_ERROR',
        1
      );
    }
  } else {
    // Just signing key format: BASE64_SIGNING_KEY
    if (!isValidBase64(trimmed)) {
      throw new SpacesError(
        'Invalid base64 encoding in public key',
        'USER_ERROR',
        1
      );
    }

    try {
      const signingPublicKey = Buffer.from(trimmed, 'base64');
      if (signingPublicKey.length !== 32) {
        throw new SpacesError(
          'Signing key must be 32 bytes (expected ~43 characters in base64)',
          'USER_ERROR',
          1
        );
      }

      const identityId = deriveIdentityId(new Uint8Array(signingPublicKey));

      return {
        id: identityId,
        signingPublicKey: trimmed,
        keyExchangePublicKey: '', // Will need to be provided separately
      };
    } catch (error) {
      throw new SpacesError(
        `Failed to parse signing key: ${error instanceof Error ? error.message : String(error)}`,
        'USER_ERROR',
        1
      );
    }
  }
}

/**
 * Check if a string is valid base64 or base64url
 */
function isValidBase64(str: string): boolean {
  // Match standard base64 or base64url (with - and _ instead of + and /)
  return /^[A-Za-z0-9+/\-_]*={0,2}$/.test(str) && str.length > 0;
}

/**
 * Format an access entry's fingerprint for display
 * Shows first 12 chars of identity ID
 */
export function formatFingerprint(identityId: string): string {
  return identityId.slice(0, 12) + '...';
}

/**
 * Format access type for display
 */
export function formatAccessType(accessType: AccessType, sessionId?: string): string {
  if (accessType === 'full') {
    return 'full access';
  }
  if (sessionId) {
    return `session invite (${sessionId})`;
  }
  return 'session invite';
}
