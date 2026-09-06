import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FactEventStore,
  GitSpaceDatabase,
  LocalArtifactResolver,
  MemoryArtifactObjectStore,
  agentSessions,
  artifactScopes,
} from '@gitspace/core';
import {
  CloudDataCheckpointBlobStore,
  CloudArtifactObjectStore,
  CloudSpaceCheckpointAuthority,
  ClosedSpaceTranscriptReader,
  EncryptedCheckpointBlobStore,
  FileCheckpointBlobStore,
  MachinePortableSpaceController,
  MachineSessionCoordinator,
  WalgitSupervisor,
  PortableSpaceLifecycle,
  projectOmpTranscript,
  projectOmpCheckpointTranscript,
  type OmpRuntime,
  type OmpRuntimeEvent,
  type OmpRuntimeSession,
  type SpaceCheckpointAuthority,
  type SpaceGitCheckpointRemote,
  type WalgitProjectBinding,
} from '../src/index.js';

import { eq } from 'drizzle-orm';

const roots: string[] = [];
const ompEntrypoint = join(import.meta.dir, '../../account-omp/src/runtime.ts');
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...Bun.env,
      GIT_AUTHOR_NAME: 'GitSpace Test',
      GIT_AUTHOR_EMAIL: 'test@gitspace.invalid',
      GIT_COMMITTER_NAME: 'GitSpace Test',
      GIT_COMMITTER_EMAIL: 'test@gitspace.invalid',
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

class PortableOmpRuntime implements OmpRuntime {
  resumeCalls = 0;
  constructor(private sessionFile: string) {}
  async create(input: { workingDirectory: string; sessionKey: string; artifactsDir: string }): Promise<OmpRuntimeSession> {
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    writeFileSync(this.sessionFile, `${JSON.stringify({ type: 'session', version: 3, id: 'omp-portable', timestamp: new Date().toISOString(), cwd: input.workingDirectory })}\n`);
    return this.session(input.artifactsDir);
  }
  async open(input: { workingDirectory: string; sessionKey: string; artifactsDir: string; sessionFile: string }): Promise<OmpRuntimeSession> {
    expect(readFileSync(input.sessionFile, 'utf8')).toContain('omp-portable');
    this.sessionFile = input.sessionFile;
    return this.session(input.artifactsDir);
  }
  transcript(sessionFile: string) { return projectOmpTranscript(sessionFile, ompEntrypoint); }
  checkpointTranscript(bytes: Uint8Array) { return projectOmpCheckpointTranscript(bytes, ompEntrypoint); }
  private session(artifactsDir: string): OmpRuntimeSession {
    const handlers = new Set<(event: OmpRuntimeEvent) => void>();
    return {
      id: 'omp-portable',
      sessionFile: this.sessionFile,
      control: async () => { throw new Error('Session controls are not configured in this fixture'); },
      cycleRole: async () => { throw new Error('Session controls are not configured in this fixture'); },
      setModel: async () => { throw new Error('Session controls are not configured in this fixture'); },
      setThinking: async () => { throw new Error('Session controls are not configured in this fixture'); },
      setFast: async () => { throw new Error('Session controls are not configured in this fixture'); },
      setApproval: async () => { throw new Error('Session controls are not configured in this fixture'); },
      setGoal: async () => { throw new Error('Session controls are not configured in this fixture'); },
      compact: async () => { throw new Error('Session controls are not configured in this fixture'); },
      clearQueue: async () => { throw new Error('Session controls are not configured in this fixture'); },
      removeQueuedMessage: async () => { throw new Error('Session controls are not configured in this fixture'); },
      promoteQueuedMessage: async () => { throw new Error('Session controls are not configured in this fixture'); },
      answerAsk: async () => { throw new Error('Session controls are not configured in this fixture'); },
      stop: async () => { throw new Error('Session controls are not configured in this fixture'); },
      navigateTree: async () => { throw new Error('Session controls are not configured in this fixture'); },
      prompt: async (text) => {
        mkdirSync(join(artifactsDir, 'workspace'), { recursive: true });
        writeFileSync(join(artifactsDir, 'workspace', 'agent.txt'), text);
        const messages = readFileSync(this.sessionFile, 'utf8').split('\n')
          .filter(Boolean).map((line) => JSON.parse(line) as { type: string; id?: string });
        const message = { role: 'assistant', content: [{ type: 'text', text: `done:${text}` }] };
        writeFileSync(this.sessionFile, `${readFileSync(this.sessionFile, 'utf8')}${JSON.stringify({
          type: 'message',
          id: crypto.randomUUID(),
          parentId: messages.findLast((entry) => entry.type === 'message')?.id ?? null,
          timestamp: new Date().toISOString(),
          message,
        })}\n`);
        for (const handler of handlers) handler({ type: 'message_end', message });
        return true;
      },
      subscribe: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
      subscribeActivity: (handler) => { handler({ active: false, reasons: [] }); return () => undefined; },
      activity: () => ({ activity: { active: false, reasons: [] } }),
      persist: async () => undefined,
      handoff: async () => false,
      resume: async () => { this.resumeCalls += 1; },
      dispose: async () => undefined,
      messages: async () => readFileSync(this.sessionFile, 'utf8').split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; message?: unknown })
        .filter((entry) => entry.type === 'message')
        .map((entry) => entry.message),
    };
  }
}

