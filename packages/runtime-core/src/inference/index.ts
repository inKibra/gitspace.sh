import { createModels, lazyStream, type Api, type Model, type Context, type TranscriptContext, type ApiStreamOptions, type ModelsApiStreamOptions, type AnyModel, type Models, type ModelsStore, type Provider, type AuthResult, type AssistantMessageEvent, type AssistantMessageEventStream, type AssistantImages, type ClassifierResult } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { isModelType } from '@earendil-works/pi-ai';
import type { ProviderResponse } from '@earendil-works/pi-ai';
import { applyProviderCatalog, limitContextWindows } from './catalog.js';
import { createLegacyCloudProviders } from './providers/index.js';
import { classifyAuthFailure, orderedAccounts, providerResetAt, type VaultAccess, type CredentialAccount, type CredentialPins, type ResolvedCredential } from './selection.js';
import { admitProfileProviders, contextWindowLimits } from './admission.js';
import { fitRequestImages, imageLimits } from './image-limits.js';
import type { InferenceProfile } from '@gitspace/protocol/inference';
import { fastServingProvider } from './fast.js';
import { withPublishedCatalog } from './published-catalog.js';
import { claudeCode } from './claude-code-request.js';
export * from './selection.js';
export * from './catalog.js';
export * from './admission.js';
export * from './models-store.js';
export * from './run-models.js';
export * from './helpers.js';
export * from './published-catalog.js';
export * from './vision.js';

export type VaultModelsOptions = {
  profileId: string;
  /** Every conversation of a workspace starts on the same account; see `orderedAccounts`. */
  workspaceId: string;
  vault: VaultAccess;
  pins: CredentialPins;
  modelsStore: ModelsStore;
  providers?: readonly Provider[];
  settings?: InferenceProfile['settings'];
  fastMode?: boolean;
  pinnedModels?: readonly AnyModel[];
};
export type VaultModels = Models;
/** One request on one account. Its transport reports the provider's answer, error statuses included (pi's
 * `onResponse` misses a rejected Anthropic request), so a failure knows the provider's reset. */
type Attempt = { fetch: typeof fetch; observe(response: ProviderResponse): void; status?: number; headers: Readonly<Record<string, string>> };
const noAmbient = { env: async () => undefined, fileExists: async () => false };
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

const cloudflareKeySchema = z.object({ token: z.string().min(1), accountId: z.string().min(1) });

function requestAuth(resolved: ResolvedCredential): AuthResult {
  const credential = resolved.credential;
  if (credential.type === 'api_key') {
    // Workers AI needs the account id in its URL; the key is stored as {"token","accountId"}.
    if (resolved.provider !== 'cloudflare-workers-ai') return { auth: { apiKey: credential.key } };
    let parsed: unknown;
    try { parsed = JSON.parse(credential.key); } catch { throw new Error('Cloudflare Workers AI key must be {"token":"…","accountId":"…"}'); }
    const key = cloudflareKeySchema.parse(parsed);
    return { auth: { apiKey: key.token }, env: { CLOUDFLARE_ACCOUNT_ID: key.accountId } };
  }
  switch (resolved.provider) {
    case 'google-gemini-cli': case 'google-antigravity':
      if (!credential.projectId) throw new Error('Google OAuth account has no authorized project');
      return { auth: { apiKey: JSON.stringify({ access: credential.access, projectId: credential.projectId }) } };
    case 'openai-codex':
      if (!credential.accountId) throw new Error('Codex OAuth account has no account identity');
      return { auth: { apiKey: credential.access, headers: { 'ChatGPT-Account-ID': credential.accountId } } };
    default: return { auth: { apiKey: credential.access, ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}), ...(credential.headers ? { headers: credential.headers } : {}) } };
  }
}

