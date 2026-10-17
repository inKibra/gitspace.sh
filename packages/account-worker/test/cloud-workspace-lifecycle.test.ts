import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, createSignedRpcFetch, credentialProtocolBase64, signDeviceInvite, type DeviceCapability } from '@gitspace/protocol';
import { gitspaceContract } from '@gitspace/protocol/rpc-contract';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { RuntimeAttachmentSchema, RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { ArtifactsCodeStore, GitDiscoveryError } from '@gitspace/runtime-workspace-do';
import { createBrowserClient } from 'result-rpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Result } from 'better-result';
import { tenantRootPrivateKey } from './setup.js';
import { createAccountWorkspaceRuntime } from '../src/account-runtime-host.js';
import { SpaceAuthorityDO } from '../src/space-authority.js';
import { GitHubAppDO } from '../src/github-app.js';
import { UserProjectIndexDO } from '../src/project-authority.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { PlanDoc, QuestionsDoc, WorkspaceDoc } from '@gitspace/runtime-core';

afterEach(() => vi.restoreAllMocks());

const commit = (digit: string) => digit.repeat(40);
const noAttach = async (): Promise<never> => { throw new Error('Unexpected machine attach'); };

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
  // An opened runtime indexes its snapshot for code_search; these source trees are empty.
  vi.spyOn(ArtifactsCodeStore.prototype, 'reader').mockImplementation(() => ({ readTree: async () => [], readBlob: async () => null, readCommit: async () => null, log: async () => [], close: async () => {} }));
  return { refs, forks, deleted, setBranch, copyCommit };
}

/** Commit graphs the cloud compares, readable from any repository: each commit's parents, newer digits committed later. */
function cloudHistory(graph: Record<string, string[]>) {
  const metadata = (hash: string): ArtifactsCommitMetadata => ({ hash, treeHash: commit('9'), parents: graph[hash] ?? [], message: 'history', author: { name: 'a', email: 'a@test' }, committer: { name: 'a', email: 'a@test' }, authoredAt: 0, committedAt: Number.parseInt(hash.slice(0, 1), 16) });
  vi.spyOn(ArtifactsCodeStore.prototype, 'readCommit').mockImplementation(async (_name, hash) => hash in graph ? metadata(hash) : null);
  vi.spyOn(ArtifactsCodeStore.prototype, 'log').mockImplementation(async (_name, hash, limit = 50) => {
    const entries: ArtifactsCommitMetadata[] = [];
    for (let current = graph[hash] ? hash : undefined; current !== undefined && entries.length < limit; current = graph[current]?.[0]) entries.push(metadata(current));
    return entries;
  });
}

