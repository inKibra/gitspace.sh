import type {
  AvailableModel,
  ProviderAccount,
  ProviderLoginEvent,
  ProviderUsage,
  ProviderUsageLimit,
  ProviderUsageReport,
  ProviderView,
} from '@gitspace/protocol';
import {
  PROVIDER_REGISTRY,
  getOAuthProviders,
  listProvidersWithEnvKey,
  resolveUsedFraction,
  type AuthStorage,
  type CredentialOrigin,
  type DisabledCredentialSummary,
  type OAuthAuthInfo,
  type OAuthLoginIdentity,
  type OAuthPrompt,
  type StoredAuthCredential,
  type UsageLimit,
  type UsageReport,
} from '@oh-my-pi/pi-ai';
import { resolveCredentialIdentityKey } from '@oh-my-pi/pi-ai/auth/sqlite-credential-store';
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry';
import { discoverAuthStorage } from '@oh-my-pi/pi-coding-agent/session/auth-broker-config';
import { collectUnreportedAccounts, type UsageAccountIdentity } from '@oh-my-pi/pi-coding-agent/cli/usage-cli';

/** Callbacks handed to `AuthStorage.login`; the coordinator turns them into stream events. */
export interface ProviderLoginController {
  signal: AbortSignal;
  onAuth(info: OAuthAuthInfo): void;
  onProgress(message: string): void;
  onPrompt(prompt: OAuthPrompt): Promise<string>;
  onManualCodeInput(): Promise<string>;
}

/** The slice of OMP's `AuthStorage` the coordinator depends on (test seam). */
export interface AuthStorageLike {
  hasAuth(provider: string): boolean;
  getCredentialOrigin(provider: string): CredentialOrigin | undefined;
  listStoredCredentials(provider?: string): StoredAuthCredential[];
  listDisabledCredentials(provider?: string): Promise<DisabledCredentialSummary[]>;
  usageProviderFor(provider: string): unknown;
  login(provider: string, ctrl: ProviderLoginController): Promise<OAuthLoginIdentity | undefined>;
  logout(provider: string): Promise<void>;
  removeCredential(provider: string, credentialId: number): Promise<boolean>;
  set(provider: string, credential: { type: 'api_key'; key: string }): Promise<void>;
  fetchUsageReports(): Promise<UsageReport[] | null>;
  invalidateUsageCache(provider?: string): Promise<void>;
}

export interface ProviderAuthCoordinatorOptions {
  /** Machine credential storage; OMP children independently discover this same backing store. */
  authStorage: () => Promise<AuthStorageLike>;
  onChanged?: () => Promise<void>;
}

export class ProviderAuthError extends Error {
  constructor(readonly operation: string, message: string) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}

/**
 * One `discoverAuthStorage(agentDir)` per machine process, resolved on first use so a
 * misconfigured auth broker surfaces on the first provider/session call instead of at boot.
 */
export function sharedAuthStorage(agentDir: string): () => Promise<AuthStorage> {
  let storage: Promise<AuthStorage> | null = null;
  return () => {
    storage ??= discoverAuthStorage(agentDir).catch((error: unknown) => {
      storage = null;
      throw error;
    });
    return storage;
  };
}

/** Finished flows stay replayable this long so a subscriber that races `done` still sees it. */
const FINISHED_FLOW_RETENTION_MS = 60_000;

interface LoginFlow {
  id: string;
  providerId: string;
  controller: AbortController;
  events: ProviderLoginEvent[];
  done: boolean;
  wake: Set<() => void>;
  prompts: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>;
}

interface ProviderDescriptor {
  id: string;
  name: string;
  available: boolean;
  loginable: boolean;
  /** Provider id credentials are stored under (`storeCredentialsAs`), when it differs. */
  credentialProvider: string;
  /** Registry declares a grant-refreshing or browser-redirect flow. */
  browserFlow: boolean;
  hasLogin: boolean;
}

function describeProviders(): ProviderDescriptor[] {
  const loginable = new Map(getOAuthProviders().map((info) => [info.id, info]));
  const envKeyed = new Set(listProvidersWithEnvKey());
  const descriptors: ProviderDescriptor[] = PROVIDER_REGISTRY.map((definition) => {
    const login = loginable.get(definition.id);
    return {
      id: definition.id,
      name: definition.name,
      available: login?.available ?? definition.available ?? true,
      loginable: login !== undefined,
      credentialProvider: definition.storeCredentialsAs ?? definition.id,
      browserFlow: definition.refreshToken !== undefined || definition.callbackPort !== undefined || definition.pasteCodeFlow === true,
      hasLogin: definition.login !== undefined || envKeyed.has(definition.id),
    };
  });
  const known = new Set(descriptors.map((descriptor) => descriptor.id));
  for (const info of loginable.values()) {
    if (known.has(info.id)) continue;
    descriptors.push({
      id: info.id,
      name: info.name,
      available: info.available,
      loginable: true,
      credentialProvider: info.storeCredentialsAs ?? info.id,
      browserFlow: false,
      hasLogin: true,
    });
  }
  return descriptors;
}

