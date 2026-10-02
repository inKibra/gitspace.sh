import { describe, expect, it } from 'bun:test';
import { AuthStorage } from '@oh-my-pi/pi-ai';
import { AuthBrokerClient, RemoteAuthCredentialStore, type SnapshotResponse } from '@oh-my-pi/pi-ai/auth-broker';
import type {
  CredentialHealthResult,
  CredentialOrigin,
  DisabledCredentialSummary,
  OAuthLoginIdentity,
  StoredAuthCredential,
  UsageReport,
} from '@oh-my-pi/pi-ai';
import type { ProviderLoginEvent } from '@gitspace/protocol';
import { ProfileProviderAuthCoordinator, ProviderAuthCoordinator, ProviderAuthError, type AuthStorageLike, type ProviderLoginController } from '../src/provider-auth.js';
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry';
import { inferenceContext } from './fixtures/inference.js';

interface FakeAuthStorageOptions {
  credentials?: StoredAuthCredential[];
  disabled?: DisabledCredentialSummary[];
  usageProviders?: string[];
  reports?: UsageReport[] | (() => Promise<UsageReport[] | null>);
  health?: CredentialHealthResult[] | (() => Promise<CredentialHealthResult[]>);
  login?: (provider: string, ctrl: ProviderLoginController, storage: FakeAuthStorage) => Promise<OAuthLoginIdentity | undefined>;
}

class FakeAuthStorage implements AuthStorageLike {
  credentials: StoredAuthCredential[];
  readonly disabled: DisabledCredentialSummary[];
  readonly invalidated: Array<string | undefined> = [];
  readonly apiKeys: Array<{ provider: string; key: string }> = [];
  readonly loggedOut: string[] = [];
  #nextId = 100;
  #generation = 0;

  constructor(private readonly options: FakeAuthStorageOptions = {}) {
    this.credentials = options.credentials ?? [];
    this.disabled = options.disabled ?? [];
  }

  getGeneration(): number { return this.#generation; }
  async revalidateCredentials(): Promise<void> {}

  addOAuth(provider: string, email: string): void {
    this.credentials.push({
      id: this.#nextId++,
      provider,
      credential: { type: 'oauth', refresh: 'r', access: 'a', expires: Date.now() + 60_000, email },
      disabledCause: null,
    });
    this.#generation++;
  }

  hasAuth(provider: string): boolean {
    return this.credentials.some((row) => row.provider === provider);
  }

  getCredentialOrigin(provider: string): CredentialOrigin | undefined {
    const rows = this.credentials.filter((row) => row.provider === provider);
    if (rows.some((row) => row.credential.type === 'oauth')) return { kind: 'oauth' };
    if (rows.length > 0) return { kind: 'api_key' };
    return undefined;
  }

  listStoredCredentials(provider?: string): StoredAuthCredential[] {
    return provider === undefined ? [...this.credentials] : this.credentials.filter((row) => row.provider === provider);
  }

  async listDisabledCredentials(provider?: string): Promise<DisabledCredentialSummary[]> {
    return provider === undefined ? this.disabled : this.disabled.filter((row) => row.provider === provider);
  }

  usageProviderFor(provider: string): unknown {
    return this.options.usageProviders?.includes(provider) ? { id: provider } : undefined;
  }

  login(provider: string, ctrl: ProviderLoginController): Promise<OAuthLoginIdentity | undefined> {
    if (!this.options.login) throw new Error('login not scripted');
    return this.options.login(provider, ctrl, this);
  }

  async logout(provider: string): Promise<void> {
    this.loggedOut.push(provider);
    this.credentials = this.credentials.filter((row) => row.provider !== provider);
    this.#generation++;
  }

  async removeCredential(provider: string, credentialId: number): Promise<boolean> {
    const before = this.credentials.length;
    this.credentials = this.credentials.filter((row) => !(row.provider === provider && row.id === credentialId));
    if (this.credentials.length !== before) this.#generation++;
    return this.credentials.length !== before;
  }

  async set(provider: string, credential: { type: 'api_key'; key: string }): Promise<void> {
    this.apiKeys.push({ provider, key: credential.key });
    this.credentials = this.credentials.filter((row) => row.provider !== provider);
    this.credentials.push({ id: this.#nextId++, provider, credential, disabledCause: null });
    this.#generation++;
  }

  async fetchUsageReports(): Promise<UsageReport[] | null> {
    const { reports } = this.options;
    if (typeof reports === 'function') return reports();
    return reports ?? [];
  }

  async checkCredentials(): Promise<CredentialHealthResult[]> {
    const { health } = this.options;
    return typeof health === 'function' ? health() : health ?? [];
  }

  async invalidateUsageCache(provider?: string): Promise<void> {
    this.invalidated.push(provider);
  }
}

function coordinator(storage: FakeAuthStorage): ProviderAuthCoordinator {
  return new ProviderAuthCoordinator({ profileId: 'default', authStorage: async () => storage, modelRegistry: async () => { throw new Error('No model catalog in this login/usage fixture'); } });
}

async function collect(events: AsyncIterable<ProviderLoginEvent>, until: (event: ProviderLoginEvent) => boolean): Promise<ProviderLoginEvent[]> {
  const seen: ProviderLoginEvent[] = [];
  for await (const event of events) {
    seen.push(event);
    if (until(event)) break;
  }
  return seen;
}

async function credentialBrokerFixture() {
  let snapshot: SnapshotResponse = {
    generation: 1, generatedAt: Date.now(), serverNowMs: Date.now(),
    refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: 0 },
    credentials: [],
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (request.headers.get('authorization') !== 'Bearer provider-refresh-test') return new Response(null, { status: 401 });
      const url = new URL(request.url);
      if (url.pathname !== '/v1/snapshot') return new Response(null, { status: 404 });
      return Response.json(snapshot, { headers: { etag: `"${snapshot.generation}"` } });
    },
  });
  const storages: AuthStorage[] = [];
  const storage = async () => {
    const remote = new RemoteAuthCredentialStore({
      client: new AuthBrokerClient({ url: server.url.toString(), token: 'provider-refresh-test', maxRetries: 0 }),
      initialSnapshot: snapshot,
      // Keep background activity parked; each foreground revalidation still uses the real HTTP client.
      backgroundIdleMs: 0,
    });
    const auth = new AuthStorage(remote, { storeOnly: true });
    storages.push(auth);
    await auth.reload();
    return auth;
  };
  return {
    storage,
    saveKey(key: string | null) {
      snapshot = {
        ...snapshot, generation: snapshot.generation + 1, generatedAt: Date.now(), serverNowMs: Date.now(),
        credentials: key === null ? [] : [{
          id: 1, provider: 'amazon-bedrock', identityKey: null, rotatesInMs: null,
          credential: { type: 'api_key', key },
        }],
      };
    },
    async close() {
      for (const auth of storages) auth.close();
      await server.stop(true);
    },
  };
}

