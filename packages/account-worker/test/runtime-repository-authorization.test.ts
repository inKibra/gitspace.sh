import { env, runInDurableObject } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant, type ControlOperation } from '@gitspace/protocol';
import { RuntimeAttachInputSchema } from '@gitspace/protocol-runtime';
import { ArtifactsCodeStore, AttachmentStore, type AttachmentServices } from '@gitspace/runtime-workspace-do';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { tenantRootPrivateKey } from './setup.js';
import { RuntimeAttachmentController } from '../src/runtime-attachments.js';

const projectId = 'repository-project';
const workspaceId = 'repository-workspace';
const signingKey = new Uint8Array(32).fill(41);
const lease = { remote: 'https://artifacts.test/workspace-repository-workspace.git', plaintext: 'test-scoped-repository-token', expiresAt: '2099-01-01T00:00:00.000Z' };

beforeEach(() => {
  // Keep the real signed route, device grants and workspace authority. Only the
  // external Artifacts service is replaced; no test mints a live credential.
  const repository = { id: 'test-repo', name: 'test-repo', description: null, defaultBranch: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastPushAt: null, source: null, readOnly: false, remote: lease.remote };
  vi.spyOn(ArtifactsCodeStore.prototype, 'ensureEmptyProject').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'credentials').mockResolvedValue(lease);
});
afterEach(() => vi.restoreAllMocks());

