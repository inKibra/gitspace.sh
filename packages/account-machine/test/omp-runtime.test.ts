import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutableArtifactManifest } from '@gitspace/account-omp/manifest';
import { ProcessOmpRuntime, ompChildEnvironment, type OmpGenerationSelection } from '../src/omp-runtime.js';
import type { InferenceExecutionContext } from '@gitspace/protocol';
import { inferenceContext } from './fixtures/inference.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(options: { next?: boolean; holdInitialize?: boolean; holdPrompt?: boolean; hangDispose?: boolean; stubborn?: boolean; noAuthority?: boolean } = {}, resolveInference: (projectId: string) => Promise<InferenceExecutionContext> = async (projectId) => inferenceContext(projectId)) {
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
  const runtime = new ProcessOmpRuntime({ environmentRoot: root, entrypoint: join(old.path, 'omp.js'), manifestHash: old.manifestHash, agentDir: join(root, 'agent'), sessionRoot: join(root, 'sessions'), ...(options.noAuthority ? {} : { resolveInference }) });
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

interface Admission {
  method: string; text: string; projectId: string; profileId: string; assignmentRevision: number;
  profileRevision: number; advancedGeneration: number; token: string; ambient: boolean;
}
async function admissions(root: string, count: number): Promise<Admission[]> {
  // These markers come from real child processes; parent fake timers cannot drive their I/O.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const content = await readFile(join(root, 'admissions'), 'utf8').catch(() => '');
    const records = content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Admission);
    if (records.length >= count) return records;
    await Bun.sleep(5);
  }
  throw new Error('Expected inference admission did not start');
}

test('two projects share a machine but retain separate profile broker scopes', async () => {
  const { root, runtime, input } = await fixture({}, async (projectId) => inferenceContext(projectId, projectId === 'project' ? 'client-a' : 'client-b'));
  try {
    const first = await runtime.create(input);
    const second = await runtime.create({ ...input, projectId: 'other-project', sessionKey: 'other' });
    await Promise.all([first.prompt('first project'), second.prompt('second project')]);
    expect((await admissions(root, 2)).sort((a, b) => a.projectId.localeCompare(b.projectId))).toEqual([
      expect.objectContaining({ projectId: 'other-project', profileId: 'client-b', token: 'scope-client-b', text: 'second project', ambient: false }),
      expect.objectContaining({ projectId: 'project', profileId: 'client-a', token: 'scope-client-a', text: 'first project', ambient: false }),
    ]);
    await runtime.reloadAuthStorage('client-a');
    const reloads = (await readFile(join(root, 'auth-reloads'), 'utf8')).trim().split('\n');
    expect(reloads.filter((scope) => scope === 'project:client-a')).toHaveLength(2);
    expect(reloads.filter((scope) => scope === 'other-project:client-b')).toHaveLength(1);
  } finally { await runtime.dispose(); }
});

test('reassignment leaves an active turn pinned and binds queued work only when it starts', async () => {
  let current = inferenceContext('project');
  const { root, runtime, input } = await fixture({ holdPrompt: true }, async () => current);
  try {
    const session = await runtime.create(input);
    const first = session.prompt('admitted before reassignment');
    await waitForFile(join(root, 'old.prompt-started'));
    current = inferenceContext('project', 'client', 1);
    expect(await session.prompt('queued after reassignment')).toBe(true);
    expect((await session.control()).queue.followUp).toEqual(['queued after reassignment']);
    expect(await admissions(root, 1)).toEqual([expect.objectContaining({ profileId: 'default', text: 'admitted before reassignment' })]);
    await writeFile(join(root, 'old.prompt-release'), 'complete');
    await first;
    expect(await admissions(root, 2)).toEqual([
      expect.objectContaining({ profileId: 'default', assignmentRevision: 0, token: 'scope-default' }),
      expect.objectContaining({ profileId: 'client', assignmentRevision: 1, token: 'scope-client', text: 'queued after reassignment' }),
    ]);
    expect(await session.messages()).toEqual(['admitted before reassignment', 'queued after reassignment']);
    expect(session.id).toBe('canonical');
  } finally { await runtime.dispose(); }
});

test('same-profile revisions apply inside the running worker; a new profile reopens it without reporting a disconnect', async () => {
  let current = inferenceContext('project');
  const { root, runtime, input } = await fixture({ holdPrompt: true }, async () => current);
  await writeFile(join(root, 'old.prompt-release'), 'complete');
  try {
    const session = await runtime.create(input);
    const availability: boolean[] = [];
    const unsubscribe = session.subscribeActivity(() => { availability.push(session.isAvailable()); });
    await session.prompt('before the edit');
    const pid = await readFile(join(root, 'old.pid'), 'utf8');
    // Roles, models or providers edited: a new revision of the same profile and broker scope.
    current = inferenceContext('project', 'default', 1);
    await session.prompt('after the edit');
    expect(await readFile(join(root, 'old.pid'), 'utf8')).toBe(pid);
    // A different profile is a new credential scope: only then does a fresh worker start.
    current = inferenceContext('project', 'client', 2);
    await session.prompt('after reassignment');
    unsubscribe();
    expect(await readFile(join(root, 'old.pid'), 'utf8')).not.toBe(pid);
    expect((await readFile(join(root, 'operations'), 'utf8')).trim().split('\n')).toEqual([
      'old:initialize', 'old:prompt', 'old:apply-inference', 'old:prompt', 'old:persist', 'old:dispose', 'old:initialize', 'old:prompt',
    ]);
    expect(await admissions(root, 3)).toEqual([
      expect.objectContaining({ text: 'before the edit', profileId: 'default', profileRevision: 0 }),
      expect.objectContaining({ text: 'after the edit', profileId: 'default', profileRevision: 1, token: 'scope-default' }),
      expect.objectContaining({ text: 'after reassignment', profileId: 'client', profileRevision: 2, token: 'scope-client' }),
    ]);
    expect(availability.length).toBeGreaterThan(0);
    expect(availability.every(Boolean)).toBe(true);
  } finally { await runtime.dispose(); }
});

