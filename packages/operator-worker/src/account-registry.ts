import { DurableObject } from 'cloudflare:workers';

export type OperatorAccountStatus = 'provisioning' | 'active' | 'quarantined' | 'suspended' | 'failed';
export interface OperatorAccountRecord {
  userId: string;
  handle: string;
  status: OperatorAccountStatus;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
  tenantHostname: string;
  tenantRelease: string | null;
  tenantProvisionedAt: number | null;
  lastError: string | null;
}
export interface OperatorAccountEvent {
  id: string;
  userId: string;
  action: string;
  actor: string;
  reason: string | null;
  createdAt: number;
}

interface AccountRow extends Record<string, SqlStorageValue> {
  user_id: string;
  handle: string;
  status: OperatorAccountStatus;
  reason: string | null;
  created_at: number;
  updated_at: number;
  tenant_hostname: string;
  tenant_release: string | null;
  tenant_provisioned_at: number | null;
  last_error: string | null;
}
interface EventRow extends Record<string, SqlStorageValue> {
  id: string;
  user_id: string;
  action: string;
  actor: string;
  reason: string | null;
  created_at: number;
}

function accountFromRow(row: AccountRow): OperatorAccountRecord {
  return {
    userId: row.user_id,
    handle: row.handle,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tenantHostname: row.tenant_hostname,
    tenantRelease: row.tenant_release,
    tenantProvisionedAt: row.tenant_provisioned_at,
    lastError: row.last_error,
  };
}

export class AccountRegistryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        user_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'quarantined', 'suspended', 'failed')),
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        tenant_hostname TEXT NOT NULL,
        tenant_release TEXT,
        tenant_provisioned_at INTEGER,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS accounts_created_at ON accounts (created_at DESC);
      CREATE TABLE IF NOT EXISTS account_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS account_events_user_created ON account_events (user_id, created_at DESC);
    `);
  }

  upsertProvisioning(input: { userId: string; handle: string; createdAt?: number }): OperatorAccountRecord {
    const existing = this.get(input.userId);
    if (existing && existing.handle !== input.handle) throw new Error('Account handle is permanent');
    if (existing?.status === 'suspended' || existing?.status === 'quarantined') throw new Error('Account is blocked');
    const now = Date.now();
    const createdAt = input.createdAt ?? now;
    this.ctx.storage.sql.exec(`
      INSERT INTO accounts (user_id, handle, status, reason, created_at, updated_at, tenant_hostname, tenant_release, tenant_provisioned_at, last_error)
      VALUES (?, ?, 'provisioning', NULL, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT(user_id) DO UPDATE SET status = CASE WHEN accounts.status = 'failed' THEN 'provisioning' ELSE accounts.status END, updated_at = excluded.updated_at
    `, input.userId, input.handle, createdAt, now, `${input.handle}.gssh.dev`);
    return this.require(input.userId);
  }

  markActive(input: { userId: string; release: string | null; provisionedAt?: number }): OperatorAccountRecord {
    const now = Date.now();
    const changed = this.ctx.storage.sql.exec(`
      UPDATE accounts SET status = 'active', reason = NULL, updated_at = ?, tenant_release = ?,
        tenant_provisioned_at = COALESCE(tenant_provisioned_at, ?), last_error = NULL WHERE user_id = ? AND status IN ('provisioning', 'active')
    `, now, input.release, input.provisionedAt ?? now, input.userId).rowsWritten > 0;
    if (!changed) throw new Error('Account provisioning cannot activate a blocked or failed account');
    return this.require(input.userId);
  }

  markFailed(input: { userId: string; message: string }): OperatorAccountRecord | null {
    const changed = this.ctx.storage.sql.exec(
      "UPDATE accounts SET status = 'failed', updated_at = ?, last_error = ? WHERE user_id = ? AND status = 'provisioning'",
      Date.now(),
      input.message.slice(0, 500),
      input.userId,
    ).rowsWritten > 0;
    return changed ? this.require(input.userId) : null;
  }

  setStatus(input: { userId: string; status: 'active' | 'quarantined' | 'suspended'; reason: string | null; actor: string; action: string }): OperatorAccountRecord {
    const now = Date.now();
    const reason = input.reason?.trim().slice(0, 500) || null;
    const changed = this.ctx.storage.sql.exec(
      'UPDATE accounts SET status = ?, reason = ?, updated_at = ? WHERE user_id = ?',
      input.status,
      reason,
      now,
      input.userId,
    ).rowsWritten > 0;
    if (!changed) throw new Error('Account not found');
    this.ctx.storage.sql.exec(
      'INSERT INTO account_events (id, user_id, action, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      crypto.randomUUID(),
      input.userId,
      input.action,
      input.actor,
      reason,
      now,
    );
    return this.require(input.userId);
  }

  get(userId: string): OperatorAccountRecord | null {
    const row = this.ctx.storage.sql.exec<AccountRow>('SELECT * FROM accounts WHERE user_id = ?', userId).toArray()[0];
    return row ? accountFromRow(row) : null;
  }

  getByHandle(handle: string): OperatorAccountRecord | null {
    const row = this.ctx.storage.sql.exec<AccountRow>('SELECT * FROM accounts WHERE handle = ?', handle).toArray()[0];
    return row ? accountFromRow(row) : null;
  }

  list(): OperatorAccountRecord[] {
    return this.ctx.storage.sql.exec<AccountRow>('SELECT * FROM accounts ORDER BY created_at DESC LIMIT 500').toArray().map(accountFromRow);
  }

  listEvents(userId: string): OperatorAccountEvent[] {
    return this.ctx.storage.sql.exec<EventRow>('SELECT * FROM account_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', userId).toArray().map((row) => ({
      id: row.id,
      userId: row.user_id,
      action: row.action,
      actor: row.actor,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  private require(userId: string): OperatorAccountRecord {
    const account = this.get(userId);
    if (!account) throw new Error('Account registry write failed');
    return account;
  }
}
