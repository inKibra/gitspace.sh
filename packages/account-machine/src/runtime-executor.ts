import { mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { ExecutorJournal, MachineExecutor, MachineBrowser, runSupervisorCommand, prepareMachineAttachment, type MachineBrowserOptions } from '@gitspace/runtime-machine';
import { RuntimeGitCheckpointSchema, RuntimeAssignmentSchema, RuntimeAssignmentsResultSchema, RuntimeAttachmentReadyResultSchema, RuntimeHeartbeatInputSchema, RuntimeBrowserPublicKeySchema, RuntimeCacheObservationSchema, RuntimeJsonSchema, browserUnbase64, verifyRuntimeBrowserAuthorization, RuntimeSyncMachineArgumentsSchema, RuntimeSyncMachineCaptureSchema, RuntimeSyncMachineDiffSchema, RuntimeSyncMachineDiscardSchema, RuntimeSyncMachineRestoreSchema, RuntimeSyncMachineStatusSchema, type RuntimeToolDispatch, type RuntimeAttachment, type RuntimeAttachmentFailure, type RuntimeCacheObservation } from '@gitspace/protocol-runtime';
import { z } from 'zod';
import type { CloudRuntimeClient } from './cloud-runtime-client.js';
import { Database } from 'bun:sqlite';
import { IncrementalGitSnapshots, createGitIntermediateCheckpoint, gitTreeChanges, gitTreePatch, readGitWorktreeSnapshot, resetGitWorktree, mergeGitBackupIntoWorktree, deleteGitRef, restoreGitIntermediateCheckpoint, applyGitCacheCheckpoint, gitCheckpointIncludes, readGitCacheBase, saveGitCacheBase, gitCheckpointRejectionError } from './git-checkpoint.js';
import type { GitIntermediateCheckpoint, GitCheckpointRejection } from './git-checkpoint.js';
import { artifactsPublicationRejection, type ArtifactsGitRemote } from './artifacts-git-remote.js';
import { spaceGitCheckpointRef } from '@gitspace/protocol-workspace';
import type { LocalAttachment, ExecutorOperationHandler, ExecutorContent } from '@gitspace/runtime-machine';
import { createArtifactsCredentialHelper } from './artifacts-credential-helper.js';
import { daemonClientForProject } from '@gitspace/supervisor';
import { checkoutGitLfs, gitLfsRestoreReceipt, hydrateGitLfs, type MachineGitLfsAccess } from './git-lfs.js';
import { gitWorktreeClock, gitWorktreeEvents, watchGitWorktree, type GitWorktreeClock, type GitWorktreeEvents } from './git-worktree-watch.js';

type RuntimeAssignment = z.infer<typeof RuntimeAssignmentSchema>;
const PendingSnapshotSchema = z.object({ checkpoint: RuntimeGitCheckpointSchema, base: z.string().nullable() });

/** Names the attachment operation a failure interrupted, so the recorded failure says what failed. */
class AttachmentOperationFailure extends Error {
  constructor(readonly operation: RuntimeAttachmentFailure['operation'], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}
const failedDuring = (operation: RuntimeAttachmentFailure['operation']) => (error: unknown): never => {
  throw error instanceof AttachmentOperationFailure ? error : new AttachmentOperationFailure(operation, error);
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export type MachineExecutorRuntime = { executor: MachineExecutor; journal: ExecutorJournal; sync(workspaceId?: string): Promise<void>; drainWorkspace(workspaceId: string): Promise<void>; useWorkspace(workspaceId: string): Promise<void>; close(): Promise<void> };
export async function createMachineExecutor(options: {
  environmentRoot: string; machineId: string; cloud: CloudRuntimeClient;
  managedSpaceRoot?: string;
  gitRemote: ArtifactsGitRemote;
  lfs?: MachineGitLfsAccess;
  operations?: Record<string, ExecutorOperationHandler>;
  browser?: Pick<MachineBrowserOptions, 'enabled' | 'services'>;
  commitSnapshot(local: LocalAttachment, checkpoint: GitIntermediateCheckpoint, previousWorktreeCommit: string | null): Promise<GitIntermediateCheckpoint>;
  prepareAttachment(local: LocalAttachment, signal: AbortSignal, progress: (step: RuntimeCacheObservation['setup'][number]) => Promise<void>): Promise<void>;
  artifactFsBinary?: string;
  checkpointClock?: GitWorktreeClock;
  checkpointEvents?: GitWorktreeEvents;
}): Promise<MachineExecutorRuntime> {
  const directory = join(options.environmentRoot, 'executor');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const journal = new ExecutorJournal(join(directory, 'attempts.sqlite'));
  const credentialHelper = await createArtifactsCredentialHelper(join(directory, 'credentials'), options.cloud);
  const stopping = new AbortController();
  const snapshots = new Database(join(directory, 'snapshots.sqlite'));
  snapshots.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS snapshots (attachment TEXT PRIMARY KEY, revision INTEGER NOT NULL, pending TEXT, committed TEXT)');
  snapshots.exec('CREATE TABLE IF NOT EXISTS snapshot_rejections (attachment TEXT PRIMARY KEY, rejection TEXT NOT NULL); DROP TABLE IF EXISTS attachment_failures');
  const keyOf = (attachment: RuntimeAttachment) => `${attachment.attachmentId}:${attachment.generation}`;
  const snapshotRow = (key: string) => snapshots.query<{ committed: string | null; pending: string | null }, [string]>('SELECT committed,pending FROM snapshots WHERE attachment=?').get(key);
  const committedOf = (key: string) => {
    const row = snapshotRow(key);
    return row?.committed ? RuntimeGitCheckpointSchema.parse(JSON.parse(row.committed)) : null;
  };
  const rejectedSnapshot = (key: string): GitCheckpointRejection | null => {
    const row = snapshots.query<{ rejection: string }, [string]>('SELECT rejection FROM snapshot_rejections WHERE attachment=?').get(key);
    return row ? JSON.parse(row.rejection) as GitCheckpointRejection : null;
  };
  const saveRejectedSnapshot = (key: string, rejection: GitCheckpointRejection | null) => {
    snapshots.transaction(() => {
      if (rejection) {
        snapshots.query('INSERT OR REPLACE INTO snapshot_rejections(attachment,rejection) VALUES(?,?)').run(key, JSON.stringify(rejection));
        snapshots.query('UPDATE snapshots SET pending=NULL WHERE attachment=?').run(key);
      } else snapshots.query('DELETE FROM snapshot_rejections WHERE attachment=?').run(key);
    })();
  };
  const retryRejected = new Set<string>();
  const captures = new Map<string, IncrementalGitSnapshots>();
  const captureAborts = new Map<string, AbortController>();
  /** Drops a capture stream without waiting, since a stuck upload never settles. What it has in flight can no longer
   * save or commit, and its pending snapshot is forgotten; the files are still on disk for the next capture. */
  const abandonCapture = (key: string) => {
    captureAborts.get(key)?.abort(new Error('Capture abandoned by sync'));
    captureAborts.delete(key);
    captures.delete(key);
    snapshots.query('UPDATE snapshots SET pending=NULL WHERE attachment=?').run(key);
  };
  const clock = options.checkpointClock ?? gitWorktreeClock;
  const lfs = options.lfs;
  const watchers = new Map<string, { close(): void }>();
  const subscriptions = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  const cacheFor = (local: LocalAttachment): RuntimeCacheObservation => local.attachment.cache ?? RuntimeCacheObservationSchema.parse({ state: 'live', platform: process.platform, lastSyncAt: null, setup: [] });
  const saveCache = (local: LocalAttachment, cache: RuntimeCacheObservation): LocalAttachment => {
    const current = journal.attachment(local.attachment.attachmentId) ?? local;
    const updated = { ...current, attachment: { ...current.attachment, cache } };
    journal.installAttachment(updated);
    return updated;
  };
  const synced = (local: LocalAttachment) => saveCache(local, { ...cacheFor(journal.attachment(local.attachment.attachmentId) ?? local), lastSyncAt: new Date().toISOString(), unsent: 0 });
  const stopFollowing = async (local: LocalAttachment) => {
    watchers.get(local.rootPath)?.close();
    watchers.delete(local.rootPath);
    const subscription = subscriptions.get(keyOf(local.attachment));
    subscription?.controller.abort();
    await subscription?.settled;
  };
  const install = async (local: LocalAttachment, previous: GitIntermediateCheckpoint, checkpoint: GitIntermediateCheckpoint, incoming = false) => {
    await options.gitRemote.fetchCheckpoint({ binding: { projectId: local.attachment.projectId, repository: `workspace-${local.attachment.workspaceId}` }, repositoryPath: local.rootPath, checkpointRef: checkpoint.checkpointRef, commit: checkpoint.worktreeCommit });
    if (incoming && await gitCheckpointIncludes(local.rootPath, previous, checkpoint)) return false;
    await applyGitCacheCheckpoint({ repositoryPath: local.rootPath, previous, checkpoint, lfs: await lfs?.read(local.attachment.projectId) });
    return true;
  };
  const capture = async (local: LocalAttachment): Promise<GitIntermediateCheckpoint | null> => {
    if (local.attachment.state === 'detached') return null;
    stopping.signal.throwIfAborted();
    const key = keyOf(local.attachment);
    let stream = captures.get(key);
    if (!stream) {
      snapshots.query('INSERT OR IGNORE INTO snapshots (attachment, revision) VALUES (?, ?)').run(key, Date.now());
      const abort = new AbortController();
      captureAborts.set(key, abort);
      stream = new IncrementalGitSnapshots({
        repositoryPath: local.rootPath,
        spaceId: local.attachment.workspaceId,
        captureId: `cache-${createHash('sha256').update(`${options.machineId}:${key}`).digest('hex')}`,
        lfs: lfs && (publicationId => lfs.publish(local.attachment.projectId, publicationId)),
        // One full second of stable dirty-path metadata coalesces editor bursts.
        settleWindowMs: 1000,
        clock: options.checkpointClock,
        signal: AbortSignal.any([stopping.signal, abort.signal]),
        allocateRevision: async () => {
          const row = snapshots.query<{ revision: number }, [string]>('UPDATE snapshots SET revision=revision+1 WHERE attachment=? RETURNING revision').get(key);
          if (!row) throw new Error('Snapshot journal row missing');
          return row.revision;
        },
        loadPending: async () => {
          const row = snapshotRow(key);
          if (!row?.pending) return null;
          const pending = PendingSnapshotSchema.safeParse(JSON.parse(row.pending));
          if (pending.success) return pending.data;
          // A pending row from before bases were recorded cannot be committed safely; the checkout is recaptured.
          snapshots.query('UPDATE snapshots SET pending=NULL WHERE attachment=?').run(key);
          return null;
        },
        loadCommitted: async () => committedOf(key),
        savePending: async pending => { snapshots.query('UPDATE snapshots SET pending=? WHERE attachment=?').run(JSON.stringify(pending), key); },
        loadRejected: async () => rejectedSnapshot(key),
        saveRejected: async rejection => { saveRejectedSnapshot(key, rejection); },
        publish: (checkpoint, committed) => options.gitRemote.publishCheckpoint({
          binding: { projectId: local.attachment.projectId, repository: `workspace-${local.attachment.workspaceId}` },
          repositoryPath: local.rootPath, checkpointRef: checkpoint.checkpointRef, headCommit: checkpoint.headCommit, remoteHead: committed?.headCommit ?? null,
        }),
        commit: async (checkpoint, base) => {
          const accepted = await options.commitSnapshot(local, checkpoint, base);
          if (accepted.worktreeCommit !== checkpoint.worktreeCommit) {
            try { await install(local, checkpoint, accepted); }
            catch (error) {
              // Keep human edits made during fetch/apply against the actual uploaded base; the next capture retries.
              snapshots.query('UPDATE snapshots SET pending=NULL, committed=? WHERE attachment=?').run(JSON.stringify(checkpoint), key);
              throw error;
            }
          }
          snapshots.query('UPDATE snapshots SET pending=NULL, committed=? WHERE attachment=?').run(JSON.stringify(accepted), key);
          await saveGitCacheBase(local.rootPath, accepted);
          synced(local);
          return accepted;
        },
      });
      captures.set(key, stream);
    }
    try {
      const checkpoint = await stream.capture({ retryRejected: retryRejected.delete(key) });
      if (journal.attachment(local.attachment.attachmentId)?.attachment.failure?.operation === 'publish') await clearFailure(local.attachment);
      return checkpoint;
    } catch (error) {
      if (artifactsPublicationRejection(error)) await recordFailure(journal.attachment(local.attachment.attachmentId) ?? local, new AttachmentOperationFailure('publish', error));
      throw error;
    }
  };
  const reconciling = new Map<string, Promise<void>>();
  /** Publishes local changes, then applies a newer cloud version. One reconciliation per checkout runs at a time. */
  const reconcile = (local: LocalAttachment, incoming?: GitIntermediateCheckpoint | null): Promise<void> => {
    const prior = reconciling.get(local.rootPath) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(async () => {
      const key = keyOf(local.attachment);
      const base = snapshotRow(key);
      if (!base?.committed && !base?.pending && incoming) throw new Error('Cache reconciliation requires its durable applied base');
      const before = committedOf(key);
      const accepted = await capture(local);
      // Only a no-op capture may apply the incoming tip; a publication already merged inside the cloud.
      if (incoming && accepted && before?.worktreeCommit === accepted.worktreeCommit && incoming.worktreeCommit !== accepted.worktreeCommit) {
        if (await install(local, accepted, incoming, true)) {
          snapshots.query('UPDATE snapshots SET committed=? WHERE attachment=?').run(JSON.stringify(incoming), key);
          await saveGitCacheBase(local.rootPath, incoming);
          synced(local);
        }
      }
    });
    reconciling.set(local.rootPath, run);
    return run.finally(() => { if (reconciling.get(local.rootPath) === run) reconciling.delete(local.rootPath); });
  };
  /** Waits for the cloud's next version after the applied one and applies it. */
  const subscribe = (local: LocalAttachment) => {
    const { attachment } = local;
    const key = keyOf(attachment);
    if (subscriptions.has(key)) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([stopping.signal, controller.signal]);
    const settled = (async () => {
      while (!signal.aborted) {
        const current = journal.attachment(attachment.attachmentId);
        if (current?.attachment.generation !== attachment.generation || current.attachment.state !== 'ready') return;
        const checkpoint = committedOf(key);
        if (!checkpoint) return;
        try {
          const result = await options.cloud.call('runtime.assignments', {
            machineId: options.machineId,
            workspace: { projectId: attachment.projectId, workspaceId: attachment.workspaceId },
            afterSnapshot: checkpoint.worktreeCommit,
          }, RuntimeAssignmentsResultSchema, signal);
          const assignment = result.assignments.find(item => item.grant.attachment.attachmentId === attachment.attachmentId && item.grant.attachment.generation === attachment.generation);
          if (!assignment || assignment.grant.attachment.state !== 'ready') return;
          const latest = journal.attachment(attachment.attachmentId);
          if (latest?.attachment.generation === attachment.generation && latest.attachment.state === 'ready') await reconcile(latest, assignment.checkpoint);
        } catch (error) {
          if (signal.aborted) return;
          if (artifactsPublicationRejection(error)) return;
          console.error('[runtime-cache-follow]', message(error));
          await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, 1000);
            signal.addEventListener('abort', finish, { once: true });
            if (signal.aborted) finish();
          });
        }
      }
    })().finally(() => { if (subscriptions.get(key)?.controller === controller) subscriptions.delete(key); });
    subscriptions.set(key, { controller, settled });
  };
  /** Publishes local edits shortly after the checkout changes. */
  const follow = async (local: LocalAttachment) => {
    if (watchers.has(local.rootPath)) return;
    let cancel: (() => void) | undefined;
    const watcher = await watchGitWorktree({
      root: local.rootPath, clock, events: options.checkpointEvents ?? gitWorktreeEvents,
      changed: () => {
        if (stopping.signal.aborted) return;
        cancel?.();
        cancel = clock.schedule(200, () => {
          cancel = undefined;
          const current = journal.attachment(local.attachment.attachmentId);
          if (stopping.signal.aborted || current?.attachment.state !== 'ready') return;
          void reconcile(current).catch(error => { if (!artifactsPublicationRejection(error)) console.error('[runtime-cache]', message(error)); });
        });
      },
      failed: error => console.error('[runtime-cache-watch]', error.message),
    });
    if (stopping.signal.aborted) { watcher.close(); cancel?.(); return; }
    watchers.set(local.rootPath, { close() { cancel?.(); watcher.close(); } });
  };
  /** Sync runs while the attachment is ready: the watcher sends local edits as they happen, each sync pass captures
   * what the watcher cannot see (such as ignore-rule changes outside the checkout), and the subscription brings cloud changes. */
  const keepSyncing = async (local: LocalAttachment, incoming?: GitIntermediateCheckpoint | null) => {
    await follow(local);
    const applied = committedOf(keyOf(local.attachment));
    await reconcile(local, incoming && applied && applied.worktreeCommit !== incoming.worktreeCommit ? incoming : undefined);
    subscribe(local);
  };
  const trustedBrowserKeys = new Map<string, Promise<CryptoKey>>();
  const browserDirectory = join(homedir(), '.gitspace-browser-profiles', createHash('sha256').update(options.machineId).digest('hex'));
  const browserRelative = relative(resolve(options.environmentRoot), browserDirectory);
  if (options.browser?.enabled && (!browserRelative || (!browserRelative.startsWith('..') && !isAbsolute(browserRelative)))) throw new Error('Browser profiles must be outside the environment root');
  const browser = new MachineBrowser({
    directory: browserDirectory, enabled: options.browser?.enabled === true, services: options.browser?.services,
    verifyAuthorization: async (authorization, dispatch) => {
      const keyId = JSON.stringify([dispatch.projectId, dispatch.workspaceId, dispatch.attachmentId, dispatch.generation]);
      let trustedKey = trustedBrowserKeys.get(keyId);
      if (!trustedKey) {
        trustedKey = options.cloud.call('runtime.browser.authority', {
          projectId: dispatch.projectId, workspaceId: dispatch.workspaceId, machineId: options.machineId,
          attachmentId: dispatch.attachmentId, generation: dispatch.generation,
        }, RuntimeBrowserPublicKeySchema, AbortSignal.any([stopping.signal, AbortSignal.timeout(10_000)]))
          .then(result => crypto.subtle.importKey('raw', browserUnbase64(result.publicKey), 'Ed25519', false, ['verify']));
        trustedBrowserKeys.set(keyId, trustedKey);
        void trustedKey.catch(() => { if (trustedBrowserKeys.get(keyId) === trustedKey) trustedBrowserKeys.delete(keyId); });
      }
      return verifyRuntimeBrowserAuthorization(authorization, dispatch, await trustedKey);
    },
  });
  void browser.recover().catch(error => console.error('[runtime-browser-recovery]', message(error)));
  /** The machine half of `sync`. Reads report an in-flight capture as `pending`; writes stop following first, so none races the snapshot stream. */
  const syncMachine = async (dispatch: RuntimeToolDispatch, local: LocalAttachment): Promise<ExecutorContent> => {
    const args = RuntimeSyncMachineArgumentsSchema.parse(dispatch.args);
    const key = keyOf(local.attachment);
    const reply = (value: unknown): ExecutorContent => [{ type: 'text', text: JSON.stringify(value) }];
    const binding = { projectId: local.attachment.projectId, repository: `workspace-${local.attachment.workspaceId}` };
    if (args.op === 'capture') {
      const accepted = await capture(local);
      return reply(RuntimeSyncMachineCaptureSchema.parse({ version: accepted?.worktreeCommit ?? null, conflicts: accepted?.conflicts ?? [] }));
    }
    const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    if (args.op === 'status' || args.op === 'diff') {
      const base = committedOf(key);
      const pending = Boolean(snapshotRow(key)?.pending);
      const current = await readGitWorktreeSnapshot(local.rootPath, local.attachment.workspaceId);
      const { changes, truncated } = await gitTreeChanges(local.rootPath, base?.worktreeTree ?? emptyTree, current.worktreeTree, 500);
      if (args.op === 'diff') {
        const patch = args.path ? await gitTreePatch(local.rootPath, base?.worktreeTree ?? emptyTree, current.worktreeTree, args.path) : null;
        return reply(RuntimeSyncMachineDiffSchema.parse({ base: base?.worktreeCommit ?? null, unsent: changes, unsentTruncated: truncated, patch }));
      }
      saveCache(local, { ...cacheFor(journal.attachment(local.attachment.attachmentId) ?? local), unsent: changes.length });
      return reply(RuntimeSyncMachineStatusSchema.parse({ base: base?.worktreeCommit ?? null, pending, unsent: changes, unsentTruncated: truncated, lastSyncAt: cacheFor(local).lastSyncAt, problem: local.attachment.failure?.message ?? null }));
    }
    const base = committedOf(key);
    if (args.op === 'restore') {
      await stopFollowing(local);
      abandonCapture(key);
      try {
        await options.gitRemote.fetchCheckpoint({ binding, repositoryPath: local.rootPath, checkpointRef: args.checkpointRef, commit: args.commit });
        await options.gitRemote.fetchCheckpoint({ binding, repositoryPath: local.rootPath, checkpointRef: args.baseRef, commit: args.base });
        const current = await readGitWorktreeSnapshot(local.rootPath, local.attachment.workspaceId);
        const merged = await mergeGitBackupIntoWorktree({ repositoryPath: local.rootPath, current, base: args.base, backup: args.commit });
        const accepted = await capture(local);
        return reply(RuntimeSyncMachineRestoreSchema.parse({ restored: merged.changes, mergeConflicts: merged.conflicts, version: accepted?.worktreeCommit ?? null, conflicts: accepted?.conflicts ?? [] }));
      } finally { resumeFollowing(local); }
    }
    // Discard: back the changes up to the cloud store, then reset the checkout to its base.
    if (!base) throw new Error('Nothing has synced on this machine yet, so there is no base to reset to');
    await stopFollowing(local);
    abandonCapture(key);
    const checkpointRef = `refs/gitspace/backups/${options.machineId}/${Date.now()}`;
    const publication = await lfs?.publish(local.attachment.projectId, checkpointRef);
    // A published backup keeps its LFS pin; the cloud releases it when the backup is pruned.
    let published = false;
    try {
      const snapshot = await createGitIntermediateCheckpoint({ repositoryPath: local.rootPath, spaceId: local.attachment.workspaceId, revision: Date.now(), checkpointRef, lfs: publication });
      const { changes } = await gitTreeChanges(local.rootPath, base.worktreeTree, snapshot.worktreeTree, 10_000);
      if (!changes.length && snapshot.headCommit === base.headCommit) {
        await deleteGitRef(local.rootPath, checkpointRef);
        return reply(RuntimeSyncMachineDiscardSchema.parse({ discarded: [], backup: null, machineId: options.machineId }));
      }
      // No upload, no discard.
      await options.gitRemote.publishCheckpoint({ binding, repositoryPath: local.rootPath, checkpointRef, headCommit: snapshot.headCommit, remoteHead: base.headCommit });
      published = true;
      const backup = { checkpointRef, commit: snapshot.worktreeCommit, base: base.worktreeCommit };
      try {
        await resetGitWorktree({ repositoryPath: local.rootPath, current: snapshot, base, lfs: await lfs?.read(local.attachment.projectId) });
      } catch (error) {
        // The backup exists in the cloud either way; report it so it is recorded.
        return reply(RuntimeSyncMachineDiscardSchema.parse({ discarded: [], backup, machineId: options.machineId, error: message(error) }));
      }
      saveRejectedSnapshot(key, null);
      // A capture that started while the checkout was being reset may hold part of the discarded changes.
      abandonCapture(key);
      return reply(RuntimeSyncMachineDiscardSchema.parse({ discarded: changes, backup, machineId: options.machineId }));
    } finally {
      if (!published) await publication?.releasePublication?.();
      resumeFollowing(local);
    }
  };
  const resumeFollowing = (local: LocalAttachment) => {
    const current = journal.attachment(local.attachment.attachmentId) ?? local;
    if (current.attachment.state === 'ready') void keepSyncing(current).catch((error: unknown) => console.error('[runtime-sync]', local.attachment.attachmentId, message(error)));
  };
  const executor = new MachineExecutor({
    machineId: options.machineId, journal, runCommand: runSupervisorCommand,
    operations: {
      ...options.operations,
      sync_machine: (dispatch, local) => syncMachine(dispatch, local),
      checkpoint: async (_dispatch, local) => {
        const checkpoint = await capture(local);
        if (!checkpoint) throw new Error('The workspace checkout is not syncing');
        return [{ type: 'text', text: JSON.stringify({ checkpoint }) }];
      },
      browser: (dispatch, local, signal) => browser.execute(dispatch, local, signal),
      browser_control: (dispatch, local, signal) => browser.execute(dispatch, local, signal),
    },
  });
  const baseCapabilities = ['read', 'write', 'edit', 'apply_patch', 'bash', 'grep', 'find', 'ast_grep', 'rule_match_ast', 'ast_edit', 'ast_resolve', 'checkpoint', 'sync_machine', ...Object.keys(options.operations ?? {})];
  const browserCapabilities = (): string[] => options.browser?.enabled === true ? ['browser', 'browser_control', 'browser.headless'] : [];
  let stopped = false;
  let syncing: Promise<Array<{ workspaceId: string; idle: Promise<void> }>> | null = null;
  const sendHeartbeat = async (local: LocalAttachment, report: { clearFailure?: boolean } = {}) => {
    const key = keyOf(local.attachment);
    const row = snapshotRow(key);
    const materializedCommit = row?.committed && !row.pending && !rejectedSnapshot(key) ? RuntimeGitCheckpointSchema.parse(JSON.parse(row.committed)).worktreeCommit : null;
    const failure = local.attachment.failure;
    const observed = await options.cloud.call('runtime.heartbeat', RuntimeHeartbeatInputSchema.parse({
      projectId: local.attachment.projectId, workspaceId: local.attachment.workspaceId,
      machineId: options.machineId, attachmentId: local.attachment.attachmentId, generation: local.attachment.generation,
      executionObservation: { activeExecutions: executor.active(local.attachment.attachmentId).length, observedAt: new Date().toISOString(), materializedCommit },
      browserCapabilities: browserCapabilities(),
      cache: { ...cacheFor(local), platform: process.platform, syncProblem: failure && (failure.operation === 'sync' || failure.operation === 'publish') ? failure.message : null },
      // A recorded failure stays reported until its operation succeeds and clears it.
      ...(failure ? { failure } : report.clearFailure ? { failure: null } : {}),
    }), RuntimeAttachmentReadyResultSchema, AbortSignal.any([stopping.signal, AbortSignal.timeout(15_000)]));
    const current = journal.attachment(local.attachment.attachmentId);
    if (current?.attachment.generation !== local.attachment.generation) return;
    const remote = observed.attachment;
    if (remote.attachmentId !== current.attachment.attachmentId || remote.generation !== current.attachment.generation || remote.machineId !== options.machineId) throw new Error('Heartbeat returned a different attachment');
    if (current.attachment.state !== remote.state || current.attachment.heartbeatAt !== remote.heartbeatAt) journal.installAttachment({ ...current, attachment: { ...current.attachment, state: remote.state, heartbeatAt: remote.heartbeatAt } });
  };
  /** A failure is recorded on the attachment it affected and reported with its heartbeat; it never blocks anything. */
  const recordFailure = async (assigned: LocalAttachment, error: unknown) => {
    const { attachmentId, generation } = assigned.attachment;
    const stored = journal.attachment(attachmentId);
    const local = stored?.attachment.generation === generation ? stored : null;
    const operation = error instanceof AttachmentOperationFailure ? error.operation : 'sync';
    const failure: RuntimeAttachmentFailure = { operation, message: message(error).slice(0, 2000), at: new Date().toISOString() };
    console.error('[runtime-attachments]', attachmentId, operation, failure.message);
    const failed = { ...(local ?? assigned), attachment: { ...(local ?? assigned).attachment, failure } };
    if (local) journal.installAttachment(failed);
    if (stopped || failed.attachment.state === 'detached') return;
    await sendHeartbeat(failed).catch((reportError: unknown) => console.error('[runtime-attachment-failure]', attachmentId, message(reportError)));
  };
  const clearFailure = async (attachment: RuntimeAttachment) => {
    const local = journal.attachment(attachment.attachmentId);
    if (local?.attachment.generation !== attachment.generation || !local.attachment.failure) return;
    const cleared = { ...local, attachment: { ...local.attachment, failure: null } };
    journal.installAttachment(cleared);
    if (stopped || cleared.attachment.state === 'detached') return;
    await sendHeartbeat(cleared, { clearFailure: true }).catch((reportError: unknown) => console.error('[runtime-attachment-failure]', attachment.attachmentId, message(reportError)));
  };
  // A rejected snapshot is a standing publish failure until its input changes.
  for (const local of journal.attachments()) {
    const rejection = rejectedSnapshot(keyOf(local.attachment));
    if (rejection && local.attachment.state !== 'detached' && local.attachment.failure?.operation !== 'publish') {
      journal.installAttachment({ ...local, attachment: { ...local.attachment, failure: { operation: 'publish', message: gitCheckpointRejectionError(rejection).message.slice(0, 2000), at: new Date().toISOString() } } });
    }
  }
  /** Stops sync and commands for an attachment the cloud released. The checkout stays on disk. */
  const release = async (local: LocalAttachment) => {
    await stopFollowing(local);
    const key = keyOf(local.attachment);
    await captures.get(key)?.settle().catch(() => {});
    captures.delete(key);
    await executor.drain(local);
    await browser.closeAttachment(local);
    const current = journal.attachment(local.attachment.attachmentId) ?? local;
    journal.installAttachment({ ...current, attachment: { ...current.attachment, state: 'detached', updatedAt: new Date().toISOString() } });
  };
  const canonicalPathOf = (attachment: RuntimeAttachment) => join(options.managedSpaceRoot ?? join(options.environmentRoot, 'spaces'), attachment.projectId, attachment.workspaceId);
  const announceReady = async (local: LocalAttachment, commit: string, signal: AbortSignal) => {
    const { attachment } = local;
    const ready = await options.cloud.call('runtime.attachment.ready', {
      projectId: attachment.projectId, workspaceId: attachment.workspaceId, machineId: options.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation,
      commit, prerequisitesComplete: true, capabilities: [...baseCapabilities, ...browserCapabilities()], lfsRestored: await gitLfsRestoreReceipt(local.rootPath, 'read'),
    }, RuntimeAttachmentReadyResultSchema, signal);
    const current = journal.attachment(attachment.attachmentId) ?? local;
    const updated = { ...current, attachment: { ...current.attachment, state: ready.attachment.state, heartbeatAt: ready.attachment.heartbeatAt, capabilities: ready.attachment.capabilities } };
    journal.installAttachment(updated);
    await gitLfsRestoreReceipt(local.rootPath, 'clear');
    return updated;
  };
  const processAssignment = async (assignment: RuntimeAssignment) => {
    const { attachment } = assignment.grant;
    const prior = journal.attachment(attachment.attachmentId);
    if (attachment.state === 'detached') {
      if (prior && prior.attachment.state !== 'detached') await release(prior);
      return;
    }
    const key = keyOf(attachment);
    // Once set up, a checkout stays in use; setup runs again only when someone runs it.
    if (prior?.prerequisitesComplete && prior.attachment.generation === attachment.generation) {
      let local: LocalAttachment = { ...prior, executionSecret: assignment.grant.executionSecret, attachment: { ...attachment, failure: prior.attachment.failure, cache: cacheFor(prior) } };
      journal.installAttachment(local);
      if (attachment.state === 'attaching') {
        const commit = committedOf(key)?.worktreeCommit ?? assignment.source?.commit;
        if (!commit) throw new AttachmentOperationFailure('materialize', new Error('The checkout has no synced version to report'));
        local = await announceReady(local, commit, stopping.signal);
      }
      if (local.attachment.state === 'ready') await keepSyncing(local, assignment.checkpoint).catch(failedDuring('sync'));
      return;
    }
    const canonicalPath = canonicalPathOf(attachment);
    const existed = existsSync(canonicalPath);
    const source = assignment.source;
    const sourceCheckpoint = source?.checkpoint ?? assignment.checkpoint;
    const signal = AbortSignal.any([stopping.signal, AbortSignal.timeout(30 * 60_000)]);
    const deadlineAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const grant: LocalAttachment = { ...assignment.grant, rootPath: canonicalPath, prerequisitesComplete: false };
    const env = source?.remote ? credentialHelper.environment(grant, source.remote) : {};
    let setupFailure: unknown = null;
    const local = await prepareMachineAttachment(journal, {
      enrolled: assignment.grant, canonicalPath, deadlineAt, signal,
      source: source?.remote ? {
        repository: { ...source, remote: source.remote }, requiresFiltersOrSubmodules: source.requiresFiltersOrSubmodules,
        host: {
          binary: options.artifactFsBinary, root: canonicalPath, gitEnvironment: async () => env,
          ensureDaemon: async (spec: { binary: string; args: string[]; env: Record<string, string> }) => {
            const client = await daemonClientForProject(canonicalPath);
            await client.request({ op: 'start', owner: attachment.attachmentId, spec: { name: `artifactfs-${Buffer.from(attachment.attachmentId).toString('base64url')}`, application: spec.binary, args: spec.args, cwd: canonicalPath, inheritEnv: true, visibility: 'private', env: spec.env, pty: false, restart: 'on-failure', persist: true, detached: false } });
          },
        },
        hydrateLfs: async (path: string) => {
          if (source.origin) {
            for (const [name, value] of [['remote.origin.url', source.origin], ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']]) {
              const result = await runSupervisorCommand({ application: 'git', args: ['config', name, value], cwd: path, env, signal, deadlineAt, attemptId: `origin-${attachment.attachmentId}-${name}`, sequence: 0 });
              if (result.exitCode !== 0) throw new Error(result.output);
            }
          }
          await hydrateGitLfs(path, [source.commit], sourceCheckpoint?.lfs, await lfs?.read(attachment.projectId));
          await checkoutGitLfs(path, source.commit);
        },
      } : null,
      prerequisites: async (prepared, prepareSignal) => {
        const durable = snapshotRow(key);
        if (!durable?.committed && !durable?.pending) {
          let base = await readGitCacheBase(prepared.rootPath);
          if (!base && sourceCheckpoint && !existed) {
            await restoreGitIntermediateCheckpoint({ repositoryPath: prepared.rootPath, checkpoint: sourceCheckpoint, branch: attachment.checkout.branch, lfs: await lfs?.read(attachment.projectId) });
            base = sourceCheckpoint;
          }
          if (!base && assignment.checkpoint) {
            const captureId = `admission-${createHash('sha256').update(attachment.attachmentId).digest('hex')}`;
            const revision = Date.now();
            // Admission only compares trees; its publication pins nothing beyond the comparison.
            const publication = await lfs?.publish(attachment.projectId, spaceGitCheckpointRef(captureId, revision));
            const observed = await createGitIntermediateCheckpoint({ repositoryPath: prepared.rootPath, spaceId: attachment.workspaceId, captureId, revision, lfs: publication })
              .finally(async () => { await publication?.releasePublication?.(); });
            const cloud = assignment.checkpoint;
            if (observed.headCommit !== cloud.headCommit || observed.branch !== cloud.branch || observed.indexTree !== cloud.indexTree || observed.worktreeTree !== cloud.worktreeTree) throw new Error(`The checkout at ${prepared.rootPath} has changes that were never synced from this workspace; move it aside to attach`);
            base = cloud;
          }
          if (base) {
            await saveGitCacheBase(prepared.rootPath, base);
            snapshots.query('INSERT OR REPLACE INTO snapshots(attachment,revision,committed) VALUES(?,?,?)').run(key, Date.now(), JSON.stringify(base));
          }
        }
        await reconcile(prepared, assignment.checkpoint);
        // Setup scripts record their own results; a failed script never blocks the checkout.
        await options.prepareAttachment(prepared, prepareSignal, async step => {
          const current = journal.attachment(attachment.attachmentId) ?? prepared;
          const cache = cacheFor(current);
          const updated = saveCache(current, { ...cache, state: 'setup', setup: [...cache.setup.filter(item => item.phase !== step.phase), step] });
          await sendHeartbeat(updated).catch((error: unknown) => console.error('[runtime-setup-progress]', attachment.attachmentId, message(error)));
        }).catch((error: unknown) => { setupFailure = error; });
      },
    }).catch(failedDuring('materialize'));
    const commit = committedOf(key)?.worktreeCommit ?? sourceCheckpoint?.worktreeCommit ?? source?.commit;
    if (!commit) throw new AttachmentOperationFailure('materialize', new Error('The checkout has no version to report'));
    const live = saveCache(local, { ...cacheFor(journal.attachment(attachment.attachmentId) ?? local), state: 'live' });
    const ready = await announceReady(live, commit, signal);
    if (setupFailure !== null) await recordFailure(ready, new AttachmentOperationFailure('setup', setupFailure));
    if (ready.attachment.state === 'ready') await keepSyncing(ready).catch(failedDuring('sync'));
  };
  /** Each assignment fails alone: its failure is recorded on its attachment and later assignments still run. */
  const runAssignment = async (assignment: RuntimeAssignment) => {
    const { attachment } = assignment.grant;
    try {
      if (attachment.machineId !== options.machineId) throw new Error('Invalid remote attachment assignment');
      await processAssignment(assignment);
    } catch (error) {
      await recordFailure({ ...assignment.grant, rootPath: canonicalPathOf(attachment), prerequisitesComplete: false }, error);
      return;
    }
    if (journal.attachment(attachment.attachmentId)?.attachment.failure?.operation !== 'setup') await clearFailure(attachment);
  };
  /** Work on one checkout stays serialized while different checkouts proceed independently. A lane busy with
   * earlier work keeps only the newest assignment per attachment and runs it next. */
  const lanes = new Map<string, { pending: Map<string, RuntimeAssignment>; idle: Promise<void> }>();
  const enqueue = (assignment: RuntimeAssignment): Promise<void> => {
    const root = canonicalPathOf(assignment.grant.attachment);
    const existing = lanes.get(root);
    if (existing) {
      existing.pending.set(assignment.grant.attachment.attachmentId, assignment);
      return existing.idle;
    }
    const lane = { pending: new Map([[assignment.grant.attachment.attachmentId, assignment]]), idle: Promise.resolve() };
    lanes.set(root, lane);
    lane.idle = (async () => {
      try {
        while (lane.pending.size && !stopped) {
          const batch = [...lane.pending.values()];
          lane.pending.clear();
          for (const item of batch) await runAssignment(item);
        }
      } finally { lanes.delete(root); }
    })();
    return lane.idle;
  };
  /** Dispatches every assignment; a workspace operation awaits only that workspace's lanes. */
  const sync = (workspaceId?: string): Promise<void> => {
    syncing ??= (async () => {
      const { assignments } = await options.cloud.call('runtime.assignments', { machineId: options.machineId }, RuntimeAssignmentsResultSchema, stopping.signal);
      for (const [key, subscription] of subscriptions) {
        if (!assignments.some(item => keyOf(item.grant.attachment) === key && item.grant.attachment.state === 'ready')) subscription.controller.abort();
      }
      // The machine-wide list omits detached attachments; a local one missing from it was released by the cloud.
      const listed = new Set(assignments.map(item => item.grant.attachment.attachmentId));
      const vanished = journal.attachments()
        .filter(local => !listed.has(local.attachment.attachmentId) && local.attachment.state !== 'detached')
        .map(local => RuntimeAssignmentSchema.parse({ grant: { attachment: { ...local.attachment, state: 'detached' }, executionSecret: local.executionSecret }, source: null }));
      return [...assignments, ...vanished].map(assignment => ({ workspaceId: String(assignment.grant.attachment.workspaceId), idle: enqueue(assignment) }));
    })().finally(() => { syncing = null; });
    return syncing.then(async work => { await Promise.all(work.filter(item => workspaceId === undefined || item.workspaceId === workspaceId).map(item => item.idle)); });
  };
  /** Waits for in-flight work on one workspace's checkout, never for another workspace's long setup. */
  const settled = async (workspaceId: string) => {
    await syncing;
    const roots = new Set(journal.attachments().filter(item => item.attachment.workspaceId === workspaceId).map(item => item.rootPath));
    await Promise.all([...roots].map(root => lanes.get(root)?.idle));
  };
  let heartbeating: Promise<void> | null = null;
  const heartbeat = (): Promise<void> => {
    heartbeating ??= (async () => {
      for (const local of journal.attachments()) {
        if (stopped) return;
        if (local.attachment.state === 'detached') continue;
        try { await sendHeartbeat(local); }
        catch (error) { console.error('[runtime-heartbeat]', local.attachment.attachmentId, message(error)); }
      }
    })().finally(() => { heartbeating = null; });
    return heartbeating;
  };
  const heartbeatTimer = setInterval(() => { void heartbeat(); }, 10_000);
  void sync().catch(error => console.error('[runtime-attachments]', message(error)));
  const timer = setInterval(() => { void sync().catch(error => console.error('[runtime-attachments]', message(error))); }, 10_000);
  return { executor, journal, sync,
    useWorkspace: async workspaceId => {
      await settled(workspaceId);
      const local = journal.attachments().find(item => item.attachment.workspaceId === workspaceId && item.attachment.state !== 'detached');
      if (!local) throw new Error('This machine is not attached to the workspace');
      retryRejected.add(keyOf(local.attachment));
      if (local.attachment.state !== 'ready') {
        await options.cloud.call('runtime.attachment.cache.request', { projectId: local.attachment.projectId, workspaceId, machineId: options.machineId }, RuntimeJsonSchema, stopping.signal);
        await sync(workspaceId);
      }
      const ready = journal.attachment(local.attachment.attachmentId);
      if (!ready || ready.attachment.state !== 'ready') throw new Error(`The workspace checkout on this machine is not ready${ready?.attachment.failure ? `: ${ready.attachment.failure.message}` : ''}`);
      await reconcile(ready);
    },
    drainWorkspace: async workspaceId => {
      await settled(workspaceId);
      for (const local of journal.attachments()) {
        const attachment = local.attachment;
        if (attachment.workspaceId !== workspaceId || attachment.state === 'detached') continue;
        // Send what is unsent first; the checkout stays on disk either way.
        await capture(local).catch((error: unknown) => console.error('[runtime-detach]', attachment.attachmentId, message(error)));
        await options.cloud.call('runtime.detach', { projectId: attachment.projectId, workspaceId, machineId: options.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation }, RuntimeJsonSchema, stopping.signal);
        await release(local);
      }
    },
    close: async () => {
      stopped = true;
      stopping.abort();
      clearInterval(timer);
      clearInterval(heartbeatTimer);
      for (const entry of watchers.values()) entry.close();
      try {
        await Promise.allSettled([syncing, heartbeating, ...[...lanes.values()].map(lane => lane.idle), ...reconciling.values(), ...[...subscriptions.values()].map(subscription => subscription.settled), ...[...captures.values()].map(capture => capture.settle())]);
        await browser.close();
      } finally {
        await credentialHelper.close();
        snapshots.close();
        journal.close();
      }
    } };
}
