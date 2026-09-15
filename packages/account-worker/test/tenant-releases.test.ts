import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { HttpResponse, http } from 'msw';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  createSignedControlRequest,
  credentialProtocolBase64,
  signCredentialAuthorityGrant,
  type ControlOperation,
} from '@gitspace/protocol';
import {
  deploymentStatusSchema,
  releaseRecordSchema,
  type PlatformDeployRequest,
  type ReleaseRecord,
  type StageReleaseInput,
  type TenantDesired,
} from '@gitspace/protocol/deployment';
import worker from '../src/index.js';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';

const machineSigningPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const machineExchangePrivateKey = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
const HASH = `sha256:${'ab'.repeat(32)}`;

function stageInput(sha: string): StageReleaseInput {
  return {
    sha,
    label: `workspace build ${sha}`,
    workspaceId: 'workspace-a',
    artifacts: {
      worker: { key: `releases/${sha}/worker.mjs`, hash: HASH, size: 1024 },
      machine: { key: `releases/${sha}/machine.js`, hash: HASH, size: 2048 },
      omp: { key: `releases/${sha}/omp.js`, hash: HASH, size: 8192 },
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
        { name: 'AUTH_MAX_SKEW_MS', source: 'literal', value: '60000' },
        { name: 'TUNNEL_HEADER_TIMEOUT_MS', source: 'literal', value: '300000' },
        { name: 'TUNNEL_IDLE_TIMEOUT_MS', source: 'literal', value: '300000' },
        { name: 'STORAGE_BUCKET', source: 'object-storage-name' },
      ],
      migrations: [{ tag: 'v1', newSqliteClasses: ['CredentialVaultDO'] }],
    },
    omp: { upstreamVersion: '18.1.10', bunVersion: '1.4.0', packages: { '@oh-my-pi/pi-coding-agent': '18.1.10' }, patches: [] },
  };
}

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

