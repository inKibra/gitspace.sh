import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { GitSpaceDatabase, LocalArtifactResolver, MemoryArtifactObjectStore } from '@gitspace/core';
import type { ControlOperation } from '@gitspace/protocol';
import { RuntimeAssignmentsInputSchema, RuntimeAttachmentReadyInputSchema, RuntimeAttachmentSchema, RuntimeDetachInputSchema, RuntimeHeartbeatInputSchema, type RuntimeAttachment, type RuntimeCacheObservation, type RuntimeHeartbeatInput } from '@gitspace/protocol-runtime';
import type { LocalAttachment } from '@gitspace/runtime-machine';
import { daemonClientForProject } from '@gitspace/supervisor';
import { CloudRuntimeClient } from '../src/cloud-runtime-client.js';
import { ArtifactsGitRemote } from '../src/artifacts-git-remote.js';
import { createMachineExecutor, type MachineExecutorRuntime } from '../src/runtime-executor.js';
import type { GitIntermediateCheckpoint } from '../src/git-checkpoint.js';
import { WorkspaceHubTerminalCoordinator } from '../src/workspace-hub.js';
import { ManualWorktreeClock } from './git-worktree-clock.js';

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(stderr);
  return stdout.trim();
}

type Preparation = (local: LocalAttachment, signal: AbortSignal, progress: (step: RuntimeCacheObservation['setup'][number]) => Promise<void>) => Promise<void>;
type Acceptance = (local: LocalAttachment, checkpoint: GitIntermediateCheckpoint, previous: string | null, final?: boolean) => Promise<GitIntermediateCheckpoint>;
type LeaseProof = {
  root: string;
  database: GitSpaceDatabase;
  runtime: MachineExecutorRuntime;
  clock: ManualWorktreeClock;
  leaseClock: ManualWorktreeClock;
  attachments: Map<string, RuntimeAttachment>;
  heartbeats: RuntimeHeartbeatInput[];
  cacheRequests: Record<string, unknown>[];
  nextHeartbeat(): Promise<RuntimeHeartbeatInput>;
};