describe('ProviderAuthCoordinator broker synchronization', () => {
  it('picks up cloud key additions, rotations, and removals in provider views, model choices, and existing session auth', async () => {
    const broker = await credentialBrokerFixture();
    try {
      const machine = await broker.storage();
      const session = await broker.storage();
      const registry = new ModelRegistry(machine, undefined, { ignoreLocalModelConfig: true });
      const auth = new ProviderAuthCoordinator({ profileId: 'default', authStorage: async () => machine, modelRegistry: async () => registry, onChanged: () => session.revalidateCredentials() });
      expect((await auth.view('amazon-bedrock')).accounts).toEqual([]);

      broker.saveKey('bedrock-first');
      expect((await auth.list()).find(provider => provider.id === 'amazon-bedrock')).toMatchObject({
        hasAuth: true, accounts: [{ id: '1', type: 'api_key', disabled: false }],
      });
      expect(session.listStoredCredentials('amazon-bedrock')[0]?.credential).toEqual({ type: 'api_key', key: 'bedrock-first' });

      broker.saveKey('bedrock-rotated');
      expect((await auth.models()).some(model => model.provider === 'amazon-bedrock')).toBe(true);
      expect(session.listStoredCredentials('amazon-bedrock')[0]?.credential).toEqual({ type: 'api_key', key: 'bedrock-rotated' });

      broker.saveKey(null);
      expect((await auth.view('amazon-bedrock')).accounts).toEqual([]);
      expect(session.listStoredCredentials('amazon-bedrock')).toEqual([]);
    } finally { await broker.close(); }
  });

  it('retries session propagation after a failed reload even when the machine cache is already current', async () => {
    const broker = await credentialBrokerFixture();
    try {
      const machine = await broker.storage();
      const session = await broker.storage();
      let available = false;
      const auth = new ProviderAuthCoordinator({
        profileId: 'default',
        authStorage: async () => machine,
        modelRegistry: async () => new ModelRegistry(machine, undefined, { ignoreLocalModelConfig: true }),
        onChanged: async () => {
          if (!available) throw new Error('Session auth reload unavailable');
          await session.revalidateCredentials();
        },
      });
      await auth.list();
      broker.saveKey('bedrock-after-reconnect');
      await expect(auth.list()).rejects.toThrow('Session auth reload unavailable');
      expect(session.listStoredCredentials('amazon-bedrock')).toEqual([]);

      available = true;
      expect((await auth.list()).find(provider => provider.id === 'amazon-bedrock')?.accounts).toHaveLength(1);
      expect(session.listStoredCredentials('amazon-bedrock')[0]?.credential).toEqual({ type: 'api_key', key: 'bedrock-after-reconnect' });
    } finally { await broker.close(); }
  });
});

