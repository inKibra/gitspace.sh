import { workerReleaseMetadataSchema, type WorkerReleaseMetadata } from '@gitspace/protocol/deployment';
import { TenantComputeProvider, type ComputeTarget } from './compute-provider.js';
import { deployResultSchema, runDeployWork, type DeployResult, type DeployWork } from './deployer.js';
import { BudgetedDurableObject } from './storage-quarantine.js';

/** One upload the platform performed for this tenant, in RELEASES bucket terms. */
export interface TenantDeployRecord {
  id: number;
  sha: string;
  /**
   * RELEASES key of the uploaded worker: a manifest (`tenants/<tenant>/<sha>/worker.manifest.json` or
   * `defaults/releases/<sha>/worker.manifest.json`, modules beside it under `worker/`), or a LEGACY single
   * `worker.bundle.json` from before module releases. Stored in the `bundle_key` column.
   */
  workerKey: string;
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

export interface DeployOutcome {
  sha: string;
  workerKey: string;
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
interface OperationRow extends Record<string, SqlStorageValue> {
  outcome_json: string | null;
}


const TOKEN_BYTES = 32;
/** Serializes swaps across instances of the object: a swap that died with an earlier instance holds it this long. */
const LEASE_MS = 5 * 60_000;
const HISTORY_LIMIT = 50;
/** Swaps whose outcome is kept under the id their caller named. */
const OPERATION_LIMIT = 50;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toRecord(row: DeployRow): TenantDeployRecord {
  return {
    id: row.id,
    sha: row.sha,
    workerKey: row.bundle_key,
    metadata: workerReleaseMetadataSchema.parse(JSON.parse(row.metadata_json)),
    uploadedAt: row.uploaded_at,
    healthy: row.healthy === 1,
    revertedTo: row.reverted_to,
  };
}

/**
 * Per-tenant deployment authority: the bearer token the tenant worker uses to
 * ask for a swap, the migration tag Cloudflare currently has for the script,
 * and the upload history the revert paths walk. Every swap runs here, under the
 * tenant lease.
 */
export class TenantDeploymentsDO extends BudgetedDurableObject {
  private computeProvider: TenantComputeProvider | null = null;
  /** Swaps running in this instance, by the operation id their caller named. */
  readonly #running = new Map<string, Promise<DeployResult>>();
  /** The swap holding the lease in this instance; a later one takes the lease over once it expires. */
  #leaseHolder: object | null = null;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS tenant_token (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          token_hash TEXT NOT NULL,
          token_value TEXT NOT NULL,
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
        CREATE TABLE IF NOT EXISTS operations (
          id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          outcome_json TEXT
        );
        INSERT OR IGNORE INTO tenant_state(id, applied_migration_tag, active_deploy_id, lease_until, updated_at)
        VALUES (1, NULL, NULL, NULL, '1970-01-01T00:00:00.000Z');
      `);
    });
  }
  private computeProviderFor(tenant: string, accountId: string): TenantComputeProvider {
    if (this.computeProvider && (this.computeProvider.tenant !== tenant || this.computeProvider.accountId !== accountId)) {
      throw new Error('Compute namespace identity does not match this tenant');
    }
    this.computeProvider ??= new TenantComputeProvider(this.ctx.storage, this.env, tenant, accountId, () => {
      const pin = this.getState().active?.metadata.resources.find(resource => resource.name === 'DEFAULT_ACCOUNT_RELEASE');
      if (!pin) return null;
      if (pin.source !== 'literal' || pin.value === undefined) throw new Error('Invalid tenant default release pin');
      return pin.value;
    });
    return this.computeProvider;
  }
  async compute(tenant: string, accountId: string, request: Request): Promise<Response> {
    return this.computeProviderFor(tenant, accountId).fetch(request);
  }
  /** Machine RPC streams bypass this object: an AbortSignal cannot cross Durable Object RPC, so a stream proxied here never learns its caller left. */
  computeRpcTarget(tenant: string, accountId: string, machineId: string): ComputeTarget {
    return this.computeProviderFor(tenant, accountId).rpcTarget(machineId);
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


  /** Provider-scoped credential injected only into this tenant's worker. */
  async rotateToken(): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
    const token = `gsd_${btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
    const hash = await sha256Hex(token);
    this.ctx.storage.sql.exec(
      `INSERT INTO tenant_token(id, token_hash, token_value, rotated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, token_value = excluded.token_value, rotated_at = excluded.rotated_at`,
      hash,
      token,
      new Date().toISOString(),
    );
    return token;
  }

  async providerToken(): Promise<string> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = this.ctx.storage.sql.exec<{ token_value: string }>('SELECT token_value FROM tenant_token WHERE id=1').toArray()[0];
      return existing?.token_value ?? await this.rotateToken();
    });
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

