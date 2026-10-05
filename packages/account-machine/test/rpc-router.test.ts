import type { AgentRuntime, RuntimeEvent, RuntimeSession, SessionControlView, TranscriptEvent as RuntimeTranscriptEvent } from '@gitspace/protocol-runtime/session-controls';
import { afterEach, describe, expect, it } from 'bun:test';
import { Result } from 'better-result';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FactEventStore,
  GitSpaceDatabase,
  GitSpaceHandlers,
  LocalArtifactResolver,
  MemoryArtifactObjectStore,
  type FactEvent,
  type MaterializedSpace,
} from '@gitspace/core';
import { ARTIFACT_UPLOAD_CHUNK_BYTES, ARTIFACT_UPLOAD_MAX_BYTES, createDeviceBinding, createEncryptedRpcFetch, createSignedRpcFetch, credentialProtocolBase64, gitspaceContract, rpcErrors, signDeviceInvite, type CloudProjectOperation, type CloudWorkspaceDefinition, type DeviceCapability, type DeviceGrantRecord, type ProjectEvent } from '@gitspace/protocol';
import { decodeTranscriptChunks, type TranscriptChunk, type TranscriptEvent } from '@gitspace/protocol/transcript';
import type { ResourcePreviewFrame } from '@gitspace/protocol/resource-uri';
import { applyStreamEvent, initialStreamState } from '@gitspace/protocol-sync';
import { WorkspaceDomainError } from '@gitspace/protocol-workspace';
import { emptyLifecycleState, isLifecycleRunActive, transitionLifecycle, type LifecycleRunRecord, type LifecycleState } from '@gitspace/protocol-environment';
import { WorkspaceEnvironmentManager } from '../src/workspace-environment.js';
import type { WorkspaceLifecyclePlanResult } from '../src/workspace-hub.js';
import { CloudProjectEventWriter } from '../src/cloud-project-events.js';
import { DeviceRegistry } from '../src/device-registry.js';
import { ProjectLifecycleManager, type ProjectLifecycleAuthority } from '../src/project-lifecycle.js';
import { createSignedRpcHandler } from '../src/signed-rpc.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createBrowserClient, fetchTransport } from 'result-rpc/client';
import { DEFAULT_MAX_WIRE_BYTES, serialize } from 'result-rpc';
import { readRepositoryTree } from '../src/inspector-git.js';
import {
  MachineSessionCoordinator,
  createEncryptedRpcHandler,
  createGitSpaceRpcHandler,
  startGitSpaceRpcHttpServer,
  type WorkspaceHubTerminalCoordinator,
} from '../src/index.js';
import { ARTIFACT_UPLOAD_IDLE_MS, ArtifactUploads } from '../src/artifact-uploads.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function* transcriptChunks(source: AsyncIterable<
  { status: 'ok'; value: TranscriptChunk } | { status: 'error'; error: unknown }
>): AsyncGenerator<TranscriptChunk> {
  for await (const result of source) {
    if (result.status === 'error') throw result.error;
    yield result.value;
  }
}

async function collectTranscript(source: Parameters<typeof transcriptChunks>[0]): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = [];
  for await (const event of decodeTranscriptChunks(transcriptChunks(source))) events.push(event);
  return events;
}

async function collectResults<T>(source: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const result of source) results.push(result);
  return results;
}

