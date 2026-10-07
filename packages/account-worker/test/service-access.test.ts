import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, credentialProtocolBase64, signDeviceInvite, signRpcRequest } from '@gitspace/protocol';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { fetchInternalService } from '../src/service-access.js';
import { SERVICE_COOKIE, SERVICE_STATE_COOKIE, safeServiceReturn } from '../src/service-sessions.js';
import { tenantRootPrivateKey } from './setup.js';

async function enrollBrowser() {
  const signingPrivateKey = crypto.getRandomValues(new Uint8Array(32));
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(71)) });
  const invite = signDeviceInvite({ version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read', 'rpc.write'], canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'https://api.gitspace.sh' }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signingPrivateKey)), label: 'Browser', boundAt: Date.now(), signingPrivateKey });
  const enrolled = await vault.enrollDevice({ invite, binding });
  if (enrolled.status !== 'ok') throw new Error(enrolled.error.message);
  return binding.deviceId;
}
const hostname = `web--space-a--${env.TENANT_ID}-srv.gssh.dev`;
async function lease() {
  await env.HOSTED_ROUTES.getByName(hostname).lease(env.ACCOUNT_ID, { hostname, workspaceId: 'space-a', serviceName: 'web', machineId: 'service-machine', ingress: 'http://127.0.0.1:3000', portName: 'http', port: 3000, generation: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'healthy', updatedAt: new Date().toISOString() });
}
describe('private hosted service access', () => {
  it('rejects URL-parser redirect tricks and reserved callback paths', () => {
    for (const target of ['/\t/outside.test', '/\u0000/outside.test', '/%5coutside.test', '/%2foutside.test', '/x/../__gitspace/auth', '/%5f_gitspace/auth']) {
      expect(safeServiceReturn(target), target).toBe(false);
    }
    expect(safeServiceReturn('/app?next=https://example.test/#part')).toBe(true);
  });
  it('rejects approval from unenrolled authority', async () => {
    const denied = await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async instance => {
      try {
        await instance.serviceApprove({ hostname, deviceId: 'unknown-browser', state: crypto.randomUUID(), returnTo: '/' });
        return false;
      } catch { return true; }
    });
    expect(denied).toBe(true);
  });
  it('logout removes only the session on its exact service host', async () => {
    const relay = env.RELAY.getByName(env.RELAY_NAME);
    const state = crypto.randomUUID();
    const deviceId = await enrollBrowser();
    const ticket = await relay.serviceApprove({ hostname, deviceId, state, returnTo: '/' });
    const session = await relay.serviceRedeem(ticket, hostname, state);
    if (!session) throw new Error('Session missing');
    const cookie = `${SERVICE_COOKIE}=${session.token}`;
    await exports.default.fetch(new Request(`https://other--${env.TENANT_ID}-srv.gssh.dev/__gitspace/logout`, { method: 'POST', headers: { cookie, origin: `https://other--${env.TENANT_ID}-srv.gssh.dev` } }));
    expect(await relay.serviceValidate(session.token, hostname)).not.toBeNull();
    await exports.default.fetch(new Request(`https://${hostname}/__gitspace/logout`, { method: 'POST', headers: { cookie, origin: `https://${hostname}` } }));
    expect(await relay.serviceValidate(session.token, hostname)).toBeNull();
  });
  it('alarm sweeps expired tickets and sessions without a redemption or request', async () => {
    const relay = env.RELAY.getByName(env.RELAY_NAME);
    const state = crypto.randomUUID();
    const deviceId = await enrollBrowser();
    await relay.serviceApprove({ hostname, deviceId, state, returnTo: '/' });
    const ticket = await relay.serviceApprove({ hostname, deviceId, state, returnTo: '/' });
    expect(await relay.serviceRedeem(ticket, hostname, state)).not.toBeNull();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 900_001);
    try {
      await runInDurableObject(relay, async (instance, context) => {
        await instance.alarm();
        expect((await context.storage.list({ prefix: 'service-ticket:' })).size).toBe(0);
        expect((await context.storage.list({ prefix: 'service-session:' })).size).toBe(0);
      });
    } finally { clock.mockRestore(); }
  });
  it('redirects unauthenticated HTTP to exact-host approval but rejects WebSocket without a cookie', async () => {
    await lease();
    const response = await exports.default.fetch(new Request(`https://${hostname}/private?x=1`, { redirect: 'manual' }));
    expect(response.status).toBe(303);
    const approval = new URL(response.headers.get('location')!);
    expect(approval.pathname).toBe('/service-access');
    expect(approval.searchParams.get('hostname')).toBe(hostname);
    expect(approval.searchParams.get('returnTo')).toBe('/private?x=1');
    expect(response.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Lax');
    expect(response.headers.get('set-cookie')).not.toContain('Domain=');
    expect((await exports.default.fetch(new Request(`https://${hostname}/socket`, { headers: { upgrade: 'websocket', origin: `https://${hostname}` } }))).status).toBe(401);
  });
  it('redeems a ticket once, binds host and browser state, and isolates service cookies', async () => {
    const relay = env.RELAY.getByName(env.RELAY_NAME);
    const state = crypto.randomUUID();
    const deviceId = await enrollBrowser();
    const ticket = await relay.serviceApprove({ hostname, deviceId, state, returnTo: '/private' });
    expect(await relay.serviceRedeem(ticket, `other--${env.TENANT_ID}-srv.gssh.dev`, state)).toBeNull();
    expect(await relay.serviceRedeem(ticket, hostname, crypto.randomUUID())).toBeNull();
    const callback = new Request(`https://${hostname}/__gitspace/auth?ticket=${ticket}`, { redirect: 'manual', headers: { cookie: `${SERVICE_STATE_COOKIE}=${state}` } });
    const response = await exports.default.fetch(callback);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/private');
    const cookies = response.headers.get('set-cookie')!;
    expect(cookies).toContain(`${SERVICE_COOKIE}=`);
    expect(cookies).not.toContain('Domain=');
    expect((await exports.default.fetch(callback)).status).toBe(401);
    const token = cookies.split(`${SERVICE_COOKIE}=`)[1]!.split(';')[0]!;
    expect(await relay.serviceValidate(token, hostname)).toMatchObject({ deviceId });
    expect(await relay.serviceValidate(token, `other--${env.TENANT_ID}-srv.gssh.dev`)).toBeNull();
    expect(await env.RELAY.getByName('foreign-tenant-fixture').serviceValidate(token, hostname)).toBeNull();
  });
  it('expires approval tickets and host cookies', async () => {
    const relay = env.RELAY.getByName(env.RELAY_NAME);
    const state = crypto.randomUUID();
    const deviceId = await enrollBrowser();
    const ticket = await relay.serviceApprove({ hostname, deviceId, state, returnTo: '/' });
    const liveTicket = await relay.serviceApprove({ hostname, deviceId, state, returnTo: '/' });
    const live = await relay.serviceRedeem(liveTicket, hostname, state);
    if (!live) throw new Error('Session missing');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
    try {
      expect(await relay.serviceRedeem(ticket, hostname, state)).toBeNull();
      expect(await relay.serviceValidate(live.token, hostname)).toMatchObject({ deviceId });
      clock.mockReturnValue(now + 900_001);
      expect(await relay.serviceValidate(live.token, hostname)).toBeNull();
    } finally { clock.mockRestore(); }
  });
  it('authorizes approval through the browser device and rejects unsafe return locations', async () => {
    await lease();
    const signingPrivateKey = crypto.getRandomValues(new Uint8Array(32));
    const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
    await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(71)) });
    const invite = signDeviceInvite({ version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read', 'rpc.write'], canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'https://api.gitspace.sh' }, tenantRootPrivateKey);
    const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signingPrivateKey)), label: 'Browser', boundAt: Date.now(), signingPrivateKey });
    const enrolled = await vault.enrollDevice({ invite, binding });
    if (enrolled.status !== 'ok') throw new Error(enrolled.error.message);
    const state = crypto.randomUUID();
    async function approve(returnTo: string) {
      const path = '/api/services/approve';
      const body = new TextEncoder().encode(JSON.stringify({ hostname, state, returnTo }));
      return exports.default.fetch(new Request(new URL(path, env.ACCOUNT_URL), { method: 'POST', body, headers: { origin: new URL(env.ACCOUNT_URL).origin, 'x-gitspace-device': signRpcRequest({ deviceId: binding.deviceId, signingPrivateKey, method: 'POST', path, body }) } }));
    }
    for (const returnTo of ['//outside.test/', '/\\outside.test/', '/__gitspace/auth']) expect((await approve(returnTo)).status).toBe(400);
    const approved = await approve('/private?approved=1');
    expect(approved.status).toBe(200);
    const result = await approved.json<{ status: string; value: { callback: string } }>();
    const callback = new URL(result.value.callback);
    expect(callback.hostname).toBe(hostname);
    const response = await exports.default.fetch(new Request(callback, { redirect: 'manual', headers: { cookie: `${SERVICE_STATE_COOKIE}=${state}` } }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/private?approved=1');
    const cookie = response.headers.get('set-cookie')!;
    const token = cookie.split(`${SERVICE_COOKIE}=`)[1]!.split(';')[0]!;
    expect(await env.RELAY.getByName(env.RELAY_NAME).serviceValidate(token, hostname)).not.toBeNull();
    await vault.revokeDeviceGrant(binding.deviceId);
    expect(await env.RELAY.getByName(env.RELAY_NAME).serviceValidate(token, hostname)).toBeNull();
  });
  it('denies foreign cloud/device identities and never calls the public service URL', async () => {
    await lease();
    const request = new Request(`https://${hostname}/private`);
    expect((await fetchInternalService(env, { kind: 'device', accountId: 'foreign', deviceId: 'machine-b' }, request)).status).toBe(403);
    expect((await fetchInternalService(env, { kind: 'cloud', accountId: env.ACCOUNT_ID, projectId: 'project-a', workspaceId: 'space-b' }, request)).status).toBe(403);
    // A registered but disconnected machine is reached through the internal relay, not Internet fetch.
    const response = await fetchInternalService(env, { kind: 'cloud', accountId: env.ACCOUNT_ID, projectId: 'project-a', workspaceId: 'space-a' }, request);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('MACHINE_OFFLINE');
    expect((await exports.default.fetch(new Request('https://relay.test/api/services/fetch?url=' + encodeURIComponent(request.url)))).status).toBe(401);
  });
});
