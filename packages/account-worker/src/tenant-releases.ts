import {
  canonicalHeadSchema,
  deploymentStatusSchema,
  launchProgressSchema,
  launcherStartedInputSchema,
  type LauncherStartedInput,
  releaseRecordSchema,
  releaseStatusSchema,
  releaseTargetSchema,
  stageReleaseInputSchema,
  tenantDesiredSchema,
  MACHINE_EXECUTION_PROTOCOL_VERSION,
  machineProtocolInputSchema,
  revertProgressSchema,
  type LaunchProgress,
  type MachineExecutionAdmission,
  type CanonicalHead,
  type DeploymentStatus,
  type ReleaseRecord,
  type RevertProgress,
  type ReleaseStatus,
  type ReleaseTarget,
  type StageReleaseInput,
  type TenantDesired,
} from '@gitspace/protocol/deployment';
import { z } from 'zod';
import type { FleetCatalogDO } from './fleet-catalog.js';
import type { CredentialVaultDO } from './application.js';
import { defaultMachineReleaseSchema } from '@gitspace/protocol/default-release';
import { platformSwap, tenantPlatformJson, tenantWorkerVersion, type WorkerSwap } from './tenant-platform.js';
import { GITSPACE_SOURCE_REPOSITORY } from '@gitspace/protocol/project-authority';
import { notifyMachines } from './machine-notices.js';
import { BudgetedDurableObject } from './storage-quarantine.js';

declare const GITSPACE_WORKER_SHA: string | undefined;

/** Build stamp injected by `Bun.build({ define })`; channel/dev builds carry none. */
export const WORKER_VERSION: string | undefined = typeof GITSPACE_WORKER_SHA === 'string' ? GITSPACE_WORKER_SHA : undefined;

/** A running Back to stable wakes its object this often, so one whose instance ended (the Worker swap it asked for
 * restarts this object) is picked up even when nothing else calls the object. */
const REVERT_HEARTBEAT_MS = 60_000;
/** A Back to stable still running this long after it started is reported failed; the platform ends its swap and
 * releases its lease well within it. */
const REVERT_DEADLINE_MS = 15 * 60_000;

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

