import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultMachineResponse } from '../src/default-native.js';
import { defaultReleaseReader } from '../src/default-release.js';
import { loadPinnedDefaultRelease } from '@gitspace/protocol/default-release';
import { publishDefaultFixture } from './default-release-fixture.js';

afterEach(() => vi.restoreAllMocks());
const select = (tenant: string, selection: object) => defaultMachineResponse(new Request('https://platform.test/machine/release', { method: 'POST', body: JSON.stringify(selection) }), env, tenant);

it('pre-pin tenant selects the authenticated current native default', async () => {
  const fixture = await publishDefaultFixture(env.RELEASES);
  const response = await select(crypto.randomUUID(), { platform: 'linux-x64' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ commit: fixture.commit, platform: 'linux-x64' });
});

it('rejects self-consistent pinned manifest substitution', async () => {
  const fixture = await publishDefaultFixture(env.RELEASES);
  const reader = defaultReleaseReader(env.RELEASES);
  expect((await loadPinnedDefaultRelease(reader, fixture.pin)).commit).toBe(fixture.commit);
  const replacement = await fixture.object(fixture.release.frontend.files[0]!.key, '<html>replacement</html>');
  fixture.release.frontend.files[0] = { ...replacement, path: 'index.html', contentType: 'text/html' };
  await fixture.object(`defaults/releases/${fixture.commit}/manifest.json`, JSON.stringify(fixture.release));
  await expect(loadPinnedDefaultRelease(reader, fixture.pin)).rejects.toThrow('integrity');
});

it('bounds repeated unknown-generation scans per tenant without losing historical recovery', async () => {
  const fixture = await publishDefaultFixture(env.RELEASES);
  const tenant = crypto.randomUUID();
  await env.DEPLOYMENTS.getByName(tenant).recordDeploy({
    sha: fixture.commit, bundleKey: fixture.release.worker.bundle.key,
    metadata: { ...fixture.release.worker.metadata, resources: [{ name: 'DEFAULT_ACCOUNT_RELEASE', source: 'literal', value: fixture.pin }] },
    healthy: true, revertedTo: null, appliedMigrationTag: null,
  });
  const list = vi.spyOn(env.RELEASES, 'list');
  const unknown = `sha256:${'9'.repeat(64)}`;
  expect((await select(tenant, { generation: unknown })).status).toBe(409);
  expect(list).toHaveBeenCalled();
  const scans = list.mock.calls.length;
  expect((await select(tenant, { generation: unknown })).status).toBe(409);
  expect(list).toHaveBeenCalledTimes(scans);
  const historical = `sha256:${'8'.repeat(64)}`;
  const root = 'distribution/v1/releases/historical/linux-x64/';
  const provenance = await fixture.object(`${root}provenance.json`, JSON.stringify({ platform: 'linux-x64', machine: { treeHash: historical } }));
  await fixture.object(`${root}manifest.json`, JSON.stringify({ platform: 'linux-x64', provenance }));
  const recovered = await select(tenant, { generation: historical });
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ commit: fixture.commit, platform: 'linux-x64' });
  const recoveredScans = list.mock.calls.length;
  expect((await select(tenant, { generation: historical })).status).toBe(200);
  expect(list).toHaveBeenCalledTimes(recoveredScans);
});

it('shares a slow unknown-generation scan and caches its result for the full window after it settles', async () => {
  const fixture = await publishDefaultFixture(env.RELEASES);
  const tenant = crypto.randomUUID();
  await env.DEPLOYMENTS.getByName(tenant).recordDeploy({
    sha: fixture.commit, bundleKey: fixture.release.worker.bundle.key,
    metadata: { ...fixture.release.worker.metadata, resources: [{ name: 'DEFAULT_ACCOUNT_RELEASE', source: 'literal', value: fixture.pin }] },
    healthy: true, revertedTo: null, appliedMigrationTag: null,
  });
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const original = env.RELEASES.list.bind(env.RELEASES);
  const gate = Promise.withResolvers<void>();
  const historicalScans: string[] = [];
  vi.spyOn(env.RELEASES, 'list').mockImplementation(async (options) => {
    if (options?.prefix === 'distribution/v1/releases/') {
      historicalScans.push(options.cursor ?? 'first');
      await gate.promise;
    }
    return original(options);
  });
  const unknown = `sha256:${'7'.repeat(64)}`;
  const first = select(tenant, { generation: unknown });
  await vi.waitFor(() => expect(historicalScans).toHaveLength(1));
  now += 61_000;
  const second = select(tenant, { generation: unknown });
  gate.resolve();
  expect((await first).status).toBe(409);
  expect((await second).status).toBe(409);
  expect(historicalScans).toHaveLength(1);
  now += 59_000;
  expect((await select(tenant, { generation: unknown })).status).toBe(409);
  expect(historicalScans).toHaveLength(1);
});
