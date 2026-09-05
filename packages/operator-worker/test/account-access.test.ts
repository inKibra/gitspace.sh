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

async function account(status: 'active' | 'provisioning' | 'failed' | 'missing' = 'active') {
  const root = ed25519.utils.randomSecretKey();
  const signing = ed25519.utils.randomSecretKey();
  const rootPublicKey = credentialProtocolBase64.encode(ed25519.getPublicKey(root));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(ed25519.getPublicKey(root)).buffer));
  const userId = `u-${Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const handle = `access-${crypto.randomUUID().slice(0, 8)}`;
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
  if (status !== 'missing') {
    await env.ACCOUNTS.getByName('global').upsertProvisioning({ userId, handle });
    if (status === 'active') await env.ACCOUNTS.getByName('global').markActive({ userId, release: null });
    if (status === 'failed') await env.ACCOUNTS.getByName('global').markFailed({ userId, message: 'provisioning failed' });
  }
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
    await env.ACCOUNTS.getByName('global').setStatus({ userId: a.userId, status: 'suspended', reason: 'operator hold', actor: 'operator', action: 'suspend' });
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
    const registry = env.ACCOUNTS.getByName('global');
    const id = crypto.randomUUID();
    await registry.beginSandboxRollout(id, `registry.cloudflare.com/1234/sandbox@sha256:${'a'.repeat(64)}`);
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
      await registry.beginSandboxRolloutRecovery(id, false);
      await registry.cancelSandboxRollout(id);
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

  it.each(['suspended', 'quarantined'] as const)('blocks %s A on direct APIs while active B retains access', async status => {
    const [a, b] = await Promise.all([account(), account()]);
    expect((await a.requests()).map(response => response.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
    await env.ACCOUNTS.getByName('global').setStatus({ userId: a.userId, status, reason: 'operator hold', actor: 'operator', action: status });
    for (const response of await a.requests()) {
      expect([401, 403]).toContain(response.status);
      expect(await response.json()).toMatchObject({ status: 'error', error: { code: 'ACCOUNT_UNAVAILABLE' } });
    }
    expect((await b.requests()).map(response => response.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
    const crossBroker = await SELF.fetch(`https://auth.test/omp/users/${b.userId}/v1/snapshot`, { headers: { authorization: `Bearer ${a.brokerToken}` } });
    expect(crossBroker.status).toBe(401);
    expect(await crossBroker.text()).not.toContain(`secret-${b.handle}`);
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

  it.each(['settings.get', 'artifacts.key.get'] as const)('denies missing registry authority, platform outage, and platform-only quarantine for %s', async operation => {
    const a = await account();
    const request = () => new Request('https://auth.test/v1/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed(operation)) });
    const unavailable = await worker.fetch(request(), { ...env, ACCOUNTS: { idFromName() { throw new Error('unavailable'); } } as unknown as Env['ACCOUNTS'] });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: { code: 'ACCOUNT_AUTHORITY_UNAVAILABLE' } });
    const platform = { ...env, PLATFORM_URL: 'https://authority.test', PLATFORM_BOOTSTRAP_TOKEN: 'authority-token' };
    network.use(http.get(`https://authority.test/__platform/operator/tenants/${a.handle}`, () => new HttpResponse(null, { status: 503 })));
    const outage = await worker.fetch(request(), platform);
    expect(outage.status).toBe(503);
    expect(await outage.json()).toMatchObject({ error: { code: 'ACCOUNT_AUTHORITY_UNAVAILABLE' } });
    network.use(http.get(`https://authority.test/__platform/operator/tenants/${a.handle}`, () => HttpResponse.json({ control: { status: 'active' }, credits: { status: 'quarantined' } })));
    expect(await (await worker.fetch(request(), platform)).json()).toMatchObject({ error: { code: 'ACCOUNT_UNAVAILABLE' } });
  });

  it.each(['settings', 'fleet'] as const)('ends stale %s subscriptions before disclosing another event', async kind => {
    const [a, b] = await Promise.all([account(), account()]);
    const [socketA, socketB] = await Promise.all([a.subscription(kind), b.subscription(kind)]);
    const eventA = nextSocketEvent(socketA);
    const eventB = nextSocketEvent(socketB);
    await env.ACCOUNTS.getByName('global').setStatus({ userId: a.userId, status: 'suspended', reason: 'hold', actor: 'operator', action: 'suspend' });
    for (const user of [a, b]) {
      if (kind === 'settings') {
        await env.USER_SETTINGS.getByName(user.userId).updateGitIdentity('fixture', { expectedGeneration: 0, privateKey: 'p'.repeat(64), publicKey: 'ssh-ed25519 public', fingerprint: 'SHA256:fingerprint' });
      } else {
        await env.FLEET_CATALOG.getByName(user.userId).putMachine({ id: 'machine', label: 'Machine', state: 'online', rpcEndpoint: 'https://machine.test/rpc', kind: 'physical', notes: '', provider: 'physical', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null });
      }
    }
    expect(await eventA).toEqual({ type: 'close', code: 1008 });
    expect(await eventB).toMatchObject({ type: 'message', data: expect.stringContaining(kind === 'settings' ? 'settings.changed' : 'upsert') });
    socketA.close();
    socketB.close();
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

  it('serves one private artifact key across enrolled machines and vault reconstruction, isolated from other accounts', async () => {
    const [a, b] = await Promise.all([account(), account()]);
    const otherSigning = ed25519.utils.randomSecretKey();
    await a.vault.registerDevice(signCredentialAuthorityGrant({
      ...a.grant.grant,
      machineId: 'other-machine',
      signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(otherSigning)),
      capabilities: ['space.control'],
    }, a.root));
    const registry = env.ACCOUNTS.getByName('global');
    const publicAccount = await registry.get(a.userId);
    const publicAccounts = await registry.list();
    const publicEvents = await registry.listEvents(a.userId);
    const keyRequest = (signed: SignedControlRequest) => SELF.fetch('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed),
    });
    const [first, second, foreign] = await Promise.all([
      keyRequest(a.signed('artifacts.key.get')),
      keyRequest(createSignedControlRequest({
        userId: a.userId, machineId: 'other-machine', operation: 'artifacts.key.get', payload: {}, signingPrivateKey: otherSigning,
      })),
      keyRequest(b.signed('artifacts.key.get')),
    ]);
    expect([first.status, second.status, foreign.status]).toEqual([200, 200, 200]);
    const firstBody = await first.json() as { status: string; value: { key: string } };
    const { key } = firstBody.value;
    expect(firstBody).toEqual({ status: 'ok', value: { key } });
    expect(atob(key).length).toBe(32);
    expect(btoa(atob(key))).toBe(key);
    expect(await second.json()).toEqual(firstBody);
    const foreignBody = await foreign.json() as { value: { key: string } };
    expect(foreignBody.value.key).not.toBe(key);
    expect(await (await keyRequest(a.signed('artifacts.key.get'))).json()).toEqual(firstBody);
    expect(await runInDurableObject(a.vault, (_vault, state) => new CredentialVaultDO(state, env).artifactKey(a.userId))).toBe(key);
    expect(await registry.get(a.userId)).toEqual(publicAccount);
    expect(await registry.getByHandle(a.handle)).toEqual(publicAccount);
    expect(await registry.list()).toEqual(publicAccounts);
    expect(await registry.listEvents(a.userId)).toEqual(publicEvents);
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

  it.each(['missing', 'provisioning', 'failed'] as const)('withholds artifact keys from a %s account despite a valid machine grant', async status => {
    const a = await account(status);
    const response = await SELF.fetch('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed('artifacts.key.get')),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ status: 'error', error: { code: 'ACCOUNT_UNAVAILABLE' } });
  });

  it('rejects nonempty artifact key payloads rather than honoring caller-selected account identity', async () => {
    const [a, b] = await Promise.all([account(), account()]);
    const response = await SELF.fetch('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.signed('artifacts.key.get', { userId: b.userId })),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: 'error' });
  });
});
