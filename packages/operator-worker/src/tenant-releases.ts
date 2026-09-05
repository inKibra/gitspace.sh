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


export const launchReleaseInputSchema = z.object({
  sha: z.string().min(1).max(160),
  targets: z.array(releaseTargetSchema).min(1),
});
export type LaunchReleaseInput = z.infer<typeof launchReleaseInputSchema>;

export const machineAppliedInputSchema = z.object({
  sha: z.string().min(1).max(160),
  target: z.enum(['machine', 'omp']),
  generation: z.string().min(1).max(160),
  status: z.enum(['applied', 'failed']),
  error: z.string().max(4_096).optional(),
});
export type MachineAppliedInput = z.infer<typeof machineAppliedInputSchema>;
export const machineChannelAppliedInputSchema = machineAppliedInputSchema.pick({ target: true, generation: true });
export type MachineChannelAppliedInput = z.infer<typeof machineChannelAppliedInputSchema>;

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
  worker_sha: string | null;
  machine_sha: string | null;
  omp_sha: string | null;
  frontend_sha: string | null;
  updated_at: string;
}

interface MachineRow extends Record<string, SqlStorageValue> {
  machine_id: string;
  sha: string | null;
  omp_sha: string | null;
  generation: string | null;
}

/** Thrown by the worker when an operation names a sha that was never staged; the object itself reports null across RPC. */
export class ReleaseNotFoundError extends Error {
  constructor(readonly sha: string) {
    super(`Release ${sha} is not staged`);
    this.name = 'ReleaseNotFoundError';
  }
}


