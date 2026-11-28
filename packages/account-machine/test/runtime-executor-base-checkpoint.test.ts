import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ControlOperation } from '@gitspace/protocol';
import { RuntimeAttachmentSchema, type RuntimeAttachmentFailure } from '@gitspace/protocol-runtime';
import { CloudRuntimeClient } from '../src/cloud-runtime-client.js';
import { ArtifactsGitRemote } from '../src/artifacts-git-remote.js';
import { createGitIntermediateCheckpoint, type GitIntermediateCheckpoint } from '../src/git-checkpoint.js';
import { createMachineExecutor, type MachineExecutorRuntime } from '../src/runtime-executor.js';
import { ManualWorktreeClock } from './git-worktree-clock.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function commit(cwd: string, content: string, message: string) {
  await writeFile(join(cwd, 'tracked.txt'), content);
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=Base proof', '-c', 'user.email=proof@example.invalid', 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

const REMOTE = 'https://cloud.invalid/project.git';
const GENERATION = 6;

/** The checkpoint the cloud writes when it moves a base workspace to its branch head: every layer is the head commit,
 * and it lists no LFS objects. */
async function baseCheckpoint(repository: string, head: string): Promise<GitIntermediateCheckpoint> {
  const tree = await git(repository, 'rev-parse', `${head}^{tree}`);
  return { checkpointRef: 'refs/gitspace/spaces/workspace/checkpoints', branch: 'main', headCommit: head, indexCommit: head, trackedWorktreeCommit: head, worktreeCommit: head, indexTree: tree, worktreeTree: tree };
}

/** A base workspace's cloud repository on `main`, and the path its checkout takes on the machine. */
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'runtime-base-checkpoint-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'cloud');
  await mkdir(repository, { recursive: true });
  await git(repository, 'init', '-b', 'main');
  await git(repository, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  return { root, repository, checkout: join(root, 'spaces', 'project', 'workspace') };
}

/** What a machine whose attach was cut short left journaled: `committed`, the version it last synced, and `pending`, a
 * capture it published against that version that the cloud never confirmed. */
async function journalSnapshots(root: string, committed: GitIntermediateCheckpoint, pending: GitIntermediateCheckpoint) {
  const directory = join(root, 'runtime', 'executor');
  await mkdir(directory, { recursive: true });
  const database = new Database(join(directory, 'snapshots.sqlite'));
  database.exec('CREATE TABLE snapshots (attachment TEXT PRIMARY KEY, revision INTEGER NOT NULL, pending TEXT, committed TEXT)');
  database.query('INSERT INTO snapshots (attachment, revision, pending, committed) VALUES (?, ?, ?, ?)')
    .run(`attachment:${GENERATION}`, 2, JSON.stringify({ checkpoint: pending, base: committed.worktreeCommit }), JSON.stringify(committed));
  database.close();
}

/** Starts the machine against a cloud whose base workspace is at `checkpoint`, carrying `failure` as the cloud last
 * heard it, and waits for a sync: its startup read and that sync's each assign the attaching attachment, so it is
 * processed twice. The cloud never answers a snapshot commit. */
