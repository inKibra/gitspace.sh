import { ed25519 } from '@noble/curves/ed25519.js';
import { env } from 'cloudflare:workers';
import { createRelayAuthorization, type PlatformDeployResponse, type WorkerReleaseMetadata } from '@gitspace/protocol';
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
      async fetch(): Promise<Response> {
        const source = scripts.get(name);
        if (source === undefined) throw new Error(`Worker not found: ${name}`);
        const version = /version: (\S+) /u.exec(source)?.[1] ?? 'unknown';
        return Response.json({ ok: true, version }, { headers: { 'x-gitspace-worker-version': version } });
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

async function stageRelease(tenant: string, sha: string, version = sha): Promise<{ bundleKey: string; bundleHash: string }> {
  const source = bundleSource(version);
  const bundleKey = `users/${tenant}/releases/${sha}/worker.mjs`;
  await env.DATA.put(bundleKey, source);
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
  uploads.length = 0;
  rejectNextUpload = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
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
  it('uploads the bundle with the exact multipart metadata and meters the deploy', async () => {
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
      bindings: [
        { type: 'durable_object_namespace', name: 'CREDENTIALS', class_name: 'CredentialVaultDO' },
        { type: 'durable_object_namespace', name: 'USER_STORAGE', class_name: 'UserStorageDO' },
      ],
      migrations: { old_tag: 'v8', new_tag: 'v10', steps: [{ new_sqlite_classes: ['Classv9'] }, { new_sqlite_classes: ['Classv10'] }] },
      keep_bindings: upload.metadata.keep_bindings,
      tags: ['bravo', 'abc123'],
    });
    expect(upload.metadata.keep_bindings).toEqual(expect.arrayContaining(['secret_text', 'r2_bucket', 'service', 'plain_text']));
    expect(upload.metadata.keep_bindings).not.toContain('durable_object_namespace');

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
    await env.DATA.delete('users/juliet/releases/one/worker.mjs');

    const response = await tenantPost('juliet', 'revert', token, { to: 'previous' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sha: 'one', healthy: true, revertedTo: null, appliedMigrationTag: 'v1' });
    expect(uploads[2]!.module).toBe(bundleSource('one'));
    expect(uploads[2]!.metadata.tags).toEqual(['juliet', 'one']);
  });
});
