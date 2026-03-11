import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { WorkerHarness } from './helpers/worker-harness';
import { createWorkerHarness } from './helpers/worker-harness';

let harness: WorkerHarness;

const backupPayload = {
  version: 1,
  kind: 'user-root-mnemonic',
  ownerUserRootId: 'gssh-user:owner-test',
  envelope: {
    version: 1,
    algorithm: 'PBKDF2-AES-GCM',
    iterations: 210000,
    salt: 'salt-b64',
    iv: 'iv-b64',
    ciphertext: 'ciphertext-b64',
    createdAt: 1000,
    updatedAt: 2000,
  },
  createdAt: 1000,
  updatedAt: 2000,
};

beforeEach(async () => {
  harness = await createWorkerHarness();
});

afterEach(async () => {
  await harness?.dispose();
});

describe('identity backup routes', () => {
  test('stores, returns, reports, and deletes encrypted identity backups', async () => {
    const session = await harness.createDeviceSession();

    const statusBefore = await harness.request('/identity/backup/status', { headers: session.headers });
    expect(statusBefore.status).toBe(200);
    await expect(statusBefore.json()).resolves.toEqual({ enabled: false });

    const putResponse = await harness.request('/identity/backup', {
      method: 'PUT',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(backupPayload),
    });
    expect(putResponse.status).toBe(200);

    const putBody = await putResponse.json() as { success: boolean; backup: typeof backupPayload };
    expect(putBody.success).toBe(true);
    expect(putBody.backup.createdAt).toBeGreaterThan(0);
    expect(putBody.backup.updatedAt).toBeGreaterThanOrEqual(putBody.backup.createdAt);

    const getResponse = await harness.request('/identity/backup', { headers: session.headers });
    expect(getResponse.status).toBe(200);
    const storedBackup = await getResponse.json() as typeof backupPayload;
    expect(storedBackup.ownerUserRootId).toBe(backupPayload.ownerUserRootId);
    expect(storedBackup.envelope).toEqual(backupPayload.envelope);
    expect(storedBackup.createdAt).toBe(putBody.backup.createdAt);
    expect(storedBackup.updatedAt).toBe(putBody.backup.updatedAt);

    const statusAfter = await harness.request('/identity/backup/status', { headers: session.headers });
    expect(statusAfter.status).toBe(200);
    await expect(statusAfter.json()).resolves.toEqual({
      enabled: true,
      ownerUserRootId: backupPayload.ownerUserRootId,
      createdAt: putBody.backup.createdAt,
      updatedAt: putBody.backup.updatedAt,
    });

    const deleteResponse = await harness.request('/identity/backup', {
      method: 'DELETE',
      headers: session.headers,
    });
    expect(deleteResponse.status).toBe(200);

    const missingResponse = await harness.request('/identity/backup', { headers: session.headers });
    expect(missingResponse.status).toBe(404);
  });

  test('requires auth for identity backup routes', async () => {
    const response = await harness.request('/identity/backup/status');
    expect(response.status).toBe(401);
  });

  test('isolates identity backups across accounts', async () => {
    const ownerSession = await harness.createDeviceSession();
    const otherSession = await harness.createDeviceSession({
      githubToken: 'github-access-token-other',
      githubUser: {
        id: 67890,
        login: 'spacecat',
        name: 'Space Cat',
        email: 'spacecat@example.com',
        avatar_url: 'https://avatars.example.com/spacecat',
      },
    });

    const putResponse = await harness.request('/identity/backup', {
      method: 'PUT',
      headers: {
        ...ownerSession.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(backupPayload),
    });
    expect(putResponse.status).toBe(200);

    const otherGet = await harness.request('/identity/backup', { headers: otherSession.headers });
    expect(otherGet.status).toBe(404);

    const otherDelete = await harness.request('/identity/backup', {
      method: 'DELETE',
      headers: otherSession.headers,
    });
    expect(otherDelete.status).toBe(404);

    const ownerGet = await harness.request('/identity/backup', { headers: ownerSession.headers });
    expect(ownerGet.status).toBe(200);
  });
});
