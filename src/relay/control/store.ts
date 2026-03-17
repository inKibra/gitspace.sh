import { Database } from 'bun:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getSpacesDir } from '../../core/config.js';
import { SpacesError } from '../../types/errors.js';
import { applyControlMigrations } from './schema.js';
import type {
  CloudBootstrapState,
  CloudBootstrapTokenRecord,
  CloudWorkspaceRecord,
  ControlMeta,
  LocalStoreMetaKey,
  LocalStoreRecord,
  LocalStoreSecretRecord,
  VaultAccessListEntry,
  VaultCategoryRecord,
  VaultMachineRecord,
  VaultMachineUnlockKeyRecord,
  VaultMetaKey,
  VaultSyncCategory,
} from './types.js';

const CONTROL_SCHEMA_VERSION = 6;
const CONTROL_DIR_OVERRIDE_ENV = 'GITSPACE_CONTROL_DIR';

const META_KEY_SCHEMA_VERSION = 'schema_version';
const META_KEY_OWNER_IDENTITY_ID = 'owner_identity_id';
const META_KEY_CREATED_AT = 'created_at';
const META_KEY_UPDATED_AT = 'updated_at';
const META_KEY_RELAY_IDENTITY_ID = 'relay_identity_id';
const META_KEY_RELAY_SIGNING_PUBLIC_KEY = 'relay_signing_public_key';
const META_KEY_RELAY_FINGERPRINT = 'relay_fingerprint';

const VAULT_SYNC_CATEGORIES: ReadonlyArray<VaultSyncCategory> = [
  'fundamental',
  'integrations',
  'project/workspace',
  'preferences',
] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertVaultSyncCategory(category: string): asserts category is VaultSyncCategory {
  if (!VAULT_SYNC_CATEGORIES.includes(category as VaultSyncCategory)) {
    throw new SpacesError(`Unsupported vault category: ${category}`, 'USER_ERROR', 1);
  }
}

export function getControlDirPath(): string {
  const override = process.env[CONTROL_DIR_OVERRIDE_ENV]?.trim();
  if (override) {
    return override;
  }

  return join(getSpacesDir(), '.relay', 'control');
}

export function getControlDbPath(): string {
  return join(getControlDirPath(), 'control.db');
}

