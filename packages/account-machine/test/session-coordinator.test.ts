import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scheduler } from 'node:timers/promises';
import {
  GitSpaceDatabase,
  LocalArtifactResolver,
  MemoryArtifactObjectStore,
} from '@gitspace/core';
import {
  MachineSessionCoordinator,
  type OmpRuntime,
  type OmpRuntimeEvent,
  type OmpRuntimeSession,
  type OmpSessionControlView,
} from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeOmpRuntime implements OmpRuntime {
  readonly created: string[] = [];
  readonly opened: string[] = [];
  readonly history: unknown[];
  messagesError: Error | null = null;
  private sessionActive = false;
  private readonly handlers = new Set<(event: OmpRuntimeEvent) => void>();

  constructor(history: unknown[] = []) {
    this.history = [...history];
  }

  async create(input: { workingDirectory: string; sessionKey: string; artifactsDir: string }): Promise<OmpRuntimeSession> {
    this.created.push(input.sessionKey);
    return this.session('omp-a', '/sessions/omp-a.jsonl', input.artifactsDir);
  }

  async open(input: { workingDirectory: string; sessionKey: string; artifactsDir: string; sessionFile: string }): Promise<OmpRuntimeSession> {
    this.opened.push(input.sessionFile);
    return this.session('omp-a', input.sessionFile, input.artifactsDir);
  }

  async transcript(): Promise<never> { throw new Error('Disk transcripts are not configured in this fixture'); }
  async checkpointTranscript(): Promise<never> { throw new Error('Checkpoint transcripts are not configured in this fixture'); }

  emit(event: OmpRuntimeEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  private session(id: string, sessionFile: string, artifactsDir: string): OmpRuntimeSession {
    if (this.sessionActive) throw new Error('OMP session is already open');
    this.sessionActive = true;
    return {
      id,
      sessionFile,
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
        const workspaceArtifacts = join(artifactsDir, 'workspace');
        mkdirSync(workspaceArtifacts, { recursive: true });
        writeFileSync(join(workspaceArtifacts, 'generated.txt'), `agent:${text}`);
        const message = { role: 'assistant', text: `done:${text}` };
        this.history.push(message);
        this.emit({ type: 'message_end', ...message });
        return true;
      },
      subscribe: (handler) => {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
      },
      subscribeActivity: (handler) => {
        handler({ active: false, reasons: [] });
        return () => undefined;
      },
      activity: () => ({ activity: { active: false, reasons: [] } }),
      persist: async () => undefined,
      handoff: async () => false,
      resume: async () => undefined,
      dispose: async () => { this.sessionActive = false; },
      messages: async () => {
        if (this.messagesError) throw this.messagesError;
        return [...this.history];
      },
    };
  }
}

class HandoffOmpRuntime implements OmpRuntime {
  readonly started = Promise.withResolvers<void>();
  readonly resumed = Promise.withResolvers<void>();
  resumeCalls = 0;
  private finishPrompt?: () => void;

  async create(input: { artifactsDir: string }): Promise<OmpRuntimeSession> {
    return this.session('/sessions/omp-handoff.jsonl');
  }

  async open(input: { sessionFile: string }): Promise<OmpRuntimeSession> {
    return this.session(input.sessionFile);
  }

  async transcript(): Promise<never> { throw new Error('Disk transcripts are not configured in this fixture'); }
  async checkpointTranscript(): Promise<never> { throw new Error('Checkpoint transcripts are not configured in this fixture'); }

