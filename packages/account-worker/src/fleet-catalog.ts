import { DurableObject } from 'cloudflare:workers';
import { subscriptionIdentity, subscriptionActive } from './account-access.js';
import { DurableChangeLog, type DurableStreamSubscription } from './durable-stream.js';
import { z } from 'zod';
import { cloudImageChoiceSchema, cloudImageOperationActive, cloudImageOperationCancellable, cloudImageProviderStatusSchema, cloudImageSelectionSchema, cloudImageStateSchema, type CloudImageChoice, type CloudImageSelection, type CloudImageState } from '@gitspace/protocol/cloud-image';
import { machineDiscardConfirmationSchema, machineDiscardScopeSchema, type MachineDiscardConfirmation, type MachineDiscardScope } from '@gitspace/protocol/machine-discard';
import { cloudImageProviderCall, prepareCloudImage, resolveCloudImage, runCloudImageOperation, type CloudImageOperationStore } from './sandbox-rollout.js';
import { controlCloudflareSandboxMachine, createCloudflareSandboxMachine } from './sandbox-provisioner.js';
import { controlFleetMachine, ownedWorkspaceScopes, type CredentialVaultDO } from './application.js';
import { listMachineAttachments } from './runtime-machine-loss.js';
import type { RuntimeAttachment, RuntimeCacheObservation } from '@gitspace/protocol-runtime';
import type { ProjectAuthorityDO, UserProjectIndexDO } from './project-authority.js';
import { DirectoryOutbox, type DirectoryPublication } from './account-directory.js';
import type { FleetMachineDefinition } from '@gitspace/protocol/account-directory';
export type { FleetMachineDefinition } from '@gitspace/protocol/account-directory';

/** Cloud machines one account may hold at once; provisioning and stopped ones still count. */
export const CLOUD_MACHINE_LIMIT = 10;
/** Each provisioning attempt is a lease: one not finished by its deadline is fenced and retried. */
export const SANDBOX_PROVISIONING_ATTEMPT_MS = 15 * 60_000;
/** After this many attempts the sandbox is destroyed so a machine that never became ready cannot keep billing. */
export const SANDBOX_PROVISIONING_ATTEMPTS = 3;
export const SANDBOX_PROVISIONING_RETRY_DELAY_MS = 60_000;
/** An image operation recording no progress this long is rolled back, or ended with its barrier released. */
export const CLOUD_IMAGE_OPERATION_DEADLINE_MS = 30 * 60_000;
/** A machine power transition (stop, start, destroy) is a lease: a row still carrying its operation id this long after
 * it started is settled by the fleet alarm, even when the request that began it died. Longer than the slowest chain of
 * bounded provider calls in one transition (`SANDBOX_PROVIDER_DEADLINE_MS`). */
export const MACHINE_OPERATION_LEASE_MS = 20 * 60_000;
const FORCED_DISCARD_TTL_MS = 15 * 60_000;
/** A running cloud sandbox with no usable attachment intent this long is stopped (slept, never destroyed). */
export const CLOUD_MACHINE_IDLE_STOP_MS = 30 * 60_000;
export const CLOUD_MACHINE_IDLE_CHECK_MS = 5 * 60_000;
/** Activity a user or agent is relying on; a watcher or the machine's own idle grace is not. */
const ACTIVITY_KEEPS_MACHINE: Record<RuntimeCacheObservation['activity'][number]['reason'], boolean> = {
  command: true, service: true, proc: true, terminal: true, 'local-work': true, setup: true, sync: true, watcher: false, grace: false,
};

/** Usable intent the cloud must never stop: opted-in local work, live activity or executions, setup or reclaim in
 * flight, a scheduled retry, or a reclaim waiting on the user (held-back LFS). Lost and detached hold nothing. */
export function attachmentKeepsMachineRunning(attachment: RuntimeAttachment): boolean {
  if (attachment.state === 'lost' || attachment.state === 'detached') return false;
  if (attachment.state !== 'ready') return true;
  const cache = attachment.cache;
  return (attachment.failure?.nextRetryAt ?? null) !== null
    || attachment.cacheAction?.status === 'requested' || attachment.cacheAction?.status === 'running'
    || (attachment.executionObservation?.activeExecutions ?? 0) > 0
    || (cache !== undefined && (cache.localWorkOptIn || cache.reclaimBlocked !== null
      || cache.setup.some(step => step.state === 'running')
      || cache.activity.some(item => ACTIVITY_KEEPS_MACHINE[item.reason])));
}
const SANDBOX_ABANDONED = `Sandbox provisioning failed after ${SANDBOX_PROVISIONING_ATTEMPTS} attempts and its cloud machine was destroyed so it cannot keep billing. Destroy this entry and create a new machine.`;

export interface PortableSpaceDefinition {
  projectId: string;
  projectName: string;
  repositoryReference: string | null;
  baseBranch: string;
  spaceId: string;
  kind: 'base' | 'worktree';
  name: string;
  branch: string;
  phase: 'plan' | 'code' | 'review' | 'ship' | null;
}


interface SandboxEnrollment {
  userId: string;
  machineId: string;
  choice: CloudImageChoice;
  environment: Record<string, string>;
}

const pendingMachineDiscardSchema = z.object({
  confirmation: machineDiscardConfirmationSchema,
  workspaces: z.array(machineDiscardScopeSchema),
});

