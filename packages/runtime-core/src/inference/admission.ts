import { createProvider, isModelType, type Api, type AnyModel, type Model, type Models, type Provider, type ProviderStreams } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { applyInferenceSettings, inferenceSettingsSchema, type InferenceProfile } from '@gitspace/protocol/inference';
import { z } from 'zod';
import { applyProviderCatalog } from './catalog.js';
import { createLegacyCloudProviders } from './providers/index.js';
import type { ModelSelectionIntent } from '@gitspace/protocol-runtime/session-controls';

const credentialHeaders = /^(?:authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|x-amz-security-token|cookie|host|chatgpt-account-id)$/iu;
const literal = z.string().refine(value => !value.startsWith('!') && !/^[A-Z][A-Z0-9_]+$/u.test(value), 'Commands and environment references are not profile configuration');
const headers = z.record(z.string(), literal).refine(value => !Object.keys(value).some(name => credentialHeaders.test(name)), 'Credentials belong in the profile vault');
const endpoint = z.url().refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
}, 'Provider endpoints must be literal HTTP(S) URLs without credentials');
const cost = z.object({ input: z.number().nonnegative().optional(), output: z.number().nonnegative().optional(), cacheRead: z.number().nonnegative().optional(), cacheWrite: z.number().nonnegative().optional() });
const compat = z.object({
  supportsStore: z.boolean().optional(), supportsDeveloperRole: z.boolean().optional(), supportsReasoningEffort: z.boolean().optional(),
  supportsUsageInStreaming: z.boolean().optional(), supportsFinishReason: z.boolean().optional(),
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  requiresToolResultName: z.boolean().optional(), requiresAssistantAfterToolResult: z.boolean().optional(), requiresThinkingAsText: z.boolean().optional(),
  supportsStrictMode: z.boolean().optional(), supportsOpenAIGrammarTools: z.boolean().optional(), supportsLongCacheRetention: z.boolean().optional(),
  supportsMidConvoSystemMessages: z.boolean().optional(), supportsAdditionalTools: z.boolean().optional(), supportsToolSearch: z.boolean().optional(),
  supportsExplicitPromptCacheMode: z.boolean().optional(), supportsMaxOutputTokens: z.boolean().optional(),
  thinkingFormat: z.enum(['openai', 'openrouter', 'deepseek', 'together', 'baseten', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling']).optional(),
}).strict();
const modelPatch = z.object({
  name: z.string().min(1).optional(), api: z.string().min(1).optional(), baseUrl: endpoint.optional(), headers: headers.optional(),
  reasoning: z.boolean().optional(), input: z.array(z.enum(['text', 'image'])).optional(),
  contextWindow: z.number().positive().optional(), maxTokens: z.number().positive().optional(),
  cost: cost.optional(), compat: compat.optional(), hidden: z.boolean().optional(),
}).strict();
const modelDefinition = modelPatch.extend({ id: z.string().min(1) });
const providerConfig = z.object({
  name: z.string().min(1).optional(), api: z.string().min(1).optional(), baseUrl: endpoint.optional(), headers: headers.optional(), compat: compat.optional(),
  models: z.array(modelDefinition).optional(), modelOverrides: z.record(z.string(), modelPatch).optional(),
}).strict();
const configsSchema = z.object({ providers: z.object({ models: z.record(z.string(), providerConfig).optional() }).passthrough().optional() }).passthrough();
type ModelPatch = z.infer<typeof modelPatch>;

function validateRouting(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['env', 'profile', 'credentials', 'bearerToken', 'fetch', 'oauth', 'streamSimple', 'fetchDynamicModels', 'apiKeyHelper', 'authCommand'].includes(key) && child !== undefined) throw new Error(`Profile inference forbids ${key}`);
    if (key === 'transport' && child !== undefined && child !== 'direct') throw new Error('Delegated inference transports are unsupported');
    if (key === 'headers') headers.parse(child);
    validateRouting(child);
  }
}

function patchModel(model: Model<Api>, patch: ModelPatch): Model<Api> {
  return {
    ...model,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.api !== undefined ? { api: patch.api } : {}),
    ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
    ...(patch.headers !== undefined ? { headers: { ...model.headers, ...patch.headers } } : {}),
    ...(patch.reasoning !== undefined ? { reasoning: patch.reasoning } : {}),
    ...(patch.input !== undefined ? { input: patch.input } : {}),
    ...(patch.contextWindow !== undefined ? { contextWindow: patch.contextWindow } : {}),
    ...(patch.maxTokens !== undefined ? { maxTokens: patch.maxTokens } : {}),
    ...(patch.cost !== undefined ? { cost: { ...model.cost, ...patch.cost } } : {}),
    ...(patch.compat !== undefined ? { compat: { ...model.compat, ...patch.compat } } : {}),
  };
}

