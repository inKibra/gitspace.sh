import { DurableObject } from 'cloudflare:workers';

export type UserStorageState = 'provisioning' | 'ready' | 'failed' | 'deleting';

export interface UserStorageRecord {
  userId: string;
  gitBucketName: string;
  state: UserStorageState;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

interface StorageRow extends Record<string, SqlStorageValue> {
  user_id: string;
  bucket_name: string;
  state: UserStorageState;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export class UserStorageDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS user_storage (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          user_id TEXT NOT NULL UNIQUE,
          bucket_name TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'failed', 'deleting')),
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    });
  }

  beginProvisioning(input: { userId: string; gitBucketName: string }): UserStorageRecord {
    validateUserId(input.userId);
    validateBucketName(input.gitBucketName);
    const existing = this.row();
    if (existing) {
      if (existing.user_id !== input.userId || existing.bucket_name !== input.gitBucketName) {
        throw new Error('User Git storage identity is immutable');
      }
      return storageRecord(existing);
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      'INSERT INTO user_storage (id, user_id, bucket_name, state, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)',
      input.userId,
      input.gitBucketName,
      'provisioning',
      now,
      now,
    );
    return storageRecord(this.row()!);
  }

  markReady(input: { userId: string; gitBucketName: string }): UserStorageRecord {
    const row = this.requiredIdentity(input);
    if (row.state === 'deleting') throw new Error('Deleting storage cannot become ready');
    this.ctx.storage.sql.exec(
      'UPDATE user_storage SET state = ?, error_message = NULL, updated_at = ? WHERE id = 1',
      'ready',
      new Date().toISOString(),
    );
    return storageRecord(this.row()!);
  }

  markFailed(input: { userId: string; gitBucketName: string; message: string }): UserStorageRecord {
    this.requiredIdentity(input);
    this.ctx.storage.sql.exec(
      'UPDATE user_storage SET state = ?, error_message = ?, updated_at = ? WHERE id = 1',
      'failed',
      input.message.slice(0, 2_048),
      new Date().toISOString(),
    );
    return storageRecord(this.row()!);
  }

  get(): UserStorageRecord | null {
    const row = this.row();
    return row ? storageRecord(row) : null;
  }

  requireReady(userId: string): UserStorageRecord {
    const row = this.row();
    if (!row || row.user_id !== userId || row.state !== 'ready') throw new Error('User storage is not ready');
    return storageRecord(row);
  }

  private row(): StorageRow | undefined {
    return this.ctx.storage.sql.exec<StorageRow>('SELECT user_id, bucket_name, state, error_message, created_at, updated_at FROM user_storage WHERE id = 1').toArray()[0];
  }

  private requiredIdentity(input: { userId: string; gitBucketName: string }): StorageRow {
    const row = this.row();
    if (!row || row.user_id !== input.userId || row.bucket_name !== input.gitBucketName) throw new Error('User Git storage identity does not match');
    return row;
  }
}

function storageRecord(row: StorageRow): UserStorageRecord {
  return {
    userId: row.user_id,
    gitBucketName: row.bucket_name,
    state: row.state,
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateUserId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value)) throw new Error('User id is invalid');
}

function validateBucketName(value: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(value)) throw new Error('R2 bucket name is invalid');
}
