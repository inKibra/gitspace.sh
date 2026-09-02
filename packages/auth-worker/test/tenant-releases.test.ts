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
  WORKER_VERSION_HEADER,
  type PlatformDeployRequest,
  type ReleaseRecord,
  type StageReleaseInput,
} from '@gitspace/protocol/deployment';
import worker from '../src/index.js';
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
      frontend: { key: `releases/${sha}/frontend`, hash: HASH, size: 4096 },
    },
    worker: {
      mainModule: 'worker.mjs',
      compatibilityDate: '2026-08-27',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: [{ name: 'CREDENTIALS', className: 'CredentialVaultDO' }],
      migrations: [{ tag: 'v1', newSqliteClasses: ['CredentialVaultDO'] }],
    },
  };
}

async function tenant() {
  const userId = `user-release-${crypto.randomUUID()}`;
  const vault = env.CREDENTIALS.getByName(userId);
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
  return { userId, control };
}

describe('tenant releases', () => {
  it('stages, launches without a platform, and reports status', async () => {
    const { control } = await tenant();
    const staged = releaseRecordSchema.parse(await control('deploy.stage', stageInput('abc123')));
    expect(staged).toMatchObject({ sha: 'abc123', builtBy: 'machine-a', status: { worker: 'pending', frontend: 'pending', machines: {} }, error: null });

    const launched = await control('deploy.launch', { sha: 'abc123', targets: ['worker', 'machine', 'frontend'] }) as { record: ReleaseRecord; desired: { sha: string | null; targets: string[] } };
    expect(releaseRecordSchema.parse(launched.record).status).toEqual({ worker: 'skipped', frontend: 'applied', machines: {} });
    expect(launched.desired).toMatchObject({ sha: 'abc123', targets: ['worker', 'machine', 'frontend'] });

    const status = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(status.desired).toMatchObject({ sha: 'abc123', targets: ['worker', 'machine', 'frontend'] });
    expect(status.current).toEqual({ worker: { sha: null, version: 'dev' }, machines: {} });
    expect(status.releases.map((release) => release.sha)).toEqual(['abc123']);
    expect(status.releases[0]!.status.worker).toBe('skipped');
  });

  it('records machine convergence and reverts to the channel build', async () => {
    const { control } = await tenant();
    await control('deploy.stage', stageInput('def456'));
    await control('deploy.launch', { sha: 'def456', targets: ['machine'] });

    const applied = releaseRecordSchema.parse(await control('deploy.machineApplied', { sha: 'def456', generation: 'gen-7', status: 'applied' }));
    expect(applied.status).toEqual({ worker: 'skipped', frontend: 'skipped', machines: { 'machine-a': 'applied' } });
    let status = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(status.current.machines).toEqual({ 'machine-a': { sha: 'def456', generation: 'gen-7' } });

    const failed = releaseRecordSchema.parse(await control('deploy.machineApplied', { sha: 'def456', generation: 'gen-8', status: 'failed', error: 'health probe timed out' }));
    expect(failed.status.machines).toEqual({ 'machine-a': 'failed' });
    expect(failed.error).toBe('health probe timed out');
    status = deploymentStatusSchema.parse(await control('deploy.status', {}));
    expect(status.current.machines).toEqual({ 'machine-a': { sha: 'def456', generation: 'gen-7' } });

    const reverted = deploymentStatusSchema.parse(await control('deploy.revert', {}));
    expect(reverted.desired).toMatchObject({ sha: null, targets: [] });
    expect(reverted.releases).toHaveLength(1);
    await expect(control('deploy.launch', { sha: 'missing', targets: ['machine'] })).rejects.toThrow('RELEASE_NOT_FOUND');
  });

  it('swaps the worker through the platform and surfaces auto-reverts', async () => {
    const { userId, control } = await tenant();
    const platform: Partial<Env> = { PLATFORM_URL: 'https://platform.test/', PLATFORM_TENANT: 'acme', PLATFORM_TENANT_TOKEN: 'tenant-token' };
    const deploys: Array<{ authorization: string | null; body: PlatformDeployRequest }> = [];
    const reverts: unknown[] = [];
    network.use(
      http.post('https://platform.test/__platform/tenants/acme/deploy', async ({ request }) => {
        const body = await request.json() as PlatformDeployRequest;
        deploys.push({ authorization: request.headers.get('authorization'), body });
        return body.sha === 'good111'
          ? HttpResponse.json({ sha: body.sha, healthy: true, revertedTo: null, appliedMigrationTag: 'v1' })
          : HttpResponse.json({ sha: body.sha, healthy: false, revertedTo: 'good111', appliedMigrationTag: 'v1' });
      }),
      http.post('https://platform.test/__platform/tenants/acme/revert', async ({ request }) => {
        reverts.push(await request.json());
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
      body: { sha: 'good111', bundleKey: `users/${userId}/releases/good111/worker.mjs`, bundleHash: HASH, metadata: stageInput('good111').worker },
    });

    await control('deploy.stage', stageInput('bad222'));
    const bad = await control('deploy.launch', { sha: 'bad222', targets: ['worker', 'frontend'] }, platform) as { record: ReleaseRecord; desired: { sha: string | null } };
    expect(bad.record.status).toEqual({ worker: 'failed', frontend: 'applied', machines: {} });
    expect(bad.record.error).toContain('reverted to good111');
    expect(bad.desired.sha).toBe('bad222');

    const reverted = deploymentStatusSchema.parse(await control('deploy.revert', {}, platform));
    expect(reverted.desired.sha).toBeNull();
    expect(reverts).toEqual([{ to: 'channel' }]);
  });

  it('answers healthz with the worker version stamp', async () => {
    const response = await SELF.fetch('https://tenant.test/healthz');
    expect(response.status).toBe(200);
    expect(response.headers.get(WORKER_VERSION_HEADER)).toBe('dev');
    expect(await response.json()).toEqual({ ok: true, version: 'dev' });
  });

  it('serves the launched frontend tree from DATA by hash', async () => {
    const { userId, control } = await tenant();
    const prefix = `users/${userId}/releases/fe333/frontend/`;
    const index = new TextEncoder().encode('<!doctype html><title>release</title>');
    const asset = new TextEncoder().encode('console.log("release")');
    await env.DATA.put(`${prefix}index.html`, index, { customMetadata: { sha256: HASH } });
    await env.DATA.put(`${prefix}assets/app-1234.js`, asset, { customMetadata: { sha256: HASH } });
    await control('deploy.stage', stageInput('fe333'));
    expect((await SELF.fetch('https://tenant.test/')).status).toBe(404);
    await control('deploy.launch', { sha: 'fe333', targets: ['frontend'] });

    const root = await SELF.fetch('https://tenant.test/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(root.headers.get('x-gitspace-frontend-release')).toBe('fe333');
    expect(await root.text()).toBe('<!doctype html><title>release</title>');

    const script = await SELF.fetch('https://tenant.test/assets/app-1234.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await script.text()).toBe('console.log("release")');

    const appRoute = await SELF.fetch('https://tenant.test/projects/project-a/spaces/space-a');
    expect(appRoute.status).toBe(200);
    expect(await appRoute.text()).toBe('<!doctype html><title>release</title>');
    expect((await SELF.fetch('https://tenant.test/assets/missing.js')).status).toBe(404);
    expect((await SELF.fetch('https://tenant.test/health')).status).toBe(200);
    expect((await SELF.fetch('https://tenant.test/v1/control')).status).toBe(404);

    await control('deploy.revert', {});
    expect((await SELF.fetch('https://tenant.test/')).status).toBe(404);
  });
});
