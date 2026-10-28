import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { env } from 'cloudflare:workers';
import { createRelayAuthorization } from '@gitspace/protocol/relay';
import { workerModuleKey, type PlatformDeployResponse, type WorkerReleaseMetadata } from '@gitspace/protocol/deployment';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import worker from '../src/index.js';
import { migrationDelta, type ScriptUploadMetadata } from '../src/deployer.js';
import { createWorkerManifest, type WorkerModule } from '@gitspace/protocol/worker-bundle';
import { DEFAULT_ACCOUNT_POINTER } from '@gitspace/protocol/default-release';

const { secretKey, publicKey } = ed25519.keygen();
const ADMIN_PUBLIC_KEY = btoa(String.fromCharCode(...publicKey));

interface Upload {
  metadata: ScriptUploadMetadata;
  module: string;
  wasm: number[];
  /** Every module part in multipart order, as Cloudflare reads it. */
  parts: Array<{ name: string; type: string }>;
}

/** What the fake Cloudflare API has "deployed": script name → module source; the dispatcher stub serves from it. */
const scripts = new Map<string, string>();
const uploads: Upload[] = [];
const objects = new Map<string, Map<string, string | Uint8Array<ArrayBuffer>>>();
const allocatedBuckets = new Set<string>();
const allocatedNamespaces = new Set<string>();
let rejectNamespaceCreation = false;
const probeVersions = new Map<string, string[]>();
// An in-flight dispatch response retains its script version until its body is released.
const activeProbes = new Map<string, { version: string; bodies: number }>();
let rejectNextUpload: string | null = null;
/** The next script upload waits for `release` after signalling `started`, so a test acts while a swap is in flight. */
let heldUpload: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | null = null;
const realFetch = globalThis.fetch;
const WASM = [0, 97, 115, 109, 1, 0, 0, 0];

function bundleSource(version: string): string {
  return `/* version: ${version} */ export default { fetch() { return new Response('ok'); } };`;
}

function releaseModules(version: string): WorkerModule[] {
  return [
    { name: 'worker.mjs', type: 'esm', content: new TextEncoder().encode(bundleSource(version)) },
    { name: 'engine.wasm', type: 'wasm', content: new Uint8Array(WASM) },
  ];
}

/** A release as builders wrote it before module releases: every module base64-encoded in one JSON document. */
async function legacyBundle(version: string): Promise<string> {
  return JSON.stringify({ version: 1, modules: await Promise.all(releaseModules(version).map(async module => ({
    name: module.name, type: module.type, hash: await sha256(module.content), bytes: module.content.byteLength, base64: btoa(String.fromCharCode(...module.content)),
  }))) });
}

async function sha256(content: string | Uint8Array<ArrayBuffer>): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', typeof content === 'string' ? new TextEncoder().encode(content) : content);
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
          if (!token || !await env.DEPLOYMENTS.getByName(name.slice(`${env.DISPATCH_NAMESPACE}-tenant-`.length)).verifyToken(token)) return new Response('Unauthorized', { status: 401 });
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
// Swaps run in the tenant's deployment object, which reads the bindings of the test worker itself.
Object.assign(env, { DISPATCHER: dispatcherStub });

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
      { name: 'ARTIFACTS', source: 'artifacts' },
      { name: 'ROOT_KEY', source: 'root-public-key' },
      { name: 'TENANT', source: 'tenant-id' },
      { name: 'PROVIDER_TOKEN', source: 'provider-token' },
      { name: 'STATIC_FILES', source: 'public-assets' },
    ],
    migrations: migrationTags.map((tag) => ({ tag, newSqliteClasses: [`Class${tag}`], deletedClasses: [] })),
  };
}

