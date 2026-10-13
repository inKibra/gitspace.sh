import { createHash } from 'node:crypto';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignedControlRequest, credentialProtocolBase64, encryptArtifactBytes, signCredentialAuthorityGrant } from '@gitspace/protocol';
import { GitLfsObjectSchema, spaceArtifactManifestKey, spaceCheckpointManifestKey, spaceGitCheckpointRef, spaceOmpCheckpointKey, type SpaceCheckpointManifest } from '@gitspace/protocol-workspace';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { SpaceAuthorityDO } from '../src/space-authority.js';
import { readLegacyMigrationBundle, requireLegacyMigrationSource, stageLegacyMigrationCode } from '../src/legacy-space-migration.js';
import { createAccountGitLfsStore } from '../src/git-lfs-store.js';
import { createCloudWorkspace } from '../src/cloud-workspace-lifecycle.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { tenantRootPrivateKey } from './setup.js';

const timestamp = '2026-10-09T00:00:00.000Z';
const oid = (digit: string) => digit.repeat(40);
afterEach(() => vi.restoreAllMocks());

async function fixture(closed = true, options: { base?: boolean; branch?: string; archived?: boolean; repositoryReference?: string; unborn?: boolean } = {}) {
  const projectId = `migration-${crypto.randomUUID()}`, workspaceId = options.base ? projectId : `${projectId}-space`;
  const project = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const created = await project.bootstrap({ id: projectId, name: projectId, repositoryReference: options.repositoryReference ?? null, baseBranch: 'main', createdBy: 'writer' });
  await project.setProjectLifecycle(created.revision, 'active');
  await project.putWorkspace({ id: workspaceId, projectId, kind: options.base ? 'base' : 'worktree', name: 'Retained branch', branch: 'main', phase: null, sourceKind: options.base ? 'base' : 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: options.archived ? 'archived' : 'active', goalId: null, expectedRevision: 0 });
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(41)) });
  const key = credentialProtocolBase64.decode(await vault.artifactKey(env.ACCOUNT_ID));
  const put = async (path: string, value: string) => {
    const bytes = await encryptArtifactBytes(new TextEncoder().encode(value), key);
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
    await env.DATA.put(`users/${env.ACCOUNT_ID}/${path}`, bytes);
    return { bytes, hash };
  };
  const sessionKey = spaceOmpCheckpointKey(projectId, workspaceId, 1);
  const session = await put(sessionKey, [
    { type: 'session', version: 3, id: 'omp', timestamp, cwd: '/preserved' },
    { type: 'message', id: 'root', parentId: null, timestamp, message: { role: 'user', content: 'Preserve this history without running it' } },
  ].map(record => JSON.stringify(record)).join('\n'));
  const scope = { id: `space:${workspaceId}`, spaceId: workspaceId, generation: 0, manifestHash: null, dirty: false };
  const artifacts = await put(spaceArtifactManifestKey(projectId, workspaceId, 1, 0), JSON.stringify({ version: 2, scope }));
  const manifest: SpaceCheckpointManifest = { version: 1, projectId, spaceId: workspaceId, revision: 1, previousRevision: null,
    repository: { checkpointRef: spaceGitCheckpointRef(workspaceId, 1), headCommit: options.unborn ? null : oid('a'), indexCommit: oid('b'), worktreeCommit: oid('d'), branch: options.branch ?? 'main' },
    agent: { kind: 'legacy', sessionId: 'session', ompSessionId: 'omp', ompCheckpointHash: session.hash, resumePending: true }, artifacts: { manifestHash: artifacts.hash, generation: 0 }, createdAt: timestamp };
  const manifestKey = spaceCheckpointManifestKey(projectId, workspaceId, 1);
  const sealed = await put(manifestKey, JSON.stringify(manifest));
  const authority = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`);
  const holder = { projectId, spaceId: workspaceId, machineId: 'writer', expectedGeneration: 1 };
  await authority.bootstrap({ projectId, spaceId: workspaceId, machineId: holder.machineId });
  if (closed) {
    await authority.beginClose(holder);
    await authority.commitClosed({ ...holder, revision: 1, manifestKey, manifestHash: sealed.hash });
  }
  const input = { operationId: crypto.randomUUID(), projectId, workspaceId, expectedGeneration: closed ? 2 : 1, expectedManifestHash: sealed.hash };
  return { project, authority, input, finalize: { ...input, historicalLfs: [] }, holder, manifest, manifestKey, sealed, sessionKey, session, scope };
}

function graph(content = 'preserved worktree bytes\n') {
  const contents = new TextEncoder().encode(content);
  const blobId = createHash('sha1').update(`blob ${contents.length}\0`).update(contents).digest('hex');
  const trees: Record<string, string> = { [oid('a')]: oid('1'), [oid('b')]: oid('2'), [oid('c')]: oid('3'), [oid('d')]: oid('4') };
  const parents: Record<string, string[]> = { [oid('a')]: [], [oid('b')]: [oid('a')], [oid('c')]: [oid('b')], [oid('d')]: [oid('c')] };
  vi.spyOn(ArtifactsCodeStore.prototype, 'readCommit').mockImplementation(async (_repo, hash) => trees[hash] ? { hash, treeHash: trees[hash]!, parents: parents[hash]!, message: 'checkpoint', author: { name: 'writer', email: 'writer@test' }, committer: { name: 'writer', email: 'writer@test' }, authoredAt: 0, committedAt: 0 } : null);
  vi.spyOn(ArtifactsCodeStore.prototype, 'listSnapshotInventories').mockImplementation(async (_repo, requested) => requested.map(() => new Map([['retained.txt', { oid: blobId, mode: '100644', type: 'blob' as const }], ['nested-repo', { oid: oid('f'), mode: '160000', type: 'commit' as const }]])));
  vi.spyOn(ArtifactsCodeStore.prototype, 'readBlob').mockImplementation(async (_repo, hash) => hash === blobId ? new Blob([contents]) : null);
  vi.spyOn(ArtifactsCodeStore.prototype, 'resolveRef').mockResolvedValue(oid('a'));
  const refs = new Map<string, string>();
  vi.spyOn(ArtifactsCodeStore.prototype, 'copyCommit').mockImplementation(async (_source, _target, ref, commit, previous) => {
    const current = refs.get(ref) ?? null;
    if (current !== previous && current !== commit) throw new Error('ref conflict');
    refs.set(ref, commit);
  });
  return { contents, blobId, refs };
}

function shallowGraph(missing?: 'head' | 'index' | 'tracked' | 'worktree' | 'tree' | 'subtree' | 'blob', unborn = false) {
  const contents = new TextEncoder().encode('retained shallow snapshot bytes\n');
  const blobId = createHash('sha1').update(`blob ${contents.length}\0`).update(contents).digest('hex');
  const commits = ([
    ['a', '1', 'e', 'head'], ['b', '2', 'a', 'index'], ['c', '3', 'b', 'tracked'], ['d', '4', 'c', 'worktree'],
  ] as const).map(([hash, tree, parent, layer]) => ({
    layer, commit: {
      hash: oid(hash), treeHash: oid(tree), parents: unborn && layer === 'index' ? [] : [oid(parent)], message: 'retained checkpoint',
      author: { name: 'writer', email: 'writer@test' }, committer: { name: 'writer', email: 'writer@test' }, authoredAt: 0, committedAt: 0,
    },
  }));
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected shallow migration binding operation'); };
  const repo: ArtifactsRepo = {
    [Symbol.dispose]() {},
    readCommit: async hash => commits.find(entry => entry.layer !== missing && entry.commit.hash === hash)?.commit ?? null,
    readTree: async hash => {
      if (hash === oid('5')) return missing === 'subtree' ? null : [{ name: 'retained.txt', hash: blobId, mode: '100644', type: 'blob' }];
      if (!['1', '2', '3', '4'].some(tree => oid(tree) === hash) || (missing === 'tree' && hash === oid('1'))) return null;
      return [{ name: 'nested', hash: oid('5'), mode: '040000', type: 'tree' }, { name: 'nested-repo', hash: oid('f'), mode: '160000', type: 'gitlink' }];
    },
    readBlob: async hash => missing !== 'blob' && hash === blobId ? new Blob([contents]) : null,
    info: unsupported, createToken: unsupported, revokeToken: unsupported, listTokens: unsupported, fork: unsupported, readFile: unsupported, log: unsupported,
  };
  const binding: Artifacts = { get: async () => repo, create: unsupported, delete: unsupported, import: unsupported, list: unsupported };
  vi.spyOn(ArtifactsCodeStore.prototype, 'resolveRef').mockResolvedValue(oid('a'));
  const refs = new Map<string, string>();
  vi.spyOn(ArtifactsCodeStore.prototype, 'copyCommit').mockImplementation(async (_source, _target, ref, commit, previous) => {
    const current = refs.get(ref) ?? null;
    if (current !== previous && current !== commit) throw new Error('ref conflict');
    refs.set(ref, commit);
  });
  return { binding, refs };
}

async function projectGraph(projectId: string, branch: string, options: { conflict?: 'branch' | 'repository'; unborn?: boolean } = {}) {
  const graph = shallowGraph(undefined, options.unborn);
  const reader = await graph.binding.get(`workspace-${projectId}`);
  vi.mocked(ArtifactsCodeStore.prototype.resolveRef).mockRestore();
  const repositories = new Map<string, { info: ArtifactsRepoInfo; refs: Map<string, string> }>();
  function add(name: string, branch: string, description: string | null, refs = new Map<string, string>()) {
    const info: ArtifactsRepoInfo = { id: name, name, description, defaultBranch: branch, createdAt: '', updatedAt: '', lastPushAt: null, source: null, readOnly: false, remote: `https://artifacts.invalid/${name}.git` };
    repositories.set(name, { info, refs });
    return { ...info, token: 'initial-token', tokenExpiresAt: '' };
  }
  function requireRepository(name: string) {
    const repository = repositories.get(name);
    if (!repository) throw new Error('Repository is missing');
    return repository;
  }
  add(`workspace-${projectId}`, branch, null, new Map(options.unborn ? [] : [[`refs/heads/${branch}`, oid('a')]]));
  if (options.conflict) add(`project-${projectId}`, branch, 'Unrelated existing project', new Map(options.conflict === 'branch' ? [[`refs/heads/${branch}`, oid('e')]] : []));
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected origin or provider operation'); };
  const binding: Artifacts = {
    list: async () => ({ repos: [...repositories.values()].map(repository => repository.info), total: repositories.size }),
    create: async (name, options) => {
      if (repositories.has(name)) throw Object.assign(new Error('Repository exists'), { name: 'ArtifactsError', code: 'ALREADY_EXISTS' });
      return add(name, options?.setDefaultBranch ?? 'main', options?.description ?? null);
    },
    get: async name => {
      const repository = requireRepository(name);
      return {
        ...reader, info: async () => repository.info, revokeToken: async () => true,
        log: async query => {
          const ref = query?.ref ?? 'HEAD';
          const hash = repository.refs.get(ref === 'HEAD' ? `refs/heads/${repository.info.defaultBranch}` : ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);
          if (hash === oid('e') && name === `project-${projectId}`) return [{ hash, treeHash: oid('9'), parents: [], message: 'unrelated history', author: { name: 'other', email: 'other@test' }, committer: { name: 'other', email: 'other@test' }, authoredAt: 0, committedAt: 0 }];
          const commit = hash ? await reader.readCommit(hash) : null;
          return commit ? [commit] : [];
        },
        fork: async (name, options) => add(name, repository.info.defaultBranch, options?.description ?? repository.info.description, new Map(repository.refs)),
      };
    },
    import: unsupported, delete: unsupported,
  };
  vi.spyOn(ArtifactsCodeStore.prototype, 'copyCommit').mockImplementation(async (source, target, ref, commit, previous) => {
    requireRepository(source);
    if (!await reader.readCommit(commit)) throw new Error('Source commit is missing');
    const refs = requireRepository(target).refs;
    const current = refs.get(ref) ?? null;
    if (current !== previous && current !== commit) throw new Error('ref conflict');
    refs.set(ref, commit);
  });
  vi.spyOn(ArtifactsCodeStore.prototype, 'setBranch').mockImplementation(async (repository, branch, commit) => {
    if (!await reader.readCommit(commit)) throw new Error('Source commit is missing');
    requireRepository(repository).refs.set(`refs/heads/${branch}`, commit);
  });
  return { binding, repositories, code: new ArtifactsCodeStore(binding) };
}