export class TenantReleasesDO extends BudgetedDurableObject {
  /** The revert this instance runs or reads back from the platform. */
  #followingRevert: string | null = null;
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
      CREATE TABLE IF NOT EXISTS latest_revert (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        record_json TEXT NOT NULL
      );
    `);
    migrateReleaseSources(ctx.storage);
    this.certifyOwnLaunch(WORKER_VERSION ?? null);
    // An earlier instance ended under a running revert (the Worker swap restarts this object): the platform kept the
    // swap's outcome under the revert's id.
    const revert = this.latestRevert();
    if (revert?.status === 'running') this.followRevert(revert.revertId, () => platformSwap(this.env, `/operations/${revert.revertId}`));
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

  /** The machine building the running launch started a new process, so nothing builds that launch any more. Coming
   * back on the release it was launching means the launch call went through (a Worker launch is also certified by the
   * new Worker); any other restart interrupted it. Only reports older than the new process count, so a launch that
   * process has already begun is never ended here. */
  launcherStarted(machineId: string, value: LauncherStartedInput): void {
    const input = launcherStartedInputSchema.parse(value);
    const row = this.ctx.storage.sql.exec<{ machine_id: string; record_json: string }>('SELECT machine_id, record_json FROM latest_launch WHERE id = 1').toArray()[0];
    if (!row || row.machine_id !== machineId) return;
    const launch = launchProgressSchema.parse(JSON.parse(row.record_json));
    if (launch.status !== 'running' || launch.updatedAt >= input.startedAt) return;
    const record = launch.sha === null ? null : this.findRelease(launch.sha);
    if (record && launch.sha === input.runningSha && launch.phase === 'launch') { this.finishLaunch(record, launch.targets); return; }
    this.endLaunch(launch, `Interrupted: the building machine restarted during ${launch.phase}.`);
  }

  /** A running launch nobody will finish (its machine is gone) stops blocking launches; a later report from its
   * machine still replaces this. */
  discardLaunch(launchId: string): void {
    const launch = this.latestLaunch();
    if (launch?.launchId !== launchId || launch.status !== 'running') return;
    this.endLaunch(launch, 'Discarded: no machine was reporting this launch.');
  }

  private endLaunch(launch: LaunchProgress, message: string): void {
    const ended = launchProgressSchema.parse({ ...launch, phase: 'failed', message, status: 'failed', error: message, updatedAt: new Date().toISOString() });
    this.ctx.storage.sql.exec('UPDATE latest_launch SET record_json = ? WHERE id = 1', JSON.stringify(ended));
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
        portable: input.artifacts.portable ?? previous?.artifacts.portable,
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

  /**
   * Starts Back to stable unless one is running, and returns it. This object runs it to its end whether or not anyone
   * follows it: the platform swaps the Worker to the default release, and only a swap that succeeded returns every
   * selection to the channel.
   */
  startRevert(userId: string): RevertProgress {
    const running = this.latestRevert();
    if (running?.status === 'running') return running;
    const now = new Date().toISOString();
    const revert: RevertProgress = { revertId: crypto.randomUUID(), status: 'running', error: null, startedAt: now, updatedAt: now };
    this.saveRevert(revert);
    this.followRevert(revert.revertId, () => this.swapToChannel(userId, revert.revertId));
    return revert;
  }

  /** The heartbeat of a running revert: an instance not running it (an earlier one ended) reads its outcome back from
   * the platform, and one past REVERT_DEADLINE_MS is reported failed. An object with no running revert holds no alarm. */
  async alarm(): Promise<void> {
    const revert = this.latestRevert();
    if (revert?.status !== 'running') return;
    if (Date.parse(revert.startedAt) + REVERT_DEADLINE_MS <= Date.now()) {
      await this.settleRevert(revert.revertId, { status: 'failed', error: `Back to stable did not finish within ${REVERT_DEADLINE_MS / 60_000} minutes. Check which Worker runs, then retry.` });
      return;
    }
    if (this.#followingRevert === revert.revertId) await this.ctx.storage.setAlarm(Date.now() + REVERT_HEARTBEAT_MS);
    else this.followRevert(revert.revertId, () => platformSwap(this.env, `/operations/${revert.revertId}`));
  }

  /** The swap a revert asks of the platform under the revert's id; none when the platform already runs the channel. */
  private async swapToChannel(userId: string, revertId: string): Promise<WorkerSwap> {
    const cutover = await this.inferenceCutover();
    if ((await tenantWorkerVersion(this.env, userId)).sha !== null) {
      return platformSwap(this.env, '/revert', { to: 'channel', operationId: revertId, accountId: userId, ...(cutover ? { inferenceVersion: 1 } : {}) });
    }
    if (cutover) return { status: 'failed', error: 'Without a platform worker the channel\'s inference-profile support cannot be verified. Select a source release advertising inferenceVersion 1 instead.' };
    return { status: 'applied', error: null };
  }

  /** Runs `swap` for the running revert in this instance and records how it ended. The alarm beats meanwhile, so the
   * next instance picks the revert up when this one ends first. */
  private followRevert(revertId: string, swap: () => Promise<WorkerSwap>): void {
    if (this.#followingRevert === revertId) return;
    this.#followingRevert = revertId;
    this.ctx.waitUntil((async () => {
      try {
        await this.ctx.storage.setAlarm(Date.now() + REVERT_HEARTBEAT_MS);
        const outcome = await swap().catch((error: unknown): WorkerSwap => ({ status: 'failed', error: error instanceof Error ? error.message : 'Back to stable failed' }));
        await this.settleRevert(revertId, outcome);
      } catch (error) {
        // Storage refuses an instance that was replaced; the next instance reads the outcome back from the platform.
        console.warn(JSON.stringify({ event: 'revert_follow_ended', revertId, message: error instanceof Error ? error.message : String(error) }));
      } finally {
        if (this.#followingRevert === revertId) this.#followingRevert = null;
      }
    })());
  }

  /** Records how the running revert `revertId` ended; only an applied swap returns every selection to the channel. */
  private async settleRevert(revertId: string, outcome: WorkerSwap): Promise<void> {
    const revert = this.latestRevert();
    if (revert?.revertId !== revertId || revert.status !== 'running') return;
    const updatedAt = new Date().toISOString();
    if (outcome.status === 'applied') this.saveDesired({ worker: null, machine: null, frontend: null, updatedAt });
    this.saveRevert(outcome.status === 'applied'
      ? { ...revert, status: 'succeeded', error: null, updatedAt }
      : { ...revert, status: 'failed', error: outcome.error ?? 'Back to stable failed', updatedAt });
    await this.ctx.storage.deleteAlarm();
  }

  private latestRevert(): RevertProgress | null {
    const row = this.ctx.storage.sql.exec<{ record_json: string }>('SELECT record_json FROM latest_revert WHERE id = 1').toArray()[0];
    return row ? revertProgressSchema.parse(JSON.parse(row.record_json)) : null;
  }

  private saveRevert(revert: RevertProgress): void {
    this.ctx.storage.sql.exec('INSERT INTO latest_revert(id, record_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json', JSON.stringify(revertProgressSchema.parse(revert)));
  }

  inferenceCutover(): Promise<boolean> {
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
      desired, current: { worker, machines, ...(platformWorker.version !== version ? { platformWorker } : {}) }, releases, machineExecution, launch: this.latestLaunch(), canonical: this.canonicalHead(), revert: this.latestRevert(),
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
