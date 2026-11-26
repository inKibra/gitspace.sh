import { beforeAll, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { HttpResponse, http } from 'msw';
import { z } from 'zod';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol';
import { deploymentStatusSchema, platformDeployRequestSchema, WORKER_MANIFEST_FILE, type ReleaseArtifact, type ReleaseSource, type WorkerReleaseMetadata } from '@gitspace/protocol/deployment';
import { NATIVE_UPSTREAMS, PORTABLE_ENTRYPOINTS, PORTABLE_MANIFEST_FILE, portableFileKey, type MachineNativeFile, type MachineNativeName, type PortableManifest } from '@gitspace/protocol/machine-release';
import { CHANNEL_CATALOG } from '@gitspace/protocol/release-channel';
import worker from '../src/index.js';
import { launchPublishedRelease } from '../src/application.js';
import { publishedFrontendTreeHash } from '../src/channel.js';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';
import { BudgetedDurableObject } from '../src/storage-quarantine.js';

// The fixture platform swaps no code: every object already runs the code under test, so none restarts for a launch
// (`release-rollout.test.ts` covers the restart).
beforeAll(() => { vi.spyOn(BudgetedDurableObject.prototype, 'restartForRelease').mockResolvedValue('current'); });

const machineSigningPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 101);
const encoder = new TextEncoder();
const hex = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))), byte => byte.toString(16).padStart(2, '0')).join('');
const WORKER_METADATA: WorkerReleaseMetadata = {
  mainModule: 'worker.mjs', compatibilityDate: '2026-08-27', compatibilityFlags: ['nodejs_compat'],
  durableObjects: [{ name: 'CREDENTIALS', className: 'CredentialVaultDO' }],
  resources: [{ name: 'DATA', source: 'object-storage' }, { name: 'ACCOUNT_ID', source: 'account-id' }],
  migrations: [{ tag: 'v1', newSqliteClasses: ['CredentialVaultDO'], deletedClasses: [] }],
};

/** An account with one machine allowed to read release files and run the account's controls. */
async function account() {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: null } })));
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)) });
  await vault.registerDevice(signCredentialAuthorityGrant({
    version: 1, userId, machineId: 'machine-a', generation: 1, capabilities: ['space.control', 'storage.access'],
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineSigningPrivateKey)),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(Uint8Array.from({ length: 32 }, (_, index) => 60 + index))),
  }, tenantRootPrivateKey));
  return { userId, origin: `https://${env.TENANT_ID}.gitspace.sh`, releases: env.TENANT_RELEASES.getByName(userId) };
}

/** The upstream asset `<os>-<tool>`: one byte, different for each. */
function asset(name: string): Uint8Array {
  return Uint8Array.of([...name].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 256);
}

/** The upstream releases the natives come from. Counts the downloads. */
function upstream() {
  const downloads: string[] = [];
  for (const [name, prefix] of Object.entries(NATIVE_UPSTREAMS)) network.use(http.get(`${prefix}v1/:asset`, ({ params }) => {
    const file = String(params.asset).replace(/\.zip$/u, '');
    if (!file.endsWith(`-${name}`)) return undefined;
    downloads.push(file);
    return HttpResponse.arrayBuffer(asset(file).slice().buffer);
  }));
  return downloads;
}

/** A release in the channel: its files by channel key, and the pin naming its manifest. */
interface Published {
  commit: string;
  tag: string;
  pin: string;
  objects: Map<string, Uint8Array>;
  worker: { key: string; sha256: string; size: number };
}

/** A release as `publish-default.yml` publishes it to the channel: every file under `defaults/releases/<commit>/`, the
 * manifest pinning them, and the pin naming the manifest. */
