import { createModels, lazyStream, type Api, type Model, type Context, type TranscriptContext, type ApiStreamOptions, type ModelsApiStreamOptions, type AnyModel, type Models, type ModelsStore, type Provider, type AuthResult, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type AssistantImages, type ClassifierResult } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { isModelType } from '@earendil-works/pi-ai';
import type { Credential, ProviderResponse } from '@earendil-works/pi-ai';
import { limitContextWindows } from './catalog.js';
import { classifyAuthFailure, orderedAccounts, providerResetAt, type VaultAccess, type CredentialAccount, type CredentialPins, type ResolvedCredential } from './selection.js';
import { contextWindowLimits } from './admission.js';
import { attemptOptions, createAttemptRunner, inferenceProviderSource, noAmbientAuth, profileProviders, requestAuth, type AttemptRunner, type InferenceAttempt } from './attempts.js';
import { fitRequestImages, imageLimits } from './image-limits.js';
import type { InferenceProfile } from '@gitspace/protocol/inference';
import { fastServingProvider } from './fast.js';
import { claudeCode } from './claude-code-request.js';
import type { RequestGate, RequestPermit } from './request-gate.js';
export * from './selection.js';
export * from './catalog.js';
export * from './admission.js';
export * from './models-store.js';
export * from './run-models.js';
export * from './helpers.js';
export * from './published-catalog.js';
export * from './vision.js';
export * from './request-gate.js';
export * from './image-requests.js';
export * from './attempts.js';
export { claudeCode, XxHash64, type ClaudeCodeTransport } from './claude-code-request.js';
export { imageDimensions } from './image-limits.js';

export type VaultModelsOptions = {
  profileId: string;
  /** Every conversation of a workspace starts on the same account; see `orderedAccounts`. */
  workspaceId: string;
  vault: VaultAccess;
  pins: CredentialPins;
  modelsStore: ModelsStore;
  providers?: readonly Provider[];
  settings?: InferenceProfile['settings'];
  /** The workspace object's gate, shared by all of its catalogs: every attempt holds a permit while it builds and
   * uploads its body. */
  gate: RequestGate;
  /** Where each request attempt is built and sent: in a workspace, the inference worker, so the object holds neither
   * request bodies nor images; in this isolate by default (`createAttemptRunner`). */
  run?: AttemptRunner;
};
/** What one admitted request adds to its profile's catalog. A pinned model resolves as it was admitted even after the
 * catalog changes or drops it. */
export type VaultModelsScope = { pins: CredentialPins; fastMode?: boolean; pinnedModels?: readonly AnyModel[] };
/** A profile's catalog (served with `pins`, never in fast mode) and the views its requests share it through. */
export type VaultModels = Models & {
  /** A view of this catalog for one request: its own credential pins, serving mode, Claude Code session and pinned
   * models. Provider data, the published-catalog overlay and refreshes stay this catalog's. */
  scope(request: VaultModelsScope): Promise<Models>;
};
/** One request on one account. It reports the provider's answer, error statuses included (pi's `onResponse` misses a
 * rejected Anthropic request), so a failure knows the provider's reset. It holds a gate permit from before its body is
 * built until the provider answers (`fetch` settles, or the runner reports the response); `release` frees it sooner. */
type Attempt = { fetch: typeof fetch; observe(response: ProviderResponse): void; release(): void; status?: number; headers: Readonly<Record<string, string>> };
const credentialHeader = /^(?:authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|x-amz-security-token|cookie|host|chatgpt-account-id)$/iu;

function rejectOverrides(options: unknown): void {
  if (!options || typeof options !== 'object') return;
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (['apiKey', 'env', 'fetch', 'transformHeaders', 'credentials', 'profile', 'bearerToken', 'baseUrl', 'onPayload', 'client', 'region', 'project', 'location', 'endpoint'].includes(key)) throw new Error(`Profile-managed inference forbids request override ${key}`);
    if (key === 'headers' && value && typeof value === 'object' && Object.keys(value).some(name => credentialHeader.test(name))) throw new Error('Profile-managed inference forbids credential headers');
    if (key === 'providerOptions') rejectOverrides(value);
  }
}