/** Profile settings are the only custom endpoint/model authority, never local files or environment. */
export function admitProfileProviders(settings: InferenceProfile['settings'], providers: readonly Provider[]): readonly Provider[] {
  const effective = applyInferenceSettings({}, inferenceSettingsSchema.parse(settings));
  validateRouting(effective);
  const allowed = z.object({ enabledModels: z.array(z.string()).optional() }).parse(effective).enabledModels ?? [];
  const patterns = allowed.map(pattern => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')}$`, 'iu'));
  const enabled = (model: Pick<AnyModel, 'provider' | 'id'>): boolean => patterns.length === 0 || patterns.some(pattern => pattern.test(`${model.provider}/${model.id}`) || pattern.test(model.id));
  const configured = configsSchema.parse(effective).providers?.models ?? {};
  const result = new Map(providers.map(provider => [provider.id, provider]));
  const allModels = providers.flatMap(provider => [...provider.getModels()]);
  const transports = new Map<string, ProviderStreams>();
  for (const provider of providers) for (const model of provider.getModels()) {
    if (!transports.has(model.api)) transports.set(model.api, {
      stream: (input, context, options) => provider.stream(input, context, options),
      streamSimple: (input, context, options) => provider.streamSimple(input, context, options),
    });
  }
  for (const [id, config] of Object.entries(configured)) {
    const original = result.get(id);
    const materialize = (): Model<Api>[] => {
      const models = new Map((original?.getModels() ?? []).map(model => [model.id, patchModel(model, config)]));
      for (const definition of config.models ?? []) {
        const baseline = models.get(definition.id) ?? allModels.find(model => model.id === definition.id && (!definition.api || model.api === definition.api));
        if (baseline) models.set(definition.id, patchModel({ ...baseline, provider: id }, { ...config, ...definition }));
        else {
          const complete = z.object({ id: z.string(), name: z.string(), api: z.string(), baseUrl: endpoint, reasoning: z.boolean(), input: z.array(z.enum(['text', 'image'])), contextWindow: z.number().positive(), maxTokens: z.number().positive(), cost: cost.required(), headers: headers.optional(), compat: compat.optional() }).parse({ ...config, ...definition });
          models.set(complete.id, { ...complete, provider: id });
        }
      }
      for (const [modelId, patch] of Object.entries(config.modelOverrides ?? {})) {
        const existing = models.get(modelId);
        if (existing) models.set(modelId, patchModel(existing, patch));
      }
      for (const model of models.values()) if (!transports.has(model.api)) throw new Error(`Unsupported managed inference API: ${model.api}`);
      return [...models.values()];
    };
    const initial = materialize();
    const api: Record<string, ProviderStreams> = {};
    for (const model of initial) {
      const transport = transports.get(model.api);
      if (transport) api[model.api] = transport;
    }
    const dispatch = createProvider({ id, name: config.name ?? original?.name ?? id, models: initial, api,
      auth: original?.auth ?? { apiKey: { name: `${id} API key`, resolve: async ({ credential }) => credential ? { auth: { apiKey: credential.key }, source: 'credential' } : undefined } },
    });
    const hidden = new Set([...(config.models ?? []).filter(model => model.hidden).map(model => model.id), ...Object.entries(config.modelOverrides ?? {}).filter(([, patch]) => patch.hidden).map(([modelId]) => modelId)]);
    result.set(id, {
      ...dispatch,
      ...(original?.refreshModels ? { refreshModels: original.refreshModels.bind(original) } : {}),
      getModels: materialize,
      getAllModels: () => {
        const others: AnyModel[] = (original?.getAllModels?.() ?? []).filter(model => !isModelType(model, 'chat')).map(model => ({ ...model, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}), ...(config.headers ? { headers: { ...model.headers, ...config.headers } } : {}) }));
        return [...materialize(), ...others];
      },
      ...(original?.generateImages ? { generateImages: original.generateImages.bind(original) } : {}),
      ...(original?.classify ? { classify: original.classify.bind(original) } : {}),
      filterModels: (models, credential) => (original?.filterModels?.(models, credential) ?? models).filter(model => !hidden.has(model.id)),
      filterAllModels: (models, credential) => (original?.filterAllModels?.(models, credential) ?? models).filter(model => !hidden.has(model.id)),
    });
  }
  return [...result.values()].map(provider => ({
    ...provider,
    filterModels: (models, credential) => (provider.filterModels?.(models, credential) ?? models).filter(enabled),
    filterAllModels: (models, credential) => {
      const available = provider.filterAllModels?.(models, credential) ?? models.filter(model => !isModelType(model, 'chat') || (provider.filterModels?.([model], credential).length ?? 1) > 0);
      return available.filter(enabled);
    },
  }));
}

