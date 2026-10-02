import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { YAML } from 'bun';
import { applyInferenceSettings, applyManagedOmpSettingDefaults, extractInferenceSettings, inferenceCredentialPaths, inferenceExecutionContextSchema, sameInferenceScope, stripInferenceSettings, type InferenceExecutionContext } from '@gitspace/protocol/inference';
import { AuthStorage, type Api, type Model, type SimpleStreamOptions } from '@oh-my-pi/pi-ai';
import { AuthBrokerClient, RemoteAuthCredentialStore } from '@oh-my-pi/pi-ai/auth-broker';
import { installManagedInferenceGuard, type ManagedInferenceGuard } from '@oh-my-pi/pi-ai/managed-inference';
import { getCustomApi } from '@oh-my-pi/pi-ai/api-registry';
// Subpaths, not the package root: the machine bundle imports this module and must not pull in OMP agent execution.
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry';
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings';
import { ModelsConfigSchema, type ModelsConfig } from '@oh-my-pi/pi-coding-agent/config/models-config-schema';

export interface ManagedInference {
  /** The admitted context; same-scope revisions replace it through `apply`. */
  readonly context: InferenceExecutionContext;
  readonly settings: Settings;
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  readonly guard: ManagedInferenceGuard;
  /** Apply a new revision of the same credential scope in place. A scope change throws: it needs a fresh worker. */
  apply(next: InferenceExecutionContext): Promise<void>;
  close(): void;
}
interface AdmittedInference {
  context: InferenceExecutionContext;
  advanced: Record<string, unknown>;
  effective: Record<string, unknown>;
  modelsConfig: ModelsConfig;
}
export interface ManagedInferenceOptions {
  agentDir: string;
  cwd: string;
  /** Exactly one immutable binding per managed OMP child. Management coordinators leave this false. */
  installDispatchGuard?: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function merge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) result[key] = object(value) && object(result[key]) ? merge(result[key], value) : structuredClone(value);
  return result;
}
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}

const supportedApis: Readonly<Record<string, true>> = {
  'anthropic-messages': true, 'openai-completions': true, 'openai-responses': true, 'openai-codex-responses': true,
  'azure-openai-responses': true, openrouter: true, 'google-generative-ai': true, 'google-gemini-cli': true,
  'bedrock-converse-stream': true, 'ollama-chat': true, 'cursor-agent': true, 'devin-agent': true,
  // Image-only transports, admitted per request by pi-ai `generateImage`.
  'openai-images': true, 'openrouter-images': true,
};
const credentialHeader = /^(?:authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|x-amz-security-token|cookie)$/iu;
function rejectCredentialHeaders(headers: unknown): void {
  if (!object(headers)) return;
  if (Object.keys(headers).some(name => credentialHeader.test(name))) throw new Error('Managed inference forbids explicit credential headers; connect the provider in this profile');
}
function validateRouting(value: unknown): void {
  if (!object(value) && !Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'headers') {
      rejectCredentialHeaders(child);
      if (object(child) && Object.values(child).some(value => typeof value !== 'string' || value.startsWith('!') || /^[A-Z][A-Z0-9_]+$/u.test(value))) {
        throw new Error('Managed provider headers must be literal non-secret values, not commands or environment references');
      }
    }
    if (['profile', 'credentials', 'bearerToken', 'fetch', 'oauth', 'streamSimple', 'fetchDynamicModels'].includes(key) && child !== undefined) throw new Error(`Unsupported managed provider auth/configuration field: ${key}`);
    if (key === 'transport' && child !== undefined && child !== 'direct') throw new Error('Managed inference does not support delegated provider transports');
    if (key === 'auth' && child !== 'apiKey' && child !== 'oauth') throw new Error('Managed inference requires profile credentials; keyless/ambient auth is unsupported');
    validateRouting(child);
  }
}