async function collectResourceBytes(source: AsyncIterable<
  { status: 'ok'; value: ResourcePreviewFrame } | { status: 'error'; error: unknown }
>, metadata: { url: string; mediaType: string | null; text: boolean; size: number }): Promise<Buffer> {
  let receivedMetadata = false;
  const chunks: Buffer[] = [];
  for await (const result of source) {
    if (result.status === 'error') throw result.error;
    expect(serialize({ v: 1, ...result }, { maxBytes: DEFAULT_MAX_WIRE_BYTES }).ok).toBe(true);
    const frame = result.value;
    if (!receivedMetadata) {
      expect(frame).toEqual({ type: 'metadata', ...metadata });
      receivedMetadata = true;
    } else {
      if (frame.type !== 'chunk') throw new Error('Expected byte chunks after the initial metadata');
      const bytes = Buffer.from(frame.base64, 'base64');
      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(bytes.byteLength).toBeLessThanOrEqual(48 * 1024);
      chunks.push(bytes);
    }
  }
  expect(receivedMetadata).toBe(true);
  const bytes = Buffer.concat(chunks);
  expect(bytes.byteLength).toBe(metadata.size);
  return bytes;
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...Bun.env,
      GIT_AUTHOR_NAME: 'Inspector RPC Test',
      GIT_AUTHOR_EMAIL: 'inspector@gitspace.invalid',
      GIT_COMMITTER_NAME: 'Inspector RPC Test',
      GIT_COMMITTER_EMAIL: 'inspector@gitspace.invalid',
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

class RpcFakeOmpRuntime implements AgentRuntime {
  readonly created: Array<{ workingDirectory: string; sessionKey: string }> = [];
  controls: SessionControlView | null = null;
  readonly opened: Array<{ workingDirectory: string; sessionKey: string }> = [];
  readonly promptBehaviors: Array<'steer' | 'followUp' | undefined> = [];
  readonly transcripts = new Map<string, RuntimeTranscriptEvent[]>();
  private readonly eventHandlers = new Map<string, Set<(event: RuntimeEvent) => void>>();
  emit(sessionId: string, event: RuntimeEvent): void {
    for (const handler of this.eventHandlers.get(sessionId) ?? []) handler(event);
  }
  async create(input: { workingDirectory: string; sessionKey: string; artifactsDir: string }): Promise<RuntimeSession> {
    this.created.push({ workingDirectory: input.workingDirectory, sessionKey: input.sessionKey });
    const name = input.sessionKey.replace(':', '-');
    const sessionFile = join(dirname(input.artifactsDir), `${name}.jsonl`);
    writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', version: 3, id: `omp-${name}` })}\n`);
    return this.session(`omp-${name}`, sessionFile, input.artifactsDir, input.sessionKey === 'space:project-a' ? 'base' : 'workspace');
  }
  async open(input: { workingDirectory: string; sessionKey: string; artifactsDir: string; sessionFile: string }): Promise<RuntimeSession> {
    this.opened.push({ workingDirectory: input.workingDirectory, sessionKey: input.sessionKey });
    const name = input.sessionKey.replace(':', '-');
    return this.session(`omp-${name}`, input.sessionFile, input.artifactsDir, input.sessionKey === 'space:project-a' ? 'base' : 'workspace');
  }
  async transcript(sessionFile: string): Promise<RuntimeTranscriptEvent[]> {
    const events = this.transcripts.get(sessionFile);
    if (!events) throw new Error('Disk transcripts are not configured in this fixture');
    return events;
  }
  async checkpointTranscript(): Promise<never> { throw new Error('Checkpoint transcripts are not configured in this fixture'); }
  async checkpointReference(): Promise<never> { throw new Error('Historical fixture does not contain a cloud conversation'); }
  private session(id: string, sessionFile: string, artifactsDir: string, artifactScope: 'base' | 'workspace'): RuntimeSession {
    const handlers = new Set<(event: RuntimeEvent) => void>();
    this.eventHandlers.set(id, handlers);
    let planning = false;
    let available = true;
    return {
      id,
      sessionFile,
      isAvailable: () => available,
      control: async () => {
        if (this.controls) return this.controls;
        throw new Error('Session controls are not configured in this fixture');
      },
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
      messages: async () => [],
      prompt: async (text, options) => {
        if (planning) throw new Error('Plan mode keeps the working tree read-only');
        this.promptBehaviors.push(options?.streamingBehavior);
        mkdirSync(join(artifactsDir, artifactScope), { recursive: true });
        writeFileSync(join(artifactsDir, artifactScope, 'rpc.txt'), text);
        for (const handler of handlers) handler({ type: 'message_end', role: 'assistant', text: `done:${text}` });
        return true;
      },
      subscribe: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      subscribeActivity: (handler) => {
        handler({ active: false, reasons: [] }, null);
        return () => undefined;
      },
      activity: () => ({ activity: { active: false, reasons: [] }, failure: null }),
      persist: async () => undefined,
      reloadSettings: async () => { throw new Error('Settings reload is not exercised by this fixture'); },
      instructionsChanged: async () => { throw new Error('Instruction reload is not exercised by this fixture'); },
      inferenceChanged: async () => { throw new Error('Inference reload is not exercised by this fixture'); },
      setWorkspacePhase: async (phase) => { planning = phase === 'plan'; },
      handoff: async () => false,
      resume: async () => undefined,
      dispose: async () => { available = false; },
    };
  }
}

describe('GitSpace Result RPC', () => {
  it('streams a complete repository tree larger than the RPC response limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-tree-rpc-'));
    roots.push(root);
    const repositoryPath = join(root, 'repo', 'workspace');
    mkdirSync(repositoryPath, { recursive: true });
    git(repositoryPath, 'init', '-b', 'main');
    writeFileSync(join(repositoryPath, 'tracked.txt'), 'tracked\n');
    git(repositoryPath, 'add', '.');
    git(repositoryPath, 'commit', '-m', 'Initial tree');
    const directory = Array.from({ length: 30 }, (_, index) => `${index}-${'directory'.repeat(10)}`).join('/');
    mkdirSync(join(repositoryPath, directory), { recursive: true });
    for (let index = 0; index < 420; index += 1) {
      writeFileSync(join(repositoryPath, directory, `${index}-${'file'.repeat(50)}.txt`), 'untracked\n');
    }
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    expect(database.createProject({ id: 'project-a', name: 'Tree', repositoryPath: join(root, 'repo') }).status).toBe('ok');
    expect(database.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'Tree', branch: 'main', rootPath: repositoryPath }).status).toBe('ok');
    expect(database.possessWorkspace('workspace-a', 'machine-a').status).toBe('ok');
    const generation = database.getSpace('workspace-a')!.generation;
    const expected = await readRepositoryTree({ repositoryPath, spaceId: 'workspace-a', generation, mode: 'current' });
    expect(serialize({ v: 1, status: 'ok', value: expected }, { maxBytes: DEFAULT_MAX_WIRE_BYTES }).ok).toBe(false);
    const artifacts = new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'cache'), new Uint8Array(32));
    const events = new FactEventStore(database);
    const handlers = new GitSpaceHandlers(database, artifacts, events);
    const sessions = new MachineSessionCoordinator(database, artifacts, new RpcFakeOmpRuntime(), 'machine-a', join(root, 'runtime'), events);
    const unavailable = async (): Promise<never> => { throw new Error('Not configured in repository fixture'); };
    const rpc = createGitSpaceRpcHandler({
      database, handlers, artifacts, sessions, factEvents: events, machineId: 'machine-a',
      terminals: {} as WorkspaceHubTerminalCoordinator,
      spaces: { close: unavailable, release: unavailable, open: unavailable },
      serviceManager: { list: async () => [], start: unavailable, stop: unavailable },
      secrets: { listProjectSecrets: async () => [], putProjectSecret: unavailable, deleteProjectSecret: unavailable, materializeProjectSecrets: unavailable },
      projects: {
        list: async () => [], createProject: unavailable, openProject: unavailable, createWorkspace: unavailable,
        retryCreateWorkspace: unavailable, findWorkspace: async () => null,
        archiveWorkspace: unavailable, archiveProject: unavailable, restoreProject: unavailable, setBaseBranch: unavailable,
        deleteProject: unavailable, deleteWorkspace: unavailable, setWorkspaceLifecycle: unavailable,
        setWorkspacePhase: unavailable, runLifecycleOperation: unavailable,
      },
      projectEvents: { appendProjectEvent: unavailable, listProjectEvents: async () => [], latestProjectEventOffset: async () => 0 },
      machines: async () => [], spacePlacements: async () => [],
    });
    const http = startGitSpaceRpcHttpServer({ handler: rpc.handler });
    const client = createBrowserClient({ contract: gitspaceContract, transport: fetchTransport({ url: `${http.url}/rpc` }) });
    try {
      const received: typeof expected = [];
      for await (const result of client.inspector.repository.tree({ spaceId: 'workspace-a', expectedGeneration: generation, mode: 'current', path: null })) {
        if (result.status === 'error') throw result.error;
        received.push(...result.value);
      }
      expect(received).toEqual(expected);
      const missing = [];
      for await (const result of client.inspector.repository.tree({ spaceId: 'missing', expectedGeneration: 0, mode: 'current', path: null })) missing.push(result);
      expect(missing).toMatchObject([{ status: 'error', error: { _tag: 'gitspace/workspace-not-found' } }]);
    } finally {
      await http.stop();
      database.close();
    }
  }, 20_000);

  it('archives a failed canonical workspace over HTTP without creating a local placement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-archive-rpc-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const artifacts = new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'cache'), new Uint8Array(32));
    const events = new FactEventStore(database);
    const handlers = new GitSpaceHandlers(database, artifacts, events);
    const sessions = new MachineSessionCoordinator(database, artifacts, new RpcFakeOmpRuntime(), 'machine-a', join(root, 'runtime'), events);
    const now = new Date(0).toISOString();
    let definition: CloudWorkspaceDefinition = {
      id: 'failed-workspace', projectId: 'cloud-project', kind: 'worktree', name: 'Failed creation',
      branch: 'failed-creation', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null,
      lifecycle: 'failed', goalId: null, revision: 2, createdAt: now, updatedAt: now, archivedAt: null,
    };
    const operations = new Map<string, CloudProjectOperation>();
    const unavailable = async (): Promise<never> => { throw new Error('Not configured in archive fixture'); };
    const authority: ProjectLifecycleAuthority = {
      bootstrap: unavailable, bootstrapInspector: unavailable, bootstrapProject: unavailable,
      activateSourceProject: unavailable, setProjectBaseBranch: unavailable, setProjectLifecycle: unavailable, deleteProject: unavailable,
      removeProjectWorkspace: unavailable,
      listProjects: async () => [],
      getProject: async (projectId) => projectId === definition.projectId ? {
        id: projectId, name: 'Cloud project', lifecycle: 'active', repositoryReference: null, baseBranch: 'main',
        role: null, source: null, revision: 1, archivedAt: null, updatedAt: now,
      } : null,
      getSpace: async () => null,
      listProjectWorkspaces: async (projectId) => projectId === definition.projectId ? [{ ...definition }] : [],
      putProjectWorkspace: async (projectId, input) => {
        if (projectId !== definition.projectId || input.id !== definition.id || input.expectedRevision !== definition.revision) {
          throw new Error('Workspace revision conflict');
        }
        const { expectedRevision, ...workspace } = input;
        definition = {
          ...workspace, revision: expectedRevision + 1, createdAt: definition.createdAt, updatedAt: now,
          archivedAt: workspace.lifecycle === 'archived' ? now : null,
        };
        return { ...definition };
      },
      createProjectOperation: async (_projectId, input) => {
        const operation: CloudProjectOperation = {
          ...input, id: crypto.randomUUID(), state: 'queued', revision: 1,
          steps: input.steps.map((step) => ({ ...step, state: 'queued', message: null, updatedAt: now })),
          claimToken: null, leaseExpiresAt: null, error: null, createdAt: now, updatedAt: now,
        };
        operations.set(operation.id, operation);
        return operation;
      },
      updateProjectOperation: async (_projectId, input) => {
        const current = operations.get(input.id);
        if (!current || current.revision !== input.expectedRevision) throw new Error('Operation revision conflict');
        const operation: CloudProjectOperation = {
          ...current, state: input.state, steps: input.steps, error: input.error, revision: current.revision + 1,
        };
        operations.set(operation.id, operation);
        return operation;
      },
    };
    const projects = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'));
    const rpc = createGitSpaceRpcHandler({
      database, handlers, artifacts, sessions, factEvents: events, projects, machineId: 'machine-a',
      terminals: {} as WorkspaceHubTerminalCoordinator,
      spaces: { close: unavailable, release: unavailable, open: unavailable },
      serviceManager: { list: async () => [], start: unavailable, stop: unavailable },
      secrets: { listProjectSecrets: async () => [], putProjectSecret: unavailable, deleteProjectSecret: unavailable, materializeProjectSecrets: unavailable },
      projectEvents: { appendProjectEvent: unavailable, listProjectEvents: async () => [], latestProjectEventOffset: async () => 0 },
      machines: async () => [], spacePlacements: async () => [],
    });
    const http = startGitSpaceRpcHttpServer({ handler: rpc.handler });
    const client = createBrowserClient({ contract: gitspaceContract, transport: fetchTransport({ url: `${http.url}/rpc` }) });
    try {
      const archived = await client.workspace.archive({
        projectId: 'cloud-project', spaceId: 'failed-workspace', expectedRevision: 2, expectedGeneration: null,
      });
      if (archived.status === 'error') throw archived.error;
      expect(archived.value).toMatchObject({
        id: 'failed-workspace', projectId: 'cloud-project', lifecycle: 'archived', revision: 3, archivedAt: now,
      });
      expect((await authority.listProjectWorkspaces('cloud-project'))[0]?.lifecycle).toBe('archived');
      expect(database.getSpace('failed-workspace')).toBeNull();
      expect(database.getProject('cloud-project')).toBeNull();
    } finally {
      await http.stop();
      database.close();
    }
  });

  it('recovers complete large live, child, and closed snapshots through bounded HTTP streams', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-transcript-rpc-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    expect(database.createProject({ id: 'project-a', name: 'Transcript', repositoryPath: join(root, 'repo') }).status).toBe('ok');
    expect(database.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'Transcript', branch: 'main', rootPath: join(root, 'repo', 'workspace') }).status).toBe('ok');
    expect(database.createProject({ id: 'project-b', name: 'Other', repositoryPath: join(root, 'other') }).status).toBe('ok');
    expect(database.createWorkspace({ id: 'workspace-b', projectId: 'project-b', name: 'Other', branch: 'main', rootPath: join(root, 'other', 'workspace') }).status).toBe('ok');
    expect(database.possessWorkspace('workspace-a', 'machine-a').status).toBe('ok');
    const artifacts = new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'cache'), new Uint8Array(32));
    const events = new FactEventStore(database);
    const handlers = new GitSpaceHandlers(database, artifacts, events);
    const runtime = new RpcFakeOmpRuntime();
    const sessions = new MachineSessionCoordinator(database, artifacts, runtime, 'machine-a', join(root, 'runtime'), events);
    const created = await sessions.create('workspace-a');
    if (created.status === 'error') throw created.error;
    const session = sessions.get(created.value.id)!;
    const texts = [
      ...Array.from({ length: 20 }, (_, index) => `${index}:` + 'history'.repeat(10_000)),
      '\u0000"\\😀'.repeat(180_000),
    ];
    for (const text of texts) runtime.emit(session.ompSessionId, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    const snapshot = await sessions.transcript(session.id);
    const expected = snapshot.map((event) => ({ ...event, sessionId: session.id, createdAt: new Date(event.createdAt) }));
    expect(new TextEncoder().encode(JSON.stringify(snapshot.slice(0, -1))).byteLength).toBeGreaterThan(1024 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(snapshot.at(-1))).byteLength).toBeGreaterThan(1024 * 1024);
    const childId = 'large-child';
    runtime.transcripts.set(join(session.sessionFile.replace(/\.jsonl$/u, ''), `${childId}.jsonl`), snapshot);
    const childPath = join(session.sessionFile.replace(/\.jsonl$/u, ''), `${childId}.jsonl`);
    mkdirSync(dirname(childPath), { recursive: true });
    writeFileSync(childPath, [
      JSON.stringify({ type: 'session', version: 3, id: childId }),
      ...snapshot.map((event, index) => JSON.stringify({
        type: 'custom', id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
        timestamp: event.createdAt, customType: event.kind, data: event.payload,
      })),
      '',
    ].join('\n'));
    const checkpoint = { sessionId: 'saved-session', generation: 2, lastMachineId: 'machine-b' };
    let checkpointAvailable = false;
    let metadataInvalidation: FactEvent | undefined;
    const unavailable = async (): Promise<never> => { throw new Error('Not configured in transcript fixture'); };
    const rpc = createGitSpaceRpcHandler({
      database, handlers, artifacts, sessions, factEvents: events,
      terminals: {} as WorkspaceHubTerminalCoordinator,
      spaces: { close: unavailable, release: unavailable, open: unavailable },
      serviceManager: { list: async () => [], start: unavailable, stop: unavailable },
      secrets: { listProjectSecrets: async () => [], putProjectSecret: unavailable, deleteProjectSecret: unavailable, materializeProjectSecrets: unavailable },
      projectEvents: {
        appendProjectEvent: unavailable,
        listProjectEvents: async () => [],
        latestProjectEventOffset: async () => 40,
      },
      projects: {
        list: async () => [], createProject: unavailable, openProject: unavailable, createWorkspace: unavailable,
        retryCreateWorkspace: unavailable,
        findWorkspace: async () => null,
        archiveWorkspace: unavailable, archiveProject: unavailable, restoreProject: unavailable, setBaseBranch: unavailable, deleteProject: unavailable, deleteWorkspace: unavailable,
        setWorkspaceLifecycle: unavailable, setWorkspacePhase: unavailable, runLifecycleOperation: unavailable,
      },
      machines: async () => [],
      spacePlacements: async () => [],
      checkpointMetadata: async () => {
        await Promise.resolve();
        metadataInvalidation = events.append({
          projectId: 'project-a', scope: 'session', entity: 'transcript', entityId: session.id,
          revision: 1, operation: 'updated',
        });
        return checkpoint;
      },
      checkpointTranscript: async () => {
        if (!checkpointAvailable) throw new WorkspaceDomainError({
          domain: 'workspace', code: 'WORKSPACE_CHECKPOINT_MISSING',
          message: 'Checkpoint history temporarily unavailable', context: { spaceId: 'workspace-a', generation: 2 },
        });
        return { ...checkpoint, events: snapshot };
      },
      machineId: 'machine-a',
    });
    const http = startGitSpaceRpcHttpServer({ handler: rpc.handler });
    let measureBootstrap = true;
    let bootstrapBytes = 0;
    const client = createBrowserClient({
      contract: gitspaceContract,
      transport: fetchTransport({
        url: `${http.url}/rpc`,
        fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const response = await fetch(request);
          if (measureBootstrap) {
            bootstrapBytes = (await response.clone().arrayBuffer()).byteLength;
          }
          return response;
        }, { preconnect: fetch.preconnect }),
      }),
    });
    try {
      const input = { projectId: 'project-a', workspaceId: 'workspace-a' };
      const metadata = await client.space.view(input);
      measureBootstrap = false;
      if (metadata.status === 'error') throw metadata.error;
      expect(metadata.value.mainAgent?.id).toBe(session.id);
      expect(metadata.value).not.toHaveProperty('transcript');
      expect(bootstrapBytes).toBeGreaterThan(0);
      expect(bootstrapBytes).toBeLessThan(64 * 1024);

      // Appending after the first frame must not change the snapshot already in flight.
      const stream = client.transcript(input)[Symbol.asyncIterator]();
      const first = await stream.next();
      if (first.done) throw new Error('Transcript stream ended before its first frame');
      const firstResult = first.value;
      runtime.emit(session.ompSessionId, { type: 'message_end', role: 'assistant', text: 'after snapshot began' });
      async function* inFlight() {
        yield firstResult;
        while (true) {
          const next = await stream.next();
          if (next.done) return;
          if (next.value.status === 'ok') expect(next.value.value.data.length).toBeLessThanOrEqual(64 * 1024);
          yield next.value;
        }
      }
      expect(await collectTranscript(inFlight())).toEqual(expected);
      const refreshed = await collectTranscript(client.transcript(input));
      expect(refreshed.slice(0, -1)).toEqual(expected);
      expect(refreshed.at(-1)).toMatchObject({ payload: { text: 'after snapshot began' } });
      const pageInput = { ...input, generation: null, before: null, after: null, around: null };
      const page = await client.transcriptPage(pageInput);
      if (page.status === 'error') throw page.error;
      expect(page.value.total).toBe(texts.length);
      expect(page.value.hasAfter).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(page.value.rows))).toBeLessThanOrEqual(96 * 1024);
      const oversized = page.value.rows.at(-1)!;
      expect(oversized.truncated).toBe(true);
      const content = await client.transcriptContent({ ...input, generation: page.value.generation, rowId: oversized.id, offset: 0 });
      if (content.status === 'error') throw content.error;
      expect(content.value.text.length).toBe(Math.min(256 * 1024, content.value.totalCharacters));
      expect(content.value.text).toContain('"type":"message"');
      expect(content.value.nextOffset).toBe(content.value.totalCharacters > 256 * 1024 ? 256 * 1024 : null);
      expect((await client.transcriptContent({ ...input, generation: 'wrong', rowId: oversized.id, offset: 0 })).status).toBe('error');
      expect((await client.transcriptPage({ ...pageInput, workspaceId: 'workspace-b' })).status).toBe('error');
      const childPage = await client.subagents.page({ sessionId: session.id, subagentId: childId, generation: null, before: null, after: null, around: null });
      if (childPage.status === 'error') throw childPage.error;
      expect(childPage.value.total).toBe(texts.length);
      expect((await client.subagents.page({ sessionId: session.id, subagentId: '../outside', generation: null, before: null, after: null, around: null })).status).toBe('error');

      const childExpected = expected.map((event) => ({ ...event, sessionId: childId }));
      expect(await collectTranscript(client.subagents.transcript({ sessionId: session.id, subagentId: childId }))).toEqual(childExpected);
      const childTail = decodeTranscriptChunks(transcriptChunks(client.subagents.events({
        sessionId: session.id, subagentId: childId, afterOrdinal: snapshot.length - 1,
      })))[Symbol.asyncIterator]();
      try {
        expect((await childTail.next()).value).toEqual(childExpected.at(-1));
      } finally {
        await childTail.return?.(undefined);
      }
      const missingProject = await client.transcript({ ...input, projectId: 'missing' })[Symbol.asyncIterator]().next();
      if (!missingProject.value || missingProject.value.status === 'ok') throw new Error('Expected missing project error');
      expect(rpcErrors.projectNotFound.is(missingProject.value.error)).toBe(true);
      const foreignWorkspace = await client.transcript({ ...input, workspaceId: 'workspace-b' })[Symbol.asyncIterator]().next();
      if (!foreignWorkspace.value || foreignWorkspace.value.status === 'ok') throw new Error('Expected out-of-project workspace error');
      expect(rpcErrors.workspaceNotFound.is(foreignWorkspace.value.error)).toBe(true);
      const missingChild = await client.subagents.transcript({ sessionId: 'missing', subagentId: childId })[Symbol.asyncIterator]().next();
      expect(missingChild.value?.status).toBe('error');

      const closing = { spaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 1 };
      expect(database.beginSpaceClose(closing).status).toBe('ok');
      expect((await sessions.close(session.id)).status).toBe('ok');
      expect(database.commitSpaceClosed(closing).status).toBe('ok');
      measureBootstrap = true;
      const beforeMetadataOffset = events.latestOffset('project-a');
      const closed = await client.space.view(input);
      measureBootstrap = false;
      if (closed.status === 'error') throw closed.error;
      expect(closed.value.mainAgent).toBeNull();
      expect(closed.value.checkpoint).toEqual(checkpoint);
      expect(closed.value).not.toHaveProperty('transcript');
      expect(bootstrapBytes).toBeLessThan(64 * 1024);
      // An invalidation arriving during metadata loading must replay from the returned offset.
      expect(closed.value.eventOffset).toBe(beforeMetadataOffset);
      const invalidations = client.events({ projectId: input.projectId, after: closed.value.eventOffset })[Symbol.asyncIterator]();
      try {
        if (!metadataInvalidation) throw new Error('Expected checkpoint metadata invalidation');
        expect((await invalidations.next()).value).toMatchObject({
          status: 'ok', value: {
            type: 'change', previous: beforeMetadataOffset, cursor: metadataInvalidation.offset,
            value: { eventId: metadataInvalidation.eventId, entity: 'transcript' },
          },
        });
      } finally {
        await invalidations.return?.();
      }
      const unavailableSnapshot = await client.transcript(input)[Symbol.asyncIterator]().next();
      if (!unavailableSnapshot.value || unavailableSnapshot.value.status === 'ok') throw new Error('Expected checkpoint failure');
      expect(rpcErrors.workspaceFailure.is(unavailableSnapshot.value.error)).toBe(true);
      expect(unavailableSnapshot.value.error.data).toMatchObject({
        domain: 'workspace', code: 'WORKSPACE_CHECKPOINT_MISSING', context: { spaceId: 'workspace-a', generation: 2 },
      });
      checkpointAvailable = true;
      expect(await collectTranscript(client.transcript(input))).toEqual(expected.map((event) => ({ ...event, sessionId: checkpoint.sessionId })));
      expect(database.getSpace('workspace-a')).toMatchObject({ placementState: 'closed', generation: 2 });
      expect(runtime.opened).toEqual([]);
    } finally {
      await sessions.close(session.id);
      await http.stop();
      database.close();
    }
  }, 20_000);

  it('runs and serves an open workspace after its project base is released from the machine', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-released-base-rpc-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    expect(database.createProject({ id: 'project-a', name: 'Released base', repositoryPath: join(root, 'base') }).status).toBe('ok');
    expect(database.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'Workspace', branch: 'feature', rootPath: join(root, 'workspace') }).status).toBe('ok');
    expect(database.possessWorkspace('workspace-a', 'machine-a').status).toBe('ok');
    const artifacts = new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'cache'), new Uint8Array(32));
    const events = new FactEventStore(database);
    const sessions = new MachineSessionCoordinator(database, artifacts, new RpcFakeOmpRuntime(), 'machine-a', join(root, 'runtime'), events);
    const base = database.getSpace('project-a')!;
    database.prepareSpaceCleanup({ spaceId: base.id, projectId: base.projectId, generation: base.generation, rootPath: base.rootPath, sessionFiles: [], sessionIds: [] });
    database.commitSpaceCleanup(base.id);
    expect(database.getBaseSpace('project-a')).toBeNull();
    // The workspace agent starts and syncs its artifacts without the base's read-only mount.
    const created = await sessions.create('workspace-a');
    if (created.status === 'error') throw created.error;
    await sessions.refreshArtifacts('project-a', 'workspace-a');
    await sessions.publishArtifacts('workspace-a');
    const checkpoint = { sessionId: 'base-session', generation: 4, lastMachineId: 'machine-b' };
    const metadataReads: string[] = [];
    const unavailable = async (): Promise<never> => { throw new Error('Not configured in released-base fixture'); };
    const rpc = createGitSpaceRpcHandler({
      database, handlers: new GitSpaceHandlers(database, artifacts, events), artifacts, sessions, factEvents: events,
      terminals: {} as WorkspaceHubTerminalCoordinator,
      spaces: { close: unavailable, release: unavailable, open: unavailable },
      serviceManager: { list: async () => [], start: unavailable, stop: unavailable },
      secrets: { listProjectSecrets: async () => [], putProjectSecret: unavailable, deleteProjectSecret: unavailable, materializeProjectSecrets: unavailable },
      projectEvents: { appendProjectEvent: unavailable, listProjectEvents: async () => [], latestProjectEventOffset: async () => 0 },
      projects: {
        list: async () => [], createProject: unavailable, openProject: unavailable, createWorkspace: unavailable,
        retryCreateWorkspace: unavailable,
        findWorkspace: async () => null,
        archiveWorkspace: unavailable, archiveProject: unavailable, restoreProject: unavailable, setBaseBranch: unavailable, deleteProject: unavailable, deleteWorkspace: unavailable,
        setWorkspaceLifecycle: unavailable, setWorkspacePhase: unavailable, runLifecycleOperation: unavailable,
      },
      machines: async () => [],
      spacePlacements: async () => [],
      checkpointMetadata: async (_projectId, spaceId) => { metadataReads.push(spaceId); return checkpoint; },
      checkpointTranscript: unavailable,
      machineId: 'machine-a',
    });
    const http = startGitSpaceRpcHttpServer({ handler: rpc.handler });
    const client = createBrowserClient({ contract: gitspaceContract, transport: fetchTransport({ url: `${http.url}/rpc` }) });
    try {
      const workspace = await client.space.view({ projectId: 'project-a', workspaceId: 'workspace-a' });
      if (workspace.status === 'error') throw workspace.error;
      expect(workspace.value.project).toEqual({ id: 'project-a', name: 'Released base', baseBranch: 'main', connected: false });
      expect(workspace.value.baseSpace).toMatchObject({ id: 'project-a', kind: 'base', branch: 'main', possessedBy: null, closedAt: null });
      expect(workspace.value.mainAgent).toMatchObject({ id: created.value.id, scope: 'workspace', workspaceId: 'workspace-a' });
      expect(workspace.value.checkpoint).toBeNull();
      expect(metadataReads).toEqual([]);

      const released = await client.space.view({ projectId: 'project-a', workspaceId: null });
      if (released.status === 'error') throw released.error;
      expect(released.value.mainAgent).toBeNull();
      expect(released.value.checkpoint).toEqual(checkpoint);
      expect(metadataReads).toEqual(['project-a']);
      expect(released.value.workspaces.map((candidate) => candidate.id)).toEqual(['workspace-a']);
    } finally {
      await sessions.close(created.value.id);
      await http.stop();
      database.close();
    }
  });

  it('serves typed queries, mutations, and one replayable fact stream over HTTP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-rpc-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    expect(database.createProject({ id: 'project-a', name: 'GitSpace', repositoryPath: join(root, 'repo') }).status).toBe('ok');
    const workspaceRoot = join(root, 'workspaces', 'a');
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(join(root, 'repo'), { recursive: true });
    expect(database.createWorkspace({
      id: 'workspace-a', projectId: 'project-a', name: 'agent-blame', branch: 'develop', rootPath: workspaceRoot, phase: 'code',
    }).status).toBe('ok');
    const artifacts = new LocalArtifactResolver(
      database,
      new MemoryArtifactObjectStore(),
      join(root, 'cache'),
      Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    );
    // Cloud delivery offsets deliberately differ from the machine's durable replay cursor.
    const PROJECT_LOG_BASE = 500;
    const projectLog: Array<ProjectEvent & { projectId: string }> = [];
    const projectEvents = {
      appendProjectEvent: async (input: Omit<ProjectEvent, 'offset' | 'createdAt'> & { projectId: string }) => {
        const event = { ...input, offset: PROJECT_LOG_BASE + projectLog.length + 1, createdAt: new Date().toISOString() };
        projectLog.push(event);
        const { projectId: _projectId, ...cloudEvent } = event;
        return cloudEvent;
      },
      listProjectEvents: async (projectId: string, afterOffset: number) => projectLog
        .filter((event) => event.projectId === projectId && event.offset > afterOffset)
        .map(({ projectId: _projectId, ...event }) => event),
      latestProjectEventOffset: async (projectId: string) => projectLog.filter((event) => event.projectId === projectId).at(-1)?.offset ?? 0,
    };
    const events = new CloudProjectEventWriter(projectEvents, database, (error) => { throw error; });
    const handlers = new GitSpaceHandlers(database, artifacts, events);
    const runtime = new RpcFakeOmpRuntime();
    let retryPlacementMoved = false;
    const sessions = new MachineSessionCoordinator(
      database,
      artifacts,
      runtime,
      'machine-a',
      join(root, 'runtime'),
      events,
    );
    let remoteSpaceGeneration = 6;
    let cleanupBlocked = false;
    const spaces = {
      retryCleanup: async () => {
        if (cleanupBlocked) throw new Error('Local cleanup is still blocked');
      },
      close: async (space: MaterializedSpace, expectedGeneration: number) => {
        const started = database.beginSpaceClose({ spaceId: space.id, holderId: 'machine-a', expectedGeneration });
        if (started.status === 'error') throw started.error;
        const session = sessions.list(space.id)[0];
        if (session) {
          const stopped = await sessions.close(session.id);
          if (stopped.status === 'error') throw stopped.error;
        }
        const committed = database.commitSpaceClosed({ spaceId: space.id, holderId: 'machine-a', expectedGeneration });
        if (committed.status === 'error') throw committed.error;
        if (space.id === 'remote-workspace') {
          remoteSpaceGeneration = expectedGeneration + 1;
          database.deleteWorkspace(space.id);
        }
      },
      release: async (space: MaterializedSpace, expectedGeneration: number) => {
        const started = database.beginSpaceClose({ spaceId: space.id, holderId: 'machine-a', expectedGeneration });
        if (started.status === 'error') throw started.error;
        const committed = database.commitSpaceClosed({ spaceId: space.id, holderId: 'machine-a', expectedGeneration });
        if (committed.status === 'error') throw committed.error;
      },
      open: async (spaceId: string, expectedGeneration: number) => {
        if (spaceId === 'remote-workspace') {
          if (expectedGeneration !== remoteSpaceGeneration) throw new Error('Cloud placement generation changed');
          if (!database.getSpace(spaceId)) {
            const remoteRoot = join(root, 'remote-workspace');
            mkdirSync(remoteRoot, { recursive: true });
            const created = database.createWorkspace({ id: spaceId, projectId: 'project-a', name: 'remote', branch: 'remote', rootPath: remoteRoot });
            if (created.status === 'error') throw created.error;
          }
          const aligned = database.alignClosedSpaceProjection(spaceId, expectedGeneration);
          if (aligned.status === 'error') throw aligned.error;
        }
        const space = database.getSpace(spaceId)!;
        const started = database.beginSpaceOpen({ spaceId: space.id, holderId: 'machine-a', expectedGeneration });
        if (started.status === 'error') throw started.error;
        const opened = await sessions.openSpace(space.id, true);
        if (opened.status === 'error') throw opened.error;
        const committed = database.commitSpaceOpen({ spaceId: space.id, holderId: 'machine-a', generation: expectedGeneration + 1 });
        if (committed.status === 'error') throw committed.error;
        database.setSpaceClosed(space.id, false);
      },
    };
    const fleet = [{ id: 'machine-a', label: 'Machine A', state: 'online' as const, rpcEndpoint: null, kind: 'physical' as const, provider: 'physical' as const, notes: '', desiredState: 'online' as const, lifecycleRevision: 0, operationId: null, error: null }];
    let projectSecrets: Array<{ projectId: string; name: string; revision: number; updatedAt: string; updatedBy: string }> = [];
    const secrets = {
      materializeProjectSecrets: async (): Promise<never> => { throw new Error('Secret materialization is not configured in this fixture'); },
      listProjectSecrets: async (projectId: string) => projectSecrets.filter((secret) => secret.projectId === projectId),
      putProjectSecret: async (projectId: string, name: string, _value: string) => {
        const current = projectSecrets.find((secret) => secret.projectId === projectId && secret.name === name);
        const secret = { projectId, name, revision: (current?.revision ?? 0) + 1, updatedAt: '2026-08-31T00:00:00.000Z', updatedBy: 'machine-a' };
        projectSecrets = [...projectSecrets.filter((candidate) => candidate.projectId !== projectId || candidate.name !== name), secret];
        return secret;
      },
      deleteProjectSecret: async (projectId: string, name: string) => {
        const before = projectSecrets.length;
        projectSecrets = projectSecrets.filter((secret) => secret.projectId !== projectId || secret.name !== name);
        return { deleted: projectSecrets.length !== before };
      },
    };
    const projectAuthority = {
      findWorkspace: async (workspaceId: string) => {
        if (workspaceId !== 'workspace-a' && workspaceId !== 'remote-workspace') return null;
        return {
          id: workspaceId, projectId: 'project-a', kind: 'worktree' as const, name: workspaceId, branch: workspaceId,
          phase: 'plan' as const, sourceKind: 'base' as const, sourceRef: 'main', sourceCommit: null,
          lifecycle: 'archived' as const, goalId: null, revision: 1, archivedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
      },
      list: async () => [{
        id: 'project-a',
        name: 'GitSpace',
        lifecycle: 'active' as const,
        repositoryReference: null,
        baseBranch: 'main',
        role: null,
        source: null,
        revision: 1,
        archivedAt: null,
        updatedAt: new Date().toISOString(),
      }],
      createProject: async () => { throw new Error('not configured'); },
      openProject: async () => { throw new Error('not configured'); },
      createWorkspace: async () => { throw new Error('not configured'); },
      retryCreateWorkspace: async (): Promise<never> => { throw new Error('Workspace retry is not configured in this fixture'); },
      archiveWorkspace: async (): Promise<never> => { throw new Error('not configured'); },
      archiveProject: async () => { throw new Error('not configured'); },
      restoreProject: async () => { throw new Error('not configured'); },
      setBaseBranch: async () => { throw new Error('not configured'); },
      deleteProject: async () => false,
      deleteWorkspace: async () => false,
      setWorkspaceLifecycle: async () => undefined,
      setWorkspacePhase: async () => undefined,
      runLifecycleOperation: async <T,>(_projectId: string, _workspaceId: string | null, _kind: string, _labels: string[], action: () => Promise<T>) => action(),
    };
    // Device grants: a root-signed invite bound by the browser key, mirrored by the machine.
    const rootPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const browserPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 90);
    const readerPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 120);
    const writerPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 180);
    const deviceRecords: DeviceGrantRecord[] = [];
    const enrollDevice = (privateKey: Uint8Array, capabilities: DeviceCapability[], kind: 'browser' | 'client' = 'browser'): string => {
      const invite = signDeviceInvite({ version: 1, userId: 'user-a', inviteId: crypto.randomUUID(), kind, label: null, scope: { kind: 'user' }, capabilities, canDelegate: true, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'http://control.test' }, rootPrivateKey);
      const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(privateKey)), label: 'Test device', boundAt: Date.now(), signingPrivateKey: privateKey });
      deviceRecords.push({ invite, binding, generation: 1, revokedAt: null });
      return binding.deviceId;
    };
    const browserDeviceId = enrollDevice(browserPrivateKey, ['rpc.read', 'rpc.write', 'session.prompt', 'fleet.control', 'devices.manage']);
    const readerDeviceId = enrollDevice(readerPrivateKey, ['rpc.read']);
    const writerDeviceId = enrollDevice(writerPrivateKey, ['rpc.read', 'rpc.write'], 'client');
    const devices = new DeviceRegistry({
      database,
      rootSigningPublicKey: ed25519.getPublicKey(rootPrivateKey),
      authority: {
        listDeviceGrants: async () => deviceRecords.map((record) => ({ ...record })),
        revokeDeviceGrant: async (deviceId) => {
          const record = deviceRecords.find((candidate) => candidate.binding.deviceId === deviceId);
          if (!record) throw new Error('unknown device');
          record.revokedAt = Date.now();
          record.generation += 1;
          return { deviceId, revokedAt: record.revokedAt };
        },
      },
      pollMs: 60_000,
    });
    await devices.start();
    const launches: Array<{ workspaceId: string; targets: string[] }> = [];
    const tenantDeployment = {
      desired: { worker: null, machine: 'rel-1', frontend: null, updatedAt: '2026-08-31T00:00:00.000Z' },
      current: { worker: { sha: null, version: 'dev' }, machines: { 'machine-a': { sha: 'rel-1', generation: 'sha256:' + 'c'.repeat(64) } } },
      releases: [],
    };
    const cloudPlacements: Array<{ spaceId: string; projectId: string; kind: 'base' | 'worktree'; holderId: string; state: string; generation: number }> = [];
    let savedInspectorBase: string | null = null;
    let lifecycle = emptyLifecycleState('project-a', 'workspace-a');
    const lifecycleRecords = new Map<string, LifecycleRunRecord>();
    const lifecycleListeners = new Set<(state: LifecycleState) => void>();
    let runSettled = Promise.withResolvers<void>();
    let runnerStarted = Promise.withResolvers<void>();
    let execution = Promise.withResolvers<WorkspaceLifecyclePlanResult>();
    const stopRequested = Promise.withResolvers<void>();
    const lifecycleAuthority: ConstructorParameters<typeof WorkspaceEnvironmentManager>[3] = {
      listProjectWorkspaces: async () => [],
      getLifecycleState: async () => structuredClone(lifecycle),
      getLifecycleRunLog: async (_projectId, _spaceId, runId) => ({
        output: lifecycle.runs.find((run) => run.id === runId)?.output ?? '', nextOffset: null, cursor: 1,
      }),
      mutateLifecycleState: async (_projectId, _spaceId, input) => {
        const transition = transitionLifecycle({
          state: lifecycle, runs: [...lifecycleRecords.values()],
          actor: { actorId: 'machine-a', machineId: 'machine-a', kind: 'machine', lifecycleControl: false },
          now: new Date().toISOString(), token: crypto.randomUUID(),
        }, input);
        if (transition.record) lifecycleRecords.set(transition.record.run.id, transition.record);
        lifecycle = transition.state;
        for (const listener of lifecycleListeners) listener(structuredClone(lifecycle));
        if (input.op === 'finish') runSettled.resolve();
        return structuredClone(lifecycle);
      },
      watchLifecycleState: async (_projectId, _spaceId, listener, signal) => {
        if (signal.aborted) return;
        lifecycleListeners.add(listener);
        try {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        } finally {
          lifecycleListeners.delete(listener);
        }
      },
    };
    const environments = new WorkspaceEnvironmentManager(database, undefined, {
      runLifecyclePlan: async () => { runnerStarted.resolve(); return execution.promise; },
      cancelLifecycleRun: async () => { stopRequested.resolve(); },
    }, lifecycleAuthority, { machineId: 'machine-a', stateRoot: join(root, 'lifecycle-runs') });
    const rpc = createGitSpaceRpcHandler({
      database,
      handlers,
      artifacts,
      terminals: {
        list: async () => lifecycle.runs.filter(isLifecycleRunActive).map((run) => ({
          spaceId: run.spaceId, name: run.terminalName!, id: run.id, kind: 'lifecycle',
          protected: run.interactive ?? false, state: 'running', machineId: 'machine-a',
          owner: null, command: 'approved script', cwd: root, createdAt: new Date(), exitCode: null,
        })),
        live: async function* () { yield { type: 'output', data: 'protected fixture output' }; yield { type: 'complete', exitCode: 0 }; },
        stopOwned: async () => undefined,
        runLifecyclePlan: async () => ({ terminalName: 'test-lifecycle', exitCode: 0, output: '', steps: [] }),
      } as unknown as WorkspaceHubTerminalCoordinator,
      sessions,
      spaces,
      environments,
      serviceManager: {
        list: async () => [],
        start: async () => { throw new Error('not configured'); },
        stop: async () => { throw new Error('not configured'); },
      },
      secrets,
      resolveInspectorBaseCommit: async () => {
        if (!savedInspectorBase) throw new Error('Base comparison checkpoint is unavailable');
        return savedInspectorBase;
      },
      projectEvents,
      factEvents: events.facts,
      projects: projectAuthority,
      machines: async () => fleet,
      spacePlacements: async () => [
        ...database.listProjects().flatMap((project) => database.listSpaces(project.id)).map((space) => ({
          spaceId: space.id, projectId: space.projectId, kind: space.kind === 'worktree' ? 'worktree' as const : 'base' as const,
          holderId: retryPlacementMoved && space.id === 'project-a' ? 'machine-b' : space.holderId, state: space.placementState, generation: space.generation,
        })),
        ...(!database.getSpace('remote-workspace') ? [{
          spaceId: 'remote-workspace', projectId: 'project-a', kind: 'worktree' as const,
          holderId: 'unassigned', state: 'closed', generation: remoteSpaceGeneration,
        }] : []),
        ...cloudPlacements,
      ],
      checkpointMetadata: async (_projectId, spaceId) => {
        const session = sessions.list(spaceId)[0];
        const space = database.getSpace(spaceId);
        return session && space?.placementState === 'closed'
          ? { sessionId: session.id, generation: space.generation, lastMachineId: 'machine-a' }
          : null;
      },
      checkpointTranscript: async (_projectId, spaceId) => {
        const session = sessions.list(spaceId)[0];
        const space = database.getSpace(spaceId);
        if (!session || space?.placementState !== 'closed') return null;
        return {
          sessionId: session.id,
          generation: space.generation,
          lastMachineId: 'machine-a',
          events: [{ ordinal: 1, kind: 'message_end', payload: { source: 'checkpoint' }, createdAt: new Date().toISOString() }],
        };
      },
      updateMachine: async (machineId, notes) => {
        const machine = fleet.find((candidate) => candidate.id === machineId);
        if (!machine) throw new Error('missing machine');
        machine.notes = notes;
        return machine;
      },
      createSandbox: async () => ({ id: 'sandbox-a', label: 'Sandbox A', state: 'offline', rpcEndpoint: null, kind: 'sandbox', provider: 'cloudflare-sandbox', notes: 'Provisioning', desiredState: 'offline', lifecycleRevision: 1, operationId: null, error: null }),
      controlMachine: async (action, machineId) => ({ id: machineId, label: machineId === 'machine-a' ? 'Machine A' : 'Sandbox A', state: action === 'sleep' ? 'offline' : 'online', rpcEndpoint: action === 'sleep' ? null : 'https://machine.example/rpc', kind: machineId === 'machine-a' ? 'physical' : 'sandbox', provider: machineId === 'machine-a' ? 'physical' : 'cloudflare-sandbox', notes: action, desiredState: action === 'sleep' ? 'offline' : 'online', lifecycleRevision: 1, operationId: null, error: null }),
      destroyMachine: async (machineId) => ({ machineId, removed: true }),
      machineId: 'machine-a',
      devices,
      deployment: {
        status: async () => tenantDeployment,
        launch: (input) => { launches.push(input); throw new Error('not built in tests'); },
        launchProgress: () => null,
        revert: async () => ({ ...tenantDeployment, desired: { worker: null, machine: null, frontend: null, updatedAt: '2026-08-31T00:00:00.000Z' } }),
        thisMachine: { sha: 'rel-1', generation: 'sha256:' + 'c'.repeat(64) },
      },
    });
    const handler = createSignedRpcHandler({
      handler: rpc.handler,
      lookupDevice: (deviceId) => devices.lookup(deviceId),
      procedureKind: rpc.procedureKind,
      workspaceProject: (workspaceId) => database.getSpace(workspaceId)?.projectId ?? null,
    });
    const http = startGitSpaceRpcHttpServer({ handler });
    const client = createBrowserClient({
      contract: gitspaceContract,
      transport: fetchTransport({ url: `${http.url}/rpc`, fetch: createSignedRpcFetch({ deviceId: browserDeviceId, signingPrivateKey: browserPrivateKey }) }),
    });
    const writer = createBrowserClient({
      contract: gitspaceContract,
      transport: fetchTransport({ url: `${http.url}/rpc`, fetch: createSignedRpcFetch({ deviceId: writerDeviceId, signingPrivateKey: writerPrivateKey }) }),
    });
    const tunneledClient = createBrowserClient({
      contract: gitspaceContract,
      transport: fetchTransport({
        url: 'https://relay.gssh.dev/u/u-test/tunnel/machine-a/rpc',
        fetch: createSignedRpcFetch({
          deviceId: browserDeviceId,
          signingPrivateKey: browserPrivateKey,
          fetch: Object.assign(async (input: RequestInfo | URL) => {
            const forwarded = new Request(input);
            const target = new URL(forwarded.url);
            const body = await forwarded.arrayBuffer();
            const headers = new Headers(forwarded.headers);
            headers.set('x-gitspace-signed-target', `${target.pathname}${target.search}`);
            return fetch(`${http.url}/rpc`, {
              method: forwarded.method,
              headers,
              body: body.byteLength > 0 ? body : null,
            });
          }, { preconnect: fetch.preconnect }),
        }),
      }),
    });

    // Unsigned and under-privileged callers never reach the router.
    const anonymous = createBrowserClient({ contract: gitspaceContract, transport: fetchTransport({ url: `${http.url}/rpc` }) });
    expect((await anonymous.space.view({ projectId: 'project-a', workspaceId: 'workspace-a' })).status).toBe('error');
    const reader = createBrowserClient({ contract: gitspaceContract, transport: fetchTransport({ url: `${http.url}/rpc`, fetch: createSignedRpcFetch({ deviceId: readerDeviceId, signingPrivateKey: readerPrivateKey }) }) });
    expect((await reader.space.view({ projectId: 'project-a', workspaceId: 'workspace-a' })).status).toBe('ok');
    expect(await collectTranscript(reader.transcript({ projectId: 'project-a', workspaceId: 'workspace-a' }))).toEqual([]);
    const unsignedTranscript = await anonymous.transcript({ projectId: 'project-a', workspaceId: 'workspace-a' })[Symbol.asyncIterator]().next();
    expect(unsignedTranscript.value?.status).toBe('error');
    expect((await tunneledClient.space.view({ projectId: 'project-a', workspaceId: 'workspace-a' })).status).toBe('ok');
    expect((await reader.secrets.put({ projectId: 'project-a', name: 'X', value: 'y' })).status).toBe('error');
    const deploymentStatus = await reader.deployment.status({});
    if (deploymentStatus.status === 'error') throw deploymentStatus.error;
    expect(deploymentStatus.value.thisMachine).toMatchObject({ machineId: 'machine-a', sha: 'rel-1' });
    expect(deploymentStatus.value.desired).toEqual({ worker: null, machine: 'rel-1', frontend: null, updatedAt: '2026-08-31T00:00:00.000Z' });
    expect(deploymentStatus.value.current.machines['machine-a']).toMatchObject({ sha: 'rel-1' });
    // Launching is a `deployment.control` mutation: a read-only device is refused before the launcher runs.
    expect((await reader.deployment.launch({ workspaceId: 'workspace-a', targets: ['machine'] })).status).toBe('error');
    expect(launches).toEqual([]);
    const listedDevices = await client.devices.list({});
    if (listedDevices.status === 'error') throw listedDevices.error;
    expect(listedDevices.value.map((device) => [device.deviceId, device.current])).toEqual([[browserDeviceId, true], [readerDeviceId, false], [writerDeviceId, false]]);
    expect((await client.devices.revoke({ deviceId: readerDeviceId })).status).toBe('ok');
    expect((await reader.space.view({ projectId: 'project-a', workspaceId: 'workspace-a' })).status).toBe('error');

    const initial = await client.space.view({ projectId: 'project-a', workspaceId: 'workspace-a' });
    expect(initial.status).toBe('ok');
    if (initial.status === 'error') throw initial.error;
    expect(initial.value.project.name).toBe('GitSpace');
    expect(initial.value.workspaces[0]?.possessedBy).toBeNull();
    expect(initial.value.eventOffset).toBe(0);

    cloudPlacements.push({ spaceId: 'cloud-only-space', projectId: 'cloud-only-project', kind: 'worktree', holderId: 'machine-b', state: 'open', generation: 1 });
    expect(database.getSpace('cloud-only-space')).toBeNull();
    expect(await client.placements({})).toMatchObject({ status: 'ok', value: { spaces: expect.arrayContaining([
      { spaceId: 'cloud-only-space', projectId: 'cloud-only-project', kind: 'worktree', holderId: 'machine-b', state: 'open', generation: 1, endpoint: null },
    ]) } });
    cloudPlacements[0]!.holderId = 'machine-c';
    expect(await client.placements({})).toMatchObject({ status: 'ok', value: { spaces: expect.arrayContaining([
      { spaceId: 'cloud-only-space', holderId: 'machine-c' },
    ].map((space) => expect.objectContaining(space))) } });
    const putSecret = await client.secrets.put({ projectId: 'project-a', name: 'API_TOKEN', value: 'write-only' });
    expect(putSecret).toMatchObject({ status: 'ok', value: { name: 'API_TOKEN', revision: 1 } });
    const listedSecrets = await client.secrets.list({ projectId: 'project-a' });
    expect(listedSecrets).toMatchObject({ status: 'ok', value: [{ name: 'API_TOKEN', revision: 1 }] });
    const deletedSecret = await client.secrets.delete({ projectId: 'project-a', name: 'API_TOKEN' });
    expect(deletedSecret).toMatchObject({ status: 'ok', value: { deleted: true } });

    const unpossessed = await client.session.create({ workspaceId: 'workspace-a' });
    expect(unpossessed.status).toBe('error');
    if (unpossessed.status === 'ok') throw new Error('Expected unpossessed failure');
    expect(rpcErrors.agentFailure.is(unpossessed.error)).toBe(true);
    expect(unpossessed.error.data).toMatchObject({ domain: 'agent', code: 'AGENT_POSSESSION_DENIED', context: { workspaceId: 'workspace-a' } });
    expect(database.possessSpace('project-a', 'machine-a').status).toBe('ok');

    const possessed = handlers.possessSpace({ spaceId: 'workspace-a', holderId: 'machine-a' });
    expect(possessed.status).toBe('ok');
    const created = await client.session.create({ workspaceId: 'workspace-a' });
    expect(created.status).toBe('ok');
    if (created.status === 'error') throw created.error;
    expect(created.value.createdAt).toBeInstanceOf(Date);
    const unavailableControl = await client.session.control({ sessionId: created.value.id });
    expect(unavailableControl.status).toBe('error');
    if (unavailableControl.status === 'ok') throw new Error('Expected runtime control rejection');
    expect(rpcErrors.agentFailure.is(unavailableControl.error)).toBe(true);
    expect(unavailableControl.error.data).toMatchObject({ domain: 'agent', code: 'AGENT_RUNTIME_FAILED', context: { sessionId: created.value.id } });
    const unavailableThinking = await client.session.setThinking({ sessionId: created.value.id, thinking: 'high' });
    expect(unavailableThinking.status).toBe('error');
    if (unavailableThinking.status === 'ok') throw new Error('Expected runtime mutation rejection');
    expect(rpcErrors.agentFailure.is(unavailableThinking.error)).toBe(true);
    expect(unavailableThinking.error.data).toMatchObject({ domain: 'agent', code: 'AGENT_RUNTIME_FAILED', context: { sessionId: created.value.id } });
    expect((await client.workspace.setPhase({ workspaceId: 'workspace-a', phase: 'plan' })).status).toBe('ok');
    expect((await client.session.prompt({ sessionId: created.value.id, text: 'blocked in plan', streamingBehavior: 'followUp', images: [] })).status).toBe('error');
    expect((await client.workspace.setPhase({ workspaceId: 'workspace-a', phase: 'code' })).status).toBe('ok');
    const commitPhase = projectAuthority.setWorkspacePhase;
    projectAuthority.setWorkspacePhase = async () => { throw new Error('Authority rejected phase revision'); };
    expect((await client.workspace.setPhase({ workspaceId: 'workspace-a', phase: 'plan' })).status).toBe('error');
    expect(database.getWorkspace('workspace-a')?.phase).toBe('code');
    projectAuthority.setWorkspacePhase = commitPhase;

    const resumePoint = await client.space.view({ projectId: 'project-a', workspaceId: 'workspace-a' });
    if (resumePoint.status === 'error') throw resumePoint.error;
    const streamController = new AbortController();
    const stream = client.events({ projectId: 'project-a', after: null }, { signal: streamController.signal })[Symbol.asyncIterator]();
    const snapshot = await stream.next();
    if (snapshot.done || snapshot.value.status === 'error') throw new Error('Expected fact stream snapshot');
    expect(snapshot.value.value).toMatchObject({ type: 'snapshot', previous: null, cursor: resumePoint.value.eventOffset, value: null });
    let streamState = applyStreamEvent(initialStreamState(snapshot.value.value.resource), snapshot.value.value);
    const observedEventIds: string[] = [];
    let transcriptAppends = 0;
    const firstChange = stream.next();

    const prompted = await client.session.prompt({ sessionId: created.value.id, text: 'ship it', streamingBehavior: 'followUp', images: [] });
    expect(prompted.status).toBe('ok');
    const usage = await client.session.usage({ sessionId: created.value.id });
    expect(usage).toMatchObject({ status: 'ok', value: { sessionId: created.value.id, childSessions: 0, byModel: [], byAgent: [], totals: { requests: 0, costUsd: 0 } } });
    const missingUsage = await client.session.usage({ sessionId: 'nope' });
    expect(missingUsage.status).toBe('error');
    if (missingUsage.status === 'ok') throw new Error('Expected missing session failure');
    expect(rpcErrors.sessionNotFound.is(missingUsage.error)).toBe(true);
    expect(runtime.promptBehaviors).toContain('followUp');
    // A mutation racing the first read is delivered once, without waiting for cloud delivery.
    let next = await firstChange;
    while (true) {
      if (next.done || next.value.status === 'error') throw new Error('Expected live fact change');
      const frame = next.value.value;
      if (frame.type !== 'change' || frame.value === null) throw new Error('Expected a durable fact');
      expect(frame.cursor).toBeGreaterThan(streamState.cursor!);
      streamState = applyStreamEvent(streamState, frame);
      expect(streamState.resync).toBe(false);
      observedEventIds.push(frame.value.eventId);
      expect(frame.value.createdAt).toBeInstanceOf(Date);
      if (frame.value.entity === 'transcript' && frame.value.operation === 'append') transcriptAppends += 1;
      if (frame.value.entity === 'artifact-scope') break;
      next = await stream.next();
    }
    expect(transcriptAppends).toBe(1);
    streamController.abort();
    await stream.return?.();

    // One transition happens while disconnected; the next races the reconnect.
    expect((await client.workspace.setPhase({ workspaceId: 'workspace-a', phase: 'plan' })).status).toBe('ok');
    await events.flush();
    const resumedController = new AbortController();
    const resumedStream = client.events({ projectId: 'project-a', after: streamState.cursor }, { signal: resumedController.signal })[Symbol.asyncIterator]();
    const resumedNext = resumedStream.next();
    expect((await client.workspace.setPhase({ workspaceId: 'workspace-a', phase: 'code' })).status).toBe('ok');
    const phases: unknown[] = [];
    next = await resumedNext;
    while (true) {
      if (next.done || next.value.status === 'error') throw new Error('Expected replayed transition');
      const frame = next.value.value;
      if (frame.type !== 'change' || frame.value === null) throw new Error('Expected a replayed fact');
      expect(frame.cursor).toBeGreaterThan(streamState.cursor!);
      streamState = applyStreamEvent(streamState, frame);
      expect(streamState.resync).toBe(false);
      observedEventIds.push(frame.value.eventId);
      if (frame.value.entity === 'workspace' && 'phase' in frame.value.payload) {
        phases.push(frame.value.payload.phase);
        if (frame.value.payload.phase === 'code') break;
      }
      next = await resumedStream.next();
    }
    expect(phases).toEqual(['plan', 'code']);
    expect(new Set(observedEventIds).size).toBe(observedEventIds.length);
    resumedController.abort();
    await resumedStream.return?.();

    // Acceptance returns while the runner is still active; retrying never creates another run.
    const checksInput = { spaceId: 'workspace-a', runId: 'checks-rpc', deadlineAt: new Date(Date.now() + 60_000).toISOString() };
    const acceptedChecks = await client.environment.runChecks(checksInput);
    if (acceptedChecks.status === 'error') throw acceptedChecks.error;
    expect(isLifecycleRunActive(acceptedChecks.value)).toBe(true);
    expect(acceptedChecks.value).toMatchObject({ id: checksInput.runId, phase: 'checks', deadlineAt: checksInput.deadlineAt, finishedAt: null });
    await runnerStarted.promise;
    const retriedChecks = await client.environment.runChecks(checksInput);
    expect(retriedChecks).toMatchObject({ status: 'ok', value: { id: checksInput.runId, finishedAt: null } });
    const runningEnvironment = await client.environment.get({ spaceId: 'workspace-a' });
    if (runningEnvironment.status === 'error') throw runningEnvironment.error;
    expect(runningEnvironment.value.runs.map((run) => run.id)).toEqual([checksInput.runId]);
    const reusedRun = await client.environment.runPhase({ ...checksInput, phase: 'machine/prepare', rerun: false });
    if (reusedRun.status === 'ok') throw new Error('Expected durable run identity conflict');
    expect(rpcErrors.environmentFailure.is(reusedRun.error)).toBe(true);
    expect(reusedRun.error.data).toMatchObject({ code: 'RunConflict', context: { runId: checksInput.runId } });
    const missingRun = await client.environment.cancelRun({ spaceId: 'workspace-a', runId: 'unknown-run' });
    if (missingRun.status === 'ok') throw new Error('Expected unknown lifecycle run failure');
    expect(rpcErrors.environmentFailure.is(missingRun.error)).toBe(true);
    expect(missingRun.error.data).toMatchObject({ code: 'NotFound', context: { runId: 'unknown-run' } });
    const terminalInput = { spaceId: 'workspace-a', name: acceptedChecks.value.terminalName! };
    expect((await writer.terminals.stop(terminalInput)).status).toBe('error');
    const stillRunning = await client.environment.get({ spaceId: 'workspace-a' });
    if (stillRunning.status === 'error') throw stillRunning.error;
    expect(stillRunning.value.runs[0]?.cancelRequestedAt).toBeNull();
    expect((await client.terminals.stop(terminalInput)).status).toBe('ok');
    const cancelled = await client.environment.cancelRun({ spaceId: 'workspace-a', runId: checksInput.runId });
    expect(cancelled).toMatchObject({ status: 'ok', value: { id: checksInput.runId, status: 'cancelling', finishedAt: null } });
    await stopRequested.promise;
    // A late successful process result cannot undo an already accepted cancellation.
    execution.resolve({ terminalName: 'checks', exitCode: 0, output: '', steps: [] });
    await runSettled.promise;
    const cancelledEnvironment = await client.environment.get({ spaceId: 'workspace-a' });
    if (cancelledEnvironment.status === 'error') throw cancelledEnvironment.error;
    expect(cancelledEnvironment.value.runs).toMatchObject([{
      id: checksInput.runId, status: 'cancelled', failure: { code: 'Cancelled', context: { runId: checksInput.runId } },
    }]);
    expect(cancelledEnvironment.value.runs[0]?.finishedAt).not.toBeNull();
    expect(await client.environment.runChecks(checksInput)).toMatchObject({ status: 'ok', value: { id: checksInput.runId, status: 'cancelled' } });

    execution = Promise.withResolvers<WorkspaceLifecyclePlanResult>();
    runnerStarted = Promise.withResolvers<void>();
    runSettled = Promise.withResolvers<void>();
    const phaseInput = { spaceId: 'workspace-a', runId: 'prepare-rpc', phase: 'machine/prepare' as const, rerun: false, interactive: true, deadlineAt: checksInput.deadlineAt };
    const acceptedPhase = await client.environment.runPhase(phaseInput);
    if (acceptedPhase.status === 'error') throw acceptedPhase.error;
    expect(isLifecycleRunActive(acceptedPhase.value)).toBe(true);
    expect(acceptedPhase.value).toMatchObject({ id: phaseInput.runId, phase: phaseInput.phase, deadlineAt: phaseInput.deadlineAt, finishedAt: null });
    await runnerStarted.promise;
    const protectedInput = { spaceId: 'workspace-a', name: acceptedPhase.value.terminalName! };
    const deniedLive = await writer.terminals.live(protectedInput)[Symbol.asyncIterator]().next();
    expect(deniedLive.value?.status).toBe('error');
    expect((await writer.terminals.send({ ...protectedInput, data: 'fake-code\n' })).status).toBe('error');
    const browserLive = await collectResults(client.terminals.live(protectedInput));
    expect(browserLive).toEqual([Result.ok({ type: 'output', data: 'protected fixture output' }), Result.ok({ type: 'complete', exitCode: 0 })]);
    execution.resolve({ terminalName: 'prepare', exitCode: 0, output: '', steps: [] });
    await runSettled.promise;
    const preparedEnvironment = await client.environment.get({ spaceId: 'workspace-a' });
    if (preparedEnvironment.status === 'error') throw preparedEnvironment.error;
    expect(preparedEnvironment.value.runs).toMatchObject([
      { id: phaseInput.runId, status: 'succeeded', failure: null },
      { id: checksInput.runId, status: 'cancelled' },
    ]);

    const refreshed = await client.space.view({ projectId: 'project-a', workspaceId: 'workspace-a' });
    expect(refreshed.status).toBe('ok');
    if (refreshed.status === 'error') throw refreshed.error;
    expect(refreshed.value.mainAgent).toMatchObject({ id: created.value.id });
    const workspaceTranscript = await collectTranscript(client.transcript({ projectId: 'project-a', workspaceId: 'workspace-a' }));
    expect(workspaceTranscript).toMatchObject([{ sessionId: created.value.id, kind: 'message_end', payload: { text: 'done:ship it' }, createdAt: expect.any(Date) }]);
    expect(refreshed.value.artifacts.map((artifact) => artifact.path)).toContain('rpc.txt');

    expect(database.createWorkspace({ id: 'workspace-b', projectId: 'project-a', name: 'stacked', branch: 'stacked', rootPath: join(root, 'repo', 'workspaces', 'b'), phase: 'code' }).status).toBe('ok');
    const related = await client.workspace.setRelations({ workspaceId: 'workspace-b', dependsOn: [], relatedTo: [], stackedOn: 'workspace-a' });
    expect(related.status).toBe('ok');
    if (related.status === 'error') throw related.error;
    expect(related.value).toMatchObject({
      id: 'workspace-b',
      relations: { dependsOn: ['workspace-a'], relatedTo: [], stackedOn: 'workspace-a' },
      stack: { blockedBy: ['workspace-a'], blocking: [], findings: [{ code: 'dependency-open', workspaceId: 'workspace-a' }] },
    });
    const relatedBootstrap = await client.space.view({ projectId: 'project-a', workspaceId: null });
    if (relatedBootstrap.status === 'error') throw relatedBootstrap.error;
    expect(relatedBootstrap.value.workspaces.find((workspace) => workspace.id === 'workspace-a')?.stack.blocking).toEqual(['workspace-b']);
    const tooFar = await client.workspace.setPhase({ workspaceId: 'workspace-b', phase: 'review' });
    expect(tooFar.status).toBe('error');
    if (tooFar.status === 'ok') throw new Error('Expected phase ceiling failure');
    expect(tooFar.error.data).toMatchObject({ domain: 'workspace', code: 'WORKSPACE_PHASE_CEILING' });
    expect(database.getWorkspace('workspace-b')?.phase).toBe('code');
    const status = await client.workspace.stackStatus({ workspaceId: 'workspace-b' });
    expect(status.status).toBe('error');
    if (status.status === 'ok') throw new Error('Expected stack status to need a materialized workspace');
    expect(rpcErrors.operationFailed.is(status.error)).toBe(true);
    const selfRelated = await client.workspace.setRelations({ workspaceId: 'workspace-b', dependsOn: ['workspace-b'], relatedTo: [], stackedOn: null });
    expect(selfRelated.status).toBe('error');
    if (selfRelated.status === 'ok') throw new Error('Expected self relation failure');
    expect(selfRelated.error.data).toMatchObject({ domain: 'workspace', code: 'WORKSPACE_RELATIONS_INVALID' });
    const unknownRelated = await client.workspace.setRelations({ workspaceId: 'workspace-b', dependsOn: [], relatedTo: ['workspace-z'], stackedOn: null });
    expect(unknownRelated.status).toBe('error');
    if (unknownRelated.status === 'ok') throw new Error('Expected unknown relation failure');
    expect(unknownRelated.error.data).toMatchObject({ domain: 'workspace', code: 'WORKSPACE_NOT_FOUND', context: { relatedId: 'workspace-z' } });
    expect(database.deleteWorkspace('workspace-b')).toBe(true);

    expect((await client.space.reopen({ spaceId: 'remote-workspace', expectedGeneration: 5 })).status).toBe('error');
    expect(await client.space.reopen({ spaceId: 'remote-workspace', expectedGeneration: 6 })).toMatchObject({
      status: 'ok', value: { id: 'remote-workspace', state: 'active', machineId: 'machine-a', generation: 7 },
    });
    expect(await client.space.close({ spaceId: 'remote-workspace', expectedGeneration: 7 })).toMatchObject({
      status: 'ok', value: { state: 'closed', generation: 8 },
    });
    expect(database.getSpace('remote-workspace')).toBeNull();
    cleanupBlocked = true;
    expect((await client.space.close({ spaceId: 'remote-workspace', expectedGeneration: 7 })).status).toBe('error');
    cleanupBlocked = false;
    expect(await client.space.close({ spaceId: 'remote-workspace', expectedGeneration: 7 })).toMatchObject({
      status: 'ok', value: { id: 'remote-workspace', state: 'archived', machineId: null, generation: 8 },
    });
    expect((await client.space.close({ spaceId: 'remote-workspace', expectedGeneration: 5 })).status).toBe('error');
    expect(await client.workspace.restore({ spaceId: 'remote-workspace', expectedGeneration: 8 })).toMatchObject({
      status: 'ok', value: { id: 'remote-workspace', state: 'active', machineId: 'machine-a', generation: 9 },
    });
    expect(await client.space.close({ spaceId: 'remote-workspace', expectedGeneration: 9 })).toMatchObject({
      status: 'ok', value: { state: 'closed', generation: 10 },
    });
    // Another machine claimed and released it; only cloud placement remains.
    remoteSpaceGeneration = 10;
    expect((await client.space.reopen({ spaceId: 'remote-workspace', expectedGeneration: 8 })).status).toBe('error');
    expect(await client.space.reopen({ spaceId: 'remote-workspace', expectedGeneration: 10 })).toMatchObject({
      status: 'ok', value: { id: 'remote-workspace', state: 'active', machineId: 'machine-a', generation: 11 },
    });

    const runtimeClosed = await client.space.close({ spaceId: 'workspace-a', expectedGeneration: 1 });
    if (runtimeClosed.status === 'error') throw runtimeClosed.error;
    expect(runtimeClosed.value).toMatchObject({ id: 'workspace-a', state: 'closed', machineId: null, generation: 2 });
    expect(database.getWorkspace('workspace-a')?.closedAt).toBeNull();
    expect((await client.space.close({ spaceId: 'workspace-a', expectedGeneration: 1 })).status).toBe('ok');

    const runtimeReopened = await client.space.reopen({ spaceId: 'workspace-a', expectedGeneration: 2 });
    expect(runtimeReopened.status).toBe('ok');
    if (runtimeReopened.status === 'error') throw runtimeReopened.error;
    expect(runtimeReopened.value).toMatchObject({ id: 'workspace-a', state: 'active', machineId: 'machine-a', generation: 3 });
    expect((await client.space.reopen({ spaceId: 'workspace-a', expectedGeneration: 2 })).status).toBe('error');
    expect((await client.space.reopen({ spaceId: 'workspace-a', expectedGeneration: 3 })).status).toBe('ok');

    await spaces.close(database.getSpace('workspace-a')!, 3);
    database.setSpaceClosed('workspace-a', true);

    // Closed metadata stays readable without projecting or opening the checkpoint transcript.
    const closedBootstrap = await client.space.view({ projectId: 'project-a', workspaceId: 'workspace-a' });
    if (closedBootstrap.status === 'error') throw closedBootstrap.error;
    expect(closedBootstrap.status).toBe('ok');
    expect(closedBootstrap.value.mainAgent).toBeNull();
    expect(closedBootstrap.value.checkpoint).toEqual({ sessionId: created.value.id, generation: 4, lastMachineId: 'machine-a' });
    const closedTranscript = await collectTranscript(client.transcript({ projectId: 'project-a', workspaceId: 'workspace-a' }));
    expect(closedTranscript).toMatchObject([{ sessionId: created.value.id, kind: 'message_end', payload: { source: 'checkpoint' } }]);
    expect(closedBootstrap.value.workspaces.find((workspace) => workspace.id === 'workspace-a')).toMatchObject({ possessedBy: null, closedAt: expect.any(Date) });

    const reopened = await client.workspace.restore({ spaceId: 'workspace-a', expectedGeneration: 4 });
    expect(reopened.status).toBe('ok');
    if (reopened.status === 'error') throw reopened.error;
    expect(reopened.value).toMatchObject({ id: 'workspace-a', kind: 'worktree', state: 'active', machineId: 'machine-a', generation: 5 });

    const reopenedBootstrap = await client.space.view({ projectId: 'project-a', workspaceId: 'workspace-a' });
    expect(reopenedBootstrap.status).toBe('ok');
    if (reopenedBootstrap.status === 'error') throw reopenedBootstrap.error;
    expect(reopenedBootstrap.value.mainAgent).toMatchObject({ id: created.value.id, state: 'active', resumePending: false, renderState: 'waiting' });
    runtime.controls = {
      sessionId: created.value.ompSessionId, role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false,
      approvalMode: 'always-ask', planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null,
      history: [], historyAnchorId: null,
    };
    // MCP clients poll session.control to learn when a turn ended; it must agree with the space view.
    expect(await client.session.control({ sessionId: created.value.id })).toMatchObject({ status: 'ok', value: { renderState: 'waiting', activity: { active: false } } });
    runtime.controls = null;
    expect(await collectTranscript(client.transcript({ projectId: 'project-a', workspaceId: 'workspace-a' }))).toEqual(workspaceTranscript);

    const projectAgent = await client.session.createProject({ projectId: 'project-a' });
    expect(projectAgent.status).toBe('ok');
    if (projectAgent.status === 'error') throw projectAgent.error;
    expect(projectAgent.value).toMatchObject({ projectId: 'project-a', workspaceId: null, scope: 'project', controlsAvailable: true });
    expect(projectAgent.value.id).not.toBe(created.value.id);

    const projectBootstrap = await client.space.view({ projectId: 'project-a', workspaceId: null });
    expect(runtime.created).toContainEqual({ workingDirectory: join(root, 'repo'), sessionKey: 'space:project-a' });
    expect(runtime.created).toContainEqual({ workingDirectory: workspaceRoot, sessionKey: 'space:workspace-a' });
    expect(projectBootstrap.status).toBe('ok');
    if (projectBootstrap.status === 'error') throw projectBootstrap.error;
    expect(projectBootstrap.value.mainAgent).toMatchObject({ id: projectAgent.value.id, scope: 'project', workspaceId: null, controlsAvailable: true });
    expect(await collectTranscript(client.transcript({ projectId: 'project-a', workspaceId: null }))).toEqual([]);

    await sessions.close(projectAgent.value.id);
    sessions.recordFailure('project-a', 'recover', new Error('Provider configuration could not be loaded'), sessions.beginOperation('project-a', 'recovery'));
    const failedBase = await client.space.view({ projectId: 'project-a', workspaceId: null });
    if (failedBase.status === 'error') throw failedBase.error;
    expect(failedBase.value.mainAgent).toMatchObject({
      id: projectAgent.value.id, state: 'closed', controlsAvailable: false,
      health: { issues: { recovery: { failure: { domain: 'agent', code: 'AGENT_RECOVERY_FAILED', context: { sessionId: projectAgent.value.id } } } } },
    });
    retryPlacementMoved = true;
    expect((await client.space.reopen({ spaceId: 'project-a', expectedGeneration: 1 })).status).toBe('error');
    expect(sessions.controlsAvailable(projectAgent.value.id)).toBe(false);
    retryPlacementMoved = false;
    expect((await client.space.reopen({ spaceId: 'project-a', expectedGeneration: 1 })).status).toBe('ok');
    const retriedBase = await client.space.view({ projectId: 'project-a', workspaceId: null });
    if (retriedBase.status === 'error') throw retriedBase.error;
    expect(retriedBase.value.mainAgent).toMatchObject({ id: projectAgent.value.id, controlsAvailable: true, health: { issues: { recovery: { failure: null, incidentId: null } } } });

    const projectStreamController = new AbortController();
    const projectArtifactStream = client.events({ projectId: 'project-a', after: projectBootstrap.value.eventOffset }, { signal: projectStreamController.signal })[Symbol.asyncIterator]();
    expect((await client.session.prompt({ sessionId: projectAgent.value.id, text: 'update base', streamingBehavior: 'steer', images: [] })).status).toBe('ok');
    while (true) {
      const event = await projectArtifactStream.next();
      if (event.done) throw new Error('Project event stream ended before artifact synchronization');
      if (event.value.status === 'error') throw event.value.error;
      if (event.value.value.type === 'change' && event.value.value.value?.entity === 'artifact-scope') break;
    }
    projectStreamController.abort();
    await projectArtifactStream.return?.();
    const projectRefreshed = await client.space.view({ projectId: 'project-a', workspaceId: null });
    expect(projectRefreshed.status).toBe('ok');
    if (projectRefreshed.status === 'error') throw projectRefreshed.error;
    expect(await collectTranscript(client.transcript({ projectId: 'project-a', workspaceId: null }))).toMatchObject([
      { sessionId: projectAgent.value.id, kind: 'message_end', payload: { text: 'done:update base' } },
    ]);
    expect(projectRefreshed.value.artifacts).toContainEqual(expect.objectContaining({ path: 'rpc.txt', scope: 'base', workspaceId: null }));

    const isolatedWorkspace = await client.space.view({ projectId: 'project-a', workspaceId: 'workspace-a' });
    expect(isolatedWorkspace.status).toBe('ok');
    if (isolatedWorkspace.status === 'error') throw isolatedWorkspace.error;
    expect(isolatedWorkspace.value.mainAgent).toMatchObject({ id: created.value.id, scope: 'workspace', workspaceId: 'workspace-a' });
    expect(await collectTranscript(client.transcript({ projectId: 'project-a', workspaceId: 'workspace-a' }))).toEqual(workspaceTranscript);

    const noted = await client.machine.updateNotes({ machineId: 'machine-a', notes: 'Docker and Android SDK' });
    expect(noted.status).toBe('ok');
    if (noted.status === 'error') throw noted.error;
    expect(noted.value.notes).toBe('Docker and Android SDK');
    const sandbox = await client.machine.createSandbox({});
    expect(sandbox.status).toBe('ok');
    if (sandbox.status === 'error') throw sandbox.error;
    expect(sandbox.value).toMatchObject({ kind: 'sandbox', state: 'offline' });
    const physicalSlept = await client.machine.sleep({ machineId: 'machine-a' });
    expect(physicalSlept.status).toBe('ok');
    if (physicalSlept.status === 'error') throw physicalSlept.error;
    expect(physicalSlept.value).toMatchObject({ kind: 'physical', state: 'offline' });
    const physicalResumed = await client.machine.resume({ machineId: 'machine-a' });
    expect(physicalResumed.status).toBe('ok');
    if (physicalResumed.status === 'error') throw physicalResumed.error;
    expect(physicalResumed.value).toMatchObject({ kind: 'physical', state: 'online' });
    const slept = await client.machine.sleep({ machineId: 'sandbox-a' });
    expect(slept.status).toBe('ok');
    if (slept.status === 'error') throw slept.error;
    expect(slept.value.state).toBe('offline');
    const resumed = await client.machine.resume({ machineId: 'sandbox-a' });
    expect(resumed.status).toBe('ok');
    if (resumed.status === 'error') throw resumed.error;
    expect(resumed.value).toMatchObject({ state: 'online', rpcEndpoint: 'https://machine.example/rpc' });
    const destroyed = await client.machine.destroy({ machineId: 'sandbox-a' });
    expect(destroyed.status).toBe('ok');
    if (destroyed.status === 'error') throw destroyed.error;
    expect(destroyed.value).toEqual({ machineId: 'sandbox-a', removed: true });

    const rpcKey = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
    const consumed = new Set<string>();
    const encryptedHandler = createEncryptedRpcHandler({
      handler,
      resolveKey: (sessionId) => sessionId === 'browser-session' ? rpcKey : null,
      consumeRequestId: (_sessionId, requestId) => {
        if (consumed.has(requestId)) return false;
        consumed.add(requestId);
        return true;
      },
    });
    const encryptedHttp = startGitSpaceRpcHttpServer({ handler: encryptedHandler });
    const encryptedClient = createBrowserClient({
      contract: gitspaceContract,
      transport: fetchTransport({
        url: `${encryptedHttp.url}/rpc`,
        fetch: createSignedRpcFetch({ deviceId: browserDeviceId, signingPrivateKey: browserPrivateKey, fetch: createEncryptedRpcFetch({ key: rpcKey, sessionId: 'browser-session' }) }),
      }),
    });
    const encryptedBootstrap = await encryptedClient.space.view({ projectId: 'project-a', workspaceId: 'workspace-a' });
    expect(encryptedBootstrap.status).toBe('ok');
    if (encryptedBootstrap.status === 'error') throw encryptedBootstrap.error;
    expect(await collectTranscript(encryptedClient.transcript({ projectId: 'project-a', workspaceId: 'workspace-a' }))).toEqual(workspaceTranscript);
    const encryptedController = new AbortController();
    const encryptedStream = encryptedClient.events({ projectId: 'project-a', after: null }, { signal: encryptedController.signal })[Symbol.asyncIterator]();
    const encryptedEvent = await encryptedStream.next();
    expect(encryptedEvent.value).toMatchObject({ status: 'ok', value: { type: 'snapshot', previous: null, value: null } });
    encryptedController.abort();
    await encryptedStream.return?.();
    await encryptedHttp.stop();

    // Hydrated spaces own only their restored branch, not the project's base ref.
    const baseRoot = join(root, 'repo');
    git(baseRoot, 'init', '-b', 'main');
    writeFileSync(join(baseRoot, 'portable.txt'), 'base\n');
    git(baseRoot, 'add', 'portable.txt');
    git(baseRoot, 'commit', '-m', 'canonical base');
    const baseCommit = git(baseRoot, 'rev-parse', 'HEAD');
    git(workspaceRoot, 'init', '-b', 'develop');
    git(workspaceRoot, 'fetch', baseRoot, 'refs/heads/main');
    git(workspaceRoot, 'reset', '--hard', 'FETCH_HEAD');
    writeFileSync(join(workspaceRoot, 'portable.txt'), 'workspace\n');
    git(workspaceRoot, 'add', 'portable.txt');
    git(workspaceRoot, 'commit', '-m', 'workspace change');
    writeFileSync(join(workspaceRoot, 'portable.txt'), 'working\n');
    savedInspectorBase = baseCommit;
    rmSync(baseRoot, { recursive: true });
    const repositoryRequest = { spaceId: 'workspace-a', expectedGeneration: database.getSpace('workspace-a')!.generation, mode: 'base' as const, path: 'portable.txt' };
    expect(await client.inspector.repository.status(repositoryRequest)).toMatchObject({
      status: 'ok', value: [expect.objectContaining({ path: 'portable.txt', status: 'modified' })],
    });
    for (const baseRef of [null, 'main', 'refs/heads/main']) {
      const diff = await client.inspector.repository.diff({ ...repositoryRequest, baseRef });
      expect(diff.status).toBe('ok');
      if (diff.status === 'error') throw diff.error;
      expect(diff.value.baseCommit).toBe(baseCommit);
      expect(diff.value.patch).toContain('-base\n+working\n');
    }
    const localDiff = await client.inspector.repository.diff({ ...repositoryRequest, baseRef: 'HEAD' });
    expect(localDiff.status).toBe('ok');
    if (localDiff.status === 'error') throw localDiff.error;
    expect(localDiff.value.patch).toContain('-workspace\n+working\n');
    savedInspectorBase = null;
    const unavailableBase = await client.inspector.repository.diff({ ...repositoryRequest, baseRef: null });
    expect(unavailableBase.status).toBe('error');
    const currentFile = await client.inspector.repository.file({ ...repositoryRequest, mode: 'current' });
    expect(currentFile).toMatchObject({ status: 'ok', value: { content: 'working\n' } });
    expect(await client.inspector.repository.status({ ...repositoryRequest, mode: 'working' })).toMatchObject({
      status: 'ok', value: [expect.objectContaining({ path: 'portable.txt', status: 'modified' })],
    });
    writeFileSync(join(workspaceRoot, 'portable.txt'), 'staged\n');
    git(workspaceRoot, 'add', 'portable.txt');
    const stagedDiff = await client.inspector.repository.diff({ ...repositoryRequest, mode: 'staged', baseRef: null });
    expect(stagedDiff.status).toBe('ok');
    if (stagedDiff.status === 'error') throw stagedDiff.error;
    expect(stagedDiff.value.patch).toContain('-workspace\n+staged\n');

    const beforeRecovery = database.getSpace('workspace-a')!;
    expect((await client.workspace.restore({
      spaceId: beforeRecovery.id, expectedGeneration: beforeRecovery.generation - 1,
    })).status).toBe('error');
    expect(database.getSpace(beforeRecovery.id)?.generation).toBe(beforeRecovery.generation);
    projectAuthority.setWorkspaceLifecycle = async () => {
      await spaces.release(beforeRecovery, beforeRecovery.generation);
      await spaces.open(beforeRecovery.id, beforeRecovery.generation + 1);
      return undefined;
    };
    expect(await client.workspace.restore({
      spaceId: beforeRecovery.id, expectedGeneration: beforeRecovery.generation,
    })).toMatchObject({
      status: 'ok', value: { state: 'active', machineId: 'machine-a', generation: beforeRecovery.generation + 2 },
    });
    expect(readFileSync(join(workspaceRoot, 'portable.txt'), 'utf8')).toBe('staged\n');

    expect((await sessions.close(created.value.id)).status).toBe('ok');
    expect((await sessions.close(projectAgent.value.id)).status).toBe('ok');
    await events.flush();
    devices.stop();
    await http.stop();
    database.close();
  });

  it('reads session links only for their owning workspace and current generation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-resource-rpc-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    database.createProject({ id: 'project-a', name: 'Resources', repositoryPath: join(root, 'repo') });
    for (const id of ['workspace-a', 'workspace-b']) {
      database.createWorkspace({ id, projectId: 'project-a', name: id, branch: id, rootPath: join(root, id) });
      database.possessWorkspace(id, 'machine-a');
    }
    const artifacts = new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'cache'), new Uint8Array(32));
    const events = new FactEventStore(database);
    const handlers = new GitSpaceHandlers(database, artifacts, events);
    const sessions = new MachineSessionCoordinator(database, artifacts, new RpcFakeOmpRuntime(), 'machine-a', join(root, 'runtime'), events);
    const created = await sessions.create('workspace-a');
    if (created.status === 'error') throw created.error;
    const context = sessions.getResourceContext(created.value.id)!;
    mkdirSync(context.localArtifactsDir, { recursive: true });
    writeFileSync(join(context.localArtifactsDir, 'private-output.txt'), 'Only workspace A can read this session output.');
    const unavailable = async (): Promise<never> => { throw new Error('Not configured in resource fixture'); };
    const rpc = createGitSpaceRpcHandler({
      database, handlers, artifacts, sessions, factEvents: events, machineId: 'machine-a',
      terminals: {} as WorkspaceHubTerminalCoordinator,
      spaces: { close: unavailable, release: unavailable, open: unavailable },
      serviceManager: { list: async () => [], start: unavailable, stop: unavailable },
      secrets: { listProjectSecrets: async () => [], putProjectSecret: unavailable, deleteProjectSecret: unavailable, materializeProjectSecrets: unavailable },
      projectEvents: { appendProjectEvent: unavailable, listProjectEvents: async () => [], latestProjectEventOffset: async () => 0 },
      projects: {
        list: async () => [], createProject: unavailable, openProject: unavailable, createWorkspace: unavailable,
        retryCreateWorkspace: unavailable,
        findWorkspace: async () => null,
        archiveWorkspace: unavailable, archiveProject: unavailable, restoreProject: unavailable, setBaseBranch: unavailable, deleteProject: unavailable, deleteWorkspace: unavailable,
        setWorkspaceLifecycle: unavailable, setWorkspacePhase: unavailable, runLifecycleOperation: unavailable,
      },
      machines: async () => [], spacePlacements: async () => [],
    });
    const http = startGitSpaceRpcHttpServer({ handler: rpc.handler });
    const client = createBrowserClient({ contract: gitspaceContract, transport: fetchTransport({ url: `${http.url}/rpc` }) });
    const input = {
      spaceId: 'workspace-a', expectedGeneration: database.getSpace('workspace-a')!.generation,
      sessionId: created.value.id, url: 'local://private-output.txt',
    };
    try {
      const text = 'Only workspace A can read this session output.';
      expect((await collectResourceBytes(client.inspector.resources.read(input), {
        url: input.url, mediaType: null, text: true, size: Buffer.byteLength(text),
      })).toString()).toBe(text);
      expect(await collectResults(client.inspector.resources.read({ ...input, expectedGeneration: input.expectedGeneration + 1 }))).toMatchObject([
        { status: 'error', error: { _tag: 'gitspace/space-generation-conflict' } },
      ]);
      expect(await collectResults(client.inspector.resources.read({
        ...input, spaceId: 'workspace-b', expectedGeneration: database.getSpace('workspace-b')!.generation,
      }))).toMatchObject([{ status: 'error', error: { _tag: 'gitspace/inspector-state' } }]);
      expect(await collectResults(client.inspector.resources.read({ ...input, sessionId: 'unknown-session' }))).toMatchObject([
        { status: 'error', error: { _tag: 'gitspace/inspector-state' } },
      ]);

      // A real PCM WAV larger than a single RPC frame must survive both read routes.
      const wav = Buffer.alloc(2 * 1024 * 1024 + 44);
      wav.write('RIFF', 0);
      wav.writeUInt32LE(wav.byteLength - 8, 4);
      wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16_000, 24);
      wav.writeUInt32LE(32_000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write('data', 36);
      wav.writeUInt32LE(wav.byteLength - 44, 40);
      for (let offset = 44; offset < wav.byteLength; offset += 2) wav.writeInt16LE((offset % 65_536) - 32_768, offset);
      const url = 'local://workspace/live-capture.wav';
      const published = await artifacts.write({ kind: 'workspace', projectId: 'project-a', workspaceId: 'workspace-a' }, url, wav);
      if (published.status === 'error') throw published.error;
      const metadata = { url, mediaType: 'audio/wav', text: false, size: wav.byteLength };
      expect(await collectResourceBytes(client.inspector.resources.read({ ...input, url }), metadata)).toEqual(wav);
      const artifactInput = { spaceId: input.spaceId, expectedGeneration: input.expectedGeneration, url, hash: published.value.hash };
      writeFileSync(join(context.localArtifactsDir, 'live-capture.wav'), wav);
      expect(await collectResourceBytes(client.inspector.resources.read({ ...input, url: 'local://live-capture.wav' }), {
        ...metadata, url: 'local://live-capture.wav',
      })).toEqual(wav);
      expect(await collectResourceBytes(client.inspector.artifacts.read(artifactInput), metadata)).toEqual(wav);
      expect(await collectResults(client.inspector.artifacts.read({ ...artifactInput, hash: `sha256:${'0'.repeat(64)}` }))).toMatchObject([
        { status: 'error', error: { _tag: 'gitspace/operation-failed' } },
      ]);
      expect(await collectResults(client.inspector.resources.read({ ...input, url: 'local://workspaces/workspace-b/private-output.txt' }))).toMatchObject([
        { status: 'error', error: { _tag: 'gitspace/operation-failed' } },
      ]);
      writeFileSync(join(context.localArtifactsDir, 'too-large.txt'), 'line\n'.repeat(30_000));
      expect(await collectResults(client.inspector.resources.read({ ...input, url: 'local://too-large.txt' }))).toMatchObject([
        { status: 'error', error: { _tag: 'gitspace/operation-failed' } },
      ]);
      expect((await collectResourceBytes(client.inspector.resources.read({ ...input, url: 'local://too-large.txt:1-1' }), {
        url: 'local://too-large.txt:1-1', mediaType: 'text/plain', text: true, size: 4,
      })).toString()).toBe('line');
      writeFileSync(join(context.localArtifactsDir, 'empty.txt'), '');
      expect(await collectResults(client.inspector.resources.read({ ...input, url: 'local://empty.txt' }))).toEqual([
        Result.ok({ type: 'metadata', url: 'local://empty.txt', mediaType: null, text: true, size: 0 }),
      ]);
    } finally {
      await sessions.close(created.value.id);
      await http.stop();
      database.close();
    }
  });
});

