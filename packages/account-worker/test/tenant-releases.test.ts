import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { env, SELF, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { HttpResponse, http } from 'msw';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  createSignedControlRequest,
  credentialProtocolBase64,
  signCredentialAuthorityGrant,
  type ControlOperation,
} from '@gitspace/protocol';
import {
  workerModuleKey,
  deploymentStatusSchema,
  releaseRecordSchema,
  type PlatformDeployRequest,
  type ReleaseRecord,
  type StageReleaseInput,
  type TenantDesired,
} from '@gitspace/protocol/deployment';
import worker, { TenantReleasesDO } from '../src/index.js';
import { revertTenantRelease } from '../src/application.js';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';

const machineSigningPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const machineExchangePrivateKey = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
const HASH: `sha256:${string}` = `sha256:${'ab'.repeat(32)}`;

function stageInput(sha: string): StageReleaseInput {
  return {
    sha,
    inferenceVersion: 1,
    label: `workspace build ${sha}`,
    source: { kind: 'workspace', workspaceId: 'workspace-a', commit: 'a'.repeat(40), uncommittedFiles: 0 },
    artifacts: {
      worker: { key: `releases/${sha}/worker.manifest.json`, hash: HASH, size: 1024 },
      machine: { key: `releases/${sha}/machine.js`, hash: HASH, size: 2048 },
      frontend: { key: `releases/${sha}/frontend`, hash: HASH, size: 4096 },
    },
    worker: {
      mainModule: 'worker.mjs',
      compatibilityDate: '2026-08-27',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: [{ name: 'CREDENTIALS', className: 'CredentialVaultDO' }],
      resources: [
        { name: 'BLOBS', source: 'object-storage' },
        { name: 'DATA', source: 'object-storage' },
        { name: 'ACCOUNT_ID', source: 'account-id' },
        { name: 'TENANT_ID', source: 'tenant-id' },
        { name: 'AUTH_PUBLIC_KEY', source: 'root-public-key' },
        { name: 'RELAY_NAME', source: 'tenant-id' },
        { name: 'ACCOUNT_URL', source: 'application-url' },
        { name: 'RELAY_URL', source: 'transport-url' },
        { name: 'PLATFORM_URL', source: 'platform-url' },
        { name: 'PLATFORM_TOKEN', source: 'provider-token' },
        { name: 'GITSPACE_OMP_BROKER_TOKEN', source: 'provider-token' },
        { name: 'ASSETS', source: 'public-assets' },
        { name: 'STORAGE_BUCKET', source: 'object-storage-name' },
      ],
      migrations: [{ tag: 'v1', newSqliteClasses: ['CredentialVaultDO'], deletedClasses: [] }],
    },
  };
}

describe('release sources migration', () => {
  it('gives stored records their source once and drops a launch recorded before launch sources', async () => {
    const commit = 'c'.repeat(40);
    const base = { inferenceVersion: 1, builtBy: 'darktop', createdAt: '2026-10-01T00:00:00.000Z', artifacts: { worker: null, machine: null, frontend: null }, worker: null, status: { worker: 'pending', frontend: 'pending', machines: {} }, error: null };
    await runInDurableObject(env.TENANT_RELEASES.getByName(`migration-${crypto.randomUUID()}`), async (_instance, state) => {
      const legacy = [
        { ...base, sha: `${commit}-dirty.0123456789ab`, label: 'feature @ cccccccccccc', workspaceId: 'workspace-a' },
        { ...base, sha: 'd'.repeat(64), label: `Default ${commit}`, workspaceId: null },
        { ...base, sha: 'channel:12', label: 'Channel build', workspaceId: null },
      ];
      for (const record of legacy) state.storage.sql.exec('INSERT OR REPLACE INTO releases(sha, created_at, record_json) VALUES (?, ?, ?)', record.sha, record.createdAt, JSON.stringify(record));
      state.storage.sql.exec('INSERT OR REPLACE INTO latest_launch(id, machine_id, record_json) VALUES (1, ?, ?)', 'darktop', JSON.stringify({ launchId: crypto.randomUUID(), workspaceId: 'workspace-a', targets: ['worker'], sha: null, phase: 'queued', message: '', status: 'running', error: null, startedAt: base.createdAt, updatedAt: base.createdAt }));
      // A new instance runs the constructor's migration over what an older release stored.
      new TenantReleasesDO(state, env);
      const stored = state.storage.sql.exec<{ sha: string; record_json: string }>('SELECT sha, record_json FROM releases').toArray();
      const sources = Object.fromEntries(stored.map(row => [row.sha, releaseRecordSchema.parse(JSON.parse(row.record_json)).source]));
      expect(sources).toEqual({
        [`${commit}-dirty.0123456789ab`]: { kind: 'workspace', workspaceId: 'workspace-a', commit, uncommittedFiles: null },
        ['d'.repeat(64)]: { kind: 'canonical', repository: 'https://github.com/inKibra/gitspace.sh.git', branch: null, commit },
        'channel:12': null,
      });
      expect(state.storage.sql.exec('SELECT id FROM latest_launch').toArray()).toEqual([]);
      // Running it again changes nothing.
      new TenantReleasesDO(state, env);
      expect(state.storage.sql.exec<{ record_json: string }>('SELECT record_json FROM releases ORDER BY sha').toArray().map(row => row.record_json)).toEqual(stored.sort((left, right) => left.sha.localeCompare(right.sha)).map(row => row.record_json));
    });
  });
});