async function published(commit: string, tag: string): Promise<Published> {
  const objects = new Map<string, Uint8Array>();
  const prefix = `defaults/releases/${commit}/`;
  const object = async (key: string, bytes: Uint8Array) => { objects.set(key, bytes); return { key, sha256: await hex(bytes), size: bytes.byteLength }; };
  const pages: Array<{ path: string; contentType: string; text: string }> = [
    { path: 'index.html', contentType: 'text/html; charset=utf-8', text: `<main>${tag}</main>` },
    { path: 'assets/app-1.js', contentType: 'text/javascript; charset=utf-8', text: 'export {};' },
  ];
  const frontend = [];
  for (const page of pages) frontend.push({ ...await object(`${prefix}frontend/${page.path}`, encoder.encode(page.text)), path: page.path, contentType: page.contentType });
  const portableKey = `${prefix}${PORTABLE_MANIFEST_FILE}`;
  const files = [];
  for (const path of PORTABLE_ENTRYPOINTS) {
    const bytes = encoder.encode(`${path} of ${tag}`);
    objects.set(portableFileKey(portableKey, path), bytes);
    files.push({ path, sha256: await hex(bytes), size: bytes.byteLength });
  }
  const native = async (name: MachineNativeName, abi: MachineNativeFile['abi']): Promise<MachineNativeFile> => ({
    version: name === 'bun' ? '1.4.0' : '1.0.0', url: `${NATIVE_UPSTREAMS[name]}v1/${abi.os}-${name}.zip`, sha256: await hex(asset(`${abi.os}-${name}`)), size: 1, member: name, executable: { sha256: 'b'.repeat(64), size: 1 }, abi,
  });
  const darwin = { bun: await native('bun', { os: 'darwin', macos: '13.0' }), rg: await native('rg', { os: 'darwin', macos: '13.0' }), 'git-lfs': await native('git-lfs', { os: 'darwin', macos: '13.0' }) };
  const linux = { bun: await native('bun', { os: 'linux', glibc: '2.17' }), rg: await native('rg', { os: 'linux', glibc: null }), 'git-lfs': await native('git-lfs', { os: 'linux', glibc: null }) };
  const portableManifest: PortableManifest = { schemaVersion: 1, bunVersion: '1.4.0', files, natives: { 'darwin-arm64': darwin, 'darwin-x64': darwin, 'linux-arm64': linux, 'linux-x64': linux } };
  const image = `registry.gitspace.sh/gitspace/machine@sha256:${'e'.repeat(64)}`;
  const release = {
    schemaVersion: 1, commit, inferenceVersion: 1,
    worker: { commit, version: commit, manifest: await object(`${prefix}${WORKER_MANIFEST_FILE}`, encoder.encode(`worker modules of ${tag}`)), metadata: WORKER_METADATA },
    frontend: { commit, files: frontend },
    image: { commit, image, provenance: await object(`${prefix}image-provenance.json`, encoder.encode(JSON.stringify({ commit, image }))) },
    machines: [],
    portable: await object(portableKey, encoder.encode(JSON.stringify(portableManifest))),
  };
  const manifest = encoder.encode(JSON.stringify(release));
  objects.set(`${prefix}manifest.json`, manifest);
  return { commit, tag, pin: `${commit}:${await hex(manifest)}`, objects, worker: release.worker.manifest };
}

/** The release channel serving `releases`, newest first, bound as `RELEASE_CHANNEL` in the environment the account
 * Worker is called with. Records each request and whether it carried credentials. */
function channel(releases: Published[]) {
  const requests: Array<{ key: string; method: string; credentials: boolean }> = [];
  const catalog = encoder.encode(JSON.stringify({ schemaVersion: 1, releases: releases.map(release => ({ tag: release.tag, commit: release.commit, pin: release.pin, publishedAt: '2026-10-29T00:00:00.000Z' })) }));
  const releaseChannel = {
    async fetch(input, init) {
      const request = new Request(input, init);
      const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
      requests.push({ key, method: request.method, credentials: request.headers.has('authorization') || request.headers.has('cookie') });
      const bytes = key === CHANNEL_CATALOG ? catalog : releases.map(release => release.objects.get(key)).find(found => found !== undefined);
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(request.method === 'HEAD' ? null : bytes.slice(), { headers: { 'content-length': String(bytes.byteLength), etag: `"${key}"` } });
    },
    connect: (address, options) => env.RELEASE_CHANNEL.connect(address, options),
  } satisfies Fetcher;
  return { requests, runtime: { ...env, RELEASE_CHANNEL: releaseChannel } };
}

