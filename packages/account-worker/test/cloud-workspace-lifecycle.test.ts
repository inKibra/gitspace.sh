import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, createSignedRpcFetch, credentialProtocolBase64, signDeviceInvite, type DeviceCapability } from '@gitspace/protocol';
import { gitspaceContract } from '@gitspace/protocol/rpc-contract';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { RuntimeAttachmentSchema, RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { createBrowserClient } from 'result-rpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tenantRootPrivateKey } from './setup.js';
import { createAccountWorkspaceRuntime } from '../src/account-runtime-host.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { PlanDoc, QuestionsDoc, WorkspaceDoc } from '@gitspace/runtime-core';

afterEach(() => vi.restoreAllMocks());

const commit = (digit: string) => digit.repeat(40);

/** Artifacts is the only service outside the account: refs per repository, forks, branch writes and deletions. */
function cloudArtifacts() {
  const refs = new Map<string, string>();
  const forks: Array<{ workspaceId: string; source: string | undefined }> = [];
  const deleted: string[] = [];
  const repository = (name: string): ArtifactsRepoInfo => ({ id: name, name, description: null, defaultBranch: 'main', createdAt: '', updatedAt: '', lastPushAt: null, source: null, readOnly: false, remote: `https://artifacts.invalid/${name}.git` });
  const ref = (name: string, value: string) => `${name} ${value === 'HEAD' || value.startsWith('refs/') ? value : `refs/heads/${value}`}`;
  vi.spyOn(ArtifactsCodeStore.prototype, 'ensureEmptyProject').mockImplementation(async (projectId) => repository(`project-${projectId}`));
  vi.spyOn(ArtifactsCodeStore.prototype, 'importProject').mockImplementation(async projectId => repository(`project-${projectId}`));
  vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockImplementation(async (projectId, workspaceId, source) => {
    const name = `workspace-${workspaceId}`;
    if (!forks.some(fork => fork.workspaceId === workspaceId)) {
      forks.push({ workspaceId, source });
      const from = source ?? `project-${projectId}`;
      for (const [key, value] of [...refs]) if (key.startsWith(`${from} `)) refs.set(`${name} ${key.slice(from.length + 1)}`, value);
    }
    return repository(name);
  });
  vi.spyOn(ArtifactsCodeStore.prototype, 'resolveRef').mockImplementation(async (name, value) => refs.get(ref(name, value)) ?? null);
  vi.spyOn(ArtifactsCodeStore.prototype, 'resolveAdvertisedRef').mockImplementation(async (name, value) => refs.get(ref(name, value)) ?? null);
  const copyCommit = vi.spyOn(ArtifactsCodeStore.prototype, 'copyCommit').mockImplementation(async (source, destination, value, hash, previous) => {
    if (![...refs].some(([key, commit]) => key.startsWith(`${source} `) && commit === hash)) throw new Error('Source commit is missing');
    const current = refs.get(ref(destination, value));
    if (current && current !== previous && current !== hash) throw new Error('Snapshot conflict: checkpoint ref has advanced');
    refs.set(ref(destination, value), hash);
  });
  vi.spyOn(ArtifactsCodeStore.prototype, 'readCommit').mockImplementation(async (name, hash) => [...refs].some(([key, value]) => key.startsWith(`${name} `) && value === hash)
    ? { hash, treeHash: commit('9'), parents: [], message: 'source', author: { name: 'a', email: 'a@test' }, committer: { name: 'a', email: 'a@test' }, authoredAt: 0, committedAt: 0 }
    : null);
  const setBranch = vi.spyOn(ArtifactsCodeStore.prototype, 'setBranch').mockImplementation(async (name, branch, value) => { refs.set(ref(name, branch), value); });
  vi.spyOn(ArtifactsCodeStore.prototype, 'initialCheckpoint').mockImplementation(async (name, workspaceId, branch) => {
    const head = refs.get(ref(name, branch));
    return head ? { checkpointRef: `refs/gitspace/spaces/${workspaceId}/checkpoints`, headCommit: head, branch, indexCommit: head, trackedWorktreeCommit: head, worktreeCommit: head, indexTree: commit('9'), worktreeTree: commit('9') } : null;
  });
  vi.spyOn(ArtifactsCodeStore.prototype, 'deleteRepository').mockImplementation(async (name) => { deleted.push(name); return true; });
  return { refs, forks, deleted, setBranch, copyCommit };
}

async function account(capabilities: DeviceCapability[] = ['rpc.read', 'rpc.write']) {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(71)) });
  await env.USER_SETTINGS.getByName(userId).setHandle('bootstrap', 0, env.TENANT_ID);
  const browserKey = crypto.getRandomValues(new Uint8Array(32));
  const invite = signDeviceInvite({ version: 1, userId, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities, canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'https://api.gitspace.sh' }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(browserKey)), label: 'Browser', boundAt: Date.now(), signingPrivateKey: browserKey });
  const enrolled = await vault.enrollDevice({ invite, binding });
  if (enrolled.status !== 'ok') throw new Error(enrolled.error.message);
  const client = createBrowserClient({ contract: gitspaceContract, transport: createRoutedTransport({
    homeUrl: `https://${env.TENANT_ID}.gitspace.sh/rpc`,
    fetch: createSignedRpcFetch({ deviceId: binding.deviceId, userId, signingPrivateKey: browserKey, fetch: async (input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(new Request(input, init)) }),
  }) });
  return { userId, client };
}

