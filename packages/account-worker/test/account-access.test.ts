import { persistPortableCheckpoint } from './portable-checkpoint-fixture.js';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  CONTROL_SOCKET_PROTOCOL, createCredentialAccessRequest, createDeviceBinding, createRelayAuthorization,
  createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant,
  signDeviceInvite, type ControlOperation, type SignedControlRequest,
} from '@gitspace/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HttpResponse, http } from 'msw';
import { CredentialVaultDO } from '../src/index.js';
import { AccountStateDO } from '../src/account-state.js';
import { invalidateDeviceAuthority } from '../src/device-authority.js';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';

afterEach(() => vi.restoreAllMocks());
function platformState(status: string) {
  network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status } })));
}

async function account() {
  const root = tenantRootPrivateKey;
  const signing = ed25519.utils.randomSecretKey();
  const rootPublicKey = credentialProtocolBase64.encode(ed25519.getPublicKey(root));
  const userId = env.ACCOUNT_ID;
  const handle = env.TENANT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey, vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const grant = signCredentialAuthorityGrant({
    version: 1, userId, machineId: 'machine', generation: 1,
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signing)),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(x25519.utils.randomSecretKey())),
    capabilities: ['space.control', 'storage.access', 'credential.access'],
  }, root);
  await vault.registerDevice(grant);
  await vault.putCredential({ id: 'primary', credential: { provider: 'openai-codex', access: `secret-${handle}`, refresh: 'refresh-secret', expires: Date.now() + 3_600_000 } });
  await env.USER_SETTINGS.getByName(userId).setHandle('fixture', 0, handle);
  await env.DATA.put(`users/${userId}/private`, `data-${handle}`);
  function signed(operation: ControlOperation, payload: Record<string, unknown> = {}) {
    return createSignedControlRequest({ userId, machineId: 'machine', operation, payload, signingPrivateKey: signing });
  }
  async function subscription() {
    const proof = signed('settings.subscribe');
    const control = btoa(JSON.stringify(proof)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const response = await SELF.fetch('https://auth.test/v1/settings/events', { headers: { upgrade: 'websocket', 'sec-websocket-protocol': `${CONTROL_SOCKET_PROTOCOL}${control}` } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    return socket;
  }
  async function requests() {
    await vault.ensureInference();
    const invite = signDeviceInvite({
      version: 1, userId, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' },
      capabilities: ['rpc.read'], canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'https://auth.test',
    }, root);
    const deviceKey = ed25519.utils.randomSecretKey();
    const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(deviceKey)), label: 'Browser', boundAt: Date.now(), signingPrivateKey: deviceKey });
    const json = (path: string, body: unknown, headers: Record<string, string> = {}) => SELF.fetch(`https://auth.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return Promise.all([
      json('/v1/control', signed('settings.get')),
      json('/v1/control', signed('artifacts.key.get')),
      SELF.fetch('https://auth.test/v1/data/private', { headers: { 'x-gitspace-control': btoa(JSON.stringify(signed('data.get', { key: 'private' }))) } }),
      json(`/v1/users/${userId}/credentials/primary/access`, createCredentialAccessRequest({ userId, machineId: 'machine', credentialId: 'primary', signingPrivateKey: signing })),
      json('/v1/devices/enroll', { invite, binding }),
      json('/v1/machines/enroll', { userId, label: 'Machine', deviceGrant: grant }, { authorization: createRelayAuthorization(root, '/v1/machines/enroll') }),
    ]);
  }
  return { userId, handle, root, signing, grant, vault, signed, subscription, requests };
}

it('serves startup catalog snapshots without waiting for or changing provider readiness', async () => {
  const fixture = await account();
  const catalog = env.FLEET_CATALOG.getByName(fixture.userId);
  const machine = { id: 'sandbox-restarting', label: 'Restarting', kind: 'sandbox' as const, provider: 'cloudflare-sandbox' as const, state: 'resuming' as const, desiredState: 'online' as const, rpcEndpoint: '/rpc', notes: '', lifecycleRevision: 3, operationId: 'restart', error: null };
  await catalog.putMachine(machine);
  let providerRequests = 0;
  network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/*`, () => {
    providerRequests += 1;
    return HttpResponse.json({ status: 'error', error: 'Provider is not ready' }, { status: 503 });
  }));
  const response = await SELF.fetch('https://auth.test/v1/control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fixture.signed('catalog.machine.list')),
  });
  expect(await response.json()).toMatchObject({ status: 'ok', value: [machine] });
  expect(await catalog.getMachine(machine.id)).toEqual(machine);
  expect(providerRequests).toBe(0);
});

