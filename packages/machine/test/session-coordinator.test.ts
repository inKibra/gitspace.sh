import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
} from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeOmpRuntime implements OmpRuntime {
  readonly created: string[] = [];
  readonly opened: string[] = [];
  readonly history: unknown[];
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

  emit(event: OmpRuntimeEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  private session(id: string, sessionFile: string, artifactsDir: string): OmpRuntimeSession {
    return {
      id,
      sessionFile,
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
      dispose: async () => undefined,
      messages: () => [...this.history],
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

  private session(sessionFile: string): OmpRuntimeSession {
    const handlers = new Set<(event: OmpRuntimeEvent) => void>();
    return {
      id: 'omp-handoff',
      sessionFile,
      prompt: async () => {
        this.started.resolve();
        await new Promise<void>((resolve) => { this.finishPrompt = resolve; });
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
      messages: () => [],
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
    expect((await first.stopForRestart()).status).toBe('ok');
    expect((await prompt).status).toBe('ok');
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
