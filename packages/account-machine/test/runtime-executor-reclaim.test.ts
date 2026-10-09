import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { GitSpaceDatabase, LocalArtifactResolver, MemoryArtifactObjectStore } from '@gitspace/core';
import type { ControlOperation } from '@gitspace/protocol';
import { RuntimeAttachmentSchema, RuntimeAssignmentsInputSchema, RuntimeHeartbeatInputSchema, RuntimeDetachInputSchema, type RuntimeSnapshotCommitInput } from '@gitspace/protocol-runtime';
import { daemonClientForProject } from '@gitspace/supervisor';
import { collectBytes, GitLfsObjectSchema, type GitLfsObject } from '@gitspace/protocol-workspace';
import type { MachineGitLfsAccess } from '../src/git-lfs.js';
import { CloudRuntimeClient } from '../src/cloud-runtime-client.js';
import { ArtifactsGitRemote } from '../src/artifacts-git-remote.js';
import { createMachineExecutor, type MachineExecutorRuntime } from '../src/runtime-executor.js';

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(stderr);
  return stdout.trim();
}

for (const scenario of ['automatic normal', 'automatic held', 'manual held rejected', 'manual held accepted', 'detach held rejected', 'detach held accepted', 'detach normal', 'detach protected', 'detach protected history']) test(`cache cleanup: ${scenario}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-reclaim-'));
  const checkout = join(root, 'checkout'), remote = join(root, 'remote.git');
  const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
  let runtime: MachineExecutorRuntime | undefined;
  try {
    await mkdir(checkout);
    await git(checkout, 'init', '-b', 'main');
    await git(checkout, 'config', 'user.name', 'Reclaim proof');
    await git(checkout, 'config', 'user.email', 'proof@example.invalid');
    await git(checkout, 'config', 'filter.lfs.process', '');
    await git(checkout, 'config', 'filter.lfs.clean', 'cat');
    await git(checkout, 'config', 'filter.lfs.smudge', 'cat');
    await git(checkout, 'config', 'filter.lfs.required', 'false');
    await writeFile(join(checkout, '.gitattributes'), '*.bin filter=lfs\n');
    // Publication-bound LFS access mirrors the cloud store: only a publication can protect or upload.
    const lfsObjects = new Map<string, Uint8Array>();
    const protections: Array<{ publicationId: string; oids: string[] }> = [];
    const released: string[] = [];
    const reader = {
      has: async (object: GitLfsObject) => lfsObjects.has(object.oid),
      get: async (object: GitLfsObject) => { const bytes = lfsObjects.get(object.oid); return bytes ? (async function* () { yield bytes; })() : null; },
    };
    const lfs: MachineGitLfsAccess | undefined = scenario.includes('protected') ? {
      read: async () => ({ store: reader, canonicalOrigin: null, originEnvironment: async () => ({}) }),
      publish: async (_projectId, publicationId) => ({
        canonicalOrigin: null, originEnvironment: async () => ({}),
        store: {
          ...reader,
          put: async (object, source) => { lfsObjects.set(object.oid, await collectBytes(source, object.size)); },
          protect: async objects => { protections.push({ publicationId, oids: objects.map(object => object.oid) }); return objects.filter(object => lfsObjects.has(object.oid)); },
        },
        releasePublication: async () => { released.push(publicationId); },
      }),
    } : undefined;
    const payload = new TextEncoder().encode('committed LFS payload');
    const committedObject = GitLfsObjectSchema.parse({ oid: new Bun.CryptoHasher('sha256').update(payload).digest('hex'), size: payload.byteLength });
    if (scenario.endsWith('history')) {
      lfsObjects.set(committedObject.oid, payload);
      await writeFile(join(checkout, 'asset.bin'), `version https://git-lfs.github.com/spec/v1\noid sha256:${committedObject.oid}\nsize ${committedObject.size}\n`);
    }
    await writeFile(join(checkout, 'tracked.txt'), 'base\n');
    await git(checkout, 'add', '.'); await git(checkout, 'commit', '-m', 'base');
    await git(root, 'init', '--bare', remote);
    database.createProject({ id: 'project', name: 'Project', repositoryPath: join(root, 'base') }).unwrap();
    database.createWorkspace({ id: 'workspace', projectId: 'project', name: 'Workspace', rootPath: checkout, branch: 'main' }).unwrap();
    database.possessSpace('workspace', 'machine').unwrap();
    const space = database.getSpace('workspace');
    if (!space) throw new Error('Missing workspace');
    let attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'cache', generation: 0, ownershipGeneration: space.generation, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'attaching', capabilities: ['read', 'write'], updatedAt: new Date().toISOString() });
    const authority: { checkpoint: RuntimeSnapshotCommitInput['checkpoint'] | null } = { checkpoint: null };
    let finalCount = 0;
    let finalRef: string | undefined;
    const published: string[] = [];
    class LocalCloud extends CloudRuntimeClient {
      override async call<S extends z.ZodType>(operation: ControlOperation, payload: Record<string, unknown>, schema: S, signal?: AbortSignal): Promise<z.output<S>> {
        if (operation === 'runtime.assignments') {
          const input = RuntimeAssignmentsInputSchema.parse(payload);
          if (input.afterSnapshot) await new Promise<void>((_, reject) => { const abort = () => reject(new Error('Subscription canceled')); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); });
          return schema.parse({ assignments: attachment.state === 'detached' ? [] : [{ grant: { attachment, executionSecret: 'proof-secret' }, source: null, checkpoint: authority.checkpoint, cachePolicy: { idleGraceSeconds: 0, reclaimSeconds: 86400 } }] });
        }
        if (operation === 'runtime.attachment.ready') { attachment = { ...attachment, state: 'ready' }; return schema.parse({ attachment }); }
        if (operation === 'runtime.heartbeat') {
          const input = RuntimeHeartbeatInputSchema.parse(payload);
          if (input.cache?.state === 'reclaimed' && finalCount === 0) throw new Error('Missing accepted final publication');
          attachment = { ...attachment, cache: input.cache, state: input.cache?.state === 'draining' ? 'draining' : input.cache?.state === 'reclaimed' ? 'attaching' : attachment.state, ...(input.cacheAction && attachment.cacheAction ? { cacheAction: { ...attachment.cacheAction, ...input.cacheAction } } : {}) };
          return schema.parse({ attachment });
        }
        if (operation === 'runtime.detach') {
          const input = RuntimeDetachInputSchema.parse(payload);
          if (input.state === 'detached' && finalCount === 0) throw new Error('Detach precedes flush');
          attachment = { ...attachment, state: input.state };
          return schema.parse({ attachment });
        }
        throw new Error(`Unexpected operation ${operation}`);
      }
    }
    class LocalRemote extends ArtifactsGitRemote {
      override async fetchCheckpoint(input: Parameters<ArtifactsGitRemote['fetchCheckpoint']>[0]) { await git(input.repositoryPath, 'fetch', remote, `${input.checkpointRef}:${input.checkpointRef}`); }
      override async publishCheckpoint(input: Parameters<ArtifactsGitRemote['publishCheckpoint']>[0]) { await git(input.repositoryPath, 'push', remote, `${input.checkpointRef}:${input.checkpointRef}`); }
    }
    const forbidden = async (): Promise<never> => { throw new Error('External access forbidden'); };
    runtime = await createMachineExecutor({ environmentRoot: join(root, 'runtime'), machineId: 'machine', database,
      artifacts: new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'cache'), new Uint8Array(32)),
      cloud: new LocalCloud({ baseUrl: 'https://proof.invalid', userId: 'account', machineId: 'machine', signingPrivateKey: new Uint8Array(32) }), gitRemote: new LocalRemote({ credentials: forbidden }),
      prepareAttachment: async () => {}, originGitEnvironment: forbidden, lfs,
      commitSnapshot: async (_local, uploaded, previous, final) => {
        if (final) finalRef = uploaded.checkpointRef;
        expect(previous).toBe(authority.checkpoint?.worktreeCommit ?? null);
        expect(await git(remote, 'rev-parse', uploaded.checkpointRef)).toBe(uploaded.worktreeCommit);
        if (final && published.includes(uploaded.worktreeCommit)) throw new Error('Final publication replayed an already accepted checkpoint instead of its original publication predecessor');
        const commit = await git(checkout, 'commit-tree', uploaded.worktreeTree, '-p', uploaded.worktreeCommit, ...(previous ? ['-p', previous] : []), '-m', 'Canonical acceptance');
        const checkpoint = { ...uploaded, worktreeCommit: commit, checkpointRef: `${uploaded.checkpointRef}-accepted` };
        authority.checkpoint = checkpoint;
        await git(checkout, 'update-ref', checkpoint.checkpointRef, commit); await git(checkout, 'push', remote, `${checkpoint.checkpointRef}:${checkpoint.checkpointRef}`);
        published.push(commit); if (final) finalCount++;
        return checkpoint;
      },
    });
    await runtime.sync();
    const local = runtime.journal.attachment('cache'); if (!local?.attachment.cache) throw new Error('Missing prepared cache');
    // This isolated checkout is test-owned; production journals obtain this evidence at acquisition.
    runtime.journal.installAttachment({ ...local, ownedCheckout: true, attachment: { ...local.attachment, cache: { ...local.attachment.cache, lastActivityAt: new Date(0).toISOString(), pausedAt: new Date(0).toISOString(), reclaimAt: new Date(0).toISOString() } } });
    const client = await daemonClientForProject(checkout);
    const observed = await client.request({ op: 'list' }); expect(observed.op).toBe('list');
    const held = scenario.includes('held');
    await writeFile(join(checkout, held ? 'asset.bin' : 'tracked.txt'), held ? 'private unsynced LFS bytes' : 'final ordinary edit\n');
    if (scenario.startsWith('manual')) attachment = RuntimeAttachmentSchema.parse({ ...attachment, state: 'draining', cacheAction: { requestId: 'manual', action: 'reclaim', status: 'requested', error: null, ...(scenario.endsWith('accepted') ? { discardHeldBack: true } : {}) } });
    if (scenario.startsWith('detach')) attachment = RuntimeAttachmentSchema.parse({ ...attachment, state: 'draining', detachRequest: { ...(scenario.endsWith('accepted') ? { discardHeldBack: true } : {}) } });
    await runtime.sync();
    const blocked = held && !scenario.endsWith('accepted');
    if (blocked) {
      expect(await Bun.file(join(checkout, 'asset.bin')).text()).toBe('private unsynced LFS bytes');
      const retained = runtime.journal.attachment('cache');
      expect(retained?.attachment.cache?.state).toBe('paused');
      expect(retained?.attachment.cache?.reclaimBlocked).toContain('asset.bin');
      expect(finalCount).toBe(0);
    } else {
      expect(await Bun.file(join(checkout, '.git/HEAD')).exists()).toBe(false);
      expect(finalCount).toBe(1);
      expect(runtime.journal.attachment('cache')?.attachment.state).toBe(scenario.startsWith('detach') ? 'detached' : 'attaching');
      expect(attachment.state).toBe(scenario.startsWith('detach') ? 'detached' : 'attaching');
      if (!held && authority.checkpoint) expect(await git(remote, 'show', `${authority.checkpoint.worktreeCommit}:tracked.txt`)).toBe('final ordinary edit');
      if (scenario.includes('protected')) {
        if (!finalRef) throw new Error('Final checkpoint was not committed');
        // The final checkpoint protects committed objects under its own publication and releases it once committed.
        expect(protections.filter(protection => protection.publicationId === finalRef)).toEqual(scenario.endsWith('history') ? [{ publicationId: finalRef, oids: [committedObject.oid] }] : []);
        expect(released).toContain(finalRef);
        if (scenario.endsWith('history')) expect(authority.checkpoint?.lfs?.objects).toEqual([{ ...committedObject, source: 'r2' }]);
      }
    }
  } finally { await runtime?.close(); database.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
