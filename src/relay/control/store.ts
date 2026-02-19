import { Database } from 'bun:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSpacesDir } from '../../core/config.js';
import { SpacesError } from '../../types/errors.js';
import { applyControlMigrations } from './schema.js';
import type {
  CloudBootstrapState,
  CloudBootstrapTokenRecord,
  CloudWorkspaceRecord,
  ControlMeta,
} from './types.js';

const CONTROL_SCHEMA_VERSION = 3;
const CONTROL_DIR_OVERRIDE_ENV = 'GITSPACE_CONTROL_DIR';

const META_KEY_SCHEMA_VERSION = 'schema_version';
const META_KEY_OWNER_IDENTITY_ID = 'owner_identity_id';
const META_KEY_CREATED_AT = 'created_at';
const META_KEY_UPDATED_AT = 'updated_at';
const META_KEY_LEGACY_META_IMPORTED = 'legacy_meta_imported';
const META_KEY_RELAY_IDENTITY_ID = 'relay_identity_id';
const META_KEY_RELAY_SIGNING_PUBLIC_KEY = 'relay_signing_public_key';
const META_KEY_RELAY_FINGERPRINT = 'relay_fingerprint';

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

export function getLegacyControlMetaPath(): string {
  return join(getControlDirPath(), 'meta.json');
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

function importLegacyMetaIfPresent(db: Database): void {
  const alreadyImported = getMetaValue(db, META_KEY_LEGACY_META_IMPORTED) === '1';
  if (alreadyImported) {
    return;
  }

  const legacyPath = getLegacyControlMetaPath();
  if (!existsSync(legacyPath)) {
    setMetaValue(db, META_KEY_LEGACY_META_IMPORTED, '1');
    return;
  }

  try {
    const content = readFileSync(legacyPath, 'utf-8');
    const legacy = JSON.parse(content) as Partial<ControlMeta>;

    if (legacy.createdAt && !getMetaValue(db, META_KEY_CREATED_AT)) {
      setMetaValue(db, META_KEY_CREATED_AT, legacy.createdAt);
    }

    if (legacy.ownerIdentityId && !getMetaValue(db, META_KEY_OWNER_IDENTITY_ID)) {
      setMetaValue(db, META_KEY_OWNER_IDENTITY_ID, legacy.ownerIdentityId);
    }
  } catch (error) {
    throw new SpacesError(
      `Failed to import legacy control metadata: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }

  setMetaValue(db, META_KEY_LEGACY_META_IMPORTED, '1');
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
    importLegacyMetaIfPresent(db);
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

export function getControlOwnerIdentityId(): string | undefined {
  return withControlDb((db) => getMetaValue(db, META_KEY_OWNER_IDENTITY_ID));
}

export function isControlOwner(identityId: string): boolean {
  const ownerIdentityId = getControlOwnerIdentityId();
  return ownerIdentityId === identityId;
}

export function assertControlOwner(identityId: string): void {
  const ownerIdentityId = getControlOwnerIdentityId();
  if (!ownerIdentityId) {
    throw new SpacesError(
      'Control relay owner is not initialized.',
      'SYSTEM_ERROR',
      2
    );
  }

  if (ownerIdentityId !== identityId) {
    throw new SpacesError(
      `Control relay owner mismatch. This control node is owned by '${ownerIdentityId}', but current identity is '${identityId}'.`,
      'USER_ERROR',
      1
    );
  }
}

export function bindControlOwner(ownerIdentityId: string): { bound: boolean; ownerIdentityId: string } {
  return withControlDb((db) => {
    const currentOwner = getMetaValue(db, META_KEY_OWNER_IDENTITY_ID);

    if (!currentOwner) {
      setMetaValue(db, META_KEY_OWNER_IDENTITY_ID, ownerIdentityId);
      setMetaValue(db, META_KEY_UPDATED_AT, nowIso());
      return { bound: true, ownerIdentityId };
    }

    if (currentOwner !== ownerIdentityId) {
      throw new SpacesError(
        `Control relay owner mismatch. This control node is owned by '${currentOwner}', but current identity is '${ownerIdentityId}'.`,
        'USER_ERROR',
        1
      );
    }

    return { bound: false, ownerIdentityId };
  });
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
        `Control relay identity mismatch. Pinned relay '${currentRelayFingerprint ?? currentRelayIdentityId}', current relay '${input.relayFingerprint}'.`,
        'USER_ERROR',
        1
      );
    }

    return { bound: false, relayIdentityId: input.relayIdentityId };
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
 */
export function updateCloudWorkspaceStatus(
  id: string,
  status: CloudWorkspaceRecord['status'],
  error?: string
): void {
  const now = nowIso();
  // Non-error statuses clear the stored error field
  const errorValue = status === 'error' ? (error ?? null) : null;
  withControlDb((db) => {
    db.query(
      `
      UPDATE cloud_workspaces
      SET status = ?, error = ?, updated_at = ?
      WHERE id = ?
      `
    ).run(status, errorValue, now, id);
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
          consumed_at
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
        SELECT machine_public_key
        FROM cloud_workspaces
        WHERE id = ?
        `
      ).get(row.workspace_id) as { machine_public_key: string | null } | null;

      if (!workspaceRow) {
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
          b.owner_identity_id
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

      if (row.machine_public_key !== input.machineSigningPublicKey) {
        db.exec('ROLLBACK');
        return null;
      }

      const workspaceRow = db.query(
        `
        SELECT machine_public_key
        FROM cloud_workspaces
        WHERE id = ?
        `
      ).get(row.workspace_id) as { machine_public_key: string | null } | null;

      if (!workspaceRow) {
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
