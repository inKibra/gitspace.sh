import { DurableObject } from 'cloudflare:workers';
import {
  deploymentStatusSchema,
  releaseRecordSchema,
  releaseStatusSchema,
  releaseTargetSchema,
  stageReleaseInputSchema,
  tenantDesiredSchema,
  type DeploymentStatus,
  type ReleaseRecord,
  type ReleaseStatus,
  type ReleaseTarget,
  type StageReleaseInput,
  type TenantDesired,
} from '@gitspace/protocol/deployment';
import { z } from 'zod';

declare const GITSPACE_WORKER_SHA: string | undefined;

/** Build stamp injected by `Bun.build({ define })`; channel/dev builds carry none. */
export const WORKER_VERSION: string | undefined = typeof GITSPACE_WORKER_SHA === 'string' ? GITSPACE_WORKER_SHA : undefined;

/** Instance name of the tenant-wide owner pointer; every other instance is keyed by user id. */
export const TENANT_OWNER_INSTANCE = '__tenant__';

export const launchReleaseInputSchema = z.object({
  sha: z.string().min(1).max(160),
  targets: z.array(releaseTargetSchema).min(1),
});
export type LaunchReleaseInput = z.infer<typeof launchReleaseInputSchema>;

export const machineAppliedInputSchema = z.object({
  sha: z.string().min(1).max(160),
  generation: z.string().min(1).max(160),
  status: z.enum(['applied', 'failed']),
  error: z.string().max(4_096).optional(),
});
export type MachineAppliedInput = z.infer<typeof machineAppliedInputSchema>;

export interface WorkerVersion {
  sha: string | null;
  version: string | null;
}

export interface LaunchResult {
  record: ReleaseRecord;
  desired: TenantDesired;
}

/** Where the active release's frontend tree lives, relative to the user prefix. */
export interface FrontendRelease {
  sha: string;
  keyPrefix: string;
}

interface ReleaseRow extends Record<string, SqlStorageValue> {
  record_json: string;
}

interface DesiredRow extends Record<string, SqlStorageValue> {
  sha: string | null;
  targets_json: string;
  updated_at: string;
}

interface MachineRow extends Record<string, SqlStorageValue> {
  machine_id: string;
  sha: string | null;
  generation: string | null;
}

/** Thrown by the worker when an operation names a sha that was never staged; the object itself reports null across RPC. */
export class ReleaseNotFoundError extends Error {
  constructor(readonly sha: string) {
    super(`Release ${sha} is not staged`);
    this.name = 'ReleaseNotFoundError';
  }
}

const EMPTY_DESIRED_TARGETS = '[]';

