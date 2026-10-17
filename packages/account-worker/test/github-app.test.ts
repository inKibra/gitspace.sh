import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import type { RuntimeGitCheckpoint } from '@gitspace/protocol-runtime';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { refreshProjectRemote } from '../src/project-remote.js';
import { SpaceAuthorityDO } from '../src/space-authority.js';
import { network } from './network.js';

const API = 'https://api.github.com';
const APP_ID = 4242;
const WEBHOOK_SECRET = 'webhook-secret-from-github';
const CLIENT_SECRET = 'client-secret-from-github';
const JwtClaimsSchema = z.object({ iat: z.number(), exp: z.number(), iss: z.number() });

interface RsaKey { pem: string; publicKey: CryptoKey }

afterEach(() => { vi.restoreAllMocks(); });

const github = () => env.GITHUB_APP.getByName(env.ACCOUNT_ID);
const vault = () => env.CREDENTIALS.getByName(env.ACCOUNT_ID);
const bearer = (request: { headers: Headers }) => request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? '';

/** A key as GitHub issues it (PKCS#1) or as a PKCS#8 export. */
async function rsaKey(format: 'pkcs1' | 'pkcs8'): Promise<RsaKey> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('RSA generation returned no key pair');
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  // A 2048-bit PKCS#8 export is a fixed 26-byte envelope whose last 4 bytes head the PKCS#1 OCTET STRING.
  if (pkcs8[22] !== 0x04) throw new Error('Unexpected PKCS#8 layout');
  const der = format === 'pkcs1' ? pkcs8.subarray(26) : pkcs8;
  const label = format === 'pkcs1' ? 'RSA PRIVATE KEY' : 'PRIVATE KEY';
  const base64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/gu, '$1\n');
  return { pem: `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`, publicKey: pair.publicKey };
}

async function verifiedClaims(jwt: string, publicKey: CryptoKey): Promise<z.infer<typeof JwtClaimsSchema> | null> {
  const [header, payload, signature] = jwt.split('.');
  if (!header || !payload || !signature) return null;
  const decode = (part: string) => Uint8Array.from(atob(part.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, decode(signature), new TextEncoder().encode(`${header}.${payload}`))) return null;
  expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({ alg: 'RS256', typ: 'JWT' });
  return JwtClaimsSchema.parse(JSON.parse(new TextDecoder().decode(decode(payload))));
}

async function signature(body: string, secret = WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function deliver(event: string, deliveryId: string, body: string, signed: string | null): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': deliveryId });
  if (signed !== null) headers.set('x-hub-signature-256', signed);
  return SELF.fetch(`${env.ACCOUNT_URL}/github/webhook`, { method: 'POST', headers, body });
}

/** The settings outcome a GitHub callback redirected the browser to. */
function outcome(response: Response): URLSearchParams {
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location') ?? '');
  expect(`${location.origin}${location.pathname}`).toBe(`${env.ACCOUNT_URL}/settings`);
  expect(location.searchParams.get('section')).toBe('github');
  return location.searchParams;
}

function setupCallback(installationId: number, action: string, state: string | null): Promise<Response> {
  const url = new URL('/github/installed', env.ACCOUNT_URL);
  url.searchParams.set('installation_id', String(installationId));
  url.searchParams.set('setup_action', action);
  if (state !== null) url.searchParams.set('state', state);
  return SELF.fetch(url, { redirect: 'manual' });
}

async function bootstrapVault(): Promise<void> {
  await vault().bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(23)) });
}

/** GitHub's manifest conversion for `code`, counting how often it is asked. */
function conversionApi(key: RsaKey): { conversions: string[] } {
  const seen: { conversions: string[] } = { conversions: [] };
  network.use(http.post(`${API}/app-manifests/:code/conversions`, ({ params, request }) => {
    expect(request.headers.get('authorization')).toBeNull();
    seen.conversions.push(String(params.code));
    return HttpResponse.json({
      id: APP_ID, slug: 'gitspace-test', name: 'GitSpace test', html_url: 'https://github.com/apps/gitspace-test',
      owner: { login: 'octo', type: 'User' }, client_id: 'Iv1.client', client_secret: CLIENT_SECRET, webhook_secret: WEBHOOK_SECRET, pem: key.pem,
    }, { status: 201 });
  }));
  return seen;
}

