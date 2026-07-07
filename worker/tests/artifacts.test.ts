import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { WorkerHarness } from './helpers/worker-harness';
import { createWorkerHarness } from './helpers/worker-harness';
import { MemoryArtifactsHost } from '../src/services/artifacts-upstream';

let harness: WorkerHarness;

beforeEach(async () => {
  harness = await createWorkerHarness();
});

afterEach(async () => {
  await harness?.dispose();
});

function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

interface ProvisionResponse {
  project: string;
  gitUrl: string;
  token: string;
  expiresAt: number;
}

async function createOwnerWithHandle(handle = 'brad') {
  const session = await harness.createDeviceSession();
  const response = await harness.request('/subdomains', {
    method: 'POST',
    headers: { ...session.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subdomain: handle }),
  });
  expect(response.status).toBe(200);
  return session;
}

async function provision(headers: Record<string, string>, project: string) {
  return harness.request('/artifacts/provision', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ project }),
  });
}

describe('artifacts provisioning', () => {
  test('provisions a managed repo and returns only a short-lived scoped token', async () => {
    const session = await createOwnerWithHandle();

    const before = Date.now();
    const response = await provision(session.headers, 'brad/demo');
    expect(response.status).toBe(200);
    const bodyText = await response.text();
    const created = JSON.parse(bodyText) as ProvisionResponse;

    expect(created.project).toBe('brad/demo');
    expect(created.gitUrl).toBe('https://artifacts-upstream.example.com/brad--demo.git');
    expect(created.token).toStartWith('art_v1_');
    expect(created.expiresAt).toBeGreaterThan(before);
    expect(created.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);

    // The long-lived upstream credential must never appear in responses.
    // (The git REMOTE is intentionally exposed — CF's model is direct data
    // plane: any git client + a short-lived repo-scoped art_v1 token.)
    expect(bodyText).not.toContain(harness.upstream.cfArtifactsApiToken);

    const repos = harness.upstream.listArtifactRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0]?.name).toBe('brad--demo');
    // Verified API mints tokens by repo NAME at the namespace level.
    expect(harness.upstream.getLastArtifactTokenRequest()).toMatchObject({
      repoId: 'brad--demo',
      access: 'write',
      ttlSeconds: 3600,
    });
  });

  test('re-provisioning is idempotent and mints a fresh token', async () => {
    const session = await createOwnerWithHandle();

    const first = await provision(session.headers, 'brad/demo');
    expect(first.status).toBe(200);
    const firstBody = await first.json() as ProvisionResponse;

    const second = await provision(session.headers, 'brad/demo');
    expect(second.status).toBe(200);
    const secondBody = await second.json() as ProvisionResponse;

    expect(harness.upstream.listArtifactRepos()).toHaveLength(1);
    expect(secondBody.project).toBe(firstBody.project);
    expect(secondBody.gitUrl).toBe(firstBody.gitUrl);
    expect(secondBody.token).not.toBe(firstBody.token);
  });

  test('rejects malformed project refs and unknown handles', async () => {
    const session = await createOwnerWithHandle();

    const malformed = await provision(session.headers, 'brad/demo/extra');
    expect(malformed.status).toBe(400);

    const unknownHandle = await provision(session.headers, 'nosuch/demo');
    expect(unknownHandle.status).toBe(404);
  });
});