describe('tenant releases', () => {
  it('recovers a pending Worker acknowledgement from the active generation without clearing machine failures', async () => {
    const { userId, control } = await tenant();
    const releases = env.TENANT_RELEASES.getByName(userId);
    await control('deploy.stage', stageInput('worker-reset'));
    await releases.launch({ sha: 'worker-reset', targets: ['worker', 'machine'] });
    await control('deploy.machineApplied', { sha: 'worker-reset', target: 'machine', generation: 'replacement', status: 'failed', error: 'Machine health check failed' });
    const before = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(before.releases[0]!.status.worker).toBe('pending');
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: 'worker-reset' } })));
    const recovered = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(recovered.releases[0]).toMatchObject({
      status: { worker: 'applied', machines: { 'machine-a': 'failed' } },
      error: 'Machine health check failed',
    });
    const persisted = await releases.status(userId, { sha: null, version: null });
    expect(persisted.releases[0]!.status.worker).toBe('applied');
  });

  it('keeps the deployed frontend and Worker launchable when machine recovery stages the same revision', async () => {
    const { userId, control, origin } = await tenant();
    const releases = env.TENANT_RELEASES.getByName(userId);
    const input = stageInput('split-targets');
    const html = '<!doctype html><title>retained frontend</title>';
    await env.DATA.put(`users/${userId}/releases/split-targets/frontend/index.html`, html);
    await control('deploy.stage', { ...input, artifacts: { ...input.artifacts, machine: null, omp: null }, omp: null });
    await releases.launch({ sha: input.sha, targets: ['worker', 'frontend'] });
    await releases.setWorkerStatus(input.sha, 'applied', null);
    await control('deploy.stage', {
      ...input, artifacts: { worker: null, machine: input.artifacts.machine, omp: null, frontend: null },
      worker: null, omp: null,
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
    expect(staged).toMatchObject({ sha: 'abc123', builtBy: 'machine-a', status: { worker: 'pending', frontend: 'pending', machines: {}, omps: {} }, error: null });

    const launched = await control('deploy.launch', { sha: 'abc123', targets: ['worker', 'machine', 'omp', 'frontend'] }) as { record: ReleaseRecord; desired: TenantDesired };
    expect(releaseRecordSchema.parse(launched.record).status).toEqual({ worker: 'failed', frontend: 'applied', machines: {}, omps: {} });
    expect(launched.desired).toMatchObject({ worker: 'abc123', machine: 'abc123', omp: 'abc123', frontend: 'abc123' });

    const status = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(status.desired).toMatchObject({ worker: 'abc123', machine: 'abc123', omp: 'abc123', frontend: 'abc123' });
    expect(status.current).toEqual({ worker: { sha: null, version: null }, machines: {} });
    expect(status.releases.map((release) => release.sha)).toEqual(['abc123']);
    expect(status.releases[0]!.status.worker).toBe('failed');
    expect(status.releases[0]!.error).toContain('HTTP 503');
  });

  it('records machine convergence and reverts to the channel build', async () => {
    const { userId, control } = await tenant();
    await control('deploy.stage', stageInput('def456'));
    await control('deploy.launch', { sha: 'def456', targets: ['machine', 'omp'] });

    const applied = releaseRecordSchema.parse(await control('deploy.machineApplied', { sha: 'def456', target: 'machine', generation: 'gen-7', status: 'applied' }));
    expect(applied.status).toEqual({ worker: 'skipped', frontend: 'skipped', machines: { 'machine-a': 'applied' }, omps: {} });
    const ompApplied = releaseRecordSchema.parse(await control('deploy.machineApplied', { sha: 'def456', target: 'omp', generation: 'gen-8', status: 'applied' }));
    expect(ompApplied.status.omps).toEqual({ 'machine-a': 'applied' });
    const machineOnly = await control('deploy.launch', { sha: 'def456', targets: ['machine'] }) as { record: ReleaseRecord; desired: TenantDesired };
    expect(machineOnly.desired.omp).toBe('def456');
    expect(machineOnly.record.status.omps).toEqual({ 'machine-a': 'applied' });
    let status = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(status.current.machines).toEqual({ 'machine-a': { sha: 'def456', ompSha: 'def456', generation: 'gen-8' } });

    const failed = releaseRecordSchema.parse(await control('deploy.machineApplied', { sha: 'def456', target: 'machine', generation: 'gen-9', status: 'failed', error: 'health probe timed out' }));
    expect(failed.status.machines).toEqual({ 'machine-a': 'failed' });
    expect(failed.error).toBe('health probe timed out');
    status = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(status.current.machines).toEqual({ 'machine-a': { sha: 'def456', ompSha: 'def456', generation: 'gen-8' } });

    const reverted = deploymentStatusSchema.parse(await control('deploy.revert', {}));
    expect(reverted.desired).toMatchObject({ worker: null, machine: null, omp: null, frontend: null });
    expect(reverted.releases).toHaveLength(1);
    expect(reverted.current.machines).toEqual({ 'machine-a': { sha: 'def456', ompSha: 'def456', generation: 'gen-8' } });
    await env.FLEET_CATALOG.getByName(userId).putMachine({
      id: 'machine-b', label: 'Machine B', state: 'online', rpcEndpoint: 'https://machine-b.test/rpc',
      kind: 'physical', provider: 'physical', notes: '', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null,
    });
    await env.TENANT_RELEASES.getByName(userId).machineApplied('machine-b', { sha: 'def456', target: 'machine', generation: 'gen-b', status: 'applied' });
    await control('deploy.machineChannelApplied', { machineId: 'machine-b', target: 'machine', generation: 'channel-machine' });
    status = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(status.current.machines).toEqual({
      'machine-a': { sha: null, ompSha: 'def456', generation: 'channel-machine' },
      'machine-b': { sha: 'def456', ompSha: null, generation: 'gen-b' },
    });
    await control('deploy.machineChannelApplied', { target: 'omp', generation: 'channel-omp' });
    status = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(status.current.machines).toEqual({
      'machine-a': { sha: null, ompSha: null, generation: 'channel-omp' },
      'machine-b': { sha: 'def456', ompSha: null, generation: 'gen-b' },
    });
    await expect(control('deploy.launch', { sha: 'missing', targets: ['machine'] })).rejects.toThrow('RELEASE_NOT_FOUND');
  });

  it('keeps eligible pending machines but excludes removed and destroyed machines without losing release history', async () => {
    const { userId, control } = await tenant();
    const catalog = env.FLEET_CATALOG.getByName(userId);
    const releases = env.TENANT_RELEASES.getByName(userId);
    const pending = await catalog.putMachine({
      id: 'machine-b', label: 'Machine B', state: 'online', rpcEndpoint: 'https://machine-b.test/rpc',
      kind: 'physical', provider: 'physical', notes: '', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null,
    });
    await control('deploy.stage', stageInput('previous'));
    for (const target of ['machine', 'omp'] as const) {
      await releases.machineApplied(pending.id, { sha: 'previous', target, generation: 'gen-b', status: 'applied' });
    }
    await control('deploy.stage', stageInput('desired'));
    await control('deploy.launch', { sha: 'desired', targets: ['machine', 'omp'] });
    for (const target of ['machine', 'omp'] as const) {
      await control('deploy.machineApplied', { sha: 'desired', target, generation: 'gen-a', status: 'applied' });
    }

    const before = deploymentStatusSchema.parse(await control('deploy.status', {}));
    const survivor = { 'machine-a': { sha: 'desired', ompSha: 'desired', generation: 'gen-a' } };
    expect(before.current.machines).toEqual({
      ...survivor,
      'machine-b': { sha: 'previous', ompSha: 'previous', generation: 'gen-b' },
    });
    expect(before.desired).toMatchObject({ machine: 'desired', omp: 'desired' });

    // Being offline is not removal: it retains the existing deferred convergence semantics.
    const offline = await catalog.putMachine({ ...pending, state: 'offline', desiredState: 'offline', lifecycleRevision: 2 });
    const sleeping = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(sleeping.current.machines).toEqual(before.current.machines);
    await catalog.putMachine({ ...offline, state: 'deleting', desiredState: 'removed', lifecycleRevision: 3 });
    const removing = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(removing.current.machines).toEqual(survivor);
    expect(removing.desired).toEqual(before.desired);
    expect(removing.releases).toEqual(before.releases);

    await catalog.removeMachine(pending.id, true);
    // A late acknowledgement cannot resurrect fleet membership from release storage.
    await releases.machineApplied(pending.id, { sha: 'previous', target: 'machine', generation: 'late-gen-b', status: 'applied' });
    const destroyed = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(destroyed.current.machines).toEqual(survivor);
    expect(destroyed.releases).toEqual(before.releases);
    const reverted = deploymentStatusSchema.parse(await control('deploy.revert', {}));
    expect(reverted.current.machines).toEqual(survivor);
    expect(reverted.releases).toEqual(before.releases);
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
    expect(good.record.status).toEqual({ worker: 'applied', frontend: 'skipped', machines: {}, omps: {} });
    expect(good.record.error).toBeNull();
    expect(deploys).toHaveLength(1);
    expect(deploys[0]).toEqual({
      authorization: 'Bearer tenant-token',
      body: { accountId: userId, sha: 'good111', bundleKey: `users/${userId}/releases/good111/worker.mjs`, bundleHash: HASH, metadata: stageInput('good111').worker },
    });

    await control('deploy.stage', stageInput('bad222'));
    const bad = await control('deploy.launch', { sha: 'bad222', targets: ['worker', 'frontend'] }, platform) as { record: ReleaseRecord; desired: TenantDesired };
    expect(bad.record.status).toEqual({ worker: 'failed', frontend: 'applied', machines: {}, omps: {} });
    expect(bad.record.error).toContain('reverted to good111');
    expect(bad.desired.worker).toBe('bad222');
    await control('deploy.stage', stageInput('machine333'));
    await control('deploy.launch', { sha: 'machine333', targets: ['machine'] });
    const status = deploymentStatusSchema.parse(await control('deploy.status', {}, platform));
    expect(status.desired).toMatchObject({ worker: 'bad222', machine: 'machine333', omp: null, frontend: 'bad222' });
    expect(status.current.worker).toEqual({ sha: 'good111', version: 'good111' });

    const reverted = deploymentStatusSchema.parse(await control('deploy.revert', {}, platform));
    expect(reverted.desired).toMatchObject({ worker: null, machine: null, omp: null, frontend: null });
    expect(reverted.current.worker).toEqual({ sha: null, version: 'channel:1' });
    expect(reverts).toEqual([{ accountId: userId, to: 'channel' }]);
    serving = 'channel';
    const unversionedChannel = deploymentStatusSchema.parse(await control('deploy.status', {}, platform));
    expect(unversionedChannel.current.worker).toEqual({ sha: null, version: 'channel' });
  });

  it('deploys and reverts only the bound tenant despite caller-supplied routing', async () => {
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
    await control('deploy.revert', { tenant: 'foreign', accountId: foreignId });
    expect(serving).toBe('channel:1');
    expect(actions).toEqual([
      { tenant: env.TENANT_ID, accountId: userId, action: 'deploy' },
      { tenant: env.TENANT_ID, accountId: userId, action: 'revert' },
    ]);
    for (const operation of ['deploy.launch', 'deploy.revert'] as const) {
      const response = await SELF.fetch('https://tenant.test/v1/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createSignedControlRequest({
          userId: foreignId, machineId: 'machine-a', operation,
          payload: { sha: 'tenant-release', targets: ['worker'] },
          signingPrivateKey: machineSigningPrivateKey,
        })),
      });
      expect(response.status).toBe(401);
    }
    expect(actions).toHaveLength(2);
    const status = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(status.desired.worker).toBeNull();
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

    await control('deploy.revert', {});
    expect(await (await fetchFrontend(`${origin}/`)).text()).toBe(channelHtml);
  });
});
