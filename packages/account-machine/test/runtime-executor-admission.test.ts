import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ControlOperation } from '@gitspace/protocol';
import { RuntimeAttachmentSchema } from '@gitspace/protocol-runtime';
import { CloudRuntimeClient } from '../src/cloud-runtime-client.js';
import { ArtifactsGitRemote } from '../src/artifacts-git-remote.js';
import { createGitIntermediateCheckpoint } from '../src/git-checkpoint.js';
import { createMachineExecutor } from '../src/runtime-executor.js';
import { ManualWorktreeClock } from './git-worktree-clock.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function commit(cwd: string, path: string, content: string, message: string) {
  await writeFile(join(cwd, path), content);
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=Admission proof', '-c', 'user.email=proof@example.invalid', 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

const REMOTE = 'https://cloud.invalid/project.git';

/** A workspace whose cloud repository holds `main` at `older` then `head`, and whose cloud version is `head` with an
 * unsent draft. Its checkout path already holds a checkout at `older`, as an earlier attach left it: fetched at depth 1,
 * with no remote-tracking branches, `REMOTE` reaching the cloud repository. `change` alters it before the machine starts;
 * the machine then attaches it once. */
async function attachExisting(change: (checkout: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-admission-'));
  const repository = join(root, 'cloud');
  const checkout = join(root, 'spaces', 'project', 'workspace');
  await mkdir(repository, { recursive: true });
  await git(repository, 'init', '-b', 'main');
  await git(repository, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const older = await commit(repository, 'tracked.txt', 'older\n', 'older');
  await commit(repository, 'tracked.txt', 'between\n', 'between');
  const head = await commit(repository, 'tracked.txt', 'head\n', 'head');
  await writeFile(join(repository, 'draft.txt'), 'cloud draft\n');
  const cloud = await createGitIntermediateCheckpoint({ repositoryPath: repository, spaceId: 'workspace', revision: 1 });
  await mkdir(checkout, { recursive: true });
  await git(checkout, 'init', '-b', 'main');
  await git(checkout, 'config', `url.file://${repository}.insteadOf`, REMOTE);
  await git(checkout, 'fetch', '--depth', '1', REMOTE, older);
  await git(checkout, 'checkout', '-B', 'main', older);
  await change(checkout);
  let attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'admission', generation: 0, checkout: { kind: 'shared', branch: 'main' }, state: 'attaching', capabilities: ['read', 'write', 'edit', 'checkpoint'], updatedAt: new Date().toISOString() });
  const published: string[] = [];
  class LocalCloud extends CloudRuntimeClient {
    override async call<S extends z.ZodType>(operation: ControlOperation, _payload: Record<string, unknown>, schema: S): Promise<z.output<S>> {
      if (operation === 'runtime.assignments') return schema.parse({ assignments: [{ grant: { attachment, executionSecret: 'secret' }, source: { ref: 'refs/heads/main', commit: head, requiresFiltersOrSubmodules: false, remote: REMOTE, origin: null }, checkpoint: cloud }] });
      if (operation === 'runtime.attachment.ready') { attachment = { ...attachment, state: 'ready' }; return schema.parse({ attachment }); }
      if (operation === 'runtime.attachment.cache.request') return schema.parse({ attachment });
      if (operation === 'runtime.heartbeat') return schema.parse({ attachment });
      if (operation === 'runtime.checkouts.retired') return schema.parse({ retired: [] });
      throw new Error(`Unexpected operation: ${operation}`);
    }
  }
  class LocalGitRemote extends ArtifactsGitRemote {
    override async publishCheckpoint(input: Parameters<ArtifactsGitRemote['publishCheckpoint']>[0]) { published.push(input.checkpointRef); }
    override async fetchCheckpoint(input: Parameters<ArtifactsGitRemote['fetchCheckpoint']>[0]) { await git(input.repositoryPath, 'cat-file', '-e', `${input.commit}^{commit}`); }
  }
  const unavailable = async (): Promise<never> => { throw new Error('External service forbidden'); };
  const clock = new ManualWorktreeClock();
  const runtime = await createMachineExecutor({
    environmentRoot: join(root, 'runtime'), managedSpaceRoot: join(root, 'spaces'), machineId: 'machine',
    cloud: new LocalCloud({ baseUrl: 'https://admission.invalid', userId: 'account', machineId: 'machine', signingPrivateKey: new Uint8Array(32) }),
    gitRemote: new LocalGitRemote({ credentials: unavailable }), prepareAttachment: async () => {},
    commitSnapshot: async (_local, candidate) => { published.push(candidate.checkpointRef); return candidate; },
    originEnvironment: async () => ({}),
    checkpointClock: clock, checkpointEvents: () => () => {},
  });
  cleanups.push(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  await clock.until(runtime.sync(), 20_000);
  return {
    checkout, cloud, older, published,
    state: () => attachment.state,
    failure: () => runtime.journal.attachment('admission')?.attachment.failure?.message ?? null,
  };
}

test('a clean checkout at an older commit of the cloud head is admitted at the cloud version, publishing nothing from it', async () => {
  const { checkout, cloud, published, state, failure } = await attachExisting(async () => {});
  expect(failure()).toBeNull();
  expect(state()).toBe('ready');
  expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(cloud.headCommit ?? '');
  expect(await git(checkout, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  expect(await git(checkout, 'write-tree')).toBe(cloud.indexTree);
  expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('head\n');
  expect(await readFile(join(checkout, 'draft.txt'), 'utf8')).toBe('cloud draft\n');
  expect(await git(checkout, 'status', '--porcelain')).toBe('?? draft.txt');
  expect(published).toEqual([]);
}, 30_000);

test('a checkout with uncommitted changes is refused as having them', async () => {
  const { checkout, older, published, state, failure } = await attachExisting(async checkout => { await writeFile(join(checkout, 'tracked.txt'), 'local edit\n'); });
  expect(failure()).toBe(`The checkout at ${checkout} has uncommitted changes; move it aside to attach`);
  expect(state()).toBe('attaching');
  expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(older);
  expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('local edit\n');
  expect(published).toEqual([]);
}, 30_000);

test('a checkout with a commit the cloud never received is refused naming it', async () => {
  let local = '';
  const { checkout, published, state, failure } = await attachExisting(async checkout => {
    await commit(checkout, 'tracked.txt', 'local commit\n', 'local');
    local = await git(checkout, 'rev-parse', '--short', 'HEAD');
  });
  expect(failure()).toBe(`The checkout at ${checkout} has commits ${local} that GitSpace never received; move it aside to attach`);
  expect(state()).toBe('attaching');
  expect(await git(checkout, 'rev-parse', '--short', 'HEAD')).toBe(local);
  expect(published).toEqual([]);
}, 30_000);