/** Publishes a default release; `legacy` publishes its worker the way defaults were published before module releases. */
async function publishDefault(commit: string, tags: string[], { legacy = false, inferenceVersion }: { legacy?: boolean; inferenceVersion?: 1 } = {}) {
  const prefix = `defaults/releases/${commit}/`;
  async function object(name: string, content: string | Uint8Array<ArrayBuffer>) {
    const key = prefix + name;
    await env.RELEASES.put(key, content);
    return { key, size: typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength, sha256: (await sha256(content)).slice(7) };
  }
  for (const module of releaseModules(commit)) await object(`worker/${module.name}`, module.content);
  const worker = legacy
    ? { bundle: await object('worker.bundle.json', await legacyBundle(commit)) }
    : { manifest: await object('worker.manifest.json', JSON.stringify(createWorkerManifest('worker.mjs', releaseModules(commit)))) };
  const frontend = await object('frontend/index.html', `<html>${commit}</html>`);
  const provenance = await object('image-provenance.json', JSON.stringify({ commit, image: `registry.example.com/gitspace@sha256:${'c'.repeat(64)}` }));
  const manifest = await object('manifest.json', JSON.stringify({
    schemaVersion: 1, commit, ...(inferenceVersion ? { inferenceVersion } : {}),
    worker: { commit, version: commit, ...worker, metadata: metadata(tags) },
    frontend: { commit, files: [{ ...frontend, path: 'index.html', contentType: 'text/html' }] },
    image: { commit, image: `registry.example.com/gitspace@sha256:${'c'.repeat(64)}`, provenance },
  }));
  await env.RELEASES.put(DEFAULT_ACCOUNT_POINTER, JSON.stringify({ schemaVersion: 1, current: manifest, previous: null }));
  return `${commit}:${manifest.sha256}`;
}

it('serves immutable default UI by explicit hash-anchored pin and rejects missing or corrupt assets', async () => {
  const commit = 'f'.repeat(40);
  const pin = await publishDefault(commit, ['v1']);
  await publishDefault('e'.repeat(40), ['v1']);
  async function get(path: string, method = 'GET') {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`https://platform.test/v1/default-releases/${pin}/frontend/${path}`, { method }), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }
  expect(await (await get('')).text()).toBe(`<html>${commit}</html>`);
  expect((await get('', 'HEAD')).status).toBe(200);
  expect(await (await get('', 'HEAD')).text()).toBe('');
  expect((await get('missing.js')).status).toBe(404);
  await env.RELEASES.put(`defaults/releases/${commit}/frontend/index.html`, 'corrupt');
  expect((await get('')).status).toBe(503);
});

async function adminPost(tenant: string, body?: unknown): Promise<Response> {
  const path = `/__platform/admin/tenants/${tenant}/token`;
  return worker.fetch(new Request(`https://platform.test${path}`, {
    method: 'POST',
    headers: {
      authorization: createRelayAuthorization(secretKey, path),
      ...(body === undefined ? { 'content-length': '0' } : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), testEnv, createExecutionContext());
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
  }), testEnv, createExecutionContext());
}

function holdNextUpload(): { started: Promise<void>; release(): void } {
  const hold = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  heldUpload = hold;
  // A test that fails while the upload is held must not leave its swap waiting.
  onTestFinished(() => hold.release.resolve());
  return { started: hold.started.promise, release: () => hold.release.resolve() };
}

async function operationGet(tenant: string, token: string, operationId: string): Promise<Response> {
  return worker.fetch(new Request(`https://platform.test/__platform/tenants/${tenant}/operations/${operationId}`, {
    headers: { authorization: `Bearer ${token}` },
  }), testEnv, createExecutionContext());
}

