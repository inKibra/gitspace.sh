import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { DEFAULT_ACCOUNT_POINTER, machineClientSchema } from '@gitspace/protocol/default-release';
import { machineClientResponse } from '../src/default-client.js';
import { publishDefaultFixture } from './default-release-fixture.js';

async function put(bucket: R2Bucket, key: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  await bucket.put(key, bytes);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  return { sha256, size: bytes.byteLength };
}
/** A tenant pinned to the default fixture, whose linux-x64 machine has a published client, and a darwin-arm64 stable channel. */
async function publishedTenant() {
  const fixture = await publishDefaultFixture(env.RELEASES);
  const native = fixture.release.machines[0]!;
  const root = 'distribution/v1/releases/fixture/linux-x64/';
  const client = await put(env.RELEASES, `${root}gitspace`, 'pinned linux client');
  await put(env.RELEASES, `${root}manifest.json`, JSON.stringify({ schemaVersion: 1, release: 'fixture', platform: 'linux-x64', client, machine: native }));
  const stableRoot = 'distribution/v1/releases/1.0.0-rc.stable/darwin-arm64/';
  const stable = await put(env.DISTRIBUTION, `${stableRoot}gitspace`, 'stable darwin client');
  const manifest = await put(env.DISTRIBUTION, `${stableRoot}manifest.json`, JSON.stringify({ schemaVersion: 1, release: '1.0.0-rc.stable', platform: 'darwin-arm64', client: stable }));
  await env.DISTRIBUTION.put('distribution/v1/stable/darwin-arm64.json', JSON.stringify({ schemaVersion: 1, release: '1.0.0-rc.stable', platform: 'darwin-arm64', manifest }));
  const tenant = crypto.randomUUID();
  await env.DEPLOYMENTS.getByName(tenant).recordDeploy({
    sha: fixture.commit, workerKey: fixture.release.worker.manifest.key,
    metadata: { ...fixture.release.worker.metadata, resources: [{ name: 'DEFAULT_ACCOUNT_RELEASE', source: 'literal', value: fixture.pin }] },
    healthy: true, revertedTo: null, appliedMigrationTag: null,
  });
  return { tenant, root, client, stable, native };
}
const request = (tenant: string, path: string, method = 'GET') => machineClientResponse(new Request(`https://platform.test/__platform/tenants/${tenant}${path}`, { method }), env, tenant, path);

it('answers the client of the pinned default for its platform and streams exactly that release', async () => {
  const { tenant, client } = await publishedTenant();
  // Only the pin names the default now: an unpinned tenant has no release to follow.
  await env.RELEASES.delete(DEFAULT_ACCOUNT_POINTER);
  const answer = await request(tenant, '/machine-release/client/linux-x64');
  expect(answer.status).toBe(200);
  expect(machineClientSchema.parse(await answer.json())).toEqual({ release: 'fixture', platform: 'linux-x64', ...client });
  const download = await request(tenant, '/machine-release/client/linux-x64/fixture');
  expect(download.status).toBe(200);
  expect(download.headers.get('content-length')).toBe(String(client.size));
  expect(new TextDecoder().decode(await download.arrayBuffer())).toBe('pinned linux client');
  expect((await request(tenant, '/machine-release/client/linux-x64/1.0.0-rc.stable')).status).toBe(404);
  expect((await request(crypto.randomUUID(), '/machine-release/client/linux-x64')).status).toBe(409);
});

it('answers the stable channel client for a platform the account release has no machine for', async () => {
  const { tenant, stable } = await publishedTenant();
  const answer = await request(tenant, '/machine-release/client/darwin-arm64');
  expect(answer.status).toBe(200);
  expect(machineClientSchema.parse(await answer.json())).toEqual({ release: '1.0.0-rc.stable', platform: 'darwin-arm64', ...stable });
  const download = await request(tenant, '/machine-release/client/darwin-arm64/1.0.0-rc.stable');
  expect(new TextDecoder().decode(await download.arrayBuffer())).toBe('stable darwin client');
});

it('refuses an unknown platform', async () => {
  const { tenant } = await publishedTenant();
  expect((await request(tenant, '/machine-release/client/windows-x64')).status).toBe(404);
});

it('refuses a client manifest that does not name the pinned machine', async () => {
  const { tenant, root, client, native } = await publishedTenant();
  await put(env.RELEASES, `${root}manifest.json`, JSON.stringify({ schemaVersion: 1, release: 'fixture', platform: 'linux-x64', client, machine: { ...native, generation: `sha256:${'0'.repeat(64)}` } }));
  expect((await request(tenant, '/machine-release/client/linux-x64')).status).toBe(409);
  expect((await request(tenant, '/machine-release/client/linux-x64/fixture')).status).toBe(409);
});

it('refuses a stable manifest that differs from the digest its channel records', async () => {
  const { tenant } = await publishedTenant();
  await put(env.DISTRIBUTION, 'distribution/v1/releases/1.0.0-rc.stable/darwin-arm64/manifest.json', JSON.stringify({ schemaVersion: 1, release: '1.0.0-rc.stable', platform: 'darwin-arm64', client: { sha256: 'f'.repeat(64), size: 20 } }));
  expect((await request(tenant, '/machine-release/client/darwin-arm64')).status).toBe(409);
});
