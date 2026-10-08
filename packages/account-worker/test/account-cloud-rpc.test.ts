import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, createSignedRpcFetch, credentialProtocolBase64, deriveArtifactScopeKey, encodeApiKey, encryptArtifactBytes, signDeviceInvite, signRpcRequest, type DeviceCapability, type DeviceScope } from '@gitspace/protocol';
import { createGitSpaceClient } from '@gitspace/protocol/client';
import { CHECKPOINT_CHUNK_BYTES, CHUNKED_CHECKPOINT_VERSION, spaceCheckpointManifestKey, spaceGitCheckpointRef, spaceOmpCheckpointKey, type SpaceCheckpointManifest } from '@gitspace/protocol-workspace';
import type { ProviderView } from '@gitspace/protocol';
import { executionHash } from '@gitspace/protocol-environment';
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

  it('locates canonical holders and sessions without a portable catalog or a running machine', async () => {
    const fixture = await account();
    const space = await inspectorWorkspace(fixture.userId);
    const { sessionId } = await publishInspectorSession(fixture, space, []);
    const catalog = env.FLEET_CATALOG.getByName(fixture.userId);
    const machineId = 'sandbox-stopped-directory';
    await space.placement.bootstrap({ projectId: space.projectId, spaceId: space.spaceId, machineId });
    await env.SPACE_AUTHORITY.getByName(`${fixture.userId}:${space.projectId}`).bootstrap({ projectId: space.projectId, spaceId: space.projectId, machineId });
    const machine = { id: machineId, label: 'Stopped', kind: 'sandbox' as const, provider: 'cloudflare-sandbox' as const,
      state: 'offline' as const, desiredState: 'online' as const, rpcEndpoint: 'https://stopped.example/rpc', notes: '',
      lifecycleRevision: 1, operationId: null, error: null };
    await catalog.putMachine(machine);
    const providerCalls: string[] = [];
    network.use(http.all(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/*`, ({ request }) => {
      providerCalls.push(request.url);
      return new HttpResponse(null, { status: 503 });
    }));
    const cloudEnv = env;
    const client = inspectorClient(fixture, (request) => worker.fetch(request, cloudEnv));
    const directory = await client.placements({});
    const located = await client.session.locate({ sessionId });
    const expected = { spaceId: space.spaceId, holderId: machineId, state: 'open', generation: 1, endpoint: null, kind: 'worktree' };
    const expectedBase = { ...expected, spaceId: space.projectId, kind: 'base' };
    expect(directory).toMatchObject({ status: 'ok', value: { machineId: '', spaces: [expectedBase, expected] } });
    expect(located).toMatchObject({ status: 'ok', value: expected });
    await catalog.putMachine({ ...machine, state: 'online', lifecycleRevision: 2 });
    expect(await client.placements({})).toMatchObject({ status: 'ok', value: { machineId: '', spaces: [
      { ...expectedBase, endpoint: machine.rpcEndpoint }, { ...expected, endpoint: machine.rpcEndpoint },
    ] } });
    expect(providerCalls).toEqual([]);
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
    expect(await env.PROJECT_AUTHORITY.getByName(`${fixture.userId}:${projects[0].id}`).listWorkspaces()).toEqual([]);
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
      client.settings.get({}), client.settings.runtime.get({}), client.browserRelay.status({}),
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
    expect(result.value.providers.find(provider => provider.id === 'openai-codex')).toMatchObject({ hasAuth: false, authKind: 'none', supportsOAuth: true, supportsApiKey: false, accounts: [] });
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
      { ...single('settings.update', { expectedRevision: before.revision, onboardingComplete: true, profile: before.profile, git: before.git, defaults: before.defaults }), id: 'write' },
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
  async function fleet() {
    const fixture = await account(['rpc.read', 'rpc.write']);
    const held = await inspectorWorkspace(fixture.userId);
    const { sessionId } = await publishInspectorSession(fixture, held, []);
    const catalog = env.FLEET_CATALOG.getByName(fixture.userId);
    const machines = ['machine-a', 'machine-b', 'machine-c'];
    for (const id of machines) await catalog.putMachine(machine(id));
    await held.placement.bootstrap({ projectId: held.projectId, spaceId: held.spaceId, machineId: 'machine-b' });
    await env.SPACE_AUTHORITY.getByName(`${fixture.userId}:${held.projectId}`).bootstrap({ projectId: held.projectId, spaceId: held.projectId, machineId: 'machine-c' });
    const reached: Array<{ machine: string; signedTarget: string | null }> = [];
    network.use(...machines.map((id) => http.post(`https://${id}.test/rpc`, ({ request }) => {
      reached.push({ machine: id, signedTarget: request.headers.get('x-gitspace-signed-target') });
      return HttpResponse.json({ machine: id });
    })));
    return { fixture, catalog, held, sessionId, reached };
  }

  it('forwards space and session work to the machine holding the space, not the first online machine', async () => {
    const { fixture, held, sessionId, reached } = await fleet();
    const view = await SELF.fetch(fixture.request(single('space.view', { projectId: held.projectId, workspaceId: held.spaceId })));
    expect(await view.json()).toEqual({ machine: 'machine-b' });
    const control = await SELF.fetch(fixture.request(single('session.control', { sessionId })));
    expect(await control.json()).toEqual({ machine: 'machine-b' });
    await inspectorClient(fixture).space.view({ projectId: held.projectId, workspaceId: held.spaceId });
    expect(reached).toEqual([
      { machine: 'machine-b', signedTarget: '/rpc' },
      { machine: 'machine-b', signedTarget: '/rpc' },
      { machine: 'machine-b', signedTarget: '/rpc?p=space.view' },
    ]);
  });

  it('rejects one signed batch naming spaces held by different machines', async () => {
    const { fixture, held, reached } = await fleet();
    const logs = vi.spyOn(console, 'log');
    try {
      const response = await SELF.fetch(fixture.request({ v: 1, batch: [
        { ...single('space.view', { projectId: held.projectId, workspaceId: held.spaceId }), id: 'held' },
        { ...single('space.view', { projectId: held.projectId, workspaceId: null }), id: 'base' },
      ] }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'RPC_MIXED_HOLDER_BATCH' } });
      expect(reached).toEqual([]);
      const batches = logs.mock.calls.flatMap(([line]): unknown[] => typeof line === 'string' && line.includes('"rpc_batch"') ? [JSON.parse(line)] : []);
      expect(batches).toEqual([expect.objectContaining({ event: 'rpc_batch', procedures: ['space.view'], status: 400, code: 'RPC_MIXED_HOLDER_BATCH' })]);
    } finally { logs.mockRestore(); }
  });

  async function creationFleet(defaultMachineId: string) {
    const value = await fleet();
    const settings = env.USER_SETTINGS.getByName(value.fixture.userId);
    const current = await settings.get('test');
    await settings.update('test', { ...current, expectedRevision: current.revision, defaults: { ...current.defaults, machineId: defaultMachineId } });
    for (const id of ['machine-a', 'machine-b', 'machine-c']) {
      await env.TENANT_RELEASES.getByName(value.fixture.userId).machineProtocol(id, { version: 1 });
    }
    return value;
  }

  it('creates a project on the compatible online configured default rather than the first machine', async () => {
    const { fixture, reached } = await creationFleet('machine-b');
    const response = await SELF.fetch(fixture.request(single('project.create', { name: 'Created', baseBranch: 'main', repositoryUrl: null })));
    expect(await response.json()).toEqual({ machine: 'machine-b' });
    expect(reached.map((entry) => entry.machine)).toEqual(['machine-b']);
  });

  it.each(['offline', 'incompatible'] as const)('falls back from an %s default only to a compatible online creation machine', async (reason) => {
    const { fixture, catalog, reached } = await creationFleet('machine-b');
    await env.TENANT_RELEASES.getByName(fixture.userId).machineProtocol('machine-a', { version: null });
    if (reason === 'offline') await catalog.putMachine({ ...machine('machine-b'), state: 'offline', lifecycleRevision: 2 });
    else await env.TENANT_RELEASES.getByName(fixture.userId).machineProtocol('machine-b', { version: null });
    const response = await SELF.fetch(fixture.request(single('project.create', { name: 'Created', baseBranch: 'main', repositoryUrl: null })));
    expect(await response.json()).toEqual({ machine: 'machine-c' });
    expect(reached.map((entry) => entry.machine)).toEqual(['machine-c']);
  });

  it('rejects project creation without a compatible online machine before dispatch', async () => {
    const { fixture, reached } = await creationFleet('machine-b');
    for (const id of ['machine-a', 'machine-b', 'machine-c']) await env.TENANT_RELEASES.getByName(fixture.userId).machineProtocol(id, { version: null });
    const response = await SELF.fetch(fixture.request(single('project.create', { name: 'Created', baseBranch: 'main', repositoryUrl: null })));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'FLEET_OFFLINE' } });
    expect(reached).toEqual([]);
  });

  it('does not retry creation on another machine after an uncertain mutation failure', async () => {
    const { fixture, reached } = await creationFleet('machine-b');
    network.use(http.post('https://machine-b.test/rpc', () => {
      reached.push({ machine: 'machine-b', signedTarget: '/rpc' });
      return HttpResponse.json({ error: 'connection failed after creation' }, { status: 502 });
    }));
    const response = await SELF.fetch(fixture.request(single('project.create', { name: 'Created', baseBranch: 'main', repositoryUrl: null })));
    expect(response.status).toBe(502);
    expect(reached.map((entry) => entry.machine)).toEqual(['machine-b']);
  });

  it('sends work without a live holder to the first online machine', async () => {
    const { fixture, catalog, held, reached } = await fleet();
    await SELF.fetch(fixture.request(single('project.open', { projectId: held.projectId })));
    await SELF.fetch(fixture.request(single('space.reopen', { spaceId: 'never-placed', expectedGeneration: 1 })));
    await catalog.putMachine({ ...machine('machine-b'), state: 'offline', lifecycleRevision: 2 });
    await SELF.fetch(fixture.request(single('space.view', { projectId: held.projectId, workspaceId: held.spaceId })));
    expect(reached.map((entry) => entry.machine)).toEqual(['machine-a', 'machine-a', 'machine-a']);
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
