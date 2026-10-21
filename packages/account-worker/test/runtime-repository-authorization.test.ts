import { env, runInDurableObject } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant, type ControlOperation } from '@gitspace/protocol';
import { RuntimeAttachInputSchema, RuntimeAttachmentReadyInputSchema } from '@gitspace/protocol-runtime';
import { ArtifactsCodeStore, AttachmentStore, type AttachmentServices } from '@gitspace/runtime-workspace-do';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { GitHubAppDO } from '../src/github-app.js';
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
    await new AttachmentStore(state.storage, services).attach(RuntimeAttachInputSchema.parse({ projectId, workspaceId, machineId, generation, checkout: { kind: 'shared', branch: 'main' }, capabilities: [] }), true);
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
    const definition = await f.project.getWorkspace(workspaceId);
    if (!definition) throw new Error('Workspace definition is missing');
    await f.authority.archiveWorkspace(definition);
    // Archiving detached the cache; a checkout attached afterwards may still read the archived repository, never publish.
    await attach('assigned', 2);
    expect((await f.request({ generation: 2 })).status).toBe(200);
    expect((await f.request({ scope: 'write', generation: 2 })).status).toBe(400);
  });

  it('leases an existing workspace repository without forking or importing it again', async () => {
    const f = await fixture(['storage.access']);
    for (let lease = 0; lease < 3; lease++) expect((await f.request()).status).toBe(200);
    expect(ArtifactsCodeStore.prototype.forkWorkspace).not.toHaveBeenCalled();
    expect(ArtifactsCodeStore.prototype.ensureEmptyProject).not.toHaveBeenCalled();
  });

  it('creates a missing workspace repository once, then leases it', async () => {
    const f = await fixture(['storage.access']);
    vi.mocked(ArtifactsCodeStore.prototype.credentials).mockRejectedValueOnce(Object.assign(new Error('Repository not found'), { name: 'ArtifactsError', code: 'NOT_FOUND' }));
    const leased = await f.request();
    expect({ status: leased.status, body: await leased.json() }).toEqual({ status: 200, body: { status: 'ok', value: lease } });
    expect(ArtifactsCodeStore.prototype.forkWorkspace).toHaveBeenCalledTimes(1);
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

describe('signed checkout origin access', () => {
  const installationToken = { token: 'ghs_test-installation-token', expiresAt: '2099-01-01T00:00:00.000Z' };
  async function originFixture(repositoryReference: string, capabilities: Array<'storage.access' | 'space.control'> = ['storage.access']) {
    const f = await fixture(capabilities, repositoryReference);
    const [attachment] = await f.authority.runtimeAttachments({ projectId, workspaceId });
    if (!attachment) throw new Error('The fixture attached no checkout');
    const tokens = vi.spyOn(GitHubAppDO.prototype, 'repositoryToken').mockResolvedValue(installationToken);
    // The App's installation covers Owner/Repo; GitHub itself is never called.
    await runInDurableObject(env.GITHUB_APP.getByName(env.ACCOUNT_ID), (_instance, state) => {
      state.storage.sql.exec('INSERT OR IGNORE INTO installation_repositories(installation_id, full_name) VALUES (?, ?)', 7, 'Owner/Repo');
    });
    const lease = { machineId: 'assigned', attachmentId: attachment.attachmentId, generation: 1 };
    const token = (access: 'read' | 'write', payload: Record<string, unknown> = {}, machineId = 'assigned') => f.request({ ...lease, access, ...payload }, machineId, 'runtime.repository.githubToken');
    const store = (run: (attachments: AttachmentStore) => unknown) => runInDurableObject(f.authority, async (_instance, state) => { run(new AttachmentStore(state.storage, services)); });
    return { ...f, attachment, lease, tokens, token, store, origin: (payload: Record<string, unknown> = {}) => f.request({ ...lease, ...payload }, 'assigned', 'runtime.repository.originAccess') };
  }

  it('routes a covered origin, in any address form, through installation tokens', async () => {
    const f = await originFixture('git@github.com:owner/repo.git');
    const route = await f.origin();
    expect(route.headers.get('cache-control')).toBe('private, no-store');
    expect(await route.json()).toEqual({ status: 'ok', value: { kind: 'github-app', repository: 'owner/repo' } });
    // Same checkout authorization as a repository lease: a foreign generation learns nothing.
    expect((await f.origin({ generation: 0 })).status).toBe(400);
  });

  it('answers an uncovered GitHub origin with the SSH route and refuses it any token', async () => {
    const f = await originFixture('https://github.com/someone/else.git');
    expect(await (await f.origin()).json()).toEqual({ status: 'ok', value: { kind: 'ssh' } });
    const refused = await f.token('read');
    expect({ status: refused.status, body: await refused.json() }).toMatchObject({ status: 400, body: { status: 'error' } });
    expect(f.tokens).not.toHaveBeenCalled();
  });

  it('issues tokens only to this machine\'s current checkout, and push tokens only once it is ready', async () => {
    const f = await originFixture('https://github.com/Owner/Repo');
    const read = await f.token('read');
    expect(read.headers.get('cache-control')).toBe('private, no-store');
    expect(await read.json()).toEqual({ status: 'ok', value: installationToken });
    expect(f.tokens).toHaveBeenLastCalledWith('Owner/Repo', 'read');
    // Still attaching: it may fetch, never push.
    expect((await f.token('write')).status).toBe(400);

    for (const [payload, machineId] of [
      [{ generation: 2 }, 'assigned'],
      [{ generation: 0 }, 'assigned'],
      [{ attachmentId: 'another-attachment' }, 'assigned'],
      [{ projectId: 'foreign-project' }, 'assigned'],
      [{ machineId: 'unassigned' }, 'assigned'],
      [{}, 'unassigned'],
      [{ machineId: 'unassigned' }, 'unassigned'],
    ] satisfies Array<[Record<string, unknown>, string]>) {
      const refused = await f.token('read', payload, machineId);
      expect({ payload, machineId, status: refused.status }).toEqual({ payload, machineId, status: 400 });
    }
    // An unregistered machine is not authenticated at all.
    expect((await f.token('read', {}, 'stranger')).status).toBe(401);
    expect(f.tokens).toHaveBeenCalledTimes(1);

    await f.store(attachments => attachments.ready(RuntimeAttachmentReadyInputSchema.parse({ projectId, workspaceId, ...f.lease, commit: 'a'.repeat(40), prerequisitesComplete: true, capabilities: [] })));
    expect(await (await f.token('write')).json()).toEqual({ status: 'ok', value: installationToken });
    expect(f.tokens).toHaveBeenLastCalledWith('Owner/Repo', 'write');

    await f.store(attachments => attachments.detach(f.attachment));
    expect((await f.token('read')).status).toBe(400);
    expect((await f.origin()).status).toBe(400);
    expect(f.tokens).toHaveBeenCalledTimes(2);
  });

  it('refuses a device that may not read repository storage', async () => {
    const f = await originFixture('https://github.com/Owner/Repo', ['space.control']);
    expect((await f.token('read')).status).toBe(401);
    expect((await f.origin()).status).toBe(401);
    expect(f.tokens).not.toHaveBeenCalled();
  });
});