it('takes the published release it was created from as its default once, by reference, and serves its frontend from the channel', async () => {
  const { userId, origin, releases } = await account();
  const release = await published('d'.repeat(40), 'v1.0.0');
  const { requests, runtime: withChannel } = channel([release]);
  const downloads = upstream();
  const runtime = { ...withChannel, DEFAULT_ACCOUNT_RELEASE: release.pin };

  const page = await worker.fetch(new Request(`${origin}/settings`, { headers: { authorization: 'Bearer private-browser-token', cookie: 'private-cookie' } }), runtime);
  expect(page.status).toBe(200);
  expect(await page.text()).toBe('<main>v1.0.0</main>');
  // A later default names other hashed assets, so the document is revalidated while the assets stay cached.
  expect(page.headers.get('cache-control')).toBe('no-cache');
  expect(page.headers.get('x-gitspace-frontend-release')).toBe(release.commit);
  const script = await worker.fetch(new Request(`${origin}/assets/app-1.js`), runtime);
  expect([script.status, script.headers.get('cache-control'), await script.text()]).toEqual([200, 'public, max-age=31536000, immutable', 'export {};']);

  const status = deploymentStatusSchema.parse(await releases.status(userId, { sha: null, version: null, startupTimeMs: null }));
  expect(status.defaultRelease).toBe(release.commit);
  expect(status.desired).toMatchObject({ worker: null, machine: null, frontend: null });
  expect(status.releases.find(record => record.sha === release.commit)?.source).toEqual({ kind: 'release', tag: 'v1.0.0', pin: release.pin });
  // Machines and new computers follow the default, whose files stay in the channel; only the natives are copied.
  expect(deploymentStatusSchema.parse(await releases.status(userId, { sha: null, version: null, startupTimeMs: null }, 'machine-b')).desired.machine).toBe(release.commit);
  expect(await releases.installRelease()).toMatchObject({ sha: release.commit, portable: { key: `channel/defaults/releases/${release.commit}/${PORTABLE_MANIFEST_FILE}` } });
  expect((await env.DATA.list({ prefix: `users/${userId}/channel/` })).objects).toEqual([]);
  expect(downloads).toHaveLength(6);

  // Once: later requests neither read the manifest again nor copy anything.
  await worker.fetch(new Request(`${origin}/`), runtime);
  expect(requests.filter(request => request.key.endsWith('/manifest.json'))).toHaveLength(1);
  expect(downloads).toHaveLength(6);
  expect(requests.some(request => request.credentials)).toBe(false);
});

it('serves the frontend bundled with the Worker and has no default while the channel lacks the release the account was created from', async () => {
  const { userId, origin, releases } = await account();
  const release = await published('f'.repeat(40), 'v1.0.0');
  const { runtime } = channel([]);
  const page = await worker.fetch(new Request(`${origin}/`), { ...runtime, DEFAULT_ACCOUNT_RELEASE: release.pin });
  expect(page.headers.get('x-gitspace-frontend-release')).toBeNull();
  expect(deploymentStatusSchema.parse(await releases.status(userId, { sha: null, version: null, startupTimeMs: null })).defaultRelease).toBeNull();
});

