import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, createSignedRpcFetch, credentialProtocolBase64, deriveArtifactScopeKey, encodeApiKey, encryptArtifactBytes, signDeviceInvite, signRpcRequest, type DeviceCapability, type DeviceScope } from '@gitspace/protocol';
import { createGitSpaceClient } from '@gitspace/protocol/client';
import { CHECKPOINT_CHUNK_BYTES, CHUNKED_CHECKPOINT_VERSION, spaceCheckpointManifestKey, spaceGitCheckpointRef, spaceOmpCheckpointKey, type SpaceCheckpointManifest } from '@gitspace/protocol-workspace';
import type { ProviderView } from '@gitspace/protocol';
import { executionHash, loadEnvironmentBundle, type LifecycleRun } from '@gitspace/protocol-environment';
import { gitspaceContract, rpcErrors, UserSettingsViewCodec } from '@gitspace/protocol/rpc-contract';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { decodeTranscriptChunks, type TranscriptChunk, type TranscriptEvent } from '@gitspace/protocol/transcript';
import { createBrowserClient, type BrowserClientOf } from 'result-rpc/client';
import { parse, stringify } from 'devalue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { tenantRootPrivateKey } from './setup.js';
import { HttpResponse, http } from 'msw';
import { network } from './network.js';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { z } from 'zod';
import { RuntimeAttachmentSchema, RuntimeLifecycleDispatchArgumentsSchema, type RuntimeGitCheckpoint, type RuntimeToolDispatch } from '@gitspace/protocol-runtime';
import { Result } from 'better-result';
import type { SpaceAuthorityDO } from '../src/space-authority.js';

afterEach(() => vi.restoreAllMocks());
function emptyCommittedSource() {
  const info: ArtifactsRepoInfo = { id: 'empty-fixture', name: 'empty-fixture', description: null, defaultBranch: 'main', createdAt: '', updatedAt: '', lastPushAt: null, source: null, readOnly: false, remote: 'https://artifacts.invalid/empty.git' };
  vi.spyOn(ArtifactsCodeStore.prototype, 'ensureEmptyProject').mockResolvedValue(info);
  vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockResolvedValue(info);
  vi.spyOn(ArtifactsCodeStore.prototype, 'resolveRef').mockResolvedValue(null);
}

async function account(capabilities: DeviceCapability[] = ['rpc.read', 'rpc.write', 'fleet.control', 'devices.manage'], kind: 'browser' | 'client' = 'browser', scope: DeviceScope = { kind: 'user' }) {
  const userId = env.ACCOUNT_ID;
  const handle = env.TENANT_ID;
  const rootKey = tenantRootPrivateKey;
  const browserKey = crypto.getRandomValues(new Uint8Array(32));
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(71)) });
  await env.USER_SETTINGS.getByName(userId).setHandle('bootstrap', 0, handle);
  const invite = signDeviceInvite({ version: 1, userId, inviteId: crypto.randomUUID(), kind, label: null, scope, capabilities, canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'https://api.gitspace.sh' }, rootKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(browserKey)), label: 'Browser', boundAt: Date.now(), signingPrivateKey: browserKey });
  const enrolled = await vault.enrollDevice({ invite, binding });
  if (enrolled.status !== 'ok') throw new Error(enrolled.error.message);
  const request = (envelope: unknown) => {
    const body = stringify(envelope);
    const signature = signRpcRequest({ deviceId: binding.deviceId, method: 'POST', path: '/rpc', body: new TextEncoder().encode(body), signingPrivateKey: browserKey });
    return new Request(`https://${handle}.gitspace.sh/rpc`, { method: 'POST', body, headers: { 'content-type': 'application/result-rpc+devalue; sv=1', 'x-gitspace-user': userId, 'x-gitspace-device': signature } });
  };
  return { userId, handle, vault, deviceId: binding.deviceId, signingPrivateKey: browserKey, request };
}

const single = (path: string, input: unknown = {}) => ({ v: 1, path, input });

describe('cloud lifecycle inspection and explicit authorization', () => {
  it('links internal RPC failures to server logs without exposing their private cause', async () => {
    const fixture = await account();
    const privateCause = 'private output-encoding failure';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(UserSettingsViewCodec, 'encode').mockImplementation(() => { throw new Error(privateCause); });
    const response = await worker.fetch(fixture.request(single('settings.get')), env);
    const body = await response.text();
    const line = logged.mock.calls.map(([entry]) => entry).find(entry => typeof entry === 'string' && entry.includes('"event":"rpc_internal_error"'));
    if (typeof line !== 'string') throw new Error('Missing internal incident log');
    const incident = z.object({ incidentId: z.string().min(1), phase: z.string().min(1), procedurePath: z.literal('settings.get'), message: z.string(), stack: z.string() }).parse(JSON.parse(line));
    expect(line).toContain(privateCause);
    expect(body).toContain(incident.incidentId);
    expect(body).not.toContain(privateCause);
  });

  it('reports pending inference activation until the platform health probe commits this Worker', async () => {
    const fixture = await account();
    const client = inspectorClient(fixture);
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: 'previous-worker' } })));
    expect(await client.inference.list({})).toMatchObject({ status: 'error', error: { _tag: 'gitspace/inference-activation-pending' } });
    expect(await fixture.vault.inferenceCutover()).toBe(false);
    const controller = new AbortController();
    const stream = client.inference.events({ after: null }, { signal: controller.signal })[Symbol.asyncIterator]();
    try {
      expect(await stream.next()).toMatchObject({ done: false, value: { status: 'error', error: { _tag: 'gitspace/inference-activation-pending' } } });
    } finally {
      controller.abort();
      await stream.return?.();
    }
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: 'test-inference-worker' } })));
    expect(await client.inference.list({})).toMatchObject({ status: 'ok', value: { profiles: [{ id: 'default' }] } });
    expect(await fixture.vault.inferenceCutover()).toBe(true);
  });

  it('fences an established environment stream before disclosing suspended account changes', async () => {
    const fixture = await account();
    const { spaceId, authority } = await inspectorWorkspace(fixture.userId);
    const client = inspectorClient(fixture);
    const controller = new AbortController();
    const stream = client.environment.events({ spaceId, after: null }, { signal: controller.signal })[Symbol.asyncIterator]();
    try {
      expect(await stream.next()).toMatchObject({ done: false, value: { status: 'ok' } });
      network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'suspended' } })));
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15_001);
      const pending = stream.next();
      await authority.mutateLifecycleState(spaceId, { op: 'policy', automatic: true }, { machineId: 'machine', actorId: 'human', kind: 'browser', lifecycleControl: true });
      expect(await pending).toMatchObject({ done: false, value: { status: 'error' } });
    } finally {
      controller.abort();
      await stream.return?.();
    }
  });

  it('streams committed environment changes and replays changes missed while disconnected', async () => {
    const fixture = await account();
    const { spaceId, authority } = await inspectorWorkspace(fixture.userId);
    const client = inspectorClient(fixture);
    const controller = new AbortController();
    const stream = client.environment.events({ spaceId, after: null }, { signal: controller.signal })[Symbol.asyncIterator]();
    let cursor: number;
    try {
      const initial = await stream.next();
      expect(initial).toMatchObject({ done: false, value: { status: 'ok', value: { type: 'snapshot', resource: `environment:${spaceId}`, value: { policy: { automatic: false } } } } });
      const pending = stream.next();
      expect(await authority.mutateLifecycleState(spaceId, { op: 'policy', automatic: true }, { machineId: 'machine', actorId: 'human', kind: 'browser', lifecycleControl: true })).toMatchObject({ status: 'ok' });
      const changed = await pending;
      expect(changed).toMatchObject({ done: false, value: { status: 'ok', value: { type: 'change', value: { policy: { automatic: true } } } } });
      if (changed.done || changed.value.status === 'error') throw new Error('Expected a committed environment change');
      cursor = changed.value.value.cursor;
    } finally {
      controller.abort();
      await stream.return?.();
    }
    expect(await authority.mutateLifecycleState(spaceId, { op: 'policy', automatic: false }, { machineId: 'machine', actorId: 'human', kind: 'browser', lifecycleControl: true })).toMatchObject({ status: 'ok' });
    const resumedController = new AbortController();
    const resumed = client.environment.events({ spaceId, after: cursor }, { signal: resumedController.signal })[Symbol.asyncIterator]();
    try {
      expect(await resumed.next()).toMatchObject({
        done: false,
        value: { status: 'ok', value: { type: 'change', previous: cursor, value: { policy: { automatic: false } } } },
      });
    } finally {
      resumedController.abort();
      await resumed.return?.();
    }
  });

  it.each(['browser', 'client'] as const)('allows authorized %s lifecycle control while preserving content review', async (kind) => {
    emptyCommittedSource();
    const fixture = await account(['rpc.read', 'rpc.write', ...(kind === 'client' ? ['lifecycle.control' as const] : [])], kind);
    const projectId = 'lifecycle-project';
    const spaceId = 'lifecycle-space';
    const authority = env.PROJECT_AUTHORITY.getByName(`${fixture.userId}:${projectId}`);
    await authority.bootstrap({ id: projectId, name: 'Lifecycle', repositoryReference: null, baseBranch: 'main', createdBy: 'machine' });
    await authority.putWorkspace({ id: spaceId, projectId, kind: 'worktree', name: 'Lifecycle', branch: 'feature', phase: null, sourceKind: 'branch', sourceRef: 'feature', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await env.USER_PROJECTS.getByName(fixture.userId).putWorkspaceLocation(spaceId, projectId);
    const content = 'echo provision';
    const hash = await executionHash({ kind: 'script', command: content });
    const actor = { machineId: 'removed-machine', actorId: 'removed-machine', kind: 'machine' as const, lifecycleControl: false };
    const configure = { op: 'configure' as const, bundleJson: JSON.stringify({ version: 1, profiles: { base: {} } }), executions: [{ id: 'provision', kind: 'script' as const, label: 'Provision', command: 'bash provision.sh', content, hash, phase: 'cloud/provision' as const, fileName: '10-provision.sh' }] };
    const configured = await authority.mutateLifecycleState(spaceId, configure, actor);
    if (configured.status === 'error') throw new Error(configured.failure.message);
    const approved = await SELF.fetch(fixture.request(single('environment.approve', { spaceId, executionHash: hash, scope: 'workspace' })));
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(parse(await approved.text())).toMatchObject({ status: 'ok', value: { executions: [{ content, approval: 'workspace' }] } });
    expect((await authority.getLifecycleState(spaceId)).approvals[0]?.approvedBy).toBe(fixture.deviceId);
    const policy = await authority.mutateLifecycleState(spaceId, { op: 'policy', automatic: true }, actor);
    if (policy.status === 'error') throw new Error(policy.failure.message);
    const running = await authority.mutateLifecycleState(spaceId, { op: 'claim', runId: 'provision', phase: 'cloud/provision', profile: 'base', executionHashes: [hash], generation: null, rerun: false }, actor);
    if (running.status === 'error') throw new Error(running.failure.message);
    const token = running.state.claim?.token;
    if (!token) throw new Error('Expected a lifecycle execution claim');
    const finished = await authority.mutateLifecycleState(spaceId, { op: 'finish', runId: 'provision', token, status: 'failed', exitCode: 1, results: [], output: 'cloud error', bindings: { database: 'partial-db' } }, actor);
    if (finished.status === 'error') throw new Error(finished.failure.message);
    const state = await SELF.fetch(fixture.request(single('environment.get', { spaceId })));
    expect(state.status, await state.clone().text()).toBe(200);
    expect(parse(await state.text())).toMatchObject({ status: 'ok', value: { lifecycle: { bindings: { database: 'partial-db' }, runs: [{ status: 'failed', output: 'cloud error' }] } } });
    expect(await env.FLEET_CATALOG.getByName(fixture.userId).listMachines()).toEqual([]);
    const log = await SELF.fetch(fixture.request(single('environment.runLog', { spaceId, runId: 'provision', offset: null })));
    expect(parse(await log.text())).toMatchObject({ status: 'ok', value: { output: 'cloud error', nextOffset: null } });
    const changed = await authority.mutateLifecycleState(spaceId, { ...configure, executions: [{ ...configure.executions[0]!, content: 'different displayed content' }] }, actor);
    if (changed.status === 'error') throw new Error(changed.failure.message);
    const forged = await SELF.fetch(fixture.request(single('environment.approve', { spaceId, executionHash: hash, scope: 'project' })));
    expect(parse(await forged.text())).toMatchObject({ status: 'error' });
  });

  it('derives a cloud workspace environment from its uncommitted checkpoint worktree and lets a cache claim the approved script', async () => {
    emptyCommittedSource();
    const fixture = await account(['rpc.read', 'rpc.write']);
    const { spaceId, authority, placement } = await inspectorWorkspace(fixture.userId);
    const id = (digit: string) => digit.repeat(40);
    // HEAD has neither file: the agent wrote both into the cloud worktree without committing.
    const checkpoint = { checkpointRef: `refs/gitspace/spaces/${spaceId}/checkpoints`, headCommit: id('1'), branch: 'review', indexCommit: id('2'), trackedWorktreeCommit: id('3'), worktreeCommit: id('4'), indexTree: id('5'), worktreeTree: id('6') };
    const bundle = { version: 1, defaultProfile: 'base', profiles: { base: {} } };
    const script = '#!/usr/bin/env bash\nsudo apt-get install -y python3\n';
    const worktree: Record<string, string> = { 'README.md': id('a'), '.gitspace/bundle.json': id('b'), '.gitspace/lifecycle/machine/prepare/10-python.sh': id('c') };
    const blobs: Record<string, string> = { [id('a')]: '# Pantry\n', [id('b')]: JSON.stringify(bundle), [id('c')]: script };
    vi.spyOn(ArtifactsCodeStore.prototype, 'readFile').mockResolvedValue(null);
    vi.spyOn(ArtifactsCodeStore.prototype, 'listSnapshotInventories').mockImplementation(async (_repository, requested) => requested.map(tree =>
      new Map(Object.entries(tree === checkpoint.worktreeTree ? worktree : {}).map(([path, oid]) => [path, { oid, mode: '100644', type: 'blob' as const }]))));
    vi.spyOn(ArtifactsCodeStore.prototype, 'readBlob').mockImplementation(async (_repository, oid) => blobs[oid] === undefined ? null : new Blob([blobs[oid]]));
    await runInDurableObject(placement, (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_code_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1), checkpoint TEXT NOT NULL)');
      state.storage.sql.exec('INSERT INTO runtime_code_snapshot(singleton,checkpoint) VALUES(1,?)', JSON.stringify(checkpoint));
    });
    const hash = await executionHash({ kind: 'script', command: script });
    const rpc = async (path: string, input: unknown) => parse(await (await SELF.fetch(fixture.request(single(path, input)))).text());
    expect(await rpc('environment.get', { spaceId })).toMatchObject({ status: 'ok', value: {
      bundleJson: JSON.stringify(loadEnvironmentBundle(bundle)),
      executions: [{ id: 'machine/prepare:10-python.sh', kind: 'script', phase: 'machine/prepare', fileName: '10-python.sh', content: script, hash, approval: null }],
    } });
    const attachment = { attachmentId: 'cache-a', generation: 1 };
    const cache = { machineId: 'machine-a', actorId: 'machine-a', kind: 'machine' as const, lifecycleControl: false, attachment };
    const claim = (runId: string) => authority.mutateLifecycleState(spaceId, { op: 'claim', runId, ownershipToken: runId, phase: 'machine/prepare', profile: 'base', executionHashes: [hash], generation: null, rerun: true, attachment }, cache);
    expect(await claim('before-approval')).toMatchObject({ status: 'error', failure: { code: 'ApprovalRequired' } });
    expect(await rpc('environment.approve', { spaceId, executionHash: hash, scope: 'workspace' })).toMatchObject({ status: 'ok', value: { executions: [{ hash, approval: 'workspace' }] } });
    expect(await claim('after-approval')).toMatchObject({ status: 'ok', state: { claim: { runId: 'after-approval', status: 'claimed' } } });
    // A later checkpoint edit is new content: it surfaces for review rather than inheriting the approval.
    blobs[id('c')] = `${script}python3 --version\n`;
    expect(await rpc('environment.get', { spaceId })).toMatchObject({ status: 'ok', value: {
      executions: [{ content: blobs[id('c')], hash: await executionHash({ kind: 'script', command: blobs[id('c')]! }), approval: null }],
    } });
  });

  it('rejects API clients granting approval even when they hold account write access', async () => {
    const fixture = await account(['rpc.read', 'rpc.write'], 'client');
    const result = await SELF.fetch(fixture.request(single('environment.approve', { spaceId: 'any-space', executionHash: `sha256:${'a'.repeat(64)}`, scope: 'workspace' })));
    expect(parse(await result.text())).toMatchObject({ status: 'error' });
  });
});

