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

export interface R2TemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: string;
}

export class CloudflareR2PlatformClient {
  constructor(private readonly options: {
    accountId: string;
    apiToken: string;
    parentAccessKeyId: string;
    fetcher?: typeof fetch;
    now?: () => number;
  }) {}

  async createBucket(input: { bucketName: string; jurisdiction?: 'default' | 'eu' | 'us' | 'fedramp' }): Promise<void> {
    validateBucketName(input.bucketName);
    const response = await (this.options.fetcher ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.options.accountId)}/r2/buckets`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiToken}`,
          'content-type': 'application/json',
          ...(input.jurisdiction && input.jurisdiction !== 'default' ? { 'cf-r2-jurisdiction': input.jurisdiction } : {}),
        },
        body: JSON.stringify({ name: input.bucketName, storageClass: 'Standard' }),
      },
    );
    const body = await boundedJson(response);
    if (!response.ok || !isCloudflareSuccess(body)) throw new Error(`R2 bucket provisioning failed with ${response.status}`);
  }

  async ensureBucket(input: { bucketName: string; jurisdiction?: 'default' | 'eu' | 'us' | 'fedramp' }): Promise<void> {
    validateBucketName(input.bucketName);
    const response = await (this.options.fetcher ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.options.accountId)}/r2/buckets/${encodeURIComponent(input.bucketName)}`,
      {
        headers: {
          authorization: `Bearer ${this.options.apiToken}`,
          ...(input.jurisdiction && input.jurisdiction !== 'default' ? { 'cf-r2-jurisdiction': input.jurisdiction } : {}),
        },
      },
    );
    if (response.ok) return;
    if (response.status !== 404) throw new Error(`R2 bucket lookup failed with ${response.status}`);
    await this.createBucket(input);
  }

  async mintTemporaryCredentials(input: {
    bucketName: string;
    prefixes: string[];
    ttlSeconds: number;
    permission?: 'object-read-write' | 'object-read-only';
  }): Promise<R2TemporaryCredentials> {
    validateBucketName(input.bucketName);
    if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 604_800) throw new RangeError('Temporary credential TTL is invalid');
    const prefixes = [...new Set(input.prefixes.map(validatePrefix))].sort();
    if (prefixes.length === 0) throw new Error('Temporary credentials require at least one prefix');
    const response = await (this.options.fetcher ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.options.accountId)}/r2/temp-access-credentials`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          bucket: input.bucketName,
          parentAccessKeyId: this.options.parentAccessKeyId,
          permission: input.permission ?? 'object-read-write',
          ttlSeconds: input.ttlSeconds,
          prefixes,
        }),
      },
    );
    const body = await boundedJson(response);
    if (!response.ok || !isCredentialResponse(body)) throw new Error(`R2 temporary credential issuance failed with ${response.status}`);
    return {
      accessKeyId: body.result.accessKeyId,
      secretAccessKey: body.result.secretAccessKey,
      sessionToken: body.result.sessionToken,
      expiresAt: new Date((this.options.now ?? Date.now)() + input.ttlSeconds * 1_000).toISOString(),
    };
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

function validatePrefix(value: string): string {
  if (!value || value.startsWith('/') || value.includes('..') || !value.endsWith('/')) throw new Error(`R2 prefix ${value} is invalid`);
  return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 64 * 1024) throw new Error('Cloudflare API response is too large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 64 * 1024) throw new Error('Cloudflare API response is too large');
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function isCloudflareSuccess(value: unknown): value is { success: true } {
  return !!value && typeof value === 'object' && (value as { success?: unknown }).success === true;
}

function isCredentialResponse(value: unknown): value is {
  success: true;
  result: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
} {
  if (!isCloudflareSuccess(value) || !('result' in value) || !value.result || typeof value.result !== 'object') return false;
  const result = value.result as Record<string, unknown>;
  return typeof result.accessKeyId === 'string' && typeof result.secretAccessKey === 'string' && typeof result.sessionToken === 'string';
}