/** One canonical cache per workspace on this machine, leased by an in-memory cloud that refuses terminal leases. */
async function leaseProof(workspaces: readonly string[], options: { prepareAttachment?: Preparation; commitSnapshot?: Acceptance; provider?: 'physical' | 'cloudflare-sandbox' }, run: (proof: LeaseProof) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-lease-proof-'));
  const remote = join(root, 'remote.git');
  const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
  const clock = new ManualWorktreeClock();
  const leaseClock = new ManualWorktreeClock();
  let runtime: MachineExecutorRuntime | undefined;
  try {
    await git(root, 'init', '--bare', remote);
    database.createProject({ id: 'project', name: 'Project', repositoryPath: join(root, 'base') }).unwrap();
    const attachments = new Map<string, RuntimeAttachment>();
    for (const workspace of workspaces) {
      const checkout = join(root, workspace);
      await mkdir(checkout);
      await git(checkout, 'init', '-b', 'main');
      await git(checkout, 'config', 'user.name', 'Lease proof');
      await git(checkout, 'config', 'user.email', 'proof@example.invalid');
      await writeFile(join(checkout, 'tracked.txt'), `${workspace}\n`);
      await git(checkout, 'add', '.');
      await git(checkout, 'commit', '-m', 'base');
      database.createWorkspace({ id: workspace, projectId: 'project', name: workspace, rootPath: checkout, branch: 'main' }).unwrap();
      database.possessSpace(workspace, 'machine').unwrap();
      const owned = database.getSpace(workspace);
      if (!owned) throw new Error('Owned workspace missing');
      attachments.set(`cache-${workspace}`, RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: workspace, machineId: 'machine', attachmentId: `cache-${workspace}`, generation: 0, ownershipGeneration: owned.generation, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'attaching', capabilities: ['read', 'write'], updatedAt: new Date().toISOString() }));
    }
    const heartbeats: RuntimeHeartbeatInput[] = [];
    const cacheRequests: Record<string, unknown>[] = [];
    let arrived = Promise.withResolvers<RuntimeHeartbeatInput>();
    class LocalCloud extends CloudRuntimeClient {
      override async call<S extends z.ZodType>(operation: ControlOperation, payload: Record<string, unknown>, schema: S, signal?: AbortSignal): Promise<z.output<S>> {
        if (operation === 'runtime.attachment.cache.request') {
          cacheRequests.push(payload);
          throw new Error('A ready replacement already owns the canonical checkout');
        }
        if (operation === 'runtime.assignments') {
          if (RuntimeAssignmentsInputSchema.parse(payload).afterSnapshot) await new Promise<void>((_, reject) => {
            const abort = () => reject(new Error('Subscription canceled'));
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
          });
          return schema.parse({ assignments: [...attachments.values()].filter(attachment => attachment.state !== 'detached').map(attachment => ({ grant: { attachment, executionSecret: 'proof-secret' }, source: null, checkpoint: null, cachePolicy: { idleGraceSeconds: 900, reclaimSeconds: 86400 } })) });
        }
        if (operation === 'runtime.attachment.ready') {
          const input = RuntimeAttachmentReadyInputSchema.parse(payload);
          const current = attachments.get(input.attachmentId);
          if (!current) throw new Error('Unknown attachment');
          const attachment = { ...current, state: 'ready' as const };
          attachments.set(input.attachmentId, attachment);
          return schema.parse({ attachment });
        }
        if (operation === 'runtime.heartbeat') {
          const input = RuntimeHeartbeatInputSchema.parse(payload);
          const attachment = attachments.get(input.attachmentId);
          if (!attachment || !['attaching', 'ready', 'draining'].includes(attachment.state)) throw new Error('Attachment heartbeat has stale authority');
          heartbeats.push(input);
          const delivered = arrived;
          arrived = Promise.withResolvers();
          delivered.resolve(input);
          return schema.parse({ attachment });
        }
        if (operation === 'runtime.detach') {
          const input = RuntimeDetachInputSchema.parse(payload);
          const current = attachments.get(input.attachmentId);
          if (!current) throw new Error('Unknown attachment');
          const attachment = { ...current, state: input.state };
          attachments.set(input.attachmentId, attachment);
          return schema.parse({ attachment });
        }
        throw new Error(`Unexpected operation: ${operation}`);
      }
    }
    class LocalRemote extends ArtifactsGitRemote {
      override async fetchCheckpoint(input: Parameters<ArtifactsGitRemote['fetchCheckpoint']>[0]) { await git(input.repositoryPath, 'fetch', remote, `${input.checkpointRef}:${input.checkpointRef}`); }
      override async publishCheckpoint(input: Parameters<ArtifactsGitRemote['publishCheckpoint']>[0]) { await git(input.repositoryPath, 'push', remote, `${input.checkpointRef}:${input.checkpointRef}`); }
    }
    const unavailable = async (): Promise<never> => { throw new Error('External service forbidden'); };
    runtime = await createMachineExecutor({
      checkpointClock: clock, leaseClock, checkpointEvents: () => () => {}, provider: options.provider,
      environmentRoot: join(root, 'runtime'), machineId: 'machine', database,
      artifacts: new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'artifacts'), new Uint8Array(32)),
      cloud: new LocalCloud({ baseUrl: 'https://proof.invalid', userId: 'account', machineId: 'machine', signingPrivateKey: new Uint8Array(32) }),
      gitRemote: new LocalRemote({ credentials: unavailable }), originGitEnvironment: unavailable,
      prepareAttachment: options.prepareAttachment ?? (async () => {}),
      commitSnapshot: options.commitSnapshot ?? (async (_local, checkpoint) => checkpoint),
    });
    await run({ root, database, runtime, clock, leaseClock, attachments, heartbeats, cacheRequests, nextHeartbeat: () => arrived.promise });
  } finally { await runtime?.close(); database.close(); await rm(root, { recursive: true, force: true }); }
}

test('a failing assignment is recorded on its attachment while a later assignment still becomes ready', async () => {
  await leaseProof(['broken', 'healthy'], {
    prepareAttachment: async local => { if (local.attachment.workspaceId === 'broken') throw new Error('apt-get: unable to locate package'); },
  }, async ({ runtime, clock, heartbeats }) => {
    await clock.until(runtime.sync(), 15_000);
    expect(runtime.journal.attachment('cache-healthy')?.attachment.state).toBe('ready');
    const failure = runtime.journal.attachment('cache-broken')?.attachment.failure;
    expect(failure).toMatchObject({ operation: 'setup', message: 'apt-get: unable to locate package', attempts: 1 });
    if (!failure?.nextRetryAt) throw new Error('Failure carries no retry time');
    expect(Date.parse(failure.nextRetryAt)).toBeGreaterThan(Date.parse(failure.at));
    expect(heartbeats.filter(heartbeat => heartbeat.attachmentId === 'cache-broken' && heartbeat.failure).at(-1)?.failure).toEqual(failure);
    // Backoff: the next sync does not hot-loop the same failing intent.
    await clock.until(runtime.sync(), 15_000);
    expect(runtime.journal.attachment('cache-broken')?.attachment.failure?.attempts).toBe(1);
  });
}, 30_000);

