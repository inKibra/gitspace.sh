import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { serializeTitleSlot } from '@oh-my-pi/pi-coding-agent/session/session-title-slot';
import { sourceWalgit } from '../../deployment/src/native-build.js';
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
  disposeCalls = 0;
  openError: Error | null = null;
  messagesError: Error | null = null;
  private active = false;
  constructor(private sessionFile: string) {}
  async create(input: { workingDirectory: string; sessionKey: string; artifactsDir: string; workspaceId: string | null }): Promise<OmpRuntimeSession> {
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    writeFileSync(this.sessionFile, `${JSON.stringify({ type: 'session', version: 3, id: 'omp-portable', timestamp: new Date().toISOString(), cwd: input.workingDirectory })}\n`);
    return this.session(input.artifactsDir, input.workspaceId === null ? 'base' : 'workspace');
  }
  async open(input: { workingDirectory: string; sessionKey: string; artifactsDir: string; sessionFile: string; workspaceId: string | null }): Promise<OmpRuntimeSession> {
    if (this.openError) throw this.openError;
    expect(readFileSync(input.sessionFile, 'utf8')).toContain('omp-portable');
    this.sessionFile = input.sessionFile;
    return this.session(input.artifactsDir, input.workspaceId === null ? 'base' : 'workspace');
  }
  transcript(sessionFile: string) { return projectOmpTranscript(sessionFile, ompEntrypoint); }
  checkpointTranscript(bytes: Uint8Array) { return projectOmpCheckpointTranscript(bytes, ompEntrypoint); }
  private session(artifactsDir: string, scope: 'base' | 'workspace'): OmpRuntimeSession {
    if (this.active) throw new Error('Portable agent already has a live worker');
    this.active = true;
    let disposed = false;
    const handlers = new Set<(event: OmpRuntimeEvent) => void>();
    return {
      id: 'omp-portable',
      sessionFile: this.sessionFile,
      isAvailable: () => !disposed,
      control: async () => ({
        sessionId: 'omp-portable', role: null, roleLabel: null, roles: [], provider: null, models: [],
        model: null, thinking: null, fastMode: false, planMode: false, approvalMode: 'always-ask', context: null,
        cost: 0, todos: [], queue: { steering: [], followUp: [] }, historyAnchorId: null, history: [], goal: null, pendingAsk: null,
      }),
      agentSetup: async () => { throw new Error('Agent setup is not configured in this fixture'); },
      saveAgentDefinition: async () => { throw new Error('Agent setup is not configured in this fixture'); },
      historyAnchorId: async () => null,
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
        mkdirSync(join(artifactsDir, scope), { recursive: true });
        writeFileSync(join(artifactsDir, scope, 'agent.txt'), text);
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
      subscribeActivity: (handler) => { handler({ active: false, reasons: [] }, null); return () => undefined; },
      activity: () => ({ activity: { active: false, reasons: [] }, failure: null }),
      persist: async () => undefined,
      setWorkspacePhase: async () => undefined,
      handoff: async () => false,
      resume: async () => { this.resumeCalls += 1; },
      dispose: async () => { disposed = true; this.active = false; this.disposeCalls += 1; },
      messages: async () => {
        if (this.messagesError) throw this.messagesError;
        return readFileSync(this.sessionFile, 'utf8').split('\n').filter(Boolean)
          .map((line) => JSON.parse(line) as { type: string; message?: unknown })
          .filter((entry) => entry.type === 'message')
          .map((entry) => entry.message);
      },
    };
  }
}