async function tenant() {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  const handle = env.TENANT_ID;
  network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: null } })));
  await vault.bootstrap({
    userId,
    rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)),
    vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)),
  });
  await vault.registerDevice(signCredentialAuthorityGrant({
    version: 1,
    userId,
    machineId: 'machine-a',
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineSigningPrivateKey)),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(machineExchangePrivateKey)),
    capabilities: ['space.control'],
    generation: 1,
  }, tenantRootPrivateKey));
  await env.FLEET_CATALOG.getByName(userId).putMachine({
    id: 'machine-a', label: 'Machine A', state: 'online', rpcEndpoint: 'https://machine-a.test/rpc',
    kind: 'physical', provider: 'physical', notes: '', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null,
  });
  const control = async (operation: ControlOperation, payload: Record<string, unknown>, overrides: Partial<Env> = {}): Promise<unknown> => {
    const request = new Request('https://tenant.test/v1/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createSignedControlRequest({ userId, machineId: 'machine-a', operation, payload, signingPrivateKey: machineSigningPrivateKey })),
    });
    const response = Object.keys(overrides).length === 0 ? await SELF.fetch(request) : await worker.fetch(request, { ...env, ...overrides });
    const body = await response.json() as { status: string; value?: unknown; error?: { code: string; message: string } };
    if (response.status !== 200) throw new Error(`${operation} failed: ${body.error?.code} ${body.error?.message}`);
    return body.value;
  };
  return { userId, handle, control, origin: `https://${handle}.gitspace.sh` };
}

/** The account's status once its latest revert has ended, read from the release object, not through a browser. */
async function revertEnded(userId: string) {
  const releases = env.TENANT_RELEASES.getByName(userId);
  return vi.waitFor(async () => {
    const status = deploymentStatusSchema.parse(await releases.status(userId, { sha: null, version: null }));
    if (status.revert?.status !== 'succeeded' && status.revert?.status !== 'failed') throw new Error('Back to stable is still running');
    return status;
  });
}