test("a workspace operation never waits for another workspace's long setup", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await leaseProof(['quick', 'slow'], {
    prepareAttachment: async local => {
      if (local.attachment.workspaceId !== 'slow') return;
      entered.resolve();
      await release.promise;
    },
  }, async ({ runtime, clock }) => {
    const everything = runtime.sync();
    await clock.until(entered.promise, 15_000);
    await clock.until(runtime.useWorkspace('quick'), 15_000);
    expect(runtime.journal.attachment('cache-quick')?.attachment.state).toBe('ready');
    expect(runtime.journal.attachment('cache-slow')?.attachment.state).toBe('attaching');
    release.resolve();
    await clock.until(everything, 15_000);
    expect(runtime.journal.attachment('cache-slow')?.attachment.state).toBe('ready');
  });
}, 30_000);

test('a terminal uses the ready replacement cache after its predecessor detaches', async () => {
  let retired = false;
  const publications: { attachmentId: string; generation: number; checkpoint: GitIntermediateCheckpoint }[] = [];
  await leaseProof(['workspace'], {
    commitSnapshot: async (local, checkpoint) => {
      if (retired && local.attachment.attachmentId === 'cache-workspace') throw new Error('Detached cache cannot publish the replacement checkout');
      publications.push({ attachmentId: local.attachment.attachmentId, generation: local.attachment.generation, checkpoint });
      return checkpoint;
    },
  }, async ({ root, database, runtime, clock, attachments, cacheRequests }) => {
    await clock.until(runtime.sync(), 15_000);
    const original = attachments.get('cache-workspace');
    if (original?.state !== 'ready') throw new Error('Original cache did not become ready');
    attachments.set(original.attachmentId, { ...original, state: 'draining', detachRequest: {} });
    await clock.until(runtime.sync(), 15_000);
    expect(runtime.journal.attachment(original.attachmentId)?.attachment.state).toBe('detached');
    retired = true;

    const replacement = { ...original, attachmentId: 'replacement-cache', generation: original.generation + 1, state: 'attaching' as const };
    attachments.set(replacement.attachmentId, replacement);
    await clock.until(runtime.sync(), 15_000);
    expect(runtime.journal.attachment(replacement.attachmentId)?.attachment).toMatchObject({ state: 'ready', generation: 1 });
    const detached = runtime.journal.attachment(original.attachmentId);
    const checkout = join(root, 'workspace');
    // A real edit forces useWorkspace to publish through the selected generation,
    // rather than merely accepting a ready state from the journal.
    publications.length = 0;
    await writeFile(join(checkout, 'tracked.txt'), 'replacement terminal checkout\n');
    const terminals = new WorkspaceHubTerminalCoordinator(database, 'machine', undefined, {
      path: workspaceId => runtime.journal.attachments().find(local => local.attachment.workspaceId === workspaceId && local.attachment.role === 'cache' && local.attachment.state === 'ready')?.rootPath ?? null,
      use: workspaceId => runtime.useWorkspace(workspaceId),
      changed: () => runtime.sync(),
    });
    const client = await daemonClientForProject(checkout);
    try {
      const terminal = await clock.until(terminals.createShell('workspace'), 15_000);
      expect(terminal).toMatchObject({ kind: 'user', cwd: checkout, machineId: 'machine' });
      await terminals.send('workspace', terminal.name, 'cat tracked.txt; exit\r');
      await client.request({ op: 'wait', name: terminal.name, for: 'exit', timeoutMs: 5000 });
      expect((await terminals.read('workspace', terminal.name, null)).data).toContain('replacement terminal checkout');
      const published = publications.at(-1);
      expect(published).toMatchObject({ attachmentId: replacement.attachmentId, generation: 1 });
      if (!published) throw new Error('Terminal use did not publish the checkout edit');
      expect(await git(join(root, 'remote.git'), 'show', `${published.checkpoint.worktreeCommit}:tracked.txt`)).toBe('replacement terminal checkout');
      expect(cacheRequests).toEqual([]);
      expect(runtime.journal.attachment(original.attachmentId)).toEqual(detached);
    } finally {
      await client.request({ op: 'shutdown' });
    }
  });
}, 30_000);