/** Validate one admission: profile settings over shared Advanced, with no local model or credential overrides. */
async function admit(input: InferenceExecutionContext, options: ManagedInferenceOptions): Promise<AdmittedInference> {
  const context = inferenceExecutionContextSchema.parse(input);
  freeze(context);
  if (context.projectId !== null) {
    for (const directory of [options.agentDir, join(options.cwd, '.omp')]) {
      for (const name of ['models.yml', 'models.yaml', 'models.json']) {
        const path = join(directory, name);
        let content: string;
        try { content = await readFile(path, 'utf8'); }
        catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue; throw error; }
        if (content.trim() && content.trim() !== '{}') throw new Error(`Local model configuration conflicts with inference profiles: migrate ${path} into the profile's Providers configuration and remove the local file`);
      }
    }
  }
  const parsed: unknown = YAML.parse(context.advanced.content || '{}');
  if (!object(parsed)) throw new Error('Shared Advanced configuration must be an object');
  const advanced = stripInferenceSettings(parsed);
  const effective = applyInferenceSettings(advanced, context.profile.settings);
  if (inferenceCredentialPaths(effective).length) throw new Error('Credential-bearing OMP configuration must be migrated to the profile vault');
  const providers = object(effective.providers) ? effective.providers : {};
  const providerModels = providers.models ?? {};
  validateRouting(providerModels);
  const modelsConfig = ModelsConfigSchema.assert({ providers: providerModels }) as ModelsConfig;
  return { context, advanced, effective, modelsConfig };
}

/**
 * One scoped broker storage and one registry per credential scope. No discovery of
 * broker configuration, auth.db, models.yml, API-key env vars or AWS/ADC credentials.
 * Normal AuthStorage OAuth refresh, selection, sticky identities and retries remain intact.
 */
