import { mkdir, chmod, readFile, statfs } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { ExecutorJournal, MachineExecutor, MachineBrowser, runSupervisorCommand, prepareMachineAttachment, cleanupMachineAttachment, type ExecutorArtifactAccess, type MachineBrowserOptions } from '@gitspace/runtime-machine';
import { RuntimeJsonSchema, RuntimeGitCheckpointSchema, RuntimeAssignmentsResultSchema, RuntimeAttachmentReadyResultSchema, RuntimeAttachmentRequestResultSchema, RuntimeHeartbeatInputSchema, RuntimeBrowserPublicKeySchema, RuntimeCacheObservationSchema, browserUnbase64, verifyRuntimeBrowserAuthorization, type RuntimeCacheObservation, type RuntimeCachePolicy } from '@gitspace/protocol-runtime';
import type { GitSpaceDatabase, LocalArtifactResolver } from '@gitspace/core';
import type { CloudRuntimeClient } from './cloud-runtime-client.js';
import { Database } from 'bun:sqlite';
import { IncrementalGitSnapshots, createGitIntermediateCheckpoint, completeGitCheckpoint, restoreGitIntermediateCheckpoint, applyGitCacheCheckpoint, gitCheckpointIncludes, readGitCacheBase, saveGitCacheBase } from './git-checkpoint.js';
import type { GitIntermediateCheckpoint } from './git-checkpoint.js';
import type { ArtifactsGitRemote } from './artifacts-git-remote.js';
import type { SpaceCheckpointManifest } from '@gitspace/protocol-workspace';
import type { LocalAttachment, ExecutorOperationHandler } from '@gitspace/runtime-machine';
import { createArtifactsCredentialHelper } from './artifacts-credential-helper.js';
import { daemonClientForProject } from '@gitspace/supervisor';
import { checkoutGitLfs, gitLfsRestoreReceipt, hydrateGitLfs, type MachineGitLfs } from './git-lfs.js';
import { gitWorktreeClock, gitWorktreeEvents, watchGitWorktree, type GitWorktreeClock, type GitWorktreeEvents } from './git-worktree-watch.js';
import { cacheActivity } from './runtime-cache-activity.js';