describe('ProviderAuthCoordinator.list', () => {
  it('maps registry providers with stored credentials, disabled tombstones, origin and usage support', async () => {
    const storage = new FakeAuthStorage({
      credentials: [
        { id: 1, provider: 'anthropic', credential: { type: 'oauth', refresh: 'r', access: 'a', expires: 1, email: 'me@example.com' }, disabledCause: null },
        { id: 2, provider: 'openai', credential: { type: 'api_key', key: 'sk-test' }, disabledCause: null },
        { id: 3, provider: 'zai', credential: { type: 'api_key', key: 'sk-zai', source: 'login' }, disabledCause: null },
      ],
      disabled: [
        { id: 9, provider: 'anthropic', type: 'oauth', email: 'old@example.com', cause: 'oauth refresh failed: invalid_grant' },
        // Lifecycle noise: deleted/replaced rows, non-OAuth rows and identities that are signed in again.
        { id: 10, provider: 'anthropic', type: 'oauth', email: 'gone@example.com', cause: 'deleted by user' },
        { id: 11, provider: 'anthropic', type: 'oauth', email: 'ME@example.com', cause: 'oauth refresh failed' },
        { id: 12, provider: 'openai', type: 'api_key', cause: 'rotated' },
      ],
      usageProviders: ['anthropic'],
    });
    const providers = await coordinator(storage).list();
    const byId = new Map(providers.map((provider) => [provider.id, provider]));

    const anthropic = byId.get('anthropic')!;
    expect(anthropic).toMatchObject({ name: 'Anthropic (Claude Pro/Max)', loginable: true, authKind: 'oauth', hasAuth: true, source: 'oauth', hasUsage: true });
    expect(anthropic.accounts).toEqual([
      { id: '1', type: 'oauth', label: 'me@example.com', email: 'me@example.com', disabled: false },
      { id: '9', type: 'oauth', label: 'old@example.com', email: 'old@example.com', disabled: true },
    ]);

    expect(byId.get('openai')).toMatchObject({
      loginable: false,
      authKind: 'api_key',
      hasAuth: true,
      source: 'api_key',
      hasUsage: false,
      accounts: [{ id: '2', type: 'api_key', label: 'API key', email: null, disabled: false }],
    });
    expect(byId.get('zai')).toMatchObject({ loginable: true, authKind: 'api_key', accounts: [{ id: '3', label: 'API key (sign-in)' }] });
    // Alias login entries report the auth state of the provider they store credentials under.
    expect(byId.get('openai-codex-device')).toMatchObject({ loginable: true, authKind: 'oauth', hasAuth: false, accounts: [] });
    // Browser-redirect flows are OAuth even before any credential is stored.
    expect(byId.get('github-copilot')).toMatchObject({ loginable: true, authKind: 'oauth', hasAuth: false, source: null });
    // Login-only alias entries never appear twice; registry order is preserved.
    expect(providers.map((provider) => provider.id)).toEqual([...new Set(providers.map((provider) => provider.id))]);
    expect(providers.findIndex((provider) => provider.id === 'anthropic')).toBeLessThan(providers.findIndex((provider) => provider.id === 'openai'));
  });

  it('identifies shared credential stores without collapsing same-email organization accounts', async () => {
    const storage = new FakeAuthStorage({
      credentials: [
        { id: 1, provider: 'openai-codex', credential: { type: 'oauth', refresh: 'personal', access: 'a', expires: 1, email: 'same@example.com', orgId: 'personal', orgName: 'Personal' }, disabledCause: null },
        { id: 2, provider: 'openai-codex', credential: { type: 'oauth', refresh: 'team', access: 'b', expires: 1, email: 'same@example.com', orgId: 'team', orgName: 'Team' }, disabledCause: null },
      ],
    });
    const providers = await coordinator(storage).list();
    const codex = providers.find((provider) => provider.id === 'openai-codex')!;
    const device = providers.find((provider) => provider.id === 'openai-codex-device')!;
    expect(codex.credentialProvider).toBe('openai-codex');
    expect(device).toMatchObject({ credentialProvider: codex.credentialProvider, loginable: true, authKind: 'oauth' });
    expect(codex.accounts.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: '1', label: 'same@example.com · Personal' },
      { id: '2', label: 'same@example.com · Team' },
    ]);
    expect(device.accounts).toEqual(codex.accounts);
  });

  it('matches disabled accounts by credential identity, including org-only identities, rather than email alone', async () => {
    const storage = new FakeAuthStorage({
      credentials: [
        { id: 1, provider: 'openai-codex', credential: { type: 'oauth', refresh: 'r', access: 'a', expires: 1, email: 'same@example.com', orgId: 'personal' }, disabledCause: null },
        { id: 2, provider: 'openai-codex', credential: { type: 'oauth', refresh: 'r', access: 'a', expires: 1, orgId: 'org-only' }, disabledCause: null },
        { id: 3, provider: 'cursor', credential: { type: 'oauth', refresh: 'r', access: 'a', expires: 1, accountId: 'current', email: 'same@example.com' }, disabledCause: null },
      ],
      disabled: [
        { id: 10, provider: 'openai-codex', type: 'oauth', email: ' SAME@example.com ', orgId: 'personal', cause: 'oauth refresh failed' },
        { id: 11, provider: 'openai-codex', type: 'oauth', email: 'same@example.com', orgId: 'team', cause: 'oauth refresh failed' },
        { id: 12, provider: 'openai-codex', type: 'oauth', orgId: 'org-only', cause: 'oauth refresh failed' },
        { id: 13, provider: 'openai-codex', type: 'oauth', cause: 'oauth refresh failed' },
        { id: 14, provider: 'cursor', type: 'oauth', accountId: 'other', email: 'same@example.com', cause: 'oauth refresh failed' },
      ],
    });
    const auth = coordinator(storage);
    const codex = await auth.view('openai-codex');
    expect(codex.accounts.filter((account) => account.disabled).map((account) => account.id)).toEqual(['11', '13']);
    expect((await auth.view('cursor')).accounts.filter((account) => account.disabled).map((account) => account.id)).toEqual(['14']);
  });

  it('rejects unknown providers and providers without an interactive sign-in', async () => {
    const storage = new FakeAuthStorage();
    const auth = coordinator(storage);
    await expect(auth.startLogin('nope')).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(auth.startLogin('openai')).rejects.toThrow('no interactive sign-in');
    await expect(auth.logout('nope', null)).rejects.toThrow('Unknown provider');
  });
});

