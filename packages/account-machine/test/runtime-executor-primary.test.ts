import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { GitSpaceDatabase, LocalArtifactResolver, MemoryArtifactObjectStore } from '@gitspace/core';
import type { ControlOperation } from '@gitspace/protocol';
import { RuntimeAttachmentSchema, RuntimeAttachmentReadyInputSchema, RuntimeAttachInputSchema, type RuntimeSnapshotCommitInput } from '@gitspace/protocol-runtime';
import { CloudRuntimeClient } from '../src/cloud-runtime-client.js';
import { ArtifactsGitRemote } from '../src/artifacts-git-remote.js';
import { createMachineExecutor, type MachineExecutorRuntime } from '../src/runtime-executor.js';
import { createGitIntermediateCheckpoint } from '../src/git-checkpoint.js';

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(stderr);
  return stdout.trim();
}

test.each(['committed', 'unborn', 'published unborn'])('primary executor reaches ready with %s canonical state', async initial => {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-primary-executor-'));
  const checkout = join(root, 'checkout'), remote = join(root, 'remote.git');
  let runtime: MachineExecutorRuntime | undefined;
  const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
  try {
    await mkdir(checkout);
    await git(checkout, 'init', '-b', 'main');
    await git(checkout, 'config', 'user.name', 'Checkpoint proof');
    await git(checkout, 'config', 'user.email', 'proof@example.invalid');
    await writeFile(join(checkout, 'tracked.txt'), 'committed\n');
    await git(checkout, 'add', '.');
    if (initial === 'committed') await git(checkout, 'commit', '-m', 'base');
    const head = initial === 'committed' ? await git(checkout, 'rev-parse', 'HEAD') : null;
    await writeFile(join(checkout, 'tracked.txt'), 'initial dirty workspace\n');
    await git(root, 'init', '--bare', remote);
    database.createProject({ id: 'project', name: 'Project', repositoryPath: join(root, 'base') }).unwrap();
    database.createWorkspace({ id: 'workspace', projectId: 'project', name: 'Workspace', rootPath: checkout, branch: 'main' }).unwrap();
    database.possessSpace('workspace', 'machine').unwrap();
    const owned = database.getSpace('workspace');
    if (!owned) throw new Error('Owned workspace missing');
    let attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'first-primary', generation: 0, ownershipGeneration: owned.generation, role: 'primary', checkout: { kind: 'shared', branch: 'main' }, state: 'attaching', capabilities: ['read', 'write', 'edit'], updatedAt: new Date().toISOString() });
    const authority: { checkpoint: RuntimeSnapshotCommitInput['checkpoint'] | null; readyCommit: string | null } = { checkpoint: null, readyCommit: null };
    if (initial === 'published unborn') {
      authority.checkpoint = await createGitIntermediateCheckpoint({ repositoryPath: checkout, spaceId: 'workspace', revision: 1 });
      await git(checkout, 'push', remote, `${authority.checkpoint.checkpointRef}:${authority.checkpoint.checkpointRef}`);
      await writeFile(join(checkout, 'tracked.txt'), 'stale local contents\n');
    }
    class LocalCloud extends CloudRuntimeClient {
      override async call<S extends z.ZodType>(operation: ControlOperation, payload: Record<string, unknown>, schema: S): Promise<z.output<S>> {
        if (operation === 'runtime.assignments') return schema.parse({ assignments: [{ grant: { attachment, executionSecret: 'local-proof-secret' }, source: null, checkpoint: authority.checkpoint }] });
        if (operation === 'runtime.attach') {
          const input = RuntimeAttachInputSchema.parse(payload);
          expect(input.machineId).toBe(attachment.machineId);
          expect(input.generation).toBe(attachment.generation);
          return schema.parse({ attachment, executionSecret: 'local-proof-secret' });
        }
        if (operation === 'runtime.attachment.ready') {
          const input = RuntimeAttachmentReadyInputSchema.parse(payload);
          if (!authority.checkpoint || input.commit !== authority.checkpoint.worktreeCommit) throw new Error('Ready precedes canonical publication');
          expect(await git(remote, 'show', `${input.commit}:tracked.txt`)).toBe('initial dirty workspace');
          authority.readyCommit = input.commit;
          attachment = { ...attachment, state: 'ready' };
          return schema.parse({ attachment });
        }
        throw new Error(`Unexpected external operation: ${operation}`);
      }
    }
    class LocalGitRemote extends ArtifactsGitRemote {
      override async fetchCheckpoint(input: Parameters<ArtifactsGitRemote['fetchCheckpoint']>[0]) {
        await git(input.repositoryPath, 'fetch', remote, `${input.checkpointRef}:${input.checkpointRef}`);
      }
      override async publishCheckpoint(input: Parameters<ArtifactsGitRemote['publishCheckpoint']>[0]) {
        await git(input.repositoryPath, 'push', remote, `${input.checkpointRef}:${input.checkpointRef}`);
      }
    }
    const unavailable = async (): Promise<never> => { throw new Error('External service forbidden'); };
    runtime = await createMachineExecutor({
      environmentRoot: join(root, 'runtime'), machineId: 'machine', database,
      artifacts: new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'cache'), new Uint8Array(32)),
      cloud: new LocalCloud({ baseUrl: 'https://proof.invalid', userId: 'account', machineId: 'machine', signingPrivateKey: new Uint8Array(32) }),
      gitRemote: new LocalGitRemote({ credentials: unavailable, lfsEnvironment: unavailable }),
      prepareAttachment: unavailable, originGitEnvironment: unavailable,
      commitSnapshot: async (local, checkpoint, previous) => {
        expect(local.attachment.attachmentId).toBe(attachment.attachmentId);
        expect(previous).toBe(authority.checkpoint?.worktreeCommit ?? null);
        expect(await git(remote, 'rev-parse', checkpoint.checkpointRef)).toBe(checkpoint.worktreeCommit);
        authority.checkpoint = checkpoint;
      },
    });
    await runtime.sync();
    expect(runtime.journal.attachment(attachment.attachmentId)?.attachment.state).toBe('ready');
    if (!authority.checkpoint) throw new Error('Ready primary has no canonical checkpoint');
    expect(authority.readyCommit).toBe(authority.checkpoint.worktreeCommit);
    expect(authority.checkpoint?.headCommit).toBe(head);
    if (head === null) {
      expect(await git(checkout, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
      expect(await git(checkout, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('');
    } else {
      expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(head);
    }
    expect(await Bun.file(join(checkout, 'tracked.txt')).text()).toBe('initial dirty workspace\n');
    const beforeNoop = authority.checkpoint;
    await runtime.checkpointWorkspace('workspace');
    expect(authority.checkpoint).toEqual(beforeNoop);
    if (head === null) {
      await git(checkout, 'commit', '-m', 'first real commit');
      await runtime.checkpointWorkspace('workspace');
      expect(authority.checkpoint.headCommit).toBe(await git(checkout, 'rev-parse', 'HEAD'));
      expect(authority.checkpoint.worktreeCommit).not.toBe(beforeNoop.worktreeCommit);
    }
  } finally { await runtime?.close(); database.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
