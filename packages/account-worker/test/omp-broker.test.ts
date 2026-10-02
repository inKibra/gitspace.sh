import { describe, expect, it } from 'vitest';
import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { network } from './network.js';
import { profileBrokerToken } from '../src/account-access.js';
import type { CredentialRefreshResponse, CredentialUploadResponse, SnapshotResponse } from '@oh-my-pi/pi-ai/auth-broker';

async function seedVault(credentials: Array<{ id: string; provider: 'anthropic' | 'openai-codex'; access: string; accountId?: string; email?: string; expires?: number }>): Promise<string> {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.get(env.CREDENTIALS.idFromName(userId));
  expect((await vault.bootstrap({
    userId,
    rootPublicKey: env.AUTH_PUBLIC_KEY,
    vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(2)),
  })).status).toBe('ok');
  await vault.registerManagedDevice({ userId, machineId: 'broker-machine', signingPublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(3)), exchangePublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(4)), capabilities: ['credential.access'] });
  for (const { id, expires = Date.now() + 60 * 60_000, ...credential } of credentials) {
    expect((await vault.putCredential({
      id,
      credential: { ...credential, refresh: `${id}-refresh`, expires },
    })).status).toBe('ok');
  }
  await vault.ensureInference();
  return userId;
}

async function writer(userId: string, profileId = 'default') {
  const vault = env.CREDENTIALS.getByName(userId);
  const machineId = profileId === 'default' ? 'writer' : `writer-${profileId}`;
  const registered = await vault.registerManagedDevice({
    userId, machineId,
    signingPublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(5)),
    exchangePublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(6)),
    capabilities: ['credential.access', 'credential.manage'],
  });
  if (registered.status !== 'ok') throw new Error('Writer enrollment failed');
  await vault.ensureInference();
  const token = await profileBrokerToken('test-omp-broker-token', userId, { profileId, machineId, generation: registered.value.generation, capability: 'manage' });
  return (operation: string, body?: unknown, headers: Record<string, string> = {}) => SELF.fetch(`https://auth.test/omp/users/${userId}/profiles/${profileId}/v1/${operation}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}


describe('OMP native auth broker adapter', () => {
  it('feeds broker-only credentials into OMP AuthStorage', async () => {
    const userId = env.ACCOUNT_ID;
    const vault = env.CREDENTIALS.get(env.CREDENTIALS.idFromName(userId));
    expect((await vault.bootstrap({
      userId,
      rootPublicKey: env.AUTH_PUBLIC_KEY,
      vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(2)),
    })).status).toBe('ok');
    await vault.registerManagedDevice({ userId, machineId: 'broker-machine', signingPublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(3)), exchangePublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(4)), capabilities: ['credential.access'] });
    expect((await vault.putCredential({
      id: 'openai-primary',
      credential: {
        provider: 'openai-codex',
        access: 'broker-only-access-token',
        refresh: 'broker-only-refresh-token',
        expires: Date.now() + 60 * 60_000,
        accountId: 'account-a',
      },
    })).status).toBe('ok');
    await vault.ensureInference();
    const token = await profileBrokerToken('test-omp-broker-token', userId, { profileId: 'default', machineId: 'broker-machine', generation: 1, capability: 'inference' });
    const health = await SELF.fetch(`https://auth.test/omp/users/${userId}/profiles/default/v1/healthz`, { headers: { authorization: `Bearer ${token}` } });
    expect(await health.json()).toMatchObject({ ok: true });
    const response = await SELF.fetch(`https://auth.test/omp/users/${userId}/profiles/default/v1/snapshot`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const snapshot = await response.json() as {
      credentials: Array<{ provider: string; identityKey: string | null; credential: { type: string; access: string; refresh: string } }>;
    };
    expect(snapshot.credentials).toHaveLength(1);
    expect(snapshot.credentials[0]).toMatchObject({
      provider: 'openai-codex',
      identityKey: 'account:account-a',
      credential: {
        type: 'oauth',
        access: 'broker-only-access-token',
        refresh: '__remote__',
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('broker-only-refresh-token');
  });

  it('requires explicit credential management authority without elevating read-only bearers', async () => {
    const userId = await seedVault([{ id: 'existing', provider: 'openai-codex', access: 'existing-access' }]);
    const vault = env.CREDENTIALS.getByName(userId);
    const request = await writer(userId);
    const readToken = await profileBrokerToken('test-omp-broker-token', userId, { profileId: 'default', machineId: 'broker-machine', generation: 1, capability: 'inference' });
    const upload = { provider: 'anthropic', credential: { type: 'api_key', key: 'api-secret' } };
    expect((await request('credential', upload, { authorization: `Bearer ${readToken}` })).status).toBe(403);
    expect((await request('credential/1/disable', { cause: 'deleted' }, { authorization: `Bearer ${readToken}` })).status).toBe(403);
    expect((await request('snapshot', undefined, { authorization: `Bearer ${readToken}` })).status).toBe(200);
    expect((await request('credential', upload)).status).toBe(200);
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'suspended' } })));
    expect((await request('credential', upload)).status).toBe(403);
    expect((await request('credential/1/disable', { cause: 'deleted' })).status).toBe(403);
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' } })));
    await vault.registerManagedDevice({
      userId, machineId: 'writer',
      signingPublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)),
      exchangePublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(8)),
      capabilities: ['credential.access', 'credential.manage'],
    });
    expect((await request('credential', upload)).status).toBe(401);
    expect((await request('credential/1/disable', { cause: 'deleted' })).status).toBe(401);
  });

  it('stores API keys canonically without OAuth refresh and invalidates snapshots after the last removal', async () => {
    const userId = await seedVault([]);
    const request = await writer(userId);
    const before = await request('snapshot');
    const initial = await before.json() as SnapshotResponse;
    const upload = { provider: 'anthropic', credential: { type: 'api_key', key: 'canonical-api-secret' } };
    const response = await request('credential', upload);
    expect(response.status).toBe(200);
    const uploaded = await response.json() as CredentialUploadResponse;
    const id = uploaded.entries[0]!.id;
    expect(uploaded.entries).toEqual([{ id, provider: 'anthropic', identityKey: null, credential: upload.credential }]);
    const snapshot = await request('snapshot', undefined, { 'if-none-match': before.headers.get('etag')! });
    expect(snapshot.status).toBe(200);
    const stored = await snapshot.json() as SnapshotResponse;
    expect(stored.generation).toBeGreaterThan(initial.generation);
    expect(stored.credentials).toEqual([{ ...uploaded.entries[0], rotatesInMs: null }]);
    const vault = env.CREDENTIALS.getByName(userId);
    const encrypted = await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec<{ sealed_json: string }>('SELECT sealed_json FROM inference_credentials').toArray());
    expect(JSON.stringify(encrypted)).not.toContain(upload.credential.key);
    let providerRequests = 0;
    network.use(http.all('https://api.anthropic.com/*', () => { providerRequests += 1; return new HttpResponse(null, { status: 500 }); }));
    expect(await (await request(`credential/${id}/refresh`, {})).json()).toEqual({ entry: uploaded.entries[0] });
    expect(providerRequests).toBe(0);
    expect((await request(`credential/${id}/disable`, { cause: 'deleted by user' })).status).toBe(200);
    const removed = await request('snapshot', undefined, { 'if-none-match': snapshot.headers.get('etag')! });
    expect(removed.status).toBe(200);
    const empty = await removed.json() as SnapshotResponse;
    expect(empty.credentials).toEqual([]);
    expect(empty.generation).toBeGreaterThan(stored.generation);
    const replacement = await (await request('credential', upload)).json() as CredentialUploadResponse;
    expect(replacement.entries[0]!.id).not.toBe(id);
    expect((await request(`credential/${id}/disable`, { cause: 'delayed logout' })).status).toBe(404);
    expect((await (await request('snapshot')).json() as SnapshotResponse).credentials[0]!.id).toBe(replacement.entries[0]!.id);
  });

  it('upserts OAuth identities separately by organization and retains rotating refresh tokens only in the vault', async () => {
    const userId = await seedVault([]);
    const request = await writer(userId);
    const credential = { type: 'oauth', access: 'access-original', refresh: 'refresh-original', expires: Date.now() + 3_600_000, email: 'person@example.com', orgId: 'org-a', orgName: 'Organization A' };
    const first = await (await request('credential', { provider: 'openai-codex', credential })).json() as CredentialUploadResponse;
    const id = first.entries[0]!.id;
    const second = await (await request('credential', { provider: 'openai-codex', credential: { ...credential, orgId: 'org-b' } })).json() as CredentialUploadResponse;
    expect(second.entries.map((entry) => entry.identityKey)).toEqual(['email:person@example.com|org:org-a', 'email:person@example.com|org:org-b']);
    const updated = await (await request('credential', { provider: 'openai-codex', credential: { ...credential, access: 'access-updated' } })).json() as CredentialUploadResponse;
    expect(updated.entries.map((entry) => entry.id)).toEqual(second.entries.map((entry) => entry.id));
    expect(updated.entries.find((entry) => entry.id === id)?.credential).toMatchObject({ access: 'access-updated', refresh: '__remote__', orgName: 'Organization A' });
    const invalid = await request('credential', { provider: 'openai-codex', credential: { ...credential, refresh: '__remote__' } });
    expect(invalid.status).toBe(400);
    const seenRefresh: string[] = [];
    network.use(http.post('https://auth.openai.com/oauth/token', async ({ request: upstream }) => {
      const body = new URLSearchParams(await upstream.text());
      seenRefresh.push(body.get('refresh_token')!);
      return HttpResponse.json({ access_token: 'access-rotated', refresh_token: 'refresh-rotated', expires_in: 3600 });
    }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refreshed = await request(`credential/${id}/refresh`, {});
      expect(refreshed.status).toBe(200);
      const result = await refreshed.json() as CredentialRefreshResponse;
      expect(result.entry.credential).toMatchObject({ access: 'access-rotated', refresh: '__remote__', orgName: 'Organization A' });
      expect(JSON.stringify(result)).not.toContain('refresh-original');
      expect(JSON.stringify(result)).not.toContain('refresh-rotated');
    }
    expect(seenRefresh).toEqual(['refresh-original', 'refresh-rotated']);
    const snapshot = await (await request('snapshot')).text();
    expect(snapshot).not.toContain('refresh-original');
    expect(snapshot).not.toContain('refresh-rotated');
  });

  it('does not resurrect a credential disabled while its rotating refresh is in flight', async () => {
    const userId = await seedVault([{ id: 'racing', provider: 'openai-codex', access: 'access-before' }]);
    const request = await writer(userId);
    const snapshot = await (await request('snapshot')).json() as SnapshotResponse;
    const id = snapshot.credentials[0]!.id;
    network.use(http.post('https://auth.openai.com/oauth/token', async () => {
      // Mutate while the upstream refresh is pending, without transferring a
      // deferred promise between the test request and MSW's fetch context.
      const disabled = await request(`credential/${id}/disable`, { cause: 'deleted by user' });
      expect(disabled.status).toBe(200);
      await disabled.text();
      return HttpResponse.json({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600 });
    }));
    const refreshed = await request(`credential/${id}/refresh`, {});
    expect(refreshed.ok).toBe(false);
    await refreshed.text();
    expect((await (await request('snapshot')).json() as SnapshotResponse).credentials).toEqual([]);
  });

  it('isolates same-provider keys, numeric IDs and cache generations, and rejects legacy or mismatched bearers', async () => {
    const userId = await seedVault([]);
    const vault = env.CREDENTIALS.getByName(userId);
    const state = await vault.createInferenceProfile({ name: 'Client', sourceProfileId: null });
    const profileId = state.profiles.find(profile => profile.id !== 'default')!.id;
    const defaultRequest = await writer(userId);
    const clientRequest = await writer(userId, profileId);
    const a = await (await defaultRequest('credential', { provider: 'openai', credential: { type: 'api_key', key: 'default-only' } })).json() as CredentialUploadResponse;
    const b = await (await clientRequest('credential', { provider: 'openai', credential: { type: 'api_key', key: 'client-only' } })).json() as CredentialUploadResponse;
    const before = await clientRequest('snapshot');
    const clientSnapshot = await before.json() as SnapshotResponse;
    expect(clientSnapshot.credentials.map(entry => entry.credential)).toEqual([{ type: 'api_key', key: 'client-only' }]);
    expect((await defaultRequest(`credential/${b.entries[0]!.id}/refresh`, {})).ok).toBe(false);
    expect((await defaultRequest(`credential/${b.entries[0]!.id}/disable`, {})).status).toBe(404);
    await vault.disableBrowserCredentials('default', 'openai', String(b.entries[0]!.id));
    expect((await clientRequest('snapshot', undefined, { 'if-none-match': before.headers.get('etag')! })).status).toBe(304);
    const payload = `gsb2.${btoa('writer').replace(/=+$/u, '')}.1`;
    const signingKey = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-omp-broker-token'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(`${userId}\n${payload}`)));
    const old = `${payload}.${btoa(String.fromCharCode(...signature)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
    const wrong = await profileBrokerToken('test-omp-broker-token', userId, { profileId: 'default', machineId: 'writer', generation: 1, capability: 'manage' });
    expect((await clientRequest('snapshot', undefined, { authorization: `Bearer ${old}` })).status).toBe(401);
    expect((await clientRequest('snapshot', undefined, { authorization: `Bearer ${wrong}` })).status).toBe(401);
    const legacy = await SELF.fetch(`https://auth.test/omp/users/${userId}/v1/snapshot`, { headers: { authorization: `Bearer ${old}` } });
    expect(legacy.status).toBe(401);
    expect(await legacy.text()).not.toContain('client-only');
    expect((await (await defaultRequest('snapshot')).json() as SnapshotResponse).credentials[0]!.id).toBe(a.entries[0]!.id);
    await vault.deleteInferenceProfile({ profileId, expectedRevision: 0 });
    expect((await clientRequest('snapshot')).status).toBe(401);
    expect((await clientRequest(`credential/${b.entries[0]!.id}/refresh`, {})).status).toBe(401);
  });

  it('limits OAuth identity upsert, auth-mode transition, refresh and logout to the selected profile', async () => {
    const userId = await seedVault([]);
    const vault = env.CREDENTIALS.getByName(userId);
    const profileId = (await vault.createInferenceProfile({ name: 'OAuth client', sourceProfileId: null })).profiles.find(profile => profile.id !== 'default')!.id;
    const a = await writer(userId);
    const b = await writer(userId, profileId);
    const oauth = { type: 'oauth', access: 'a-access', refresh: 'a-refresh', expires: Date.now() + 3_600_000, accountId: 'shared-upstream' };
    await a('credential', { provider: 'openai-codex', credential: { type: 'api_key', key: 'a-static' } });
    const uploaded = await (await b('credential', { provider: 'openai-codex', credential: { ...oauth, access: 'b-access', refresh: 'b-refresh' } })).json() as CredentialUploadResponse;
    expect((await (await a('snapshot')).json() as SnapshotResponse).credentials[0]!.credential).toEqual({ type: 'api_key', key: 'a-static' });
    await a('credential', { provider: 'openai-codex', credential: oauth });
    const updated = await (await b('credential', { provider: 'openai-codex', credential: { ...oauth, access: 'b-updated', refresh: 'b-updated-refresh' } })).json() as CredentialUploadResponse;
    expect(updated.entries[0]!.id).toBe(uploaded.entries[0]!.id);
    const seen: string[] = [];
    network.use(http.post('https://auth.openai.com/oauth/token', async ({ request }) => {
      seen.push(new URLSearchParams(await request.text()).get('refresh_token')!);
      return HttpResponse.json({ access_token: 'b-rotated', refresh_token: 'b-rotated-refresh', expires_in: 3600 });
    }));
    expect((await b(`credential/${uploaded.entries[0]!.id}/refresh`, {})).status).toBe(200);
    expect(seen).toEqual(['b-updated-refresh']);
    await vault.disableBrowserCredentials(profileId, 'openai-codex', null);
    expect((await (await b('snapshot')).json() as SnapshotResponse).credentials).toEqual([]);
    expect((await (await a('snapshot')).json() as SnapshotResponse).credentials[0]!.credential).toMatchObject({ access: 'a-access', refresh: '__remote__' });
  });

  it('retries Default migration without rewriting encrypted identities or leases and duplicates configuration only', async () => {
    const userId = env.ACCOUNT_ID;
    const vault = env.CREDENTIALS.getByName(userId);
    await vault.bootstrap({ userId, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(2)) });
    await vault.putCredential({ id: 'preserved-oauth', credential: { provider: 'openai-codex', access: 'preserved-access', refresh: 'preserved-refresh', accountId: 'existing-account', expires: Date.now() + 3_600_000 } });
    const settings = env.USER_SETTINGS.getByName(userId);
    const content = JSON.stringify({ modelRoles: { default: 'openai/gpt-4.1', custom: 'anthropic/claude' }, agents: { custom: { modelRole: 'custom' } }, terminal: { theme: 'dark' } });
    const checksum = `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
    await settings.updateOmp('legacy', { expectedGeneration: 0, content, checksum });
    const before = await runInDurableObject(vault, (_instance, state) => {
      state.storage.sql.exec('INSERT INTO refresh_leases(credential_id, owner, revision, expires_at) VALUES (?, ?, 1, ?)', 'preserved-oauth', 'existing-refresh', Date.now() + 60_000);
      return {
        credentials: state.storage.sql.exec('SELECT rowid, id, sealed_json, revision FROM oauth_credentials').toArray(),
        leases: state.storage.sql.exec('SELECT * FROM refresh_leases').toArray(),
      };
    });
    // Interrupted between authorities: settings preparation has committed, vault has not.
    await settings.prepareInferenceMigration();
    const first = await vault.ensureInference();
    const second = await vault.ensureInference();
    expect(second).toEqual(first);
    expect(first.profiles[0]!.settings).toMatchObject({ modelRoles: { default: 'openai/gpt-4.1', custom: 'anthropic/claude' }, agents: { custom: { modelRole: 'custom' } } });
    expect((await settings.getOmp()).content).toContain('terminal');
    expect((await settings.getOmp()).content).not.toContain('modelRoles');
    const after = await runInDurableObject(vault, (_instance, state) => ({
      credentials: state.storage.sql.exec('SELECT rowid, id, sealed_json, revision FROM inference_credentials').toArray(),
      leases: state.storage.sql.exec('SELECT * FROM refresh_leases').toArray(),
    }));
    expect(after).toEqual(before);
    expect((await vault.ompSnapshot('default')).credentials[0]!.credential).toMatchObject({ access: 'preserved-access', refresh: '__remote__' });
    const duplicate = (await vault.createInferenceProfile({ name: 'Independent', sourceProfileId: 'default' })).profiles.find(profile => profile.id !== 'default')!;
    expect(duplicate.settings).toEqual(first.profiles[0]!.settings);
    expect((await vault.ompSnapshot(duplicate.id)).credentials).toEqual([]);
    await vault.updateInferenceProfile({ profileId: duplicate.id, expectedRevision: 0, name: duplicate.name, settings: {} });
    expect((await vault.ensureInference()).profiles.find(profile => profile.id === 'default')!.settings).toEqual(first.profiles[0]!.settings);
  });

  it('serializes profile CAS and assignment/delete races without assigning a tombstone', async () => {
    const userId = await seedVault([]);
    const vault = env.CREDENTIALS.getByName(userId);
    const profileId = (await vault.createInferenceProfile({ name: 'Race', sourceProfileId: null })).profiles.find(profile => profile.id !== 'default')!.id;
    const edits = await Promise.all([
      vault.updateInferenceProfile({ profileId, expectedRevision: 0, name: 'One', settings: {} }),
      vault.updateInferenceProfile({ profileId, expectedRevision: 0, name: 'Two', settings: {} }),
    ]);
    expect(edits.map(result => result.status).sort()).toEqual(['conflict', 'ok']);
    expect(edits.find(result => result.status === 'conflict')).toMatchObject({ expected: 0, actual: 1 });
    const projectId = 'assignment-race';
    const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
    const project = await authority.bootstrap({ id: projectId, name: 'Race', repositoryReference: null, baseBranch: 'main', createdBy: 'test' });
    await env.USER_PROJECTS.getByName(userId).put(project);
    const race = await Promise.allSettled([
      vault.assignInferenceProfile({ projectId, profileId, expectedRevision: 0 }),
      vault.deleteInferenceProfile({ profileId, expectedRevision: 1 }),
    ]);
    expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const state = await vault.ensureInference();
    const assigned = state.assignments.find(assignment => assignment.projectId === projectId)!;
    expect(state.profiles.some(profile => profile.id === assigned.profileId)).toBe(true);
    expect(await vault.assignInferenceProfile({ projectId: 'foreign-project', profileId: 'default', expectedRevision: 0 }).then(() => 'allowed', () => 'denied')).toBe('denied');
  });

  it('leaves legacy credential ciphertext and leases untouched until the Worker deployment is committed', async () => {
    const userId = env.ACCOUNT_ID;
    const vault = env.CREDENTIALS.getByName(userId);
    await vault.bootstrap({ userId, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(2)) });
    await vault.putCredential({ id: 'legacy', credential: { provider: 'openai-codex', access: 'legacy-access', refresh: 'legacy-refresh', expires: Date.now() + 3_600_000 } });
    const before = await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec('SELECT rowid, * FROM oauth_credentials').toArray());
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: 'previous-worker' } })));
    await expect(vault.ensureInference()).rejects.toThrow();
    expect(await vault.inferenceCutover()).toBe(false);
    const uncommitted = await runInDurableObject(vault, (_instance, state) => ({
      rows: state.storage.sql.exec('SELECT rowid, * FROM oauth_credentials').toArray(),
      scoped: state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'inference_credentials'").toArray(),
    }));
    expect(uncommitted.rows).toEqual(before);
    expect(uncommitted.scoped).toEqual([]);
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: 'test-inference-worker' } })));
    await vault.ensureInference();
    const oldReader = await runInDurableObject(vault, (_instance, state) => {
      // A rolled-back binary recreates its old table. Its unfiltered query is empty.
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS oauth_credentials (id TEXT PRIMARY KEY, provider TEXT, sealed_json TEXT, revision INTEGER, expires_at INTEGER, state TEXT, updated_at TEXT)');
      return state.storage.sql.exec("SELECT * FROM oauth_credentials WHERE state = 'active'").toArray();
    });
    expect(oldReader).toEqual([]);
    expect((await vault.ompSnapshot('default')).credentials[0]!.credential).toMatchObject({ access: 'legacy-access' });
    await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec("INSERT INTO oauth_credentials(id, provider, sealed_json, revision, expires_at, state, updated_at) VALUES ('old-write', 'openai', 'untrusted-legacy-ciphertext', 1, 0, 'active', '')").toArray());
    await expect(vault.ensureInference()).rejects.toThrow();
    await expect(vault.ompSnapshot('default')).rejects.toThrow();
  });

  it('withholds in-flight refresh disclosure after enrollment revocation without losing the rotated grant', async () => {
    const userId = await seedVault([{ id: 'revoked-in-flight', provider: 'openai-codex', access: 'before-revocation' }]);
    const vault = env.CREDENTIALS.getByName(userId);
    const request = await writer(userId);
    const id = ((await (await request('snapshot')).json()) as SnapshotResponse).credentials[0]!.id;
    // The DO's outbound fetch cannot call back into its own stub, and promises cannot settle across request
    // contexts; each side polls plain flags while the test revokes the parked refresh.
    let started = false;
    let released = false;
    network.use(http.post('https://auth.openai.com/oauth/token', async () => {
      started = true;
      while (!released) await scheduler.wait(5);
      return HttpResponse.json({ access_token: 'rotated-after-revocation', refresh_token: 'rotated-grant', expires_in: 3600 });
    }));
    const refreshing = request(`credential/${id}/refresh`, {});
    while (!started) await scheduler.wait(5);
    await vault.removeManagedDevice('writer');
    released = true;
    const refreshed = await refreshing;
    expect(refreshed.ok).toBe(false);
    expect(await refreshed.text()).not.toContain('rotated-after-revocation');
    const replacement = await writer(userId);
    expect(((await (await replacement('snapshot')).json()) as SnapshotResponse).credentials[0]!.credential).toMatchObject({ access: 'rotated-after-revocation', refresh: '__remote__' });
  });
});