describe('ProviderAuthCoordinator login flows', () => {
  it('streams auth → prompt → done and stores the credential the prompt answer produced', async () => {
    const storage = new FakeAuthStorage({
      login: async (provider, ctrl, fake) => {
        ctrl.onAuth({ url: 'https://example.com/authorize', launchUrl: 'http://localhost:1/launch', instructions: 'Open the link' });
        ctrl.onProgress('Waiting for browser…');
        const code = await ctrl.onPrompt({ message: 'Paste the code', placeholder: 'code' });
        fake.addOAuth(provider, `${code}@example.com`);
        return { type: 'oauth', email: `${code}@example.com` };
      },
    });
    const auth = coordinator(storage);
    const flowId = await auth.startLogin('anthropic');

    const first = await collect(auth.events(flowId), (event) => event.type === 'prompt');
    expect(first).toEqual([
      { type: 'auth', url: 'https://example.com/authorize', launchUrl: 'http://localhost:1/launch', instructions: 'Open the link' },
      { type: 'progress', message: 'Waiting for browser…' },
      expect.objectContaining({ type: 'prompt', message: 'Paste the code', placeholder: 'code' }),
    ]);
    const prompt = first[2] as Extract<ProviderLoginEvent, { type: 'prompt' }>;
    await expect(auth.respond(flowId, 'missing', 'x')).rejects.toThrow('no open prompt');
    await auth.respond(flowId, prompt.promptId, 'alice');

    // A late subscriber replays the whole buffer and still observes completion.
    const replay = await collect(auth.events(flowId), () => false);
    expect(replay.map((event) => event.type)).toEqual(['auth', 'progress', 'prompt', 'done']);
    const done = replay.at(-1) as Extract<ProviderLoginEvent, { type: 'done'; ok: true }>;
    expect(done.ok).toBe(true);
    expect(done.provider).toMatchObject({ id: 'anthropic', hasAuth: true, authKind: 'oauth', source: 'oauth' });
    expect(done.provider.accounts).toEqual([{ id: '100', type: 'oauth', label: 'alice@example.com', email: 'alice@example.com', disabled: false }]);
    await expect(auth.respond(flowId, prompt.promptId, 'again')).rejects.toThrow('no open prompt');
  });

  it('retires the remote paste prompt when the local callback wins', async () => {
    const callback = Promise.withResolvers<string>();
    const storage = new FakeAuthStorage({
      login: async (provider, ctrl, fake) => {
        await Promise.race([ctrl.onManualCodeInput(), callback.promise]);
        fake.addOAuth(provider, 'local@example.com');
        return { type: 'oauth', email: 'local@example.com' };
      },
    });
    const auth = coordinator(storage);
    const flowId = await auth.startLogin('openai-codex');
    const waiting = await collect(auth.events(flowId), (event) => event.type === 'prompt');
    const prompt = waiting.at(-1) as Extract<ProviderLoginEvent, { type: 'prompt' }>;
    callback.resolve('local-callback');
    const events = await collect(auth.events(flowId), () => false);
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: true });
    await expect(auth.respond(flowId, prompt.promptId, 'late-remote-callback')).rejects.toThrow('no open prompt');
  });

  it('cancel aborts the flow, rejects open prompts and ends the stream with done ok:false', async () => {
    let aborted = false;
    const storage = new FakeAuthStorage({
      login: async (_provider, ctrl) => {
        ctrl.signal.addEventListener('abort', () => { aborted = true; });
        await ctrl.onPrompt({ message: 'Paste the code' });
        throw new Error('unreachable');
      },
    });
    const auth = coordinator(storage);
    const flowId = await auth.startLogin('openai-codex');
    await collect(auth.events(flowId), (event) => event.type === 'prompt');
    await auth.cancel(flowId);
    const events = await collect(auth.events(flowId), () => false);
    expect(aborted).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', ok: false, error: 'Login cancelled' });
    // Cancelling a finished flow is a no-op; unknown flows are rejected.
    await auth.cancel(flowId);
    await expect(auth.cancel('missing')).rejects.toThrow('Unknown login flow');
    expect(() => auth.events('missing')).toThrow('Unknown login flow');
  });

  it('reports provider failures as done ok:false', async () => {
    const storage = new FakeAuthStorage({ login: async () => { throw new Error('token exchange failed'); } });
    const auth = coordinator(storage);
    const flowId = await auth.startLogin('anthropic');
    const events = await collect(auth.events(flowId), () => false);
    expect(events).toEqual([{ type: 'done', ok: false, error: 'token exchange failed' }]);
  });

  it('stops streaming when the subscriber signal aborts', async () => {
    const storage = new FakeAuthStorage({ login: (_provider, ctrl) => ctrl.onPrompt({ message: 'wait' }).then(() => undefined) });
    const auth = coordinator(storage);
    const flowId = await auth.startLogin('anthropic');
    const controller = new AbortController();
    const iterator = auth.events(flowId, controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'prompt', message: 'wait' });
    const pending = iterator.next();
    controller.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    await auth.cancel(flowId);
  });
});

