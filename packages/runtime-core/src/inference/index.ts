import { createModels, lazyStream, type Api, type Model, type Context, type TranscriptContext, type ApiStreamOptions, type ModelsApiStreamOptions, type AnyModel, type Models, type ModelsStore, type Provider, type ModelAuth, type AssistantMessageEvent, type AssistantMessageEventStream, type AssistantImages, type ClassifierResult } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { isModelType } from '@earendil-works/pi-ai';
import type { ProviderResponse } from '@earendil-works/pi-ai';
import { applyProviderCatalog } from './catalog.js';
import { createLegacyCloudProviders } from './providers/index.js';
import { classifyAuthFailure, orderedAccounts, type VaultAccess, type CredentialPins, type ResolvedCredential } from './selection.js';
import { admitProfileProviders } from './admission.js';
import type { InferenceProfile } from '@gitspace/protocol/inference';
import { fastServingProvider } from './fast.js';
import { withPublishedCatalog } from './published-catalog.js';
export * from './selection.js';
export * from './catalog.js';
export * from './admission.js';
export * from './models-store.js';
export * from './run-models.js';
export * from './helpers.js';
export * from './published-catalog.js';

/** Never forward an admitted credential across an HTTP redirect. */
const cloudFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'manual' });

export type VaultModelsOptions = {
  profileId: string;
  conversationId: string;
  vault: VaultAccess;
  pins: CredentialPins;
  modelsStore: ModelsStore;
  providers?: readonly Provider[];
  settings?: InferenceProfile['settings'];
  fastMode?: boolean;
  pinnedModels?: readonly AnyModel[];
  conversationForSignal?(signal?: AbortSignal): { conversationId: string; pins: CredentialPins };
};
export type VaultModels = Models;
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

function requestAuth(resolved: ResolvedCredential): ModelAuth {
  const credential = resolved.credential;
  if (credential.type === 'api_key') return { apiKey: credential.key };
  switch (resolved.provider) {
    case 'google-gemini-cli': case 'google-antigravity':
      if (!credential.projectId) throw new Error('Google OAuth account has no authorized project');
      return { apiKey: JSON.stringify({ access: credential.access, projectId: credential.projectId }) };
    case 'openai-codex':
      if (!credential.accountId) throw new Error('Codex OAuth account has no account identity');
      return { apiKey: credential.access, headers: { 'ChatGPT-Account-ID': credential.accountId } };
    default: return { apiKey: credential.access };
  }
}