async function createApp(key: RsaKey): Promise<void> {
  await bootstrapVault();
  conversionApi(key);
  const form = await github().startApp({ kind: 'user' });
  const created = await SELF.fetch(`${env.ACCOUNT_URL}/github/app/created?code=manifest-code&state=${new URL(form.action).searchParams.get('state')}`, { redirect: 'manual' });
  expect(outcome(created).get('github')).toBe('created');
}

/** GitHub's side of one installation: it answers only JWTs the App key signed and the token it issued. */
function installationApi(key: RsaKey, installationId: number, account: string, repositories: { names: string[] }): void {
  network.use(
    http.get(`${API}/app/installations/${installationId}`, async ({ request }) => {
      if (!await verifiedClaims(bearer(request), key.publicKey)) return HttpResponse.json({ message: 'Bad credentials' }, { status: 401 });
      return HttpResponse.json({
        id: installationId, account: { login: account, type: 'Organization' }, repository_selection: 'selected',
        permissions: { metadata: 'read', contents: 'write' }, created_at: '2026-10-17T12:00:00Z',
      });
    }),
    http.post(`${API}/app/installations/${installationId}/access_tokens`, async ({ request }) => {
      if (!await verifiedClaims(bearer(request), key.publicKey)) return HttpResponse.json({ message: 'Bad credentials' }, { status: 401 });
      return HttpResponse.json({ token: `installation-token-${installationId}`, expires_at: '2026-10-17T13:00:00Z' }, { status: 201 });
    }),
    http.get(`${API}/installation/repositories`, ({ request }) => {
      if (bearer(request) !== `installation-token-${installationId}`) return HttpResponse.json({ message: 'Bad credentials' }, { status: 401 });
      return HttpResponse.json({ total_count: repositories.names.length, repositories: repositories.names.map((full_name) => ({ full_name })) });
    }),
  );
}

async function project(name: string, remote: string): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${id}`);
  const created = await authority.bootstrap({ id, name, repositoryReference: remote, baseBranch: 'main', createdBy: 'user' });
  await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).put(await authority.setProjectLifecycle(created.revision, 'active'));
  return { id };
}

async function installState(): Promise<string> {
  const { url } = await github().startInstall();
  expect(url).toMatch(/^https:\/\/github\.com\/apps\/gitspace-test\/installations\/new\?state=[A-Za-z0-9_-]{43}$/u);
  return new URL(url).searchParams.get('state') ?? '';
}

/** Artifacts history: each repository serves only the commits it holds, along their first-parent chain, and the refs
 * set on it. */
function artifactsHistory() {
  const commits = new Map<string, { parents: string[]; committedAt: number; repositories: Set<string> }>();
  const refs = new Map<string, string>();
  const identity = { name: 'Fixture', email: 'fixture@example.invalid' };
  const metadata = (hash: string, entry: { parents: string[]; committedAt: number }): ArtifactsCommitMetadata => ({ hash, treeHash: hash, message: hash, author: identity, committer: identity, parents: entry.parents, authoredAt: entry.committedAt, committedAt: entry.committedAt });
  vi.spyOn(ArtifactsCodeStore.prototype, 'resolveRef').mockImplementation(async (repository, ref) => refs.get(`${repository} ${ref}`) ?? null);
  vi.spyOn(ArtifactsCodeStore.prototype, 'readCommit').mockImplementation(async (repository, hash) => {
    const entry = commits.get(hash);
    return entry?.repositories.has(repository) ? metadata(hash, entry) : null;
  });
  vi.spyOn(ArtifactsCodeStore.prototype, 'log').mockImplementation(async (repository, start, limit = 50) => {
    const page: ArtifactsCommitMetadata[] = [];
    for (let hash: string | undefined = start; hash !== undefined && page.length < limit;) {
      const entry = commits.get(hash);
      if (!entry?.repositories.has(repository)) break;
      page.push(metadata(hash, entry));
      hash = entry.parents[0];
    }
    return page;
  });
  return {
    commit(parents: string[], ...repositories: string[]) {
      const hash = (commits.size + 1).toString(16).padStart(40, '0');
      commits.set(hash, { parents, committedAt: commits.size + 1, repositories: new Set(repositories) });
      return hash;
    },
    ref(repository: string, ref: string, hash: string) { refs.set(`${repository} ${ref}`, hash); },
  };
}

/** A cloud workspace's committed checkout, as its runtime stores it. */
async function seedCheckpoint(workspaceId: string, branch: string, head: string): Promise<void> {
  const checkpoint: RuntimeGitCheckpoint = { checkpointRef: `refs/gitspace/spaces/${workspaceId}/checkpoints`, headCommit: head, branch, indexCommit: head, trackedWorktreeCommit: head, worktreeCommit: head, indexTree: 'e'.repeat(40), worktreeTree: 'e'.repeat(40) };
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`), (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_code_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1), checkpoint TEXT NOT NULL)');
    state.storage.sql.exec('INSERT OR REPLACE INTO runtime_code_snapshot(singleton,checkpoint) VALUES(1,?)', JSON.stringify(checkpoint));
  });
}

