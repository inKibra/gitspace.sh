import { mkdir, chmod, readFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { ExecutorJournal, MachineExecutor, MachineBrowser, runSupervisorCommand, prepareMachineAttachment, cleanupMachineAttachment, type ExecutorArtifactAccess, type RuntimeBrowserRelay } from '@gitspace/runtime-machine';
import { RuntimeJsonSchema, RuntimeGitCheckpointSchema, RuntimeAssignmentsResultSchema, RuntimeAttachmentReadyResultSchema, RuntimeHeartbeatInputSchema, RuntimeBrowserPublicKeySchema, browserUnbase64, verifyRuntimeBrowserAuthorization } from '@gitspace/protocol-runtime';
import type { GitSpaceDatabase, LocalArtifactResolver } from '@gitspace/core';
import type { CloudRuntimeClient } from './cloud-runtime-client.js';
import { Database } from 'bun:sqlite';
import { IncrementalGitSnapshots, restoreGitIntermediateCheckpoint } from './git-checkpoint.js';
import type { GitIntermediateCheckpoint } from './git-checkpoint.js';
import type { ArtifactsGitRemote } from './artifacts-git-remote.js';
import type { LocalAttachment, ExecutorOperationHandler } from '@gitspace/runtime-machine';
import { createArtifactsCredentialHelper } from './artifacts-credential-helper.js';
import { daemonClientForProject } from '@gitspace/supervisor';
import { checkoutGitLfs, gitLfsRestoreReceipt, hydrateGitLfs, restoredGitLfsPaths, type MachineGitLfs } from './git-lfs.js';

export type MachineExecutorRuntime = { executor: MachineExecutor; journal: ExecutorJournal; sync(): Promise<void>; drainWorkspace(workspaceId: string): Promise<void>; checkpointWorkspace(workspaceId: string): Promise<void>; close(): Promise<void> };
export async function createMachineExecutor(options: {
  environmentRoot: string; machineId: string; database: GitSpaceDatabase; artifacts: LocalArtifactResolver; cloud: CloudRuntimeClient;
  gitRemote: ArtifactsGitRemote;
  lfs?: (projectId: string, publicationId?: string) => Promise<MachineGitLfs>;
  operations?: Record<string, ExecutorOperationHandler>;
  browser?: { enabled: boolean; relay?: RuntimeBrowserRelay };
  commitSnapshot(local: LocalAttachment, checkpoint: GitIntermediateCheckpoint, previousWorktreeCommit: string | null, final?: boolean): Promise<void>;
  prepareAttachment(local: LocalAttachment, signal: AbortSignal): Promise<void>;
  originGitEnvironment(origin: string): Promise<Record<string, string>>;
  artifactFsBinary?: string;
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
  const capture = async (local: LocalAttachment): Promise<GitIntermediateCheckpoint | null> => {
    if (local.attachment.role !== 'primary' || !['attaching', 'ready', 'draining'].includes(local.attachment.state)) return null;
    const key = `${local.attachment.attachmentId}:${local.attachment.generation}`;
    let stream = captures.get(key);
    if (!stream) {
      snapshots.query('INSERT OR IGNORE INTO snapshots (attachment, revision) VALUES (?, ?)').run(key, Date.now());
      stream = new IncrementalGitSnapshots({
        repositoryPath: local.rootPath,
        spaceId: local.attachment.workspaceId,
        lfs: options.lfs?.bind(undefined, local.attachment.projectId),
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
          await options.commitSnapshot(local, checkpoint, previous?.worktreeCommit ?? null);
          snapshots.query('UPDATE snapshots SET pending=NULL, committed=? WHERE attachment=?').run(JSON.stringify(checkpoint), key);
        },
      });
      captures.set(key, stream);
    }
    return stream.capture();
  };
  const trustedBrowserKeys = new Map<string, Promise<CryptoKey>>();
  const browserDirectory = join(homedir(), '.gitspace-browser-profiles', createHash('sha256').update(options.machineId).digest('hex'));
  const browserRelative = relative(resolve(options.environmentRoot), browserDirectory);
  if (options.browser?.enabled && (!browserRelative || (!browserRelative.startsWith('..') && !isAbsolute(browserRelative)))) throw new Error('Browser profiles must be outside the environment root');
  const browser = new MachineBrowser({
    directory: browserDirectory, enabled: options.browser?.enabled === true, relay: options.browser?.relay,
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
    onMutationSettled: capture,
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
    cloudModel: input => options.cloud.call('runtime.model', { dispatch: input.dispatch, operation: input.operation, args: input.args }, RuntimeJsonSchema, input.signal),
    cloudMcp: input => options.cloud.call('runtime.mcp', { dispatch: input.dispatch, callId: input.callId, method: input.method, args: input.args }, RuntimeJsonSchema, input.signal),
  });
  const baseCapabilities = ['read', 'write', 'edit', 'apply_patch', 'bash', 'grep', 'find', 'ast_grep', 'rule_match_ast', 'ast_edit', 'ast_resolve', 'codemode', ...Object.keys(options.operations ?? {})];
  const browserCapabilities = async (): Promise<string[]> => {
    if (options.browser?.enabled !== true) return [];
    const relayConnected = await options.browser.relay?.status().then(status => status.connected, () => false) ?? false;
    return ['browser', 'browser_control', 'browser.headless', ...(relayConnected ? ['browser.relay'] : [])];
  };
  const isBrowserCapability = (capability: string) => capability === 'browser' || capability === 'browser_control' || capability.startsWith('browser.');
  let stopped = false;
  let syncing: Promise<void> | null = null;
  const sync = (): Promise<void> => {
    if (syncing) return syncing;
    syncing = (async () => {
      const browserSupport = await browserCapabilities();
      const capabilities = [...baseCapabilities, ...browserSupport];
      for (const local of journal.attachments()) {
        if (local.attachment.role !== 'primary' || local.attachment.state !== 'ready') continue;
        const space = options.database.getSpace(local.attachment.workspaceId);
        if (!space || space.holderId !== options.machineId || space.placementState !== 'open' || space.generation !== (local.attachment.ownershipGeneration ?? local.attachment.generation)) {
          journal.installAttachment({ ...local, attachment: { ...local.attachment, state: 'draining' } });
        }
      }
      const assignments = await options.cloud.call('runtime.assignments', { machineId: options.machineId }, RuntimeAssignmentsResultSchema, stopping.signal);
      for (const assignment of assignments.assignments) {
        if (stopped) return;
        const { attachment } = assignment.grant;
        if (attachment.machineId !== options.machineId) throw new Error('Invalid remote attachment assignment');
        if (attachment.role === 'primary') {
          if (attachment.checkout.kind !== 'shared') throw new Error('Primary requires a shared checkout');
          const space = options.database.getSpace(attachment.workspaceId);
          const existing = journal.attachment(attachment.attachmentId);
          const ownsCheckout = space && space.holderId === options.machineId && space.placementState === 'open' && space.generation === (attachment.ownershipGeneration ?? attachment.generation) && space.branch === attachment.checkout.branch;
          if (attachment.state === 'draining') {
            if (!existing) {
              if (!ownsCheckout) throw new Error('Primary cleanup lacks recorded canonical checkout');
              journal.installAttachment({ attachment, executionSecret: assignment.grant.executionSecret, rootPath: space.rootPath, prerequisitesComplete: true });
            }
            const local = await cleanupMachineAttachment(journal, {
              attachment, checkoutRoot: directory, signal: stopping.signal,
              stopAndVerify: async owned => {
                if (journal.attachment(attachment.attachmentId)?.attachment.state !== 'detached') await executor.drain(owned);
                await browser.closeAttachment(owned);
                const client = await daemonClientForProject(owned.rootPath);
                const owner = `runtime:${attachment.attachmentId}:${attachment.generation}`;
                const listed = await client.request({ op: 'list' }, stopping.signal);
                if (listed.op !== 'list') throw new Error('Primary cleanup could not enumerate supervisor processes');
                for (const daemon of listed.daemons.filter(daemon => daemon.owner === owner)) {
                  const result = await client.request({ op: 'stop', name: daemon.name, timeoutMs: 5000 }, stopping.signal);
                  if (result.op !== 'stop' || !['exited', 'failed'].includes(result.daemon.state)) throw new Error('Primary process termination is unverified');
                }
                const verified = await client.request({ op: 'list' }, stopping.signal);
                if (verified.op !== 'list' || verified.daemons.some(daemon => daemon.owner === owner && !['exited', 'failed'].includes(daemon.state))) throw new Error('Primary attachment retains live supervisor processes');
                const checkpoint = await capture({ ...owned, attachment: { ...owned.attachment, state: 'draining' } });
                if (!checkpoint) throw new Error('Primary final checkpoint was not captured');
                await options.commitSnapshot(owned, checkpoint, checkpoint.worktreeCommit, true);
              },
              verifyUnmounted: async () => { throw new Error('Primary cleanup must never unmount shared checkout'); },
            });
            await options.cloud.call('runtime.detach', { projectId: attachment.projectId, workspaceId: attachment.workspaceId, machineId: options.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation, state: local.attachment.state }, RuntimeJsonSchema, stopping.signal);
            continue;
          }
          if (attachment.state === 'lost') {
            if (existing) journal.installAttachment({ ...existing, attachment });
            continue;
          }
          if (!ownsCheckout) throw new Error('Primary assignment requires materialized canonical checkout ownership');
          if (!attachment.capabilities.filter(capability => !isBrowserCapability(capability)).every(capability => capabilities.includes(capability))) throw new Error('Executor lacks assigned primary capabilities');
          if (!existing && assignment.checkpoint) {
            const checkpoint = assignment.checkpoint;
            await options.gitRemote.fetchCheckpoint({ binding: { projectId: attachment.projectId, repository: `workspace-${attachment.workspaceId}` }, repositoryPath: space.rootPath, checkpointRef: checkpoint.checkpointRef, commit: checkpoint.worktreeCommit });
            await restoreGitIntermediateCheckpoint({ repositoryPath: space.rootPath, checkpoint, branch: attachment.checkout.branch, lfs: await options.lfs?.(attachment.projectId) });
            snapshots.query('INSERT OR REPLACE INTO snapshots(attachment,revision,committed) VALUES(?,?,?)').run(`${attachment.attachmentId}:${attachment.generation}`, Date.now(), JSON.stringify(checkpoint));
          }
          const enrolled = await options.cloud.attach({ projectId: attachment.projectId, workspaceId: attachment.workspaceId, machineId: attachment.machineId, generation: attachment.generation, ownershipGeneration: attachment.ownershipGeneration, role: attachment.role, checkout: attachment.checkout, capabilities: [...attachment.capabilities.filter(capability => !isBrowserCapability(capability)), ...browserSupport] });
          let local: LocalAttachment = { ...assignment.grant, attachment: enrolled.attachment, rootPath: space.rootPath, prerequisitesComplete: true };
          journal.installAttachment(local);
          if (local.attachment.state === 'attaching') {
            const checkpoint = assignment.checkpoint ?? await capture(local);
            if (!checkpoint) throw new Error('Primary readiness requires a canonical checkpoint');
            const ready = await options.cloud.call('runtime.attachment.ready', {
              projectId: attachment.projectId, workspaceId: attachment.workspaceId, machineId: options.machineId,
              attachmentId: attachment.attachmentId, generation: attachment.generation, commit: checkpoint.worktreeCommit,
              prerequisitesComplete: true, capabilities,
              lfsRestored: await gitLfsRestoreReceipt(space.rootPath, 'read'),
            }, RuntimeAttachmentReadyResultSchema, stopping.signal);
            local = { ...local, attachment: ready.attachment };
            journal.installAttachment(local);
            await gitLfsRestoreReceipt(space.rootPath, 'clear');
          }
          await capture(local);
          continue;
        }
        if (attachment.checkout.kind === 'shared' || !assignment.source) throw new Error('Private assignment requires an immutable source');
        const name = Buffer.from(attachment.attachmentId).toString('base64url');
        const checkoutRoot = join(directory, 'copies', name);
        const grant: LocalAttachment = { attachment, executionSecret: assignment.grant.executionSecret, rootPath: join(checkoutRoot, name), prerequisitesComplete: false };
        if (attachment.state === 'lost') {
          const existing = journal.attachment(attachment.attachmentId);
          if (existing && existing.attachment.generation === attachment.generation) journal.installAttachment({ ...existing, attachment });
          continue;
        }
        if (attachment.state === 'draining') {
          const local = await cleanupMachineAttachment(journal, {
            attachment, checkoutRoot, signal: stopping.signal,
            stopAndVerify: async owned => {
              if (journal.attachment(attachment.attachmentId)?.attachment.state !== 'detached') await executor.drain(owned);
              await browser.closeAttachment(owned);
              for (const root of [owned.rootPath, checkoutRoot]) {
                const client = await daemonClientForProject(root);
                const listed = await client.request({ op: 'list' }, stopping.signal);
                if (listed.op !== 'list') throw new Error('Cleanup could not enumerate supervisor processes');
                for (const daemon of listed.daemons) {
                  const stopped = await client.request({ op: 'stop', name: daemon.name, timeoutMs: 5000 }, stopping.signal);
                  if (stopped.op !== 'stop' || !['exited', 'failed'].includes(stopped.daemon.state)) throw new Error('Cleanup process termination is unverified');
                }
                const verified = await client.request({ op: 'list' }, stopping.signal);
                if (verified.op !== 'list' || verified.daemons.some(daemon => !['exited', 'failed'].includes(daemon.state))) throw new Error('Cleanup has live supervisor processes');
              }
            },
            verifyUnmounted: async root => {
              if (process.platform !== 'linux') throw new Error('Checkout cleanup mount verification requires Linux');
              const mounts = await readFile('/proc/self/mountinfo', 'utf8');
              const mounted = mounts.split('\n').some(line => {
                const path = line.split(' ')[4]?.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
                return path === root || path?.startsWith(`${root}/`);
              });
              if (mounted) {
                const unmount = await runSupervisorCommand({ application: 'fusermount3', args: ['-u', '--', root], cwd: checkoutRoot, attemptId: `cleanup-${attachment.attachmentId}-${attachment.generation}`, sequence: 0, deadlineAt: new Date(Date.now() + 30_000).toISOString(), signal: stopping.signal });
                if (unmount.exitCode !== 0) throw new Error('ArtifactFS unmount failed; checkout retained');
                const after = await readFile('/proc/self/mountinfo', 'utf8');
                if (after.split('\n').some(line => {
                  const path = line.split(' ')[4]?.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
                  return path === root || path?.startsWith(`${root}/`);
                })) throw new Error('ArtifactFS mount remains present; checkout retained');
              }
            },
          });
          await options.cloud.call('runtime.detach', {
            projectId: attachment.projectId, workspaceId: attachment.workspaceId, machineId: options.machineId,
            attachmentId: attachment.attachmentId, generation: attachment.generation, state: local.attachment.state,
          }, RuntimeJsonSchema, stopping.signal);
          continue;
        }
        const source = assignment.source;
        if (!source.remote) throw new Error('Attachment preparation requires an authorized repository remote');
        const env = credentialHelper.environment(grant, source.remote);
        const signal = AbortSignal.any([stopping.signal, AbortSignal.timeout(30 * 60_000)]);
        const deadlineAt = new Date(Date.now() + 30 * 60_000).toISOString();
        let sequence = 0;
        const git = async (path: string, args: string[], environment: Record<string, string> = env) => {
          const result = await runSupervisorCommand({ application: 'git', args, cwd: path, env: environment, signal, deadlineAt, attemptId: `acquire-lfs-${attachment.attachmentId}`, sequence: sequence++ });
          if (result.exitCode !== 0) throw new Error(result.output);
          return result.output.trim();
        };
        const local = await prepareMachineAttachment(journal, {
          enrolled: assignment.grant, checkoutRoot, deadlineAt, signal,
          source: {
            kind: 'artifacts', repository: { ...source, remote: source.remote },
            requiresFiltersOrSubmodules: source.requiresFiltersOrSubmodules,
            host: {
              binary: options.artifactFsBinary, root: checkoutRoot,
              gitEnvironment: async () => env,
              ensureDaemon: async spec => {
                const client = await daemonClientForProject(checkoutRoot);
                await client.request({ op: 'start', owner: attachment.attachmentId, spec: {
                  name: `artifactfs-${name}`, application: spec.binary, args: spec.args, cwd: checkoutRoot,
                  inheritEnv: true, env: spec.env, pty: false, restart: 'on-failure', persist: true, detached: false,
                } });
              },
            },
            hydrateLfs: async path => {
              if (source.origin) await git(path, ['config', 'remote.origin.url', source.origin]);
              await hydrateGitLfs(path, [source.commit], assignment.checkpoint?.lfs, await options.lfs?.(attachment.projectId));
              await checkoutGitLfs(path, source.commit);
            },
          },
          prerequisites: options.prepareAttachment,
        });
        const ready = await options.cloud.call('runtime.attachment.ready', {
          projectId: attachment.projectId, workspaceId: attachment.workspaceId, machineId: options.machineId,
          attachmentId: attachment.attachmentId, generation: attachment.generation, commit: source.commit,
          prerequisitesComplete: true, capabilities,
          lfsRestored: assignment.checkpoint ? await restoredGitLfsPaths(local.rootPath, source.commit, assignment.checkpoint.lfs) : undefined,
        }, RuntimeAttachmentReadyResultSchema, signal);
        journal.installAttachment({ ...local, attachment: ready.attachment });
      }
    })().finally(() => { syncing = null; });
    return syncing;
  };
  let heartbeating: Promise<void> | null = null;
  const heartbeat = (): Promise<void> => {
    if (heartbeating) return heartbeating;
    heartbeating = (async () => {
      const attachments = journal.attachments().filter(local => local.attachment.state === 'ready');
      const browserSupport = await browserCapabilities();
      const processes = new Map<string, string>();
      for (const rootPath of new Set(attachments.map(local => local.rootPath))) {
        const client = await daemonClientForProject(rootPath);
        const reply = await client.request({ op: 'list' }, stopping.signal);
        if (reply.op !== 'list') throw new Error('Supervisor returned invalid load observation');
        for (const process of reply.daemons) processes.set(process.id, process.state);
      }
      const activeExecutions = [...processes.values()].filter(state => state !== 'exited' && state !== 'failed').length;
      const observedAt = new Date().toISOString();
      for (const local of attachments) {
        if (stopped) return;
        await options.cloud.call('runtime.heartbeat', RuntimeHeartbeatInputSchema.parse({
          projectId: local.attachment.projectId, workspaceId: local.attachment.workspaceId,
          machineId: options.machineId, attachmentId: local.attachment.attachmentId,
          generation: local.attachment.generation, executionObservation: { activeExecutions, observedAt },
          browserCapabilities: browserSupport,
        }), RuntimeJsonSchema, stopping.signal);
        const current = journal.attachment(local.attachment.attachmentId);
        if (current?.attachment.state === 'ready' && current.attachment.generation === local.attachment.generation) {
          journal.installAttachment({ ...current, attachment: { ...current.attachment, capabilities: [...current.attachment.capabilities.filter(capability => !isBrowserCapability(capability)), ...browserSupport] } });
        }
      }
    })().finally(() => { heartbeating = null; });
    return heartbeating;
  };
  const heartbeatTimer = setInterval(() => { void heartbeat().catch(error => console.error('[runtime-heartbeat]', error instanceof Error ? error.message : String(error))); }, 10_000);
  void sync().catch(error => console.error('[runtime-attachments]', error instanceof Error ? error.message : String(error)));
  const timer = setInterval(() => { void sync().catch(error => console.error('[runtime-attachments]', error instanceof Error ? error.message : String(error))); }, 10_000);
  return { executor, journal, sync,
    checkpointWorkspace: async workspaceId => {
      const local = journal.attachments().find(item => item.attachment.workspaceId === workspaceId && item.attachment.role === 'primary' && item.attachment.state === 'ready');
      if (!local || !await capture(local)) throw new Error('Checkpoint requires the current ready primary');
    },
    drainWorkspace: async workspaceId => {
      await syncing;
      for (const local of journal.attachments()) {
        const attachment = local.attachment;
        if (attachment.workspaceId !== workspaceId || attachment.role !== 'primary' || attachment.state === 'detached') continue;
        await options.cloud.call('runtime.detach', { projectId: attachment.projectId, workspaceId, machineId: options.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation, state: 'draining' }, RuntimeJsonSchema, stopping.signal);
      }
      await sync();
      if (journal.attachments().some(item => item.attachment.workspaceId === workspaceId && item.attachment.role === 'primary' && item.attachment.state !== 'detached')) throw new Error('Primary writer is not safely detached');
    },
    close: async () => {
    stopped = true;
    stopping.abort();
    clearInterval(timer);
    clearInterval(heartbeatTimer);
    try {
      await Promise.allSettled([syncing, heartbeating, ...[...captures.values()].map(capture => capture.settle())]);
      await browser.close();
    } finally {
      await credentialHelper.close();
      snapshots.close();
      journal.close();
    }
  } };
}