function oauthAccountLabel(account: { email?: string; accountId?: string; orgId?: string; orgName?: string }): string {
  const base = account.email ?? account.accountId ?? 'OAuth account';
  const org = account.orgName ?? account.orgId;
  return org && org !== base ? `${base} · ${org}` : base;
}

function storedAccount(row: StoredAuthCredential): ProviderAccount {
  const { credential } = row;
  return credential.type === 'oauth'
    ? {
        id: String(row.id),
        type: 'oauth',
        label: oauthAccountLabel(credential),
        email: credential.email ?? null,
        disabled: row.disabledCause !== null,
      }
    : {
        id: String(row.id),
        type: 'api_key',
        label: credential.source === 'login' ? 'API key (sign-in)' : 'API key',
        email: null,
        disabled: row.disabledCause !== null,
      };
}

/**
 * Surface automatically disabled OAuth accounts, unless that credential identity is signed in again.
 * Use the credential store's organization-aware identity rules, not an email-only match.
 */
function actionableTombstone(summary: DisabledCredentialSummary, active: readonly StoredAuthCredential[]): boolean {
  if (summary.type !== 'oauth' || /^(replaced by|deleted by user)/i.test(summary.cause)) return false;
  // Tombstones retain identity metadata only; the resolver never reads token fields.
  const identity = resolveCredentialIdentityKey(summary.provider, { ...summary, type: 'oauth', access: '', refresh: '', expires: 0 });
  return !active.some(({ id, credential }) =>
    id === summary.id
    || (identity !== null && resolveCredentialIdentityKey(summary.provider, credential) === identity),
  );
}

function reportAccount(report: UsageReport): string | null {
  const metadata = report.metadata ?? {};
  for (const key of ['email', 'accountId', 'projectId'] as const) {
    const value = metadata[key];
    if (typeof value === 'string' && value) return value;
  }
  for (const limit of report.limits) {
    const scoped = limit.scope.accountId ?? limit.scope.projectId;
    if (scoped) return scoped;
  }
  return null;
}

function usageLimitView(limit: UsageLimit): ProviderUsageLimit {
  const { amount, window, scope } = limit;
  const usedFraction = resolveUsedFraction(limit);
  const remainingFraction = amount.remainingFraction ?? (usedFraction === undefined ? null : Math.max(0, 1 - usedFraction));
  return {
    id: limit.id,
    label: limit.label,
    scope: scope.tier ?? scope.modelId ?? (scope.shared ? 'shared' : 'account'),
    window: window?.label ?? scope.windowId ?? null,
    unit: amount.unit,
    used: amount.used ?? null,
    limit: amount.limit ?? null,
    remaining: amount.remaining ?? null,
    remainingFraction,
    resetsAt: window?.resetsAt === undefined ? null : new Date(window.resetsAt).toISOString(),
    status: limit.status ?? null,
  };
}

function usageReportView(report: UsageReport): ProviderUsageReport {
  return {
    provider: report.provider,
    account: reportAccount(report),
    fetchedAt: new Date(report.fetchedAt).toISOString(),
    limits: report.limits.map(usageLimitView),
    notes: report.notes ?? [],
  };
}

function usageAccountIdentity(row: StoredAuthCredential): UsageAccountIdentity {
  const { credential } = row;
  if (credential.type !== 'oauth') return { provider: row.provider, type: 'api_key' };
  return {
    provider: row.provider,
    type: 'oauth',
    email: credential.email,
    accountId: credential.accountId,
    projectId: credential.projectId,
    enterpriseUrl: credential.enterpriseUrl,
    orgId: credential.orgId,
    orgName: credential.orgName,
    authorizedAt: credential.authorizedAt,
  };
}

