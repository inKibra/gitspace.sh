/**
 * Access control list management for managing authorized identities
 *
 * This module provides an in-memory access control list that can be serialized
 * to JSON for persistence. It manages which public keys are allowed to connect.
 *
 * Access types:
 * - 'full': Complete machine access (browse, create sessions, etc.)
 * - 'session-invite': View-only access to a specific session
 *
 * @module access-control
 */

import type {
  AccessEntry,
  AccessType,
  PublicIdentity,
} from "../../../types/identity.js";
import { verify, deriveIdentityId } from "./identity.js";

// ============================================================================
// Constants
// ============================================================================

/** Default access type for new entries via `gssh access add` */
export const DEFAULT_ACCESS_TYPE: AccessType = 'full';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if an access entry is expired
 *
 * @param entry - Access entry to check
 * @returns True if the entry has an expiry time and it has passed
 */
export function isAccessExpired(entry: AccessEntry): boolean {
  if (!entry.expiresAt) {
    return false;
  }
  return Date.now() >= entry.expiresAt;
}

// ============================================================================
// AccessControlList Class
// ============================================================================

/**
 * Manages the access control list for authorized identities
 *
 * This class maintains an in-memory map of identity IDs to access entries,
 * providing methods to add, remove, and check access. It also supports
 * signature verification to authenticate incoming connections.
 *
 * @example
 * ```typescript
 * const acl = new AccessControlList();
 *
 * // Add a new identity with full access
 * const entry = acl.addEntry(publicIdentity);
 *
 * // Add a session invite (view-only)
 * const invite = acl.addEntry(publicIdentity, 'session-invite', 'session-123');
 *
 * // Check access
 * if (acl.hasAccess(identityId)) {
 *   console.log('Access granted');
 * }
 *
 * // Verify signature and check access
 * const entry = acl.verifyAndCheckAccess(message, signature, publicKey);
 * if (entry) {
 *   console.log('Authenticated with access type:', entry.accessType);
 * }
 * ```
 */
export class AccessControlList {
  private entries: Map<string, AccessEntry> = new Map();

  /**
   * Add an identity to the access list
   *
   * Creates a new access entry with the given access type.
   * If the identity already exists, it will be replaced.
   *
   * @param publicIdentity - Public identity information to add
   * @param accessType - Access type to grant (default: 'full')
   * @param sessionId - For session-invite: the specific session ID
   * @returns The created access entry
   */
  addEntry(
    publicIdentity: PublicIdentity,
    accessType: AccessType = DEFAULT_ACCESS_TYPE,
    sessionId?: string
  ): AccessEntry {
    const entry: AccessEntry = {
      identityId: publicIdentity.id,
      signingPublicKey: publicIdentity.signingPublicKey,
      keyExchangePublicKey: publicIdentity.keyExchangePublicKey,
      label: publicIdentity.label,
      grantedAt: Date.now(),
      accessType,
      sessionId,
    };

    this.entries.set(publicIdentity.id, entry);
    return entry;
  }

  /**
   * Remove an identity from the access list
   *
   * @param identityId - Identity ID to remove
   * @returns True if the entry was removed, false if it didn't exist
   */
  removeEntry(identityId: string): boolean {
    return this.entries.delete(identityId);
  }

  /**
   * Check if an identity has access
   *
   * Checks if the identity exists in the access list and is not expired.
   *
   * @param identityId - Identity ID to check
   * @returns True if the identity has access and is not expired
   */
  hasAccess(identityId: string): boolean {
    const entry = this.entries.get(identityId);
    if (!entry) {
      return false;
    }
    return !isAccessExpired(entry);
  }

  /**
   * Check if an identity has full access
   *
   * @param identityId - Identity ID to check
   * @returns True if the identity has full access and is not expired
   */
  hasFullAccess(identityId: string): boolean {
    const entry = this.entries.get(identityId);
    if (!entry || isAccessExpired(entry)) {
      return false;
    }
    return entry.accessType === 'full';
  }

