import { env, SELF } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, createSignedRpcFetch, credentialProtocolBase64, deriveArtifactScopeKey, encryptArtifactBytes, signDeviceInvite, signRpcRequest, spaceCheckpointManifestKey, spaceOmpCheckpointKey, type DeviceCapability, type DeviceScope } from '@gitspace/protocol';
import type { ProviderView } from '@gitspace/protocol';
import { gitspaceContract } from '@gitspace/protocol/rpc-contract';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { createBrowserClient } from 'result-rpc/client';
import { parse, stringify } from 'devalue';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';

async function account(capabilities: DeviceCapability[] = ['rpc.read', 'rpc.write', 'fleet.control', 'devices.manage'], kind: 'browser' | 'client' = 'browser', scope: DeviceScope = { kind: 'user' }) {
  const userId = `u-${crypto.randomUUID().replaceAll('-', '')}`;
  const handle = `rpc-${crypto.randomUUID().slice(0, 8)}`;
  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const browserKey = crypto.getRandomValues(new Uint8Array(32));
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootKey)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  await env.ACCOUNTS.getByName('global').upsertProvisioning({ userId, handle });
  await env.ACCOUNTS.getByName('global').markActive({ userId, release: null });
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

describe('account cloud RPC without machines', () => {
  it('loads canonical settings and an empty fleet/project index in one authorized batch', async () => {
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
      { id: 'projects', response: { status: 'ok', value: [] } },
    ] });
  });

  it('opens an empty fleet stream and reports the first machine without reconnecting', async () => {
    const fixture = await account();
    const response = await SELF.fetch(fixture.request(single('machine.events')));
    const reader = response.body!.getReader();
    try {
      const ready = await reader.read();
      expect(parse(new TextDecoder().decode(ready.value).trim())).toMatchObject({
        response: { status: 'ok', value: { type: 'ready' } },
      });
      await env.FLEET_CATALOG.getByName(fixture.userId).putMachine({
        id: 'first-machine', label: 'First machine', state: 'offline', rpcEndpoint: null,
        kind: 'physical', provider: 'physical', notes: '', desiredState: 'online',
        lifecycleRevision: 1, operationId: null, error: null,
      });
      const changed = await reader.read();
      expect(parse(new TextDecoder().decode(changed.value).trim())).toMatchObject({
        response: { status: 'ok', value: { type: 'upsert', machineId: 'first-machine' } },
      });
    } finally {
      await reader.cancel();
    }
  });

  it('keeps missing machine data from failing concurrent account queries for API clients', async () => {
    const fixture = await account(['rpc.read'], 'client');
    const content = 'modelRoles:\n  default: openai/gpt-4o\n';
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
    await env.USER_SETTINGS.getByName(fixture.userId).updateOmp('bootstrap', { expectedGeneration: 0, content, checksum: `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}` });
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set('x-gitspace-user', fixture.userId);
      return SELF.fetch(new Request(request, { headers }));
    }) as typeof fetch;
    const client = createBrowserClient({ contract: gitspaceContract, transport: createRoutedTransport({
      homeUrl: `https://${fixture.handle}.gitspace.sh/rpc`,
      fetch: createSignedRpcFetch({ deviceId: fixture.deviceId, signingPrivateKey: fixture.signingPrivateKey, fetch: fetcher }),
    }) });
    const [settings, omp, machine] = await Promise.all([
      client.settings.get({}), client.settings.omp.get({}), client.browserRelay.status({}),
    ]);
    expect(settings).toMatchObject({ status: 'ok', value: { profile: { handle: fixture.handle } } });
    expect(omp).toMatchObject({ status: 'ok', value: { document: { content }, schema: [], sync: { status: 'offline' } } });
    expect(machine.status).toBe('error');
  });

  it('does not turn a project-scoped API key into account access', async () => {
    const fixture = await account(['rpc.read'], 'client', { kind: 'project', projectId: 'project-a' });
    expect((await SELF.fetch(fixture.request(single('settings.get')))).status).toBe(403);
  });

  it('stores provider keys in the canonical broker but never discloses them in RPC views', async () => {
    const fixture = await account();
    const key = 'sk-account-rpc-secret-key';
    const saved = await SELF.fetch(fixture.request(single('providers.apiKey.set', { providerId: 'openai', key })));
    const savedBody = await saved.text();
    expect(saved.status, savedBody).toBe(200);
    expect(savedBody).not.toContain(key);
    expect(parse(savedBody)).toMatchObject({ status: 'ok', value: { provider: { id: 'openai', hasAuth: true } } });
    const snapshot = await fixture.vault.ompSnapshot();
    expect(snapshot.credentials).toMatchObject([{ provider: 'openai', credential: { type: 'api_key', key } }]);
    const logout = await SELF.fetch(fixture.request(single('providers.logout', { providerId: 'openai', credentialId: String(snapshot.credentials[0]!.id) })));
    expect(parse(await logout.text())).toMatchObject({ status: 'ok', value: { provider: { hasAuth: false, accounts: [] } } });
    expect((await fixture.vault.ompSnapshot()).credentials).toEqual([]);
  });

  it('identifies Codex sign-in aliases as one credential store without merging organization accounts', async () => {
    const fixture = await account();
    for (const orgId of ['personal', 'team']) {
      await fixture.vault.putCredential({
        id: orgId,
        credential: { provider: 'openai-codex', email: 'same@example.com', orgId, refresh: `refresh-${orgId}`, access: `access-${orgId}`, expires: Date.now() + 60_000 },
      });
    }
    const response = await SELF.fetch(fixture.request(single('providers.list')));
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = parse(body) as { status: 'ok'; value: { providers: ProviderView[] } };
    const codex = result.value.providers.find((provider) => provider.id === 'openai-codex')!;
    const device = result.value.providers.find((provider) => provider.id === 'openai-codex-device')!;
    expect(codex.credentialProvider).toBe('openai-codex');
    expect(device.credentialProvider).toBe(codex.credentialProvider);
    expect(codex.accounts.map((account) => account.label)).toEqual(['same@example.com · personal', 'same@example.com · team']);
    expect(new Set(codex.accounts.map((account) => account.id)).size).toBe(2);
    expect(device.accounts).toEqual(codex.accounts);
    expect(body).not.toContain('refresh-personal');
    expect(body).not.toContain('access-personal');
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
    const replay = signed.clone();
    expect((await SELF.fetch(signed)).status).toBe(200);
    expect((await SELF.fetch(replay)).status).toBe(409);
    const original = fixture.request(single('settings.get'));
    const tampered = new Request(original.url, { method: 'POST', headers: original.headers, body: stringify(single('devices.list')) });
    expect((await SELF.fetch(tampered)).status).toBe(401);
    await fixture.vault.revokeDeviceGrant(fixture.deviceId);
    expect((await SELF.fetch(fixture.request(single('settings.get')))).status).toBe(401);
  });
});

