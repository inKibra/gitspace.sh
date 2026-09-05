import { describe, expect, it } from 'vitest';
import { env, SELF, runInDurableObject } from 'cloudflare:test';
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
  WORKER_VERSION_HEADER,
  type PlatformDeployRequest,
  type ReleaseRecord,
  type StageReleaseInput,
  type TenantDesired,
} from '@gitspace/protocol/deployment';
import worker from '../src/index.js';
import { TenantReleasesDO } from '../src/tenant-releases.js';
import { network } from './network.js';

const rootPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
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
      migrations: [{ tag: 'v1', newSqliteClasses: ['CredentialVaultDO'] }],
    },
    omp: { upstreamVersion: '18.1.10', bunVersion: '1.4.0', packages: { '@oh-my-pi/pi-coding-agent': '18.1.10' }, patches: [] },
  };
}

async function tenant() {
  const userId = `user-release-${crypto.randomUUID()}`;
  const vault = env.CREDENTIALS.getByName(userId);
  const handle = `release-${crypto.randomUUID().slice(0, 8)}`;
  await env.ACCOUNTS.getByName('global').upsertProvisioning({ userId, handle });
  await env.ACCOUNTS.getByName('global').markActive({ userId, release: null });
  await vault.bootstrap({
    userId,
    rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)),
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
  }, rootPrivateKey));
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
  it('keeps other targets launchable but fails the Worker target when no platform exists', async () => {
    const { control } = await tenant();
    const staged = releaseRecordSchema.parse(await control('deploy.stage', stageInput('abc123')));
    expect(staged).toMatchObject({ sha: 'abc123', builtBy: 'machine-a', status: { worker: 'pending', frontend: 'pending', machines: {}, omps: {} }, error: null });

    const launched = await control('deploy.launch', { sha: 'abc123', targets: ['worker', 'machine', 'omp', 'frontend'] }, { PLATFORM_URL: '' }) as { record: ReleaseRecord; desired: TenantDesired };
    expect(releaseRecordSchema.parse(launched.record).status).toEqual({ worker: 'failed', frontend: 'applied', machines: {}, omps: {} });
    expect(launched.desired).toMatchObject({ worker: 'abc123', machine: 'abc123', omp: 'abc123', frontend: 'abc123' });

    const status = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(status.desired).toMatchObject({ worker: 'abc123', machine: 'abc123', omp: 'abc123', frontend: 'abc123' });
    expect(status.current).toEqual({ worker: { sha: null, version: null }, machines: {} });
    expect(status.releases.map((release) => release.sha)).toEqual(['abc123']);
    expect(status.releases[0]!.status.worker).toBe('failed');
    expect(status.releases[0]!.error).toContain('platform is not configured');
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

  it('swaps the worker through the platform and surfaces auto-reverts', async () => {
    const { userId, handle, control } = await tenant();
    const platform: Partial<Env> = { PLATFORM_URL: 'https://platform.test/', PLATFORM_BOOTSTRAP_TOKEN: 'operator-token' };
    const deploys: Array<{ authorization: string | null; body: PlatformDeployRequest }> = [];
    const reverts: unknown[] = [];
    let serving: string | null = null;
    network.use(
      http.get(`https://platform.test/__platform/operator/tenants/${handle}`, () => HttpResponse.json({ control: { status: 'active' }, credits: null, deployment: { active: serving } })),
      http.post(`https://platform.test/__platform/operator/tenants/${handle}/deploy`, async ({ request }) => {
        const body = await request.json() as PlatformDeployRequest;
        deploys.push({ authorization: request.headers.get('authorization'), body });
        if (body.sha === 'good111') serving = body.sha;
        return body.sha === 'good111'
          ? HttpResponse.json({ sha: body.sha, healthy: true, revertedTo: null, appliedMigrationTag: 'v1' })
          : HttpResponse.json({ sha: body.sha, healthy: false, revertedTo: 'good111', appliedMigrationTag: 'v1' });
      }),
      http.post(`https://platform.test/__platform/operator/tenants/${handle}/revert`, async ({ request }) => {
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
      authorization: 'Bearer operator-token',
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

  it('resolves B deploy and revert from authenticated B, never caller-supplied A routing', async () => {
    const [a, b] = await Promise.all([tenant(), tenant()]);
    const platform: Partial<Env> = { PLATFORM_URL: 'https://platform.test', PLATFORM_BOOTSTRAP_TOKEN: 'operator-token' };
    const serving = new Map<string, string>();
    network.use(
      http.get('https://platform.test/__platform/operator/tenants/:handle', ({ params }) => HttpResponse.json({ control: { status: 'active' }, credits: null, deployment: { active: serving.get(String(params.handle)) ?? null } })),
      http.post('https://platform.test/__platform/operator/tenants/:handle/:action', async ({ params, request }) => {
        const body = await request.json() as { accountId: string; sha?: string };
        const owner = params.handle === a.handle ? a : params.handle === b.handle ? b : null;
        if (!owner || body.accountId !== owner.userId) return new HttpResponse(null, { status: 403 });
        const sha = params.action === 'revert' ? 'channel:1' : body.sha!;
        serving.set(owner.handle, sha);
        return HttpResponse.json({ sha, healthy: true, revertedTo: null, appliedMigrationTag: 'v1' });
      }),
    );
    await a.control('deploy.stage', stageInput('a-release'));
    await b.control('deploy.stage', stageInput('b-release'));
    await a.control('deploy.launch', { sha: 'a-release', targets: ['worker'] }, platform);
    await b.control('deploy.launch', { sha: 'b-release', targets: ['worker'], tenant: a.handle, accountId: a.userId }, platform);
    expect(serving.get(a.handle)).toBe('a-release');
    expect(serving.get(b.handle)).toBe('b-release');
    await b.control('deploy.revert', { tenant: a.handle, accountId: a.userId }, platform);
    expect(serving.get(a.handle)).toBe('a-release');
    expect(serving.get(b.handle)).toBe('channel:1');
    const statusA = deploymentStatusSchema.parse(await a.control('deploy.status', {}));
    expect(statusA.desired.worker).toBe('a-release');
  });

  it('migrates the legacy desired selection and keeps it across a different target launch', async () => {
    const releases = env.TENANT_RELEASES.getByName(`legacy-${crypto.randomUUID()}`);
    const migrated = await runInDurableObject(releases, (instance: TenantReleasesDO, state) => {
      instance.stage(stageInput('legacy'), 'builder');
      state.storage.sql.exec('CREATE TABLE desired (id INTEGER PRIMARY KEY, sha TEXT, targets_json TEXT NOT NULL, updated_at TEXT NOT NULL)');
      state.storage.sql.exec('INSERT INTO desired VALUES (1, ?, ?, ?)', 'legacy', JSON.stringify(['omp', 'frontend']), '2026-09-01T00:00:00.000Z');
      const upgraded = new TenantReleasesDO(state, env);
      upgraded.stage(stageInput('new-machine'), 'builder');
      upgraded.launch({ sha: 'new-machine', targets: ['machine'] });
      return { status: upgraded.status({ sha: null, version: 'channel:1' }), frontend: upgraded.frontend() };
    });
    expect(migrated.status.desired).toMatchObject({ worker: null, machine: 'new-machine', omp: 'legacy', frontend: 'legacy' });
    expect(migrated.frontend).toEqual({ sha: 'legacy', keyPrefix: 'releases/legacy/frontend' });
  });

  it('answers healthz with the worker version stamp', async () => {
    const response = await SELF.fetch('https://tenant.test/healthz');
    expect(response.status).toBe(200);
    expect(response.headers.get(WORKER_VERSION_HEADER)).toBe('dev');
    expect(await response.json()).toEqual({ ok: true, version: 'dev' });
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

  it('serves released frontend only on its owning account hostname', async () => {
    const { userId, control, origin } = await tenant();
    const prefix = `users/${userId}/releases/fe333/frontend/`;
    const index = new TextEncoder().encode('<!doctype html><title>release</title>');
    const asset = new TextEncoder().encode('console.log("release")');
    await env.DATA.put(`${prefix}index.html`, index, { customMetadata: { sha256: HASH } });
    await env.DATA.put(`${prefix}assets/app-1234.js`, asset, { customMetadata: { sha256: HASH } });
    await control('deploy.stage', stageInput('fe333'));
    expect((await SELF.fetch(`${origin}/`)).status).toBe(503);
    await control('deploy.launch', { sha: 'fe333', targets: ['frontend'] });

    const root = await SELF.fetch(`${origin}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(root.headers.get('x-gitspace-frontend-release')).toBe('fe333');
    expect(await root.text()).toBe('<!doctype html><title>release</title>');

    const script = await SELF.fetch(`${origin}/assets/app-1234.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await script.text()).toBe('console.log("release")');

    const appRoute = await SELF.fetch(`${origin}/projects/project-a/spaces/space-a`);
    expect(appRoute.status).toBe(200);
    expect(await appRoute.text()).toBe('<!doctype html><title>release</title>');
    expect((await SELF.fetch(`${origin}/assets/missing.js`)).status).toBe(404);
    expect((await SELF.fetch(`${origin}/health`)).status).toBe(200);
    expect((await SELF.fetch(`${origin}/v1/control`)).status).toBe(404);
    const other = await tenant();
    await other.control('deploy.status', {});
    for (const host of ['https://gitspace.sh', 'https://api.gitspace.sh', other.origin]) {
      const response = await SELF.fetch(`${host}/`);
      expect(response.headers.get('x-gitspace-frontend-release')).toBeNull();
      expect(await response.text()).not.toContain('<title>release</title>');
    }
    expect(await (await SELF.fetch(`${origin}/`)).text()).toBe('<!doctype html><title>release</title>');
    await control('deploy.stage', stageInput('machine-only'));
    await control('deploy.launch', { sha: 'machine-only', targets: ['machine'] });
    const afterMachineLaunch = await SELF.fetch(`${origin}/`);
    expect(afterMachineLaunch.headers.get('x-gitspace-frontend-release')).toBe('fe333');
    expect(await afterMachineLaunch.text()).toBe('<!doctype html><title>release</title>');

    await control('deploy.revert', {});
    expect((await SELF.fetch(`${origin}/`)).status).toBe(503);
  });
});
