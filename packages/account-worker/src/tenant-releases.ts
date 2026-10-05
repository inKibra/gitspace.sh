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
import type { FleetCatalogDO } from './fleet-catalog.js';
import type { CredentialVaultDO } from './application.js';

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
  target: z.literal('machine'),
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
  frontend_sha: string | null;
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


export class TenantReleasesDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep legacy OMP columns as history; active selection and acknowledgements never read or write them.
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
  }


  async stage(inputValue: StageReleaseInput, builtBy: string): Promise<ReleaseRecord> {
    const cutover = await this.inferenceCutover();
    const input = stageReleaseInputSchema.parse(inputValue);
    const previous = this.findRelease(input.sha);
    // A partial rebuild cannot certify legacy sibling artifacts it retained.
    const retainsArtifacts = previous && (['worker', 'machine', 'frontend'] as const)
      .some((target) => input.artifacts[target] === null && previous.artifacts[target] !== null);
    // The running Worker's own sha fingerprints the whole source tree that contains this check.
    const inferenceVersion = input.sha === WORKER_VERSION || (input.inferenceVersion === 1 && (!retainsArtifacts || previous?.inferenceVersion === 1)) ? 1 : undefined;
    this.requireInferenceCompatibility(inferenceVersion, input.sha, cutover);
    const record = releaseRecordSchema.parse({
      ...input,
      inferenceVersion,
      label: previous?.label ?? input.label,
      workspaceId: previous ? previous.workspaceId : input.workspaceId,
      // Targets are independently staged; null must not erase a serving sibling.
      artifacts: {
        worker: input.artifacts.worker ?? previous?.artifacts.worker ?? null,
        machine: input.artifacts.machine ?? previous?.artifacts.machine ?? null,
        ...(previous?.artifacts.omp === undefined ? {} : { omp: previous.artifacts.omp }),
        frontend: input.artifacts.frontend ?? previous?.artifacts.frontend ?? null,
      },
      worker: input.worker ?? previous?.worker ?? null,
      ...(previous?.omp === undefined ? {} : { omp: previous.omp }),
      builtBy: previous?.builtBy ?? builtBy,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      status: previous?.status ?? { worker: 'pending', frontend: 'pending', machines: {} },
      error: previous?.error ?? null,
    });
    this.ctx.storage.sql.exec(
      'INSERT INTO releases(sha, created_at, record_json) VALUES (?, ?, ?) ON CONFLICT(sha) DO UPDATE SET created_at = excluded.created_at, record_json = excluded.record_json',
      record.sha, record.createdAt, JSON.stringify(record),
    );
    return record;
  }

  /** Updates only the named target selections; all other targets retain their release. */
  async launch(inputValue: LaunchReleaseInput): Promise<LaunchResult | null> {
    const cutover = await this.inferenceCutover();
    const input = launchReleaseInputSchema.parse(inputValue);
    const record = this.findRelease(input.sha);
    if (!record) return null;
    this.requireInferenceCompatibility(record.inferenceVersion, record.sha, cutover);
    const targets: ReleaseTarget[] = [...new Set(input.targets)];
    for (const target of targets) {
      if (record.artifacts[target] === null || (target === 'worker' && record.worker === null)) {
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

  async setWorkerStatus(sha: string, status: ReleaseStatus, error: string | null): Promise<ReleaseRecord | null> {
    const cutover = status === 'applied' && await this.inferenceCutover();
    const record = this.findRelease(sha);
    if (!record) return null;
    this.requireInferenceCompatibility(record.inferenceVersion, record.sha, cutover);
    record.status.worker = releaseStatusSchema.parse(status);
    record.error = error;
    this.saveRecord(record);
    return record;
  }

  async machineApplied(machineId: string, inputValue: MachineAppliedInput): Promise<ReleaseRecord | null> {
    const input = machineAppliedInputSchema.parse(inputValue);
    const cutover = input.status === 'applied' && await this.inferenceCutover();
    const record = this.findRelease(input.sha);
    if (!record) return null;
    this.requireInferenceCompatibility(record.inferenceVersion, record.sha, cutover);
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

  /** Actual healthy channel activation, acknowledged by the enrolled machine after draining. */
  async machineChannelApplied(machineId: string, inputValue: MachineChannelAppliedInput): Promise<void> {
    const input = machineChannelAppliedInputSchema.parse(inputValue);
    await this.assertChannelCompatible();
    this.ctx.storage.sql.exec(
      'INSERT INTO machines(machine_id, sha, generation, updated_at) VALUES (?, NULL, ?, ?) ON CONFLICT(machine_id) DO UPDATE SET sha = NULL, generation = excluded.generation, updated_at = excluded.updated_at',
      machineId, input.generation, new Date().toISOString(),
    );
  }

  /** Executor admission trusts the acknowledged machine binary, not an obsolete OMP selection. */
  machineInferenceCompatible(machineId: string): boolean {
    const current = this.ctx.storage.sql.exec<Pick<MachineRow, 'sha'>>(
      'SELECT sha FROM machines WHERE machine_id=?', machineId,
    ).toArray()[0];
    if (!current?.sha) return false;
    const machine = this.findRelease(current.sha);
    return machine?.inferenceVersion === 1 && machine.artifacts.machine !== null;
  }

  async revert(): Promise<TenantDesired> {
    await this.assertChannelCompatible();
    const desired: TenantDesired = { worker: null, machine: null, frontend: null, updatedAt: new Date().toISOString() };
    this.saveDesired(desired);
    return desired;
  }

  /** Call before any external platform rollback, not only before saving selection. */
  async assertChannelCompatible(): Promise<void> {
    if (await this.inferenceCutover()) {
      throw new Error('Channel inference-profile compatibility cannot be verified after account cutover. Select a source release advertising inferenceVersion 1 instead.');
    }
  }

  private inferenceCutover(): Promise<boolean> {
    return (this.env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(this.env.ACCOUNT_ID).inferenceCutover();
  }

  private requireInferenceCompatibility(version: number | undefined, sha: string, cutover: boolean): void {
    if (cutover && version !== 1) {
      throw new Error(`Release ${sha} does not support inference profiles. Build and select a release advertising inferenceVersion 1; account-wide credential rollback is disabled.`);
    }
  }


  /** Release acknowledgements are history; only catalog members remain in the current fleet. */
  async status(userId: string, worker: WorkerVersion): Promise<DeploymentStatus> {
    const catalog = this.env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>;
    const fleet = await catalog.get(catalog.idFromName(userId)).listMachines();
    const cutover = await this.inferenceCutover();
    const currentIds = new Set<string>();
    for (const machine of fleet) {
      if (machine.desiredState !== 'removed') currentIds.add(machine.id);
    }
    const desired = this.desired();
    // Self-update may interrupt the acknowledgement after the platform activated it.
    if (worker.sha !== null && worker.sha === desired.worker) {
      const record = this.findRelease(worker.sha);
      if (record?.status.worker === 'pending' && (!cutover || record.inferenceVersion === 1)) {
        record.status.worker = 'applied';
        this.saveRecord(record);
      }
    }
    const machines: DeploymentStatus['current']['machines'] = {};
    for (const row of this.ctx.storage.sql.exec<MachineRow>('SELECT machine_id, sha, generation FROM machines ORDER BY machine_id').toArray()) {
      if (!currentIds.has(row.machine_id)) continue;
      machines[row.machine_id] = { sha: row.sha, generation: row.generation };
    }
    const releases = this.ctx.storage.sql.exec<ReleaseRow>('SELECT record_json FROM releases ORDER BY created_at DESC, sha').toArray()
      .map((row) => releaseRecordSchema.parse(JSON.parse(row.record_json)));
    return deploymentStatusSchema.parse({ desired, current: { worker, machines }, releases });
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
    const row = this.ctx.storage.sql.exec<DesiredRow>('SELECT worker_sha, machine_sha, frontend_sha, updated_at FROM release_selection WHERE id = 1').toArray()[0];
    if (!row) return { worker: null, machine: null, frontend: null, updatedAt: new Date(0).toISOString() };
    return tenantDesiredSchema.parse({ worker: row.worker_sha, machine: row.machine_sha, frontend: row.frontend_sha, updatedAt: row.updated_at });
  }

  private saveDesired(desired: TenantDesired): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO release_selection(id, worker_sha, machine_sha, frontend_sha, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET worker_sha = excluded.worker_sha, machine_sha = excluded.machine_sha, frontend_sha = excluded.frontend_sha, updated_at = excluded.updated_at',
      desired.worker, desired.machine, desired.frontend, desired.updatedAt,
    );
  }

  /**
   * A release staged by a launcher that predates capability stamps (every first cutover deploy) is
   * certified once this Worker runs as that release: its sha fingerprints the complete source tree,
   * so all of that release's artifacts were built from source containing this code.
   */
  private findRelease(sha: string): ReleaseRecord | null {
    const row = this.ctx.storage.sql.exec<ReleaseRow>('SELECT record_json FROM releases WHERE sha = ?', sha).toArray()[0];
    if (!row) return null;
    const record = releaseRecordSchema.parse(JSON.parse(row.record_json));
    if (sha === WORKER_VERSION && record.inferenceVersion !== 1) {
      record.inferenceVersion = 1;
      this.saveRecord(record);
    }
    return record;
  }

  private saveRecord(record: ReleaseRecord): void {
    this.ctx.storage.sql.exec('UPDATE releases SET record_json = ? WHERE sha = ?', JSON.stringify(record), record.sha);
  }
}
