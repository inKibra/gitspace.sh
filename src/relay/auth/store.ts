/**
 * Auth persistence for relay ACL and root-signed invites.
 *
 * This module owns user-root keyed authorization data and stores it in the
 * relay control database.
 */

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SpacesError } from '../../types/errors.js';
import { applyControlMigrations } from '../control/schema.js';
import { getControlDbPath } from '../control/store.js';
import type {
  MachineAccessListEntry,
  RelayAccessListEntry,
  RootInviteRecord,
  RootInviteRecordType,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ensureControlDir(): void {
  const controlDir = dirname(getControlDbPath());
  if (!existsSync(controlDir)) {
    mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  }
}

function openAuthDb(): Database {
  ensureControlDir();
  const db = new Database(getControlDbPath(), { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function ensureAuthTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_access_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_root_id TEXT NOT NULL,
      client_user_root_id TEXT NOT NULL,
      label TEXT,
      granted_at TEXT NOT NULL,
      UNIQUE(owner_user_root_id, client_user_root_id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_relay_access_owner
    ON relay_access_list(owner_user_root_id)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS machine_access_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT NOT NULL,
      owner_user_root_id TEXT NOT NULL,
      client_user_root_id TEXT NOT NULL,
      label TEXT,
      granted_at TEXT NOT NULL,
      UNIQUE(machine_id, client_user_root_id),
      FOREIGN KEY (machine_id) REFERENCES vault_machines(machine_id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_machine_access_machine
    ON machine_access_list(machine_id)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_machine_access_owner
    ON machine_access_list(owner_user_root_id)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS root_invites (
      invite_id TEXT PRIMARY KEY,
      owner_user_root_id TEXT NOT NULL,
      invite_type TEXT NOT NULL,
      relay_url TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT,
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      target_user_root_id TEXT,
      machine_id TEXT,
      target_machine_signing_key TEXT,
      target_machine_key_exchange_key TEXT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_root_invites_owner
    ON root_invites(owner_user_root_id)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_root_invites_type
    ON root_invites(invite_type)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_root_invites_expires
    ON root_invites(expires_at)
  `);
}

function withAuthDb<T>(handler: (db: Database) => T): T {
  const db = openAuthDb();
  try {
    applyControlMigrations(db);
    ensureAuthTables(db);
    return handler(db);
  } finally {
    db.close();
  }
}

// ============================================================================
// Relay Access List CRUD (user-root keyed)
// ============================================================================

export interface GrantRelayAccessInput {
  ownerUserRootId: string;
  clientUserRootId: string;
  label?: string;
}

interface RelayAccessRow {
  id: number;
  owner_user_root_id: string;
  client_user_root_id: string;
  label: string | null;
  granted_at: string;
}

function mapRelayAccessRow(row: RelayAccessRow): RelayAccessListEntry {
  return {
    id: row.id,
    ownerUserRootId: row.owner_user_root_id,
    clientUserRootId: row.client_user_root_id,
    label: row.label ?? undefined,
    grantedAt: row.granted_at,
  };
}

export function grantRelayAccess(input: GrantRelayAccessInput): RelayAccessListEntry {
  return withAuthDb((db) => {
    const now = nowIso();
    db.query(
      `
      INSERT INTO relay_access_list (owner_user_root_id, client_user_root_id, label, granted_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_user_root_id, client_user_root_id) DO UPDATE
      SET label = COALESCE(excluded.label, relay_access_list.label),
          granted_at = excluded.granted_at
      `
    ).run(input.ownerUserRootId, input.clientUserRootId, input.label ?? null, now);

    const row = db.query(
      `
      SELECT * FROM relay_access_list
      WHERE owner_user_root_id = ? AND client_user_root_id = ?
      `
    ).get(input.ownerUserRootId, input.clientUserRootId) as RelayAccessRow;

    return mapRelayAccessRow(row);
  });
}

export function revokeRelayAccess(
  ownerUserRootId: string,
  clientUserRootId: string
): boolean {
  return withAuthDb((db) => {
    const result = db.query(
      'DELETE FROM relay_access_list WHERE owner_user_root_id = ? AND client_user_root_id = ?'
    ).run(ownerUserRootId, clientUserRootId);
    return result.changes > 0;
  });
}

export function listRelayAccessList(ownerUserRootId: string): RelayAccessListEntry[] {
  return withAuthDb((db) => {
    const rows = db.query(
      'SELECT * FROM relay_access_list WHERE owner_user_root_id = ? ORDER BY granted_at DESC'
    ).all(ownerUserRootId) as RelayAccessRow[];
    return rows.map(mapRelayAccessRow);
  });
}

export function isRelayAccessGranted(
  ownerUserRootId: string,
  clientUserRootId: string
): boolean {
  return withAuthDb((db) => {
    const row = db.query(
      'SELECT 1 FROM relay_access_list WHERE owner_user_root_id = ? AND client_user_root_id = ?'
    ).get(ownerUserRootId, clientUserRootId);
    return row !== null;
  });
}

// ============================================================================
// Machine Access List CRUD (user-root keyed, machine-scoped)
// ============================================================================

export interface GrantMachineAccessInput {
  machineId: string;
  ownerUserRootId: string;
  clientUserRootId: string;
  label?: string;
}

interface MachineAccessRow {
  id: number;
  machine_id: string;
  owner_user_root_id: string;
  client_user_root_id: string;
  label: string | null;
  granted_at: string;
}

function mapMachineAccessRow(row: MachineAccessRow): MachineAccessListEntry {
  return {
    id: row.id,
    machineId: row.machine_id,
    ownerUserRootId: row.owner_user_root_id,
    clientUserRootId: row.client_user_root_id,
    label: row.label ?? undefined,
    grantedAt: row.granted_at,
  };
}

export function grantMachineAccess(input: GrantMachineAccessInput): MachineAccessListEntry {
  return withAuthDb((db) => {
    const ownerRow = db.query(
      'SELECT owner_user_root_id FROM vault_machines WHERE machine_id = ?'
    ).get(input.machineId) as { owner_user_root_id: string } | null;

    if (!ownerRow) {
      throw new SpacesError(
        `Machine '${input.machineId}' is not registered`,
        'USER_ERROR',
        1
      );
    }

    if (ownerRow.owner_user_root_id !== input.ownerUserRootId) {
      throw new SpacesError(
        `Machine '${input.machineId}' is owned by a different user root`,
        'USER_ERROR',
        1
      );
    }

    const now = nowIso();
    db.query(
      `
      INSERT INTO machine_access_list (machine_id, owner_user_root_id, client_user_root_id, label, granted_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(machine_id, client_user_root_id) DO UPDATE
      SET label = COALESCE(excluded.label, machine_access_list.label),
          granted_at = excluded.granted_at
      `
    ).run(
      input.machineId,
      input.ownerUserRootId,
      input.clientUserRootId,
      input.label ?? null,
      now
    );

    const row = db.query(
      `
      SELECT * FROM machine_access_list
      WHERE machine_id = ? AND client_user_root_id = ?
      `
    ).get(input.machineId, input.clientUserRootId) as MachineAccessRow;

    return mapMachineAccessRow(row);
  });
}

export function revokeMachineAccess(
  machineId: string,
  ownerUserRootId: string,
  clientUserRootId: string
): boolean {
  return withAuthDb((db) => {
    const result = db.query(
      `
      DELETE FROM machine_access_list
      WHERE machine_id = ? AND owner_user_root_id = ? AND client_user_root_id = ?
      `
    ).run(machineId, ownerUserRootId, clientUserRootId);
    return result.changes > 0;
  });
}

export function listMachineAccessList(
  machineId: string,
  ownerUserRootId: string
): MachineAccessListEntry[] {
  return withAuthDb((db) => {
    const rows = db.query(
      `
      SELECT * FROM machine_access_list
      WHERE machine_id = ? AND owner_user_root_id = ?
      ORDER BY granted_at DESC
      `
    ).all(machineId, ownerUserRootId) as MachineAccessRow[];
    return rows.map(mapMachineAccessRow);
  });
}

export function isMachineAccessGranted(
  machineId: string,
  ownerUserRootId: string,
  clientUserRootId: string
): boolean {
  return withAuthDb((db) => {
    const row = db.query(
      `
      SELECT 1 FROM machine_access_list
      WHERE machine_id = ? AND owner_user_root_id = ? AND client_user_root_id = ?
      `
    ).get(machineId, ownerUserRootId, clientUserRootId);
    return row !== null;
  });
}

// ============================================================================
// Root-Signed Invite CRUD + Consumption
// ============================================================================

interface RootInviteRow {
  invite_id: string;
  owner_user_root_id: string;
  invite_type: RootInviteRecordType;
  relay_url: string;
  token_hash: string;
  label: string | null;
  max_uses: number | null;
  used_count: number;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
  target_user_root_id: string | null;
  machine_id: string | null;
  target_machine_signing_key: string | null;
  target_machine_key_exchange_key: string | null;
}

function mapRootInviteRow(row: RootInviteRow): RootInviteRecord {
  return {
    inviteId: row.invite_id,
    ownerUserRootId: row.owner_user_root_id,
    inviteType: row.invite_type,
    relayUrl: row.relay_url,
    tokenHash: row.token_hash,
    label: row.label ?? undefined,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? undefined,
    machineId: row.machine_id ?? undefined,
    targetMachineSigningKey: row.target_machine_signing_key ?? undefined,
    targetMachineKeyExchangeKey: row.target_machine_key_exchange_key ?? undefined,
  };
}

export function hashRootInviteToken(token: string): string {
  return sha256Hex(token.trim());
}

export interface RegisterRootInviteInput {
  inviteId: string;
  ownerUserRootId: string;
  inviteType: RootInviteRecordType;
  relayUrl: string;
  token: string;
  maxUses: number | null;
  expiresAt: string;
  label?: string;
  machineId?: string;
  targetMachineSigningKey?: string;
  targetMachineKeyExchangeKey?: string;
}

function validateRootInviteInput(input: RegisterRootInviteInput): void {
  if (!input.inviteId.trim()) {
    throw new SpacesError('Invite ID is required', 'USER_ERROR', 1);
  }
  if (!input.ownerUserRootId.trim()) {
    throw new SpacesError('Owner user root id is required', 'USER_ERROR', 1);
  }
  if (!input.relayUrl.trim()) {
    throw new SpacesError('Relay URL is required', 'USER_ERROR', 1);
  }
  if (!input.token.trim()) {
    throw new SpacesError('Invite token is required', 'USER_ERROR', 1);
  }
  if (input.maxUses !== null && (!Number.isInteger(input.maxUses) || input.maxUses <= 0)) {
    throw new SpacesError('maxUses must be a positive integer or null', 'USER_ERROR', 1);
  }

  if (!input.machineId?.trim()) {
    throw new SpacesError('machineId is required for relay-machine invites', 'USER_ERROR', 1);
  }
  if (!input.targetMachineSigningKey?.trim() || !input.targetMachineKeyExchangeKey?.trim()) {
    throw new SpacesError('Machine signing and key exchange keys are required for relay-machine invites', 'USER_ERROR', 1);
  }
}

export function registerRootInvite(input: RegisterRootInviteInput): RootInviteRecord {
  validateRootInviteInput(input);
  const now = nowIso();
  const tokenHash = hashRootInviteToken(input.token);

  return withAuthDb((db) => {
    db.query(
      `
      INSERT INTO root_invites (
        invite_id,
        owner_user_root_id,
        invite_type,
        relay_url,
        token_hash,
        label,
        max_uses,
        used_count,
        expires_at,
        created_at,
        revoked_at,
        target_user_root_id,
        machine_id,
        target_machine_signing_key,
        target_machine_key_exchange_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, ?)
      `
    ).run(
      input.inviteId,
      input.ownerUserRootId,
      input.inviteType,
      input.relayUrl,
      tokenHash,
      input.label ?? null,
      input.maxUses,
      input.expiresAt,
      now,
      null,
      input.machineId ?? null,
      input.targetMachineSigningKey ?? null,
      input.targetMachineKeyExchangeKey ?? null,
    );

    const row = db.query(
      `
      SELECT * FROM root_invites
      WHERE invite_id = ?
      `
    ).get(input.inviteId) as RootInviteRow;

    return mapRootInviteRow(row);
  });
}

export function listRootInvites(
  ownerUserRootId: string,
  options: {
    inviteType?: RootInviteRecordType;
    includeRevoked?: boolean;
    includeExpired?: boolean;
  } = {},
): RootInviteRecord[] {
  return withAuthDb((db) => {
    const clauses = ['owner_user_root_id = ?'];
    const params: Array<string | number> = [ownerUserRootId];

    if (options.inviteType) {
      clauses.push('invite_type = ?');
      params.push(options.inviteType);
    }

    if (!options.includeRevoked) {
      clauses.push('revoked_at IS NULL');
    }

    if (!options.includeExpired) {
      clauses.push('expires_at > ?');
      params.push(nowIso());
    }

    const rows = db.query(
      `
      SELECT * FROM root_invites
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC
      `
    ).all(...params) as RootInviteRow[];

    return rows.map(mapRootInviteRow);
  });
}

export function revokeRootInvite(ownerUserRootId: string, inviteId: string): boolean {
  return withAuthDb((db) => {
    const result = db.query(
      `
      UPDATE root_invites
      SET revoked_at = ?
      WHERE owner_user_root_id = ? AND invite_id = ? AND revoked_at IS NULL
      `
    ).run(nowIso(), ownerUserRootId, inviteId);

    return result.changes > 0;
  });
}

function selectRootInviteByToken(
  db: Database,
  inviteId: string,
  ownerUserRootId: string,
  tokenHash: string,
): RootInviteRow | null {
  return db.query(
    `
    SELECT * FROM root_invites
    WHERE invite_id = ? AND owner_user_root_id = ? AND token_hash = ?
    LIMIT 1
    `
  ).get(inviteId, ownerUserRootId, tokenHash) as RootInviteRow | null;
}

function isRootInviteRowUsable(row: RootInviteRow): boolean {
  if (row.revoked_at) {
    return false;
  }

  if (row.expires_at <= nowIso()) {
    return false;
  }

  if (row.max_uses !== null && row.used_count >= row.max_uses) {
    return false;
  }

  return true;
}

export function getRootInviteByToken(
  inviteId: string,
  ownerUserRootId: string,
  token: string,
): RootInviteRecord | null {
  const tokenHash = hashRootInviteToken(token);
  return withAuthDb((db) => {
    const row = selectRootInviteByToken(db, inviteId, ownerUserRootId, tokenHash);
    if (!row || !isRootInviteRowUsable(row)) {
      return null;
    }
    return mapRootInviteRow(row);
  });
}

export function consumeRootInviteToken(
  inviteId: string,
  ownerUserRootId: string,
  token: string,
): RootInviteRecord | null {
  const tokenHash = hashRootInviteToken(token);
  return withAuthDb((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = selectRootInviteByToken(db, inviteId, ownerUserRootId, tokenHash);
      if (!row || !isRootInviteRowUsable(row)) {
        db.exec('ROLLBACK');
        return null;
      }

      db.query(
        `
        UPDATE root_invites
        SET used_count = used_count + 1
        WHERE invite_id = ?
        `
      ).run(inviteId);

      const updated = db.query(
        `
        SELECT * FROM root_invites
        WHERE invite_id = ?
        LIMIT 1
        `
      ).get(inviteId) as RootInviteRow;

      db.exec('COMMIT');
      return mapRootInviteRow(updated);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

export type {
  RelayAccessListEntry,
  MachineAccessListEntry,
  RootInviteRecord,
  RootInviteRecordType,
};