export async function createManagedInference(input: InferenceExecutionContext, options: ManagedInferenceOptions): Promise<ManagedInference> {
  let admitted = await admit(input, options);
  const { context } = admitted;
  // Hash the broker origin as well as profile identity: two accounts using a machine
  // directory must never share a persistent credential/model-discovery cache.
  const scope = createHash('sha256').update(context.broker.url).update('\0').update(context.profile.id).digest('hex');
  const cacheDir = join(options.agentDir, 'inference', scope);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const client = new AuthBrokerClient(context.broker);
  // Always authenticate a fresh snapshot before admission. A stale encrypted cache
  // must not revive a deleted profile or revoked enrollment while the broker is down.
  const initial = await client.fetchSnapshot();
  if (initial.status !== 200) throw new Error('Profile broker did not return an initial credential snapshot');
  const store = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false });
  const authStorage = new AuthStorage(store, {
    storeOnly: true,
    configValueResolver: async value => value,
    sourceLabel: `inference profile ${context.profile.id}`,
  });
  try {
    await authStorage.reload();
    // Reads the current admission, so a same-scope `apply` re-runs it in place.
    const configTransform = (config: Record<string, unknown>): Record<string, unknown> => {
      if (admitted.context.projectId !== null) {
        const repositoryInference = extractInferenceSettings(config);
        const admittedInference = extractInferenceSettings(admitted.effective);
        for (const [path, value] of Object.entries(repositoryInference)) {
          if (JSON.stringify(value) !== JSON.stringify(admittedInference[path])) throw new Error(`Local inference setting ${path} conflicts with the selected profile; move it to Inference and remove the local override`);
        }
      }
      return applyManagedOmpSettingDefaults(applyInferenceSettings(merge(stripInferenceSettings(config), admitted.advanced), admitted.context.profile.settings));
    };
    // Read-only loading does not fire process-global hooks in the multi-profile
    // management host. SDK initialization applies hooks only inside its bound child.
    const settings = await Settings.loadReadOnly({ cwd: options.cwd, agentDir: options.agentDir, inMemory: true, configTransform });
    const modelRegistry = new ModelRegistry(authStorage, undefined, { settings, ignoreLocalModelConfig: true, modelsConfig: admitted.modelsConfig, cacheDbPath: join(cacheDir, 'models.db') });
    const authorizedKeys = new Map<string, Set<string>>();
    const fingerprint = (key: string): string => createHash('sha256').update(key).digest('hex');
    const remember = (provider: string, key: string | undefined): string | undefined => {
      if (key) {
        let keys = authorizedKeys.get(provider);
        if (!keys) authorizedKeys.set(provider, keys = new Set());
        keys.add(fingerprint(key));
      }
      return key;
    };
    // Observe only the actual store-only resolver result (including provider-specific
    // OAuth encodings); never authorize a caller-supplied key by its mere presence.
    const resolve = authStorage.getApiKey.bind(authStorage);
    authStorage.getApiKey = async (provider, sessionId, resolution) => remember(provider, await resolve(provider, sessionId, resolution));
    const peek = authStorage.peekApiKey.bind(authStorage);
    authStorage.peekApiKey = async provider => remember(provider, await peek(provider));
    authStorage.onGenerationChanged(() => authorizedKeys.clear());
    const guard: ManagedInferenceGuard = {
      authStorage,
      async prepare(model: Model<Api>, request: SimpleStreamOptions): Promise<SimpleStreamOptions> {
        if (!supportedApis[model.api] || model.transport === 'pi-native' || getCustomApi(model.api)
          || model.provider === 'google-vertex' || model.provider === 'bedrock-mantle') {
          throw new Error(`Unsupported managed inference authentication/transport: ${model.provider}/${model.api}`);
        }
        const canonical = modelRegistry.find(model.provider, model.id);
        if (!canonical || canonical.api !== model.api || canonical.baseUrl !== model.baseUrl) throw new Error(`Model ${model.provider}/${model.id} is not part of the admitted inference profile`);
        rejectCredentialHeaders(model.headers);
        rejectCredentialHeaders(request.headers);
        const raw = request as SimpleStreamOptions & { profile?: unknown; credentials?: unknown; bearerToken?: string };
        if (raw.profile !== undefined || raw.credentials !== undefined || request.providerOptions?.profile !== undefined || request.providerOptions?.credentials !== undefined) throw new Error('Ambient AWS/profile credentials are unsupported in managed inference');
        let key = typeof request.apiKey === 'function'
          ? await request.apiKey({ lastChance: false, error: undefined, signal: request.signal })
          : request.apiKey;
        if (!key) key = await authStorage.getApiKey(model.provider, request.sessionId, { modelId: model.id, baseUrl: model.baseUrl, signal: request.signal });
        if (!key) throw new Error(`Inference profile ${admitted.context.profile.name} has no credential for ${model.provider}; connect it in Inference`);
        if (!authorizedKeys.get(model.provider)?.has(fingerprint(key))) {
          // A literal key from a scoped caller need not have gone through getApiKey
          // yet, but it must equal one current broker row, never an env/config key.
          const rows = store.listAuthCredentials(model.provider);
          const owned = rows.some(row => row.credential.type === 'api_key' ? row.credential.key === key : row.credential.access === key);
          if (!owned) throw new Error(`Explicit credential does not belong to inference profile ${admitted.context.profile.id}`);
        }
        if (raw.bearerToken !== undefined && raw.bearerToken !== key) throw new Error('Explicit Bedrock bearer does not belong to the inference profile');
        return { ...request, apiKey: key, ...(model.api === 'bedrock-converse-stream' ? { bearerToken: key } : {}) };
      },
    };
    if (options.installDispatchGuard) {
      installManagedInferenceGuard(guard);
      Settings.bindManaged(settings);
      ModelRegistry.bindManaged(modelRegistry);
    }
    return {
      get context() { return admitted.context; },
      settings, authStorage, modelRegistry, guard,
      async apply(next) {
        const candidate = await admit(next, options);
        if (!sameInferenceScope(admitted.context, candidate.context)) throw new Error('Inference credential scope changed; the agent worker must reopen');
        const previous = admitted;
        admitted = candidate;
        try { settings.reapplyConfigTransform(); }
        catch (error) {
          // A local override conflicts with the new revision: keep serving the previous one.
          admitted = previous;
          settings.reapplyConfigTransform();
          throw error;
        }
        await modelRegistry.replaceManagedModelsConfig(candidate.modelsConfig);
      },
      close: () => authStorage.close(),
    };
  } catch (error) {
    authStorage.close();
    throw error;
  }
}