describe('Inspector administrative authority', () => {
  it('rejects ordinary client approvals and records a delegated client rather than its claimed reviewer', async () => {
    const owner = await account(['rpc.read', 'rpc.write', 'account.admin'], 'client');
    const ordinary = await account(['rpc.read', 'rpc.write'], 'client');
    const { projectId, spaceId } = await inspectorWorkspace(owner.userId);
    const invoke = async (actor: typeof owner, path: string, input: unknown) => parse(await (await SELF.fetch(actor.request(single(path, { expectedGeneration: 0, input })))).text());
    const identity = { projectId, spaceId };
    expect(await invoke(owner, 'inspector.workflow.put', { ...identity, expectedRevision: 0, workflow: {
      id: 'workflow', title: 'Review', description: '', updatedBy: 'author',
      nodes: [{ id: 'gate', kind: 'gate', label: 'Review', position: { x: 0, y: 0 }, requirementIds: [] }], edges: [],
    } })).toMatchObject({ status: 'ok' });
    const waiver = { ...identity, expectedRevision: 1, gateId: 'gate', waiverId: 'waiver', reason: 'Owner delegated this review', actorId: 'forged-browser', actorKind: 'human' };
    expect(await invoke(ordinary, 'inspector.workflow.waiveGate', waiver)).toMatchObject({ status: 'error' });
    expect(await invoke(owner, 'inspector.workflow.waiveGate', waiver)).toMatchObject({ status: 'ok', value: { nodes: [{ waivers: [{ actorId: owner.deviceId, actorKind: 'client' }] }] } });
    const headCommit = 'a'.repeat(40);
    expect(await invoke(owner, 'inspector.guide.put', { ...identity, expectedRevision: 0, guide: {
      headCommit, baseRef: 'main', title: 'Review', createdBy: 'author',
      sections: [{ id: 'section', title: 'Change', kind: 'risk', explanation: 'Changed behavior', why: 'Permission boundary', exhibits: [], requirementIds: [] }],
    } })).toMatchObject({ status: 'ok' });
    const review = { ...identity, revision: 1, headCommit, reviewerId: 'forged-browser' };
    expect(await invoke(owner, 'inspector.guide.markSectionRead', { ...review, sectionId: 'section' })).toMatchObject({ status: 'ok', value: { reviewerStates: [{ reviewerId: owner.deviceId }] } });
    expect(await invoke(ordinary, 'inspector.guide.setApproval', { ...review, decision: 'approved', note: null })).toMatchObject({ status: 'error' });
    expect(await invoke(owner, 'inspector.guide.setApproval', { ...review, decision: 'approved', note: null })).toMatchObject({ status: 'ok', value: { reviewerStates: [{ reviewerId: owner.deviceId, decision: 'approved' }] } });
  });
});