async function accountId(tenant: string): Promise<string> {
  const config = await env.DEPLOYMENTS.getByName(tenant).tenantConfig();
  if (!config) throw new Error('Tenant fixture is not configured');
  const key = Uint8Array.from(atob(config.rootPublicKey), (character) => character.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', key));
  return `u-${Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function tenantObjects(tenant: string): Map<string, string | Uint8Array<ArrayBuffer>> {
  let staged = objects.get(`${env.DISPATCH_NAMESPACE}-tenant-${tenant}`);
  if (!staged) { staged = new Map(); objects.set(`${env.DISPATCH_NAMESPACE}-tenant-${tenant}`, staged); }
  return staged;
}

/** Puts a module release into the tenant's data bucket the way the machine uploads it: modules, then the manifest. */
async function stageRelease(tenant: string, sha: string, version = sha): Promise<{ manifestKey: string; manifestHash: string }> {
  const manifestKey = `users/${await accountId(tenant)}/releases/${sha}/worker.manifest.json`;
  const modules = releaseModules(version);
  for (const module of modules) tenantObjects(tenant).set(workerModuleKey(manifestKey, module.name), module.content);
  const manifest = JSON.stringify(createWorkerManifest('worker.mjs', modules));
  tenantObjects(tenant).set(manifestKey, manifest);
  return { manifestKey, manifestHash: await sha256(manifest) };
}

async function stageLegacyRelease(tenant: string, sha: string, version = sha): Promise<{ bundleKey: string; bundleHash: string }> {
  const source = await legacyBundle(version);
  const bundleKey = `users/${await accountId(tenant)}/releases/${sha}/worker.bundle.json`;
  tenantObjects(tenant).set(bundleKey, source);
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
  allocatedNamespaces.clear();
  rejectNamespaceCreation = false;
  uploads.length = 0;
  probeVersions.clear();
  activeProbes.clear();
  rejectNextUpload = null;
  heldUpload = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const bucketLookup = /^\/client\/v4\/accounts\/test-account\/r2\/buckets\/([^/]+)$/u.exec(url.pathname);
    const namespaceLookup = /^\/client\/v4\/accounts\/test-account\/artifacts\/namespaces\/([^/]+)$/u.exec(url.pathname);
    if (url.hostname === 'api.cloudflare.com' && namespaceLookup && (!init?.method || init.method === 'GET')) {
      return Response.json({ success: allocatedNamespaces.has(namespaceLookup[1]!) }, { status: allocatedNamespaces.has(namespaceLookup[1]!) ? 200 : 404 });
    }
    if (url.hostname === 'api.cloudflare.com' && url.pathname === '/client/v4/accounts/test-account/artifacts/namespaces' && init?.method === 'POST') {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-api-token');
      if (rejectNamespaceCreation) return Response.json({ success: false, errors: [{ code: 10000, message: 'Artifacts access denied' }] });
      const body = JSON.parse(String(init.body)) as { namespace: string };
      allocatedNamespaces.add(body.namespace);
      return Response.json({ success: true });
    }
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
    const contentType = new Headers(init?.headers).get('content-type');
    if (!contentType?.startsWith('multipart/form-data; boundary=')) throw new Error('Upload must be multipart');
    // Parse the body the way Cloudflare does; the platform streams it rather than sending a FormData object.
    const form = await new Response(init?.body, { headers: { 'content-type': contentType } }).formData();
    const metadataPart = form.get('metadata');
    if (!(metadataPart instanceof File)) throw new Error('metadata part missing');
    const parsed: unknown = JSON.parse(await metadataPart.text());
    if (!parsed || typeof parsed !== 'object' || !('main_module' in parsed) || typeof parsed.main_module !== 'string') throw new Error('main_module missing');
    const modulePart = form.get(parsed.main_module);
    if (!(modulePart instanceof File)) throw new Error('module part missing');
    expect(modulePart.type).toBe('application/javascript+module');
    const hold = heldUpload;
    if (hold) {
      heldUpload = null;
      hold.started.resolve();
      await hold.release.promise;
    }
    if (rejectNextUpload) {
      const message = rejectNextUpload;
      rejectNextUpload = null;
      return Response.json({ success: false, errors: [{ code: 10021, message }], result: null }, { status: 400 });
    }
    const module = await modulePart.text();
    const wasm = form.get('engine.wasm');
    if (!(wasm instanceof File) || wasm.type !== 'application/wasm') throw new Error('Static WASM upload missing');
    const parts = [...form.entries()].flatMap(([name, value]) => name !== 'metadata' && value instanceof File ? [{ name, type: value.type }] : []);
    uploads.push({ metadata: parsed as ScriptUploadMetadata, module, wasm: [...new Uint8Array(await wasm.arrayBuffer())], parts });
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
    const unsigned = await worker.fetch(new Request('https://platform.test/__platform/admin/tenants/alpha/token', { method: 'POST' }), testEnv, createExecutionContext());
    expect(unsigned.status).toBe(401);

    const first = await mintToken('alpha');
    expect(first.startsWith('gsd_')).toBe(true);

    const staged = await stageRelease('alpha', 'a1');
    const request = { sha: 'a1', ...staged, metadata: metadata(['v1']) };
    const forged = await tenantPost('alpha', 'deploy', `${first}x`, request);
    expect(forged.status).toBe(401);
    const missing = await worker.fetch(new Request('https://platform.test/__platform/tenants/alpha/deploy', { method: 'POST', body: '{}' }), testEnv, createExecutionContext());
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
  it('next deploy records a hash-anchored default pin for a pre-pin tenant', async () => {
    const token = await mintToken('pre-pin-deploy');
    await env.RELEASES.delete(DEFAULT_ACCOUNT_POINTER);
    await deploy('pre-pin-deploy', token, 'old', ['v1']);
    const commit = 'd'.repeat(40);
    await publishDefault(commit, ['v1']);
    const manifest = await env.RELEASES.get(`defaults/releases/${commit}/manifest.json`);
    if (!manifest) throw new Error('Fixture manifest missing');
    const digest = (await sha256(await manifest.text())).slice(7);
    await deploy('pre-pin-deploy', token, 'next', ['v1']);
    const active = (await env.DEPLOYMENTS.getByName('pre-pin-deploy').getState()).active;
    expect(active?.metadata.resources.find(resource => resource.name === 'DEFAULT_ACCOUNT_RELEASE')).toEqual({
      name: 'DEFAULT_ACCOUNT_RELEASE', source: 'literal', value: `${commit}:${digest}`,
    });
  });
  it('binds distinct account roots to isolated namespaces across releases', async () => {
    const first = await mintToken('artifacts-first');
    const otherRoot = ed25519.keygen().publicKey;
    await env.DEPLOYMENTS.getByName('artifacts-second').configure(btoa(String.fromCharCode(...otherRoot)), 'gsp-relay-artifacts-second');
    const tokenResponse = await adminPost('artifacts-second');
    expect(tokenResponse.status).toBe(200);
    const second = (await tokenResponse.json() as { token: string }).token;
    await deploy('artifacts-first', first, 'first-release', ['v1']);
    await deploy('artifacts-second', second, 'second-release', ['v1']);
    await deploy('artifacts-first', first, 'first-successor', ['v1']);
    const namespaces = uploads.map(upload => upload.metadata.bindings.find(binding => binding.type === 'artifacts'));
    expect(namespaces[0]).toEqual({ type: 'artifacts', name: 'ARTIFACTS', namespace: `gsp-${await accountId('artifacts-first')}` });
    expect(namespaces[1]).toEqual({ type: 'artifacts', name: 'ARTIFACTS', namespace: `gsp-${await accountId('artifacts-second')}` });
    expect(namespaces[1]).not.toEqual(namespaces[0]);
    expect(namespaces[2]).toEqual(namespaces[0]);
  });

  it('does not upload or change the selected worker when namespace provisioning fails', async () => {
    const token = await mintToken('artifacts-denied');
    const staged = await stageRelease('artifacts-denied', 'candidate');
    rejectNamespaceCreation = true;
    const response = await tenantPost('artifacts-denied', 'deploy', token, { sha: 'candidate', ...staged, metadata: metadata(['v1']) });
    expect(response.status).toBe(502);
    expect(uploads).toHaveLength(0);
    expect((await env.DEPLOYMENTS.getByName('artifacts-denied').getState()).active).toBeNull();
    rejectNamespaceCreation = false;
    expect((await deploy('artifacts-denied', token, 'candidate', ['v1'])).healthy).toBe(true);
  });

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

  it('uploads every manifest module with tenant-scoped bindings and migrations and meters the deploy', async () => {
    await env.CREDITS.getByName('bravo').configure({ balanceMicros: 1_000_000, riskReserveMicros: 0 });
    const token = await mintToken('bravo', 'v8');
    const result = await deploy('bravo', token, 'abc123', ['v7', 'v8', 'v9', 'v10']);
    expect(result).toEqual({ sha: 'abc123', healthy: true, revertedTo: null, appliedMigrationTag: 'v10' });

    expect(uploads).toHaveLength(1);
    const upload = uploads[0]!;
    expect(upload.module).toBe(bundleSource('abc123'));
    expect(upload.wasm).toEqual(WASM);
    expect(upload.parts).toEqual([{ name: 'worker.mjs', type: 'application/javascript+module' }, { name: 'engine.wasm', type: 'application/wasm' }]);
    expect(upload.metadata).toMatchObject({
      bindings: expect.arrayContaining([
        { type: 'durable_object_namespace', name: 'CREDENTIALS', class_name: 'CredentialVaultDO' },
        { type: 'durable_object_namespace', name: 'USER_STORAGE', class_name: 'UserStorageDO' },
        { type: 'r2_bucket', name: 'OBJECTS', bucket_name: (await env.DEPLOYMENTS.getByName('bravo').tenantConfig())!.blobBucket },
        { type: 'artifacts', name: 'ARTIFACTS', namespace: `gsp-${await accountId('bravo')}` },
        { type: 'plain_text', name: 'ROOT_KEY', text: ADMIN_PUBLIC_KEY },
        { type: 'plain_text', name: 'TENANT', text: 'bravo' },
        { type: 'secret_text', name: 'PROVIDER_TOKEN', text: token },
        { type: 'service', name: 'STATIC_FILES', service: 'public-assets-test' },
      ]),
      migrations: { old_tag: 'v8', new_tag: 'v10', steps: [{ new_sqlite_classes: ['Classv9'] }, { new_sqlite_classes: ['Classv10'] }] },
    });

    // The release is kept in RELEASES as sent: the manifest and each module beside it.
    const stored = await env.RELEASES.get('tenants/bravo/abc123/worker.manifest.json');
    expect(await stored?.text()).toBe(tenantObjects('bravo').get(`users/${await accountId('bravo')}/releases/abc123/worker.manifest.json`));
    expect([...new Uint8Array(await (await env.RELEASES.get('tenants/bravo/abc123/worker/engine.wasm'))!.arrayBuffer())]).toEqual(WASM);

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

  it('rejects a manifest whose bytes do not match the declared hash', async () => {
    const token = await mintToken('delta');
    const staged = await stageRelease('delta', 'd1');
    const response = await tenantPost('delta', 'deploy', token, { sha: 'd1', manifestKey: staged.manifestKey, manifestHash: `sha256:${'0'.repeat(64)}`, metadata: metadata(['v1']) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'MANIFEST_HASH_MISMATCH' } });
    expect(uploads).toHaveLength(0);
  });

  it.each([
    ['different bytes of the same size', (content: Uint8Array<ArrayBuffer>) => content.map((byte, index) => index === 4 ? byte ^ 1 : byte)],
    ['one byte more than the manifest size', (content: Uint8Array<ArrayBuffer>) => new Uint8Array([...content, 0])],
    ['one byte less than the manifest size', (content: Uint8Array<ArrayBuffer>) => content.slice(0, -1)],
  ])('rejects a module with %s before storing or uploading anything', async (_case, tamper) => {
    const tenant = `tamper-${crypto.randomUUID().slice(0, 8)}`;
    const token = await mintToken(tenant);
    const staged = await stageRelease(tenant, 't1');
    const moduleKey = workerModuleKey(staged.manifestKey, 'engine.wasm');
    const original = tenantObjects(tenant).get(moduleKey);
    if (!(original instanceof Uint8Array)) throw new Error('Staged module missing');
    tenantObjects(tenant).set(moduleKey, tamper(original));
    const response = await tenantPost(tenant, 'deploy', token, { sha: 't1', ...staged, metadata: metadata(['v1']) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'WORKER_MODULE_INVALID', message: 'Worker module integrity mismatch: engine.wasm' } });
    expect(uploads).toHaveLength(0);
    expect(await env.RELEASES.head(`tenants/${tenant}/t1/worker.manifest.json`)).toBeNull();
    expect((await env.DEPLOYMENTS.getByName(tenant).getState()).active).toBeNull();
  });

  it('deploys a legacy bundle request and restores it from RELEASES after a module release', async () => {
    const token = await mintToken('legacy');
    const legacy = await stageLegacyRelease('legacy', 'one');
    const first = await tenantPost('legacy', 'deploy', token, { sha: 'one', ...legacy, metadata: metadata(['v1']) });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ sha: 'one', healthy: true });
    expect(uploads[0]).toMatchObject({ module: bundleSource('one'), wasm: WASM, parts: [{ name: 'worker.mjs', type: 'application/javascript+module' }, { name: 'engine.wasm', type: 'application/wasm' }] });
    expect(await (await env.RELEASES.get('tenants/legacy/one/worker.bundle.json'))?.text()).toBe(await legacyBundle('one'));

    await deploy('legacy', token, 'two', ['v1']);
    objects.delete(`${env.DISPATCH_NAMESPACE}-tenant-legacy`);
    const response = await tenantPost('legacy', 'revert', token, { to: 'previous' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sha: 'one', healthy: true, revertedTo: null, appliedMigrationTag: 'v1' });
    expect(uploads[2]).toMatchObject({ module: bundleSource('one'), wasm: WASM, metadata: { tags: ['legacy', 'one'] } });
  });

  it('deploys a module release named by a legacy request from a tenant that predates module releases', async () => {
    const token = await mintToken('transition');
    const staged = await stageRelease('transition', 'modules');
    const response = await tenantPost('transition', 'deploy', token, { sha: 'modules', bundleKey: staged.manifestKey, bundleHash: staged.manifestHash, metadata: metadata(['v1']) });
    expect(response.status).toBe(200);
    expect(uploads[0]).toMatchObject({ module: bundleSource('modules'), wasm: WASM });
    expect(await env.RELEASES.head('tenants/transition/modules/worker.manifest.json')).not.toBeNull();
  });

  it('surfaces Cloudflare rejections without recording a deploy and frees the lease for the next one', async () => {
    const token = await mintToken('echo');
    rejectNextUpload = 'old_tag mismatch';
    const staged = await stageRelease('echo', 'e1');
    const response = await tenantPost('echo', 'deploy', token, { sha: 'e1', ...staged, metadata: metadata(['v1']) });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'UPLOAD_REJECTED', message: expect.stringContaining('10021: old_tag mismatch') } });
    const state = await env.DEPLOYMENTS.getByName('echo').getState();
    expect(state.deploys).toHaveLength(0);
    expect(state.appliedMigrationTag).toBeNull();
    expect(await deploy('echo', token, 'e1', ['v1'])).toMatchObject({ sha: 'e1', healthy: true });
  });

  it('keeps a healthy candidate when the dispatcher still serves its predecessor during propagation', async () => {
    const token = await mintToken('propagation');
    await deploy('propagation', token, 'old', ['v1']);
    probeVersions.set(`${env.DISPATCH_NAMESPACE}-tenant-propagation`, Array(5).fill('old'));

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
    expect(scripts.get(`${env.DISPATCH_NAMESPACE}-tenant-foxtrot`)).toBe(bundleSource('good'));

    const state = await env.DEPLOYMENTS.getByName('foxtrot').getState();
    expect(state.active?.sha).toBe('good');
    expect(state.appliedMigrationTag).toBe('v2');
    expect(state.deploys.map((deploy) => [deploy.sha, deploy.healthy, deploy.revertedTo])).toEqual([
      ['bad', false, 'good'],
      ['good', true, null],
      ['good', true, null],
    ]);
  });

  it.each([['module', false], ['legacy bundle', true]])('falls back to a channel published as a %s when a first deploy is unhealthy', async (_format, legacy) => {
    const commit = 'a'.repeat(40);
    await publishDefault(commit, ['v1'], { legacy });
    const tenant = `golf-${legacy ? 'legacy' : 'modules'}`;
    const token = await mintToken(tenant);
    const result = await deploy(tenant, token, 'unhealthy', ['v1'], 'nope');
    expect(result).toEqual({ sha: 'unhealthy', healthy: false, revertedTo: commit, appliedMigrationTag: 'v1' });
    expect(uploads[1]).toMatchObject({ module: bundleSource(commit), wasm: WASM, metadata: { tags: [tenant, commit] } });
    const fallback = (await env.DEPLOYMENTS.getByName(tenant).getState()).active;
    expect(fallback?.workerKey).toBe(`defaults/releases/${commit}/${legacy ? 'worker.bundle.json' : 'worker.manifest.json'}`);
  });
});

describe('POST /__platform/tenants/:tenant/revert', () => {
  it('refuses legacy split channel objects without a coherent default pointer', async () => {
    await env.RELEASES.delete(DEFAULT_ACCOUNT_POINTER);
    await env.RELEASES.put('channel/worker.bundle.json', await legacyBundle('channel:split'));
    await env.RELEASES.put('channel/metadata.json', JSON.stringify(metadata(['v1'])));
    const token = await mintToken('split-default');
    const response = await tenantPost('split-default', 'revert', token, { to: 'channel' });
    expect(response.status).toBe(409);
    expect(uploads).toHaveLength(0);
  });
  it('reverts to the complete channel module graph and its metadata', async () => {
    const commit = 'b'.repeat(40);
    const expectedPin = await publishDefault(commit, ['v1', 'v2']);
    const token = await mintToken('hotel', 'v2');
    await deploy('hotel', token, 'h1', ['v1', 'v2']);
    probeVersions.set(`${env.DISPATCH_NAMESPACE}-tenant-hotel`, ['h1']);

    const response = await tenantPost('hotel', 'revert', token, { to: 'channel' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sha: commit, healthy: true, revertedTo: null, appliedMigrationTag: 'v2' });

    const upload = uploads[1]!;
    expect(upload.module).toBe(bundleSource(commit));
    expect(upload.metadata.tags).toEqual(['hotel', commit]);
    expect(upload.metadata.migrations).toBeUndefined();
    expect(scripts.get(`${env.DISPATCH_NAMESPACE}-tenant-hotel`)).toBe(bundleSource(commit));
    const state = await env.DEPLOYMENTS.getByName('hotel').getState();
    expect(state.active?.sha).toBe(commit);
    await publishDefault('e'.repeat(40), ['v1', 'v2']);
    await deploy('hotel', token, 'hot-worker', ['v1', 'v2']);
    const defaultImage = await env.DEPLOYMENTS.getByName('hotel').compute('hotel', `u-${'f'.repeat(32)}`, new Request('https://compute.internal/v1/images/default', { method: 'POST' }));
    expect(defaultImage.status).toBe(200);
    expect(await defaultImage.json()).toMatchObject({ value: { image: `registry.example.com/gitspace@sha256:${'c'.repeat(64)}` } });
    const pin = (await env.DEPLOYMENTS.getByName('hotel').getState()).active?.metadata.resources.find(resource => resource.name === 'DEFAULT_ACCOUNT_RELEASE');
    expect(pin).toMatchObject({ source: 'literal', value: expectedPin });
  });

  it('restores the channel under an inference requirement only when the default advertises it', async () => {
    const commit = '7'.repeat(40);
    await publishDefault(commit, ['v1']);
    const token = await mintToken('kilo');
    await deploy('kilo', token, 'k1', ['v1']);

    const refused = await tenantPost('kilo', 'revert', token, { to: 'channel', inferenceVersion: 1 });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'RELEASE_INCOMPATIBLE' } });
    expect(scripts.get(`${env.DISPATCH_NAMESPACE}-tenant-kilo`)).toBe(bundleSource('k1'));

    await publishDefault(commit, ['v1'], { inferenceVersion: 1 });
    const restored = await tenantPost('kilo', 'revert', token, { to: 'channel', inferenceVersion: 1 });
    expect(restored.status).toBe(200);
    expect(scripts.get(`${env.DISPATCH_NAMESPACE}-tenant-kilo`)).toBe(bundleSource(commit));
  });

  it('refuses a channel revert when the channel bundle is not published', async () => {
    await env.RELEASES.delete(DEFAULT_ACCOUNT_POINTER);
    const token = await mintToken('india');
    const response = await tenantPost('india', 'revert', token, { to: 'channel' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'CHANNEL_UNAVAILABLE' } });
  });

  it('reverts to the previous healthy release from RELEASES', async () => {
    const token = await mintToken('juliet');
    await deploy('juliet', token, 'one', ['v1']);
    await deploy('juliet', token, 'two', ['v1']);
    objects.delete(`${env.DISPATCH_NAMESPACE}-tenant-juliet`);

    const response = await tenantPost('juliet', 'revert', token, { to: 'previous' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sha: 'one', healthy: true, revertedTo: null, appliedMigrationTag: 'v1' });
    expect(uploads[2]!.module).toBe(bundleSource('one'));
    expect(uploads[2]!.metadata.tags).toEqual(['juliet', 'one']);
  });

  it('finishes a revert whose caller left mid-swap, keeps its outcome under the operation id, and frees the lease when it ends', async () => {
    const commit = '5'.repeat(40);
    await publishDefault(commit, ['v1']);
    const token = await mintToken('lima');
    await deploy('lima', token, 'l1', ['v1']);
    const operationId = crypto.randomUUID();
    const upload = holdNextUpload();
    // Nobody reads this answer: the caller is gone once the upload is under way.
    void tenantPost('lima', 'revert', token, { to: 'channel', operationId });
    await upload.started;

    const concurrent = await tenantPost('lima', 'revert', token, { to: 'previous' });
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toMatchObject({ error: { code: 'DEPLOY_IN_PROGRESS' } });
    const deployments = env.DEPLOYMENTS.getByName('lima');
    const outcome = deployments.operation(operationId);
    // Calls on one stub arrive in order: once this answers, the object holds the request above on the running swap.
    await deployments.getState();
    upload.release();
    expect(await outcome).toEqual({ status: 'ok', value: { sha: commit, healthy: true, revertedTo: null, appliedMigrationTag: 'v1' } });
    const answered = await operationGet('lima', token, operationId);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ sha: commit, healthy: true, revertedTo: null, appliedMigrationTag: 'v1' });
    expect((await deployments.getState()).active?.sha).toBe(commit);

    // The same id answers from the record and never swaps twice.
    const repeated = await tenantPost('lima', 'revert', token, { to: 'channel', operationId });
    expect(await repeated.json()).toEqual({ sha: commit, healthy: true, revertedTo: null, appliedMigrationTag: 'v1' });
    expect(uploads).toHaveLength(2);
    expect((await operationGet('lima', token, crypto.randomUUID())).status).toBe(404);

    const next = await tenantPost('lima', 'revert', token, { to: 'previous' });
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ sha: 'l1', healthy: true });
  });

  it('reports a swap that ended with an earlier instance of the deployment object as interrupted', async () => {
    const token = await mintToken('mike');
    const operationId = crypto.randomUUID();
    await runInDurableObject(env.DEPLOYMENTS.getByName('mike'), (_instance, state) => {
      state.storage.sql.exec('INSERT INTO operations(id, started_at, outcome_json) VALUES (?, ?, NULL)', operationId, new Date().toISOString());
    });
    const response = await operationGet('mike', token, operationId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'DEPLOY_INTERRUPTED' } });
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
    }), testEnv, createExecutionContext());
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
    expect(scripts.get(`${env.DISPATCH_NAMESPACE}-tenant-${a}`)).toBe(bundleSource('account-a'));
    expect(scripts.get(`${env.DISPATCH_NAMESPACE}-tenant-${b}`)).toBe(bundleSource('account-b'));

    const commit = 'd'.repeat(40);
    await publishDefault(commit, ['v1']);
    expect((await post(b, 'revert', { accountId: bId, to: 'channel' })).status).toBe(200);
    expect(scripts.get(`${env.DISPATCH_NAMESPACE}-tenant-${b}`)).toBe(bundleSource(commit));
    expect(scripts.get(`${env.DISPATCH_NAMESPACE}-tenant-${a}`)).toBe(bundleSource('account-a'));
    expect(await env.DEPLOYMENTS.getByName(a).getState()).toEqual(aState);
    expect((await env.DEPLOYMENTS.getByName(b).getState()).active?.sha).toBe(commit);
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
    expect(scripts.get(`${env.DISPATCH_NAMESPACE}-tenant-${tenant}`)).toBe(bundleSource('owned-release'));
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
