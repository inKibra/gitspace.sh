import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, credentialProtocolBase64, signDeviceInvite, signRpcRequest, type DeviceCapability, type DeviceScope } from '@gitspace/protocol';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { tenantRootPrivateKey } from './setup.js';
import worker from '../src/index.js';

async function browserDevice(capabilities: DeviceCapability[], scope: DeviceScope = { kind: 'user' }) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(71)) });
  const invite = signDeviceInvite({ version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope, capabilities, canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'https://api.gitspace.sh' }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(key)), label: 'Browser', boundAt: Date.now(), signingPrivateKey: key });
  const enrolled = await vault.enrollDevice({ invite, binding });
  if (enrolled.status !== 'ok') throw new Error(enrolled.error.message);
  return { deviceId: binding.deviceId, signTunnel(path: string, method: string, body = new Uint8Array(), timestamp = Date.now()) {
    return signRpcRequest({ deviceId: binding.deviceId, signingPrivateKey: key, method, path, body, timestamp });
  }, tunnel(path: string, method: string, body = new Uint8Array()) {
    return exports.default.fetch(new Request(new URL(path, env.ACCOUNT_URL), {
      method, ...(method === 'GET' ? {} : { body }),
      headers: { 'x-gitspace-device': signRpcRequest({ deviceId: binding.deviceId, signingPrivateKey: key, method, path, body }) },
    }));
  }, async request(path: string, input: unknown = {}) {
    const body = new TextEncoder().encode(JSON.stringify(input));
    return exports.default.fetch(new Request(new URL(path, env.ACCOUNT_URL), { method: 'POST', body, headers: { origin: new URL(env.ACCOUNT_URL).origin, 'x-gitspace-device': signRpcRequest({ deviceId: binding.deviceId, signingPrivateKey: key, method: 'POST', path, body }) } }));
  } };
}

async function serviceSession() {
  const device = await browserDevice(['rpc.read', 'rpc.write']);
  const hostname = `web--space-a--${env.TENANT_ID}-srv.gssh.dev`;
  await env.HOSTED_ROUTES.getByName(hostname).lease(env.ACCOUNT_ID, { hostname, workspaceId: 'space-a', serviceName: 'web', machineId: 'offline-machine', ingress: 'http://127.0.0.1:3000', portName: 'http', port: 3000, generation: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'healthy', updatedAt: new Date().toISOString() });
  const relay = env.RELAY.getByName(env.RELAY_NAME);
  const state = crypto.randomUUID();
  const ticket = await relay.serviceApprove({ hostname, deviceId: device.deviceId, state, returnTo: '/' });
  const session = await relay.serviceRedeem(ticket, hostname, state);
  if (!session) throw new Error('Session not created');
  return { hostname, cookie: `__Host-gitspace-service=${session.token}` };
}