export class FleetCatalogDO extends DurableObject<Env> {
  private readonly changes: DurableChangeLog;
  private readonly directoryOutbox: DirectoryOutbox;
  private readonly imageRuns = new Map<string, { run: Promise<void>; current: boolean }>();
  private readonly provisioningRuns = new Map<string, Promise<void>>();
  private alarmLine: Promise<void> = Promise.resolve();
  private imageDefaultRun: Promise<CloudImageChoice> | null = null;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.changes = new DurableChangeLog(ctx.storage);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fleet_alarms(owner TEXT PRIMARY KEY, timestamp INTEGER NOT NULL)');
    this.directoryOutbox = new DirectoryOutbox(ctx, env, { set: timestamp => this.scheduleAlarm('directory', timestamp), clear: () => this.scheduleAlarm('directory', null) });
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS space_definitions (
          space_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          definition_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fleet_machines (
          machine_id TEXT PRIMARY KEY,
          definition_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS destroyed_machines(machine_id TEXT PRIMARY KEY,destroyed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cloud_images(machine_id TEXT PRIMARY KEY,state_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cloud_image_default(singleton INTEGER PRIMARY KEY CHECK(singleton=1),choice_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cloud_image_operation_ids(operation_id TEXT PRIMARY KEY,machine_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sandbox_enrollments(machine_id TEXT PRIMARY KEY,enrollment_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sandbox_provisioning(machine_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL,deadline_at INTEGER NOT NULL,phase TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS forced_discards(machine_id TEXT PRIMARY KEY,token TEXT NOT NULL,workspaces_json TEXT NOT NULL,issued_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS machine_idle(machine_id TEXT PRIMARY KEY,idle_since INTEGER NOT NULL);
      `);
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS machine_operations(machine_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,deadline_at INTEGER NOT NULL)');
      // Transitions written before operation leases existed lease from their last write.
      for (const row of this.ctx.storage.sql.exec<{ machine_id: string; definition_json: string; updated_at: string }>('SELECT machine_id,definition_json,updated_at FROM fleet_machines').toArray()) {
        const operationId = (JSON.parse(row.definition_json) as Partial<FleetMachineDefinition>).operationId;
        if (typeof operationId === 'string' && !this.hasPendingSandbox(row.machine_id)) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO machine_operations(machine_id,operation_id,deadline_at) VALUES(?,?,?)', row.machine_id, operationId, Date.parse(row.updated_at) + MACHINE_OPERATION_LEASE_MS);
      }
      // No attempt survives an isolate restart; the provisioning lease retries interrupted work shortly.
      const retryAt = Date.now() + SANDBOX_PROVISIONING_RETRY_DELAY_MS;
      for (const row of this.ctx.storage.sql.exec<{ machine_id: string }>('SELECT machine_id FROM sandbox_enrollments').toArray()) {
        this.ctx.storage.sql.exec("INSERT INTO sandbox_provisioning(machine_id,attempts,deadline_at,phase) VALUES(?,1,?,'provisioning') ON CONFLICT(machine_id) DO UPDATE SET deadline_at=MIN(deadline_at,excluded.deadline_at)", row.machine_id, retryAt);
        const machine = this.getMachine(row.machine_id);
        if (machine?.state === 'provisioning') this.saveMachine({
          ...machine, state: 'error', operationId: null, lifecycleRevision: machine.lifecycleRevision + 1,
          error: 'Sandbox provisioning was interrupted; retrying automatically.',
        });
      }
      this.directoryOutbox.kick();
      await this.armProvisioning();
      await this.armImageDeadlines();
      await this.armOperations();
      if (this.listMachines().some(machine => machine.provider === 'cloudflare-sandbox' && machine.state === 'online')) await this.scheduleAlarm('idle', Date.now() + CLOUD_MACHINE_IDLE_CHECK_MS);
    });
  }

  async pendingMachineDiscard(machineId: string): Promise<z.infer<typeof pendingMachineDiscardSchema> | null> {
    const stored = await this.ctx.storage.get(`machine-discard:${machineId}`);
    return stored === undefined ? null : pendingMachineDiscardSchema.parse(stored);
  }

  async beginMachineDiscard(input: z.infer<typeof pendingMachineDiscardSchema>): Promise<void> {
    const validated = pendingMachineDiscardSchema.parse(input);
    const prior = await this.pendingMachineDiscard(validated.confirmation.machineId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(validated)) throw new Error('Another confirmed discard is awaiting provider stop recovery');
    await this.ctx.storage.put(`machine-discard:${validated.confirmation.machineId}`, validated);
  }

  async finishMachineDiscard(machineId: string): Promise<void> {
    await this.ctx.storage.delete(`machine-discard:${machineId}`);
  }

  directoryPublication(): Extract<DirectoryPublication, { source: 'fleet' }> {
    return { source: 'fleet', cursor: this.directoryOutbox.head(), machines: this.listMachines() };
  }

  private scheduleAlarm(owner: 'directory' | 'provisioning' | 'images' | 'idle' | 'operations', timestamp: number | null): Promise<void> {
    if (timestamp === null) this.ctx.storage.sql.exec('DELETE FROM fleet_alarms WHERE owner=?', owner);
    else this.ctx.storage.sql.exec('INSERT INTO fleet_alarms(owner,timestamp) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET timestamp=excluded.timestamp', owner, timestamp);
    const operation = this.alarmLine.then(async () => {
      const next = this.ctx.storage.sql.exec<{ timestamp: number | null }>('SELECT MIN(timestamp) AS timestamp FROM fleet_alarms').toArray()[0]?.timestamp;
      if (next === null || next === undefined) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(next);
    });
    this.alarmLine = operation.catch(() => {});
    return operation;
  }

  /** Every resource-holding fleet state is a lease the cloud forces to a terminal state when it lapses. */
  async alarm(): Promise<void> {
    await this.directoryOutbox.flush();
    const now = Date.now();
    const due = new Set(this.ctx.storage.sql.exec<{ owner: string }>("SELECT owner FROM fleet_alarms WHERE owner<>'directory' AND timestamp<=?", now).toArray().map(row => row.owner));
    if (due.has('provisioning')) await this.expireProvisioningLeases(now);
    if (due.has('images')) await this.expireCloudImageOperations(now);
    if (due.has('idle')) await this.stopIdleSandboxes(now);
    if (due.has('operations')) await this.expireMachineOperations(now);
  }

  private armOperations(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ timestamp: number | null }>('SELECT MIN(deadline_at) AS timestamp FROM machine_operations').toArray()[0]?.timestamp;
    return this.scheduleAlarm('operations', next ?? null);
  }

  /** Settles power transitions whose lease lapsed: the provider's observed state when it answers, otherwise error, and
   * always the timeout recorded on the machine with the operation id cleared so the user can retry. */
  private async expireMachineOperations(now: number): Promise<void> {
    for (const lease of this.ctx.storage.sql.exec<{ machine_id: string; operation_id: string }>('SELECT machine_id,operation_id FROM machine_operations WHERE deadline_at<=?', now).toArray()) {
      const current = this.getMachine(lease.machine_id);
      if (!current || current.operationId !== lease.operation_id || this.hasPendingSandbox(lease.machine_id)) {
        this.ctx.storage.sql.exec('DELETE FROM machine_operations WHERE machine_id=? AND operation_id=?', lease.machine_id, lease.operation_id);
        continue;
      }
      const observed = current.provider === 'cloudflare-sandbox'
        ? await controlCloudflareSandboxMachine({ env: this.env, userId: this.env.ACCOUNT_ID, machineId: current.id, action: 'status' }).catch(() => null)
        : null;
      const latest = this.getMachine(lease.machine_id);
      if (!latest || latest.operationId !== lease.operation_id) continue;
      const transition = latest.state === 'sleeping' ? 'stop' : latest.state === 'resuming' ? 'start' : latest.state === 'deleting' ? 'destroy' : 'lifecycle';
      this.saveMachine({
        ...latest, state: observed?.state ?? 'error', rpcEndpoint: observed ? observed.rpcEndpoint : latest.rpcEndpoint,
        lifecycleRevision: Math.max(latest.lifecycleRevision, observed?.lifecycleRevision ?? 0) + 1, operationId: null,
        error: `Machine ${transition} operation timed out after ${MACHINE_OPERATION_LEASE_MS / 60_000} minutes; ${observed ? `the provider reports it ${observed.state}` : 'the provider could not be reached'}. Retry the action.`,
      });
    }
    await this.armOperations();
  }

  /** Stops (sleeps, never destroys) running cloud sandboxes nobody intends to use. Sleep checkpoints first and keeps
   * the machine for Start; a refused checkpoint is recorded on the machine and the next idle window retries. An
   * open legacy workspace is intent the cloud cannot observe, so its machine is kept. */
  private async stopIdleSandboxes(now: number): Promise<void> {
    let watching = false;
    for (const machine of this.listMachines()) {
      if (machine.provider !== 'cloudflare-sandbox' || machine.state !== 'online' || machine.desiredState !== 'online' || machine.operationId !== null) {
        this.ctx.storage.sql.exec('DELETE FROM machine_idle WHERE machine_id=?', machine.id);
        continue;
      }
      watching = true;
      // Intent that cannot be read counts as intent; one unreachable workspace never stalls the sweep.
      const busy = this.hasPendingSandbox(machine.id) || cloudImageOperationActive(this.cloudImage(machine.id)) || await this.pendingMachineDiscard(machine.id) !== null
        || await listMachineAttachments(this.env, this.env.ACCOUNT_ID, machine.id).then(attachments => attachments.some(attachmentKeepsMachineRunning), () => true)
        || await ownedWorkspaceScopes(this.env, this.env.ACCOUNT_ID, this, machine.id).then(scopes => scopes.length > 0, () => true);
      const idleSince = this.ctx.storage.sql.exec<{ idle_since: number }>('SELECT idle_since FROM machine_idle WHERE machine_id=?', machine.id).toArray()[0]?.idle_since;
      if (busy) this.ctx.storage.sql.exec('DELETE FROM machine_idle WHERE machine_id=?', machine.id);
      else if (idleSince === undefined) this.ctx.storage.sql.exec('INSERT INTO machine_idle(machine_id,idle_since) VALUES(?,?)', machine.id, now);
      else if (now - idleSince >= CLOUD_MACHINE_IDLE_STOP_MS) {
        this.ctx.storage.sql.exec('DELETE FROM machine_idle WHERE machine_id=?', machine.id);
        try {
          await controlFleetMachine(this.env, this.env.ACCOUNT_ID, machine.id, 'sleep');
        } catch (error) {
          console.error(JSON.stringify({ event: 'cloud_machine_auto_stop_failed', machineId: machine.id, errorName: error instanceof Error ? error.name : 'UnknownError' }));
        }
      }
    }
    await this.scheduleAlarm('idle', watching ? now + CLOUD_MACHINE_IDLE_CHECK_MS : null);
  }

  private armProvisioning(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ timestamp: number | null }>("SELECT MIN(deadline_at) AS timestamp FROM sandbox_provisioning WHERE phase IN ('provisioning','releasing')").toArray()[0]?.timestamp;
    return this.scheduleAlarm('provisioning', next ?? null);
  }

  private armImageDeadlines(): Promise<void> {
    const deadlines = this.listCloudImages().flatMap(image => cloudImageOperationActive(image) ? [image.operation!.updatedAt + CLOUD_IMAGE_OPERATION_DEADLINE_MS] : []);
    return this.scheduleAlarm('images', deadlines.length ? Math.min(...deadlines) : null);
  }

  cloudImage(machineId: string): CloudImageState | null {
    const row = this.ctx.storage.sql.exec<{ state_json: string }>('SELECT state_json FROM cloud_images WHERE machine_id=?', machineId).toArray()[0];
    return row ? cloudImageStateSchema.parse(JSON.parse(row.state_json)) : null;
  }

  listCloudImages(): CloudImageState[] {
    return this.ctx.storage.sql.exec<{ state_json: string }>('SELECT state_json FROM cloud_images ORDER BY machine_id').toArray().map(row => cloudImageStateSchema.parse(JSON.parse(row.state_json)));
  }

  watchCloudImages(after: number | null): DurableStreamSubscription {
    return this.changes.watch('cloud-images', after, () => this.listCloudImages());
  }

  saveCloudImage(input: CloudImageState): CloudImageState {
    if (this.hasPendingSandbox(input.machineId)) throw new Error('Finish sandbox provisioning before changing its image');
    return this.writeCloudImage(input);
  }

  private writeCloudImage(input: CloudImageState): CloudImageState {
    const state = cloudImageStateSchema.parse(input);
    this.ctx.storage.transactionSync(() => {
      if (state.operation) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO cloud_image_operation_ids(operation_id,machine_id) VALUES(?,?)', state.operation.id, state.machineId);
      this.ctx.storage.sql.exec('INSERT INTO cloud_images(machine_id,state_json) VALUES(?,?) ON CONFLICT(machine_id) DO UPDATE SET state_json=excluded.state_json', state.machineId, JSON.stringify(state));
      this.changes.append('cloud-images', this.listCloudImages());
    });
    this.changes.wake();
    this.ctx.waitUntil(this.armImageDeadlines());
    return state;
  }

  async cloudImageDefault(): Promise<CloudImageChoice> {
    const row = this.ctx.storage.sql.exec<{ choice_json: string }>('SELECT choice_json FROM cloud_image_default WHERE singleton=1').toArray()[0];
    if (row) return cloudImageChoiceSchema.parse(JSON.parse(row.choice_json));
    if (this.imageDefaultRun) return this.imageDefaultRun;
    const run = (async () => {
      const choice = await resolveCloudImage(this.env, { kind: 'platform-default' });
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO cloud_image_default(singleton,choice_json) VALUES(1,?)', JSON.stringify(choice));
      const pinned = this.ctx.storage.sql.exec<{ choice_json: string }>('SELECT choice_json FROM cloud_image_default WHERE singleton=1').toArray()[0]!;
      return cloudImageChoiceSchema.parse(JSON.parse(pinned.choice_json));
    })();
    this.imageDefaultRun = run;
    try { return await run; } finally { this.imageDefaultRun = null; }
  }

  async setCloudImageDefault(input: CloudImageSelection): Promise<CloudImageChoice> {
    if (this.imageDefaultRun) throw new Error('An account image default update is already in progress');
    const selection = cloudImageSelectionSchema.parse(input);
    const run = (async () => {
      const choice = await resolveCloudImage(this.env, selection);
      await prepareCloudImage(this.env, choice.image);
      this.ctx.storage.sql.exec('INSERT INTO cloud_image_default(singleton,choice_json) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET choice_json=excluded.choice_json', JSON.stringify(choice));
      return choice;
    })();
    this.imageDefaultRun = run;
    try { return await run; } finally { this.imageDefaultRun = null; }
  }

  startCloudImage(input: { userId: string; machineId: string; operationId: string; selection: CloudImageSelection }): CloudImageState {
    if (input.userId !== this.env.ACCOUNT_ID) throw new Error('Cloud image operation belongs to another account');
    const operationId = z.string().uuid().parse(input.operationId);
    const selection = cloudImageSelectionSchema.parse(input.selection);
    const machine = this.getMachine(input.machineId);
    if (!machine || machine.provider !== 'cloudflare-sandbox') throw new Error('Account cloud machine does not exist');
    if (this.hasPendingSandbox(machine.id)) throw new Error('Finish sandbox provisioning before changing its image');
    const existing = this.cloudImage(machine.id);
    if (existing?.operation?.id === operationId) {
      if (JSON.stringify(existing.selection) !== JSON.stringify(selection)) throw new Error('Operation id is already bound to another image');
      return existing;
    }
    if (this.ctx.storage.sql.exec('SELECT operation_id FROM cloud_image_operation_ids WHERE operation_id=?', operationId).toArray().length) throw new Error('Image operation id has already been used; it cannot select another machine or supersede a newer operation');
    if (cloudImageOperationActive(existing)) throw new Error('Recover or cancel the active image operation first');
    if (machine.operationId || machine.desiredState !== 'online' || machine.state !== 'online') throw new Error('Start the cloud machine and finish its lifecycle operation before changing its image');
    const now = Date.now();
    const state = this.saveCloudImage({ machineId: machine.id, currentImage: existing?.currentImage ?? null, desiredImage: selection.kind === 'custom' ? selection.image : null, selection, operation: { id: operationId, phase: 'staging', barrier: false, error: null, startedAt: now, updatedAt: now, resumeSpaceIds: [] } });
    this.launchCloudImage(state);
    return state;
  }

  retryCloudImage(input: { userId: string; machineId: string; operationId: string; cancel?: boolean }): CloudImageState {
    if (input.userId !== this.env.ACCOUNT_ID) throw new Error('Cloud image operation belongs to another account');
    const state = this.cloudImage(input.machineId);
    if (!this.getMachine(input.machineId) || !state?.operation || state.operation.id !== input.operationId) throw new Error('Cloud image operation identity does not match this account machine');
    if (!cloudImageOperationActive(state)) return state;
    if (this.imageRuns.has(input.machineId)) {
      if (input.cancel) throw new Error('Image operation is running; wait for it to settle before cancelling');
      return state;
    }
    if (input.cancel) {
      if (!cloudImageOperationCancellable(state)) throw new Error('Image selection may already have changed; retry recovery instead of cancelling');
      if (state.operation.phase === 'staging') {
        state.operation.phase = 'cancelled';
        state.desiredImage = state.currentImage;
      } else state.operation.phase = 'cancelling';
    }
    state.operation.error = null;
    state.operation.updatedAt = Date.now();
    this.saveCloudImage(state);
    if (cloudImageOperationActive(state)) this.launchCloudImage(state);
    return state;
  }

  recoverCloudImage(input: { userId: string; machineId: string; operationId: string; recoveryOperationId: string; selection: CloudImageSelection; discardUncheckpointedCandidate?: boolean; approvedBy: string }): CloudImageState {
    if (input.userId !== this.env.ACCOUNT_ID) throw new Error('Cloud image operation belongs to another account');
    const recoveryId = z.string().uuid().parse(input.recoveryOperationId);
    const selection = cloudImageSelectionSchema.parse(input.selection);
    const discardApproval = input.discardUncheckpointedCandidate ? { deviceId: z.string().min(1).parse(input.approvedBy), at: Date.now() } : undefined;
    const state = this.cloudImage(input.machineId);
    if (!this.getMachine(input.machineId) || !state?.operation) throw new Error('Account cloud machine image operation does not exist');
    if (state.operation.id === recoveryId) {
      if (state.operation.recoveryOf !== input.operationId || JSON.stringify(state.selection) !== JSON.stringify(selection) || !!state.operation.discardApproval !== !!discardApproval) throw new Error('Recovery id is already bound to another operation, image or consent');
      return state;
    }
    if (state.operation.id !== input.operationId || !cloudImageOperationActive(state) || cloudImageOperationCancellable(state)) throw new Error('This operation does not require alternate-image recovery');
    if (this.imageRuns.has(input.machineId)) throw new Error('Wait for the current image operation to settle before selecting a recovery image');
    if (this.ctx.storage.sql.exec('SELECT operation_id FROM cloud_image_operation_ids WHERE operation_id=?', recoveryId).toArray().length) throw new Error('Recovery operation id has already been used');
    const now = Date.now();
    const recovering = this.saveCloudImage({ ...state, selection, desiredImage: selection.kind === 'custom' ? selection.image : null, operation: { id: recoveryId, recoveryOf: input.operationId, discardApproval, phase: 'staging', barrier: true, error: null, startedAt: now, updatedAt: now, resumeSpaceIds: state.operation.resumeSpaceIds } });
    this.launchCloudImage(recovering);
    return recovering;
  }

  private launchCloudImage(state: CloudImageState): void {
    if (this.imageRuns.has(state.machineId)) return;
    const entry = { run: Promise.resolve(), current: true };
    // A run superseded at its deadline may still be awaiting the provider, but it can no longer commit.
    const store: CloudImageOperationStore = {
      saveCloudImage: (next) => { if (!entry.current) throw new Error('Image operation was superseded after missing its deadline'); return this.saveCloudImage(next); },
      putMachine: (machine) => { if (!entry.current) throw new Error('Image operation was superseded after missing its deadline'); return this.putMachine(machine); },
      listSpaces: () => this.listSpaces(),
      getMachine: (machineId) => this.getMachine(machineId),
    };
    entry.run = runCloudImageOperation(this.env, store, state).finally(() => { if (this.imageRuns.get(state.machineId) === entry) this.imageRuns.delete(state.machineId); });
    this.imageRuns.set(state.machineId, entry);
    this.ctx.waitUntil(entry.run);
  }

  /** No progress for the deadline means the operation is hung. A cancellable one rolls back; an overdue
   * rollback, or one past the point of no cancellation, ends with its admission barrier released. */
  private async expireCloudImageOperations(now: number): Promise<void> {
    for (const state of this.listCloudImages()) {
      const operation = state.operation;
      if (!operation || !cloudImageOperationActive(state) || operation.updatedAt + CLOUD_IMAGE_OPERATION_DEADLINE_MS > now) continue;
      const hung = this.imageRuns.get(state.machineId);
      if (hung) {
        hung.current = false;
        this.imageRuns.delete(state.machineId);
      }
      if (operation.phase === 'checkpointing' && cloudImageOperationCancellable(state)) {
        this.launchCloudImage(this.writeCloudImage({ ...state, operation: { ...operation, phase: 'cancelling', updatedAt: now, error: 'Image operation stalled past its deadline; rolling back to the current image.' } }));
        continue;
      }
      const cancelled = operation.phase === 'staging' && !operation.recoveryOf;
      const error = cancelled ? 'Image operation stalled past its deadline and was cancelled.'
        : 'Image operation stalled past its deadline; its admission barrier was released. Workspaces resume from their last checkpoint; check this machine before relying on its image.';
      this.writeCloudImage({ ...state, desiredImage: state.currentImage, operation: { ...operation, phase: 'cancelled', barrier: false, updatedAt: now, error } });
      const machine = this.getMachine(state.machineId);
      if (machine && !cancelled) this.saveMachine({ ...machine, state: 'error', lifecycleRevision: machine.lifecycleRevision + 1, operationId: null, error });
    }
    await this.armImageDeadlines();
  }

  hasPendingSandbox(machineId: string): boolean {
    validateId(machineId);
    return this.ctx.storage.sql.exec('SELECT machine_id FROM sandbox_enrollments WHERE machine_id=?', machineId).toArray().length > 0;
  }

  /** True once the provisioning lease is exhausted: the record stays visible in error and can only be destroyed. */
  abandonedSandbox(machineId: string): boolean {
    return this.ctx.storage.sql.exec("SELECT machine_id FROM sandbox_provisioning WHERE machine_id=? AND phase<>'provisioning'", machineId).toArray().length > 0;
  }

  /** Atomic with the insert that follows it: both run in one synchronous Durable Object turn. */
  assertCloudMachineCapacity(): void {
    if (this.listMachines().filter(machine => machine.provider === 'cloudflare-sandbox').length >= CLOUD_MACHINE_LIMIT) {
      throw new Error(`This account already has ${CLOUD_MACHINE_LIMIT} cloud machines, the maximum. Destroy one before creating another.`);
    }
  }

  beginSandboxProvisioning(input: SandboxEnrollment): FleetMachineDefinition {
    if (input.userId !== this.env.ACCOUNT_ID) throw new Error('Machine belongs to another account');
    if (!/^sandbox-[a-z0-9-]{1,64}$/u.test(input.machineId) || input.environment.GITSPACE_MACHINE_ID !== input.machineId || input.environment.GITSPACE_USER_ID !== input.userId) throw new Error('Sandbox enrollment identity is invalid');
    if (this.getMachine(input.machineId) || this.wasMachineDestroyed(input.machineId)) throw new Error('Sandbox identity has already been allocated');
    const choice = cloudImageChoiceSchema.parse(input.choice);
    const machine: FleetMachineDefinition = {
      id: input.machineId, label: `Cloudflare ${input.machineId.slice('sandbox-'.length)}`,
      state: 'provisioning', rpcEndpoint: null, kind: 'sandbox', provider: 'cloudflare-sandbox',
      notes: 'Provisioning Cloudflare Sandbox machine runtime.', desiredState: 'online',
      lifecycleRevision: 1, operationId: crypto.randomUUID(), error: null,
    };
    this.ctx.storage.transactionSync(() => {
      this.assertCloudMachineCapacity();
      // The only durable copy of private enrollment belongs to this tenant, never
      // a fleet snapshot, event, image record, or platform resource definition.
      this.ctx.storage.sql.exec('INSERT INTO sandbox_enrollments(machine_id,enrollment_json) VALUES(?,?)', machine.id, JSON.stringify({ ...input, choice }));
      this.ctx.storage.sql.exec("INSERT INTO sandbox_provisioning(machine_id,attempts,deadline_at,phase) VALUES(?,1,?,'provisioning')", machine.id, Date.now() + SANDBOX_PROVISIONING_ATTEMPT_MS);
      this.writeCloudImage({ machineId: machine.id, selection: choice.kind === 'custom' ? choice : { kind: 'platform-default' }, currentImage: null, desiredImage: choice.image, operation: null });
      this.saveMachine(machine);
    });
    this.ctx.waitUntil(this.armProvisioning());
    this.launchSandboxProvisioning(machine.id);
    return machine;
  }

  resumeSandboxProvisioning(userId: string, machineId: string): FleetMachineDefinition | null {
    if (userId !== this.env.ACCOUNT_ID) throw new Error('Machine belongs to another account');
    if (this.abandonedSandbox(machineId)) throw new Error(SANDBOX_ABANDONED);
    if (!this.hasPendingSandbox(machineId)) return null;
    const current = this.getMachine(machineId);
    if (!current || current.desiredState !== 'online') throw new Error('Sandbox provisioning is no longer active');
    if (this.provisioningRuns.has(machineId)) return current;
    // An explicit Start is a new decision with a fresh attempt budget.
    const machine = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO sandbox_provisioning(machine_id,attempts,deadline_at,phase) VALUES(?,1,?,'provisioning') ON CONFLICT(machine_id) DO UPDATE SET attempts=1,deadline_at=excluded.deadline_at", machineId, Date.now() + SANDBOX_PROVISIONING_ATTEMPT_MS);
      return this.saveMachine({ ...current, state: 'provisioning', lifecycleRevision: current.lifecycleRevision + 1, operationId: crypto.randomUUID(), error: null });
    });
    this.ctx.waitUntil(this.armProvisioning());
    this.launchSandboxProvisioning(machineId);
    return machine;
  }

  private launchSandboxProvisioning(machineId: string): void {
    if (this.provisioningRuns.has(machineId)) return;
    const run: Promise<void> = this.runSandboxProvisioning(machineId).finally(() => { if (this.provisioningRuns.get(machineId) === run) this.provisioningRuns.delete(machineId); });
    this.provisioningRuns.set(machineId, run);
    this.ctx.waitUntil(run);
  }

  /** An attempt that missed its deadline is fenced by a new operation id (a hung run can no longer
   * commit) and retried; an exhausted lease destroys the sandbox. */
  private async expireProvisioningLeases(now: number): Promise<void> {
    for (const lease of this.ctx.storage.sql.exec<{ machine_id: string; attempts: number; phase: string }>("SELECT machine_id,attempts,phase FROM sandbox_provisioning WHERE phase IN ('provisioning','releasing') AND deadline_at<=?", now).toArray()) {
      const current = this.getMachine(lease.machine_id);
      if (lease.phase === 'releasing') {
        await this.releaseSandbox(lease.machine_id);
      } else if (!current || current.desiredState !== 'online' || !this.hasPendingSandbox(lease.machine_id)) {
        this.ctx.storage.sql.exec('DELETE FROM sandbox_provisioning WHERE machine_id=?', lease.machine_id);
      } else if (lease.attempts >= SANDBOX_PROVISIONING_ATTEMPTS) {
        await this.releaseSandbox(lease.machine_id);
      } else {
        this.provisioningRuns.delete(lease.machine_id);
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('UPDATE sandbox_provisioning SET attempts=attempts+1,deadline_at=? WHERE machine_id=?', now + SANDBOX_PROVISIONING_ATTEMPT_MS, lease.machine_id);
          this.saveMachine({ ...current, state: 'provisioning', lifecycleRevision: current.lifecycleRevision + 1, operationId: crypto.randomUUID(), error: null });
        });
        this.launchSandboxProvisioning(lease.machine_id);
      }
    }
    await this.armProvisioning();
  }

  private async failSandboxAttempt(machineId: string): Promise<void> {
    const attempts = this.ctx.storage.sql.exec<{ attempts: number }>("SELECT attempts FROM sandbox_provisioning WHERE machine_id=? AND phase='provisioning'", machineId).toArray()[0]?.attempts ?? SANDBOX_PROVISIONING_ATTEMPTS;
    if (attempts >= SANDBOX_PROVISIONING_ATTEMPTS) return this.releaseSandbox(machineId);
    const current = this.getMachine(machineId)!;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('UPDATE sandbox_provisioning SET deadline_at=? WHERE machine_id=?', Date.now() + SANDBOX_PROVISIONING_RETRY_DELAY_MS, machineId);
      this.saveMachine({ ...current, state: 'error', lifecycleRevision: current.lifecycleRevision + 1, operationId: null, error: `Sandbox provisioning attempt ${attempts} of ${SANDBOX_PROVISIONING_ATTEMPTS} failed; retrying automatically. Start retries now with its retained enrollment.` });
    });
    await this.armProvisioning();
  }

  /** Fences the enrollment first, then revokes the machine credential and destroys the provider sandbox.
   * A failed destroy stays 'releasing' and the lease alarm retries it. */
  private async releaseSandbox(machineId: string): Promise<void> {
    this.provisioningRuns.delete(machineId);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM sandbox_enrollments WHERE machine_id=?', machineId);
      this.ctx.storage.sql.exec("UPDATE sandbox_provisioning SET phase='releasing',deadline_at=? WHERE machine_id=?", Date.now() + SANDBOX_PROVISIONING_RETRY_DELAY_MS, machineId);
      const current = this.getMachine(machineId);
      if (current) this.saveMachine({ ...current, state: 'error', desiredState: 'offline', lifecycleRevision: current.lifecycleRevision + 1, operationId: null, error: `Sandbox provisioning failed after ${SANDBOX_PROVISIONING_ATTEMPTS} attempts; destroying its cloud machine so it cannot keep billing.` });
    });
    try {
      await (this.env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(this.env.ACCOUNT_ID).removeManagedDevice(machineId);
      await controlCloudflareSandboxMachine({ env: this.env, userId: this.env.ACCOUNT_ID, machineId, action: 'destroy' });
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE sandbox_provisioning SET phase='released' WHERE machine_id=?", machineId);
        const released = this.getMachine(machineId);
        if (released) this.saveMachine({ ...released, lifecycleRevision: released.lifecycleRevision + 1, error: SANDBOX_ABANDONED });
      });
    } catch (error) {
      // Provider failures may echo enrollment; record only the error class.
      console.error(JSON.stringify({ event: 'sandbox_release_failed', machineId, errorName: error instanceof Error ? error.name : 'UnknownError' }));
    }
    await this.armProvisioning();
  }

  private async runSandboxProvisioning(machineId: string): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ enrollment_json: string }>('SELECT enrollment_json FROM sandbox_enrollments WHERE machine_id=?', machineId).toArray()[0];
    if (!row) return;
    const enrollment = JSON.parse(row.enrollment_json) as SandboxEnrollment;
    const operationId = this.getMachine(machineId)?.operationId;
    const active = () => this.hasPendingSandbox(machineId) && this.getMachine(machineId)?.operationId === operationId;
    try {
      await prepareCloudImage(this.env, enrollment.choice.image);
      if (!active()) return;
      let machine: FleetMachineDefinition | null;
      try {
        machine = await createCloudflareSandboxMachine({ env: this.env, userId: enrollment.userId, machineId, image: enrollment.choice.image, environment: enrollment.environment });
      } catch {
        if (!active()) return;
        // Creation may have been accepted even though its response was lost.
        // Observe once; an unready/unenrolled machine remains explicitly retryable.
        machine = await controlCloudflareSandboxMachine({ env: this.env, userId: enrollment.userId, machineId, action: 'status' });
      }
      if (!active()) return;
      // Enrollment acknowledges process start, not host readiness.
      if (machine?.state === 'offline') {
        machine = await controlCloudflareSandboxMachine({ env: this.env, userId: enrollment.userId, machineId, action: 'resume' });
        if (!active()) return;
      }
      const provider = cloudImageProviderStatusSchema.parse(await cloudImageProviderCall(this.env, `/v1/sandboxes/${encodeURIComponent(machineId)}/image/status`));
      if (!active()) return;
      if (!machine || machine.state !== 'online' || provider.image !== enrollment.choice.image || provider.prepared) throw new Error('Sandbox is not ready');
      const current = this.getMachine(machineId)!;
      const rpcEndpoint = new URL(`/__sandbox/${encodeURIComponent(enrollment.userId)}/${encodeURIComponent(machineId)}/rpc`, enrollment.environment.GITSPACE_CONTROL_URL).toString();
      const lifecycleRevision = Math.max(current.lifecycleRevision, machine.lifecycleRevision) + 1;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM sandbox_enrollments WHERE machine_id=?', machineId);
        this.ctx.storage.sql.exec('DELETE FROM sandbox_provisioning WHERE machine_id=?', machineId);
        this.writeCloudImage({ ...this.cloudImage(machineId)!, currentImage: enrollment.choice.image });
        // Provider error/notes/labels are untrusted and may echo enrollment.
        this.saveMachine({ ...current, state: 'online', rpcEndpoint, notes: 'Managed Cloudflare Sandbox. Machine runtime ready.', lifecycleRevision, operationId: null, error: null });
      });
      await this.armProvisioning();
    } catch {
      if (!active()) return;
      await this.failSandboxAttempt(machineId);
    }
  }

  putSpace(input: PortableSpaceDefinition): PortableSpaceDefinition {
    validateSpace(input);
    this.ctx.storage.sql.exec(`
      INSERT INTO space_definitions(space_id, project_id, definition_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(space_id) DO UPDATE SET
        project_id = excluded.project_id,
        definition_json = excluded.definition_json,
        updated_at = excluded.updated_at
    `, input.spaceId, input.projectId, JSON.stringify(input), new Date().toISOString());
    return input;
  }

  getSpace(spaceId: string): PortableSpaceDefinition | null {
    validateId(spaceId);
    const row = this.ctx.storage.sql.exec<{ definition_json: string }>('SELECT definition_json FROM space_definitions WHERE space_id = ?', spaceId).toArray()[0];
    return row ? JSON.parse(row.definition_json) as PortableSpaceDefinition : null;
  }

  async listSpaces(): Promise<PortableSpaceDefinition[]> {
    const projects = await (this.env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(this.env.ACCOUNT_ID).list();
    const definitions = await Promise.all(projects.map(async project => ({
      project,
      workspaces: await (this.env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`${this.env.ACCOUNT_ID}:${project.id}`).listWorkspaces(),
    })));
    return definitions.flatMap(({ project, workspaces }) => workspaces.map(workspace => ({
      projectId: project.id, projectName: project.name, repositoryReference: project.repositoryReference,
      baseBranch: project.baseBranch, spaceId: workspace.id, kind: workspace.kind,
      name: workspace.name, branch: workspace.branch, phase: workspace.phase,
    })));
  }

  putMachine(input: FleetMachineDefinition): FleetMachineDefinition {
    const current = this.getMachine(input.id);
    if (this.wasMachineDestroyed(input.id)) throw new Error('Machine has been destroyed');
    if (current?.desiredState === 'removed' && input.desiredState !== 'removed') throw new Error('Machine is being destroyed');
    if (this.hasPendingSandbox(input.id)) {
      if (input.desiredState === 'removed') {
        // Fence every suspended provisioning continuation before a provider
        // destroy can run; Start must never retrieve these credentials again.
        return this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('DELETE FROM sandbox_enrollments WHERE machine_id=?', input.id);
          return this.saveMachine(input);
        });
      }
      if (input.desiredState !== 'online' || input.operationId !== null && input.operationId !== current?.operationId) throw new Error('Finish sandbox provisioning before changing its lifecycle');
      // Runtime self-registration/status is not evidence that enrollment and its
      // selected image have been confirmed by the provisioning owner.
      return current!;
    }
    return this.saveMachine(input);
  }

  /** A machine's own report describes what it observes; lifecycle intent, kind and provider stay account-owned. */
  reportMachine(input: FleetMachineDefinition): FleetMachineDefinition {
    const current = this.getMachine(input.id);
    return this.putMachine(current
      ? { ...current, label: input.label, state: input.state, rpcEndpoint: input.rpcEndpoint, notes: input.notes }
      : { ...input, kind: 'physical', provider: 'physical', desiredState: 'online', lifecycleRevision: 0, operationId: null, error: null });
  }

  /** A cloud-issued destroy confirmation for a cloud machine whose runtime could not checkpoint. It is bound to the
   * machine and the exact owned-workspace scope, and expires; reissuing for an unchanged scope keeps the token. */
  issueForcedDiscard(machineId: string, workspaces: MachineDiscardScope[]): MachineDiscardConfirmation {
    const scope = JSON.stringify(z.array(machineDiscardScopeSchema).parse(workspaces));
    const now = Date.now();
    const issued = this.ctx.storage.sql.exec<{ token: string; workspaces_json: string; issued_at: number }>('SELECT token,workspaces_json,issued_at FROM forced_discards WHERE machine_id=?', machineId).toArray()[0];
    if (issued && issued.workspaces_json === scope && issued.issued_at + FORCED_DISCARD_TTL_MS > now) return { machineId, action: 'destroy', token: issued.token };
    const token = `cloud:${crypto.randomUUID()}`;
    this.ctx.storage.sql.exec('INSERT INTO forced_discards(machine_id,token,workspaces_json,issued_at) VALUES(?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET token=excluded.token,workspaces_json=excluded.workspaces_json,issued_at=excluded.issued_at', machineId, token, scope, now);
    return { machineId, action: 'destroy', token };
  }

  /** The workspace scope a still-valid cloud-issued confirmation covers, or null when it is not one. */
  forcedDiscardScope(confirmation: MachineDiscardConfirmation): MachineDiscardScope[] | null {
    const issued = this.ctx.storage.sql.exec<{ token: string; workspaces_json: string; issued_at: number }>('SELECT token,workspaces_json,issued_at FROM forced_discards WHERE machine_id=?', confirmation.machineId).toArray()[0];
    if (!issued || confirmation.action !== 'destroy' || issued.token !== confirmation.token || issued.issued_at + FORCED_DISCARD_TTL_MS <= Date.now()) return null;
    return z.array(machineDiscardScopeSchema).parse(JSON.parse(issued.workspaces_json));
  }

  private saveMachine(input: FleetMachineDefinition): FleetMachineDefinition {
    validateId(input.id);
    if (!input.label || !['provisioning', 'online', 'sleeping', 'offline', 'resuming', 'deleting', 'error'].includes(input.state) || !['online', 'offline', 'removed'].includes(input.desiredState) || !Number.isInteger(input.lifecycleRevision) || input.lifecycleRevision < 0 || !['physical', 'sandbox'].includes(input.kind) || !['physical', 'cloudflare-sandbox'].includes(input.provider) || input.notes.length > 4_000) throw new Error('Machine definition is invalid');
    if (input.rpcEndpoint !== null && !input.rpcEndpoint.startsWith('/')) new URL(input.rpcEndpoint);
    const current = this.getMachine(input.id);
    if (cloudImageOperationActive(this.cloudImage(input.id)) && (input.operationId !== null || input.desiredState !== 'online')) throw new Error('Cloud image recovery has reserved this machine lifecycle');
    // Heartbeats with identical public state must not wake the account directory.
    if (current && current.label === input.label && current.state === input.state && current.rpcEndpoint === input.rpcEndpoint
      && current.kind === input.kind && current.notes === input.notes && current.provider === input.provider
      && current.desiredState === input.desiredState && current.lifecycleRevision === input.lifecycleRevision
      && current.operationId === input.operationId && current.error === input.error) return current;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
        INSERT INTO fleet_machines(machine_id, definition_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(machine_id) DO UPDATE SET definition_json = excluded.definition_json, updated_at = excluded.updated_at
      `, input.id, JSON.stringify(input), new Date().toISOString());
      this.ctx.storage.sql.exec('DELETE FROM destroyed_machines WHERE machine_id=?', input.id);
      // Provisioning keeps its own lease; every other operation id is a power transition lease.
      if (input.operationId === null || this.hasPendingSandbox(input.id)) this.ctx.storage.sql.exec('DELETE FROM machine_operations WHERE machine_id=?', input.id);
      else this.ctx.storage.sql.exec('INSERT INTO machine_operations(machine_id,operation_id,deadline_at) VALUES(?,?,?) ON CONFLICT(machine_id) DO UPDATE SET operation_id=excluded.operation_id,deadline_at=excluded.deadline_at WHERE operation_id<>excluded.operation_id', input.id, input.operationId, Date.now() + MACHINE_OPERATION_LEASE_MS);
      const machines = this.listMachines();
      this.changes.append('machines', machines);
      this.directoryOutbox.enqueue({ source: 'fleet', machines });
    });
    this.directoryOutbox.kick();
    this.changes.wake();
    this.ctx.waitUntil(this.broadcast({ type: 'upsert', machineId: input.id, machine: input }));
    this.ctx.waitUntil(this.armOperations());
    if (input.provider === 'cloudflare-sandbox' && input.state === 'online' && input.desiredState === 'online'
      && this.ctx.storage.sql.exec("SELECT owner FROM fleet_alarms WHERE owner='idle'").toArray().length === 0) {
      this.ctx.waitUntil(this.scheduleAlarm('idle', Date.now() + CLOUD_MACHINE_IDLE_CHECK_MS));
    }
    return input;
  }

  getMachine(machineId: string): FleetMachineDefinition | null {
    validateId(machineId);
    const row = this.ctx.storage.sql.exec<{ definition_json: string }>('SELECT definition_json FROM fleet_machines WHERE machine_id = ?', machineId).toArray()[0];
    if (!row) return null;
    const value = JSON.parse(row.definition_json) as Partial<FleetMachineDefinition> & Pick<FleetMachineDefinition, 'id' | 'label' | 'state' | 'rpcEndpoint'>;
    return normalizeMachine(value);
  }

  removeMachine(machineId: string, destroyed = false): boolean {
    validateId(machineId);
    if (cloudImageOperationActive(this.cloudImage(machineId))) throw new Error('Cloud image recovery has reserved this machine');
    destroyed ||= this.hasPendingSandbox(machineId);
    const removed = this.ctx.storage.transactionSync(() => {
      if (destroyed) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO destroyed_machines(machine_id,destroyed_at) VALUES(?,?)', machineId, new Date().toISOString());
      this.ctx.storage.sql.exec('DELETE FROM sandbox_enrollments WHERE machine_id=?', machineId);
      this.ctx.storage.sql.exec('DELETE FROM sandbox_provisioning WHERE machine_id=?', machineId);
      this.ctx.storage.sql.exec('DELETE FROM forced_discards WHERE machine_id=?', machineId);
      this.ctx.storage.sql.exec('DELETE FROM machine_idle WHERE machine_id=?', machineId);
      this.ctx.storage.sql.exec('DELETE FROM machine_operations WHERE machine_id=?', machineId);
      const removed = this.ctx.storage.sql.exec('DELETE FROM fleet_machines WHERE machine_id = ?', machineId).rowsWritten > 0;
      if (removed) {
        const machines = this.listMachines();
        this.changes.append('machines', machines);
        this.ctx.storage.sql.exec('DELETE FROM cloud_images WHERE machine_id=?', machineId);
        this.changes.append('cloud-images', this.listCloudImages());
        this.directoryOutbox.enqueue({ source: 'fleet', machines });
      }
      return removed;
    });
    this.directoryOutbox.kick();
    if (removed) {
      this.changes.wake();
      this.ctx.waitUntil(this.broadcast({ type: 'remove', machineId, machine: null }));
    }
    return removed;
  }

  wasMachineDestroyed(machineId: string): boolean {
    validateId(machineId);
    return this.ctx.storage.sql.exec('SELECT machine_id FROM destroyed_machines WHERE machine_id=?', machineId).toArray().length > 0;
  }

  /** Whether workspaces may still hold attachments of machines removed before attachment leases existed. */
  runtimeLeaseBackfillPending(): boolean {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_lease_backfill(singleton INTEGER PRIMARY KEY CHECK(singleton=1), completed_at TEXT NOT NULL)');
    return this.ctx.storage.sql.exec('SELECT singleton FROM runtime_lease_backfill').toArray().length === 0;
  }

  completeRuntimeLeaseBackfill(): void {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_lease_backfill(singleton INTEGER PRIMARY KEY CHECK(singleton=1), completed_at TEXT NOT NULL)');
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO runtime_lease_backfill(singleton,completed_at) VALUES(1,?)', new Date().toISOString());
  }

  listMachines(): FleetMachineDefinition[] {
    return this.ctx.storage.sql.exec<{ definition_json: string }>('SELECT definition_json FROM fleet_machines ORDER BY machine_id').toArray()
      .map((row) => {
        const value = JSON.parse(row.definition_json) as Partial<FleetMachineDefinition> & Pick<FleetMachineDefinition, 'id' | 'label' | 'state' | 'rpcEndpoint'>;
        return normalizeMachine(value);
      });
  }
  watch(after: number | null): DurableStreamSubscription {
    return this.changes.watch('machines', after, () => this.listMachines());
  }
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const identity = await subscriptionIdentity(this.env, request, 'space.control');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(identity);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (await subscriptionActive(this.env, socket, 'space.control') && message === 'ping') socket.send('pong');
  }

  private async broadcast(event: { type: 'upsert' | 'remove'; machineId: string; machine: FleetMachineDefinition | null }): Promise<void> {
    const encoded = JSON.stringify(event);
    await Promise.all(this.ctx.getWebSockets().map(async (socket) => {
      if (!await subscriptionActive(this.env, socket, 'space.control')) return;
      try { socket.send(encoded); } catch { socket.close(1011, 'Fleet event delivery failed'); }
    }));
  }
}

function normalizeMachine(value: Partial<FleetMachineDefinition> & Pick<FleetMachineDefinition, 'id' | 'label' | 'state' | 'rpcEndpoint'>): FleetMachineDefinition {
  const state = ['provisioning', 'online', 'sleeping', 'offline', 'resuming', 'deleting', 'error'].includes(value.state) ? value.state : 'offline';
  return {
    ...value,
    state,
    kind: value.kind ?? 'physical',
    provider: value.provider ?? (value.kind === 'sandbox' ? 'cloudflare-sandbox' : 'physical'),
    notes: value.notes ?? '',
    desiredState: value.desiredState ?? (state === 'offline' ? 'offline' : 'online'),
    lifecycleRevision: value.lifecycleRevision ?? 0,
    operationId: value.operationId ?? null,
    error: value.error ?? null,
  };
}

function validateSpace(input: PortableSpaceDefinition): void {
  validateId(input.projectId);
  validateId(input.spaceId);
  if (!input.projectName || !input.baseBranch || !input.name || !input.branch) throw new Error('Space definition is invalid');
  if (input.kind === 'base' && (input.spaceId !== input.projectId || input.phase !== null)) throw new Error('Base definition is invalid');
  if (input.kind === 'worktree' && !['plan', 'code', 'review', 'ship'].includes(input.phase ?? '')) throw new Error('Worktree definition is invalid');
}

function validateId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value)) throw new Error('Catalog id is invalid');
}
