import { DurableObject } from 'cloudflare:workers';
import { workerReleaseMetadataSchema, type WorkerReleaseMetadata } from '@gitspace/protocol';

/** One upload the platform performed for this tenant, in RELEASES bucket terms. */
export interface TenantDeployRecord {
  id: number;
  sha: string;
  /** Object key in RELEASES (`tenants/<tenant>/<sha>/worker.mjs` or `channel/worker.mjs`). */
  bundleKey: string;
  metadata: WorkerReleaseMetadata;
  uploadedAt: string;
  healthy: boolean;
  revertedTo: string | null;
}

export interface TenantDeploymentState {
  appliedMigrationTag: string | null;
  /** Deploy currently serving traffic (last healthy upload), if any. */
  active: TenantDeployRecord | null;
  /** The healthy deploy before `active`; what `revert { to: 'previous' }` restores. */
  previous: TenantDeployRecord | null;
  deploys: TenantDeployRecord[];
}

export type DeployLease =
  | { status: 'ok'; value: TenantDeploymentState }
  | { status: 'error'; error: { code: 'DEPLOY_IN_PROGRESS'; message: string } };

export interface DeployOutcome {
  sha: string;
  bundleKey: string;
  metadata: WorkerReleaseMetadata;
  healthy: boolean;
  revertedTo: string | null;
  /** Migration tag now applied on Cloudflare, or null when unchanged. */
  appliedMigrationTag: string | null;
}

interface DeployRow extends Record<string, SqlStorageValue> {
  id: number;
  sha: string;
  bundle_key: string;
  metadata_json: string;
  uploaded_at: string;
  healthy: number;
  reverted_to: string | null;
}

interface StateRow extends Record<string, SqlStorageValue> {
  applied_migration_tag: string | null;
  active_deploy_id: number | null;
  lease_until: number | null;
}
interface TenantConfigRow extends Record<string, SqlStorageValue> {
  root_public_key: string;
  blob_bucket: string | null;
}


const TOKEN_BYTES = 32;
const LEASE_MS = 5 * 60_000;
const HISTORY_LIMIT = 50;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toRecord(row: DeployRow): TenantDeployRecord {
  return {
    id: row.id,
    sha: row.sha,
    bundleKey: row.bundle_key,
    metadata: workerReleaseMetadataSchema.parse(JSON.parse(row.metadata_json)),
    uploadedAt: row.uploaded_at,
    healthy: row.healthy === 1,
    revertedTo: row.reverted_to,
  };
}

/**
 * Per-tenant deployment authority: the bearer token the tenant worker uses to
 * ask for a swap, the migration tag Cloudflare currently has for the script,
 * and the upload history the revert paths walk.
 */