describe('service browser request isolation', () => {
  it('rejects same-site foreign Origin POSTs and WebSocket upgrades despite a valid host cookie', async () => {
    const { hostname, cookie } = await serviceSession();
    for (const request of [
      new Request(`https://${hostname}/private`, { method: 'POST', headers: { cookie, origin: 'https://attacker.gssh.dev', 'sec-fetch-site': 'same-site' } }),
      new Request(`https://${hostname}/socket`, { headers: { cookie, origin: 'https://attacker.gssh.dev', upgrade: 'websocket' } }),
    ]) expect((await exports.default.fetch(request)).status).toBe(403);
  });
  it('fails closed on missing or opaque origin unless Fetch Metadata proves same-origin', async () => {
    const { hostname, cookie } = await serviceSession();
    const rejected: Record<string, string>[] = [{}, { origin: 'null' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }];
    for (const headers of rejected) {
      expect((await exports.default.fetch(new Request(`https://${hostname}/private`, { method: 'POST', headers: { cookie, ...headers } }))).status).toBe(403);
    }
    const accepted: Record<string, string>[] = [{ origin: `https://${hostname}` }, { 'sec-fetch-site': 'same-origin' }];
    for (const headers of accepted) {
      expect((await exports.default.fetch(new Request(`https://${hostname}/private`, { method: 'POST', headers: { cookie, ...headers } }))).status).toBe(503);
    }
  });
  it('does not serve public tunnel content to an unsigned browser', async () => {
    expect((await exports.default.fetch(new Request('https://relay.test/tunnel/offline-machine/page'))).status).toBe(401);
  });
  it('admits signed project and workspace tunnel GETs without widening account RPC scope', async () => {
    const scopes: DeviceScope[] = [{ kind: 'project', projectId: 'project-a' }, { kind: 'workspace', workspaceId: 'space-a' }];
    for (const scope of scopes) {
      const device = await browserDevice(['rpc.read'], scope);
      const response = await device.tunnel('/tunnel/offline-machine/page?view=1', 'GET');
      expect(response.status).toBe(503);
      expect(await response.text()).toContain('MACHINE_OFFLINE');
      expect((await device.request('/api/browser-relay/status')).status).toBe(403);
    }
  });
  it('admits a signed tunnel upload larger than the account RPC body cap', async () => {
    const device = await browserDevice(['rpc.read']);
    const response = await device.tunnel('/tunnel/offline-machine/upload', 'PUT', new Uint8Array(512 * 1024 + 1).fill(17));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('MACHINE_OFFLINE');
  });
  it.each(['malformed', 'unknown', 'expired', 'forged'] as const)('rejects %s upload authority before reading the body', async reason => {
    const device = await browserDevice(['rpc.read']);
    const path = '/tunnel/offline-machine/upload';
    const header = reason === 'malformed' ? 'not-a-device-signature'
      : reason === 'unknown' ? signRpcRequest({ deviceId: crypto.randomUUID(), signingPrivateKey: crypto.getRandomValues(new Uint8Array(32)), method: 'PUT', path, body: new Uint8Array() })
      : reason === 'forged' ? signRpcRequest({ deviceId: device.deviceId, signingPrivateKey: crypto.getRandomValues(new Uint8Array(32)), method: 'PUT', path, body: new Uint8Array() })
      : device.signTunnel(path, 'PUT', new Uint8Array(), Date.now() - 10 * 60_000);
    let consumed = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { consumed += 64 * 1024; controller.enqueue(new Uint8Array(64 * 1024)); if (consumed === 8 * 1024 * 1024) controller.close(); },
    });
    const response = await worker.fetch(new Request(new URL(path, env.ACCOUNT_URL), { method: 'PUT', headers: { 'x-gitspace-device': header, 'content-length': String(8 * 1024 * 1024) }, body }), env);
    expect(response.status).toBe(401);
    expect(consumed).toBeLessThanOrEqual(64 * 1024);
    await body.cancel().catch(() => {});
  });
  it('rejects authenticated streaming uploads without a declared length before consumption', async () => {
    const device = await browserDevice(['rpc.read']);
    const path = '/tunnel/offline-machine/upload';
    const bytes = new Uint8Array(64 * 1024);
    let consumed = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { consumed += bytes.byteLength; controller.enqueue(bytes); controller.close(); } });
    const response = await worker.fetch(new Request(new URL(path, env.ACCOUNT_URL), { method: 'PUT', headers: { 'x-gitspace-device': device.signTunnel(path, 'PUT', bytes) }, body }), env);
    expect(response.status).toBe(411);
    expect(consumed).toBeLessThanOrEqual(64 * 1024);
    await body.cancel().catch(() => {});
  });
  it('rejects a declared 90 MiB upload before reading its body', async () => {
    const device = await browserDevice(['rpc.read']);
    const path = '/tunnel/offline-machine/upload';
    let consumed = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { consumed += 64 * 1024; controller.enqueue(new Uint8Array(64 * 1024)); },
    }, { highWaterMark: 0 });
    const response = await worker.fetch(new Request(new URL(path, env.ACCOUNT_URL), {
      method: 'PUT', headers: { 'x-gitspace-device': device.signTunnel(path, 'PUT'), 'content-length': String(90 * 1024 * 1024) }, body,
    }), env);
    expect(response.status).toBe(413);
    expect(consumed).toBe(0);
    await body.cancel();
  });
  it('rejects read-only service approval', async () => {
    const device = await browserDevice(['rpc.read']);
    const hostname = `web--space-a--${env.TENANT_ID}-srv.gssh.dev`;
    await env.HOSTED_ROUTES.getByName(hostname).lease(env.ACCOUNT_ID, { hostname, workspaceId: 'space-a', serviceName: 'web', machineId: 'offline-machine', ingress: 'http://127.0.0.1:3000', portName: 'http', port: 3000, generation: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'healthy', updatedAt: new Date().toISOString() });
    expect((await device.request('/api/services/approve', { hostname, state: crypto.randomUUID(), returnTo: '/' })).status).toBe(403);
  });
  it('refuses a persisted service session whose browser only has rpc.read', async () => {
    const device = await browserDevice(['rpc.read']);
    const hostname = `web--space-a--${env.TENANT_ID}-srv.gssh.dev`;
    const token = crypto.randomUUID();
    const relay = env.RELAY.getByName(env.RELAY_NAME);
    await runInDurableObject(relay, async (_instance, context) => {
      await context.storage.put(`service-session:${token}`, { accountId: env.ACCOUNT_ID, hostname, deviceId: device.deviceId, expiresAt: Date.now() + 60_000 });
    });
    expect(await relay.serviceValidate(token, hostname)).toBeNull();
  });
});