export class TenantReleasesDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS releases (
        sha TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desired (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        sha TEXT,
        targets_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS machines (
        machine_id TEXT PRIMARY KEY,
        sha TEXT,
        generation TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tenant_owner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        user_id TEXT NOT NULL
      );
    `);
  }

  // --- tenant owner pointer (only meaningful on the TENANT_OWNER_INSTANCE) ---

  /** The tenant serves one user: whoever last ran a deploy op is the user whose release frontend the worker serves. */
  setOwner(userId: string): void {
    this.ctx.storage.sql.exec('INSERT INTO tenant_owner(id, user_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id', userId);
  }

  owner(): string | null {
    return this.ctx.storage.sql.exec<{ user_id: string }>('SELECT user_id FROM tenant_owner WHERE id = 1').toArray()[0]?.user_id ?? null;
  }

  // --- releases ---

  stage(inputValue: StageReleaseInput, builtBy: string): ReleaseRecord {
    const input = stageReleaseInputSchema.parse(inputValue);
    const record = releaseRecordSchema.parse({
      ...input,
      builtBy,
      createdAt: new Date().toISOString(),
      status: { worker: 'pending', frontend: 'pending', machines: {} },
      error: null,
    });
    this.ctx.storage.sql.exec(
      'INSERT INTO releases(sha, created_at, record_json) VALUES (?, ?, ?) ON CONFLICT(sha) DO UPDATE SET created_at = excluded.created_at, record_json = excluded.record_json',
      record.sha, record.createdAt, JSON.stringify(record),
    );
    return record;
  }

  /**
   * Points `desired` at the release. Worker status becomes `pending` when the
   * caller still has to swap the script (it reports back via `setWorkerStatus`),
   * `skipped` when the target is absent or the record has no worker bundle;
   * the frontend is served by hash from this moment, so it is `applied` at once.
   * Null when the sha was never staged.
   */
  launch(inputValue: LaunchReleaseInput): LaunchResult | null {
    const input = launchReleaseInputSchema.parse(inputValue);
    const record = this.findRelease(input.sha);
    if (!record) return null;
    const targets: ReleaseTarget[] = [...new Set(input.targets)];
    record.status.worker = targets.includes('worker') && record.artifacts.worker !== null && record.worker !== null ? 'pending' : 'skipped';
    record.status.frontend = targets.includes('frontend') && record.artifacts.frontend !== null ? 'applied' : 'skipped';
    record.error = null;
    this.saveRecord(record);
    const desired: TenantDesired = { sha: record.sha, targets, updatedAt: new Date().toISOString() };
    this.saveDesired(desired);
    return { record, desired };
  }

  setWorkerStatus(sha: string, status: ReleaseStatus, error: string | null): ReleaseRecord | null {
    const record = this.findRelease(sha);
    if (!record) return null;
    record.status.worker = releaseStatusSchema.parse(status);
    record.error = error;
    this.saveRecord(record);
    return record;
  }

  machineApplied(machineId: string, inputValue: MachineAppliedInput): ReleaseRecord | null {
    const input = machineAppliedInputSchema.parse(inputValue);
    const record = this.findRelease(input.sha);
    if (!record) return null;
    record.status.machines[machineId] = input.status;
    if (input.status === 'failed') {
      record.error = input.error ?? `Machine ${machineId} failed to apply ${input.sha}`;
    } else {
      this.ctx.storage.sql.exec(
        'INSERT INTO machines(machine_id, sha, generation, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(machine_id) DO UPDATE SET sha = excluded.sha, generation = excluded.generation, updated_at = excluded.updated_at',
        machineId, input.sha, input.generation, new Date().toISOString(),
      );
    }
    this.saveRecord(record);
    return record;
  }

  revert(): TenantDesired {
    const desired: TenantDesired = { sha: null, targets: [], updatedAt: new Date().toISOString() };
    this.saveDesired(desired);
    return desired;
  }

  status(worker: WorkerVersion): DeploymentStatus {
    const machines: DeploymentStatus['current']['machines'] = {};
    for (const row of this.ctx.storage.sql.exec<MachineRow>('SELECT machine_id, sha, generation FROM machines ORDER BY machine_id').toArray()) {
      machines[row.machine_id] = { sha: row.sha, generation: row.generation };
    }
    const releases = this.ctx.storage.sql.exec<ReleaseRow>('SELECT record_json FROM releases ORDER BY created_at DESC, sha').toArray()
      .map((row) => releaseRecordSchema.parse(JSON.parse(row.record_json)));
    return deploymentStatusSchema.parse({ desired: this.desired(), current: { worker, machines }, releases });
  }

  /** The frontend tree to serve, or null when the tenant runs our channel build. */
  frontend(): FrontendRelease | null {
    const desired = this.desired();
    if (desired.sha === null || !desired.targets.includes('frontend')) return null;
    const record = this.findRelease(desired.sha);
    if (!record || record.artifacts.frontend === null) return null;
    return { sha: record.sha, keyPrefix: record.artifacts.frontend.key };
  }

  private desired(): TenantDesired {
    const row = this.ctx.storage.sql.exec<DesiredRow>('SELECT sha, targets_json, updated_at FROM desired WHERE id = 1').toArray()[0];
    if (!row) return { sha: null, targets: [], updatedAt: new Date(0).toISOString() };
    return tenantDesiredSchema.parse({ sha: row.sha, targets: JSON.parse(row.targets_json), updatedAt: row.updated_at });
  }

  private saveDesired(desired: TenantDesired): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO desired(id, sha, targets_json, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sha = excluded.sha, targets_json = excluded.targets_json, updated_at = excluded.updated_at',
      desired.sha, desired.targets.length === 0 ? EMPTY_DESIRED_TARGETS : JSON.stringify(desired.targets), desired.updatedAt,
    );
  }

  private findRelease(sha: string): ReleaseRecord | null {
    const row = this.ctx.storage.sql.exec<ReleaseRow>('SELECT record_json FROM releases WHERE sha = ?', sha).toArray()[0];
    return row ? releaseRecordSchema.parse(JSON.parse(row.record_json)) : null;
  }

  private saveRecord(record: ReleaseRecord): void {
    this.ctx.storage.sql.exec('UPDATE releases SET record_json = ? WHERE sha = ?', JSON.stringify(record), record.sha);
  }
}
