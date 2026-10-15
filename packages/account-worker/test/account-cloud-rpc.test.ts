import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, createSignedRpcFetch, credentialProtocolBase64, deriveArtifactScopeKey, DEVICE_SOCKET_PROTOCOL, encodeApiKey, encryptArtifactBytes, signDeviceInvite, signRpcRequest, type DeviceCapability, type DeviceScope } from '@gitspace/protocol';
import { accountLiveKey, liveNoticeMessageSchema, workspaceLiveKey, type LiveKey, type LiveNotice } from '@gitspace/protocol/live-notice';
import { workspaceStatusMessageSchema } from '@gitspace/protocol/account-directory';
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
import { invalidateDeviceAuthority } from '../src/device-authority.js';
import { tenantRootPrivateKey } from './setup.js';
import { HttpResponse, http } from 'msw';
import { network } from './network.js';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { z } from 'zod';
import { RuntimeAttachmentSchema, RuntimeLifecycleDispatchArgumentsSchema, type RuntimeGitCheckpoint, type RuntimeToolDispatch } from '@gitspace/protocol-runtime';
import { Result } from 'better-result';
import { SpaceAuthorityDO } from '../src/space-authority.js';

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

  it('sends a tab every status row when it connects, then each changed row once', async () => {
    const fixture = await account();
    const { projectId, spaceId } = await inspectorWorkspace(fixture.userId);
    const index = env.USER_PROJECTS.getByName(fixture.userId);
    const idle = { primaryColor: 'blue' as const, agents: { green: 0, blue: 1, orange: 0, red: 0 }, machines: { attached: 0, online: 0, ready: 0 }, sync: { conflicts: 0, problems: 0 } };
    await index.setWorkspaceStatus({ projectId, workspaceId: spaceId, status: idle });
    const path = '/v1/directory/events';
    const auth = signRpcRequest({ deviceId: fixture.deviceId, signingPrivateKey: fixture.signingPrivateKey, method: 'GET', path, body: new Uint8Array() });
    const response = await SELF.fetch(new Request(`${env.ACCOUNT_URL}${path}`, { headers: { origin: env.ACCOUNT_URL, upgrade: 'websocket', 'sec-websocket-protocol': `${DEVICE_SOCKET_PROTOCOL}${auth}` } }));
    const socket = response.webSocket!;
    const messages: z.infer<typeof workspaceStatusMessageSchema>[] = [];
    socket.addEventListener('message', (event) => {
      const parsed = workspaceStatusMessageSchema.safeParse(JSON.parse(String(event.data)));
      if (parsed.success) messages.push(parsed.data);
    });
    socket.accept();
    await vi.waitFor(() => expect(messages).toEqual([{ type: 'statuses', rows: expect.arrayContaining([{ projectId, workspaceId: spaceId, status: idle }]) }]));
    const working = { ...idle, primaryColor: 'green' as const, agents: { green: 1, blue: 0, orange: 0, red: 0 } };
    await index.setWorkspaceStatus({ projectId, workspaceId: spaceId, status: working });
    await index.setWorkspaceStatus({ projectId, workspaceId: spaceId, status: working });
    await vi.waitFor(() => expect(messages.slice(1)).toEqual([{ type: 'status', projectId, workspaceId: spaceId, status: working }]));
    socket.close();
  });

  it('sends a watching tab one notice per committed change, and its read after the cursor returns only newer changes', async () => {
    const fixture = await account();
    const { projectId, spaceId } = await inspectorWorkspace(fixture.userId);
    const space = env.SPACE_AUTHORITY.getByName(`${fixture.userId}:${spaceId}`);
    const spaceIdentity = { projectId, workspaceId: spaceId };
    const client = inspectorClient(fixture);
    expect(await client.environment.state({ spaceId })).toMatchObject({ status: 'ok', value: { policy: { automatic: false } } });
    const watching = await liveSocket(fixture);
    const elsewhere = await liveSocket(fixture);
    try {
      await watching.subscribe(workspaceLiveKey(spaceId, 'environment'), accountLiveKey('cloud-images'));
      await elsewhere.subscribe(workspaceLiveKey('another-space', 'environment'));
      // Listed by `getWebSockets`: accepted for hibernation, so open tabs never pin the live object.
      expect(await runInDurableObject(env.USER_PROJECTS.getByName(fixture.userId), (_instance, state) => state.getWebSockets().length)).toBeGreaterThanOrEqual(2);
      expect(await space.mutateLifecycleState(spaceIdentity, { op: 'policy', automatic: true }, { machineId: 'machine', actorId: 'human', kind: 'browser', lifecycleControl: true })).toMatchObject({ status: 'ok' });
      const notice = await watching.next();
      expect(notice).toEqual({ project: null, workspace: spaceId, resource: 'environment', version: expect.any(Number) });
      // Each socket's next notice is this marker: no second notice for the change, none for a key a tab does not watch.
      expect(await env.USER_PROJECTS.getByName(fixture.userId).liveNotices([
        { ...accountLiveKey('cloud-images'), version: 1 }, { ...workspaceLiveKey('another-space', 'environment'), version: 1 }, { ...accountLiveKey('machines'), version: 1 },
      ])).toEqual([1, 1, 0]);
      expect(await watching.next()).toMatchObject({ resource: 'cloud-images' });
      expect(await elsewhere.next()).toMatchObject({ workspace: 'another-space', resource: 'environment' });
      // The notice carries no state: the tab reads the current state again.
      expect(await client.environment.state({ spaceId })).toMatchObject({ status: 'ok', value: { policy: { automatic: true } } });
    } finally {
      watching.socket.close();
      elsewhere.socket.close();
    }
  });

  it.each(['browser', 'client'] as const)('allows authorized %s lifecycle control while preserving content review', async (kind) => {
    emptyCommittedSource();
    const fixture = await account(['rpc.read', 'rpc.write', ...(kind === 'client' ? ['lifecycle.control' as const] : [])], kind);
    const projectId = 'lifecycle-project';
    const spaceId = 'lifecycle-space';
    const authority = env.PROJECT_AUTHORITY.getByName(`${fixture.userId}:${projectId}`);
    const space = env.SPACE_AUTHORITY.getByName(`${fixture.userId}:${spaceId}`);
    const spaceIdentity = { projectId, workspaceId: spaceId };
    await authority.bootstrap({ id: projectId, name: 'Lifecycle', repositoryReference: null, baseBranch: 'main', createdBy: 'machine' });
    await authority.putWorkspace({ id: spaceId, projectId, kind: 'worktree', name: 'Lifecycle', branch: 'feature', phase: null, sourceKind: 'branch', sourceRef: 'feature', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await env.USER_PROJECTS.getByName(fixture.userId).putWorkspaceLocation(spaceId, projectId);
    const content = 'echo provision';
    const hash = await executionHash({ kind: 'script', command: content });
    const actor = { machineId: 'removed-machine', actorId: 'removed-machine', kind: 'machine' as const, lifecycleControl: false };
    const configure = { op: 'configure' as const, bundleJson: JSON.stringify({ version: 1, profiles: { base: {} } }), executions: [{ id: 'provision', kind: 'script' as const, label: 'Provision', command: 'bash provision.sh', content, hash, phase: 'cloud/provision' as const, fileName: '10-provision.sh' }] };
    const configured = await space.mutateLifecycleState(spaceIdentity, configure, actor);
    if (configured.status === 'error') throw new Error(configured.failure.message);
    const approved = await SELF.fetch(fixture.request(single('environment.approve', { spaceId, executionHash: hash, scope: 'workspace' })));
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(parse(await approved.text())).toMatchObject({ status: 'ok', value: { executions: [{ content, approval: 'workspace' }] } });
    expect((await space.getLifecycleState(spaceIdentity)).approvals[0]?.approvedBy).toBe(fixture.deviceId);
    const policy = await space.mutateLifecycleState(spaceIdentity, { op: 'policy', automatic: true }, actor);
    if (policy.status === 'error') throw new Error(policy.failure.message);
    const running = await space.mutateLifecycleState(spaceIdentity, { op: 'claim', runId: 'provision', phase: 'cloud/provision', profile: 'base', executionHashes: [hash], generation: null, rerun: false }, actor);
    if (running.status === 'error') throw new Error(running.failure.message);
    expect(running.state.claim?.status).toBe('claimed');
    const finished = await space.mutateLifecycleState(spaceIdentity, { op: 'finish', runId: 'provision', status: 'failed', exitCode: 1, results: [], output: 'cloud error', bindings: { database: 'partial-db' } }, actor);
    if (finished.status === 'error') throw new Error(finished.failure.message);
    const state = await SELF.fetch(fixture.request(single('environment.get', { spaceId })));
    expect(state.status, await state.clone().text()).toBe(200);
    expect(parse(await state.text())).toMatchObject({ status: 'ok', value: { lifecycle: { bindings: { database: 'partial-db' }, runs: [{ status: 'failed', output: 'cloud error' }] } } });
    expect(await env.FLEET_CATALOG.getByName(fixture.userId).listMachines()).toEqual([]);
    const log = await SELF.fetch(fixture.request(single('environment.runLog', { spaceId, runId: 'provision', offset: null })));
    expect(parse(await log.text())).toMatchObject({ status: 'ok', value: { output: 'cloud error', nextOffset: null } });
    const changed = await space.mutateLifecycleState(spaceIdentity, { ...configure, executions: [{ ...configure.executions[0]!, content: 'different displayed content' }] }, actor);
    if (changed.status === 'error') throw new Error(changed.failure.message);
    const forged = await SELF.fetch(fixture.request(single('environment.approve', { spaceId, executionHash: hash, scope: 'project' })));
    expect(parse(await forged.text())).toMatchObject({ status: 'error' });
  });

  it('derives a cloud workspace environment from its uncommitted checkpoint worktree and lets a cache claim the approved script', async () => {
    emptyCommittedSource();
    const fixture = await account(['rpc.read', 'rpc.write']);
    const { projectId, spaceId, placement } = await inspectorWorkspace(fixture.userId);
    const space = env.SPACE_AUTHORITY.getByName(`${fixture.userId}:${spaceId}`);
    const spaceIdentity = { projectId, workspaceId: spaceId };
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
    const claim = (runId: string) => space.mutateLifecycleState(spaceIdentity, { op: 'claim', runId, phase: 'machine/prepare', profile: 'base', executionHashes: [hash], generation: null, rerun: true, attachment }, cache);
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
    const space = env.SPACE_AUTHORITY.getByName(`${fixture.userId}:${spaceId}`);
    const spaceIdentity = { projectId, workspaceId: spaceId };
    const configured = await space.mutateLifecycleState(spaceIdentity, {
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

  it('reads committed inference profiles without broker credentials', async () => {
    const fixture = await account();
    const client = inspectorClient(fixture);
    await fixture.vault.putBrowserApiKey('default', 'openai', 'never-in-reads');
    await fixture.vault.createInferenceProfile({ name: 'Read back', sourceProfileId: null });
    const listed = await client.inference.list({});
    expect(listed).toMatchObject({ status: 'ok', value: { profiles: [{ id: 'default' }, { name: 'Read back' }] } });
    expect(JSON.stringify(listed)).not.toContain('never-in-reads');
    expect(JSON.stringify(listed)).not.toContain('broker');
  });

  it('authorizes every batch item before any mutation and rejects tampering and revocation', async () => {
    const fixture = await account(['rpc.read']);
    const before = await env.USER_SETTINGS.getByName(fixture.userId).get('check');
    const denied = await SELF.fetch(fixture.request({ v: 1, batch: [
      { ...single('settings.get'), id: 'read' },
      { ...single('settings.update', { expectedRevision: before.revision, onboardingComplete: true, profile: before.profile, git: before.git, defaults: before.defaults, machines: before.machines }), id: 'write' },
    ] }));
    expect(denied.status).toBe(403);
    expect((await env.USER_SETTINGS.getByName(fixture.userId).get('check')).onboardingComplete).toBe(false);

    expect((await SELF.fetch(fixture.request(single('settings.get')))).status).toBe(200);
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

  /** Machine A is the first online machine; machines B and C are also enrolled. */
  async function fleet(cloudRuntime = false) {
    const fixture = await account(['rpc.read', 'rpc.write']);
    const held = await inspectorWorkspace(fixture.userId);
    const catalog = env.FLEET_CATALOG.getByName(fixture.userId);
    const machines = ['machine-a', 'machine-b', 'machine-c'];
    for (const id of machines) await catalog.putMachine(machine(id));
    if (cloudRuntime) await held.placement.runtimeAttachments({ projectId: held.projectId, workspaceId: held.spaceId });
    const reached: Array<{ machine: string; signedTarget: string | null }> = [];
    network.use(...machines.map((id) => http.post(`https://${id}.test/rpc`, ({ request }) => {
      reached.push({ machine: id, signedTarget: request.headers.get('x-gitspace-signed-target') });
      return HttpResponse.json({ machine: id });
    })));
    return { fixture, catalog, held, reached };
  }

  /** HEAD and index hold README.md and src/app.ts; the worktree edits src/app.ts and adds untracked notes.txt. */
  function committedCheckout(spaceId: string) {
    const id = (digit: string) => digit.repeat(40);
    const checkpoint = { checkpointRef: `refs/gitspace/spaces/${spaceId}/checkpoints`, headCommit: id('1'), branch: 'review', indexCommit: id('2'), trackedWorktreeCommit: id('3'), worktreeCommit: id('4'), indexTree: id('5'), worktreeTree: id('6') };
    const file = (name: string, hash: string): ArtifactsTreeEntry => ({ name, hash, mode: '100644', type: 'blob' });
    const committed = [file('README.md', id('a')), { name: 'src', hash: id('8'), mode: '40000', type: 'tree' as const }];
    const trees: Record<string, ArtifactsTreeEntry[]> = {
      [id('7')]: committed, [id('5')]: committed, [id('8')]: [file('app.ts', id('b'))], [id('9')]: [file('app.ts', id('c'))],
      [id('6')]: [file('README.md', id('a')), { name: 'src', hash: id('9'), mode: '40000', type: 'tree' }, file('notes.txt', id('d'))],
    };
    const blobs: Record<string, string> = { [id('a')]: '# Review\n', [id('b')]: "export const source = 'head';\n", [id('c')]: "export const source = 'cloud checkpoint';\n", [id('d')]: 'scratch\n' };
    vi.spyOn(ArtifactsCodeStore.prototype, 'reader').mockImplementation(() => ({
      readTree: async oid => trees[oid] ?? null,
      readBlob: async oid => blobs[oid] === undefined ? null : new Blob([blobs[oid]]),
      readCommit: async hash => hash === checkpoint.headCommit
        ? { hash, treeHash: id('7'), message: 'head', author: { name: 'a', email: 'a@test' }, committer: { name: 'a', email: 'a@test' }, parents: [], authoredAt: 0, committedAt: 0 }
        : null,
      log: async () => [],
      close: async () => {},
    }));
    return { checkpoint, worktreeContent: blobs[id('c')] };
  }

  it('forwards terminal work only to the chosen machine while it is a ready cache of the cloud workspace', async () => {
    const { fixture, held, reached } = await fleet(true);
    const ready = RuntimeAttachmentSchema.parse({
      projectId: held.projectId, workspaceId: held.spaceId, attachmentId: 'cache-c', machineId: 'machine-c', generation: 1, role: 'cache', state: 'ready',
      checkout: { kind: 'shared', branch: 'review' }, capabilities: [], updatedAt: new Date().toISOString(), online: true,
    });
    const stale = { ...ready, attachmentId: 'cache-a', machineId: 'machine-a', online: false };
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
      checkout: { kind: 'shared', branch: 'review' }, capabilities: [], updatedAt: new Date().toISOString(), online: true,
    });
    const stale = { ...ready, attachmentId: 'cache-a', machineId: 'machine-a', online: false };
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

  it('runs a person\'s sync actions as the sync tool on the named ready cache only', async () => {
    const { fixture, held, reached } = await fleet(true);
    const client = inspectorClient(fixture);
    const ready = RuntimeAttachmentSchema.parse({
      projectId: held.projectId, workspaceId: held.spaceId, attachmentId: 'cache-c', machineId: 'machine-c', generation: 1, state: 'ready',
      checkout: { kind: 'shared', branch: 'review' }, capabilities: [], updatedAt: new Date().toISOString(), online: true,
    });
    const { checkpoint } = committedCheckout(held.spaceId);
    const dispatched: RuntimeToolDispatch[] = [];
    await runInDurableObject(held.placement, async (instance, state) => {
      state.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', ready.attachmentId, JSON.stringify(ready), 'fixture');
      const runtime = await instance['runtime'];
      if (!runtime) throw new Error('Workspace runtime did not open');
      vi.spyOn(runtime.cloudFiles, 'initializeSnapshot').mockResolvedValue(checkpoint);
      vi.spyOn(runtime.cloudFiles, 'snapshot').mockResolvedValue({ ...checkpoint, conflicts: [] });
      // The machine half of `sync`: capture sends its changes; diff lists what it has not sent.
      vi.spyOn(runtime.attachments, 'execute').mockImplementation(async (dispatch) => {
        dispatched.push(dispatch);
        const op = z.object({ op: z.string() }).parse(dispatch.args).op;
        const value = op === 'capture' ? { version: checkpoint.worktreeCommit, conflicts: [] } : { base: checkpoint.worktreeCommit, unsent: [{ status: 'M', path: 'src/app.ts' }], unsentTruncated: false, patch: null };
        return { status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: JSON.stringify(value) }] };
      });
    });
    const identity = { projectId: held.projectId, workspaceId: held.spaceId };
    expect(await client.runtime.sync({ ...identity, requestId: 'now-c', args: { method: 'now', on: 'machine-c' } })).toEqual({ status: 'ok', value: { method: 'now', version: checkpoint.worktreeCommit, conflicts: [] } });
    expect(await client.runtime.sync({ ...identity, requestId: 'diff-c', args: { method: 'diff', on: 'machine-c' } })).toEqual({ status: 'ok', value: { method: 'diff', unsent: [{ status: 'M', path: 'src/app.ts' }], unsentTruncated: false, notOnMachine: [], notOnMachineTruncated: false } });
    // An online machine that is not a ready cache of this workspace is never used instead.
    expect(await client.runtime.sync({ ...identity, requestId: 'now-a', args: { method: 'now', on: 'machine-a' } })).toMatchObject({ status: 'error' });
    expect(dispatched.map((dispatch) => ({ machineId: dispatch.machineId, tool: dispatch.tool, args: dispatch.args }))).toEqual([
      { machineId: 'machine-c', tool: 'sync_machine', args: { op: 'capture', on: 'machine-c' } },
      { machineId: 'machine-c', tool: 'sync_machine', args: { op: 'diff', on: 'machine-c' } },
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
      operation: { kind: 'project.create', state: 'succeeded' },
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
      operation: { kind: 'project.import', state: 'succeeded' },
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

async function inspectorWorkspace(userId: string, repositoryReference: string | null = null) {
  const projectId = `project-${crypto.randomUUID()}`;
  const spaceId = `space-${crypto.randomUUID()}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const project = await authority.bootstrap({ id: projectId, name: `Saved inspection ${projectId}`, repositoryReference, baseBranch: 'main', createdBy: 'human' });
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

/** A tab's account directory socket, collecting the live notices it receives. */
async function liveSocket(fixture: InspectorAccount) {
  const path = '/v1/directory/events';
  const auth = signRpcRequest({ deviceId: fixture.deviceId, signingPrivateKey: fixture.signingPrivateKey, method: 'GET', path, body: new Uint8Array() });
  const response = await SELF.fetch(new Request(`${env.ACCOUNT_URL}${path}`, { headers: { origin: env.ACCOUNT_URL, upgrade: 'websocket', 'sec-websocket-protocol': `${DEVICE_SOCKET_PROTOCOL}${auth}` } }));
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const notices: LiveNotice[] = [];
  let arrived = () => {};
  socket.addEventListener('message', (event) => {
    const parsed = liveNoticeMessageSchema.safeParse(JSON.parse(String(event.data)));
    if (!parsed.success) return;
    const { type: _type, ...notice } = parsed.data;
    notices.push(notice);
    arrived();
  });
  socket.accept();
  const index = env.USER_PROJECTS.getByName(fixture.userId);
  const watched = () => runInDurableObject(index, (_instance, state) => state.getWebSockets().map(server => z.object({ live: z.array(z.number()).default([]) }).parse(server.deserializeAttachment()).live.length));
  return {
    socket,
    /** Resolves once the live object recorded the keys. */
    async subscribe(...keys: LiveKey[]) {
      const before = (await watched()).reduce((total, count) => total + count, 0);
      socket.send(JSON.stringify({ type: 'subscribe', keys }));
      await vi.waitFor(async () => expect((await watched()).reduce((total, count) => total + count, 0)).toBe(before + keys.length));
    },
    async next(): Promise<LiveNotice> {
      while (notices.length === 0) await new Promise<void>((resolve) => { arrived = resolve; });
      return notices.shift()!;
    },
  };
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

describe('machine-independent Inspector', () => {
  it.each(['active', 'archived'] as const)('keeps an unplaced %s native workspace authoritative without contacting a provider', async lifecycle => {
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
    expect(await space.placement.hasCloudRuntime()).toBe(true);
    const workspace = (await space.authority.listWorkspaces()).find(candidate => candidate.id === space.spaceId)!;
    await space.authority.putWorkspace({ ...workspace, lifecycle, expectedRevision: workspace.revision });
    expect(await space.authority.listCanonicalSessions()).toEqual([]);
    const transcript = await collectInspectorTranscript(inspectorClient(fixture, (request) => worker.fetch(request, cloudEnv)), space.projectId, space.spaceId);
    expect(transcript).toEqual([]);
    expect(await space.placement.get()).toBeNull();
    expect(await env.FLEET_CATALOG.getByName(fixture.userId).listMachines()).toEqual([]);
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