  private session(sessionFile: string): OmpRuntimeSession {
    const handlers = new Set<(event: OmpRuntimeEvent) => void>();
    return {
      id: 'omp-handoff',
      sessionFile,
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
      prompt: async () => {
        this.started.resolve();
        for (const handler of handlers) handler({ type: 'message_start', role: 'user', text: 'long-running turn' });
        const completion = Promise.withResolvers<void>();
        this.finishPrompt = completion.resolve;
        await completion.promise;
        return true;
      },
      subscribe: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
      subscribeActivity: (handler) => { handler({ active: false, reasons: [] }); return () => undefined; },
      activity: () => ({ activity: { active: false, reasons: [] } }),
      persist: async () => undefined,
      handoff: async () => {
        this.finishPrompt?.();
        return true;
      },
      resume: async () => {
        this.resumeCalls += 1;
        for (const handler of handlers) handler({ type: 'message_end', role: 'assistant', text: 'resumed-progress' });
        this.resumed.resolve();
      },
      dispose: async () => undefined,
      messages: async () => [],
    };
  }
}

function fixture(): {
  root: string;
  databasePath: string;
  cacheRoot: string;
  database: GitSpaceDatabase;
  artifacts: LocalArtifactResolver;
  store: MemoryArtifactObjectStore;
} {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-machine-'));
  roots.push(root);
  const databasePath = join(root, 'gitspace.db');
  const cacheRoot = join(root, 'cache');
  const database = new GitSpaceDatabase(databasePath);
  expect(database.createProject({ id: 'project-a', name: 'A', repositoryPath: join(root, 'repo') }).status).toBe('ok');
  const workspaceRoot = join(root, 'repo', 'workspaces', 'a');
  mkdirSync(workspaceRoot, { recursive: true });
  expect(database.createWorkspace({
    id: 'workspace-a', projectId: 'project-a', name: 'A', branch: 'a', rootPath: workspaceRoot,
  }).status).toBe('ok');
  const store = new MemoryArtifactObjectStore();
  const artifacts = new LocalArtifactResolver(
    database,
    store,
    cacheRoot,
    artifactKey(),
  );
  return { root, databasePath, cacheRoot, database, artifacts, store };
}

function artifactKey(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => 100 + index);
}

