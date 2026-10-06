import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { GitSpaceDatabase, LocalArtifactResolver, MemoryArtifactObjectStore } from '@gitspace/core';
import type { ControlOperation } from '@gitspace/protocol';
import { RuntimeAttachmentSchema, type RuntimeSnapshotCommitInput } from '@gitspace/protocol-runtime';
import { CloudRuntimeClient } from '../src/cloud-runtime-client.js';
import { ArtifactsGitRemote } from '../src/artifacts-git-remote.js';
import { createMachineExecutor, type MachineExecutorRuntime } from '../src/runtime-executor.js';
import { ManualWorktreeClock } from './git-worktree-clock.js';

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function watcherProof(run: (proof: {
  checkout: string;
  root: string;
  uploads: string[][];
  publications: string[][];
  runtime: MachineExecutorRuntime;
  clock: ManualWorktreeClock;
  event(path: string): Promise<void>;
  duringCapture(action: () => Promise<void>): void;
  waitForFinal(): Promise<void>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-watcher-proof-'));
  const checkout = join(root, 'checkout');
  const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
  let runtime: MachineExecutorRuntime | undefined;
  const clock = new ManualWorktreeClock();
  let event: (path: string) => Promise<void> = async () => { throw new Error('Watcher is not installed'); };
  try {
    await mkdir(checkout);
    await git(checkout, 'init', '-b', 'main');
    await git(checkout, 'config', 'user.name', 'Watcher proof');
    await git(checkout, 'config', 'user.email', 'proof@example.invalid');
    await writeFile(join(checkout, 'tracked.txt'), 'base\n');
    await git(checkout, 'add', '.');
    await git(checkout, 'commit', '-m', 'base');
    database.createProject({ id: 'project', name: 'Project', repositoryPath: join(root, 'base') }).unwrap();
    database.createWorkspace({ id: 'workspace', projectId: 'project', name: 'Workspace', rootPath: checkout, branch: 'main' }).unwrap();
    database.possessSpace('workspace', 'machine').unwrap();
    const owned = database.getSpace('workspace');
    if (!owned) throw new Error('Owned workspace missing');
    let attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'watch-primary', generation: 0, ownershipGeneration: owned.generation, role: 'primary', checkout: { kind: 'shared', branch: 'main' }, state: 'attaching', capabilities: ['read', 'write', 'edit', 'checkpoint'], updatedAt: new Date().toISOString() });
    let checkpoint: RuntimeSnapshotCommitInput['checkpoint'] | null = null;
    let captureAction: (() => Promise<void>) | undefined;
    const uploads: string[][] = [], publications: string[][] = [];
    const final = Promise.withResolvers<void>();
    const contents = async (ref: string) => {
      const paths = (await git(checkout, 'ls-tree', '-r', '--name-only', ref)).split('\n');
      return Promise.all(paths.map(async path => `${path}:${await git(checkout, 'show', `${ref}:${path}`)}`));
    };
    class LocalCloud extends CloudRuntimeClient {
      override async call<S extends z.ZodType>(operation: ControlOperation, payload: Record<string, unknown>, schema: S, signal?: AbortSignal): Promise<z.output<S>> {
        if (operation === 'runtime.assignments') {
          if (payload.afterSnapshot) await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error('Subscription canceled'));
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
          });
          return schema.parse({ assignments: [{ grant: { attachment, executionSecret: 'proof-secret' }, source: null, checkpoint }] });
        }
        if (operation === 'runtime.attach') return schema.parse({ attachment, executionSecret: 'proof-secret' });
        if (operation === 'runtime.attachment.ready') { attachment = { ...attachment, state: 'ready' }; return schema.parse({ attachment }); }
        throw new Error(`Unexpected operation: ${operation}`);
      }
    }
    class LocalGitRemote extends ArtifactsGitRemote {
      override async publishCheckpoint(input: Parameters<ArtifactsGitRemote['publishCheckpoint']>[0]) { uploads.push(await contents(input.checkpointRef)); }
      override async fetchCheckpoint(input: Parameters<ArtifactsGitRemote['fetchCheckpoint']>[0]) {
        // The fake authority shares this real object database, never a provider.
        await git(input.repositoryPath, 'cat-file', '-e', `${input.commit}^{commit}`);
      }
    }
    const unavailable = async (): Promise<never> => { throw new Error('External service forbidden'); };
    runtime = await createMachineExecutor({
      checkpointClock: clock,
      checkpointEvents: (_root, changed) => { event = changed; return () => {}; },
      environmentRoot: join(root, 'runtime'), machineId: 'machine', database,
      artifacts: new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'cache'), new Uint8Array(32)),
      cloud: new LocalCloud({ baseUrl: 'https://proof.invalid', userId: 'account', machineId: 'machine', signingPrivateKey: new Uint8Array(32) }),
      gitRemote: new LocalGitRemote({ credentials: unavailable }), prepareAttachment: unavailable, originGitEnvironment: unavailable,
      lfs: async () => ({ store: { has: unavailable, put: unavailable, get: unavailable }, originEnvironment: async () => {
        const action = captureAction; captureAction = undefined; await action?.(); return {};
      } }),
      commitSnapshot: async (_local, candidate, previous) => {
        const worktreeCommit = await git(checkout, 'commit-tree', candidate.worktreeTree,
          '-p', candidate.worktreeCommit, ...(previous ? ['-p', previous] : []), '-m', 'Accepted canonical snapshot');
        const accepted = { ...candidate, checkpointRef: `${candidate.checkpointRef}-accepted`, worktreeCommit };
        await git(checkout, 'update-ref', accepted.checkpointRef, accepted.worktreeCommit);
        checkpoint = accepted;
        const files = await contents(candidate.worktreeCommit);
        publications.push(files);
        if (files.includes('tracked.txt:final')) final.resolve();
        return accepted;
      },
    });
    await clock.until(runtime.sync());
    uploads.length = 0; publications.length = 0;
    await run({ root, checkout, uploads, publications, runtime, clock, event: path => event(path), duringCapture: action => { captureAction = action; }, waitForFinal: async () => {
      await clock.until(final.promise);
    } });
  } finally { await runtime?.close(); database.close(); await rm(root, { recursive: true, force: true }); }
}