async function uploadFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-upload-rpc-'));
  roots.push(root);
  const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
  database.createProject({ id: 'project-a', name: 'Uploads', repositoryPath: join(root, 'repo') });
  database.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'A', branch: 'a', rootPath: join(root, 'workspace-a') });
  database.possessWorkspace('workspace-a', 'machine-a');
  const store = new MemoryArtifactObjectStore();
  const artifacts = new LocalArtifactResolver(database, store, join(root, 'cache'), new Uint8Array(32));
  const events = new FactEventStore(database);
  const runtime = new RpcFakeOmpRuntime();
  const sessions = new MachineSessionCoordinator(database, artifacts, runtime, 'machine-a', join(root, 'runtime'), events);
  const publications: Promise<void>[] = [];
  const failures: unknown[] = [];
  let clock = Date.now();
  const staging = join(root, 'artifact-uploads');
  const uploads = new ArtifactUploads({
    artifacts, root: staging, now: () => clock, onError: (error) => failures.push(error),
    publish: (spaceId) => {
      const publication = sessions.publishArtifacts(spaceId);
      publications.push(publication);
      return publication;
    },
  });
  const unavailable = async (): Promise<never> => { throw new Error('Not configured in upload fixture'); };
  const rpc = createGitSpaceRpcHandler({
    database, handlers: new GitSpaceHandlers(database, artifacts, events), artifacts, artifactUploads: uploads, sessions, factEvents: events, machineId: 'machine-a',
    terminals: {} as WorkspaceHubTerminalCoordinator,
    spaces: { close: unavailable, release: unavailable, open: unavailable },
    serviceManager: { list: async () => [], start: unavailable, stop: unavailable },
    secrets: { listProjectSecrets: async () => [], putProjectSecret: unavailable, deleteProjectSecret: unavailable, materializeProjectSecrets: unavailable },
    projectEvents: { appendProjectEvent: unavailable, listProjectEvents: async () => [], latestProjectEventOffset: async () => 0 },
    projects: {
      list: async () => [], createProject: unavailable, openProject: unavailable, createWorkspace: unavailable,
      retryCreateWorkspace: unavailable,
      findWorkspace: async () => null,
      archiveWorkspace: unavailable, archiveProject: unavailable, restoreProject: unavailable, setBaseBranch: unavailable, deleteProject: unavailable, deleteWorkspace: unavailable,
      setWorkspaceLifecycle: unavailable, setWorkspacePhase: unavailable, runLifecycleOperation: unavailable,
    },
    machines: async () => [], spacePlacements: async () => [],
  });
  const http = startGitSpaceRpcHttpServer({ handler: rpc.handler });
  const client = createBrowserClient({ contract: gitspaceContract, transport: fetchTransport({ url: `${http.url}/rpc` }) });
  const space = { spaceId: 'workspace-a', expectedGeneration: database.getSpace('workspace-a')!.generation };
  const chunk = (uploadId: string, offset: number, bytes: Buffer, sha256 = createHash('sha256').update(bytes).digest('hex')) =>
    client.inspector.artifacts.uploadChunk({ ...space, uploadId, offset, sha256, data: bytes.toString('base64') });
  return {
    root, database, store, artifacts, runtime, sessions, uploads, publications, failures, staging, http, client, space, chunk,
    advance: (milliseconds: number) => { clock += milliseconds; },
    close: async () => {
      uploads.close();
      await http.stop();
      database.close();
    },
  };
}