describe('ProviderAuthCoordinator credentials', () => {
  it('logs out a single credential or the whole provider through the credential provider id', async () => {
    const storage = new FakeAuthStorage({
      credentials: [
        { id: 1, provider: 'openai-codex', credential: { type: 'oauth', refresh: 'r', access: 'a', expires: 1, email: 'a@example.com' }, disabledCause: null },
        { id: 2, provider: 'openai-codex', credential: { type: 'oauth', refresh: 'r', access: 'a', expires: 1, email: 'b@example.com' }, disabledCause: null },
      ],
    });
    const auth = coordinator(storage);
    const afterOne = await auth.logout('openai-codex-device', '1');
    expect(afterOne.accounts.map((account) => account.email)).toEqual(['b@example.com']);
    await expect(auth.logout('openai-codex', '1')).rejects.toThrow('no credential 1');
    const afterAll = await auth.logout('openai-codex', null);
    expect(storage.loggedOut).toEqual(['openai-codex']);
    expect(afterAll).toMatchObject({ hasAuth: false, accounts: [], source: null });
  });

  it('stores trimmed API keys and refuses empty ones', async () => {
    const storage = new FakeAuthStorage();
    const auth = coordinator(storage);
    const view = await auth.setApiKey('openai', '  sk-live  ');
    expect(storage.apiKeys).toEqual([{ provider: 'openai', key: 'sk-live' }]);
    expect(view).toMatchObject({ id: 'openai', hasAuth: true, authKind: 'api_key', source: 'api_key' });
    await expect(auth.setApiKey('openai', '   ')).rejects.toThrow('must not be empty');
    expect(storage.apiKeys).toHaveLength(1);
  });
});

