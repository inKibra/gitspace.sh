import { DurableObject } from 'cloudflare:workers';

export type TenantControlStatus = 'active' | 'quarantined' | 'suspended';
export interface TenantControlState {
  status: TenantControlStatus;
  reason: string | null;
  updatedAt: string | null;
}

interface TenantControlRow {
  [key: string]: SqlStorageValue;
  status: TenantControlStatus;
  reason: string | null;
  updated_at: string;
}

export class TenantControlDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tenant_control (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL CHECK (status IN ('active', 'quarantined', 'suspended')),
        reason TEXT,
        updated_at TEXT NOT NULL
      )
    `);
  }

  get(): TenantControlState {
    const row = this.ctx.storage.sql.exec<TenantControlRow>('SELECT status, reason, updated_at FROM tenant_control WHERE id = 1').toArray()[0];
    return row ? { status: row.status, reason: row.reason, updatedAt: row.updated_at } : { status: 'active', reason: null, updatedAt: null };
  }

  set(input: { status: TenantControlStatus; reason: string | null }): TenantControlState {
    const updatedAt = new Date().toISOString();
    const reason = input.reason?.trim().slice(0, 500) || null;
    this.ctx.storage.sql.exec(`
      INSERT INTO tenant_control (id, status, reason, updated_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, reason = excluded.reason, updated_at = excluded.updated_at
    `, input.status, reason, updatedAt);
    return { status: input.status, reason, updatedAt };
  }
}