export type MachineExecutorRuntime = { executor: MachineExecutor; journal: ExecutorJournal; sync(): Promise<void>; drainWorkspace(workspaceId: string): Promise<void>; useWorkspace(workspaceId: string): Promise<void>; close(): Promise<void> };
export async function createMachineExecutor(options: {
  environmentRoot: string; machineId: string; database: GitSpaceDatabase; artifacts: LocalArtifactResolver; cloud: CloudRuntimeClient;
  managedSpaceRoot?: string;
  gitRemote: ArtifactsGitRemote;
  lfs?: (projectId: string, publicationId?: string) => Promise<MachineGitLfs>;
  operations?: Record<string, ExecutorOperationHandler>;
  browser?: Pick<MachineBrowserOptions, 'enabled' | 'services'>;
  commitSnapshot(local: LocalAttachment, checkpoint: GitIntermediateCheckpoint, previousWorktreeCommit: string | null, final?: boolean): Promise<GitIntermediateCheckpoint>;
  restoredBase?(projectId: string, workspaceId: string): Promise<SpaceCheckpointManifest['repository'] | null>;
  prepareAttachment(local: LocalAttachment, signal: AbortSignal, progress: (step: RuntimeCacheObservation['setup'][number]) => Promise<void>): Promise<void>;
  originGitEnvironment(origin: string): Promise<Record<string, string>>;
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
  const captures = new Map<string, IncrementalGitSnapshots>();
  const clock = options.checkpointClock ?? gitWorktreeClock;
  const watchers = new Map<string, { close(): void }>();
  const subscriptions = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  const policies = new Map<string, RuntimeCachePolicy>();
  const cacheFor = (local: LocalAttachment): RuntimeCacheObservation => local.attachment.cache ?? RuntimeCacheObservationSchema.parse({ state: 'live', platform: process.platform, activity: [], lastActivityAt: new Date().toISOString(), pausedAt: null, reclaimAt: null, lastSyncAt: null, localWorkOptIn: false, setup: [] });
  const saveCache = (local: LocalAttachment, cache: RuntimeCacheObservation): LocalAttachment => {
    const current = journal.attachment(local.attachment.attachmentId) ?? local;
    const updated = { ...current, attachment: { ...current.attachment, cache } };
    journal.installAttachment(updated);
    return updated;
  };
  const touch = (local: LocalAttachment) => local.attachment.role === 'cache' ? saveCache(local, { ...cacheFor(journal.attachment(local.attachment.attachmentId) ?? local), state: 'live', lastActivityAt: new Date().toISOString(), pausedAt: null, reclaimAt: null, reclaimBlocked: null }) : local;
  const stopFollowing = async (local: LocalAttachment) => {
    watchers.get(local.rootPath)?.close();
    watchers.delete(local.rootPath);
    const subscription = subscriptions.get(`${local.attachment.attachmentId}:${local.attachment.generation}`);
    subscription?.controller.abort();
    await subscription?.settled;
  };
  const install = async (local: LocalAttachment, previous: GitIntermediateCheckpoint, checkpoint: GitIntermediateCheckpoint, incoming = false) => {
    await options.gitRemote.fetchCheckpoint({ binding: { projectId: local.attachment.projectId, repository: `workspace-${local.attachment.workspaceId}` }, repositoryPath: local.rootPath, checkpointRef: checkpoint.checkpointRef, commit: checkpoint.worktreeCommit });
    if (incoming && await gitCheckpointIncludes(local.rootPath, previous, checkpoint)) return false;
    // Every canonical cache uses the workspace branch, never a private execution branch.
    await applyGitCacheCheckpoint({ repositoryPath: local.rootPath, previous, checkpoint, lfs: await options.lfs?.(local.attachment.projectId) });
    return true;
  };
  const capture = async (local: LocalAttachment): Promise<GitIntermediateCheckpoint | null> => {
    if (local.attachment.role !== 'cache' || !['attaching', 'ready', 'draining'].includes(local.attachment.state)) return null;
    stopping.signal.throwIfAborted();
    const key = `${local.attachment.attachmentId}:${local.attachment.generation}`;
    let stream = captures.get(key);
    if (!stream) {
      snapshots.query('INSERT OR IGNORE INTO snapshots (attachment, revision) VALUES (?, ?)').run(key, Date.now());
      stream = new IncrementalGitSnapshots({
        repositoryPath: local.rootPath,
        spaceId: local.attachment.workspaceId,
        captureId: `cache-${createHash('sha256').update(`${options.machineId}:${key}`).digest('hex')}`,
        lfs: options.lfs?.bind(undefined, local.attachment.projectId),
        // One full second of stable dirty-path metadata coalesces editor bursts,
        // including pauses beyond the old 200ms debounce. Longer pauses can be
        // separate edits; no timestamp policy proves an arbitrary writer done.
        settleWindowMs: 1000,
        clock: options.checkpointClock,
        signal: stopping.signal,
        allocateRevision: async () => {
          const row = snapshots.query<{ revision: number }, [string]>('UPDATE snapshots SET revision=revision+1 WHERE attachment=? RETURNING revision').get(key);
          if (!row) throw new Error('Snapshot journal row missing');
          return row.revision;
        },
        loadPending: async () => {
          const row = snapshots.query<{ pending: string | null }, [string]>('SELECT pending FROM snapshots WHERE attachment=?').get(key);
          return row?.pending ? RuntimeGitCheckpointSchema.parse(JSON.parse(row.pending)) : null;
        },
        loadCommitted: async () => {
          const row = snapshots.query<{ committed: string | null }, [string]>('SELECT committed FROM snapshots WHERE attachment=?').get(key);
          return row?.committed ? RuntimeGitCheckpointSchema.parse(JSON.parse(row.committed)) : null;
        },
        savePending: async checkpoint => { snapshots.query('UPDATE snapshots SET pending=? WHERE attachment=?').run(JSON.stringify(checkpoint), key); },
        publish: checkpoint => options.gitRemote.publishCheckpoint({
          binding: { projectId: local.attachment.projectId, repository: `workspace-${local.attachment.workspaceId}` },
          repositoryPath: local.rootPath, checkpointRef: checkpoint.checkpointRef,
        }),
        commit: async checkpoint => {
          const prior = snapshots.query<{ committed: string | null }, [string]>('SELECT committed FROM snapshots WHERE attachment=?').get(key);
          const previous = prior?.committed ? RuntimeGitCheckpointSchema.parse(JSON.parse(prior.committed)) : null;
          const accepted = await options.commitSnapshot(local, checkpoint, previous?.worktreeCommit ?? null);
          if (accepted.worktreeCommit !== checkpoint.worktreeCommit) {
            try { await install(local, checkpoint, accepted); }
            catch (error) {
              // Preserve human edits made during fetch/apply against the actual
              // uploaded base, not the accepted tree we could not install.
              // Leave the changed worktree for the same settling/capture boundary
              // on retry; taking a raw pending snapshot here would bypass it.
              snapshots.query('UPDATE snapshots SET pending=NULL, committed=? WHERE attachment=?').run(JSON.stringify(checkpoint), key);
              throw error;
            }
          }
          snapshots.query('UPDATE snapshots SET pending=NULL, committed=? WHERE attachment=?').run(JSON.stringify(accepted), key);
          await saveGitCacheBase(local.rootPath, accepted);
          saveCache(local, { ...cacheFor(journal.attachment(local.attachment.attachmentId) ?? local), lastSyncAt: new Date().toISOString() });
          return accepted;
        },
      });
      captures.set(key, stream);
    }
    return stream.capture();
  };
  const reconcile = async (local: LocalAttachment, incoming?: GitIntermediateCheckpoint | null) => {
    if (local.attachment.role !== 'cache') return;
    const key = `${local.attachment.attachmentId}:${local.attachment.generation}`;
    const base = snapshots.query<{ committed: string | null; pending: string | null }, [string]>('SELECT committed,pending FROM snapshots WHERE attachment=?').get(key);
    if (!base?.committed && !base?.pending && incoming) throw new Error('Cache reconciliation requires its durable applied base');
    const before = base?.committed ? RuntimeGitCheckpointSchema.parse(JSON.parse(base.committed)) : null;
    const accepted = await capture(local);
    // A publication races against the cloud tip inside the cloud merge owner.
    // Only a no-op capture may use the bounded subscription's incoming tip.
    if (incoming && accepted && before?.worktreeCommit === accepted.worktreeCommit && incoming.worktreeCommit !== accepted.worktreeCommit) {
      if (await install(local, accepted, incoming, true)) {
        snapshots.query('UPDATE snapshots SET committed=? WHERE attachment=?').run(JSON.stringify(incoming), key);
        await saveGitCacheBase(local.rootPath, incoming);
        saveCache(local, { ...cacheFor(journal.attachment(local.attachment.attachmentId) ?? local), lastSyncAt: new Date().toISOString() });
      }
    }
  };
  const subscribe = (local: LocalAttachment) => {
    const { attachment } = local;
    const key = `${attachment.attachmentId}:${attachment.generation}`;
    if (attachment.role !== 'cache' || subscriptions.has(key)) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([stopping.signal, controller.signal]);
    const settled = (async () => {
      while (!signal.aborted) {
        const current = journal.attachment(attachment.attachmentId);
        if (current?.attachment.generation !== attachment.generation || current.attachment.state !== 'ready' || cacheFor(current).state !== 'live') return;
        const row = snapshots.query<{ committed: string | null }, [string]>('SELECT committed FROM snapshots WHERE attachment=?').get(key);
        if (!row?.committed) return;
        const checkpoint = RuntimeGitCheckpointSchema.parse(JSON.parse(row.committed));
        try {
          const result = await options.cloud.call('runtime.assignments', {
            machineId: options.machineId,
            workspace: { projectId: attachment.projectId, workspaceId: attachment.workspaceId },
            afterSnapshot: checkpoint.worktreeCommit,
          }, RuntimeAssignmentsResultSchema, signal);
          const assignment = result.assignments.find(item => item.grant.attachment.attachmentId === attachment.attachmentId && item.grant.attachment.generation === attachment.generation);
          if (!assignment || assignment.grant.attachment.state !== 'ready') return;
          await executor.withCheckout(current, async () => {
            const latest = journal.attachment(attachment.attachmentId);
            if (latest?.attachment.generation === attachment.generation && latest.attachment.state === 'ready' && !journal.hasRunningCheckout(latest.rootPath)) await reconcile(latest, assignment.checkpoint);
          });
        } catch (error) {
          if (signal.aborted) return;
          console.error('[runtime-cache-follow]', error instanceof Error ? error.message : String(error));
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
  const follow = async (local: LocalAttachment) => {
    if (local.attachment.role !== 'cache' || watchers.has(local.rootPath)) return;
    let cancel: (() => void) | undefined;
    const watcher = await watchGitWorktree({
      root: local.rootPath, clock, events: options.checkpointEvents ?? gitWorktreeEvents,
      changed: () => {
        if (stopping.signal.aborted) return;
        cancel?.();
        cancel = clock.schedule(200, () => {
          cancel = undefined;
          void executor.withCheckout(local, async () => {
            const current = journal.attachment(local.attachment.attachmentId);
            if (!stopping.signal.aborted && current?.attachment.state === 'ready' && !journal.hasRunningCheckout(local.rootPath)) await reconcile(current);
          }).catch(error => console.error('[runtime-cache]', error instanceof Error ? error.message : String(error)));
        });
      },
      failed: error => console.error('[runtime-cache-watch]', error.message),
    });
    if (stopping.signal.aborted) { watcher.close(); cancel?.(); return; }
    watchers.set(local.rootPath, { close() { cancel?.(); watcher.close(); } });
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
  void browser.recover().catch(error => console.error('[runtime-browser-recovery]', error instanceof Error ? error.message : String(error)));
  const executor = new MachineExecutor({
    machineId: options.machineId, journal, runCommand: runSupervisorCommand,
    onMutationSettled: async local => {
      touch(local);
      return capture(local);
    },
    onBeforeExecute: async (local, dispatch) => {
      local = touch(local);
      await reconcile(local, dispatch.snapshot);
      if (dispatch.tool === 'grep' && dispatch.snapshot && local.attachment.role === 'cache') {
        const key = `${local.attachment.attachmentId}:${local.attachment.generation}`;
        const row = snapshots.query<{ committed: string | null; pending: string | null }, [string]>('SELECT committed,pending FROM snapshots WHERE attachment=?').get(key);
        const applied = row?.committed ? RuntimeGitCheckpointSchema.parse(JSON.parse(row.committed)) : null;
        if (row?.pending || applied?.worktreeCommit !== dispatch.snapshot.worktreeCommit) throw new Error('Grep cache has not materialized the canonical snapshot');
        // Native grep reads an immutable raw-blob tree keyed by this verified applied
        // commit; local edits, LFS hydration and filesystem races cannot affect it.
        return;
      }
    },
    operations: { ...options.operations, browser: (dispatch, local, signal) => browser.execute(dispatch, local, signal), browser_control: (dispatch, local, signal) => browser.execute(dispatch, local, signal) },
    artifacts: local => {
      const capability = { kind: 'workspace' as const, projectId: local.attachment.projectId, workspaceId: local.attachment.workspaceId };
      const adapter: ExecutorArtifactAccess = {
        read: async (uri, signal) => {
          if (signal.aborted) throw new Error('Artifact read canceled');
          const result = await options.artifacts.read(capability, uri);
          if (result.status === 'error') throw result.error;
          return [{ type: 'text', text: new TextDecoder().decode(result.value) }];
        },
        write: async (uri, content, signal) => {
          if (signal.aborted) throw new Error('Artifact write canceled');
          const result = await options.artifacts.write(capability, uri, new TextEncoder().encode(content));
          if (result.status === 'error') throw result.error;
        },
      };
      return adapter;
    },
  });
  const baseCapabilities = ['read', 'write', 'edit', 'apply_patch', 'bash', 'grep', 'find', 'ast_grep', 'rule_match_ast', 'ast_edit', 'ast_resolve', 'checkpoint', ...Object.keys(options.operations ?? {})];
  const browserCapabilities = async (): Promise<string[]> => {
    if (options.browser?.enabled !== true) return [];
    return ['browser', 'browser_control', 'browser.headless'];
  };
  const isBrowserCapability = (capability: string) => capability === 'browser' || capability === 'browser_control' || capability.startsWith('browser.');
  let stopped = false;
  let syncing: Promise<void> | null = null;
  const sendHeartbeat = async (local: LocalAttachment, browserSupport: string[], activeExecutions: number) => {
    const row = snapshots.query<{ committed: string | null; pending: string | null }, [string]>('SELECT committed,pending FROM snapshots WHERE attachment=?').get(`${local.attachment.attachmentId}:${local.attachment.generation}`);
    const materializedCommit = row?.committed && !row.pending ? RuntimeGitCheckpointSchema.parse(JSON.parse(row.committed)).worktreeCommit : null;
    const action = local.attachment.cacheAction;
    const observed = await options.cloud.call('runtime.heartbeat', RuntimeHeartbeatInputSchema.parse({
      projectId: local.attachment.projectId, workspaceId: local.attachment.workspaceId,
      machineId: options.machineId, attachmentId: local.attachment.attachmentId, generation: local.attachment.generation,
      executionObservation: { activeExecutions, observedAt: new Date().toISOString(), materializedCommit },
      browserCapabilities: browserSupport,
      ...(local.attachment.role === 'cache' ? { cache: { ...cacheFor(local), platform: process.platform } } : {}),
      ...(action && action.status !== 'requested' ? { cacheAction: { requestId: action.requestId, status: action.status, error: action.error } } : {}),
    }), RuntimeAttachmentRequestResultSchema, stopping.signal);
    const current = journal.attachment(local.attachment.attachmentId);
    if (current?.attachment.generation === local.attachment.generation) {
      const remote = observed.attachment;
      if (remote.attachmentId !== current.attachment.attachmentId || remote.generation !== current.attachment.generation || remote.machineId !== options.machineId) throw new Error('Heartbeat returned a different attachment lease');
      journal.installAttachment({ ...current, attachment: {
        ...current.attachment,
        state: remote.state === 'ready' && current.attachment.state !== 'ready' ? current.attachment.state : remote.state,
        heartbeatAt: remote.heartbeatAt, cacheAction: remote.cacheAction,
        ...(current.attachment.cache && remote.cache ? { cache: { ...current.attachment.cache, localWorkOptIn: remote.cache.localWorkOptIn } } : {}),
      } });
    }
  };
  const reclaim = async (local: LocalAttachment, attachment: LocalAttachment['attachment'], checkoutRoot: string, canonicalPath?: string) => {
    await stopFollowing(local);
    if (attachment.role === 'cache' && !local.ownedCheckout && attachment.cacheAction?.action === 'reclaim') throw new Error('Reclamation cannot delete a checkout not acquired by this cache');
    const action = attachment.cacheAction?.action === 'reclaim' && ['requested', 'running'].includes(attachment.cacheAction.status) ? attachment.cacheAction : undefined;
    const draining: LocalAttachment = { ...local, attachment: { ...attachment, state: 'draining', ...(attachment.role === 'cache' ? { cache: { ...cacheFor(local), state: 'draining', reclaimBlocked: null } } : {}), ...(action ? { cacheAction: { ...action, status: 'running', error: null } } : {}) } };
    journal.installAttachment(draining);
    await sendHeartbeat(draining, await browserCapabilities(), journal.unresolved(attachment).length);
    try {
      const cleaned = await cleanupMachineAttachment(journal, {
        attachment: draining.attachment, checkoutRoot, canonicalPath, signal: stopping.signal,
        stopAndVerify: async owned => {
          await executor.drain(owned);
          await browser.closeAttachment(owned);
          for (const root of attachment.role === 'cache' ? [owned.rootPath] : [owned.rootPath, checkoutRoot]) {
            const client = await daemonClientForProject(root);
            const listed = await client.request({ op: 'list' }, stopping.signal);
            if (listed.op !== 'list') throw new Error('Cleanup could not enumerate supervisor processes');
            if (attachment.role !== 'cache') {
              for (const daemon of listed.daemons) {
                const stopped = await client.request({ op: 'stop', name: daemon.name, timeoutMs: 5000 }, stopping.signal);
                if (stopped.op !== 'stop' || !['exited', 'failed'].includes(stopped.daemon.state)) throw new Error('Explicit-copy process termination is unverified');
              }
            }
            const verified = await client.request({ op: 'list' }, stopping.signal);
            if (verified.op !== 'list' || verified.daemons.some(daemon => !['exited', 'failed'].includes(daemon.state))) throw new Error('Cleanup retains live supervisor effects');
          }
          if (attachment.role === 'cache') {
            return executor.withCheckout(owned, async (): Promise<void | false> => {
              const key = `${attachment.attachmentId}:${attachment.generation}`;
              const prior = snapshots.query<{ committed: string | null }, [string]>('SELECT committed FROM snapshots WHERE attachment=?').get(key);
              const previous = prior?.committed ? RuntimeGitCheckpointSchema.parse(JSON.parse(prior.committed)) : null;
              const checkpoint = await createGitIntermediateCheckpoint({ repositoryPath: owned.rootPath, spaceId: attachment.workspaceId, captureId: `final-${crypto.randomUUID()}`, revision: Date.now(), lfs: await options.lfs?.(attachment.projectId) });
              const heldBack = checkpoint.lfs?.heldBack ?? [];
              const discardHeldBack = attachment.detachRequest ? attachment.detachRequest.discardHeldBack === true : action?.discardHeldBack === true;
              if (heldBack.length && !discardHeldBack) {
                const reason = `Held-back LFS changes must be committed or explicitly discarded: ${heldBack.map(item => item.path).join(', ')}`;
                const current = journal.attachment(attachment.attachmentId) ?? draining;
                journal.installAttachment({ ...current, attachment: { ...current.attachment, state: attachment.detachRequest ? 'draining' : 'attaching', cache: { ...cacheFor(current), state: 'paused', reclaimBlocked: reason }, ...(action ? { cacheAction: { ...action, status: 'failed', error: reason } } : {}) } });
                return false;
              }
              await options.gitRemote.publishCheckpoint({ binding: { projectId: attachment.projectId, repository: `workspace-${attachment.workspaceId}` }, repositoryPath: owned.rootPath, checkpointRef: checkpoint.checkpointRef });
              const accepted = await options.commitSnapshot(owned, checkpoint, previous?.worktreeCommit ?? null, true);
              snapshots.query('UPDATE snapshots SET pending=NULL, committed=? WHERE attachment=?').run(JSON.stringify(accepted), key);
            });
          }
        },
        verifyUnmounted: async root => {
          if (process.platform !== 'linux') return;
          const mounted = (mounts: string) => mounts.split('\n').some(line => {
            const path = line.split(' ')[4]?.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
            return path === root || path?.startsWith(`${root}/`);
          });
          if (mounted(await readFile('/proc/self/mountinfo', 'utf8'))) {
            if (attachment.role === 'cache') throw new Error('Cleanup retains mounted canonical checkout');
            const result = await runSupervisorCommand({ application: 'fusermount3', args: ['-u', '--', root], cwd: checkoutRoot, attemptId: `cleanup-${attachment.attachmentId}-${attachment.generation}`, sequence: 0, deadlineAt: new Date(Date.now() + 30_000).toISOString(), signal: stopping.signal });
            if (result.exitCode !== 0 || mounted(await readFile('/proc/self/mountinfo', 'utf8'))) throw new Error('ArtifactFS unmount remains unverified; checkout retained');
          }
        },
      });
      if (cleaned.attachment.cache?.reclaimBlocked) {
        await sendHeartbeat(cleaned, await browserCapabilities(), journal.unresolved(attachment).length);
        return;
      }
      const completed = { ...cleaned, attachment: { ...cleaned.attachment, ...(action ? { cacheAction: { ...action, status: 'completed' as const, error: null } } : {}) } };
      journal.installAttachment(completed);
      await sendHeartbeat(completed, await browserCapabilities(), 0);
      if (attachment.role !== 'cache' || !cleaned.ownedCheckout || attachment.detachRequest) {
        await options.cloud.call('runtime.detach', { projectId: attachment.projectId, workspaceId: attachment.workspaceId, machineId: options.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation, state: 'detached' }, RuntimeJsonSchema, stopping.signal);
        const detached = { ...completed.attachment, state: 'detached' as const };
        delete detached.detachRequest;
        journal.installAttachment({ ...completed, attachment: detached });
      }
    } catch (error) {
      if (action) {
        const current = journal.attachment(attachment.attachmentId) ?? draining;
        journal.installAttachment({ ...current, attachment: { ...current.attachment, cacheAction: { ...action, status: 'failed', error: error instanceof Error ? error.message : String(error) } } });
        await sendHeartbeat(journal.attachment(attachment.attachmentId) ?? current, await browserCapabilities(), journal.unresolved(attachment).length);
      }
      throw error;
    }
  };
  const updating = new Map<string, Promise<void>>();
  const updateActivity = (local: LocalAttachment, incoming?: GitIntermediateCheckpoint | null): Promise<void> => {
    const id = local.attachment.attachmentId;
    const previous = updating.get(id);
    if (previous) return previous;
    const pending = (async () => {
      const client = await daemonClientForProject(local.rootPath);
      const listed = await client.request({ op: 'list' }, stopping.signal);
      if (listed.op !== 'list') throw new Error('Supervisor returned invalid cache activity observation');
      const activity: RuntimeCacheObservation['activity'] = [];
      for (const daemon of listed.daemons) {
        if (['exited', 'failed'].includes(daemon.state)) continue;
        const owner = daemon.owner;
        if (owner === `gitspace:${local.attachment.workspaceId}:user`) activity.push({ reason: 'terminal', name: daemon.name });
        else if (owner === `workspace:${local.attachment.projectId}:${local.attachment.workspaceId}`) activity.push({ reason: daemon.name.startsWith('gitspace-svc-') ? 'service' : 'proc', name: daemon.name });
        else if (owner?.startsWith(`gitspace:${local.attachment.workspaceId}:service`)) activity.push({ reason: 'service', name: daemon.name });
        else if (owner === `runtime:${id}:${local.attachment.generation}`) activity.push({ reason: 'proc', name: daemon.name });
        else if (owner?.startsWith(`gitspace:${local.attachment.workspaceId}:lifecycle`)) activity.push({ reason: 'setup', name: daemon.name });
      }
      for (const attempt of journal.unresolved(local.attachment)) activity.push({ reason: 'command', name: attempt.dispatch.tool });
      const prior = cacheFor(journal.attachment(id) ?? local);
      const policy = policies.get(id);
      if (!policy) throw new Error('Cache assignment has no lifecycle policy');
      const cache = cacheActivity(prior, activity, policy, Date.now());
      local = saveCache(local, cache);
      const humanWatch = cache.localWorkOptIn || activity.some(item => item.reason === 'terminal');
      if (humanWatch) await follow(local);
      else { watchers.get(local.rootPath)?.close(); watchers.delete(local.rootPath); }
      if (cache.state === 'live') {
        // Capture live effects periodically even while the checkout command queue is held.
        // IncrementalGitSnapshots serializes capture; this does not enable an idle human watcher.
        if (activity.length || prior.activity.some(item => !['grace', 'sync'].includes(item.reason))) await capture(local);
        const applied = snapshots.query<{ committed: string | null }, [string]>('SELECT committed FROM snapshots WHERE attachment=?').get(`${id}:${local.attachment.generation}`);
        if (incoming && applied?.committed && RuntimeGitCheckpointSchema.parse(JSON.parse(applied.committed)).worktreeCommit !== incoming.worktreeCommit && !journal.hasRunningCheckout(local.rootPath)) await executor.withCheckout(local, () => reconcile(local, incoming));
        subscribe(local);
      } else {
        await stopFollowing(local);
        const disk = await statfs(local.rootPath);
        const lowDisk = disk.blocks > 0 && disk.bavail / disk.blocks < 0.05;
        if ((cache.state === 'draining' || lowDisk) && local.ownedCheckout) {
          await reclaim(local, { ...local.attachment, state: 'draining' }, dirname(local.rootPath), local.rootPath);
        }
      }
    })().finally(() => { updating.delete(id); });
    updating.set(id, pending);
    return pending;
  };
  const sync = (): Promise<void> => {
    if (syncing) return syncing;
    syncing = (async () => {
      const browserSupport = await browserCapabilities();
      const capabilities = [...baseCapabilities, ...browserSupport];
      const assignments = await options.cloud.call('runtime.assignments', { machineId: options.machineId }, RuntimeAssignmentsResultSchema, stopping.signal);
      for (const [key, subscription] of subscriptions) {
        if (!assignments.assignments.some(item => `${item.grant.attachment.attachmentId}:${item.grant.attachment.generation}` === key && item.grant.attachment.state === 'ready')) subscription.controller.abort();
      }
      for (const assignment of assignments.assignments) {
        if (stopped) return;
        const { attachment } = assignment.grant;
        if (attachment.machineId !== options.machineId) throw new Error('Invalid remote attachment assignment');
        policies.set(attachment.attachmentId, assignment.cachePolicy);
        const prior = journal.attachment(attachment.attachmentId);
        if (attachment.state === 'lost') {
          if (prior) { await stopFollowing(prior); journal.installAttachment({ ...prior, attachment }); }
          continue;
        }
        const name = Buffer.from(attachment.attachmentId).toString('base64url');
        const space = options.database.getSpace(attachment.workspaceId);
        const canonicalPath = space?.rootPath ?? join(options.managedSpaceRoot ?? join(options.environmentRoot, 'spaces'), attachment.projectId, attachment.workspaceId);
        const checkoutRoot = attachment.role === 'cache' ? dirname(canonicalPath) : join(directory, 'copies', name);
        if (attachment.state === 'draining' || attachment.cacheAction?.action === 'reclaim' && attachment.cacheAction.status === 'requested') {
          if (!prior) throw new Error('Cache cleanup requires durable local ownership evidence');
          await reclaim(prior, attachment.state === 'draining' ? attachment : { ...attachment, state: 'draining' }, checkoutRoot, canonicalPath);
          continue;
        }
        const setupRequested = attachment.cacheAction?.action === 'setup' && ['requested', 'running'].includes(attachment.cacheAction.status);
        if (attachment.state === 'detached' || !setupRequested && (attachment.cache?.state === 'reclaimed' || attachment.cache?.state === 'paused' && !attachment.cache.localWorkOptIn)) {
          if (prior) {
            await stopFollowing(prior);
            journal.installAttachment({ ...prior, attachment: { ...attachment, cache: prior.attachment.cache ? { ...prior.attachment.cache, localWorkOptIn: attachment.cache?.localWorkOptIn ?? false } : attachment.cache } });
            const paused = journal.attachment(attachment.attachmentId);
            if (paused?.attachment.cache?.state === 'paused') await updateActivity(paused);
          }
          continue;
        }
        if (prior?.attachment.state === 'ready' && attachment.state === 'ready' && prior.attachment.generation === attachment.generation && !setupRequested) {
          const local = { ...prior, executionSecret: assignment.grant.executionSecret, attachment: { ...attachment, cache: attachment.role === 'cache' ? { ...cacheFor(prior), localWorkOptIn: attachment.cache?.localWorkOptIn ?? false } : undefined } };
          journal.installAttachment(local);
          if (attachment.role === 'cache') await updateActivity(local, assignment.checkpoint);
          continue;
        }
        if (!attachment.capabilities.filter(capability => !isBrowserCapability(capability)).every(capability => capabilities.includes(capability))) throw new Error('Executor lacks assigned capabilities');
        const trustedExisting = attachment.role === 'cache' && space?.holderId === options.machineId && space.placementState === 'open' && space.branch === (attachment.checkout.kind === 'shared' ? attachment.checkout.branch : null);
        const source = assignment.source;
        const sourceCheckpoint = assignment.sourceCheckpoint ?? assignment.checkpoint;
        const grant: LocalAttachment = { ...assignment.grant, rootPath: attachment.role === 'cache' ? canonicalPath : join(checkoutRoot, name), prerequisitesComplete: false };
        const signal = AbortSignal.any([stopping.signal, AbortSignal.timeout(30 * 60_000)]);
        const deadlineAt = new Date(Date.now() + 30 * 60_000).toISOString();
        if (!trustedExisting && !source?.remote) throw new Error('Attachment preparation requires an authorized canonical source');
        const env = source?.remote ? credentialHelper.environment(grant, source.remote) : {};
        if (prior && prior.attachment.cache?.state !== 'reclaimed' && attachment.cacheAction?.action === 'setup' && attachment.cacheAction.status === 'requested') {
          await stopFollowing(prior);
          journal.installAttachment({ ...prior, attachment, prerequisitesComplete: false });
        }
        const action = setupRequested ? attachment.cacheAction : undefined;
        await sendHeartbeat({ ...grant, attachment: { ...attachment, ...(attachment.role === 'cache' ? { cache: { ...cacheFor(grant), state: 'setup' } } : {}), ...(action?.status === 'requested' ? { cacheAction: { ...action, status: 'running', error: null } } : {}) } }, browserSupport, 0);
        try {
          let local = await prepareMachineAttachment(journal, {
            enrolled: assignment.grant, checkoutRoot, canonicalPath: attachment.role === 'cache' ? canonicalPath : undefined, adoptExisting: trustedExisting, deadlineAt, signal,
            source: trustedExisting ? { kind: 'local', repository: canonicalPath } : (() => {
              if (!source?.remote) throw new Error('Missing canonical source');
              return {
                kind: 'artifacts' as const, repository: { ...source, remote: source.remote }, requiresFiltersOrSubmodules: source.requiresFiltersOrSubmodules,
                host: {
                  binary: attachment.role === 'cache' ? undefined : options.artifactFsBinary, root: checkoutRoot, gitEnvironment: async () => env,
                  ensureDaemon: async (spec: { binary: string; args: string[]; env: Record<string, string> }) => {
                    const client = await daemonClientForProject(checkoutRoot);
                    await client.request({ op: 'start', owner: attachment.attachmentId, spec: { name: `artifactfs-${name}`, application: spec.binary, args: spec.args, cwd: checkoutRoot, inheritEnv: true, visibility: 'private', env: spec.env, pty: false, restart: 'on-failure', persist: true, detached: false } });
                  },
                },
                hydrateLfs: async (path: string) => {
                  if (source.origin) {
                    const result = await runSupervisorCommand({ application: 'git', args: ['config', 'remote.origin.url', source.origin], cwd: path, env, signal, deadlineAt, attemptId: `origin-${attachment.attachmentId}`, sequence: 0 });
                    if (result.exitCode !== 0) throw new Error(result.output);
                  }
                  await hydrateGitLfs(path, [source.commit], sourceCheckpoint?.lfs, await options.lfs?.(attachment.projectId));
                  await checkoutGitLfs(path, source.commit);
                },
              };
            })(),
            prerequisites: async (prepared, prepareSignal) => {
              if (attachment.role === 'cache') {
                if (attachment.checkout.kind !== 'shared') throw new Error('Canonical cache requires a workspace branch');
                const key = `${attachment.attachmentId}:${attachment.generation}`;
                const durable = snapshots.query<{ committed: string | null; pending: string | null }, [string]>('SELECT committed,pending FROM snapshots WHERE attachment=?').get(key);
                if (prior?.attachment.cache?.state === 'reclaimed') {
                  if (!sourceCheckpoint) throw new Error('Rehydration requires a canonical checkpoint');
                  await restoreGitIntermediateCheckpoint({ repositoryPath: prepared.rootPath, checkpoint: sourceCheckpoint, branch: attachment.checkout.branch, lfs: await options.lfs?.(attachment.projectId) });
                  snapshots.query('INSERT OR REPLACE INTO snapshots(attachment,revision,pending,committed) VALUES(?,?,NULL,?)').run(key, Date.now(), JSON.stringify(sourceCheckpoint));
                  captures.delete(key);
                }
                if (!durable?.committed && !durable?.pending) {
                  let base = await readGitCacheBase(prepared.rootPath);
                  if (!base && trustedExisting) {
                    const restored = await options.restoredBase?.(attachment.projectId, attachment.workspaceId);
                    if (restored) {
                      await options.gitRemote.fetchCheckpoint({ binding: { projectId: attachment.projectId, repository: `workspace-${attachment.workspaceId}` }, repositoryPath: prepared.rootPath, checkpointRef: restored.checkpointRef, commit: restored.worktreeCommit });
                      base = await completeGitCheckpoint(prepared.rootPath, restored);
                    }
                  }
                  if (!base && sourceCheckpoint && !trustedExisting) {
                    await restoreGitIntermediateCheckpoint({ repositoryPath: prepared.rootPath, checkpoint: sourceCheckpoint, branch: attachment.checkout.branch, lfs: await options.lfs?.(attachment.projectId) });
                    base = sourceCheckpoint;
                  }
                  if (!base && assignment.checkpoint) {
                    const observed = await createGitIntermediateCheckpoint({ repositoryPath: prepared.rootPath, spaceId: attachment.workspaceId, captureId: `admission-${createHash('sha256').update(attachment.attachmentId).digest('hex')}`, revision: Date.now(), lfs: await options.lfs?.(attachment.projectId) });
                    const cloud = assignment.checkpoint;
                    if (observed.headCommit !== cloud.headCommit || observed.branch !== cloud.branch || observed.indexTree !== cloud.indexTree || observed.worktreeTree !== cloud.worktreeTree) throw new Error('Canonical cache lacks a durable applied base; refusing unbased local edits');
                    base = cloud;
                  }
                  if (base) {
                    await saveGitCacheBase(prepared.rootPath, base);
                    snapshots.query('INSERT OR REPLACE INTO snapshots(attachment,revision,committed) VALUES(?,?,?)').run(key, Date.now(), JSON.stringify(base));
                  }
                }
                await executor.withCheckout(prepared, () => reconcile(prepared, assignment.checkpoint));
              }
              await options.prepareAttachment(prepared, prepareSignal, async step => {
                const current = journal.attachment(attachment.attachmentId) ?? prepared;
                const cache = cacheFor(current);
                const setup = [...cache.setup.filter(item => item.phase !== step.phase), step];
                const updated = saveCache(current, { ...cache, state: 'setup', activity: [{ reason: 'setup', name: step.phase }], setup });
                await sendHeartbeat(updated, browserSupport, 0);
              });
            },
          });
          if (attachment.role === 'cache') await executor.withCheckout(local, () => reconcile(local, assignment.checkpoint));
          const checkpoint = attachment.role === 'cache' ? await capture(local) : null;
          const commit = checkpoint?.worktreeCommit ?? source?.commit;
          if (!commit) throw new Error('Attachment readiness requires a canonical checkpoint');
          const ready = await options.cloud.call('runtime.attachment.ready', {
            projectId: attachment.projectId, workspaceId: attachment.workspaceId, machineId: options.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation,
            commit, prerequisitesComplete: true, capabilities, lfsRestored: await gitLfsRestoreReceipt(local.rootPath, 'read'),
          }, RuntimeAttachmentReadyResultSchema, signal);
          local = { ...local, attachment: { ...ready.attachment, cache: attachment.role === 'cache' ? { ...cacheFor(journal.attachment(attachment.attachmentId) ?? local), state: 'live', lastActivityAt: new Date().toISOString() } : undefined, ...(action ? { cacheAction: { ...action, status: 'completed', error: null } } : {}) } };
          journal.installAttachment(local);
          await gitLfsRestoreReceipt(local.rootPath, 'clear');
          if (attachment.role === 'cache') await updateActivity(local);
        } catch (error) {
          const local = journal.attachment(attachment.attachmentId);
          if (local && action) {
            journal.installAttachment({ ...local, attachment: { ...local.attachment, cacheAction: { ...action, status: 'failed', error: error instanceof Error ? error.message : String(error) } } });
            await sendHeartbeat(journal.attachment(attachment.attachmentId) ?? local, browserSupport, 0);
          }
          throw error;
        }
      }
    })().finally(() => { syncing = null; });
    return syncing;
  };
  let heartbeating: Promise<void> | null = null;
  const heartbeat = (): Promise<void> => {
    if (heartbeating) return heartbeating;
    heartbeating = (async () => {
      const browserSupport = await browserCapabilities();
      for (const local of journal.attachments()) {
        if (stopped) return;
        if (local.attachment.state === 'detached') continue;
        if (local.attachment.role === 'cache' && local.attachment.state === 'ready') await updateActivity(local);
        const current = journal.attachment(local.attachment.attachmentId) ?? local;
        await sendHeartbeat(current, browserSupport, journal.unresolved(current.attachment).length);
      }
    })().finally(() => { heartbeating = null; });
    return heartbeating;
  };
  const heartbeatTimer = setInterval(() => { void heartbeat().catch(error => console.error('[runtime-heartbeat]', error instanceof Error ? error.message : String(error))); }, 10_000);
  void sync().catch(error => console.error('[runtime-attachments]', error instanceof Error ? error.message : String(error)));
  const timer = setInterval(() => { void sync().catch(error => console.error('[runtime-attachments]', error instanceof Error ? error.message : String(error))); }, 10_000);
  return { executor, journal, sync,
    useWorkspace: async workspaceId => {
      await syncing;
      const local = journal.attachments().find(item => item.attachment.workspaceId === workspaceId && item.attachment.role === 'cache');
      if (!local) throw new Error('Workspace has no canonical cache assignment');
      if (local.attachment.cache?.state === 'reclaimed' || local.attachment.cache?.state === 'paused' || local.attachment.state === 'attaching') {
        await options.cloud.call('runtime.attachment.cache.request', { projectId: local.attachment.projectId, workspaceId, machineId: options.machineId, requestId: crypto.randomUUID() }, RuntimeJsonSchema, stopping.signal);
      } else touch(local);
      await sync();
      const ready = journal.attachment(local.attachment.attachmentId);
      if (!ready || ready.attachment.state !== 'ready') throw new Error('Canonical cache is not ready');
      await executor.withCheckout(ready, () => reconcile(ready));
    },
    drainWorkspace: async workspaceId => {
      await syncing;
      for (const local of journal.attachments()) {
        const attachment = local.attachment;
        if (attachment.workspaceId !== workspaceId || attachment.role !== 'cache' || attachment.state === 'detached') continue;
        await options.cloud.call('runtime.detach', { projectId: attachment.projectId, workspaceId, machineId: options.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation, state: 'draining' }, RuntimeJsonSchema, stopping.signal);
      }
      await sync();
      if (journal.attachments().some(item => item.attachment.workspaceId === workspaceId && item.attachment.role === 'cache' && item.attachment.state !== 'detached' && item.attachment.cache?.state !== 'reclaimed')) throw new Error('Canonical cache is not safely detached');
    },
    close: async () => {
    stopped = true;
    stopping.abort();
    clearInterval(timer);
    clearInterval(heartbeatTimer);
    for (const entry of watchers.values()) entry.close();
    try {
      await Promise.allSettled([syncing, heartbeating, ...updating.values(), ...[...subscriptions.values()].map(subscription => subscription.settled), ...[...captures.values()].map(capture => capture.settle())]);
      await browser.close();
    } finally {
      await credentialHelper.close();
      snapshots.close();
      journal.close();
    }
  } };
}