it('answers its machines and the platform with a published release\'s files from the channel, read only', async () => {
  const { userId, origin } = await account();
  const release = await published('d'.repeat(40), 'v1.0.0');
  const { runtime } = channel([release]);
  upstream();
  await worker.fetch(new Request(`${origin}/`), { ...runtime, DEFAULT_ACCOUNT_RELEASE: release.pin });
  const signed = (operation: 'data.get' | 'data.head' | 'data.put', key: string, hash?: string) => btoa(JSON.stringify(createSignedControlRequest({ userId, machineId: 'machine-a', operation, payload: operation === 'data.put' ? { key, hash: `sha256:${'0'.repeat(64)}`, size: 1 } : { key, ...(hash ? { hash } : {}) }, signingPrivateKey: machineSigningPrivateKey }))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const cli = encoder.encode('cli/gitspace.js of v1.0.0');
  const cliHash = `sha256:${await hex(cli)}`;
  // What the machine client (`CloudSpaceAuthority.download`) accepts: the named digest and the size in the headers,
  // then bytes matching both.
  const machineRead = async (key: string, hash: string) => {
    const response = await worker.fetch(new Request(`https://auth.test/v1/data/${key}`, { headers: { 'x-gitspace-control': signed('data.get', key, hash) } }), runtime);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, hash: response.headers.get('x-gitspace-sha256'), size: response.headers.get('content-length'), bytesHash: `sha256:${await hex(bytes)}` };
  };
  const portable = `channel/${portableFileKey(`defaults/releases/${release.commit}/${PORTABLE_MANIFEST_FILE}`, 'cli/gitspace.js')}`;
  expect(await machineRead(portable, cliHash)).toEqual({ status: 200, hash: cliHash, size: String(cli.byteLength), bytesHash: cliHash });
  // `gitspace machine setup` names every release's files `releases/<sha>/…`, a published release's too.
  const named = portableFileKey(`releases/${release.commit}/${PORTABLE_MANIFEST_FILE}`, 'cli/gitspace.js');
  expect(await machineRead(named, cliHash)).toEqual({ status: 200, hash: cliHash, size: String(cli.byteLength), bytesHash: cliHash });
  // A machine reads `releases/<sha>/frontend.manifest.json` unnamed by digest before it takes any release; a published
  // release has none of its own, so the answer lists the files its pinned manifest names, each by its digest.
  const frontendManifest = `releases/${release.commit}/frontend.manifest.json`;
  const listed = await worker.fetch(new Request(`https://auth.test/v1/data/${frontendManifest}`, { headers: { 'x-gitspace-control': signed('data.get', frontendManifest) } }), runtime);
  const listedBytes = new Uint8Array(await listed.arrayBuffer());
  expect({ status: listed.status, hash: listed.headers.get('x-gitspace-sha256'), size: listed.headers.get('content-length') })
    .toEqual({ status: 200, hash: `sha256:${await hex(listedBytes)}`, size: String(listedBytes.byteLength) });
  const { files } = z.object({ files: z.array(z.object({ path: z.string(), hash: z.string() })) }).parse(JSON.parse(new TextDecoder().decode(listedBytes)));
  expect(files.length).toBeGreaterThan(0);
  const [first] = files;
  const frontendFile = `channel/defaults/releases/${release.commit}/frontend/${first!.path}`;
  expect((await machineRead(frontendFile, first!.hash)).status).toBe(200);
  // A read that names no digest is refused: nothing could check what the channel answers.
  expect((await worker.fetch(new Request(`https://auth.test/v1/data/${portable}`, { headers: { 'x-gitspace-control': signed('data.get', portable) } }), runtime)).status).toBe(400);
  const missing = `channel/defaults/releases/${release.commit}/missing`;
  expect((await machineRead(missing, cliHash)).status).toBe(404);
  const write = await worker.fetch(new Request(`https://auth.test/v1/data/${portable}`, { method: 'PUT', headers: { 'content-length': '1', 'x-gitspace-control': signed('data.put', portable) }, body: 'x' }), runtime);
  expect(write.status).toBe(400);

  const manifestPath = `users/${userId}/channel/${release.worker.key}`.split('/').map(encodeURIComponent).join('/');
  const platform = await worker.fetch(new Request(`https://tenant.test/__platform/objects/${manifestPath}`, { headers: { authorization: `Bearer ${env.PLATFORM_TOKEN}` } }), runtime);
  expect([platform.status, await platform.text()]).toEqual([200, 'worker modules of v1.0.0']);
  expect((await worker.fetch(new Request(`https://tenant.test/__platform/objects/${manifestPath}`, { headers: { authorization: 'Bearer not-the-platform' } }), runtime)).status).toBe(401);
});

