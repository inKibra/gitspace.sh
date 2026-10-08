import { env, runInDurableObject } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant, type ControlOperation } from '@gitspace/protocol';
import { RuntimeAttachInputSchema, RuntimeHeartbeatInputSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import { ArtifactsCodeStore, AttachmentStore, type AttachmentServices } from '@gitspace/runtime-workspace-do';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { tenantRootPrivateKey } from './setup.js';
import { RuntimeAttachmentController } from '../src/runtime-attachments.js';
import { emptyLifecycleState } from '@gitspace/protocol-environment';

const projectId = 'repository-project';
const workspaceId = 'repository-workspace';
const signingKey = new Uint8Array(32).fill(41);
const lease = { remote: 'https://artifacts.test/workspace-repository-workspace.git', plaintext: 'test-scoped-repository-token', expiresAt: '2099-01-01T00:00:00.000Z' };

const repository = { id: 'test-repo', name: 'test-repo', description: null, defaultBranch: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastPushAt: null, source: null, readOnly: false, remote: lease.remote };

beforeEach(() => {
  // Keep the real signed route, device grants and workspace authority. Only the
  // external Artifacts service is replaced; no test mints a live credential.
  vi.spyOn(ArtifactsCodeStore.prototype, 'ensureEmptyProject').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'credentials').mockResolvedValue(lease);
});
afterEach(() => vi.restoreAllMocks());

