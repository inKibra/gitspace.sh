import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { network } from './network.js';
import { parse as parseYaml } from 'yaml';

async function seedVault(credentials: Array<{ id: string; provider: 'anthropic' | 'openai-codex'; access: string; accountId?: string; email?: string; expires?: number }>): Promise<string> {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.get(env.CREDENTIALS.idFromName(userId));
  expect((await vault.bootstrap({
    userId,
    rootPublicKey: env.AUTH_PUBLIC_KEY,
    vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(2)),
  })).status).toBe('ok');
  for (const { id, expires = Date.now() + 60 * 60_000, ...credential } of credentials) {
    expect((await vault.putCredential({
      id,
      credential: { ...credential, refresh: `${id}-refresh`, expires },
    })).status).toBe('ok');
  }
  await vault.ensureInference();
  return userId;
}

describe('Cloud inference credential authority', () => {
  it('lists independently selectable accounts without exposing grant secrets', async () => {
    const userId = await seedVault([
      { id: 'first', provider: 'openai-codex', access: 'access-first', accountId: 'account-first' },
      { id: 'second', provider: 'openai-codex', access: 'access-second', accountId: 'account-second' },
    ]);
    const vault = env.CREDENTIALS.getByName(userId);
    const accounts = await vault.cloudCredentialAccounts('default');
    expect(accounts.map(account => account.identity)).toEqual(['account:account-first', 'account:account-second']);
    expect(JSON.stringify(accounts)).not.toContain('access-first');
    const resolved = await Promise.all(accounts.map(account => vault.cloudResolveCredential({ profileId: 'default', credentialId: account.id })));
    expect(resolved.map(value => value.credential)).toMatchObject([{ access: 'access-first', accountId: 'account-first' }, { access: 'access-second', accountId: 'account-second' }]);
    expect(JSON.stringify(resolved)).not.toContain('refresh');
  });

  it('stores static keys encrypted and isolates resolution and logout by profile', async () => {
    const vault = env.CREDENTIALS.getByName(await seedVault([]));
    const profile = (await vault.createInferenceProfile({ name: 'Client', sourceProfileId: null })).profiles.find(value => value.id !== 'default')!;
    await vault.putBrowserApiKey('default', 'openai', 'default-secret');
    await vault.putBrowserApiKey(profile.id, 'openai', 'client-secret');
    const original = (await vault.cloudCredentialAccounts('default'))[0]!;
    const client = (await vault.cloudCredentialAccounts(profile.id))[0]!;
    await runInDurableObject(vault, async instance => {
      await expect(instance.cloudResolveCredential({ profileId: 'default', credentialId: client.id })).rejects.toThrow();
    });
    await vault.disableBrowserCredentials('default', 'openai', client.id);
    expect((await vault.cloudResolveCredential({ profileId: profile.id, credentialId: client.id })).credential).toEqual({ type: 'api_key', key: 'client-secret' });
    const encrypted = await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec('SELECT sealed_json FROM inference_credentials').toArray());
    expect(JSON.stringify(encrypted)).not.toContain('client-secret');
    await vault.disableBrowserCredentials('default', 'openai', original.id);
    await vault.putBrowserApiKey('default', 'openai', 'replacement');
    const replacement = (await vault.cloudCredentialAccounts('default'))[0]!;
    expect(replacement.id).not.toBe(original.id);
    await vault.disableBrowserCredentials('default', 'openai', original.id);
    expect((await vault.cloudResolveCredential({ profileId: 'default', credentialId: replacement.id, forceRefresh: true })).credential).toEqual({ type: 'api_key', key: 'replacement' });
    await vault.deleteInferenceProfile({ profileId: profile.id, expectedRevision: 0 });
    await runInDurableObject(vault, async instance => {
      await expect(instance.cloudResolveCredential({ profileId: profile.id, credentialId: client.id })).rejects.toThrow();
    });
  });

  it('completes machine-free copy-code login and upserts distinct organizations independently', async () => {
    const vault = env.CREDENTIALS.getByName(await seedVault([]));
    let organization = 'org-a';
    let access = 'first-access';
    network.use(http.post('https://platform.claude.com/v1/oauth/token', () => HttpResponse.json({
      access_token: access, refresh_token: `${organization}-refresh`, expires_in: 3600,
      account: { uuid: 'same-account', email_address: 'person@example.com' }, organization: { uuid: organization },
    })));
    async function login() {
      const { flowId } = await vault.cloudLoginStart({ profileId: 'default', providerId: 'anthropic' });
      const pending = await vault.cloudLoginEvents({ profileId: 'default', flowId });
      const auth = pending.events.find(event => event.type === 'auth');
      const prompt = pending.events.find(event => event.type === 'prompt');
      if (!auth || !prompt) throw new Error('Login must expose consent and code entry');
      const csrf = new URL(auth.url).searchParams.get('state');
      await vault.cloudLoginRespond({ profileId: 'default', flowId, promptId: prompt.promptId, value: `code#${csrf}` });
      expect((await vault.cloudLoginEvents({ profileId: 'default', flowId })).events).toContainEqual(expect.objectContaining({ type: 'done', ok: true }));
    }
    await login();
    const first = (await vault.cloudCredentialAccounts('default'))[0]!;
    organization = 'org-b'; access = 'second-access';
    await login();
    expect((await vault.cloudCredentialAccounts('default')).map(value => value.identity)).toEqual(['email:person@example.com|org:org-a', 'email:person@example.com|org:org-b']);
    organization = 'org-a'; access = 'updated-access';
    await login();
    const accounts = await vault.cloudCredentialAccounts('default');
    expect(accounts.map(value => value.id)).toContain(first.id);
    expect(accounts).toHaveLength(2);
    expect((await vault.cloudResolveCredential({ profileId: 'default', credentialId: first.id })).credential).toMatchObject({ access: 'updated-access', orgId: 'org-a' });
  });

  it('finishes device login from a durable alarm after the browser disconnects', async () => {
    const vault = env.CREDENTIALS.getByName(await seedVault([]));
    const access = `header.${btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'alarm-account' } }))}.signature`;
    let tokenPolls = 0;
    let exchanges = 0;
    network.use(
      http.post('https://auth.openai.com/api/accounts/deviceauth/usercode', () => HttpResponse.json({ device_auth_id: 'device-auth', user_code: 'USER-CODE', interval: 5 })),
      http.post('https://auth.openai.com/api/accounts/deviceauth/token', () => {
        tokenPolls += 1;
        return HttpResponse.json({ authorization_code: 'authorized-code', code_verifier: 'provider-verifier' });
      }),
      http.post('https://auth.openai.com/oauth/token', () => {
        exchanges += 1;
        return HttpResponse.json({ access_token: access, refresh_token: 'alarm-refresh', expires_in: 3600 });
      }),
    );
    const { flowId } = await vault.cloudLoginStart({ profileId: 'default', providerId: 'openai-codex' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
    try {
      // No loginEvents/respond/poll call drives the exchange: only the durable alarm does.
      expect(await runDurableObjectAlarm(vault)).toBe(true);
      const accounts = await vault.cloudCredentialAccounts('default');
      expect(accounts).toMatchObject([{ provider: 'openai-codex', identity: 'account:alarm-account|org:alarm-account' }]);
      expect(tokenPolls).toBe(1);
      expect(exchanges).toBe(1);
      const replay = await vault.cloudLoginEvents({ profileId: 'default', flowId });
      expect(replay.done).toBe(true);
      expect(replay.events).toContainEqual(expect.objectContaining({ type: 'done', ok: true }));
      expect(exchanges).toBe(1);
      expect(JSON.stringify(replay)).not.toContain('alarm-refresh');
    } finally { clock.mockRestore(); }
  });

  it('commits rotated grants once and retains refresh tokens only in the vault', async () => {
    const vault = env.CREDENTIALS.getByName(await seedVault([{ id: 'rotating', provider: 'openai-codex', access: 'old' }]));
    const account = (await vault.cloudCredentialAccounts('default'))[0]!;
    const seen: Array<string | null> = [];
    network.use(http.post('https://auth.openai.com/oauth/token', async ({ request }) => {
      seen.push(new URLSearchParams(await request.text()).get('refresh_token'));
      return HttpResponse.json({ access_token: 'new', refresh_token: 'rotated-refresh', expires_in: 3600 });
    }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resolved = await vault.cloudResolveCredential({ profileId: 'default', credentialId: account.id, forceRefresh: true });
      expect(resolved.credential).toMatchObject({ access: 'new' });
      expect(JSON.stringify(resolved)).not.toContain('rotated-refresh');
    }
    expect(seen).toEqual(['rotating-refresh', 'rotated-refresh']);
  });

  it('refuses a second rotating exchange while another owner holds the lease', async () => {
    const vault = env.CREDENTIALS.getByName(await seedVault([{ id: 'leased', provider: 'openai-codex', access: 'old' }]));
    const account = (await vault.cloudCredentialAccounts('default'))[0]!;
    await runInDurableObject(vault, (_instance, state) => {
      state.storage.sql.exec('INSERT INTO refresh_leases(credential_id, owner, revision, expires_at) VALUES (?, ?, 1, ?)', 'leased', 'other-owner', Date.now() + 60_000);
    });
    let requests = 0;
    network.use(http.post('https://auth.openai.com/oauth/token', () => { requests += 1; return HttpResponse.json({ access_token: 'bad', refresh_token: 'bad', expires_in: 3600 }); }));
    await runInDurableObject(vault, async instance => {
      await expect(instance.cloudResolveCredential({ profileId: 'default', credentialId: account.id, forceRefresh: true })).rejects.toThrow();
    });
    expect(requests).toBe(0);
  });

  it('marks an uncertain rotation unavailable rather than replaying its refresh token', async () => {
    const vault = env.CREDENTIALS.getByName(await seedVault([{ id: 'uncertain', provider: 'openai-codex', access: 'old' }]));
    const account = (await vault.cloudCredentialAccounts('default'))[0]!;
    let requests = 0;
    network.use(http.post('https://auth.openai.com/oauth/token', () => { requests += 1; return HttpResponse.error(); }));
    await runInDurableObject(vault, async instance => {
      await expect(instance.cloudResolveCredential({ profileId: 'default', credentialId: account.id, forceRefresh: true })).rejects.toThrow();
      await expect(instance.cloudResolveCredential({ profileId: 'default', credentialId: account.id, forceRefresh: true })).rejects.toThrow();
    });
    expect(requests).toBe(1);
    expect(await vault.cloudCredentialAccounts('default')).toEqual([]);
  });

  it('does not disclose or resurrect a credential revoked during a rotating exchange', async () => {
    const vault = env.CREDENTIALS.getByName(await seedVault([{ id: 'revoked', provider: 'openai-codex', access: 'old' }]));
    const account = (await vault.cloudCredentialAccounts('default'))[0]!;
    let started = false;
    let released = false;
    network.use(http.post('https://auth.openai.com/oauth/token', async () => {
      started = true;
      while (!released) await scheduler.wait(5);
      return HttpResponse.json({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600 });
    }));
    let settled = false;
    const refresh = runInDurableObject(vault, async instance => {
      try {
        await instance.cloudResolveCredential({ profileId: 'default', credentialId: account.id, forceRefresh: true });
        return { rejected: false };
      } catch {
        return { rejected: true };
      } finally { settled = true; }
    });
    try {
      const deadline = Date.now() + 2000;
      while (!started && !settled && Date.now() < deadline) await scheduler.wait(5);
      expect(started).toBe(true);
      await vault.disableBrowserCredentials('default', 'openai-codex', account.id);
    } finally {
      released = true;
      expect(await refresh).toEqual({ rejected: true });
    }
    expect(await vault.cloudCredentialAccounts('default')).toEqual([]);
  });

  it('retries Default migration without rewriting encrypted identities or leases and duplicates configuration only', async () => {
    const userId = env.ACCOUNT_ID;
    const vault = env.CREDENTIALS.getByName(userId);
    await vault.bootstrap({ userId, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(2)) });
    await vault.putCredential({ id: 'preserved-oauth', credential: { provider: 'openai-codex', access: 'preserved-access', refresh: 'preserved-refresh', accountId: 'existing-account', expires: Date.now() + 3_600_000 } });
    const settings = env.USER_SETTINGS.getByName(userId);
    const content = JSON.stringify({ modelRoles: { default: 'openai/gpt-4.1', custom: 'anthropic/claude' }, agents: { custom: { modelRole: 'custom' } }, terminal: { theme: 'dark' } });
    const checksum = `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
    await runInDurableObject(settings, (_instance, state) => {
      state.storage.sql.exec('INSERT INTO omp_config(id, generation, content, checksum, updated_at, updated_by) VALUES (1, 1, ?, ?, ?, ?)', content, checksum, new Date().toISOString(), 'legacy');
    });
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
    const legacySettings = await runInDurableObject(settings, (_instance, state) => state.storage.sql.exec<{ content: string }>('SELECT content FROM omp_config WHERE id = 1').one().content);
    expect(parseYaml(legacySettings)).toEqual({ terminal: { theme: 'dark' } });
    const after = await runInDurableObject(vault, (_instance, state) => ({
      credentials: state.storage.sql.exec('SELECT rowid, id, sealed_json, revision FROM inference_credentials').toArray(),
      leases: state.storage.sql.exec('SELECT * FROM refresh_leases').toArray(),
    }));
    expect(after).toEqual(before);
    const preserved = (await vault.cloudCredentialAccounts('default'))[0]!;
    expect((await vault.cloudResolveCredential({ profileId: 'default', credentialId: preserved.id })).credential).toMatchObject({ access: 'preserved-access' });
    const duplicate = (await vault.createInferenceProfile({ name: 'Independent', sourceProfileId: 'default' })).profiles.find(profile => profile.id !== 'default')!;
    expect(duplicate.settings).toEqual(first.profiles[0]!.settings);
    expect(await vault.cloudCredentialAccounts(duplicate.id)).toEqual([]);
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
    const race = await runInDurableObject(vault, instance => Promise.allSettled([
      instance.assignInferenceProfile({ projectId, profileId, expectedRevision: 0 }),
      instance.deleteInferenceProfile({ profileId, expectedRevision: 1 }),
    ]));
    expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const state = await vault.ensureInference();
    const assigned = state.assignments.find(assignment => assignment.projectId === projectId)!;
    expect(state.profiles.some(profile => profile.id === assigned.profileId)).toBe(true);
    expect(await runInDurableObject(vault, instance => instance.assignInferenceProfile({ projectId: 'foreign-project', profileId: 'default', expectedRevision: 0 }).then(() => 'allowed', () => 'denied'))).toBe('denied');
  });

  it('leaves legacy credential ciphertext and leases untouched until the Worker deployment is committed', async () => {
    const userId = env.ACCOUNT_ID;
    const vault = env.CREDENTIALS.getByName(userId);
    await vault.bootstrap({ userId, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(2)) });
    await vault.putCredential({ id: 'legacy', credential: { provider: 'openai-codex', access: 'legacy-access', refresh: 'legacy-refresh', expires: Date.now() + 3_600_000 } });
    const before = await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec('SELECT rowid, * FROM oauth_credentials').toArray());
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: 'previous-worker' } })));
    await runInDurableObject(vault, async instance => {
      await expect(instance.ensureInference()).rejects.toThrow();
    });
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
    const legacy = (await vault.cloudCredentialAccounts('default'))[0]!;
    expect((await vault.cloudResolveCredential({ profileId: 'default', credentialId: legacy.id })).credential).toMatchObject({ access: 'legacy-access' });
    await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec("INSERT INTO oauth_credentials(id, provider, sealed_json, revision, expires_at, state, updated_at) VALUES ('old-write', 'openai', 'untrusted-legacy-ciphertext', 1, 0, 'active', '')").toArray());
    await runInDurableObject(vault, async instance => {
      await expect(instance.ensureInference()).rejects.toThrow();
      await expect(instance.cloudCredentialAccounts('default')).rejects.toThrow();
    });
  });

});
