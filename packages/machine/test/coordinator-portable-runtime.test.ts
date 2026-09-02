import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FactEventStore,
  GitSpaceDatabase,
  LocalArtifactResolver,
  MemoryArtifactObjectStore,
  releasedSpaces,
} from '@gitspace/core';
import {
  CloudDataCheckpointBlobStore,
  CloudSpaceCheckpointAuthority,
  ClosedSpaceTranscriptReader,
  EncryptedCheckpointBlobStore,
  FileCheckpointBlobStore,
  MachinePortableSpaceController,
  MachineSessionCoordinator,
  WalgitSupervisor,
  PortableSpaceLifecycle,
  type OmpRuntime,
  type OmpRuntimeEvent,
  type OmpRuntimeSession,
  type SpaceCheckpointAuthority,
  type SpaceGitCheckpointRemote,
  type WalgitProjectBinding,
} from '../src/index.js';

const roots: string[] = [];
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
  constructor(private readonly sessionFile: string) {}
  async create(input: { workingDirectory: string; sessionKey: string; artifactsDir: string }): Promise<OmpRuntimeSession> {
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    writeFileSync(this.sessionFile, `${JSON.stringify({ type: 'session', version: 3, id: 'omp-portable', timestamp: new Date().toISOString(), cwd: input.workingDirectory })}\n`);
    return this.session(input.artifactsDir);
  }
  async open(input: { workingDirectory: string; sessionKey: string; artifactsDir: string; sessionFile: string }): Promise<OmpRuntimeSession> {
    expect(input.sessionFile).toBe(this.sessionFile);
    expect(readFileSync(input.sessionFile, 'utf8')).toContain('omp-portable');
    return this.session(input.artifactsDir);
  }
  private session(artifactsDir: string): OmpRuntimeSession {
    const handlers = new Set<(event: OmpRuntimeEvent) => void>();
    return {
      id: 'omp-portable',
      sessionFile: this.sessionFile,
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
      resume: async () => undefined,
      dispose: async () => undefined,
      messages: () => readFileSync(this.sessionFile, 'utf8').split('\n').filter(Boolean)
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
    database.close();
  });
  it('releases a space with local files kept, projects its checkpoint read-only, and reclaims it on the same machine', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-coordinator-release-'));
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
    writeFileSync(join(workspaceRoot, 'tracked.txt'), 'changed\n');
    writeFileSync(join(workspaceRoot, 'secret.env'), 'stays-local\n');
    git(root, 'init', '--bare', remote);

    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    expect(database.createProject({ id: 'project-a', name: 'Project', repositoryPath: join(root, 'base') }).status).toBe('ok');
    expect(database.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'Workspace', branch: 'main', rootPath: workspaceRoot }).status).toBe('ok');
    expect(database.possessWorkspace('workspace-a', 'machine-a').status).toBe('ok');
    const artifacts = new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'artifact-cache'), new Uint8Array(32).fill(3));
    const coordinator = new MachineSessionCoordinator(database, artifacts, new PortableOmpRuntime(sessionFile), 'machine-a', join(root, 'runtime'), new FactEventStore(database));
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
    expect(database.orm.select().from(releasedSpaces).all()).toEqual([expect.objectContaining({ spaceId: 'workspace-a', generation: 2 })]);
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
    }, blobs);
    const projected = await reader.read('project-a', 'workspace-a');
    expect(projected).toMatchObject({ sessionId: created.value.id, generation: 2, lastMachineId: 'machine-a' });
    expect(projected?.events).toHaveLength(1);
    expect(projected?.events[0]).toMatchObject({ kind: 'message_end', payload: { message: { role: 'assistant' } } });

    // Reclaim: the same machine reopens over its kept files; ignored files survive.
    await spaces.open('workspace-a', 2);
    expect(database.getSpace('workspace-a')).toMatchObject({ placementState: 'open', holderId: 'machine-a', generation: 3 });
    expect(authority.state).toBe('open');
    expect(readFileSync(join(workspaceRoot, 'tracked.txt'), 'utf8')).toBe('changed\n');
    expect(readFileSync(join(workspaceRoot, 'secret.env'), 'utf8')).toBe('stays-local\n');
    const reclaimed = coordinator.get(created.value.id)!;
    expect(reclaimed).toMatchObject({ id: created.value.id, state: 'active' });
    expect(await coordinator.transcript(reclaimed.id)).toHaveLength(1);
    expect((await coordinator.prompt(reclaimed.id, 'after-reclaim')).status).toBe('ok');
    expect(await coordinator.transcript(reclaimed.id)).toHaveLength(2);
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
    expect(coordinator.transcript(created.value.id)).toHaveLength(1);
    const restoredArtifacts = artifacts.list({ kind: 'workspace', projectId, workspaceId: spaceId }, 'local://workspace/');
    expect(restoredArtifacts.status).toBe('ok');
    if (restoredArtifacts.status === 'error') throw restoredArtifacts.error;
    expect(restoredArtifacts.value.map((entry) => entry.path)).toContain('agent.txt');
    expect((await coordinator.prompt(created.value.id, 'after-open')).status).toBe('ok');
    expect(coordinator.transcript(created.value.id)).toHaveLength(2);
    await walgit.dispose();
    database.close();
  });
});