describe('Inspector artifact uploads', () => {
  it('commits sequential chunks into a published uploads/ artifact without notifying the agent', async () => {
    const fixture = await uploadFixture();
    const { artifacts, client, space, chunk, store } = fixture;
    const capability = { kind: 'workspace', projectId: 'project-a', workspaceId: 'workspace-a' } as const;
    const session = await fixture.sessions.create('workspace-a');
    if (session.status === 'error') throw session.error;
    try {
      expect((await artifacts.write(capability, 'local://workspace/uploads/report.zip', new TextEncoder().encode('existing'))).status).toBe('ok');
      const bytes = Buffer.alloc(2 * ARTIFACT_UPLOAD_CHUNK_BYTES + 1000);
      for (let index = 0; index < bytes.byteLength; index++) bytes[index] = (index * 131 + 17) % 256;
      const begun = await client.inspector.artifacts.uploadBegin({ ...space, fileName: 'report.zip', size: bytes.byteLength, mediaType: 'application/zip' });
      if (begun.status === 'error') throw begun.error;
      expect(begun.value).toMatchObject({ url: 'local://workspace/uploads/report (1).zip', chunkBytes: ARTIFACT_UPLOAD_CHUNK_BYTES });
      const { uploadId, chunkBytes } = begun.value;
      // A full chunk must fit the account Worker's 512 KiB space-routed body cap.
      const fullChunk = { ...space, uploadId, offset: 0, sha256: 'f'.repeat(64), data: Buffer.alloc(chunkBytes, 255).toString('base64') };
      const envelope = serialize({ v: 1, batch: [{ id: 'b0', path: 'inspector.artifacts.uploadChunk', input: fullChunk }] });
      if (!envelope.ok) throw new Error(envelope.message);
      expect(Buffer.byteLength(envelope.value)).toBeLessThan(512 * 1024);

      const first = bytes.subarray(0, chunkBytes);
      expect(await chunk(uploadId, 0, first)).toEqual(Result.ok({ received: chunkBytes }));
      // A timed-out client resends the chunk it cannot prove was stored.
      expect(await chunk(uploadId, 0, first)).toEqual(Result.ok({ received: chunkBytes }));
      expect(await chunk(uploadId, chunkBytes, bytes.subarray(chunkBytes, 2 * chunkBytes))).toEqual(Result.ok({ received: 2 * chunkBytes }));
      const last = bytes.subarray(2 * chunkBytes);
      expect(await chunk(uploadId, 2 * chunkBytes, last)).toEqual(Result.ok({ received: bytes.byteLength }));
      expect(await chunk(uploadId, 2 * chunkBytes, last)).toEqual(Result.ok({ received: bytes.byteLength }));

      const committed = await client.inspector.artifacts.uploadCommit({ ...space, uploadId });
      if (committed.status === 'error') throw committed.error;
      expect(committed.value).toMatchObject({
        url: 'local://workspace/uploads/report (1).zip', path: 'uploads/report (1).zip', size: bytes.byteLength,
        mediaType: 'application/zip', scope: 'workspace', workspaceId: 'workspace-a',
      });
      expect(await client.inspector.artifacts.uploadCommit({ ...space, uploadId })).toEqual(committed);
      await Promise.all(fixture.publications);
      expect(fixture.failures).toEqual([]);
      expect(store.objects.has(committed.value.hash)).toBe(true);
      const listed = artifacts.list(capability, 'local://workspace/uploads/');
      if (listed.status === 'error') throw listed.error;
      expect(listed.value.map((entry) => entry.path)).toEqual(['uploads/report (1).zip', 'uploads/report.zip']);
      const stored = await artifacts.read(capability, committed.value.url);
      if (stored.status === 'error') throw stored.error;
      expect(Buffer.from(stored.value).equals(bytes)).toBe(true);
      expect(readdirSync(fixture.staging)).toEqual([]);
      expect(fixture.runtime.promptBehaviors).toEqual([]);

      const base = await client.inspector.artifacts.uploadBegin({
        spaceId: 'project-a', expectedGeneration: fixture.database.getSpace('project-a')!.generation, fileName: 'shared.txt', size: 1, mediaType: null,
      });
      expect(base).toMatchObject({ status: 'ok', value: { url: 'local://base/uploads/shared.txt' } });
    } finally {
      await fixture.sessions.close(session.value.id);
      await fixture.close();
    }
  });

  it('rejects invalid, out-of-order, corrupt, incomplete, aborted, oversized and stale uploads', async () => {
    const fixture = await uploadFixture();
    const { client, space, chunk, uploads } = fixture;
    try {
      expect(await client.inspector.artifacts.uploadBegin({ ...space, fileName: '../escape.txt', size: 1, mediaType: null }))
        .toMatchObject({ status: 'error', error: { _tag: 'gitspace/inspector-state' } });
      await expect(client.inspector.artifacts.uploadBegin({ ...space, fileName: 'huge.bin', size: ARTIFACT_UPLOAD_MAX_BYTES + 1, mediaType: null }))
        .rejects.toThrow('Invalid input');
      const oversizedBody = serialize({ v: 1, path: 'inspector.artifacts.uploadBegin', input: { ...space, fileName: 'huge.bin', size: ARTIFACT_UPLOAD_MAX_BYTES + 1, mediaType: null } });
      if (!oversizedBody.ok) throw new Error(oversizedBody.message);
      const oversized = await fetch(`${fixture.http.url}/rpc`, {
        method: 'POST', headers: { 'content-type': 'application/result-rpc+devalue; sv=1' },
        body: oversizedBody.value,
      });
      expect(oversized.status).toBe(400);
      expect(existsSync(fixture.staging)).toBe(false);

      const begun = await client.inspector.artifacts.uploadBegin({ ...space, fileName: 'notes.txt', size: 10, mediaType: 'text/plain' });
      if (begun.status === 'error') throw begun.error;
      const { uploadId } = begun.value;
      expect(await chunk(uploadId, 5, Buffer.from('world')))
        .toMatchObject({ status: 'error', error: { _tag: 'gitspace/inspector-conflict', data: { resource: 'upload', expected: 0, actual: 5 } } });
      expect(await chunk(uploadId, 0, Buffer.from('hello'), createHash('sha256').update('other').digest('hex')))
        .toMatchObject({ status: 'error', error: { _tag: 'gitspace/inspector-state' } });
      expect(await chunk(uploadId, 0, Buffer.from('hello'))).toEqual(Result.ok({ received: 5 }));
      expect(await chunk(uploadId, 5, Buffer.from('world!'))).toMatchObject({ status: 'error', error: { _tag: 'gitspace/inspector-state' } });
      expect(await client.inspector.artifacts.uploadCommit({ ...space, uploadId }))
        .toMatchObject({ status: 'error', error: { _tag: 'gitspace/inspector-conflict', data: { expected: 10, actual: 5 } } });
      expect(readdirSync(fixture.staging)).toEqual([`${uploadId}.part`]);
      expect(await client.inspector.artifacts.uploadAbort({ ...space, uploadId })).toEqual(Result.ok({ aborted: true }));
      expect(readdirSync(fixture.staging)).toEqual([]);
      expect(await chunk(uploadId, 5, Buffer.from('world'))).toMatchObject({ status: 'error', error: { _tag: 'gitspace/inspector-state' } });
      expect(await client.inspector.artifacts.uploadAbort({ ...space, uploadId })).toEqual(Result.ok({ aborted: false }));
      const aborted = fixture.artifacts.list({ kind: 'workspace', projectId: 'project-a', workspaceId: 'workspace-a' }, 'local://workspace/uploads/');
      expect(aborted).toMatchObject({ status: 'ok', value: [] });

      const stale = await client.inspector.artifacts.uploadBegin({ ...space, fileName: 'stale.bin', size: 10, mediaType: null });
      if (stale.status === 'error') throw stale.error;
      expect(await chunk(stale.value.uploadId, 0, Buffer.from('hello'))).toEqual(Result.ok({ received: 5 }));
      const orphan = join(fixture.staging, 'previous-process.part');
      writeFileSync(orphan, 'lost with its machine process');
      const old = new Date(Date.now() - 2 * ARTIFACT_UPLOAD_IDLE_MS);
      utimesSync(orphan, old, old);
      fixture.advance(ARTIFACT_UPLOAD_IDLE_MS - 1);
      await uploads.sweep();
      expect(readdirSync(fixture.staging)).toEqual([`${stale.value.uploadId}.part`]);
      fixture.advance(2);
      await uploads.sweep();
      expect(readdirSync(fixture.staging)).toEqual([]);
      expect(await chunk(stale.value.uploadId, 5, Buffer.from('world'))).toMatchObject({ status: 'error', error: { _tag: 'gitspace/inspector-state' } });
    } finally {
      await fixture.close();
    }
  });
});
