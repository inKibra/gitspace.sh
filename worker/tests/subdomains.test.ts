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
  test('protects bare /subdomains and provisions companion serve token data', async () => {
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
    const subdomains = await listResponse.json() as Array<{ subdomain: string }>;
    expect(subdomains.map((entry) => entry.subdomain)).toEqual(['brad']);

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
});
