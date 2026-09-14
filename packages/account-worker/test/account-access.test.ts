import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  createCredentialAccessRequest, createDeviceBinding, createRelayAuthorization,
  createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant,
  signDeviceInvite, type ControlOperation, type SignedControlRequest,
} from '@gitspace/protocol';
import { describe, expect, it } from 'vitest';
import { HttpResponse, http } from 'msw';
import worker, { CredentialVaultDO } from '../src/index.js';
import { machineBrokerToken } from '../src/account-access.js';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';

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
  const brokerToken = await machineBrokerToken('test-omp-broker-token', userId, 'machine', 1);
  function signed(operation: ControlOperation, payload: Record<string, unknown> = {}) {
    return createSignedControlRequest({ userId, machineId: 'machine', operation, payload, signingPrivateKey: signing });
  }
  async function subscription(kind: 'settings' | 'fleet') {
    const proof = signed(kind === 'settings' ? 'settings.subscribe' : 'catalog.machine.subscribe');
    const control = btoa(JSON.stringify(proof)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const response = await SELF.fetch(`https://auth.test/v1/${kind}/events?control=${encodeURIComponent(control)}`, { headers: { upgrade: 'websocket' } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    return socket;
  }
  async function requests() {
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
      SELF.fetch(`https://auth.test/omp/users/${userId}/v1/snapshot`, { headers: { authorization: `Bearer ${brokerToken}` } }),
      json('/v1/devices/enroll', { invite, binding }),
      json('/v1/machines/enroll', { userId, label: 'Machine', deviceGrant: grant }, { authorization: createRelayAuthorization(root, '/v1/machines/enroll') }),
    ]);
  }
  return { userId, handle, root, signing, grant, vault, brokerToken, signed, subscription, requests };
}

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

  it('fences new work during a rollout without blocking checkpoint control reads', async () => {
    const a = await account();
    const accountState = env.ACCOUNT_STATE.getByName('account');
    const id = crypto.randomUUID();
    await accountState.beginSandboxRollout(id, `registry.cloudflare.com/1234/sandbox@sha256:${'a'.repeat(64)}`);
    try {
      for (const operation of ['space.bootstrap', 'space.beginOpen', 'catalog.sandbox.create', 'catalog.machine.resume'] as const) {
        const response = await SELF.fetch('https://auth.test/v1/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed(operation)) });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { code: 'SANDBOX_ROLLOUT_IN_PROGRESS' } });
      }
      const rpc = await SELF.fetch(`https://auth.test/__sandbox/${a.userId}/sandbox-browser/rpc`, { method: 'POST', body: '{}' });
      expect(rpc.status).toBe(503);
      const settings = await SELF.fetch('https://auth.test/v1/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed('settings.get')) });
      expect(settings.status).toBe(200);
    } finally {
      await accountState.beginSandboxRolloutRecovery(id, false);
      await accountState.cancelSandboxRollout(id);
    }
  });

  it('binds space ownership to the signing machine rather than a payload impersonation', async () => {
    const a = await account();
    const spaceId = `signed-space-${crypto.randomUUID()}`;
    const response = await SELF.fetch('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(a.signed('space.bootstrap', { projectId: 'project', spaceId, machineId: 'impersonated-machine' })),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', value: { machineId: 'machine' } });
  });

  it.each(['suspended', 'quarantined'] as const)('blocks %s tenant access on direct APIs', async status => {
    const a = await account();
    expect((await a.requests()).map(response => response.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
    platformState(status);
    for (const response of await a.requests()) {
      expect([401, 403]).toContain(response.status);
      expect(await response.json()).toMatchObject({ status: 'error', error: { code: 'ACCOUNT_UNAVAILABLE' } });
    }
  });

  it('revokes every credential broker route at the machine generation without disabling another machine', async () => {
    const a = await account();
    const url = `https://auth.test/omp/users/${a.userId}/v1`;
    const get = (token: string) => SELF.fetch(`${url}/snapshot`, { headers: { authorization: `Bearer ${token}` } });
    expect((await get(a.brokerToken)).status).toBe(200);
    await a.vault.registerDevice(signCredentialAuthorityGrant({ ...a.grant.grant, machineId: 'other-machine' }, a.root));
    const otherToken = await machineBrokerToken('test-omp-broker-token', a.userId, 'other-machine', 1);
    await a.vault.removeManagedDevice('machine');
    for (const [path, method] of [['snapshot', 'GET'], ['snapshot/stream', 'GET'], ['usage', 'GET'], ['credential/1/refresh', 'POST'], ['credential', 'POST'], ['credential/1/disable', 'POST']] as const) {
      const response = await SELF.fetch(`${url}/${path}`, { method, headers: { authorization: `Bearer ${a.brokerToken}` } });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(`secret-${a.handle}`);
    }
    expect((await get(otherToken)).status).toBe(200);
    await a.vault.registerDevice(signCredentialAuthorityGrant({ ...a.grant.grant, generation: 2 }, a.root));
    expect((await get(a.brokerToken)).status).toBe(401);
    expect((await get(a.brokerToken.replace('.1.', '.2.'))).status).toBe(401);
    expect((await get(await machineBrokerToken('test-omp-broker-token', a.userId, 'machine', 2))).status).toBe(200);
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
    const crossBroker = await SELF.fetch(`https://auth.test/omp/users/${foreignUserId}/v1/snapshot`, { headers: { authorization: `Bearer ${a.brokerToken}` } });
    expect(crossBroker.status).toBe(401);
    expect(await crossBroker.text()).not.toContain(`secret-${a.handle}`);
    expect((await a.requests()).map(response => response.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
  });

  it.each(['settings.get', 'artifacts.key.get'] as const)('allows active tenant control but still denies revoked devices for %s', async operation => {
    const a = await account();
    const platform = { ...env, PLATFORM_URL: 'https://authority.test', PLATFORM_TOKEN: 'authority-token' };
    network.use(
      http.get(`https://authority.test/__platform/tenants/${env.TENANT_ID}/state`, ({ request }) => request.headers.get('authorization') === 'Bearer authority-token'
        ? HttpResponse.json({ control: { status: 'active' } })
        : new HttpResponse(null, { status: 401 })),
    );
    const response = await worker.fetch(new Request('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed(operation)),
    }), platform);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
    await a.vault.removeManagedDevice('machine');
    const revoked = await worker.fetch(new Request('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed(operation)),
    }), platform);
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ status: 'error' });
  });

  it.each(['settings.get', 'artifacts.key.get'] as const)('fails closed on missing, unavailable, or malformed platform access authority for %s', async operation => {
    const a = await account();
    const platform = { ...env, PLATFORM_URL: 'https://authority.test', PLATFORM_TOKEN: 'authority-token' };
    network.use(http.get(`https://authority.test/__platform/tenants/${env.TENANT_ID}/state`, ({ request }) => request.headers.get('authorization') === 'Bearer authority-token'
      ? HttpResponse.json({ control: { status: 'active' } })
      : new HttpResponse(null, { status: 401 })));
    const missingToken = await worker.fetch(new Request('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed(operation)),
    }), { ...platform, PLATFORM_TOKEN: '' });
    expect(missingToken.status).toBe(503);
    expect(await missingToken.json()).toMatchObject({ error: { code: 'ACCOUNT_AUTHORITY_UNAVAILABLE' } });
    for (const result of [
      () => new HttpResponse(null, { status: 404 }),
      () => new HttpResponse(null, { status: 503 }),
      () => HttpResponse.error(),
      () => new HttpResponse('not JSON'),
      () => HttpResponse.json(null),
      () => HttpResponse.json({}),
    ]) {
      network.use(http.get(`https://authority.test/__platform/tenants/${env.TENANT_ID}/state`, result));
      const response = await worker.fetch(new Request('https://auth.test/v1/control', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed(operation)),
      }), platform);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'ACCOUNT_AUTHORITY_UNAVAILABLE' } });
    }
    network.use(http.get(`https://authority.test/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: ['active'] } })));
    const malformedControl = await worker.fetch(new Request('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed(operation)),
    }), platform);
    expect(malformedControl.status).toBe(403);
    expect(await malformedControl.json()).toMatchObject({ error: { code: 'ACCOUNT_UNAVAILABLE' } });
  });

  it.each(['settings', 'fleet'] as const)('ends stale %s subscriptions before disclosing another event', async kind => {
    const a = await account();
    const socket = await a.subscription(kind);
    const activeEvent = nextSocketEvent(socket);
    if (kind === 'settings') {
      await env.USER_SETTINGS.getByName(a.userId).updateGitIdentity('fixture', { expectedGeneration: 0, privateKey: 'p'.repeat(64), publicKey: 'ssh-ed25519 public', fingerprint: 'SHA256:fingerprint' });
    } else {
      await env.FLEET_CATALOG.getByName(a.userId).putMachine({ id: 'machine', label: 'Machine', state: 'online', rpcEndpoint: 'https://machine.test/rpc', kind: 'physical', notes: '', provider: 'physical', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null });
    }
    expect(await activeEvent).toMatchObject({ type: 'message', data: expect.stringContaining(kind === 'settings' ? 'settings.changed' : 'upsert') });
    const suspendedEvent = nextSocketEvent(socket);
    platformState('suspended');
    if (kind === 'settings') {
      await env.USER_SETTINGS.getByName(a.userId).updateGitIdentity('fixture', { expectedGeneration: 1, privateKey: 'q'.repeat(64), publicKey: 'ssh-ed25519 updated', fingerprint: 'SHA256:updated' });
    } else {
      await env.FLEET_CATALOG.getByName(a.userId).putMachine({ id: 'machine', label: 'Updated machine', state: 'online', rpcEndpoint: 'https://machine.test/rpc', kind: 'physical', notes: '', provider: 'physical', desiredState: 'online', lifecycleRevision: 2, operationId: null, error: null });
    }
    expect(await suspendedEvent).toEqual({ type: 'close', code: 1008 });
    socket.close();
  });

  it('does not revive an established socket when the same machine key is reenrolled at a new generation', async () => {
    const a = await account();
    const socket = await a.subscription('settings');
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

  it('does not turn storage access into secret administration or plaintext access', async () => {
    const a = await account();
    await a.vault.registerDevice(signCredentialAuthorityGrant({
      ...a.grant.grant, machineId: 'storage-only', capabilities: ['storage.access'],
    }, a.root));
    for (const operation of ['secrets.account.put', 'secrets.account.grant', 'secrets.account.revoke', 'secrets.materialize'] as const) {
      const proof = createSignedControlRequest({
        userId: a.userId, machineId: 'storage-only', operation,
        payload: { projectId: 'project', name: 'TOKEN', value: 'secret', workspaceId: null, names: ['TOKEN'], projectSpaceEnabled: true, workspacesEnabled: true },
        signingPrivateKey: a.signing,
      });
      const response = await SELF.fetch('https://auth.test/v1/control', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proof),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ status: 'error' });
    }
    const proof = a.signed('secrets.account.grant', { projectId: 'project', name: 'TOKEN', projectSpaceEnabled: true, workspacesEnabled: true });
    const response = await SELF.fetch('https://auth.test/v1/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proof) });
    expect(response.status).toBe(401);
  });

  it('requires space.control and a valid unreplayed machine signature for artifact keys', async () => {
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
    expect((await keyRequest(proof)).status).toBe(401);
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
