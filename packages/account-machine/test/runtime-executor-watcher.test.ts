import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
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
  watcherCount(): number;
  event(path: string): Promise<void>;
  duringCapture(action: () => Promise<void>): void;
  waitForFinal(): Promise<void>;
  /** The cloud refuses the next `count` snapshot commits with `reason`, by default as it did with "internal error; reference = …". */
  failCommits(count: number, reason?: string): void;
  /** Closes the executor and starts another on the same journals, as a machine restart does. */
  restart(): Promise<MachineExecutorRuntime>;
  /** The simulated time of each snapshot commit attempt. */
  commitTimes(): number[];
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-watcher-proof-'));
  const checkout = join(root, 'spaces', 'project', 'workspace');
  let runtime: MachineExecutorRuntime | undefined;
  const clock = new ManualWorktreeClock();
  let event: (path: string) => Promise<void> = async () => { throw new Error('Watcher is not installed'); };
  let watchers = 0;
  try {
    await mkdir(checkout, { recursive: true });
    await git(checkout, 'init', '-b', 'main');
    await git(checkout, 'config', 'user.name', 'Watcher proof');
    await git(checkout, 'config', 'user.email', 'proof@example.invalid');
    await writeFile(join(checkout, 'tracked.txt'), 'base\n');
    await git(checkout, 'add', '.');
    await git(checkout, 'commit', '-m', 'base');
    let attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'watch-cache', generation: 0, checkout: { kind: 'shared', branch: 'main' }, state: 'attaching', capabilities: ['read', 'write', 'edit', 'checkpoint'], updatedAt: new Date().toISOString() });
    let checkpoint: RuntimeSnapshotCommitInput['checkpoint'] | null = null;
    let captureAction: (() => Promise<void>) | undefined;
    let refusals = 0, refusal = '';
    const attempts: number[] = [];
    const uploads: string[][] = [], publications: string[][] = [];
    const final = Promise.withResolvers<void>();
    const contents = async (ref: string) => {
      const paths = (await git(checkout, 'ls-tree', '-r', '--name-only', ref)).split('\n');
      return Promise.all(paths.map(async path => `${path}:${await git(checkout, 'show', `${ref}:${path}`)}`));
    };
    class LocalCloud extends CloudRuntimeClient {
      override async call<S extends z.ZodType>(operation: ControlOperation, payload: Record<string, unknown>, schema: S, signal?: AbortSignal): Promise<z.output<S>> {
        if (operation === 'runtime.assignments') {
          return schema.parse({ assignments: [{ grant: { attachment, executionSecret: 'proof-secret' }, source: null, checkpoint }] });
        }
        if (operation === 'runtime.attachment.cache.request') {
          attachment = { ...attachment, state: 'attaching' };
          return schema.parse({ attachment });
        }
        if (operation === 'runtime.attachment.ready') { attachment = { ...attachment, state: 'ready' }; return schema.parse({ attachment }); }
        if (operation === 'runtime.heartbeat') return schema.parse({ attachment });
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
    const lfs = async () => ({ store: { has: unavailable, put: unavailable, get: unavailable }, originEnvironment: async () => {
      const action = captureAction; captureAction = undefined; await action?.(); return {};
    } });
    const start = () => createMachineExecutor({
      checkpointClock: clock,
      checkpointEvents: (_root, changed) => { watchers++; event = changed; return () => { watchers--; }; },
      environmentRoot: join(root, 'runtime'), managedSpaceRoot: join(root, 'spaces'), machineId: 'machine',
      cloud: new LocalCloud({ baseUrl: 'https://proof.invalid', userId: 'account', machineId: 'machine', signingPrivateKey: new Uint8Array(32) }),
      gitRemote: new LocalGitRemote({ credentials: unavailable }), prepareAttachment: async () => {},
      lfs: { read: lfs, publish: lfs },
      commitSnapshot: async (_local, candidate, previous) => {
        attempts.push(clock.now);
        if (refusals > 0) { refusals--; throw new Error(refusal); }
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
    runtime = await start();
    await clock.until(runtime.sync());
    uploads.length = 0; publications.length = 0; attempts.length = 0;
    await run({ root, checkout, uploads, publications, runtime, clock, watcherCount: () => watchers, event: path => event(path), duringCapture: action => { captureAction = action; }, failCommits: (count, reason = 'internal error; reference = proof') => { refusals = count; refusal = reason; }, commitTimes: () => attempts, waitForFinal: async () => {
      await clock.until(final.promise);
    }, restart: async () => {
      await runtime?.close();
      runtime = await start();
      await clock.until(runtime.sync());
      return runtime;
    } });
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
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

test('a failing sync retries after a doubling wait, and edits made meanwhile ride along instead of each retrying', async () => {
  await watcherProof(async ({ checkout, clock, event, publications, failCommits, commitTimes, waitForFinal }) => {
    failCommits(2);
    await writeFile(join(checkout, 'tracked.txt'), 'first\n');
    await event('tracked.txt');
    for (let step = 0; step < 50 && commitTimes().length < 1; step++) await clock.until(Bun.sleep(5));
    for (const content of ['second\n', 'final\n']) { await writeFile(join(checkout, 'tracked.txt'), content); await event('tracked.txt'); }
    // Retry waits are 5 s and longer, which the manual clock never advances by itself.
    for (let step = 0; step < 400 && publications.length < 2; step++) { clock.advance(250); await clock.until(Bun.sleep(2)); }
    await waitForFinal();
    // Refused, retried after 5 s and refused, retried after 10 s and accepted; then the held edits, once.
    const [first, second, third] = commitTimes();
    expect(commitTimes()).toHaveLength(4);
    expect(second! - first!).toBeGreaterThanOrEqual(5_000);
    expect(third! - second!).toBeGreaterThanOrEqual(10_000);
    expect(publications).toEqual([['tracked.txt:first'], ['tracked.txt:final']]);
  });
});

test('a failed sync pass is retried without waiting for an edit, so an idle checkout does not keep the failure', async () => {
  await watcherProof(async ({ checkout, runtime, clock, failCommits, commitTimes, publications, waitForFinal }) => {
    failCommits(1);
    // A change no watcher event reports: only a sync pass captures it, as when a checkout becomes ready.
    await writeFile(join(checkout, 'tracked.txt'), 'final\n');
    await clock.until(runtime.sync().catch(() => undefined));
    expect(commitTimes()).toHaveLength(1);
    // Nothing is edited from here on; only the clock moves.
    for (let step = 0; step < 100 && publications.length < 1; step++) { clock.advance(250); await clock.until(Bun.sleep(2)); }
    await waitForFinal();
    const [refused, retried] = commitTimes();
    expect(retried! - refused!).toBeGreaterThanOrEqual(5_000);
    expect(publications).toEqual([['tracked.txt:final']]);
  });
});

/** Moves simulated time on in `stepMs` steps until `done`. Retry waits are 5 s and longer, which the manual clock never
 * advances by itself; the short real sleep gives each attempt's git processes time to run. */
async function advanceUntil(clock: ManualWorktreeClock, stepMs: number, steps: number, done: () => boolean) {
  for (let step = 0; step < steps && !done(); step++) { clock.advance(stepMs); await clock.until(Bun.sleep(2)); }
}
const syncProblem = (runtime: MachineExecutorRuntime) => runtime.journal.attachment('watch-cache')?.attachment.failure?.message ?? '';

test('a sync that keeps failing stops after 8 attempts, and the next edit starts it again', async () => {
  await watcherProof(async ({ checkout, runtime, clock, event, failCommits, commitTimes, publications, waitForFinal }) => {
    failCommits(1_000);
    await writeFile(join(checkout, 'tracked.txt'), 'first\n');
    await event('tracked.txt');
    await advanceUntil(clock, 5_000, 2_000, () => commitTimes().length > 8 || syncProblem(runtime).includes('after 8 attempts'));
    // An idle hour later the workspace has not been asked again.
    await advanceUntil(clock, 60_000, 60, () => commitTimes().length > 8);
    expect(commitTimes()).toHaveLength(8);
    expect(syncProblem(runtime)).toBe('Changes on this machine could not be sent after 8 attempts: internal error; reference = proof. Edit a file or retry sync to try again.');
    failCommits(0);
    await writeFile(join(checkout, 'tracked.txt'), 'final\n');
    await event('tracked.txt');
    await waitForFinal();
    // The snapshot left pending is sent first, then the edit.
    expect(publications).toEqual([['tracked.txt:first'], ['tracked.txt:final']]);
  });
}, 30_000);

test('a stopped sync stays stopped through Git metadata changes, and restarts on an edit', async () => {
  await watcherProof(async ({ checkout, runtime, clock, event, failCommits, commitTimes, publications, waitForFinal }) => {
    failCommits(1_000);
    await writeFile(join(checkout, 'tracked.txt'), 'first\n');
    await event('tracked.txt');
    await advanceUntil(clock, 5_000, 2_000, () => commitTimes().length > 8 || syncProblem(runtime).includes('after 8 attempts'));
    // An editor running `git status` refreshes the index again and again.
    for (let refresh = 0; refresh < 10; refresh++) { await event('.git/index'); await advanceUntil(clock, 60_000, 2, () => commitTimes().length > 8); }
    expect(commitTimes()).toHaveLength(8);
    failCommits(0);
    await writeFile(join(checkout, 'tracked.txt'), 'final\n');
    await event('tracked.txt');
    await waitForFinal();
    expect(publications).toEqual([['tracked.txt:first'], ['tracked.txt:final']]);
  });
}, 30_000);

test('a checkout state no retry can change is not retried until an edit', async () => {
  await watcherProof(async ({ checkout, clock, event, failCommits, commitTimes, publications, waitForFinal }) => {
    failCommits(1, 'Git LFS write-tree: bun.lock: unmerged');
    await writeFile(join(checkout, 'tracked.txt'), 'first\n');
    await event('tracked.txt');
    await advanceUntil(clock, 5_000, 200, () => commitTimes().length > 1);
    expect(commitTimes()).toHaveLength(1);
    await writeFile(join(checkout, 'tracked.txt'), 'final\n');
    await event('tracked.txt');
    await waitForFinal();
    expect(publications).toEqual([['tracked.txt:first'], ['tracked.txt:final']]);
  });
}, 30_000);

test('a restart continues the attempt count of a failing sync instead of starting over', async () => {
  await watcherProof(async ({ checkout, clock, event, failCommits, commitTimes, restart }) => {
    failCommits(1_000);
    await writeFile(join(checkout, 'tracked.txt'), 'first\n');
    await event('tracked.txt');
    // The wait after the third failure: three attempts are counted.
    const third = clock.pending(20_000, 10_000);
    await advanceUntil(clock, 5_000, 2_000, () => commitTimes().length >= 3);
    await third;
    const runtime = await restart();
    await advanceUntil(clock, 5_000, 2_000, () => commitTimes().length > 8 || syncProblem(runtime).includes('after 8 attempts'));
    await advanceUntil(clock, 60_000, 60, () => commitTimes().length > 8);
    expect(commitTimes()).toHaveLength(8);
  });
}, 30_000);
