import { DurableObject } from 'cloudflare:workers';
import { SpaceAuthorityRecordSchema, WorkspaceDomainError, type SpaceAuthorityRecord, type SpaceAuthorityResult } from '@gitspace/protocol-workspace';
import { DurableChangeLog } from './durable-stream.js';
import type { StreamEvent } from '@gitspace/protocol-sync';
import type { LiveNotice } from '@gitspace/protocol/live-notice';
import { notifyBrowsers } from './live-notices.js';
import { cloudImageDiscardReceiptSchema, type CloudImageDiscardReceipt } from '@gitspace/protocol/cloud-image';
import { DirectoryOutbox, type DirectoryPublication } from './account-directory.js';
import { RuntimeAttachmentSchema, RuntimeIdentitySchema, RuntimeMachineIdSchema, RuntimeJsonSchema, RuntimeSubmitInputSchema, RuntimeCancelInputSchema, RuntimeAnswerInputSchema, RuntimeWatchInputSchema, type RuntimeAttachment, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { ArtifactsCodeStore, artifactsProjectRepository, artifactsWorkspaceRepository, isAttachmentReady, isSupportedBranchName, CloudPublicationUncertain, readCurrentCheckpoint, readRuntimeLfsRoots, reconcileRuntimeLfsSources, type WorkspaceRuntime } from '@gitspace/runtime-workspace-do';
import { createAccountWorkspaceRuntime, ensureProjectCodeRepository } from './account-runtime-host.js';
import { RuntimeSessionInputSchema } from '@gitspace/protocol-runtime/session-controls';
import { RuntimeTranscriptRangeSchema } from '@gitspace/runtime-core/history';
import { RuntimeDraftSaveInputSchema } from '@gitspace/protocol-runtime/draft';
import { RuntimeServiceInputSchema } from '@gitspace/protocol-runtime/services';
import { RuntimeSyncRequestInputSchema, RuntimeSyncRequestResultSchema, type RuntimeSyncRequestResult } from '@gitspace/protocol-runtime/tool-arguments';
import { runtimeServiceControl } from './runtime-service-control.js';
import { RuntimeGitCheckpointSchema, RuntimeQaActionInputSchema, RuntimeSnapshotCommitInputSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { RuntimeAttachmentReadyInputSchema, RuntimeAssignmentsInputSchema, RuntimeCacheAttachmentRequestInputSchema, RuntimeAttachmentDetachRequestInputSchema } from '@gitspace/protocol-runtime/attachment-controls';
import { RuntimeHeartbeatInputSchema, RuntimeDetachInputSchema } from '@gitspace/protocol-runtime/machine-controls';
import { RuntimeAttachmentController, executorCapabilities } from './runtime-attachments.js';
import { notifyMachines } from './machine-notices.js';
import { adoptWorkspaceMetadata, authorizeWorkspaceRuntime, createWorkspaceMetadataTables, projectAcceptsWrites, readWorkspaceMetadata, readWorkspaceStatus, writeWorkspaceMetadata, type WorkspaceMetadata } from './workspace-metadata.js';
import { z } from 'zod';
import { normalizeRemoteRepositoryUrl, type CloudProjectSummary, type CloudWorkspaceDefinition, type ProjectLifecycle, type WorkspaceLifecycle } from '@gitspace/protocol';
import { assertWorkspacePhase, type GitLfsConfirmedObject, type WorkspacePhase, type WorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import { RetainedLfsSnapshotSchema } from './git-lfs-retention.js';
import { LifecycleRunRequestSchema, LifecycleRunSchema, type EnvironmentFailure, type LifecycleRun } from '@gitspace/protocol-environment';
const PortableLfsRetentionSchema = RetainedLfsSnapshotSchema.extend({ publicationId: z.string().optional() });
const BaseBranchChangeSchema = z.object({
  projectId: z.string(), previousBranch: z.string(), branch: z.string(),
  previous: RuntimeGitCheckpointSchema, checkpoint: RuntimeGitCheckpointSchema,
  previousBranchTip: z.string().nullable(),
});
/** Steps an interrupted base-branch change resumes from: `check` reads the project and fixes the target checkout;
 * `switch` fences the checkout (`prepared`), publishes its refs and records the branch on the project. */
const BaseBranchStepsSchema = z.object({
  projectId: z.string(), branch: z.string(), expectedRevision: z.number().int(), step: z.enum(['check', 'switch']),
  checkpoint: RuntimeGitCheckpointSchema.nullable(), prepared: BaseBranchChangeSchema.nullable(),
  attempts: z.number().int().nonnegative(), error: z.string().nullable(),
});
type BaseBranchSteps = z.infer<typeof BaseBranchStepsSchema>;
/** A step interrupted by a restart resumes from this alarm. */
const BASE_BRANCH_RECOVERY_MS = 60_000;
/** A fenced change that keeps failing stops retrying here; retrying `project.setBaseBranch` resumes it. */
const BASE_BRANCH_MAX_ATTEMPTS = 8;
/** A legacy LFS retention that keeps failing stays pending (its objects stay retained) and stops retrying here. */
const PORTABLE_LFS_MAX_ATTEMPTS = 12;
type RuntimeIdentity = Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>;

export class SpaceAuthorityDO extends DurableObject<Env> {
  private changes: DurableChangeLog;
  private directoryOutbox: DirectoryOutbox;
  private runtime: Promise<WorkspaceRuntime> | undefined;
  /** Loaded before any request; set once the space has cloud runtime state (see `hasCloudRuntime`). */
  private cloudRuntime: z.infer<typeof RuntimeIdentitySchema> | null = null;
  private cloudRuntimePublished = false;
  private alarmLine: Promise<void> = Promise.resolve();
  private seeding: Promise<WorkspaceMetadata> | undefined;
  private baseBranchRun: Promise<CloudProjectSummary> | undefined;
  /** Tabs learn of a committed change without the writer waiting for them. */
  private readonly liveNotify = (notices: LiveNotice[]) => { this.ctx.waitUntil(notifyBrowsers(this.env, notices)); };
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.changes = new DurableChangeLog(ctx.storage, this.liveNotify);
    this.directoryOutbox = this.openDirectoryOutbox();
    this.createTables();
    ctx.blockConcurrencyWhile(async () => {
      const state = this.get();
      const identity = await this.ctx.storage.get('runtime.identity') ?? (state ? { projectId: state.projectId, workspaceId: state.spaceId } : null);
      this.cloudRuntime = identity !== null && await this.hasCloudRuntime() ? RuntimeIdentitySchema.parse(identity) : null;
      this.cloudRuntimePublished = await this.ctx.storage.get('directory.runtimePublished') === true;
      // A base-branch change an older release left awaiting a retry resumes as a step list.
      const legacyChange = await this.ctx.storage.get('runtime.baseBranchChange');
      if (legacyChange !== undefined) {
        const change = BaseBranchChangeSchema.parse(legacyChange);
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO base_branch_steps(singleton,project_id,branch,expected_revision,step,checkpoint,prepared,attempts) VALUES(1,?,?,0,'switch',?,?,0)", change.projectId, change.branch, JSON.stringify(change.checkpoint), JSON.stringify(change));
        await this.ctx.storage.delete('runtime.baseBranchChange');
        await this.scheduleAlarm('baseBranch', Date.now());
      }
      this.ctx.waitUntil(this.flushPortableLfs());
      this.directoryOutbox.kick();
    });
  }

  private openDirectoryOutbox(): DirectoryOutbox {
    return new DirectoryOutbox(this.ctx, this.env, { set: timestamp => this.scheduleAlarm('directory', timestamp), clear: () => this.scheduleAlarm('directory', null) });
  }

  private createTables(): void {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_alarms(owner TEXT PRIMARY KEY, timestamp INTEGER NOT NULL)');
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS space_authority (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      project_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      resume_machine_id TEXT,
      record_json TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS image_recovery_receipts(operation_id TEXT PRIMARY KEY,receipt_json TEXT NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS portable_lfs_outbox(snapshot_id TEXT PRIMARY KEY,inventory TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0)');
    if (!this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(portable_lfs_outbox)').toArray().some(column => column.name === 'attempts')) this.ctx.storage.sql.exec('ALTER TABLE portable_lfs_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS base_branch_steps(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), project_id TEXT NOT NULL, branch TEXT NOT NULL, expected_revision INTEGER NOT NULL,
      step TEXT NOT NULL, checkpoint TEXT, prepared TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT
    )`);
    createWorkspaceMetadataTables(this.ctx.storage);
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
    // Runtime wakes from several sources (task wake, retention retry, code_search retry): a later request never postpones an earlier one.
    else this.ctx.storage.sql.exec("INSERT INTO runtime_alarms(owner,timestamp) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET timestamp=CASE WHEN owner='runtime' THEN MIN(timestamp,excluded.timestamp) ELSE excluded.timestamp END", owner, timestamp);
    const operation = this.alarmLine.then(async () => {
      // Runtime wakes are held while a base-branch change keeps the runtime closed; its end arms them.
      const next = this.ctx.storage.sql.exec<{ timestamp: number | null }>("SELECT MIN(timestamp) AS timestamp FROM runtime_alarms WHERE owner<>'runtime' OR NOT EXISTS (SELECT 1 FROM base_branch_steps)").toArray()[0]?.timestamp ?? null;
      // Every alarm write is billed: only a changed time is written.
      const current = await this.ctx.storage.getAlarm();
      if (next === null) { if (current !== null) await this.ctx.storage.deleteAlarm(); }
      else if (current !== next) await this.ctx.storage.setAlarm(next);
    });
    this.alarmLine = operation.catch(() => {});
    return operation;
  }

  async alarm(): Promise<void> {
    const startedAt = Date.now();
    const due = this.ctx.storage.sql.exec<{ owner: string; timestamp: number }>("SELECT owner, timestamp FROM runtime_alarms WHERE timestamp <= ? AND owner <> 'runtime'", startedAt).toArray();
    await this.directoryOutbox.flush();
    await this.flushPortableLfs();
    const change = this.baseBranchSteps();
    if (change && change.attempts < BASE_BRANCH_MAX_ATTEMPTS) {
      await this.advanceBaseBranch().catch((error: unknown) => console.error(JSON.stringify({ event: 'base_branch_step_failed', branch: change.branch, message: error instanceof Error ? error.message : String(error) })));
    }
    const wake = this.ctx.storage.sql.exec<{ timestamp: number }>("SELECT timestamp FROM runtime_alarms WHERE owner='runtime'").toArray()[0];
    if (wake && wake.timestamp <= Date.now() && !this.baseBranchSteps()) {
      await this.scheduleAlarm('runtime', null);
      const identity = await this.ctx.storage.get<Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>>('runtime.identity');
      if (identity) await (await this.getRuntime(identity)).wake();
    }
    // A wake that was due and that its handler neither cleared nor moved has nothing to do: re-arming it would fire again
    // at once, forever (a base-branch change past its attempts, an empty outbox). It is dropped; a handler that has work
    // schedules again.
    const stale = due.filter(row => this.ctx.storage.sql.exec<{ timestamp: number }>('SELECT timestamp FROM runtime_alarms WHERE owner=?', row.owner).toArray()[0]?.timestamp === row.timestamp);
    for (const row of stale) {
      console.error(JSON.stringify({ event: 'space_alarm_stale_wake_dropped', owner: row.owner, dueAt: new Date(row.timestamp).toISOString() }));
      await this.scheduleAlarm(row.owner, null);
    }
  }


  /** Attachment records read without starting the runtime, so legacy spaces never gain runtime state. */
  private async storedAttachments(): Promise<RuntimeAttachment[]> {
    if (await this.ctx.storage.get('runtime.identity') === undefined) return [];
    if (!this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_attachments'").toArray().length) return [];
    return this.ctx.storage.sql.exec<{ record: string }>('SELECT record FROM runtime_attachments').toArray().map(row => RuntimeAttachmentSchema.parse(JSON.parse(row.record)));
  }

  /** The project listing's one read of this workspace: its legacy placement and the status summary its runtime last
   * published, read without opening the runtime (null before its first publication under this release). */
  listingState(): { placement: SpaceAuthorityRecord | null; status: WorkspaceStatusSummary | null } {
    return { placement: this.get(), status: readWorkspaceStatus(this.ctx.storage) };
  }

  /** This workspace's metadata. One that predates workspaces holding their own reads its project once to seed it;
   * every later decision is local. */
  private async metadata(identity: RuntimeIdentity): Promise<WorkspaceMetadata> {
    const stored = readWorkspaceMetadata(this.ctx.storage);
    if (stored) return stored;
    this.seeding ??= this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${identity.projectId}`).workspaceSeed(identity.workspaceId).then(seed => {
      if (!seed || seed.project.id !== identity.projectId) throw new Error('Runtime project is unavailable');
      if (!seed.workspace || seed.workspace.projectId !== seed.project.id) throw new Error('Workspace does not belong to the requested project');
      // A creation seed may have landed while this read was in flight; adoption keeps whichever is newer.
      return writeWorkspaceMetadata(this.ctx.storage, adoptWorkspaceMetadata(readWorkspaceMetadata(this.ctx.storage), seed.workspace, seed.project));
    }).finally(() => { this.seeding = undefined; });
    return this.seeding;
  }

  /** Takes a definition the project recorded for this workspace when it is newer than the one held. */
  private adopt(workspace: CloudWorkspaceDefinition): WorkspaceMetadata {
    const current = readWorkspaceMetadata(this.ctx.storage);
    if (!current) throw new Error('Workspace metadata is unavailable');
    return writeWorkspaceMetadata(this.ctx.storage, adoptWorkspaceMetadata(current, workspace, { id: current.projectId, lifecycle: current.projectLifecycle, revision: current.projectRevision }));
  }

  /** Runtime access decided from this workspace's own metadata, with no project read once seeded. */
  async runtimeAccess(raw: unknown, write: boolean): Promise<WorkspaceMetadata> {
    const identity = RuntimeIdentitySchema.parse(raw);
    return authorizeWorkspaceRuntime(await this.metadata(identity), identity, write);
  }

  /** Creation seeds the workspace with the definition it starts from. Idempotent: an older definition or project
   * state never replaces a newer one. */
  seedWorkspace(workspace: CloudWorkspaceDefinition, project: Pick<CloudProjectSummary, 'id' | 'lifecycle' | 'revision'>): WorkspaceMetadata {
    return writeWorkspaceMetadata(this.ctx.storage, adoptWorkspaceMetadata(readWorkspaceMetadata(this.ctx.storage), workspace, project));
  }

  async runtimeMachineAttachments(machineId: string): Promise<RuntimeAttachment[]> {
    return (await this.storedAttachments()).filter(item => item.machineId === machineId);
  }

  /** Machines with a live attachment here, read without starting the runtime; the fleet's machine index is built
   * once from these. */
  async runtimeAttachedMachines(): Promise<string[]> {
    return [...new Set((await this.storedAttachments()).filter(item => item.state !== 'detached').map(item => item.machineId))];
  }

  /** The relay's view of a machine's connection: its attachments here are online exactly while it is connected. */
  async runtimeMachinePresence(machineId: string, connected: boolean): Promise<void> {
    if (!(await this.storedAttachments()).some(item => item.machineId === machineId && item.state !== 'detached' && item.online !== connected)) return;
    const runtime = await this.getRuntime(await this.ctx.storage.get('runtime.identity'));
    if (runtime.attachments.presence(RuntimeMachineIdSchema.parse(machineId), connected)) runtime.publish();
  }

  /** Machine removal fan-out: the machine's attachments here are detached before its credentials go. */
  async runtimeRemoveMachine(machineId: string): Promise<RuntimeAttachment[]> {
    if (!(await this.storedAttachments()).some(item => item.machineId === machineId && item.state !== 'detached')) return [];
    const identity = RuntimeIdentitySchema.parse(await this.ctx.storage.get('runtime.identity'));
    const runtime = await this.getRuntime(identity);
    runtime.attachments.remove(RuntimeMachineIdSchema.parse(machineId));
    runtime.publish();
    await this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID).detachMachineWorkspace(machineId, identity.workspaceId);
    return runtime.attachments.list().filter(item => item.machineId === machineId);
  }

  /** Detached machines leave the fleet's machine index and are told to fetch their assignments. */
  private async releaseMachines(workspaceId: string, machineIds: readonly string[]): Promise<void> {
    const fleet = this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID);
    for (const machineId of machineIds) await fleet.detachMachineWorkspace(machineId, workspaceId);
    await notifyMachines(this.env, machineIds, ['assignments'], workspaceId);
  }

  private async getRuntime(raw: unknown): Promise<WorkspaceRuntime> {
    const identity = RuntimeIdentitySchema.parse(raw);
    authorizeWorkspaceRuntime(await this.metadata(identity), identity, false);
    this.assertNoBaseBranchChange();
    return this.loadRuntime(identity);
  }

  /** The runtime without the base-branch fence; only the base-branch steps open it while a change is pending. */
  private async loadRuntime(identity: RuntimeIdentity): Promise<WorkspaceRuntime> {
    const authority = this.get();
    if (authority && (authority.projectId !== identity.projectId || authority.spaceId !== identity.workspaceId)) throw new Error('Runtime workspace identity mismatch');
    const stored = await this.ctx.storage.get('runtime.identity');
    if (stored !== undefined) {
      const previous = RuntimeIdentitySchema.parse(stored);
      if (previous.projectId !== identity.projectId || previous.workspaceId !== identity.workspaceId) throw new Error('Runtime actor identity mismatch');
    } else await this.ctx.storage.put('runtime.identity', identity);
    this.publishCloudRuntime(identity);
    if (!this.runtime) {
      const runtime = this.openRuntime(identity);
      this.runtime = runtime;
      runtime.catch(() => { this.runtime = undefined; });
    }
    return this.runtime;
  }

  /** Agents request attachments through the same path a person's cache request takes. */
  private openRuntime(identity: RuntimeIdentity): Promise<WorkspaceRuntime> {
    return createAccountWorkspaceRuntime(this.ctx, this.env, identity, timestamp => this.scheduleAlarm('runtime', timestamp), machineId => this.runtimeCacheAttachmentRequest({ ...identity, machineId }));
  }

  async runtimeSnapshot(raw: unknown): Promise<Response> { return Response.json(await (await this.getRuntime(raw)).snapshot()); }
  async runtimeAttachments(raw: unknown) { return (await this.getRuntime(raw)).attachments.list(); }
  async runtimeCodeCheckpoint(raw: unknown) {
    const identity = RuntimeIdentitySchema.parse(raw);
    this.assertNoBaseBranchChange();
    const authority = this.get();
    if (authority && (authority.projectId !== identity.projectId || authority.spaceId !== identity.workspaceId)) throw new Error('Checkpoint workspace identity mismatch');
    const stored = await this.ctx.storage.get('runtime.identity');
    if (stored !== undefined) {
      const previous = RuntimeIdentitySchema.parse(stored);
      if (previous.projectId !== identity.projectId || previous.workspaceId !== identity.workspaceId) throw new Error('Checkpoint runtime identity mismatch');
    }
    return readCurrentCheckpoint(this.ctx.storage);
  }

  /** The pending base-branch change, if any. */
  private baseBranchSteps(): BaseBranchSteps | null {
    const row = this.ctx.storage.sql.exec<{ project_id: string; branch: string; expected_revision: number; step: string; checkpoint: string | null; prepared: string | null; attempts: number; error: string | null }>('SELECT project_id,branch,expected_revision,step,checkpoint,prepared,attempts,error FROM base_branch_steps WHERE singleton=1').toArray()[0];
    return row ? BaseBranchStepsSchema.parse({
      projectId: row.project_id, branch: row.branch, expectedRevision: row.expected_revision, step: row.step,
      checkpoint: row.checkpoint === null ? null : JSON.parse(row.checkpoint), prepared: row.prepared === null ? null : JSON.parse(row.prepared),
      attempts: row.attempts, error: row.error,
    }) : null;
  }

  /** Runtime calls are refused, not queued, while the base checkout changes. */
  private assertNoBaseBranchChange(): void {
    const change = this.baseBranchSteps();
    if (!change) return;
    if (change.attempts >= BASE_BRANCH_MAX_ATTEMPTS) throw new Error(`The base branch change to ${change.branch} stopped after ${change.attempts} attempts (${change.error ?? 'unknown error'}); retry project.setBaseBranch with branch ${change.branch}`);
    throw new Error(`The base branch is changing to ${change.branch}; try again when the change finishes`);
  }

  /** The base checkout, its Git refs and metadata change as a durable step list. Requests and the alarm run the steps;
   * nothing holds this object while they wait on the project, the git store or the index. Dirty state, agents and
   * live caches are rejected before the checkout is fenced. */
  async runtimeSetBaseBranch(raw: unknown, expectedRevision: number, branch: string): Promise<CloudProjectSummary> {
    const identity = RuntimeIdentitySchema.parse(raw);
    if (!isSupportedBranchName(branch)) throw new Error('Invalid base branch');
    const projectId: string = identity.projectId;
    if (identity.workspaceId !== projectId) throw new Error('Base branch changes require the project base workspace');
    const pending = this.baseBranchSteps();
    if (pending && (pending.projectId !== identity.projectId || pending.branch !== branch)) throw new Error(`Retry the pending base branch change to ${pending.branch} first`);
    // A person retrying a stopped change restarts its retries.
    if (pending) this.ctx.storage.sql.exec('UPDATE base_branch_steps SET attempts=0 WHERE singleton=1 AND attempts>0');
    else this.ctx.storage.sql.exec("INSERT INTO base_branch_steps(singleton,project_id,branch,expected_revision,step,attempts) VALUES(1,?,?,?,'check',0)", identity.projectId, branch, expectedRevision);
    return this.advanceBaseBranch();
  }

  /** One run of the steps at a time; a request and the alarm share it. */
  private advanceBaseBranch(): Promise<CloudProjectSummary> {
    this.baseBranchRun ??= this.runBaseBranchSteps().finally(() => { this.baseBranchRun = undefined; });
    return this.baseBranchRun;
  }

  private async runBaseBranchSteps(): Promise<CloudProjectSummary> {
    const steps = this.baseBranchSteps();
    if (!steps) throw new Error('No base branch change is pending');
    await this.scheduleAlarm('baseBranch', Date.now() + BASE_BRANCH_RECOVERY_MS);
    try {
      const result = await this.baseBranchStep(steps);
      await this.endBaseBranch();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.baseBranchSteps();
      // Nothing is fenced before the switch prepares: the change ends and its caller learns why.
      if (!current?.prepared) {
        await this.endBaseBranch();
        throw error;
      }
      const attempts = current.attempts + 1;
      this.ctx.storage.sql.exec('UPDATE base_branch_steps SET attempts=?,error=? WHERE singleton=1', attempts, message);
      if (attempts >= BASE_BRANCH_MAX_ATTEMPTS) {
        await this.scheduleAlarm('baseBranch', null);
        throw new Error(`${message}. The base branch change to ${current.branch} stopped after ${attempts} attempts; retry project.setBaseBranch with branch ${current.branch}`);
      }
      await this.scheduleAlarm('baseBranch', Date.now() + Math.min(3_600_000, 30_000 * 2 ** (attempts - 1)));
      throw new Error(`${message}. GitSpace retries the base branch change to ${current.branch} automatically; retry project.setBaseBranch with branch ${current.branch} to resume it now`);
    }
  }

  private async endBaseBranch(): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM base_branch_steps WHERE singleton=1');
    await this.scheduleAlarm('baseBranch', null);
  }

  private async baseBranchStep(steps: BaseBranchSteps): Promise<CloudProjectSummary> {
    const identity = RuntimeIdentitySchema.parse({ projectId: steps.projectId, workspaceId: steps.projectId });
    const branch = steps.branch;
    const authority = this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${steps.projectId}`);
    const project = await authority.getProject();
    if (!project) throw new Error('Project is unavailable');
    if (project.role === 'gitspace-source') throw new Error('The built-in GitSpace project base branch is managed by GitSpace releases');
    if (steps.step === 'check' && project.revision !== steps.expectedRevision) throw new Error(`Project revision conflict: expected ${steps.expectedRevision}, actual ${project.revision}`);
    if (steps.step === 'check' && project.baseBranch === branch) return this.env.USER_PROJECTS.getByName(this.env.ACCOUNT_ID).put(project);
    if (project.lifecycle !== 'active') throw new Error('Project must be active to change its base branch');
    authorizeWorkspaceRuntime(await this.metadata(identity), identity, false);
    const runtime = await this.loadRuntime(identity);
    const snapshot = await runtime.snapshot();
    if (snapshot.conversations.some(conversation => conversation.status === 'running' || conversation.status === 'waiting')) throw new Error('Stop the base workspace agent before changing its branch');
    if (runtime.attachments.list().some(attachment => attachment.state !== 'detached')) throw new Error('Detach base workspace caches before changing its branch');
    const code = new ArtifactsCodeStore(this.env.ARTIFACTS);
    const repository = artifactsWorkspaceRepository(identity.workspaceId);
    const source = artifactsProjectRepository(project.id);
    await ensureProjectCodeRepository(code, project);
    let checkpoint = steps.checkpoint;
    if (!checkpoint) {
      const head = await code.resolveRef(source, `refs/heads/${branch}`)
        ?? (project.repositoryReference ? await code.importSourceRef(project.id, normalizeRemoteRepositoryUrl(project.repositoryReference.replace(/^git@github\.com:/u, 'https://github.com/')), `refs/heads/${branch}`) : null);
      if (!head) throw new Error(`Branch ${branch} does not exist in the project repository`);
      const metadata = await code.readCommit(source, head);
      if (!metadata) throw new Error('Base branch commit is unavailable');
      checkpoint = RuntimeGitCheckpointSchema.parse({
        checkpointRef: `refs/gitspace/spaces/${identity.workspaceId}/checkpoints`, branch, headCommit: head,
        indexCommit: head, trackedWorktreeCommit: head, worktreeCommit: head, indexTree: metadata.treeHash, worktreeTree: metadata.treeHash,
      });
      this.ctx.storage.sql.exec("UPDATE base_branch_steps SET step='switch',checkpoint=? WHERE singleton=1", JSON.stringify(checkpoint));
    }
    const target = checkpoint;
    const commit = target.headCommit;
    if (!commit) throw new Error('Base branch commit is unavailable');
    let prepared = steps.prepared;
    const result = await runtime.cloudFiles.changeBranch({
      checkpoint: target,
      validate: async current => {
        if (prepared) {
          if (current.worktreeCommit !== prepared.previous.worktreeCommit && current.worktreeCommit !== target.worktreeCommit) throw new Error('Base checkout changed during branch recovery');
          return;
        }
        const head = current.headCommit ? await code.readCommit(repository, current.headCommit) : null;
        if (!head || current.indexTree !== head.treeHash || current.worktreeTree !== head.treeHash || current.conflicts?.length || current.lfs?.heldBack.length) throw new Error('Base workspace has uncommitted changes; commit or discard them before changing its branch');
      },
      prepare: async current => {
        if (prepared) return;
        prepared = BaseBranchChangeSchema.parse({ projectId: project.id, previousBranch: project.baseBranch, branch, previous: current, checkpoint: target, previousBranchTip: await code.resolveRef(repository, `refs/heads/${branch}`) });
        this.ctx.storage.sql.exec('UPDATE base_branch_steps SET prepared=? WHERE singleton=1', JSON.stringify(prepared));
      },
      publish: async () => {
        if (!prepared) throw new Error('Base branch intent is missing');
        await code.copyCommit(source, repository, `refs/heads/${branch}`, commit, prepared.previousBranchTip);
        await code.copyCommit(source, repository, target.checkpointRef, commit, prepared.previous.worktreeCommit);
      },
      commit: async () => {
        if (!prepared) throw new Error('Base branch intent is missing');
        const latest = await authority.getProject();
        if (!latest || (latest.baseBranch !== prepared.previousBranch && latest.baseBranch !== branch)) throw new Error('Project base branch changed during checkout publication');
        const updated = latest.baseBranch === branch ? latest : await authority.setBaseBranch(latest.revision, branch, commit);
        return this.env.USER_PROJECTS.getByName(this.env.ACCOUNT_ID).put(updated);
      },
    });
    // The base branch is this workspace's branch: take the definition the project just recorded.
    const recorded = await authority.workspaceSeed(project.id);
    if (!recorded?.workspace) throw new Error('Project is unavailable');
    this.seedWorkspace(recorded.workspace, recorded.project);
    return result;
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
  /** A cloud workspace's checkout lives in this DO's runtime; machines only attach as caches. */
  async hasCloudRuntime(): Promise<boolean> {
    return await this.ctx.storage.get('runtime.identity') !== undefined || await readCurrentCheckpoint(this.ctx.storage) !== null;
  }
  /** A workspace leaving active use: its working conversations stop and every live attachment is asked to drain and detach.
   * Draining is recorded here; a machine finishes it when it next reports, or its lease expires. Never opens a runtime that has no state. */
  private async stopRuntime(identity: RuntimeIdentity): Promise<void> {
    if (await this.ctx.storage.get('runtime.identity') === undefined) return;
    const runtime = await this.getRuntime(identity);
    for (const conversation of (await runtime.snapshot()).conversations) {
      if (conversation.status === 'running' || conversation.status === 'waiting') await runtime.cancel({ ...identity, conversationId: conversation.id });
    }
    const detached: string[] = [];
    for (const attachment of runtime.attachments.list()) {
      if (attachment.state === 'detached') continue;
      runtime.attachments.detach(attachment);
      detached.push(attachment.machineId);
    }
    runtime.publish();
    await this.releaseMachines(identity.workspaceId, detached);
  }

  /** Permanent deletion of this workspace's runtime, attachments and placement. The tombstone is written before and
   * survives the erase, so nothing reopens what this removes and an interrupted deletion resumes. */
  private async erase(tombstone: WorkspaceMetadata): Promise<void> {
    writeWorkspaceMetadata(this.ctx.storage, tombstone);
    // A runtime that never opened has no conversation to stop.
    const loaded = await this.runtime?.catch(() => undefined);
    this.runtime = undefined;
    if (loaded) {
      for (const conversation of (await loaded.snapshot()).conversations) {
        if (conversation.status === 'running' || conversation.status === 'waiting') await loaded.cancel({ projectId: tombstone.projectId, workspaceId: tombstone.workspaceId, conversationId: conversation.id });
      }
    }
    // Unindexed while the attachments still exist, so an interrupted erase unindexes them again.
    const attached = await this.runtimeAttachedMachines();
    const fleet = this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID);
    for (const machineId of attached) await fleet.detachMachineWorkspace(machineId, tombstone.workspaceId);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.changes = new DurableChangeLog(this.ctx.storage, this.liveNotify);
    this.directoryOutbox = this.openDirectoryOutbox();
    this.createTables();
    writeWorkspaceMetadata(this.ctx.storage, tombstone);
    this.cloudRuntime = null;
    this.cloudRuntimePublished = false;
    await notifyMachines(this.env, attached, ['assignments'], tombstone.workspaceId);
  }

  /** The worktree a lifecycle change acts on, current with the project definition the caller read: a workspace whose
   * creation the project finished after this workspace last looked starts from that definition. */
  private async worktree(definition: CloudWorkspaceDefinition): Promise<WorkspaceMetadata> {
    await this.metadata(RuntimeIdentitySchema.parse({ projectId: definition.projectId, workspaceId: definition.id }));
    const current = this.adopt(definition);
    if (current.kind !== 'worktree') throw new Error('The project base workspace is archived, restored and deleted only with its project');
    if (current.projectLifecycle === 'archived' || current.projectLifecycle === 'deleting') throw new Error(`Cannot write workspace for ${current.projectLifecycle} project`);
    return current;
  }

  /** The project records a lifecycle this workspace has already applied to itself. */
  private async recordLifecycle(applied: WorkspaceMetadata, lifecycle: WorkspaceLifecycle): Promise<CloudWorkspaceDefinition> {
    const recorded = await this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${applied.projectId}`).commitWorkspaceLifecycle(applied.workspaceId, applied.revision, lifecycle);
    this.adopt(recorded);
    return recorded;
  }

  /** Archives this workspace: it turns read-only and stops its runtime before the project records it archived. */
  async archiveWorkspace(definition: CloudWorkspaceDefinition): Promise<CloudWorkspaceDefinition> {
    const current = await this.worktree(definition);
    if (current.lifecycle !== 'active' && current.lifecycle !== 'failed' && current.lifecycle !== 'archived') throw new Error(`Workspace ${definition.name} is ${current.lifecycle}; retry or delete its creation instead`);
    const archived = writeWorkspaceMetadata(this.ctx.storage, { ...current, lifecycle: 'archived' });
    await this.stopRuntime({ projectId: archived.projectId, workspaceId: archived.workspaceId });
    return this.recordLifecycle(archived, 'archived');
  }

  /** Returns this archived workspace to active use before the project records it; its runtime reopens on first use. */
  async restoreWorkspace(definition: CloudWorkspaceDefinition): Promise<CloudWorkspaceDefinition> {
    const current = await this.worktree(definition);
    if (current.projectLifecycle !== 'active' && current.projectLifecycle !== 'cloud-only') throw new Error(`Project ${current.projectId} is not active`);
    if (current.lifecycle !== 'archived' && current.lifecycle !== 'active') throw new Error(`Workspace ${definition.name} is ${current.lifecycle}; only an archived workspace can be restored`);
    return this.recordLifecycle(writeWorkspaceMetadata(this.ctx.storage, { ...current, lifecycle: 'active' }), 'active');
  }

  /** Permanently deletes this workspace in any state: its runtime stops, its attachments, placement and state are
   * erased, then the project records it deleting. A workspace of an archived project is deleted too. */
  async deleteWorkspace(definition: CloudWorkspaceDefinition): Promise<CloudWorkspaceDefinition> {
    await this.metadata(RuntimeIdentitySchema.parse({ projectId: definition.projectId, workspaceId: definition.id }));
    const current = this.adopt(definition);
    if (current.kind !== 'worktree') throw new Error('The project base workspace is deleted only with its project');
    const deleting: WorkspaceMetadata = { ...current, lifecycle: 'deleting' };
    await this.erase(deleting);
    return this.recordLifecycle(deleting, 'deleting');
  }

  /** A project archive or restore reaching this workspace: it takes the project lifecycle decided at `revision`, and a
   * project that no longer accepts writes stops this runtime. A push older than the state held changes nothing. */
  async applyProjectLifecycle(raw: unknown, project: { lifecycle: ProjectLifecycle; revision: number }): Promise<void> {
    const identity = RuntimeIdentitySchema.parse(raw);
    const current = await this.metadata(identity);
    if (current.projectId !== identity.projectId || current.workspaceId !== identity.workspaceId) throw new Error('Runtime actor identity mismatch');
    if (project.revision < current.projectRevision) return;
    writeWorkspaceMetadata(this.ctx.storage, { ...current, projectLifecycle: project.lifecycle, projectRevision: project.revision });
    if (!projectAcceptsWrites(project.lifecycle)) await this.stopRuntime(identity);
  }

  /** Project deletion reaching this workspace: it becomes unavailable, then its runtime, attachments and placement are erased. */
  async runtimeErase(raw: unknown): Promise<void> {
    const identity = RuntimeIdentitySchema.parse(raw);
    const current = await this.metadata(identity);
    if (current.projectId !== identity.projectId || current.workspaceId !== identity.workspaceId) throw new Error('Runtime actor identity mismatch');
    await this.erase({ ...current, projectLifecycle: 'deleting' });
  }

  /** Moves this workspace's phase within the ceiling its dependencies set; the project records it after. */
  async setWorkspacePhase(raw: unknown, phase: WorkspacePhase): Promise<CloudWorkspaceDefinition> {
    const identity = RuntimeIdentitySchema.parse(raw);
    const current = authorizeWorkspaceRuntime(await this.metadata(identity), identity, false);
    if (current.projectLifecycle === 'archived') throw new Error('Cannot write workspace for archived project');
    const project = this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${identity.projectId}`);
    assertWorkspacePhase(phase, await project.workspaceDependencies(identity.workspaceId));
    const applied = writeWorkspaceMetadata(this.ctx.storage, { ...current, phase });
    const recorded = await project.commitWorkspacePhase(identity.workspaceId, applied.revision, phase);
    this.adopt(recorded);
    return recorded;
  }

  /** A human bundle edit lands in the cloud working copy exactly as an agent `write` does: one checkpoint
   * through the same publication queue, from which every environment read re-derives the definition. */
  async runtimeWriteEnvironmentBundle(raw: unknown, content: string): Promise<void> {
    const identity = RuntimeIdentitySchema.parse(raw);
    await this.runtimeAccess(identity, true);
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
    return (await this.getRuntime(identity)).attachments.list().some(item => item.machineId === machineId && isAttachmentReady(item));
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
    if (!runtime.attachments.list().some(item => item.machineId === input.machineId && isAttachmentReady(item))) return { status: 'error', failure: detached };
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
  /** Approving an agent's machine-attach question attaches that machine; the asking conversation hears when it is ready. */
  async runtimeAnswer(raw: unknown, actor: { deviceId: string; canApprove: boolean }) {
    const input = RuntimeAnswerInputSchema.parse(raw);
    const runtime = await this.getRuntime(input);
    const result = await runtime.answer(input, actor);
    if (input.answer !== true || !input.questionId.startsWith('machine-attach:')) return result;
    const question = (await runtime.snapshot()).questions.find(item => item.id === input.questionId);
    if (question?.tool?.name !== 'machines') return result;
    const machineId = z.object({ machine: RuntimeMachineIdSchema }).parse(question.tool.args).machine;
    const { attachment } = await this.runtimeCacheAttachmentRequest({ projectId: input.projectId, workspaceId: input.workspaceId, machineId });
    if (!isAttachmentReady(attachment)) {
      const label = (await this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID).getMachine(machineId))?.label ?? machineId;
      runtime.noticeWhenReady({ attachmentId: attachment.attachmentId, generation: attachment.generation, conversationId: question.conversationId, label });
    }
    return result;
  }
  /** A finite JSON body: the events of one bounded read, never a held-open stream. */
  async runtimeEvents(raw: unknown): Promise<Response> { const input = RuntimeWatchInputSchema.parse(raw); return Response.json(await (await this.getRuntime(input)).events(input.after)); }

  async runtimeSession(raw: unknown, actor: { canApprove: boolean; deviceId?: string }): Promise<Response> {
    const input = RuntimeSessionInputSchema.parse(raw);
    return Response.json(await (await this.getRuntime(input)).session(input.conversationId, input.command, actor.canApprove, actor.deviceId));
  }
  async runtimeServices(raw: unknown) {
    const input = RuntimeServiceInputSchema.parse(raw);
    return runtimeServiceControl(await this.getRuntime(input), input);
  }
  /** A person's sync action runs the `sync` tool once per request id as a call of the main conversation. */
  async runtimeSync(raw: unknown): Promise<RuntimeSyncRequestResult> {
    const input = RuntimeSyncRequestInputSchema.parse(raw);
    const result = await (await this.getRuntime(input)).manage({ tool: 'sync', requestId: `sync:${input.requestId}`, args: input.args });
    const text = result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('');
    if (result.status === 'failed') throw new Error(result.error.message);
    if (result.status !== 'completed') throw new Error(text || 'The sync operation was interrupted; check the machine before retrying');
    return RuntimeSyncRequestResultSchema.parse({ ...JSON.parse(text), method: input.args.method });
  }
  async runtimeBrowserAuthority(raw: unknown) {
    const input = RuntimeIdentitySchema.extend({ machineId: z.string(), attachmentId: z.string(), generation: z.number().int().nonnegative() }).parse(raw);
    const runtime = await this.getRuntime(input);
    if (!runtime.attachments.list().some(item => item.machineId === input.machineId && item.attachmentId === input.attachmentId && item.generation === input.generation && item.state !== 'detached')) throw new Error('Browser authority requires active owned assignment');
    const { algorithm, publicKey } = await this.env.ACCOUNT_STATE.getByName(this.env.ACCOUNT_ID).browserTrust();
    return { algorithm, publicKey };
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
    return new RuntimeAttachmentController({
      attachments: runtime.attachments, code: new ArtifactsCodeStore(this.env.ARTIFACTS), publish: () => runtime.publish(),
      snapshot: () => runtime.cloudFiles.initializeSnapshot(),
      origin: async projectId => (await this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).getProject())?.repositoryReference ?? null,
      // The worker authenticated this machine's request; only fleet membership is checked here.
      authorizeMachine: async machineId => {
        const machine = await this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID).getMachine(machineId);
        if (!machine || machine.desiredState === 'removed') throw new Error('Attachment target is not an enrolled account machine');
      },
    });
  }

  async runtimeCacheAttachmentRequest(raw: unknown) {
    const input = RuntimeCacheAttachmentRequestInputSchema.parse(raw);
    const workspace = await this.runtimeAccess(input, true);
    // Indexed before the attachment exists, so a machine-wide assignment read never misses it.
    const { connected } = await this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID).attachMachineWorkspace(input.machineId, { projectId: input.projectId, workspaceId: input.workspaceId });
    const runtime = await this.getRuntime(input);
    await runtime.cloudFiles.initializeSnapshot();
    const result = await runtime.attachments.requestCache({ ...input, checkout: { kind: 'shared', branch: workspace.branch }, capabilities: executorCapabilities }, connected);
    runtime.publish();
    await notifyMachines(this.env, [input.machineId], ['assignments'], input.workspaceId);
    return result;
  }

  /** A person detaches a machine; the machine learns it from its next assignment read. */
  async runtimeAttachmentDetachRequest(raw: unknown) {
    const input = RuntimeAttachmentDetachRequestInputSchema.parse(raw);
    const result = await this.runtimeDetach(input);
    await notifyMachines(this.env, [input.machineId], ['assignments'], input.workspaceId);
    return result;
  }

  async runtimeAssignments(raw: unknown) {
    const identity = RuntimeIdentitySchema.parse(raw);
    const input = RuntimeAssignmentsInputSchema.parse(raw);
    if (await this.ctx.storage.get('runtime.identity') === undefined) return { assignments: [] };
    // Only machines released before 9f5bbae long-poll with `afterSnapshot`; delete this once lightbeam's machines have updated.
    if (input.afterSnapshot !== undefined) {
      const runtime = await this.getRuntime(identity);
      if (!runtime.attachments.list().some(item => item.machineId === input.machineId && item.state !== 'detached')) throw new Error('Snapshot wait requires an active cache');
      await runtime.waitForSnapshot(input.afterSnapshot);
    }
    return (await this.attachmentController(identity)).assignments(input);
  }

  async runtimeAttachmentReady(raw: unknown) {
    const input = RuntimeAttachmentReadyInputSchema.parse(raw);
    const runtime = await this.getRuntime(input);
    const result = await (await this.attachmentController(input)).ready(input);
    await runtime.cacheReady(input.attachmentId, input.generation);
    return result;
  }

  async runtimeHeartbeat(raw: unknown) {
    const input = RuntimeHeartbeatInputSchema.parse(raw);
    const runtime = await this.getRuntime(input);
    const machine = input.browserCapabilities ? await this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID).getMachine(input.machineId) : undefined;
    if (input.browserCapabilities && (machine?.kind !== 'physical' || machine.desiredState === 'removed')) input.browserCapabilities = [];
    // A report that only moves timestamps changes nothing anyone sees: no snapshot rebuild.
    const visible = (value: unknown) => JSON.stringify(value, (key, field: unknown) => key.endsWith('At') ? undefined : field);
    const before = visible(runtime.attachments.list().find(item => item.attachmentId === input.attachmentId));
    const attachment = runtime.attachments.observe(input);
    if (visible(attachment) !== before) runtime.publish();
    return { attachment };
  }

  async runtimeDetach(raw: unknown) {
    const input = RuntimeDetachInputSchema.parse(raw);
    const runtime = await this.getRuntime(input);
    if (runtime.cloudFiles.hasPendingMachine(input.machineId)) throw new Error('Pending snapshot publication prevents cache detach');
    const attachment = runtime.attachments.detach(input);
    runtime.publish();
    await this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID).detachMachineWorkspace(input.machineId, input.workspaceId);
    return { attachment };
  }


  async runtimeCronSubmit(raw: unknown) {
    const input = RuntimeIdentitySchema.extend({ requestId: z.string().min(1), text: z.string().min(1), readScopes: z.array(z.string()), writeScopes: z.array(z.string()) }).parse(raw);
    await this.runtimeAccess(input, true);
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
    const input = RuntimeIdentitySchema.extend({ requestId: z.string().min(1) }).parse(raw);
    return (await this.getRuntime(input)).cronCancel(input.requestId);
  }

  async runtimeCronNotifyOverdue(raw: unknown) {
    const input = RuntimeIdentitySchema.extend({ requestId: z.string().min(1) }).parse(raw);
    return (await this.getRuntime(input)).cronNotifyOverdue(input.requestId);
  }

  async runtimeTranscript(raw: unknown, format: 'json' | 'ndjson' = 'json', range: unknown = {}): Promise<Response> {
    const input = RuntimeIdentitySchema.extend({ conversationId: z.string().optional() }).parse(raw);
    return (await this.getRuntime(input)).transcript(input.conversationId, format, RuntimeTranscriptRangeSchema.parse(range));
  }


  async runtimeDiscoverMcp(raw: unknown) {
    const input = RuntimeIdentitySchema.extend({ requestId: z.string().min(1), args: z.object({ connectionId: z.string().min(1) }) }).parse(raw);
    await this.runtimeAccess(input, true);
    return (await this.getRuntime(input)).manage({ tool: 'mcp_discover', requestId: input.requestId, args: input.args });
  }

  /** Machine-held workspace writes are refused once the workspace lives in the cloud. */
  private assertLegacyWriter(): void {
    if (this.cloudRuntime !== null) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_POSSESSION_DENIED', message: 'Legacy writers cannot modify a cloud-owned workspace', context: {} });
  }

  /** `space.events`: the authority record after `after`, bounded. */
  events(spaceId: string, after: number | null): StreamEvent<SpaceAuthorityRecord | null>[] {
    const state = this.get();
    if (state && state.spaceId !== spaceId) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_IDENTITY_MISMATCH', message: 'Space authority identity mismatch', context: { spaceId } });
    return this.changes.replay(`space:${spaceId}`, after, () => this.get(), false);
  }

  private commit<T>(mutate: () => T): SpaceAuthorityResult<T> {
    try {
      const value = this.ctx.storage.transactionSync(() => {
        this.assertLegacyWriter();
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


  private async flushPortableLfs(): Promise<void> {
    const state = this.get();
    if (!state) return;
    for (const row of this.ctx.storage.sql.exec<{ snapshot_id: string; inventory: string; attempts: number }>('SELECT snapshot_id,inventory,attempts FROM portable_lfs_outbox WHERE attempts<?', PORTABLE_LFS_MAX_ATTEMPTS).toArray()) {
      try {
        const retained = PortableLfsRetentionSchema.parse(JSON.parse(row.inventory));
        const project = this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${state.projectId}`);
        await project.lfsRetain(retained);
        if (retained.publicationId) await project.lfsReleasePublication(retained.publicationId);
        this.ctx.storage.sql.exec('DELETE FROM portable_lfs_outbox WHERE snapshot_id=? AND inventory=?', row.snapshot_id, row.inventory);
        await this.ctx.storage.sync();
      } catch (error) {
        // Retried with backoff, never by a throwing alarm; the last failure leaves the snapshot pending.
        this.ctx.storage.sql.exec('UPDATE portable_lfs_outbox SET attempts=attempts+1 WHERE snapshot_id=?', row.snapshot_id);
        console.error(JSON.stringify({ event: 'portable_lfs_retention_failed', snapshotId: row.snapshot_id, attempts: row.attempts + 1, message: error instanceof Error ? error.message : String(error) }));
        if (row.attempts + 1 < PORTABLE_LFS_MAX_ATTEMPTS) {
          await this.scheduleAlarm('lfs', Date.now() + Math.min(3_600_000, 1_000 * 2 ** row.attempts));
          return;
        }
      }
    }
    await this.scheduleAlarm('lfs', null);
  }

  async lfsRoots() {
    await readCurrentCheckpoint(this.ctx.storage);
    const attachmentTable = this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_attachments'").toArray().length > 0;
    const active = attachmentTable && this.ctx.storage.sql.exec<{ record: string }>('SELECT record FROM runtime_attachments').toArray().some(row => RuntimeAttachmentSchema.parse(JSON.parse(row.record)).state !== 'detached');
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