describe('artifacts token refresh', () => {
  test('re-mints a short-lived token for a provisioned project', async () => {
    const session = await createOwnerWithHandle();
    const provisioned = await provision(session.headers, 'brad/demo');
    expect(provisioned.status).toBe(200);
    const initial = await provisioned.json() as ProvisionResponse;

    const refresh = await harness.request('/artifacts/token?project=brad/demo', {
      headers: session.headers,
    });
    expect(refresh.status).toBe(200);
    const refreshed = await refresh.json() as ProvisionResponse;
    expect(refreshed.project).toBe('brad/demo');
    expect(refreshed.gitUrl).toBe('https://artifacts-upstream.example.com/brad--demo.git');
    expect(refreshed.token).toStartWith('art_v1_');
    expect(refreshed.token).not.toBe(initial.token);
    expect(refreshed.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
  });

  test('returns 404 for a project that has not been provisioned', async () => {
    const session = await createOwnerWithHandle();
    const response = await harness.request('/artifacts/token?project=brad/never-provisioned', {
      headers: session.headers,
    });
    expect(response.status).toBe(404);
  });
});

describe('artifacts blobs', () => {
  test('PUT/HEAD/GET round trip with sha256 oid addressing', async () => {
    const session = await createOwnerWithHandle();
    await provision(session.headers, 'brad/demo');

    const content = 'hello artifacts blob';
    const oid = sha256Hex(content);
    const blobPath = `/artifacts/blobs/brad/demo/${oid}`;

    const missingHead = await harness.request(blobPath, {
      method: 'HEAD',
      headers: session.headers,
    });
    expect(missingHead.status).toBe(404);

    const put = await harness.request(blobPath, {
      method: 'PUT',
      headers: session.headers,
      body: content,
    });
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toMatchObject({
      oid,
      size: content.length,
      existed: false,
    });

    const head = await harness.request(blobPath, {
      method: 'HEAD',
      headers: session.headers,
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe(String(content.length));

    const get = await harness.request(blobPath, { headers: session.headers });
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toBe('application/octet-stream');
    await expect(get.text()).resolves.toBe(content);

    // Re-upload short-circuits on the existing object.
    const rePut = await harness.request(blobPath, {
      method: 'PUT',
      headers: session.headers,
      body: content,
    });
    expect(rePut.status).toBe(200);
    await expect(rePut.json()).resolves.toMatchObject({ oid, existed: true });
  });

  test('rejects an oid that does not match the content sha256', async () => {
    const session = await createOwnerWithHandle();
    await provision(session.headers, 'brad/demo');

    const wrongOid = sha256Hex('some other content');
    const response = await harness.request(`/artifacts/blobs/brad/demo/${wrongOid}`, {
      method: 'PUT',
      headers: session.headers,
      body: 'actual content',
    });
    expect(response.status).toBe(400);

    const head = await harness.request(`/artifacts/blobs/brad/demo/${wrongOid}`, {
      method: 'HEAD',
      headers: session.headers,
    });
    expect(head.status).toBe(404);
  });

  test('rejects malformed oids and unprovisioned projects', async () => {
    const session = await createOwnerWithHandle();
    await provision(session.headers, 'brad/demo');

    const badOid = await harness.request('/artifacts/blobs/brad/demo/not-a-sha', {
      method: 'PUT',
      headers: session.headers,
      body: 'content',
    });
    expect(badOid.status).toBe(400);

    const oid = sha256Hex('content');
    const unprovisioned = await harness.request(`/artifacts/blobs/brad/other/${oid}`, {
      method: 'PUT',
      headers: session.headers,
      body: 'content',
    });
    expect(unprovisioned.status).toBe(404);
  });
});

describe('artifacts authorization', () => {
  test('requires authentication on every route', async () => {
    const oid = sha256Hex('content');
    const routes: Array<[string, string]> = [
      ['POST', '/artifacts/provision'],
      ['GET', '/artifacts/token?project=brad/demo'],
      ['PUT', `/artifacts/blobs/brad/demo/${oid}`],
      ['GET', `/artifacts/blobs/brad/demo/${oid}`],
      ['HEAD', `/artifacts/blobs/brad/demo/${oid}`],
    ];

    for (const [method, path] of routes) {
      const response = await harness.request(path, { method });
      expect(response.status).toBe(401);
    }
  });

  test('rejects a different user for provision, token, and blobs', async () => {
    const owner = await createOwnerWithHandle();
    await provision(owner.headers, 'brad/demo');

    const stranger = await harness.createDeviceSession({
      githubToken: 'stranger-token',
      githubUser: {
        id: 67890,
        login: 'stranger',
        name: 'Some Stranger',
        email: 'stranger@example.com',
        avatar_url: 'https://avatars.example.com/stranger',
      },
    });

    const provisionAttempt = await provision(stranger.headers, 'brad/demo');
    expect(provisionAttempt.status).toBe(403);

    const tokenAttempt = await harness.request('/artifacts/token?project=brad/demo', {
      headers: stranger.headers,
    });
    expect(tokenAttempt.status).toBe(403);

    const oid = sha256Hex('secret bytes');
    const putAttempt = await harness.request(`/artifacts/blobs/brad/demo/${oid}`, {
      method: 'PUT',
      headers: stranger.headers,
      body: 'secret bytes',
    });
    expect(putAttempt.status).toBe(403);

    const getAttempt = await harness.request(`/artifacts/blobs/brad/demo/${oid}`, {
      headers: stranger.headers,
    });
    expect(getAttempt.status).toBe(403);
  });

  test('allows a collaborator granted via subdomain_access identity', async () => {
    const owner = await createOwnerWithHandle();
    await provision(owner.headers, 'brad/demo');

    const collaborator = await harness.createDeviceSession({
      githubToken: 'collab-token',
      githubUser: {
        id: 24680,
        login: 'collab',
        name: 'Collaborator',
        email: 'collab@example.com',
        avatar_url: 'https://avatars.example.com/collab',
      },
    });

    // No grant yet: rejected.
    const denied = await harness.request('/artifacts/token?project=brad/demo', {
      headers: collaborator.headers,
    });
    expect(denied.status).toBe(403);

    // Grant the collaborator's machine identity on the handle's subdomain.
    const db = await harness.mf.getD1Database('DB');
    const subdomain = await db.prepare(
      "SELECT id FROM subdomains WHERE subdomain = 'brad' AND status = 'active'",
    ).first<{ id: string }>();
    expect(subdomain).toBeTruthy();
    await db.prepare(
      `INSERT INTO subdomain_access (id, subdomain_id, identity_id, label, permissions, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        subdomain!.id,
        collaborator.fingerprint,
        'collab machine',
        JSON.stringify({ read: true, write: true, manage: false }),
        Date.now(),
      )
      .run();

    const granted = await harness.request('/artifacts/token?project=brad/demo', {
      headers: collaborator.headers,
    });
    expect(granted.status).toBe(200);
    const minted = await granted.json() as ProvisionResponse;
    expect(minted.token).toStartWith('art_v1_');

    const content = 'collaborator blob';
    const oid = sha256Hex(content);
    const put = await harness.request(`/artifacts/blobs/brad/demo/${oid}`, {
      method: 'PUT',
      headers: collaborator.headers,
      body: content,
    });
    expect(put.status).toBe(200);
  });
});

describe('MemoryArtifactsHost (dev/test upstream impl)', () => {
  test('creates repos idempotently and mints expiring scoped tokens', async () => {
    const host = new MemoryArtifactsHost();

    const repo = await host.createRepo('brad--demo');
    const again = await host.createRepo('brad--demo');
    expect(again.repoId).toBe(repo.repoId);
    expect(repo.gitUrl).toBe('memory://artifacts/brad--demo.git');

    const before = Date.now();
    const minted = await host.mintScopedToken(repo.repoId, 'read', 600);
    expect(minted.token).toStartWith('cfa_mem_read_');
    expect(minted.expiresAt).toBeGreaterThanOrEqual(before + 600 * 1000);
    expect(minted.expiresAt).toBeLessThanOrEqual(Date.now() + 600 * 1000);
  });
});
