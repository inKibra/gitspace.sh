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
      apiVersion: 3,
      subdomainsSchemaVersion: 4,
    });
  });

  test('protects bare /subdomains and returns flattened serve tunnel metadata', async () => {
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
      tunnelToken: string;
      serveDomain: string;
      serveTunnelId: string;
      serveTunnelName: string;
      serveTunnelConfigSource: 'local';
      serveTunnelCredentialsFile: {
        AccountTag: string;
        TunnelID: string;
        TunnelName: string;
        TunnelSecret: string;
      };
      isPrimary: boolean;
    };
    expect(created.subdomain).toBe('brad');
    expect(created.tunnelToken).toBeTruthy();
    expect(created.serveDomain).toBe('gitspace.sh');
    expect(created.serveTunnelId).toBeTruthy();
    expect(created.serveTunnelName).toBe('gitspace-brad.serve');
    expect(created.serveTunnelConfigSource).toBe('local');
    expect(created.serveTunnelCredentialsFile).toEqual({
      AccountTag: 'cf-account-id',
      TunnelID: created.serveTunnelId,
      TunnelName: 'gitspace-brad.serve',
      TunnelSecret: expect.any(String),
    });
    expect(created.isPrimary).toBe(true);

    const listResponse = await harness.request('/subdomains', { headers: session.headers });
    expect(listResponse.status).toBe(200);
    const subdomains = await listResponse.json() as Array<{
      subdomain: string;
      serveDomain: string | null;
      serveStatus: string | null;
      is_primary: number;
    }>;
    expect(subdomains).toEqual([
      expect.objectContaining({
        subdomain: 'brad',
        serveDomain: 'gitspace.sh',
        serveStatus: 'active',
        is_primary: 1,
      }),
    ]);

    const serveDetailsResponse = await harness.request('/subdomains/brad', {
      headers: session.headers,
    });
    expect(serveDetailsResponse.status).toBe(200);
    await expect(serveDetailsResponse.json()).resolves.toEqual({
      serveDomain: 'gitspace.sh',
      serveTunnelId: created.serveTunnelId,
      serveTunnelName: 'gitspace-brad.serve',
      serveTunnelConfigSource: 'local',
      serveTunnelCredentialsFile: created.serveTunnelCredentialsFile,
    });

    const serveTokenResponse = await harness.request('/subdomains/brad.serve/token', {
      headers: session.headers,
    });
    expect(serveTokenResponse.status).toBe(400);
    await expect(serveTokenResponse.json()).resolves.toEqual({
      error: 'Serve tunnels are locally managed and do not expose tunnel tokens',
    });
  });

  test('rejects reserved root-host namespaces used by flattened service routes', async () => {
    const session = await harness.createDeviceSession();

    const reservedAvailability = await harness.request('/subdomains/check?name=brad-srv', {
      headers: session.headers,
    });
    expect(reservedAvailability.status).toBe(200);
    await expect(reservedAvailability.json()).resolves.toEqual({
      available: false,
      reason: 'Subdomain names ending in -srv are reserved for hosted service routes.',
    });

    const reservedDoubleDash = await harness.request('/subdomains/check?name=brad--svc', {
      headers: session.headers,
    });
    expect(reservedDoubleDash.status).toBe(200);
    await expect(reservedDoubleDash.json()).resolves.toEqual({
      available: false,
      reason: 'Subdomain names containing -- are reserved for hosted service routes.',
    });

    const createResponse = await harness.request('/subdomains', {
      method: 'POST',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subdomain: 'brad-srv' }),
    });
    expect(createResponse.status).toBe(400);
    await expect(createResponse.json()).resolves.toEqual({
      error: 'Subdomain names ending in -srv are reserved for hosted service routes.',
    });
  });

  test('syncs flattened serve route DNS records for active services', async () => {
    const session = await harness.createDeviceSession();

    const createResponse = await harness.request('/subdomains', {
      method: 'POST',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subdomain: 'brad' }),
    });
    const created = await createResponse.json() as { serveTunnelId: string };

    const hostnames = [
      'web--demo--macbook--app--1--brad-srv.gitspace.sh',
      'api--demo--macbook--http--1--brad-srv.gitspace.sh',
    ];
    const syncResponse = await harness.request('/subdomains/brad/serve-routes', {
      method: 'PUT',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hostnames }),
    });
    expect(syncResponse.status).toBe(200);
    await expect(syncResponse.json()).resolves.toEqual({
      serveDomain: 'gitspace.sh',
      syncedHostnames: [...hostnames].sort(),
      deletedHostnames: [],
    });

    const dnsNames = harness.upstream.listDnsRecords().map((record) => record.name).sort();
    expect(dnsNames).toEqual([
      '*.brad.gitspace.sh',
      ...hostnames,
      'brad.gitspace.sh',
    ].sort());

    const secondSync = await harness.request('/subdomains/brad/serve-routes', {
      method: 'PUT',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hostnames: [hostnames[1]!] }),
    });
    expect(secondSync.status).toBe(200);
    await expect(secondSync.json()).resolves.toEqual({
      serveDomain: 'gitspace.sh',
      syncedHostnames: [hostnames[1]!],
      deletedHostnames: [hostnames[0]!],
    });

    const updatedDnsNames = harness.upstream.listDnsRecords().map((record) => record.name).sort();
    expect(updatedDnsNames).toEqual([
      '*.brad.gitspace.sh',
      hostnames[1]!,
      'brad.gitspace.sh',
    ].sort());
    expect(created.serveTunnelId).toBeTruthy();
  });

  test('rejects serve-route hostnames outside the caller namespace', async () => {
    const session = await harness.createDeviceSession();

    await harness.request('/subdomains', {
      method: 'POST',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subdomain: 'brad' }),
    });

    const syncResponse = await harness.request('/subdomains/brad/serve-routes', {
      method: 'PUT',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        hostnames: ['web--demo--macbook--app--1--alice-srv.gitspace.sh'],
      }),
    });

    expect(syncResponse.status).toBe(400);
    await expect(syncResponse.json()).resolves.toEqual({
      error: 'Serve route web--demo--macbook--app--1--alice-srv.gitspace.sh must be a single-label host ending with --brad-srv.gitspace.sh',
    });
  });

  test('reuses an existing active subdomain instead of reprovisioning either tunnel', async () => {
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
      serveTunnelId: string;
      serveTunnelCredentialsFile: { TunnelSecret: string };
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
      serveTunnelId: string;
      serveTunnelCredentialsFile: { TunnelSecret: string };
      isPrimary: boolean;
    };

    expect(secondBody.tunnelToken).toBe(firstBody.tunnelToken);
    expect(secondBody.serveTunnelId).toBe(firstBody.serveTunnelId);
    expect(secondBody.serveTunnelCredentialsFile.TunnelSecret).toBe(firstBody.serveTunnelCredentialsFile.TunnelSecret);
    expect(secondBody.isPrimary).toBe(true);
  });

  test('set-primary updates only primary root subdomains while preserving serve domain metadata', async () => {
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
      serveDomain: string | null;
      serveStatus: string | null;
      is_primary: number;
    }>;

    expect(subdomains).toHaveLength(2);
    expect(subdomains[0]).toEqual(expect.objectContaining({
      subdomain: 'alice',
      serveDomain: 'gitspace.sh',
      serveStatus: 'active',
      is_primary: 1,
    }));
    expect(subdomains[1]).toEqual(expect.objectContaining({
      subdomain: 'brad',
      serveDomain: 'gitspace.sh',
      serveStatus: 'active',
      is_primary: 0,
    }));
  });

  test('deleting a primary subdomain also removes its serve tunnel and synced routes', async () => {
    const session = await harness.createDeviceSession();

    await harness.request('/subdomains', {
      method: 'POST',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subdomain: 'brad' }),
    });
    await harness.request('/subdomains/brad/serve-routes', {
      method: 'PUT',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hostnames: ['web--demo--macbook--app--1--brad-srv.gitspace.sh'] }),
    });

    const deleteResponse = await harness.request('/subdomains/brad', {
      method: 'DELETE',
      headers: session.headers,
    });
    expect(deleteResponse.status).toBe(200);

    const listResponse = await harness.request('/subdomains', { headers: session.headers });
    const subdomains = await listResponse.json() as Array<{ subdomain: string }>;
    expect(subdomains).toEqual([]);
    const dnsNames = harness.upstream.listDnsRecords().map((record) => record.name).sort();
    expect(dnsNames).toEqual([]);
  });

  test('keeps the current primary when serve tunnel provisioning fails for a replacement host', async () => {
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
