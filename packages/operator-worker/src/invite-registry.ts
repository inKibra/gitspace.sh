import { DurableObject } from 'cloudflare:workers';

const INVITE_PREFIX = 'gsi_';
const RESERVATION_TTL_MS = 10 * 60 * 1000;
const MAX_INVITES = 500;

interface InviteRow {
  [key: string]: SqlStorageValue;
  id: string;
  token_hash: string;
  note: string;
  created_at: number;
  expires_at: number | null;
  reserved_by: string | null;
  reserved_at: number | null;
  reserved_handle: string | null;
  consumed_by: string | null;
  consumed_handle: string | null;
  consumed_at: number | null;
  revoked_at: number | null;
}

export interface OperatorInviteView {
  id: string;
  note: string;
  createdAt: number;
  expiresAt: number | null;
  status: 'available' | 'reserved' | 'consumed' | 'revoked' | 'expired';
  consumedBy: string | null;
  consumedHandle: string | null;
  consumedAt: number | null;
  revokedAt: number | null;
}

export type InviteReservation =
  | { status: 'reserved' | 'already-consumed' }
  | { status: 'invalid'; reason: 'not-found' | 'expired' | 'revoked' | 'consumed' | 'reserved' };

function encodeToken(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${INVITE_PREFIX}${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
}

async function tokenHash(token: string): Promise<string | null> {
  if (!/^gsi_[A-Za-z0-9_-]{43}$/u.test(token)) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function inviteView(row: InviteRow, now = Date.now()): OperatorInviteView {
  const reservationActive = row.reserved_at !== null && row.reserved_at + RESERVATION_TTL_MS > now;
  const status = row.revoked_at !== null
    ? 'revoked'
    : row.consumed_at !== null
      ? 'consumed'
      : row.expires_at !== null && row.expires_at <= now
        ? 'expired'
        : reservationActive
          ? 'reserved'
          : 'available';
  return {
    id: row.id,
    note: row.note,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status,
    consumedBy: row.consumed_by,
    consumedHandle: row.consumed_handle,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
  };
}

export class InviteRegistryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        note TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        reserved_by TEXT,
        reserved_handle TEXT,
        reserved_at INTEGER,
        consumed_by TEXT,
        consumed_handle TEXT,
        consumed_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS invites_created_at ON invites (created_at DESC);
    `);
  }

  async create(input: { note: string; expiresAt: number | null }): Promise<{ invite: OperatorInviteView; token: string }> {
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = encodeToken(tokenBytes);
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const hash = await tokenHash(token);
    if (!hash) throw new Error('Generated invite token is invalid');
    this.ctx.storage.sql.exec(
      'INSERT INTO invites (id, token_hash, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      id,
      hash,
      input.note,
      createdAt,
      input.expiresAt,
    );
    this.ctx.storage.sql.exec(`DELETE FROM invites WHERE id IN (
      SELECT id FROM invites ORDER BY created_at DESC LIMIT -1 OFFSET ?
    ) AND consumed_at IS NOT NULL`, MAX_INVITES);
    return {
      invite: {
        id,
        note: input.note,
        createdAt,
        expiresAt: input.expiresAt,
        status: 'available',
        consumedBy: null,
        consumedHandle: null,
        consumedAt: null,
        revokedAt: null,
      },
      token,
    };
  }

  list(): OperatorInviteView[] {
    return this.ctx.storage.sql.exec<InviteRow>('SELECT * FROM invites ORDER BY created_at DESC LIMIT ?', MAX_INVITES)
      .toArray()
      .map((row) => inviteView(row));
  }

  revoke(id: string): { revoked: boolean } {
    const changed = this.ctx.storage.sql.exec(
      'UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND consumed_at IS NULL',
      Date.now(),
      id,
    ).rowsWritten > 0;
    return { revoked: changed };
  }

  async reserve(input: { token: string; userId: string; handle: string }): Promise<InviteReservation> {
    const hash = await tokenHash(input.token);
    if (!hash) return { status: 'invalid', reason: 'not-found' };
    const row = this.ctx.storage.sql.exec<InviteRow>('SELECT * FROM invites WHERE token_hash = ?', hash).toArray()[0];
    if (!row) return { status: 'invalid', reason: 'not-found' };
    const now = Date.now();
    if (row.revoked_at !== null) return { status: 'invalid', reason: 'revoked' };
    if (row.expires_at !== null && row.expires_at <= now) return { status: 'invalid', reason: 'expired' };
    if (row.consumed_at !== null) {
      return row.consumed_by === input.userId && row.consumed_handle === input.handle
        ? { status: 'already-consumed' }
        : { status: 'invalid', reason: 'consumed' };
    }
    const reservationActive = row.reserved_at !== null && row.reserved_at + RESERVATION_TTL_MS > now;
    if (reservationActive && (row.reserved_by !== input.userId || row.reserved_handle !== input.handle)) {
      return { status: 'invalid', reason: 'reserved' };
    }
    this.ctx.storage.sql.exec('UPDATE invites SET reserved_by = ?, reserved_handle = ?, reserved_at = ? WHERE id = ?', input.userId, input.handle, now, row.id);
    return { status: 'reserved' };
  }

  async consume(input: { token: string; userId: string; handle: string }): Promise<{ consumed: boolean }> {
    const hash = await tokenHash(input.token);
    if (!hash) return { consumed: false };
    const changed = this.ctx.storage.sql.exec(
      `UPDATE invites SET consumed_by = ?, consumed_handle = ?, consumed_at = ?, reserved_by = NULL, reserved_handle = NULL, reserved_at = NULL
       WHERE token_hash = ? AND revoked_at IS NULL AND consumed_at IS NULL AND reserved_by = ? AND reserved_handle = ?`,
      input.userId,
      input.handle,
      Date.now(),
      hash,
      input.userId,
      input.handle,
    ).rowsWritten > 0;
    if (changed) return { consumed: true };
    const row = this.ctx.storage.sql.exec<InviteRow>('SELECT * FROM invites WHERE token_hash = ?', hash).toArray()[0];
    return { consumed: row?.consumed_by === input.userId && row.consumed_handle === input.handle };
  }

  async release(input: { token: string; userId: string }): Promise<void> {
    const hash = await tokenHash(input.token);
    if (!hash) return;
    this.ctx.storage.sql.exec(
      'UPDATE invites SET reserved_by = NULL, reserved_handle = NULL, reserved_at = NULL WHERE token_hash = ? AND reserved_by = ? AND consumed_at IS NULL',
      hash,
      input.userId,
    );
  }
}
