import { env, runInDurableObject } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant, type ControlOperation } from '@gitspace/protocol';
import { RuntimeAttachInputSchema } from '@gitspace/protocol-runtime';
import { ArtifactsCodeStore, AttachmentStore, type AttachmentServices } from '@gitspace/runtime-workspace-do';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { tenantRootPrivateKey } from './setup.js';

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

const services: AttachmentServices = {
  seal: async () => 'test-sealed-execution-secret',
  open: async () => { throw new Error('This fixture does not recover execution secrets'); },
  dispatch: async () => { throw new Error('Repository authorization must not dispatch tools'); },
};

async function attach(machineId: string, generation: number) {
  const authority = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`);
  await authority.runtimeAttachments({ projectId, workspaceId });
  await runInDurableObject(authority, async (_instance, state) => {
    await new AttachmentStore(state.storage, services).attach(RuntimeAttachInputSchema.parse({ projectId, workspaceId, machineId, generation, checkout: { kind: 'shared', branch: 'main' }, capabilities: [] }));
  });
}

async function fixture(capabilities: Array<'storage.access' | 'space.control'>, repositoryReference: string | null = null, attached = true) {
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
  if (attached) await attach('assigned', 1);
  const request = (payload: Record<string, unknown> = {}, machineId = 'assigned', operation: ControlOperation = 'runtime.repository.credentials') => worker.fetch(new Request('https://auth.test/v1/control', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(createSignedControlRequest({ userId, machineId, operation, payload: { projectId, workspaceId, generation: 1, scope: 'read', ...payload }, signingPrivateKey: signingKey })),
  }), env);
  return { project, workspace, authority, request };
}

describe('signed repository credential authority', () => {
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

  it('leases the cloud workspace repository only to a machine with a live checkout', async () => {
    // The machine git remote binds only the repository; it carries no attachment generation.
    const binding = { workspaceId: undefined, generation: undefined, repository: `workspace-${workspaceId}` };
    const f = await fixture(['storage.access'], null, false);
    expect((await f.request(binding, 'unassigned')).status).toBe(400);
    await attach('unassigned', 2);
    const read = await f.request(binding, 'unassigned');
    expect(read.status, await read.text()).toBe(200);
    const write = await f.request({ ...binding, scope: 'write' }, 'unassigned');
    expect(write.status, await write.text()).toBe(200);
  });
});
