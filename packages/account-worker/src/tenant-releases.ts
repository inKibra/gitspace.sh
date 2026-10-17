import { DurableObject } from 'cloudflare:workers';
import {
  canonicalHeadSchema,
  deploymentStatusSchema,
  launchProgressSchema,
  releaseRecordSchema,
  releaseStatusSchema,
  releaseTargetSchema,
  stageReleaseInputSchema,
  tenantDesiredSchema,
  MACHINE_EXECUTION_PROTOCOL_VERSION,
  machineProtocolInputSchema,
  type LaunchProgress,
  type MachineExecutionAdmission,
  type CanonicalHead,
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
import { defaultMachineReleaseSchema } from '@gitspace/protocol/default-release';
import { tenantPlatformJson } from './tenant-platform.js';
import { GITSPACE_SOURCE_REPOSITORY } from '@gitspace/protocol/project-authority';
import { notifyMachines } from './machine-notices.js';

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


/** One-time migration to release sources: a record's `workspaceId` becomes a workspace source at the commit its key
 * names (uncommitted count unknown), a platform default becomes a canonical source at its commit, and anything else keeps
 * no source. A latest launch recorded before launch sources is finished history and is dropped. */
function migrateReleaseSources(storage: DurableObjectStorage): void {
  const legacy = z.object({ workspaceId: z.string().nullable() }).passthrough();
  for (const row of storage.sql.exec<{ sha: string; record_json: string }>('SELECT sha, record_json FROM releases').toArray()) {
    const parsed = legacy.safeParse(JSON.parse(row.record_json));
    if (!parsed.success || !('workspaceId' in parsed.data)) continue;
    const { workspaceId, ...record } = parsed.data;
    const defaultCommit = workspaceId === null ? /^Default ([a-f0-9]{40})$/u.exec(String(record.label))?.[1] : undefined;
    const workspaceCommit = workspaceId === null ? undefined : /^[a-f0-9]{40}/u.exec(row.sha)?.[0];
    const source = defaultCommit ? { kind: 'canonical', repository: GITSPACE_SOURCE_REPOSITORY, branch: null, commit: defaultCommit }
      : workspaceId !== null && workspaceCommit ? { kind: 'workspace', workspaceId, commit: workspaceCommit, uncommittedFiles: null } : null;
    storage.sql.exec('UPDATE releases SET record_json = ? WHERE sha = ?', JSON.stringify(releaseRecordSchema.parse({ ...record, source })), row.sha);
  }
  const launch = storage.sql.exec<{ record_json: string }>('SELECT record_json FROM latest_launch WHERE id = 1').toArray()[0];
  if (launch && !launchProgressSchema.safeParse(JSON.parse(launch.record_json)).success) storage.sql.exec('DELETE FROM latest_launch WHERE id = 1');
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
      CREATE TABLE IF NOT EXISTS latest_launch (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        machine_id TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canonical_head (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        record_json TEXT NOT NULL
      );
    `);
    migrateReleaseSources(ctx.storage);
    this.certifyOwnLaunch(WORKER_VERSION ?? null);
  }

  /** The canonical branch head this account last read; status serves it and never reaches the canonical repository. */
  canonicalHead(): CanonicalHead | null {
    const row = this.ctx.storage.sql.exec<{ record_json: string }>('SELECT record_json FROM canonical_head WHERE id = 1').toArray()[0];
    return row ? canonicalHeadSchema.parse(JSON.parse(row.record_json)) : null;
  }

  recordCanonicalHead(value: CanonicalHead): void {
    const head = canonicalHeadSchema.parse(value);
    this.ctx.storage.sql.exec('INSERT INTO canonical_head(id, record_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json', JSON.stringify(head));
  }

  /** Keeps the account's latest launch as its building machine reports it; an older report of the same launch never
   * overwrites a newer one. */
  recordLaunchProgress(machineId: string, value: LaunchProgress): void {
    const progress = launchProgressSchema.parse(value);
    const stored = this.latestLaunch();
    if (stored?.launchId === progress.launchId && stored.updatedAt > progress.updatedAt) return;
    this.ctx.storage.sql.exec(
      'INSERT INTO latest_launch(id, machine_id, record_json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET machine_id = excluded.machine_id, record_json = excluded.record_json',
      machineId, JSON.stringify(progress),
    );
  }

  /** The launch's outcome, recorded where its release is applied: a machine that builds and launches its own release is
   * replaced by it, sometimes before this launch call answers, and could then never report the launch finished. */
  finishLaunch(record: ReleaseRecord, targets: ReleaseTarget[]): void {
    const launch = this.latestLaunch();
    if (!launch || launch.sha !== record.sha || launch.status !== 'running') return;
    const failed = (targets.includes('worker') && record.status.worker === 'failed') || (targets.includes('frontend') && record.status.frontend === 'failed');
    const message = failed ? record.error ?? 'Release activation failed' : `worker=${record.status.worker} machine=${targets.includes('machine') ? 'pending' : 'skipped'} frontend=${record.status.frontend}`;
    const finished = launchProgressSchema.parse({ ...launch, phase: failed ? 'failed' : 'launched', message, status: failed ? 'failed' : 'succeeded', error: failed ? message : null, updatedAt: new Date().toISOString() });
    this.ctx.storage.sql.exec('UPDATE latest_launch SET record_json = ? WHERE id = 1', JSON.stringify(finished));
  }

  /** A launch that deploys the Worker replaces the code serving it, so the old version may never answer the launch
   * call (its object is reset mid-request). The new version, starting here, is proof the Worker was applied: a launch
   * still running for this very sha is recorded applied and finished. Public for the test that starts a version. */
  certifyOwnLaunch(version: string | null): void {
    const launch = this.latestLaunch();
    if (version === null || launch?.status !== 'running' || launch.sha !== version || !launch.targets.includes('worker')) return;
    const record = this.findRelease(version);
    if (!record) return;
    if (record.status.worker === 'pending') { record.status.worker = 'applied'; record.error = null; this.saveRecord(record); }
    this.finishLaunch(record, launch.targets);
  }

  private latestLaunch(): LaunchProgress | null {
    const row = this.ctx.storage.sql.exec<{ record_json: string }>('SELECT record_json FROM latest_launch WHERE id = 1').toArray()[0];
    return row ? launchProgressSchema.parse(JSON.parse(row.record_json)) : null;
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
    if (input.artifacts.worker !== null) this.requireInferenceCompatibility(inferenceVersion, input.sha, cutover);
    const record = releaseRecordSchema.parse({
      ...input,
      inferenceVersion,
      label: previous?.label ?? input.label,
      source: previous ? previous.source : input.source,
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
    if (input.targets.includes('worker')) this.requireInferenceCompatibility(record.inferenceVersion, record.sha, cutover);
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

  /** Actual healthy channel activation, acknowledged by the enrolled machine after draining. */
  async machineChannelApplied(machineId: string, inputValue: MachineChannelAppliedInput): Promise<void> {
    const input = machineChannelAppliedInputSchema.parse(inputValue);
    this.ctx.storage.sql.exec(
      'INSERT INTO machines(machine_id, sha, generation, updated_at) VALUES (?, NULL, ?, ?) ON CONFLICT(machine_id) DO UPDATE SET sha = NULL, generation = excluded.generation, updated_at = excluded.updated_at',
      machineId, input.generation, new Date().toISOString(),
    );
  }

  async machineProtocol(machineId: string, inputValue: z.input<typeof machineProtocolInputSchema>): Promise<MachineExecutionAdmission> {
    const input = machineProtocolInputSchema.parse(inputValue);
    await this.ctx.storage.put(`machine-protocol:${machineId}`, input);
    if (input.version !== MACHINE_EXECUTION_PROTOCOL_VERSION) await this.resolveMachineDefault(machineId);
    return this.machineExecutionAdmission(machineId);
  }

  private async resolveMachineDefault(machineId: string): Promise<void> {
    if (this.desired().machine !== null) return;
    const stored = await this.ctx.storage.get(`machine-protocol:${machineId}`);
    const protocol = stored === undefined ? null : machineProtocolInputSchema.parse(stored);
    const generation = this.ctx.storage.sql.exec<Pick<MachineRow, 'generation'>>('SELECT generation FROM machines WHERE machine_id=?', machineId).toArray()[0]?.generation;
    if (!protocol?.platform && (!generation || !/^sha256:[a-f0-9]{64}$/u.test(generation))) {
      await this.ctx.storage.put(`machine-default-error:${machineId}`, 'This legacy machine has not reported a verifiable native generation. Automatic updating is waiting for its healthy host acknowledgement.');
      return;
    }
    try {
      const selected = defaultMachineReleaseSchema.parse(await tenantPlatformJson<unknown>(this.env, '/machine-release', {
        method: 'POST', body: JSON.stringify(protocol?.platform ? { platform: protocol.platform } : { generation }),
      }));
      await this.stage({
        sha: selected.sha, label: `Default ${selected.commit}`, source: { kind: 'canonical', repository: GITSPACE_SOURCE_REPOSITORY, branch: null, commit: selected.commit },
        artifacts: { worker: null, machine: selected.artifact, frontend: null }, worker: null,
      }, 'platform-default');
      await this.ctx.storage.put(`machine-default:${machineId}`, selected.sha);
      await this.ctx.storage.delete(`machine-default-error:${machineId}`);
    } catch (error) {
      await this.ctx.storage.put(`machine-default-error:${machineId}`, `Automatic machine update unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4096));
    }
  }

  async machineExecutionAdmission(machineId: string): Promise<MachineExecutionAdmission> {
    const stored = await this.ctx.storage.get(`machine-protocol:${machineId}`);
    const protocol = stored === undefined ? { version: null, blocker: null } : machineProtocolInputSchema.parse(stored);
    const selected = await this.ctx.storage.get(`machine-default:${machineId}`);
    const releaseSha = this.desired().machine ?? (selected === undefined ? null : z.string().parse(selected));
    if (protocol.version === MACHINE_EXECUTION_PROTOCOL_VERSION) return { version: protocol.version, required: MACHINE_EXECUTION_PROTOCOL_VERSION, state: 'ready', releaseSha, error: null };
    const record = releaseSha === null ? null : this.findRelease(releaseSha);
    const updateError = this.desired().machine === null ? await this.ctx.storage.get(`machine-default-error:${machineId}`) : undefined;
    const error = protocol.blocker ?? (updateError !== undefined ? z.string().parse(updateError)
      : record?.status.machines[machineId] === 'failed' ? record.error ?? 'Machine update failed; select a repaired release to retry.'
      : !record?.artifacts.machine ? 'Waiting for the authenticated machine to negotiate its native update target.'
      : null);
    return { version: protocol.version, required: MACHINE_EXECUTION_PROTOCOL_VERSION, state: error ? 'blocked' : 'updating', releaseSha, error };
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
  async status(userId: string, platformWorker: WorkerVersion, requestingMachineId?: string): Promise<DeploymentStatus> {
    const catalog = this.env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>;
    const fleet = await catalog.get(catalog.idFromName(userId)).listMachines();
    const cutover = await this.inferenceCutover();
    const currentIds = new Set<string>();
    for (const machine of fleet) {
      if (machine.desiredState !== 'removed') currentIds.add(machine.id);
    }
    const desired = this.desired();
    if (requestingMachineId && desired.machine === null) {
      await this.resolveMachineDefault(requestingMachineId);
      const selected = await this.ctx.storage.get(`machine-default:${requestingMachineId}`);
      if (selected !== undefined) desired.machine = z.string().parse(selected);
    }
    // Self-update may interrupt the acknowledgement after the platform activated it.
    if (platformWorker.sha !== null && platformWorker.sha === desired.worker) {
      const record = this.findRelease(platformWorker.sha);
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
    const machineExecution: NonNullable<DeploymentStatus['machineExecution']> = {};
    for (const machineId of currentIds) machineExecution[machineId] = await this.machineExecutionAdmission(machineId);
    const version = WORKER_VERSION ?? null;
    const worker = { sha: version === 'channel' || version?.startsWith('channel:') ? null : version, version };
    return deploymentStatusSchema.parse({
      desired, current: { worker, machines, ...(platformWorker.version !== version ? { platformWorker } : {}) }, releases, machineExecution, launch: this.latestLaunch(), canonical: this.canonicalHead(),
    });
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

  /** Machines follow the machine and frontend selections; a change to either tells every machine to read its status. */
  private saveDesired(desired: TenantDesired): void {
    const previous = this.desired();
    if (previous.machine !== desired.machine || previous.frontend !== desired.frontend) this.ctx.waitUntil(notifyMachines(this.env, 'all', ['release']));
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