class Authority implements SpaceCheckpointAuthority {
  state: 'open' | 'closing' | 'closed' | 'opening' = 'open';
  generation = 1;
  revision = 0;
  manifestKey?: string;
  manifestHash?: `sha256:${string}`;
  readonly closingEntered = Promise.withResolvers<void>();
  async beginClose(input: { expectedGeneration: number }) {
    expect(input.expectedGeneration).toBe(this.generation);
    this.state = 'closing';
    this.closingEntered.resolve();
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

async function cloudDefinition(spaceId: string, projectId = 'project-a') {
  return {
    projectId, projectName: 'Project', repositoryReference: null, baseBranch: 'main',
    spaceId, kind: spaceId === projectId ? 'base' as const : 'worktree' as const,
    name: spaceId, branch: 'main', phase: spaceId === projectId ? null : 'code' as const,
  };
}

async function failedBaseFixture(configureRepository?: (repositoryPath: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-failed-base-'));
  roots.push(root);
  const repository = join(root, 'project-a', 'project-a');
  const remote = join(root, 'remote.git');
  const sessionFile = join(root, 'omp.jsonl');
  mkdirSync(repository, { recursive: true });
  git(repository, 'init', '-b', 'main');
  writeFileSync(join(repository, 'tracked.txt'), 'retained repository work\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'base');
  git(root, 'init', '--bare', remote);
  const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
  database.createProject({ id: 'project-a', name: 'Base', repositoryPath: repository });
  database.possessSpace('project-a', 'machine-a');
  const store = new MemoryArtifactObjectStore();
  const artifacts = new LocalArtifactResolver(database, store, join(root, 'cache'), new Uint8Array(32).fill(3));
  const initial = new MachineSessionCoordinator(database, artifacts, new PortableOmpRuntime(sessionFile), 'machine-a', join(root, 'runtime'));
  const opened = await initial.openSpace('project-a');
  if (opened.status === 'error') throw opened.error;
  const session = opened.value;
  const mount = join(root, 'runtime', 'sessions', session.id, 'artifacts', 'base');
  await initial.prompt(session.id, 'history before worker failure');
  writeFileSync(join(mount, 'stable.txt'), 'durable artifact');
  const stopped = await initial.stopForRestart();
  if (stopped.status === 'error') throw stopped.error;
  writeFileSync(sessionFile, serializeTitleSlot({ title: 'Retained base', updatedAt: new Date().toISOString() }) + readFileSync(sessionFile, 'utf8'));
  writeFileSync(join(mount, 'unsynced.txt'), 'last local artifact');
  const runtime = new PortableOmpRuntime(sessionFile);
  runtime.openError = new Error('Provider credentials unavailable during worker recovery');
  const sessions = new MachineSessionCoordinator(database, artifacts, runtime, 'machine-a', join(root, 'runtime'));
  const recovered = await sessions.recover('project-a');
  if (recovered.status !== 'error') throw new Error('Fixture must retain a failed inactive session');
  const authority = new Authority();
  const lifecycle = new PortableSpaceLifecycle(authority,
    new EncryptedCheckpointBlobStore(new FileCheckpointBlobStore(join(root, 'blobs')), new Uint8Array(32).fill(4)),
    new BareRemote(remote));
  const binding: WalgitProjectBinding = { projectId: 'project-a', bucket: 'bucket', endpoint: 'https://example.invalid', region: 'auto' };
  const controller = new MachinePortableSpaceController(database, sessions, lifecycle, 'machine-a', () => binding, cloudDefinition, root, undefined, undefined, configureRepository);
  return { root, repository, sessionFile, mount, database, store, artifacts, session, runtime, sessions, authority, lifecycle, binding, controller };
}

describe('CoordinatorPortableSpaceRuntime', () => {
  it('disposes without publication and retries committed cleanup after the rows disappear', async () => {
    const { root, database, artifacts, sessionFile, session, runtime } = await failedBaseFixture();
    let publications = 0;
    runtime.openError = null;
    const sessions = new MachineSessionCoordinator(database, artifacts, runtime, 'machine-a', join(root, 'runtime'), undefined, root, {
      get: async () => null,
      put: () => { publications += 1; },
    });
    try {
      const opened = await sessions.openSpace('project-a');
      if (opened.status === 'error') throw opened.error;
      await sessions.quiesceSpace('project-a');
      const childRoot = sessionFile.replace(/\.jsonl$/u, '');
      mkdirSync(childRoot, { recursive: true });
      writeFileSync(join(childRoot, 'child.jsonl'), 'child transcript');
      await sessions.preparePortableSpaceCleanup('project-a');
      const before = publications;
      database.commitSpaceCleanup('project-a');
      expect(database.getSpace('project-a')).toBeNull();
      expect(sessions.get(session.id)).toBeNull();
      await sessions.deletePortableSpaceLocal('project-a');
      expect(runtime.disposeCalls).toBe(1);
      expect(publications).toBe(before);
      expect(existsSync(sessionFile)).toBe(false);
      expect(existsSync(childRoot)).toBe(false);
      expect(existsSync(join(root, 'runtime', 'sessions', session.id))).toBe(false);
      expect(existsSync(join(root, 'project-a', 'project-a'))).toBe(false);
      const restarted = new MachineSessionCoordinator(database, artifacts, runtime, 'machine-a', join(root, 'runtime'));
      await restarted.deletePortableSpaceLocal('project-a');
      expect(database.listSpaceCleanupJobs()[0]?.state).toBe('committed');
    } finally { database.close(); }
  });

  it('detaches a sibling worktree before committing base cleanup', async () => {
    const { root, repository, database, sessions } = await failedBaseFixture();
    try {
      const sibling = join(root, 'sibling');
      const siblingCapability = { kind: 'workspace' as const, projectId: 'project-a', workspaceId: 'sibling' };
      git(repository, 'worktree', 'add', '-b', 'sibling', sibling);
      database.createWorkspace({ id: 'sibling', projectId: 'project-a', name: 'Sibling', branch: 'sibling', rootPath: sibling });
      const artifacts = new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'cache'), new Uint8Array(32).fill(3));
      writeFileSync(join(sibling, 'tracked.txt'), 'sibling dirty work\n');
      const written = await artifacts.write(siblingCapability, 'local://workspace/keep.txt', new TextEncoder().encode('sibling artifact'));
      if (written.status === 'error') throw written.error;
      const committed = await artifacts.commit(siblingCapability, 'local://workspace/');
      if (committed.status === 'error') throw committed.error;
      await sessions.preparePortableSpaceCleanup('project-a');
      expect(readFileSync(join(repository, 'tracked.txt'), 'utf8')).toBe('retained repository work\n');
      await sessions.deletePortableSpaceLocal('project-a');
      expect(readFileSync(join(sibling, 'tracked.txt'), 'utf8')).toBe('sibling dirty work\n');
      expect(git(sibling, 'show', 'HEAD:tracked.txt')).toBe('retained repository work');
      expect(git(sibling, 'status', '--porcelain')).toBe('M tracked.txt');
      const kept = await artifacts.read(siblingCapability, 'local://workspace/keep.txt');
      if (kept.status === 'error') throw kept.error;
      expect(new TextDecoder().decode(kept.value)).toBe('sibling artifact');
    } finally { database.close(); }
  });

  it('refuses an unproven restore checkout instead of moving it into retention', async () => {
    const { root, repository, database, sessions } = await failedBaseFixture();
    try {
      await expect(sessions.preparePortableSpaceRepository('project-a')).rejects.toThrow('unproven local data');
      expect(readFileSync(join(repository, 'tracked.txt'), 'utf8')).toBe('retained repository work\n');
      expect(readdirSync(dirname(repository)).some((name) => name.startsWith('project-a.retained-'))).toBe(false);
    } finally { database.close(); }
  });

  it('persists an interrupted cleanup and retries it after reopening the database without local rows', async () => {
    const { root, database, sessions, artifacts } = await failedBaseFixture();
    await sessions.preparePortableSpaceCleanup('project-a');
    artifacts.pruneUnreferencedCachedBytes = async () => { throw new Error('cache removal interrupted'); };
    await expect(sessions.deletePortableSpaceLocal('project-a')).rejects.toThrow('cache removal interrupted');
    expect(database.listSpaceCleanupJobs()[0]).toMatchObject({ state: 'committed', error: 'cache removal interrupted' });
    database.close();
    const reopened = new GitSpaceDatabase(join(root, 'gitspace.db'));
    try {
      expect(reopened.getSpace('project-a')).toBeNull();
      const resolver = new LocalArtifactResolver(reopened, new MemoryArtifactObjectStore(), join(root, 'cache'), new Uint8Array(32).fill(3));
      const restarted = new MachineSessionCoordinator(reopened, resolver, new PortableOmpRuntime(join(root, 'unused.jsonl')), 'machine-a', join(root, 'runtime'));
      await restarted.deletePortableSpaceLocal('project-a');
      expect(existsSync(join(root, 'project-a', 'project-a'))).toBe(false);
      expect(existsSync(join(root, 'omp.jsonl'))).toBe(false);
      // Resource cleanup remains the controller's responsibility.
      expect(reopened.listSpaceCleanupJobs()[0]?.state).toBe('committed');
    } finally { reopened.close(); }
  });

  it('does not report cleanup complete while the cloud commit outcome remains unresolved', async () => {
    const { database, repository, sessionFile, sessions, controller } = await failedBaseFixture();
    try {
      await sessions.preparePortableSpaceCleanup('project-a');
      await expect(controller.retryCleanup('project-a')).rejects.toThrow('checkpoint outcome is unresolved');
      expect(existsSync(repository)).toBe(true);
      expect(existsSync(sessionFile)).toBe(true);
      expect(database.listSpaceCleanupJobs()[0]?.state).toBe('prepared');
      database.commitSpaceCleanup('project-a');
      await controller.retryCleanup('project-a');
      expect(database.getSpace('project-a')).toBeNull();
      expect(existsSync(repository)).toBe(false);
      expect(existsSync(sessionFile)).toBe(false);
      expect(database.listSpaceCleanupJobs()).toEqual([]);
    } finally { database.close(); }
  });
  it('retries a failed inactive base without changing identity, retained history or unsynced files', async () => {
    const { database, sessionFile, mount, session, runtime, sessions } = await failedBaseFixture();
    try {
      const saved = readFileSync(sessionFile, 'utf8');
      expect(sessions.controlsAvailable(session.id)).toBe(false);
      expect(sessions.get(session.id)?.health.issues.recovery?.failure).toMatchObject({ code: 'AGENT_RECOVERY_FAILED', context: { operation: 'recover' } });
      expect((await sessions.openSpace('project-a', false, 2)).status).toBe('error');
      runtime.openError = null;
      runtime.messagesError = new Error('Transcript transport disconnected');
      const results = await Promise.all([sessions.openSpace('project-a', false, 1), sessions.openSpace('project-a', false, 1)]);
      for (const result of results) {
        if (result.status === 'error') throw result.error;
        expect(result.value).toMatchObject({ id: session.id, ompSessionId: session.ompSessionId, sessionFile, state: 'active', health: { issues: { recovery: { failure: null } } } });
      }
      expect(sessions.controlsAvailable(session.id)).toBe(true);
      expect(readFileSync(sessionFile, 'utf8')).toBe(saved);
      expect(readFileSync(join(mount, 'unsynced.txt'), 'utf8')).toBe('last local artifact');
      expect(JSON.stringify(await sessions.transcript(session.id))).toContain('history before worker failure');
      expect((await sessions.prompt(session.id, 'after retry')).status).toBe('ok');
      expect(JSON.stringify(await sessions.transcript(session.id))).toContain('after retry');
      await sessions.stopForRestart();
    } finally { database.close(); }
  });

  it('checkpoints a failed inactive base and unsynced artifacts without opening a worker, then restores the same history', async () => {
    const { database, repository, sessionFile, mount, session, runtime, sessions, artifacts, authority, controller } = await failedBaseFixture();
    try {
      writeFileSync(join(mount, 'agent.txt'), 'unsynced edit to an existing artifact');
      await Promise.all([controller.close(database.getSpace('project-a')!, 1), controller.close(database.getSpace('project-a')!, 1)]);
      expect(authority.state).toBe('closed');
      expect(authority.revision).toBe(1);
      expect(database.getSpace('project-a')).toBeNull();
      expect(existsSync(repository)).toBe(false);
      expect(existsSync(sessionFile)).toBe(false);
      expect(sessions.controlsAvailable(session.id)).toBe(false);
      expect(sessions.get(session.id)).toBeNull();
      runtime.openError = null;
      await controller.open('project-a', 2);
      expect(sessions.get(session.id)).toMatchObject({ id: session.id, ompSessionId: session.ompSessionId, state: 'active' });
      expect(JSON.stringify(await sessions.transcript(session.id))).toContain('history before worker failure');
      for (const [name, content] of [['agent.txt', 'unsynced edit to an existing artifact'], ['unsynced.txt', 'last local artifact']]) {
        const restored = await artifacts.read({ kind: 'project', projectId: 'project-a' }, `local://base/${name}`);
        if (restored.status === 'error') throw restored.error;
        expect(new TextDecoder().decode(restored.value)).toBe(content);
      }
      await sessions.stopForRestart();
    } finally { database.close(); }
  });

  it('restores the configured author before a recreated checkout is available for commits', async () => {
    const { database, repository, runtime, sessions, controller } = await failedBaseFixture(async (path) => {
      git(path, 'config', 'user.name', 'Configured Author');
      git(path, 'config', 'user.email', 'author@example.com');
    });
    try {
      await controller.close(database.getSpace('project-a')!, 1);
      runtime.openError = null;
      await controller.open('project-a', 2);
      const env = { ...Bun.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
      for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_COUNT']) delete env[key];
      const committed = Bun.spawnSync(['git', '-c', 'user.useConfigOnly=true', 'commit', '--allow-empty', '-m', 'Commit after restore'], {
        cwd: repository,
        env,
      });
      expect(committed.exitCode).toBe(0);
      expect(git(repository, 'log', '-1', '--format=%an <%ae>')).toBe('Configured Author <author@example.com>');
    } finally {
      await sessions.stopForRestart();
      database.close();
    }
  });

  it('does not expose a restored workspace when repository configuration fails', async () => {
    const { database, repository, session, runtime, sessions, authority, controller } = await failedBaseFixture(async () => {
      throw new Error('Saved Git identity is unavailable');
    });
    try {
      await controller.close(database.getSpace('project-a')!, 1);
      runtime.openError = null;
      await expect(controller.open('project-a', 2)).rejects.toThrow('Saved Git identity is unavailable');
      expect(authority.state).toBe('closed');
      expect(database.getSpace('project-a')?.placementState).toBe('closed');
      expect(sessions.controlsAvailable(session.id)).toBe(false);
    } finally {
      await sessions.stopForRestart();
      database.close();
    }
  });

  for (const damage of ['missing session', 'corrupt session', 'missing scope', 'corrupt artifact', 'missing mount'] as const) {
    it(`keeps retained data and the recovery reason when checkpointing encounters ${damage}`, async () => {
      const { database, repository, sessionFile, mount, session, store, artifacts, sessions, authority, controller } = await failedBaseFixture();
      try {
        if (damage === 'missing session') rmSync(sessionFile);
        if (damage === 'corrupt session') writeFileSync(sessionFile, `${readFileSync(sessionFile, 'utf8')}{malformed\n`);
        if (damage === 'missing scope') database.orm.delete(artifactScopes).where(eq(artifactScopes.spaceId, 'project-a')).run();
        if (damage === 'corrupt artifact') {
          const listed = artifacts.list({ kind: 'project', projectId: 'project-a' }, 'local://base/');
          if (listed.status === 'error') throw listed.error;
          store.objects.set(listed.value.find((entry) => entry.path === 'stable.txt')!.hash, new Uint8Array([1]));
        }
        if (damage === 'missing mount') renameSync(mount, `${mount}.retained`);
        const saved = existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8') : null;
        await expect(controller.close(database.getSpace('project-a')!, 1)).rejects.toThrow();
        expect(authority.state).toBe('open');
        expect(database.getSpace('project-a')).toMatchObject({ placementState: 'open', generation: 1 });
        expect(readFileSync(join(repository, 'tracked.txt'), 'utf8')).toBe('retained repository work\n');
        expect(existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8') : null).toBe(saved);
        expect(readFileSync(join(damage === 'missing mount' ? `${mount}.retained` : mount, 'unsynced.txt'), 'utf8')).toBe('last local artifact');
        expect(sessions.get(session.id)?.health.issues['workspace-close']?.failure).toMatchObject({ code: 'AGENT_RUNTIME_FAILED' });
        expect(sessions.get(session.id)?.health.issues.recovery?.failure).toMatchObject({ code: 'AGENT_RECOVERY_FAILED' });
        expect(sessions.controlsAvailable(session.id)).toBe(false);
      } finally { database.close(); }
    });
  }

  it('refuses to drop known queued work from an inactive agent checkpoint', async () => {
    const { database, repository, session, controller } = await failedBaseFixture();
    try {
      database.orm.update(agentSessions).set({ activity: { active: false, reasons: [{ kind: 'queued', steering: 0, followUp: 1 }] } })
        .where(eq(agentSessions.id, session.id)).run();
      await expect(controller.close(database.getSpace('project-a')!, 1)).rejects.toThrow();
      expect(database.getSpace('project-a')?.placementState).toBe('open');
      expect(existsSync(repository)).toBe(true);
      expect(database.orm.select().from(agentSessions).where(eq(agentSessions.id, session.id)).get()?.activity.reasons)
        .toEqual([{ kind: 'queued', steering: 0, followUp: 1 }]);
    } finally { database.close(); }
  });

  it('fences a concurrent retry before closing the retained checkpoint', async () => {
    const { root, database, artifacts, session, sessionFile, authority, lifecycle, binding } = await failedBaseFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class OpeningRuntime extends PortableOmpRuntime {
      override async open(input: { workingDirectory: string; sessionKey: string; artifactsDir: string; sessionFile: string; workspaceId: string | null }) {
        entered.resolve();
        await release.promise;
        return super.open(input);
      }
    }
    const sessions = new MachineSessionCoordinator(database, artifacts, new OpeningRuntime(sessionFile), 'machine-a', join(root, 'runtime'));
    const controller = new MachinePortableSpaceController(database, sessions, lifecycle, 'machine-a', () => binding, async () => null, root);
    try {
      const retry = sessions.openSpace('project-a', false, 1);
      await entered.promise;
      const closing = controller.close(database.getSpace('project-a')!, 1);
      await authority.closingEntered.promise;
      release.resolve();
      expect((await retry).status).toBe('error');
      await closing;
      expect(authority.state).toBe('closed');
      expect(sessions.controlsAvailable(session.id)).toBe(false);
      expect(database.getSpace('project-a')).toBeNull();
      expect(database.getSpacePlacement('project-a')).toBeNull();
    } finally { release.resolve(); database.close(); }
  });

  it('keeps both the original history and changed bytes when a retry returns the wrong agent identity', async () => {
    const { root, database, artifacts, session, sessionFile } = await failedBaseFixture();
    const saved = readFileSync(sessionFile, 'utf8');
    class WrongIdentityRuntime extends PortableOmpRuntime {
      override async open(input: { workingDirectory: string; sessionKey: string; artifactsDir: string; sessionFile: string; workspaceId: string | null }) {
        const worker = await super.open(input);
        writeFileSync(input.sessionFile, '{"type":"session","version":3,"id":"wrong-agent"}\n');
        return { ...worker, id: 'wrong-agent' };
      }
    }
    const sessions = new MachineSessionCoordinator(database, artifacts, new WrongIdentityRuntime(sessionFile), 'machine-a', join(root, 'runtime'));
    try {
      expect((await sessions.openSpace('project-a', false, 1)).status).toBe('error');
      expect(readFileSync(sessionFile, 'utf8')).toBe(saved);
      const retained = readdirSync(root).find((name) => name.startsWith('omp.jsonl.failed-open-'));
      expect(retained).toBeDefined();
      expect(readFileSync(join(root, retained!), 'utf8')).toContain('wrong-agent');
      expect(sessions.list('project-a').map((record) => record.id)).toEqual([session.id]);
      expect(sessions.controlsAvailable(session.id)).toBe(false);
      expect(sessions.get(session.id)?.health.issues.recovery?.failure).toMatchObject({ code: 'AGENT_RECOVERY_FAILED' });
    } finally { database.close(); }
  });

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
    let scope: typeof artifactScopes.$inferSelect | undefined;
    const commitClosed = authority.commitClosed.bind(authority);
    authority.commitClosed = async (input) => {
      scope = source.orm.select().from(artifactScopes).where(eq(artifactScopes.spaceId, 'workspace-a')).get();
      expect(existsSync(repository)).toBe(true);
      expect(existsSync(session.value.sessionFile)).toBe(true);
      await commitClosed(input);
    };
    await controller.release(source.getSpace('workspace-a')!, 1);
    expect(source.getSpace('workspace-a')).toBeNull();
    source.close();
    rmSync(machineRoot, { recursive: true, force: true });

    mkdirSync(machineRoot);
    const destination = new GitSpaceDatabase(join(machineRoot, 'gitspace.db'));
    const restoredArtifacts = new LocalArtifactResolver(destination, new CloudArtifactObjectStore('account-a', durableBlobs), join(machineRoot, 'cache'), artifactKey);
    const restoredRuntime = new PortableOmpRuntime(join(machineRoot, 'unused.jsonl'));
    const restoredSessions = new MachineSessionCoordinator(destination, restoredArtifacts, restoredRuntime, 'machine-a', join(machineRoot, 'runtime'));
    const restoredController = new MachinePortableSpaceController(destination, restoredSessions, lifecycle, 'machine-a', () => binding, cloudDefinition, machineRoot);
    await restoredController.open('workspace-a', 2);
    expect(destination.getSpace('workspace-a')).toMatchObject({ holderId: 'machine-a', placementState: 'open', generation: 3 });
    expect(authority.generation).toBe(3);
    expect(restoredSessions.get(session.value.id)).toMatchObject({ id: session.value.id, ompSessionId: session.value.ompSessionId, state: 'active' });
    expect(restoredRuntime.resumeCalls).toBe(1);
    expect(JSON.stringify(await restoredSessions.transcript(session.value.id))).toContain(content);
    expect(readFileSync(join(repository, 'tracked.txt'), 'utf8')).toBe('unstaged final work\n');
    expect(readFileSync(join(repository, 'untracked.txt'), 'utf8')).toBe(content);
    expect(git(repository, 'diff', '--cached', '--name-only')).toBe('staged.txt');
    expect(destination.orm.select().from(artifactScopes).all().find((entry) => entry.spaceId === 'workspace-a')).toMatchObject({ id: scope!.id, generation: scope!.generation, manifestHash: scope!.manifestHash });
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
    const workspaceRoot = join(root, 'project-a', 'workspace-a');
    const remote = join(root, 'remote.git');
    const sessionFile = join(root, 'sessions', 'omp-portable.jsonl');
    mkdirSync(workspaceRoot, { recursive: true });
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
    expect(database.getSpace('workspace-a')).toBeNull();
    expect(existsSync(workspaceRoot)).toBe(false);
    expect(existsSync(sessionFile)).toBe(false);
    expect(coordinator.get(created.value.id)).toBeNull();

    const destinationCoordinator = new MachineSessionCoordinator(
      database,
      artifacts,
      new PortableOmpRuntime(sessionFile),
      'machine-b',
      join(root, 'destination-runtime'),
      new FactEventStore(database),
    );
    const destinationSpaces = new MachinePortableSpaceController(database, destinationCoordinator, lifecycle, 'machine-b', () => binding, cloudDefinition, root, () => ['portable.txt']);
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
  it('removes released files and restores only the durable checkpoint on explicit reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-coordinator-release-'));
    roots.push(root);
    const workspaceRoot = join(root, 'managed-spaces', 'project-a', 'workspace-a');
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
    const coordinator = new MachineSessionCoordinator(database, artifacts, new PortableOmpRuntime(sessionFile), 'machine-a', join(root, 'runtime'), new FactEventStore(database), join(root, 'managed-spaces'), undefined, undefined, join(root, 'sessions'));
    const created = await coordinator.create('workspace-a');
    if (created.status === 'error') throw created.error;
    expect((await coordinator.prompt(created.value.id, 'before-release')).status).toBe('ok');

    const authority = new Authority();
    const blobs = new EncryptedCheckpointBlobStore(new FileCheckpointBlobStore(join(root, 'bucket')), new Uint8Array(32).fill(4));
    const lifecycle = new PortableSpaceLifecycle(authority, blobs, new BareRemote(remote));
    const binding: WalgitProjectBinding = { projectId: 'project-a', bucket: 'user-bucket', endpoint: 'https://example.invalid', region: 'auto' };
    const spaces = new MachinePortableSpaceController(database, coordinator, lifecycle, 'machine-a', () => binding, cloudDefinition, join(root, 'managed-spaces'));
    await spaces.release(database.getSpace('workspace-a')!, 1);
    expect(authority.state).toBe('closed');
    expect(database.getSpace('workspace-a')).toBeNull();
    expect(existsSync(workspaceRoot)).toBe(false);
    expect(existsSync(sessionFile)).toBe(false);
    expect(coordinator.get(created.value.id)).toBeNull();

    // The cloud checkpoint is readable without opening the space anywhere.
    const checkpointObjectReads: string[] = [];
    let projections = 0;
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
        failures: { open: null, close: null },
        revision: authority.revision + 1,
        publishedRevision: authority.revision,
        resumeMachineId: null,
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
        health: { revision: 0, issues: {} },
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    }, {
      put: (key, bytes) => blobs.put(key, bytes),
      get: (key, hash) => {
        checkpointObjectReads.push(key);
        return blobs.get(key, hash);
      },
    }, (bytes) => {
      projections += 1;
      return projectOmpCheckpointTranscript(bytes, ompEntrypoint);
    }, join(root, 'checkpoint-transcripts'));
    const metadata = await reader.readMetadata('project-a', 'workspace-a');
    expect(metadata).toEqual({ sessionId: created.value.id, generation: 2, lastMachineId: 'machine-a' });
    expect(checkpointObjectReads).toEqual([authority.manifestKey!]);
    expect(projections).toBe(0);
    const projected = await reader.read('project-a', 'workspace-a');
    expect(projected).toMatchObject({ sessionId: created.value.id, generation: 2, lastMachineId: 'machine-a' });
    expect(projected?.events.map(({ kind, payload }) => ({ kind, payload }))).toEqual([
      { kind: 'message_end', payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'done:before-release' }] } } },
    ]);
    expect(await reader.readMetadata('project-a', 'workspace-a')).toEqual(metadata);
    expect(await reader.read('project-a', 'workspace-a')).toEqual(projected);
    expect(projections).toBe(1);
    const page = await reader.page('project-a', 'workspace-a', { generation: null, before: null, after: null, around: null });
    expect(page?.rows[0]?.item).toMatchObject({ type: 'message', text: 'done:before-release' });
    expect(await reader.page('project-a', 'workspace-a', { generation: page!.generation, before: null, after: null, around: null })).toEqual(page);
    const content = await reader.content('project-a', 'workspace-a', { generation: page!.generation, rowId: page!.rows[0]!.id, offset: 0 });
    expect(JSON.parse(content!.text)).toMatchObject({ type: 'message', text: 'done:before-release' });
    expect(projections).toBe(1);
    expect(database.getSpace('workspace-a')).toBeNull();

    // The cloud definition rematerializes metadata; the checkpoint supplies the bytes.
    await spaces.open('workspace-a', 2);
    expect(database.getSpace('workspace-a')).toMatchObject({ placementState: 'open', holderId: 'machine-a', generation: 3 });
    expect(authority.state).toBe('open');
    expect(await reader.readMetadata('project-a', 'workspace-a')).toBeNull();
    expect(await reader.read('project-a', 'workspace-a')).toBeNull();
    expect(readFileSync(join(workspaceRoot, 'tracked.txt'), 'utf8')).toBe('changed\n');
    expect(existsSync(join(workspaceRoot, 'secret.env'))).toBe(false);
    expect(readdirSync(dirname(workspaceRoot)).some((entry) => entry.startsWith('workspace.retained-'))).toBe(false);
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
    const projectId = `project-${crypto.randomUUID().slice(0, 8)}`;
    const spaceId = `space-${crypto.randomUUID().slice(0, 8)}`;
    const workspaceRoot = join(root, projectId, spaceId);
    const sessionFile = join(root, 'sessions', 'omp-portable.jsonl');
    mkdirSync(workspaceRoot, { recursive: true });
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
      binaryPath: await sourceWalgit(join(import.meta.dir, '../../..')),
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
    const spaces = new MachinePortableSpaceController(database, coordinator, lifecycle, 'local-machine', () => binding, (id) => cloudDefinition(id, projectId), root);
    await spaces.close(database.getSpace(spaceId)!, 1);
    expect(database.getSpace(spaceId)).toBeNull();
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