export class TenantReleasesDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS releases (
        sha TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS release_selection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        worker_sha TEXT,
        machine_sha TEXT,
        omp_sha TEXT,
        frontend_sha TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS machines (
        machine_id TEXT PRIMARY KEY,
        sha TEXT,
        omp_sha TEXT,
        generation TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    const legacy = ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'desired'").toArray()[0];
    if (legacy) {
      ctx.storage.transactionSync(() => {
        const previous = ctx.storage.sql.exec<{ sha: string | null; targets_json: string; updated_at: string }>('SELECT sha, targets_json, updated_at FROM desired WHERE id = 1').toArray()[0];
        if (previous) {
          const targets = z.array(releaseTargetSchema).parse(JSON.parse(previous.targets_json));
          ctx.storage.sql.exec(
            'INSERT OR IGNORE INTO release_selection(id, worker_sha, machine_sha, omp_sha, frontend_sha, updated_at) VALUES (1, ?, ?, ?, ?, ?)',
            targets.includes('worker') ? previous.sha : null,
            targets.includes('machine') ? previous.sha : null,
            targets.includes('omp') ? previous.sha : null,
            targets.includes('frontend') ? previous.sha : null,
            previous.updated_at,
          );
        }
        ctx.storage.sql.exec('DROP TABLE desired');
      });
    }
    try {
      ctx.storage.sql.exec('ALTER TABLE machines ADD COLUMN omp_sha TEXT');
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/u.test(error.message)) throw error;
    }
  }


  stage(inputValue: StageReleaseInput, builtBy: string): ReleaseRecord {
    const input = stageReleaseInputSchema.parse(inputValue);
    const record = releaseRecordSchema.parse({
      ...input,
      builtBy,
      createdAt: new Date().toISOString(),
      status: { worker: 'pending', frontend: 'pending', machines: {}, omps: {} },
      error: null,
    });
    this.ctx.storage.sql.exec(
      'INSERT INTO releases(sha, created_at, record_json) VALUES (?, ?, ?) ON CONFLICT(sha) DO UPDATE SET created_at = excluded.created_at, record_json = excluded.record_json',
      record.sha, record.createdAt, JSON.stringify(record),
    );
    return record;
  }

  /** Updates only the named target selections; all other targets retain their release. */
  launch(inputValue: LaunchReleaseInput): LaunchResult | null {
    const input = launchReleaseInputSchema.parse(inputValue);
    const record = this.findRelease(input.sha);
    if (!record) return null;
    const targets: ReleaseTarget[] = [...new Set(input.targets)];
    for (const target of targets) {
      if (record.artifacts[target] === null || (target === 'worker' && record.worker === null) || (target === 'omp' && record.omp === null)) {
        throw new Error(`Release ${record.sha} has no ${target} artifact`);
      }
    }
    if (targets.includes('worker')) record.status.worker = 'pending';
    else if (record.status.worker === 'pending') record.status.worker = 'skipped';
    if (targets.includes('frontend')) record.status.frontend = 'applied';
    else if (record.status.frontend === 'pending') record.status.frontend = 'skipped';
    record.error = null;
    this.saveRecord(record);
    const desired = this.desired();
    for (const target of targets) desired[target] = record.sha;
    desired.updatedAt = new Date().toISOString();
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
    const statuses = input.target === 'omp' ? record.status.omps : record.status.machines;
    statuses[machineId] = input.status;
    if (input.status === 'failed') {
      record.error = input.error ?? `${input.target === 'omp' ? 'OMP' : 'Machine'} ${machineId} failed to apply ${input.sha}`;
    } else if (input.target === 'omp') {
      this.ctx.storage.sql.exec(
        'INSERT INTO machines(machine_id, sha, omp_sha, generation, updated_at) VALUES (?, NULL, ?, ?, ?) ON CONFLICT(machine_id) DO UPDATE SET omp_sha = excluded.omp_sha, generation = excluded.generation, updated_at = excluded.updated_at',
        machineId, input.sha, input.generation, new Date().toISOString(),
      );
    } else {
      this.ctx.storage.sql.exec(
        'INSERT INTO machines(machine_id, sha, omp_sha, generation, updated_at) VALUES (?, ?, NULL, ?, ?) ON CONFLICT(machine_id) DO UPDATE SET sha = excluded.sha, generation = excluded.generation, updated_at = excluded.updated_at',
        machineId, input.sha, input.generation, new Date().toISOString(),
      );
    }
    this.saveRecord(record);
    return record;
  }

  /** Actual healthy channel activation, acknowledged by the enrolled machine after draining. */
  machineChannelApplied(machineId: string, inputValue: MachineChannelAppliedInput): void {
    const input = machineChannelAppliedInputSchema.parse(inputValue);
    this.ctx.storage.sql.exec(
      input.target === 'omp'
        ? 'INSERT INTO machines(machine_id, sha, omp_sha, generation, updated_at) VALUES (?, NULL, NULL, ?, ?) ON CONFLICT(machine_id) DO UPDATE SET omp_sha = NULL, generation = excluded.generation, updated_at = excluded.updated_at'
        : 'INSERT INTO machines(machine_id, sha, omp_sha, generation, updated_at) VALUES (?, NULL, NULL, ?, ?) ON CONFLICT(machine_id) DO UPDATE SET sha = NULL, generation = excluded.generation, updated_at = excluded.updated_at',
      machineId, input.generation, new Date().toISOString(),
    );
  }

  revert(): TenantDesired {
    const desired: TenantDesired = { worker: null, machine: null, omp: null, frontend: null, updatedAt: new Date().toISOString() };
    this.saveDesired(desired);
    return desired;
  }


  status(worker: WorkerVersion): DeploymentStatus {
    const machines: DeploymentStatus['current']['machines'] = {};
    for (const row of this.ctx.storage.sql.exec<MachineRow>('SELECT machine_id, sha, omp_sha, generation FROM machines ORDER BY machine_id').toArray()) {
      machines[row.machine_id] = { sha: row.sha, ompSha: row.omp_sha, generation: row.generation };
    }
    const releases = this.ctx.storage.sql.exec<ReleaseRow>('SELECT record_json FROM releases ORDER BY created_at DESC, sha').toArray()
      .map((row) => this.parseRecord(row.record_json));
    return deploymentStatusSchema.parse({ desired: this.desired(), current: { worker, machines }, releases });
  }

  /** The frontend tree to serve, or null when the tenant runs our channel build. */
  frontend(): FrontendRelease | null {
    const sha = this.desired().frontend;
    if (!sha) return null;
    const record = this.findRelease(sha);
    if (!record || record.artifacts.frontend === null) return null;
    return { sha: record.sha, keyPrefix: record.artifacts.frontend.key };
  }

  private desired(): TenantDesired {
    const row = this.ctx.storage.sql.exec<DesiredRow>('SELECT worker_sha, machine_sha, omp_sha, frontend_sha, updated_at FROM release_selection WHERE id = 1').toArray()[0];
    if (!row) return { worker: null, machine: null, omp: null, frontend: null, updatedAt: new Date(0).toISOString() };
    return tenantDesiredSchema.parse({ worker: row.worker_sha, machine: row.machine_sha, omp: row.omp_sha, frontend: row.frontend_sha, updatedAt: row.updated_at });
  }

  private saveDesired(desired: TenantDesired): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO release_selection(id, worker_sha, machine_sha, omp_sha, frontend_sha, updated_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET worker_sha = excluded.worker_sha, machine_sha = excluded.machine_sha, omp_sha = excluded.omp_sha, frontend_sha = excluded.frontend_sha, updated_at = excluded.updated_at',
      desired.worker, desired.machine, desired.omp, desired.frontend, desired.updatedAt,
    );
  }

  private findRelease(sha: string): ReleaseRecord | null {
    const row = this.ctx.storage.sql.exec<ReleaseRow>('SELECT record_json FROM releases WHERE sha = ?', sha).toArray()[0];
    return row ? this.parseRecord(row.record_json) : null;
  }

  /** Stored pre-OMP releases remain readable, but can never masquerade as OMP artifacts. */
  private parseRecord(source: string): ReleaseRecord {
    const value = JSON.parse(source) as Record<string, unknown>;
    const artifacts = value.artifacts as Record<string, unknown> | undefined;
    const status = value.status as Record<string, unknown> | undefined;
    return releaseRecordSchema.parse({
      ...value,
      artifacts: { ...artifacts, omp: artifacts?.omp ?? null },
      omp: value.omp ?? null,
      status: { ...status, omps: status?.omps ?? {} },
    });
  }

  private saveRecord(record: ReleaseRecord): void {
    this.ctx.storage.sql.exec('UPDATE releases SET record_json = ? WHERE sha = ?', JSON.stringify(record), record.sha);
  }
}
