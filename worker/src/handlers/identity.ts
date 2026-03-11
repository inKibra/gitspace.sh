import { Hono } from 'hono';
import type { Env, IdentityBackupRecord } from '../types';
import type { AuthContext } from '../middleware/auth';

interface IdentityBackupEnvelope {
  version: number;
  algorithm: string;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  createdAt: number;
  updatedAt: number;
}

interface IdentityBackupPayload {
  version: number;
  kind: string;
  ownerUserRootId: string;
  envelope: IdentityBackupEnvelope;
  createdAt: number;
  updatedAt: number;
}

const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();

function isValidEnvelope(value: unknown): value is IdentityBackupEnvelope {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const envelope = value as Partial<IdentityBackupEnvelope>;
  return envelope.version === 1
    && typeof envelope.algorithm === 'string'
    && typeof envelope.iterations === 'number'
    && typeof envelope.salt === 'string'
    && typeof envelope.iv === 'string'
    && typeof envelope.ciphertext === 'string'
    && typeof envelope.createdAt === 'number'
    && typeof envelope.updatedAt === 'number';
}

function isValidBackupPayload(value: unknown): value is IdentityBackupPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const payload = value as Partial<IdentityBackupPayload>;
  return payload.version === 1
    && payload.kind === 'user-root-mnemonic'
    && typeof payload.ownerUserRootId === 'string'
    && typeof payload.createdAt === 'number'
    && typeof payload.updatedAt === 'number'
    && isValidEnvelope(payload.envelope);
}

function serializeBackup(record: IdentityBackupRecord): IdentityBackupPayload {
  return {
    version: record.version,
    kind: record.kind,
    ownerUserRootId: record.owner_user_root_id,
    envelope: JSON.parse(record.envelope_json) as IdentityBackupEnvelope,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

async function getBackupRow(db: D1Database, userId: string): Promise<IdentityBackupRecord | null> {
  return db
    .prepare(
      `
      SELECT user_id, version, kind, owner_user_root_id, envelope_json, created_at, updated_at
      FROM identity_backups
      WHERE user_id = ?
    `,
    )
    .bind(userId)
    .first<IdentityBackupRecord>();
}

app.get('/backup', async (c) => {
  const user = c.get('user');
  const record = await getBackupRow(c.env.DB, user.id);
  if (!record) {
    return c.json({ error: 'Identity backup not found' }, 404);
  }

  return c.json(serializeBackup(record));
});

app.put('/backup', async (c) => {
  const user = c.get('user');
  const payload = await c.req.json().catch(() => null);
  if (!isValidBackupPayload(payload)) {
    return c.json({ error: 'Invalid identity backup payload' }, 400);
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `
    INSERT INTO identity_backups (
      user_id, version, kind, owner_user_root_id, envelope_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      version = excluded.version,
      kind = excluded.kind,
      owner_user_root_id = excluded.owner_user_root_id,
      envelope_json = excluded.envelope_json,
      updated_at = excluded.updated_at
  `,
  )
    .bind(
      user.id,
      payload.version,
      payload.kind,
      payload.ownerUserRootId,
      JSON.stringify(payload.envelope),
      now,
      now,
    )
    .run();

  const backup = await getBackupRow(c.env.DB, user.id);
  return c.json({ success: true, backup: backup ? serializeBackup(backup) : payload });
});

app.delete('/backup', async (c) => {
  const user = c.get('user');
  const result = await c.env.DB.prepare('DELETE FROM identity_backups WHERE user_id = ?')
    .bind(user.id)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    return c.json({ error: 'Identity backup not found' }, 404);
  }

  return c.json({ success: true });
});

app.get('/backup/status', async (c) => {
  const user = c.get('user');
  const record = await getBackupRow(c.env.DB, user.id);
  if (!record) {
    return c.json({ enabled: false });
  }

  return c.json({
    enabled: true,
    ownerUserRootId: record.owner_user_root_id,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  });
});

export default app;