async function fixture(capabilities: Array<'storage.access' | 'space.control'>, repositoryReference: string | null = null) {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(19)) });
  for (const machineId of ['assigned', 'unassigned']) {
    await vault.registerDevice(signCredentialAuthorityGrant({
      version: 1, userId, machineId, generation: 1, capabilities,
      signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signingKey)),
      exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(new Uint8Array(32).fill(37))),
    }, tenantRootPrivateKey));
  }
  const project = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const created = await project.bootstrap({ id: projectId, name: 'Repository authorization', repositoryReference, baseBranch: 'main', createdBy: 'assigned' });
  await project.setProjectLifecycle(created.revision, 'active');
  const workspace = { id: workspaceId, projectId, kind: 'worktree' as const, name: 'Repository', branch: 'main', phase: null, sourceKind: 'branch' as const, sourceRef: 'main', sourceCommit: null, lifecycle: 'active' as const, goalId: null, expectedRevision: 0 };
  await project.putWorkspace(workspace);
  const authority = env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`);
  await authority.bootstrap({ projectId, spaceId: workspaceId, machineId: 'assigned' });
  const request = (payload: Record<string, unknown> = {}, machineId = 'assigned', operation: ControlOperation = 'runtime.repository.credentials') => worker.fetch(new Request('https://auth.test/v1/control', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(createSignedControlRequest({ userId, machineId, operation, payload: { projectId, workspaceId, generation: 1, scope: 'read', ...payload }, signingPrivateKey: signingKey })),
  }), env);
  return { project, workspace, authority, request };
}

describe('signed repository credential authority', () => {
  it('refuses incompatible execution before admitting an effect and leaves recovery observable', async () => {
    const f = await fixture(['space.control']);
    await runInDurableObject(f.authority, async (_instance, state) => {
      let dispatched = false;
      const store = new AttachmentStore(state.storage, {
        seal: async secret => secret, open: async secret => secret,
        admitExecution: async () => { throw new Error('Updating machine: executor protocol 1 is required'); },
        dispatch: async () => { dispatched = true; throw new Error('Unexpected dispatch'); },
      });
      const dispatch = RuntimeToolDispatchSchema.parse({ version: 1, conversationKind: 'main', conversationId: 'conversation', taskId: 'task', attachmentId: 'attachment', projectId, workspaceId, machineId: 'assigned', generation: 1, requestId: 'request', attemptId: 'protocol-refusal', tool: 'bash', args: { command: 'effect' }, deadlineAt: new Date(Date.now() + 60_000).toISOString(), replay: 'unsafe' });
      await expect(store.execute(dispatch, AbortSignal.timeout(1000))).rejects.toThrow('Updating machine');
      expect(store.getAttempt(dispatch.attemptId)).toBe(null);
      expect(dispatched).toBe(false);
    });
  });
  it('pins checkpoint attachments to the durable commit rather than resolving custom refs through the binding', async () => {
    const f = await fixture(['space.control']);
    await runInDurableObject(f.authority, async (_instance, state) => {
      const commit = 'a'.repeat(40);
      const tree = 'b'.repeat(40);
      const checkpoint = { checkpointRef: `refs/gitspace/spaces/${workspaceId}/checkpoints`, branch: 'main', headCommit: commit, indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: tree, worktreeTree: tree };
      const unsupported = async (): Promise<never> => { throw new Error('Unexpected binding operation'); };
      const repo: ArtifactsRepo = {
        [Symbol.dispose]() {}, info: unsupported, createToken: unsupported, revokeToken: unsupported, listTokens: unsupported, fork: unsupported, readBlob: unsupported, readFile: unsupported,
        log: async () => [],
        readCommit: async oid => oid === commit ? { hash: commit, treeHash: tree, parents: [], message: 'checkpoint', author: { name: 'Fixture', email: 'fixture@example.invalid' }, committer: { name: 'Fixture', email: 'fixture@example.invalid' }, authoredAt: 1, committedAt: 1 } : null,
        readTree: async oid => oid === tree ? [] : null,
      };
      const code = new ArtifactsCodeStore({ get: async () => repo, create: unsupported, import: unsupported, list: unsupported, delete: unsupported });
      const controller = new RuntimeAttachmentController({
        attachments: new AttachmentStore(state.storage, { seal: async secret => secret, open: async secret => secret, dispatch: unsupported }),
        code, publish() {}, snapshot: async () => checkpoint, origin: async () => null, lifecycle: unsupported, authorizeMachine: async () => {},
      });
      const request = { projectId, workspaceId, machineId: 'assigned', requestId: 'checkpoint-pin', sourceRef: checkpoint.checkpointRef, checkout: { kind: 'snapshot', commit } };
      await expect(controller.request({ ...request, checkout: { kind: 'snapshot', commit: 'c'.repeat(40) } })).rejects.toThrow();
      await expect(controller.request({ ...request, sourceRef: 'refs/gitspace/spaces/foreign/checkpoints' })).rejects.toThrow();
      const assigned = await controller.request(request);
      expect(assigned.attachment.checkout).toEqual({ kind: 'snapshot', commit });
    });
  });

  it('does not grant repository credentials to a space-control-only device', async () => {
    const f = await fixture(['space.control']);
    const response = await f.request();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ status: 'error' });
  });

  it('allows storage-only access without granting conversation control', async () => {
    const f = await fixture(['storage.access']);
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', value: lease });
    expect((await f.request({}, 'assigned', 'runtime.snapshot')).status).toBe(401);
  });

  it('retains repository, project, signed-machine and generation boundaries', async () => {
    const f = await fixture(['storage.access']);
    for (const payload of [
      { repository: 'workspace-foreign' },
      { projectId: 'foreign-project' },
      { machineId: 'unassigned' },
      { generation: 0 },
    ]) {
      const response = await f.request(payload);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ status: 'error' });
    }
    expect((await f.request({}, 'unassigned')).status).toBe(400);
    expect((await f.request()).status).toBe(200);
  });

  it('keeps archived workspaces readable but refuses write credentials', async () => {
    const f = await fixture(['storage.access']);
    const writable = await f.request({ scope: 'write' });
    expect({ status: writable.status, body: await writable.json() }).toMatchObject({ status: 200, body: { status: 'ok' } });
    await f.project.putWorkspace({ ...f.workspace, lifecycle: 'archived', expectedRevision: 1 });
    expect((await f.request()).status).toBe(200);
    expect((await f.request({ scope: 'write' })).status).toBe(400);
  });

  describe('project repository leases', () => {
    const seedLease = { workspaceId: undefined, generation: undefined, repository: `project-${projectId}`, scope: 'write' };
    async function seeding(baseHolder: string, repositoryReference: string | null = 'https://github.com/example/private.git') {
      const f = await fixture(['storage.access'], repositoryReference);
      await env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`).bootstrap({ projectId, spaceId: projectId, machineId: baseHolder });
      const seedTarget = vi.spyOn(ArtifactsCodeStore.prototype, 'ensureMachineSeedTarget').mockResolvedValue(repository);
      const imported = vi.spyOn(ArtifactsCodeStore.prototype, 'importProject').mockRejectedValue(new Error('A seed lease must never import'));
      return { ...f, seedTarget, imported, credentials: vi.spyOn(ArtifactsCodeStore.prototype, 'credentials') };
    }

    it('grants write to the open base space holder without importing the origin', async () => {
      const f = await seeding('assigned');
      const granted = await f.request(seedLease);
      expect({ status: granted.status, body: await granted.json() }).toEqual({ status: 200, body: { status: 'ok', value: lease } });
      expect(f.seedTarget).toHaveBeenCalledWith(projectId, 'main');
      expect(f.credentials).toHaveBeenCalledWith(`project-${projectId}`, 'write');
      expect(f.imported).not.toHaveBeenCalled();
      expect(ArtifactsCodeStore.prototype.ensureEmptyProject).not.toHaveBeenCalled();
      expect(ArtifactsCodeStore.prototype.forkWorkspace).not.toHaveBeenCalled();
    });

    it('refuses machines that do not hold the open base space, even a workspace holder', async () => {
      const f = await seeding('unassigned');
      expect((await f.request(seedLease, 'assigned')).status).toBe(400);
      expect((await f.request({ ...seedLease, generation: 2 }, 'unassigned')).status).toBe(400);
      expect(f.credentials).not.toHaveBeenCalled();
      expect((await f.request(seedLease, 'unassigned')).status).toBe(200);
    });

    it('refuses foreign project repositories and project leases mixed with workspace or attachment identity', async () => {
      const f = await seeding('assigned');
      for (const payload of [
        { ...seedLease, repository: 'project-foreign' },
        { ...seedLease, workspaceId },
        { ...seedLease, attachmentId: 'attachment', generation: 1 },
      ]) expect((await f.request(payload)).status).toBe(400);
      expect(f.credentials).not.toHaveBeenCalled();
    });

    it('refuses scratch projects, whose repository is never machine-seeded', async () => {
      const f = await seeding('assigned', null);
      expect((await f.request(seedLease)).status).toBe(400);
      expect(f.seedTarget).not.toHaveBeenCalled();
    });
  });

  it('fences attachment generation and state and prevents runner publication', async () => {
    const f = await fixture(['storage.access']);
    const services: AttachmentServices = {
      seal: async () => 'test-sealed-execution-secret',
      open: async () => { throw new Error('This fixture does not recover execution secrets'); },
      dispatch: async () => { throw new Error('Repository authorization must not dispatch tools'); },
    };
    const attachment = await runInDurableObject(f.authority, async (_instance, state) => {
      const store = new AttachmentStore(state.storage, services);
      const { attachment } = await store.attach(RuntimeAttachInputSchema.parse({ projectId, workspaceId, machineId: 'assigned', generation: 3, role: 'runner', checkout: { kind: 'snapshot', commit: 'a'.repeat(40) }, capabilities: [] }));
      return store.ready({ ...attachment, commit: 'a'.repeat(40), prerequisitesComplete: true }).attachment;
    });
    const assigned = { attachmentId: attachment.attachmentId, generation: attachment.generation };
    const readable = await f.request(assigned);
    expect(readable.status, await readable.text()).toBe(200);
    expect((await f.request({ ...assigned, scope: 'write' })).status).toBe(400);
    expect((await f.request({ ...assigned, generation: 2 })).status).toBe(400);
    expect((await f.request(assigned, 'unassigned')).status).toBe(400);
    await runInDurableObject(f.authority, (_instance, state) => {
      new AttachmentStore(state.storage, services).detach({ ...attachment, state: 'lost' });
    });
    expect((await f.request(assigned)).status).toBe(400);
  });

  it('leases the workspace repository to an attached cache machine that does not hold the legacy placement', async () => {
    const f = await fixture(['storage.access']);
    const services: AttachmentServices = {
      seal: async () => 'test-sealed-execution-secret',
      open: async () => { throw new Error('This fixture does not recover execution secrets'); },
      dispatch: async () => { throw new Error('Repository authorization must not dispatch tools'); },
    };
    // The machine git remote binds only the repository; it carries no attachment or placement generation.
    const binding = { workspaceId: undefined, generation: undefined, repository: `workspace-${workspaceId}` };
    expect((await f.request(binding, 'unassigned')).status).toBe(400);
    const runner = await runInDurableObject(f.authority, async (_instance, state) => {
      const store = new AttachmentStore(state.storage, services);
      return (await store.attach(RuntimeAttachInputSchema.parse({ projectId, workspaceId, machineId: 'unassigned', generation: 1, role: 'runner', checkout: { kind: 'snapshot', commit: 'a'.repeat(40) }, capabilities: [] }))).attachment;
    });
    expect((await f.request(binding, 'unassigned')).status).toBe(400);
    await runInDurableObject(f.authority, async (_instance, state) => {
      const store = new AttachmentStore(state.storage, services);
      store.detach({ ...runner, state: 'lost' });
      await store.attach(RuntimeAttachInputSchema.parse({ projectId, workspaceId, machineId: 'unassigned', generation: 2, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, capabilities: [] }));
    });
    const read = await f.request(binding, 'unassigned');
    expect(read.status, await read.text()).toBe(200);
    const write = await f.request({ ...binding, scope: 'write' }, 'unassigned');
    expect(write.status, await write.text()).toBe(200);
  });

  it('independent machine caches coexist while the same shared checkout requires a completed drain before replacement', async () => {
    const f = await fixture(['space.control']);
    await runInDurableObject(f.authority, async (_instance, state) => {
      const store = new AttachmentStore(state.storage, {
        seal: async secret => secret, open: async secret => secret,
        dispatch: async () => { throw new Error('No machine calls allowed in this regression'); },
      });
      const admission = RuntimeAttachInputSchema.parse({ projectId, workspaceId, machineId: 'assigned', generation: 0, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, capabilities: [] });
      const input = { ...admission, requestId: 'assigned-request' };
      const first = await store.requestCache(input);
      expect((await store.requestCache(input)).attachment.attachmentId).toBe(first.attachment.attachmentId);
      await expect(store.requestCache({ ...input, requestId: 'premature' })).rejects.toThrow();
      const other = await store.requestCache({ ...RuntimeAttachInputSchema.parse({ ...admission, machineId: 'other' }), requestId: 'other-machine' });
      expect((await store.assignments(other.attachment.machineId))[0]?.grant.attachment.attachmentId).toBe(other.attachment.attachmentId);
      expect(other.attachment.machineId).not.toBe(first.attachment.machineId);
      expect((await store.assignments(admission.machineId))[0]?.grant.attachment.state).toBe('attaching');
      expect(() => store.detach({ ...first.attachment, generation: first.attachment.generation + 1, state: 'draining' })).toThrow();
      expect(() => store.detach({ ...first.attachment, state: 'detached' })).toThrow();
      store.detach({ ...first.attachment, state: 'draining' });
      await expect(store.requestCache({ ...input, requestId: 'while-draining' })).rejects.toThrow();
      expect((await store.assignments(admission.machineId))[0]?.grant.attachment.state).toBe('draining');
      expect(() => store.detach({ ...first.attachment, state: 'detached' })).toThrow();
      store.recordCacheFlush(first.attachment.attachmentId, first.attachment.generation);
      store.detach({ ...first.attachment, state: 'detached' });
      expect(await store.assignments(admission.machineId)).toEqual([]);
      expect(await store.assignments(admission.machineId)).toEqual([]);
      expect((await store.requestCache(input)).attachment.state).toBe('detached');
      const renewed = await store.requestCache({ ...input, requestId: 'explicit-new-request' });
      expect(renewed.attachment.generation).toBeGreaterThan(first.attachment.generation);
      expect(renewed.attachment.attachmentId).not.toBe(first.attachment.attachmentId);
    });
  });

  it('requires all durable setup receipts for every equal canonical cache', async () => {
    const f = await fixture(['space.control']);
    await runInDurableObject(f.authority, async (_instance, state) => {
      const unsupported = async (): Promise<never> => { throw new Error('Unexpected external operation'); };
      const store = new AttachmentStore(state.storage, { seal: async secret => secret, open: async secret => secret, dispatch: unsupported });
      const controller = new RuntimeAttachmentController({
        attachments: store,
        code: new ArtifactsCodeStore({ get: unsupported, create: unsupported, import: unsupported, list: unsupported, delete: unsupported }),
        publish() {}, snapshot: async () => null, origin: async () => null,
        lifecycle: async () => emptyLifecycleState(projectId, workspaceId),
        authorizeMachine: async () => {},
      });
      for (const machineId of ['first-cache', 'second-cache']) {
        const input = RuntimeAttachInputSchema.parse({ projectId, workspaceId, machineId, generation: 0, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, capabilities: [] });
        const { attachment } = await store.requestCache({ ...input, requestId: machineId });
        await expect(controller.ready({ ...attachment, commit: 'a'.repeat(40), prerequisitesComplete: true })).rejects.toThrow(/durable receipt/);
        expect(store.list().find(item => item.attachmentId === attachment.attachmentId)?.state).toBe('attaching');
      }
    });
  });

  it('retains reclaimed canonical caches and fences reclamation behind final publication', async () => {
    const f = await fixture(['space.control']);
    await runInDurableObject(f.authority, async (_instance, state) => {
      const store = new AttachmentStore(state.storage, {
        seal: async secret => secret, open: async secret => secret,
        dispatch: async () => { throw new Error('Unexpected machine dispatch'); },
      });
      const admission = RuntimeAttachInputSchema.parse({ projectId, workspaceId, machineId: 'cache', generation: 0, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, capabilities: [] });
      const { attachment } = await store.requestCache({ ...admission, requestId: 'cache-admit' });
      const requested = store.requestCacheAction({ ...attachment, requestId: 'reclaim-cache', action: { kind: 'reclaim' } });
      expect(requested.attachment.cacheAction?.status).toBe('requested');
      const now = new Date().toISOString();
      const observation = { state: 'reclaimed', platform: 'linux', activity: [], lastActivityAt: now, pausedAt: now, reclaimAt: now, lastSyncAt: now, localWorkOptIn: false, setup: [] };
      const heartbeat = RuntimeHeartbeatInputSchema.parse({ ...attachment, executionObservation: { activeExecutions: 0, observedAt: now }, cache: observation, cacheAction: { requestId: 'reclaim-cache', status: 'completed', error: null } });
      expect(() => store.heartbeat(heartbeat)).toThrow(/snapshot/i);
      store.recordCacheFlush(attachment.attachmentId, attachment.generation);
      expect(store.heartbeat(heartbeat).cache?.state).toBe('reclaimed');
      expect((await store.assignments(attachment.machineId))[0]?.grant.attachment.attachmentId).toBe(attachment.attachmentId);
      const setup = store.requestCacheAction({ ...attachment, requestId: 'restore-cache', action: { kind: 'setup' } });
      expect(setup.attachment.cacheAction?.status).toBe('requested');
      expect(setup.attachment.state).not.toBe('ready');
    });
  });

});