describe('account Chrome pairing authority', () => {
  it('allows read-only status/download but denies pairing and forgetting', async () => {
    const device = await browserDevice(['rpc.read']);
    expect((await device.request('/api/browser-relay/status')).status).toBe(200);
    expect((await device.request('/api/browser-relay/extension.zip')).status).toBe(200);
    expect((await device.request('/api/browser-relay/pair')).status).toBe(403);
    expect((await device.request('/api/browser-relay/unpair', { pairingId: crypto.randomUUID() })).status).toBe(403);
    expect((await device.request('/api/browser-relay/project-status', { projectId: 'project-a' })).status).toBe(200);
    expect((await device.request('/api/browser-relay/project-update', { projectId: 'project-a', expectedRevision: 0, preferences: { defaultPairingId: null, approvals: [] } })).status).toBe(403);
  });
  it('rejects project-scoped browser pairing even with rpc.write', async () => {
    const device = await browserDevice(['rpc.read', 'rpc.write'], { kind: 'project', projectId: 'project-a' });
    expect((await device.request('/api/browser-relay/pair')).status).toBe(403);
    expect((await device.request('/api/browser-relay/project-update', { projectId: 'project-a', expectedRevision: 0, preferences: { defaultPairingId: null, approvals: [] } })).status).toBe(403);
  });
  it('updates only the named personal project and rejects stale or unconfirmed approval writes', async () => {
    const device = await browserDevice(['rpc.read', 'rpc.write']);
    const projectId = crypto.randomUUID();
    const initial = await device.request('/api/browser-relay/project-status', { projectId });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ status: 'ok', value: { projectId, revision: 0, defaultPairingId: null } });
    const input = { projectId, expectedRevision: 0, preferences: { defaultPairingId: null, approvals: [] } };
    const updated = await device.request('/api/browser-relay/project-update', input);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ status: 'ok', value: { projectId, revision: 1 } });
    expect((await device.request('/api/browser-relay/project-update', input)).status).toBe(409);
    const other = await device.request('/api/browser-relay/project-status', { projectId: crypto.randomUUID() });
    expect(await other.json()).toMatchObject({ status: 'ok', value: { revision: 0, defaultPairingId: null } });
    const pairingId = crypto.randomUUID();
    expect((await device.request('/api/browser-relay/project-update', { projectId, expectedRevision: 1, preferences: { defaultPairingId: pairingId, approvals: [{ pairingId, name: 'Unconfirmed', note: '' }] } })).status).toBe(409);
  });
});
