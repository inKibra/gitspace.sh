/**
 * Relay Vault — encrypted persistent storage for machine unlock keys
 *
 * The vault protects machine unlock keys at rest using a vault key derived
 * from the owner's user root private key. The relay starts in "locked" mode
 * after restart — all encrypted data is opaque until the owner authenticates
 * from any device and the vault key is derived and held in memory.
 *
 * Flow:
 * 1. Owner initializes vault: `initializeVault(userRootPrivateKey)`
 *    - Generates random vault salt, stores in vault_meta
 *    - Derives vault key via HKDF(privateKey, salt, "gssh-vault-v1")
 *    - Encrypts a known plaintext as key_check for future unlock verification
 *
 * 2. On relay restart: vault is "locked" (vaultKey is null)
 *
 * 3. Owner unlocks vault: `unlockVault(userRootPrivateKey)`
 *    - Re-derives vault key from stored salt
 *    - Verifies against key_check
 *    - Holds vault key in memory
 *
 * 4. Machine unlock: `sealMachineUnlockKey(machineId, unlockKey)` / `openMachineUnlockKey(machineId)`
 *    - Encrypts/decrypts random unlock key using vault key + AES-256-GCM
 *    - Stored in vault_machine_unlock_keys table
 */

import { createHash, randomBytes } from 'node:crypto';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { seal, open } from '../lib/tmux-lite/crypto/secretbox.js';
import {
  getVaultCategory,
  getVaultMeta,
  setVaultMeta,
  isVaultInitialized,
  listVaultCategories,
  removeVaultCategory,
  setVaultMachineUnlockKey,
  getVaultMachineUnlockKey,
  removeVaultMachineUnlockKey,
  listVaultMachineUnlockKeys,
  upsertVaultCategory,
} from './control/store.js';
import type { VaultCategoryRecord, VaultLockState, VaultSyncCategory } from './control/types.js';

// ============================================================================
// Constants
// ============================================================================

/** HKDF info string for vault key derivation */
const VAULT_KEY_INFO = 'gssh-vault-v1';

/** Vault key length (32 bytes for AES-256-GCM) */
const VAULT_KEY_LENGTH = 32;

/** Salt length for vault key derivation */
const VAULT_SALT_LENGTH = 32;

/** Known plaintext used for key verification */
const VAULT_KEY_CHECK_PLAINTEXT = 'gssh-vault-key-check-v1';

/** Machine unlock key length (32 bytes of randomness) */
export const MACHINE_UNLOCK_KEY_LENGTH = 32;

// ============================================================================
// Vault State (in-memory)
// ============================================================================

/** In-memory vault key — null when locked, Uint8Array when unlocked */
let vaultKey: Uint8Array | null = null;

/**
 * Get current vault lock state.
 */
export function getVaultLockState(): VaultLockState {
  return vaultKey !== null ? 'unlocked' : 'locked';
}

export function isVaultMetadataComplete(): boolean {
  return Boolean(getVaultMeta('vault_salt') && getVaultMeta('vault_key_check'));
}

function hasVaultEncryptedState(): boolean {
  return listVaultCategories().length > 0 || listVaultMachineUnlockKeys().length > 0;
}

/**
 * Check if vault is currently unlocked (key held in memory).
 */
export function isVaultUnlocked(): boolean {
  return vaultKey !== null;
}

/**
 * Lock the vault — wipe vault key from memory.
 * After locking, machine unlock keys cannot be decrypted until re-unlocked.
 */
export function lockVault(): void {
  if (vaultKey !== null) {
    // Zero out the key before discarding
    vaultKey.fill(0);
    vaultKey = null;
  }
}

// ============================================================================
// Vault Key Derivation
// ============================================================================

/**
 * Derive vault key from user root private key and salt using HKDF-SHA256.
 *
 * @param userRootPrivateKey - Owner's Ed25519 private key (32 or 64 bytes)
 * @param salt - Vault salt (32 bytes, stored in vault_meta)
 * @returns 32-byte vault key
 */
function deriveVaultKey(
  userRootPrivateKey: Uint8Array,
  salt: Uint8Array
): Uint8Array {
  const info = new TextEncoder().encode(VAULT_KEY_INFO);
  return hkdf(sha256, userRootPrivateKey, salt, info, VAULT_KEY_LENGTH);
}