export function resetControlStore(): void {
  withControlDb((db) => {
    const tablesToClear = [
      'machine_access_list',
      'relay_access_list',
      'root_invites',
      'vault_machine_unlock_keys',
      'vault_access_list',
      'vault_sync_categories',
      'cloud_events',
      'cloud_bootstrap_tokens',
      'cloud_register_permits',
      'cloud_workspaces',
      'vault_machines',
      'vault_meta',
    ].filter((tableName) => {
      const row = db.query(
        `
          SELECT 1
          FROM sqlite_master
          WHERE type = 'table' AND name = ?
        `,
      ).get(tableName);
      return row !== null;
    });

    db.exec('BEGIN');
    try {
      for (const tableName of tablesToClear) {
        db.exec(`DELETE FROM ${tableName}`);
      }
      db.query(
        `
          DELETE FROM control_meta
          WHERE key NOT IN (?, ?, ?)
        `,
      ).run(META_KEY_SCHEMA_VERSION, META_KEY_CREATED_AT, META_KEY_UPDATED_AT);
      setMetaValue(db, META_KEY_UPDATED_AT, nowIso());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

function ensureControlDir(): void {
  const controlDir = getControlDirPath();
  if (!existsSync(controlDir)) {
    mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  }
}

function openControlDb(): Database {
  ensureControlDir();
  const db = new Database(getControlDbPath(), { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function getMetaValue(db: Database, key: string): string | undefined {
  const row = db.query('SELECT value FROM control_meta WHERE key = ?').get(key) as
    | { value: string }
    | null;
  return row?.value;
}

function setMetaValue(db: Database, key: string, value: string): void {
  db.query(
    `
      INSERT INTO control_meta(key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE
      SET value = excluded.value,
          updated_at = excluded.updated_at
    `
  ).run(key, value, nowIso());
}

function deleteMetaValue(db: Database, key: string): void {
  db.query('DELETE FROM control_meta WHERE key = ?').run(key);
}

function bootstrapControlMeta(db: Database): void {
  const schemaVersion = getMetaValue(db, META_KEY_SCHEMA_VERSION);
  const createdAt = getMetaValue(db, META_KEY_CREATED_AT);
  const updatedAt = getMetaValue(db, META_KEY_UPDATED_AT);
  const now = nowIso();

  if (schemaVersion !== String(CONTROL_SCHEMA_VERSION)) {
    setMetaValue(db, META_KEY_SCHEMA_VERSION, String(CONTROL_SCHEMA_VERSION));
  }

  if (!createdAt) {
    setMetaValue(db, META_KEY_CREATED_AT, now);
  }

  if (!updatedAt) {
    setMetaValue(db, META_KEY_UPDATED_AT, now);
  }
}

function readControlMetaFromDb(db: Database): ControlMeta {
  const createdAt = getMetaValue(db, META_KEY_CREATED_AT) ?? nowIso();
  const updatedAt = getMetaValue(db, META_KEY_UPDATED_AT) ?? createdAt;
  const schemaVersionRaw = getMetaValue(db, META_KEY_SCHEMA_VERSION);
  const schemaVersion = schemaVersionRaw ? parseInt(schemaVersionRaw, 10) : CONTROL_SCHEMA_VERSION;

  const ownerIdentityId = getMetaValue(db, META_KEY_OWNER_IDENTITY_ID);
  const relayIdentityId = getMetaValue(db, META_KEY_RELAY_IDENTITY_ID);
  const relaySigningPublicKey = getMetaValue(db, META_KEY_RELAY_SIGNING_PUBLIC_KEY);
  const relayFingerprint = getMetaValue(db, META_KEY_RELAY_FINGERPRINT);

  return {
    schemaVersion: Number.isNaN(schemaVersion) ? CONTROL_SCHEMA_VERSION : schemaVersion,
    ownerIdentityId,
    relayIdentityId,
    relaySigningPublicKey,
    relayFingerprint,
    createdAt,
    updatedAt,
  };
}

function withControlDb<T>(handler: (db: Database) => T): T {
  const db = openControlDb();

  try {
    applyControlMigrations(db);
    bootstrapControlMeta(db);
    return handler(db);
  } finally {
    db.close();
  }
}

export function ensureControlStore(): ControlMeta {
  return withControlDb((db) => readControlMetaFromDb(db));
}

export function readControlMeta(): ControlMeta {
  return withControlDb((db) => readControlMetaFromDb(db));
}

export function writeControlMeta(meta: ControlMeta): void {
  withControlDb((db) => {
    const existing = readControlMetaFromDb(db);
    const createdAt = meta.createdAt || existing.createdAt || nowIso();

    setMetaValue(db, META_KEY_SCHEMA_VERSION, String(CONTROL_SCHEMA_VERSION));
    setMetaValue(db, META_KEY_CREATED_AT, createdAt);
    setMetaValue(db, META_KEY_UPDATED_AT, nowIso());

    if (meta.ownerIdentityId) {
      setMetaValue(db, META_KEY_OWNER_IDENTITY_ID, meta.ownerIdentityId);
    } else {
      deleteMetaValue(db, META_KEY_OWNER_IDENTITY_ID);
    }

    if (meta.relayIdentityId) {
      setMetaValue(db, META_KEY_RELAY_IDENTITY_ID, meta.relayIdentityId);
    } else {
      deleteMetaValue(db, META_KEY_RELAY_IDENTITY_ID);
    }

    if (meta.relaySigningPublicKey) {
      setMetaValue(db, META_KEY_RELAY_SIGNING_PUBLIC_KEY, meta.relaySigningPublicKey);
    } else {
      deleteMetaValue(db, META_KEY_RELAY_SIGNING_PUBLIC_KEY);
    }

    if (meta.relayFingerprint) {
      setMetaValue(db, META_KEY_RELAY_FINGERPRINT, meta.relayFingerprint);
    } else {
      deleteMetaValue(db, META_KEY_RELAY_FINGERPRINT);
    }
  });
}

function getVaultMetaValueFromDb(db: Database, key: VaultMetaKey): string | undefined {
  const row = db.query('SELECT value FROM vault_meta WHERE key = ?').get(key) as
    | { value: string }
    | null;
  return row?.value;
}

function setVaultMetaValueInDb(db: Database, key: VaultMetaKey, value: string): void {
  db.query(
    `
      INSERT INTO vault_meta(key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE
      SET value = excluded.value
    `
  ).run(key, value);
}

export interface PersistedOwnerBinding {
  controlOwnerId?: string;
  vaultOwnerId?: string;
  effectiveOwnerId?: string;
  mismatch: boolean;
  repaired: boolean;
}

function peekPersistedOwnerBindingFromDb(db: Database): PersistedOwnerBinding {
  let controlOwnerId = getMetaValue(db, META_KEY_OWNER_IDENTITY_ID);
  let vaultOwnerId = getVaultMetaValueFromDb(db, 'owner_user_root_id');

  const mismatch = Boolean(controlOwnerId && vaultOwnerId && controlOwnerId !== vaultOwnerId);
  const effectiveOwnerId = mismatch ? undefined : (controlOwnerId ?? vaultOwnerId);

  return {
    controlOwnerId,
    vaultOwnerId,
    effectiveOwnerId,
    mismatch,
    repaired: false,
  };
}

function readPersistedOwnerBindingFromDb(db: Database): PersistedOwnerBinding {
  const binding = peekPersistedOwnerBindingFromDb(db);

  if (!binding.controlOwnerId && binding.vaultOwnerId) {
    setMetaValue(db, META_KEY_OWNER_IDENTITY_ID, binding.vaultOwnerId);
    return {
      ...binding,
      controlOwnerId: binding.vaultOwnerId,
      effectiveOwnerId: binding.vaultOwnerId,
      repaired: true,
    };
  }

  if (binding.controlOwnerId && !binding.vaultOwnerId) {
    setVaultMetaValueInDb(db, 'owner_user_root_id', binding.controlOwnerId);
    return {
      ...binding,
      vaultOwnerId: binding.controlOwnerId,
      effectiveOwnerId: binding.controlOwnerId,
      repaired: true,
    };
  }

  return binding;
}

export function readPersistedOwnerBinding(): PersistedOwnerBinding {
  return withControlDb((db) => readPersistedOwnerBindingFromDb(db));
}

export function peekPersistedOwnerBinding(): PersistedOwnerBinding {
  return withControlDb((db) => peekPersistedOwnerBindingFromDb(db));
}

export function getPersistedOwnerIdentityId(): string | undefined {
  return readPersistedOwnerBinding().effectiveOwnerId;
}

export function bindPersistedOwnerIdentity(ownerIdentityId: string): {
  bound: boolean;
  repaired: boolean;
  ownerIdentityId: string;
} {
  return withControlDb((db) => {
    const binding = readPersistedOwnerBindingFromDb(db);

    if (!binding.controlOwnerId && !binding.vaultOwnerId) {
      setMetaValue(db, META_KEY_OWNER_IDENTITY_ID, ownerIdentityId);
      setVaultMetaValueInDb(db, 'owner_user_root_id', ownerIdentityId);
      setMetaValue(db, META_KEY_UPDATED_AT, nowIso());
      return { bound: true, repaired: false, ownerIdentityId };
    }

    if (!binding.mismatch) {
      if (binding.effectiveOwnerId !== ownerIdentityId) {
        throw new SpacesError(
          `Local control bindings mismatch. Persisted owner '${binding.effectiveOwnerId}' does not match current identity '${ownerIdentityId}'.`,
          'USER_ERROR',
          1
        );
      }

      return { bound: false, repaired: binding.repaired, ownerIdentityId };
    }

    const canRepairToCurrentIdentity = binding.controlOwnerId === ownerIdentityId
      || binding.vaultOwnerId === ownerIdentityId;

    if (!canRepairToCurrentIdentity) {
      throw new SpacesError(
        `Local control bindings mismatch. Persisted control owner '${binding.controlOwnerId}' and vault owner '${binding.vaultOwnerId}' do not match current identity '${ownerIdentityId}'.`,
        'USER_ERROR',
        1
      );
    }

    setMetaValue(db, META_KEY_OWNER_IDENTITY_ID, ownerIdentityId);
    setVaultMetaValueInDb(db, 'owner_user_root_id', ownerIdentityId);
    setMetaValue(db, META_KEY_UPDATED_AT, nowIso());
    return { bound: false, repaired: true, ownerIdentityId };
  });
}

export function isControlOwner(identityId: string): boolean {
  const ownerIdentityId = getPersistedOwnerIdentityId();
  return ownerIdentityId === identityId;
}

export function assertControlOwner(identityId: string): void {
  const ownerBinding = readPersistedOwnerBinding();
  if (ownerBinding.mismatch) {
    throw new SpacesError(
      `Local control bindings mismatch. Persisted control owner '${ownerBinding.controlOwnerId}' and vault owner '${ownerBinding.vaultOwnerId}' do not match current identity '${identityId}'.`,
      'USER_ERROR',
      1
    );
  }

  const ownerIdentityId = ownerBinding.effectiveOwnerId;
  if (!ownerIdentityId) {
    throw new SpacesError(
      'Local control bindings are not initialized.',
      'SYSTEM_ERROR',
      2
    );
  }

  if (ownerIdentityId !== identityId) {
    throw new SpacesError(
      `Local control bindings mismatch. Persisted owner '${ownerIdentityId}' does not match current identity '${identityId}'.`,
      'USER_ERROR',
      1
    );
  }
}

export interface BindControlRelayIdentityInput {
  relayIdentityId: string;
  relaySigningPublicKey: string;
  relayFingerprint: string;
}

export function bindControlRelayIdentity(
  input: BindControlRelayIdentityInput
): { bound: boolean; relayIdentityId: string } {
  return withControlDb((db) => {
    const currentRelayIdentityId = getMetaValue(db, META_KEY_RELAY_IDENTITY_ID);
    const currentRelaySigningPublicKey = getMetaValue(db, META_KEY_RELAY_SIGNING_PUBLIC_KEY);
    const currentRelayFingerprint = getMetaValue(db, META_KEY_RELAY_FINGERPRINT);

    if (!currentRelayIdentityId && !currentRelaySigningPublicKey && !currentRelayFingerprint) {
      setMetaValue(db, META_KEY_RELAY_IDENTITY_ID, input.relayIdentityId);
      setMetaValue(db, META_KEY_RELAY_SIGNING_PUBLIC_KEY, input.relaySigningPublicKey);
      setMetaValue(db, META_KEY_RELAY_FINGERPRINT, input.relayFingerprint);
      setMetaValue(db, META_KEY_UPDATED_AT, nowIso());
      return { bound: true, relayIdentityId: input.relayIdentityId };
    }

    const sameIdentityId = currentRelayIdentityId === input.relayIdentityId;
    const sameSigningKey = currentRelaySigningPublicKey === input.relaySigningPublicKey;
    const sameFingerprint = currentRelayFingerprint === input.relayFingerprint;

    if (!sameIdentityId || !sameSigningKey || !sameFingerprint) {
      throw new SpacesError(
        [
          `Local control bindings mismatch. Pinned relay '${currentRelayFingerprint ?? currentRelayIdentityId}', current relay '${input.relayFingerprint}'.`,
          '',
          'This relay pin is stored in the local control database, not the trusted relay list.',
          'If this relay change is expected, re-run `gssh machine serve start --takeover` to clear persisted local control bindings and re-bind to the current relay.',
        ].join('\n'),
        'USER_ERROR',
        1
      );
    }

    return { bound: false, relayIdentityId: input.relayIdentityId };
  });
}

// ============================================================================
// Local Secure Store
// ============================================================================

interface LocalStoreRecordRow {
  namespace: string;
  key: string;
  value_json: string;
  created_at: string;
  updated_at: string;
}

interface LocalStoreSecretRow {
  namespace: string;
  key: string;
  ciphertext: string;
  created_at: string;
  updated_at: string;
}

function getLocalStoreMetaValue(db: Database, key: LocalStoreMetaKey): string | undefined {
  const row = db.query('SELECT value FROM local_store_meta WHERE key = ?').get(key) as
    | { value: string }
    | null;
  return row?.value;
}

function setLocalStoreMetaValue(db: Database, key: LocalStoreMetaKey, value: string): void {
  db.query(
    `
      INSERT INTO local_store_meta(key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE
      SET value = excluded.value,
          updated_at = excluded.updated_at
    `
  ).run(key, value, nowIso());
}

function deleteLocalStoreMetaValue(db: Database, key: LocalStoreMetaKey): void {
  db.query('DELETE FROM local_store_meta WHERE key = ?').run(key);
}

function mapLocalStoreRecordRow(row: LocalStoreRecordRow): LocalStoreRecord {
  return {
    namespace: row.namespace,
    key: row.key,
    valueJson: row.value_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLocalStoreSecretRow(row: LocalStoreSecretRow): LocalStoreSecretRecord {
  return {
    namespace: row.namespace,
    key: row.key,
    ciphertext: row.ciphertext,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getLocalStoreMeta(key: LocalStoreMetaKey): string | undefined {
  return withControlDb((db) => getLocalStoreMetaValue(db, key));
}

export function setLocalStoreMeta(key: LocalStoreMetaKey, value: string): void {
  withControlDb((db) => {
    setLocalStoreMetaValue(db, key, value);
  });
}

export function deleteLocalStoreMeta(key: LocalStoreMetaKey): void {
  withControlDb((db) => {
    deleteLocalStoreMetaValue(db, key);
  });
}

export function getLocalStoreRecord(namespace: string, key: string): LocalStoreRecord | undefined {
  return withControlDb((db) => {
    const row = db.query(
      'SELECT * FROM local_store_records WHERE namespace = ? AND key = ?'
    ).get(namespace, key) as LocalStoreRecordRow | null;
    return row ? mapLocalStoreRecordRow(row) : undefined;
  });
}

export function upsertLocalStoreRecord(namespace: string, key: string, valueJson: string): LocalStoreRecord {
  return withControlDb((db) => {
    const now = nowIso();
    const existing = db.query(
      'SELECT created_at FROM local_store_records WHERE namespace = ? AND key = ?'
    ).get(namespace, key) as { created_at: string } | null;
    const createdAt = existing?.created_at ?? now;

    db.query(
      `
        INSERT INTO local_store_records(namespace, key, value_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(namespace, key) DO UPDATE
        SET value_json = excluded.value_json,
            updated_at = excluded.updated_at
      `
    ).run(namespace, key, valueJson, createdAt, now);

    return {
      namespace,
      key,
      valueJson,
      createdAt,
      updatedAt: now,
    };
  });
}

export function removeLocalStoreRecord(namespace: string, key: string): boolean {
  return withControlDb((db) => {
    const result = db.query(
      'DELETE FROM local_store_records WHERE namespace = ? AND key = ?'
    ).run(namespace, key);
    return result.changes > 0;
  });
}

export function getLocalStoreSecret(namespace: string, key: string): LocalStoreSecretRecord | undefined {
  return withControlDb((db) => {
    const row = db.query(
      'SELECT * FROM local_store_secrets WHERE namespace = ? AND key = ?'
    ).get(namespace, key) as LocalStoreSecretRow | null;
    return row ? mapLocalStoreSecretRow(row) : undefined;
  });
}

export function upsertLocalStoreSecret(namespace: string, key: string, ciphertext: string): LocalStoreSecretRecord {
  return withControlDb((db) => {
    const now = nowIso();
    const existing = db.query(
      'SELECT created_at FROM local_store_secrets WHERE namespace = ? AND key = ?'
    ).get(namespace, key) as { created_at: string } | null;
    const createdAt = existing?.created_at ?? now;

    db.query(
      `
        INSERT INTO local_store_secrets(namespace, key, ciphertext, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(namespace, key) DO UPDATE
        SET ciphertext = excluded.ciphertext,
            updated_at = excluded.updated_at
      `
    ).run(namespace, key, ciphertext, createdAt, now);

    return {
      namespace,
      key,
      ciphertext,
      createdAt,
      updatedAt: now,
    };
  });
}

export function removeLocalStoreSecret(namespace: string, key: string): boolean {
  return withControlDb((db) => {
    const result = db.query(
      'DELETE FROM local_store_secrets WHERE namespace = ? AND key = ?'
    ).run(namespace, key);
    return result.changes > 0;
  });
}

// ============================================================================
// Workspace CRUD
// ============================================================================

export interface UpsertCloudWorkspaceInput {
  id: string;
  provider: 'sprites';
  providerWorkspaceId: string;
  machineId?: string;
  machinePublicKey?: string;
  repo?: string;
  branch?: string;
  status: CloudWorkspaceRecord['status'];
  error?: string;
}

/**
 * Insert or update a cloud workspace record.
 * On conflict (same id) all fields are updated except created_at.
 */
export function upsertCloudWorkspace(input: UpsertCloudWorkspaceInput): void {
  const now = nowIso();
  withControlDb((db) => {
    db.query(
      `
      INSERT INTO cloud_workspaces (
        id, provider, provider_workspace_id,
        machine_id, machine_public_key,
        repo, branch,
        status, error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider              = excluded.provider,
        provider_workspace_id = excluded.provider_workspace_id,
        machine_id            = excluded.machine_id,
        machine_public_key    = excluded.machine_public_key,
        repo                  = excluded.repo,
        branch                = excluded.branch,
        status                = excluded.status,
        error                 = excluded.error,
        updated_at            = excluded.updated_at
      `
    ).run(
      input.id,
      input.provider,
      input.providerWorkspaceId,
      input.machineId ?? null,
      input.machinePublicKey ?? null,
      input.repo ?? null,
      input.branch ?? null,
      input.status,
      input.error ?? null,
      now,
      now
    );
  });
}

/**
 * Retrieve a single cloud workspace record by id.
 * Returns undefined if not found.
 */
export function getCloudWorkspace(id: string): CloudWorkspaceRecord | undefined {
  return withControlDb((db) => {
    const row = db.query(
      `
      SELECT
        id, provider, provider_workspace_id,
        machine_id, machine_public_key,
        repo, branch,
        status, error,
        created_at, updated_at
      FROM cloud_workspaces
      WHERE id = ?
      `
    ).get(id) as {
      id: string;
      provider: string;
      provider_workspace_id: string;
      machine_id: string | null;
      machine_public_key: string | null;
      repo: string | null;
      branch: string | null;
      status: string;
      error: string | null;
      created_at: string;
      updated_at: string;
    } | null;

    if (!row) return undefined;

    return {
      id: row.id,
      provider: row.provider as CloudWorkspaceRecord['provider'],
      providerWorkspaceId: row.provider_workspace_id,
      machineId: row.machine_id ?? undefined,
      machinePublicKey: row.machine_public_key ?? undefined,
      repo: row.repo ?? undefined,
      branch: row.branch ?? undefined,
      status: row.status as CloudWorkspaceRecord['status'],
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

/**
 * Retrieve the latest cloud workspace record matching a machine signing key.
 * Returns undefined if no workspace is associated with the key.
 */
export function getCloudWorkspaceByMachinePublicKey(
  machinePublicKey: string
): CloudWorkspaceRecord | undefined {
  return withControlDb((db) => {
    const row = db.query(
      `
      SELECT
        id, provider, provider_workspace_id,
        machine_id, machine_public_key,
        repo, branch,
        status, error,
        created_at, updated_at
      FROM cloud_workspaces
      WHERE machine_public_key = ?
      ORDER BY updated_at DESC
      LIMIT 1
      `
    ).get(machinePublicKey) as {
      id: string;
      provider: string;
      provider_workspace_id: string;
      machine_id: string | null;
      machine_public_key: string | null;
      repo: string | null;
      branch: string | null;
      status: string;
      error: string | null;
      created_at: string;
      updated_at: string;
    } | null;

    if (!row) return undefined;

    return {
      id: row.id,
      provider: row.provider as CloudWorkspaceRecord['provider'],
      providerWorkspaceId: row.provider_workspace_id,
      machineId: row.machine_id ?? undefined,
      machinePublicKey: row.machine_public_key ?? undefined,
      repo: row.repo ?? undefined,
      branch: row.branch ?? undefined,
      status: row.status as CloudWorkspaceRecord['status'],
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

/**
 * Update only the status (and optional error message) of a workspace.
 * Passing a non-error status clears any previous error.
 *
 * @returns `true` if a row was updated, `false` if no workspace with that id
 *   was found (silently no-ops instead of throwing so callers can decide how
 *   to handle a missing workspace).
 */
export function updateCloudWorkspaceStatus(
  id: string,
  status: CloudWorkspaceRecord['status'],
  error?: string
): boolean {
  const now = nowIso();
  // Non-error statuses clear the stored error field
  const errorValue = status === 'error' ? (error ?? null) : null;
  return withControlDb((db) => {
    const result = db.query(
      `
      UPDATE cloud_workspaces
      SET status = ?, error = ?, updated_at = ?
      WHERE id = ?
      `
    ).run(status, errorValue, now, id);
    return result.changes > 0;
  });
}

/**
 * Mark a workspace as destroyed (soft delete / tombstone).
 */
export function tombstoneCloudWorkspace(id: string): void {
  updateCloudWorkspaceStatus(id, 'destroyed');
}

// ============================================================================
// Cloud Events Log
// ============================================================================

export interface CloudEventRecord {
  id: number;
  workspaceId?: string;
  eventType: string;
  message?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface LogCloudEventInput {
  workspaceId?: string;
  eventType: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append an event to the cloud_events log.
 * workspaceId is optional — global control-plane events omit it.
 */
export function logCloudEvent(input: LogCloudEventInput): void {
  const now = nowIso();
  withControlDb((db) => {
    db.query(
      `
      INSERT INTO cloud_events (workspace_id, event_type, message, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      `
    ).run(
      input.workspaceId ?? null,
      input.eventType,
      input.message ?? null,
      input.metadata != null ? JSON.stringify(input.metadata) : null,
      now
    );
  });
}

export interface ListCloudEventsOptions {
  workspaceId?: string;
  limit?: number;
}

/**
 * List cloud events, optionally filtered by workspaceId.
 * Results are returned in ascending created_at order (oldest first).
 */
export function listCloudEvents(options: ListCloudEventsOptions = {}): CloudEventRecord[] {
  return withControlDb((db) => {
    const { workspaceId, limit } = options;
    const rows = workspaceId != null
      ? (db.query(
          `
          SELECT id, workspace_id, event_type, message, metadata_json, created_at
          FROM cloud_events
          WHERE workspace_id = ?
          ORDER BY id ASC
          ${limit != null ? `LIMIT ${limit}` : ''}
          `
        ).all(workspaceId) as Array<{
          id: number;
          workspace_id: string | null;
          event_type: string;
          message: string | null;
          metadata_json: string | null;
          created_at: string;
        }>)
      : (db.query(
          `
          SELECT id, workspace_id, event_type, message, metadata_json, created_at
          FROM cloud_events
          ORDER BY id ASC
          ${limit != null ? `LIMIT ${limit}` : ''}
          `
        ).all() as Array<{
          id: number;
          workspace_id: string | null;
          event_type: string;
          message: string | null;
          metadata_json: string | null;
          created_at: string;
        }>);

    return rows.map((row) => {
      let metadata: Record<string, unknown> | undefined;
      if (row.metadata_json) {
        try {
          metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
        } catch {
          metadata = undefined;
        }
      }

      return {
        id: row.id,
        workspaceId: row.workspace_id ?? undefined,
        eventType: row.event_type,
        message: row.message ?? undefined,
        metadata,
        createdAt: row.created_at,
      };
    });
  });
}

// ============================================================================
// Bootstrap Tokens
// ============================================================================

export interface CreateCloudBootstrapTokenInput {
  workspaceId: string;
  ownerIdentityId: string;
  ttlMs?: number;
}

export interface IssuedCloudBootstrapToken {
  token: string;
  tokenId: string;
  workspaceId: string;
  ownerIdentityId: string;
  expiresAt: string;
}

export interface ConsumeCloudBootstrapTokenInput {
  token: string;
  machineId: string;
  machineSigningPublicKey: string;
}

export interface ConsumedCloudBootstrapToken {
  tokenId: string;
  workspaceId: string;
  ownerIdentityId: string;
}

export interface ValidCloudBootstrapToken {
  tokenId: string;
  workspaceId: string;
  ownerIdentityId: string;
  expiresAt: string;
  state: CloudBootstrapState;
}

export interface ConsumeCloudBootstrapTokenForUnlockInput {
  token: string;
  workspaceId: string;
  machineSigningPublicKey: string;
  permitTtlMs?: number;
}

export interface IssuedCloudRegisterPermit {
  permitId: string;
  registerPermit: string;
  tokenId: string;
  workspaceId: string;
  ownerIdentityId: string;
  machineSigningPublicKey: string;
  expiresAt: string;
}

export interface ConsumeCloudRegisterPermitInput {
  registerPermit: string;
  workspaceId: string;
  machineId: string;
  machineSigningPublicKey: string;
}

export interface ConsumedCloudRegisterPermit {
  permitId: string;
  tokenId: string;
  workspaceId: string;
  ownerIdentityId: string;
}

const DEFAULT_BOOTSTRAP_TOKEN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REGISTER_PERMIT_TTL_MS = 2 * 60 * 1000;

function mapBootstrapRow(row: {
  token_id: string;
  workspace_id: string;
  owner_identity_id: string;
  token_hash: string;
  state: string;
  expires_at: string;
  consumed_at: string | null;
  machine_id: string | null;
  machine_public_key: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}): CloudBootstrapTokenRecord {
  return {
    tokenId: row.token_id,
    workspaceId: row.workspace_id,
    ownerIdentityId: row.owner_identity_id,
    tokenHash: row.token_hash,
    state: row.state as CloudBootstrapState,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at ?? undefined,
    machineId: row.machine_id ?? undefined,
    machinePublicKey: row.machine_public_key ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createCloudBootstrapToken(
  input: CreateCloudBootstrapTokenInput
): IssuedCloudBootstrapToken {
  const now = nowIso();
  const ttlMs = input.ttlMs ?? DEFAULT_BOOTSTRAP_TOKEN_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const token = randomBytes(32).toString('base64url');
  const tokenId = randomUUID();
  const tokenHash = sha256Hex(token);

  withControlDb((db) => {
    db.query(
      `
      INSERT INTO cloud_bootstrap_tokens (
        token_id,
        workspace_id,
        owner_identity_id,
        token_hash,
        state,
        expires_at,
        consumed_at,
        machine_id,
        machine_public_key,
        last_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
      `
    ).run(
      tokenId,
      input.workspaceId,
      input.ownerIdentityId,
      tokenHash,
      'pending',
      expiresAt,
      now,
      now
    );

    db.query(
      `
      INSERT INTO cloud_events (workspace_id, event_type, message, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      `
    ).run(
      input.workspaceId,
      'bootstrap_token_issued',
      'Issued one-time bootstrap token',
      JSON.stringify({ tokenId, expiresAt }),
      now
    );
  });

  return {
    token,
    tokenId,
    workspaceId: input.workspaceId,
    ownerIdentityId: input.ownerIdentityId,
    expiresAt,
  };
}

/**
 * Issue a one-time unlock token for a boot/resume attempt.
 * Internally reuses bootstrap token storage while tagging event semantics.
 */
export function createCloudUnlockToken(
  input: CreateCloudBootstrapTokenInput
): IssuedCloudBootstrapToken {
  const issued = createCloudBootstrapToken(input);
  logCloudEvent({
    workspaceId: input.workspaceId,
    eventType: 'unlock_token_issued',
    message: 'Issued one-time unlock token',
    metadata: {
      tokenId: issued.tokenId,
      expiresAt: issued.expiresAt,
    },
  });
  return issued;
}

export function markCloudBootstrapVmCreated(workspaceId: string): void {
  const now = nowIso();
  withControlDb((db) => {
    db.query(
      `
      UPDATE cloud_bootstrap_tokens
      SET state = 'vm_created', updated_at = ?
      WHERE token_id = (
        SELECT token_id
        FROM cloud_bootstrap_tokens
        WHERE workspace_id = ?
          AND consumed_at IS NULL
          AND state IN ('pending', 'vm_created')
        ORDER BY created_at DESC
        LIMIT 1
      )
      `
    ).run(now, workspaceId);
  });
}

export function markCloudBootstrapReady(workspaceId: string): void {
  const now = nowIso();
  withControlDb((db) => {
    db.query(
      `
      UPDATE cloud_bootstrap_tokens
      SET state = 'ready', updated_at = ?
      WHERE token_id = (
        SELECT token_id
        FROM cloud_bootstrap_tokens
        WHERE workspace_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      )
      `
    ).run(now, workspaceId);

    db.query(
      `
      UPDATE cloud_workspaces
      SET status = 'ready', error = NULL, updated_at = ?
      WHERE id = ?
      `
    ).run(now, workspaceId);

    db.query(
      `
      INSERT INTO cloud_events (workspace_id, event_type, message, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      `
    ).run(workspaceId, 'bootstrap_ready', 'Cloud bootstrap marked ready', null, now);
  });
}

/**
 * Atomically consume bootstrap token during unlock and mint a one-time register permit.
 * This closes the unlock->register replay window by invalidating the bootstrap token
 * before any identity material is returned.
 */
export function consumeCloudBootstrapTokenForUnlock(
  input: ConsumeCloudBootstrapTokenForUnlockInput
): IssuedCloudRegisterPermit | null {
  return withControlDb((db) => {
    const tokenHash = sha256Hex(input.token);
    const now = nowIso();
    const permitTtlMs = input.permitTtlMs ?? DEFAULT_REGISTER_PERMIT_TTL_MS;
    const registerPermit = randomBytes(32).toString('base64url');
    const permitId = randomUUID();
    const permitHash = sha256Hex(registerPermit);
    const permitExpiresAt = new Date(Date.now() + permitTtlMs).toISOString();

    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.query(
        `
        SELECT
          token_id,
          workspace_id,
          owner_identity_id,
          expires_at,
          consumed_at,
          state,
          machine_public_key,
          machine_id
        FROM cloud_bootstrap_tokens
        WHERE token_hash = ?
        LIMIT 1
        `
      ).get(tokenHash) as {
        token_id: string;
        workspace_id: string;
        owner_identity_id: string;
        expires_at: string;
        consumed_at: string | null;
        state: string;
        machine_public_key: string | null;
        machine_id: string | null;
      } | null;

      if (!row) {
        db.exec('ROLLBACK');
        return null;
      }

      if (row.workspace_id !== input.workspaceId) {
        db.exec('ROLLBACK');
        return null;
      }

      if (row.consumed_at) {
        db.exec('ROLLBACK');
        return null;
      }

      if (row.state !== 'pending' && row.state !== 'vm_created') {
        db.exec('ROLLBACK');
        return null;
      }

      if (Date.parse(row.expires_at) < Date.now()) {
        db.query(
          `
          UPDATE cloud_bootstrap_tokens
          SET state = 'failed', last_error = ?, updated_at = ?
          WHERE token_id = ?
          `
        ).run('Bootstrap token expired before unlock', now, row.token_id);
        db.exec('COMMIT');
        return null;
      }

      const workspaceRow = db.query(
        `
        SELECT machine_public_key, machine_id, status
        FROM cloud_workspaces
        WHERE id = ?
        `
      ).get(row.workspace_id) as {
        machine_public_key: string | null;
        machine_id: string | null;
        status: string;
      } | null;

      if (!workspaceRow) {
        db.exec('ROLLBACK');
        return null;
      }

      if (workspaceRow.status !== 'bootstrapping') {
        db.exec('ROLLBACK');
        return null;
      }

      if (workspaceRow.machine_id) {
        db.exec('ROLLBACK');
        return null;
      }

      if (!workspaceRow.machine_public_key) {
        db.query(
          `
          UPDATE cloud_bootstrap_tokens
          SET state = 'failed', last_error = ?, updated_at = ?
          WHERE token_id = ?
          `
        ).run('Workspace machine key is missing for unlock grant', now, row.token_id);
        db.exec('COMMIT');
        return null;
      }

      if (
        workspaceRow.machine_public_key !== input.machineSigningPublicKey
      ) {
        db.exec('ROLLBACK');
        return null;
      }

      if (
        row.machine_public_key &&
        row.machine_public_key !== input.machineSigningPublicKey
      ) {
        db.exec('ROLLBACK');
        return null;
      }

      if (row.machine_id) {
        db.exec('ROLLBACK');
        return null;
      }

      db.query(
        `
        UPDATE cloud_bootstrap_tokens
        SET
          consumed_at = ?,
          state = 'unlock_granted',
          machine_public_key = ?,
          updated_at = ?
        WHERE token_id = ?
        `
      ).run(now, input.machineSigningPublicKey, now, row.token_id);

      db.query(
        `
        INSERT INTO cloud_register_permits (
          permit_id,
          workspace_id,
          token_id,
          permit_hash,
          machine_public_key,
          expires_at,
          consumed_at,
          machine_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
        `
      ).run(
        permitId,
        row.workspace_id,
        row.token_id,
        permitHash,
        input.machineSigningPublicKey,
        permitExpiresAt,
        now,
        now
      );

      db.query(
        `
        UPDATE cloud_workspaces
        SET machine_public_key = COALESCE(machine_public_key, ?), updated_at = ?
        WHERE id = ?
        `
      ).run(input.machineSigningPublicKey, now, row.workspace_id);

      db.query(
        `
        INSERT INTO cloud_events (workspace_id, event_type, message, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        `
      ).run(
        row.workspace_id,
        'unlock_granted',
        'Bootstrap token consumed and register permit issued',
        JSON.stringify({
          tokenId: row.token_id,
          permitId,
          permitExpiresAt,
          machineSigningPublicKey: input.machineSigningPublicKey,
        }),
        now
      );

      db.exec('COMMIT');

      return {
        permitId,
        registerPermit,
        tokenId: row.token_id,
        workspaceId: row.workspace_id,
        ownerIdentityId: row.owner_identity_id,
        machineSigningPublicKey: input.machineSigningPublicKey,
        expiresAt: permitExpiresAt,
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

export function consumeCloudRegisterPermit(
  input: ConsumeCloudRegisterPermitInput
): ConsumedCloudRegisterPermit | null {
  return withControlDb((db) => {
    const permitHash = sha256Hex(input.registerPermit);
    const now = nowIso();

    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.query(
        `
        SELECT
          p.permit_id,
          p.workspace_id,
          p.token_id,
          p.machine_public_key,
          p.expires_at,
          p.consumed_at,
          b.owner_identity_id,
          b.state AS bootstrap_state
        FROM cloud_register_permits p
        INNER JOIN cloud_bootstrap_tokens b ON b.token_id = p.token_id
        WHERE p.permit_hash = ?
        LIMIT 1
        `
      ).get(permitHash) as {
        permit_id: string;
        workspace_id: string;
        token_id: string;
        machine_public_key: string;
        expires_at: string;
        consumed_at: string | null;
        owner_identity_id: string;
        bootstrap_state: string;
      } | null;

      if (!row) {
        db.exec('ROLLBACK');
        return null;
      }

      if (row.workspace_id !== input.workspaceId) {
        db.exec('ROLLBACK');
        return null;
      }

      if (row.consumed_at) {
        db.exec('ROLLBACK');
        return null;
      }

      if (Date.parse(row.expires_at) < Date.now()) {
        db.exec('ROLLBACK');
        return null;
      }

      if (row.bootstrap_state !== 'unlock_granted') {
        db.exec('ROLLBACK');
        return null;
      }

      if (row.machine_public_key !== input.machineSigningPublicKey) {
        db.exec('ROLLBACK');
        return null;
      }

      const workspaceRow = db.query(
        `
        SELECT machine_public_key, machine_id, status
        FROM cloud_workspaces
        WHERE id = ?
        `
      ).get(row.workspace_id) as {
        machine_public_key: string | null;
        machine_id: string | null;
        status: string;
      } | null;

      if (!workspaceRow) {
        db.exec('ROLLBACK');
        return null;
      }

      if (workspaceRow.status !== 'bootstrapping') {
        db.exec('ROLLBACK');
        return null;
      }

      if (
        workspaceRow.machine_public_key &&
        workspaceRow.machine_public_key !== input.machineSigningPublicKey
      ) {
        db.exec('ROLLBACK');
        return null;
      }

      if (workspaceRow.machine_id && workspaceRow.machine_id !== input.machineId) {
        db.exec('ROLLBACK');
        return null;
      }

      db.query(
        `
        UPDATE cloud_register_permits
        SET consumed_at = ?, machine_id = ?, updated_at = ?
        WHERE permit_id = ?
        `
      ).run(now, input.machineId, now, row.permit_id);

      db.query(
        `
        UPDATE cloud_bootstrap_tokens
        SET
          state = 'machine_registered',
          machine_id = ?,
          machine_public_key = ?,
          updated_at = ?
        WHERE token_id = ?
        `
      ).run(input.machineId, input.machineSigningPublicKey, now, row.token_id);

      db.query(
        `
        UPDATE cloud_workspaces
        SET
          machine_id = ?,
          machine_public_key = ?,
          updated_at = ?
        WHERE id = ?
        `
      ).run(input.machineId, input.machineSigningPublicKey, now, row.workspace_id);

      db.query(
        `
        INSERT INTO cloud_events (workspace_id, event_type, message, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        `
      ).run(
        row.workspace_id,
        'machine_registered',
        'Machine registered using register permit',
        JSON.stringify({
          tokenId: row.token_id,
          permitId: row.permit_id,
          machineId: input.machineId,
          machineSigningPublicKey: input.machineSigningPublicKey,
        }),
        now
      );

      db.exec('COMMIT');

      return {
        permitId: row.permit_id,
        tokenId: row.token_id,
        workspaceId: row.workspace_id,
        ownerIdentityId: row.owner_identity_id,
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

export function consumeCloudBootstrapToken(
  input: ConsumeCloudBootstrapTokenInput
): ConsumedCloudBootstrapToken | null {
  return withControlDb((db) => {
    const tokenHash = sha256Hex(input.token);
    const now = nowIso();

    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.query(
        `
        SELECT
          token_id,
          workspace_id,
          owner_identity_id,
          expires_at,
          consumed_at,
          state
        FROM cloud_bootstrap_tokens
        WHERE token_hash = ?
        LIMIT 1
        `
      ).get(tokenHash) as {
        token_id: string;
        workspace_id: string;
        owner_identity_id: string;
        expires_at: string;
        consumed_at: string | null;
        state: string;
      } | null;

      if (!row) {
        db.exec('ROLLBACK');
        return null;
      }

      if (row.consumed_at) {
        db.exec('ROLLBACK');
        return null;
      }

      if (Date.parse(row.expires_at) < Date.now()) {
        db.query(
          `
          UPDATE cloud_bootstrap_tokens
          SET state = 'failed', last_error = ?, updated_at = ?
          WHERE token_id = ?
          `
        ).run('Bootstrap token expired', now, row.token_id);
        db.exec('COMMIT');
        return null;
      }

      const workspaceRow = db.query(
        `
        SELECT machine_public_key
        FROM cloud_workspaces
        WHERE id = ?
        `
      ).get(row.workspace_id) as { machine_public_key: string | null } | null;

      if (workspaceRow?.machine_public_key && workspaceRow.machine_public_key !== input.machineSigningPublicKey) {
        db.exec('ROLLBACK');
        return null;
      }

      db.query(
        `
        UPDATE cloud_bootstrap_tokens
        SET
          consumed_at = ?,
          state = 'machine_registered',
          machine_id = ?,
          machine_public_key = ?,
          updated_at = ?
        WHERE token_id = ?
        `
      ).run(now, input.machineId, input.machineSigningPublicKey, now, row.token_id);

      db.query(
        `
        UPDATE cloud_workspaces
        SET
          machine_id = ?,
          machine_public_key = ?,
          status = 'ready',
          error = NULL,
          updated_at = ?
        WHERE id = ?
        `
      ).run(input.machineId, input.machineSigningPublicKey, now, row.workspace_id);

      db.query(
        `
        INSERT INTO cloud_events (workspace_id, event_type, message, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        `
      ).run(
        row.workspace_id,
        'machine_registered',
        'Machine registered using bootstrap token',
        JSON.stringify({
          tokenId: row.token_id,
          machineId: input.machineId,
          machineSigningPublicKey: input.machineSigningPublicKey,
        }),
        now
      );

      db.exec('COMMIT');

      return {
        tokenId: row.token_id,
        workspaceId: row.workspace_id,
        ownerIdentityId: row.owner_identity_id,
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

/**
 * Validate a bootstrap token without consuming it.
 * Used by unlock-request flow to verify token prior to machine registration.
 */
export function validateCloudBootstrapToken(
  token: string,
  expectedWorkspaceId?: string
): ValidCloudBootstrapToken | null {
  return withControlDb((db) => {
    const tokenHash = sha256Hex(token);
    const row = db.query(
      `
      SELECT
        token_id,
        workspace_id,
        owner_identity_id,
        expires_at,
        consumed_at,
        state
      FROM cloud_bootstrap_tokens
      WHERE token_hash = ?
      LIMIT 1
      `
    ).get(tokenHash) as {
      token_id: string;
      workspace_id: string;
      owner_identity_id: string;
      expires_at: string;
      consumed_at: string | null;
      state: string;
    } | null;

    if (!row) {
      return null;
    }

    if (row.consumed_at) {
      return null;
    }

    if (Date.parse(row.expires_at) < Date.now()) {
      return null;
    }

    if (expectedWorkspaceId && expectedWorkspaceId !== row.workspace_id) {
      return null;
    }

    return {
      tokenId: row.token_id,
      workspaceId: row.workspace_id,
      ownerIdentityId: row.owner_identity_id,
      expiresAt: row.expires_at,
      state: row.state as CloudBootstrapState,
    };
  });
}

export function getLatestCloudBootstrapToken(
  workspaceId: string
): CloudBootstrapTokenRecord | undefined {
  return withControlDb((db) => {
    const row = db.query(
      `
      SELECT
        token_id,
        workspace_id,
        owner_identity_id,
        token_hash,
        state,
        expires_at,
        consumed_at,
        machine_id,
        machine_public_key,
        last_error,
        created_at,
        updated_at
      FROM cloud_bootstrap_tokens
      WHERE workspace_id = ?
      ORDER BY created_at DESC
      LIMIT 1
      `
    ).get(workspaceId) as {
      token_id: string;
      workspace_id: string;
      owner_identity_id: string;
      token_hash: string;
      state: string;
      expires_at: string;
      consumed_at: string | null;
      machine_id: string | null;
      machine_public_key: string | null;
      last_error: string | null;
      created_at: string;
      updated_at: string;
    } | null;

    if (!row) {
      return undefined;
    }

    return mapBootstrapRow(row);
  });
}

export function listCloudWorkspaces(): CloudWorkspaceRecord[] {
  return withControlDb((db) => {
    const rows = db.query(
      `
      SELECT
        id,
        provider,
        provider_workspace_id,
        machine_id,
        machine_public_key,
        repo,
        branch,
        status,
        error,
        created_at,
        updated_at
      FROM cloud_workspaces
      ORDER BY updated_at DESC
      `
    ).all() as Array<{
      id: string;
      provider: string;
      provider_workspace_id: string;
      machine_id: string | null;
      machine_public_key: string | null;
      repo: string | null;
      branch: string | null;
      status: string;
      error: string | null;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      provider: row.provider as CloudWorkspaceRecord['provider'],
      providerWorkspaceId: row.provider_workspace_id,
      machineId: row.machine_id ?? undefined,
      machinePublicKey: row.machine_public_key ?? undefined,
      repo: row.repo ?? undefined,
      branch: row.branch ?? undefined,
      status: row.status as CloudWorkspaceRecord['status'],
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  });
}

// ============================================================================
// Vault Meta
// ============================================================================

export function getVaultMeta(key: VaultMetaKey): string | undefined {
  return withControlDb((db) => {
    const row = db.query('SELECT value FROM vault_meta WHERE key = ?').get(key) as
      | { value: string }
      | null;
    return row?.value;
  });
}

export function setVaultMeta(key: VaultMetaKey, value: string): void {
  withControlDb((db) => {
    db.query(
      `
      INSERT INTO vault_meta(key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE
      SET value = excluded.value
      `
    ).run(key, value);
  });
}

export function isVaultInitialized(): boolean {
  return getVaultMeta('vault_initialized') === '1';
}

// ============================================================================
// Vault Sync Categories CRUD
// ============================================================================

export interface UpsertVaultCategoryInput {
  category: VaultSyncCategory;
  encryptedEnvelope: string;
  writerId: string;
  checksum: string;
  /** Optional optimistic-concurrency guard (0 means record must not exist). */
  expectedRevision?: number;
}

interface VaultCategoryRow {
  category: string;
  encrypted_envelope: string;
  revision: number;
  writer_id: string;
  checksum: string;
  created_at: string;
  updated_at: string;
}

function mapVaultCategoryRow(row: VaultCategoryRow): VaultCategoryRecord {
  assertVaultSyncCategory(row.category);
  return {
    category: row.category,
    encryptedEnvelope: row.encrypted_envelope,
    revision: row.revision,
    writerId: row.writer_id,
    checksum: row.checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getVaultCategory(category: VaultSyncCategory): VaultCategoryRecord | undefined {
  return withControlDb((db) => {
    const row = db.query(
      'SELECT * FROM vault_sync_categories WHERE category = ?'
    ).get(category) as VaultCategoryRow | null;
    return row ? mapVaultCategoryRow(row) : undefined;
  });
}

export function listVaultCategories(): VaultCategoryRecord[] {
  return withControlDb((db) => {
    const rows = db.query(
      'SELECT * FROM vault_sync_categories ORDER BY updated_at DESC'
    ).all() as VaultCategoryRow[];
    return rows.map(mapVaultCategoryRow);
  });
}

export function removeVaultCategory(category: VaultSyncCategory): boolean {
  return withControlDb((db) => {
    const result = db.query(
      'DELETE FROM vault_sync_categories WHERE category = ?'
    ).run(category);
    return result.changes > 0;
  });
}

export function upsertVaultCategory(input: UpsertVaultCategoryInput): VaultCategoryRecord {
  return withControlDb((db) => {
    const now = nowIso();
    const existing = db.query(
      'SELECT revision, created_at FROM vault_sync_categories WHERE category = ?'
    ).get(input.category) as { revision: number; created_at: string } | null;

    if (input.expectedRevision !== undefined) {
      if (!existing && input.expectedRevision !== 0) {
        throw new SpacesError(
          `Revision mismatch for ${input.category}: expected ${input.expectedRevision}, current 0`,
          'USER_ERROR',
          1
        );
      }

      if (existing && existing.revision !== input.expectedRevision) {
        throw new SpacesError(
          `Revision mismatch for ${input.category}: expected ${input.expectedRevision}, current ${existing.revision}`,
          'USER_ERROR',
          1
        );
      }
    }

    const revision = existing ? existing.revision + 1 : 1;
    const createdAt = existing?.created_at ?? now;

    db.query(
      `
      INSERT INTO vault_sync_categories (
        category,
        encrypted_envelope,
        revision,
        writer_id,
        checksum,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(category) DO UPDATE
      SET encrypted_envelope = excluded.encrypted_envelope,
          revision = excluded.revision,
          writer_id = excluded.writer_id,
          checksum = excluded.checksum,
          updated_at = excluded.updated_at
      `
    ).run(
      input.category,
      input.encryptedEnvelope,
      revision,
      input.writerId,
      input.checksum,
      createdAt,
      now,
    );

    const row = db.query(
      'SELECT * FROM vault_sync_categories WHERE category = ?'
    ).get(input.category) as VaultCategoryRow;

    return mapVaultCategoryRow(row);
  });
}

// ============================================================================
// Vault Machines CRUD
// ============================================================================

export interface UpsertVaultMachineInput {
  machineId: string;
  ownerUserRootId: string;
  signingKey: string;
  keyExchangeKey: string;
  label?: string;
}

/**
 * Insert or update a persistent machine registration.
 * On re-registration, verifies ownership and signing key match.
 * Returns the upserted record.
 */
export function upsertVaultMachine(
  input: UpsertVaultMachineInput
): { success: true; record: VaultMachineRecord } | { success: false; error: string } {
  return withControlDb((db) => {
    const now = nowIso();

    const existing = db.query(
      'SELECT machine_id, owner_user_root_id, signing_key FROM vault_machines WHERE machine_id = ?'
    ).get(input.machineId) as {
      machine_id: string;
      owner_user_root_id: string;
      signing_key: string;
    } | null;

    if (existing) {
      // Security: Verify ownership — must be same user root
      if (existing.owner_user_root_id !== input.ownerUserRootId) {
        return {
          success: false as const,
          error: 'Machine already registered by different owner',
        };
      }
      // Security: Verify signing key matches — prevents key substitution
      if (existing.signing_key !== input.signingKey) {
        return {
          success: false as const,
          error: 'Signing key mismatch — machine identity has changed',
        };
      }

      // Safe to update
      db.query(
        `
        UPDATE vault_machines
        SET key_exchange_key = ?, label = COALESCE(?, label), last_connected_at = ?
        WHERE machine_id = ?
        `
      ).run(input.keyExchangeKey, input.label ?? null, now, input.machineId);

      const updated = db.query(
        'SELECT * FROM vault_machines WHERE machine_id = ?'
      ).get(input.machineId) as VaultMachineRow;

      return { success: true as const, record: mapVaultMachineRow(updated) };
    }

    // New registration
    db.query(
      `
      INSERT INTO vault_machines (
        machine_id, owner_user_root_id, signing_key, key_exchange_key,
        label, registered_at, last_connected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      input.machineId,
      input.ownerUserRootId,
      input.signingKey,
      input.keyExchangeKey,
      input.label ?? null,
      now,
      now
    );

    return {
      success: true as const,
      record: {
        machineId: input.machineId,
        ownerUserRootId: input.ownerUserRootId,
        signingKey: input.signingKey,
        keyExchangeKey: input.keyExchangeKey,
        label: input.label,
        registeredAt: now,
        lastConnectedAt: now,
      },
    };
  });
}

interface VaultMachineRow {
  machine_id: string;
  owner_user_root_id: string;
  signing_key: string;
  key_exchange_key: string;
  label: string | null;
  registered_at: string;
  last_connected_at: string;
}

function mapVaultMachineRow(row: VaultMachineRow): VaultMachineRecord {
  return {
    machineId: row.machine_id,
    ownerUserRootId: row.owner_user_root_id,
    signingKey: row.signing_key,
    keyExchangeKey: row.key_exchange_key,
    label: row.label ?? undefined,
    registeredAt: row.registered_at,
    lastConnectedAt: row.last_connected_at,
  };
}

export function getVaultMachine(machineId: string): VaultMachineRecord | undefined {
  return withControlDb((db) => {
    const row = db.query(
      'SELECT * FROM vault_machines WHERE machine_id = ?'
    ).get(machineId) as VaultMachineRow | null;
    return row ? mapVaultMachineRow(row) : undefined;
  });
}

export function getVaultMachineBySigningKey(signingKey: string): VaultMachineRecord | undefined {
  return withControlDb((db) => {
    const row = db.query(
      'SELECT * FROM vault_machines WHERE signing_key = ?'
    ).get(signingKey) as VaultMachineRow | null;
    return row ? mapVaultMachineRow(row) : undefined;
  });
}

export function listVaultMachines(ownerUserRootId?: string): VaultMachineRecord[] {
  return withControlDb((db) => {
    const rows = ownerUserRootId
      ? (db.query(
          'SELECT * FROM vault_machines WHERE owner_user_root_id = ? ORDER BY last_connected_at DESC'
        ).all(ownerUserRootId) as VaultMachineRow[])
      : (db.query(
          'SELECT * FROM vault_machines ORDER BY last_connected_at DESC'
        ).all() as VaultMachineRow[]);
    return rows.map(mapVaultMachineRow);
  });
}

export function updateVaultMachineLastConnected(machineId: string): void {
  withControlDb((db) => {
    db.query(
      'UPDATE vault_machines SET last_connected_at = ? WHERE machine_id = ?'
    ).run(nowIso(), machineId);
  });
}

export function removeVaultMachine(machineId: string): boolean {
  return withControlDb((db) => {
    const result = db.query(
      'DELETE FROM vault_machines WHERE machine_id = ?'
    ).run(machineId);
    return result.changes > 0;
  });
}

export function removeVaultMachineForOwner(ownerUserRootId: string, machineId: string): boolean {
  return withControlDb((db) => {
    const result = db.query(
      'DELETE FROM vault_machines WHERE owner_user_root_id = ? AND machine_id = ?'
    ).run(ownerUserRootId, machineId);
    return result.changes > 0;
  });
}

export function listVaultMachinesForOwner(ownerUserRootId: string): VaultMachineRecord[] {
  return listVaultMachines(ownerUserRootId);
}

// ============================================================================
// Vault Machine Unlock Keys CRUD
// ============================================================================

/**
 * Store an encrypted machine unlock key in the vault.
 * The unlock key is encrypted with the vault key (AES-256-GCM) before storage.
 */
export function setVaultMachineUnlockKey(
  machineId: string,
  encryptedUnlockKey: string
): void {
  const now = nowIso();
  withControlDb((db) => {
    db.query(
      `
      INSERT INTO vault_machine_unlock_keys (machine_id, encrypted_unlock_key, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(machine_id) DO UPDATE
      SET encrypted_unlock_key = excluded.encrypted_unlock_key,
          updated_at = excluded.updated_at
      `
    ).run(machineId, encryptedUnlockKey, now, now);
  });
}

export function getVaultMachineUnlockKey(
  machineId: string
): VaultMachineUnlockKeyRecord | undefined {
  return withControlDb((db) => {
    const row = db.query(
      'SELECT * FROM vault_machine_unlock_keys WHERE machine_id = ?'
    ).get(machineId) as {
      machine_id: string;
      encrypted_unlock_key: string;
      created_at: string;
      updated_at: string;
    } | null;

    if (!row) return undefined;

    return {
      machineId: row.machine_id,
      encryptedUnlockKey: row.encrypted_unlock_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export function removeVaultMachineUnlockKey(machineId: string): boolean {
  return withControlDb((db) => {
    const result = db.query(
      'DELETE FROM vault_machine_unlock_keys WHERE machine_id = ?'
    ).run(machineId);
    return result.changes > 0;
  });
}

export function listVaultMachineUnlockKeys(): VaultMachineUnlockKeyRecord[] {
  return withControlDb((db) => {
    const rows = db.query(
      'SELECT * FROM vault_machine_unlock_keys ORDER BY updated_at DESC'
    ).all() as Array<{
      machine_id: string;
      encrypted_unlock_key: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      machineId: row.machine_id,
      encryptedUnlockKey: row.encrypted_unlock_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  });
}

// ============================================================================
// Vault Access List CRUD
// ============================================================================

export interface GrantVaultAccessInput {
  ownerUserRootId: string;
  clientUserRootId: string;
  label?: string;
}

/**
 * Grant access to a client user root ID for a given owner.
 * Upserts — if the same (owner, client) pair exists, updates the label.
 */
export function grantVaultAccess(input: GrantVaultAccessInput): VaultAccessListEntry {
  return withControlDb((db) => {
    const now = nowIso();
    db.query(
      `
      INSERT INTO vault_access_list (owner_user_root_id, client_user_root_id, label, granted_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_user_root_id, client_user_root_id) DO UPDATE
      SET label = COALESCE(excluded.label, vault_access_list.label),
          granted_at = excluded.granted_at
      `
    ).run(input.ownerUserRootId, input.clientUserRootId, input.label ?? null, now);

    const row = db.query(
      `
      SELECT * FROM vault_access_list
      WHERE owner_user_root_id = ? AND client_user_root_id = ?
      `
    ).get(input.ownerUserRootId, input.clientUserRootId) as VaultAccessRow;

    return mapVaultAccessRow(row);
  });
}

interface VaultAccessRow {
  id: number;
  owner_user_root_id: string;
  client_user_root_id: string;
  label: string | null;
  granted_at: string;
}

function mapVaultAccessRow(row: VaultAccessRow): VaultAccessListEntry {
  return {
    id: row.id,
    ownerUserRootId: row.owner_user_root_id,
    clientUserRootId: row.client_user_root_id,
    label: row.label ?? undefined,
    grantedAt: row.granted_at,
  };
}

export function revokeVaultAccess(
  ownerUserRootId: string,
  clientUserRootId: string
): boolean {
  return withControlDb((db) => {
    const result = db.query(
      'DELETE FROM vault_access_list WHERE owner_user_root_id = ? AND client_user_root_id = ?'
    ).run(ownerUserRootId, clientUserRootId);
    return result.changes > 0;
  });
}

export function listVaultAccessList(ownerUserRootId: string): VaultAccessListEntry[] {
  return withControlDb((db) => {
    const rows = db.query(
      'SELECT * FROM vault_access_list WHERE owner_user_root_id = ? ORDER BY granted_at DESC'
    ).all(ownerUserRootId) as VaultAccessRow[];
    return rows.map(mapVaultAccessRow);
  });
}

export function isVaultAccessGranted(
  ownerUserRootId: string,
  clientUserRootId: string
): boolean {
  return withControlDb((db) => {
    const row = db.query(
      'SELECT 1 FROM vault_access_list WHERE owner_user_root_id = ? AND client_user_root_id = ?'
    ).get(ownerUserRootId, clientUserRootId);
    return row !== null;
  });
}