  /**
   * Check if an identity has access to a specific session
   *
   * @param identityId - Identity ID to check
   * @param sessionId - Session ID to check access for
   * @returns True if the identity has access (full or session-invite for this session)
   */
  hasSessionAccess(identityId: string, sessionId: string): boolean {
    const entry = this.entries.get(identityId);
    if (!entry || isAccessExpired(entry)) {
      return false;
    }
    // Full access can access any session
    if (entry.accessType === 'full') {
      return true;
    }
    // Session invite can only access the specific session
    return entry.accessType === 'session-invite' && entry.sessionId === sessionId;
  }

  /**
   * Get access entry by identity ID
   *
   * @param identityId - Identity ID to look up
   * @returns Access entry if found and not expired, undefined otherwise
   */
  getEntry(identityId: string): AccessEntry | undefined {
    const entry = this.entries.get(identityId);
    if (!entry || isAccessExpired(entry)) {
      return undefined;
    }
    return entry;
  }

  /**
   * Get all entries
   *
   * Returns all access entries, including expired ones. Use isAccessExpired()
   * to filter out expired entries if needed.
   *
   * @returns Array of all access entries
   */
  getAllEntries(): AccessEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Update access type for an identity
   *
   * @param identityId - Identity ID to update
   * @param accessType - New access type
   * @param sessionId - For session-invite: the specific session ID
   * @returns True if the entry was updated, false if it doesn't exist
   */
  updateAccessType(
    identityId: string,
    accessType: AccessType,
    sessionId?: string
  ): boolean {
    const entry = this.entries.get(identityId);
    if (!entry) {
      return false;
    }

    entry.accessType = accessType;
    entry.sessionId = sessionId;

    this.entries.set(identityId, entry);
    return true;
  }

  /**
   * Update label for an identity
   *
   * @param identityId - Identity ID to update
   * @param label - New label
   * @returns True if the entry was updated, false if it doesn't exist
   */
  updateLabel(identityId: string, label: string): boolean {
    const entry = this.entries.get(identityId);
    if (!entry) {
      return false;
    }

    entry.label = label;
    this.entries.set(identityId, entry);
    return true;
  }

  /**
   * Verify a signed message and check access
   *
   * This method:
   * 1. Derives the identity ID from the signing public key
   * 2. Verifies the signature is valid
   * 3. Checks if the identity has access
   * 4. Returns the access entry if all checks pass
   *
   * @param message - Message that was signed
   * @param signature - Signature to verify (64 bytes)
   * @param signingPublicKey - Ed25519 public key (32 bytes)
   * @returns AccessEntry if signature is valid and identity has access, null otherwise
   */
  verifyAndCheckAccess(
    message: Uint8Array,
    signature: Uint8Array,
    signingPublicKey: Uint8Array
  ): AccessEntry | null {
    // Verify signature
    if (!verify(message, signature, signingPublicKey)) {
      return null;
    }

    // Derive identity ID from public key
    const identityId = deriveIdentityId(signingPublicKey);

    // Check access
    const entry = this.getEntry(identityId);
    if (!entry) {
      return null;
    }

    return entry;
  }

  /**
   * Export access list for storage
   *
   * Returns all entries (including expired ones) as a JSON-serializable array.
   * This can be used to persist the access list to disk.
   *
   * @returns Array of access entries
   */
  export(): AccessEntry[] {
    return this.getAllEntries();
  }

  /**
   * Import access list from storage
   *
   * Replaces the current access list with the provided entries.
   * This will clear any existing entries.
   *
   * @param entries - Array of access entries to import
   */
  import(entries: AccessEntry[]): void {
    this.entries.clear();
    for (const entry of entries) {
      this.entries.set(entry.identityId, entry);
    }
  }

  /**
   * Clear all entries
   *
   * Removes all access entries from the list.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Get count of entries
   *
   * @returns Number of entries in the access list (including expired ones)
   */
  get size(): number {
    return this.entries.size;
  }
}