describe('account cloud RPC without machines', () => {
  it('manages shared secrets and values without machines and enforces effective grants', async () => {
    emptyCommittedSource();
    const fixture = await account();
    const { projectId, spaceId, authority } = await inspectorWorkspace(fixture.userId);
    const configured = await authority.mutateLifecycleState(spaceId, {
      op: 'configure',
      bundleJson: JSON.stringify({ version: 1, profiles: { base: { values: ['REGION'] } }, values: { REGION: {} } }),
    }, { machineId: 'removed-machine', actorId: 'removed-machine', kind: 'machine', lifecycleControl: false });
    if (configured.status === 'error') throw new Error(configured.failure.message);
    const secrets = env.PROJECT_SECRETS.getByName(fixture.userId);
    await secrets.bootstrap({ userId: fixture.userId, vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
    const rpc = async (path: string, input: unknown = {}) => {
      const response = await SELF.fetch(fixture.request(single(path, input)));
      const text = await response.text();
      expect(text).not.toContain('private-secret-value');
      return parse(text);
    };
    expect(await rpc('configuration.values.put', { scope: 'global', name: 'REGION', value: 'global' })).toMatchObject({ status: 'ok', value: { global: { REGION: 'global' }, project: {} } });
    expect(await rpc('environment.get', { spaceId })).toMatchObject({ status: 'ok', value: { values: { effective: { REGION: 'global' } } } });
    expect(await rpc('configuration.values.put', { scope: 'project', projectId, name: 'REGION', value: 'project' })).toMatchObject({ status: 'ok', value: { global: { REGION: 'global' }, project: { REGION: 'project' } } });
    expect(await authority.getEnvironmentValues()).toEqual({ REGION: 'project' });
    expect(await rpc('configuration.values.put', { scope: 'project', name: 'REGION', value: 'bad' })).toMatchObject({ status: 'error' });
    expect(await rpc('secrets.account.put', { name: 'TOKEN', value: 'private-secret-value' })).toMatchObject({ status: 'ok', value: { name: 'TOKEN', grants: [] } });
    expect(await secrets.materialize(projectId, ['TOKEN'], spaceId)).toEqual({});
    expect(await rpc('secrets.account.grant', { name: 'TOKEN', projectId: 'foreign-project', projectSpaceEnabled: true, workspacesEnabled: true })).toMatchObject({ status: 'error' });
    expect(await rpc('secrets.account.grant', { name: 'TOKEN', projectId, projectSpaceEnabled: false, workspacesEnabled: true })).toMatchObject({ status: 'ok', value: { grants: [{ projectId, projectSpaceEnabled: false, workspacesEnabled: true }] } });
    expect(await secrets.materialize(projectId, ['TOKEN'], null)).toEqual({});
    expect(await secrets.materialize(projectId, ['TOKEN'], spaceId)).toEqual({ TOKEN: 'private-secret-value' });
    expect(await rpc('environment.get', { spaceId })).toMatchObject({ status: 'ok', value: { secretMetadata: [{ name: 'TOKEN', source: 'account' }], values: { effective: { REGION: 'project' } } } });
    expect(await rpc('secrets.put', { projectId, name: 'TOKEN', value: 'project-override' })).toMatchObject({ status: 'ok' });
    expect(await secrets.materialize(projectId, ['TOKEN'], spaceId)).toEqual({ TOKEN: 'project-override' });
    expect(await rpc('secrets.account.revoke', { name: 'TOKEN', projectId })).toMatchObject({ status: 'ok', value: { grants: [] } });
    expect(await rpc('secrets.delete', { projectId, name: 'TOKEN' })).toMatchObject({ status: 'ok', value: { deleted: true } });
    expect(await secrets.materialize(projectId, ['TOKEN'], spaceId)).toEqual({});
    expect(await env.FLEET_CATALOG.getByName(fixture.userId).listMachines()).toEqual([]);
  });

  it('lists and updates bundled account skills with no selected project', async () => {
    const fixture = await account();
    const response = await SELF.fetch(fixture.request(single('skills.list')));
    const list = parse(await response.text()) as { status: string; value: Array<{ id: string; revision: number }> };
    expect(list.status).toBe('ok');
    const skill = list.value.find(entry => entry.id === 'space-goal')!;
    expect(skill).toBeDefined();
    const updated = await SELF.fetch(fixture.request(single('skills.update', { update: { id: skill.id, expectedRevision: skill.revision, enabled: false, scope: 'all', exceptions: [], assignments: [] } })));
    expect(parse(await updated.text())).toMatchObject({ status: 'ok', value: { id: skill.id, enabled: false, revision: skill.revision + 1 } });
    const reader = await account(['rpc.read']);
    expect((await SELF.fetch(reader.request(single('secrets.account.put', { name: 'TOKEN', value: 'denied' })))).status).toBe(403);
  });

  it('manages plugins and project-owned cron queues through the cloud alone', async () => {
    const fixture = await account();
    const { projectId, spaceId } = await inspectorWorkspace(fixture.userId);
    const rpc = async (path: string, input: unknown = {}) => {
      const response = await SELF.fetch(fixture.request(single(path, input)));
      const text = await response.text();
      return parse(text);
    };
    const draft = { id: 'plugin', label: 'Plugin', enabled: true, target: { kind: 'workspace' }, transport: { type: 'http', url: 'https://example.test/mcp', headers: [] }, timeoutMs: 5_000 };
    expect(await rpc('mcp.connections.create', { connection: draft })).toMatchObject({ status: 'ok', value: { id: 'plugin', revision: 1 } });
    expect(await rpc('mcp.connections.list')).toMatchObject({ status: 'ok', value: [{ id: 'plugin', createdAt: expect.any(Date) }] });
    expect(await rpc('mcp.grants.list', { projectId })).toMatchObject({ status: 'ok', value: [] });
    expect(await rpc('mcp.grants.put', { projectId, connectionId: 'plugin', enabled: true, projectSpaceEnabled: false, workspacesEnabled: true, expectedRevision: 0 })).toMatchObject({ status: 'ok', value: { projectId, workspacesEnabled: true, projectSpaceEnabled: false, revision: 1 } });
    expect(await rpc('mcp.grants.put', { projectId: 'foreign', connectionId: 'plugin', enabled: true, projectSpaceEnabled: true, workspacesEnabled: true, expectedRevision: 0 })).toMatchObject({ status: 'error' });
    const cronDraft = { name: 'Review', schedule: 'every 1h', description: '', prompt: 'Review the changes', target: { scope: 'workspace', projectId, spaceId }, readScopes: [], writeScopes: [], enabled: false };
    const created = await rpc('crons.create', { projectId, draft: cronDraft }) as { status: string; value: { id: string; revision: number } };
    expect(created.status).toBe('ok');
    expect(await rpc('crons.list', { projectId })).toMatchObject({ status: 'ok', value: [{ id: created.value.id }] });
    expect(await rpc('crons.create', { projectId, draft: { ...cronDraft, target: { ...cronDraft.target, spaceId: 'foreign' } } })).toMatchObject({ status: 'error' });
    const queued = await rpc('crons.runNow', { projectId, cronId: created.value.id });
    expect(queued).toMatchObject({ status: 'ok', value: { projectId, cronId: created.value.id, prompt: cronDraft.prompt } });
    expect(await rpc('crons.history', { projectId, cronId: created.value.id })).toMatchObject({ status: 'ok', value: [{ id: queued.value.id, projectId, cronId: created.value.id, prompt: cronDraft.prompt }] });
    expect(await env.PROJECT_CRONS.getByName(JSON.stringify([fixture.userId, projectId])).list(projectId)).toMatchObject([{ id: created.value.id }]);
    expect(await env.FLEET_CATALOG.getByName(fixture.userId).listMachines()).toEqual([]);
  });

  it('loads settings, an empty fleet, and the mandatory cloud-only source project without a machine', async () => {
    const fixture = await account();
    const response = await SELF.fetch(fixture.request({ v: 1, batch: [
      { ...single('settings.get'), id: 'settings' },
      { ...single('settings.git.get'), id: 'git' },
      { ...single('machines'), id: 'fleet' },
      { ...single('project.list', { lifecycle: 'active' }), id: 'projects' },
    ] }));
    expect(response.status).toBe(200);
    expect(parse(await response.text())).toMatchObject({ v: 1, batch: [
      { id: 'settings', response: { status: 'ok', value: { profile: { handle: fixture.handle }, revision: 1 } } },
      { id: 'git', response: { status: 'ok', value: null } },
      { id: 'fleet', response: { status: 'ok', value: [] } },
      { id: 'projects', response: { status: 'ok', value: [{ role: 'gitspace-source', lifecycle: 'cloud-only' }] } },
    ] });
  });


  it('repairs the same canonical source project across concurrent onboarding requests without Git authorization', async () => {
    const fixture = await account();
    const responses = await Promise.all(Array.from({ length: 3 }, () => SELF.fetch(fixture.request(single('project.ensureGitSpace', { sourceBranch: 'release/test', sourceCommit: 'a'.repeat(40) })))));
    const projects = await Promise.all(responses.map(async (response) => {
      expect(response.status).toBe(200);
      const envelope = parse(await response.text());
      expect(envelope).toMatchObject({ status: 'ok', value: { role: 'gitspace-source', lifecycle: 'cloud-only' } });
      return envelope.value;
    }));
    expect(new Set(projects.map((project) => project.id)).size).toBe(1);
    expect(await env.USER_PROJECTS.getByName(fixture.userId).list()).toHaveLength(1);
    expect(await env.PROJECT_AUTHORITY.getByName(`${fixture.userId}:${projects[0].id}`).listWorkspaces()).toMatchObject([
      { id: projects[0].id, projectId: projects[0].id, kind: 'base', branch: projects[0].baseBranch },
    ]);
    expect(await env.FLEET_CATALOG.getByName(fixture.userId).listMachines()).toEqual([]);
    expect(await env.USER_SETTINGS.getByName(fixture.userId).getGitIdentity()).toBeNull();
  });

  it('opens an empty fleet stream and reports the first machine without reconnecting', async () => {
    const fixture = await account();
    const response = await SELF.fetch(fixture.request(single('machine.events', { after: null })));
    const reader = response.body!.getReader();
    try {
      const ready = await reader.read();
      expect(parse(new TextDecoder().decode(ready.value).trim())).toMatchObject({
        response: { status: 'ok', value: { type: 'snapshot', previous: null, value: [] } },
      });
      await env.FLEET_CATALOG.getByName(fixture.userId).putMachine({
        id: 'first-machine', label: 'First machine', state: 'offline', rpcEndpoint: null,
        kind: 'physical', provider: 'physical', notes: '', desiredState: 'online',
        lifecycleRevision: 1, operationId: null, error: null,
      });
      const changed = await reader.read();
      expect(parse(new TextDecoder().decode(changed.value).trim())).toMatchObject({
        response: { status: 'ok', value: { type: 'change', value: [{ id: 'first-machine', state: 'offline' }] } },
      });
    } finally {
      await reader.cancel();
    }
  });

  it('keeps missing machine data from failing concurrent account queries for API clients', async () => {
    const fixture = await account(['rpc.read', 'rpc.write'], 'client');
    const content = '{"toolExecution":"sequential"}';
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
    await env.USER_SETTINGS.getByName(fixture.userId).updateRuntime('bootstrap', { expectedGeneration: 0, content, checksum: `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}` });
    const client = createGitSpaceClient({
      key: encodeApiKey({
        version: 2, userId: fixture.userId, deviceId: fixture.deviceId,
        signingPrivateKey: credentialProtocolBase64.encode(fixture.signingPrivateKey),
        rpcUrl: `https://${fixture.handle}.gitspace.sh/rpc`,
        enrollUrl: `https://${fixture.handle}.gitspace.sh`,
      }),
      fetch: ((input, init) => SELF.fetch(new Request(input, init))) as typeof fetch,
    });
    const [settings, runtime, machine] = await Promise.all([
      client.settings.get({}), client.settings.runtime.get({}), client.terminals.list({ spaceId: 'missing', machineId: 'offline' }),
    ]);
    expect(settings).toMatchObject({ status: 'ok', value: { profile: { handle: fixture.handle } } });
    expect(runtime).toMatchObject({ status: 'ok', value: { document: { content }, schema: expect.arrayContaining([expect.objectContaining({ path: 'toolExecution', valueJson: '"sequential"' })]), sync: { status: 'synced' } } });
    const updated = await client.settings.runtime.set({ expectedGeneration: 1, path: 'toolExecution', valueJson: '"parallel"' });
    expect(updated).toMatchObject({ status: 'ok', value: { document: { generation: 2, content: '{"toolExecution":"parallel"}' } } });
    expect(await client.settings.runtime.set({ expectedGeneration: 1, path: 'toolExecution', valueJson: '"sequential"' })).toMatchObject({ status: 'error' });
    expect(machine.status).toBe('error');
  });

  it('does not turn a project-scoped API key into account access', async () => {
    const fixture = await account(['rpc.read'], 'client', { kind: 'project', projectId: 'project-a' });
    expect((await SELF.fetch(fixture.request(single('settings.get')))).status).toBe(403);
  });

  it('requires deployment control for cloud images and rejects a foreign account or machine before provider work', async () => {
    const reader = await account(['rpc.read', 'fleet.control']);
    const input = { machineId: 'sandbox-foreign', operationId: crypto.randomUUID(), selection: { kind: 'custom', image: `ghcr.io/tenant/custom@sha256:${'a'.repeat(64)}` } };
    expect((await SELF.fetch(reader.request(single('machine.image.set', input)))).status).toBe(403);
    const custom = { image: input.selection };
    expect((await SELF.fetch(reader.request(single('machine.createSandbox', custom)))).status).toBe(403);
    expect((await SELF.fetch(reader.request(single('machine.createSandbox', { image: { kind: 'platform-default' } })))).status).toBe(403);
    expect((await SELF.fetch(reader.request({ v: 1, batch: [
      { id: 'machines', path: 'machines', input: {} }, { id: 'create', path: 'machine.createSandbox', input: custom },
    ] }))).status).toBe(403);
    const owner = await account(['rpc.read', 'deployment.control']);
    expect((await SELF.fetch(owner.request(single('machine.createSandbox', custom)))).status).toBe(403);
    const foreign = owner.request(single('machine.image.set', input));
    foreign.headers.set('x-gitspace-user', `u-${'f'.repeat(32)}`);
    expect((await SELF.fetch(foreign)).status).toBe(403);
    const missing = await SELF.fetch(owner.request(single('machine.image.set', input)));
    expect(parse(await missing.text())).toMatchObject({ status: 'error' });
    expect(await env.FLEET_CATALOG.getByName(owner.userId).listCloudImages()).toEqual([]);
  });

  it('admits explicit sandbox images only with both grants and keeps omitted images fleet-only', async () => {
    const reader = await account(['fleet.control']);
    const owner = await account(['fleet.control', 'deployment.control']);
    const custom = { image: { kind: 'custom', image: `ghcr.io/tenant/custom@sha256:${'a'.repeat(64)}` } } as const;
    // No storage has been provisioned: authorized requests reach the real creation
    // prerequisite and fail without creating a machine or contacting the provider.
    for (const [fixture, input] of [
      [reader, {}],
      [owner, custom],
      [owner, { image: { kind: 'platform-default' } }],
    ] as const) {
      const result = await inspectorClient(fixture).machine.createSandbox(input);
      expect(result.status === 'error' && rpcErrors.operationFailed.is(result.error)).toBe(true);
    }
    const scoped = await account(['fleet.control', 'deployment.control'], 'client', { kind: 'project', projectId: 'project-a' });
    expect((await SELF.fetch(scoped.request(single('machine.createSandbox', custom)))).status).toBe(403);
    expect((await SELF.fetch(scoped.request(single('machine.createSandbox')))).status).toBe(403);
    const foreign = owner.request(single('machine.createSandbox', custom));
    foreign.headers.set('x-gitspace-user', `u-${'f'.repeat(32)}`);
    expect((await SELF.fetch(foreign)).status).toBe(403);
    expect(await env.FLEET_CATALOG.getByName(owner.userId).listMachines()).toEqual([]);
  });

  it('stores provider keys in the canonical vault but never discloses them in RPC views', async () => {
    const fixture = await account();
    const key = 'sk-account-rpc-secret-key';
    const saved = await SELF.fetch(fixture.request(single('providers.apiKey.set', { profileId: 'default', providerId: 'openai', key })));
    const savedBody = await saved.text();
    expect(saved.status, savedBody).toBe(200);
    expect(savedBody).not.toContain(key);
    expect(parse(savedBody)).toMatchObject({ status: 'ok', value: { provider: { id: 'openai', hasAuth: true } } });
    const accounts = await fixture.vault.cloudCredentialAccounts('default');
    expect((await fixture.vault.cloudResolveCredential({ profileId: 'default', credentialId: accounts[0]!.id })).credential).toEqual({ type: 'api_key', key });
    const logout = await SELF.fetch(fixture.request(single('providers.logout', { profileId: 'default', providerId: 'openai', credentialId: accounts[0]!.id })));
    expect(parse(await logout.text())).toMatchObject({ status: 'ok', value: { provider: { hasAuth: false, accounts: [{ id: accounts[0]!.id, disabled: true }] } } });
    expect(await fixture.vault.cloudCredentialAccounts('default')).toEqual([]);
  });

  it('keeps Codex organization accounts independently selectable and revocable', async () => {
    const fixture = await account();
    for (const orgId of ['personal', 'team']) {
      await fixture.vault.putCredential({
        id: orgId,
        credential: { provider: 'openai-codex', email: 'same@example.com', orgId, refresh: `refresh-${orgId}`, access: `access-${orgId}`, expires: Date.now() + 60_000 },
      });
    }
    const response = await SELF.fetch(fixture.request(single('providers.list', { profileId: 'default' })));
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = parse(body) as { status: 'ok'; value: { providers: ProviderView[] } };
    const codex = result.value.providers.find((provider) => provider.id === 'openai-codex')!;
    expect(codex.credentialProvider).toBe('openai-codex');
    expect(new Set(codex.accounts.map((account) => account.id)).size).toBe(2);
    expect(body).not.toContain('refresh-personal');
    expect(body).not.toContain('access-personal');
    const first = codex.accounts[0]!, second = codex.accounts[1]!;
    const logout = await SELF.fetch(fixture.request(single('providers.logout', { profileId: 'default', providerId: 'openai-codex', credentialId: first.id })));
    expect(parse(await logout.text())).toMatchObject({ status: 'ok', value: { provider: { hasAuth: true, accounts: [{ id: first.id, disabled: true }, { id: second.id, disabled: false }] } } });
    expect((await fixture.vault.cloudCredentialAccounts('default', 'openai-codex')).map(account => account.id)).toEqual([second.id]);
    const removal = await SELF.fetch(fixture.request(single('providers.logout', { profileId: 'default', providerId: 'openai-codex', credentialId: first.id })));
    expect(parse(await removal.text())).toMatchObject({ status: 'ok', value: { provider: { hasAuth: true, accounts: [{ id: second.id, disabled: false }] } } });
  });

  it('manages inference profiles with typed conflicts and refuses account API clients provider/profile writes', async () => {
    const fixture = await account();
    const client = inspectorClient(fixture);
    const created = await client.inference.create({ name: 'Client', sourceProfileId: null });
    if (created.status !== 'ok') throw new Error('Expected a new profile');
    const profile = created.value.profiles.find(candidate => candidate.id !== 'default')!;
    expect(await client.inference.update({ profileId: profile.id, expectedRevision: 0, name: 'Renamed', settings: { modelRoles: { default: 'openai/gpt-4.1' } } })).toMatchObject({ status: 'ok' });
    const stale = await client.inference.update({ profileId: profile.id, expectedRevision: 0, name: 'Lost update', settings: {} });
    expect(stale.status === 'error' && rpcErrors.settingsConflict.is(stale.error)).toBe(true);
    expect(await client.inference.assign({ projectId: 'foreign-project', profileId: profile.id, expectedRevision: 0 })).toMatchObject({ status: 'error' });
    const api = await account(['rpc.read', 'rpc.write'], 'client');
    for (const [path, input] of [
      ['inference.create', { name: 'Unauthorized', sourceProfileId: null }],
      ['inference.update', { profileId: profile.id, expectedRevision: 1, name: 'Unauthorized', settings: {} }],
      ['inference.delete', { profileId: profile.id, expectedRevision: 1 }],
      ['providers.apiKey.set', { profileId: profile.id, providerId: 'openai', key: 'not-stored' }],
      ['providers.logout', { profileId: profile.id, providerId: 'openai', credentialId: null }],
    ] as const) {
      expect(parse(await (await SELF.fetch(api.request(single(path, input)))).text())).toMatchObject({ status: 'error' });
    }
    expect((await fixture.vault.ensureInference()).profiles.map(candidate => candidate.name)).toEqual(['Default', 'Renamed']);
    expect(await fixture.vault.cloudCredentialAccounts(profile.id)).toEqual([]);
  });

  it('keeps profile provider views scoped and rejects missing profile identity before mutation', async () => {
    const fixture = await account();
    const state = await fixture.vault.createInferenceProfile({ name: 'Empty', sourceProfileId: null });
    const profileId = state.profiles.find(profile => profile.id !== 'default')!.id;
    await fixture.vault.putBrowserApiKey('default', 'openai', 'default-private-key');
    const response = await SELF.fetch(fixture.request(single('providers.list', { profileId })));
    const text = await response.text();
    const result = parse(text) as { status: 'ok'; value: { providers: ProviderView[] } };
    expect(result.value.providers.find(provider => provider.id === 'openai')).toMatchObject({ hasAuth: false, authKind: 'none', supportsOAuth: true, supportsApiKey: true, accounts: [] });
    expect(result.value.providers.find(provider => provider.id === 'anthropic')).toMatchObject({ hasAuth: false, authKind: 'none', supportsOAuth: true, supportsApiKey: true, accounts: [] });
    expect(result.value.providers.find(provider => provider.id === 'openai-codex')).toMatchObject({ name: 'OpenAI Codex (ChatGPT)', hasAuth: false, authKind: 'none', supportsOAuth: true, supportsApiKey: false, accounts: [] });
    expect(text).not.toContain('default-private-key');
    const missing = await SELF.fetch(fixture.request(single('providers.apiKey.set', { providerId: 'openai', key: 'unscoped-key' })));
    expect(parse(await missing.text())).toMatchObject({ status: 'error' });
    const storedAccount = (await fixture.vault.cloudCredentialAccounts('default'))[0]!;
    expect((await fixture.vault.cloudResolveCredential({ profileId: 'default', credentialId: storedAccount.id })).credential).toEqual({ type: 'api_key', key: 'default-private-key' });
  });

  it('bypasses recent account usage observations only for an explicit refresh', async () => {
    const fixture = await account();
    await fixture.vault.putBrowserApiKey('default', 'openai', 'offline-fixture-key');
    const [credential] = await fixture.vault.cloudCredentialAccounts('default', 'openai');
    if (!credential) throw new Error('Expected fixture credential');
    await runInDurableObject(fixture.vault, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO cloud_account_health(profile_id, credential_id, cooldown_until, observed_at, report_json, error) VALUES (?, ?, 0, ?, NULL, ?)',
        'default', credential.id, Date.now(), 'Cached usage observation',
      );
    });
    const client = inspectorClient(fixture);
    expect(await client.providers.usage({ profileId: 'default', providerId: 'openai', refresh: false })).toMatchObject({
      status: 'ok', value: { errors: [{ provider: 'openai', message: 'Cached usage observation' }] },
    });
    // API-key usage is unsupported locally, so refresh can be proven without any provider request.
    const refreshed = await client.providers.usage({ profileId: 'default', providerId: 'openai', refresh: true });
    expect(refreshed).toMatchObject({ status: 'ok', value: { reports: [], errors: [{ provider: 'openai', message: 'Usage reporting is unavailable; inference remains enabled' }] } });
    if (refreshed.status !== 'ok') throw new Error('Expected refreshed usage');
    expect(await client.providers.usage({ profileId: 'default', providerId: 'openai', refresh: false })).toMatchObject({
      status: 'ok', value: { errors: refreshed.value.errors },
    });
  });

  it('streams committed profile invalidations without broker credentials and replays after reconnect', async () => {
    const fixture = await account();
    const client = inspectorClient(fixture);
    const controller = new AbortController();
    const stream = client.inference.events({ after: null }, { signal: controller.signal })[Symbol.asyncIterator]();
    let cursor: number;
    try {
      const initial = await stream.next();
      if (initial.done || initial.value.status !== 'ok') throw new Error('Expected inference snapshot');
      cursor = initial.value.value.cursor;
      await fixture.vault.putBrowserApiKey('default', 'openai', 'never-in-events');
      const pending = stream.next();
      await fixture.vault.createInferenceProfile({ name: 'Streamed', sourceProfileId: null });
      const changed = await pending;
      expect(changed).toMatchObject({ done: false, value: { status: 'ok', value: { type: 'change', previous: cursor, value: { profiles: [{ id: 'default' }, { name: 'Streamed' }] } } } });
      expect(JSON.stringify(changed)).not.toContain('never-in-events');
      expect(JSON.stringify(changed)).not.toContain('broker');
    } finally { controller.abort(); await stream.return?.(); }
    const replayController = new AbortController();
    const replay = client.inference.events({ after: cursor }, { signal: replayController.signal })[Symbol.asyncIterator]();
    try {
      expect(await replay.next()).toMatchObject({ done: false, value: { status: 'ok', value: { type: 'change', previous: cursor } } });
    } finally { replayController.abort(); await replay.return?.(); }
  });

  it('authorizes every batch item before any mutation and rejects replay, tampering and revocation', async () => {
    const fixture = await account(['rpc.read']);
    const before = await env.USER_SETTINGS.getByName(fixture.userId).get('check');
    const denied = await SELF.fetch(fixture.request({ v: 1, batch: [
      { ...single('settings.get'), id: 'read' },
      { ...single('settings.update', { expectedRevision: before.revision, onboardingComplete: true, profile: before.profile, git: before.git, defaults: before.defaults, machines: before.machines }), id: 'write' },
    ] }));
    expect(denied.status).toBe(403);
    expect((await env.USER_SETTINGS.getByName(fixture.userId).get('check')).onboardingComplete).toBe(false);

    const signed = fixture.request(single('settings.get'));
    const replay = new Request(signed.url, { method: signed.method, headers: signed.headers, body: signed.clone().body });
    expect((await SELF.fetch(signed)).status).toBe(200);
    expect((await SELF.fetch(replay)).status).toBe(409);
    const original = fixture.request(single('settings.get'));
    const tampered = new Request(original.url, { method: 'POST', headers: original.headers, body: stringify(single('devices.list')) });
    expect((await SELF.fetch(tampered)).status).toBe(401);
    await fixture.vault.revokeDeviceGrant(fixture.deviceId);
    expect((await SELF.fetch(fixture.request(single('settings.get')))).status).toBe(401);
  });

  it('authorizes a procedure-tagged target and refuses one retagged after signing', async () => {
    const fixture = await account(['rpc.read']);
    const urls: string[] = [];
    const client = inspectorClient(fixture, (request) => { urls.push(request.url); return SELF.fetch(request); });
    expect(await client.settings.get({})).toMatchObject({ status: 'ok' });
    expect(urls).toEqual([`https://${fixture.handle}.gitspace.sh/rpc?p=settings.get`]);
    const retagged = inspectorClient(fixture, (request) => SELF.fetch(new Request(request.url.replace('p=settings.get', 'p=devices.list'), request)));
    expect(await retagged.settings.get({})).toMatchObject({ status: 'error', error: { _tag: 'client/http-failure', data: { status: 401 } } });
  });
});

