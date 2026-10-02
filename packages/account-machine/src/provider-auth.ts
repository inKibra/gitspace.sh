import type {
  AvailableModel,
  InferenceExecutionContext,
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
  type CredentialHealthResult,
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
import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry';
import { createManagedInference } from '../../account-omp/src/inference.js';
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
  getGeneration(): number;
  revalidateCredentials(): Promise<void>;
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
  checkCredentials(): Promise<CredentialHealthResult[]>;
  invalidateUsageCache(provider?: string): Promise<void>;
}

export interface ProviderAuthCoordinatorOptions {
  profileId: string;
  /** Storage belongs to exactly one profile; there is no machine-global credential inventory. */
  authStorage: () => Promise<AuthStorageLike>;
  modelRegistry: () => Promise<Pick<ModelRegistry, 'getAvailable'>>;
  onChanged?: () => Promise<void>;
}

export class ProviderAuthError extends Error {
  constructor(readonly operation: string, message: string) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}

export interface ProviderManagementContext {
  authStorage: AuthStorageLike;
  modelRegistry: Pick<ModelRegistry, 'getAvailable'>;
  close(): void;
}

/** Profile identity owns the coordinator, including in-flight OAuth callbacks and usage state. */
export class ProfileProviderAuthCoordinator {
  readonly #profiles = new Map<string, {
    coordinator: ProviderAuthCoordinator;
    context: InferenceExecutionContext;
    managed: Promise<ProviderManagementContext>;
    publishBundle: boolean;
  }>();
  readonly #managed = new Set<Promise<ProviderManagementContext>>();

  constructor(private readonly options: {
    agentDir: string;
    cwd: string;
    resolve(profileId: string): Promise<InferenceExecutionContext>;
    createContext?(context: InferenceExecutionContext): Promise<ProviderManagementContext>;
    onChanged?(profileId: string): Promise<void>;
  }) {}

  async forProfile(profileId: string): Promise<ProviderAuthCoordinator> {
    if (!profileId) throw new ProviderAuthError('resolve inference profile', 'Select an inference profile before managing providers');
    // Recheck canonical authority even when a local coordinator already exists.
    const context = structuredClone(await this.options.resolve(profileId));
    if (context.profile.id !== profileId || context.projectId !== null || context.assignmentRevision !== null) {
      throw new ProviderAuthError('resolve inference profile', 'Provider management requires the requested profile management scope');
    }
    let entry = this.#profiles.get(profileId);
    if (!entry) {
      const managed = this.createContext(context);
      entry = {
        context,
        managed,
        publishBundle: false,
        coordinator: new ProviderAuthCoordinator({
          profileId,
          authStorage: async () => (await this.#profiles.get(profileId)!.managed).authStorage,
          modelRegistry: async () => (await this.#profiles.get(profileId)!.managed).modelRegistry,
          onChanged: () => this.options.onChanged?.(profileId) ?? Promise.resolve(),
        }),
      };
      this.#profiles.set(profileId, entry);
    } else if (entry.context.profile.revision !== context.profile.revision
      || entry.context.advanced.generation !== context.advanced.generation
      || entry.context.broker.url !== context.broker.url
      || entry.context.broker.token !== context.broker.token) {
      entry.context = context;
      entry.managed = this.createContext(context);
      entry.publishBundle = true;
    }
    try { await entry.managed; }
    catch (error) { this.#profiles.delete(profileId); throw error; }
    if (entry.publishBundle) {
      await this.options.onChanged?.(profileId);
      entry.publishBundle = false;
    }
    return entry.coordinator;
  }

  private createContext(context: InferenceExecutionContext): Promise<ProviderManagementContext> {
    const managed = this.options.createContext?.(context)
      ?? createManagedInference(context, { agentDir: this.options.agentDir, cwd: this.options.cwd });
    // Retired contexts may still own an OAuth callback. Keep that scope alive until
    // shutdown rather than closing storage out from under an accepted login.
    this.#managed.add(managed);
    return managed;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#profiles.values()].map((entry) => entry.coordinator.dispose()));
    await Promise.all([...this.#managed].map((managed) => managed.then((value) => value.close(), () => undefined)));
    this.#managed.clear();
    this.#profiles.clear();
  }
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
  readonly profileId: string;
  readonly #authStorage: () => Promise<AuthStorageLike>;
  readonly #modelRegistry: () => Promise<Pick<ModelRegistry, 'getAvailable'>>;
  readonly #flows = new Map<string, LoginFlow>();
  #descriptors: ProviderDescriptor[] | null = null;
  readonly #onChanged: (() => Promise<void>) | undefined;
  #refreshingAuth: Promise<AuthStorageLike> | null = null;
  #publishedGeneration: number | null = null;

  constructor(options: ProviderAuthCoordinatorOptions) {
    if (!options.profileId) throw new ProviderAuthError('initialize provider management', 'An explicit inference profile is required');
    this.profileId = options.profileId;
    this.#authStorage = options.authStorage;
    this.#modelRegistry = options.modelRegistry;
    this.#onChanged = options.onChanged;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#flows.values()].filter((flow) => !flow.done).map((flow) => this.cancel(flow.id)));
  }

  #currentAuthStorage(): Promise<AuthStorageLike> {
    this.#refreshingAuth ??= (async () => {
      const storage = await this.#authStorage();
      this.#publishedGeneration ??= storage.getGeneration();
      // Cloud writes bypass this coordinator; re-reading its old AuthStorage is not a refresh.
      await storage.revalidateCredentials();
      await this.#publishAuthChanges(storage);
      return storage;
    })().finally(() => { this.#refreshingAuth = null; });
    return this.#refreshingAuth;
  }

  async #publishAuthChanges(storage: AuthStorageLike): Promise<void> {
    const generation = storage.getGeneration();
    if (generation === this.#publishedGeneration) return;
    await this.#onChanged?.();
    // A failed child reload must be retried even when our own cache is already current.
    this.#publishedGeneration = generation;
  }

  /** Models runnable on this machine right now: the OMP catalog narrowed to authenticated providers. */
  async models(): Promise<AvailableModel[]> {
    const storage = await this.#currentAuthStorage();
    const registry = await this.#modelRegistry();
    return registry.getAvailable().filter((model) => storage.hasAuth(model.provider)).map((model) => ({ provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow ?? null }));
  }

  async list(): Promise<ProviderView[]> {
    const storage = await this.#currentAuthStorage();
    const disabled = await this.#disabledCredentials(storage);
    return this.#descriptorList().map((descriptor) => this.#view(storage, descriptor, disabled));
  }

  async view(providerId: string): Promise<ProviderView> {
    const storage = await this.#currentAuthStorage();
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
    const storage = await this.#currentAuthStorage();
    if (credentialId === null) {
      await storage.logout(descriptor.credentialProvider);
    } else {
      const numeric = Number(credentialId);
      const removed = Number.isInteger(numeric) && await storage.removeCredential(descriptor.credentialProvider, numeric);
      if (!removed) throw new ProviderAuthError('sign out provider', `Provider ${providerId} has no credential ${credentialId}`);
    }
    await this.#publishAuthChanges(storage);
    return this.view(providerId);
  }

  async setApiKey(providerId: string, key: string): Promise<ProviderView> {
    const descriptor = this.#descriptor(providerId);
    const trimmed = key.trim();
    if (!trimmed) throw new ProviderAuthError('set provider API key', 'API key must not be empty');
    const storage = await this.#currentAuthStorage();
    await storage.set(descriptor.credentialProvider, { type: 'api_key', key: trimmed });
    await this.#publishAuthChanges(storage);
    return this.view(providerId);
  }

  async usage(providerId: string | null, refresh: boolean): Promise<ProviderUsage> {
    const storage = await this.#currentAuthStorage();
    const errors: Array<{ provider: string; message: string }> = [];
    const aggregateErrors: Array<{ provider: string; message: string }> = [];
    const scope = providerId ?? '*';
    if (refresh) {
      try {
        await storage.invalidateUsageCache(providerId ?? undefined);
      } catch (error) {
        aggregateErrors.push({ provider: scope, message: errorMessage(error, 'Unable to invalidate cached usage') });
      }
    }
    let reports: UsageReport[] = [];
    try {
      reports = (await storage.fetchUsageReports()) ?? [];
    } catch (error) {
      aggregateErrors.push({ provider: '*', message: errorMessage(error, 'Unable to fetch provider usage') });
    }
    if (providerId !== null) reports = reports.filter((report) => report.provider === providerId);
    const rows = storage
      .listStoredCredentials()
      .filter((row) => (providerId === null ? storage.usageProviderFor(row.provider) !== undefined : row.provider === providerId));
    const accounts = rows.map(usageAccountIdentity);
    let unreported = new Set(collectUnreportedAccounts(reports, accounts));
    const missingRows = rows.filter((row, index) => unreported.has(accounts[index]!) && storage.usageProviderFor(row.provider) !== undefined);
    const reasons = new Map<number, string>();
    if (missingRows.length > 0) {
      try {
        // A broker's egress can be refused while the same credential works on
        // this machine. OMP probes its existing usage providers locally and
        // still refreshes OAuth through the discovered credential store.
        const health = new Map((await storage.checkCredentials()).map((result) => [result.id, result]));
        const recovered: UsageReport[] = [];
        for (const row of missingRows) {
          const result = health.get(row.id);
          if (result?.provider !== row.provider) continue;
          if (result.ok === true && result.report?.provider === row.provider) {
            // Diagnostic reports omit identity metadata that aggregate usage
            // normally supplies; retain the probed credential's attribution.
            const metadata = { ...result.report.metadata };
            for (const key of ['email', 'accountId', 'orgId'] as const) {
              if (!metadata[key] && result[key]) metadata[key] = result[key];
            }
            recovered.push({ ...result.report, metadata });
          } else if (result.reason) reasons.set(row.id, result.reason);
        }
        // The aggregate may be an OMP cache entry; never mutate its array.
        if (recovered.length > 0) reports = reports.concat(recovered);
      } catch (error) {
        errors.push({ provider: '*', message: errorMessage(error, 'Unable to check missing provider usage') });
      }
      unreported = new Set(collectUnreportedAccounts(reports, accounts));
    }
    if (unreported.size > 0 || missingRows.length === 0) errors.unshift(...aggregateErrors);
    for (const [index, row] of rows.entries()) {
      const account = accounts[index]!;
      if (!unreported.has(account)) continue;
      const reason = reasons.get(row.id);
      if (!reason && errors.some((error) => error.provider === '*')) continue;
      const message = reason ?? (storage.usageProviderFor(account.provider) === undefined
        ? 'This provider has no usage reporting endpoint.'
        : 'OMP returned no usage data. Refresh usage; if it remains unavailable, check this account’s provider sign-in and auth broker.');
      errors.push({ provider: account.provider, message: `${usageAccountLabel(account)}: ${message}` });
    }
    return {
      generatedAt: new Date().toISOString(),
      reports: reports.map(usageReportView),
      accountsWithoutUsage: [...unreported].map(usageAccountLabel),
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
      const storage = await this.#currentAuthStorage();
      await storage.login(flow.providerId, {
        signal: flow.controller.signal,
        onAuth: (info) => this.#push(flow, { type: 'auth', url: info.url, launchUrl: info.launchUrl ?? null, instructions: info.instructions ?? null }),
        onProgress: (message) => this.#push(flow, { type: 'progress', message }),
        onPrompt: (prompt) => this.#prompt(flow, prompt),
        // The browser may be on a different host. OMP races this supported paste
        // fallback against its local callback; `done` retires any unanswered prompt.
        onManualCodeInput: () => this.#prompt(flow, { message: 'Paste the authorization code or full redirect URL' }),
      });
      await this.#publishAuthChanges(storage);
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
