import { env, SELF } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, createSignedRpcFetch, credentialProtocolBase64, signDeviceInvite, signRpcRequest, type DeviceCapability, type DeviceScope } from '@gitspace/protocol';
import { gitspaceContract } from '@gitspace/protocol/rpc-contract';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { createBrowserClient } from 'result-rpc/client';
import { parse, stringify } from 'devalue';
import { describe, expect, it } from 'vitest';

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
