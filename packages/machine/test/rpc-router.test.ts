import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  GitSpaceDatabase,
  GitSpaceHandlers,
  LocalArtifactResolver,
  MemoryArtifactObjectStore,
} from '@gitspace/core';
import { createDeviceBinding, createEncryptedRpcFetch, createSignedRpcFetch, credentialProtocolBase64, gitspaceContract, rpcErrors, signDeviceInvite, type DeviceCapability, type DeviceGrantRecord, type ProjectEvent } from '@gitspace/protocol';
import { CloudProjectEventWriter } from '../src/cloud-project-events.js';
import { DeviceRegistry } from '../src/device-registry.js';
import { createSignedRpcHandler } from '../src/signed-rpc.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createBrowserClient, fetchTransport } from 'result-rpc/client';
import {
  MachineSessionCoordinator,
  createEncryptedRpcHandler,
  createGitSpaceRpcHandler,
  startGitSpaceRpcHttpServer,
  type OmpRuntime,
  type OmpRuntimeEvent,
  type OmpRuntimeSession,
} from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class RpcFakeOmpRuntime implements OmpRuntime {
  readonly created: Array<{ workingDirectory: string; sessionKey: string }> = [];
  readonly opened: Array<{ workingDirectory: string; sessionKey: string }> = [];
  readonly promptBehaviors: Array<'steer' | 'followUp' | undefined> = [];
  async create(input: { workingDirectory: string; sessionKey: string; artifactsDir: string }): Promise<OmpRuntimeSession> {
    this.created.push({ workingDirectory: input.workingDirectory, sessionKey: input.sessionKey });
    const name = input.sessionKey.replace(':', '-');
    return this.session(`omp-${name}`, `/sessions/${name}.jsonl`, input.artifactsDir, input.sessionKey === 'space:project-a' ? 'base' : 'workspace');
  }
  async open(input: { workingDirectory: string; sessionKey: string; artifactsDir: string; sessionFile: string }): Promise<OmpRuntimeSession> {
    this.opened.push({ workingDirectory: input.workingDirectory, sessionKey: input.sessionKey });
    const name = input.sessionKey.replace(':', '-');
    return this.session(`omp-${name}`, input.sessionFile, input.artifactsDir, input.sessionKey === 'space:project-a' ? 'base' : 'workspace');
  }
  private session(id: string, sessionFile: string, artifactsDir: string, artifactScope: 'base' | 'workspace'): OmpRuntimeSession {
    const handlers = new Set<(event: OmpRuntimeEvent) => void>();
    return {
      id,
      sessionFile,
      prompt: async (text, options) => {
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
        handler({ active: false, reasons: [] });
        return () => undefined;
      },
      activity: () => ({ activity: { active: false, reasons: [] } }),
      persist: async () => undefined,
      handoff: async () => false,
      resume: async () => undefined,
      dispose: async () => undefined,
    };
  }
}