class Authority implements SpaceCheckpointAuthority {
  state: 'open' | 'closing' | 'closed' | 'opening' = 'open';
  generation = 1;
  revision = 0;
  manifestKey?: string;
  manifestHash?: `sha256:${string}`;
  async beginClose(input: { expectedGeneration: number }) {
    expect(input.expectedGeneration).toBe(this.generation);
    this.state = 'closing';
    this.revision += 1;
    return { revision: this.revision, previousRevision: null };
  }
  async commitClosed(input: { manifestKey: string; manifestHash: `sha256:${string}` }) {
    this.manifestKey = input.manifestKey;
    this.manifestHash = input.manifestHash;
    this.state = 'closed';
    this.generation += 1;
  }
  async abortClose() { this.state = 'open'; }
  async beginOpen(input: { expectedGeneration: number }) {
    expect(input.expectedGeneration).toBe(this.generation);
    this.state = 'opening';
    return { revision: this.revision, manifestKey: this.manifestKey!, manifestHash: this.manifestHash! };
  }
  async commitOpen() { this.state = 'open'; this.generation += 1; }
  async failOpen() { this.state = 'closed'; }
}

class BareRemote implements SpaceGitCheckpointRemote {
  constructor(private readonly remote: string) {}
  async publishCheckpoint(input: { repositoryPath: string; checkpointRef: string }) {
    git(input.repositoryPath, 'push', this.remote, `${input.checkpointRef}:${input.checkpointRef}`);
  }
  async fetchCheckpoint(input: { repositoryPath: string; checkpointRef: string }) {
    git(input.repositoryPath, 'fetch', this.remote, `${input.checkpointRef}:${input.checkpointRef}`);
  }
}

