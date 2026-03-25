import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { WorkerHarness } from './helpers/worker-harness';
import { createWorkerHarness } from './helpers/worker-harness';

let harness: WorkerHarness;

beforeEach(async () => {
  harness = await createWorkerHarness();
});

afterEach(async () => {
  await harness?.dispose();
});

describe('subdomain routes', () => {
  test('publishes worker API compatibility metadata from /config', async () => {
    const response = await harness.request('/config');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      github_client_id: 'github-client-id',
      version: '1.0.0',
      apiVersion: 1,
      subdomainsSchemaVersion: 2,
    });
  });


  test('protects bare /subdomains and lists companion serve metadata with provisioned Cloudflare resources', async () => {
    const unauthenticated = await harness.request('/subdomains');
    expect(unauthenticated.status).toBe(401);

    const session = await harness.createDeviceSession();
    const createResponse = await harness.request('/subdomains', {
      method: 'POST',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subdomain: 'brad' }),
    });

    expect(createResponse.status).toBe(200);
    const created = await createResponse.json() as {
      subdomain: string;
      serveSubdomain?: string;
      tunnelToken?: string;
      serveTunnelToken?: string;
      isPrimary: boolean;
    };
    expect(created.subdomain).toBe('brad');
    expect(created.serveSubdomain).toBe('brad.serve');
    expect(created.tunnelToken).toBeTruthy();
    expect(created.serveTunnelToken).toBeTruthy();
    expect(created.isPrimary).toBe(true);

    const listResponse = await harness.request('/subdomains', { headers: session.headers });
    expect(listResponse.status).toBe(200);
    const subdomains = await listResponse.json() as Array<{
      subdomain: string;
      serveSubdomain: string | null;
      serveStatus: string | null;
      is_primary: number;
    }>;
    expect(subdomains).toEqual([
      expect.objectContaining({
        subdomain: 'brad',
        serveSubdomain: 'brad.serve',
        serveStatus: 'active',
        is_primary: 1,
      }),
    ]);

    const configuredHostnames = harness.upstream
      .listTunnelConfigurations()
      .flatMap((entry) => entry.ingress.map((rule) => rule.hostname).filter((hostname): hostname is string => Boolean(hostname)))
      .sort();
    expect(configuredHostnames).toEqual([
      '*.brad.gitspace.sh',
      '*.brad.serve.gitspace.sh',
      'brad.gitspace.sh',
      'brad.serve.gitspace.sh',
    ]);

    const dnsNames = harness.upstream.listDnsRecords().map((record) => record.name).sort();
    expect(dnsNames).toEqual([
      '*.brad.gitspace.sh',
      '*.brad.serve.gitspace.sh',
      'brad.gitspace.sh',
      'brad.serve.gitspace.sh',
    ]);

    const serveTokenResponse = await harness.request('/subdomains/brad.serve/token', {
      headers: session.headers,
    });
    expect(serveTokenResponse.status).toBe(200);
    await expect(serveTokenResponse.json()).resolves.toMatchObject({
      tunnelToken: created.serveTunnelToken,
    });
  });

  test('deleting a primary subdomain also removes its companion serve subdomain', async () => {
    const session = await harness.createDeviceSession();

    await harness.request('/subdomains', {
      method: 'POST',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subdomain: 'brad' }),
    });

    const deleteResponse = await harness.request('/subdomains/brad', {
      method: 'DELETE',
      headers: session.headers,
    });
    expect(deleteResponse.status).toBe(200);

    const serveTokenResponse = await harness.request('/subdomains/brad.serve/token', {
      headers: session.headers,
    });
    expect(serveTokenResponse.status).toBe(404);
  });

  test('reuses an existing active subdomain instead of tearing it down first', async () => {
    const session = await harness.createDeviceSession();

    const firstCreate = await harness.request('/subdomains', {
      method: 'POST',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subdomain: 'brad' }),
    });
    expect(firstCreate.status).toBe(200);
    const firstBody = await firstCreate.json() as {
      tunnelToken: string;
      serveTunnelToken: string;
      isPrimary: boolean;
    };

    const secondCreate = await harness.request('/subdomains', {
      method: 'POST',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subdomain: 'brad' }),
    });
    expect(secondCreate.status).toBe(200);
    const secondBody = await secondCreate.json() as {
      tunnelToken: string;
      serveTunnelToken: string;
      isPrimary: boolean;
    };

    expect(secondBody.tunnelToken).toBe(firstBody.tunnelToken);
    expect(secondBody.serveTunnelToken).toBe(firstBody.serveTunnelToken);
    expect(secondBody.isPrimary).toBe(true);

    const listResponse = await harness.request('/subdomains', { headers: session.headers });
    const subdomains = await listResponse.json() as Array<{ subdomain: string; is_primary: number }>;
    expect(subdomains).toHaveLength(1);
    expect(subdomains[0]?.subdomain).toBe('brad');
  });

  test('set-primary updates only primary subdomains while preserving serve companion metadata', async () => {
    const session = await harness.createDeviceSession();

    for (const subdomain of ['brad', 'alice']) {
      const response = await harness.request('/subdomains', {
        method: 'POST',
        headers: {
          ...session.headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ subdomain }),
      });
      expect(response.status).toBe(200);
    }

    const setPrimaryResponse = await harness.request('/subdomains/alice/set-primary', {
      method: 'POST',
      headers: session.headers,
    });
    expect(setPrimaryResponse.status).toBe(200);

    const listResponse = await harness.request('/subdomains', { headers: session.headers });
    expect(listResponse.status).toBe(200);
    const subdomains = await listResponse.json() as Array<{
      subdomain: string;
      serveSubdomain: string | null;
      serveStatus: string | null;
      is_primary: number;
    }>;

    expect(subdomains).toHaveLength(2);
    expect(subdomains[0]).toEqual(expect.objectContaining({
      subdomain: 'alice',
      serveSubdomain: 'alice.serve',
      serveStatus: 'active',
      is_primary: 1,
    }));
    expect(subdomains[1]).toEqual(expect.objectContaining({
      subdomain: 'brad',
      serveSubdomain: 'brad.serve',
      serveStatus: 'active',
      is_primary: 0,
    }));
  });


  test('keeps the current primary when replacement provisioning fails', async () => {
    const session = await harness.createDeviceSession();

    const firstCreate = await harness.request('/subdomains', {
      method: 'POST',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subdomain: 'brad' }),
    });
    expect(firstCreate.status).toBe(200);

    harness.upstream.failNextTunnelCreate('gitspace-alice.serve');
    const failedCreate = await harness.request('/subdomains', {
      method: 'POST',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subdomain: 'alice', isPrimary: true }),
    });
    expect(failedCreate.status).toBe(500);

    const listResponse = await harness.request('/subdomains', { headers: session.headers });
    expect(listResponse.status).toBe(200);
    const subdomains = await listResponse.json() as Array<{ subdomain: string; is_primary: number }>;
    expect(subdomains).toHaveLength(1);
    expect(subdomains[0]?.subdomain).toBe('brad');
    expect(subdomains[0]?.is_primary).toBe(1);
  });
});