describe('MachineSessionCoordinator', () => {
  it('preserves external artifact additions and edits when an older agent mount synchronizes', async () => {
    const { root, database, artifacts } = fixture();
    const capability = { kind: 'workspace' as const, projectId: 'project-a', workspaceId: 'workspace-a' };
    const original = new TextEncoder().encode('original');
    const external = new Uint8Array([0, 1, 255, 128, 0]);
    expect((await artifacts.write(capability, 'local://workspace/shared.bin', original)).status).toBe('ok');
    expect((await artifacts.commit(capability, 'local://workspace/')).status).toBe('ok');
    expect(database.possessWorkspace('workspace-a', 'machine-a').status).toBe('ok');
    const coordinator = new MachineSessionCoordinator(database, artifacts, new FakeOmpRuntime(), 'machine-a', join(root, 'runtime'));
    const created = await coordinator.create('workspace-a');
    if (created.status === 'error') throw created.error;
    expect((await artifacts.write(capability, 'local://workspace/shared.bin', external)).status).toBe('ok');
    expect((await artifacts.write(capability, 'local://workspace/inspector.bin', external)).status).toBe('ok');
    expect((await artifacts.commit(capability, 'local://workspace/')).status).toBe('ok');
    expect((await coordinator.prompt(created.value.id, 'keep external work')).status).toBe('ok');
    expect((await coordinator.stopForRestart()).status).toBe('ok');
    try {
      for (const name of ['shared.bin', 'inspector.bin']) {
        const result = await artifacts.read(capability, `local://workspace/${name}`);
        if (result.status === 'error') throw result.error;
        expect(result.value).toEqual(external);
      }
      const generated = await artifacts.read(capability, 'local://workspace/generated.txt');
      if (generated.status === 'error') throw generated.error;
      expect(new TextDecoder().decode(generated.value)).toBe('agent:keep external work');
    } finally {
      database.close();
    }
  });

  it('releases a child whose initial message read fails so the session can reopen', async () => {
    const { root, database, artifacts } = fixture();
    expect(database.possessWorkspace('workspace-a', 'machine-a').status).toBe('ok');
    const runtime = new FakeOmpRuntime();
    runtime.messagesError = new Error('OMP child disconnected during transcript read');
    const coordinator = new MachineSessionCoordinator(database, artifacts, runtime, 'machine-a', join(root, 'runtime'));

    const failed = await coordinator.create('workspace-a');
    expect(failed.status).toBe('error');
    expect(coordinator.list('workspace-a')[0]?.state).toBe('failed');

    runtime.messagesError = null;
    const reopened = await coordinator.create('workspace-a');
    if (reopened.status === 'error') throw reopened.error;
    expect(reopened.value.state).toBe('active');
    expect((await coordinator.prompt(reopened.value.id, 'after-reconnect')).status).toBe('ok');
    expect(await coordinator.transcript(reopened.value.id)).toMatchObject([
      { kind: 'message_end', payload: { text: 'done:after-reconnect' } },
    ]);
    await coordinator.close(reopened.value.id);
    database.close();
  });

  it('requires possession, records OMP events, syncs local artifacts, and recovers after restart', async () => {
    const { root, databasePath, cacheRoot, database, artifacts, store } = fixture();
    const firstRuntime = new FakeOmpRuntime();
    const first = new MachineSessionCoordinator(database, artifacts, firstRuntime, 'machine-a', join(root, 'runtime'));

    expect((await first.create('workspace-a')).status).toBe('error');
    expect(database.possessWorkspace('workspace-a', 'machine-a').status).toBe('ok');
    const created = await first.create('workspace-a');
    expect(created.status).toBe('ok');
    if (created.status === 'error') throw created.error;
    expect(firstRuntime.created).toEqual(['space:workspace-a']);
    const sameMainAgent = await first.create('workspace-a');
    expect(sameMainAgent.status).toBe('ok');
    if (sameMainAgent.status === 'error') throw sameMainAgent.error;
    expect(sameMainAgent.value.id).toBe(created.value.id);
    expect(firstRuntime.created).toEqual(['space:workspace-a']);

    expect((await first.prompt(created.value.id, 'build it')).status).toBe('ok');
    expect(await first.transcript(created.value.id)).toEqual([
      expect.objectContaining({ ordinal: 1, kind: 'message_end', payload: expect.objectContaining({ text: 'done:build it' }) }),
    ]);
    firstRuntime.emit({ type: 'turn_start' });
    firstRuntime.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'hel' }] } });
    firstRuntime.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } });
    expect(await first.transcript(created.value.id)).toEqual([
      expect.objectContaining({ ordinal: 1, kind: 'message_end' }),
      expect.objectContaining({ ordinal: 2, kind: 'turn_start' }),
      expect.objectContaining({ ordinal: 3, kind: 'message_update', payload: expect.objectContaining({ message: expect.objectContaining({ content: [expect.objectContaining({ text: 'hello' })] }) }) }),
    ]);
    firstRuntime.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } });
    expect((await first.transcript(created.value.id)).some((event) => event.kind === 'message_update')).toBe(false);
    expect((await first.stopForRestart()).status).toBe('ok');

    const persisted = await artifacts.read(
      { kind: 'workspace', projectId: 'project-a', workspaceId: 'workspace-a' },
      'local://workspace/generated.txt',
    );
    expect(persisted.status).toBe('ok');
    if (persisted.status === 'error') throw persisted.error;
    expect(new TextDecoder().decode(persisted.value)).toBe('agent:build it');

    database.close();
    const reopenedDatabase = new GitSpaceDatabase(databasePath);
    const reopenedArtifacts = new LocalArtifactResolver(reopenedDatabase, store, cacheRoot, artifactKey());
    const secondRuntime = new FakeOmpRuntime(firstRuntime.history);
    const second = new MachineSessionCoordinator(reopenedDatabase, reopenedArtifacts, secondRuntime, 'machine-a', join(root, 'runtime'));
    const recovered = await second.recover();
    expect(recovered.status).toBe('ok');
    if (recovered.status === 'error') throw recovered.error;
    expect(recovered.value.map((session) => session.id)).toEqual([created.value.id]);
    expect(secondRuntime.opened).toEqual(['/sessions/omp-a.jsonl']);
    expect(await second.transcript(created.value.id)).toHaveLength(1);
    expect((await second.close(created.value.id)).status).toBe('ok');
    expect(second.get(created.value.id)?.state).toBe('closed');
    reopenedDatabase.close();
  });

  it('joins every accepted prompt finalization before quiescing or disposing a session', async () => {
    const { root, database, artifacts } = fixture();
    database.possessWorkspace('workspace-a', 'machine-a');
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const firstFinished = Promise.withResolvers<void>();
    const firstGate = Promise.withResolvers<void>();
    const secondGate = Promise.withResolvers<void>();
    let publications = 0;
    let disposed = false;
    class AcknowledgedRuntime extends FakeOmpRuntime {
      override async create(input: Parameters<FakeOmpRuntime['create']>[0]) {
        const session = await super.create(input);
        return {
          ...session,
          prompt: async (text: string) => {
            this.emit({ type: 'message_start', role: 'user', text });
            return session.prompt(text);
          },
          dispose: async () => { disposed = true; await session.dispose(); },
        };
      }
    }
    const coordinator = new MachineSessionCoordinator(
      database, artifacts, new AcknowledgedRuntime(), 'machine-a', join(root, 'runtime'),
      undefined, undefined, undefined,
      {
        synchronizeArtifactScope: async () => {
          publications += 1;
          if (publications === 1) {
            firstEntered.resolve();
            await firstGate.promise;
            firstFinished.resolve();
          } else if (publications === 2) {
            secondEntered.resolve();
            await secondGate.promise;
          }
        },
      },
    );
    const opened = await coordinator.openSpace('workspace-a');
    if (opened.status === 'error') throw opened.error;
    expect((await coordinator.prompt(opened.value.id, 'first accepted turn')).status).toBe('ok');
    await firstEntered.promise;
    expect((await coordinator.prompt(opened.value.id, 'second accepted turn')).status).toBe('ok');
    await secondEntered.promise;
    firstGate.resolve();
    await firstFinished.promise;
    // Finish the first promise's microtasks; its completion must not erase the second.
    await scheduler.yield();
    let quiesced = false;
    const draining = coordinator.quiesceSpace('workspace-a').then(() => { quiesced = true; });
    const stopping = coordinator.stopForRestart();
    try {
      await scheduler.yield();
      expect(quiesced).toBe(false);
      expect(disposed).toBe(false);
      expect((await coordinator.prompt(opened.value.id, 'late arrival')).status).toBe('error');
    } finally {
      secondGate.resolve();
      await draining;
      const stopped = await stopping;
      if (stopped.status === 'error') throw stopped.error;
    }
    expect(disposed).toBe(true);
    const saved = await artifacts.read({ kind: 'workspace', projectId: 'project-a', workspaceId: 'workspace-a' }, 'local://workspace/generated.txt');
    if (saved.status === 'error') throw saved.error;
    expect(new TextDecoder().decode(saved.value)).toBe('agent:second accepted turn');
    database.close();
  });

  it('retains remote and released sessions without starting them until this machine claims the space', async () => {
    const { root, database, artifacts } = fixture();
    database.possessWorkspace('workspace-a', 'machine-a');
    const original = new MachineSessionCoordinator(database, artifacts, new FakeOmpRuntime(), 'machine-a', join(root, 'runtime'));
    const created = await original.create('workspace-a');
    if (created.status === 'error') throw created.error;
    await original.stopForRestart();
    const destination = new MachineSessionCoordinator(database, artifacts, new FakeOmpRuntime(), 'machine-b', join(root, 'runtime'));
    const remote = await destination.recover();
    expect(remote).toMatchObject({ status: 'ok', value: [] });
    expect(destination.get(created.value.id)).toMatchObject({ state: 'active', sessionFile: created.value.sessionFile, ompSessionId: created.value.ompSessionId });
    expect((await destination.prompt(created.value.id, 'must not run')).status).toBe('error');
    expect(database.releaseWorkspacePossession({ workspaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 1 }).status).toBe('ok');
    expect(await destination.recover()).toMatchObject({ status: 'ok', value: [] });
    expect(database.possessWorkspace('workspace-a', 'machine-b').status).toBe('ok');
    const claimed = await destination.recover();
    expect(claimed).toMatchObject({ status: 'ok', value: [{ id: created.value.id }] });
    expect((await destination.prompt(created.value.id, 'claimed')).status).toBe('ok');
    await destination.close(created.value.id);
    database.close();
  });

  it('does not activate a recovered runtime across a possession generation change', async () => {
    const { root, database, artifacts } = fixture();
    database.possessWorkspace('workspace-a', 'machine-a');
    const original = new MachineSessionCoordinator(database, artifacts, new FakeOmpRuntime(), 'machine-a', join(root, 'runtime'));
    const created = await original.create('workspace-a');
    if (created.status === 'error') throw created.error;
    await original.stopForRestart();
    class MovingRuntime extends FakeOmpRuntime {
      private moved = false;
      override async open(input: Parameters<FakeOmpRuntime['open']>[0]) {
        const session = await super.open(input);
        if (!this.moved) {
          this.moved = true;
          expect(database.transferSpacePossession({ spaceId: 'workspace-a', fromHolderId: 'machine-a', toHolderId: 'machine-b', expectedGeneration: 1 }).status).toBe('ok');
          expect(database.transferSpacePossession({ spaceId: 'workspace-a', fromHolderId: 'machine-b', toHolderId: 'machine-a', expectedGeneration: 2 }).status).toBe('ok');
        }
        return session;
      }
    }
    const recovered = new MachineSessionCoordinator(database, artifacts, new MovingRuntime(), 'machine-a', join(root, 'runtime'));
    expect(await recovered.recover()).toMatchObject({ status: 'ok', value: [] });
    expect((await recovered.prompt(created.value.id, 'stale')).status).toBe('error');
    expect(recovered.get(created.value.id)?.state).toBe('active');
    expect(await recovered.recover()).toMatchObject({ status: 'ok', value: [{ id: created.value.id }] });
    expect((await recovered.prompt(created.value.id, 'current')).status).toBe('ok');
    await recovered.close(created.value.id);
    database.close();
  });

  it('refuses provider checkpointing without consuming pending asks or queued prompts, and canceling that preparation is harmless', async () => {
    const { root, database, artifacts } = fixture();
    database.possessWorkspace('workspace-a', 'machine-a');
    const controls: OmpSessionControlView = {
      sessionId: 'omp-a', role: null, roleLabel: null, roles: [], provider: null, models: [],
      model: null, thinking: null, fastMode: false, approvalMode: 'always-ask', context: null,
      cost: 0, todos: [], queue: { steering: [], followUp: [] }, tree: [], history: [], goal: null,
      pendingAsk: { id: 'pending-ask', questions: [] },
    };
    let interruptions = 0;
    class PendingRuntime extends FakeOmpRuntime {
      override async create(input: Parameters<FakeOmpRuntime['create']>[0]) {
        const session = await super.create(input);
        return {
          ...session,
          control: async () => controls,
          handoff: async () => { interruptions += 1; return false; },
          answerAsk: async (id: string) => {
            if (controls.pendingAsk?.id !== id) throw new Error('Ask was consumed');
            controls.pendingAsk = null;
            return controls;
          },
          clearQueue: async () => { controls.queue = { steering: [], followUp: [] }; return controls; },
        };
      }
    }
    const coordinator = new MachineSessionCoordinator(database, artifacts, new PendingRuntime(), 'machine-a', join(root, 'runtime'));
    const opened = await coordinator.openSpace('workspace-a');
    if (opened.status === 'error') throw opened.error;
    await expect(coordinator.quiesceSpace('workspace-a', true)).rejects.toThrow();
    coordinator.resumeSpace('workspace-a');
    expect((await coordinator.control(opened.value.id)).pendingAsk?.id).toBe('pending-ask');
    expect(interruptions).toBe(0);
    await coordinator.answerAsk(opened.value.id, 'pending-ask', []);
    controls.queue.followUp.push('queued work');
    await expect(coordinator.quiesceSpace('workspace-a', true)).rejects.toThrow();
    coordinator.resumeSpace('workspace-a');
    expect((await coordinator.control(opened.value.id)).queue.followUp).toEqual(['queued work']);
    expect(interruptions).toBe(0);
    await coordinator.clearQueue(opened.value.id);
    await coordinator.quiesceSpace('workspace-a', true);
    expect((await coordinator.prompt(opened.value.id, 'must wait')).status).toBe('error');
    coordinator.resumeSpace('workspace-a');
    expect((await coordinator.prompt(opened.value.id, 'continued after cancel')).status).toBe('ok');
    await coordinator.stopForRestart();
    database.close();
  });

  it('interrupts an active turn before quiescing a space for close', async () => {
    const { root, database, artifacts } = fixture();
    expect(database.possessWorkspace('workspace-a', 'machine-a').status).toBe('ok');
    const runtime = new HandoffOmpRuntime();
    const coordinator = new MachineSessionCoordinator(database, artifacts, runtime, 'machine-a', join(root, 'runtime'));
    const created = await coordinator.create('workspace-a');
    expect(created.status).toBe('ok');
    if (created.status === 'error') throw created.error;
    const prompt = coordinator.prompt(created.value.id, 'long-running turn');
    await runtime.started.promise;
    expect((await prompt).status).toBe('ok');

    await coordinator.quiesceSpace('workspace-a');
    expect(coordinator.get(created.value.id)?.resumePending).toBe(true);

    const rejected = await coordinator.prompt(created.value.id, 'must not start');
    expect(rejected.status).toBe('error');
    if (rejected.status === 'ok') throw new Error('Expected quiesced prompt rejection');
    expect(rejected.error.message).toContain('Session is quiescing');
    expect((await coordinator.close(created.value.id)).status).toBe('ok');
    expect(coordinator.get(created.value.id)).toMatchObject({ state: 'closed', resumePending: true });
    database.close();
  });

  it('drains an active long turn and resumes it after machine replacement', async () => {
    const { root, databasePath, cacheRoot, database, artifacts, store } = fixture();
    expect(database.possessWorkspace('workspace-a', 'machine-a').status).toBe('ok');
    const firstRuntime = new HandoffOmpRuntime();
    const first = new MachineSessionCoordinator(database, artifacts, firstRuntime, 'machine-a', join(root, 'runtime'));
    const created = await first.create('workspace-a');
    expect(created.status).toBe('ok');
    if (created.status === 'error') throw created.error;
    const prompt = first.prompt(created.value.id, 'long-running turn');
    await firstRuntime.started.promise;
    expect((await prompt).status).toBe('ok');
    expect((await first.stopForRestart()).status).toBe('ok');
    expect(first.get(created.value.id)).toMatchObject({ state: 'active', resumePending: true });
    database.close();

    const reopenedDatabase = new GitSpaceDatabase(databasePath);
    const reopenedArtifacts = new LocalArtifactResolver(reopenedDatabase, store, cacheRoot, artifactKey());
    const secondRuntime = new HandoffOmpRuntime();
    const second = new MachineSessionCoordinator(reopenedDatabase, reopenedArtifacts, secondRuntime, 'machine-a', join(root, 'runtime'));
    const recovered = await second.recover();
    expect(recovered.status).toBe('ok');
    await secondRuntime.resumed.promise;
    expect(secondRuntime.resumeCalls).toBe(1);
    expect(second.get(created.value.id)).toMatchObject({ state: 'active', resumePending: false });
    expect(await second.transcript(created.value.id)).toEqual([
      expect.objectContaining({ kind: 'message_end', payload: expect.objectContaining({ text: 'resumed-progress' }) }),
    ]);
    await second.close(created.value.id);
    reopenedDatabase.close();
  });
});