describe('CoordinatorPortableSpaceRuntime', () => {
  it('restores a released workspace after the entire machine root is erased without changing session identity or lowering fences', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-erased-machine-'));
    roots.push(root);
    const machineRoot = join(root, 'machine');
    const repository = join(machineRoot, 'project-a', 'workspace-a');
    const remote = join(root, 'durable-repository.git');
    mkdirSync(repository, { recursive: true });
    git(repository, 'init', '-b', 'main');
    writeFileSync(join(repository, 'tracked.txt'), 'original\n');
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'original');
    git(root, 'init', '--bare', remote);
    const durableBlobs = new FileCheckpointBlobStore(join(root, 'durable-objects'));
    const artifactKey = new Uint8Array(32).fill(7);
    const authority = new Authority();
    const lifecycle = new PortableSpaceLifecycle(authority, new EncryptedCheckpointBlobStore(durableBlobs, artifactKey), new BareRemote(remote));
    const binding: WalgitProjectBinding = { projectId: 'project-a', bucket: 'bucket', endpoint: 'https://example.invalid', region: 'auto' };
    const source = new GitSpaceDatabase(join(machineRoot, 'gitspace.db'));
    source.createProject({ id: 'project-a', name: 'Project', repositoryPath: join(machineRoot, 'project-a', 'base') });
    source.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'Workspace', branch: 'main', rootPath: repository });
    source.possessSpace('workspace-a', 'machine-a');
    const artifacts = new LocalArtifactResolver(source, new CloudArtifactObjectStore('account-a', durableBlobs), join(machineRoot, 'cache'), artifactKey);
    const coordinator = new MachineSessionCoordinator(source, artifacts, new PortableOmpRuntime(join(machineRoot, 'omp.jsonl')), 'machine-a', join(machineRoot, 'runtime'));
    const session = await coordinator.openSpace('workspace-a');
    if (session.status === 'error') throw session.error;
    const content = `last-turn-${crypto.randomUUID()}`;
    await coordinator.prompt(session.value.id, content);
    writeFileSync(join(repository, 'tracked.txt'), 'unstaged final work\n');
    writeFileSync(join(repository, 'staged.txt'), 'staged final work\n');
    git(repository, 'add', 'staged.txt');
    writeFileSync(join(repository, 'untracked.txt'), content);
    source.orm.update(agentSessions).set({ resumePending: true }).where(eq(agentSessions.id, session.value.id)).run();
    const controller = new MachinePortableSpaceController(source, coordinator, lifecycle, 'machine-a', () => binding, async () => null, machineRoot);
    await controller.release(source.getSpace('workspace-a')!, 1);
    const scope = source.orm.select().from(artifactScopes).all().find((scope) => scope.spaceId === 'workspace-a')!;
    source.close();
    rmSync(machineRoot, { recursive: true, force: true });

    mkdirSync(machineRoot);
    const destination = new GitSpaceDatabase(join(machineRoot, 'gitspace.db'));
    destination.createProject({ id: 'project-a', name: 'Project', repositoryPath: join(machineRoot, 'project-a', 'base') });
    destination.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'Workspace', branch: 'main', rootPath: repository });
    const restoredArtifacts = new LocalArtifactResolver(destination, new CloudArtifactObjectStore('account-a', durableBlobs), join(machineRoot, 'cache'), artifactKey);
    const restoredRuntime = new PortableOmpRuntime(join(machineRoot, 'unused.jsonl'));
    const restoredSessions = new MachineSessionCoordinator(destination, restoredArtifacts, restoredRuntime, 'machine-a', join(machineRoot, 'runtime'));
    const restoredController = new MachinePortableSpaceController(destination, restoredSessions, lifecycle, 'machine-a', () => binding, async () => null, machineRoot);
    await restoredController.open('workspace-a', 2);
    expect(destination.getSpace('workspace-a')).toMatchObject({ holderId: 'machine-a', placementState: 'open', generation: 3 });
    expect(authority.generation).toBe(3);
    expect(restoredSessions.get(session.value.id)).toMatchObject({ id: session.value.id, ompSessionId: session.value.ompSessionId, state: 'active' });
    expect(restoredRuntime.resumeCalls).toBe(1);
    expect(JSON.stringify(await restoredSessions.transcript(session.value.id))).toContain(content);
    expect(readFileSync(join(repository, 'tracked.txt'), 'utf8')).toBe('unstaged final work\n');
    expect(readFileSync(join(repository, 'untracked.txt'), 'utf8')).toBe(content);
    expect(git(repository, 'diff', '--cached', '--name-only')).toBe('staged.txt');
    expect(destination.orm.select().from(artifactScopes).all().find((entry) => entry.spaceId === 'workspace-a')).toMatchObject({ id: scope.id, generation: scope.generation, manifestHash: scope.manifestHash });
    const artifact = await restoredArtifacts.read({ kind: 'workspace', projectId: 'project-a', workspaceId: 'workspace-a' }, 'local://workspace/agent.txt');
    if (artifact.status === 'error') throw artifact.error;
    expect(new TextDecoder().decode(artifact.value)).toBe(content);
    destination.invalidateSpacePossession({ spaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 3 });
    await expect(restoredController.open('workspace-a', 2)).rejects.toThrow();
    expect(destination.getSpace('workspace-a')?.generation).toBe(3);
    destination.close();
  });
  it('moves real files and the canonical OMP agent from machine A to machine B', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-coordinator-portable-'));
    roots.push(root);
    const workspaceRoot = join(root, 'workspace');
    const remote = join(root, 'remote.git');
    const sessionFile = join(root, 'sessions', 'omp-portable.jsonl');
    mkdirSync(workspaceRoot);
    git(workspaceRoot, 'init', '-b', 'main');
    writeFileSync(join(workspaceRoot, '.gitignore'), 'secret.env\n');
    writeFileSync(join(workspaceRoot, 'tracked.txt'), 'base\n');
    git(workspaceRoot, 'add', '.');
    git(workspaceRoot, 'commit', '-m', 'base');
    writeFileSync(join(workspaceRoot, 'staged.txt'), 'staged\n');
    git(workspaceRoot, 'add', 'staged.txt');
    writeFileSync(join(workspaceRoot, 'tracked.txt'), 'changed\n');
    writeFileSync(join(workspaceRoot, 'portable.txt'), 'portable\n');
    writeFileSync(join(workspaceRoot, 'secret.env'), 'do-not-move\n');
    git(root, 'init', '--bare', remote);

    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    expect(database.createProject({ id: 'project-a', name: 'Project', repositoryPath: join(root, 'base') }).status).toBe('ok');
    expect(database.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'Workspace', branch: 'main', rootPath: workspaceRoot }).status).toBe('ok');
    expect(database.possessWorkspace('workspace-a', 'machine-a').status).toBe('ok');
    const artifacts = new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'artifact-cache'), new Uint8Array(32).fill(3));
    const coordinator = new MachineSessionCoordinator(database, artifacts, new PortableOmpRuntime(sessionFile), 'machine-a', join(root, 'runtime'), new FactEventStore(database));
    const created = await coordinator.create('workspace-a');
    expect(created.status).toBe('ok');
    if (created.status === 'error') throw created.error;
    expect((await coordinator.prompt(created.value.id, 'before-close')).status).toBe('ok');
    expect(await coordinator.transcript(created.value.id)).toHaveLength(1);

    const authority = new Authority();
    const lifecycle = new PortableSpaceLifecycle(
      authority,
      new EncryptedCheckpointBlobStore(new FileCheckpointBlobStore(join(root, 'bucket')), new Uint8Array(32).fill(4)),
      new BareRemote(remote),
    );
    const binding: WalgitProjectBinding = { projectId: 'project-a', bucket: 'user-bucket', endpoint: 'https://example.invalid', region: 'auto' };
    const spaces = new MachinePortableSpaceController(database, coordinator, lifecycle, 'machine-a', () => binding, async () => null, root, () => ['portable.txt']);
    await spaces.close(database.getSpace('workspace-a')!, 1);
    expect(authority.state).toBe('closed');
    expect(database.getSpace('workspace-a')).toMatchObject({ placementState: 'closed', holderId: 'unassigned', generation: 2 });
    expect(existsSync(workspaceRoot)).toBe(false);
    expect(existsSync(sessionFile)).toBe(false);
    expect(coordinator.get(created.value.id)?.state).toBe('closed');

    const destinationCoordinator = new MachineSessionCoordinator(
      database,
      artifacts,
      new PortableOmpRuntime(sessionFile),
      'machine-b',
      join(root, 'destination-runtime'),
      new FactEventStore(database),
    );
    const destinationSpaces = new MachinePortableSpaceController(database, destinationCoordinator, lifecycle, 'machine-b', () => binding, async () => null, root, () => ['portable.txt']);
    await destinationSpaces.open('workspace-a', 2);
    expect(database.getSpace('workspace-a')).toMatchObject({ placementState: 'open', holderId: 'machine-b', generation: 3 });
    expect(readFileSync(join(workspaceRoot, 'tracked.txt'), 'utf8')).toBe('changed\n');
    expect(readFileSync(join(workspaceRoot, 'portable.txt'), 'utf8')).toBe('portable\n');
    expect(readFileSync(join(workspaceRoot, 'staged.txt'), 'utf8')).toBe('staged\n');
    expect(git(workspaceRoot, 'diff', '--cached', '--name-only')).toBe('staged.txt');
    expect(existsSync(join(workspaceRoot, 'secret.env'))).toBe(false);
    expect(authority.state).toBe('open');
    const restored = destinationCoordinator.get(created.value.id)!;
    expect(restored).toMatchObject({ id: created.value.id, ompSessionId: 'omp-portable', state: 'active' });
    expect(await destinationCoordinator.transcript(restored.id)).toHaveLength(1);
    expect((await destinationCoordinator.prompt(restored.id, 'after-open')).status).toBe('ok');
    expect(await destinationCoordinator.transcript(restored.id)).toHaveLength(2);
    const listed = artifacts.list({ kind: 'workspace', projectId: 'project-a', workspaceId: 'workspace-a' }, 'local://workspace/');
    expect(listed.status).toBe('ok');
    if (listed.status === 'error') throw listed.error;
    expect(listed.value.map((entry) => entry.path)).toContain('agent.txt');
    const stopped = await destinationCoordinator.stopForRestart();
    if (stopped.status === 'error') throw stopped.error;
    database.close();
  });
  it('keeps released files until explicit reopen restores a fresh checkout and retains local leftovers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-coordinator-release-'));
    roots.push(root);
    const workspaceRoot = join(root, 'managed-spaces', 'workspace');
    const remote = join(root, 'remote.git');
    const sessionFile = join(root, 'sessions', 'omp-portable.jsonl');
    mkdirSync(workspaceRoot, { recursive: true });
    git(workspaceRoot, 'init', '-b', 'main');
    writeFileSync(join(workspaceRoot, '.gitignore'), 'secret.env\n');
    writeFileSync(join(workspaceRoot, 'tracked.txt'), 'base\n');
    git(workspaceRoot, 'add', '.');
    git(workspaceRoot, 'commit', '-m', 'base');
    writeFileSync(join(workspaceRoot, 'tracked.txt'), 'changed\n');
    writeFileSync(join(workspaceRoot, 'secret.env'), 'stays-local\n');
    git(root, 'init', '--bare', remote);

    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    expect(database.createProject({ id: 'project-a', name: 'Project', repositoryPath: join(root, 'base') }).status).toBe('ok');
    expect(database.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'Workspace', branch: 'main', rootPath: workspaceRoot }).status).toBe('ok');
    expect(database.possessWorkspace('workspace-a', 'machine-a').status).toBe('ok');
    const artifacts = new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'artifact-cache'), new Uint8Array(32).fill(3));
    const coordinator = new MachineSessionCoordinator(database, artifacts, new PortableOmpRuntime(sessionFile), 'machine-a', join(root, 'runtime'), new FactEventStore(database), join(root, 'managed-spaces'));
    const created = await coordinator.create('workspace-a');
    if (created.status === 'error') throw created.error;
    expect((await coordinator.prompt(created.value.id, 'before-release')).status).toBe('ok');

    const authority = new Authority();
    const blobs = new EncryptedCheckpointBlobStore(new FileCheckpointBlobStore(join(root, 'bucket')), new Uint8Array(32).fill(4));
    const lifecycle = new PortableSpaceLifecycle(authority, blobs, new BareRemote(remote));
    const binding: WalgitProjectBinding = { projectId: 'project-a', bucket: 'user-bucket', endpoint: 'https://example.invalid', region: 'auto' };
    const spaces = new MachinePortableSpaceController(database, coordinator, lifecycle, 'machine-a', () => binding, async () => null, root);
    await spaces.release(database.getSpace('workspace-a')!, 1);
    expect(authority.state).toBe('closed');
    expect(database.getSpace('workspace-a')).toMatchObject({ placementState: 'closed', holderId: 'unassigned', generation: 2, closedAt: null });
    expect(readFileSync(join(workspaceRoot, 'tracked.txt'), 'utf8')).toBe('changed\n');
    expect(readFileSync(join(workspaceRoot, 'secret.env'), 'utf8')).toBe('stays-local\n');
    expect(existsSync(sessionFile)).toBe(true);
    expect(coordinator.get(created.value.id)?.state).toBe('closed');

    // The cloud checkpoint is readable without opening the space anywhere.
    const reader = new ClosedSpaceTranscriptReader({
      getSpace: async () => ({
        projectId: 'project-a',
        spaceId: 'workspace-a',
        state: authority.state,
        machineId: null,
        generation: authority.generation,
        checkpointRevision: authority.revision,
        manifestKey: authority.manifestKey ?? null,
        manifestHash: authority.manifestHash ?? null,
        errorMessage: null,
        updatedAt: new Date().toISOString(),
      }),
      getCanonicalSession: async () => ({
        id: created.value.id,
        projectId: 'project-a',
        workspaceId: 'workspace-a',
        ompSessionId: 'omp-portable',
        machineId: 'machine-a',
        state: 'closed',
        sessionObjectKey: null,
        sessionObjectHash: null,
        sessionFormatVersion: null,
        activity: { active: false, reasons: [] },
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    }, blobs, (bytes) => projectOmpCheckpointTranscript(bytes, ompEntrypoint));
    const projected = await reader.read('project-a', 'workspace-a');
    expect(projected).toMatchObject({ sessionId: created.value.id, generation: 2, lastMachineId: 'machine-a' });
    expect(projected?.events).toHaveLength(1);
    expect(projected?.events[0]).toMatchObject({ kind: 'message_end', payload: { message: { role: 'assistant' } } });

    // Reclaim restores a fresh checkout; ignored leftovers remain available only in the retained directory.
    await spaces.open('workspace-a', 2);
    expect(database.getSpace('workspace-a')).toMatchObject({ placementState: 'open', holderId: 'machine-a', generation: 3 });
    expect(authority.state).toBe('open');
    expect(readFileSync(join(workspaceRoot, 'tracked.txt'), 'utf8')).toBe('changed\n');
    expect(existsSync(join(workspaceRoot, 'secret.env'))).toBe(false);
    const retained = readdirSync(dirname(workspaceRoot)).find((entry) => entry.startsWith('workspace.retained-'));
    expect(retained).toBeDefined();
    expect(readFileSync(join(dirname(workspaceRoot), retained!, 'secret.env'), 'utf8')).toBe('stays-local\n');
    const reclaimed = coordinator.get(created.value.id)!;
    expect(reclaimed).toMatchObject({ id: created.value.id, state: 'active' });
    expect(await coordinator.transcript(reclaimed.id)).toHaveLength(1);
    expect((await coordinator.prompt(reclaimed.id, 'after-reclaim')).status).toBe('ok');
    expect(await coordinator.transcript(reclaimed.id)).toHaveLength(2);
    const stopped = await coordinator.stopForRestart();
    if (stopped.status === 'error') throw stopped.error;
    database.close();
  });
  it.skipIf(process.env.GITSPACE_LIVE_PORTABLE_TEST !== '1')('closes and reopens through Miniflare R2 and walgit on RustFS', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-live-portable-'));
    roots.push(root);
    const workspaceRoot = join(root, 'workspace');
    const sessionFile = join(root, 'sessions', 'omp-portable.jsonl');
    mkdirSync(workspaceRoot);
    git(workspaceRoot, 'init', '-b', 'main');
    writeFileSync(join(workspaceRoot, '.gitignore'), 'secret.env\n');
    writeFileSync(join(workspaceRoot, 'tracked.txt'), 'base\n');
    git(workspaceRoot, 'add', '.');
    git(workspaceRoot, 'commit', '-m', 'base');
    writeFileSync(join(workspaceRoot, 'staged.txt'), 'staged\n');
    git(workspaceRoot, 'add', 'staged.txt');
    writeFileSync(join(workspaceRoot, 'tracked.txt'), 'changed\n');
    writeFileSync(join(workspaceRoot, 'portable.txt'), 'portable\n');
    writeFileSync(join(workspaceRoot, 'secret.env'), 'do-not-move\n');

    const projectId = `project-${crypto.randomUUID().slice(0, 8)}`;
    const spaceId = `space-${crypto.randomUUID().slice(0, 8)}`;
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    expect(database.createProject({ id: projectId, name: `Project ${projectId}`, repositoryPath: join(root, 'base') }).status).toBe('ok');
    expect(database.createWorkspace({ id: spaceId, projectId, name: 'Workspace', branch: 'main', rootPath: workspaceRoot }).status).toBe('ok');
    expect(database.possessWorkspace(spaceId, 'local-machine').status).toBe('ok');
    const artifacts = new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'artifact-cache'), new Uint8Array(32).fill(3));
    const coordinator = new MachineSessionCoordinator(database, artifacts, new PortableOmpRuntime(sessionFile), 'local-machine', join(root, 'runtime'), new FactEventStore(database));
    const created = await coordinator.create(spaceId);
    if (created.status === 'error') throw created.error;
    expect((await coordinator.prompt(created.value.id, 'before-close')).status).toBe('ok');

    const controlOptions = {
      baseUrl: process.env.GITSPACE_CONTROL_URL!,
      userId: 'local-user',
      machineId: 'local-machine',
      signingPrivateKey: new Uint8Array(Buffer.from(process.env.GITSPACE_MACHINE_SIGNING_PRIVATE_KEY!, 'base64')),
    };
    const authority = new CloudSpaceCheckpointAuthority(controlOptions);
    await authority.bootstrap({ projectId, spaceId });
    const binding: WalgitProjectBinding = {
      projectId,
      bucket: process.env.GITSPACE_GIT_BUCKET!,
      endpoint: process.env.GITSPACE_GIT_ENDPOINT!,
      region: 'us-east-1',
    };
    const walgit = new WalgitSupervisor({
      binaryPath: process.env.GITSPACE_WALGIT_BINARY!,
      runtimeRoot: join(root, 'walgit-runtime'),
      credentials: async () => ({
        accessKeyId: process.env.GITSPACE_GIT_ACCESS_KEY_ID!,
        secretAccessKey: process.env.GITSPACE_GIT_SECRET_ACCESS_KEY!,
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      }),
      port: () => 4_601,
    });
    const lifecycle = new PortableSpaceLifecycle(
      authority,
      new EncryptedCheckpointBlobStore(new CloudDataCheckpointBlobStore(controlOptions), new Uint8Array(32).fill(4)),
      walgit,
    );
    const spaces = new MachinePortableSpaceController(database, coordinator, lifecycle, 'local-machine', () => binding, async () => null, root);
    await spaces.close(database.getSpace(spaceId)!, 1);
    expect(database.getSpace(spaceId)).toMatchObject({ placementState: 'closed', holderId: 'unassigned', generation: 2 });
    expect(existsSync(workspaceRoot)).toBe(false);
    expect(existsSync(sessionFile)).toBe(false);

    await spaces.open(spaceId, 2);
    expect(database.getSpace(spaceId)).toMatchObject({ placementState: 'open', holderId: 'local-machine', generation: 3 });
    expect(readFileSync(join(workspaceRoot, 'tracked.txt'), 'utf8')).toBe('changed\n');
    expect(readFileSync(join(workspaceRoot, 'portable.txt'), 'utf8')).toBe('portable\n');
    expect(git(workspaceRoot, 'diff', '--cached', '--name-only')).toBe('staged.txt');
    expect(existsSync(join(workspaceRoot, 'secret.env'))).toBe(false);
    expect(await coordinator.transcript(created.value.id)).toHaveLength(1);
    const restoredArtifacts = artifacts.list({ kind: 'workspace', projectId, workspaceId: spaceId }, 'local://workspace/');
    expect(restoredArtifacts.status).toBe('ok');
    if (restoredArtifacts.status === 'error') throw restoredArtifacts.error;
    expect(restoredArtifacts.value.map((entry) => entry.path)).toContain('agent.txt');
    expect((await coordinator.prompt(created.value.id, 'after-open')).status).toBe('ok');
    expect(await coordinator.transcript(created.value.id)).toHaveLength(2);
    await walgit.dispose();
    database.close();
  });
});
