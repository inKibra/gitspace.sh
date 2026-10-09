import { DurableObject } from 'cloudflare:workers';
import { Result } from 'better-result';
import { abortSpaceClose, beginSpaceClose, beginSpaceOpen, bootstrapSpaceAuthority, commitSpaceClosed, commitSpaceOpen, failSpaceOpen, SpaceAuthorityRecordSchema, WorkspaceDomainError, type SpaceAuthorityMutation, type SpaceAuthorityRecord, type SpaceAuthorityResult, type VerifiedSpaceAuthorityIdentity } from '@gitspace/protocol-workspace';
import { DurableChangeLog, type DurableStreamSubscription } from './durable-stream.js';
import { cloudImageDiscardReceiptSchema, type CloudImageDiscardReceipt } from '@gitspace/protocol/cloud-image';
import { DirectoryOutbox, type DirectoryPublication } from './account-directory.js';
import { RuntimeAttachmentSchema, RuntimeCachePolicySchema, RuntimeIdentitySchema, RuntimeJsonSchema, RuntimeSubmitInputSchema, RuntimeCancelInputSchema, RuntimeAnswerInputSchema, RuntimeWatchInputSchema, type RuntimeAttachment, type RuntimeAttachmentLossReason, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { ArtifactsCodeStore, artifactsProjectRepository, artifactsWorkspaceRepository, isSupportedBranchName, CloudPublicationUncertain, readCurrentCheckpoint, readRuntimeLfsRoots, readRuntimeSnapshot, reconcileRuntimeLfsSources, type WorkspaceRuntime } from '@gitspace/runtime-workspace-do';
import { createAccountWorkspaceRuntime, ensureProjectCodeRepository } from './account-runtime-host.js';
import { RuntimeSessionInputSchema } from '@gitspace/protocol-runtime/session-controls';
import { RuntimeDraftSaveInputSchema } from '@gitspace/protocol-runtime/draft';
import { RuntimeServiceInputSchema } from '@gitspace/protocol-runtime/services';
import { runtimeServiceControl } from './runtime-service-control.js';
import { RuntimeGitCheckpointSchema, RuntimeExecutionMachineInputSchema, RuntimeQaActionInputSchema, RuntimeSnapshotCommitInputSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { RuntimeAttachmentRequestInputSchema, RuntimeAttachmentReadyInputSchema, RuntimeAssignmentsInputSchema, RuntimeCacheAttachmentRequestInputSchema, RuntimeAttachmentDetachRequestInputSchema, RuntimeCacheActionInputSchema } from '@gitspace/protocol-runtime/attachment-controls';
import { RuntimeHeartbeatInputSchema, RuntimeDetachInputSchema } from '@gitspace/protocol-runtime/machine-controls';
import { RuntimeAttachmentController, executorCapabilities } from './runtime-attachments.js';
import { requireRuntimeIdentity } from './runtime-access.js';
import { z } from 'zod';
import { credentialProtocolBase64, normalizeRemoteRepositoryUrl } from '@gitspace/protocol';
import { deriveWorkspaceStatusSummary, parseWorkspaceCheckpoint, spaceCheckpointManifestKey, type GitLfsConfirmedObject, type WorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import { RetainedLfsSnapshotSchema } from './git-lfs-retention.js';
import { readEncryptedCheckpoint } from './git-lfs-store.js';
import { attachmentMachineKind } from './runtime-machine-loss.js';
import { isDispatchableCache } from './runtime-dispatch-selection.js';
import { LifecycleRunRequestSchema, LifecycleRunSchema, type EnvironmentFailure, type LifecycleRun } from '@gitspace/protocol-environment';
const PortableLfsRetentionSchema = RetainedLfsSnapshotSchema.extend({ publicationId: z.string().optional() });
const BaseBranchChangeSchema = z.object({
  projectId: z.string(), previousBranch: z.string(), branch: z.string(),
  previous: RuntimeGitCheckpointSchema, checkpoint: RuntimeGitCheckpointSchema,
  previousBranchTip: z.string().nullable(),
});
/** Lease sweeps also audit fleet membership this often, so no attachment outlives its machine's removal. */
const LEASE_AUDIT_MS = 60 * 60_000;
const LEASE_RETRY_MS = 5 * 60_000;

export class SpaceAuthorityDO extends DurableObject<Env> {
  private changes: DurableChangeLog;
  private directoryOutbox: DirectoryOutbox;
  private runtime: Promise<WorkspaceRuntime> | undefined;
  /** Loaded before any request; set once the space has cloud runtime state (see `hasCloudRuntime`). */
  private cloudRuntime: z.infer<typeof RuntimeIdentitySchema> | null = null;
  private cloudRuntimePublished = false;
  private alarmLine: Promise<void> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.changes = new DurableChangeLog(ctx.storage);
    this.directoryOutbox = this.openDirectoryOutbox();
    this.createTables();
    ctx.blockConcurrencyWhile(async () => {
      const state = this.get();
      const identity = await this.ctx.storage.get('runtime.identity') ?? (state ? { projectId: state.projectId, workspaceId: state.spaceId } : null);
      this.cloudRuntime = identity !== null && await this.hasCloudRuntime() ? RuntimeIdentitySchema.parse(identity) : null;
      this.cloudRuntimePublished = await this.ctx.storage.get('directory.runtimePublished') === true;
      this.ctx.waitUntil(this.flushPortableLfs());
      this.directoryOutbox.kick();
    });
  }

  private openDirectoryOutbox(): DirectoryOutbox {
    return new DirectoryOutbox(this.ctx, this.env, { set: timestamp => this.scheduleAlarm('directory', timestamp), clear: () => this.scheduleAlarm('directory', null) });
  }

  private createTables(): void {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_alarms(owner TEXT PRIMARY KEY, timestamp INTEGER NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_lost_claims_released(attachment_id TEXT PRIMARY KEY)');
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS space_authority (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      project_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      resume_machine_id TEXT,
      record_json TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS image_recovery_receipts(operation_id TEXT PRIMARY KEY,receipt_json TEXT NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS portable_lfs_outbox(snapshot_id TEXT PRIMARY KEY,inventory TEXT NOT NULL)');
  }

  directoryPublication(): Extract<DirectoryPublication, { source: 'space' }> | null {
    const state = this.get();
    return state || this.cloudRuntime ? { source: 'space', cursor: this.directoryOutbox.head(), state, runtime: this.cloudRuntime } : null;
  }

  /** The account directory learns once that this space is a cloud workspace; it then ignores the legacy placement. */
  private publishCloudRuntime(identity: z.infer<typeof RuntimeIdentitySchema>): void {
    this.cloudRuntime = identity;
    if (this.cloudRuntimePublished) return;
    this.cloudRuntimePublished = true;
    this.ctx.storage.transactionSync(() => this.directoryOutbox.enqueue({ source: 'space', state: this.get(), runtime: identity }));
    void this.ctx.storage.put('directory.runtimePublished', true);
    this.directoryOutbox.kick();
  }

  private scheduleAlarm(owner: string, timestamp: number | null): Promise<void> {
    if (timestamp === null) this.ctx.storage.sql.exec('DELETE FROM runtime_alarms WHERE owner=?', owner);
    else this.ctx.storage.sql.exec('INSERT INTO runtime_alarms(owner,timestamp) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET timestamp=excluded.timestamp', owner, timestamp);
    const operation = this.alarmLine.then(async () => {
      const next = this.ctx.storage.sql.exec<{ timestamp: number | null }>('SELECT MIN(timestamp) AS timestamp FROM runtime_alarms').toArray()[0]?.timestamp;
      if (next === null || next === undefined) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(next);
    });
    this.alarmLine = operation.catch(() => {});
    return operation;
  }

  async alarm(): Promise<void> {
    const leases = this.ctx.storage.sql.exec<{ timestamp: number }>("SELECT timestamp FROM runtime_alarms WHERE owner='leases'").toArray()[0];
    if (leases && leases.timestamp <= Date.now()) {
      await this.scheduleAlarm('leases', null);
      const identity = await this.ctx.storage.get('runtime.identity');
      // An unavailable runtime (a deleted workspace) is retried only at the audit cadence; a failed sweep sooner.
      const runtime = identity === undefined ? undefined : await this.getRuntime(identity).catch(async (error: unknown) => {
        console.error('Runtime lease sweep deferred: workspace runtime is unavailable', error);
        await this.scheduleAlarm('leases', Date.now() + LEASE_AUDIT_MS);
      });
      if (runtime) {
        try { await this.sweepLeases(runtime, 'alarm'); }
        catch (error) {
          console.error('Runtime lease sweep failed; retrying', error);
          await this.scheduleAlarm('leases', Date.now() + LEASE_RETRY_MS);
        }
      }
    }
    await this.directoryOutbox.flush();
    await this.flushPortableLfs();
    const wake = this.ctx.storage.sql.exec<{ timestamp: number }>("SELECT timestamp FROM runtime_alarms WHERE owner='runtime'").toArray()[0];
    if (wake && wake.timestamp <= Date.now()) {
      await this.scheduleAlarm('runtime', null);
      const identity = await this.ctx.storage.get<Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>>('runtime.identity');
      if (identity) await (await this.getRuntime(identity)).wake();
    }
  }

  /** Every live attachment is a lease: the alarm wakes at the earliest deadline, or at the next membership audit. */
  private async scheduleLeases(runtime: WorkspaceRuntime): Promise<void> {
    if (!runtime.attachments.list().some(item => item.state !== 'lost' && item.state !== 'detached')) return;
    const target = Math.min(runtime.attachments.nextDeadline() ?? Infinity, Date.now() + LEASE_AUDIT_MS);
    const scheduled = this.ctx.storage.sql.exec<{ timestamp: number }>("SELECT timestamp FROM runtime_alarms WHERE owner='leases'").toArray()[0]?.timestamp;
    if (scheduled === undefined || scheduled > target) await this.scheduleAlarm('leases', target);
  }

  /** Lose the attachments of machines that left the fleet and every attachment whose lease expired, then release what
   * their holders claimed. Machine kinds are refreshed first: they decide the lease windows. Logs one line per sweep. */
  private async sweepLeases(runtime: WorkspaceRuntime, trigger: 'alarm' | 'backfill'): Promise<void> {
    const fleet = this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID);
    const before = runtime.attachments.list().filter(item => item.state !== 'lost' && item.state !== 'detached');
    const missingMachines: string[] = [];
    const failures: string[] = [];
    for (const machineId of new Set(before.map(item => item.machineId))) {
      try {
        const machine = await fleet.getMachine(machineId);
        if (machine) runtime.attachments.recordMachineKind(machineId, attachmentMachineKind(machine));
        else {
          missingMachines.push(machineId);
          await this.loseMachineAttachments(runtime, machineId, await fleet.wasMachineDestroyed(machineId) ? 'machine-destroyed' : 'machine-revoked');
        }
      } catch (error) { failures.push(`${machineId}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    await runtime.expireAttachments(Date.now());
    await this.releaseLostClaims(runtime);
    await this.scheduleLeases(runtime);
    const after = new Map(runtime.attachments.list().map(item => [item.attachmentId, item]));
    console.info('Runtime lease sweep', {
      workspaceId: this.cloudRuntime?.workspaceId ?? null, trigger, examined: before.length, missingMachines,
      lost: before.filter(item => after.get(item.attachmentId)?.state === 'lost').length,
      deadlinesStarted: before.filter(item => item.deadlineAt === null && after.get(item.attachmentId)?.state !== 'lost' && (after.get(item.attachmentId)?.deadlineAt ?? null) !== null).length,
      nextDeadline: runtime.attachments.nextDeadline(), failures,
    });
    if (failures.length) throw new Error(`Runtime lease sweep failed for ${failures.join('; ')}`);
  }

  private async loseMachineAttachments(runtime: WorkspaceRuntime, machineId: string, reason: RuntimeAttachmentLossReason): Promise<void> {
    for (const attachment of runtime.attachments.list()) {
      if (attachment.machineId === machineId && attachment.state !== 'lost' && attachment.state !== 'detached') await runtime.loseAttachment(attachment.attachmentId, attachment.generation, reason);
    }
  }

  /** Lifecycle runs a lost attachment held end interrupted. Derived from durable lost state, so a crash only retries. */
  private async releaseLostClaims(runtime: WorkspaceRuntime): Promise<void> {
    const released = new Set(this.ctx.storage.sql.exec<{ attachment_id: string }>('SELECT attachment_id FROM runtime_lost_claims_released').toArray().map(row => row.attachment_id));
    for (const attachment of runtime.attachments.list()) {
      if (attachment.state !== 'lost' || released.has(attachment.attachmentId)) continue;
      await this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${attachment.projectId}`).releaseLostLifecycleClaims(attachment.workspaceId, { machineId: attachment.machineId, attachment: { attachmentId: attachment.attachmentId, generation: attachment.generation }, reason: attachment.lossReason ?? 'operator' });
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO runtime_lost_claims_released(attachment_id) VALUES(?)', attachment.attachmentId);
    }
  }

  /** Attachment records read without starting the runtime, so legacy spaces never gain runtime state. */
  private async storedAttachments(): Promise<RuntimeAttachment[]> {
    if (await this.ctx.storage.get('runtime.identity') === undefined) return [];
    if (!this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_attachments'").toArray().length) return [];
    return this.ctx.storage.sql.exec<{ record: string }>('SELECT record FROM runtime_attachments').toArray().map(row => RuntimeAttachmentSchema.parse(JSON.parse(row.record)));
  }

  /** Agent status of this cloud workspace from its last published runtime snapshot, without opening the runtime;
   * null when the workspace has no cloud runtime state yet. */
  async runtimeWorkspaceStatus(): Promise<WorkspaceStatusSummary | null> {
    if (await this.ctx.storage.get('runtime.identity') === undefined) return null;
    const snapshot = readRuntimeSnapshot(this.ctx.storage);
    return deriveWorkspaceStatusSummary({ agents: (snapshot?.conversations ?? []).map(item => ({ state: item.status === 'running' ? 'running' : item.status === 'waiting' ? 'permission-needed' : 'waiting', ...(item.status === 'failed' ? { failure: { code: 'RUNTIME_FAILED', message: item.error ?? 'Conversation failed' } } : {}) })) });
  }

  async runtimeMachineAttachments(machineId: string): Promise<RuntimeAttachment[]> {
    return (await this.storedAttachments()).filter(item => item.machineId === machineId);
  }

  /** Destroy and revoke fan-out: the machine's live attachments here become lost before its credentials go. */
  async runtimeLoseMachine(machineId: string, reason: 'machine-destroyed' | 'machine-revoked'): Promise<RuntimeAttachment[]> {
    if (!(await this.storedAttachments()).some(item => item.machineId === machineId && item.state !== 'lost' && item.state !== 'detached')) return [];
    const runtime = await this.getRuntime(await this.ctx.storage.get('runtime.identity'));
    await this.loseMachineAttachments(runtime, machineId, reason);
    await this.releaseLostClaims(runtime);
    return runtime.attachments.list().filter(item => item.machineId === machineId);
  }

  /** Backfill: sweep now, resolving attachments of machines removed before leases existed and starting the others' leases. */
  async runtimeSweepLeases(): Promise<void> {
    if (!(await this.storedAttachments()).some(item => item.state !== 'lost' && item.state !== 'detached')) {
      console.info('Runtime lease sweep', { workspaceId: this.get()?.spaceId ?? null, trigger: 'backfill', examined: 0, lost: 0, deadlinesStarted: 0, skipped: 'no live attachments' });
      return;
    }
    await this.sweepLeases(await this.getRuntime(await this.ctx.storage.get('runtime.identity')), 'backfill');
  }

  private async getRuntime(raw: unknown): Promise<WorkspaceRuntime> {
    const identity = RuntimeIdentitySchema.parse(raw);
    await requireRuntimeIdentity(this.env, this.env.ACCOUNT_ID, identity, false);
    if (await this.ctx.storage.get('runtime.baseBranchChange') !== undefined) throw new Error('Base branch change is awaiting recovery; retry project.setBaseBranch with the same branch');
    const authority = this.get();
    if (authority && (authority.projectId !== identity.projectId || authority.spaceId !== identity.workspaceId)) throw new Error('Runtime workspace identity mismatch');
    const stored = await this.ctx.storage.get('runtime.identity');
    if (stored === undefined && authority?.machineId) throw new Error('This legacy workspace must be migrated from its machine checkout before cloud lifecycle operations are available.');
    if (stored !== undefined) {
      const previous = RuntimeIdentitySchema.parse(stored);
      if (previous.projectId !== identity.projectId || previous.workspaceId !== identity.workspaceId) throw new Error('Runtime actor identity mismatch');
    } else await this.ctx.storage.put('runtime.identity', identity);
    this.publishCloudRuntime(identity);
    if (!this.runtime) {
      const runtime = createAccountWorkspaceRuntime(this.ctx, this.env, identity, timestamp => this.scheduleAlarm('runtime', timestamp));
      this.runtime = runtime;
      runtime.catch(() => { this.runtime = undefined; });
      // Rows written before leases, or of machines whose kind was never recorded, are settled by this workspace's own
      // sweep as soon as its runtime opens; no account-wide trigger is needed.
      this.ctx.waitUntil(runtime.then(async opened => {
        if (opened.attachments.leaseBackfillNeeded()) await this.scheduleAlarm('leases', Date.now());
      }, () => {}));
    }
    return this.runtime;
  }

  async runtimeSnapshot(raw: unknown): Promise<Response> { return Response.json(await (await this.getRuntime(raw)).snapshot()); }
  async runtimeAttachments(raw: unknown) { return (await this.getRuntime(raw)).attachments.list(); }
  async runtimeCodeCheckpoint(raw: unknown) {
    const identity = RuntimeIdentitySchema.parse(raw);
    if (await this.ctx.storage.get('runtime.baseBranchChange') !== undefined) throw new Error('Base branch change is awaiting recovery; retry project.setBaseBranch with the same branch');
    const authority = this.get();
    if (authority && (authority.projectId !== identity.projectId || authority.spaceId !== identity.workspaceId)) throw new Error('Checkpoint workspace identity mismatch');
    const stored = await this.ctx.storage.get('runtime.identity');
    if (stored !== undefined) {
      const previous = RuntimeIdentitySchema.parse(stored);
      if (previous.projectId !== identity.projectId || previous.workspaceId !== identity.workspaceId) throw new Error('Checkpoint runtime identity mismatch');
    }
    return readCurrentCheckpoint(this.ctx.storage);
  }

  /** The base checkout, its Git refs and metadata change as a recoverable, fenced operation.
   * Dirty state, agents and live caches are rejected before the durable intent or ref writes. */
  async runtimeSetBaseBranch(raw: unknown, expectedRevision: number, branch: string) {
    const result = await this.ctx.blockConcurrencyWhile(() => Result.tryPromise({ try: async () => {
      const identity = RuntimeIdentitySchema.parse(raw);
      if (!isSupportedBranchName(branch)) throw new Error('Invalid base branch');
      const authority = this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${identity.projectId}`);
      const project = await authority.getProject();
      if (!project) throw new Error('Project is unavailable');
      if (identity.workspaceId !== project.id) throw new Error('Base branch changes require the project base workspace');
      if (project.role === 'gitspace-source') throw new Error('The built-in GitSpace project base branch is managed by GitSpace releases');
      const saved = await this.ctx.storage.get('runtime.baseBranchChange');
      let change = saved === undefined ? undefined : BaseBranchChangeSchema.parse(saved);
      if (change && (change.projectId !== project.id || change.branch !== branch)) throw new Error(`Retry the pending base branch change to ${change.branch} first`);
      if (!change && project.revision !== expectedRevision) throw new Error(`Project revision conflict: expected ${expectedRevision}, actual ${project.revision}`);
      if (!change && project.baseBranch === branch) return this.env.USER_PROJECTS.getByName(this.env.ACCOUNT_ID).put(project);
      if (project.lifecycle !== 'active') throw new Error('Project must be active to change its base branch');
      const runtime = change
        ? await (this.runtime ??= createAccountWorkspaceRuntime(this.ctx, this.env, identity, timestamp => this.scheduleAlarm('runtime', timestamp)).catch(error => { this.runtime = undefined; throw error; }))
        : await this.getRuntime(identity);
      const snapshot = await runtime.snapshot();
      if (snapshot.conversations.some(conversation => conversation.status === 'running' || conversation.status === 'waiting')) throw new Error('Stop the base workspace agent before changing its branch');
      if (runtime.attachments.list().some(attachment => attachment.state !== 'lost' && attachment.state !== 'detached')) throw new Error('Detach base workspace caches before changing its branch');
      const code = new ArtifactsCodeStore(this.env.ARTIFACTS);
      const repository = artifactsWorkspaceRepository(identity.workspaceId);
      const source = artifactsProjectRepository(project.id);
      await ensureProjectCodeRepository(code, project);
      const commit = change?.checkpoint.headCommit ?? await code.resolveRef(source, `refs/heads/${branch}`)
        ?? (project.repositoryReference ? await code.importSourceRef(project.id, normalizeRemoteRepositoryUrl(project.repositoryReference.replace(/^git@github\.com:/u, 'https://github.com/')), `refs/heads/${branch}`) : null);
      if (!commit) throw new Error(`Branch ${branch} does not exist in the project repository`);
      const metadata = await code.readCommit(source, commit);
      if (!metadata) throw new Error('Base branch commit is unavailable');
      const checkpoint = change?.checkpoint ?? RuntimeGitCheckpointSchema.parse({
        checkpointRef: `refs/gitspace/spaces/${identity.workspaceId}/checkpoints`, branch, headCommit: commit,
        indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: metadata.treeHash, worktreeTree: metadata.treeHash,
      });
      const result = await runtime.cloudFiles.changeBranch({
        checkpoint,
        validate: async current => {
          if (change) {
            if (current.worktreeCommit !== change.previous.worktreeCommit && current.worktreeCommit !== checkpoint.worktreeCommit) throw new Error('Base checkout changed during branch recovery');
            return;
          }
          const head = current.headCommit ? await code.readCommit(repository, current.headCommit) : null;
          if (!head || current.indexTree !== head.treeHash || current.worktreeTree !== head.treeHash || current.conflicts?.length || current.lfs?.heldBack.length) throw new Error('Base workspace has uncommitted changes; commit or discard them before changing its branch');
        },
        prepare: async current => {
          if (change) return;
          change = BaseBranchChangeSchema.parse({ projectId: project.id, previousBranch: project.baseBranch, branch, previous: current, checkpoint, previousBranchTip: await code.resolveRef(repository, `refs/heads/${branch}`) });
          await this.ctx.storage.put('runtime.baseBranchChange', change);
        },
        publish: async () => {
          if (!change) throw new Error('Base branch intent is missing');
          await code.copyCommit(source, repository, `refs/heads/${branch}`, commit, change.previousBranchTip);
          await code.copyCommit(source, repository, checkpoint.checkpointRef, commit, change.previous.worktreeCommit);
        },
        commit: async () => {
          if (!change) throw new Error('Base branch intent is missing');
          const latest = await authority.getProject();
          if (!latest || (latest.baseBranch !== change.previousBranch && latest.baseBranch !== branch)) throw new Error('Project base branch changed during checkout publication');
          const updated = latest.baseBranch === branch ? latest : await authority.setBaseBranch(latest.revision, branch, commit);
          return this.env.USER_PROJECTS.getByName(this.env.ACCOUNT_ID).put(updated);
        },
      });
      await this.ctx.storage.delete('runtime.baseBranchChange');
      return result;
    }, catch: error => error instanceof Error ? error : new Error(String(error)) }));
    // Expected rejections must not break the Durable Object's input gate.
    if (result.isErr()) throw result.error;
    return result.value;
  }
  /** The committed checkout the Inspector reads. A cloud workspace whose runtime has not yet
   * touched files gets its source initialized here, as file execution would. */
  async runtimeRepositoryCheckpoint(raw: unknown) {
    const committed = await this.runtimeCodeCheckpoint(raw);
    if (committed) return committed;
    const checkpoint = await (await this.getRuntime(raw)).cloudFiles.initializeSnapshot();
    if (!checkpoint) throw new Error('This workspace has no committed source in the cloud yet.');
    return checkpoint;
  }
  /** A cloud workspace's checkout lives in this DO's runtime; machines only attach as caches.
   * Spaces without cloud runtime state are legacy machine-held placements. */
  async hasCloudRuntime(): Promise<boolean> {
    return await this.ctx.storage.get('runtime.identity') !== undefined || await readCurrentCheckpoint(this.ctx.storage) !== null;
  }
  /** A workspace leaving active use: its working conversations stop and every live attachment is asked to drain and detach.
   * Draining is recorded here; a machine finishes it when it next reports, or its lease expires. Never opens a runtime that has no state. */
  async runtimeStop(raw: unknown): Promise<void> {
    const identity = RuntimeIdentitySchema.parse(raw);
    if (await this.ctx.storage.get('runtime.identity') === undefined) return;
    const runtime = await this.getRuntime(identity);
    for (const conversation of (await runtime.snapshot()).conversations) {
      if (conversation.status === 'running' || conversation.status === 'waiting') await runtime.cancel({ ...identity, conversationId: conversation.id });
    }
    for (const attachment of runtime.attachments.list()) {
      if (attachment.state !== 'lost' && attachment.state !== 'detached') runtime.attachments.detach({ ...attachment, state: 'draining' });
    }
    runtime.publish();
    await this.scheduleLeases(runtime);
  }
  /** Permanent deletion of this workspace's runtime, attachments and placement. The caller has already fenced the
   * workspace out of runtime access, so nothing reopens what this removes. */
  async runtimeErase(raw: unknown): Promise<void> {
    const identity = RuntimeIdentitySchema.parse(raw);
    const stored = await this.ctx.storage.get('runtime.identity');
    if (stored !== undefined) {
      const previous = RuntimeIdentitySchema.parse(stored);
      if (previous.projectId !== identity.projectId || previous.workspaceId !== identity.workspaceId) throw new Error('Runtime actor identity mismatch');
    }
    // A runtime that never opened has no conversation to stop.
    const loaded = await this.runtime?.catch(() => undefined);
    this.runtime = undefined;
    if (loaded) {
      for (const conversation of (await loaded.snapshot()).conversations) {
        if (conversation.status === 'running' || conversation.status === 'waiting') await loaded.cancel({ ...identity, conversationId: conversation.id });
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.changes = new DurableChangeLog(this.ctx.storage);
    this.directoryOutbox = this.openDirectoryOutbox();
    this.createTables();
    this.cloudRuntime = null;
    this.cloudRuntimePublished = false;
  }
  /** A human bundle edit lands in the cloud working copy exactly as an agent `write` does: one checkpoint
   * through the same publication queue, from which every environment read re-derives the definition. */
  async runtimeWriteEnvironmentBundle(raw: unknown, content: string): Promise<void> {
    const identity = RuntimeIdentitySchema.parse(raw);
    await requireRuntimeIdentity(this.env, this.env.ACCOUNT_ID, identity, true);
    const runtime = await this.getRuntime(identity);
    const attemptId = `environment-bundle:${crypto.randomUUID()}`;
    try {
      const result = await runtime.cloudFiles.execute({ tool: 'write', args: { path: '.gitspace/bundle.json', content, message: 'Update environment bundle' }, requestId: attemptId, attemptId });
      if (result.status === 'failed') throw new Error(result.error.message);
      if (result.status !== 'completed') throw new Error('Environment bundle write was interrupted');
    } catch (error) {
      // The publication is durably pending: the runtime alarm finishes it, as it does for an agent write.
      if (CloudPublicationUncertain.is(error)) await this.scheduleAlarm('runtime', Date.now() + 1_000);
      throw error;
    }
  }
  /** A cloud workspace's terminals run only on a cache attachment that is ready and heartbeating. */
  async runtimeTerminalMachine(machineId: string): Promise<boolean> {
    const identity = await this.ctx.storage.get('runtime.identity');
    if (identity === undefined) return false;
    const now = Date.now();
    return (await this.getRuntime(identity)).attachments.list().some(item => item.machineId === machineId && item.role === 'cache' && item.state === 'ready'
      && item.heartbeatAt !== null && now - Date.parse(item.heartbeatAt) <= 30_000);
  }
  /** A human environment run, accepted here and dispatched to the cache machine the caller named exactly as an agent's
   * lifecycle run is. A machine that is not a ready or resumable cache of this workspace is refused before dispatch;
   * the lifecycle ledger's run id, not this request, makes a retry return the run already accepted. */
  async runtimeEnvironmentRun(raw: unknown): Promise<{ status: 'ok'; run: LifecycleRun } | { status: 'error'; failure: EnvironmentFailure }> {
    const input = RuntimeIdentitySchema.extend({ machineId: z.string().min(1), request: LifecycleRunRequestSchema }).parse(raw);
    const context = { spaceId: input.workspaceId, machineId: input.machineId, runId: input.request.runId };
    const detached: EnvironmentFailure = { code: 'RunnerUnavailable', message: `Machine ${input.machineId} is not a ready cache of this workspace; attach it to run environment phases there`, context };
    if (await this.ctx.storage.get('runtime.identity') === undefined) return { status: 'error', failure: detached };
    const runtime = await this.getRuntime(input);
    const now = Date.now();
    if (!runtime.attachments.list().some(item => item.machineId === input.machineId && isDispatchableCache(item, now))) return { status: 'error', failure: detached };
    // Absent optional fields cross Worker RPC as undefined, which is not JSON.
    const args = RuntimeJsonSchema.parse(Object.fromEntries(Object.entries({ ...input.request, on: input.machineId }).filter(([, value]) => value !== undefined)));
    const result = await runtime.manage({ tool: 'lifecycle', requestId: `environment:${input.request.runId}:${crypto.randomUUID()}`, args });
    const text = result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n');
    if (result.status === 'completed') return { status: 'ok', run: LifecycleRunSchema.parse(JSON.parse(text)) };
    return { status: 'error', failure: result.status === 'failed'
      ? { code: 'ExecutionFailed', message: result.error.message, context }
      : { code: 'Interrupted', message: text || 'The environment run was interrupted before its machine accepted it', context } };
  }
  async runtimeDraft(raw: unknown, actor: { deviceId: string }) { const input = RuntimeDraftSaveInputSchema.parse(raw); return (await this.getRuntime(input)).saveDraft(input, actor.deviceId); }
  async runtimeSubmit(raw: unknown, actor?: { deviceId: string }) { const input = RuntimeSubmitInputSchema.parse(raw); return (await this.getRuntime(input)).submit(input, actor?.deviceId); }
  async runtimeCancel(raw: unknown) { const input = RuntimeCancelInputSchema.parse(raw); return (await this.getRuntime(input)).cancel(input); }
  async runtimeAnswer(raw: unknown, actor: { deviceId: string; canApprove: boolean }) { const input = RuntimeAnswerInputSchema.parse(raw); return (await this.getRuntime(input)).answer(input, actor); }
  async runtimeWatch(raw: unknown): Promise<Response> { const input = RuntimeWatchInputSchema.parse(raw); return (await this.getRuntime(input)).watch(input); }

  async runtimeSession(raw: unknown, actor: { canApprove: boolean; deviceId?: string }): Promise<Response> {
    const input = RuntimeSessionInputSchema.parse(raw);
    return Response.json(await (await this.getRuntime(input)).session(input.conversationId, input.command, actor.canApprove, actor.deviceId));
  }
  async runtimeServices(raw: unknown) {
    const input = RuntimeServiceInputSchema.parse(raw);
    return runtimeServiceControl(await this.getRuntime(input), input);
  }
  async runtimeBrowserAuthority(raw: unknown) {
    const input = RuntimeIdentitySchema.extend({ machineId: z.string(), attachmentId: z.string(), generation: z.number().int().nonnegative() }).parse(raw);
    const runtime = await this.getRuntime(input);
    if (!runtime.attachments.list().some(item => item.machineId === input.machineId && item.attachmentId === input.attachmentId && item.generation === input.generation && ['attaching', 'ready', 'draining'].includes(item.state))) throw new Error('Browser authority requires active owned assignment');
    const { algorithm, publicKey } = await this.env.ACCOUNT_STATE.getByName(this.env.ACCOUNT_ID).browserTrust();
    return { algorithm, publicKey };
  }

  async runtimeExecutionMachine(raw: unknown) {
    const input = RuntimeExecutionMachineInputSchema.parse(raw);
    const runtime = await this.getRuntime(input);
    await runtime.setExecutionMachine(input.machineId);
    return { accepted: true as const, cursor: (await runtime.snapshot()).cursor };
  }

  async runtimeQa(raw: unknown, actor: { deviceId: string; canApprove: boolean }) {
    const input = RuntimeQaActionInputSchema.parse(raw);
    return (await this.getRuntime(input)).qa(input, actor);
  }

  async runtimeSnapshotCommit(raw: unknown) {
    const input = RuntimeSnapshotCommitInputSchema.parse(raw);
    const runtime = await this.getRuntime(input);
    const code = new ArtifactsCodeStore(this.env.ARTIFACTS);
    const repository = artifactsWorkspaceRepository(input.workspaceId);
    const commits = new Set([input.checkpoint.indexCommit, input.checkpoint.trackedWorktreeCommit, input.checkpoint.worktreeCommit]);
    if (input.checkpoint.headCommit !== null) commits.add(input.checkpoint.headCommit);
    await Promise.all([...commits].map(async commit => {
      if (!await code.readCommit(repository, commit)) throw new Error('Checkpoint commit was not published');
    }));
    return runtime.snapshotCommit(input);
  }

  private async attachmentController(raw: unknown) {
    const runtime = await this.getRuntime(raw);
    await runtime.cloudFiles.recover();
    return new RuntimeAttachmentController({
      attachments: runtime.attachments, code: new ArtifactsCodeStore(this.env.ARTIFACTS), publish: () => runtime.publish(),
      snapshot: () => runtime.cloudFiles.initializeSnapshot(),
      origin: async projectId => (await this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).getProject())?.repositoryReference ?? null,
      lifecycle: (projectId, workspaceId) => this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).getLifecycleState(workspaceId),
      authorizeMachine: async machineId => {
        const machine = await this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID).getMachine(machineId);
        if (!machine || machine.desiredState === 'removed' || !await this.env.CREDENTIALS.getByName(this.env.ACCOUNT_ID).hasRuntimeMachine(machineId)) throw new Error('Attachment target is not an enrolled account machine');
        runtime.attachments.recordMachineKind(machineId, attachmentMachineKind(machine));
      },
    });
  }

  async runtimeAttachmentRequest(raw: unknown) {
    const input = RuntimeAttachmentRequestInputSchema.parse(raw);
    const result = await (await this.attachmentController(input)).request(input);
    await this.scheduleLeases(await this.getRuntime(input));
    return result;
  }

  async runtimeCacheAttachmentRequest(raw: unknown) {
    const input = RuntimeCacheAttachmentRequestInputSchema.parse(raw);
    const { project, workspace } = await requireRuntimeIdentity(this.env, this.env.ACCOUNT_ID, input, true);
    const machine = await this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID).getMachine(input.machineId);
    if (!machine || machine.desiredState === 'removed' || !await this.env.CREDENTIALS.getByName(this.env.ACCOUNT_ID).hasRuntimeMachine(input.machineId)) throw new Error('Attachment target is not an enrolled account machine');
    const runtime = await this.getRuntime(input);
    runtime.attachments.recordMachineKind(input.machineId, attachmentMachineKind(machine));
    await runtime.cloudFiles.recover();
    await runtime.cloudFiles.initializeSnapshot();
    const result = await runtime.attachments.requestCache({ ...input, checkout: { kind: 'shared', branch: workspace?.branch ?? project.baseBranch }, capabilities: executorCapabilities });
    runtime.publish();
    await this.scheduleLeases(runtime);
    return result;
  }

  async runtimeCacheAction(raw: unknown) {
    const input = RuntimeCacheActionInputSchema.parse(raw);
    const runtime = await this.getRuntime(input);
    const result = await runtime.attachments.requestCacheAction(input);
    runtime.publish();
    await this.scheduleLeases(runtime);
    return result;
  }

  async runtimeAttachmentDetachRequest(raw: unknown) {
    const input = RuntimeAttachmentDetachRequestInputSchema.parse(raw);
    const runtime = await this.getRuntime(input);
    const attachment = runtime.attachments.list().find(candidate => candidate.attachmentId === input.attachmentId);
    if (attachment?.state === 'detached') return { attachment: runtime.attachments.detach({ ...input, state: 'detached' }) };
    return this.runtimeDetach({ ...input, state: 'draining' });
  }

  async runtimeAssignments(raw: unknown) {
    const identity = RuntimeIdentitySchema.parse(raw);
    const input = RuntimeAssignmentsInputSchema.parse(raw);
    if (await this.ctx.storage.get('runtime.identity') === undefined) return { assignments: [] };
    if (input.afterSnapshot !== undefined) {
      const runtime = await this.getRuntime(identity);
      if (!runtime.attachments.list().some(item => item.machineId === input.machineId && (item.role === 'cache') && ['attaching', 'ready', 'draining'].includes(item.state))) throw new Error('Snapshot wait requires an active cache');
      await runtime.waitForSnapshot(input.afterSnapshot);
    }
    const result = await (await this.attachmentController(identity)).assignments(input);
    if (!result.assignments.length) return { assignments: [] };
    // One account-wide policy governs every workspace cache; machines receive it with each assignment.
    const { machines } = await this.env.USER_SETTINGS.getByName(this.env.ACCOUNT_ID).get('runtime-assignments');
    const cachePolicy = RuntimeCachePolicySchema.parse({ reclaimSeconds: machines.cacheReclaimSeconds });
    return { assignments: result.assignments.map(assignment => ({ ...assignment, cachePolicy })) };
  }

  async runtimeAttachmentReady(raw: unknown) {
    const input = RuntimeAttachmentReadyInputSchema.parse(raw);
    const result = await (await this.attachmentController(input)).ready(input);
    const runtime = await this.getRuntime(input);
    await runtime.cacheReady(input.attachmentId, input.generation);
    await this.scheduleLeases(runtime);
    return result;
  }

  async runtimeHeartbeat(raw: unknown) {
    const input = RuntimeHeartbeatInputSchema.parse(raw);
    const runtime = await this.getRuntime(input);
    // Leases of a machine whose kind was never recorded (attached before leases existed) start under its real windows.
    const machine = input.browserCapabilities || runtime.attachments.machineKind(input.machineId) === null ? await this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID).getMachine(input.machineId) : undefined;
    if (machine) runtime.attachments.recordMachineKind(input.machineId, attachmentMachineKind(machine));
    if (input.browserCapabilities && (machine?.kind !== 'physical' || machine.desiredState === 'removed')) input.browserCapabilities = [];
    if (input.cache?.state === 'reclaimed' && runtime.cloudFiles.hasPendingMachine(input.machineId)) throw new Error('Pending snapshot publication prevents cache reclamation');
    const attachment = runtime.attachments.heartbeat(input);
    runtime.publish();
    await this.scheduleLeases(runtime);
    return { attachment };
  }

  async runtimeDetach(raw: unknown) {
    const input = RuntimeDetachInputSchema.parse(raw);
    const runtime = await this.getRuntime(input);
    if (input.state === 'detached' && runtime.cloudFiles.hasPendingMachine(input.machineId)) throw new Error('Pending snapshot publication prevents cache detach');
    if (input.state === 'detached') await runtime.attachments.reconcileDetach(input);
    const held = runtime.attachments.list().find(item => item.attachmentId === input.attachmentId && item.generation === input.generation && item.machineId === input.machineId && item.projectId === input.projectId && item.workspaceId === input.workspaceId);
    if (input.state === 'lost' && !held) throw new Error('Attachment detach has stale authority');
    const attachment = input.state === 'lost' ? await runtime.loseAttachment(input.attachmentId, input.generation, 'operator') : runtime.attachments.detach(input);
    runtime.publish();
    if (attachment.state === 'lost') await this.releaseLostClaims(runtime);
    await this.scheduleLeases(runtime);
    this.ctx.waitUntil(this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${input.projectId}`).lfsCollect());
    return { attachment };
  }


  async runtimeCronSubmit(raw: unknown) {
    const input = RuntimeIdentitySchema.extend({ requestId: z.string().min(1), text: z.string().min(1), readScopes: z.array(z.string()), writeScopes: z.array(z.string()) }).parse(raw);
    await requireRuntimeIdentity(this.env, this.env.ACCOUNT_ID, input, true);
    return (await this.getRuntime(input)).cronSubmit(input);
  }

  async runtimeRequestStatus(raw: unknown) {
    const input = RuntimeIdentitySchema.extend({ requestId: z.string().min(1) }).parse(raw);
    return (await this.getRuntime(input)).requestStatus(input.requestId);
  }

  async runtimeCronWithdraw(raw: unknown) {
    const input = RuntimeIdentitySchema.extend({ requestId: z.string().min(1) }).parse(raw);
    return (await this.getRuntime(input)).cronWithdraw(input.requestId);
  }

  async runtimeCronCancel(raw: unknown) {
    const input = RuntimeIdentitySchema.extend({ requestId: z.string().min(1), confirmStopWorkspaceAgent: z.boolean() }).parse(raw);
    return (await this.getRuntime(input)).cronCancel(input.requestId, input.confirmStopWorkspaceAgent);
  }

  async runtimeCronNotifyOverdue(raw: unknown) {
    const input = RuntimeIdentitySchema.extend({ requestId: z.string().min(1) }).parse(raw);
    return (await this.getRuntime(input)).cronNotifyOverdue(input.requestId);
  }

  async runtimeTranscript(raw: unknown): Promise<Response> {
    const input = RuntimeIdentitySchema.extend({ conversationId: z.string().optional() }).parse(raw);
    return Response.json(await (await this.getRuntime(input)).transcript(input.conversationId));
  }


  async runtimeDiscoverMcp(raw: unknown) {
    const input = RuntimeIdentitySchema.extend({ requestId: z.string().min(1), args: z.object({ connectionId: z.string().min(1) }) }).parse(raw);
    await requireRuntimeIdentity(this.env, this.env.ACCOUNT_ID, input, true);
    return (await this.getRuntime(input)).manage({ tool: 'mcp_discover', requestId: input.requestId, args: input.args });
  }

  watch(spaceId: string, after: number | null): DurableStreamSubscription {
    const state = this.get();
    if (state && state.spaceId !== spaceId) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_IDENTITY_MISMATCH', message: 'Space authority identity mismatch', context: { spaceId } });
    return this.changes.watch(`space:${spaceId}`, after, () => this.get());
  }

  private commit<T>(mutate: () => T): SpaceAuthorityResult<T> {
    try {
      const value = this.ctx.storage.transactionSync(() => {
        const value = mutate();
        const state = this.get();
        if (state) {
          this.changes.append(`space:${state.spaceId}`, state);
          this.directoryOutbox.enqueue({ source: 'space', state, runtime: this.cloudRuntime });
        }
        return value;
      });
      this.directoryOutbox.kick();
      this.changes.wake();
      return { status: 'ok', value };
    } catch (error) {
      if (error instanceof WorkspaceDomainError) return { status: 'error', failure: error.toJSON() };
      throw error;
    }
  }

  bootstrap(input: VerifiedSpaceAuthorityIdentity): SpaceAuthorityResult<SpaceAuthorityRecord> {
    return this.commit(() => {
      const state = bootstrapSpaceAuthority(this.get(), input, new Date().toISOString());
      this.save(state);
      return state;
    });
  }

  /** First publication of a GitSpace source base: from a released retry, or (`orphanedHolderId`) from a
   *  removed machine that opened it and published nothing. The caller proves that machine is gone. */
  bootstrapUnpublishedSource(input: VerifiedSpaceAuthorityIdentity, orphanedHolderId?: string): SpaceAuthorityResult<SpaceAuthorityRecord> {
    return this.commit(() => {
      const current = this.get();
      const holder = current?.state === 'closed' ? null : current?.state === 'open' && orphanedHolderId !== undefined ? orphanedHolderId : undefined;
      if (!current || current.projectId !== input.projectId || current.spaceId !== input.spaceId
        || holder === undefined || current.machineId !== holder || current.publishedRevision !== 0
        || current.manifestKey !== null || current.manifestHash !== null) {
        throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_POSSESSION_DENIED', message: 'Source placement changed before retrying its first publication', context: { spaceId: input.spaceId, machineId: input.machineId } });
      }
      const opened: SpaceAuthorityRecord = { ...current, state: 'open', machineId: input.machineId,
        generation: current.generation + 1, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      this.save(opened);
      return opened;
    });
  }

  beginClose(input: SpaceAuthorityMutation): SpaceAuthorityResult<{ revision: number; previousRevision: number | null }> {
    return this.commit(() => {
      const next = beginSpaceClose(this.get(), input, new Date().toISOString());
      this.save(next.state);
      return { revision: next.revision, previousRevision: next.previousRevision };
    });
  }

  async commitClosed(input: SpaceAuthorityMutation & { revision: number; manifestKey: string; manifestHash: string; resumeOnMachineRestart?: boolean }): Promise<SpaceAuthorityResult<void>> {
    // Validate the ownership fence before reading or retaining publisher-controlled inventory.
    try { commitSpaceClosed(this.get(), input, new Date().toISOString()); }
    catch (error) {
      if (error instanceof WorkspaceDomainError) return { status: 'error', failure: error.toJSON() };
      throw error;
    }
    const expectedKey = spaceCheckpointManifestKey(input.projectId, input.spaceId, input.revision);
    if (input.manifestKey !== expectedKey) throw new Error('Portable checkpoint manifest scope mismatch');
    const key = credentialProtocolBase64.decode(await this.env.CREDENTIALS.getByName(this.env.ACCOUNT_ID).artifactKey(this.env.ACCOUNT_ID));
    const bytes = await readEncryptedCheckpoint(this.env.DATA, `users/${this.env.ACCOUNT_ID}/${expectedKey}`, key, input.manifestHash);
    if (!bytes) throw new Error('Portable checkpoint manifest is missing');
    const manifest = parseWorkspaceCheckpoint(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), { projectId: input.projectId, spaceId: input.spaceId, revision: input.revision });
    const retained = { snapshotId: `portable:${input.spaceId}:${input.revision}`, workspaceId: input.spaceId, kind: 'portable' as const, objects: manifest.repository.lfs?.objects ?? [], publicationId: `${input.machineId}:portable:${input.spaceId}:${input.revision}` };
    const accepted = this.commit(() => {
      this.save(commitSpaceClosed(this.get(), input, new Date().toISOString()));
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO portable_lfs_outbox VALUES(?,?)', retained.snapshotId, JSON.stringify(retained));
    });
    if (accepted.status === 'ok') { await this.ctx.storage.sync(); await this.flushPortableLfs(); }
    return accepted;
  }

  private async flushPortableLfs(): Promise<void> {
    const state = this.get();
    if (!state) return;
    for (const row of this.ctx.storage.sql.exec<{ snapshot_id: string; inventory: string }>('SELECT snapshot_id,inventory FROM portable_lfs_outbox').toArray()) {
      try {
        const retained = PortableLfsRetentionSchema.parse(JSON.parse(row.inventory));
        const project = this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${state.projectId}`);
        await project.lfsRetain(retained);
        if (retained.publicationId) await project.lfsReleasePublication(retained.publicationId);
        this.ctx.storage.sql.exec('DELETE FROM portable_lfs_outbox WHERE snapshot_id=? AND inventory=?', row.snapshot_id, row.inventory);
        await this.ctx.storage.sync();
      } catch (error) { await this.scheduleAlarm('lfs', Date.now() + 1_000); throw error; }
    }
    await this.scheduleAlarm('lfs', null);
  }

  async lfsRoots() {
    await readCurrentCheckpoint(this.ctx.storage);
    const attachmentTable = this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_attachments'").toArray().length > 0;
    const active = attachmentTable && this.ctx.storage.sql.exec<{ record: string }>('SELECT record FROM runtime_attachments').toArray().some(row => ['attaching', 'ready', 'draining'].includes(RuntimeAttachmentSchema.parse(JSON.parse(row.record)).state));
    const state = this.get();
    return {
      checkpoints: readRuntimeLfsRoots(this.ctx.storage),
      pendingRuntime: ['runtime_cloud_files', 'runtime_lfs_retention_outbox'].some(table => {
        if (!this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table).toArray().length) return false;
        return this.ctx.storage.sql.exec(table === 'runtime_cloud_files' ? 'SELECT 1 FROM runtime_cloud_files WHERE pending IS NOT NULL LIMIT 1' : 'SELECT 1 FROM runtime_lfs_retention_outbox LIMIT 1').toArray().length > 0;
      }),
      active,
      portableRevision: state?.publishedRevision ?? null,
      pending: this.ctx.storage.sql.exec<{ snapshot_id: string }>('SELECT snapshot_id FROM portable_lfs_outbox').toArray().map(row => row.snapshot_id),
    };
  }

  async reconcileLfsSources(objects: readonly GitLfsConfirmedObject[]): Promise<void> {
    await readCurrentCheckpoint(this.ctx.storage);
    await reconcileRuntimeLfsSources(this.ctx.storage, objects);
  }

  abortClose(input: SpaceAuthorityMutation & { revision: number; message: string }): SpaceAuthorityResult<void> {
    return this.commit(() => this.save(abortSpaceClose(this.get(), input, new Date().toISOString())));
  }

  beginOpen(input: SpaceAuthorityMutation & { resumeOnMachineRestart?: boolean }): SpaceAuthorityResult<{ revision: number; manifestKey: string; manifestHash: `sha256:${string}` }> {
    return this.commit(() => {
      const next = beginSpaceOpen(this.get(), input, new Date().toISOString());
      this.save(next.state);
      return { revision: next.revision, manifestKey: next.manifestKey, manifestHash: next.manifestHash };
    });
  }

  commitOpen(input: SpaceAuthorityMutation & { revision: number }): SpaceAuthorityResult<void> {
    return this.commit(() => this.save(commitSpaceOpen(this.get(), input, new Date().toISOString())));
  }

  failOpen(input: SpaceAuthorityMutation & { revision: number; message: string }): SpaceAuthorityResult<void> {
    return this.commit(() => this.save(failSpaceOpen(this.get(), input, new Date().toISOString())));
  }

  releaseUnpublishedSource(input: SpaceAuthorityMutation): SpaceAuthorityResult<void> {
    return this.commit(() => {
      const current = this.get();
      if (!current || current.projectId !== input.projectId || current.spaceId !== input.spaceId
        || current.state !== 'open' || current.machineId !== input.machineId || current.generation !== input.expectedGeneration
        || current.publishedRevision !== 0 || current.manifestKey !== null || current.manifestHash !== null) {
        throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_POSSESSION_DENIED', message: 'Unpublished source placement changed; local checkout must be retained', context: { spaceId: input.spaceId, machineId: input.machineId, generation: input.expectedGeneration } });
      }
      this.save({ ...current, state: 'closed', machineId: null, resumeMachineId: null,
        generation: current.generation + 1, revision: current.revision + 1, updatedAt: new Date().toISOString() });
    });
  }

  /** Account-only call after provider acknowledgement that the VM has stopped.
   * Deliberately absent from signed machine control; canonical content is retained. */
  discardStoppedLocalWork(input: { userId: string; machineId: string; projectId: string; spaceId: string; expectedGeneration: number }): SpaceAuthorityResult<void> {
    if (input.userId !== this.env.ACCOUNT_ID) throw new Error('Machine discard belongs to another account');
    return this.commit(() => {
      const current = this.get();
      if (!current || current.projectId !== input.projectId || current.spaceId !== input.spaceId
        || current.machineId !== input.machineId || current.generation !== input.expectedGeneration) {
        throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_POSSESSION_DENIED', message: 'Machine discard ownership changed; refusing to fence another generation', context: { spaceId: input.spaceId, machineId: input.machineId, generation: input.expectedGeneration } });
      }
      this.save({ ...current, state: 'closed', machineId: null,
        resumeMachineId: current.publishedRevision > 0 ? input.machineId : null,
        generation: current.generation + 1, revision: current.revision + 1, updatedAt: new Date().toISOString(),
        failures: { open: null, close: null } });
    });
  }

  /** Account-only recovery after a provider-verified stop and explicit discard approval.
   * No signed machine-control operation exposes this capability. */
  recoverStoppedImage(input: { userId: string; expectedGeneration: number; receipt: CloudImageDiscardReceipt }): SpaceAuthorityResult<SpaceAuthorityRecord> {
    if (input.userId !== this.env.ACCOUNT_ID) throw new Error('Image recovery belongs to another account');
    const receipt = cloudImageDiscardReceiptSchema.parse(input.receipt);
    return this.commit(() => {
      const current = this.get();
      if (!current) throw new Error('Image recovery workspace does not exist');
      const prior = this.ctx.storage.sql.exec<{ receipt_json: string }>('SELECT receipt_json FROM image_recovery_receipts WHERE operation_id=?', receipt.recoveryOperationId).toArray()[0];
      if (prior) {
        if (prior.receipt_json !== JSON.stringify(receipt)) throw new Error('Image recovery receipt identity changed');
        return current;
      }
      if (current.generation !== input.expectedGeneration || (current.machineId !== receipt.machineId && current.resumeMachineId !== receipt.machineId)) throw new Error('Image recovery workspace ownership or generation changed');
      if (!current.manifestKey || !current.manifestHash || current.publishedRevision < 1) throw new Error('Image recovery requires a previously committed workspace checkpoint');
      const recovered: SpaceAuthorityRecord = { ...current, state: 'closed', machineId: null, resumeMachineId: receipt.machineId, generation: current.generation + 1, revision: current.revision + 1, updatedAt: new Date().toISOString(), failures: { open: null, close: null } };
      this.save(recovered);
      this.ctx.storage.sql.exec('INSERT INTO image_recovery_receipts(operation_id,receipt_json) VALUES(?,?)', receipt.recoveryOperationId, JSON.stringify(receipt));
      return recovered;
    });
  }

  get(): SpaceAuthorityRecord | null {
    const row = this.ctx.storage.sql.exec<{ record_json: string }>('SELECT record_json FROM space_authority WHERE id = 1').toArray()[0];
    return row ? SpaceAuthorityRecordSchema.parse(JSON.parse(row.record_json)) : null;
  }

  private save(state: SpaceAuthorityRecord): void {
    this.ctx.storage.sql.exec('INSERT INTO space_authority (id, project_id, space_id, resume_machine_id, record_json) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET resume_machine_id = excluded.resume_machine_id, record_json = excluded.record_json', state.projectId, state.spaceId, state.resumeMachineId, JSON.stringify(state));
  }
}