/** Providers the account Worker can sign in to: GitSpace's own flows plus Pi's subscription flows. */
const signInProviders: Readonly<Record<string, true>> = {
  anthropic: true, 'openai-codex': true, cursor: true, 'google-antigravity': true, 'google-gemini-cli': true,
  openai: true, 'github-copilot': true, openrouter: true, xai: true, 'kimi-coding': true, meta: true,
};
/** Subscription-only providers whose API-key path would bypass the sign-in they require. */
const signInOnlyProviders: Readonly<Record<string, true>> = { 'openai-codex': true, cursor: true, 'google-antigravity': true, 'google-gemini-cli': true };
export function describeCloudProviders(settings: InferenceProfile['settings'] = {}) {
  return admitProfileProviders(settings, [...builtinProviders(), ...createLegacyCloudProviders()].map(applyProviderCatalog)).map(provider => ({
    id: provider.id, name: provider.name, credentialProvider: provider.id,
    supportsApiKey: provider.auth.apiKey !== undefined && signInOnlyProviders[provider.id] !== true, supportsOAuth: signInProviders[provider.id] === true,
  }));
}

export function listCloudModels(settings: InferenceProfile['settings'], authenticatedProviderIds: readonly string[]) {
  const authenticated = new Set(authenticatedProviderIds);
  const providers = admitProfileProviders(settings, [...builtinProviders(), ...createLegacyCloudProviders()].map(applyProviderCatalog));
  return providers.filter(provider => authenticated.has(provider.id)).flatMap(provider => {
    const models = provider.getModels();
    const visible = provider.filterModels?.(models, undefined) ?? models;
    return visible.map(model => ({ provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow }));
  });
}

/** Resolve profile roles and model patterns against the admitted registry only. */
export function resolveProfileModel(settings: InferenceProfile['settings'], models: Models, role = 'default'): Model<Api> {
  const effective = applyInferenceSettings({}, inferenceSettingsSchema.parse(settings));
  const selection = z.object({
    modelRoles: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    enabledModels: z.array(z.string()).optional(),
  }).parse(effective);
  const matches = (pattern: string, model: Model<Api>): boolean => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*');
    const expression = new RegExp(`^${escaped}$`, 'iu');
    return expression.test(`${model.provider}/${model.id}`) || expression.test(model.id);
  };
  const candidates = models.getModels().filter(model => !selection.enabledModels?.length || selection.enabledModels.some(pattern => matches(pattern, model)));
  const visited = new Set<string>();
  const resolve = (value: string | string[]): Model<Api> | undefined => {
    for (const pattern of typeof value === 'string' ? [value] : value) {
      const alias = pattern.startsWith('pi/') ? pattern.slice(3) : pattern.startsWith('@') ? pattern.slice(1) : undefined;
      if (alias !== undefined) {
        if (visited.has(alias)) throw new Error(`Circular profile model role: ${alias}`);
        visited.add(alias);
        const configured = selection.modelRoles?.[alias];
        const found = configured ? resolve(configured) : undefined;
        visited.delete(alias);
        if (found) return found;
      } else {
        const found = candidates.find(model => matches(pattern, model));
        if (found) return found;
      }
    }
    return undefined;
  };
  const configured = selection.modelRoles?.[role] ?? selection.modelRoles?.default;
  const selected = configured ? resolve(configured) : candidates[0];
  if (!selected) throw new Error(`Inference profile has no admitted model for role ${role}`);
  return selected;
}

/** Availability is resolved before defaults so unauthenticated providers never win. */
export async function resolveAvailableProfileModel(settings: InferenceProfile['settings'], models: Models, role = 'default'): Promise<Model<Api>> {
  const available = await models.getAvailable();
  const snapshot: Models = {
    ...models,
    getModels: providerId => providerId === undefined ? available : available.filter(model => model.provider === providerId),
  };
  return resolveProfileModel(settings, snapshot, role);
}

/** Selection is intent; only an admission turns it into an immutable model identity. */
export async function resolveModelSelection(settings: InferenceProfile['settings'], models: Models, selection: ModelSelectionIntent): Promise<{ model: Model<Api>; notice?: string }> {
  const available = await models.getAvailable();
  const snapshot: Models = { ...models, getModels: provider => available.filter(model => provider === undefined || model.provider === provider) };
  if (selection.kind === 'explicit') {
    const model = available.find(model => model.provider === selection.provider && model.id === selection.modelId);
    if (model) return { model };
  } else {
    const role = selection.kind === 'role' ? selection.role : 'default';
    try {
      if (selection.kind === 'role' && !profileModelRoles(settings).includes(role)) throw new Error(`Inference role ${role} was removed`);
      return { model: resolveProfileModel(settings, snapshot, role) };
    } catch (error) { if (!available.length) throw error; }
  }
  let model: Model<Api>;
  try { model = resolveProfileModel(settings, snapshot); }
  catch { if (!available[0]) throw new Error('Inference profile has no available model'); model = available[0]; }
  const requested = selection.kind === 'explicit' ? `${selection.provider}/${selection.modelId}` : `${selection.kind === 'role' ? selection.role : 'default'} role`;
  return { model, notice: `Model selection ${requested} is no longer available. Using ${model.provider}/${model.id} for this run.` };
}

export function profileModelRoles(settings: InferenceProfile['settings']): string[] {
  const effective = applyInferenceSettings({}, inferenceSettingsSchema.parse(settings));
  const roles = z.object({ modelRoles: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional() }).parse(effective).modelRoles;
  return [...new Set(['default', ...Object.keys(roles ?? {})])];
}