it('launches a published release by its tag to every target with no machine, and it becomes the default once the platform runs its Worker', async () => {
  const { userId, origin, releases } = await account();
  const first = await published('d'.repeat(40), 'v1.0.0');
  const next = await published('a'.repeat(40), 'v1.1.0');
  const { runtime } = channel([next, first]);
  upstream();
  const deploys: unknown[] = [];
  network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/deploy`, async ({ request }) => {
    const body: unknown = await request.json();
    deploys.push(body);
    return HttpResponse.json({ sha: platformDeployRequestSchema.parse(body).sha, healthy: true, revertedTo: null, appliedMigrationTag: 'v1' });
  }));
  await worker.fetch(new Request(`${origin}/`), { ...runtime, DEFAULT_ACCOUNT_RELEASE: first.pin });
  expect(deploymentStatusSchema.parse(await releases.status(userId, { sha: null, version: null, startupTimeMs: null })).defaultRelease).toBe(first.commit);
  await expect(launchPublishedRelease(runtime, userId, 'v9.9.9')).rejects.toThrow('no release v9.9.9');

  const started = deploymentStatusSchema.parse(await launchPublishedRelease(runtime, userId, 'v1.1.0'));
  expect(started.launch).toMatchObject({ source: { kind: 'release', sha: next.commit }, targets: ['worker', 'machine', 'frontend'] });
  const finished = await vi.waitFor(async () => {
    const status = deploymentStatusSchema.parse(await releases.status(userId, { sha: null, version: null, startupTimeMs: null }));
    if (status.launch?.status === 'running') throw new Error('The launch is still running');
    return status;
  });
  expect(finished.launch).toMatchObject({ launchId: started.launch?.launchId, status: 'succeeded', error: null });
  expect(finished.defaultRelease).toBe(next.commit);
  expect(finished.desired).toMatchObject({ worker: next.commit, machine: next.commit, frontend: next.commit });
  expect(deploys).toEqual([{ accountId: userId, sha: next.commit, manifestKey: `users/${userId}/channel/${next.worker.key}`, manifestHash: `sha256:${next.worker.sha256}`, metadata: WORKER_METADATA }]);
  expect(await (await worker.fetch(new Request(`${origin}/`), runtime)).text()).toBe('<main>v1.1.0</main>');
});

it('launches a published commit the account already built as the release it holds, from its own files', async () => {
  const { userId, releases } = await account();
  const release = await published('a'.repeat(40), 'v1.1.0');
  const { runtime } = channel([release]);
  const downloads = upstream();
  const deploys: unknown[] = [];
  network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/deploy`, async ({ request }) => {
    const body: unknown = await request.json();
    deploys.push(body);
    return HttpResponse.json({ sha: platformDeployRequestSchema.parse(body).sha, healthy: true, revertedTo: null, appliedMigrationTag: 'v1' });
  }));
  const own = (name: string): ReleaseArtifact => ({ key: `releases/${release.commit}/${name}`, hash: `sha256:${'c'.repeat(64)}`, size: 1 });
  const source: ReleaseSource = { kind: 'canonical', repository: 'https://github.com/inKibra/gitspace.sh.git', branch: 'develop', commit: release.commit };
  await releases.stage({ sha: release.commit, label: 'develop @ aaaaaaaaaaaa', inferenceVersion: 1, source, worker: WORKER_METADATA,
    artifacts: { worker: own(WORKER_MANIFEST_FILE), machine: null, frontend: own('frontend'), portable: own(PORTABLE_MANIFEST_FILE) } }, 'machine-a');

  await launchPublishedRelease(runtime, userId, 'v1.1.0');
  const finished = await vi.waitFor(async () => {
    const status = deploymentStatusSchema.parse(await releases.status(userId, { sha: null, version: null, startupTimeMs: null }));
    if (status.launch?.status === 'running') throw new Error('The launch is still running');
    return status;
  });
  expect(finished.launch).toMatchObject({ status: 'succeeded' });
  expect(deploys).toEqual([expect.objectContaining({ manifestKey: `users/${userId}/${own(WORKER_MANIFEST_FILE).key}` })]);
  expect(finished.releases.find(record => record.sha === release.commit)).toMatchObject({ source, label: 'develop @ aaaaaaaaaaaa' });
  expect(downloads).toEqual([]);
});

it('names a published frontend by the tree hash a machine computes over the files it writes', async () => {
  // `hashArtifactPath` over this tree on disk (index.html, assets/a.js, assets/B.css, Z.txt) gives this hash: directory
  // entries in localeCompare order (assets, index.html, Z.txt; a.js, B.css), never byte order.
  const tree = { 'index.html': 'html', 'assets/a.js': 'js', 'assets/B.css': 'css', 'Z.txt': 'zed' };
  const files = await Promise.all(Object.entries(tree).map(async ([path, text]) => ({ key: `defaults/releases/x/frontend/${path}`, sha256: await hex(encoder.encode(text)), size: text.length, path, contentType: 'text/plain' })));
  const releaseChannel = {
    async fetch(input, init) {
      const path = decodeURIComponent(new URL(new Request(input, init).url).pathname.slice('/defaults/releases/x/frontend/'.length));
      const text = Object.entries(tree).find(([name]) => name === path)?.[1];
      return text === undefined ? new Response(null, { status: 404 }) : new Response(text);
    },
    connect: (address, options) => env.RELEASE_CHANNEL.connect(address, options),
  } satisfies Fetcher;
  expect(await publishedFrontendTreeHash({ ...env, RELEASE_CHANNEL: releaseChannel }, files)).toBe('sha256:8b7057a8fb01d26f6d8e135d16a562f92337c9172dcbfe267dd8e97dd5573b3b');
});