test('manual watcher waits reject missing completion and missing timers within a deadline', async () => {
  const clock = new ManualWorktreeClock();
  await expect(clock.until(new Promise<void>(() => {}), 20)).rejects.toThrow('completion');
  await expect(clock.pending(1000, 20)).rejects.toThrow('1000ms timer');
}, 1000);

test('manual watcher completion deadline survives continuously scheduled work', async () => {
  const clock = new ManualWorktreeClock();
  const repeat = () => { clock.schedule(1, repeat); };
  repeat();
  await expect(clock.until(new Promise<void>(() => {}), 20)).rejects.toThrow('completion');
}, 1000);

test('human chunk gaps above 200ms coalesce through watcher and reconcile', async () => {
  await watcherProof(async ({ checkout, runtime, clock, event, uploads, publications, waitForFinal }) => {
    await writeFile(join(checkout, 'tracked.txt'), 'chunk one\n');
    await event('tracked.txt');
    const reconcile = runtime.sync();
    await clock.pending(1000);
    clock.advance(450);
    await writeFile(join(checkout, 'tracked.txt'), 'chunk one and two\n');
    await event('tracked.txt');
    clock.advance(450);
    await writeFile(join(checkout, 'tracked.txt'), 'final\n');
    await event('tracked.txt');
    await clock.until(reconcile); await waitForFinal();
    expect(uploads).toEqual([['tracked.txt:final']]);
    expect(publications).toEqual(uploads);
  });
});