describe('GitSpace Result RPC', () => {
  it('serves typed queries, mutations, and one replayable fact stream over HTTP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-rpc-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    expect(database.createProject({ id: 'project-a', name: 'GitSpace', repositoryPath: join(root, 'repo') }).status).toBe('ok');
    const workspaceRoot = join(root, 'repo', 'workspaces', 'a');
    mkdirSync(workspaceRoot, { recursive: true });
    expect(database.createWorkspace({
      id: 'workspace-a', projectId: 'project-a', name: 'agent-blame', branch: 'develop', rootPath: workspaceRoot,
    }).status).toBe('ok');
    const artifacts = new LocalArtifactResolver(
      database,
      new MemoryArtifactObjectStore(),
      join(root, 'cache'),
      Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    );
    // The project log lives in the cloud, not in the machine database; its
    // offsets are unrelated to anything local. Start well above zero so a
    // machine-local counter leaking into `bootstrap.eventOffset` shows up.
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
    const events = new CloudProjectEventWriter(projectEvents, (error) => { throw error; });
    const handlers = new GitSpaceHandlers(database, artifacts, events);
    const runtime = new RpcFakeOmpRuntime();
    const sessions = new MachineSessionCoordinator(
      database,
      artifacts,
      runtime,
      'machine-a',
      join(root, 'runtime'),
      events,
    );
    const spaces = {
      close: async (space: NonNullable<ReturnType<GitSpaceDatabase['getSpace']>>, expectedGeneration: number) => {
        const started = database.beginSpaceClose({ spaceId: space.id, holderId: 'machine-a', expectedGeneration });
        if (started.status === 'error') throw started.error;
        const session = sessions.list(space.id)[0];
        if (session) {
          const stopped = await sessions.close(session.id);
          if (stopped.status === 'error') throw stopped.error;
        }
        const committed = database.commitSpaceClosed({ spaceId: space.id, holderId: 'machine-a', expectedGeneration });
        if (committed.status === 'error') throw committed.error;
        database.setSpaceClosed(space.id, true);
      },
      open: async (spaceId: string, expectedGeneration: number) => {
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
    const checkpointReads: Array<{ projectId: string; spaceId: string }> = [];
    let fleetListener: ((event: { type: 'upsert' | 'remove'; machineId: string; machine: typeof fleet[number] | null }) => void) | null = null;
    let projectSecrets: Array<{ projectId: string; name: string; revision: number; updatedAt: string; updatedBy: string }> = [];
    const secrets = {
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
      list: async () => [{
        id: 'project-a',
        name: 'GitSpace',
        lifecycle: 'active' as const,
        repositoryReference: null,
        baseBranch: 'main',
        revision: 1,
        archivedAt: null,
        updatedAt: new Date().toISOString(),
      }],
      createProject: async () => { throw new Error('not configured'); },
      createWorkspace: async () => { throw new Error('not configured'); },
      archiveProject: async () => { throw new Error('not configured'); },
      restoreProject: async () => { throw new Error('not configured'); },
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
    const deviceRecords: DeviceGrantRecord[] = [];
    const enrollDevice = (privateKey: Uint8Array, capabilities: DeviceCapability[]): string => {
      const invite = signDeviceInvite({ version: 1, userId: 'user-a', inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities, canDelegate: true, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'http://control.test' }, rootPrivateKey);
      const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(privateKey)), label: 'Test device', boundAt: Date.now(), signingPrivateKey: privateKey });
      deviceRecords.push({ invite, binding, generation: 1, revokedAt: null });
      return binding.deviceId;
    };
    const browserDeviceId = enrollDevice(browserPrivateKey, ['rpc.read', 'rpc.write', 'session.prompt', 'fleet.control', 'devices.manage']);
    const readerDeviceId = enrollDevice(readerPrivateKey, ['rpc.read']);
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
      desired: { sha: 'rel-1', targets: ['machine' as const], updatedAt: '2026-08-31T00:00:00.000Z' },
      current: { worker: { sha: null, version: 'dev' }, machines: { 'machine-a': { sha: 'rel-1', generation: 'sha256:' + 'c'.repeat(64) } } },
      releases: [],
    };
    const rpc = createGitSpaceRpcHandler({
      database,
      handlers,
      artifacts,
      sessions,
      spaces,
      serviceManager: {
        list: async () => [],
        start: async () => { throw new Error('not configured'); },
        stop: async () => { throw new Error('not configured'); },
      },
      secrets,
      projectEvents,
      projects: projectAuthority,
      machines: async () => fleet,
      checkpointTranscript: async (projectId, spaceId) => {
        checkpointReads.push({ projectId, spaceId });
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
      watchMachines: (listener) => { fleetListener = listener as typeof fleetListener; return () => { fleetListener = null; }; },
      destroyMachine: async (machineId) => ({ machineId, removed: true }),
      machineId: 'machine-a',
      devices,
      deployment: {
        status: async () => tenantDeployment,
        launch: (input) => { launches.push(input); throw new Error('not built in tests'); },
        launchProgress: () => null,
        revert: async () => ({ ...tenantDeployment, desired: { sha: null, targets: [], updatedAt: '2026-08-31T00:00:00.000Z' } }),
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

    // Unsigned and under-privileged callers never reach the router.
    const anonymous = createBrowserClient({ contract: gitspaceContract, transport: fetchTransport({ url: `${http.url}/rpc` }) });
    expect((await anonymous.bootstrap({ projectId: 'project-a', workspaceId: 'workspace-a' })).status).toBe('error');
    const reader = createBrowserClient({ contract: gitspaceContract, transport: fetchTransport({ url: `${http.url}/rpc`, fetch: createSignedRpcFetch({ deviceId: readerDeviceId, signingPrivateKey: readerPrivateKey }) }) });
    expect((await reader.bootstrap({ projectId: 'project-a', workspaceId: 'workspace-a' })).status).toBe('ok');
    expect((await reader.secrets.put({ projectId: 'project-a', name: 'X', value: 'y' })).status).toBe('error');
    const deploymentStatus = await reader.deployment.status({});
    if (deploymentStatus.status === 'error') throw deploymentStatus.error;
    expect(deploymentStatus.value.thisMachine).toEqual({ machineId: 'machine-a', sha: 'rel-1', generation: 'sha256:' + 'c'.repeat(64) });
    expect(deploymentStatus.value.desired).toEqual({ sha: 'rel-1', targets: ['machine'], updatedAt: '2026-08-31T00:00:00.000Z' });
    expect(deploymentStatus.value.current.machines['machine-a']).toEqual({ sha: 'rel-1', generation: 'sha256:' + 'c'.repeat(64) });
    // Launching is a `deployment.control` mutation: a read-only device is refused before the launcher runs.
    expect((await reader.deployment.launch({ workspaceId: 'workspace-a', targets: ['machine'] })).status).toBe('error');
    expect(launches).toEqual([]);
    const listedDevices = await client.devices.list({});
    if (listedDevices.status === 'error') throw listedDevices.error;
    expect(listedDevices.value.map((device) => [device.deviceId, device.current])).toEqual([[browserDeviceId, true], [readerDeviceId, false]]);
    expect((await client.devices.revoke({ deviceId: readerDeviceId })).status).toBe('ok');
    expect((await reader.bootstrap({ projectId: 'project-a', workspaceId: 'workspace-a' })).status).toBe('error');

    const initial = await client.bootstrap({ projectId: 'project-a', workspaceId: 'workspace-a' });
    expect(initial.status).toBe('ok');
    if (initial.status === 'error') throw initial.error;
    expect(initial.value.project.name).toBe('GitSpace');
    expect(initial.value.workspaces[0]?.possessedBy).toBeNull();
    expect(initial.value.eventOffset).toBe(0);

    const putSecret = await client.secrets.put({ projectId: 'project-a', name: 'API_TOKEN', value: 'write-only' });
    expect(putSecret).toMatchObject({ status: 'ok', value: { name: 'API_TOKEN', revision: 1 } });
    const listedSecrets = await client.secrets.list({ projectId: 'project-a' });
    expect(listedSecrets).toMatchObject({ status: 'ok', value: [{ name: 'API_TOKEN', revision: 1 }] });
    const deletedSecret = await client.secrets.delete({ projectId: 'project-a', name: 'API_TOKEN' });
    expect(deletedSecret).toMatchObject({ status: 'ok', value: { deleted: true } });

    const unpossessed = await client.session.create({ workspaceId: 'workspace-a' });
    expect(unpossessed.status).toBe('error');
    if (unpossessed.status === 'ok') throw new Error('Expected unpossessed failure');
    expect(rpcErrors.workspaceUnpossessed.is(unpossessed.error)).toBe(true);
    expect(database.possessSpace('project-a', 'machine-a').status).toBe('ok');

    const possessed = handlers.possessSpace({ spaceId: 'workspace-a', holderId: 'machine-a' });
    expect(possessed.status).toBe('ok');
    const created = await client.session.create({ workspaceId: 'workspace-a' });
    expect(created.status).toBe('ok');
    if (created.status === 'error') throw created.error;
    expect(created.value.createdAt).toBeInstanceOf(Date);

    const fleetStream = client.machine.events({})[Symbol.asyncIterator]();
    const fleetNext = fleetStream.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fleetListener?.({ type: 'upsert', machineId: 'machine-a', machine: fleet[0]! });
    const fleetEvent = await fleetNext;
    expect(fleetEvent.value).toMatchObject({ status: 'ok', value: { type: 'upsert', machineId: 'machine-a', machine: { state: 'online' } } });
    await fleetStream.return?.();
    // A page loaded now resumes the stream from `bootstrap.eventOffset`; that
    // offset must be the project log's, so nothing appended afterwards is skipped.
    await events.flush();
    const resumePoint = await client.bootstrap({ projectId: 'project-a', workspaceId: 'workspace-a' });
    if (resumePoint.status === 'error') throw resumePoint.error;
    expect(resumePoint.value.eventOffset).toBe(PROJECT_LOG_BASE + projectLog.length);
    expect(resumePoint.value.eventOffset).toBeGreaterThan(PROJECT_LOG_BASE);
    const stream = client.events({ projectId: 'project-a', afterOffset: 0 })[Symbol.asyncIterator]();
    const possessionEvent = await stream.next();
    const sessionEvent = await stream.next();
    expect(possessionEvent.value?.status).toBe('ok');
    expect(sessionEvent.value?.status).toBe('ok');
    if (!sessionEvent.value || sessionEvent.value.status === 'error') throw new Error('Expected session event');
    expect(sessionEvent.value.value.createdAt).toBeInstanceOf(Date);
    const resumedStream = client.events({ projectId: 'project-a', afterOffset: resumePoint.value.eventOffset })[Symbol.asyncIterator]();
    const resumedNext = resumedStream.next();

    const prompted = await client.session.prompt({ sessionId: created.value.id, text: 'ship it', streamingBehavior: 'followUp', images: [] });
    expect(prompted.status).toBe('ok');
    const usage = await client.session.usage({ sessionId: created.value.id });
    expect(usage).toMatchObject({ status: 'ok', value: { sessionId: created.value.id, childSessions: 0, byModel: [], byAgent: [], totals: { requests: 0, costUsd: 0 } } });
    const missingUsage = await client.session.usage({ sessionId: 'nope' });
    expect(missingUsage.status).toBe('error');
    if (missingUsage.status === 'ok') throw new Error('Expected missing session failure');
    expect(rpcErrors.sessionNotFound.is(missingUsage.error)).toBe(true);
    expect(runtime.promptBehaviors).toContain('followUp');
    const transcriptEvent = await stream.next();
    expect(transcriptEvent.value?.status).toBe('ok');
    if (!transcriptEvent.value || transcriptEvent.value.status === 'error') throw new Error('Expected transcript event');
    expect(transcriptEvent.value.value).toMatchObject({ entity: 'transcript', operation: 'append' });
    await stream.return?.();
    const resumedEvent = await resumedNext;
    expect(resumedEvent.value).toMatchObject({ status: 'ok', value: { entity: 'transcript', operation: 'append', offset: transcriptEvent.value.value.offset } });
    await resumedStream.return?.();

    const refreshed = await client.bootstrap({ projectId: 'project-a', workspaceId: 'workspace-a' });
    expect(refreshed.status).toBe('ok');
    if (refreshed.status === 'error') throw refreshed.error;
    expect(refreshed.value.mainAgent).toMatchObject({ id: created.value.id });
    expect(refreshed.value.transcript).toHaveLength(1);
    expect(refreshed.value.artifacts.map((artifact) => artifact.path)).toContain('rpc.txt');

    expect(database.createWorkspace({ id: 'workspace-b', projectId: 'project-a', name: 'stacked', branch: 'stacked', rootPath: join(root, 'repo', 'workspaces', 'b') }).status).toBe('ok');
    const related = await client.workspace.setRelations({ workspaceId: 'workspace-b', dependsOn: [], relatedTo: [], stackedOn: 'workspace-a' });
    expect(related.status).toBe('ok');
    if (related.status === 'error') throw related.error;
    expect(related.value).toMatchObject({
      id: 'workspace-b',
      relations: { dependsOn: ['workspace-a'], relatedTo: [], stackedOn: 'workspace-a' },
      stack: { blockedBy: ['workspace-a'], blocking: [], findings: [{ code: 'dependency-open', workspaceId: 'workspace-a' }] },
    });
    const relatedBootstrap = await client.bootstrap({ projectId: 'project-a', workspaceId: null });
    if (relatedBootstrap.status === 'error') throw relatedBootstrap.error;
    expect(relatedBootstrap.value.workspaces.find((workspace) => workspace.id === 'workspace-a')?.stack.blocking).toEqual(['workspace-b']);
    const tooFar = await client.workspace.setPhase({ workspaceId: 'workspace-b', phase: 'review' });
    expect(tooFar.status).toBe('error');
    if (tooFar.status === 'ok') throw new Error('Expected phase ceiling failure');
    expect(rpcErrors.operationFailed.is(tooFar.error)).toBe(true);
    expect(tooFar.error.message).toContain('agent-blame (code)');
    expect(database.getWorkspace('workspace-b')?.phase).toBe('code');
    const status = await client.workspace.stackStatus({ workspaceId: 'workspace-b' });
    expect(status.status).toBe('error');
    if (status.status === 'ok') throw new Error('Expected stack status to need a materialized workspace');
    expect(rpcErrors.operationFailed.is(status.error)).toBe(true);
    const selfRelated = await client.workspace.setRelations({ workspaceId: 'workspace-b', dependsOn: ['workspace-b'], relatedTo: [], stackedOn: null });
    expect(selfRelated.status).toBe('error');
    if (selfRelated.status === 'ok') throw new Error('Expected self relation failure');
    expect(rpcErrors.operationFailed.is(selfRelated.error)).toBe(true);
    const unknownRelated = await client.workspace.setRelations({ workspaceId: 'workspace-b', dependsOn: [], relatedTo: ['workspace-z'], stackedOn: null });
    expect(unknownRelated.status).toBe('error');
    if (unknownRelated.status === 'ok') throw new Error('Expected unknown relation failure');
    expect(rpcErrors.workspaceNotFound.is(unknownRelated.error)).toBe(true);
    expect(database.deleteWorkspace('workspace-b')).toBe(true);

    const closed = await client.workspace.archive({ spaceId: 'workspace-a', expectedGeneration: 1 });
    expect(closed.status).toBe('ok');
    if (closed.status === 'error') throw closed.error;
    expect(closed.value).toMatchObject({ id: 'workspace-a', kind: 'worktree', state: 'archived', machineId: null, generation: 2 });

    // Closed in the cloud: bootstrap serves the checkpoint read-only instead of the local agent.
    const closedBootstrap = await client.bootstrap({ projectId: 'project-a', workspaceId: 'workspace-a' });
    if (closedBootstrap.status === 'error') throw closedBootstrap.error;
    expect(closedBootstrap.status).toBe('ok');
    expect(checkpointReads.at(-1)).toEqual({ projectId: 'project-a', spaceId: 'workspace-a' });
    expect(closedBootstrap.value.mainAgent).toBeNull();
    expect(closedBootstrap.value.checkpoint).toEqual({ sessionId: created.value.id, generation: 2, lastMachineId: 'machine-a' });
    expect(closedBootstrap.value.transcript).toHaveLength(1);
    expect(closedBootstrap.value.transcript[0]).toMatchObject({ sessionId: created.value.id, kind: 'message_end', payload: { source: 'checkpoint' } });
    expect(closedBootstrap.value.workspaces.find((workspace) => workspace.id === 'workspace-a')).toMatchObject({ possessedBy: null, closedAt: expect.any(Date) });

    const reopened = await client.workspace.restore({ spaceId: 'workspace-a', expectedGeneration: 2 });
    expect(reopened.status).toBe('ok');
    if (reopened.status === 'error') throw reopened.error;
    expect(reopened.value).toMatchObject({ id: 'workspace-a', kind: 'worktree', state: 'active', machineId: 'machine-a', generation: 3 });

    const reopenedBootstrap = await client.bootstrap({ projectId: 'project-a', workspaceId: 'workspace-a' });
    expect(reopenedBootstrap.status).toBe('ok');
    if (reopenedBootstrap.status === 'error') throw reopenedBootstrap.error;
    expect(reopenedBootstrap.value.mainAgent).toMatchObject({ id: created.value.id, state: 'active', renderState: 'waiting' });
    expect(reopenedBootstrap.value.transcript).toHaveLength(1);

    const projectAgent = await client.session.createProject({ projectId: 'project-a' });
    expect(projectAgent.status).toBe('ok');
    if (projectAgent.status === 'error') throw projectAgent.error;
    expect(projectAgent.value).toMatchObject({ projectId: 'project-a', workspaceId: null, scope: 'project' });
    expect(projectAgent.value.id).not.toBe(created.value.id);

    const projectBootstrap = await client.bootstrap({ projectId: 'project-a', workspaceId: null });
    expect(runtime.created).toContainEqual({ workingDirectory: join(root, 'repo'), sessionKey: 'space:project-a' });
    expect(runtime.created).toContainEqual({ workingDirectory: workspaceRoot, sessionKey: 'space:workspace-a' });
    expect(projectBootstrap.status).toBe('ok');
    if (projectBootstrap.status === 'error') throw projectBootstrap.error;
    expect(projectBootstrap.value.mainAgent).toMatchObject({ id: projectAgent.value.id, scope: 'project', workspaceId: null });
    expect(projectBootstrap.value.transcript).toHaveLength(0);

    expect((await client.session.prompt({ sessionId: projectAgent.value.id, text: 'update base', streamingBehavior: 'steer', images: [] })).status).toBe('ok');
    const projectRefreshed = await client.bootstrap({ projectId: 'project-a', workspaceId: null });
    expect(projectRefreshed.status).toBe('ok');
    if (projectRefreshed.status === 'error') throw projectRefreshed.error;
    expect(projectRefreshed.value.transcript).toHaveLength(1);
    expect(projectRefreshed.value.artifacts).toContainEqual(expect.objectContaining({ path: 'rpc.txt', scope: 'base', workspaceId: null }));

    const isolatedWorkspace = await client.bootstrap({ projectId: 'project-a', workspaceId: 'workspace-a' });
    expect(isolatedWorkspace.status).toBe('ok');
    if (isolatedWorkspace.status === 'error') throw isolatedWorkspace.error;
    expect(isolatedWorkspace.value.mainAgent).toMatchObject({ id: created.value.id, scope: 'workspace', workspaceId: 'workspace-a' });
    expect(isolatedWorkspace.value.transcript).toHaveLength(1);

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
    const encryptedBootstrap = await encryptedClient.bootstrap({ projectId: 'project-a', workspaceId: 'workspace-a' });
    expect(encryptedBootstrap.status).toBe('ok');
    if (encryptedBootstrap.status === 'error') throw encryptedBootstrap.error;
    expect(encryptedBootstrap.value.transcript[0]?.createdAt).toBeInstanceOf(Date);
    const encryptedStream = encryptedClient.events({ projectId: 'project-a', afterOffset: 0 })[Symbol.asyncIterator]();
    const encryptedEvent = await encryptedStream.next();
    expect(encryptedEvent.value?.status).toBe('ok');
    await encryptedStream.return?.();
    expect(consumed.size).toBe(2);
    await encryptedHttp.stop();

    expect((await sessions.close(created.value.id)).status).toBe('ok');
    expect((await sessions.close(projectAgent.value.id)).status).toBe('ok');
    await http.stop();
    database.close();
  });
});