describe('account routing of machine work', () => {
  const machine = (id: string) => ({ id, label: id, kind: 'physical' as const, provider: 'physical' as const, state: 'online' as const, desiredState: 'online' as const,
    rpcEndpoint: `https://${id}.test/rpc`, notes: '', lifecycleRevision: 1, operationId: null, error: null });

  /** Machine A is the first online machine. The project's worktree and its
   * session are open on machine B; the base space on machine C. */
  async function fleet(cloudRuntime = false) {
    const fixture = await account(['rpc.read', 'rpc.write']);
    const held = await inspectorWorkspace(fixture.userId);
    const { sessionId } = await publishInspectorSession(fixture, held, []);
    const catalog = env.FLEET_CATALOG.getByName(fixture.userId);
    const machines = ['machine-a', 'machine-b', 'machine-c'];
    for (const id of machines) await catalog.putMachine(machine(id));
    // A real cloud runtime predates any stale placement. Do not migrate a legacy fixture implicitly.
    if (cloudRuntime) await held.placement.runtimeAttachments({ projectId: held.projectId, workspaceId: held.spaceId });
    await held.placement.bootstrap({ projectId: held.projectId, spaceId: held.spaceId, machineId: 'machine-b' });
    await env.SPACE_AUTHORITY.getByName(`${fixture.userId}:${held.projectId}`).bootstrap({ projectId: held.projectId, spaceId: held.projectId, machineId: 'machine-c' });
    const reached: Array<{ machine: string; signedTarget: string | null }> = [];
    network.use(...machines.map((id) => http.post(`https://${id}.test/rpc`, ({ request }) => {
      reached.push({ machine: id, signedTarget: request.headers.get('x-gitspace-signed-target') });
      return HttpResponse.json({ machine: id });
    })));
    return { fixture, catalog, held, sessionId, reached };
  }

  it('serves cloud space state without following an online legacy holder', async () => {
    const { fixture, held, reached } = await fleet();
    const view = await inspectorClient(fixture).space.view({ projectId: held.projectId, workspaceId: held.spaceId });
    expect(view).toMatchObject({ status: 'ok', value: { project: { id: held.projectId } } });
    expect(reached).toEqual([]);
  });

  it('keeps cloud runtime work on the account even while a machine holds the space', async () => {
    const { fixture, held, reached } = await fleet();
    for (const path of ['runtime.draft', 'runtime.attachment.detach']) {
      await SELF.fetch(fixture.request(single(path, { projectId: held.projectId, workspaceId: held.spaceId })));
    }
    expect(reached).toEqual([]);
  });

  /** HEAD and index hold README.md and src/app.ts; the worktree edits src/app.ts and adds untracked notes.txt. */
  function committedCheckout(spaceId: string) {
    const id = (digit: string) => digit.repeat(40);
    const checkpoint = { checkpointRef: `refs/gitspace/spaces/${spaceId}/checkpoints`, headCommit: id('1'), branch: 'review', indexCommit: id('2'), trackedWorktreeCommit: id('3'), worktreeCommit: id('4'), indexTree: id('5'), worktreeTree: id('6') };
    const committed = { 'README.md': id('a'), 'src/app.ts': id('b') };
    const trees: Record<string, Record<string, string>> = { [id('7')]: committed, [id('5')]: committed, [id('6')]: { 'README.md': id('a'), 'src/app.ts': id('c'), 'notes.txt': id('d') } };
    const blobs: Record<string, string> = { [id('a')]: '# Review\n', [id('b')]: "export const source = 'head';\n", [id('c')]: "export const source = 'cloud checkpoint';\n", [id('d')]: 'scratch\n' };
    vi.spyOn(ArtifactsCodeStore.prototype, 'readCommit').mockImplementation(async (_repository, hash) => hash === checkpoint.headCommit
      ? { hash, treeHash: id('7'), message: 'head', author: { name: 'a', email: 'a@test' }, committer: { name: 'a', email: 'a@test' }, parents: [], authoredAt: 0, committedAt: 0 }
      : null);
    vi.spyOn(ArtifactsCodeStore.prototype, 'listSnapshotInventories').mockImplementation(async (_repository, requested) => requested.map(tree =>
      new Map(Object.entries(trees[tree] ?? {}).map(([path, oid]) => [path, { oid, mode: '100644', type: 'blob' as const }]))));
    vi.spyOn(ArtifactsCodeStore.prototype, 'readBlob').mockImplementation(async (_repository, oid) => blobs[oid] === undefined ? null : new Blob([blobs[oid]]));
    return { checkpoint, worktreeContent: blobs[id('c')] };
  }

  it('reads a cloud workspace repository from its committed checkpoint, never from a legacy holder', async () => {
    const { fixture, held, reached } = await fleet();
    const { checkpoint, worktreeContent } = committedCheckout(held.spaceId);
    await runInDurableObject(held.placement, (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_code_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1), checkpoint TEXT NOT NULL)');
      state.storage.sql.exec('INSERT INTO runtime_code_snapshot(singleton,checkpoint) VALUES(1,?)', JSON.stringify(checkpoint));
    });
    const client = inspectorClient(fixture);
    const read = { spaceId: held.spaceId, expectedGeneration: 1, mode: 'current' as const };
    const tree: Array<{ path: string; kind: string; status: string }> = [];
    for await (const chunk of client.inspector.repository.tree({ ...read, path: null })) {
      if (chunk.status === 'error') throw chunk.error;
      for (const entry of chunk.value) tree.push({ path: entry.path, kind: entry.kind, status: entry.status });
    }
    expect(tree).toEqual([
      { path: 'notes.txt', kind: 'file', status: 'untracked' },
      { path: 'README.md', kind: 'file', status: 'clean' },
      { path: 'src', kind: 'directory', status: 'modified' },
      { path: 'src/app.ts', kind: 'file', status: 'modified' },
    ]);
    expect(await client.inspector.repository.status({ ...read, path: null })).toEqual({ status: 'ok', value: [
      { spaceId: held.spaceId, generation: 1, mode: 'current', path: 'notes.txt', status: 'untracked', oldPath: null, staged: false, working: true },
      { spaceId: held.spaceId, generation: 1, mode: 'current', path: 'src/app.ts', status: 'modified', oldPath: null, staged: false, working: true },
    ] });
    // A cloud-specific refusal, not the legacy "open the workspace" runtime stub.
    expect(await client.inspector.repository.diff({ ...read, mode: 'working', path: null, baseRef: null })).toMatchObject({ status: 'error', error: { _tag: 'gitspace/inspector-state', data: { resource: 'repository' } } });
    expect(await client.inspector.repository.file({ ...read, path: 'src/app.ts' })).toMatchObject({ status: 'ok', value: {
      path: 'src/app.ts', content: worktreeContent, encoding: 'utf-8', binary: false, blobId: 'c'.repeat(40), commitId: checkpoint.headCommit, headCommit: checkpoint.headCommit, status: 'modified',
    } });
    expect(await client.inspector.repository.file({ ...read, mode: 'staged', path: 'src/app.ts' })).toMatchObject({ status: 'ok', value: { content: "export const source = 'head';\n", status: 'clean' } });
    expect(reached).toEqual([]);
  });

  it('refuses legacy holder terminal access without a ready cache attachment', async () => {
    const { fixture, held, reached } = await fleet();
    const response = await SELF.fetch(fixture.request(single('terminals.list', { spaceId: held.spaceId, machineId: 'machine-b' })));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TERMINAL_MACHINE_NOT_ATTACHED' } });
    expect(reached).toEqual([]);
  });

  it('forwards terminal work only to the chosen machine while it is a ready cache of the cloud workspace', async () => {
    const { fixture, held, reached } = await fleet(true);
    const ready = RuntimeAttachmentSchema.parse({
      projectId: held.projectId, workspaceId: held.spaceId, attachmentId: 'cache-c', machineId: 'machine-c', generation: 1, role: 'cache', state: 'ready',
      checkout: { kind: 'shared', branch: 'review' }, capabilities: [], updatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
    });
    const stale = { ...ready, attachmentId: 'cache-a', machineId: 'machine-a', heartbeatAt: new Date(Date.now() - 60_000).toISOString() };
    await runInDurableObject(held.placement, (_instance, state) => {
      for (const attachment of [ready, stale]) {
        state.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', attachment.attachmentId, JSON.stringify(attachment), 'fixture');
      }
    });
    const created = await SELF.fetch(fixture.request(single('terminals.create', { spaceId: held.spaceId, machineId: 'machine-c' })));
    expect(await created.json()).toEqual({ machine: 'machine-c' });
    // The legacy placement holder and a cache whose heartbeat went stale are both refused before dispatch.
    for (const machineId of ['machine-b', 'machine-a']) {
      const refused = await SELF.fetch(fixture.request(single('terminals.send', { spaceId: held.spaceId, machineId, name: 'shell', data: 'ls\r' })));
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: 'TERMINAL_MACHINE_NOT_ATTACHED' } });
    }
    const unnamed = await SELF.fetch(fixture.request(single('terminals.list', { spaceId: held.spaceId })));
    expect(await unnamed.json()).toMatchObject({ error: { code: 'TERMINAL_MACHINE_REQUIRED' } });
    expect(reached.map((entry) => entry.machine)).toEqual(['machine-c']);
  });

  it('accepts environment runs in the cloud and dispatches them only to the named ready cache of the workspace', async () => {
    const { fixture, held, reached } = await fleet(true);
    const client = inspectorClient(fixture);
    const notAttached = (machineId: string) => ({ status: 'error', error: { data: { code: 'RunnerUnavailable', context: { spaceId: held.spaceId, machineId } } } });
    // Online machines exist, but none is attached: a typed refusal, never a forward to whichever machine is online.
    expect(await client.environment.runChecks({ spaceId: held.spaceId, machineId: 'machine-a', runId: 'checks-unattached' })).toMatchObject(notAttached('machine-a'));
    const ready = RuntimeAttachmentSchema.parse({
      projectId: held.projectId, workspaceId: held.spaceId, attachmentId: 'cache-c', machineId: 'machine-c', generation: 1, role: 'cache', state: 'ready',
      checkout: { kind: 'shared', branch: 'review' }, capabilities: [], updatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
    });
    const stale = { ...ready, attachmentId: 'cache-a', machineId: 'machine-a', heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() };
    const dispatched: RuntimeToolDispatch[] = [];
    await runInDurableObject(held.placement, async (instance, state) => {
      for (const attachment of [ready, stale]) {
        state.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', attachment.attachmentId, JSON.stringify(attachment), 'fixture');
      }
      const runtime = await instance['runtime'];
      if (!runtime) throw new Error('Workspace runtime did not open');
      vi.spyOn(runtime.cloudFiles, 'initializeSnapshot').mockResolvedValue(committedCheckout(held.spaceId).checkpoint);
      // The cache accepts the run it was sent, as the machine's lifecycle tool does.
      vi.spyOn(runtime.attachments, 'execute').mockImplementation(async (dispatch) => {
        dispatched.push(dispatch);
        const request = RuntimeLifecycleDispatchArgumentsSchema.parse(dispatch.args);
        const run: LifecycleRun = {
          id: request.runId, projectId: held.projectId, spaceId: held.spaceId, phase: request.phase, status: 'accepted', profile: 'base', machineId: dispatch.machineId, generation: dispatch.generation,
          executionHashes: [], terminalName: null, results: [], output: '', exitCode: null, startedAt: new Date().toISOString(), finishedAt: null,
          deadlineAt: new Date(Date.now() + 60_000).toISOString(), cancelRequestedAt: null, failure: null, incidents: [],
        };
        return { status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: JSON.stringify(run) }] };
      });
    });
    expect(await client.environment.runChecks({ spaceId: held.spaceId, machineId: 'machine-c', runId: 'checks-c' })).toMatchObject({ status: 'ok', value: { id: 'checks-c', phase: 'checks', machineId: 'machine-c' } });
    expect(await client.environment.runPhase({ spaceId: held.spaceId, machineId: 'machine-c', runId: 'destroy-c', phase: 'cloud/destroy', rerun: null })).toMatchObject({ status: 'ok', value: { id: 'destroy-c', phase: 'cloud/destroy', machineId: 'machine-c' } });
    // Destroying cloud resources needs lifecycle authority, which an API client must be granted explicitly.
    const apiClient = inspectorClient(await account(['rpc.read', 'rpc.write'], 'client'));
    expect(await apiClient.environment.runPhase({ spaceId: held.spaceId, machineId: 'machine-c', runId: 'destroy-client', phase: 'cloud/destroy', rerun: null })).toMatchObject({ status: 'error', error: { data: { code: 'PermissionDenied' } } });
    // A cache whose heartbeat went stale and the legacy placement holder are refused before dispatch.
    for (const machineId of ['machine-a', 'machine-b']) {
      expect(await client.environment.runPhase({ spaceId: held.spaceId, machineId, runId: `prepare-${machineId}`, phase: 'machine/prepare', rerun: null })).toMatchObject(notAttached(machineId));
    }
    expect(dispatched.map((dispatch) => ({ machineId: dispatch.machineId, attachmentId: dispatch.attachmentId, tool: dispatch.tool, args: dispatch.args }))).toEqual([
      { machineId: 'machine-c', attachmentId: 'cache-c', tool: 'lifecycle', args: { runId: 'checks-c', phase: 'checks', on: 'machine-c' } },
      { machineId: 'machine-c', attachmentId: 'cache-c', tool: 'lifecycle', args: { runId: 'destroy-c', phase: 'cloud/destroy', rerun: false, on: 'machine-c' } },
    ]);
    expect(reached).toEqual([]);
  });

  it('launches a release only on the named online enrolled machine, never the holder or any online machine', async () => {
    const { fixture, catalog, held, reached } = await fleet();
    await catalog.putMachine({ ...machine('machine-d'), state: 'offline' });
    const launch = (input: Record<string, unknown>) => SELF.fetch(fixture.request(single('deployment.launch', { workspaceId: held.spaceId, targets: ['worker'], ...input })));
    expect(await (await launch({ machineId: 'machine-c' })).json()).toEqual({ machine: 'machine-c' });
    const refusals: Array<[Record<string, unknown>, number, string]> = [[{}, 400, 'LAUNCH_MACHINE_REQUIRED'], [{ machineId: 'machine-d' }, 503, 'LAUNCH_MACHINE_OFFLINE'], [{ machineId: 'machine-z' }, 409, 'LAUNCH_MACHINE_NOT_ENROLLED']];
    for (const [input, status, code] of refusals) {
      const refused = await launch(input);
      expect(refused.status).toBe(status);
      expect(await refused.json()).toMatchObject({ error: { code } });
    }
    expect(reached.map((entry) => entry.machine)).toEqual(['machine-c']);
  });

  it('rejects mixed cloud and explicit machine work before either authority acts', async () => {
    const { fixture, held, reached } = await fleet();
    const response = await SELF.fetch(fixture.request({ v: 1, batch: [
      { ...single('settings.get', {}), id: 'cloud' },
      { ...single('deployment.launch', { workspaceId: held.spaceId, machineId: 'machine-c', targets: ['worker'] }), id: 'machine' },
    ] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'RPC_MIXED_AUTHORITY_BATCH' } });
    expect(reached).toEqual([]);
  });

  it('rejects removed and unknown public procedures instead of selecting an online machine', async () => {
    const { fixture, held, reached } = await fleet();
    for (const path of ['project.open', 'space.close', 'space.reopen', 'session.control', 'placements', 'events', 'browserRelay.status', 'runtime.unknown', 'inspector.unknown', 'terminals.unknown']) {
      const response = await SELF.fetch(fixture.request(single(path, { projectId: held.projectId, spaceId: held.spaceId, machineId: 'machine-b' })));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'RPC_PROCEDURE_UNKNOWN' } });
    }
    expect(reached).toEqual([]);
  });
});