async function attach(root: string, checkpoint: GitIntermediateCheckpoint, options: { failure?: RuntimeAttachmentFailure; attachDeadlineMs?: number } = {}) {
  let attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'attachment', generation: GENERATION, checkout: { kind: 'shared', branch: 'main' }, state: 'attaching', capabilities: ['read', 'write', 'edit', 'checkpoint'], updatedAt: new Date().toISOString(), failure: options.failure ?? null });
  /** Each publication and each commit the machine asked for, by checkpoint ref. */
  const published: string[] = [];
  /** The commit each ready announcement reported. */
  const announced: string[] = [];
  /** Each commit's signal, and the failure the machine recorded when it asked. */
  const commits: Array<{ signal: AbortSignal; failure: RuntimeAttachmentFailure | null }> = [];
  const ReadySchema = z.object({ commit: z.string() });
  /** Whether the cloud fails every assignments read. */
  let readsFail = false;
  class LocalCloud extends CloudRuntimeClient {
    override async call<S extends z.ZodType>(operation: ControlOperation, payload: Record<string, unknown>, schema: S): Promise<z.output<S>> {
      if (operation === 'runtime.assignments' && readsFail) throw new Error('internal error; reference = assignments unavailable');
      if (operation === 'runtime.assignments') return schema.parse({ assignments: [{ grant: { attachment, executionSecret: 'secret' }, source: { ref: 'refs/heads/main', commit: checkpoint.headCommit, requiresFiltersOrSubmodules: false, remote: REMOTE, origin: null }, checkpoint }] });
      if (operation === 'runtime.attachment.ready') {
        announced.push(ReadySchema.parse(payload).commit);
        attachment = { ...attachment, state: 'ready' };
        return schema.parse({ attachment });
      }
      if (operation === 'runtime.attachment.cache.request') return schema.parse({ attachment });
      if (operation === 'runtime.heartbeat') return schema.parse({ attachment });
      if (operation === 'runtime.checkouts.retired') return schema.parse({ retired: [] });
      throw new Error(`Unexpected operation: ${operation}`);
    }
  }
  class LocalGitRemote extends ArtifactsGitRemote {
    override async publishCheckpoint(input: Parameters<ArtifactsGitRemote['publishCheckpoint']>[0]) { published.push(input.checkpointRef); }
    /** Downloads the commit from the cloud repository, as Artifacts serves it. */
    override async fetchCheckpoint(input: Parameters<ArtifactsGitRemote['fetchCheckpoint']>[0]) {
      await git(input.repositoryPath, 'fetch', '--no-tags', REMOTE, input.commit ?? input.checkpointRef);
      if (input.commit) await git(input.repositoryPath, 'update-ref', input.checkpointRef, input.commit);
    }
  }
  const unavailable = async (): Promise<never> => { throw new Error('External service forbidden'); };
  const clock = new ManualWorktreeClock();
  let runtime: MachineExecutorRuntime | undefined;
  runtime = await createMachineExecutor({
    environmentRoot: join(root, 'runtime'), managedSpaceRoot: join(root, 'spaces'), machineId: 'machine',
    cloud: new LocalCloud({ baseUrl: 'https://base-checkpoint.invalid', userId: 'account', machineId: 'machine', signingPrivateKey: new Uint8Array(32) }),
    gitRemote: new LocalGitRemote({ credentials: unavailable }), prepareAttachment: async () => {},
    commitSnapshot: async (_local, candidate, _previous, signal) => {
      published.push(candidate.checkpointRef);
      commits.push({ signal, failure: runtime?.journal.attachment('attachment')?.attachment.failure ?? null });
      const unanswered = Promise.withResolvers<never>();
      signal.addEventListener('abort', () => unanswered.reject(signal.reason), { once: true });
      return unanswered.promise;
    },
    originEnvironment: async () => ({}),
    checkpointClock: clock, checkpointEvents: () => () => {},
    ...(options.attachDeadlineMs ? { attachDeadlineMs: options.attachDeadlineMs } : {}),
  });
  const started = runtime;
  cleanups.unshift(() => started.close());
  await clock.until(runtime.sync(), 20_000);
  return {
    clock, published, announced, commits,
    failReads: () => { readsFail = true; },
    state: () => attachment.state,
    failure: () => started.journal.attachment('attachment')?.attachment.failure ?? null,
  };
}

test('a clean checkout admitted at the checkpoint the cloud wrote for its base branch attaches at it, publishing nothing', async () => {
  const { root, repository, checkout } = await project();
  const older = await commit(repository, 'older\n', 'older');
  const head = await commit(repository, 'head\n', 'head');
  const cloud = await baseCheckpoint(repository, head);
  await mkdir(checkout, { recursive: true });
  await git(checkout, 'init', '-b', 'main');
  await git(checkout, 'config', `url.file://${repository}.insteadOf`, REMOTE);
  await git(checkout, 'fetch', '--depth', '1', REMOTE, older);
  await git(checkout, 'checkout', '-B', 'main', older);
  const { published, announced, state, failure } = await attach(root, cloud);
  expect(failure()).toBeNull();
  expect(state()).toBe('ready');
  expect(new Set(announced)).toEqual(new Set([head]));
  expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(head);
  expect(await git(checkout, 'status', '--porcelain')).toBe('');
  expect(published).toEqual([]);
}, 30_000);