it('keeps signed machine lifecycle mutations scoped and unable to self-approve execution', async () => {
  const fixture = await account();
  const projectId = 'lifecycle-project';
  const spaceId = 'lifecycle-workspace';
  const authority = env.PROJECT_AUTHORITY.getByName(`${fixture.userId}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Lifecycle', repositoryReference: null, baseBranch: 'main', createdBy: 'machine' });
  await authority.putWorkspace({ id: spaceId, projectId, kind: 'worktree', name: 'Lifecycle', branch: 'main', phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const request = (operation: ControlOperation, payload: Record<string, unknown>) => SELF.fetch('https://auth.test/v1/control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fixture.signed(operation, payload)),
  });
  const denied = await request('project.environment.mutate', { projectId, spaceId, input: { op: 'approval', scope: 'project', executionHash: `sha256:${'a'.repeat(64)}`, approved: true } });
  expect(await denied.json()).toMatchObject({ status: 'error' });
  expect((await authority.getLifecycleState(spaceId)).approvals).toEqual([]);
  const foreign = await request('project.environment.get', { projectId, spaceId: 'another-project-workspace' });
  expect(await foreign.json()).toMatchObject({ status: 'error' });
  const saved = await request('project.environment.mutate', { projectId, spaceId, input: { op: 'value', scope: 'global', name: 'REGION', value: 'west' } });
  expect(await saved.json()).toMatchObject({ status: 'ok', value: { values: { global: { REGION: 'west' } } } });
  expect(await env.USER_PROJECTS.getByName(fixture.userId).getEnvironmentValues()).toEqual({ REGION: 'west' });
  await env.FLEET_CATALOG.getByName(fixture.userId).putMachine({ id: 'machine', label: 'Machine', kind: 'physical', provider: 'physical', state: 'online', desiredState: 'online', rpcEndpoint: '/rpc', notes: '', lifecycleRevision: 1, operationId: null, error: null });
  const stale = await request('project.environment.mutate', { projectId, spaceId, input: { op: 'claim', runId: 'stale', phase: 'workspace/materialize', profile: 'base', executionHashes: [], generation: 99, rerun: false } });
  expect(await stale.json()).toMatchObject({ status: 'error' });
  expect((await authority.getLifecycleState(spaceId)).runs).toEqual([]);
  const detachedCheckout = await request('project.environment.mutate', { projectId, spaceId, input: { op: 'claim', runId: 'detached-checkout', phase: 'workspace/materialize', profile: 'base', executionHashes: [], generation: null, rerun: false } });
  expect(await detachedCheckout.json()).toMatchObject({ status: 'error' });
  const detachedPreparation = await request('project.environment.mutate', { projectId, spaceId, input: { op: 'claim', runId: 'detached-prepare', phase: 'machine/prepare', profile: 'base', executionHashes: [], generation: null, rerun: false } });
  expect(await detachedPreparation.json()).toMatchObject({ status: 'ok', value: { claim: { status: 'claimed' }, runs: [{ phase: 'machine/prepare', machineId: 'machine', generation: null }] } });
});

function nextSocketEvent(socket: WebSocket): Promise<{ type: 'close' | 'message'; data?: string; code?: number }> {
  const { promise, resolve } = Promise.withResolvers<{ type: 'close' | 'message'; data?: string; code?: number }>();
  const message = (event: MessageEvent) => { socket.removeEventListener('close', close); resolve({ type: 'message', data: String(event.data) }); };
  const close = (event: CloseEvent) => { socket.removeEventListener('message', message); resolve({ type: 'close', code: event.code }); };
  socket.addEventListener('message', message, { once: true });
  socket.addEventListener('close', close, { once: true });
  return promise;
}

describe('account lifecycle authorization', () => {
  it('serves cached account state between refreshes, then fails closed once its authority lapses and recovers', async () => {
    const a = await account();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    let reads = 0;
    let available = true;
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => {
      reads++;
      return available ? HttpResponse.json({ control: { status: 'active' } }) : new HttpResponse(null, { status: 503 });
    }));
    const request = () => SELF.fetch('https://auth.test/v1/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed('settings.get')) });
    expect((await request()).status).toBe(200);
    available = false;
    clock.mockReturnValue(now + 15_001);
    // Requests read the isolate's snapshot; none reaches the account authority.
    expect((await Promise.all(Array.from({ length: 5 }, request))).map(response => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(reads).toBe(1);
    // The next refresh after the platform observation lapses carries the outage.
    clock.mockReturnValue(now + 60_001);
    invalidateDeviceAuthority();
    const expired = await request();
    expect(expired.status).toBe(503);
    expect(await expired.json()).toMatchObject({ error: { code: 'ACCOUNT_AUTHORITY_UNAVAILABLE' } });
    available = true;
    clock.mockReturnValue(now + 65_002);
    invalidateDeviceAuthority();
    expect((await request()).status).toBe(200);
  });

  it('preserves the authority deadline across reconstruction and rejects a different tenant cache', async () => {
    const state = env.ACCOUNT_STATE.getByName('account');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(await state.authorization(env.ACCOUNT_ID)).toEqual({ status: 'active', checkedAt: now, refreshAt: now + 15_000, expiresAt: now + 60_000 });
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => new HttpResponse(null, { status: 503 })));
    expect(await runInDurableObject(state, (_instance, context) => new AccountStateDO(context, env).authorization(env.ACCOUNT_ID))).toEqual({ status: 'active', checkedAt: now, refreshAt: now + 15_000, expiresAt: now + 60_000 });
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/different-tenant/state`, () => new HttpResponse(null, { status: 503 })));
    expect(await runInDurableObject(state, (_instance, context) => new AccountStateDO(context, { ...env, TENANT_ID: 'different-tenant' }).authorization(env.ACCOUNT_ID))).toEqual({ status: 'unavailable' });
    clock.mockReturnValue(now + 60_001);
    expect(await runInDurableObject(state, (_instance, context) => new AccountStateDO(context, env).authorization(env.ACCOUNT_ID))).toEqual({ status: 'unavailable' });
  });

  it('never grants an uninitialized tenant authority during a platform outage', async () => {
    const a = await account();
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => new HttpResponse(null, { status: 503 })));
    const response = await SELF.fetch('https://auth.test/v1/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed('settings.get')) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'ACCOUNT_AUTHORITY_UNAVAILABLE' } });
  });

  it('does not let a warm authority cache bypass tenant ownership, signatures, or device revocation', async () => {
    const a = await account();
    const request = (proof: SignedControlRequest) => SELF.fetch('https://auth.test/v1/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proof) });
    expect((await request(a.signed('settings.get'))).status).toBe(200);
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => new HttpResponse(null, { status: 503 })));
    expect((await request(a.signed('settings.get'))).status).toBe(200);
    expect((await request({ ...a.signed('settings.get'), userId: `u-${'0'.repeat(32)}` })).status).not.toBe(200);
    expect((await request({ ...a.signed('settings.get'), signature: credentialProtocolBase64.encode(new Uint8Array(64)) })).status).toBe(401);
    await a.vault.removeManagedDevice('machine');
    expect((await request(a.signed('settings.get'))).status).toBe(401);
  });
  it('allows signed RPC preflight while exposing account suspension to the browser', async () => {
    const a = await account();
    platformState('suspended');
    const url = `https://auth.test/__sandbox/${a.userId}/sandbox-browser/rpc`;
    const origin = `https://${a.handle}.gitspace.sh`;
    const preflight = await SELF.fetch(url, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-gitspace-device,x-gitspace-user' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-gitspace-device');
    const denied = await SELF.fetch(url, { method: 'POST', headers: { origin }, body: '{}' });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBe('*');
    expect(await denied.json()).toMatchObject({ error: { code: 'ACCOUNT_UNAVAILABLE' } });
  });

  it.each(['suspended', 'quarantined'] as const)('blocks %s tenant access on direct APIs', async status => {
    const a = await account();
    expect((await a.requests()).map(response => response.status)).toEqual([200, 200, 200, 401, 200, 200]);
    platformState(status);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15_001);
    invalidateDeviceAuthority();
    for (const response of await a.requests()) {
      expect([401, 403]).toContain(response.status);
      expect(await response.json()).toMatchObject({ status: 'error', error: { code: 'ACCOUNT_UNAVAILABLE' } });
    }
  });


  it('rejects foreign account identities at this tenant without exposing its credentials', async () => {
    const a = await account();
    const foreignUserId = `u-${'0'.repeat(32)}`;
    const credential = await SELF.fetch(`https://auth.test/v1/users/${foreignUserId}/credentials/primary/access`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createCredentialAccessRequest({ userId: foreignUserId, machineId: 'machine', credentialId: 'primary', signingPrivateKey: a.signing })),
    });
    expect(credential.status).toBe(403);
    expect(await credential.json()).toMatchObject({ error: { code: 'ACCOUNT_UNAVAILABLE' } });
    expect((await a.requests()).map(response => response.status)).toEqual([200, 200, 200, 401, 200, 200]);
  });

  it('resolves an assigned profile credential only for that profile, after the machine is gone', async () => {
    const a = await account();
    const created = await a.vault.createInferenceProfile({ name: 'Managed', sourceProfileId: null });
    const profileId = created.profiles.find(profile => profile.id !== 'default')!.id;
    const projectId = 'bound-project';
    const authority = env.PROJECT_AUTHORITY.getByName(`${a.userId}:${projectId}`);
    await env.USER_PROJECTS.getByName(a.userId).put(await authority.bootstrap({ id: projectId, name: 'Bound', baseBranch: 'main', repositoryReference: null, createdBy: 'machine' }));
    await a.vault.assignInferenceProfile({ projectId, profileId, expectedRevision: 0 });
    await a.vault.putBrowserApiKey(profileId, 'openai', 'bound-project-key');
    await a.vault.removeManagedDevice('machine');
    const resolved = await a.vault.resolveCloudInference(projectId);
    expect(resolved).toMatchObject({ projectId, assignmentRevision: 1, profile: { id: profileId } });
    const [credential] = await a.vault.cloudCredentialAccounts(profileId, 'openai');
    if (!credential) throw new Error('Expected the admitted profile credential');
    expect(await a.vault.cloudResolveCredential({ profileId, credentialId: credential.id })).toMatchObject({ credential: { type: 'api_key', key: 'bound-project-key' } });
    const denial = await runInDurableObject(a.vault, async instance => {
      try { await instance.cloudResolveCredential({ profileId: 'default', credentialId: credential.id }); return null; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    });
    expect(denial).toBe('Credential is unavailable');
    await a.vault.cloudSetApiKey({ profileId, providerId: 'openai', key: 'managed-update' });
    expect(await a.vault.cloudResolveCredential({ profileId, credentialId: credential.id })).toMatchObject({ credential: { type: 'api_key', key: 'managed-update' } });
    const providers = await a.vault.cloudProviders(profileId);
    expect(providers.find(provider => provider.id === 'openai')).toMatchObject({ hasAuth: true });
    expect(JSON.stringify(providers)).not.toContain('managed-update');
  });


  it.each(['settings.get', 'artifacts.key.get'] as const)('allows active tenant control but still denies revoked devices for %s', async operation => {
    const a = await account();
    const response = await SELF.fetch('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed(operation)),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
    await a.vault.removeManagedDevice('machine');
    const revoked = await SELF.fetch('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed(operation)),
    });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ status: 'error' });
  });

  it.each(['settings.get', 'artifacts.key.get'] as const)('fails closed on missing, unavailable, or malformed platform access authority for %s', async operation => {
    const a = await account();
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    for (const result of [
      () => new HttpResponse(null, { status: 401 }),
      () => new HttpResponse(null, { status: 404 }),
      () => new HttpResponse(null, { status: 503 }),
      () => HttpResponse.error(),
      () => new HttpResponse('not JSON'),
      () => HttpResponse.json(null),
      () => HttpResponse.json({}),
      () => HttpResponse.json({ control: { status: ['active'] } }),
    ]) {
      clock.mockReturnValue(now += 5_001);
      network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, result));
      invalidateDeviceAuthority();
      const response = await SELF.fetch('https://auth.test/v1/control', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed(operation)),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'ACCOUNT_AUTHORITY_UNAVAILABLE' } });
    }
  });

  it('ends stale settings subscriptions before disclosing another event', async () => {
    const a = await account();
    const socket = await a.subscription();
    const activeEvent = nextSocketEvent(socket);
    await env.USER_SETTINGS.getByName(a.userId).updateGitIdentity('fixture', { expectedGeneration: 0, privateKey: 'p'.repeat(64), publicKey: 'ssh-ed25519 public', fingerprint: 'SHA256:fingerprint' });
    expect(await activeEvent).toMatchObject({ type: 'message', data: expect.stringContaining('settings.changed') });
    const suspendedEvent = nextSocketEvent(socket);
    platformState('suspended');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15_001);
    invalidateDeviceAuthority();
    await env.USER_SETTINGS.getByName(a.userId).updateGitIdentity('fixture', { expectedGeneration: 1, privateKey: 'q'.repeat(64), publicKey: 'ssh-ed25519 updated', fingerprint: 'SHA256:updated' });
    expect(await suspendedEvent).toEqual({ type: 'close', code: 1008 });
    socket.close();
  });

  it('does not revive an established socket when the same machine key is reenrolled at a new generation', async () => {
    const a = await account();
    const socket = await a.subscription();
    const next = nextSocketEvent(socket);
    await a.vault.removeManagedDevice('machine');
    expect(await a.vault.registerDevice(a.grant)).toMatchObject({ status: 'error', error: { code: 'STALE_DEVICE_GRANT' } });
    await a.vault.registerDevice(signCredentialAuthorityGrant({ ...a.grant.grant, generation: 2 }, a.root));
    socket.send('ping');
    expect(await next).toEqual({ type: 'close', code: 1008 });
    socket.close();
  });

  it('serves one private artifact key across enrolled machines and vault reconstruction, rejecting foreign identities', async () => {
    const a = await account();
    const otherSigning = ed25519.utils.randomSecretKey();
    await a.vault.registerDevice(signCredentialAuthorityGrant({
      ...a.grant.grant,
      machineId: 'other-machine',
      signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(otherSigning)),
      capabilities: ['space.control'],
    }, a.root));
    const keyRequest = (signed: SignedControlRequest) => SELF.fetch('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed),
    });
    const [first, second, foreign] = await Promise.all([
      keyRequest(a.signed('artifacts.key.get')),
      keyRequest(createSignedControlRequest({
        userId: a.userId, machineId: 'other-machine', operation: 'artifacts.key.get', payload: {}, signingPrivateKey: otherSigning,
      })),
      keyRequest(createSignedControlRequest({
        userId: `u-${'0'.repeat(32)}`, machineId: 'machine', operation: 'artifacts.key.get', payload: {}, signingPrivateKey: a.signing,
      })),
    ]);
    expect([first.status, second.status, foreign.status]).toEqual([200, 200, 401]);
    const firstBody = await first.json() as { status: string; value: { key: string } };
    const { key } = firstBody.value;
    expect(firstBody).toEqual({ status: 'ok', value: { key } });
    expect(atob(key).length).toBe(32);
    expect(btoa(atob(key))).toBe(key);
    expect(await second.json()).toEqual(firstBody);
    expect(await foreign.text()).not.toContain(key);
    expect(await (await keyRequest(a.signed('artifacts.key.get'))).json()).toEqual(firstBody);
    expect(await runInDurableObject(a.vault, (_vault, state) => new CredentialVaultDO(state, env).artifactKey(a.userId))).toBe(key);
  });

  it('does not turn storage access into plaintext secret access', async () => {
    const a = await account();
    await a.vault.registerDevice(signCredentialAuthorityGrant({
      ...a.grant.grant, machineId: 'storage-only', capabilities: ['storage.access'],
    }, a.root));
    const proof = createSignedControlRequest({
      userId: a.userId, machineId: 'storage-only', operation: 'secrets.materialize',
      payload: { projectId: 'project', workspaceId: null, names: ['TOKEN'] },
      signingPrivateKey: a.signing,
    });
    const response = await SELF.fetch('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proof),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ status: 'error' });
  });

  it('requires space.control and a valid machine signature for artifact keys', async () => {
    const a = await account();
    await a.vault.registerDevice(signCredentialAuthorityGrant({
      ...a.grant.grant, machineId: 'storage-only', capabilities: ['storage.access'],
    }, a.root));
    const keyRequest = (signed: SignedControlRequest) => SELF.fetch('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed),
    });
    const storageOnly = createSignedControlRequest({
      userId: a.userId, machineId: 'storage-only', operation: 'artifacts.key.get', payload: {}, signingPrivateKey: a.signing,
    });
    const denied = await keyRequest(storageOnly);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ status: 'error' });
    const proof = a.signed('artifacts.key.get');
    const tampered = await keyRequest({ ...proof, signature: credentialProtocolBase64.encode(new Uint8Array(64)) });
    expect(tampered.status).toBe(401);
    const accepted = await keyRequest(proof);
    expect(accepted.status).toBe(200);
    await a.vault.removeManagedDevice('machine');
    expect((await keyRequest(a.signed('artifacts.key.get'))).status).toBe(401);
  });

  it.each(['provisioning', 'failed', 'unknown'] as const)('withholds artifact keys when platform control is %s despite a valid machine grant', async status => {
    const a = await account();
    platformState(status);
    const response = await SELF.fetch('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed('artifacts.key.get')),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ status: 'error', error: { code: 'ACCOUNT_UNAVAILABLE' } });
  });

  it('rejects nonempty artifact key payloads rather than honoring caller-selected account identity', async () => {
    const a = await account();
    const response = await SELF.fetch('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed('artifacts.key.get', { userId: `u-${'0'.repeat(32)}` })),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: 'error' });
  });
});