describe('closed OMP to cloud migration', () => {
  it('authorizes only signed space controllers and keeps preflight read-only and account-bound', async () => {
    const f = await fixture();
    const signing = crypto.getRandomValues(new Uint8Array(32));
    const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
    for (const [machineId, capabilities] of [['controller', ['space.control']], ['reader', ['storage.access']]] as const) {
      await vault.registerDevice(signCredentialAuthorityGrant({ version: 1, userId: env.ACCOUNT_ID, machineId, signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signing)), exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(signing)), capabilities: [...capabilities], generation: 1 }, tenantRootPrivateKey));
    }
    const request = async (machineId: string, payload: Record<string, unknown>) => SELF.fetch('https://auth.test/v1/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createSignedControlRequest({ userId: env.ACCOUNT_ID, machineId, operation: 'space.legacyMigrationStatus', payload, signingPrivateKey: signing })) });
    const allowed = await request('controller', f.input);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ status: 'ok', value: { state: 'ready', repository: f.manifest.repository, source: { accountId: env.ACCOUNT_ID, workspaceId: f.input.workspaceId, manifestHash: f.input.expectedManifestHash } } });
    expect((await request('reader', f.input)).status).toBe(401);
    expect((await request('controller', { ...f.input, accountId: 'foreign' })).status).toBe(400);
    expect(await f.authority.beginOpen({ ...f.holder, expectedGeneration: 2 })).toMatchObject({ status: 'ok' });
  });

  it('refuses an open source without taking a migration fence', async () => {
    const open = await fixture(false);
    await runInDurableObject(open.authority, async instance => { await expect(instance.migrateLegacy(open.finalize)).rejects.toThrow(); });
    expect(await open.authority.beginClose(open.holder)).toMatchObject({ status: 'ok' });
  });

  it('refuses a stale generation without fencing the current owner', async () => {
    const closed = await fixture();
    await runInDurableObject(closed.authority, async instance => { await expect(instance.migrateLegacy({ ...closed.finalize, expectedGeneration: 1 })).rejects.toThrow(); });
    expect(await closed.authority.beginOpen({ ...closed.holder, expectedGeneration: 2 })).toMatchObject({ status: 'ok' });
  });

  it('keeps a durable fence after destination failure, rejects changed retry identity, and never exposes a half-runtime', async () => {
    const f = await fixture();
    vi.spyOn(ArtifactsCodeStore.prototype, 'readCommit').mockResolvedValue(null);
    await runInDurableObject(f.authority, async instance => { await expect(instance.migrateLegacy(f.finalize)).rejects.toThrow(); });
    expect(await f.authority.beginOpen({ ...f.holder, expectedGeneration: 2 })).toMatchObject({ status: 'error', failure: { code: 'WORKSPACE_POSSESSION_DENIED' } });
    expect(await f.authority.bootstrap(f.holder)).toMatchObject({ status: 'error' });
    await runInDurableObject(f.authority, async instance => { await expect(instance.runtimeSnapshot(f.input)).rejects.toThrow(); });
    expect(await f.authority.hasCloudRuntime()).toBe(false);
    await runInDurableObject(f.authority, async (_instance, state) => {
      const reopened = new SpaceAuthorityDO(state, env);
      expect(await reopened.legacyMigrationStatus(f.input)).toMatchObject({ state: 'staging' });
      await expect(reopened.migrateLegacy({ ...f.finalize, operationId: crypto.randomUUID() })).rejects.toThrow();
      expect(reopened.commitOpen({ ...f.holder, expectedGeneration: 2, revision: 1 })).toMatchObject({ status: 'error' });
    });
    await runInDurableObject(f.authority, async instance => { await expect(instance.migrateLegacy(f.finalize)).rejects.toThrow(); });
    expect(await f.project.getArtifactScope(f.scope.id)).toMatchObject({ workspaceId: f.input.workspaceId, generation: 0, manifestHash: null });
    await runInDurableObject(f.project, async instance => {
      await expect(instance.putMachineArtifactScope({ id: f.scope.id, workspaceId: f.input.workspaceId, generation: 1, expectedGeneration: 0, manifestHash: `sha256:${'1'.repeat(64)}` })).rejects.toThrow();
    });
    expect(await f.authority.get()).toMatchObject({ state: 'closed', generation: 2, manifestHash: f.input.expectedManifestHash });
  });

  it('keeps exact HEAD/index/tracked/worktree identities and gitlinks while verifying bytes and CAS retry', async () => {
    const f = await fixture();
    const git = graph();
    const source = requireLegacyMigrationSource(await f.authority.get(), f.input, env.ACCOUNT_ID);
    const checkpoint = await stageLegacyMigrationCode(env, source, f.manifest, []);
    expect(checkpoint).toMatchObject({ headCommit: oid('a'), indexCommit: oid('b'), trackedWorktreeCommit: oid('c'), worktreeCommit: oid('d'), branch: 'main', indexTree: oid('2'), worktreeTree: oid('4') });
    expect(await stageLegacyMigrationCode(env, source, f.manifest, [])).toEqual(checkpoint);
    expect(git.refs.get(checkpoint.checkpointRef)).toBe(oid('d'));
    vi.spyOn(ArtifactsCodeStore.prototype, 'readBlob').mockResolvedValue(new Blob(['corrupt']));
    await expect(stageLegacyMigrationCode(env, source, f.manifest, [])).rejects.toThrow();
  });

  it('activates a shallow current graph at the original IDs without requiring pre-HEAD ancestors', async () => {
    const f = await fixture();
    const git = shallowGraph();
    const receipt = await runInDurableObject(f.authority, async (_instance, state) => {
      const authority = new SpaceAuthorityDO(state, { ...env, ARTIFACTS: git.binding });
      const activated = await authority.migrateLegacy(f.finalize);
      expect(await authority.migrateLegacy(f.finalize)).toEqual(activated);
      return activated;
    });
    expect(receipt.checkpoint).toMatchObject({
      headCommit: oid('a'), indexCommit: oid('b'), trackedWorktreeCommit: oid('c'), worktreeCommit: oid('d'), indexTree: oid('2'), worktreeTree: oid('4'),
    });
    expect(git.refs.get(receipt.checkpoint.checkpointRef)).toBe(oid('d'));
    expect(await f.authority.runtimeCodeCheckpoint({ projectId: f.input.projectId, workspaceId: f.input.workspaceId })).toEqual(receipt.checkpoint);
    expect(await f.authority.get()).toMatchObject({ state: 'closed', generation: 3, manifestKey: f.manifestKey, manifestHash: f.input.expectedManifestHash });
    expect(await f.authority.beginOpen({ ...f.holder, expectedGeneration: 3 })).toMatchObject({ status: 'error' });
  });

  it.each(['head', 'index', 'tracked', 'worktree', 'tree', 'subtree', 'blob'] as const)('rejects missing required current %s rather than treating it as shallow history', async missing => {
    const f = await fixture();
    const git = shallowGraph(missing);
    await runInDurableObject(f.authority, async (_instance, state) => {
      const authority = new SpaceAuthorityDO(state, { ...env, ARTIFACTS: git.binding });
      await expect(authority.migrateLegacy(f.finalize)).rejects.toThrow();
      expect(await authority.hasCloudRuntime()).toBe(false);
    });
    expect(git.refs.size).toBe(0);
    expect(await f.authority.get()).toMatchObject({ state: 'closed', generation: 2, manifestKey: f.manifestKey, manifestHash: f.input.expectedManifestHash });
    expect(await f.authority.beginOpen({ ...f.holder, expectedGeneration: 2 })).toMatchObject({ status: 'error', failure: { code: 'WORKSPACE_POSSESSION_DENIED' } });
  });

  it('refuses an oversized current blob before retaining a runtime checkpoint', async () => {
    const f = await fixture();
    const git = graph('x'.repeat(32_000_001));
    const source = requireLegacyMigrationSource(await f.authority.get(), f.input, env.ACCOUNT_ID);
    await expect(stageLegacyMigrationCode(env, source, f.manifest, [])).rejects.toThrow();
    expect(git.refs.size).toBe(0);
    expect(await f.authority.hasCloudRuntime()).toBe(false);
  });

  it('requires actual LFS payloads even when a pre-inventory legacy manifest omits LFS metadata', async () => {
    const f = await fixture();
    const payload = new TextEncoder().encode('independently verified LFS payload');
    const object = GitLfsObjectSchema.parse({ oid: createHash('sha256').update(payload).digest('hex'), size: payload.length });
    const git = graph(`version https://git-lfs.github.com/spec/v1\noid sha256:${object.oid}\nsize ${object.size}\n`);
    const source = requireLegacyMigrationSource(await f.authority.get(), f.input, env.ACCOUNT_ID);
    await expect(stageLegacyMigrationCode(env, source, f.manifest, [object])).rejects.toThrow();
    expect(git.refs.size).toBe(0);
    const lfs = await createAccountGitLfsStore(env, env.ACCOUNT_ID, f.input.projectId, `migration-test:${f.input.operationId}`);
    await lfs.put(object, (async function* () { yield payload; })());
    expect((await stageLegacyMigrationCode(env, source, f.manifest, [object])).lfs).toEqual({ objects: [{ ...object, source: 'r2' }], heldBack: [] });
  });

  it('retains historical-only LFS after activation, publication release and later workspace archival', async () => {
    const f = await fixture();
    graph();
    const bytes = new TextEncoder().encode('reachable only from an older Git commit');
    const object = GitLfsObjectSchema.parse({ oid: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength });
    const publicationId = `migration-test:${f.input.operationId}`;
    const lfs = await createAccountGitLfsStore(env, env.ACCOUNT_ID, f.input.projectId, publicationId);
    await lfs.put(object, (async function* () { yield bytes; })());
    const receipt = await f.authority.migrateLegacy({ ...f.input, historicalLfs: [object] });
    expect(receipt.historicalLfs).toEqual([object]);
    expect(receipt.checkpoint.lfs?.objects).toEqual([]);
    await f.project.lfsReleasePublication(publicationId);
    expect(await lfs.has(object)).toBe(true);
    const workspace = (await f.project.listWorkspaces())[0]!;
    await f.project.putWorkspace({ ...workspace, lifecycle: 'archived', expectedRevision: workspace.revision });
    await f.project.lfsCollect();
    expect(await lfs.has(object)).toBe(true);
    await runInDurableObject(f.authority, async instance => {
      await expect(instance.migrateLegacy(f.finalize)).rejects.toThrow();
    });
  });

  it('activates passive history once, keeps the original checkpoint and retires legacy writers', async () => {
    const f = await fixture();
    graph();
    const receipt = await f.authority.migrateLegacy(f.finalize);
    expect(receipt).toMatchObject({ operationId: f.input.operationId, importedEvents: 1, source: { manifestHash: f.input.expectedManifestHash, generation: 2 }, checkpoint: { headCommit: oid('a'), indexCommit: oid('b'), worktreeCommit: oid('d') } });
    expect(await f.authority.migrateLegacy(f.finalize)).toEqual(receipt);
    expect(await f.authority.legacyMigrationStatus(f.input)).toEqual({ state: 'activated', source: receipt.source, receipt });
    expect(await f.authority.get()).toMatchObject({ state: 'closed', generation: 3, machineId: null, resumeMachineId: null, manifestKey: f.manifestKey, manifestHash: f.input.expectedManifestHash });
    expect(await f.authority.beginOpen({ ...f.holder, expectedGeneration: 3 })).toMatchObject({ status: 'error' });
    const definition = (await f.project.listWorkspaces())[0]!;
    await runInDurableObject(f.project, async instance => {
      await expect(instance.putMachineWorkspace({ ...definition, branch: 'old-machine', expectedRevision: definition.revision })).rejects.toThrow();
      await expect(instance.removeMachineWorkspace(definition.id, definition.revision)).rejects.toThrow();
      await expect(instance.putMachineArtifactScope({ id: f.scope.id, workspaceId: definition.id, generation: 1, expectedGeneration: 0, manifestHash: `sha256:${'1'.repeat(64)}` })).rejects.toThrow();
    });
    expect(await f.project.listWorkspaces()).toEqual([definition]);
    const identity = { projectId: f.input.projectId, workspaceId: f.input.workspaceId };
    expect(await f.authority.runtimeCodeCheckpoint(identity)).toEqual(receipt.checkpoint);
    const transcript = await (await f.authority.runtimeTranscript({ ...identity, conversationId: receipt.conversationId })).json();
    expect(JSON.stringify(transcript)).toContain('Preserve this history without running it');
    const snapshot = await (await f.authority.runtimeSnapshot(identity)).json();
    expect(snapshot).toMatchObject({ conversations: [expect.objectContaining({ id: receipt.conversationId, status: 'idle' })] });
    expect(new Uint8Array(await (await env.DATA.get(`users/${env.ACCOUNT_ID}/${f.sessionKey}`))!.arrayBuffer())).toEqual(f.session.bytes);
  });

  it('imports archived workspace history without reactivating its lifecycle or execution', async () => {
    const f = await fixture(true, { archived: true, branch: 'retained-branch' });
    graph();
    expect(await f.authority.legacyMigrationStatus(f.input)).toMatchObject({ state: 'ready', repository: f.manifest.repository });
    const receipt = await f.authority.migrateLegacy(f.finalize);
    expect((await f.project.listWorkspaces())[0]).toMatchObject({ lifecycle: 'archived', branch: 'retained-branch' });
    const identity = { projectId: f.input.projectId, workspaceId: f.input.workspaceId };
    const transcript = await (await f.authority.runtimeTranscript({ ...identity, conversationId: receipt.conversationId })).json();
    expect(JSON.stringify(transcript)).toContain('Preserve this history without running it');
    await runInDurableObject(f.authority, async instance => {
      await expect(instance.runtimeWriteEnvironmentBundle(identity, '{}')).rejects.toThrow();
    });
    expect((await f.project.listWorkspaces())[0]?.lifecycle).toBe('archived');
  });

  it.each([false, true])('seeds the migrated base source so a new cloud workspace needs no origin (unborn=%s)', async unborn => {
    const f = await fixture(true, { base: true, branch: 'retained/base', repositoryReference: 'https://private-origin.invalid/repository.git', unborn });
    const git = await projectGraph(f.input.projectId, f.manifest.repository.branch, { unborn });
    const scoped = { ...env, ARTIFACTS: git.binding };
    const receipt = await runInDurableObject(f.authority, async (_instance, state) => {
      const authority = new SpaceAuthorityDO(state, scoped);
      const receipt = await authority.migrateLegacy(f.finalize);
      expect(await authority.migrateLegacy(f.finalize)).toEqual(receipt);
      return receipt;
    });
    expect(await stageLegacyMigrationCode(scoped, receipt.source, f.manifest, [])).toEqual(receipt.checkpoint);
    const project = (await f.project.getProject())!;
    await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).put(project);
    const created = await createCloudWorkspace(scoped, env.ACCOUNT_ID, { projectId: f.input.projectId, name: 'From migrated base', branch: 'created/from-base', sourceKind: 'base', sourceRef: '' });
    expect(project.baseBranch).toBe('retained/base');
    const headCommit = unborn ? null : oid('a');
    expect(created.workspace).toMatchObject({ sourceCommit: headCommit, sourceRef: 'retained/base', lifecycle: 'active' });
    expect(await git.code.resolveRef(`workspace-${created.workspace.id}`, 'refs/heads/created/from-base')).toBe(headCommit);
    expect(await git.code.resolveRef(`project-${f.input.projectId}`, 'refs/heads/retained/base')).toBe(headCommit);
    expect(receipt.checkpoint).toMatchObject({ headCommit, indexCommit: oid('b'), trackedWorktreeCommit: oid('c'), worktreeCommit: oid('d') });
  });

  it.each(['branch', 'repository'] as const)('refuses a conflicting canonical %s without activating or overwriting it', async conflict => {
    const f = await fixture(true, { base: true, branch: 'retained/base' });
    const git = await projectGraph(f.input.projectId, f.manifest.repository.branch, { conflict });
    const before = [...git.repositories.get(`project-${f.input.projectId}`)!.refs];
    await runInDurableObject(f.authority, async (_instance, state) => {
      const authority = new SpaceAuthorityDO(state, { ...env, ARTIFACTS: git.binding });
      await expect(authority.migrateLegacy(f.finalize)).rejects.toThrow();
      expect(await authority.hasCloudRuntime()).toBe(false);
    });
    expect([...git.repositories.get(`project-${f.input.projectId}`)!.refs]).toEqual(before);
    expect(await f.authority.get()).toMatchObject({ generation: 2, manifestHash: f.input.expectedManifestHash });
  });

  it.each([true, false])('aligns only source branch metadata under revision CAS (base=%s)', async base => {
    const f = await fixture(true, { base, branch: 'infra/keys' });
    graph();
    if (base) vi.spyOn(ArtifactsCodeStore.prototype, 'seedLegacyProjectSource').mockResolvedValue();
    const beforeProject = (await f.project.getProject())!;
    const beforeWorkspace = (await f.project.listWorkspaces())[0]!;
    expect(await f.authority.legacyMigrationStatus(f.input)).toMatchObject({ state: 'ready' });
    const receipt = await f.authority.migrateLegacy(f.finalize);
    expect(receipt.branchAlignment).toEqual({ project: { before: 'main', after: base ? 'infra/keys' : 'main' }, workspace: { before: 'main', after: 'infra/keys' } });
    const project = (await f.project.getProject())!;
    const workspace = (await f.project.listWorkspaces())[0]!;
    expect(project).toEqual({ ...beforeProject, baseBranch: base ? 'infra/keys' : 'main', revision: beforeProject.revision + (base ? 1 : 0), updatedAt: project.updatedAt });
    expect(workspace).toEqual({ ...beforeWorkspace, branch: 'infra/keys', sourceRef: base ? 'infra/keys' : beforeWorkspace.sourceRef, revision: beforeWorkspace.revision + 1, updatedAt: workspace.updatedAt });
    expect(await f.authority.migrateLegacy(f.finalize)).toEqual(receipt);
    expect(await f.project.getProject()).toEqual(project);
    expect(await f.project.listWorkspaces()).toEqual([workspace]);
  });

  it.each(['manifest', 'transcript', 'artifact'] as const)('rejects corrupt or missing %s before taking a source fence', async kind => {
    const f = await fixture();
    const path = kind === 'manifest' ? f.manifestKey : kind === 'transcript' ? f.sessionKey : spaceArtifactManifestKey(f.input.projectId, f.input.workspaceId, 1, 0);
    const before = await f.authority.get();
    const workspace = (await f.project.listWorkspaces())[0]!;
    if (kind === 'manifest') await env.DATA.put(`users/${env.ACCOUNT_ID}/${path}`, new Uint8Array([0, 1, 2]));
    else await env.DATA.delete(`users/${env.ACCOUNT_ID}/${path}`);
    await runInDurableObject(f.authority, async instance => {
      await expect(instance.legacyMigrationStatus(f.input)).rejects.toThrow();
      await expect(instance.stageLegacyMigration(f.input)).rejects.toThrow();
      await expect(instance.migrateLegacy(f.finalize)).rejects.toThrow();
    });
    expect(await f.authority.get()).toEqual(before);
    expect(await f.project.listWorkspaces()).toEqual([workspace]);
    expect(await f.project.getArtifactScope(f.scope.id)).toBeNull();
    expect(await f.authority.hasCloudRuntime()).toBe(false);
    expect(await f.authority.beginOpen({ ...f.holder, expectedGeneration: 2 })).toMatchObject({ status: 'ok' });
  });

  it('rejects missing artifact metadata and preserves the immutable session object', async () => {
    const f = await fixture();
    const source = requireLegacyMigrationSource(await f.authority.get(), f.input, env.ACCOUNT_ID);
    const bundle = await readLegacyMigrationBundle(env, source);
    expect(bundle.transcript).toMatchObject({ objectKey: f.sessionKey, objectHash: f.session.hash, sessionId: 'session', ompSessionId: 'omp' });
    await env.DATA.delete(`users/${env.ACCOUNT_ID}/${spaceArtifactManifestKey(f.input.projectId, f.input.workspaceId, 1, 0)}`);
    await expect(readLegacyMigrationBundle(env, source)).rejects.toThrow('unavailable');
    expect(new Uint8Array(await (await env.DATA.get(`users/${env.ACCOUNT_ID}/${f.sessionKey}`))!.arrayBuffer())).toEqual(f.session.bytes);
  });
});