test('a checkout left attaching with an unconfirmed capture of nothing new attaches at the base version the cloud moved to since', async () => {
  const { root, repository, checkout } = await project();
  const synced = await commit(repository, 'synced\n', 'synced');
  await git(root, 'clone', '--quiet', repository, checkout);
  await git(checkout, 'config', `url.file://${repository}.insteadOf`, REMOTE);
  // The capture taken right after the checkout was admitted at the cloud's version: the same files, listed with their
  // LFS objects (none).
  const unconfirmed = await createGitIntermediateCheckpoint({ repositoryPath: checkout, spaceId: 'workspace', revision: 2, checkpointRef: 'refs/gitspace/spaces/cache-proof/snapshot' });
  await journalSnapshots(root, await baseCheckpoint(repository, synced), unconfirmed);
  // Update base moved the workspace on; the checkout lacks the new head.
  const moved = await commit(repository, 'moved\n', 'moved');
  const { published, announced, state, failure } = await attach(root, await baseCheckpoint(repository, moved));
  expect(failure()).toBeNull();
  expect(state()).toBe('ready');
  expect(new Set(announced)).toEqual(new Set([moved]));
  expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(moved);
  expect(await git(checkout, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('moved\n');
  expect(await git(checkout, 'status', '--porcelain')).toBe('');
  expect(published).toEqual([]);
}, 30_000);

test('an attach whose snapshot commit the cloud never answers fails at its deadline naming what it was doing, and is tried again', async () => {
  const { root, repository, checkout } = await project();
  const synced = await commit(repository, 'synced\n', 'synced');
  await git(root, 'clone', '--quiet', repository, checkout);
  await writeFile(join(checkout, 'tracked.txt'), 'edited on the machine\n');
  const unconfirmed = await createGitIntermediateCheckpoint({ repositoryPath: checkout, spaceId: 'workspace', revision: 2, checkpointRef: 'refs/gitspace/spaces/cache-proof/snapshot' });
  const cloud = await baseCheckpoint(repository, synced);
  await journalSnapshots(root, cloud, unconfirmed);
  const stale: RuntimeAttachmentFailure = { operation: 'materialize', message: `The checkout at ${checkout} has changes that were never synced from this workspace; move it aside to attach`, at: new Date().toISOString() };
  const { clock, published, announced, commits, state, failure } = await attach(root, cloud, { failure: stale, attachDeadlineMs: 3_000 });
  expect(failure()).toEqual({ operation: 'materialize', message: 'Preparing the checkout took longer than 3 s, while sending the checkout\'s changes and applying the cloud version', at: expect.any(String) });
  expect(state()).toBe('attaching');
  expect(announced).toEqual([]);
  // Each of the two attempts sent the unconfirmed capture again and asked the cloud to commit it.
  expect(published).toEqual(Array(4).fill(unconfirmed.checkpointRef));
  // The refusal an earlier attempt recorded was gone once each attempt was past it; the deadline stopped each commit.
  expect(commits.map(item => item.failure)).toEqual([null, null]);
  expect(commits.map(item => item.signal.aborted)).toEqual([true, true]);
  await clock.pending(15_000);
}, 30_000);

test('a failed attach whose retry cannot read the assignments is tried again later', async () => {
  const { root, repository, checkout } = await project();
  const head = await commit(repository, 'head\n', 'head');
  await git(root, 'clone', '--quiet', repository, checkout);
  await writeFile(join(checkout, 'tracked.txt'), 'edited on the machine\n');
  const { clock, failReads, failure } = await attach(root, await baseCheckpoint(repository, head));
  expect(failure()?.message).toBe(`The checkout at ${checkout} has uncommitted changes; move it aside to attach`);
  // The first retry, after 15 s, finds the cloud unable to answer.
  await clock.pending(15_000);
  failReads();
  clock.advance(15_000);
  // Two failed attempts and that retry doubled the pause twice from 15 s.
  await clock.pending(60_000);
}, 30_000);
