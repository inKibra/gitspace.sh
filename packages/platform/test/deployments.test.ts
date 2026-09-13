import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { env } from 'cloudflare:workers';
import { createRelayAuthorization } from '@gitspace/protocol/relay';
import type { PlatformDeployResponse, WorkerReleaseMetadata } from '@gitspace/protocol/deployment';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { CHANNEL_BUNDLE_KEY, CHANNEL_METADATA_KEY, migrationDelta, type ScriptUploadMetadata } from '../src/deployer.js';

const { secretKey, publicKey } = ed25519.keygen();
const ADMIN_PUBLIC_KEY = btoa(String.fromCharCode(...publicKey));

interface Upload {
  scriptName: string;
  metadata: ScriptUploadMetadata;
  module: string;
}

/** What the fake Cloudflare API has "deployed": script name → module source; the dispatcher stub serves from it. */
const scripts = new Map<string, string>();
const uploads: Upload[] = [];
const objects = new Map<string, Map<string, string>>();
const allocatedBuckets = new Set<string>();
const probeVersions = new Map<string, string[]>();
// An in-flight dispatch response retains its script version until its body is released.
const activeProbes = new Map<string, { version: string; bodies: number }>();
let rejectNextUpload: string | null = null;
const realFetch = globalThis.fetch;

function bundleSource(version: string): string {
  return `/* version: ${version} */ export default { fetch() { return new Response('ok'); } };`;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

const dispatcherStub: DispatchNamespace = {
  get(name: string) {
    const fetcher = {
      async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path.startsWith('/__platform/objects/')) {
          const token = /^Bearer (.+)$/u.exec(request.headers.get('authorization') ?? '')?.[1];
          if (!token || !await env.DEPLOYMENTS.getByName(name.slice('tenant-'.length)).verifyToken(token)) return new Response('Unauthorized', { status: 401 });
          const value = objects.get(name)?.get(decodeURIComponent(path.slice('/__platform/objects/'.length)));
          return value === undefined ? new Response('Not found', { status: 404 }) : new Response(value);
        }
        const source = scripts.get(name);
        if (source === undefined) throw new Error(`Worker not found: ${name}`);
        const active = activeProbes.get(name) ?? {
          version: probeVersions.get(name)?.shift() ?? /version: (\S+) /u.exec(source)?.[1] ?? 'unknown',
          bodies: 0,
        };
        active.bodies += 1;
        activeProbes.set(name, active);
        const release = () => {
          active.bodies -= 1;
          if (active.bodies === 0) activeProbes.delete(name);
        };
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, version: active.version })));
          },
          pull(controller) {
            release();
            controller.close();
          },
          cancel: release,
        });
        return new Response(body, { headers: { 'content-type': 'application/json', 'x-gitspace-worker-version': active.version } });
      },
    };
    return fetcher as unknown as Fetcher;
  },
} as unknown as DispatchNamespace;

// `wrangler types` freezes vars to their production literals; the test key is a different string.
const testEnv: Env = { ...env, ADMIN_PUBLIC_KEY: ADMIN_PUBLIC_KEY as Env['ADMIN_PUBLIC_KEY'], DISPATCHER: dispatcherStub };

function metadata(migrationTags: string[]): WorkerReleaseMetadata {
  return {
    mainModule: 'worker.mjs',
    compatibilityDate: '2026-08-27',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: [
      { name: 'CREDENTIALS', className: 'CredentialVaultDO' },
      { name: 'USER_STORAGE', className: 'UserStorageDO' },
    ],
    resources: [
      { name: 'OBJECTS', source: 'object-storage' },
      { name: 'ROOT_KEY', source: 'root-public-key' },
      { name: 'TENANT', source: 'tenant-id' },
      { name: 'PROVIDER_TOKEN', source: 'provider-token' },
      { name: 'STATIC_FILES', source: 'public-assets' },
    ],
    migrations: migrationTags.map((tag) => ({ tag, newSqliteClasses: [`Class${tag}`] })),
  };
}