async function cloudProject(name: string, repositoryUrl: string | null = null) {
  const artifacts = cloudArtifacts();
  const { userId, client } = await account();
  const created = await client.project.create({ name, baseBranch: repositoryUrl ? 'main' : null, repositoryUrl });
  if (created.status === 'error') throw created.error;
  const project = created.value.project;
  artifacts.refs.set(`project-${project.id} refs/heads/main`, commit('1'));
  return { userId, client, project, artifacts, authority: env.PROJECT_AUTHORITY.getByName(`${userId}:${project.id}`), index: env.USER_PROJECTS.getByName(userId) };
}

describe('cloud workspace lifecycle with no machines', () => {
  it('creates a workspace from the project base, opens its cloud runtime, and stacks another on it', async () => {
    const { userId, client, project, artifacts, authority, index } = await cloudProject('Create in cloud');
    const created = await client.workspace.create({ projectId: project.id, name: 'Cloud feature', branch: 'feature/cloud', phase: 'plan', sourceKind: 'base', sourceRef: '' });
    if (created.status === 'error') throw created.error;
    const workspaceId = created.value.workspace.id;
    expect(created.value).toMatchObject({
      workspace: { projectId: project.id, name: 'Cloud feature', branch: 'feature/cloud', phase: 'plan', possessedBy: null, closedAt: null },
      operation: { projectId: project.id, workspaceId, kind: 'workspace.create', state: 'succeeded', targetMachines: [], error: null },
    });
    expect((await authority.listWorkspaces()).find(workspace => workspace.id === workspaceId)).toMatchObject({ lifecycle: 'active', sourceKind: 'base', sourceRef: 'main', sourceCommit: commit('1') });
    expect((await authority.listOperations()).find(operation => operation.workspaceId === workspaceId)?.steps.map(step => step.state)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    expect(await index.locateWorkspace(workspaceId)).toBe(project.id);
    expect(artifacts.setBranch).toHaveBeenCalledWith(`workspace-${workspaceId}`, 'feature/cloud', commit('1'));
    expect(await client.space.view({ projectId: project.id, workspaceId })).toMatchObject({ status: 'ok', value: { workspaces: [{ id: workspaceId, branch: 'feature/cloud', phase: 'plan' }] } });

    const identity = RuntimeIdentitySchema.parse({ projectId: project.id, workspaceId });
    expect(await client.runtime.snapshot(identity)).toMatchObject({ status: 'ok', value: { ...identity, documents: { 'gitspace.workspace': { phase: 'plan' } } } });
    expect(await env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`).runtimeRepositoryCheckpoint(identity)).toMatchObject({ headCommit: commit('1'), branch: 'feature/cloud' });
    await runInDurableObject(env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`), async (_instance, state) => {
      const reopened = await createAccountWorkspaceRuntime(state, env, identity, async () => {});
      expect((await reopened.snapshot()).documents['gitspace.workspace']).toMatchObject({ phase: 'plan' });
      await reopened.wake();
      await reopened.harness.close(BACKGROUND_CONTEXT);
    });

    // A workspace source is a dependency: its phase is the ceiling, and its repository holds the commit the child starts from.
    const ahead = await client.workspace.create({ projectId: project.id, name: 'Too far', branch: 'too-far', phase: 'code', sourceKind: 'workspace', sourceRef: workspaceId });
    expect(ahead).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('cannot pass the phase') } } });
    const stacked = await client.workspace.create({ projectId: project.id, name: 'Stacked', branch: 'stacked', phase: 'plan', sourceKind: 'workspace', sourceRef: 'Cloud feature' });
    if (stacked.status === 'error') throw stacked.error;
    expect(stacked.value.workspace).toMatchObject({ phase: 'plan', relations: { dependsOn: [workspaceId], stackedOn: workspaceId } });
    expect(artifacts.forks).toContainEqual({ workspaceId: stacked.value.workspace.id, source: `workspace-${workspaceId}` });
    expect(artifacts.setBranch).toHaveBeenCalledWith(`workspace-${stacked.value.workspace.id}`, 'stacked', commit('1'));
    expect((await authority.listWorkspaces()).filter(workspace => workspace.kind === 'worktree').map(workspace => workspace.name).sort()).toEqual(['Cloud feature', 'Stacked']);
  });

  it('refuses invalid branches and unresolvable sources before anything enters the catalog', async () => {
    const { client, project, authority } = await cloudProject('Refusals');
    const create = (change: Partial<Parameters<typeof client.workspace.create>[0]>) => client.workspace.create({ projectId: project.id, name: 'Refused', branch: 'refused', sourceKind: 'base', sourceRef: '', ...change });
    for (const branch of ['bad..name', '-flag', 'with space', 'trailing/', 'part.lock', 'HEAD', '.hidden']) {
      expect(await create({ branch })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('is not a valid branch name') } } });
    }
    expect(await create({ sourceKind: 'branch', sourceRef: 'origin/missing' })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('Branch missing does not exist') } } });
    expect(await create({ sourceKind: 'commit', sourceRef: 'abc123' })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('40-character') } } });
    expect(await create({ sourceKind: 'commit', sourceRef: commit('7') })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('does not exist') } } });
    expect(await create({ sourceKind: 'workspace', sourceRef: 'nobody' })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('Source workspace nobody does not exist') } } });
    expect(await create({ dependsOn: ['nobody'] })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('Dependency workspace nobody does not exist') } } });
    expect(await create({ projectId: 'missing-project' })).toMatchObject({ status: 'error', error: { _tag: 'gitspace/project-not-found' } });
    expect((await authority.listWorkspaces()).filter(workspace => workspace.kind === 'worktree')).toEqual([]);
    expect(await create({ sourceKind: 'branch', sourceRef: 'refs/remotes/origin/main' })).toMatchObject({ status: 'ok', value: { workspace: { branch: 'refused' } } });
    expect(await create({ name: 'From commit', branch: 'from-commit', sourceKind: 'commit', sourceRef: commit('1') })).toMatchObject({ status: 'ok' });
  });

  it('imports missing public branches for workspace sources and base switches without refreshing cached refs', async () => {
    const { userId, client, project, artifacts, authority } = await cloudProject('Public branches', 'https://github.com/octocat/Hello-World.git');
    const importRef = vi.spyOn(ArtifactsCodeStore.prototype, 'importSourceRef').mockImplementation(async (projectId, _url, ref) => {
      const hash = ref === 'refs/heads/feature/public' ? commit('2') : ref === 'refs/heads/release/public' ? commit('3') : null;
      if (!hash) throw new Error(`Source ref ${ref} is not advertised by the public origin`);
      artifacts.refs.set(`project-${projectId} ${ref}`, hash);
      return hash;
    });
    const created = await client.workspace.create({ projectId: project.id, name: 'Public feature', branch: 'work', sourceKind: 'branch', sourceRef: 'origin/feature/public' });
    if (created.status === 'error') throw created.error;
    expect((await authority.listWorkspaces()).find(workspace => workspace.id === created.value.workspace.id)).toMatchObject({ sourceRef: 'feature/public', sourceCommit: commit('2'), lifecycle: 'active' });
    expect(await env.SPACE_AUTHORITY.getByName(`${userId}:${created.value.workspace.id}`).runtimeRepositoryCheckpoint({ projectId: project.id, workspaceId: created.value.workspace.id })).toMatchObject({ branch: 'work', headCommit: commit('2') });

    const identity = { projectId: project.id, workspaceId: project.id };
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${project.id}`);
    expect(await space.runtimeRepositoryCheckpoint(identity)).toMatchObject({ branch: 'main', headCommit: commit('1') });
    const current = await authority.getProject();
    if (!current) throw new Error('Missing project');
    const beforeMissing = await authority.listWorkspaces();
    expect(await client.workspace.create({ projectId: project.id, name: 'Missing public branch', branch: 'missing', sourceKind: 'branch', sourceRef: 'missing' })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('not advertised by the public origin') } } });
    expect(await client.project.setBaseBranch({ projectId: project.id, expectedRevision: current.revision, baseBranch: 'missing' })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('not advertised by the public origin') } } });
    expect(await authority.getProject()).toEqual(current);
    expect(await authority.listWorkspaces()).toEqual(beforeMissing);
    expect(await space.runtimeRepositoryCheckpoint(identity)).toMatchObject({ branch: 'main', headCommit: commit('1') });
    expect(await client.project.setBaseBranch({ projectId: project.id, expectedRevision: current.revision - 1, baseBranch: 'release/public' })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('revision conflict') } } });
    expect(artifacts.refs.has(`project-${project.id} refs/heads/release/public`)).toBe(false);
    expect(await client.project.setBaseBranch({ projectId: project.id, expectedRevision: current.revision, baseBranch: 'release/public' })).toMatchObject({ status: 'ok', value: { baseBranch: 'release/public' } });
    expect(await space.runtimeRepositoryCheckpoint(identity)).toMatchObject({ branch: 'release/public', headCommit: commit('3'), indexCommit: commit('3'), worktreeCommit: commit('3') });
    expect((await authority.listWorkspaces()).find(workspace => workspace.kind === 'base')).toMatchObject({ branch: 'release/public', sourceCommit: commit('3') });
    expect((await authority.listWorkspaces()).find(workspace => workspace.id === created.value.workspace.id)?.branch).toBe('work');

    importRef.mockRejectedValue(new Error('Origin unavailable'));
    const cached = await client.workspace.create({ projectId: project.id, name: 'Cached public feature', branch: 'cached', sourceKind: 'branch', sourceRef: 'refs/heads/feature/public' });
    if (cached.status === 'error') throw cached.error;
    expect((await authority.listWorkspaces()).find(workspace => workspace.id === cached.value.workspace.id)?.sourceCommit).toBe(commit('2'));
    const latest = await authority.getProject();
    if (!latest) throw new Error('Missing project');
    expect(await client.project.setBaseBranch({ projectId: project.id, expectedRevision: latest.revision, baseBranch: 'feature/public' })).toMatchObject({ status: 'ok' });
    expect(await space.runtimeRepositoryCheckpoint(identity)).toMatchObject({ branch: 'feature/public', headCommit: commit('2') });
  });

  it('resumes a failed creation from the cloud and refuses to retry a finished one', async () => {
    const { client, project, artifacts, authority } = await cloudProject('Retry');
    artifacts.setBranch.mockRejectedValueOnce(new Error('Artifacts push unavailable'));
    const failed = await client.workspace.create({ projectId: project.id, name: 'Retried', branch: 'retried', sourceKind: 'base', sourceRef: '' });
    expect(failed).toMatchObject({ status: 'error', error: { data: { message: 'Artifacts push unavailable' } } });
    const definition = (await authority.listWorkspaces()).find(workspace => workspace.name === 'Retried');
    if (!definition) throw new Error('A failed creation keeps its definition for Retry and Delete');
    expect(definition).toMatchObject({ lifecycle: 'failed', sourceCommit: commit('1') });
    expect((await authority.listOperations()).find(operation => operation.workspaceId === definition.id)).toMatchObject({
      kind: 'workspace.create', state: 'failed', error: 'Artifacts push unavailable',
      steps: [{ id: 'source', state: 'succeeded' }, { id: 'repository', state: 'succeeded' }, { id: 'branch', state: 'failed', message: 'Artifacts push unavailable' }, { id: 'activate', state: 'queued' }],
    });
    const retried = await client.workspace.retryCreate({ workspaceId: definition.id });
    expect(retried).toMatchObject({ status: 'ok', value: { workspace: { id: definition.id, branch: 'retried' }, operation: { kind: 'workspace.create', state: 'succeeded', targetMachines: [] } } });
    expect((await authority.listWorkspaces()).find(workspace => workspace.id === definition.id)).toMatchObject({ lifecycle: 'active', sourceCommit: commit('1') });
    expect(await client.workspace.retryCreate({ workspaceId: definition.id })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('only a failed or unfinished creation can be retried') } } });
    expect(await client.workspace.retryCreate({ workspaceId: 'missing' })).toMatchObject({ status: 'error', error: { _tag: 'gitspace/workspace-not-found' } });
  });

  it('archives, restores and deletes a workspace, stopping its runtime and detaching its caches in the cloud', async () => {
    const { userId, client, project, artifacts, authority, index } = await cloudProject('Archive');
    const created = await client.workspace.create({ projectId: project.id, name: 'Archived', branch: 'archived', sourceKind: 'base', sourceRef: '' });
    if (created.status === 'error') throw created.error;
    const workspaceId = created.value.workspace.id;
    const identity = { projectId: project.id, workspaceId };
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`);
    await space.runtimeAttachments(identity);
    const cache = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'cache-a', machineId: 'gone-machine', generation: 1, role: 'cache', state: 'ready',
      checkout: { kind: 'shared', branch: 'archived' }, capabilities: [], updatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
    await runInDurableObject(space, (_instance, state) => {
      state.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', cache.attachmentId, JSON.stringify(cache), 'fixture');
    });
    const current = async () => {
      const definition = (await authority.listWorkspaces()).find(workspace => workspace.id === workspaceId);
      if (!definition) throw new Error('Workspace definition is missing');
      return definition;
    };
    const archive = async () => client.workspace.archive({ projectId: project.id, spaceId: workspaceId, expectedRevision: (await current()).revision, expectedGeneration: null });
    expect(await client.workspace.archive({ projectId: project.id, spaceId: workspaceId, expectedRevision: 0, expectedGeneration: null })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('revision conflict') } } });
    expect(await archive()).toMatchObject({ status: 'ok', value: { id: workspaceId, lifecycle: 'archived' } });
    expect(await space.runtimeAttachments(identity)).toMatchObject([{ attachmentId: 'cache-a', state: 'draining' }]);
    expect((await authority.listOperations()).find(operation => operation.kind === 'workspace.archive' && operation.workspaceId === workspaceId)).toMatchObject({ state: 'succeeded', targetMachines: [] });
    expect(await client.space.view({ projectId: project.id, workspaceId })).toMatchObject({ status: 'ok', value: { workspaces: [{ id: workspaceId, closedAt: expect.any(Date) }] } });

    expect(await client.workspace.restore({ spaceId: workspaceId, expectedGeneration: 3 })).toMatchObject({ status: 'error' });
    expect(await client.workspace.restore({ spaceId: workspaceId, expectedGeneration: 0 })).toMatchObject({ status: 'ok', value: { id: workspaceId, projectId: project.id, kind: 'worktree', state: 'active', machineId: null, generation: 0 } });
    expect(await current()).toMatchObject({ lifecycle: 'active', archivedAt: null });
    expect(await client.workspace.delete({ workspaceId })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('Archive') } } });
    expect(await client.workspace.delete({ workspaceId: project.id })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('base workspace') } } });

    expect(await archive()).toMatchObject({ status: 'ok' });
    expect(await client.workspace.delete({ workspaceId })).toMatchObject({ status: 'ok', value: { workspaceId, deleted: true } });
    expect((await authority.listWorkspaces()).some(workspace => workspace.id === workspaceId)).toBe(false);
    expect(await index.locateWorkspace(workspaceId)).toBeNull();
    expect(artifacts.deleted).toEqual([`workspace-${workspaceId}`]);
    expect(await space.hasCloudRuntime()).toBe(false);
    expect(await client.workspace.delete({ workspaceId })).toMatchObject({ status: 'error', error: { _tag: 'gitspace/workspace-not-found' } });
  });

  it('switches an opened clean base checkout and keeps the new branch after reopening', async () => {
    const { userId, client, project, artifacts, authority } = await cloudProject('Opened base');
    // A branch introduced after the base fork must bring its objects into that existing repository.
    const identity = { projectId: project.id, workspaceId: project.id };
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${project.id}`);
    expect(await space.runtimeRepositoryCheckpoint(identity)).toMatchObject({ branch: 'main', headCommit: commit('1') });
    artifacts.refs.set(`project-${project.id} refs/heads/develop`, commit('2'));
    const current = await authority.getProject();
    if (!current) throw new Error('Missing project');
    expect(await client.project.setBaseBranch({ projectId: project.id, expectedRevision: current.revision, baseBranch: 'develop' })).toMatchObject({ status: 'ok' });
    expect(await space.runtimeRepositoryCheckpoint(identity)).toMatchObject({ branch: 'develop', headCommit: commit('2'), indexCommit: commit('2'), worktreeCommit: commit('2') });
    expect((await authority.listWorkspaces()).find(workspace => workspace.kind === 'base')).toMatchObject({ branch: 'develop', sourceRef: 'develop', sourceCommit: commit('2') });
    expect(artifacts.refs.get(`workspace-${project.id} refs/heads/develop`)).toBe(commit('2'));
    await runInDurableObject(space, async (_instance, state) => {
      const reopened = await createAccountWorkspaceRuntime(state, env, RuntimeIdentitySchema.parse(identity), async () => {});
      expect(await reopened.cloudFiles.initializeSnapshot()).toMatchObject({ branch: 'develop', headCommit: commit('2') });
      await reopened.wake();
      await reopened.harness.close(BACKGROUND_CONTEXT);
    });
  });

  it('rejects dirty base checkout before changing its branch, refs or canonical metadata', async () => {
    const { userId, client, project, artifacts, authority, index } = await cloudProject('Dirty base');
    artifacts.refs.set(`project-${project.id} refs/heads/develop`, commit('2'));
    const identity = { projectId: project.id, workspaceId: project.id };
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${project.id}`);
    const clean = await space.runtimeRepositoryCheckpoint(identity);
    const dirty = { ...clean, indexTree: commit('3'), worktreeTree: commit('4'), indexCommit: commit('5'), worktreeCommit: commit('6') };
    await runInDurableObject(space, (_instance, state) => {
      state.storage.sql.exec('UPDATE runtime_code_snapshot SET checkpoint=? WHERE singleton=1', JSON.stringify(dirty));
    });
    const current = await authority.getProject();
    if (!current) throw new Error('Missing project');
    const before = await authority.listWorkspaces();
    const refs = [...artifacts.refs];
    expect(await client.project.setBaseBranch({ projectId: project.id, expectedRevision: current.revision, baseBranch: 'develop' })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('uncommitted changes') } } });
    expect(await space.runtimeRepositoryCheckpoint(identity)).toEqual(dirty);
    expect(await authority.getProject()).toEqual(current);
    expect(await authority.listWorkspaces()).toEqual(before);
    expect((await index.list()).find(entry => entry.id === project.id)?.baseBranch).toBe('main');
    expect([...artifacts.refs]).toEqual(refs);
  });

  it('fences an interrupted ref publication and resumes it without exposing partial metadata', async () => {
    const { userId, client, project, artifacts, authority } = await cloudProject('Branch recovery');
    artifacts.refs.set(`project-${project.id} refs/heads/develop`, commit('2'));
    const identity = RuntimeIdentitySchema.parse({ projectId: project.id, workspaceId: project.id });
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${project.id}`);
    await space.runtimeRepositoryCheckpoint(identity);
    const current = await authority.getProject();
    if (!current) throw new Error('Missing project');
    const copy = artifacts.copyCommit.getMockImplementation();
    if (!copy) throw new Error('Missing copy fixture');
    artifacts.copyCommit.mockImplementationOnce(copy).mockRejectedValueOnce(new Error('Checkpoint push interrupted'));
    const input = { projectId: project.id, expectedRevision: current.revision, baseBranch: 'develop' };
    expect(await client.project.setBaseBranch(input)).toMatchObject({ status: 'error', error: { data: { message: 'Checkpoint push interrupted' } } });
    expect((await authority.getProject())?.baseBranch).toBe('main');
    expect((await authority.listWorkspaces()).find(workspace => workspace.kind === 'base')?.branch).toBe('main');
    expect(await client.runtime.snapshot(identity)).toMatchObject({ status: 'error' });
    expect(await client.project.setBaseBranch(input)).toMatchObject({ status: 'ok', value: { baseBranch: 'develop' } });
    expect(await space.runtimeRepositoryCheckpoint(identity)).toMatchObject({ branch: 'develop', headCommit: commit('2') });
    expect((await authority.listWorkspaces()).find(workspace => workspace.kind === 'base')).toMatchObject({ branch: 'develop', sourceCommit: commit('2') });
  });

  it('creates from advertised tags and pull request heads without a machine', async () => {
    const { client, project, artifacts, authority } = await cloudProject('Imported refs');
    artifacts.refs.set(`project-${project.id} refs/tags/v1`, commit('3'));
    artifacts.refs.set(`project-${project.id} refs/pull/12/head`, commit('4'));
    expect(await client.workspace.create({ projectId: project.id, name: 'Tag', branch: 'tag-work', sourceKind: 'tag', sourceRef: 'refs/tags/v1' })).toMatchObject({ status: 'ok' });
    expect(await client.workspace.create({ projectId: project.id, name: 'PR', branch: 'pr-work', sourceKind: 'pull-request', sourceRef: '12' })).toMatchObject({ status: 'ok' });
    const workspaces = await authority.listWorkspaces();
    expect(workspaces.find(workspace => workspace.name === 'Tag')).toMatchObject({ sourceKind: 'tag', sourceRef: 'v1', sourceCommit: commit('3') });
    expect(workspaces.find(workspace => workspace.name === 'PR')).toMatchObject({ sourceKind: 'pull-request', sourceRef: '12', sourceCommit: commit('4') });
  });

  it('rejects a legacy machine-held checkout before creating or publishing cloud runtime state', async () => {
    const { userId, client, project, artifacts, authority } = await cloudProject('Legacy held');
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${project.id}`);
    const placement = await space.bootstrap({ projectId: project.id, spaceId: project.id, machineId: 'legacy-machine' });
    if (placement.status === 'error') throw new Error(placement.failure.message);
    const identity = RuntimeIdentitySchema.parse({ projectId: project.id, workspaceId: project.id });
    expect(await client.runtime.snapshot(identity)).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('must be migrated from its machine checkout') } } });
    artifacts.refs.set(`project-${project.id} refs/heads/develop`, commit('2'));
    const current = await authority.getProject();
    if (!current) throw new Error('Missing project');
    expect(await client.project.setBaseBranch({ projectId: project.id, expectedRevision: current.revision, baseBranch: 'develop' })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('must be migrated from its machine checkout') } } });
    expect(await space.hasCloudRuntime()).toBe(false);
    expect(await space.get()).toEqual(placement.value);
    expect(await authority.getProject()).toEqual(current);
    expect(artifacts.forks).toEqual([]);
    await runInDurableObject(space, async (_instance, state) => {
      expect(await state.storage.get('runtime.identity')).toBeUndefined();
      expect(await state.storage.get('directory.runtimePublished')).toBeUndefined();
    });
  });

  it('preserves explicit phases and approved plan transitions across runtime reopening', async () => {
    const { userId, client, project } = await cloudProject('Durable phase');
    const created = await client.workspace.create({ projectId: project.id, name: 'Reviewed', branch: 'reviewed', phase: 'review', sourceKind: 'base', sourceRef: '' });
    if (created.status === 'error') throw created.error;
    const identity = RuntimeIdentitySchema.parse({ projectId: project.id, workspaceId: created.value.workspace.id });
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${identity.workspaceId}`);
    await runInDurableObject(space, async (_instance, state) => {
      const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${project.id}`);
      const runtime = await createAccountWorkspaceRuntime(state, env, identity, async () => {});
      expect((await runtime.harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT))?.phase).toBe('review');
      await runtime.session(undefined, { type: 'setWorkspacePhase', phase: 'plan' }, true);
      expect((await authority.listWorkspaces()).find(workspace => workspace.id === identity.workspaceId)?.phase).toBe('plan');
      const root = await runtime.harness.root(BACKGROUND_CONTEXT);
      await runtime.harness.commit(async tx => {
        const plan = await tx.doc(PlanDoc, root.id);
        plan.status = 'proposed'; plan.questionId = 'approved-plan';
        (await tx.doc(QuestionsDoc)).items.push({ id: 'approved-plan', conversationId: String(root.id), kind: 'approval', prompt: 'Approve this plan?', choices: [], answer: null });
      }, BACKGROUND_CONTEXT);
      await runtime.snapshot();
      await runtime.answer({ ...identity, questionId: 'approved-plan', answer: true }, { deviceId: 'browser', canApprove: true });
      expect((await authority.listWorkspaces()).find(workspace => workspace.id === identity.workspaceId)?.phase).toBe('code');
      await runtime.wake();
      await runtime.harness.close(BACKGROUND_CONTEXT);
      const reopened = await createAccountWorkspaceRuntime(state, env, identity, async () => {});
      expect((await reopened.harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT))?.phase).toBe('code');
      await reopened.wake();
      await reopened.harness.close(BACKGROUND_CONTEXT);
    });
  });

  it('archives, restores, rebases and deletes a project in the cloud; the GitSpace project refuses archive and delete', async () => {
    const { client, project, artifacts, authority, index } = await cloudProject('Project lifecycle');
    artifacts.refs.set(`project-${project.id} refs/heads/develop`, commit('2'));
    const created = await client.workspace.create({ projectId: project.id, name: 'Child', branch: 'child', sourceKind: 'base', sourceRef: '' });
    if (created.status === 'error') throw created.error;
    const revision = async () => (await authority.getProject())?.revision ?? -1;

    expect(await client.project.setBaseBranch({ projectId: project.id, expectedRevision: await revision(), baseBranch: 'bad..branch' })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('not a valid branch name') } } });
    expect(await client.project.setBaseBranch({ projectId: project.id, expectedRevision: await revision(), baseBranch: 'missing' })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('Branch missing does not exist') } } });
    expect(await client.project.setBaseBranch({ projectId: project.id, expectedRevision: await revision(), baseBranch: 'develop' })).toMatchObject({ status: 'ok', value: { id: project.id, baseBranch: 'develop', lifecycle: 'active' } });
    expect(await client.space.view({ projectId: project.id, workspaceId: null })).toMatchObject({ status: 'ok', value: { project: { baseBranch: 'develop' }, baseSpace: { branch: 'develop' } } });
    const fromBase = await client.workspace.create({ projectId: project.id, name: 'From develop', branch: 'from-develop', sourceKind: 'base', sourceRef: '' });
    expect(fromBase).toMatchObject({ status: 'ok' });
    expect(artifacts.setBranch).toHaveBeenLastCalledWith(expect.any(String), 'from-develop', commit('2'));

    expect(await client.project.delete({ projectId: project.id, expectedRevision: await revision() })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('Archive') } } });
    expect(await client.project.archive({ projectId: project.id, expectedRevision: await revision() })).toMatchObject({ status: 'ok', value: { lifecycle: 'archived', archivedAt: expect.any(Date) } });
    expect((await index.list('archived')).map(entry => entry.id)).toContain(project.id);
    expect(await client.project.restore({ projectId: project.id, expectedRevision: await revision() })).toMatchObject({ status: 'ok', value: { lifecycle: 'active', archivedAt: null } });
    expect(await client.project.archive({ projectId: project.id, expectedRevision: await revision() })).toMatchObject({ status: 'ok' });
    const workspaces = (await authority.listWorkspaces()).map(workspace => workspace.id);
    expect(await client.project.delete({ projectId: project.id, expectedRevision: await revision() })).toMatchObject({ status: 'ok', value: { projectId: project.id, deleted: true } });
    expect((await index.list()).some(entry => entry.id === project.id)).toBe(false);
    expect(await index.locateWorkspace(created.value.workspace.id)).toBeNull();
    expect((await authority.getProject())?.lifecycle).toBe('deleting');
    expect(artifacts.deleted.sort()).toEqual([`project-${project.id}`, ...workspaces.map(id => `workspace-${id}`)].sort());
    expect(await client.project.archive({ projectId: project.id, expectedRevision: 1 })).toMatchObject({ status: 'error', error: { _tag: 'gitspace/project-not-found' } });

    const listed = await client.project.list({ lifecycle: 'all' });
    if (listed.status === 'error') throw listed.error;
    const gitspace = listed.value.find(entry => entry.role === 'gitspace-source');
    if (!gitspace) throw new Error('Every account has the built-in GitSpace project');
    expect(await client.project.archive({ projectId: gitspace.id, expectedRevision: gitspace.revision })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('cannot be archived') } } });
    expect(await client.project.delete({ projectId: gitspace.id, expectedRevision: gitspace.revision })).toMatchObject({ status: 'error' });
    expect((await index.list()).some(entry => entry.id === gitspace.id)).toBe(true);
  });
});