describe('cloud projects and workspace relations with no machines', () => {
  it('creates an empty project in the cloud and reads its workspaces without any machine', async () => {
    const fixture = await account(['rpc.read', 'rpc.write']);
    const client = inspectorClient(fixture);
    const created = await client.project.create({ name: 'Pantry tracker', baseBranch: null, repositoryUrl: null });
    if (created.status === 'error') throw created.error;
    expect(created.value).toMatchObject({
      project: { name: 'Pantry tracker', lifecycle: 'active', repositoryReference: null, baseBranch: 'main' },
      operation: { kind: 'project.create', state: 'succeeded', targetMachines: [] },
    });
    const projectId = created.value.project.id;
    expect(projectId).toMatch(/^pantry-tracker-[0-9a-f]{8}$/u);
    expect((await env.USER_PROJECTS.getByName(fixture.userId).list()).map((project) => project.id)).toContain(projectId);
    expect(await client.space.view({ projectId, workspaceId: null })).toMatchObject({ status: 'ok', value: {
      project: { id: projectId, baseBranch: 'main', connected: true },
      baseSpace: { id: projectId, kind: 'base', branch: 'main', possessedBy: null, closedAt: null, status: { primaryColor: 'dim' } },
      workspaces: [], mainAgent: null,
    } });
  });

  it('saves workspace relations in the cloud and derives the stack they block', async () => {
    const fixture = await account(['rpc.read', 'rpc.write']);
    const { projectId, spaceId: parentId, authority } = await inspectorWorkspace(fixture.userId);
    const childId = `space-${crypto.randomUUID()}`;
    await authority.putWorkspace({ id: childId, projectId, kind: 'worktree', name: 'Child', branch: 'child', phase: 'plan', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await env.USER_PROJECTS.getByName(fixture.userId).putWorkspaceLocation(childId, projectId);
    const client = inspectorClient(fixture);
    expect(await client.workspace.setRelations({ workspaceId: childId, dependsOn: [], relatedTo: [], stackedOn: parentId })).toMatchObject({ status: 'ok', value: {
      id: childId, phase: 'plan', relations: { dependsOn: [parentId], relatedTo: [], stackedOn: parentId }, stack: { blockedBy: [parentId], blocking: [] },
    } });
    const view = await client.space.view({ projectId, workspaceId: parentId });
    if (view.status === 'error') throw view.error;
    expect(view.value.workspaces.find((workspace) => workspace.id === parentId)?.stack.blocking).toEqual([childId]);
    expect(await client.workspace.setRelations({ workspaceId: parentId, dependsOn: [childId], relatedTo: [], stackedOn: null })).toMatchObject({ status: 'error', error: { data: { code: 'WORKSPACE_DEPENDENCY_CYCLE' } } });
    expect(await client.workspace.setRelations({ workspaceId: childId, dependsOn: ['missing'], relatedTo: [], stackedOn: null })).toMatchObject({ status: 'error', error: { data: { code: 'WORKSPACE_NOT_FOUND' } } });
    expect(await client.space.view({ projectId, workspaceId: 'missing' })).toMatchObject({ status: 'error', error: { data: { workspaceId: 'missing' } } });
  });

  it('imports a public repository at its advertised default branch and asks for the branch it cannot read', async () => {
    const fixture = await account(['rpc.read', 'rpc.write']);
    const client = inspectorClient(fixture);
    network.use(
      http.get('https://github.com/example/public.git/info/refs', () => new HttpResponse(`001e# service=git-upload-pack\n0000${'a'.repeat(40)} HEAD\0multi_ack symref=HEAD:refs/heads/trunk agent=git/github\n0000`)),
      http.get('https://github.com/example/private.git/info/refs', () => new HttpResponse(null, { status: 401 })),
    );
    expect(await client.project.create({ name: 'Public', baseBranch: null, repositoryUrl: 'example/public' })).toMatchObject({ status: 'ok', value: {
      project: { repositoryReference: 'https://github.com/example/public.git', baseBranch: 'trunk', lifecycle: 'active' },
      operation: { kind: 'project.import', state: 'succeeded', targetMachines: [] },
    } });
    expect(await client.project.create({ name: 'Private', baseBranch: null, repositoryUrl: 'git@github.com:example/private.git' }))
      .toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('Enter its base branch') } } });
    expect(await client.project.create({ name: 'Private', baseBranch: 'release', repositoryUrl: 'git@github.com:example/private.git' })).toMatchObject({ status: 'ok', value: {
      project: { repositoryReference: 'git@github.com:example/private.git', baseBranch: 'release', lifecycle: 'active' },
    } });
  });

  it('reports what the account runs without any machine', async () => {
    const fixture = await account(['rpc.read', 'rpc.write']);
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: null } })));
    expect(await inspectorClient(fixture).deployment.status({})).toMatchObject({ status: 'ok', value: {
      desired: { worker: null, machine: null, frontend: null }, current: { machines: {} }, releases: [], launch: null,
    } });
  });
});

async function inspectorWorkspace(userId: string) {
  const projectId = `project-${crypto.randomUUID()}`;
  const spaceId = `space-${crypto.randomUUID()}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const project = await authority.bootstrap({ id: projectId, name: 'Saved inspection', repositoryReference: null, baseBranch: 'main', createdBy: 'human' });
  await env.USER_PROJECTS.getByName(userId).put(await authority.setProjectLifecycle(project.revision, 'active'));
  for (const [id, kind] of [[projectId, 'base'], [spaceId, 'worktree']] as const) {
    await authority.putWorkspace({ id, projectId, kind, name: kind === 'base' ? 'Project' : 'Review', branch: kind === 'base' ? 'main' : 'review', phase: kind === 'base' ? null : 'review', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await env.USER_PROJECTS.getByName(userId).putWorkspaceLocation(id, projectId);
  }
  await authority.putArtifactScope({ id: `artifacts-${spaceId}`, workspaceId: spaceId, expectedGeneration: 0, generation: 0, manifestHash: null });
  const placement = env.SPACE_AUTHORITY.getByName(`${userId}:${spaceId}`);
  return { projectId, spaceId, authority, placement };
}

interface InspectorAccount {
  userId: string;
  handle: string;
  deviceId: string;
  signingPrivateKey: Uint8Array;
}

function inspectorClient(fixture: InspectorAccount, fetchResponse: (request: Request) => Promise<Response> = (request) => SELF.fetch(request)) {
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return fetchResponse(new Request(input, init));
  }) as typeof fetch;
  return createBrowserClient({ contract: gitspaceContract, transport: createRoutedTransport({
    homeUrl: `https://${fixture.handle}.gitspace.sh/rpc`,
    fetch: createSignedRpcFetch({ deviceId: fixture.deviceId, userId: fixture.userId, signingPrivateKey: fixture.signingPrivateKey, fetch: fetcher }),
  }) });
}

async function collectInspectorTranscript(client: BrowserClientOf<typeof gitspaceContract>, projectId: string, workspaceId: string) {
  async function* chunks(): AsyncGenerator<TranscriptChunk> {
    for await (const result of client.inspector.transcript({ projectId, workspaceId })) {
      if (result.status === 'error') throw result.error;
      yield result.value;
    }
  }
  const events: TranscriptEvent[] = [];
  for await (const event of decodeTranscriptChunks(chunks())) events.push(event);
  return events;
}