/** Each dispatch gets its own Models/auth object; concurrent accounts never share a credential slot. */
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
  const claude = await claudeCode(options.profileId);
  const cloudFetch = claude.fetch;
  const source = options.providers ?? [...builtinProviders().map(provider => withPublishedCatalog(provider)), ...createLegacyCloudProviders()];
  const listed = admitProfileProviders(options.settings ?? {}, source.map(applyProviderCatalog)).map(provider => {
    const pinned = options.pinnedModels?.filter(model => model.provider === provider.id);
    if (!pinned?.length) return provider;
    const all = () => {
      const rows = new Map((provider.getAllModels?.() ?? provider.getModels()).map(model => [`${model.type ?? 'chat'}:${model.id}`, model]));
      for (const model of pinned) rows.set(`${model.type ?? 'chat'}:${model.id}`, model);
      return [...rows.values()];
    };
    return { ...provider, getAllModels: all, getModels: () => all().filter(model => isModelType(model, 'chat')) };
  });
  const catalog = (list: readonly Provider[]) => {
    const models = createModels({ authContext: noAmbient, modelsStore: options.modelsStore });
    for (const provider of list) models.setProvider({ ...provider, auth: { apiKey: { name: 'Public catalog', resolve: async () => ({ auth: { apiKey: 'catalog-only' }, source: 'Public catalog' }) } } });
    return models;
  };
  // Every chat model carries the window its roles' context limits allow; pinned admissions too.
  const limit = contextWindowLimits(options.settings ?? {}, catalog(listed));
  const providers = listed.map(provider => limitContextWindows(provider, limit));
  const registry = catalog(providers);
  const providerById = new Map(providers.map(provider => [provider.id, provider]));
  function canonical(model: AnyModel): void {
    const known = registry.getAllModels(model.provider).find(candidate => candidate.id === model.id && (candidate.type ?? 'chat') === (model.type ?? 'chat'));
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
  async function bound(providerId: string, credentialId: string, forceRefresh = false, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const resolved = await options.vault.resolve({ profileId: options.profileId, credentialId, forceRefresh, ...(signal ? { signal } : {}) });
    if (resolved.id !== credentialId || resolved.provider !== providerId) throw new Error('Vault returned a different account scope');
    const provider = providerById.get(providerId);
    if (!provider) throw new Error(`Unknown provider ${providerId}`);
    const resolvedAuth = requestAuth(resolved);
    const models = createModels({ authContext: noAmbient, modelsStore: options.modelsStore });
    models.setProvider({ ...(options.fastMode ? fastServingProvider(provider) : provider), auth: { apiKey: { name: 'Profile vault', resolve: async ({ signal }) => { signal.throwIfAborted(); return { ...resolvedAuth, source: 'Profile vault' }; } } } });
    return models;
  }
  function startAttempt(): Attempt {
    const attempt: Attempt = {
      headers: {},
      observe(response) { attempt.status = response.status; attempt.headers = response.headers; },
      async fetch(input, init) {
        const response = await cloudFetch(input, init);
        attempt.observe({ status: response.status, headers: Object.fromEntries(response.headers.entries()) });
        return response;
      },
    };
    return attempt;
  }
  /** The account is out until the provider's reset when its answer named one; the vault falls back to a used-up usage window or a short backoff. */
  function failed(candidate: CredentialAccount, kind: 'refresh' | 'rotate', attempt: Attempt, reason: string) {
    const until = kind === 'rotate' ? providerResetAt(attempt.headers, Date.now()) : undefined;
    return options.vault.recordFailure({ profileId: options.profileId, credentialId: candidate.id, kind, reason, ...(until === undefined ? {} : { until }) });
  }
  async function* streamAttempts(model: AnyModel, invoke: (models: Models, attempt: Attempt, subscription: boolean) => AssistantMessageEventStream, signal?: AbortSignal): AsyncGenerator<AssistantMessageEvent> {
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
        await options.pins.write(model.provider, { credentialId: candidate.id });
        const attempt = startAttempt();
        let published = false;
        let failure: Extract<AssistantMessageEvent, { type: 'error' }> | undefined;
        const deferred: AssistantMessageEvent[] = [];
        for await (const event of invoke(models, attempt, candidate.type === 'oauth')) {
          if (event.type === 'error') { failure = event; break; }
          if (event.type === 'start') { deferred.push(event); continue; }
          if (!published) { for (const start of deferred) yield start; deferred.length = 0; published = true; }
          yield event;
        }
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
        await options.pins.write(model.provider, { credentialId: candidate.id });
        const attempt = startAttempt();
        const result = await invoke(models, attempt);
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
    const enabled = new Set((await options.vault.list(options.profileId, providerId)).map(account => account.provider));
    return providers.filter(provider => enabled.has(provider.id) && (providerId === undefined || provider.id === providerId)).flatMap(provider => {
      const models = provider.getAllModels?.() ?? provider.getModels();
      if (provider.filterAllModels) return [...provider.filterAllModels(models, undefined)];
      const chat = models.filter(model => isModelType(model, 'chat'));
      return [...(provider.filterModels?.(chat, undefined) ?? chat), ...models.filter(model => !isModelType(model, 'chat'))];
    });
  }
  const facade: Models = {
    getProviders: () => providers.map(provider => ({ ...provider, auth: { apiKey: { name: 'Profile vault', resolve: async () => facade.getAuth(provider.id) } }, stream<T extends Api>(model: Model<T>, context: TranscriptContext, request?: ApiStreamOptions<T>) { rejectOverrides(request); return facade.stream<T>(model, context, request === undefined ? undefined : Object.assign({}, request, { transformHeaders: undefined })); }, streamSimple: (model, context, request) => facade.streamSimple(model, context, request), generateImages: (model, context, request) => facade.generateImages(model, context, request), classify: (model, context, request) => facade.classify(model, context, request), fetchDeferred: (model, handle, request) => facade.streamDeferred(model, handle, request), cancelDeferred: (model, handle, request) => facade.cancelDeferred(model, handle, request) })),
    getProvider: id => facade.getProviders().find(provider => provider.id === id),
    getModels: provider => registry.getModels(provider),
    getModel: (provider, id) => registry.getModel(provider, id),
    getModelsOfType: (type, provider) => registry.getModelsOfType(type, provider),
    getModelOfType: (type, provider, id) => registry.getModelOfType(type, provider, id),
    getAllModels: provider => registry.getAllModels(provider),
    checkAuth: async provider => { const account = (await options.vault.list(options.profileId, provider))[0]; return account ? { type: account.type, source: 'Profile vault' } : undefined; },
    getAvailable: async provider => (await available(provider)).filter(model => isModelType(model, 'chat')),
    getAvailableOfType: async (type, provider) => (await available(provider)).filter(model => isModelType(model, type)),
    getAllAvailable: available,
    getAuth: async (provider, overrides) => { rejectOverrides(overrides); const id = typeof provider === 'string' ? provider : provider.provider; if (typeof provider !== 'string') canonical(provider); const candidate = (await orderedAccounts({ ...options, provider: id }))[0]!; const models = await bound(id, candidate.id); return typeof provider === 'string' ? models.getAuth(provider) : models.getAuth(provider); },
    login: async () => { throw new Error('Login requires the signed profile management endpoint'); },
    logout: async () => { throw new Error('Logout requires the signed profile management endpoint'); },
    refresh: async refresh => {
      const enabled = [...new Set((await options.vault.list(options.profileId)).map(account => account.provider))];
      return registry.refresh({ ...refresh, providers: enabled.filter(id => !refresh?.providers || refresh.providers.includes(id)) });
    },
    stream<T extends Api>(model: Model<T>, context: Context, request?: ModelsApiStreamOptions<T>) {
      return lazyStream(model, async () => {
        rejectOverrides(request);
        const fitted = fitRequestImages(context, imageLimits(model));
        return streamAttempts(model, (models, attempt, subscription) => models.stream<T>(subscription ? subscriptionModel(model) : model, fitted, Object.assign({}, request, {
          fetch: attempt.fetch, onPayload: claude.onPayload,
          onResponse: async (response: ProviderResponse, selected: Model<Api>) => { attempt.observe(response); await request?.onResponse?.(response, selected); },
        })), request?.signal);
      });
    },
    complete: (model, context, request) => facade.stream(model, context, request).result(),
    streamSimple: (model, context, request) => lazyStream(model, async () => { rejectOverrides(request); const fitted = fitRequestImages(context, imageLimits(model)); return streamAttempts(model, (models, attempt, subscription) => models.streamSimple(subscription ? subscriptionModel(model) : model, fitted, { ...request, fetch: attempt.fetch, onPayload: claude.onPayload, onResponse: async (response, selected) => { attempt.observe(response); await request?.onResponse?.(response, selected); } }), request?.signal); }),
    completeSimple: (model, context, request) => facade.streamSimple(model, context, request).result(),
    streamDeferred: (model, handle, request) => lazyStream(model, async () => { rejectOverrides(request); canonical(model); const pin = await options.pins.read(model.provider); if (!pin) throw new Error('Deferred response has no admitted account'); return (await bound(model.provider, pin.credentialId, false, request?.signal)).streamDeferred(model, handle, { ...request, fetch: cloudFetch }); }),
    fetchDeferred: (model, handle, request) => facade.streamDeferred(model, handle, request).result(),
    cancelDeferred: async (model, handle, request) => { rejectOverrides(request); canonical(model); const pin = await options.pins.read(model.provider); if (!pin) throw new Error('Deferred response has no admitted account'); await (await bound(model.provider, pin.credentialId, false, request?.signal)).cancelDeferred(model, handle, { ...request, fetch: cloudFetch }); },
    generateImages: async (model, context, request) => { rejectOverrides(request); return resultAttempts(model, (models, attempt) => models.generateImages(model, context, { ...request, fetch: attempt.fetch, onResponse: async (response, selected) => { attempt.observe(response); await request?.onResponse?.(response, selected); } }), request?.signal); },
    classify: async (model, context, request) => { rejectOverrides(request); return resultAttempts(model, (models, attempt) => models.classify(model, context, { ...request, fetch: attempt.fetch, onResponse: async (response, selected) => { attempt.observe(response); await request?.onResponse?.(response, selected); } }), request?.signal); },
  };
  await facade.refresh({ allowNetwork: false });
  return facade;
}
