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

describe('worker auth routes', () => {
  test('protects bare /me and returns profile for a device-bound token', async () => {
    const unauthenticated = await harness.request('/me');
    expect(unauthenticated.status).toBe(401);

    const session = await harness.createDeviceSession();
    const me = await harness.request('/me', { headers: session.headers });

    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({
      github_username: 'octocat',
      email: 'octocat@example.com',
    });
  });

  test('rejects requests missing the bound device fingerprint', async () => {
    const session = await harness.createDeviceSession();
    const response = await harness.request('/me', {
      headers: { Authorization: session.headers.Authorization },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Missing device fingerprint',
    });
  });
});