  /**
   * Runs one upload/probe cycle under the tenant lease in this object, so a caller that leaves cannot cancel it, and
   * releases the lease when the swap ends, however it ends. A lease held by a swap that died with an earlier instance
   * of this object expires after LEASE_MS. With an `operationId` the outcome is kept under that id, and the same id
   * never starts a second swap.
   */
  async deploy(tenant: string, work: DeployWork, operationId: string | null): Promise<DeployResult> {
    if (operationId !== null) {
      const known = this.operation(operationId);
      if (known) return known;
    }
    const now = Date.now();
    const lease = this.stateRow().lease_until;
    if (lease !== null && lease > now) {
      const refused: DeployResult = { status: 'error', error: { status: 409, code: 'DEPLOY_IN_PROGRESS', message: 'Another deployment for this tenant is in progress' } };
      if (operationId !== null) this.recordOperation(operationId, now, refused);
      return refused;
    }
    this.ctx.storage.sql.exec('UPDATE tenant_state SET lease_until = ?, updated_at = ? WHERE id = 1', now + LEASE_MS, new Date(now).toISOString());
    if (operationId !== null) this.recordOperation(operationId, now, null);
    const holder = {};
    this.#leaseHolder = holder;
    const state = this.getState();
    const run = async (): Promise<DeployResult> => {
      try {
        const result = await runDeployWork(this.env, tenant, this, state, work).catch((error: unknown): DeployResult => {
          console.error(JSON.stringify({ event: 'deploy-failed', tenant, kind: work.kind, message: error instanceof Error ? error.message : String(error) }));
          return { status: 'error', error: { status: 500, code: 'DEPLOY_FAILED', message: error instanceof Error ? error.message : 'Deployment failed' } };
        });
        if (operationId !== null) this.ctx.storage.sql.exec('UPDATE operations SET outcome_json = ? WHERE id = ?', JSON.stringify(result), operationId);
        return result;
      } finally {
        if (operationId !== null) this.#running.delete(operationId);
        if (this.#leaseHolder === holder) {
          this.#leaseHolder = null;
          this.ctx.storage.sql.exec('UPDATE tenant_state SET lease_until = NULL, updated_at = ? WHERE id = 1', new Date().toISOString());
        }
      }
    };
    const swap = run();
    if (operationId !== null) this.#running.set(operationId, swap);
    this.ctx.waitUntil(swap);
    return swap;
  }

  /** The outcome of the swap started under `operationId`, waiting while it still runs here; null when none was. */
  operation(operationId: string): Promise<DeployResult> | DeployResult | null {
    const running = this.#running.get(operationId);
    if (running) return running;
    const row = this.ctx.storage.sql.exec<OperationRow>('SELECT outcome_json FROM operations WHERE id = ?', operationId).toArray()[0];
    if (!row) return null;
    if (row.outcome_json !== null) return deployResultSchema.parse(JSON.parse(row.outcome_json));
    // Started by an earlier instance of this object, which ended before the swap did; its lease runs out on its own.
    const interrupted: DeployResult = { status: 'error', error: { status: 409, code: 'DEPLOY_INTERRUPTED', message: `The platform restarted during this deployment; the tenant can deploy again within ${LEASE_MS / 60_000} minutes` } };
    this.ctx.storage.sql.exec('UPDATE operations SET outcome_json = ? WHERE id = ?', JSON.stringify(interrupted), operationId);
    return interrupted;
  }

  /** Records one upload attempt; a healthy upload becomes the active deploy. */
  recordDeploy(outcome: DeployOutcome): TenantDeployRecord {
    return this.ctx.storage.transactionSync(() => {
      const uploadedAt = new Date().toISOString();
      const cursor = this.ctx.storage.sql.exec<DeployRow>(
        `INSERT INTO deploys(sha, bundle_key, metadata_json, uploaded_at, healthy, reverted_to)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        outcome.sha,
        outcome.workerKey,
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
      this.ctx.storage.sql.exec('UPDATE tenant_state SET updated_at = ? WHERE id = 1', uploadedAt);
      return toRecord(row);
    });
  }

  private recordOperation(operationId: string, startedAt: number, outcome: DeployResult | null): void {
    this.ctx.storage.sql.exec('INSERT INTO operations(id, started_at, outcome_json) VALUES (?, ?, ?)', operationId, new Date(startedAt).toISOString(), outcome === null ? null : JSON.stringify(outcome));
    this.ctx.storage.sql.exec('DELETE FROM operations WHERE id NOT IN (SELECT id FROM operations ORDER BY started_at DESC LIMIT ?)', OPERATION_LIMIT);
  }

  private stateRow(): StateRow {
    const row = this.ctx.storage.sql.exec<StateRow>(
      'SELECT applied_migration_tag, active_deploy_id, lease_until FROM tenant_state WHERE id = 1',
    ).toArray()[0];
    if (!row) throw new Error('Tenant deployment state invariant violated');
    return row;
  }
}