describe('tenant releases', () => {
  it('reports the answering Worker stamp separately from a different platform deployment record', async () => {
    const { control } = await tenant();
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: 'platform-record' } })));
    expect(await control('deploy.status', {})).toMatchObject({
      current: {
        worker: { sha: 'test-inference-worker', version: 'test-inference-worker' },
        platformWorker: { sha: 'platform-record', version: 'platform-record' },
      },
    });
  });

  it('keeps the latest launch its building machine reports and ignores an older report of the same launch', async () => {
    const { control } = await tenant();
    expect(deploymentStatusSchema.parse(await control('deploy.status', {})).launch).toBeNull();
    const queued = { launchId: crypto.randomUUID(), source: { kind: 'workspace', workspaceId: 'workspace-a' }, targets: ['frontend'], sha: null, phase: 'queued', message: 'Preparing the build', status: 'running', error: null, startedAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T10:00:00.000Z' };
    const building = { ...queued, sha: 'b'.repeat(40), phase: 'build', message: 'building frontend', updatedAt: '2026-10-09T10:01:00.000Z' };
    await control('deploy.launchProgress', queued);
    await control('deploy.launchProgress', building);
    await control('deploy.launchProgress', queued);
    expect(deploymentStatusSchema.parse(await control('deploy.status', {})).launch).toEqual(building);
    const next = { ...queued, launchId: crypto.randomUUID(), startedAt: '2026-10-09T09:00:00.000Z', updatedAt: '2026-10-09T09:00:00.000Z' };
    await control('deploy.launchProgress', next);
    expect(deploymentStatusSchema.parse(await control('deploy.status', {})).launch).toEqual(next);
  });

  it('records a launch finished when its release is applied, without the launching machine reporting it', async () => {
    const { control } = await tenant();
    const input = stageInput('self-launch');
    await control('deploy.stage', input);
    // The building machine's last report before it is replaced by the release it launches.
    const launching = { launchId: crypto.randomUUID(), source: { kind: 'workspace', workspaceId: 'workspace-a' }, targets: ['frontend'], sha: input.sha, phase: 'launch', message: 'launching into frontend', status: 'running', error: null, startedAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T10:01:00.000Z' };
    await control('deploy.launchProgress', launching);
    await control('deploy.launch', { sha: input.sha, targets: ['frontend'] });
    expect(deploymentStatusSchema.parse(await control('deploy.status', {})).launch).toMatchObject({ launchId: launching.launchId, phase: 'launched', status: 'succeeded', message: 'worker=skipped machine=skipped frontend=applied', error: null });
  });

  it('a Worker launch is finished by the version it launched, whose old version may never answer the launch call', async () => {
    const { userId, control } = await tenant();
    const releases = env.TENANT_RELEASES.getByName(userId);
    const input = stageInput('worker-self-launch');
    await control('deploy.stage', input);
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: 'test-inference-worker' } })));
    await env.CREDENTIALS.getByName(userId).ensureInference();
    const launching = { launchId: crypto.randomUUID(), source: { kind: 'workspace', workspaceId: 'workspace-a' }, targets: ['worker', 'frontend'], sha: input.sha, phase: 'launch', message: 'launching into worker, frontend', status: 'running', error: null, startedAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T10:01:00.000Z' };
    await control('deploy.launchProgress', launching);
    // The launch call deploys the Worker and is cut off before it records anything.
    await releases.launch({ sha: input.sha, targets: ['worker', 'frontend'] });
    await releases.certifyOwnLaunch('some-other-version');
    expect(deploymentStatusSchema.parse(await control('deploy.status', {})).launch).toMatchObject({ status: 'running', phase: 'launch' });
    await releases.certifyOwnLaunch(input.sha);
    expect(deploymentStatusSchema.parse(await control('deploy.status', {})).launch).toMatchObject({ launchId: launching.launchId, phase: 'launched', status: 'succeeded', message: 'worker=applied machine=skipped frontend=applied' });
  });

  it('a launch left running is ended by its building machine restarting, and only by that', async () => {
    const { userId, control } = await tenant();
    const releases = env.TENANT_RELEASES.getByName(userId);
    const input = stageInput('restart-settles');
    await control('deploy.stage', input);
    const base = { source: { kind: 'workspace', workspaceId: 'workspace-a' }, targets: ['frontend', 'machine'], sha: input.sha, status: 'running', error: null, startedAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T10:01:00.000Z' };
    const status = async () => deploymentStatusSchema.parse(await control('deploy.status', {})).launch;

    // Died during the build: another machine's restart and a process that started before the last report change nothing.
    const building = { ...base, launchId: crypto.randomUUID(), phase: 'build', message: 'building frontend' };
    await control('deploy.launchProgress', building);
    await releases.launcherStarted('machine-b', { runningSha: null, startedAt: '2026-10-09T10:05:00.000Z' });
    await releases.launcherStarted('machine-a', { runningSha: null, startedAt: '2026-10-09T10:00:30.000Z' });
    expect(await status()).toMatchObject({ status: 'running', phase: 'build' });
    await releases.launcherStarted('machine-a', { runningSha: null, startedAt: '2026-10-09T10:05:00.000Z' });
    expect(await status()).toMatchObject({ launchId: building.launchId, status: 'failed', error: 'Interrupted: the building machine restarted during build.' });

    // Replaced by the release it was launching: the launch went through.
    const launching = { ...base, launchId: crypto.randomUUID(), phase: 'launch', message: 'launching into frontend, machine' };
    await control('deploy.launchProgress', launching);
    await releases.launch({ sha: input.sha, targets: ['frontend', 'machine'] });
    await releases.launcherStarted('machine-a', { runningSha: input.sha, startedAt: '2026-10-09T10:05:00.000Z' });
    expect(await status()).toMatchObject({ launchId: launching.launchId, status: 'succeeded', phase: 'launched' });
  });

  it('discarding ends only the running launch it names, and the machine\'s next report still wins', async () => {
    const { userId, control } = await tenant();
    const releases = env.TENANT_RELEASES.getByName(userId);
    const running = { launchId: crypto.randomUUID(), source: { kind: 'workspace', workspaceId: 'workspace-a' }, targets: ['frontend'], sha: null, phase: 'install', message: 'installing', status: 'running', error: null, startedAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T10:01:00.000Z' };
    await control('deploy.launchProgress', running);
    await releases.discardLaunch(crypto.randomUUID());
    expect(deploymentStatusSchema.parse(await control('deploy.status', {})).launch).toMatchObject({ status: 'running' });
    await releases.discardLaunch(running.launchId);
    expect(deploymentStatusSchema.parse(await control('deploy.status', {})).launch).toMatchObject({ status: 'failed', error: 'Discarded: no machine was reporting this launch.' });
    await control('deploy.launchProgress', { ...running, phase: 'build', message: 'building frontend', updatedAt: new Date(Date.now() + 60_000).toISOString() });
    expect(deploymentStatusSchema.parse(await control('deploy.status', {})).launch).toMatchObject({ status: 'running', phase: 'build' });
  });

  it('rejects retired OMP staging, activation, and acknowledgements without changing the release', async () => {
    const { control } = await tenant();
    const input = stageInput('retired-target');
    await control('deploy.stage', input);
    const before = await control('deploy.status', {});
    await expect(control('deploy.stage', { ...input, omp: null })).rejects.toThrow();
    await expect(control('deploy.stage', { ...input, artifacts: { ...input.artifacts, omp: input.artifacts.machine } })).rejects.toThrow();
    await expect(control('deploy.launch', { sha: input.sha, targets: ['omp'] })).rejects.toThrow();
    expect(await control('deploy.status', {})).toEqual(before);
  });

  it('does not let a compatible machine-only rebuild certify retained legacy Worker and frontend artifacts', async () => {
    const { userId } = await tenant();
    const releases = env.TENANT_RELEASES.getByName(userId);
    const input = stageInput('mixed-capabilities');
    await releases.stage({ ...input, inferenceVersion: undefined }, 'machine-a');
    await releases.stage({
      ...input, artifacts: { worker: null, frontend: null, machine: input.artifacts.machine }, worker: null,
    }, 'machine-a');
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: 'test-inference-worker' } })));
    await env.CREDENTIALS.getByName(userId).ensureInference();
    await expect(Promise.resolve(releases.launch({ sha: input.sha, targets: ['worker', 'frontend'] }))).rejects.toThrow();
    const rejected = await releases.status(userId, { sha: null, version: null });
    expect(rejected.desired).toMatchObject({ worker: null, machine: null, frontend: null });

    // Replacing every legacy target with a compatible build permits forward repair.
    await releases.stage(input, 'machine-a');
    await releases.stage({
      ...input, artifacts: { worker: null, frontend: null, machine: input.artifacts.machine }, worker: null,
    }, 'machine-a');
    const launched = await releases.launch({ sha: input.sha, targets: ['worker', 'frontend'] });
    expect(launched!.desired).toMatchObject({ worker: input.sha, frontend: input.sha });
  });

  it('keeps the deployed frontend and Worker launchable when machine recovery stages the same revision', async () => {
    const { userId, control, origin } = await tenant();
    const releases = env.TENANT_RELEASES.getByName(userId);
    const input = stageInput('split-targets');
    const html = '<!doctype html><title>retained frontend</title>';
    await env.DATA.put(`users/${userId}/releases/split-targets/frontend/index.html`, html);
    await control('deploy.stage', { ...input, artifacts: { ...input.artifacts, machine: null } });
    await releases.launch({ sha: input.sha, targets: ['worker', 'frontend'] });
    await releases.setWorkerStatus(input.sha, 'applied', null);
    await control('deploy.stage', {
      ...input, artifacts: { worker: null, machine: input.artifacts.machine, frontend: null },
      worker: null,
    });
    await control('deploy.launch', { sha: input.sha, targets: ['machine'] });
    expect(await (await SELF.fetch(new Request(`${origin}/`))).text()).toBe(html);
    const status = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(status.desired).toMatchObject({ worker: input.sha, frontend: input.sha, machine: input.sha });
    expect(status.releases[0]?.status).toMatchObject({ worker: 'applied', frontend: 'applied' });
    const relaunched = await releases.launch({ sha: input.sha, targets: ['worker'] });
    expect(relaunched?.record.status.worker).toBe('pending');
  });

  it('keeps other targets launchable but fails the Worker target when platform deployment is unavailable', async () => {
    const { control } = await tenant();
    network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/deploy`, () => new HttpResponse(null, { status: 503 })));
    const staged = releaseRecordSchema.parse(await control('deploy.stage', stageInput('abc123')));
    expect(staged).toMatchObject({ sha: 'abc123', builtBy: 'machine-a', status: { worker: 'pending', frontend: 'pending', machines: {} }, error: null });

    const launched = await control('deploy.launch', { sha: 'abc123', targets: ['worker', 'machine', 'frontend'] }) as { record: ReleaseRecord; desired: TenantDesired };
    expect(releaseRecordSchema.parse(launched.record).status).toEqual({ worker: 'failed', frontend: 'applied', machines: {} });
    expect(launched.desired).toMatchObject({ worker: 'abc123', machine: 'abc123', frontend: 'abc123' });

    const status = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(status.desired).toMatchObject({ worker: 'abc123', machine: 'abc123', frontend: 'abc123' });
    expect(status.current).toEqual({
      worker: { sha: 'test-inference-worker', version: 'test-inference-worker' },
      platformWorker: { sha: null, version: null }, machines: {},
    });
    expect(status.releases.map((release) => release.sha)).toEqual(['abc123']);
    expect(status.releases[0]!.status.worker).toBe('failed');
    expect(status.releases[0]!.error).toContain('HTTP 503');
  });

  it('swaps the worker through the platform and surfaces auto-reverts', async () => {
    const { userId, control } = await tenant();
    const platform: Partial<Env> = { PLATFORM_URL: 'https://platform.test', PLATFORM_TOKEN: 'tenant-token' };
    const deploys: Array<{ authorization: string | null; body: PlatformDeployRequest }> = [];
    const reverts: unknown[] = [];
    let serving: string | null = null;
    network.use(
      http.get(`https://platform.test/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, credits: null, deployment: { active: serving } })),
      http.post(`https://platform.test/__platform/tenants/${env.TENANT_ID}/deploy`, async ({ request }) => {
        const body = await request.json() as PlatformDeployRequest;
        deploys.push({ authorization: request.headers.get('authorization'), body });
        if (body.sha === 'good111') serving = body.sha;
        return body.sha === 'good111'
          ? HttpResponse.json({ sha: body.sha, healthy: true, revertedTo: null, appliedMigrationTag: 'v1' })
          : HttpResponse.json({ sha: body.sha, healthy: false, revertedTo: 'good111', appliedMigrationTag: 'v1' });
      }),
      http.post(`https://platform.test/__platform/tenants/${env.TENANT_ID}/revert`, async ({ request }) => {
        reverts.push(await request.json());
        serving = 'channel:1';
        return HttpResponse.json({ sha: 'channel:1', healthy: true, revertedTo: null, appliedMigrationTag: 'v1' });
      }),
    );

    await control('deploy.stage', stageInput('good111'));
    const good = await control('deploy.launch', { sha: 'good111', targets: ['worker'] }, platform) as { record: ReleaseRecord };
    expect(good.record.status).toEqual({ worker: 'applied', frontend: 'skipped', machines: {} });
    expect(good.record.error).toBeNull();
    expect(deploys).toHaveLength(1);
    expect(deploys[0]).toEqual({
      authorization: 'Bearer tenant-token',
      body: { accountId: userId, sha: 'good111', manifestKey: `users/${userId}/releases/good111/worker.manifest.json`, manifestHash: HASH, metadata: stageInput('good111').worker },
    });

    await control('deploy.stage', stageInput('bad222'));
    const bad = await control('deploy.launch', { sha: 'bad222', targets: ['worker', 'frontend'] }, platform) as { record: ReleaseRecord; desired: TenantDesired };
    expect(bad.record.status).toEqual({ worker: 'failed', frontend: 'applied', machines: {} });
    expect(bad.record.error).toContain('reverted to good111');
    expect(bad.desired.worker).toBe('bad222');
    await control('deploy.stage', stageInput('machine333'));
    await control('deploy.launch', { sha: 'machine333', targets: ['machine'] });
    const status = deploymentStatusSchema.parse(await control('deploy.status', {}, platform));
    expect(status.desired).toMatchObject({ worker: 'bad222', machine: 'machine333', frontend: 'bad222' });
    expect(status.current.worker).toEqual({ sha: 'test-inference-worker', version: 'test-inference-worker' });
    expect(status.current.platformWorker).toEqual({ sha: 'good111', version: 'good111' });

    const started = deploymentStatusSchema.parse(await revertTenantRelease(env, userId));
    const reverted = await revertEnded(userId);
    expect(reverted.revert).toMatchObject({ revertId: started.revert?.revertId, status: 'succeeded', error: null });
    expect(reverted.desired).toMatchObject({ worker: null, machine: null, frontend: null });
    expect(reverts).toEqual([{ accountId: userId, to: 'channel', operationId: started.revert?.revertId }]);
    serving = 'channel';
    const unversionedChannel = deploymentStatusSchema.parse(await control('deploy.status', {}, platform));
    expect(unversionedChannel.current.platformWorker).toEqual({ sha: null, version: 'channel' });
  });

  it('requires inference-profile support from the channel once the account has cut over', async () => {
    const { userId, control } = await tenant();
    const reverts: unknown[] = [];
    let channelSupportsProfiles = false;
    network.use(
      http.get(`https://platform.test/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, credits: null, deployment: { active: 'tenant-release' } })),
      http.post(`https://platform.test/__platform/tenants/${env.TENANT_ID}/revert`, async ({ request }) => {
        reverts.push(await request.json());
        return channelSupportsProfiles
          ? HttpResponse.json({ sha: 'channel:1', healthy: true, revertedTo: null, appliedMigrationTag: 'v1' })
          : HttpResponse.json({ error: { code: 'RELEASE_INCOMPATIBLE', message: 'Release channel:0 does not advertise inferenceVersion 1' } }, { status: 409 });
      }),
    );
    await control('deploy.stage', stageInput('tenant-release'));
    await control('deploy.launch', { sha: 'tenant-release', targets: ['machine', 'frontend'] });
    await env.CREDENTIALS.getByName(userId).ensureInference();

    const refused = deploymentStatusSchema.parse(await revertTenantRelease(env, userId)).revert;
    const failed = await revertEnded(userId);
    expect(failed.revert).toMatchObject({ revertId: refused?.revertId, status: 'failed', error: expect.stringContaining('RELEASE_INCOMPATIBLE') });
    expect(failed.desired).toMatchObject({ machine: 'tenant-release', frontend: 'tenant-release' });

    channelSupportsProfiles = true;
    const retried = deploymentStatusSchema.parse(await revertTenantRelease(env, userId)).revert;
    expect(retried?.revertId).not.toBe(refused?.revertId);
    const reverted = await revertEnded(userId);
    expect(reverted.revert).toMatchObject({ revertId: retried?.revertId, status: 'succeeded' });
    expect(reverted.desired).toMatchObject({ worker: null, machine: null, frontend: null });
    expect(reverts).toEqual([
      { accountId: userId, to: 'channel', inferenceVersion: 1, operationId: refused?.revertId },
      { accountId: userId, to: 'channel', inferenceVersion: 1, operationId: retried?.revertId },
    ]);
  });

  it('answers Back to stable while the platform still swaps, and resets the selections only after a swap that succeeded', async () => {
    const { userId, control } = await tenant();
    // The platform answers each revert with the swap result the test releases.
    let answer = Promise.withResolvers<{ healthy: boolean }>();
    onTestFinished(() => answer.resolve({ healthy: false }));
    const reverts: unknown[] = [];
    network.use(
      http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: 'tenant-release' } })),
      http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/revert`, async ({ request }) => {
        reverts.push(await request.json());
        const { healthy } = await answer.promise;
        return HttpResponse.json({ sha: 'channel:1', healthy, revertedTo: null, appliedMigrationTag: null });
      }),
    );
    await control('deploy.stage', stageInput('tenant-release'));
    await control('deploy.launch', { sha: 'tenant-release', targets: ['machine', 'frontend'] });

    const first = deploymentStatusSchema.parse(await revertTenantRelease(env, userId));
    expect(first.revert).toMatchObject({ status: 'running', error: null });
    expect(first.desired).toMatchObject({ machine: 'tenant-release', frontend: 'tenant-release' });
    await vi.waitFor(() => expect(reverts).toHaveLength(1));
    // Asking again while it runs follows the same revert; the platform is asked once.
    expect(deploymentStatusSchema.parse(await revertTenantRelease(env, userId)).revert?.revertId).toBe(first.revert?.revertId);

    // Nobody follows it any more; the platform's swap fails its health probe.
    answer.resolve({ healthy: false });
    const failed = await revertEnded(userId);
    expect(failed.revert).toMatchObject({ revertId: first.revert?.revertId, status: 'failed', error: 'Platform reported channel:1 unhealthy' });
    expect(failed.desired).toMatchObject({ machine: 'tenant-release', frontend: 'tenant-release' });
    expect(reverts).toHaveLength(1);

    answer = Promise.withResolvers<{ healthy: boolean }>();
    const second = deploymentStatusSchema.parse(await revertTenantRelease(env, userId));
    expect(second.revert).toMatchObject({ status: 'running' });
    answer.resolve({ healthy: true });
    const reverted = await revertEnded(userId);
    expect(reverted.revert).toMatchObject({ revertId: second.revert?.revertId, status: 'succeeded', error: null });
    expect(reverted.desired).toMatchObject({ worker: null, machine: null, frontend: null });
  });

  it('finishes a revert whose object restarted during the swap from the outcome the platform kept', async () => {
    const { userId, control } = await tenant();
    const reads: string[] = [];
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/operations/:id`, ({ params }) => {
      reads.push(String(params.id));
      return HttpResponse.json({ sha: 'channel:1', healthy: true, revertedTo: null, appliedMigrationTag: null });
    }));
    await control('deploy.stage', stageInput('tenant-release'));
    await control('deploy.launch', { sha: 'tenant-release', targets: ['machine', 'frontend'] });
    const revertId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await runInDurableObject(env.TENANT_RELEASES.getByName(userId), (_instance, state) => {
      state.storage.sql.exec('INSERT INTO latest_revert(id, record_json) VALUES (1, ?)', JSON.stringify({ revertId, status: 'running', error: null, startedAt, updatedAt: startedAt }));
      // The instance that starts after the Worker swap replaced the one running the revert.
      new TenantReleasesDO(state, env);
    });
    const reverted = await revertEnded(userId);
    expect(reverted.revert).toMatchObject({ revertId, status: 'succeeded' });
    expect(reverted.desired).toMatchObject({ worker: null, machine: null, frontend: null });
    expect(reads).toEqual([revertId]);
  });

  it('the heartbeat picks up a revert no instance runs, and reports one past its deadline failed', async () => {
    const { userId, control } = await tenant();
    const reads: string[] = [];
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/operations/:id`, ({ params }) => {
      reads.push(String(params.id));
      return HttpResponse.json({ error: { code: 'RELEASE_INCOMPATIBLE', message: 'Release channel:0 does not advertise inferenceVersion 1' } }, { status: 409 });
    }));
    await control('deploy.stage', stageInput('tenant-release'));
    await control('deploy.launch', { sha: 'tenant-release', targets: ['machine', 'frontend'] });
    const releases = env.TENANT_RELEASES.getByName(userId);
    const running = async (startedAt: string) => {
      const revertId = crypto.randomUUID();
      await runInDurableObject(releases, async (_instance, state) => {
        state.storage.sql.exec('INSERT OR REPLACE INTO latest_revert(id, record_json) VALUES (1, ?)', JSON.stringify({ revertId, status: 'running', error: null, startedAt, updatedAt: startedAt }));
        await state.storage.setAlarm(Date.now() + 60_000);
      });
      return revertId;
    };

    const orphan = await running(new Date().toISOString());
    expect(await runDurableObjectAlarm(releases)).toBe(true);
    const failed = await revertEnded(userId);
    expect(failed.revert).toMatchObject({ revertId: orphan, status: 'failed', error: expect.stringContaining('RELEASE_INCOMPATIBLE') });
    expect(reads).toEqual([orphan]);

    const stale = await running(new Date(Date.now() - 16 * 60_000).toISOString());
    expect(await runDurableObjectAlarm(releases)).toBe(true);
    const expired = deploymentStatusSchema.parse(await releases.status(userId, { sha: null, version: null }));
    expect(expired.revert).toMatchObject({ revertId: stale, status: 'failed', error: expect.stringContaining('15 minutes') });
    expect(expired.desired).toMatchObject({ machine: 'tenant-release', frontend: 'tenant-release' });
    expect(reads).toEqual([orphan]);
    expect(await runInDurableObject(releases, (_instance, state) => state.storage.getAlarm())).toBeNull();
  });

  it('deploys only the bound tenant despite caller-supplied routing', async () => {
    const { userId, control } = await tenant();
    const foreignId = `foreign-${crypto.randomUUID()}`;
    const actions: Array<{ tenant: string; accountId: string; action: string }> = [];
    let serving: string | null = null;
    network.use(
      http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: serving } })),
      http.post(`${env.PLATFORM_URL}/__platform/tenants/:tenant/:action`, async ({ params, request }) => {
        const body = await request.json() as { accountId: string; sha?: string };
        actions.push({ tenant: String(params.tenant), accountId: body.accountId, action: String(params.action) });
        serving = params.action === 'revert' ? 'channel:1' : body.sha!;
        return HttpResponse.json({ sha: serving, healthy: true, revertedTo: null, appliedMigrationTag: 'v1' });
      }),
    );
    await control('deploy.stage', stageInput('tenant-release'));
    await control('deploy.launch', { sha: 'tenant-release', targets: ['worker'], tenant: 'foreign', accountId: foreignId });
    expect(serving).toBe('tenant-release');
    await revertTenantRelease(env, userId);
    await revertEnded(userId);
    expect(serving).toBe('channel:1');
    expect(actions).toEqual([
      { tenant: env.TENANT_ID, accountId: userId, action: 'deploy' },
      { tenant: env.TENANT_ID, accountId: userId, action: 'revert' },
    ]);
    const foreignLaunch = await SELF.fetch('https://tenant.test/v1/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createSignedControlRequest({
        userId: foreignId, machineId: 'machine-a', operation: 'deploy.launch',
        payload: { sha: 'tenant-release', targets: ['worker'] },
        signingPrivateKey: machineSigningPrivateKey,
      })),
    });
    expect(foreignLaunch.status).toBe(401);
    expect(actions).toHaveLength(2);
    const status = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(status.desired.worker).toBeNull();
  });

  it('serves each module of a staged worker release to the platform with its exact length', async () => {
    const manifestKey = `users/${env.ACCOUNT_ID}/releases/route-release/worker.manifest.json`;
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    await env.DATA.put(workerModuleKey(manifestKey, 'engine.wasm'), wasm);
    const get = (key: string, token = env.PLATFORM_TOKEN) => SELF.fetch(`https://tenant.test/__platform/objects/${key.split('/').map(encodeURIComponent).join('/')}`, { headers: { authorization: `Bearer ${token}` } });
    const module = await get(workerModuleKey(manifestKey, 'engine.wasm'));
    expect(module.status).toBe(200);
    expect(module.headers.get('content-length')).toBe(String(wasm.byteLength));
    expect([...new Uint8Array(await module.arrayBuffer())]).toEqual([...wasm]);
    expect((await get(workerModuleKey(manifestKey, 'missing.wasm'))).status).toBe(404);
    expect((await get(workerModuleKey(manifestKey, 'engine.wasm'), 'not-the-platform')).status).toBe(401);
  });

  it('serves the pinned default frontend without following a moving asset tree or forwarding credentials', async () => {
    const { origin } = await tenant();
    const commit = 'a'.repeat(40);
    const pin = `${commit}:${'b'.repeat(64)}`;
    const runtime = { ...env, DEFAULT_ACCOUNT_RELEASE: pin };
    let available = true;
    network.use(http.get(`${env.PLATFORM_URL}/v1/default-releases/${pin}/frontend/`, ({ request }) => {
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.headers.get('cookie')).toBeNull();
      return available ? new HttpResponse('<main>Pinned default</main>', { headers: { 'content-type': 'text/html', 'x-gitspace-frontend-release': pin } }) : new HttpResponse(null, { status: 503 });
    }));
    const response = await worker.fetch(new Request(`${origin}/`, { headers: { authorization: 'Bearer private-browser-token', cookie: 'private-cookie' } }), runtime);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<main>Pinned default</main>');
    expect(response.headers.get('x-gitspace-frontend-release')).toBe(pin);
    available = false;
    expect((await worker.fetch(new Request(`${origin}/`), runtime)).status).toBe(503);
  });

  it('serves the channel SPA and its assets without leaking the internal asset namespace', async () => {
    const { origin } = await tenant();
    const html = '<!doctype html><link rel="stylesheet" href="/assets/app.css"><main>Account</main>';
    const css = 'main { color: green; }';
    const assets = {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        // Cloudflare's default HTML handling redirects directory index files.
        if (path === '/__account/index.html') return Response.redirect(`${origin}/__account/`, 307);
        if (path === '/__account/') return new Response(request.method === 'HEAD' ? null : html, { headers: { 'content-type': 'text/html' } });
        if (path === '/__account/assets/app.css') return new Response(css, { headers: { 'content-type': 'text/css' } });
        return new Response('<main>Operator SPA fallback</main>', { headers: { 'content-type': 'text/html' } });
      },
    } as Fetcher;
    const runtime = { ...env, ASSETS: assets };
    const root = await worker.fetch(new Request(`${origin}/`), runtime);
    expect(root.status).toBe(200);
    expect(root.headers.get('location')).toBeNull();
    expect(await root.text()).toBe(html);

    const route = await worker.fetch(new Request(`${origin}/projects/project-a/spaces/space-a`), runtime);
    expect(route.status).toBe(200);
    expect(route.headers.get('location')).toBeNull();
    expect(await route.text()).toBe(html);
    const stylesheet = await worker.fetch(new Request(`${origin}/assets/app.css?v=1`), runtime);
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get('content-type')).toBe('text/css');
    expect(await stylesheet.text()).toBe(css);
    expect((await worker.fetch(new Request(`${origin}/assets/missing.js`), runtime)).status).toBe(404);
    const head = await worker.fetch(new Request(`${origin}/`, { method: 'HEAD' }), runtime);
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('text/html');
    expect(await head.text()).toBe('');
  });

  it('resolves account asset redirects internally and rejects namespace escapes and cycles', async () => {
    const { origin } = await tenant();
    const assets = {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        if (path === '/__account/assets/app.css') return Response.redirect(`${origin}/__account/assets/app.min.css`, 307);
        if (path === '/__account/assets/app.min.css') return new Response('main{color:green}', { headers: { 'content-type': 'text/css' } });
        if (path === '/__account/assets/escape.css') return Response.redirect(`${origin}/index.html`, 307);
        return Response.redirect(request.url, 307);
      },
    } as Fetcher;
    const runtime = { ...env, ASSETS: assets };
    const stylesheet = await worker.fetch(new Request(`${origin}/assets/app.css`), runtime);
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get('location')).toBeNull();
    expect(await stylesheet.text()).toBe('main{color:green}');
    const escape = await worker.fetch(new Request(`${origin}/assets/escape.css`), runtime);
    expect(escape.status).toBe(502);
    expect(escape.headers.get('location')).toBeNull();
    const cycle = await worker.fetch(new Request(`${origin}/assets/cycle.css`), runtime);
    expect(cycle.status).toBe(502);
    expect(cycle.headers.get('location')).toBeNull();
  });

  it('uses the channel favicon when absent from a release without replacing a release-owned icon', async () => {
    const { userId, control, origin } = await tenant();
    await control('deploy.stage', stageInput('release-favicon'));
    await control('deploy.launch', { sha: 'release-favicon', targets: ['frontend'] });
    const channelIcon = new Uint8Array([0, 0, 1, 0, 1, 0]);
    const runtime = { ...env, ASSETS: {
      async fetch(request: Request) {
        return new URL(request.url).pathname === '/__account/favicon.ico'
          ? new Response(channelIcon, { headers: { 'content-type': 'image/x-icon' } })
          : new Response('Not found', { status: 404 });
      },
    } as Fetcher };
    const fallback = await worker.fetch(new Request(`${origin}/favicon.ico`), runtime);
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get('content-type')).toBe('image/x-icon');
    expect(new Uint8Array(await fallback.arrayBuffer())).toEqual(channelIcon);

    const releaseIcon = new Uint8Array([0, 0, 1, 0, 2, 0]);
    await env.DATA.put(`users/${userId}/releases/release-favicon/frontend/favicon.ico`, releaseIcon);
    const owned = await worker.fetch(new Request(`${origin}/favicon.ico`), runtime);
    expect(owned.status).toBe(200);
    expect(owned.headers.get('content-type')).toBe('image/x-icon');
    expect(owned.headers.get('x-gitspace-frontend-release')).toBe('release-favicon');
    expect(new Uint8Array(await owned.arrayBuffer())).toEqual(releaseIcon);
  });

  it('serves released frontend only on its owning account hostname', async () => {
    const { userId, control, origin } = await tenant();
    const channelHtml = '<!doctype html><title>channel</title>';
    const runtime = { ...env, ASSETS: {
      async fetch(request: Request) {
        return new URL(request.url).pathname === '/__account/'
          ? new Response(channelHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } })
          : new Response('Not found', { status: 404 });
      },
    } as Fetcher };
    const fetchFrontend = (url: string) => worker.fetch(new Request(url), runtime);
    const prefix = `users/${userId}/releases/fe333/frontend/`;
    const index = new TextEncoder().encode('<!doctype html><title>release</title>');
    const asset = new TextEncoder().encode('console.log("release")');
    await env.DATA.put(`${prefix}index.html`, index, { customMetadata: { sha256: HASH } });
    await env.DATA.put(`${prefix}assets/app-1234.js`, asset, { customMetadata: { sha256: HASH } });
    await control('deploy.stage', stageInput('fe333'));
    expect(await (await fetchFrontend(`${origin}/`)).text()).toBe(channelHtml);
    await control('deploy.launch', { sha: 'fe333', targets: ['frontend'] });

    const root = await fetchFrontend(`${origin}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(root.headers.get('x-gitspace-frontend-release')).toBe('fe333');
    expect(await root.text()).toBe('<!doctype html><title>release</title>');

    const script = await fetchFrontend(`${origin}/assets/app-1234.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await script.text()).toBe('console.log("release")');

    const appRoute = await fetchFrontend(`${origin}/projects/project-a/spaces/space-a`);
    expect(appRoute.status).toBe(200);
    expect(await appRoute.text()).toBe('<!doctype html><title>release</title>');
    expect((await fetchFrontend(`${origin}/assets/missing.js`)).status).toBe(404);
    expect((await fetchFrontend(`${origin}/health`)).status).toBe(200);
    expect((await fetchFrontend(`${origin}/v1/control`)).status).toBe(404);
    for (const host of ['https://gitspace.sh', 'https://api.gitspace.sh', 'https://foreign.gitspace.sh']) {
      const response = await fetchFrontend(`${host}/`);
      expect(response.headers.get('x-gitspace-frontend-release')).toBeNull();
      expect(await response.text()).not.toContain('<title>release</title>');
    }
    expect(await (await fetchFrontend(`${origin}/`)).text()).toBe('<!doctype html><title>release</title>');
    await control('deploy.stage', stageInput('machine-only'));
    await control('deploy.launch', { sha: 'machine-only', targets: ['machine'] });
    const afterMachineLaunch = await fetchFrontend(`${origin}/`);
    expect(afterMachineLaunch.headers.get('x-gitspace-frontend-release')).toBe('fe333');
    expect(await afterMachineLaunch.text()).toBe('<!doctype html><title>release</title>');

    await revertTenantRelease(env, userId);
    expect(await (await fetchFrontend(`${origin}/`)).text()).toBe(channelHtml);
  });
});