async function fixture(capabilities: Array<'storage.access' | 'space.control'>) {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(19)) });
  for (const machineId of ['primary', 'unassigned']) {
    await vault.registerDevice(signCredentialAuthorityGrant({
      version: 1, userId, machineId, generation: 1, capabilities,
      signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signingKey)),
      exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(new Uint8Array(32).fill(37))),
    }, tenantRootPrivateKey));
  }
  const project = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const created = await project.bootstrap({ id: projectId, name: 'Repository authorization', repositoryReference: null, baseBranch: 'main', createdBy: 'primary' });
  await project.setProjectLifecycle(created.revision, 'active');
  const workspace = { id: workspaceId, projectId, kind: 'worktree' as const, name: 'Repository', branch: 'main', phase: null, sourceKind: 'branch' as const, sourceRef: 'main', sourceCommit: null, lifecycle: 'active' as const, goalId: null, expectedRevision: 0 };
  await project.putWorkspace(workspace);
  const authority = env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`);
  await authority.bootstrap({ projectId, spaceId: workspaceId, machineId: 'primary' });
  const request = (payload: Record<string, unknown> = {}, machineId = 'primary', operation: ControlOperation = 'runtime.repository.credentials') => worker.fetch(new Request('https://auth.test/v1/control', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(createSignedControlRequest({ userId, machineId, operation, payload: { projectId, workspaceId, generation: 1, scope: 'read', ...payload }, signingPrivateKey: signingKey })),
  }), env);
  return { project, workspace, authority, request };
}

describe('signed repository credential authority', () => {
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
      const request = { projectId, workspaceId, machineId: 'primary', requestId: 'checkpoint-pin', sourceRef: checkpoint.checkpointRef, checkout: { kind: 'snapshot', commit } };
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
    expect((await f.request({}, 'primary', 'runtime.snapshot')).status).toBe(401);
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

  it('fences attachment generation and state and prevents runner publication', async () => {
    const f = await fixture(['storage.access']);
    const services: AttachmentServices = {
      seal: async () => 'test-sealed-execution-secret',
      open: async () => { throw new Error('This fixture does not recover execution secrets'); },
      dispatch: async () => { throw new Error('Repository authorization must not dispatch tools'); },
    };
    const attachment = await runInDurableObject(f.authority, async (_instance, state) => {
      const store = new AttachmentStore(state.storage, services);
      const { attachment } = await store.attach(RuntimeAttachInputSchema.parse({ projectId, workspaceId, machineId: 'primary', generation: 3, role: 'runner', checkout: { kind: 'snapshot', commit: 'a'.repeat(40) }, capabilities: [] }));
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

  it('independent machine replicas coexist while the same shared checkout requires a completed drain before replacement', async () => {
    const f = await fixture(['space.control']);
    await runInDurableObject(f.authority, async (_instance, state) => {
      const store = new AttachmentStore(state.storage, {
        seal: async secret => secret, open: async secret => secret,
        dispatch: async () => { throw new Error('No machine calls allowed in this regression'); },
      });
      const admission = RuntimeAttachInputSchema.parse({ projectId, workspaceId, machineId: 'primary', generation: 0, ownershipGeneration: 1, role: 'primary', checkout: { kind: 'shared', branch: 'main' }, capabilities: [] });
      const input = { ...admission, requestId: 'primary-request' };
      const first = await store.requestPrimary(input);
      expect((await store.requestPrimary(input)).attachment.attachmentId).toBe(first.attachment.attachmentId);
      await expect(store.requestPrimary({ ...input, ownershipGeneration: 2 })).rejects.toThrow();
      await expect(store.requestPrimary({ ...input, requestId: 'premature' })).rejects.toThrow();
      const other = await store.requestPrimary({ ...RuntimeAttachInputSchema.parse({ ...admission, machineId: 'other' }), requestId: 'other-machine' });
      expect((await store.assignments(other.attachment.machineId))[0]?.grant.attachment.attachmentId).toBe(other.attachment.attachmentId);
      expect(other.attachment.machineId).not.toBe(first.attachment.machineId);
      expect((await store.assignments(admission.machineId))[0]?.grant.attachment.state).toBe('attaching');
      expect(() => store.detach({ ...first.attachment, generation: first.attachment.generation + 1, state: 'draining' })).toThrow();
      expect(() => store.detach({ ...first.attachment, state: 'detached' })).toThrow();
      store.detach({ ...first.attachment, state: 'draining' });
      await expect(store.requestPrimary({ ...input, requestId: 'while-draining' })).rejects.toThrow();
      expect((await store.assignments(admission.machineId))[0]?.grant.attachment.state).toBe('draining');
      expect(() => store.detach({ ...first.attachment, state: 'detached' })).toThrow();
      store.recordPrimaryFlush(first.attachment.attachmentId, first.attachment.generation);
      store.detach({ ...first.attachment, state: 'detached' });
      expect(await store.assignments(admission.machineId)).toEqual([]);
      expect(await store.assignments(admission.machineId)).toEqual([]);
      expect((await store.requestPrimary(input)).attachment.state).toBe('detached');
      const renewed = await store.requestPrimary({ ...input, requestId: 'explicit-new-request' });
      expect(renewed.attachment.generation).toBeGreaterThan(first.attachment.generation);
      expect(renewed.attachment.attachmentId).not.toBe(first.attachment.attachmentId);
      expect(renewed.attachment.ownershipGeneration).toBe(1);
    });
  });

  it('native primary confirmation cannot create an unrequested lease or reuse stale canonical ownership', async () => {
    const f = await fixture(['space.control']);
    const input = { generation: 0, ownershipGeneration: 1, machineId: 'primary', role: 'primary', checkout: { kind: 'shared', branch: 'main' }, capabilities: [] };
    expect((await f.request(input, 'primary', 'runtime.attach')).status).toBe(400);
    const attachment = await runInDurableObject(f.authority, async (_instance, state) => {
      const store = new AttachmentStore(state.storage, {
        seal: async secret => secret, open: async secret => secret,
        dispatch: async () => { throw new Error('No machine effects allowed'); },
      });
      return (await store.requestPrimary({ ...RuntimeAttachInputSchema.parse({ ...input, projectId, workspaceId, ownershipGeneration: 0 }), requestId: 'stale-primary' })).attachment;
    });
    expect((await f.request({ ...input, generation: attachment.generation, ownershipGeneration: 0 }, 'primary', 'runtime.attach')).status).toBe(400);
    expect((await f.request({ ...input, generation: attachment.generation, machineId: 'unassigned' }, 'unassigned', 'runtime.attach')).status).toBe(400);
  });
});
