import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutableArtifactManifest } from '@gitspace/account-omp/manifest';
import { ProcessOmpRuntime, type OmpGenerationSelection } from '../src/omp-runtime.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(options: { next?: boolean; holdInitialize?: boolean; hangDispose?: boolean; stubborn?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'omp-lifecycle-'));
  roots.push(root);
  const generation = async (name: string, settings = options): Promise<OmpGenerationSelection> => {
    const path = join(root, name);
    await mkdir(path);
    await writeFile(join(path, 'omp.js'), `import { serveLifecycleFixture } from ${JSON.stringify(new URL('./fixtures/omp-lifecycle.ts', import.meta.url).pathname)};\nserveLifecycleFixture(${JSON.stringify({ root, generation: name, ...settings })});\n`);
    const { manifest, manifestHash } = await createExecutableArtifactManifest(path, 'omp', { upstreamVersion: '18.1.10', bunVersion: Bun.version, packages: {}, patches: [] });
    return { path, hash: manifest.treeHash, manifestHash, sha: name };
  };
  const old = await generation('old', options.next ? {} : options);
  const next = options.next ? await generation('next') : null;
  const runtime = new ProcessOmpRuntime({ environmentRoot: root, entrypoint: join(old.path, 'omp.js'), manifestHash: old.manifestHash, agentDir: join(root, 'agent'), sessionRoot: join(root, 'sessions') });
  await runtime.initialize(old);
  await runtime.commitInitialSelection();
  const input = { projectId: 'project', workspaceId: null, workingDirectory: root, sessionKey: 'canonical', artifactsDir: root };
  return { root, runtime, input, next };
}

async function waitForFile(path: string): Promise<void> {
  // This observes a real child-process gate; parent fake timers cannot drive it.
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Fixture did not reach ${path}`);
    await Bun.sleep(5);
  }
}

function assertExited(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow();
}

test('persist waits after handoff closes predecessor while automatic migration has not assigned successor', async () => {
  const { root, runtime, input, next } = await fixture({ next: true, holdInitialize: true });
  try {
    const session = await runtime.create(input);
    await session.prompt('Do not replay this task');
    expect((await runtime.activate(next!)).draining).toBe(1);
    expect(existsSync(join(root, 'next.pid'))).toBe(false); // Active turn pins old generation.
    const oldPid = Number(await readFile(join(root, 'old.pid'), 'utf8'));
    expect(await session.handoff()).toBe(true);
    await waitForFile(join(root, 'next.pid'));
    assertExited(oldPid); // start(next) is blocked inside initialize, before assignment.
    const before = JSON.parse(await readFile(session.sessionFile, 'utf8'));
    expect(before).toEqual({ id: session.id, messages: ['Do not replay this task'] });
    const persisting = session.persist();
    const observed = persisting.then(() => 'succeeded', error => error);
    await writeFile(join(root, 'next.release'), 'release');
    expect(await observed).toBe('succeeded');
    expect(session.id).toBe(before.id);
    expect(await session.messages()).toEqual(['Do not replay this task']);
    expect(await readFile(session.sessionFile, 'utf8')).toBe(JSON.stringify(before));
    expect((await readFile(join(root, 'operations'), 'utf8')).trim().split('\n')).toEqual([
      'old:initialize', 'old:prompt', 'old:handoff-flushed', 'old:persist', 'old:dispose', 'next:initialize', 'next:persist',
    ]);
  } finally { await runtime.dispose(); }
}, 15_000);

test('persistence reports its actual stage and RPC cause rather than the previous handoff activity failure', async () => {
  const { root, runtime, input } = await fixture();
  try {
    const session = await runtime.create(input);
    await session.prompt('task');
    await session.handoff();
    await writeFile(join(root, 'fail-persist'), 'fail');
    await expect(session.persist()).rejects.toMatchObject({ message: 'OMP persist failed: checkpoint disk unavailable', cause: { message: 'checkpoint disk unavailable', code: 'EIO' } });
  } finally { await runtime.dispose(); }
});

test('aborted open fences a child stuck initializing before rejecting and permits one clean successor', async () => {
  const { root, runtime, input } = await fixture({ holdInitialize: true, stubborn: true });
  const sessionFile = join(root, 'session.json');
  await writeFile(sessionFile, JSON.stringify({ id: 'saved-session', messages: ['existing task'] }));
  const controller = new AbortController();
  const reason = new Error('recovery deadline');
  const opening = runtime.open({ ...input, sessionFile }, controller.signal);
  const rejected = opening.catch(error => error);
  try {
    await waitForFile(join(root, 'old.pid'));
    const pid = Number(await readFile(join(root, 'old.pid'), 'utf8'));
    controller.abort(reason);
    expect(await rejected).toBe(reason);
    assertExited(pid);
    await writeFile(join(root, 'old.release'), 'release');
    const successor = await runtime.open({ ...input, sessionFile });
    expect(successor.id).toBe('saved-session');
    expect(await successor.messages()).toEqual(['existing task']);
  } finally { await runtime.dispose(); }
}, 10_000);

test('dispose fences a child despite a hung dispose RPC and ignored disconnect', async () => {
  const { root, runtime, input } = await fixture({ hangDispose: true, stubborn: true });
  try {
    const session = await runtime.create(input);
    const pid = Number(await readFile(join(root, 'old.pid'), 'utf8'));
    await Promise.all([session.dispose(), session.dispose()]);
    assertExited(pid);
    expect(session.isAvailable?.()).toBe(false);
  } finally { await runtime.dispose(); }
}, 10_000);

test('dispose fences pending migration initialization without awaiting its hung RPC or spawning rollback', async () => {
  const { root, runtime, input, next } = await fixture({ next: true, holdInitialize: true, stubborn: true });
  try {
    const session = await runtime.create(input);
    await session.prompt('task');
    await runtime.activate(next!);
    await session.handoff();
    await waitForFile(join(root, 'next.pid'));
    const pid = Number(await readFile(join(root, 'next.pid'), 'utf8'));
    await session.dispose();
    assertExited(pid);
    expect(session.isAvailable?.()).toBe(false);
    expect((await readFile(join(root, 'operations'), 'utf8')).match(/old:initialize/gu)).toEqual(['old:initialize']);
  } finally { await runtime.dispose(); }
}, 10_000);