async function publishInspectorSession(fixture: { userId: string }, space: { projectId: string; spaceId: string }, records: Record<string, unknown>[], expectedRevision = 0) {
  const sessionId = 'canonical';
  const ompSessionId = 'canonical-omp';
  const snapshot = new TextEncoder().encode([
    { type: 'session', version: 3, id: ompSessionId, timestamp: '2026-09-01T12:00:00.000Z', cwd: '/saved' },
    ...records,
  ].map((entry) => JSON.stringify(entry)).join('\n'));
  const snapshotHash = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', snapshot)), (byte) => byte.toString(16).padStart(2, '0')).join('')}` as const;
  const snapshotKey = `projects/${space.projectId}/sessions/${sessionId}/${snapshotHash.slice(7)}.jsonl`;
  await env.DATA.put(`users/${fixture.userId}/${snapshotKey}`, snapshot, { customMetadata: { sha256: snapshotHash } });
  await env.PROJECT_AUTHORITY.getByName(`${fixture.userId}:${space.projectId}`).putCanonicalSession({ id: sessionId, workspaceId: space.spaceId, ompSessionId, machineId: null, state: 'closed', sessionObjectKey: snapshotKey, sessionObjectHash: snapshotHash, sessionFormatVersion: 'omp-jsonl-1', activity: { active: false, reasons: [] }, health: { revision: 0, issues: {} }, expectedRevision });
  return { sessionId, ompSessionId, snapshot, snapshotKey, snapshotHash };
}