async function adminPost(tenant: string, body?: unknown): Promise<Response> {
  const path = `/__platform/admin/tenants/${tenant}/token`;
  return worker.fetch(new Request(`https://platform.test${path}`, {
    method: 'POST',
    headers: {
      authorization: createRelayAuthorization(secretKey, path),
      ...(body === undefined ? { 'content-length': '0' } : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), testEnv);
}

async function mintToken(tenant: string, appliedMigrationTag?: string | null): Promise<string> {
  const rootHash = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey));
  const bucket = `gsp-relay-u-${Array.from(rootHash.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  allocatedBuckets.add(bucket);
  await env.DEPLOYMENTS.getByName(tenant).configure(ADMIN_PUBLIC_KEY, bucket);
  const response = await adminPost(tenant, appliedMigrationTag === undefined ? undefined : { appliedMigrationTag });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string') throw new Error('token missing');
  return body.token;
}

async function tenantPost(tenant: string, action: 'deploy' | 'revert', token: string, body: unknown): Promise<Response> {
  return worker.fetch(new Request(`https://platform.test/__platform/tenants/${tenant}/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), testEnv);
}

async function accountId(tenant: string): Promise<string> {
  const config = await env.DEPLOYMENTS.getByName(tenant).tenantConfig();
  if (!config) throw new Error('Tenant fixture is not configured');
  const key = Uint8Array.from(atob(config.rootPublicKey), (character) => character.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', key));
  return `u-${Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function stageRelease(tenant: string, sha: string, version = sha): Promise<{ bundleKey: string; bundleHash: string }> {
  const source = bundleSource(version);
  const bundleKey = `users/${await accountId(tenant)}/releases/${sha}/worker.mjs`;
  let staged = objects.get(`tenant-${tenant}`);
  if (!staged) { staged = new Map(); objects.set(`tenant-${tenant}`, staged); }
  staged.set(bundleKey, source);
  return { bundleKey, bundleHash: await sha256(source) };
}

async function deploy(tenant: string, token: string, sha: string, tags: string[], version = sha): Promise<PlatformDeployResponse> {
  const staged = await stageRelease(tenant, sha, version);
  const response = await tenantPost(tenant, 'deploy', token, { sha, ...staged, metadata: metadata(tags) });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('sha' in body) || !('healthy' in body)) throw new Error('malformed deploy response');
  return body as PlatformDeployResponse;
}

beforeEach(() => {
  scripts.clear();
  objects.clear();
  allocatedBuckets.clear();
  uploads.length = 0;
  probeVersions.clear();
  activeProbes.clear();
  rejectNextUpload = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const bucketLookup = /^\/client\/v4\/accounts\/test-account\/r2\/buckets\/([^/]+)$/u.exec(url.pathname);
    if (url.hostname === 'api.cloudflare.com' && bucketLookup && (!init?.method || init.method === 'GET')) return Response.json({ success: allocatedBuckets.has(bucketLookup[1]!) }, { status: allocatedBuckets.has(bucketLookup[1]!) ? 200 : 404 });
    if (url.hostname === 'api.cloudflare.com' && url.pathname === '/client/v4/accounts/test-account/r2/buckets' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { name: string };
      allocatedBuckets.add(body.name);
      return Response.json({ success: true });
    }
    const match = /^\/client\/v4\/accounts\/test-account\/workers\/dispatch\/namespaces\/gitspace-relays-test\/scripts\/([^/]+)$/u.exec(url.pathname);
    if (url.hostname !== 'api.cloudflare.com' || !match) throw new Error(`Unexpected fetch ${url}`);
    expect(init?.method).toBe('PUT');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-api-token');
    if (!(init?.body instanceof FormData)) throw new Error('Upload must be multipart');
    const metadataPart = init.body.get('metadata');
    if (!(metadataPart instanceof File)) throw new Error('metadata part missing');
    const parsed: unknown = JSON.parse(await metadataPart.text());
    if (!parsed || typeof parsed !== 'object' || !('main_module' in parsed) || typeof parsed.main_module !== 'string') throw new Error('main_module missing');
    const modulePart = init.body.get(parsed.main_module);
    if (!(modulePart instanceof File)) throw new Error('module part missing');
    expect(modulePart.type).toBe('application/javascript+module');
    if (rejectNextUpload) {
      const message = rejectNextUpload;
      rejectNextUpload = null;
      return Response.json({ success: false, errors: [{ code: 10021, message }], result: null }, { status: 400 });
    }
    const module = await modulePart.text();
    uploads.push({ scriptName: match[1]!, metadata: parsed as ScriptUploadMetadata, module });
    scripts.set(match[1]!, module);
    return Response.json({ success: true, errors: [], result: { id: match[1] } });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('migrationDelta', () => {
  const migrations = metadata(['v1', 'v2', 'v3']).migrations;

  it('sends every tag on first upload and only the tail afterwards', () => {
    expect(migrationDelta(migrations, null)).toEqual({
      new_tag: 'v3',
      steps: [{ new_sqlite_classes: ['Classv1'] }, { new_sqlite_classes: ['Classv2'] }, { new_sqlite_classes: ['Classv3'] }],
    });
    expect(migrationDelta(migrations, 'v1')).toEqual({ old_tag: 'v1', new_tag: 'v3', steps: [{ new_sqlite_classes: ['Classv2'] }, { new_sqlite_classes: ['Classv3'] }] });
    expect(migrationDelta(migrations, 'v3')).toBeNull();
  });

  it('never replays classes when the applied tag is unknown to the release', () => {
    expect(migrationDelta(migrations, 'v9')).toBeNull();
  });
});

describe('tenant deployment token', () => {
  it('mints once, rejects bad tokens, and rotation invalidates the old token', async () => {
    const unsigned = await worker.fetch(new Request('https://platform.test/__platform/admin/tenants/alpha/token', { method: 'POST' }), testEnv);
    expect(unsigned.status).toBe(401);

    const first = await mintToken('alpha');
    expect(first.startsWith('gsd_')).toBe(true);

    const staged = await stageRelease('alpha', 'a1');
    const request = { sha: 'a1', ...staged, metadata: metadata(['v1']) };
    const forged = await tenantPost('alpha', 'deploy', `${first}x`, request);
    expect(forged.status).toBe(401);
    const missing = await worker.fetch(new Request('https://platform.test/__platform/tenants/alpha/deploy', { method: 'POST', body: '{}' }), testEnv);
    expect(missing.status).toBe(401);

    const second = await mintToken('alpha');
    expect(second).not.toBe(first);
    const stale = await tenantPost('alpha', 'deploy', first, request);
    expect(stale.status).toBe(401);
    const fresh = await tenantPost('alpha', 'deploy', second, request);
    expect(fresh.status).toBe(200);
    expect(uploads).toHaveLength(1);
  });
});

describe('POST /__platform/tenants/:tenant/deploy', () => {
  it('deploys an active tenant despite exhausted and quarantined billing state', async () => {
    const tenant = `billing-${crypto.randomUUID().slice(0, 8)}`;
    const token = await mintToken(tenant);
    const credits = env.CREDITS.getByName(tenant);
    await credits.configure({ balanceMicros: 0, riskReserveMicros: 100 });
    await credits.quarantine('legacy billing hold');
    const result = await deploy(tenant, token, 'billing-independent', ['v1']);
    expect(result).toMatchObject({ sha: 'billing-independent', healthy: true });
    expect((await env.DEPLOYMENTS.getByName(tenant).getState()).active?.sha).toBe('billing-independent');
    expect(await credits.usageSummary()).toEqual({ records: 1, debitedMicros: Number(env.DEPLOY_SETTLEMENT_MICROS) });
  });

  it('uploads the bundle with tenant-scoped bindings and migrations and meters the deploy', async () => {
    await env.CREDITS.getByName('bravo').configure({ balanceMicros: 1_000_000, riskReserveMicros: 0 });
    const token = await mintToken('bravo', 'v8');
    const result = await deploy('bravo', token, 'abc123', ['v7', 'v8', 'v9', 'v10']);
    expect(result).toEqual({ sha: 'abc123', healthy: true, revertedTo: null, appliedMigrationTag: 'v10' });

    expect(uploads).toHaveLength(1);
    const upload = uploads[0]!;
    expect(upload.scriptName).toBe('tenant-bravo');
    expect(upload.module).toBe(bundleSource('abc123'));
    expect(upload.metadata).toEqual({
      main_module: 'worker.mjs',
      compatibility_date: '2026-08-27',
      compatibility_flags: ['nodejs_compat'],
      bindings: expect.arrayContaining([
        { type: 'durable_object_namespace', name: 'CREDENTIALS', class_name: 'CredentialVaultDO' },
        { type: 'durable_object_namespace', name: 'USER_STORAGE', class_name: 'UserStorageDO' },
        { type: 'r2_bucket', name: 'OBJECTS', bucket_name: (await env.DEPLOYMENTS.getByName('bravo').tenantConfig())!.blobBucket },
        { type: 'plain_text', name: 'ROOT_KEY', text: ADMIN_PUBLIC_KEY },
        { type: 'plain_text', name: 'TENANT', text: 'bravo' },
        { type: 'secret_text', name: 'PROVIDER_TOKEN', text: token },
        { type: 'service', name: 'STATIC_FILES', service: 'public-assets-test' },
      ]),
      migrations: { old_tag: 'v8', new_tag: 'v10', steps: [{ new_sqlite_classes: ['Classv9'] }, { new_sqlite_classes: ['Classv10'] }] },
      keep_bindings: [],
      tags: ['bravo', 'abc123'],
    });

    const copy = await env.RELEASES.get('tenants/bravo/abc123/worker.mjs');
    expect(await copy?.text()).toBe(bundleSource('abc123'));

    const ledger = await env.CREDITS.getByName('bravo').listLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ resource: 'worker-deploy', quantity: '1', debitMicros: 1000 });

    const state = await env.DEPLOYMENTS.getByName('bravo').getState();
    expect(state.appliedMigrationTag).toBe('v10');
    expect(state.active?.sha).toBe('abc123');
  });

  it('sends every migration without old_tag on a tenant that was never migrated', async () => {
    const token = await mintToken('charlie');
    await deploy('charlie', token, 'first', ['v1', 'v2']);
    expect(uploads[0]!.metadata.migrations).toEqual({ new_tag: 'v2', steps: [{ new_sqlite_classes: ['Classv1'] }, { new_sqlite_classes: ['Classv2'] }] });
  });

  it('rejects a bundle whose bytes do not match the declared hash', async () => {
    const token = await mintToken('delta');
    const staged = await stageRelease('delta', 'd1');
    const response = await tenantPost('delta', 'deploy', token, { sha: 'd1', bundleKey: staged.bundleKey, bundleHash: `sha256:${'0'.repeat(64)}`, metadata: metadata(['v1']) });
    expect(response.status).toBe(409);
    expect(uploads).toHaveLength(0);
  });

  it('surfaces Cloudflare rejections without recording a deploy', async () => {
    const token = await mintToken('echo');
    rejectNextUpload = 'old_tag mismatch';
    const staged = await stageRelease('echo', 'e1');
    const response = await tenantPost('echo', 'deploy', token, { sha: 'e1', ...staged, metadata: metadata(['v1']) });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'UPLOAD_REJECTED', message: expect.stringContaining('10021: old_tag mismatch') } });
    const state = await env.DEPLOYMENTS.getByName('echo').getState();
    expect(state.deploys).toHaveLength(0);
    expect(state.appliedMigrationTag).toBeNull();
    expect((await env.DEPLOYMENTS.getByName('echo').acquireLease()).status).toBe('ok');
  });

  it('keeps a healthy candidate when the dispatcher still serves its predecessor during propagation', async () => {
    const token = await mintToken('propagation');
    await deploy('propagation', token, 'old', ['v1']);
    probeVersions.set('tenant-propagation', Array(5).fill('old'));

    const result = await deploy('propagation', token, 'next', ['v1']);

    expect(result).toMatchObject({ healthy: true, revertedTo: null });
    expect((await env.DEPLOYMENTS.getByName('propagation').getState()).active?.sha).toBe('next');
  });

  it('restores the previous bundle when the new script fails its health probe', async () => {
    const token = await mintToken('foxtrot');
    const good = await deploy('foxtrot', token, 'good', ['v1']);
    expect(good.healthy).toBe(true);

    // The staged bundle stamps itself as "stale", so the probe never sees `bad`.
    const bad = await deploy('foxtrot', token, 'bad', ['v1', 'v2'], 'stale');
    expect(bad).toEqual({ sha: 'bad', healthy: false, revertedTo: 'good', appliedMigrationTag: 'v2' });

    expect(uploads.map((upload) => upload.metadata.tags)).toEqual([['foxtrot', 'good'], ['foxtrot', 'bad'], ['foxtrot', 'good']]);
    const restore = uploads[2]!;
    expect(restore.module).toBe(bundleSource('good'));
    expect(restore.metadata.migrations).toBeUndefined();
    expect(scripts.get('tenant-foxtrot')).toBe(bundleSource('good'));

    const state = await env.DEPLOYMENTS.getByName('foxtrot').getState();
    expect(state.active?.sha).toBe('good');
    expect(state.appliedMigrationTag).toBe('v2');
    expect(state.deploys.map((deploy) => [deploy.sha, deploy.healthy, deploy.revertedTo])).toEqual([
      ['bad', false, 'good'],
      ['good', true, null],
      ['good', true, null],
    ]);
  });

  it('falls back to the channel bundle when a first deploy is unhealthy', async () => {
    await env.RELEASES.put(CHANNEL_BUNDLE_KEY, bundleSource('channel:9.9.9'));
    await env.RELEASES.put(CHANNEL_METADATA_KEY, JSON.stringify(metadata(['v1'])));
    const token = await mintToken('golf');
    const result = await deploy('golf', token, 'unhealthy', ['v1'], 'nope');
    expect(result).toEqual({ sha: 'unhealthy', healthy: false, revertedTo: 'channel:9.9.9', appliedMigrationTag: 'v1' });
    expect(uploads[1]!.module).toBe(bundleSource('channel:9.9.9'));
    expect(uploads[1]!.metadata.tags).toEqual(['golf', 'channel']);
  });
});

describe('POST /__platform/tenants/:tenant/revert', () => {
  it('reverts to channel using channel/worker.mjs and its metadata', async () => {
    await env.RELEASES.put(CHANNEL_BUNDLE_KEY, bundleSource('channel:1.2.3'));
    await env.RELEASES.put(CHANNEL_METADATA_KEY, JSON.stringify(metadata(['v1', 'v2'])));
    const token = await mintToken('hotel', 'v2');
    await deploy('hotel', token, 'h1', ['v1', 'v2']);
    probeVersions.set('tenant-hotel', ['h1']);

    const response = await tenantPost('hotel', 'revert', token, { to: 'channel' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sha: 'channel:1.2.3', healthy: true, revertedTo: null, appliedMigrationTag: 'v2' });

    const upload = uploads[1]!;
    expect(upload.module).toBe(bundleSource('channel:1.2.3'));
    expect(upload.metadata.tags).toEqual(['hotel', 'channel']);
    expect(upload.metadata.migrations).toBeUndefined();
    expect(scripts.get('tenant-hotel')).toBe(bundleSource('channel:1.2.3'));
    const state = await env.DEPLOYMENTS.getByName('hotel').getState();
    expect(state.active?.sha).toBe('channel:1.2.3');
  });

  it('refuses a channel revert when the channel bundle is not published', async () => {
    await env.RELEASES.delete([CHANNEL_BUNDLE_KEY, CHANNEL_METADATA_KEY]);
    const token = await mintToken('india');
    const response = await tenantPost('india', 'revert', token, { to: 'channel' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'CHANNEL_UNAVAILABLE' } });
  });

  it('reverts to the previous healthy release from RELEASES', async () => {
    const token = await mintToken('juliet');
    await deploy('juliet', token, 'one', ['v1']);
    await deploy('juliet', token, 'two', ['v1']);
    objects.delete('tenant-juliet');

    const response = await tenantPost('juliet', 'revert', token, { to: 'previous' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sha: 'one', healthy: true, revertedTo: null, appliedMigrationTag: 'v1' });
    expect(uploads[2]!.module).toBe(bundleSource('one'));
    expect(uploads[2]!.metadata.tags).toEqual(['juliet', 'one']);
  });
});

describe('operator account-bound deployment', () => {
  it('lets B launch and revert only B while A remains unchanged and blocked A cannot deploy', async () => {
    const a = `isolation-a-${crypto.randomUUID().slice(0, 8)}`;
    const b = `isolation-b-${crypto.randomUUID().slice(0, 8)}`;
    for (const tenant of [a, b]) {
      const root = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
      await env.DEPLOYMENTS.getByName(tenant).configure(btoa(String.fromCharCode(...root)), `gsp-relay-${tenant}`);
    }
    const [aId, bId] = await Promise.all([accountId(a), accountId(b)]);
    const aBundle = await stageRelease(a, 'account-a');
    const bBundle = await stageRelease(b, 'account-b');
    const post = (tenant: string, action: 'deploy' | 'revert', body: Record<string, unknown>, token = 'test-bootstrap-token') => worker.fetch(new Request(`https://platform.test/__platform/operator/tenants/${tenant}/${action}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), testEnv);
    const aRequest = { accountId: aId, sha: 'account-a', ...aBundle, metadata: metadata(['v1']) };
    const bRequest = { accountId: bId, sha: 'account-b', ...bBundle, metadata: metadata(['v1']) };
    expect((await post(a, 'deploy', aRequest)).status).toBe(200);
    const aState = await env.DEPLOYMENTS.getByName(a).getState();
    expect((await post(a, 'deploy', bRequest)).status).toBe(403);
    expect((await post(a, 'revert', { accountId: bId, to: 'channel' })).status).toBe(403);
    expect((await post(b, 'deploy', { ...bRequest, ...aBundle })).status).toBe(403);
    expect((await post(b, 'deploy', bRequest, 'not-operator')).status).toBe(401);
    expect((await post(b, 'revert', { accountId: aId, to: 'channel' })).status).toBe(403);

    await env.TENANT_CONTROL.getByName(a).set({ status: 'suspended', reason: 'operator hold' });
    expect((await post(a, 'deploy', aRequest)).status).toBe(423);
    expect((await post(a, 'revert', { accountId: aId, to: 'channel' })).status).toBe(423);
    expect((await post(b, 'deploy', bRequest)).status).toBe(200);
    expect(scripts.get(`tenant-${a}`)).toBe(bundleSource('account-a'));
    expect(scripts.get(`tenant-${b}`)).toBe(bundleSource('account-b'));

    await env.RELEASES.put(CHANNEL_BUNDLE_KEY, bundleSource('channel:isolated'));
    await env.RELEASES.put(CHANNEL_METADATA_KEY, JSON.stringify(metadata(['v1'])));
    expect((await post(b, 'revert', { accountId: bId, to: 'channel' })).status).toBe(200);
    expect(scripts.get(`tenant-${b}`)).toBe(bundleSource('channel:isolated'));
    expect(scripts.get(`tenant-${a}`)).toBe(bundleSource('account-a'));
    expect(await env.DEPLOYMENTS.getByName(a).getState()).toEqual(aState);
    expect((await env.DEPLOYMENTS.getByName(b).getState()).active?.sha).toBe('channel:isolated');
  });

  it('preserves the account-owned release on bootstrap retry and never reopens a quarantined tenant', async () => {
    const tenant = `retry-${crypto.randomUUID().slice(0, 8)}`;
    const token = await mintToken(tenant);
    await deploy(tenant, token, 'owned-release', ['v1']);
    const config = await env.DEPLOYMENTS.getByName(tenant).tenantConfig();
    const bootstrap = (bindings = testEnv) => worker.fetch(new Request(`https://platform.test/__platform/bootstrap/${tenant}`, {
      method: 'POST', headers: { authorization: 'Bearer test-bootstrap-token', 'content-type': 'application/json' },
      body: JSON.stringify(config),
    }), bindings, createExecutionContext());
    const recovered = await bootstrap({
      ...testEnv,
      get CREDITS(): Env['CREDITS'] { throw new Error('Credit authority unavailable'); },
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ deployment: { sha: 'owned-release', healthy: true } });
    expect(scripts.get(`tenant-${tenant}`)).toBe(bundleSource('owned-release'));
    await env.TENANT_CONTROL.getByName(tenant).set({ status: 'quarantined', reason: 'hold' });
    expect((await bootstrap()).status).toBe(423);
    expect((await env.TENANT_CONTROL.getByName(tenant).get()).status).toBe('quarantined');
    expect((await env.DEPLOYMENTS.getByName(tenant).getState()).active?.sha).toBe('owned-release');
    const unavailable = await bootstrap({
      ...testEnv,
      TENANT_CONTROL: {
        getByName() { return { async get() { throw new Error('Tenant control unavailable'); } }; },
      } as unknown as Env['TENANT_CONTROL'],
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: { code: 'TENANT_AUTHORITY_UNAVAILABLE' } });
  });
});