async function inspectorWorkspace(userId: string) {
  const projectId = `project-${crypto.randomUUID()}`;
  const spaceId = `space-${crypto.randomUUID()}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const project = await authority.bootstrap({ id: projectId, name: 'Saved inspection', repositoryReference: null, baseBranch: 'main', createdBy: 'human' });
  await env.USER_PROJECTS.getByName(userId).put(await authority.setProjectLifecycle(project.revision, 'active'));
  for (const [id, kind] of [[projectId, 'base'], [spaceId, 'worktree']] as const) {
    await authority.putWorkspace({ id, projectId, kind, name: kind === 'base' ? 'Project' : 'Review', branch: kind === 'base' ? 'main' : 'review', phase: kind === 'base' ? null : 'review', sourceKind: 'base', sourceRef: 'main', lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await env.USER_PROJECTS.getByName(userId).putWorkspaceLocation(id, projectId);
  }
  await authority.putArtifactScope({ id: `artifacts-${spaceId}`, workspaceId: spaceId, expectedGeneration: 0, generation: 0, manifestHash: null });
  const placement = env.SPACE_AUTHORITY.getByName(`${userId}:${spaceId}`);
  return { projectId, spaceId, authority, placement };
}

describe('machine-independent Inspector', () => {
  it('reads and edits unplaced canonical workspaces without making a placement or contacting a provider', async () => {
    const fixture = await account();
    const space = await inspectorWorkspace(fixture.userId);
    const providerCalls: string[] = [];
    const cloudEnv = { ...env, SANDBOX_PROVISIONER: { fetch: async (request: Request) => { providerCalls.push(request.url); throw new Error('Inspection must not contact the provider'); } } } as unknown as Env;
    const availability = await worker.fetch(fixture.request(single('inspector.availability', { projectId: space.projectId, workspaceId: space.spaceId })), cloudEnv);
    expect(parse(await availability.text())).toMatchObject({ status: 'ok', value: { runtimeAvailable: false } });
    const opened = await worker.fetch(fixture.request(single('inspector.bootstrap', { projectId: space.projectId, workspaceId: space.spaceId })), cloudEnv);
    expect(parse(await opened.text())).toMatchObject({ status: 'ok', value: { identity: { projectId: space.projectId, spaceId: space.spaceId }, placement: null, savedTranscript: { status: 'none' } } });
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
    await space.authority.putCanonicalSession({ id: 'canonical', workspaceId: space.spaceId, ompSessionId: 'canonical-omp', machineId: null, state: 'closed', sessionObjectKey: snapshotKey, sessionObjectHash: snapshotHash, sessionFormatVersion: 'omp-jsonl-1', activity: { active: false, reasons: [] }, expectedRevision: 0 });
    const published = await worker.fetch(fixture.request(single('inspector.bootstrap', { projectId: space.projectId, workspaceId: space.spaceId })), cloudEnv);
    expect(parse(await published.text())).toMatchObject({ status: 'ok', value: { checkpoint: null, savedTranscript: { status: 'available', events: [{ payload: { message: { content: 'Published canonical conversation' } } }] } } });
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
    const cloudEnv = { ...env, SANDBOX_PROVISIONER: { fetch: async (request: Request) => { providerCalls.push(request.url); throw new Error('Inspection must not wake compute'); } } } as unknown as Env;
    const catalog = env.FLEET_CATALOG.getByName(fixture.userId);
    await catalog.putMachine({ id: machineId, label: 'Stopped', kind: 'sandbox', provider: 'cloudflare-sandbox', state: 'offline', desiredState: 'online', rpcEndpoint: 'https://stopped.example/rpc', notes: '', lifecycleRevision: 3, operationId: null, error: null });
    await space.placement.bootstrap(identity);
    const availability = await worker.fetch(fixture.request(single('inspector.availability', { projectId: space.projectId, workspaceId: space.spaceId })), cloudEnv);
    expect(parse(await availability.text())).toMatchObject({ status: 'ok', value: { runtimeAvailable: false } });
    const offlineOverview = await worker.fetch(fixture.request(single('inspector.overview', { spaceId: space.spaceId, expectedGeneration: 1 })), cloudEnv);
    expect(parse(await offlineOverview.text())).toMatchObject({ status: 'ok', value: { spaceId: space.spaceId } });
    await space.placement.beginClose({ ...identity, expectedGeneration: 1 });
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
      const hash = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', sealed)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      await env.DATA.put(`users/${fixture.userId}/${objectKey}`, sealed, { customMetadata: { sha256: hash } });
      return hash;
    };
    const ompHash = await persist(spaceOmpCheckpointKey(space.projectId, space.spaceId, 1), jsonl);
    const scopeId = `artifacts-${space.spaceId}`;
    const scopeKey = await deriveArtifactScopeKey(key, scopeId);
    const publishArtifact = async (content: string) => {
      const sealed = await encryptArtifactBytes(new TextEncoder().encode(content), scopeKey);
      const hash = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', sealed)), (byte) => byte.toString(16).padStart(2, '0')).join('')}` as const;
      await env.DATA.put(`users/${fixture.userId}/accounts/${Buffer.from(fixture.userId).toString('base64url')}/artifacts/sha256/${hash.slice(7)}`, sealed, { customMetadata: { sha256: hash } });
      return hash;
    };
    const artifactHash = await publishArtifact('Cloud review evidence');
    const scopeHash = await publishArtifact(JSON.stringify({ version: 1, scopeId, generation: 1, entries: [{ path: 'review.txt', blobHash: artifactHash, size: 21, mediaType: 'text/plain' }] }));
    await space.authority.putArtifactScope({ id: scopeId, workspaceId: space.spaceId, expectedGeneration: 0, generation: 1, manifestHash: scopeHash });
    const manifestKey = spaceCheckpointManifestKey(space.projectId, space.spaceId, 1);
    const manifestHash = await persist(manifestKey, JSON.stringify({
      version: 1, projectId: space.projectId, spaceId: space.spaceId, revision: 1, previousRevision: null,
      repository: { checkpointRef: 'refs/gitspace/saved', headCommit: 'a'.repeat(40), branch: 'review', indexCommit: 'b'.repeat(40), worktreeCommit: 'c'.repeat(40) },
      agent: { sessionId, ompSessionId, ompCheckpointHash: ompHash, resumePending: false },
      artifacts: { manifestHash: `sha256:${'d'.repeat(64)}`, generation: 0 }, createdAt: at,
    }));
    await space.placement.commitClosed({ ...identity, expectedGeneration: 1, revision: 1, manifestKey, manifestHash, resumeOnMachineRestart: true });
    await space.authority.putCanonicalSession({ id: sessionId, workspaceId: space.spaceId, ompSessionId, machineId, state: 'closed', sessionObjectKey: null, sessionObjectHash: null, sessionFormatVersion: null, activity: { active: false, reasons: [] }, expectedRevision: 0 });
    const before = await space.placement.get();
    const boot = await worker.fetch(fixture.request(single('inspector.bootstrap', { projectId: space.projectId, workspaceId: space.spaceId })), cloudEnv);
    expect(parse(await boot.text())).toMatchObject({ status: 'ok', value: {
      checkpoint: { sessionId, generation: 2, revision: 1, lastMachineId: machineId },
      savedTranscript: { status: 'available', events: [
        { ordinal: 1, payload: { message: { content: 'Review the saved change' } } },
        { ordinal: 2, payload: { message: { content: 'Saved answer' } } },
      ] },
    } });
    const artifact = { spaceId: space.spaceId, expectedGeneration: 2, url: 'local://workspace/review.txt' };
    const written = await worker.fetch(fixture.request(single('inspector.artifacts.write', { ...artifact, mediaType: 'text/plain', base64: btoa('Cloud review evidence') })), cloudEnv);
    expect(parse(await written.text())).toMatchObject({ status: 'error' });
    const read = await worker.fetch(fixture.request(single('inspector.artifacts.read', artifact)), cloudEnv);
    expect(parse(await read.text())).toMatchObject({ status: 'ok', value: { text: 'Cloud review evidence', mediaType: 'text/plain' } });
    const repository = await worker.fetch(fixture.request(single('inspector.repository.tree', { spaceId: space.spaceId, expectedGeneration: 2, mode: 'working', path: null })), cloudEnv);
    expect(parse(await repository.text())).toMatchObject({ status: 'error' });
    expect(await space.placement.get()).toEqual(before);
    expect(await catalog.getMachine(machineId)).toMatchObject({ state: 'offline', desiredState: 'online', lifecycleRevision: 3 });
    expect(providerCalls).toEqual([]);
  });

  it('forwards the unchanged signed envelope only to the open online holder', async () => {
    const fixture = await account();
    const space = await inspectorWorkspace(fixture.userId);
    const machineId = 'sandbox-holder';
    await space.placement.bootstrap({ projectId: space.projectId, spaceId: space.spaceId, machineId });
    await env.FLEET_CATALOG.getByName(fixture.userId).putMachine({ id: machineId, label: 'Running', kind: 'sandbox', provider: 'cloudflare-sandbox', state: 'online', desiredState: 'online', rpcEndpoint: 'https://running.example/rpc', notes: '', lifecycleRevision: 1, operationId: null, error: null });
    const request = fixture.request(single('inspector.overview', { spaceId: space.spaceId, expectedGeneration: 1 }));
    const original = await request.clone().text();
    const attempts: string[] = [];
    const cloudEnv = { ...env, SANDBOX_PROVISIONER: { fetch: async (forwarded: Request) => {
      attempts.push(new URL(forwarded.url).pathname);
      expect(await forwarded.text()).toBe(original);
      expect(forwarded.headers.get('x-gitspace-device')).toBe(request.headers.get('x-gitspace-device'));
      expect(forwarded.headers.get('x-gitspace-signed-target')).toBe('/rpc');
      return new Response('existing live Inspector response', { status: 200 });
    } } } as unknown as Env;
    const response = await worker.fetch(request, cloudEnv);
    expect(await response.text()).toBe('existing live Inspector response');
    expect(attempts).toEqual([`/v1/sandboxes/${machineId}/rpc`]);
    expect(await space.placement.get()).toMatchObject({ state: 'open', machineId, generation: 1 });
  });
});