test('human atomic save retains persistent scratch but not the renamed temporary path', async () => {
  await watcherProof(async ({ checkout, clock, event, uploads, publications, waitForFinal }) => {
    const persistent = ['tracked.txt~', '.#tracked.txt', '.tracked.txt.swp'];
    for (const name of persistent) { await writeFile(join(checkout, name), 'editor temporary\n'); await event(name); }
    await writeFile(join(checkout, 'tracked.txt.tmp'), 'first chunk\n');
    await event('tracked.txt.tmp');
    clock.advance(450);
    await clock.pending(1000);
    await writeFile(join(checkout, 'tracked.txt.tmp'), 'final\n');
    await event('tracked.txt.tmp');
    clock.advance(450);
    await rename(join(checkout, 'tracked.txt.tmp'), join(checkout, 'tracked.txt'));
    await event('tracked.txt.tmp'); await event('tracked.txt');
    await waitForFinal();
    expect(uploads).toEqual([[...persistent.map(path => `${path}:editor temporary`), 'tracked.txt:final'].sort()]);
    expect(publications).toEqual(uploads);
  });
});

test('human many file burst publishes a single complete snapshot', async () => {
  await watcherProof(async ({ checkout, clock, event, uploads, publications, waitForFinal }) => {
    for (let group = 0; group < 3; group++) {
      await Promise.all(Array.from({ length: 4 }, async (_, index) => {
        const path = `file-${group}-${index}.txt`; await writeFile(join(checkout, path), 'complete\n'); await event(path);
      }));
      clock.advance(350);
      await clock.pending(1000);
    }
    await writeFile(join(checkout, 'tracked.txt'), 'final\n');
    await event('tracked.txt');
    await waitForFinal();
    const expected = [...Array.from({ length: 3 }, (_, group) => Array.from({ length: 4 }, (_, index) => `file-${group}-${index}.txt:complete`)).flat(), 'tracked.txt:final'];
    expect(uploads).toEqual([expected]);
    expect(publications).toEqual(uploads);
  });
});

test('human mutation during capture discards candidate before upload or admission', async () => {
  await watcherProof(async ({ checkout, clock, event, uploads, publications, duringCapture, waitForFinal }) => {
    duringCapture(async () => {
      await writeFile(join(checkout, 'tracked.txt'), 'capture interrupted\n');
      clock.advance(450);
      await writeFile(join(checkout, 'tracked.txt'), 'final\n');
      await event('tracked.txt');
    });
    await writeFile(join(checkout, 'tracked.txt'), 'first candidate\n');
    await event('tracked.txt');
    await waitForFinal();
    expect(uploads).toEqual([['tracked.txt:final']]);
    expect(publications).toEqual(uploads);
  });
});

test('tracked tmp filenames retain human chunk stability during capture', async () => {
  await watcherProof(async ({ checkout, runtime, clock, event, uploads, publications, duringCapture, waitForFinal }) => {
    await writeFile(join(checkout, 'tracked.tmp'), 'base\n');
    await git(checkout, 'add', 'tracked.tmp');
    await git(checkout, 'commit', '-m', 'Legitimate tracked temporary extension');
    await clock.until(runtime.sync());
    uploads.length = 0; publications.length = 0;
    duringCapture(async () => {
      await writeFile(join(checkout, 'tracked.tmp'), 'capture interrupted\n');
      clock.advance(450);
      await writeFile(join(checkout, 'tracked.tmp'), 'complete\n');
      await writeFile(join(checkout, 'tracked.txt'), 'final\n');
      await event('tracked.tmp'); await event('tracked.txt');
    });
    await writeFile(join(checkout, 'tracked.tmp'), 'first chunk\n');
    await event('tracked.tmp');
    await waitForFinal();
    expect(uploads).toEqual([['tracked.tmp:complete', 'tracked.txt:final']]);
    expect(publications).toEqual(uploads);
  });
});