describe('bounded saved Inspector transcripts', () => {
  it('reads an encrypted chunked canonical session and rejects an incomplete checkpoint', async () => {
    const fixture = await account(['rpc.read']);
    const space = await inspectorWorkspace(fixture.userId);
    const published = await publishInspectorSession(fixture, space, [
      { type: 'message', id: 'answer', parentId: null, timestamp: '2026-09-01T12:00:00.000Z', message: { role: 'assistant', content: 'Full checkpoint survived' } },
    ]);
    const key = credentialProtocolBase64.decode(await env.CREDENTIALS.getByName(fixture.userId).artifactKey(fixture.userId));
    const snapshot = new Uint8Array(CHECKPOINT_CHUNK_BYTES + published.snapshot.byteLength + 1).fill(32);
    snapshot[CHECKPOINT_CHUNK_BYTES] = 10;
    snapshot.set(published.snapshot, CHECKPOINT_CHUNK_BYTES + 1);
    const objectKey = `projects/${space.projectId}/sessions/canonical/chunked.checkpoint`;
    const hash = async (bytes: Uint8Array): Promise<`sha256:${string}`> => `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const chunks: Array<{ hash: `sha256:${string}`; size: number }> = [];
    let lastChunk: Uint8Array = new Uint8Array();
    let lastKey = '';
    for (let offset = 0; offset < snapshot.byteLength; offset += CHECKPOINT_CHUNK_BYTES) {
      const plaintext = snapshot.subarray(offset, offset + CHECKPOINT_CHUNK_BYTES);
      const sealed = await encryptArtifactBytes(plaintext, key);
      const digest = await hash(sealed);
      lastKey = `users/${fixture.userId}/${objectKey}.chunks/${digest.slice(7)}`;
      await env.DATA.put(lastKey, sealed, { customMetadata: { sha256: digest } });
      chunks.push({ hash: digest, size: plaintext.byteLength });
      lastChunk = sealed;
    }
    const inventory = await encryptArtifactBytes(new TextEncoder().encode(JSON.stringify({ version: 1, size: snapshot.byteLength, chunks })), key);
    const envelope = new Uint8Array(inventory.byteLength + 1);
    envelope[0] = CHUNKED_CHECKPOINT_VERSION;
    envelope.set(inventory, 1);
    const objectHash = await hash(envelope);
    await env.DATA.put(`users/${fixture.userId}/${objectKey}`, envelope, { customMetadata: { sha256: objectHash } });
    await space.authority.putCanonicalSession({ id: published.sessionId, workspaceId: space.spaceId, ompSessionId: published.ompSessionId, machineId: null, state: 'closed', sessionObjectKey: objectKey, sessionObjectHash: objectHash, sessionFormatVersion: 'omp-checkpoint-1', activity: { active: false, reasons: [] }, health: { revision: 0, issues: {} }, expectedRevision: 1 });
    await env.DATA.delete(lastKey);
    const client = inspectorClient(fixture);
    const error = await collectInspectorTranscript(client, space.projectId, space.spaceId).then(() => null, (failure: unknown) => failure);
    expect(rpcErrors.operationFailed.is(error)).toBe(true);
    await env.DATA.put(lastKey, lastChunk, { customMetadata: { sha256: chunks.at(-1)!.hash } });
    expect(await collectInspectorTranscript(client, space.projectId, space.spaceId)).toMatchObject([
      { sessionId: published.sessionId, payload: { message: { content: 'Full checkpoint survived' } } },
    ]);
  });

  it('serves repeat pages without loading the saved source and resets after canonical publication changes', async () => {
    const fixture = await account(['rpc.read']);
    const space = await inspectorWorkspace(fixture.userId);
    const records = Array.from({ length: 90 }, (_, index) => ({
      type: 'message', id: `message-${index}`, parentId: index === 0 ? null : `message-${index - 1}`,
      timestamp: '2026-09-01T12:00:00.000Z', message: { role: index % 2 === 0 ? 'user' : 'assistant', content: `saved-${index}` },
    }));
    const published = await publishInspectorSession(fixture, space, records);
    const input = { projectId: space.projectId, workspaceId: space.spaceId, generation: null, before: null, after: null, around: null };
    const client = inspectorClient(fixture);
    const first = await client.inspector.transcriptPage(input);
    if (first.status !== 'ok') throw new Error('Expected saved transcript page');
    expect(first.value.total).toBe(90);
    expect(first.value.rows.at(-1)!.item).toMatchObject({ text: 'saved-89' });
    const warmEnv = { ...env, DATA: {
      head: (key: string) => env.DATA.head(key),
      get: (key: string, options?: R2GetOptions) => {
        if (key === `users/${fixture.userId}/${published.snapshotKey}`) throw new Error('Warm pages must not load source');
        return env.DATA.get(key, options);
      },
    } } as unknown as Env;
    const warmClient = inspectorClient(fixture, (request) => worker.fetch(request, warmEnv));
    const older = await warmClient.inspector.transcriptPage({ ...input, generation: first.value.generation, before: first.value.rows[0]!.ordinal });
    if (older.status !== 'ok') throw new Error('Expected indexed older page');
    expect(older.value.rows[0]!.item).toMatchObject({ text: 'saved-0' });
    const current = await space.authority.getCanonicalSession(published.sessionId);
    await publishInspectorSession(fixture, space, [{ ...records[0]!, message: { role: 'user', content: 'replacement saved source' } }], current!.revision);
    const reset = await client.inspector.transcriptPage({ ...input, generation: first.value.generation, before: 0 });
    if (reset.status !== 'ok') throw new Error('Expected replacement page');
    expect(reset.value.generation).not.toBe(first.value.generation);
    expect(reset.value.rows[0]!.item).toMatchObject({ text: 'replacement saved source' });
    const stale = await client.inspector.transcriptContent({ projectId: space.projectId, workspaceId: space.spaceId, generation: first.value.generation, rowId: first.value.rows[0]!.id, offset: 0 });
    expect(stale.status === 'error' && rpcErrors.operationFailed.is(stale.error)).toBe(true);
  });

  it('rechecks page authorization after cold indexing before disclosing rows', async () => {
    const fixture = await account(['rpc.read']);
    const space = await inspectorWorkspace(fixture.userId);
    const published = await publishInspectorSession(fixture, space, [{ type: 'message', id: 'root', parentId: null, timestamp: '2026-09-01T12:00:00.000Z', message: { role: 'user', content: 'Private saved content' } }]);
    const cloudEnv = { ...env, DATA: {
      head: (key: string) => env.DATA.head(key),
      put: (key: string, value: Uint8Array) => env.DATA.put(key, value),
      get: async (key: string, options?: R2GetOptions) => {
        const object = await env.DATA.get(key, options);
        if (key === `users/${fixture.userId}/${published.snapshotKey}`) await fixture.vault.revokeDeviceGrant(fixture.deviceId);
        return object;
      },
    } } as unknown as Env;
    const result = await inspectorClient(fixture, (request) => worker.fetch(request, cloudEnv)).inspector.transcriptPage({ projectId: space.projectId, workspaceId: space.spaceId, generation: null, before: null, after: null, around: null });
    expect(result.status === 'error' && rpcErrors.operationFailed.is(result.error)).toBe(true);
  });

  it('loads metadata without reading history and delivers every large event over signed HTTP with bounded frames', async () => {
    const fixture = await account(['rpc.read']);
    const space = await inspectorWorkspace(fixture.userId);
    const at = '2026-09-01T12:00:00.000Z';
    const messages = Array.from({ length: 48 }, (_, index) => ({ role: 'assistant', content: `message-${index}: ${'saved history '.repeat(2_200)}` }));
    messages.push({ role: 'assistant', content: '\u0000\\"'.repeat(180_000) });
    const records = messages.map((message, index) => ({ type: 'message', id: `message-${index}`, parentId: index === 0 ? null : `message-${index - 1}`, timestamp: at, message }));
    const published = await publishInspectorSession(fixture, space, records);
    const expected = messages.map((message, index) => ({ sessionId: published.sessionId, ordinal: index + 1, kind: 'message_end', payload: { message }, createdAt: new Date(at) }));
    expect(new TextEncoder().encode(stringify(expected.at(-1))).byteLength).toBeGreaterThan(1024 * 1024);
    const metadataEnv = { ...env, DATA: {
      head: (key: string) => env.DATA.head(key),
      get: (key: string) => {
        if (key === `users/${fixture.userId}/${published.snapshotKey}`) throw new Error('History body must not be read by metadata bootstrap');
        return env.DATA.get(key);
      },
    } } as unknown as Env;
    const bootstrap = await worker.fetch(fixture.request(single('inspector.view', { projectId: space.projectId, workspaceId: space.spaceId })), metadataEnv);
    const bootstrapWire = await bootstrap.text();
    const metadata = parse(bootstrapWire);
    expect(metadata).toMatchObject({ status: 'ok', value: { identity: { spaceId: space.spaceId }, savedTranscript: { status: 'available' } } });
    expect(metadata.value.savedTranscript).not.toHaveProperty('events');
    expect(new TextEncoder().encode(bootstrapWire).byteLength).toBeLessThan(64 * 1024);
    let transcriptWire: Promise<string> | undefined;
    const client = inspectorClient(fixture, async (request) => {
      const response = await SELF.fetch(request);
      transcriptWire = response.clone().text();
      return response;
    });
    expect(await collectInspectorTranscript(client, space.projectId, space.spaceId)).toEqual(expected);
    const lines = (await transcriptWire)!.trim().split('\n');
    for (const line of lines) expect(new TextEncoder().encode(line).byteLength).toBeLessThan(1024 * 1024);
    const frames = lines.map((line) => parse(line));
    expect(frames.at(-1)).toMatchObject({ done: true });
    expect(frames.some((frame) => !frame.done && frame.response.value.complete === false)).toBe(true);
    expect(await space.placement.get()).toBeNull();
    expect(await env.FLEET_CATALOG.getByName(fixture.userId).listMachines()).toEqual([]);
  });

  it('distinguishes empty cloud and legacy conversations from missing saved objects', async () => {
    const fixture = await account(['rpc.read']);
    const space = await inspectorWorkspace(fixture.userId);
    const client = inspectorClient(fixture);
    const input = { projectId: space.projectId, workspaceId: space.spaceId };
    expect(await client.inspector.view(input)).toMatchObject({ status: 'ok', value: { checkpoint: null, savedTranscript: { status: 'available' } } });
    expect(await collectInspectorTranscript(client, space.projectId, space.spaceId)).toEqual([]);
    const published = await publishInspectorSession(fixture, space, []);
    expect(await client.inspector.view(input)).toMatchObject({ status: 'ok', value: { savedTranscript: { status: 'available' } } });
    expect(await collectInspectorTranscript(client, space.projectId, space.spaceId)).toEqual([]);
    await env.DATA.delete(`users/${fixture.userId}/${published.snapshotKey}`);
    expect(await client.inspector.view(input)).toMatchObject({ status: 'ok', value: { savedTranscript: { status: 'unavailable' } } });
    const error = await collectInspectorTranscript(client, space.projectId, space.spaceId).then(() => null, (error: unknown) => error);
    expect(rpcErrors.operationFailed.is(error)).toBe(true);
  });

  it('rejects content-address tampering rather than presenting the replacement as history', async () => {
    const fixture = await account(['rpc.read']);
    const space = await inspectorWorkspace(fixture.userId);
    const published = await publishInspectorSession(fixture, space, [
      { type: 'message', id: 'root', parentId: null, timestamp: '2026-09-01T12:00:00.000Z', message: { role: 'user', content: 'Original content' } },
    ]);
    const replacement = new TextDecoder().decode(published.snapshot).replace('Original content', 'Tampered content');
    await env.DATA.put(`users/${fixture.userId}/${published.snapshotKey}`, replacement, { customMetadata: { sha256: published.snapshotHash } });
    const results = [];
    for await (const result of inspectorClient(fixture).inspector.transcript({ projectId: space.projectId, workspaceId: space.spaceId })) results.push(result);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('error');
    if (results[0]?.status !== 'error') throw new Error('Expected content verification failure');
    expect(rpcErrors.operationFailed.is(results[0].error)).toBe(true);
  });

  it('keeps Inspector metadata usable when a correctly hashed saved branch is corrupt', async () => {
    const fixture = await account(['rpc.read']);
    const space = await inspectorWorkspace(fixture.userId);
    await publishInspectorSession(fixture, space, [
      { type: 'message', id: 'root', parentId: null, timestamp: '2026-09-01T12:00:00.000Z', message: { role: 'user', content: 'Intact ancestor' } },
      { type: 'message', id: 'leaf', parentId: 'missing-parent', timestamp: '2026-09-01T12:00:00.000Z', message: { role: 'assistant', content: 'Invalid branch' } },
    ]);
    const client = inspectorClient(fixture);
    const input = { projectId: space.projectId, workspaceId: space.spaceId };
    expect(await client.inspector.view(input)).toMatchObject({ status: 'ok', value: { overview: { spaceId: space.spaceId }, savedTranscript: { status: 'available' } } });
    const results = [];
    for await (const result of client.inspector.transcript(input)) results.push(result);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('error');
    if (results[0]?.status !== 'error') throw new Error('Expected saved branch validation failure');
    expect(rpcErrors.operationFailed.is(results[0].error)).toBe(true);
  });

  it('requires account read authorization and the canonical project/workspace identity', async () => {
    const fixture = await account(['rpc.read']);
    const space = await inspectorWorkspace(fixture.userId);
    await publishInspectorSession(fixture, space, []);
    const writer = await account(['rpc.write']);
    const input = { projectId: space.projectId, workspaceId: space.spaceId };
    expect((await SELF.fetch(writer.request(single('inspector.transcript', input)))).status).toBe(403);
    const scoped = await account(['rpc.read'], 'client', { kind: 'project', projectId: space.projectId });
    expect((await SELF.fetch(scoped.request(single('inspector.transcript', input)))).status).toBe(403);
    const foreignRequest = (path: string, input: unknown) => {
      const request = fixture.request(single(path, input));
      request.headers.set('x-gitspace-user', `u-${'f'.repeat(32)}`);
      return request;
    };
    const pageInput = { ...input, generation: null, before: null, after: null, around: null };
    expect((await SELF.fetch(writer.request(single('inspector.transcriptPage', pageInput)))).status).toBe(403);
    expect((await SELF.fetch(scoped.request(single('inspector.transcriptPage', pageInput)))).status).toBe(403);
    expect((await SELF.fetch(foreignRequest('inspector.transcript', input))).status).toBe(403);
    expect((await SELF.fetch(foreignRequest('inspector.transcriptPage', pageInput))).status).toBe(403);
    const ownerPage = await inspectorClient(fixture).inspector.transcriptPage(pageInput);
    if (ownerPage.status !== 'ok') throw new Error('Expected owner transcript page');
    const contentInput = { ...input, generation: ownerPage.value.generation, rowId: 'missing', offset: 0 };
    expect((await SELF.fetch(writer.request(single('inspector.transcriptContent', contentInput)))).status).toBe(403);
    expect((await SELF.fetch(foreignRequest('inspector.transcriptContent', contentInput))).status).toBe(403);
    const mismatchError = await collectInspectorTranscript(inspectorClient(fixture), 'another-project', space.spaceId).then(() => null, (error: unknown) => error);
    expect(rpcErrors.workspaceNotFound.is(mismatchError)).toBe(true);
    await fixture.vault.revokeDeviceGrant(fixture.deviceId);
    expect((await SELF.fetch(fixture.request(single('inspector.transcript', input)))).status).toBe(401);
  });

  it('rechecks authorization after loading the snapshot and before disclosing any event', async () => {
    const fixture = await account(['rpc.read']);
    const space = await inspectorWorkspace(fixture.userId);
    const published = await publishInspectorSession(fixture, space, [
      { type: 'message', id: 'root', parentId: null, timestamp: '2026-09-01T12:00:00.000Z', message: { role: 'user', content: 'Private saved content' } },
    ]);
    const cloudEnv = { ...env, DATA: {
      head: (key: string) => env.DATA.head(key),
      get: async (key: string) => {
        const object = await env.DATA.get(key);
        if (key === `users/${fixture.userId}/${published.snapshotKey}`) await fixture.vault.revokeDeviceGrant(fixture.deviceId);
        return object;
      },
    } } as unknown as Env;
    const client = inspectorClient(fixture, (request) => worker.fetch(request, cloudEnv));
    const results = [];
    for await (const result of client.inspector.transcript({ projectId: space.projectId, workspaceId: space.spaceId })) results.push(result);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('error');
    if (results[0]?.status !== 'error') throw new Error('Expected subscription authorization failure');
    expect(rpcErrors.operationFailed.is(results[0].error)).toBe(true);
  });
});

describe('machine-independent Inspector', () => {
  it('reads and edits unplaced canonical workspaces without making a placement or contacting a provider', async () => {
    const fixture = await account();
    const space = await inspectorWorkspace(fixture.userId);
    const providerCalls: string[] = [];
    network.use(http.all(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/*`, ({ request }) => {
      providerCalls.push(request.url);
      return new HttpResponse(null, { status: 503 });
    }));
    const cloudEnv = env;
    const availability = await worker.fetch(fixture.request(single('inspector.availability', { projectId: space.projectId, workspaceId: space.spaceId })), cloudEnv);
    expect(parse(await availability.text())).toMatchObject({ status: 'ok', value: { runtimeAvailable: false } });
    const opened = await worker.fetch(fixture.request(single('inspector.view', { projectId: space.projectId, workspaceId: space.spaceId })), cloudEnv);
    expect(parse(await opened.text())).toMatchObject({ status: 'ok', value: { identity: { projectId: space.projectId, spaceId: space.spaceId }, placement: null } });
    expect(await collectInspectorTranscript(inspectorClient(fixture, (request) => worker.fetch(request, cloudEnv)), space.projectId, space.spaceId)).toEqual([]);
    const saved = await worker.fetch(fixture.request(single('inspector.goal.put', { expectedGeneration: 0, input: {
      projectId: space.projectId, spaceId: space.spaceId, expectedRevision: 0,
      goal: { id: 'offline-goal', title: 'Review without compute', summary: 'Canonical goal', phase: 'review', requirements: [], updatedBy: 'human' },
    } })), cloudEnv);
    expect(parse(await saved.text())).toMatchObject({ status: 'ok', value: { id: 'offline-goal', revision: 1 } });
    const overview = await worker.fetch(fixture.request(single('inspector.overview', { spaceId: space.spaceId, expectedGeneration: 0 })), cloudEnv);
    expect(parse(await overview.text())).toMatchObject({ status: 'ok', value: { goal: { title: 'Review without compute' } } });
    const snapshot = new TextEncoder().encode([
      { type: 'session', version: 3, id: 'canonical-omp', timestamp: '2026-09-01T12:00:00.000Z', cwd: '/saved' },
      { type: 'message', id: 'root', parentId: null, timestamp: '2026-09-01T12:00:00.000Z', message: { role: 'user', content: 'Published canonical conversation' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const snapshotHash = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', snapshot)), (byte) => byte.toString(16).padStart(2, '0')).join('')}` as const;
    const snapshotKey = `projects/${space.projectId}/sessions/canonical/${snapshotHash.slice(7)}.jsonl`;
    await env.DATA.put(`users/${fixture.userId}/${snapshotKey}`, snapshot, { customMetadata: { sha256: snapshotHash } });
    await space.authority.putCanonicalSession({ id: 'canonical', workspaceId: space.spaceId, ompSessionId: 'canonical-omp', machineId: null, state: 'closed', sessionObjectKey: snapshotKey, sessionObjectHash: snapshotHash, sessionFormatVersion: 'omp-jsonl-1', activity: { active: false, reasons: [] }, health: { revision: 0, issues: {} }, expectedRevision: 0 });
    const published = await worker.fetch(fixture.request(single('inspector.view', { projectId: space.projectId, workspaceId: space.spaceId })), cloudEnv);
    expect(parse(await published.text())).toMatchObject({ status: 'ok', value: { checkpoint: null, savedTranscript: { status: 'available' } } });
    const transcript = await collectInspectorTranscript(inspectorClient(fixture, (request) => worker.fetch(request, cloudEnv)), space.projectId, space.spaceId);
    expect(transcript).toMatchObject([{ sessionId: 'canonical', ordinal: 1, payload: { message: { content: 'Published canonical conversation' } } }]);
    expect(await space.placement.get()).toBeNull();
    expect(await env.FLEET_CATALOG.getByName(fixture.userId).listMachines()).toEqual([]);
    expect(providerCalls).toEqual([]);
  });

  it('reads saved checkpoint branches and encrypted artifacts but blocks artifact edits while the holder is stopped', async () => {
    const fixture = await account();
    const space = await inspectorWorkspace(fixture.userId);
    const machineId = 'sandbox-inspector';
    const identity = { projectId: space.projectId, spaceId: space.spaceId, machineId };
    const providerCalls: string[] = [];
    network.use(http.all(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/*`, ({ request }) => {
      providerCalls.push(request.url);
      return new HttpResponse(null, { status: 503 });
    }));
    const cloudEnv = env;
    const catalog = env.FLEET_CATALOG.getByName(fixture.userId);
    await catalog.putMachine({ id: machineId, label: 'Stopped', kind: 'sandbox', provider: 'cloudflare-sandbox', state: 'offline', desiredState: 'online', rpcEndpoint: 'https://stopped.example/rpc', notes: '', lifecycleRevision: 3, operationId: null, error: null });
    const bootstrapped = await space.placement.bootstrap(identity);
    if (bootstrapped.status === 'error') throw new Error(bootstrapped.failure.message);
    const availability = await worker.fetch(fixture.request(single('inspector.availability', { projectId: space.projectId, workspaceId: space.spaceId })), cloudEnv);
    expect(parse(await availability.text())).toMatchObject({ status: 'ok', value: { runtimeAvailable: false } });
    const offlineOverview = await worker.fetch(fixture.request(single('inspector.overview', { spaceId: space.spaceId, expectedGeneration: 1 })), cloudEnv);
    expect(parse(await offlineOverview.text())).toMatchObject({ status: 'ok', value: { spaceId: space.spaceId } });
    const closing = await space.placement.beginClose({ ...identity, expectedGeneration: 1 });
    if (closing.status === 'error') throw new Error(closing.failure.message);
    const { revision, previousRevision } = closing.value;
    const key = credentialProtocolBase64.decode(await fixture.vault.artifactKey(fixture.userId));
    const at = '2026-09-01T12:00:00.000Z';
    const sessionId = 'saved-session';
    const ompSessionId = 'saved-omp';
    const jsonl = [
      { type: 'session', version: 3, id: ompSessionId, timestamp: at, cwd: '/saved' },
      { type: 'message', id: 'root', parentId: null, timestamp: at, message: { role: 'user', content: 'Review the saved change' } },
      { type: 'message', id: 'abandoned', parentId: 'root', timestamp: at, message: { role: 'assistant', content: 'Old branch' } },
      { type: 'message', id: 'leaf', parentId: 'root', timestamp: at, message: { role: 'assistant', content: 'Saved answer' } },
    ].map((entry) => JSON.stringify(entry)).join('\n');
    const persist = async (objectKey: string, content: string) => {
      const sealed = await encryptArtifactBytes(new TextEncoder().encode(content), key);
      const hash: `sha256:${string}` = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(sealed))), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      await env.DATA.put(`users/${fixture.userId}/${objectKey}`, sealed, { customMetadata: { sha256: hash } });
      return hash;
    };
    const ompHash = await persist(spaceOmpCheckpointKey(space.projectId, space.spaceId, revision), jsonl);
    const scopeId = `artifacts-${space.spaceId}`;
    const scopeKey = await deriveArtifactScopeKey(key, scopeId);
    const publishArtifact = async (content: string) => {
      const sealed = await encryptArtifactBytes(new TextEncoder().encode(content), scopeKey);
      const hash = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(sealed))), (byte) => byte.toString(16).padStart(2, '0')).join('')}` as const;
      await env.DATA.put(`users/${fixture.userId}/accounts/${Buffer.from(fixture.userId).toString('base64url')}/artifacts/sha256/${hash.slice(7)}`, sealed, { customMetadata: { sha256: hash } });
      return hash;
    };
    const artifactHash = await publishArtifact('Cloud review evidence');
    const scopeHash = await publishArtifact(JSON.stringify({ version: 1, scopeId, generation: 1, entries: [{ path: 'review.txt', blobHash: artifactHash, size: 21, mediaType: 'text/plain' }] }));
    await space.authority.putArtifactScope({ id: scopeId, workspaceId: space.spaceId, expectedGeneration: 0, generation: 1, manifestHash: scopeHash });
    const manifestKey = spaceCheckpointManifestKey(space.projectId, space.spaceId, revision);
    const manifest: SpaceCheckpointManifest = {
      version: 1, projectId: space.projectId, spaceId: space.spaceId, revision, previousRevision,
      repository: { checkpointRef: spaceGitCheckpointRef(space.spaceId, revision), headCommit: 'a'.repeat(40), branch: 'review', indexCommit: 'b'.repeat(40), worktreeCommit: 'c'.repeat(40) },
      agent: { kind: 'legacy', sessionId, ompSessionId, ompCheckpointHash: ompHash, resumePending: false },
      artifacts: { manifestHash: scopeHash, generation: 1 }, createdAt: at,
    };
    const manifestHash = await persist(manifestKey, JSON.stringify(manifest));
    const closed = await space.placement.commitClosed({ ...identity, expectedGeneration: 1, revision, manifestKey, manifestHash, resumeOnMachineRestart: true });
    if (closed.status === 'error') throw new Error(closed.failure.message);
    await space.authority.putCanonicalSession({ id: sessionId, workspaceId: space.spaceId, ompSessionId, machineId, state: 'closed', sessionObjectKey: null, sessionObjectHash: null, sessionFormatVersion: null, activity: { active: false, reasons: [] }, health: { revision: 0, issues: {} }, expectedRevision: 0 });
    const before = await space.placement.get();
    const boot = await worker.fetch(fixture.request(single('inspector.view', { projectId: space.projectId, workspaceId: space.spaceId })), cloudEnv);
    expect(parse(await boot.text())).toMatchObject({ status: 'ok', value: {
      checkpoint: { sessionId, generation: 2, revision: 1, lastMachineId: machineId },
      savedTranscript: { status: 'available' },
    } });
    const transcript = await collectInspectorTranscript(inspectorClient(fixture, (request) => worker.fetch(request, cloudEnv)), space.projectId, space.spaceId);
    expect(transcript).toMatchObject([
      { sessionId, ordinal: 1, payload: { message: { content: 'Review the saved change' } }, createdAt: new Date(at) },
      { sessionId, ordinal: 2, payload: { message: { content: 'Saved answer' } }, createdAt: new Date(at) },
    ]);
    const savedClient = inspectorClient(fixture, (request) => worker.fetch(request, cloudEnv));
    const savedInput = { projectId: space.projectId, workspaceId: space.spaceId };
    const savedPage = await savedClient.inspector.transcriptPage({ ...savedInput, generation: null, before: null, after: null, around: null });
    if (savedPage.status !== 'ok') throw new Error('Expected encrypted saved page');
    expect(savedPage.value.rows.map((row) => row.item)).toMatchObject([
      { type: 'message', role: 'user', text: 'Review the saved change' },
      { type: 'message', role: 'assistant', text: 'Saved answer' },
    ]);
    const savedRow = savedPage.value.rows[1]!;
    const savedContent = await savedClient.inspector.transcriptContent({ ...savedInput, generation: savedPage.value.generation, rowId: savedRow.id, offset: 0 });
    expect(savedContent).toMatchObject({ status: 'ok', value: { text: JSON.stringify(savedRow.item), nextOffset: null } });
    const artifact = { spaceId: space.spaceId, expectedGeneration: 2, url: 'local://workspace/review.txt' };
    const written = await worker.fetch(fixture.request(single('inspector.artifacts.write', { ...artifact, mediaType: 'text/plain', base64: btoa('Cloud review evidence') })), cloudEnv);
    expect(parse(await written.text())).toMatchObject({ status: 'error' });
    const artifactChunks: Uint8Array<ArrayBuffer>[] = [];
    for await (const result of savedClient.inspector.artifacts.read({ ...artifact, hash: artifactHash })) {
      if (result.status === 'error') throw result.error;
      if (result.value.type === 'chunk') artifactChunks.push(Uint8Array.from(credentialProtocolBase64.decode(result.value.base64)));
    }
    expect(await new Blob(artifactChunks).text()).toBe('Cloud review evidence');
    const metadataPage = await savedClient.inspector.artifacts.readPage({ ...artifact, hash: artifactHash, cursor: null, limit: 1 });
    if (metadataPage.status !== 'ok') throw new Error('Expected saved artifact metadata page');
    expect(metadataPage.value.items).toMatchObject([{ type: 'metadata' }]);
    const contentPage = await savedClient.inspector.artifacts.readPage({ ...artifact, hash: artifactHash, cursor: metadataPage.value.nextCursor, limit: 1 });
    if (contentPage.status !== 'ok') throw new Error('Expected saved artifact content page');
    expect(contentPage.value.nextCursor).toBeNull();
    expect(contentPage.value.items).toEqual([{ type: 'chunk', base64: btoa('Cloud review evidence') }]);
    const repository = [];
    for await (const result of savedClient.inspector.repository.tree({ spaceId: space.spaceId, expectedGeneration: 2, mode: 'working', path: null })) {
      repository.push(result);
    }
    expect(repository).toMatchObject([{ status: 'error', error: { _tag: 'gitspace/inspector-state', data: { resource: 'runtime' } } }]);
    expect(await space.placement.get()).toEqual(before);
    expect(await catalog.getMachine(machineId)).toMatchObject({ state: 'offline', desiredState: 'online', lifecycleRevision: 3 });
    expect(providerCalls).toEqual([]);
  });

});

/** A cloud workspace's committed checkout, as its runtime stores it. */
async function seedCheckpoint(authority: DurableObjectStub<SpaceAuthorityDO>, checkpoint: RuntimeGitCheckpoint) {
  await runInDurableObject(authority, (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_code_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1), checkpoint TEXT NOT NULL)');
    state.storage.sql.exec('INSERT OR REPLACE INTO runtime_code_snapshot(singleton,checkpoint) VALUES(1,?)', JSON.stringify(checkpoint));
  });
}

function checkpointAt(workspaceId: string, branch: string, headCommit: string, worktreeTree = 'e'.repeat(40)): RuntimeGitCheckpoint {
  return { checkpointRef: `refs/gitspace/spaces/${workspaceId}/checkpoints`, headCommit, branch, indexCommit: headCommit, trackedWorktreeCommit: headCommit, worktreeCommit: headCommit, indexTree: worktreeTree, worktreeTree };
}

/** Artifacts history: each repository serves only the commits it holds, along their first-parent chain. */
function artifactsHistory() {
  const commits = new Map<string, { parents: string[]; committedAt: number; repositories: Set<string> }>();
  const identity = { name: 'Fixture', email: 'fixture@example.invalid' };
  vi.spyOn(ArtifactsCodeStore.prototype, 'log').mockImplementation(async (repository, start, limit = 50) => {
    const page: ArtifactsCommitMetadata[] = [];
    for (let hash: string | undefined = start; hash !== undefined && page.length < limit;) {
      const entry = commits.get(hash);
      if (!entry?.repositories.has(repository)) break;
      page.push({ hash, treeHash: hash, message: hash, author: identity, committer: identity, parents: entry.parents, authoredAt: entry.committedAt, committedAt: entry.committedAt });
      hash = entry.parents[0];
    }
    return page;
  });
  return {
    commit(parents: string[], ...repositories: string[]) {
      const hash = (commits.size + 1).toString(16).padStart(40, '0');
      commits.set(hash, { parents, committedAt: commits.size + 1, repositories: new Set(repositories) });
      return hash;
    },
    copy(repository: string, ...hashes: string[]) {
      for (const hash of hashes) commits.get(hash)?.repositories.add(repository);
    },
  };
}

describe('workspace environment edits and stack status with no machines', () => {
  it('saves a validated bundle into the cloud working copy and edits the profile and values', async () => {
    emptyCommittedSource();
    const fixture = await account(['rpc.read', 'rpc.write']);
    const { spaceId, placement } = await inspectorWorkspace(fixture.userId);
    const trees = new Map<string, Record<string, string>>([['e'.repeat(40), { 'README.md': 'f'.repeat(40) }]]);
    const blobs = new Map<string, string>([['f'.repeat(40), '# Pantry\n']]);
    const writes: string[][] = [];
    vi.spyOn(ArtifactsCodeStore.prototype, 'readFile').mockResolvedValue(null);
    vi.spyOn(ArtifactsCodeStore.prototype, 'listSnapshotPaths').mockImplementation(async (_repository, tree) => Object.keys(trees.get(tree) ?? {}));
    vi.spyOn(ArtifactsCodeStore.prototype, 'listSnapshotInventories').mockImplementation(async (_repository, requested) => requested.map(tree =>
      new Map(Object.entries(trees.get(tree) ?? {}).map(([path, oid]) => [path, { oid, mode: '100644', type: 'blob' as const }]))));
    vi.spyOn(ArtifactsCodeStore.prototype, 'readBlob').mockImplementation(async (_repository, oid) => {
      const text = blobs.get(oid);
      return text === undefined ? null : new Blob([text]);
    });
    vi.spyOn(ArtifactsCodeStore.prototype, 'writeSnapshot').mockImplementation(async (input) => {
      const files = { ...trees.get(input.previous.worktreeTree) };
      for (const mutation of input.mutations) {
        if (mutation.content === null) { delete files[mutation.path]; continue; }
        const oid = (blobs.size + 1).toString(16).padStart(40, 'b');
        blobs.set(oid, new TextDecoder().decode(mutation.content));
        files[mutation.path] = oid;
      }
      const tree = (trees.size + 1).toString(16).padStart(40, 'a');
      trees.set(tree, files);
      writes.push(input.mutations.map(mutation => mutation.path));
      return Result.ok({ ...input.previous, trackedWorktreeCommit: tree, worktreeCommit: tree, worktreeTree: tree });
    });
    await seedCheckpoint(placement, checkpointAt(spaceId, 'review', '1'.repeat(40)));
    const client = inspectorClient(fixture);
    const bundle = { version: 1, defaultProfile: 'base', profiles: { base: { values: ['REGION'] }, ios: { values: ['DEVICE'] } }, values: { REGION: { default: 'us-east-1' }, DEVICE: {} } };
    const canonical = JSON.stringify(loadEnvironmentBundle(bundle));
    expect(await client.environment.putBundle({ spaceId, bundleJson: JSON.stringify(bundle) })).toMatchObject({ status: 'ok', value: { bundleJson: canonical, selectedProfile: 'base', values: { effective: { REGION: 'us-east-1' } } } });
    expect(writes).toEqual([['.gitspace/bundle.json']]);
    const committed = [...trees.values()].at(-1)?.['.gitspace/bundle.json'];
    expect(JSON.parse(blobs.get(committed ?? '') ?? 'null')).toEqual(loadEnvironmentBundle(bundle));
    // The environment definition is the working copy's file: a fresh read derives the saved bundle from it.
    expect(await client.environment.get({ spaceId })).toMatchObject({ status: 'ok', value: { bundleJson: canonical } });

    const invalid = await client.environment.putBundle({ spaceId, bundleJson: JSON.stringify({ version: 1, profiles: { base: { values: ['REGION'] } } }) });
    expect(invalid).toMatchObject({ status: 'error', error: { _tag: rpcErrors.environmentFailure.tag, data: { code: 'InvalidBundle', message: expect.stringContaining('profiles.base.values: Unknown value: REGION') } } });
    expect(writes).toHaveLength(1);
    expect(await client.environment.get({ spaceId })).toMatchObject({ status: 'ok', value: { bundleJson: canonical } });

    expect(await client.environment.setProfile({ spaceId, profile: 'ios' })).toMatchObject({ status: 'ok', value: { selectedProfile: 'ios', effective: { values: ['REGION', 'DEVICE'] } } });
    expect(await client.environment.setProfile({ spaceId, profile: 'android' })).toMatchObject({ status: 'error', error: { data: { code: 'InvalidConfiguration', message: 'Unknown environment profile: android' } } });
    expect(await client.environment.putValue({ spaceId, scope: 'workspace', name: 'DEVICE', value: 'simulator' })).toMatchObject({ status: 'ok', value: { values: { workspace: { DEVICE: 'simulator' }, effective: { DEVICE: 'simulator' } } } });
    expect(await client.environment.putValue({ spaceId, scope: 'global', name: 'REGION', value: 'ap-south-1' })).toMatchObject({ status: 'ok', value: { values: { global: { REGION: 'ap-south-1' }, effective: { REGION: 'ap-south-1' } } } });
    expect(await client.environment.putValue({ spaceId, scope: 'project', name: 'REGION', value: 'eu-west-1' })).toMatchObject({ status: 'ok', value: { values: { project: { REGION: 'eu-west-1' }, global: { REGION: 'ap-south-1' }, effective: { REGION: 'eu-west-1' } } } });
    expect(await client.environment.putValue({ spaceId, scope: 'workspace', name: 'device', value: 'x' })).toMatchObject({ status: 'error', error: { data: { code: 'InvalidConfiguration' } } });
    const removed = await client.environment.deleteValue({ spaceId, scope: 'workspace', name: 'DEVICE' });
    if (removed.status === 'error') throw removed.error;
    expect(removed.value.values.workspace).toEqual({});
    expect(removed.value.values.effective).not.toHaveProperty('DEVICE');
    expect(removed.value.selectedProfile).toBe('ios');
  });

  it('computes a stacked workspace position from cloud checkpoints and Artifacts history', async () => {
    const fixture = await account(['rpc.read', 'rpc.write']);
    const { projectId, spaceId: parentId, authority } = await inspectorWorkspace(fixture.userId);
    const childId = `space-${crypto.randomUUID()}`;
    await authority.putWorkspace({ id: childId, projectId, kind: 'worktree', name: 'Child', branch: 'child', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await env.USER_PROJECTS.getByName(fixture.userId).putWorkspaceLocation(childId, projectId);
    const client = inspectorClient(fixture);
    expect(await client.workspace.setRelations({ workspaceId: childId, dependsOn: [], relatedTo: [], stackedOn: parentId })).toMatchObject({ status: 'ok' });
    const stack = async (workspaceId: string) => {
      const result = await client.workspace.stackStatus({ workspaceId });
      if (result.status === 'error') throw result.error;
      return result.value;
    };
    const [projectRepository, baseRepository, parentRepository, childRepository] = [`project-${projectId}`, `workspace-${projectId}`, `workspace-${parentId}`, `workspace-${childId}`];
    const history = artifactsHistory();
    const root = history.commit([], projectRepository, baseRepository, parentRepository, childRepository);
    const main = history.commit([root], projectRepository, baseRepository, parentRepository, childRepository);
    const fork = history.commit([main], parentRepository, childRepository);
    const second = history.commit([fork], parentRepository);
    const parentHead = history.commit([second], parentRepository);
    const childHead = history.commit([fork], childRepository);
    vi.spyOn(ArtifactsCodeStore.prototype, 'resolveRef').mockImplementation(async (repository, ref) => repository === projectRepository && ref === 'refs/heads/main' ? main : null);
    const child = env.SPACE_AUTHORITY.getByName(`${fixture.userId}:${childId}`);
    await seedCheckpoint(env.SPACE_AUTHORITY.getByName(`${fixture.userId}:${parentId}`), checkpointAt(parentId, 'review', parentHead));
    await seedCheckpoint(child, checkpointAt(childId, 'child', childHead));
    expect(await stack(childId)).toEqual({ parentId, parentBranch: 'review', baseBranch: 'main', mergeBase: fork, parentAhead: 2, parentMerged: 'not-merged', instruction: 'Rebase onto the parent: `git rebase review`' });

    // Merging the parent into the child reaches its commits only through a second parent.
    history.copy(childRepository, second, parentHead);
    await seedCheckpoint(child, checkpointAt(childId, 'child', history.commit([childHead, parentHead], childRepository)));
    expect(await stack(childId)).toMatchObject({ mergeBase: parentHead, parentAhead: 0, parentMerged: 'not-merged', instruction: null });

    // The base workspace's checkpoint, not the imported branch, says whether the parent landed.
    history.copy(baseRepository, fork, second, parentHead);
    await seedCheckpoint(env.SPACE_AUTHORITY.getByName(`${fixture.userId}:${projectId}`), checkpointAt(projectId, 'main', history.commit([main, parentHead], baseRepository)));
    expect(await stack(childId)).toMatchObject({ parentAhead: 0, parentMerged: 'merged', instruction: 'The parent merged into main. Rebase only your own commits: `git rebase --onto main review`, then this workspace is no longer stacked.' });

    expect(await stack(parentId)).toEqual({ parentId: null, parentBranch: null, baseBranch: 'main', mergeBase: null, parentAhead: 0, parentMerged: 'unknown', instruction: null });
    expect(await client.workspace.stackStatus({ workspaceId: 'missing' })).toMatchObject({ status: 'error', error: { _tag: rpcErrors.workspaceNotFound.tag, data: { workspaceId: 'missing' } } });
  });
});