/** Each dispatch gets its own Models/auth object; concurrent accounts never share a credential slot. */
export async function createVaultModels(options: VaultModelsOptions): Promise<VaultModels> {
  const source = options.providers ?? [...builtinProviders().map(provider => withPublishedCatalog(provider)), ...createLegacyCloudProviders()];
  const providers = admitProfileProviders(options.settings ?? {}, source.map(applyProviderCatalog)).map(provider => {
    const pinned = options.pinnedModels?.filter(model => model.provider === provider.id);
    if (!pinned?.length) return provider;
    const all = () => {
      const rows = new Map((provider.getAllModels?.() ?? provider.getModels()).map(model => [`${model.type ?? 'chat'}:${model.id}`, model]));
      for (const model of pinned) rows.set(`${model.type ?? 'chat'}:${model.id}`, model);
      return [...rows.values()];
    };
    return { ...provider, getAllModels: all, getModels: () => all().filter(model => isModelType(model, 'chat')) };
  });
  const registry = createModels({ authContext: noAmbient, modelsStore: options.modelsStore });
  for (const provider of providers) registry.setProvider({ ...provider, auth: { apiKey: { name: 'Public catalog', resolve: async () => ({ auth: { apiKey: 'catalog-only' }, source: 'Public catalog' }) } } });
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
    const auth = requestAuth(resolved);
    const models = createModels({ authContext: noAmbient, modelsStore: options.modelsStore });
    models.setProvider({ ...(options.fastMode ? fastServingProvider(provider) : provider), auth: { apiKey: { name: 'Profile vault', resolve: async ({ signal }) => { signal.throwIfAborted(); return { auth, source: 'Profile vault' }; } } } });
    return models;
  }
  async function accounts(provider: string, scope: { conversationId: string; pins: CredentialPins } = options) {
    const result = await orderedAccounts({ ...options, ...scope, provider });
    if (!result.length) throw new Error(`Inference profile has no usable account for ${provider}`);
    return result;
  }
  async function* streamAttempts(model: AnyModel, invoke: (models: Models, observe: (status: number) => void) => AssistantMessageEventStream, signal?: AbortSignal): AsyncGenerator<AssistantMessageEvent> {
    canonical(model);
    const scope = options.conversationForSignal?.(signal) ?? options;
    const candidates = await accounts(model.provider, scope);
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      for (let refresh = 0; refresh < 2; refresh++) {
        let models: Models;
        try { models = await bound(model.provider, candidate.id, refresh === 1, signal); }
        catch (error) {
          if (refresh === 1 && index < candidates.length - 1 && !signal?.aborted) break;
          throw error;
        }
        await scope.pins.write(model.provider, { credentialId: candidate.id, lastUsedAt: Date.now() });
        let status: number | undefined;
        let published = false;
        let failure: Extract<AssistantMessageEvent, { type: 'error' }> | undefined;
        const deferred: AssistantMessageEvent[] = [];
        for await (const event of invoke(models, value => { status = value; })) {
          if (event.type === 'error') { failure = event; break; }
          if (event.type === 'start') { deferred.push(event); continue; }
          if (!published) { for (const start of deferred) yield start; deferred.length = 0; published = true; }
          yield event;
        }
        if (!failure) { await scope.pins.write(model.provider, { credentialId: candidate.id, lastUsedAt: Date.now() }); return; }
        const policy = classifyAuthFailure(failure.error.errorMessage ?? '', status);
        if (published || signal?.aborted || policy === 'none') { for (const start of deferred) yield start; yield failure; return; }
        if (policy === 'refresh' && refresh === 0 && candidate.type === 'oauth') continue;
        if (index === candidates.length - 1) { for (const start of deferred) yield start; yield failure; return; }
        await options.vault.recordFailure?.({ profileId: options.profileId, credentialId: candidate.id, kind: policy });
        break;
      }
    }
  }
  async function resultAttempts<T extends AssistantImages | ClassifierResult>(model: AnyModel, invoke: (models: Models, observe: (status: number) => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
    canonical(model);
    const scope = options.conversationForSignal?.(signal) ?? options;
    const candidates = await accounts(model.provider, scope);
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      for (let refresh = 0; refresh < 2; refresh++) {
        let status: number | undefined;
        let models: Models;
        try { models = await bound(model.provider, candidate.id, refresh === 1, signal); }
        catch (error) {
          if (refresh === 1 && index < candidates.length - 1 && !signal?.aborted) break;
          throw error;
        }
        await scope.pins.write(model.provider, { credentialId: candidate.id, lastUsedAt: Date.now() });
        const result = await invoke(models, value => { status = value; });
        if (result.stopReason !== 'error') { await scope.pins.write(model.provider, { credentialId: candidate.id, lastUsedAt: Date.now() }); return result; }
        const policy = classifyAuthFailure(result.errorMessage ?? '', status);
        if (signal?.aborted || policy === 'none') return result;
        if (policy === 'refresh' && refresh === 0 && candidate.type === 'oauth') continue;
        await options.vault.recordFailure?.({ profileId: options.profileId, credentialId: candidate.id, kind: policy });
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
    getAuth: async (provider, overrides) => { rejectOverrides(overrides); const id = typeof provider === 'string' ? provider : provider.provider; if (typeof provider !== 'string') canonical(provider); const candidate = (await accounts(id))[0]!; const models = await bound(id, candidate.id); return typeof provider === 'string' ? models.getAuth(provider) : models.getAuth(provider); },
    login: async () => { throw new Error('Login requires the signed profile management endpoint'); },
    logout: async () => { throw new Error('Logout requires the signed profile management endpoint'); },
    refresh: async refresh => {
      const enabled = [...new Set((await options.vault.list(options.profileId)).map(account => account.provider))];
      return registry.refresh({ ...refresh, providers: enabled.filter(id => !refresh?.providers || refresh.providers.includes(id)) });
    },
    stream<T extends Api>(model: Model<T>, context: Context, request?: ModelsApiStreamOptions<T>) {
      return lazyStream(model, async () => {
        rejectOverrides(request);
        return streamAttempts(model, (models, observe) => models.stream<T>(model, context, Object.assign({}, request, {
          fetch: cloudFetch,
          onResponse: async (response: ProviderResponse, selected: Model<Api>) => { observe(response.status); await request?.onResponse?.(response, selected); },
        })), request?.signal);
      });
    },
    complete: (model, context, request) => facade.stream(model, context, request).result(),
    streamSimple: (model, context, request) => lazyStream(model, async () => { rejectOverrides(request); return streamAttempts(model, (models, observe) => models.streamSimple(model, context, { ...request, fetch: cloudFetch, onResponse: async (response, selected) => { observe(response.status); await request?.onResponse?.(response, selected); } }), request?.signal); }),
    completeSimple: (model, context, request) => facade.streamSimple(model, context, request).result(),
    streamDeferred: (model, handle, request) => lazyStream(model, async () => { rejectOverrides(request); canonical(model); const pin = await options.pins.read(model.provider); if (!pin) throw new Error('Deferred response has no admitted account'); return (await bound(model.provider, pin.credentialId, false, request?.signal)).streamDeferred(model, handle, { ...request, fetch: cloudFetch }); }),
    fetchDeferred: (model, handle, request) => facade.streamDeferred(model, handle, request).result(),
    cancelDeferred: async (model, handle, request) => { rejectOverrides(request); canonical(model); const pin = await options.pins.read(model.provider); if (!pin) throw new Error('Deferred response has no admitted account'); await (await bound(model.provider, pin.credentialId, false, request?.signal)).cancelDeferred(model, handle, { ...request, fetch: cloudFetch }); },
    generateImages: async (model, context, request) => { rejectOverrides(request); return resultAttempts(model, (models, observe) => models.generateImages(model, context, { ...request, fetch: cloudFetch, onResponse: async (response, selected) => { observe(response.status); await request?.onResponse?.(response, selected); } }), request?.signal); },
    classify: async (model, context, request) => { rejectOverrides(request); return resultAttempts(model, (models, observe) => models.classify(model, context, { ...request, fetch: cloudFetch, onResponse: async (response, selected) => { observe(response.status); await request?.onResponse?.(response, selected); } }), request?.signal); },
  };
  await facade.refresh({ allowNetwork: false });
  return facade;
}