function checksumPayload(payload: Uint8Array): string {
  return createHash('sha256').update(payload).digest('hex');
}

// ============================================================================
// Vault Initialization
// ============================================================================

/**
 * Initialize the vault for the first time.
 *
 * Generates a random salt, derives the vault key, encrypts a key check,
 * and stores everything in the vault_meta table.
 *
 * @param userRootPrivateKey - Owner's Ed25519 private key
 * @returns true if initialized, false if already initialized
 * @throws {Error} If initialization fails
 */
export function initializeVault(
  userRootPrivateKey: Uint8Array,
  options: { allowRepair?: boolean } = {},
): boolean {
  if (isVaultInitialized()) {
    if (!options.allowRepair || isVaultMetadataComplete()) {
      return false;
    }

    if (hasVaultEncryptedState()) {
      throw new Error('Vault metadata is incomplete but encrypted data already exists');
    }
  }

  // Generate random salt
  const salt = randomBytes(VAULT_SALT_LENGTH);
  const saltB64 = Buffer.from(salt).toString('base64');

  // Derive vault key
  const derivedKey = deriveVaultKey(userRootPrivateKey, salt);

  // Encrypt known plaintext as key check
  const checkPlaintext = new TextEncoder().encode(VAULT_KEY_CHECK_PLAINTEXT);
  const sealedCheck = seal(checkPlaintext, derivedKey);
  const checkB64 = Buffer.from(sealedCheck).toString('base64');

  // Store in vault_meta
  setVaultMeta('vault_salt', saltB64);
  setVaultMeta('vault_key_check', checkB64);
  setVaultMeta('vault_initialized', '1');

  // Hold key in memory
  vaultKey = derivedKey;

  return true;
}

/**
 * Unlock the vault by re-deriving the vault key and verifying against the stored key check.
 *
 * @param userRootPrivateKey - Owner's Ed25519 private key
 * @returns true if unlock succeeded, false if key check failed
 * @throws {Error} If vault is not initialized or salt is missing
 */
export function unlockVault(userRootPrivateKey: Uint8Array): boolean {
  if (!isVaultInitialized()) {
    throw new Error('Vault is not initialized');
  }

  const saltB64 = getVaultMeta('vault_salt');
  if (!saltB64) {
    throw new Error('Vault salt not found');
  }

  const checkB64 = getVaultMeta('vault_key_check');
  if (!checkB64) {
    throw new Error('Vault key check not found');
  }

  // Derive vault key from private key + stored salt
  const salt = Buffer.from(saltB64, 'base64');
  const derivedKey = deriveVaultKey(userRootPrivateKey, salt);

  // Verify against key check
  const sealedCheck = Buffer.from(checkB64, 'base64');
  const decrypted = open(sealedCheck, derivedKey);

  if (!decrypted) {
    return false;
  }

  const plaintext = new TextDecoder().decode(decrypted);
  if (plaintext !== VAULT_KEY_CHECK_PLAINTEXT) {
    return false;
  }

  // Key verified — hold in memory
  vaultKey = derivedKey;
  return true;
}

// ============================================================================
// Owner Sync Categories
// ============================================================================

export interface WriteVaultCategoryInput {
  category: VaultSyncCategory;
  payload: Uint8Array | string;
  writerId: string;
  expectedRevision?: number;
}

export interface OpenedVaultCategoryRecord extends VaultCategoryRecord {
  payload: Uint8Array;
}

/**
 * Encrypt and persist a sync category payload.
 */
export function writeVaultCategory(input: WriteVaultCategoryInput): VaultCategoryRecord {
  if (!vaultKey) {
    throw new Error('Vault is locked — cannot write sync category');
  }

  const payload = typeof input.payload === 'string'
    ? new TextEncoder().encode(input.payload)
    : input.payload;
  const checksum = checksumPayload(payload);
  const sealed = seal(payload, vaultKey);
  const encryptedEnvelope = Buffer.from(sealed).toString('base64');

  return upsertVaultCategory({
    category: input.category,
    encryptedEnvelope,
    writerId: input.writerId,
    checksum,
    expectedRevision: input.expectedRevision,
  });
}

