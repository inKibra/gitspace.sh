import { SpaceAuthorityRecordSchema, WorkspaceDomainError, type SpaceAuthorityRecord, type SpaceAuthorityResult } from '@gitspace/protocol-workspace';
import { LiveChanges } from './live-changes.js';
import type { LiveNotice } from '@gitspace/protocol/live-notice';
import { notifyBrowsers } from './live-notices.js';
import { cloudImageDiscardReceiptSchema, type CloudImageDiscardReceipt } from '@gitspace/protocol/cloud-image';
import { DirectoryPublisher, type DirectoryPublication } from './account-directory.js';
import { RuntimeAttachmentSchema, RuntimeIdentitySchema, RuntimeProcessExitedInputSchema, RuntimeMachineIdSchema, RuntimeJsonSchema, RuntimeSubmitInputSchema, RuntimeCancelInputSchema, RuntimeAnswerInputSchema, RuntimeWatchInputSchema, type RuntimeAttachment, type RuntimeGitCheckpoint, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { RuntimeBrowsersDocumentSchema, type RuntimeBrowsersDocumentGroup } from '@gitspace/protocol-runtime';
import { BROWSER_GROUP_ROWS, retireWorkspaceBrowsers } from './runtime-browser.js';
import { refreshCloudEnvironment } from './cloud-environment.js';
import { ArtifactsCodeStore, artifactsProjectRepository, artifactsWorkspaceRepository, isAttachmentReady, isSupportedBranchName, CloudPublicationUncertain, readCurrentCheckpoint, readRuntimeLfsRoots, reconcileRuntimeLfsSources, type RuntimeAccepted, type WorkspaceRuntime } from '@gitspace/runtime-workspace-do';
import { createAccountWorkspaceRuntime, ensureProjectCodeRepository } from './account-runtime-host.js';
import { RuntimeSessionInputSchema } from '@gitspace/protocol-runtime/session-controls';
import { RuntimeTranscriptRangeSchema } from '@gitspace/runtime-core/history';
import { RuntimeDraftSaveInputSchema } from '@gitspace/protocol-runtime/draft';
import { RuntimeServiceInputSchema } from '@gitspace/protocol-runtime/services';
import { RuntimeSyncRequestInputSchema, RuntimeSyncRequestResultSchema, type RuntimeSyncRequestResult } from '@gitspace/protocol-runtime/tool-arguments';
import { runtimeServiceControl } from './runtime-service-control.js';
import { importRefThroughBaseMachine } from './runtime-ref-import.js';
import { RuntimeGitCheckpointSchema, RuntimeQaActionInputSchema, RuntimeSnapshotCommitInputSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { RuntimeAttachmentReadyInputSchema, RuntimeAssignmentsInputSchema, RuntimeCacheAttachmentRequestInputSchema, RuntimeAttachmentDetachRequestInputSchema } from '@gitspace/protocol-runtime/attachment-controls';
import { RuntimeHeartbeatInputSchema, RuntimeDetachInputSchema } from '@gitspace/protocol-runtime/machine-controls';
import { CheckoutSourceFactsSchema, RuntimeAttachmentController, executorCapabilities } from './runtime-attachments.js';
import { notifyLifecycleHolders, notifyMachines } from './machine-notices.js';
import { SpaceEnvironmentStore, type LostLifecycleHolder } from './space-environment.js';
import { committedBrowserOrigins } from './committed-browser-origins.js';
import { adoptWorkspaceMetadata, authorizeWorkspaceRuntime, createWorkspaceMetadataTables, projectAcceptsWrites, readWorkspaceMetadata, readWorkspaceReport, readWorkspaceStatus, writeSourceCheckpoint, writeWorkspaceMetadata, type WorkspaceMetadata } from './workspace-metadata.js';
import { projectProgress, startFromProject, type ProjectProgress } from './project-watch.js';
import { workspaceTurnReportSchema, type WorkspaceTurnReport } from '@gitspace/blocks';
import { z } from 'zod';
import type { CloudProjectSummary, CloudWorkspaceDefinition, ProjectLifecycle, WorkspaceLifecycle } from '@gitspace/protocol';
import { assertWorkspacePhase, type GitLfsConfirmedObject, type WorkspacePhase, type WorkspaceReport, type WorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import { RetainedLfsSnapshotSchema } from './git-lfs-retention.js';
import { LifecycleRunRequestSchema, LifecycleRunSchema, environmentFailure, type EnvironmentFailure, type LifecycleActor, type LifecycleMutation, type LifecycleRun, type LifecycleRunLog, type LifecycleState } from '@gitspace/protocol-environment';
import { forwardPosition } from './cloud-stack-status.js';
import { originAccess, originReadCredentials } from './origin-access.js';
import { BudgetedDurableObject } from './storage-quarantine.js';
import { WORKER_VERSION } from './tenant-releases.js';
const PortableLfsRetentionSchema = RetainedLfsSnapshotSchema.extend({ publicationId: z.string().optional() });
/** A legacy LFS retention that keeps failing stays pending (its objects stay retained) and stops retrying here. */
const PORTABLE_LFS_MAX_ATTEMPTS = 12;
type RuntimeIdentity = Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>;

/** How long a machine stays offline before its workspaces' conversations are told. */
const OFFLINE_NOTICE_MS = 60_000;
const OfflineMachinesSchema = z.record(z.string(), z.object({ since: z.number(), told: z.boolean() }));

/** Whether a base checkout at `commit` already holds the project's `tip` (true) or fast-forwards to it (false). One with
 * commits the tip lacks is never moved there: those commits would leave its branch. */
async function baseCheckoutHolds(code: ArtifactsCodeStore, repositories: readonly string[], commit: string, tip: string): Promise<boolean> {
  const position = await forwardPosition(code, repositories, commit, tip);
  if (position.kind === 'diverged') {
    throw new Error(position.ahead === null
      ? `GitSpace cannot tell whether the base workspace holds commits that ${tip.slice(0, 7)} lacks, so it was not moved`
      : `The base workspace has ${position.ahead} ${position.ahead === 1 ? 'commit' : 'commits'} that ${tip.slice(0, 7)} lacks, so it was not moved; push them to origin first`);
  }
  return position.kind === 'holds';
}

/** A sync failure reaches the conversation only once it has lasted this long. */
const SYNC_NOTICE_AFTER_MS = 5 * 60_000;
const SyncFailureRunSchema = z.object({ since: z.number(), noticed: z.boolean() });
/** How often an instance waiting to restart on a newer release checks whether its work has ended. */
const RELEASE_RESTART_CHECK_MS = 5_000;

export class SpaceAuthorityDO extends BudgetedDurableObject {
  private readonly changes: LiveChanges;
  private readonly environment: SpaceEnvironmentStore;
  private directory: DirectoryPublisher;
  private runtime: Promise<WorkspaceRuntime> | undefined;
  /** Loaded before any request; set once the space has cloud runtime state (see `hasCloudRuntime`). */
  private cloudRuntime: z.infer<typeof RuntimeIdentitySchema> | null = null;
  private cloudRuntimePublished = false;
  private alarmLine: Promise<void> = Promise.resolve();
  /** A newer release this instance's code predates: it restarts on that code once nothing is running. */
  private releaseRestart: { version: string; since: number; checking: boolean } | null = null;
  private seeding: Promise<WorkspaceMetadata> | undefined;
  /** Tabs learn of a committed change without the writer waiting for them. */
  private readonly liveNotify = (notices: LiveNotice[]) => { this.ctx.waitUntil(notifyBrowsers(this.env, notices)); };
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.changes = new LiveChanges(ctx.storage, this.liveNotify);
    this.environment = new SpaceEnvironmentStore(ctx.storage, this.changes);
    this.createTables();
    this.directory = new DirectoryPublisher(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const state = this.get();
      const identity = await this.ctx.storage.get('runtime.identity') ?? (state ? { projectId: state.projectId, workspaceId: state.spaceId } : null);
      this.cloudRuntime = identity !== null && await this.hasCloudRuntime() ? RuntimeIdentitySchema.parse(identity) : null;
      this.cloudRuntimePublished = await this.ctx.storage.get('directory.runtimePublished') === true;
      // Base-branch changes no longer keep a step list: a pending one is dropped once and is retried by its caller.
      await this.ctx.storage.delete('runtime.baseBranchChange');
      this.ctx.waitUntil(this.flushPortableLfs());
    });
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
    this.ctx.storage.sql.exec('DROP TABLE IF EXISTS base_branch_steps');
    this.ctx.storage.sql.exec("DELETE FROM runtime_alarms WHERE owner IN ('baseBranch','directory')");
    createWorkspaceMetadataTables(this.ctx.storage);
  }

  directoryPublication(): Extract<DirectoryPublication, { source: 'space' }> | null {
    const state = this.get();
    return state || this.cloudRuntime ? { source: 'space', cursor: this.directory.version(), state, runtime: this.cloudRuntime } : null;
  }

  /** The account directory learns once that this space is a cloud workspace; it then ignores the legacy placement. */
  private publishCloudRuntime(identity: z.infer<typeof RuntimeIdentitySchema>): void {
    this.cloudRuntime = identity;
    if (this.cloudRuntimePublished) return;
    this.cloudRuntimePublished = true;
    this.directory.publish({ source: 'space', state: this.get(), runtime: identity });
    void this.ctx.storage.put('directory.runtimePublished', true);
  }

  private scheduleAlarm(owner: string, timestamp: number | null): Promise<void> {
    if (timestamp === null) this.ctx.storage.sql.exec('DELETE FROM runtime_alarms WHERE owner=?', owner);
    // Runtime wakes from several sources (task wake, retention retry, code_search retry): a later request never postpones an earlier one.
    else this.ctx.storage.sql.exec("INSERT INTO runtime_alarms(owner,timestamp) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET timestamp=CASE WHEN owner='runtime' THEN MIN(timestamp,excluded.timestamp) ELSE excluded.timestamp END", owner, timestamp);
    const operation = this.alarmLine.then(async () => {
      const next = this.ctx.storage.sql.exec<{ timestamp: number | null }>('SELECT MIN(timestamp) AS timestamp FROM runtime_alarms').toArray()[0]?.timestamp ?? null;
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
    await this.flushPortableLfs();
    if (due.some(row => row.owner === 'presence-notice')) await this.noticeOfflineMachines();
    const wake = this.ctx.storage.sql.exec<{ timestamp: number }>("SELECT timestamp FROM runtime_alarms WHERE owner='runtime'").toArray()[0];
    if (wake && wake.timestamp <= Date.now()) {
      await this.scheduleAlarm('runtime', null);
      const identity = await this.ctx.storage.get<Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>>('runtime.identity');
      if (identity) await (await this.getRuntime(identity)).wake();
    }
    // A wake that was due and that its handler neither cleared nor moved has nothing to do: re-arming it would fire again
    // at once, forever (an empty outbox). It is dropped; a handler that has work
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

  /** The status summary this workspace's runtime last published, read without opening it (null before its first
   * publication). Only the one-time seed of the account's status rows reads it; views read those rows. */
  publishedStatus(): WorkspaceStatusSummary | null {
    return readWorkspaceStatus(this.ctx.storage);
  }

  /** The report this workspace's runtime published last, read without opening it; null before its first publication. */
  workspaceReport(): WorkspaceReport | null {
    return readWorkspaceReport(this.ctx.storage);
  }

  /** The project agent's instruction to this workspace: the turn it starts reports once to the project conversation. */
  async runtimeStartFromProject(raw: unknown, input: { name: string; requestId: string; text: string; onDone: 'quiet' | 'wake' }): Promise<RuntimeAccepted> {
    const identity = RuntimeIdentitySchema.parse(raw);
    const runtime = await this.getRuntime(identity);
    return startFromProject(this.ctx.storage, runtime, RuntimeSubmitInputSchema.parse({ ...identity, requestId: input.requestId, text: input.text }), { name: input.name, onDone: input.onDone });
  }

  /** The turn the project agent started here, for the project agent; the runtime opens only while that turn runs. */
  async projectProgress(raw: unknown): Promise<ProjectProgress> {
    const identity = RuntimeIdentitySchema.parse(raw);
    return projectProgress(this.ctx.storage, () => this.getRuntime(identity));
  }

  /** Base workspace only: a workspace's report of a turn the project agent started. */
  async runtimeWorkspaceReport(raw: unknown, report: WorkspaceTurnReport, onDone: 'quiet' | 'wake'): Promise<void> {
    const identity = RuntimeIdentitySchema.parse(raw);
    if (String(identity.workspaceId) !== String(identity.projectId)) throw new Error('Workspace reports go to the project base workspace');
    await (await this.getRuntime(identity)).workspaceReport(workspaceTurnReportSchema.parse(report), onDone);
  }

  /** Base workspace only: a line in the project conversation that does not start a turn. */
  async runtimeProjectNotice(raw: unknown, text: string): Promise<void> {
    const identity = RuntimeIdentitySchema.parse(raw);
    if (String(identity.workspaceId) !== String(identity.projectId)) throw new Error('Project notices go to the project base workspace');
    await (await this.getRuntime(identity)).notice(text, undefined, 'Project');
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

  /** Creation seeds the workspace with the definition it starts from, and with a source workspace's checkpoint when it
   * starts from one. Idempotent: an older definition or project state never replaces a newer one. */
  seedWorkspace(workspace: CloudWorkspaceDefinition, project: Pick<CloudProjectSummary, 'id' | 'lifecycle' | 'revision'>, sourceCheckpoint: RuntimeGitCheckpoint | null = null): WorkspaceMetadata {
    if (sourceCheckpoint) writeSourceCheckpoint(this.ctx.storage, sourceCheckpoint);
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
    if (!runtime.attachments.presence(RuntimeMachineIdSchema.parse(machineId), connected)) return;
    runtime.publish();
    // A deploy or network blip drops a machine for seconds: the conversation hears of an absence only once it lasts a
    // minute, and of the return only after it heard of the absence.
    const offline = await this.offlineMachines();
    if (!connected) {
      offline[machineId] = { since: Date.now(), told: false };
      await this.ctx.storage.put('presence.offline', offline);
      await this.scheduleAlarm('presence-notice', Date.now() + OFFLINE_NOTICE_MS);
      return;
    }
    const told = offline[machineId]?.told;
    delete offline[machineId];
    await this.ctx.storage.put('presence.offline', offline);
    if (told) await runtime.notice(`Machine ${await this.machineLabel(machineId)} is back online; commands can run on it again.`);
  }

  private async offlineMachines(): Promise<Record<string, { since: number; told: boolean }>> {
    return OfflineMachinesSchema.catch({}).parse(await this.ctx.storage.get('presence.offline') ?? {});
  }

  /** Tells the conversation about machines offline for a minute; a later one re-arms the alarm. */
  private async noticeOfflineMachines(): Promise<void> {
    const offline = await this.offlineMachines();
    const now = Date.now();
    const due = Object.entries(offline).filter(([, entry]) => !entry.told && entry.since + OFFLINE_NOTICE_MS <= now);
    if (due.length) {
      const runtime = await this.getRuntime(await this.ctx.storage.get('runtime.identity'));
      for (const [machineId, entry] of due) {
        await runtime.notice(`Machine ${await this.machineLabel(machineId)} went offline. Commands on it fail until it reconnects; attach another machine if this work cannot wait.`);
        entry.told = true;
      }
      await this.ctx.storage.put('presence.offline', offline);
    }
    const next = Math.min(...Object.values(offline).filter(entry => !entry.told).map(entry => entry.since + OFFLINE_NOTICE_MS));
    await this.scheduleAlarm('presence-notice', Number.isFinite(next) ? next : null);
  }

  private async machineLabel(machineId: string): Promise<string> {
    return (await this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID).getMachine(machineId))?.label ?? machineId;
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
      // Diagnostic for idle wakes (2026-10-22): remove once diagnosed.
      const openStartedAt = Date.now();
      const runtime = this.openRuntime(identity);
      this.runtime = runtime;
      // Diagnostic for idle wakes (2026-10-22): remove once diagnosed. A failed open is reported by the chain below.
      runtime.then(() => {
        const durationMs = Date.now() - openStartedAt;
        if (durationMs >= 5_000) console.warn(JSON.stringify({ event: 'runtime_cold_open', workspaceId: identity.workspaceId, durationMs }));
      }, () => {});
      // A storage error ends the session for good: forget it so the next call opens a fresh one from what was committed.
      runtime.then(opened => opened.harness.closed.then(end => {
        if (end.reason !== 'failed' || this.runtime !== runtime) return;
        this.runtime = undefined;
        console.error(JSON.stringify({ event: 'runtime_session_failed', workspaceId: identity.workspaceId, error: end.error instanceof Error ? end.error.message : String(end.error) }));
      }), () => { if (this.runtime === runtime) this.runtime = undefined; });
    }
    return this.runtime;
  }

  /** Running work an immediate restart would cut off: a live foreground pi task (a generation, a tool, the next round
   * between them) or a marked step (sync merge, cloud write). Read from storage, not the status summary, which a
   * rebuild updates later. An instance that never opened its runtime runs neither. */
  private async running(): Promise<boolean> {
    if (!this.runtime) return false;
    if (!(await this.runtime.catch(() => null))) return false;
    return this.ctx.storage.sql.exec("SELECT id FROM tasks WHERE status != 'terminal' AND background = 0 LIMIT 1").toArray().length > 0
      || this.ctx.storage.sql.exec('SELECT id FROM runtime_running LIMIT 1').toArray().length > 0;
  }

  /**
   * A release went live. Cloudflare keeps a resident instance on the code it started with and swaps it minutes later
   * whatever it is doing then, cutting off turns started meanwhile; an older instance restarts on the new code now
   * when nothing is running, otherwise as soon as its running work ends.
   */
  async restartForRelease(version: string): Promise<'current' | 'restarting' | 'when-idle'> {
    if (WORKER_VERSION === undefined || version === WORKER_VERSION) return 'current';
    // A second release while this one waits replaces the version it restarts for, not the wait.
    this.releaseRestart = { version, since: this.releaseRestart?.since ?? Date.now(), checking: this.releaseRestart?.checking ?? false };
    const restart = this.releaseRestart;
    const restartWhenIdle = async (): Promise<boolean> => {
      if (await this.running()) return false;
      console.info(JSON.stringify({ event: 'release_restart', workspaceId: this.get()?.spaceId ?? this.cloudRuntime?.workspaceId ?? null, from: WORKER_VERSION, to: restart.version, waitedMs: Date.now() - restart.since }));
      // After this call has answered, so the release sees the outcome.
      setTimeout(() => this.ctx.abort(`Restarting on release ${restart.version}`), 0);
      return true;
    };
    if (await restartWhenIdle()) return 'restarting';
    if (!restart.checking) {
      restart.checking = true;
      const check = () => setTimeout(() => { void restartWhenIdle().then(restarted => { if (!restarted) check(); }); }, RELEASE_RESTART_CHECK_MS);
      check();
    }
    return 'when-idle';
  }

  /** Agents request attachments through the same path a person's cache request takes. */
  private openRuntime(identity: RuntimeIdentity): Promise<WorkspaceRuntime> {
    return createAccountWorkspaceRuntime(this.ctx, this.env, identity, timestamp => this.scheduleAlarm('runtime', timestamp), machineId => this.runtimeCacheAttachmentRequest({ ...identity, machineId }), this);
  }

  async runtimeSnapshot(raw: unknown): Promise<Response> { return Response.json(await (await this.getRuntime(raw)).snapshot()); }
  /** Attachment records for authorizing a machine, read without starting the runtime: every git authentication asks,
   * and an idle workspace must not wake for it. An object without runtime state has none. */
  async runtimeAttachmentRecords(raw: unknown): Promise<RuntimeAttachment[]> {
    const identity = RuntimeIdentitySchema.parse(raw);
    const stored = await this.ctx.storage.get('runtime.identity');
    if (stored === undefined) return [];
    const runtime = RuntimeIdentitySchema.parse(stored);
    if (runtime.projectId !== identity.projectId || runtime.workspaceId !== identity.workspaceId) throw new Error('Runtime actor identity mismatch');
    return this.storedAttachments();
  }
  async runtimeCodeCheckpoint(raw: unknown) {
    const identity = RuntimeIdentitySchema.parse(raw);
    const authority = this.get();
    if (authority && (authority.projectId !== identity.projectId || authority.spaceId !== identity.workspaceId)) throw new Error('Checkpoint workspace identity mismatch');
    const stored = await this.ctx.storage.get('runtime.identity');
    if (stored !== undefined) {
      const previous = RuntimeIdentitySchema.parse(stored);
      if (previous.projectId !== identity.projectId || previous.workspaceId !== identity.workspaceId) throw new Error('Checkpoint runtime identity mismatch');
    }
    return readCurrentCheckpoint(this.ctx.storage);
  }

  /** The base checkout, its Git refs and the project's branch change in one run of the checkout's queue: cloud edits
   * and cache publications wait for it rather than being refused. Every step is repeatable, so a failed change is
   * reported and running it again finishes it. Dirty state, agents and live caches are rejected first. The current
   * branch refreshes the checkout instead: after Update base moved the project's copy forward, a checkout behind it
   * fast-forwards to it, one already holding it is left untouched, and one with commits the copy lacks never moves. */
  async runtimeSetBaseBranch(raw: unknown, expectedRevision: number, branch: string): Promise<CloudProjectSummary> {
    const identity = RuntimeIdentitySchema.parse(raw);
    if (!isSupportedBranchName(branch)) throw new Error('Invalid base branch');
    const projectId: string = identity.projectId;
    if (identity.workspaceId !== projectId) throw new Error('Base branch changes require the project base workspace');
    const authority = this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`);
    const project = await authority.getProject();
    if (!project) throw new Error('Project is unavailable');
    if (project.role === 'gitspace-source') throw new Error('The built-in GitSpace project base branch is managed by GitSpace releases');
    const code = new ArtifactsCodeStore(this.env.ARTIFACTS);
    const repository = artifactsWorkspaceRepository(identity.workspaceId);
    const source = artifactsProjectRepository(project.id);
    // Commit IDs are content addresses: the checkout's repository and the project's together hold both graphs.
    const repositories = [repository, source];
    const refresh = project.baseBranch === branch;
    const action = refresh ? 'moving it forward' : 'changing its branch';
    if (refresh) {
      // A base workspace with no committed checkout yet has nothing to move; its project repository may not exist yet.
      const committed = (await readCurrentCheckpoint(this.ctx.storage))?.headCommit;
      const tip = committed ? await code.resolveRef(source, `refs/heads/${branch}`) : null;
      if (!committed || tip === null || await baseCheckoutHolds(code, repositories, committed, tip)) return this.env.USER_PROJECTS.getByName(this.env.ACCOUNT_ID).put(project);
    } else if (project.revision !== expectedRevision) throw new Error(`Project revision conflict: expected ${expectedRevision}, actual ${project.revision}`);
    if (project.lifecycle !== 'active') throw new Error('Project must be active to change its base branch');
    authorizeWorkspaceRuntime(await this.metadata(identity), identity, false);
    const runtime = await this.loadRuntime(identity);
    const snapshot = await runtime.snapshot();
    if (snapshot.conversations.some(conversation => conversation.status === 'running' || conversation.status === 'waiting')) throw new Error(`Stop the base workspace agent before ${action}`);
    await ensureProjectCodeRepository(this.env, code, project);
    const reference = project.repositoryReference;
    const head = await code.resolveRef(source, `refs/heads/${branch}`)
      ?? (reference === null ? null : await originAccess(this.env, reference).then(access => code.importSourceRef(project.id, access.remote, `refs/heads/${branch}`, originReadCredentials(access))));
    if (!head) throw new Error(`Branch ${branch} does not exist in the project repository`);
    const metadata = await code.readCommit(source, head);
    if (!metadata) throw new Error('Base branch commit is unavailable');
    const target = RuntimeGitCheckpointSchema.parse({
      checkpointRef: `refs/gitspace/spaces/${identity.workspaceId}/checkpoints`, branch, headCommit: head,
      indexCommit: head, trackedWorktreeCommit: head, worktreeCommit: head, indexTree: metadata.treeHash, worktreeTree: metadata.treeHash,
    });
    let previous: z.infer<typeof RuntimeGitCheckpointSchema> | undefined;
    let previousBranchTip: string | null = null;
    const result = await runtime.cloudFiles.changeBranch({
      checkpoint: target,
      validate: async current => {
        // A change that already switched the checkout and failed later finishes from there.
        if (current.worktreeCommit === target.worktreeCommit) return;
        const currentHead = current.headCommit ? await code.readCommit(repository, current.headCommit) : null;
        if (!currentHead || current.indexTree !== currentHead.treeHash || current.worktreeTree !== currentHead.treeHash || current.conflicts?.length || current.lfs?.heldBack.length) throw new Error(`Base workspace has uncommitted changes; commit or discard them before ${action}`);
        if (refresh && current.headCommit && await baseCheckoutHolds(code, repositories, current.headCommit, head)) throw new Error(`The base workspace moved past ${head.slice(0, 7)} during the update`);
      },
      prepare: async current => {
        previous = current;
        previousBranchTip = await code.resolveRef(repository, `refs/heads/${branch}`);
        // The workspace's branch never loses commits it holds beyond its checkout either.
        if (refresh && previousBranchTip !== null && previousBranchTip !== current.headCommit && await baseCheckoutHolds(code, repositories, previousBranchTip, head)) throw new Error(`The base workspace's ${branch} already holds ${head.slice(0, 7)}`);
      },
      publish: async () => {
        if (!previous) throw new Error('Base branch change has no prepared checkout');
        await code.copyCommit(source, repository, `refs/heads/${branch}`, head, previousBranchTip);
        await code.copyCommit(source, repository, target.checkpointRef, head, previous.worktreeCommit);
      },
      commit: async () => {
        const latest = await authority.getProject();
        if (!latest || (latest.baseBranch !== project.baseBranch && latest.baseBranch !== branch)) throw new Error('Project base branch changed during checkout publication');
        const updated = latest.baseBranch === branch ? latest : await authority.setBaseBranch(latest.revision, branch, head);
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
  /** A workspace leaving active use: its working conversations stop, every live attachment is asked to drain and detach,
   * and its Chrome groups end. Draining is recorded here; a machine finishes it when it next reports, or its lease
   * expires. Never opens a runtime that has no state. */
  private async stopRuntime(identity: RuntimeIdentity): Promise<void> {
    if (await this.ctx.storage.get('runtime.identity') === undefined) return;
    await this.retireBrowsers(identity);
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

  /** Ends this workspace's Chrome groups. A relay that cannot be reached leaves the tabs in their group; the
   * workspace's own revocation already ends their authority, so this never blocks leaving active use. */
  private async retireBrowsers(identity: RuntimeIdentity): Promise<void> {
    await retireWorkspaceBrowsers(this.ctx.storage, this.env.RELAY.getByName(this.env.RELAY_NAME), identity).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_retire_failed', workspaceId: identity.workspaceId, error: String(error) })));
  }

  /** The relay's report of one of this workspace's Chrome groups, kept as a row for `gitspace.browsers`. A running
   * runtime republishes; one asleep reads the row when it next opens. */
  async browserGroupReported(raw: unknown, group: RuntimeBrowsersDocumentGroup): Promise<void> {
    const identity = RuntimeIdentitySchema.parse(raw);
    const current = await this.metadata(identity);
    if (current.lifecycle !== 'active' || await this.ctx.storage.get(`runtime.browser.revoked:${group.groupId}`)) return;
    await this.ctx.storage.put(`${BROWSER_GROUP_ROWS}${group.groupId}`, RuntimeBrowsersDocumentSchema.shape.chrome.element.parse(group));
    (await this.runtime?.catch(() => undefined))?.publish();
  }

  /** Permanent deletion of this workspace's runtime, attachments and placement. The tombstone is written before and
   * survives the erase, so nothing reopens what this removes and an interrupted deletion resumes. */
  private async erase(tombstone: WorkspaceMetadata): Promise<void> {
    writeWorkspaceMetadata(this.ctx.storage, tombstone);
    await this.retireBrowsers({ projectId: tombstone.projectId, workspaceId: tombstone.workspaceId });
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
    this.createTables();
    this.directory = new DirectoryPublisher(this.ctx, this.env);
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
    const recorded = await this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${applied.projectId}`).commitWorkspaceLifecycle(applied.workspaceId, lifecycle);
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
    const recorded = await project.commitWorkspacePhase(identity.workspaceId, phase);
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
    const detached: EnvironmentFailure = { code: 'RunnerUnavailable', message: `Machine ${input.machineId} is not attached to this workspace; attach it to run environment phases there`, context };
    if (await this.ctx.storage.get('runtime.identity') === undefined) return { status: 'error', failure: detached };
    const runtime = await this.getRuntime(input);
    // Setup runs are what make a checkout ready, so an attaching one accepts them too.
    if (!runtime.attachments.list().some(item => item.machineId === input.machineId && (isAttachmentReady(item) || item.state === 'attaching'))) return { status: 'error', failure: detached };
    // Absent optional fields cross Worker RPC as undefined, which is not JSON.
    const args = RuntimeJsonSchema.parse(Object.fromEntries(Object.entries({ ...input.request, on: input.machineId }).filter(([, value]) => value !== undefined)));
    const result = await runtime.manage({ tool: 'lifecycle', requestId: `environment:${input.request.runId}:${crypto.randomUUID()}`, args });
    const text = result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n');
    if (result.status === 'completed') return { status: 'ok', run: LifecycleRunSchema.parse(JSON.parse(text)) };
    return { status: 'error', failure: result.status === 'failed'
      ? { code: 'ExecutionFailed', message: result.error.message, context }
      : { code: 'Interrupted', message: text || 'The environment run was interrupted before its machine accepted it', context } };
  }
  private environmentImport: Promise<void> | undefined;
  /** Checks access, then on the first access imports the rows the project object held for this workspace before
   * environments moved into workspace objects (one-time). */
  private async environmentReady(raw: unknown) {
    const identity = RuntimeIdentitySchema.parse(raw);
    await this.runtimeAccess(identity, false);
    const project = this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${identity.projectId}`);
    if (!this.environment.present()) {
      this.environmentImport ??= (async () => {
        await this.environment.import(identity.projectId, identity.workspaceId, await project.exportEnvironment(identity.workspaceId), after => project.exportEnvironmentLogs(identity.workspaceId, after));
        await project.forgetEnvironment(identity.workspaceId);
      })().finally(() => { this.environmentImport = undefined; });
      await this.environmentImport;
    }
    return { identity, project };
  }
  async getLifecycleState(raw: unknown): Promise<LifecycleState> {
    const { identity, project } = await this.environmentReady(raw);
    return this.environment.get(identity.projectId, identity.workspaceId, await project.environmentShared());
  }
  /** The stored environment, derived again first when the workspace's files or selected profile changed since it was
   * last derived. A workspace with no cloud checkout yet has nothing to derive from. */
  async currentLifecycleState(raw: unknown): Promise<LifecycleState> {
    const { identity, project } = await this.environmentReady(raw);
    const stored = this.environment.get(identity.projectId, identity.workspaceId, await project.environmentShared());
    if (!await this.hasCloudRuntime()) return stored;
    const checkpoint = await this.runtimeRepositoryCheckpoint(identity);
    const source = (state: LifecycleState) => `${checkpoint.worktreeCommit}:${state.selectedProfile ?? ''}`;
    if (this.environment.derivedFrom() === source(stored)) return stored;
    const state = await refreshCloudEnvironment({ code: new ArtifactsCodeStore(this.env.ARTIFACTS), environment: this, identity, checkpoint });
    this.environment.markDerived(source(state));
    return state;
  }
  /** Re-derives the browser origins the workspace's committed HEAD declares. */
  async refreshBrowserOrigins(raw: unknown): Promise<LifecycleState> {
    const { identity, project } = await this.environmentReady(raw);
    const shared = await project.environmentShared();
    const summary = await project.getProject();
    const metadata = readWorkspaceMetadata(this.ctx.storage);
    if (!summary || !metadata) throw new Error('Committed environment workspace is unavailable');
    const code = new ArtifactsCodeStore(this.env.ARTIFACTS);
    try {
      await ensureProjectCodeRepository(this.env, code, summary);
      await code.forkWorkspace(summary.id, identity.workspaceId);
      const { origins } = await committedBrowserOrigins({
        code, repository: artifactsWorkspaceRepository(identity.workspaceId), branch: metadata.branch,
        checkpoint: () => this.runtimeCodeCheckpoint(identity),
      });
      const result = this.environment.setBrowserOrigins(identity.projectId, identity.workspaceId, origins, shared);
      if (result.shared) await project.applyEnvironmentShared(result.shared);
      return result.state;
    } catch (error) {
      // Unavailable is not an observed removal: retain membership and approvals.
      this.environment.markBrowserOriginsUnavailable(identity.projectId, identity.workspaceId, shared);
      throw error;
    }
  }
  async mutateLifecycleState(raw: unknown, input: LifecycleMutation, actor: LifecycleActor): Promise<{ status: 'ok'; state: LifecycleState } | { status: 'error'; failure: EnvironmentFailure }> {
    const { identity, project } = await this.environmentReady(raw);
    try {
      const result = this.environment.mutate(identity.projectId, identity.workspaceId, input, actor, await project.environmentShared());
      if (result.shared) await project.applyEnvironmentShared(result.shared);
      this.ctx.waitUntil(notifyLifecycleHolders(this.env, identity.workspaceId, result.state, actor.machineId));
      return { status: 'ok', state: result.state };
    } catch (error) {
      const failure = environmentFailure(error);
      if (failure) return { status: 'error', failure };
      throw error;
    }
  }
  /** Called once the cloud knows the holder is gone (destroyed or revoked): its runs end as interrupted. */
  async releaseLostLifecycleClaims(raw: unknown, holder: LostLifecycleHolder): Promise<string[]> {
    const { identity } = await this.environmentReady(raw);
    const actor: LifecycleActor = { actorId: 'cloud:attachment-lease', machineId: 'cloud:attachment-lease', kind: 'client', lifecycleControl: true };
    const runs = this.environment.lostRuns(holder);
    for (const runId of runs) await this.mutateLifecycleState(identity, { op: 'interrupt', runId, reason: `Its ${holder.attachment ? 'attachment' : 'machine'} was lost (${holder.reason})` }, actor);
    return runs;
  }
  async getLifecycleRunLog(raw: unknown, runId: string, offset = 0): Promise<LifecycleRunLog> {
    await this.environmentReady(raw);
    return this.environment.runLog(runId, offset);
  }
  /** Resolves when the run ends; the workspace's own runtime waits on it in-process. */
  async lifecycleRunEnded(raw: unknown, runId: string, signal?: AbortSignal): Promise<LifecycleRun> {
    await this.environmentReady(raw);
    return this.environment.ended(runId, signal);
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
  /** Base workspace only: one origin ref imported through a machine holding the base checkout; returns its commit. */
  async runtimeImportRef(raw: unknown, ref: string): Promise<string> {
    const identity = RuntimeIdentitySchema.parse(raw);
    return importRefThroughBaseMachine(await this.getRuntime(identity), identity, ref);
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
    // The failing step is logged with the error: callers see only its message, often the runtime's bare "internal error".
    let step = 'open runtime';
    // Diagnostic for idle wakes (2026-10-22): remove once diagnosed.
    const startedAt = Date.now();
    let openedAt: number | null = null;
    let verifiedAt: number | null = null;
    try {
      const runtime = await this.getRuntime(input);
      openedAt = Date.now();
      step = 'verify published commits';
      const code = new ArtifactsCodeStore(this.env.ARTIFACTS);
      const repository = artifactsWorkspaceRepository(input.workspaceId);
      const commits = new Set([input.checkpoint.indexCommit, input.checkpoint.trackedWorktreeCommit, input.checkpoint.worktreeCommit]);
      if (input.checkpoint.headCommit !== null) commits.add(input.checkpoint.headCommit);
      await Promise.all([...commits].map(async commit => {
        if (!await code.readCommit(repository, commit)) throw new Error('Checkpoint commit was not published');
      }));
      verifiedAt = Date.now();
      step = 'commit snapshot';
      return await runtime.snapshotCommit(input);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'snapshot_commit_failed', step, workspaceId: input.workspaceId, attachmentId: input.attachmentId, worktreeCommit: input.checkpoint.worktreeCommit,
        error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack ?? null : null,
      }));
      throw error;
    } finally {
      // Diagnostic for idle wakes (2026-10-22): remove once diagnosed.
      const endedAt = Date.now();
      if (endedAt - startedAt >= 10_000) console.warn(JSON.stringify({
        event: 'snapshot_commit_slow', workspaceId: input.workspaceId, attachmentId: input.attachmentId, step, durationMs: endedAt - startedAt,
        openMs: (openedAt ?? endedAt) - startedAt, verifyMs: openedAt === null ? null : (verifiedAt ?? endedAt) - openedAt, commitMs: verifiedAt === null ? null : endedAt - verifiedAt,
      }));
    }
  }

  private async attachmentController(raw: unknown) {
    const runtime = await this.getRuntime(raw);
    return new RuntimeAttachmentController({
      attachments: runtime.attachments, code: new ArtifactsCodeStore(this.env.ARTIFACTS), publish: () => runtime.publish(),
      // The stored checkpoint; only a workspace that has none yet initializes it (and waits on its retention flush).
      snapshot: async () => await runtime.cloudFiles.snapshot() ?? runtime.cloudFiles.initializeSnapshot(),
      origin: async projectId => (await this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).getProject())?.repositoryReference ?? null,
      // The worker authenticated this machine's request; only fleet membership is checked here.
      authorizeMachine: async machineId => {
        const machine = await this.env.FLEET_CATALOG.getByName(this.env.ACCOUNT_ID).getMachine(machineId);
        if (!machine || machine.desiredState === 'removed') throw new Error('Attachment target is not an enrolled account machine');
      },
      sourceFacts: {
        read: async () => CheckoutSourceFactsSchema.nullable().catch(null).parse(await this.ctx.storage.get('assignment.source') ?? null),
        write: facts => this.ctx.storage.put('assignment.source', facts),
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

  async runtimeProcessExited(raw: unknown): Promise<null> {
    const input = RuntimeProcessExitedInputSchema.parse(raw);
    await (await this.getRuntime(input)).processExited(input.daemon);
    return null;
  }
  async runtimeAssignments(raw: unknown) {
    const identity = RuntimeIdentitySchema.parse(raw);
    const input = RuntimeAssignmentsInputSchema.parse(raw);
    if (await this.ctx.storage.get('runtime.identity') === undefined) return { assignments: [] };
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
    const previous = runtime.attachments.list().find(item => item.attachmentId === input.attachmentId);
    const before = visible(previous);
    const attachment = runtime.attachments.observe(input);
    if (visible(attachment) !== before) runtime.publish();
    // What the machine reports going wrong reaches the conversation once, when it first appears.
    const failedSetup = (attachment.cache?.setup ?? []).filter(step => step.state === 'failed' && !previous?.cache?.setup.some(prior => prior.phase === step.phase && prior.state === 'failed' && prior.runId === step.runId));
    const syncProblem = await this.lastingSyncProblem(input.attachmentId, input.generation, attachment.cache?.syncProblem ?? null);
    if (failedSetup.length || syncProblem) {
      const label = await this.machineLabel(input.machineId);
      for (const step of failedSetup) await runtime.notice(`Setup on ${label} failed at ${step.phase}${step.error ? `: ${step.error}` : ''}. Commands that need it wait until setup runs again.`);
      if (syncProblem) await runtime.notice(`Sync with ${label} failed: ${syncProblem}`);
    }
    return { attachment };
  }

  /** The problem to announce, once, when a checkout's sync has been failing for SYNC_NOTICE_AFTER_MS. Most failures are
   * transient (a provider error, a restart) and clear on the next retry; they stay visible as the sync status only.
   * The machine reports each retry, so its reports are the clock. */
  private async lastingSyncProblem(attachmentId: string, generation: number, problem: string | null): Promise<string | null> {
    const key = `runtime.sync-failing:${attachmentId}:${generation}`;
    const run = SyncFailureRunSchema.nullable().parse(await this.ctx.storage.get(key) ?? null);
    if (problem === null) {
      if (run) await this.ctx.storage.delete(key);
      return null;
    }
    if (!run) { await this.ctx.storage.put(key, { since: Date.now(), noticed: false }); return null; }
    if (run.noticed || Date.now() - run.since < SYNC_NOTICE_AFTER_MS) return null;
    await this.ctx.storage.put(key, { ...run, noticed: true });
    return problem;
  }

  async runtimeDetach(raw: unknown) {
    const input = RuntimeDetachInputSchema.parse(raw);
    const runtime = await this.getRuntime(input);
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


  private commit<T>(mutate: () => T): SpaceAuthorityResult<T> {
    try {
      const value = this.ctx.storage.transactionSync(() => {
        this.assertLegacyWriter();
        const value = mutate();
        const state = this.get();
        if (state) this.changes.mark(`space:${state.spaceId}`);
        return value;
      });
      const state = this.get();
      if (state) this.directory.publish({ source: 'space', state, runtime: this.cloudRuntime });
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