export class TenantDeploymentsDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS tenant_token (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          token_hash TEXT NOT NULL,
          rotated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tenant_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          applied_migration_tag TEXT,
          active_deploy_id INTEGER,
          lease_until INTEGER,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deploys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sha TEXT NOT NULL,
          bundle_key TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          uploaded_at TEXT NOT NULL,
          healthy INTEGER NOT NULL CHECK (healthy IN (0, 1)),
          reverted_to TEXT
        );
        CREATE TABLE IF NOT EXISTS tenant_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          root_public_key TEXT NOT NULL,
          blob_bucket TEXT,
          created_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO tenant_state(id, applied_migration_tag, active_deploy_id, lease_until, updated_at)
        VALUES (1, NULL, NULL, NULL, '1970-01-01T00:00:00.000Z');
      `);
      try {
        ctx.storage.sql.exec('ALTER TABLE tenant_config ADD COLUMN blob_bucket TEXT');
      } catch {
        // Existing instances already have the column.
      }
    });
  }
  configure(rootPublicKey: string, blobBucket: string): { created: boolean; rootPublicKey: string; blobBucket: string } {
    if (!/^[A-Za-z0-9+/]{43}=$/u.test(rootPublicKey)) throw new Error('Tenant root public key is invalid');
    if (!/^gsp-relay-[a-z0-9](?:[a-z0-9-]{0,50}[a-z0-9])?$/u.test(blobBucket)) throw new Error('Tenant relay bucket is invalid');
    const existing = this.ctx.storage.sql.exec<TenantConfigRow>('SELECT root_public_key, blob_bucket FROM tenant_config WHERE id = 1').toArray()[0];
    if (existing && existing.root_public_key !== rootPublicKey) throw new Error('Tenant is already owned by another root key');
    if (existing?.blob_bucket && existing.blob_bucket !== blobBucket) throw new Error('Tenant is already bound to another relay bucket');
    if (!existing) {
      this.ctx.storage.sql.exec(
        'INSERT INTO tenant_config(id, root_public_key, blob_bucket, created_at) VALUES (1, ?, ?, ?)',
        rootPublicKey,
        blobBucket,
        new Date().toISOString(),
      );
    } else if (!existing.blob_bucket) {
      this.ctx.storage.sql.exec('UPDATE tenant_config SET blob_bucket=? WHERE id=1', blobBucket);
    }
    return { created: !existing, rootPublicKey, blobBucket };
  }

  tenantConfig(): { rootPublicKey: string; blobBucket: string } | null {
    const row = this.ctx.storage.sql.exec<TenantConfigRow>('SELECT root_public_key, blob_bucket FROM tenant_config WHERE id = 1').toArray()[0];
    return row?.blob_bucket ? { rootPublicKey: row.root_public_key, blobBucket: row.blob_bucket } : null;
  }


  /** Mints a fresh token, invalidating the previous one. The raw token is returned exactly once. */
  async rotateToken(): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
    const token = `gsd_${btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
    const hash = await sha256Hex(token);
    this.ctx.storage.sql.exec(
      `INSERT INTO tenant_token(id, token_hash, rotated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, rotated_at = excluded.rotated_at`,
      hash,
      new Date().toISOString(),
    );
    return token;
  }

  async verifyToken(token: string): Promise<boolean> {
    const row = this.ctx.storage.sql.exec<{ token_hash: string }>('SELECT token_hash FROM tenant_token WHERE id = 1').toArray()[0];
    if (!row || !token) return false;
    const expected = new TextEncoder().encode(row.token_hash);
    const presented = new TextEncoder().encode(await sha256Hex(token));
    if (expected.byteLength !== presented.byteLength) return false;
    let diff = 0;
    for (let index = 0; index < expected.byteLength; index += 1) diff |= expected[index]! ^ presented[index]!;
    return diff === 0;
  }

  /** Seeds the migration tag for tenants whose script predates the platform (deployed by wrangler). */
  setAppliedMigrationTag(tag: string | null): TenantDeploymentState {
    this.ctx.storage.sql.exec(
      'UPDATE tenant_state SET applied_migration_tag = ?, updated_at = ? WHERE id = 1',
      tag,
      new Date().toISOString(),
    );
    return this.getState();
  }

  getState(): TenantDeploymentState {
    const state = this.stateRow();
    const deploys = this.ctx.storage.sql.exec<DeployRow>(
      'SELECT * FROM deploys ORDER BY id DESC LIMIT ?',
      HISTORY_LIMIT,
    ).toArray().map(toRecord);
    const active = deploys.find((deploy) => deploy.id === state.active_deploy_id) ?? null;
    const previous = active
      ? deploys.find((deploy) => deploy.healthy && deploy.id < active.id && deploy.sha !== active.sha) ?? null
      : null;
    return { appliedMigrationTag: state.applied_migration_tag, active, previous, deploys };
  }

  /** Serializes deploys per tenant: one upload/probe/revert cycle at a time. */
  acquireLease(): DeployLease {
    const now = Date.now();
    const state = this.stateRow();
    if (state.lease_until !== null && state.lease_until > now) {
      return { status: 'error', error: { code: 'DEPLOY_IN_PROGRESS', message: 'Another deployment for this tenant is in progress' } };
    }
    this.ctx.storage.sql.exec('UPDATE tenant_state SET lease_until = ?, updated_at = ? WHERE id = 1', now + LEASE_MS, new Date(now).toISOString());
    return { status: 'ok', value: this.getState() };
  }

  releaseLease(): void {
    this.ctx.storage.sql.exec('UPDATE tenant_state SET lease_until = NULL, updated_at = ? WHERE id = 1', new Date().toISOString());
  }

  /** Records one upload attempt; a healthy upload becomes the active deploy. Always releases the lease. */
  recordDeploy(outcome: DeployOutcome): TenantDeployRecord {
    return this.ctx.storage.transactionSync(() => {
      const uploadedAt = new Date().toISOString();
      const cursor = this.ctx.storage.sql.exec<DeployRow>(
        `INSERT INTO deploys(sha, bundle_key, metadata_json, uploaded_at, healthy, reverted_to)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        outcome.sha,
        outcome.bundleKey,
        JSON.stringify(outcome.metadata),
        uploadedAt,
        outcome.healthy ? 1 : 0,
        outcome.revertedTo,
      );
      const row = cursor.toArray()[0];
      if (!row) throw new Error('Deploy insert returned no row');
      if (outcome.appliedMigrationTag !== null) {
        this.ctx.storage.sql.exec('UPDATE tenant_state SET applied_migration_tag = ? WHERE id = 1', outcome.appliedMigrationTag);
      }
      if (outcome.healthy) {
        this.ctx.storage.sql.exec('UPDATE tenant_state SET active_deploy_id = ? WHERE id = 1', row.id);
      }
      this.ctx.storage.sql.exec('UPDATE tenant_state SET lease_until = NULL, updated_at = ? WHERE id = 1', uploadedAt);
      return toRecord(row);
    });
  }

  private stateRow(): StateRow {
    const row = this.ctx.storage.sql.exec<StateRow>(
      'SELECT applied_migration_tag, active_deploy_id, lease_until FROM tenant_state WHERE id = 1',
    ).toArray()[0];
    if (!row) throw new Error('Tenant deployment state invariant violated');
    return row;
  }
}