function usageAccountLabel(account: UsageAccountIdentity): string {
  const identity = account.email ?? account.accountId ?? account.projectId ?? (account.type === 'oauth' ? 'OAuth account' : 'API key');
  return `${account.provider}: ${identity}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export class ProviderAuthCoordinator {
  readonly #authStorage: () => Promise<AuthStorageLike>;
  readonly #flows = new Map<string, LoginFlow>();
  #descriptors: ProviderDescriptor[] | null = null;
  readonly #onChanged: (() => Promise<void>) | undefined;

  constructor(options: ProviderAuthCoordinatorOptions) {
    this.#authStorage = options.authStorage;
    this.#onChanged = options.onChanged;
  }

  /** Models runnable on this machine right now: the OMP catalog narrowed to authenticated providers. */
  async models(): Promise<AvailableModel[]> {
    const storage = await this.#authStorage();
    const registry = new ModelRegistry(storage as AuthStorage);
    return registry.getAvailable().map((model) => ({ provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow ?? null }));
  }

  async list(): Promise<ProviderView[]> {
    const storage = await this.#authStorage();
    const disabled = await this.#disabledCredentials(storage);
    return this.#descriptorList().map((descriptor) => this.#view(storage, descriptor, disabled));
  }

  async view(providerId: string): Promise<ProviderView> {
    const storage = await this.#authStorage();
    const descriptor = this.#descriptor(providerId);
    return this.#view(storage, descriptor, await this.#disabledCredentials(storage, descriptor.credentialProvider));
  }

  async startLogin(providerId: string): Promise<string> {
    const descriptor = this.#descriptor(providerId);
    if (!descriptor.loginable) throw new ProviderAuthError('start provider login', `Provider ${providerId} has no interactive sign-in`);
    const flow: LoginFlow = {
      id: crypto.randomUUID(),
      providerId,
      controller: new AbortController(),
      events: [],
      done: false,
      wake: new Set(),
      prompts: new Map(),
    };
    this.#flows.set(flow.id, flow);
    void this.#runLogin(flow);
    return flow.id;
  }

  /** Replays buffered events, then live ones, until `done`; throws synchronously for an unknown flow. */
  events(flowId: string, signal?: AbortSignal): AsyncIterable<ProviderLoginEvent> {
    const flow = this.#flow(flowId, 'subscribe to provider login');
    return (async function* () {
      let cursor = 0;
      while (!signal?.aborted) {
        if (cursor < flow.events.length) {
          const event = flow.events[cursor++]!;
          yield event;
          if (event.type === 'done') return;
          continue;
        }
        if (flow.done) return;
        await new Promise<void>((resolve) => {
          flow.wake.add(resolve);
          signal?.addEventListener('abort', () => { flow.wake.delete(resolve); resolve(); }, { once: true });
        });
      }
    })();
  }

  async respond(flowId: string, promptId: string, value: string): Promise<void> {
    const flow = this.#flow(flowId, 'respond to provider login');
    const pending = flow.prompts.get(promptId);
    if (!pending) throw new ProviderAuthError('respond to provider login', `Login flow ${flowId} has no open prompt ${promptId}`);
    flow.prompts.delete(promptId);
    pending.resolve(value);
  }

  async cancel(flowId: string): Promise<void> {
    const flow = this.#flow(flowId, 'cancel provider login');
    if (flow.done) return;
    flow.controller.abort(new ProviderAuthError('cancel provider login', 'Login cancelled'));
    for (const [promptId, pending] of flow.prompts) {
      flow.prompts.delete(promptId);
      pending.reject(new ProviderAuthError('cancel provider login', 'Login cancelled'));
    }
  }

  async logout(providerId: string, credentialId: string | null): Promise<ProviderView> {
    const descriptor = this.#descriptor(providerId);
    const storage = await this.#authStorage();
    if (credentialId === null) {
      await storage.logout(descriptor.credentialProvider);
    } else {
      const numeric = Number(credentialId);
      const removed = Number.isInteger(numeric) && await storage.removeCredential(descriptor.credentialProvider, numeric);
      if (!removed) throw new ProviderAuthError('sign out provider', `Provider ${providerId} has no credential ${credentialId}`);
    }
    await this.#onChanged?.();
    return this.view(providerId);
  }

  async setApiKey(providerId: string, key: string): Promise<ProviderView> {
    const descriptor = this.#descriptor(providerId);
    const trimmed = key.trim();
    if (!trimmed) throw new ProviderAuthError('set provider API key', 'API key must not be empty');
    const storage = await this.#authStorage();
    await storage.set(descriptor.credentialProvider, { type: 'api_key', key: trimmed });
    await this.#onChanged?.();
    return this.view(providerId);
  }

  async usage(providerId: string | null, refresh: boolean): Promise<ProviderUsage> {
    const storage = await this.#authStorage();
    const errors: Array<{ provider: string; message: string }> = [];
    const scope = providerId ?? '*';
    if (refresh) {
      try {
        await storage.invalidateUsageCache(providerId ?? undefined);
      } catch (error) {
        errors.push({ provider: scope, message: errorMessage(error, 'Unable to invalidate cached usage') });
      }
    }
    let reports: UsageReport[] = [];
    try {
      reports = (await storage.fetchUsageReports()) ?? [];
    } catch (error) {
      errors.push({ provider: scope, message: errorMessage(error, 'Unable to fetch provider usage') });
    }
    if (providerId !== null) reports = reports.filter((report) => report.provider === providerId);
    const accounts = storage
      .listStoredCredentials()
      .filter((row) => (providerId === null ? storage.usageProviderFor(row.provider) !== undefined : row.provider === providerId))
      .map(usageAccountIdentity);
    return {
      generatedAt: new Date().toISOString(),
      reports: reports.map(usageReportView),
      accountsWithoutUsage: collectUnreportedAccounts(reports, accounts).map(usageAccountLabel),
      errors,
    };
  }

  #descriptorList(): ProviderDescriptor[] {
    this.#descriptors ??= describeProviders();
    return this.#descriptors;
  }

  #descriptor(providerId: string): ProviderDescriptor {
    const descriptor = this.#descriptorList().find((candidate) => candidate.id === providerId);
    if (!descriptor) throw new ProviderAuthError('resolve provider', `Unknown provider: ${providerId}`);
    return descriptor;
  }

  #flow(flowId: string, operation: string): LoginFlow {
    const flow = this.#flows.get(flowId);
    if (!flow) throw new ProviderAuthError(operation, `Unknown login flow: ${flowId}`);
    return flow;
  }

  async #disabledCredentials(storage: AuthStorageLike, provider?: string): Promise<DisabledCredentialSummary[]> {
    try {
      return await storage.listDisabledCredentials(provider);
    } catch {
      // Tombstones are advisory; a broker without the endpoint must not hide the provider list.
      return [];
    }
  }

  #view(storage: AuthStorageLike, descriptor: ProviderDescriptor, disabled: readonly DisabledCredentialSummary[]): ProviderView {
    const provider = descriptor.credentialProvider;
    const stored = storage.listStoredCredentials(provider);
    const origin = storage.getCredentialOrigin(provider);
    return {
      id: descriptor.id,
      credentialProvider: provider,
      name: descriptor.name,
      available: descriptor.available,
      loginable: descriptor.loginable,
      authKind: authKind(descriptor, stored, origin),
      hasAuth: storage.hasAuth(provider),
      source: origin?.kind ?? null,
      accounts: [
        ...stored.map(storedAccount),
        ...disabled
          .filter((summary) => summary.provider === provider && actionableTombstone(summary, stored))
          .map((summary) => ({
            id: String(summary.id),
            type: 'oauth' as const,
            label: oauthAccountLabel(summary),
            email: summary.email ?? null,
            disabled: true,
          })),
      ],
      hasUsage: storage.usageProviderFor(provider) !== undefined,
    };
  }

  #push(flow: LoginFlow, event: ProviderLoginEvent): void {
    if (flow.done) return;
    flow.events.push(event);
    if (event.type === 'done') {
      flow.done = true;
      for (const pending of flow.prompts.values()) pending.reject(new ProviderAuthError('provider login', 'Login finished'));
      flow.prompts.clear();
      setTimeout(() => this.#flows.delete(flow.id), FINISHED_FLOW_RETENTION_MS).unref();
    }
    const waiters = [...flow.wake];
    flow.wake.clear();
    for (const wake of waiters) wake();
  }

  #prompt(flow: LoginFlow, prompt: OAuthPrompt): Promise<string> {
    if (flow.controller.signal.aborted) return Promise.reject(new ProviderAuthError('provider login', 'Login cancelled'));
    const promptId = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      flow.prompts.set(promptId, { resolve, reject });
      this.#push(flow, { type: 'prompt', promptId, message: prompt.message, placeholder: prompt.placeholder ?? null });
    });
  }

  async #runLogin(flow: LoginFlow): Promise<void> {
    try {
      const storage = await this.#authStorage();
      await storage.login(flow.providerId, {
        signal: flow.controller.signal,
        onAuth: (info) => this.#push(flow, { type: 'auth', url: info.url, launchUrl: info.launchUrl ?? null, instructions: info.instructions ?? null }),
        onProgress: (message) => this.#push(flow, { type: 'progress', message }),
        onPrompt: (prompt) => this.#prompt(flow, prompt),
        // The browser may be on a different host. OMP races this supported paste
        // fallback against its local callback; `done` retires any unanswered prompt.
        onManualCodeInput: () => this.#prompt(flow, { message: 'Paste the authorization code or full redirect URL' }),
      });
      await this.#onChanged?.();
      this.#push(flow, { type: 'done', ok: true, provider: await this.view(flow.providerId) });
    } catch (error) {
      const message = flow.controller.signal.aborted ? 'Login cancelled' : errorMessage(error, 'Login failed');
      this.#push(flow, { type: 'done', ok: false, error: message });
    }
  }
}

function authKind(descriptor: ProviderDescriptor, stored: readonly StoredAuthCredential[], origin: CredentialOrigin | undefined): ProviderView['authKind'] {
  if (origin?.kind === 'oauth' || stored.some((row) => row.credential.type === 'oauth')) return 'oauth';
  if (descriptor.browserFlow) return 'oauth';
  if (descriptor.hasLogin || origin !== undefined) return 'api_key';
  return 'none';
}