describe('ProviderAuthCoordinator.usage', () => {
  const anthropicReport: UsageReport = {
    provider: 'anthropic',
    fetchedAt: Date.parse('2026-09-01T10:00:00Z'),
    metadata: { email: 'a@example.com' },
    notes: ['Observed spend only'],
    limits: [
      {
        id: '5h',
        label: 'Session',
        scope: { provider: 'anthropic', windowId: '5h' },
        window: { id: '5h', label: '5 Hour', resetsAt: Date.parse('2026-09-01T12:00:00Z') },
        amount: { unit: 'percent', used: 40 },
        status: 'ok',
      },
      {
        id: 'opus',
        label: 'Opus',
        scope: { provider: 'anthropic', modelId: 'opus', tier: 'Max' },
        amount: { unit: 'requests', used: 10, limit: 50, remaining: 40, remainingFraction: 0.8 },
      },
    ],
    raw: { secret: true },
  };
  const codexReport: UsageReport = {
    provider: 'openai-codex',
    fetchedAt: Date.parse('2026-09-01T10:00:00Z'),
    metadata: { email: 'other@example.com' },
    limits: [{ id: 'weekly', label: 'Weekly', scope: { provider: 'openai-codex', shared: true }, amount: { unit: 'unknown' } }],
  };
  const credentials: StoredAuthCredential[] = [
    { id: 1, provider: 'anthropic', credential: { type: 'oauth', refresh: 'r', access: 'a', expires: 1, email: 'a@example.com' }, disabledCause: null },
    { id: 2, provider: 'openai-codex', credential: { type: 'oauth', refresh: 'r', access: 'a', expires: 1, email: 'b@example.com' }, disabledCause: null },
    { id: 3, provider: 'zai', credential: { type: 'api_key', key: 'k' }, disabledCause: null },
  ];

  it('maps OMP usage reports, drops raw payloads and lists accounts without a report', async () => {
    const storage = new FakeAuthStorage({ credentials, usageProviders: ['anthropic', 'openai-codex'], reports: [anthropicReport, codexReport] });
    const usage = await coordinator(storage).usage(null, false);
    expect(storage.invalidated).toEqual([]);
    expect(usage.errors).toEqual([{ provider: 'openai-codex', message: expect.stringContaining('b@example.com') }]);
    expect(usage.reports).toEqual([
      {
        provider: 'anthropic',
        account: 'a@example.com',
        fetchedAt: '2026-09-01T10:00:00.000Z',
        notes: ['Observed spend only'],
        limits: [
          { id: '5h', label: 'Session', scope: 'account', window: '5 Hour', unit: 'percent', used: 40, limit: null, remaining: null, remainingFraction: 0.6, resetsAt: '2026-09-01T12:00:00.000Z', status: 'ok' },
          { id: 'opus', label: 'Opus', scope: 'Max', window: null, unit: 'requests', used: 10, limit: 50, remaining: 40, remainingFraction: 0.8, resetsAt: null, status: null },
        ],
      },
      {
        provider: 'openai-codex',
        account: 'other@example.com',
        fetchedAt: '2026-09-01T10:00:00.000Z',
        notes: [],
        limits: [{ id: 'weekly', label: 'Weekly', scope: 'shared', window: null, unit: 'unknown', used: null, limit: null, remaining: null, remainingFraction: null, resetsAt: null, status: null }],
      },
    ]);
    // zai has no usage endpoint, so it is not "missing"; the unattributed Codex account is.
    expect(usage.accountsWithoutUsage).toEqual(['openai-codex: b@example.com']);
    expect(JSON.stringify(usage)).not.toContain('secret');
  });

  it('filters by provider and invalidates that provider cache on refresh', async () => {
    const storage = new FakeAuthStorage({ credentials, usageProviders: ['anthropic', 'openai-codex'], reports: [anthropicReport, codexReport] });
    const usage = await coordinator(storage).usage('anthropic', true);
    expect(storage.invalidated).toEqual(['anthropic']);
    expect(usage.reports.map((report) => report.provider)).toEqual(['anthropic']);
    expect(usage.accountsWithoutUsage).toEqual([]);
    // Explicit provider bypasses the usage-endpoint cull so a key without an endpoint still shows as unreported.
    const zai = await coordinator(storage).usage('zai', false);
    expect(zai.reports).toEqual([]);
    expect(zai.accountsWithoutUsage).toEqual(['zai: API key']);
    expect(zai.errors).toEqual([{ provider: 'zai', message: expect.any(String) }]);
  });

  it('turns a failed fetch into an error entry instead of throwing', async () => {
    const storage = new FakeAuthStorage({ credentials, usageProviders: ['anthropic'], reports: async () => { throw new Error('broker offline'); } });
    const usage = await coordinator(storage).usage(null, true);
    expect(storage.invalidated).toEqual([undefined]);
    expect(usage.reports).toEqual([]);
    expect(usage.errors).toEqual([{ provider: '*', message: 'broker offline' }]);
    expect(usage.accountsWithoutUsage).toEqual(['anthropic: a@example.com']);
  });

  it('does not treat an empty aggregate as successful for connected usage accounts', async () => {
    const storage = new FakeAuthStorage({ credentials, usageProviders: ['openai-codex'] });
    const usage = await coordinator(storage).usage(null, false);
    expect(usage.reports).toEqual([]);
    expect(usage.accountsWithoutUsage).toEqual(['openai-codex: b@example.com']);
    expect(usage.errors).toEqual([{ provider: 'openai-codex', message: expect.any(String) }]);
  });

  it('keeps aggregate failure attribution when the view is scoped to one provider', async () => {
    const storage = new FakeAuthStorage({ credentials, reports: async () => { throw new Error('Codex usage request failed with status 403'); } });
    const usage = await coordinator(storage).usage('openai-codex', false);
    expect(usage.errors).toEqual([{ provider: '*', message: 'Codex usage request failed with status 403' }]);
    expect(usage.accountsWithoutUsage).toEqual(['openai-codex: b@example.com']);
  });

  it('recovers missing broker usage through the matching OMP credential probe', async () => {
    const storage = new FakeAuthStorage({
      credentials,
      usageProviders: ['openai-codex'],
      reports: async () => null,
      health: [{ id: 2, provider: 'openai-codex', type: 'oauth', ok: true, report: { ...codexReport, metadata: { email: 'b@example.com' } } }],
    });
    const usage = await coordinator(storage).usage(null, false);
    expect(usage.reports).toMatchObject([{ provider: 'openai-codex', account: 'b@example.com', limits: [{ id: 'weekly' }] }]);
    expect(usage.accountsWithoutUsage).toEqual([]);
    expect(usage.errors).toEqual([]);
  });

  it('attributes recovered usage to its organization without covering a same-email sibling', async () => {
    const storage = new FakeAuthStorage({
      credentials: [
        { id: 2, provider: 'openai-codex', credential: { type: 'oauth', refresh: 'r', access: 'a', expires: 1, email: 'b@example.com', orgId: 'org-a' }, disabledCause: null },
        { id: 4, provider: 'openai-codex', credential: { type: 'oauth', refresh: 'r4', access: 'a4', expires: 1, email: 'b@example.com', orgId: 'org-b' }, disabledCause: null },
      ],
      usageProviders: ['openai-codex'],
      health: [
        { id: 2, provider: 'openai-codex', type: 'oauth', email: 'b@example.com', orgId: 'org-a', ok: true, report: { ...codexReport, metadata: { email: 'b@example.com' } } },
        { id: 4, provider: 'openai-codex', type: 'oauth', ok: false, reason: 'account unavailable' },
      ],
    });
    const usage = await coordinator(storage).usage(null, false);
    expect(usage.reports).toMatchObject([{ provider: 'openai-codex', account: 'b@example.com', limits: [{ id: 'weekly' }] }]);
    expect(usage.accountsWithoutUsage).toEqual(['openai-codex: b@example.com']);
    expect(usage.errors).toEqual([{ provider: 'openai-codex', message: 'openai-codex: b@example.com: account unavailable' }]);
  });

  it('does not surface a broker error after the local probe recovers all missing usage', async () => {
    const storage = new FakeAuthStorage({
      credentials,
      usageProviders: ['openai-codex'],
      reports: async () => { throw new Error('Broker usage request failed with status 403'); },
      health: [{ id: 2, provider: 'openai-codex', type: 'oauth', ok: true, report: { ...codexReport, metadata: { email: 'b@example.com' } } }],
    });
    const usage = await coordinator(storage).usage('openai-codex', true);
    expect(usage.reports.map((report) => report.account)).toEqual(['b@example.com']);
    expect(usage.accountsWithoutUsage).toEqual([]);
    expect(usage.errors).toEqual([]);
  });

  it('supplements partial aggregates without replacing successes or losing per-account probe failures', async () => {
    const aggregate = [anthropicReport, { ...codexReport, metadata: { email: 'b@example.com' } }];
    const storage = new FakeAuthStorage({
      credentials: [
        ...credentials,
        { id: 4, provider: 'openai-codex', credential: { type: 'oauth', refresh: 'r4', access: 'a4', expires: 1, email: 'c@example.com' }, disabledCause: null },
        { id: 5, provider: 'openai-codex', credential: { type: 'oauth', refresh: 'r5', access: 'a5', expires: 1, email: 'd@example.com' }, disabledCause: null },
      ],
      usageProviders: ['anthropic', 'openai-codex'],
      reports: aggregate,
      health: [
        { id: 1, provider: 'anthropic', type: 'oauth', ok: true, report: { ...anthropicReport, limits: [] } },
        { id: 2, provider: 'openai-codex', type: 'oauth', ok: true, report: { ...codexReport, metadata: { email: 'b@example.com' }, limits: [] } },
        { id: 4, provider: 'openai-codex', type: 'oauth', ok: false, reason: 'oauth refresh failed: invalid_grant' },
        { id: 5, provider: 'openai-codex', type: 'oauth', ok: true, report: { ...codexReport, metadata: { email: 'd@example.com' } } },
      ],
    });
    const usage = await coordinator(storage).usage(null, false);
    expect(usage.reports.map((report) => ({ account: report.account, limits: report.limits.map((limit) => limit.id) }))).toEqual([
      { account: 'a@example.com', limits: ['5h', 'opus'] },
      { account: 'b@example.com', limits: ['weekly'] },
      { account: 'd@example.com', limits: ['weekly'] },
    ]);
    expect(usage.accountsWithoutUsage).toEqual(['openai-codex: c@example.com']);
    expect(usage.errors).toEqual([{ provider: 'openai-codex', message: 'openai-codex: c@example.com: oauth refresh failed: invalid_grant' }]);
    expect(aggregate.map((report) => report.metadata?.email)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('ignores probe reports for unrelated credential IDs or providers in a scoped view', async () => {
    const storage = new FakeAuthStorage({
      credentials,
      usageProviders: ['anthropic', 'openai-codex'],
      health: [
        { id: 22, provider: 'openai-codex', type: 'oauth', ok: true, report: { ...codexReport, metadata: { email: 'b@example.com' } } },
        { id: 2, provider: 'anthropic', type: 'oauth', ok: true, report: { ...codexReport, metadata: { email: 'b@example.com' } } },
        { id: 1, provider: 'anthropic', type: 'oauth', ok: true, report: anthropicReport },
      ],
    });
    const usage = await coordinator(storage).usage('openai-codex', false);
    expect(usage.reports).toEqual([]);
    expect(usage.accountsWithoutUsage).toEqual(['openai-codex: b@example.com']);
    expect(usage.errors).toEqual([{ provider: 'openai-codex', message: expect.any(String) }]);
  });

  it('preserves aggregate reports and the real diagnostic error when local probing fails', async () => {
    const storage = new FakeAuthStorage({
      credentials,
      usageProviders: ['anthropic', 'openai-codex'],
      reports: [anthropicReport],
      health: async () => { throw new Error('Auth broker refresh timed out'); },
    });
    const usage = await coordinator(storage).usage(null, false);
    expect(usage.reports.map((report) => report.provider)).toEqual(['anthropic']);
    expect(usage.accountsWithoutUsage).toEqual(['openai-codex: b@example.com']);
    expect(usage.errors).toEqual([{ provider: '*', message: 'Auth broker refresh timed out' }]);
  });
});

describe('profile-scoped provider management', () => {
  it('captures the OAuth profile across UI switches and rejects cross-profile flow IDs', async () => {
    const storages: Record<string, FakeAuthStorage> = {
      first: new FakeAuthStorage({
        login: async (provider, ctrl, storage) => {
          const email = await ctrl.onPrompt({ message: 'Account email' });
          storage.addOAuth(provider, email);
          return { type: 'oauth', email };
        },
      }),
      second: new FakeAuthStorage(),
    };
    const profiles = new ProfileProviderAuthCoordinator({
      agentDir: '/unused', cwd: '/unused', resolve: async (id) => inferenceContext(null, id),
      createContext: async (context) => {
        const authStorage = storages[context.profile.id]!;
        return { authStorage, modelRegistry: { getAvailable() { throw new Error('No model catalog in login fixture'); } }, close() {} };
      },
    });
    try {
      const first = await profiles.forProfile('first');
      const flow = await first.startLogin('anthropic');
      const events = await collect(first.events(flow), (event) => event.type === 'prompt');
      const prompt = events.at(-1) as Extract<ProviderLoginEvent, { type: 'prompt' }>;
      const second = await profiles.forProfile('second');
      expect(() => second.events(flow)).toThrow('Unknown login flow');
      await expect(second.respond(flow, prompt.promptId, 'wrong@example.com')).rejects.toThrow('Unknown login flow');
      await (await profiles.forProfile('first')).respond(flow, prompt.promptId, 'right@example.com');
      const done = (await collect(first.events(flow), () => false)).at(-1);
      expect(done).toMatchObject({ type: 'done', ok: true, provider: { accounts: [{ email: 'right@example.com' }] } });
      expect((await second.view('anthropic')).accounts).toEqual([]);
    } finally { await profiles.close(); }
  });

  it('isolates usage accounts and invalidation, and never serves a cached coordinator when authority is unavailable', async () => {
    const storages: Record<string, FakeAuthStorage> = {};
    for (const id of ['first', 'second']) {
      storages[id] = new FakeAuthStorage({
        usageProviders: ['anthropic'],
        credentials: [{ id: 1, provider: 'anthropic', credential: { type: 'oauth', refresh: `r-${id}`, access: `a-${id}`, expires: 1, email: `${id}@example.com` }, disabledCause: null }],
        reports: [{ provider: 'anthropic', fetchedAt: 0, metadata: { email: `${id}@example.com` }, limits: [] }],
      });
    }
    let available = true;
    const profiles = new ProfileProviderAuthCoordinator({
      agentDir: '/unused', cwd: '/unused',
      resolve: async (id) => { if (!available) throw new Error('Canonical authority offline'); return inferenceContext(null, id); },
      createContext: async (context) => {
        const authStorage = storages[context.profile.id]!;
        return { authStorage, modelRegistry: { getAvailable() { throw new Error('No model catalog in usage fixture'); } }, close() {} };
      },
    });
    try {
      expect((await (await profiles.forProfile('first')).usage(null, false)).reports.map((report) => report.account)).toEqual(['first@example.com']);
      expect((await (await profiles.forProfile('second')).usage('anthropic', true)).reports.map((report) => report.account)).toEqual(['second@example.com']);
      expect(storages.first!.invalidated).toEqual([]);
      expect(storages.second!.invalidated).toEqual(['anthropic']);
      await (await profiles.forProfile('first')).setApiKey('openai', 'first-key');
      await (await profiles.forProfile('second')).setApiKey('openai', 'second-key');
      await (await profiles.forProfile('first')).logout('openai', null);
      expect((await (await profiles.forProfile('first')).view('openai')).hasAuth).toBe(false);
      expect(storages.second!.listStoredCredentials('openai')[0]?.credential).toEqual({ type: 'api_key', key: 'second-key' });
      available = false;
      await expect(profiles.forProfile('first')).rejects.toThrow('Canonical authority offline');
    } finally { await profiles.close(); }
  });

  it('propagates cloud key rotation only to children sharing that profile', async () => {
    const first = await credentialBrokerFixture();
    const second = await credentialBrokerFixture();
    let profiles: ProfileProviderAuthCoordinator | undefined;
    try {
      first.saveKey('first-initial');
      second.saveKey('second-independent');
      const firstChild = await first.storage();
      const secondChild = await second.storage();
      const firstManagement = await first.storage();
      const secondManagement = await second.storage();
      profiles = new ProfileProviderAuthCoordinator({
        agentDir: '/unused', cwd: '/unused', resolve: async (id) => inferenceContext(null, id),
        createContext: async (context) => {
          const authStorage = context.profile.id === 'first' ? firstManagement : secondManagement;
          return { authStorage, modelRegistry: new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true }), close() {} };
        },
        onChanged: (profileId) => (profileId === 'first' ? firstChild : secondChild).revalidateCredentials(),
      });
      await (await profiles.forProfile('first')).list();
      await (await profiles.forProfile('second')).list();
      first.saveKey('first-rotated');
      await (await profiles.forProfile('first')).list();
      expect(firstChild.listStoredCredentials('amazon-bedrock')[0]?.credential).toEqual({ type: 'api_key', key: 'first-rotated' });
      expect(secondChild.listStoredCredentials('amazon-bedrock')[0]?.credential).toEqual({ type: 'api_key', key: 'second-independent' });
      first.saveKey(null);
      await (await profiles.forProfile('first')).list();
      expect(firstChild.listStoredCredentials()).toEqual([]);
      expect(secondChild.listStoredCredentials('amazon-bedrock')[0]?.credential).toEqual({ type: 'api_key', key: 'second-independent' });
    } finally {
      await profiles?.close();
      await first.close();
      await second.close();
    }
  });
});
