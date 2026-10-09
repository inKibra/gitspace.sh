import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { GitSpaceDatabase, LocalArtifactResolver, MemoryArtifactObjectStore } from '@gitspace/core';
import type { ControlOperation } from '@gitspace/protocol';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema, type RuntimeSnapshotCommitInput } from '@gitspace/protocol-runtime';
import { CloudRuntimeClient } from '../src/cloud-runtime-client.js';
import { ArtifactsGitRemote } from '../src/artifacts-git-remote.js';
import { createMachineExecutor, type MachineExecutorRuntime } from '../src/runtime-executor.js';
import { ManualWorktreeClock } from './git-worktree-clock.js';

type Checkpoint = RuntimeSnapshotCommitInput['checkpoint'];
const canonicalRef = 'refs/gitspace/spaces/workspace/checkpoints';
const artifactsUrl = 'https://artifacts.invalid/workspace-workspace';

async function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: {
    ...Bun.env, ...env, GIT_AUTHOR_NAME: 'Cloud proof', GIT_AUTHOR_EMAIL: 'cloud@example.invalid', GIT_COMMITTER_NAME: 'Cloud proof', GIT_COMMITTER_EMAIL: 'cloud@example.invalid',
  } });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(stderr);
  return stdout.trim();
}

test('two caches of one workspace converge when a canonical snapshot reaches a cache its own publication overtook', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-multi-cache-'));
  const remote = join(root, 'remote.git'), seed = join(root, 'seed');
  const clock = new ManualWorktreeClock();
  const runtimes: MachineExecutorRuntime[] = [];
  const databases: GitSpaceDatabase[] = [];
  // The cloud merge owner: three-way merge onto the current tip, then advance the one
  // canonical ref only from that tip, as publishSnapshotPack does for every cache.
  const cloud: { tip: Checkpoint | null } = { tip: null };
  const commitSnapshot = async (candidate: Checkpoint, previous: string | null): Promise<Checkpoint> => {
    const tip = cloud.tip;
    let worktreeTree = candidate.worktreeTree;
    if (tip && previous) {
      const index = { GIT_INDEX_FILE: join(root, `merge-${crypto.randomUUID()}`) };
      await git(remote, ['read-tree', '-i', '-m', previous, tip.worktreeCommit, candidate.worktreeCommit], index);
      worktreeTree = await git(remote, ['write-tree'], index);
    }
    const worktreeCommit = await git(remote, ['commit-tree', worktreeTree, ...(tip ? ['-p', tip.worktreeCommit] : []), '-p', candidate.worktreeCommit, '-m', 'Accepted canonical snapshot']);
    await git(remote, ['update-ref', canonicalRef, worktreeCommit, tip?.worktreeCommit ?? '0'.repeat(40)]);
    cloud.tip = { ...candidate, checkpointRef: canonicalRef, worktreeCommit, worktreeTree };
    return cloud.tip;
  };
  const machine = async (machineId: string) => {
    const checkout = join(root, machineId);
    await git(root, ['clone', '--quiet', seed, checkout]);
    // The real Artifacts transport; only its URL resolves to the local bare repository.
    await git(checkout, ['config', `url.${remote}.insteadOf`, artifactsUrl]);
    const database = new GitSpaceDatabase(join(root, `${machineId}.db`));
    databases.push(database);
    database.createProject({ id: 'project', name: 'Project', repositoryPath: join(root, 'base') }).unwrap();
    database.createWorkspace({ id: 'workspace', projectId: 'project', name: 'Workspace', rootPath: checkout, branch: 'main' }).unwrap();
    database.possessSpace('workspace', machineId).unwrap();
    const owned = database.getSpace('workspace');
    if (!owned) throw new Error('Owned workspace missing');
    let attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', machineId, attachmentId: `${machineId}-cache`, generation: 0, ownershipGeneration: owned.generation, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'attaching', capabilities: ['read', 'checkpoint'], updatedAt: new Date().toISOString() });
    class LocalCloud extends CloudRuntimeClient {
      override async call<S extends z.ZodType>(operation: ControlOperation, payload: Record<string, unknown>, schema: S, signal?: AbortSignal): Promise<z.output<S>> {
        if (operation === 'runtime.assignments') {
          // Follow subscriptions stay parked; canonical snapshots arrive through dispatches.
          if (payload.afterSnapshot) await new Promise<void>((_, reject) => {
            const abort = () => reject(new Error('Subscription canceled'));
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
          });
          return schema.parse({ assignments: [{ grant: { attachment, executionSecret: 'proof-secret' }, source: null, checkpoint: cloud.tip }] });
        }
        if (operation === 'runtime.attachment.ready') { attachment = { ...attachment, state: 'ready' }; return schema.parse({ attachment }); }
        if (operation === 'runtime.heartbeat') return schema.parse({ attachment });
        throw new Error(`Unexpected operation: ${operation}`);
      }
    }
    const unavailable = async (): Promise<never> => { throw new Error('External service forbidden'); };
    const runtime = await createMachineExecutor({
      checkpointClock: clock, environmentRoot: join(root, `${machineId}-runtime`), machineId, database,
      artifacts: new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, `${machineId}-artifacts`), new Uint8Array(32)),
      cloud: new LocalCloud({ baseUrl: 'https://proof.invalid', userId: 'account', machineId, signingPrivateKey: new Uint8Array(32) }),
      gitRemote: new ArtifactsGitRemote({ credentials: async () => ({ remote: artifactsUrl, plaintext: 'proof-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) }),
      prepareAttachment: async () => {}, originGitEnvironment: unavailable,
      commitSnapshot: (_local, candidate, previous) => commitSnapshot(candidate, previous),
    });
    runtimes.push(runtime);
    await clock.until(runtime.sync(), 20_000);
    expect(runtime.journal.attachment(attachment.attachmentId)?.attachment.state).toBe('ready');
    const execute = (tool: 'read' | 'checkpoint', args: Record<string, unknown>, snapshot?: Checkpoint) => clock.until(runtime.executor.execute(RuntimeToolDispatchSchema.parse({
      conversationKind: 'main', version: 1, projectId: 'project', workspaceId: 'workspace', machineId, attachmentId: attachment.attachmentId, generation: attachment.generation,
      conversationId: 'proof', taskId: 'proof', requestId: crypto.randomUUID(), attemptId: crypto.randomUUID(), tool, args,
      replay: tool === 'read' ? 'safe' : 'unsafe', deadlineAt: new Date(Date.now() + 20_000).toISOString(), ...(snapshot ? { snapshot } : {}),
    })), 20_000);
    return { checkout, execute };
  };
  try {
    await git(root, ['init', '--bare', remote]);
    await git(root, ['init', '-b', 'main', seed]);
    await writeFile(join(seed, 'tracked.txt'), 'base\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-m', 'base']);
    const a = await machine('machine-a');
    const b = await machine('machine-b');
    await writeFile(join(b.checkout, 'b.txt'), 'from b\n');
    expect(await b.execute('checkpoint', {})).toMatchObject({ status: 'completed' });
    const fromB = cloud.tip;
    await writeFile(join(a.checkout, 'a.txt'), 'from a\n');
    expect(await a.execute('checkpoint', {})).toMatchObject({ status: 'completed' });
    const merged = cloud.tip;
    if (!fromB || !merged) throw new Error('Cloud did not accept both caches');
    expect(await git(remote, ['merge-base', '--is-ancestor', fromB.worktreeCommit, merged.worktreeCommit])).toBe('');
    // The cloud dispatched this read while B's publication was its tip; A's own
    // publication then advanced A past it. The stale snapshot is already included.
    const stale = await a.execute('read', { path: 'b.txt' }, fromB);
    expect(stale).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(stale.content)).toContain('from b');
    const current = await b.execute('read', { path: 'a.txt' }, merged);
    expect(current).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(current.content)).toContain('from a');
    expect((await git(remote, ['ls-tree', '--name-only', merged.worktreeCommit])).split('\n')).toEqual(['a.txt', 'b.txt', 'tracked.txt']);
    for (const checkout of [a.checkout, b.checkout]) {
      // Neither cache rewound its anchor: the newest committed checkpoint stays reachable.
      expect(await git(checkout, ['for-each-ref', '--format=%(objectname)', canonicalRef])).toBe(merged.worktreeCommit);
      expect(await git(checkout, ['for-each-ref', '--format=%(refname)', 'refs/gitspace/fetch/'])).toBe('');
      expect(await Bun.file(join(checkout, 'a.txt')).text()).toBe('from a\n');
      expect(await Bun.file(join(checkout, 'b.txt')).text()).toBe('from b\n');
    }
  } finally {
    await Promise.allSettled(runtimes.map(runtime => runtime.close()));
    for (const database of databases) database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
