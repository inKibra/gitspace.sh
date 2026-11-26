// The platform of an install at its own domains (`ACCOUNT_DOMAIN`, `SERVICE_DOMAIN`): it dispatches the install's
// hostnames and not GitSpace's own, and the account Workers it deploys name the install's URLs and domains. (The
// shared test config runs at GitSpace's own, as production does.)
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { domainsFromSettings } from '@gitspace/protocol-environment/domains';
import { scriptUploadMetadata } from '../src/deployer.js';
import worker from '../src/index.js';

const onPrem = { ACCOUNT_DOMAIN: 'account.test', SERVICE_DOMAIN: 'relay.test' };

/** The platform at the install's domains, every tenant Worker answering 201. */
function platform(): Env {
  return {
    ...env,
    ...onPrem,
    DISPATCHER: { get() { return { async fetch() { return new Response('tenant response', { status: 201 }); } }; } } as unknown as DispatchNamespace,
  };
}

describe('an install at its own domains', () => {
  it.each(['alice.relay.test', 'alice.account.test', 'web--space-a--alice-srv.relay.test'])('dispatches %s to its tenant', async (hostname) => {
    const response = await worker.fetch(new Request(`https://${hostname}/health`), platform(), createExecutionContext());
    expect(response.status).toBe(201);
  });

  it.each(['alice.gitspace.sh', 'alice.gssh.dev', 'web--space-a--alice-srv.gssh.dev', 'alice.account.test.example'])('does not dispatch %s', async (hostname) => {
    const response = await worker.fetch(new Request(`https://${hostname}/health`), platform(), createExecutionContext());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'TENANT_NOT_FOUND' } });
  });

  it('sends its reserved www host to its own site', async () => {
    const response = await worker.fetch(new Request('https://www.account.test/pricing?ref=nav'), platform(), createExecutionContext());
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://account.test/pricing?ref=nav');
  });

  it('deploys account Workers that name its URLs and domains', () => {
    const metadata = scriptUploadMetadata({
      mainModule: 'worker.mjs', compatibilityDate: '2026-08-27', compatibilityFlags: [], durableObjects: [], migrations: [],
      resources: [
        { name: 'ACCOUNT_URL', source: 'application-url' }, { name: 'RELAY_URL', source: 'transport-url' },
        { name: 'ACCOUNT_DOMAIN', source: 'account-domain' }, { name: 'SERVICE_DOMAIN', source: 'service-domain' },
      ],
    }, null, [], {
      id: 'bravo', accountId: 'u-bravo', rootPublicKey: 'key', blobBucket: 'bucket', platformUrl: 'https://platform.relay.test', platformService: 'platform',
      token: 'token', publicAssetsService: 'assets', releaseChannelService: 'channel', domains: domainsFromSettings(onPrem),
    });
    expect(metadata.bindings).toEqual([
      { type: 'plain_text', name: 'ACCOUNT_URL', text: 'https://bravo.account.test' },
      { type: 'plain_text', name: 'RELAY_URL', text: 'https://bravo.relay.test' },
      { type: 'plain_text', name: 'ACCOUNT_DOMAIN', text: 'account.test' },
      { type: 'plain_text', name: 'SERVICE_DOMAIN', text: 'relay.test' },
    ]);
  });
});