describe('GitHub App', () => {
  it('creates the App only through a fresh one-time state and keeps its secrets in the vault', async () => {
    await bootstrapVault();
    const key = await rsaKey('pkcs1');
    const seen = conversionApi(key);
    const created = (state: string) => SELF.fetch(`${env.ACCOUNT_URL}/github/app/created?code=manifest-code&state=${encodeURIComponent(state)}`, { redirect: 'manual' });

    expect(outcome(await created('forged-state')).get('github')).toBe('error');
    const expiring = await github().startApp({ kind: 'user' });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15 * 60_000 + 1);
    await runInDurableObject(github(), async (instance) => {
      await expect(instance.appCreated('manifest-code', new URL(expiring.action).searchParams.get('state') ?? '')).rejects.toThrow('expired or was already used');
    });
    vi.restoreAllMocks();
    expect(seen.conversions).toEqual([]);
    expect((await github().state()).app).toBeNull();

    const form = await github().startApp({ kind: 'organization', login: 'inKibra' });
    expect(form.action).toMatch(/^https:\/\/github\.com\/organizations\/inKibra\/settings\/apps\/new\?state=[A-Za-z0-9_-]{43}$/u);
    expect(JSON.parse(form.manifest)).toMatchObject({
      name: `GitSpace ${env.TENANT_ID}`, public: true,
      hook_attributes: { url: `${env.ACCOUNT_URL}/github/webhook`, active: true },
      redirect_url: `${env.ACCOUNT_URL}/github/app/created`, setup_url: `${env.ACCOUNT_URL}/github/installed`, setup_on_update: true,
      default_permissions: { contents: 'write', workflows: 'write', pull_requests: 'write' },
    });
    const state = new URL(form.action).searchParams.get('state') ?? '';
    expect(outcome(await created(state)).get('github')).toBe('created');
    const reused = outcome(await created(state));
    expect(reused.get('github')).toBe('error');
    expect(reused.get('message')).toContain('expired or was already used');
    expect(seen.conversions).toEqual(['manifest-code']);
    await runInDurableObject(github(), (instance) => {
      expect(() => instance.startApp({ kind: 'user' })).toThrow('already has a GitHub App');
    });

    const view = await github().state();
    expect(view.app).toMatchObject({ id: APP_ID, slug: 'gitspace-test', name: 'GitSpace test', owner: { login: 'octo', kind: 'user' } });
    const visible = JSON.stringify(view);
    for (const secret of [WEBHOOK_SECRET, CLIENT_SECRET, key.pem.split('\n')[1] ?? '']) expect(visible).not.toContain(secret);
    // The PKCS#1 key GitHub issued signs the App JWT inside the vault.
    const claims = await verifiedClaims(await vault().githubAppJwt(), key.publicKey);
    expect(claims?.iss).toBe(APP_ID);
    expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBe(600);
    expect(claims?.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 60);
  });

  it('rejects deliveries without a valid signature and records none', async () => {
    const body = JSON.stringify({ zen: 'Design for failure.', hook_id: 1 });
    await bootstrapVault();
    // Before an App exists nothing can verify a delivery.
    expect((await deliver('ping', 'delivery-before-app', body, await signature(body))).status).toBe(401);
    await createApp(await rsaKey('pkcs1'));
    expect((await deliver('ping', 'delivery-unsigned', body, null)).status).toBe(400);
    expect((await deliver('ping', 'delivery-wrong-secret', body, await signature(body, 'another-secret'))).status).toBe(401);
    expect((await deliver('ping', 'delivery-tampered', `${body} `, await signature(body))).status).toBe(401);
    expect((await deliver('ping', 'delivery-garbled', body, 'sha256=not-hex')).status).toBe(401);
    expect((await github().state()).deliveries).toEqual([]);
  });

  it('records a delivery once by its id', async () => {
    await createApp(await rsaKey('pkcs1'));
    const body = JSON.stringify({ action: 'opened', installation: { id: 77 }, repository: { full_name: 'octo/hello' } });
    const signed = await signature(body);
    expect((await deliver('pull_request', 'delivery-1', body, signed)).status).toBe(202);
    expect((await deliver('pull_request', 'delivery-1', body, signed)).status).toBe(202);
    expect((await github().state()).deliveries).toEqual([{
      id: 'delivery-1', event: 'pull_request', action: 'opened', installationId: 77, repository: 'octo/hello',
      receivedAt: expect.any(String), outcome: 'dropped: unknown installation',
    }]);
  });

  it('claims an installation started from GitSpace and links projects using its repositories, with notices', async () => {
    const key = await rsaKey('pkcs1');
    await createApp(key);
    const notices = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeProjectNotice').mockResolvedValue(undefined);
    const pantry = await project('Pantry', 'git@github.com:inKibra/Pantry.git');
    await project('Elsewhere', 'https://github.com/someone/else.git');
    const repositories = { names: ['inKibra/pantry', 'inKibra/tools'] };
    installationApi(key, 91, 'inKibra', repositories);

    // A setup callback without GitSpace's state claims nothing.
    const stray = outcome(await setupCallback(91, 'install', null));
    expect(stray.get('github')).toBe('error');
    expect((await github().state()).installations).toEqual([]);

    const state = await installState();
    expect(outcome(await setupCallback(91, 'install', state)).get('github')).toBe('installed');
    expect((await github().state()).installations).toEqual([{
      id: 91, account: { login: 'inKibra', kind: 'organization' }, repositorySelection: 'selected',
      repositories: ['inKibra/pantry', 'inKibra/tools'], permissions: { metadata: 'read', contents: 'write' },
      installedAt: '2026-10-17T12:00:00.000Z', projects: [{ id: pantry.id, name: 'Pantry', repository: 'inKibra/pantry' }],
    }]);
    await vi.waitFor(() => expect(notices).toHaveBeenCalledWith({ projectId: pantry.id, workspaceId: pantry.id }, 'Linked to GitHub: GitSpace test on inKibra covers inKibra/pantry.'));
    expect(notices).toHaveBeenCalledTimes(1);
    // The state was spent by that install.
    expect(outcome(await setupCallback(92, 'install', state)).get('github')).toBe('error');

    // GitHub reports the selection changed; the project unlinks.
    repositories.names = ['inKibra/tools'];
    const body = JSON.stringify({ action: 'removed', installation: { id: 91 }, repositories_removed: [{ full_name: 'inKibra/pantry' }] });
    expect((await deliver('installation_repositories', 'selection-changed', body, await signature(body))).status).toBe(202);
    const after = await github().state();
    expect(after.installations[0]).toMatchObject({ repositories: ['inKibra/tools'], projects: [] });
    expect(after.deliveries[0]).toMatchObject({ id: 'selection-changed', outcome: 'repositories refreshed' });
    await vi.waitFor(() => expect(notices).toHaveBeenCalledWith({ projectId: pantry.id, workspaceId: pantry.id }, 'Unlinked from GitHub: inKibra no longer covers inKibra/pantry.'));
  });

  it('uninstalls an installation GitSpace did not start once its grace period ends, and keeps claimed ones', async () => {
    const key = await rsaKey('pkcs1');
    await createApp(key);
    installationApi(key, 92, 'inKibra', { names: [] });
    const uninstalled: string[] = [];
    network.use(http.delete(`${API}/app/installations/:id`, async ({ params, request }) => {
      if (!await verifiedClaims(bearer(request), key.publicKey)) return HttpResponse.json({ message: 'Bad credentials' }, { status: 401 });
      uninstalled.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }));
    const installationCreated = async (installationId: number, deliveryId: string) => {
      const body = JSON.stringify({ action: 'created', installation: { id: installationId } });
      expect((await deliver('installation', deliveryId, body, await signature(body))).status).toBe(202);
    };
    await installationCreated(91, 'stranger-installed');
    // GitHub may deliver the webhook before the browser reaches the setup callback; the claim still wins.
    await installationCreated(92, 'ours-installed');
    expect(outcome(await setupCallback(92, 'install', await installState())).get('github')).toBe('installed');

    expect(await runDurableObjectAlarm(github())).toBe(true);
    expect(uninstalled).toEqual([]);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000 + 1);
    expect(await runDurableObjectAlarm(github())).toBe(true);
    expect(uninstalled).toEqual(['91']);
    expect(await runDurableObjectAlarm(github())).toBe(false);
    const view = await github().state();
    expect(view.installations.map((installation) => installation.id)).toEqual([92]);
    expect(view.deliveries.find((delivery) => delivery.id === 'stranger-installed')?.outcome).toContain('not started from GitSpace');
  });

  it('replaces the private key only after GitHub accepts the new one for this App', async () => {
    const original = await rsaKey('pkcs1');
    await createApp(original);
    const rejected = await rsaKey('pkcs8');
    const accepted = await rsaKey('pkcs8');
    network.use(http.get(`${API}/app`, async ({ request }) => {
      if (await verifiedClaims(bearer(request), accepted.publicKey)) return HttpResponse.json({ id: APP_ID, slug: 'gitspace-test' });
      return HttpResponse.json({ message: 'A JSON web token could not be decoded' }, { status: 401 });
    }));

    await runInDurableObject(github(), async (instance) => {
      await expect(instance.rotateKey(rejected.pem)).rejects.toThrow('GitHub did not accept this private key');
      await expect(instance.rotateKey('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----')).rejects.toThrow('not an RSA key');
    });
    expect(await verifiedClaims(await vault().githubAppJwt(), original.publicKey)).toMatchObject({ iss: APP_ID });

    await github().rotateKey(accepted.pem);
    const jwt = await vault().githubAppJwt();
    expect(await verifiedClaims(jwt, accepted.publicKey)).toMatchObject({ iss: APP_ID });
    expect(await verifiedClaims(jwt, original.publicKey)).toBeNull();
    // The webhook secret survives the key change.
    const body = JSON.stringify({ zen: 'Keep it logically awesome.' });
    expect((await deliver('ping', 'after-rotation', body, await signature(body))).status).toBe(202);
  });

  it('moves a pushed branch in every project using the repository, behind only where GitSpace lacks the head', async () => {
    const key = await rsaKey('pkcs1');
    await createApp(key);
    vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeProjectNotice').mockResolvedValue(undefined);
    const stale = await project('Pantry', 'git@github.com:inKibra/Pantry.git');
    const current = await project('Pantry mirror', 'https://github.com/inkibra/pantry');
    const other = await project('Elsewhere', 'https://github.com/someone/else.git');
    installationApi(key, 91, 'inKibra', { names: ['inKibra/pantry'] });
    expect(outcome(await setupCallback(91, 'install', await installState())).get('github')).toBe('installed');
    const authority = (id: string) => env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${id}`);
    const workspaceId = `space-${crypto.randomUUID()}`;
    await authority(stale.id).putWorkspace({ id: workspaceId, projectId: stale.id, kind: 'worktree', name: 'Feature', branch: 'feature', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    const history = artifactsHistory();
    const root = history.commit([], `project-${stale.id}`, `project-${current.id}`);
    const pushed = history.commit([root], `project-${current.id}`);
    const ahead = history.commit([pushed], `project-${current.id}`);
    history.ref(`project-${stale.id}`, 'refs/heads/main', root);
    history.ref(`project-${current.id}`, 'refs/heads/main', ahead);
    const feature = history.commit([root], `workspace-${workspaceId}`);
    await seedCheckpoint(workspaceId, 'feature', feature);
    const push = async (deliveryId: string, change: { ref: string; after: string; deleted: boolean }) => {
      const body = JSON.stringify({ installation: { id: 91 }, repository: { full_name: 'inKibra/pantry' }, ...change });
      expect((await deliver('push', deliveryId, body, await signature(body))).status).toBe(202);
      return (await github().state()).deliveries.find((delivery) => delivery.id === deliveryId)?.outcome;
    };

    expect(await push('push-main', { ref: 'refs/heads/main', after: pushed, deleted: false })).toBe(`main → ${pushed.slice(0, 7)} for 2 projects`);
    // The origin is ahead of one project's copy; the other's copy already contains the pushed head.
    expect((await authority(stale.id).getProject())?.remote).toMatchObject({ head: pushed, behind: true });
    expect((await authority(current.id).getProject())?.remote).toMatchObject({ head: pushed, behind: false });
    expect((await authority(other.id).getProject())?.remote).toBeNull();
    const listed = await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).list();
    expect(listed.find((entry) => entry.id === stale.id)?.remote).toMatchObject({ head: pushed, behind: true });
    expect(listed.find((entry) => entry.id === current.id)?.remote).toMatchObject({ head: pushed, behind: false });

    // GitHub redelivering the same delivery changes nothing, not even when the origin was checked.
    const recorded = (await authority(stale.id).getProject())?.remote;
    await push('push-main', { ref: 'refs/heads/main', after: pushed, deleted: false });
    expect((await authority(stale.id).getProject())?.remote).toEqual(recorded);

    // The workspace on the pushed branch compares its own checkout.
    expect(await push('push-feature', { ref: 'refs/heads/feature', after: feature, deleted: false })).toBe(`feature → ${feature.slice(0, 7)} for 2 projects`);
    expect((await authority(stale.id).getWorkspace(workspaceId))?.remote).toMatchObject({ head: feature, behind: false });
    const elsewhere = history.commit([feature]);
    await push('push-feature-again', { ref: 'refs/heads/feature', after: elsewhere, deleted: false });
    expect((await authority(stale.id).getWorkspace(workspaceId))?.remote).toMatchObject({ head: elsewhere, behind: true });
    expect(await push('delete-feature', { ref: 'refs/heads/feature', after: '0'.repeat(40), deleted: true })).toBe('feature → deleted for 2 projects');
    expect((await authority(stale.id).getWorkspace(workspaceId))?.remote).toMatchObject({ head: null, behind: false });
    expect((await authority(stale.id).getProject())?.remote).toEqual(recorded);

    expect(await push('push-tag', { ref: 'refs/tags/v1', after: pushed, deleted: false })).toBe('recorded');
    expect((await authority(current.id).getProject())?.remote?.head).toBe(pushed);
  });

  it('checks a covered origin only with an installation token, recording tracked branches it lacks as absent', async () => {
    const key = await rsaKey('pkcs1');
    await createApp(key);
    vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeProjectNotice').mockResolvedValue(undefined);
    const pantry = await project('Pantry', 'git@github.com:inKibra/Pantry.git');
    installationApi(key, 91, 'inKibra', { names: ['inKibra/pantry'] });
    expect(outcome(await setupCallback(91, 'install', await installState())).get('github')).toBe('installed');
    const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${pantry.id}`);
    const gone = `space-${crypto.randomUUID()}`;
    await authority.putWorkspace({ id: gone, projectId: pantry.id, kind: 'worktree', name: 'Gone', branch: 'gone', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    artifactsHistory();
    const main = 'c'.repeat(40);
    const packet = (line: string) => (line.length + 4).toString(16).padStart(4, '0') + line;
    const authorizations: Array<string | null> = [];
    network.use(http.get('https://github.com/inKibra/Pantry.git/info/refs', ({ request }) => {
      authorizations.push(request.headers.get('authorization'));
      return new HttpResponse(packet('# service=git-upload-pack\n') + '0000' + packet(`${main} refs/heads/main\n`) + packet(`${'d'.repeat(40)} refs/heads/unrelated\n`) + '0000');
    }));

    await refreshProjectRemote(env, env.ACCOUNT_ID, pantry.id);
    expect(authorizations).toEqual([`Basic ${btoa('x-access-token:installation-token-91')}`]);
    expect((await authority.getProject())?.remote).toMatchObject({ head: main, behind: true });
    expect((await authority.getWorkspace(gone))?.remote).toMatchObject({ head: null, behind: false });

    // A project without a remote has no origin to read.
    const localId = crypto.randomUUID();
    const local = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${localId}`);
    await local.bootstrap({ id: localId, name: 'Local', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
    await refreshProjectRemote(env, env.ACCOUNT_ID, localId);
    expect((await local.getProject())?.remote).toBeNull();
    expect(authorizations).toHaveLength(1);
  });
});