/**
 * Read and decrypt a sync category payload.
 */
export function readVaultCategory(category: VaultSyncCategory): OpenedVaultCategoryRecord | null {
  if (!vaultKey) {
    throw new Error('Vault is locked — cannot read sync category');
  }

  const record = getVaultCategory(category);
  if (!record) {
    return null;
  }

  const sealed = Buffer.from(record.encryptedEnvelope, 'base64');
  const payload = open(sealed, vaultKey);
  if (!payload) {
    return null;
  }

  const checksum = checksumPayload(payload);
  if (checksum !== record.checksum) {
    throw new Error(`Vault category checksum mismatch: ${category}`);
  }

  return {
    ...record,
    payload: new Uint8Array(payload),
  };
}

/**
 * Read a sync category payload as UTF-8 text.
 */
export function readVaultCategoryText(category: VaultSyncCategory): string | null {
  const opened = readVaultCategory(category);
  if (!opened) {
    return null;
  }
  return new TextDecoder().decode(opened.payload);
}

export function removeVaultSyncCategory(category: VaultSyncCategory): boolean {
  return removeVaultCategory(category);
}

export function listVaultSyncCategoryMetadata(): VaultCategoryRecord[] {
  return listVaultCategories();
}

// ============================================================================
// Machine Unlock Key Operations
// ============================================================================

/**
 * Generate a random machine unlock key.
 */
export function generateMachineUnlockKey(): Uint8Array {
  return randomBytes(MACHINE_UNLOCK_KEY_LENGTH);
}

/**
 * Seal (encrypt) a machine unlock key and store it in the vault.
 *
 * @param machineId - Machine identifier
 * @param unlockKey - Raw unlock key (32 bytes)
 * @throws {Error} If vault is locked
 */
export function sealMachineUnlockKey(machineId: string, unlockKey: Uint8Array): void {
  if (!vaultKey) {
    throw new Error('Vault is locked — cannot seal machine unlock key');
  }

  const sealed = seal(unlockKey, vaultKey);
  const sealedB64 = Buffer.from(sealed).toString('base64');

  setVaultMachineUnlockKey(machineId, sealedB64);
}

/**
 * Open (decrypt) a machine unlock key from the vault.
 *
 * @param machineId - Machine identifier
 * @returns Decrypted unlock key (32 bytes), or null if not found or decryption fails
 * @throws {Error} If vault is locked
 */
export function openMachineUnlockKey(machineId: string): Uint8Array | null {
  if (!vaultKey) {
    throw new Error('Vault is locked — cannot open machine unlock key');
  }

  const record = getVaultMachineUnlockKey(machineId);
  if (!record) {
    return null;
  }

  const sealed = Buffer.from(record.encryptedUnlockKey, 'base64');
  const decrypted = open(sealed, vaultKey);

  return decrypted ? new Uint8Array(decrypted) : null;
}

/**
 * Remove a machine unlock key from the vault.
 */
export function removeMachineUnlockKey(machineId: string): boolean {
  return removeVaultMachineUnlockKey(machineId);
}

/**
 * List all machine IDs that have unlock keys stored in the vault.
 */
export function listMachinesWithUnlockKeys(): string[] {
  return listVaultMachineUnlockKeys().map((r) => r.machineId);
}

/**
 * Open all machine unlock keys in the vault.
 * Useful after unlock to pre-populate a cache.
 *
 * @returns Map of machineId → decrypted unlock key
 * @throws {Error} If vault is locked
 */
export function openAllMachineUnlockKeys(): Map<string, Uint8Array> {
  if (!vaultKey) {
    throw new Error('Vault is locked — cannot open machine unlock keys');
  }

  const records = listVaultMachineUnlockKeys();
  const result = new Map<string, Uint8Array>();

  for (const record of records) {
    const sealed = Buffer.from(record.encryptedUnlockKey, 'base64');
    const decrypted = open(sealed, vaultKey);
    if (decrypted) {
      result.set(record.machineId, new Uint8Array(decrypted));
    }
  }

  return result;
}

// ============================================================================
// Testing Helpers
// ============================================================================

/**
 * Reset vault state — FOR TESTING ONLY.
 * Wipes the in-memory vault key.
 */
export function _resetVaultState(): void {
  lockVault();
}