/** An installation of the account's GitHub App covers every repository; its tokens read only that one. */
function coveredRepositories() {
  vi.spyOn(GitHubAppDO.prototype, 'coverage').mockReturnValue(91);
  return vi.spyOn(GitHubAppDO.prototype, 'repositoryToken').mockImplementation(async (repository, access) => ({ token: `ghs_${access}_${repository}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
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
      operation: { projectId: project.id, workspaceId, kind: 'workspace.create', state: 'succeeded', error: null },
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
      const reopened = await createAccountWorkspaceRuntime(state, env, identity, async () => {}, noAttach);
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

  it('notices each runtime publication once and reads only the events after the cursor', async () => {
    const { userId, client, project } = await cloudProject('Runtime notices');
    const created = await client.workspace.create({ projectId: project.id, name: 'Noticed', branch: 'noticed', phase: 'plan', sourceKind: 'base', sourceRef: '' });
    if (created.status === 'error') throw created.error;
    const identity = RuntimeIdentitySchema.parse({ projectId: project.id, workspaceId: created.value.workspace.id });
    const first = await client.runtime.watch({ ...identity, after: null });
    if (first.status === 'error') throw first.error;
    expect(first.value).toMatchObject([{ type: 'snapshot', snapshot: identity }]);
    const [initial] = first.value;
    if (initial?.type !== 'snapshot') throw new Error('Expected a snapshot');
    const cursor = initial.snapshot.cursor;
    expect(await client.runtime.watch({ ...identity, after: cursor })).toEqual({ status: 'ok', value: [] });

    const notices = vi.spyOn(UserProjectIndexDO.prototype, 'liveNotices');
    await env.SPACE_AUTHORITY.getByName(`${userId}:${identity.workspaceId}`).runtimeDraft({ ...identity, text: 'noticed draft', expectedRevision: 0 }, { deviceId: 'browser' });
    const noticed = await vi.waitFor(() => {
      const runtime = notices.mock.calls.flatMap(([batch]) => batch.filter(notice => notice.resource === 'runtime'));
      expect(runtime.length).toBeGreaterThan(0);
      return runtime;
    });
    expect(noticed[0]).toEqual({ project: project.id, workspace: identity.workspaceId, resource: 'runtime', version: expect.any(Number) });
    const read = await client.runtime.watch({ ...identity, after: cursor });
    if (read.status === 'error') throw read.error;
    const published = read.value.map(event => event.type === 'delta' ? event.cursor : -1);
    expect(published.every(version => version > cursor)).toBe(true);
    expect(JSON.stringify(read.value)).toContain('noticed draft');
    // Every publication noticed so far is noticed once, naming the cursor it published.
    const versions = noticed.map(notice => notice.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(published).toEqual(expect.arrayContaining(versions));
  });

  it('indexes an existing snapshot for code_search from the runtime alarm, with no request searching first', async () => {
    const { userId, client, project } = await cloudProject('Indexed in cloud');
    const created = await client.workspace.create({ projectId: project.id, name: 'Indexed', branch: 'indexed', phase: 'plan', sourceKind: 'base', sourceRef: '' });
    if (created.status === 'error') throw created.error;
    const identity = RuntimeIdentitySchema.parse({ projectId: project.id, workspaceId: created.value.workspace.id });
    const trees = new Map<string, ArtifactsTreeEntry[]>([
      [commit('9'), [{ name: 'README.md', type: 'blob', mode: '100644', hash: commit('a') }, { name: 'src', type: 'tree', mode: '40000', hash: commit('b') }]],
      [commit('b'), [{ name: 'main.ts', type: 'blob', mode: '100644', hash: commit('c') }]],
    ]);
    const blobs = new Map([[commit('a'), 'GitSpace readme\n'], [commit('c'), 'export const needle = 1;\n']]);
    vi.spyOn(ArtifactsCodeStore.prototype, 'reader').mockImplementation(() => ({ readTree: async oid => trees.get(oid) ?? null, readBlob: async oid => { const text = blobs.get(oid); return text === undefined ? null : new Blob([text]); }, readCommit: async () => null, log: async () => [], close: async () => {} }));
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${identity.workspaceId}`);
    // Runtime alarms run until the index serves `tree`; nothing searches meanwhile.
    const indexed = async (tree: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        await runDurableObjectAlarm(space);
        if (await runInDurableObject(space, (_instance, state) => state.storage.sql.exec<{ served_tree: string | null }>('SELECT served_tree FROM code_search_state').one().served_tree) === tree) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`The index never served ${tree}`);
    };
    // Opening the runtime and initializing its source snapshot is all a workspace does before an agent searches.
    expect(await space.runtimeRepositoryCheckpoint(identity)).toMatchObject({ worktreeTree: commit('9') });
    await indexed(commit('9'));
    // A cloud write publishes a snapshot; the next alarm indexes only what changed.
    trees.set(commit('8'), [...trees.get(commit('9')) ?? [], { name: 'NEW.md', type: 'blob', mode: '100644', hash: commit('d') }]);
    blobs.set(commit('d'), 'new file\n');
    vi.spyOn(ArtifactsCodeStore.prototype, 'readFile').mockResolvedValue(null);
    vi.spyOn(ArtifactsCodeStore.prototype, 'listSnapshotPaths').mockResolvedValue(['README.md', 'src/main.ts']);
    vi.spyOn(ArtifactsCodeStore.prototype, 'writeSnapshot').mockImplementation(async input => Result.ok({ ...input.previous, worktreeCommit: commit('7'), trackedWorktreeCommit: commit('7'), worktreeTree: commit('8') }));
    await space.runtimeWriteEnvironmentBundle(identity, JSON.stringify({ version: 1, defaultProfile: 'base', profiles: { base: {} } }));
    await indexed(commit('8'));
    await runInDurableObject(space, (_instance, state) => {
      expect(state.storage.sql.exec('SELECT path FROM code_search_file WHERE until IS NULL ORDER BY path').toArray()).toEqual([{ path: 'NEW.md' }, { path: 'README.md' }, { path: 'src/main.ts' }]);
    });
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
    // A ref with the base source names another source; it is refused rather than silently started from the base.
    expect(await create({ sourceKind: 'base', sourceRef: 'staging' })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('use sourceKind branch with sourceRef staging') } } });
    expect((await authority.listWorkspaces()).filter(workspace => workspace.kind === 'worktree')).toEqual([]);
    expect(await create({ sourceKind: 'branch', sourceRef: 'refs/remotes/origin/main' })).toMatchObject({ status: 'ok', value: { workspace: { branch: 'refused' } } });
    expect(await create({ name: 'From commit', branch: 'from-commit', sourceKind: 'commit', sourceRef: commit('1') })).toMatchObject({ status: 'ok' });
    expect(await create({ name: 'Base by name', branch: 'base-by-name', sourceKind: 'base', sourceRef: 'origin/main' })).toMatchObject({ status: 'ok' });
  });

  it('imports a branch a private origin refuses through a machine holding the base checkout, and says so when none is ready', async () => {
    const { client, project, authority } = await cloudProject('Private branches', 'https://github.com/Deedible/Private.git');
    const importRef = vi.spyOn(ArtifactsCodeStore.prototype, 'importSourceRef').mockRejectedValue(new GitDiscoveryError(401));
    try {
      const created = await client.workspace.create({ projectId: project.id, name: 'Staging work', branch: 'work', sourceKind: 'branch', sourceRef: 'staging' });
      expect(created).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('The project repository is private') } } });
      expect(importRef).toHaveBeenCalledWith(project.id, 'https://github.com/Deedible/Private.git', 'refs/heads/staging', null);
      expect((await authority.listWorkspaces()).filter(workspace => workspace.kind === 'worktree')).toEqual([]);
      // Any other refusal is the origin's answer, not a reason to involve a machine.
      importRef.mockRejectedValue(new GitDiscoveryError(500));
      expect(await client.workspace.create({ projectId: project.id, name: 'Staging work', branch: 'work', sourceKind: 'branch', sourceRef: 'staging' })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('Git discovery failed (500)') } } });
    } finally { importRef.mockRestore(); }
  });

  it('reads a covered origin only with an installation token and never asks a machine when it refuses', async () => {
    const { client, project, authority } = await cloudProject('Covered branches', 'git@github.com:acme/private.git');
    const tokens = coveredRepositories();
    const credentials: Array<unknown> = [];
    const importRef = vi.spyOn(ArtifactsCodeStore.prototype, 'importSourceRef').mockImplementation(async (_projectId, _url, _ref, read) => {
      credentials.push(await read?.());
      throw new GitDiscoveryError(404);
    });
    const machine = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeImportRef');
    const created = await client.workspace.create({ projectId: project.id, name: 'Staging work', branch: 'work', sourceKind: 'branch', sourceRef: 'staging' });
    expect(created).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('Git discovery failed (404)') } } });
    expect(importRef).toHaveBeenCalledWith(project.id, 'https://github.com/acme/private.git', 'refs/heads/staging', expect.any(Function));
    expect(credentials).toEqual([{ kind: 'basic', username: 'x-access-token', password: 'ghs_read_acme/private' }]);
    expect(tokens).toHaveBeenCalledWith('acme/private', 'read');
    expect(machine).not.toHaveBeenCalled();
    expect((await authority.listWorkspaces()).filter(workspace => workspace.kind === 'worktree')).toEqual([]);
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

  it('leaves the workspace catalog intact when the source import is refused and permits explicit recovery', async () => {
    const { client, project, artifacts, authority } = await cloudProject('Refused import', 'https://github.com/example/source.git');
    const definitions = await authority.listWorkspaces();
    const imports = vi.spyOn(ArtifactsCodeStore.prototype, 'importProject');
    const importProject = imports.getMockImplementation();
    imports.mockRejectedValue(new Error('Artifacts refused repository history'));
    const input = { projectId: project.id, name: 'Not yet admitted', branch: 'review', sourceKind: 'base' as const, sourceRef: '' };
    expect(await client.workspace.create(input)).toMatchObject({ status: 'error' });
    expect(await authority.listWorkspaces()).toEqual(definitions);
    expect(artifacts.forks).toEqual([]);
    expect(artifacts.setBranch).not.toHaveBeenCalled();
    if (!importProject) throw new Error('Missing import fixture');
    imports.mockImplementation(importProject);
    const admitted = await client.workspace.create(input);
    if (admitted.status === 'error') throw admitted.error;
    expect((await authority.listWorkspaces()).find(workspace => workspace.id === admitted.value.workspace.id)).toMatchObject({ name: input.name, branch: input.branch, lifecycle: 'active', sourceCommit: commit('1') });
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
    expect(retried).toMatchObject({ status: 'ok', value: { workspace: { id: definition.id, branch: 'retried' }, operation: { kind: 'workspace.create', state: 'succeeded' } } });
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
      checkout: { kind: 'shared', branch: 'archived' }, capabilities: [], updatedAt: new Date().toISOString(), online: true });
    await runInDurableObject(space, (_instance, state) => {
      state.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', cache.attachmentId, JSON.stringify(cache), 'fixture');
    });
    const current = async () => {
      const definition = (await authority.listWorkspaces()).find(workspace => workspace.id === workspaceId);
      if (!definition) throw new Error('Workspace definition is missing');
      return definition;
    };
    const archive = async () => client.workspace.archive({ projectId: project.id, spaceId: workspaceId, expectedGeneration: null });
    expect(await archive()).toMatchObject({ status: 'ok', value: { id: workspaceId, lifecycle: 'archived' } });
    expect(await space.runtimeAttachments(identity)).toMatchObject([{ attachmentId: 'cache-a', state: 'detached' }]);
    expect((await authority.listOperations()).find(operation => operation.kind === 'workspace.archive' && operation.workspaceId === workspaceId)).toMatchObject({ state: 'succeeded' });
    expect(await client.space.view({ projectId: project.id, workspaceId })).toMatchObject({ status: 'ok', value: { workspaces: [{ id: workspaceId, closedAt: expect.any(Date) }] } });

    expect(await client.workspace.restore({ spaceId: workspaceId, expectedGeneration: 3 })).toMatchObject({ status: 'error' });
    expect(await client.workspace.restore({ spaceId: workspaceId, expectedGeneration: 0 })).toMatchObject({ status: 'ok', value: { id: workspaceId, projectId: project.id, kind: 'worktree', state: 'active', machineId: null, generation: 0 } });
    expect(await current()).toMatchObject({ lifecycle: 'active', archivedAt: null });
    expect(await client.workspace.delete({ workspaceId: project.id })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('base workspace') } } });

    expect(await archive()).toMatchObject({ status: 'ok' });
    expect(await client.workspace.delete({ workspaceId })).toMatchObject({ status: 'ok', value: { workspaceId, deleted: true } });
    expect((await authority.listWorkspaces()).some(workspace => workspace.id === workspaceId)).toBe(false);
    expect(await index.locateWorkspace(workspaceId)).toBeNull();
    expect(artifacts.deleted).toEqual([`workspace-${workspaceId}`]);
    expect(await space.hasCloudRuntime()).toBe(false);
    expect(await client.workspace.delete({ workspaceId })).toMatchObject({ status: 'error', error: { _tag: 'gitspace/workspace-not-found' } });
  });

  it('deletes a workspace in any state: an active one and a creation that never finished', async () => {
    const { userId, client, project, authority, index } = await cloudProject('Delete in any state');
    const created = await client.workspace.create({ projectId: project.id, name: 'Active', branch: 'active', sourceKind: 'base', sourceRef: '' });
    if (created.status === 'error') throw created.error;
    const active = created.value.workspace.id;
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${active}`);
    await space.runtimeAttachments({ projectId: project.id, workspaceId: active });
    expect(await client.workspace.delete({ workspaceId: active })).toMatchObject({ status: 'ok', value: { workspaceId: active, deleted: true } });
    expect(await authority.getWorkspace(active)).toBeNull();
    expect(await space.hasCloudRuntime()).toBe(false);

    const unfinished = await authority.putWorkspace({
      id: 'unfinished-creation', projectId: project.id, kind: 'worktree', name: 'Unfinished', branch: 'unfinished', phase: 'plan',
      sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'provisioning', goalId: null, expectedRevision: 0,
    });
    await index.putWorkspaceLocation(unfinished.id, project.id);
    expect(await client.workspace.delete({ workspaceId: unfinished.id })).toMatchObject({ status: 'ok', value: { workspaceId: unfinished.id, deleted: true } });
    expect(await index.locateWorkspace(unfinished.id)).toBeNull();
  });

  it('archives and deletes workspace first, and the project records it even after a project-side write the workspace never saw', async () => {
    const { userId, client, project, authority } = await cloudProject('Workspace first');
    const created = await client.workspace.create({ projectId: project.id, name: 'Recorded', branch: 'recorded', sourceKind: 'base', sourceRef: '' });
    if (created.status === 'error') throw created.error;
    const workspaceId = created.value.workspace.id;
    const identity = { projectId: project.id, workspaceId };
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`);
    await space.runtimeAttachments(identity);
    const definition = async () => {
      const current = await authority.getWorkspace(workspaceId);
      if (!current) throw new Error('Workspace definition is missing');
      return current;
    };
    const bypass = async () => {
      const { revision, archivedAt: _archivedAt, createdAt: _createdAt, updatedAt: _updatedAt, ...fields } = await definition();
      await authority.putWorkspace({ ...fields, name: `${fields.name}!`, expectedRevision: revision });
    };

    const active = await definition();
    await bypass();
    expect(await runInDurableObject(space, (instance: SpaceAuthorityDO) => instance.archiveWorkspace(active))).toMatchObject({ lifecycle: 'archived' });
    await expect(runInDurableObject(space, (instance: SpaceAuthorityDO) => instance.runtimeAccess(identity, true))).rejects.toThrow('Archived runtime state is read-only');
    expect(await definition()).toMatchObject({ lifecycle: 'archived' });

    await bypass();
    expect(await client.workspace.delete({ workspaceId })).toMatchObject({ status: 'ok', value: { workspaceId, deleted: true } });
    expect(await space.hasCloudRuntime()).toBe(false);
    expect(await authority.getWorkspace(workspaceId)).toBeNull();
  });

  it('stores the status its runtime publishes and serves it without opening the runtime or reading the project', async () => {
    const { userId, client, project } = await cloudProject('Stored status');
    const created = await client.workspace.create({ projectId: project.id, name: 'Status', branch: 'status', sourceKind: 'base', sourceRef: '' });
    if (created.status === 'error') throw created.error;
    const workspaceId = created.value.workspace.id;
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`);
    expect((await space.listingState()).status).toBeNull();
    expect(await client.runtime.snapshot(RuntimeIdentitySchema.parse({ projectId: project.id, workspaceId }))).toMatchObject({ status: 'ok' });
    const published = (await space.listingState()).status;
    if (!published) throw new Error('Opening the runtime publishes its status');
    // A freshly opened runtime has no live task: its main agent waits for the user.
    expect(published).toEqual({ primaryColor: 'blue', agents: { green: 0, blue: 1, orange: 0, red: 0 }, machines: { attached: 0, online: 0, ready: 0 }, sync: { conflicts: 0, problems: 0 } });
    expect(await client.space.view({ projectId: project.id, workspaceId: null })).toMatchObject({ status: 'ok', value: { workspaces: [{ id: workspaceId, status: published }] } });
    // The project agent's report before any message: nothing waited on, no model admitted, no checkpoint yet.
    const report = await space.workspaceReport();
    expect(report).toMatchObject({ summary: published, phase: 'plan', waitingOn: null, failure: null, lastReply: null, model: null, code: null });
    await runInDurableObject(space, async (_instance, state) => {
      // The published snapshot is gone; only the stored summary remains, and the project is unreachable.
      state.storage.sql.exec("DELETE FROM runtime_replica WHERE kind='snapshot'");
      const local = new SpaceAuthorityDO(state, { ...env, PROJECT_AUTHORITY: new Proxy(env.PROJECT_AUTHORITY, { get() { throw new Error('ProjectAuthority was consulted'); } }) });
      await state.blockConcurrencyWhile(async () => {});
      expect(local.listingState().status).toEqual(published);
      expect(local.workspaceReport()).toEqual(report);
      // A summary an older release derived from conversation flags is not shown until the runtime publishes again.
      state.storage.sql.exec('UPDATE workspace_status SET summary=? WHERE id=1', JSON.stringify({ primaryColor: 'green', agents: { green: 1, blue: 0, orange: 0, red: 0 }, services: { green: 0, red: 0 }, terminals: { green: 0, red: 0 } }));
      expect(local.listingState().status).toBeNull();
    });
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
      const reopened = await createAccountWorkspaceRuntime(state, env, RuntimeIdentitySchema.parse(identity), async () => {}, noAttach);
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

  it('reports an interrupted ref publication and finishes it on retry without exposing partial metadata', async () => {
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
    expect(await client.project.setBaseBranch(input)).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('Checkpoint push interrupted') } } });
    expect((await authority.getProject())?.baseBranch).toBe('main');
    expect((await authority.listWorkspaces()).find(workspace => workspace.kind === 'base')?.branch).toBe('main');
    expect(await client.runtime.snapshot(identity)).toMatchObject({ status: 'ok' });
    expect(await client.project.setBaseBranch(input)).toMatchObject({ status: 'ok', value: { baseBranch: 'develop' } });
    expect(await space.runtimeRepositoryCheckpoint(identity)).toMatchObject({ branch: 'develop', headCommit: commit('2') });
    expect((await authority.listWorkspaces()).find(workspace => workspace.kind === 'base')).toMatchObject({ branch: 'develop', sourceCommit: commit('2') });
  });

  it('answers other requests while a base-branch change waits on the git store', async () => {
    const { userId, client, project, artifacts, authority } = await cloudProject('Unblocked branch change');
    artifacts.refs.set(`project-${project.id} refs/heads/develop`, commit('2'));
    const identity = RuntimeIdentitySchema.parse({ projectId: project.id, workspaceId: project.id });
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${project.id}`);
    await space.runtimeRepositoryCheckpoint(identity);
    const current = await authority.getProject();
    if (!current) throw new Error('Missing project');
    const copy = artifacts.copyCommit.getMockImplementation();
    if (!copy) throw new Error('Missing copy fixture');
    let answered: [unknown, string] | null = null;
    artifacts.copyCommit.mockImplementationOnce(async (...args) => {
      // Other requests reach the workspace object while the ref publication waits on the git store; a lock would deadlock them here.
      const workspace = env.SPACE_AUTHORITY.getByName(`${userId}:${project.id}`);
      answered = [await workspace.directoryPublication(), await workspace.runtimeSnapshot(identity).then(() => 'opened', (error: unknown) => error instanceof Error ? error.message : String(error))];
      return copy(...args);
    });
    expect(await client.project.setBaseBranch({ projectId: project.id, expectedRevision: current.revision, baseBranch: 'develop' })).toMatchObject({ status: 'ok', value: { baseBranch: 'develop' } });
    expect(answered).toEqual([expect.objectContaining({ source: 'space' }), 'opened']);
    expect(await client.runtime.snapshot(identity)).toMatchObject({ status: 'ok' });
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

  it('preserves explicit phases and approved plan transitions across runtime reopening', async () => {
    const { userId, client, project } = await cloudProject('Durable phase');
    const created = await client.workspace.create({ projectId: project.id, name: 'Reviewed', branch: 'reviewed', phase: 'review', sourceKind: 'base', sourceRef: '' });
    if (created.status === 'error') throw created.error;
    const identity = RuntimeIdentitySchema.parse({ projectId: project.id, workspaceId: created.value.workspace.id });
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${identity.workspaceId}`);
    await runInDurableObject(space, async (_instance, state) => {
      const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${project.id}`);
      const runtime = await createAccountWorkspaceRuntime(state, env, identity, async () => {}, noAttach);
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
      const reopened = await createAccountWorkspaceRuntime(state, env, identity, async () => {}, noAttach);
      expect((await reopened.harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT))?.phase).toBe('code');
      await reopened.wake();
      await reopened.harness.close(BACKGROUND_CONTEXT);
    });
  });

  it('archives, restores, rebases and deletes a project in the cloud; the GitSpace project refuses archive and delete', async () => {
    const { userId, client, project, artifacts, authority, index } = await cloudProject('Project lifecycle');
    artifacts.refs.set(`project-${project.id} refs/heads/develop`, commit('2'));
    const created = await client.workspace.create({ projectId: project.id, name: 'Child', branch: 'child', sourceKind: 'base', sourceRef: '' });
    if (created.status === 'error') throw created.error;
    const revision = async () => (await authority.getProject())?.revision ?? -1;
    const child = env.SPACE_AUTHORITY.getByName(`${userId}:${created.value.workspace.id}`);
    const childIdentity = { projectId: project.id, workspaceId: created.value.workspace.id };

    expect(await client.project.setBaseBranch({ projectId: project.id, expectedRevision: await revision(), baseBranch: 'bad..branch' })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('not a valid branch name') } } });
    expect(await client.project.setBaseBranch({ projectId: project.id, expectedRevision: await revision(), baseBranch: 'missing' })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('Branch missing does not exist') } } });
    expect(await client.project.setBaseBranch({ projectId: project.id, expectedRevision: await revision(), baseBranch: 'develop' })).toMatchObject({ status: 'ok', value: { id: project.id, baseBranch: 'develop', lifecycle: 'active' } });
    expect(await client.space.view({ projectId: project.id, workspaceId: null })).toMatchObject({ status: 'ok', value: { project: { baseBranch: 'develop' }, baseSpace: { branch: 'develop' } } });
    const fromBase = await client.workspace.create({ projectId: project.id, name: 'From develop', branch: 'from-develop', sourceKind: 'base', sourceRef: '' });
    expect(fromBase).toMatchObject({ status: 'ok' });
    expect(artifacts.setBranch).toHaveBeenLastCalledWith(expect.any(String), 'from-develop', commit('2'));

    expect(await client.project.archive({ projectId: project.id, expectedRevision: await revision() })).toMatchObject({ status: 'ok', value: { lifecycle: 'archived', archivedAt: expect.any(Date) } });
    // Each workspace object learned the archive from the worker and refuses writes on its own.
    await expect(runInDurableObject(child, (instance: SpaceAuthorityDO) => instance.runtimeAccess(childIdentity, true))).rejects.toThrow('Archived runtime state is read-only');
    expect((await index.list('archived')).map(entry => entry.id)).toContain(project.id);
    expect(await client.project.restore({ projectId: project.id, expectedRevision: await revision() })).toMatchObject({ status: 'ok', value: { lifecycle: 'active', archivedAt: null } });
    await expect(child.runtimeAccess(childIdentity, true)).resolves.toMatchObject({ projectLifecycle: 'active' });
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

  it('updates the base from a covered origin: the project copy fast-forwards and the clean idle base checkout follows', async () => {
    const { userId, client, project, artifacts, authority } = await cloudProject('Update base', 'https://github.com/acme/app.git');
    const identity = RuntimeIdentitySchema.parse({ projectId: project.id, workspaceId: project.id });
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${project.id}`);
    expect(await space.runtimeRepositoryCheckpoint(identity)).toMatchObject({ branch: 'main', headCommit: commit('1') });
    coveredRepositories();
    cloudHistory({ [commit('1')]: [], [commit('2')]: [commit('1')] });
    const read: Array<unknown> = [];
    vi.spyOn(ArtifactsCodeStore.prototype, 'fetchOriginBranch').mockImplementation(async (projectId, url, branch, credentials) => {
      read.push([url, branch, await credentials?.()]);
      artifacts.refs.set(`project-${projectId} refs/gitspace/origin/heads/${branch}`, commit('2'));
      return commit('2');
    });
    const notices = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeProjectNotice').mockResolvedValue(undefined);
    expect(await client.project.updateBase({ projectId: project.id })).toMatchObject({ status: 'ok' });
    expect(read).toEqual([['https://github.com/acme/app.git', 'main', { kind: 'basic', username: 'x-access-token', password: 'ghs_read_acme/app' }]]);
    expect(artifacts.refs.get(`project-${project.id} refs/heads/main`)).toBe(commit('2'));
    expect(artifacts.refs.get(`workspace-${project.id} refs/heads/main`)).toBe(commit('2'));
    expect(await space.runtimeRepositoryCheckpoint(identity)).toMatchObject({ branch: 'main', headCommit: commit('2'), indexCommit: commit('2'), worktreeCommit: commit('2') });
    expect(notices.mock.calls.map(call => call[1])).toEqual(['Base branch main updated to 2222222 from origin.']);
    expect((await authority.getProject())?.remote).toMatchObject({ head: commit('2'), behind: false });
    expect((await authority.listOperations()).find(operation => operation.kind === 'project.updateBase')).toMatchObject({ state: 'succeeded' });

    // Nothing new on origin: the copy and the checkout already hold its head, and nothing moves.
    const copies = artifacts.copyCommit.mock.calls.length;
    expect(await client.project.updateBase({ projectId: project.id })).toMatchObject({ status: 'ok' });
    expect(artifacts.copyCommit.mock.calls.length).toBe(copies);
    expect(notices.mock.calls.at(-1)?.[1]).toBe("Base branch main already holds origin's 2222222.");
  });

  it('refuses to move a project copy holding commits the origin lacks', async () => {
    const { userId, client, project, artifacts, authority } = await cloudProject('Diverged base', 'https://github.com/acme/app.git');
    const identity = RuntimeIdentitySchema.parse({ projectId: project.id, workspaceId: project.id });
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${project.id}`);
    await space.runtimeRepositoryCheckpoint(identity);
    cloudHistory({ [commit('1')]: [], [commit('3')]: [] });
    vi.spyOn(ArtifactsCodeStore.prototype, 'fetchOriginBranch').mockImplementation(async (projectId, _url, branch) => {
      artifacts.refs.set(`project-${projectId} refs/gitspace/origin/heads/${branch}`, commit('3'));
      return commit('3');
    });
    const notices = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeProjectNotice').mockResolvedValue(undefined);
    expect(await client.project.updateBase({ projectId: project.id })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining("The project's main has 1 commit that origin's main (3333333) lacks") } } });
    expect(artifacts.refs.get(`project-${project.id} refs/heads/main`)).toBe(commit('1'));
    expect(await space.runtimeRepositoryCheckpoint(identity)).toMatchObject({ headCommit: commit('1') });
    expect(notices).not.toHaveBeenCalled();
    expect((await authority.listOperations()).find(operation => operation.kind === 'project.updateBase')).toMatchObject({ state: 'failed' });
  });

  it('updates the project copy but leaves a dirty base workspace for later, saying so', async () => {
    const { userId, client, project, artifacts } = await cloudProject('Busy base', 'https://github.com/acme/app.git');
    const identity = RuntimeIdentitySchema.parse({ projectId: project.id, workspaceId: project.id });
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${project.id}`);
    const clean = await space.runtimeRepositoryCheckpoint(identity);
    const dirty = { ...clean, worktreeTree: commit('4'), worktreeCommit: commit('6') };
    await runInDurableObject(space, (_instance, state) => {
      state.storage.sql.exec('UPDATE runtime_code_snapshot SET checkpoint=? WHERE singleton=1', JSON.stringify(dirty));
    });
    cloudHistory({ [commit('1')]: [], [commit('2')]: [commit('1')] });
    vi.spyOn(ArtifactsCodeStore.prototype, 'fetchOriginBranch').mockImplementation(async (projectId, _url, branch) => {
      artifacts.refs.set(`project-${projectId} refs/gitspace/origin/heads/${branch}`, commit('2'));
      return commit('2');
    });
    const notices = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeProjectNotice').mockResolvedValue(undefined);
    const result = await client.project.updateBase({ projectId: project.id });
    expect(result).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('Base branch main updated to 2222222 from origin. The base workspace was left for later') } } });
    expect(result).toMatchObject({ error: { data: { message: expect.stringContaining('uncommitted changes') } } });
    expect(artifacts.refs.get(`project-${project.id} refs/heads/main`)).toBe(commit('2'));
    expect(await space.runtimeRepositoryCheckpoint(identity)).toEqual(dirty);
    expect(notices.mock.calls.map(call => call[1])).toEqual([expect.stringContaining('The base workspace was left for later')]);
  });
});