test('a long setup phase renews its lease with progress heartbeats until the phase completes', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await leaseProof(['workspace'], {
    prepareAttachment: async (_local, _signal, progress) => {
      await progress({ phase: 'machine/prepare', state: 'running', runId: 'setup', error: null });
      entered.resolve();
      await release.promise;
      await progress({ phase: 'machine/prepare', state: 'succeeded', runId: 'setup', error: null });
    },
  }, async ({ runtime, clock, leaseClock, nextHeartbeat }) => {
    const prepared = runtime.sync();
    await clock.until(entered.promise, 15_000);
    const renewals: RuntimeHeartbeatInput[] = [];
    for (let tick = 0; tick < 3; tick++) {
      await leaseClock.pending(20_000);
      const renewal = nextHeartbeat();
      leaseClock.advance(20_000);
      renewals.push(await renewal);
    }
    expect(renewals.map(heartbeat => [heartbeat.attachmentId, heartbeat.progress?.phase])).toEqual(Array.from({ length: 3 }, () => ['cache-workspace', 'machine/prepare']));
    release.resolve();
    await clock.until(prepared, 15_000);
    expect(runtime.journal.attachment('cache-workspace')?.attachment.state).toBe('ready');
    expect(leaseClock.remaining(20_000)).toBeUndefined();
  });
}, 30_000);

test('a long drain renews its lease with progress heartbeats until the checkout is released', async () => {
  const committing = Promise.withResolvers<void>();
  const accept = Promise.withResolvers<void>();
  await leaseProof(['workspace'], {
    commitSnapshot: async (_local, checkpoint, _previous, final) => {
      if (final) { committing.resolve(); await accept.promise; }
      return checkpoint;
    },
  }, async ({ runtime, clock, leaseClock, attachments, nextHeartbeat }) => {
    await clock.until(runtime.sync(), 15_000);
    const local = runtime.journal.attachment('cache-workspace');
    if (local?.attachment.state !== 'ready') throw new Error('Cache did not become ready');
    // This isolated checkout is test-owned; production journals obtain this evidence at acquisition.
    runtime.journal.installAttachment({ ...local, ownedCheckout: true });
    const assigned = attachments.get('cache-workspace');
    if (!assigned) throw new Error('Missing assignment');
    attachments.set('cache-workspace', { ...assigned, state: 'draining', detachRequest: {} });
    const drained = runtime.sync();
    await clock.until(committing.promise, 15_000);
    const renewals: RuntimeHeartbeatInput[] = [];
    for (let tick = 0; tick < 2; tick++) {
      await leaseClock.pending(20_000);
      const renewal = nextHeartbeat();
      leaseClock.advance(20_000);
      renewals.push(await renewal);
    }
    expect(renewals.map(heartbeat => [heartbeat.attachmentId, heartbeat.progress?.phase])).toEqual([['cache-workspace', 'drain'], ['cache-workspace', 'drain']]);
    accept.resolve();
    await clock.until(drained, 15_000);
    expect(runtime.journal.attachment('cache-workspace')?.attachment.state).toBe('detached');
    expect(leaseClock.remaining(20_000)).toBeUndefined();
  });
}, 30_000);

for (const provider of ['cloudflare-sandbox', 'physical'] as const) test(`a lost cache stops its processes and ${provider === 'cloudflare-sandbox' ? 'removes' : 'retains'} its checkout`, async () => {
  await leaseProof(['workspace'], { provider }, async ({ root, runtime, clock, attachments }) => {
    await clock.until(runtime.sync(), 15_000);
    const local = runtime.journal.attachment('cache-workspace');
    if (local?.attachment.state !== 'ready') throw new Error('Cache did not become ready');
    // This isolated checkout is test-owned; production journals obtain this evidence at acquisition.
    runtime.journal.installAttachment({ ...local, ownedCheckout: true });
    const checkout = join(root, 'workspace');
    const client = await daemonClientForProject(checkout);
    await client.request({ op: 'start', owner: 'gitspace:workspace:user', spec: { name: 'lost-terminal', application: '/bin/sh', args: ['-c', 'read value'], env: {}, cwd: checkout, pty: true, restart: 'no', persist: false, detached: false } });
    try {
      const assigned = attachments.get('cache-workspace');
      if (!assigned) throw new Error('Missing assignment');
      attachments.set('cache-workspace', { ...assigned, state: 'lost', lossReason: 'deadline' });
      await clock.until(runtime.sync(), 15_000);
      const listed = await client.request({ op: 'list' });
      if (listed.op !== 'list') throw new Error('Unexpected supervisor response');
      expect(listed.daemons.filter(daemon => !['exited', 'failed'].includes(daemon.state)).map(daemon => daemon.name)).toEqual([]);
      const lost = runtime.journal.attachment('cache-workspace');
      expect(lost?.attachment.state).toBe('lost');
      expect(lost?.lostCheckout).toBe(provider === 'cloudflare-sandbox' ? 'removed' : 'orphaned');
      expect(await Bun.file(join(checkout, 'tracked.txt')).exists()).toBe(provider === 'physical');
    } finally { await client.request({ op: 'stop', name: 'lost-terminal', timeoutMs: 5000 }).catch(() => {}); }
  });
}, 30_000);