test('ignored churn cannot reset the tracked edit debounce', async () => {
  await watcherProof(async ({ checkout, runtime, clock, event, uploads }) => {
    await writeFile(join(checkout, '.gitignore'), 'cache/\n');
    await mkdir(join(checkout, 'cache'));
    await clock.until(runtime.sync());
    uploads.length = 0;
    await writeFile(join(checkout, 'tracked.txt'), 'final\n');
    await event('tracked.txt');
    clock.advance(100);
    await writeFile(join(checkout, 'cache/output'), 'first\n');
    await event('cache/output');
    expect(clock.remaining(200)).toBe(100);
    clock.advance(100);
    await clock.pending(1000);
    for (let index = 0; index < 9; index++) {
      clock.advance(100);
      await writeFile(join(checkout, 'cache/output'), `${index}\n`);
      await event('cache/output');
    }
    await clock.until(runtime.sync());
    expect(uploads).toEqual([['.gitignore:cache/', 'tracked.txt:final']]);
  });
});

test('tracked and untracked lock files trigger publication outside Git bookkeeping', async () => {
  await watcherProof(async ({ checkout, clock, event, uploads, runtime }) => {
    await writeFile(join(checkout, 'tracked.lock'), 'base\n');
    await git(checkout, 'add', 'tracked.lock'); await git(checkout, 'commit', '-m', 'Tracked lock');
    await clock.until(runtime.sync()); uploads.length = 0;
    await writeFile(join(checkout, 'tracked.lock'), 'human\n');
    await event('tracked.lock');
    expect(clock.remaining(200)).toBe(200);
    await writeFile(join(checkout, 'portable.lock'), 'human\n');
    await event('portable.lock');
    expect(clock.remaining(200)).toBe(200);
    await clock.until(runtime.sync());
    expect(uploads).toEqual([['portable.lock:human', 'tracked.lock:human', 'tracked.txt:base']]);
  });
});

test('nested and info ignore edits invalidate previously ignored paths', async () => {
  await watcherProof(async ({ checkout, clock, event, uploads, runtime }) => {
    await mkdir(join(checkout, 'nested'));
    await writeFile(join(checkout, 'nested/.gitignore'), 'hidden\n');
    await writeFile(join(checkout, '.git/info/exclude'), 'info-hidden\n');
    await writeFile(join(checkout, 'nested/hidden'), 'nested\n');
    await writeFile(join(checkout, 'info-hidden'), 'info\n');
    await clock.until(runtime.sync()); uploads.length = 0;
    await event('nested/hidden'); await event('info-hidden');
    expect(clock.remaining(200)).toBeUndefined();
    await writeFile(join(checkout, 'nested/.gitignore'), '');
    await writeFile(join(checkout, '.git/info/exclude'), '');
    await event('nested/.gitignore'); await event('.git/info/exclude');
    clock.advance(100);
    await event('nested/hidden'); await event('info-hidden');
    expect(clock.remaining(200)).toBe(200);
    await clock.until(runtime.sync());
    expect(uploads).toEqual([['info-hidden:info', 'nested/.gitignore:', 'nested/hidden:nested', 'tracked.txt:base']]);
  });
});

test('external global ignore content and config path changes invalidate without worktree events', async () => {
  await watcherProof(async ({ root, checkout, clock, event, uploads, runtime }) => {
    const first = join(root, 'first-ignore'), second = join(root, 'second-ignore');
    await writeFile(first, 'external-hidden\n');
    await writeFile(second, 'other-hidden\n');
    await git(checkout, 'config', 'core.excludesFile', first);
    await writeFile(join(checkout, 'external-hidden'), 'external\n');
    await writeFile(join(checkout, 'other-hidden'), 'other\n');
    await event('.git/config');
    await clock.until(runtime.sync()); uploads.length = 0;
    await event('external-hidden');
    expect(clock.remaining(200)).toBeUndefined();
    // No worktree event accompanies a write to this external file.
    await writeFile(first, '');
    clock.advance(5000);
    await clock.pending(200);
    await clock.until(runtime.sync());
    expect(uploads.at(-1)).toEqual(['external-hidden:external', 'other-hidden:other', 'tracked.txt:base']);
    uploads.length = 0;
    // A changed config can point to an entirely different external file.
    await git(checkout, 'config', 'core.excludesFile', second);
    clock.advance(5000);
    await clock.pending(200);
    await clock.until(runtime.sync());
    expect(uploads.at(-1)).toEqual(['external-hidden:external', 'tracked.txt:base']);
  });
});
