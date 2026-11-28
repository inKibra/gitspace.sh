// An install at its own domains (`ACCOUNT_DOMAIN`, `SERVICE_DOMAIN`): the account Worker's host checks accept the
// install's hosts and refuse GitSpace's own, and what it hands out names the install's.
import { env } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, credentialProtocolBase64, signDeviceInvite, signRpcRequest } from '@gitspace/protocol';
import { parse, stringify } from 'devalue';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { hostedServiceUrlPattern, isHostedServiceHostname } from '../src/service-access.js';
import { tenantRootPrivateKey } from './setup.js';

const onPrem = { ...env, ACCOUNT_DOMAIN: 'git.acme.example', SERVICE_DOMAIN: 'relay.acme.example' };

/** A browser device of the test account, and a signed `/rpc` request on `host`. */
async function browser() {
  const userId = env.ACCOUNT_ID;
  const handle = env.TENANT_ID;
  const key = crypto.getRandomValues(new Uint8Array(32));
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(71)) });
  await env.USER_SETTINGS.getByName(userId).setHandle('bootstrap', 0, handle);
  const invite = signDeviceInvite({ version: 1, userId, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read'], canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: `https://${handle}.git.acme.example` }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(key)), label: 'Browser', boundAt: Date.now(), signingPrivateKey: key });
  const enrolled = await vault.enrollDevice({ invite, binding });
  if (enrolled.status !== 'ok') throw new Error(enrolled.error.message);
  const rpc = (host: string) => {
    const body = stringify({ v: 1, path: 'settings.get', input: {} });
    const signature = signRpcRequest({ deviceId: binding.deviceId, method: 'POST', path: '/rpc', body: new TextEncoder().encode(body), signingPrivateKey: key });
    return new Request(`https://${host}/rpc`, { method: 'POST', body, headers: { 'content-type': 'application/result-rpc+devalue; sv=1', 'x-gitspace-user': userId, 'x-gitspace-device': signature } });
  };
  return { handle, rpc };
}

describe('an install at its own domains', () => {
  it('answers account RPC on its account hostname and refuses GitSpace\'s own', async () => {
    const { handle, rpc } = await browser();
    const own = await worker.fetch(rpc(`${handle}.git.acme.example`), onPrem);
    expect(own.status).toBe(200);
    expect(parse(new TextDecoder().decode(await own.arrayBuffer()))).toMatchObject({ status: 'ok' });
    const gitspace = await worker.fetch(rpc(`${handle}.gitspace.sh`), onPrem);
    expect(gitspace.status).toBe(403);
    expect(await gitspace.json()).toMatchObject({ error: { code: 'ACCOUNT_HOST_MISMATCH' } });
    // An install at GitSpace's own domains (unset) is as before.
    expect((await worker.fetch(rpc(`${handle}.gitspace.sh`), env)).status).toBe(200);
    expect((await worker.fetch(rpc(`${handle}.git.acme.example`), env)).status).toBe(403);
  });

  it('tells its browser app its domains', async () => {
    const domains = await worker.fetch(new Request(`https://${env.TENANT_ID}.git.acme.example/v1/domains`), onPrem);
    expect(await domains.json()).toEqual({ account: 'git.acme.example', service: 'relay.acme.example' });
    const defaults = await worker.fetch(new Request(`https://${env.TENANT_ID}.gitspace.sh/v1/domains`), env);
    expect(await defaults.json()).toEqual({ account: 'gitspace.sh', service: 'gssh.dev' });
  });

  it('names its domains in the browser app\'s pages it serves, so the app needs no request for them', async () => {
    const page = '<!doctype html><html><head><title>GitSpace</title></head><body><div id="root"></div></body></html>';
    const assets = { fetch: async () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', etag: '"abc"' } }) } as unknown as Fetcher;
    const served = await worker.fetch(new Request(`https://www.git.acme.example/settings`), { ...onPrem, ASSETS: assets });
    const html = await served.text();
    expect(html).toContain('<head><meta name="gitspace-domains" content="{&quot;account&quot;:&quot;git.acme.example&quot;,&quot;service&quot;:&quot;relay.acme.example&quot;}">');
    expect(served.headers.get('etag')).toBe('W/"abc-git.acme.example-relay.acme.example"');
    const defaults = await (await worker.fetch(new Request(`https://www.gitspace.sh/settings`), { ...env, ASSETS: assets })).text();
    expect(defaults).toContain('content="{&quot;account&quot;:&quot;gitspace.sh&quot;,&quot;service&quot;:&quot;gssh.dev&quot;}"');
  });

  it('knows its hosted services by its service domain', () => {
    const service = `web--space-a--${env.TENANT_ID}-srv`;
    expect(isHostedServiceHostname(onPrem, `${service}.relay.acme.example`)).toBe(true);
    expect(isHostedServiceHostname(onPrem, `${service}.gssh.dev`)).toBe(false);
    expect(isHostedServiceHostname(env, `${service}.gssh.dev`)).toBe(true);
    expect(hostedServiceUrlPattern(onPrem)).toBe(`*://*--${env.TENANT_ID}-srv.relay.acme.example/*`);
  });
});

describe('an install on one domain (account and service domains alike)', () => {
  const oneDomain = { ...env, ACCOUNT_DOMAIN: 'studio.test', SERVICE_DOMAIN: 'studio.test' };

  it('answers account RPC on the account hostname only, not on its relay\'s', async () => {
    const { handle, rpc } = await browser();
    expect((await worker.fetch(rpc(`${handle}.studio.test`), oneDomain)).status).toBe(200);
    const relay = await worker.fetch(rpc(`${handle}-relay.studio.test`), oneDomain);
    expect(relay.status).toBe(403);
    expect(await relay.json()).toMatchObject({ error: { code: 'ACCOUNT_HOST_MISMATCH' } });
  });

  it('knows its hosted services on the one domain', () => {
    expect(isHostedServiceHostname(oneDomain, `web--space-a--${env.TENANT_ID}-srv.studio.test`)).toBe(true);
    expect(isHostedServiceHostname(oneDomain, `${env.TENANT_ID}.studio.test`)).toBe(false);
  });
});