test('unavailable authority blocks new and queued admissions without replaying accepted work', async () => {
  let available = true;
  let current = inferenceContext('project');
  const { root, runtime, input } = await fixture({ holdPrompt: true }, async () => {
    if (!available) throw new Error('Canonical inference unavailable');
    return current;
  });
  try {
    const session = await runtime.create(input);
    const blocked = Promise.withResolvers<void>();
    const unsubscribe = session.subscribeActivity((_activity, failure) => { if (failure) blocked.resolve(); });
    const first = session.prompt('accepted');
    await waitForFile(join(root, 'old.prompt-started'));
    await session.prompt('waiting for authority');
    available = false;
    await writeFile(join(root, 'old.prompt-release'), 'complete');
    await first;
    await blocked.promise;
    unsubscribe();
    expect(session.activity().failure?.message).toContain('Canonical inference unavailable');
    expect((await session.control()).queue.followUp).toEqual(['waiting for authority']);
    expect((await admissions(root, 1)).map((entry) => entry.text)).toEqual(['accepted']);
    await expect(session.compact()).rejects.toThrow('Canonical inference unavailable');
    current = inferenceContext('project', 'reassigned', 1);
    available = true;
    await session.promoteQueuedMessage(0);
    expect((await admissions(root, 2)).map((entry) => [entry.text, entry.profileId])).toEqual([
      ['accepted', 'default'], ['waiting for authority', 'reassigned'],
    ]);
  } finally { await runtime.dispose(); }
});

test('resume after moving a transcript resolves current assignment and shared Advanced revision', async () => {
  let current = inferenceContext('project');
  const { root, runtime, input } = await fixture({}, async () => current);
  try {
    const session = await runtime.create(input);
    await session.prompt('persisted history');
    await session.handoff();
    await session.dispose();
    current = inferenceContext('project', 'new-profile', 2);
    const moved = join(root, 'moved-workspace');
    await mkdir(moved);
    const restored = await runtime.open({ ...input, workingDirectory: moved, workspaceId: 'moved-space', sessionFile: session.sessionFile });
    await restored.resume();
    current = { ...current, advanced: { ...current.advanced, generation: 2 } };
    await restored.compact();
    expect((await admissions(root, 3)).map((entry) => [entry.method, entry.profileId, entry.advancedGeneration])).toEqual([
      ['prompt', 'default', 1], ['resume', 'new-profile', 1], ['compact', 'new-profile', 2],
    ]);
    expect(await restored.messages()).toEqual(['persisted history']);
  } finally { await runtime.dispose(); }
});

test('broker unavailability blocks a new turn even when canonical revisions are unchanged', async () => {
  const { root, runtime, input } = await fixture();
  try {
    const session = await runtime.create(input);
    await session.prompt('already admitted');
    await session.handoff();
    await writeFile(join(root, 'fail-auth'), 'offline');
    await expect(session.prompt('must not use cached credentials')).rejects.toThrow('Profile broker unavailable');
    expect((await admissions(root, 1)).map((entry) => entry.text)).toEqual(['already admitted']);
  } finally { await runtime.dispose(); }
});

test('stop cancels an admission waiting for canonical authority before any inference begins', async () => {
  let hold = false;
  const requested = Promise.withResolvers<void>();
  const resolved = Promise.withResolvers<InferenceExecutionContext>();
  const { runtime, input } = await fixture({}, async (projectId) => {
    if (!hold) return inferenceContext(projectId);
    requested.resolve();
    return resolved.promise;
  });
  try {
    const session = await runtime.create(input);
    hold = true;
    const pending = session.prompt('cancel before admission');
    const observed = pending.catch((error: unknown) => error);
    await requested.promise;
    await session.stop();
    resolved.resolve(inferenceContext('project'));
    expect(await observed).toMatchObject({ message: 'Inference admission was cancelled' });
    expect(await session.messages()).toEqual([]);
  } finally { resolved.resolve(inferenceContext('project')); await runtime.dispose(); }
});

test('unconfigured local runtimes fail closed and child environments contain no broad auth', async () => {
  const { runtime, input } = await fixture({ noAuthority: true });
  try { await expect(runtime.create(input)).rejects.toThrow('Canonical inference authority is required'); }
  finally { await runtime.dispose(); }
  expect(ompChildEnvironment({
    PATH: '/usr/bin', HOME: '/home/test', OPENAI_API_KEY: 'personal', AWS_PROFILE: 'personal',
    AWS_ACCESS_KEY_ID: 'personal', GOOGLE_APPLICATION_CREDENTIALS: '/personal.json',
    OMP_AUTH_BROKER_TOKEN: 'account-management', GITSPACE_MACHINE_SIGNING_KEY: 'signing-key',
    GITSPACE_CLOUDFLARE_API_TOKEN: 'cloud-admin', NODE_OPTIONS: '--require personal-auth',
  })).toEqual({ GITSPACE_MANAGED_INFERENCE: '1', PATH: '/usr/bin', HOME: '/home/test' });
});
