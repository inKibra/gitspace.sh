export type CloudWorkspaceStatus =
  | 'provisioning'
  | 'bootstrapping'
  | 'ready'
  | 'hibernated'
  | 'offline'
  | 'destroyed'
  | 'error';

export interface ControlMeta {
  schemaVersion: number;
  ownerIdentityId?: string;
  relayIdentityId?: string;
  relaySigningPublicKey?: string;
  relayFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudWorkspaceRecord {
  id: string;
  provider: 'sprites';
  providerWorkspaceId: string;
  machineId?: string;
  machinePublicKey?: string;
  repo?: string;
  branch?: string;
  status: CloudWorkspaceStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export type CloudBootstrapState =
  | 'pending'
  | 'vm_created'
  | 'unlock_granted'
  | 'machine_registered'
  | 'ready'
  | 'failed';

export interface CloudBootstrapTokenRecord {
  tokenId: string;
  workspaceId: string;
  ownerIdentityId: string;
  tokenHash: string;
  state: CloudBootstrapState;
  expiresAt: string;
  consumedAt?: string;
  machineId?: string;
  machinePublicKey?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Vault Types
// ============================================================================

/** Persistent machine registration record (replaces in-memory registry) */
export interface VaultMachineRecord {
  machineId: string;
  /** User root public key of the machine owner */
  ownerUserRootId: string;
  /** Ed25519 signing public key (base64) */
  signingKey: string;
  /** X25519 key exchange public key (base64) */
  keyExchangeKey: string;
  /** Human-readable label */
  label?: string;
  registeredAt: string;
  lastConnectedAt: string;
}

/** Encrypted machine unlock key record */
export interface VaultMachineUnlockKeyRecord {
  machineId: string;
  /** AES-256-GCM sealed unlock key (base64 of nonce || ciphertext || authTag) */
  encryptedUnlockKey: string;
  createdAt: string;
  updatedAt: string;
}

/** Access control list entry keyed by user root ID */
export interface VaultAccessListEntry {
  id: number;
  /** Owner's user root public key */
  ownerUserRootId: string;
  /** Authorized client's user root public key */
  clientUserRootId: string;
  /** Human-readable label */
  label?: string;
  grantedAt: string;
}

/** Relay-level access control list entry keyed by user root ID */
export interface RelayAccessListEntry {
  id: number;
  /** Relay owner's user root public key */
  ownerUserRootId: string;
  /** Authorized client's user root public key */
  clientUserRootId: string;
  /** Human-readable label */
  label?: string;
  grantedAt: string;
}

/** Machine-level access control list entry keyed by machine + user root ID */
export interface MachineAccessListEntry {
  id: number;
  machineId: string;
  /** Machine owner's user root public key */
  ownerUserRootId: string;
  /** Authorized client's user root public key */
  clientUserRootId: string;
  /** Human-readable label */
  label?: string;
  grantedAt: string;
}

/** Vault lock state */
export type VaultLockState = 'locked' | 'unlocked';

/** Vault metadata keys stored in vault_meta table */
export type VaultMetaKey =
  | 'vault_salt'
  | 'vault_key_check'
  | 'vault_initialized'
  | 'owner_user_root_id';

/** Relay owner sync categories persisted in the vault. */
export type VaultSyncCategory =
  | 'fundamental'
  | 'integrations'
  | 'project/workspace'
  | 'preferences';

/**
 * Encrypted sync category envelope metadata.
 *
 * The payload is encrypted at rest in `encryptedEnvelope`.
 */
export interface VaultCategoryRecord {
  category: VaultSyncCategory;
  encryptedEnvelope: string;
  revision: number;
  updatedAt: string;
  writerId: string;
  checksum: string;
  createdAt: string;
}
