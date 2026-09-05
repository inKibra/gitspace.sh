import { describe, expect, it } from 'bun:test';
import type {
  CredentialOrigin,
  DisabledCredentialSummary,
  OAuthLoginIdentity,
  StoredAuthCredential,
  UsageReport,
} from '@oh-my-pi/pi-ai';
import type { ProviderLoginEvent } from '@gitspace/protocol';
import { ProviderAuthCoordinator, ProviderAuthError, type AuthStorageLike, type ProviderLoginController } from '../src/provider-auth.js';

interface FakeAuthStorageOptions {
  credentials?: StoredAuthCredential[];
  disabled?: DisabledCredentialSummary[];
  usageProviders?: string[];
  reports?: UsageReport[] | (() => Promise<UsageReport[] | null>);
  login?: (provider: string, ctrl: ProviderLoginController, storage: FakeAuthStorage) => Promise<OAuthLoginIdentity | undefined>;
}

class FakeAuthStorage implements AuthStorageLike {
  credentials: StoredAuthCredential[];
  readonly disabled: DisabledCredentialSummary[];
  readonly invalidated: Array<string | undefined> = [];
  readonly apiKeys: Array<{ provider: string; key: string }> = [];
  readonly loggedOut: string[] = [];
  #nextId = 100;

  constructor(private readonly options: FakeAuthStorageOptions = {}) {
    this.credentials = options.credentials ?? [];
    this.disabled = options.disabled ?? [];
  }

  addOAuth(provider: string, email: string): void {
    this.credentials.push({
      id: this.#nextId++,
      provider,
      credential: { type: 'oauth', refresh: 'r', access: 'a', expires: Date.now() + 60_000, email },
      disabledCause: null,
    });
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
  }

  async removeCredential(provider: string, credentialId: number): Promise<boolean> {
    const before = this.credentials.length;
    this.credentials = this.credentials.filter((row) => !(row.provider === provider && row.id === credentialId));
    return this.credentials.length !== before;
  }

  async set(provider: string, credential: { type: 'api_key'; key: string }): Promise<void> {
    this.apiKeys.push({ provider, key: credential.key });
    this.credentials = this.credentials.filter((row) => row.provider !== provider);
    this.credentials.push({ id: this.#nextId++, provider, credential, disabledCause: null });
  }

  async fetchUsageReports(): Promise<UsageReport[] | null> {
    const { reports } = this.options;
    if (typeof reports === 'function') return reports();
    return reports ?? [];
  }

  async invalidateUsageCache(provider?: string): Promise<void> {
    this.invalidated.push(provider);
  }
}

function coordinator(storage: FakeAuthStorage): ProviderAuthCoordinator {
  return new ProviderAuthCoordinator({ authStorage: async () => storage });
}

async function collect(events: AsyncIterable<ProviderLoginEvent>, until: (event: ProviderLoginEvent) => boolean): Promise<ProviderLoginEvent[]> {
  const seen: ProviderLoginEvent[] = [];
  for await (const event of events) {
    seen.push(event);
    if (until(event)) break;
  }
  return seen;
}

describe('ProviderAuthCoordinator.list', () => {
  it('maps registry providers with stored credentials, disabled tombstones, origin and usage support', async () => {
    const storage = new FakeAuthStorage({
      credentials: [
        { id: 1, provider: 'anthropic', credential: { type: 'oauth', refresh: 'r', access: 'a', expires: 1, email: 'me@example.com', orgName: 'Acme' }, disabledCause: null },
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
    expect(usage.errors).toEqual([]);
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
  });

  it('turns a failed fetch into an error entry instead of throwing', async () => {
    const storage = new FakeAuthStorage({ credentials, usageProviders: ['anthropic'], reports: async () => { throw new Error('broker offline'); } });
    const usage = await coordinator(storage).usage(null, true);
    expect(storage.invalidated).toEqual([undefined]);
    expect(usage.reports).toEqual([]);
    expect(usage.errors).toEqual([{ provider: '*', message: 'broker offline' }]);
    expect(usage.accountsWithoutUsage).toEqual(['anthropic: a@example.com']);
  });
});
