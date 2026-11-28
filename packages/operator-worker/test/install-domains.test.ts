// The operator Worker of an install at its own domains (`ACCOUNT_DOMAIN`, `SERVICE_DOMAIN`): the URLs it hands out
// and the domains it names are the install's. (The shared test config runs at GitSpace's own, as production does.)
import { env } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createRelayAuthorization, credentialProtocolBase64 } from '@gitspace/protocol';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { network } from './network.js';

const onPrem = { ...env, ACCOUNT_DOMAIN: 'account.test', SERVICE_DOMAIN: 'relay.test' };

describe('an install at its own domains', () => {
  it('names them for tools', async () => {
    expect(await (await worker.fetch(new Request('https://account.test/v1/domains'), onPrem)).json()).toEqual({ account: 'account.test', service: 'relay.test' });
    expect(await (await worker.fetch(new Request('https://gitspace.sh/v1/domains'), env)).json()).toEqual({ account: 'gitspace.sh', service: 'gssh.dev' });
  });

  it('names them in the browser app\'s pages it serves', async () => {
    const page = '<!doctype html><html><head><title>GitSpace</title></head><body></body></html>';
    const served = await worker.fetch(new Request('https://account.test/'), { ...onPrem, ASSETS: { fetch: async () => new Response(page, { headers: { 'content-type': 'text/html' } }) } as unknown as Fetcher });
    expect(await served.text()).toContain('<head><meta name="gitspace-domains" content="{&quot;account&quot;:&quot;account.test&quot;,&quot;service&quot;:&quot;relay.test&quot;}">');
  });

  it('recovers an account at its URLs', async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const publicKey = Uint8Array.from(ed25519.getPublicKey(privateKey));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey));
    const userId = `u-${Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const registry = env.ACCOUNTS.getByName('global');
    await registry.upsertProvisioning({ userId, handle: 'onprem' });
    await registry.markActive({ userId, release: 'stable' });
    network.use(http.get('https://platform.test/__platform/operator/tenants/onprem', () => HttpResponse.json({
      control: { status: 'active', reason: null, updatedAt: null }, credits: null, usage: { records: 0, debitedMicros: 0 },
      deployment: { active: null, uploadedAt: null, appliedMigrationTag: null },
    })));
    const path = '/v1/accounts/recover';
    const response = await worker.fetch(new Request(`https://api.account.test${path}`, {
      method: 'POST',
      headers: { authorization: createRelayAuthorization(privateKey, path), 'content-type': 'application/json' },
      body: JSON.stringify({ rootPublicKey: credentialProtocolBase64.encode(publicKey), handle: 'onprem' }),
    }), onPrem);
    expect(await response.json()).toEqual({
      status: 'ok',
      value: { userId, handle: 'onprem', relayUrl: 'https://onprem.relay.test', accountUrl: 'https://onprem.account.test', apiUrl: 'https://onprem.account.test' },
    });
  });
});

describe('an install on one domain (account and service domains alike)', () => {
  const oneDomain = { ...env, ACCOUNT_DOMAIN: 'studio.test', SERVICE_DOMAIN: 'studio.test' };

  it.each(['work-relay', 'a--b'])('refuses the handle %s, which would take a relay or a hosted service\'s hostname', async (handle) => {
    const response = await worker.fetch(new Request('https://api.studio.test/v1/accounts/bootstrap', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rootPublicKey: 'key', handle, invite: 'invite' }),
    }), oneDomain);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_HANDLE' } });
  });
});