/**
 * A Claude subscription request declares its whole current tool set up front instead of announcing mid-conversation
 * changes (`tool_addition`/`tool_removal` blocks, which pi-ai sends for models that support them). Every request
 * Anthropic refused as a third-party app's (billed to extra usage) carried 40 or more of those blocks, whatever its
 * size; Claude Code's own requests are not known to send them. A tool-set change then restarts the prompt cache.
 */
function subscriptionModel<T extends Api>(model: Model<T>): Model<T> {
  if (model.api !== 'anthropic-messages' || !model.compat || !('supportsMidConvoToolChanges' in model.compat) || !model.compat.supportsMidConvoToolChanges) return model;
  return { ...model, compat: { ...model.compat, supportsMidConvoToolChanges: false } };
}

export async function createVaultModels(options: VaultModelsOptions): Promise<VaultModels> {
  const settings = options.settings ?? {};
  const listed = profileProviders(settings, options.providers ?? inferenceProviderSource());
  const run = options.run ?? createAttemptRunner({ providers: () => listed });
  const catalog = (list: readonly Provider[]) => {
    const models = createModels({ authContext: noAmbientAuth, modelsStore: options.modelsStore });
    for (const provider of list) models.setProvider({ ...provider, auth: { apiKey: { name: 'Public catalog', resolve: async () => ({ auth: { apiKey: 'catalog-only' }, source: 'Public catalog' }) } } });
    return models;
  };
  // Every chat model carries the window its roles' context limits allow, published and pinned models too: roles are
  // resolved again over the catalog each refresh publishes.
  const limits = (list: readonly Provider[]) => contextWindowLimits(settings, catalog(list));
  let limit = limits(listed);
  const limited = (model: Model<Api>) => limit(model);
  const providers = listed.map(provider => limitContextWindows(provider, limited));
  const registry = catalog(providers);
  const refresh: Models['refresh'] = async request => {
    const enabled = [...new Set((await options.vault.list(options.profileId)).map(account => account.provider))];
    const result = await registry.refresh({ ...request, providers: enabled.filter(id => !request?.providers || request.providers.includes(id)) });
    limit = limits(listed);
    return result;
  };
  const rowKey = (model: AnyModel) => `${model.type ?? 'chat'}:${model.id}`;
  const rows = (provider: Provider): readonly AnyModel[] => provider.getAllModels?.() ?? provider.getModels();
  /** The providers a request lists: this catalog's, with each pinned model in place of the row it was admitted as. */
  function scopedProviders(pinnedModels: readonly AnyModel[]): readonly Provider[] {
    if (!pinnedModels.length) return providers;
    const pinned = listed.map(provider => {
      const own = pinnedModels.filter(model => model.provider === provider.id);
      if (!own.length) return provider;
      const all = () => {
        const merged = new Map(rows(provider).map(model => [rowKey(model), model]));
        for (const model of own) merged.set(rowKey(model), model);
        return [...merged.values()];
      };
      return { ...provider, getAllModels: all, getModels: () => all().filter(model => isModelType(model, 'chat')) };
    });
    // Roles resolve as they do over the catalog unless a pinned model has left it, when a limited role may resolve to it.
    const listedModel = (model: AnyModel) => { const provider = listed.find(candidate => candidate.id === model.provider); return !provider || rows(provider).some(row => rowKey(row) === rowKey(model)); };
    if (pinnedModels.every(listedModel)) return pinned.map((provider, index) => provider === listed[index] ? providers[index]! : limitContextWindows(provider, limited));
    const ownLimit = limits(pinned);
    return pinned.map(provider => limitContextWindows(provider, ownLimit));
  }
  /** The catalog as one request uses it: `list`'s models, dispatched with `pins` and Claude Code's request shape. */
  async function view(list: readonly Provider[], pins: CredentialPins, fastMode: boolean): Promise<Models> {
    // One Claude Code session per view, for every attempt it makes wherever it runs.
    const session = { profileId: options.profileId, sessionId: crypto.randomUUID() };
    const claude = await claudeCode(session);
    const cloudFetch = claude.fetch;
    const providerById = new Map(list.map(provider => [provider.id, provider]));
    /** Best-effort, as pi's registry: a provider whose listing throws lists nothing. */
    function listing<T>(provider: string | undefined, read: (entry: Provider) => readonly T[]): T[] {
      const entry = provider === undefined ? undefined : providerById.get(provider);
      if (provider !== undefined && !entry) return [];
      return (entry ? [entry] : list).flatMap(candidate => { try { return [...read(candidate)]; } catch { return []; } });
    }
    function canonical(model: AnyModel): void {
      const known = facade.getAllModels(model.provider).find(candidate => candidate.id === model.id && (candidate.type ?? 'chat') === (model.type ?? 'chat'));
      if (!known || JSON.stringify(known) !== JSON.stringify(model)) throw new Error(`Model ${model.provider}/${model.id} is not the canonical profile catalog model`);
      const provider = providerById.get(model.provider);
      if (!provider) throw new Error('Model provider is not admitted');
      const allowed = provider.filterAllModels
        ? provider.filterAllModels([known], undefined).length > 0
        : !isModelType(known, 'chat') || !provider.filterModels || provider.filterModels([known], undefined).length > 0;
      if (!allowed) throw new Error(`Model ${model.provider}/${model.id} is disabled in the inference profile`);
      if (model.provider === 'google-vertex') throw new Error('Ambient Google Vertex credentials are not admitted by inference profiles');
      if (model.headers && Object.keys(model.headers).some(name => credentialHeader.test(name))) throw new Error('Profile catalog contains credential headers');
    }
    async function resolveCredential(providerId: string, credentialId: string, forceRefresh = false, signal?: AbortSignal): Promise<ResolvedCredential> {
      signal?.throwIfAborted();
      const resolved = await options.vault.resolve({ profileId: options.profileId, credentialId, forceRefresh, ...(signal ? { signal } : {}) });
      if (resolved.id !== credentialId || resolved.provider !== providerId) throw new Error('Vault returned a different account scope');
      return resolved;
    }
    /** Each dispatch gets its own Models/auth object; concurrent accounts never share a credential slot. */
    async function bound(providerId: string, credentialId: string, forceRefresh = false, signal?: AbortSignal) {
      const resolved = await resolveCredential(providerId, credentialId, forceRefresh, signal);
      const provider = providerById.get(providerId);
      if (!provider) throw new Error(`Unknown provider ${providerId}`);
      const resolvedAuth = requestAuth(resolved);
      const models = createModels({ authContext: noAmbientAuth, modelsStore: options.modelsStore });
      models.setProvider({ ...(fastMode ? fastServingProvider(provider) : provider), auth: { apiKey: { name: 'Profile vault', resolve: async ({ signal }) => { signal.throwIfAborted(); return { ...resolvedAuth, source: 'Profile vault' }; } } } });
      return models;
    }
    async function startAttempt(signal?: AbortSignal): Promise<Attempt> {
      let permit: RequestPermit | undefined = await options.gate.acquire(signal);
      const attempt: Attempt = {
        headers: {},
        observe(response) { attempt.status = response.status; attempt.headers = response.headers; },
        release() { permit?.release(); permit = undefined; },
        async fetch(input, init) {
          // A later fetch of the attempt (the SDK retrying) encodes its body again: it waits for a permit too.
          const held = permit ?? await options.gate.acquire(init?.signal ?? signal);
          permit = undefined;
          try {
            const response = await cloudFetch(input, init);
            attempt.observe({ status: response.status, headers: Object.fromEntries(response.headers.entries()) });
            return response;
          } finally { held.release(); }
        },
      };
      return attempt;
    }
    /** The account is out until the provider's reset when its answer named one; the vault falls back to a used-up usage window or a short backoff. */
    function failed(candidate: CredentialAccount, kind: 'refresh' | 'rotate', attempt: Attempt, reason: string) {
      const until = kind === 'rotate' ? providerResetAt(attempt.headers, Date.now()) : undefined;
      return options.vault.recordFailure({ profileId: options.profileId, credentialId: candidate.id, kind, reason, ...(until === undefined ? {} : { until }) });
    }
    async function* streamAttempts(model: AnyModel, invoke: (credential: ResolvedCredential, attempt: Attempt, subscription: boolean) => AsyncIterable<AssistantMessageEvent>, signal?: AbortSignal): AsyncGenerator<AssistantMessageEvent> {
      canonical(model);
      const candidates = await orderedAccounts({ ...options, provider: model.provider });
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index]!;
        for (let refresh = 0; refresh < 2; refresh++) {
          let credential: ResolvedCredential;
          try { credential = await resolveCredential(model.provider, candidate.id, refresh === 1, signal); }
          catch (error) {
            if (refresh === 1 && index < candidates.length - 1 && !signal?.aborted) break;
            throw error;
          }
          await pins.write(model.provider, { credentialId: candidate.id });
          const attempt = await startAttempt(signal);
          let published = false;
          let failure: Extract<AssistantMessageEvent, { type: 'error' }> | undefined;
          const deferred: AssistantMessageEvent[] = [];
          try {
            for await (const event of invoke(credential, attempt, candidate.type === 'oauth')) {
              if (event.type === 'error') { failure = event; break; }
              if (event.type === 'start') { deferred.push(event); continue; }
              if (!published) { for (const start of deferred) yield start; deferred.length = 0; published = true; }
              yield event;
            }
          } finally { attempt.release(); }
          if (!failure) return;
          const message = failure.error.errorMessage ?? '';
          const policy = classifyAuthFailure(message, attempt.status);
          if (!signal?.aborted && !published && policy === 'refresh' && refresh === 0 && candidate.type === 'oauth') continue;
          const more = index < candidates.length - 1;
          if (!signal?.aborted && !published && policy !== 'none' && more) { await failed(candidate, policy, attempt, message); break; }
          for (const start of deferred) yield start;
          if (signal?.aborted || policy !== 'rotate') { yield failure; return; }
          // Published output is never replayed on another account: the turn ends here, and the account stays out so
          // the next request (pi's own retry of this turn, or the next turn) starts on another one.
          const out = await failed(candidate, policy, attempt, message);
          const note = `${out.label} ran out until ${new Date(out.until).toUTCString()}${published && more ? '; the next turn uses another account' : ''}.`;
          yield { ...failure, error: { ...failure.error, errorMessage: message ? `${message}\n\n${note}` : note } };
          return;
        }
      }
    }
    async function resultAttempts<T extends AssistantImages | ClassifierResult>(model: AnyModel, invoke: (models: Models, attempt: Attempt) => Promise<T>, signal?: AbortSignal): Promise<T> {
      canonical(model);
      const candidates = await orderedAccounts({ ...options, provider: model.provider });
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index]!;
        for (let refresh = 0; refresh < 2; refresh++) {
          let models: Models;
          try { models = await bound(model.provider, candidate.id, refresh === 1, signal); }
          catch (error) {
            if (refresh === 1 && index < candidates.length - 1 && !signal?.aborted) break;
            throw error;
          }
          await pins.write(model.provider, { credentialId: candidate.id });
          const attempt = await startAttempt(signal);
          let result: T;
          try { result = await invoke(models, attempt); }
          finally { attempt.release(); }
          if (result.stopReason !== 'error') return result;
          const policy = classifyAuthFailure(result.errorMessage ?? '', attempt.status);
          if (signal?.aborted || policy === 'none') return result;
          if (policy === 'refresh' && refresh === 0 && candidate.type === 'oauth') continue;
          await failed(candidate, policy, attempt, result.errorMessage ?? '');
          if (index === candidates.length - 1) return result;
          break;
        }
      }
      throw new Error('Account retry invariant violated');
    }
    async function available(providerId?: string): Promise<AnyModel[]> {
      const kinds = new Map<string, Set<CredentialAccount['type']>>();
      for (const account of await options.vault.list(options.profileId, providerId)) kinds.set(account.provider, (kinds.get(account.provider) ?? new Set()).add(account.type));
      return list.filter(provider => kinds.has(provider.id) && (providerId === undefined || provider.id === providerId)).flatMap(provider => {
        const models = provider.getAllModels?.() ?? provider.getModels();
        // A provider narrows its models by the kind of credential (a ChatGPT sign-in reaches no OpenAI classifier): a
        // model is available when one of the profile's accounts for it can use it. The stand-in carries the kind only.
        const usable = [...kinds.get(provider.id) ?? []].map((kind): Credential => kind === 'oauth' ? { type: 'oauth', access: '', refresh: '', expires: 0 } : { type: 'api_key' });
        if (provider.filterAllModels) { const kept = new Set(usable.flatMap(credential => provider.filterAllModels?.(models, credential) ?? [])); return models.filter(model => kept.has(model)); }
        const chat = models.filter(model => isModelType(model, 'chat'));
        const keptChat = new Set(usable.flatMap(credential => provider.filterModels?.(chat, credential) ?? chat));
        return [...chat.filter(model => keptChat.has(model)), ...models.filter(model => !isModelType(model, 'chat'))];
      });
    }
    /** One attempt of a streamed request, on the account `streamAttempts` chose: its images fitted to the model's limits
     * by reference, built and sent by the runner. The gate permit is held until the provider answers. */
    function attempted(method: InferenceAttempt['method'], model: Model<Api>, context: Context, request?: { signal?: AbortSignal; onResponse?: (response: ProviderResponse, model: Model<Api>) => unknown }) {
      const fitted = fitRequestImages(context, imageLimits(model));
      return async function* (credential: ResolvedCredential, attempt: Attempt, subscription: boolean): AsyncGenerator<AssistantMessageEvent> {
        const sent: InferenceAttempt = { method, model: subscription ? subscriptionModel(model) : model, context: fitted, options: attemptOptions(request), credential, settings, fastMode, claude: session };
        let ended = false;
        for await (const event of run(sent, request?.signal)) {
          attempt.release();
          if (event.type !== 'response') { ended = event.type === 'done' || event.type === 'error'; yield event; continue; }
          const response = { status: event.status, headers: event.headers };
          attempt.observe(response);
          await request?.onResponse?.(response, model);
        }
        // A stream cancelled by an abort, or cut off with its worker, ends as a provider's would: with an error event, so
        // the request settles instead of waiting for an answer that cannot come.
        if (!ended) {
          const aborted = request?.signal?.aborted === true;
          const message: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: aborted ? 'aborted' : 'error', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, errorMessage: aborted ? 'Request was aborted' : 'The inference worker ended the request without an answer' };
          yield { type: 'error', reason: aborted ? 'aborted' : 'error', error: message };
        }
      };
    }
    const facade: Models = {
      getProviders: () => list.map(provider => ({ ...provider, auth: { apiKey: { name: 'Profile vault', resolve: async () => facade.getAuth(provider.id) } }, stream<T extends Api>(model: Model<T>, context: TranscriptContext, request?: ApiStreamOptions<T>) { rejectOverrides(request); return facade.stream<T>(model, context, request === undefined ? undefined : Object.assign({}, request, { transformHeaders: undefined })); }, streamSimple: (model, context, request) => facade.streamSimple(model, context, request), generateImages: (model, context, request) => facade.generateImages(model, context, request), classify: (model, context, request) => facade.classify(model, context, request), fetchDeferred: (model, handle, request) => facade.streamDeferred(model, handle, request), cancelDeferred: (model, handle, request) => facade.cancelDeferred(model, handle, request) })),
      getProvider: id => facade.getProviders().find(provider => provider.id === id),
      getModels: provider => listing(provider, entry => entry.getModels()),
      getModel: (provider, id) => facade.getModels(provider).find(model => model.id === id),
      getModelsOfType: (type, provider) => facade.getAllModels(provider).flatMap(model => isModelType(model, type) ? [model] : []),
      getModelOfType: (type, provider, id) => facade.getModelsOfType(type, provider).find(model => model.id === id),
      getAllModels: provider => listing(provider, rows),
      checkAuth: async provider => { const account = (await options.vault.list(options.profileId, provider))[0]; return account ? { type: account.type, source: 'Profile vault' } : undefined; },
      getAvailable: async provider => (await available(provider)).filter(model => isModelType(model, 'chat')),
      getAvailableOfType: async (type, provider) => (await available(provider)).filter(model => isModelType(model, type)),
      getAllAvailable: available,
      getAuth: async (provider, overrides) => { rejectOverrides(overrides); const id = typeof provider === 'string' ? provider : provider.provider; if (typeof provider !== 'string') canonical(provider); const candidate = (await orderedAccounts({ ...options, provider: id }))[0]!; const models = await bound(id, candidate.id); return typeof provider === 'string' ? models.getAuth(provider) : models.getAuth(provider); },
      login: async () => { throw new Error('Login requires the signed profile management endpoint'); },
      logout: async () => { throw new Error('Logout requires the signed profile management endpoint'); },
      refresh,
      stream<T extends Api>(model: Model<T>, context: Context, request?: ModelsApiStreamOptions<T>) {
        return lazyStream(model, async () => { rejectOverrides(request); return streamAttempts(model, attempted('stream', model, context, request), request?.signal); });
      },
      complete: (model, context, request) => facade.stream(model, context, request).result(),
      streamSimple: (model, context, request) => lazyStream(model, async () => { rejectOverrides(request); return streamAttempts(model, attempted('streamSimple', model, context, request), request?.signal); }),
      completeSimple: (model, context, request) => facade.streamSimple(model, context, request).result(),
      streamDeferred: (model, handle, request) => lazyStream(model, async () => { rejectOverrides(request); canonical(model); const pin = await pins.read(model.provider); if (!pin) throw new Error('Deferred response has no admitted account'); return (await bound(model.provider, pin.credentialId, false, request?.signal)).streamDeferred(model, handle, { ...request, fetch: cloudFetch }); }),
      fetchDeferred: (model, handle, request) => facade.streamDeferred(model, handle, request).result(),
      cancelDeferred: async (model, handle, request) => { rejectOverrides(request); canonical(model); const pin = await pins.read(model.provider); if (!pin) throw new Error('Deferred response has no admitted account'); await (await bound(model.provider, pin.credentialId, false, request?.signal)).cancelDeferred(model, handle, { ...request, fetch: cloudFetch }); },
      generateImages: async (model, context, request) => { rejectOverrides(request); return resultAttempts(model, (models, attempt) => models.generateImages(model, context, { ...request, fetch: attempt.fetch, onResponse: async (response, selected) => { attempt.observe(response); await request?.onResponse?.(response, selected); } }), request?.signal); },
      classify: async (model, context, request) => { rejectOverrides(request); return resultAttempts(model, (models, attempt) => models.classify(model, context, { ...request, fetch: attempt.fetch, onResponse: async (response, selected) => { attempt.observe(response); await request?.onResponse?.(response, selected); } }), request?.signal); },
    };
    return facade;
  }
  await refresh({ allowNetwork: false });
  const base = await view(providers, options.pins, false);
  return { ...base, scope: async request => view(scopedProviders(request.pinnedModels ?? []), request.pins, request.fastMode ?? false) };
}
