import { z } from 'zod';
import type { Message, Models } from '@earendil-works/pi-ai';
import { MODEL_ROLE_LABELS, applyInferenceSettings, inferenceProfileSchema, modelRoleThinkingSchema, type InferenceProfile } from '@gitspace/protocol/inference';
import { RuntimeJsonSchema, type RuntimeSnapshot, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { ModelSelectionIntentSchema, type ModelSelectionIntent, type SessionControlView } from '@gitspace/protocol-runtime/session-controls';
import {
  createVaultModels, createRunModelsRouter, createDurableModelsStore, createRequestGate,
  resolveModelSelection, resolveProfileModel, resolveAvailableProfileModel, StoredPiModelSchema, modelEditTool, generateProfileImage, runProfileModelHelper, describeImagesForModel,
  type AttemptRunner, type CredentialPins, type VaultModels,
} from '@gitspace/runtime-core/inference';

export type RuntimeModelHelperInput = { operation: 'completion' | 'judge'; args: z.infer<typeof RuntimeJsonSchema>; conversationId: string; signal?: AbortSignal };
export type RuntimeModelHelper = (input: RuntimeModelHelperInput) => Promise<z.infer<typeof RuntimeJsonSchema>>;
const admissionSchema = z.object({ requestId: z.string(), conversationId: z.string(), profile: inferenceProfileSchema, assignmentRevision: z.number().int().nonnegative().nullable(), selection: ModelSelectionIntentSchema, model: StoredPiModelSchema, thinking: modelRoleThinkingSchema.optional(), role: z.string().optional() });
type Admission = z.infer<typeof admissionSchema>;
const pinSchema = z.object({ credentialId: z.string() });
const key = (kind: string, ...parts: string[]) => `runtime-inference:${JSON.stringify([kind, ...parts])}`;

/** Only the Workspace DO calls this factory; no bearer or refresh token enters runtime state. `retrying` names the
 * conversations whose generation or compaction a reset interrupted and pi retries when the runtime opens. */
export async function createCloudRuntimeInference(ctx: DurableObjectState, env: Env, identity: Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>, retrying: readonly string[], run: AttemptRunner) {
  // A stub per call: this outlives any one, and one that saw an error stays broken.
  const vault = () => env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  const scopes = new WeakMap<AbortSignal, { admission: Admission; models: Models }>();
  /** Requests a hook stopped, by signal, and why: the request fails with that reason instead of running. */
  const refusals = new WeakMap<AbortSignal, string>();
  /** One catalog per profile revision; every admission on that revision shares it through a scoped view. */
  const catalogs = new Map<string, Promise<VaultModels>>();
  /** This object's model requests, every catalog's, wait here to build and upload their bodies. */
  const gate = createRequestGate();
  const pinsFor = (profileId: string, conversationId: string): CredentialPins => ({
    async read(provider) { const stored = await ctx.storage.get<unknown>(key('pin', profileId, conversationId, provider)); return stored === undefined ? null : pinSchema.parse(stored); },
    async write(provider, pin) { await ctx.storage.put(key('pin', profileId, conversationId, provider), pinSchema.parse(pin)); },
  });
  function catalog(profile: InferenceProfile): Promise<VaultModels> {
    const id = JSON.stringify([profile.id, profile.revision]);
    let pending = catalogs.get(id);
    if (!pending) {
      const store = createDurableModelsStore({
        read: name => ctx.storage.get<unknown>(key('catalog', name)),
        write: (name, value) => ctx.storage.put(key('catalog', name), value),
        delete: async name => { await ctx.storage.delete(key('catalog', name)); },
      });
      pending = createVaultModels({ profileId: profile.id, workspaceId: identity.workspaceId, settings: profile.settings, modelsStore: store, pins: pinsFor(profile.id, 'catalog'), gate, run, vault: {
        list: (profileId, provider) => vault().cloudCredentialAccounts(profileId, provider),
        resolve: input => { input.signal?.throwIfAborted(); return vault().cloudResolveCredential({ profileId: input.profileId, credentialId: input.credentialId, ...(input.forceRefresh === undefined ? {} : { forceRefresh: input.forceRefresh }) }); },
        recordFailure: input => vault().cloudCredentialFailure(input),
      } });
      catalogs.set(id, pending);
      void pending.catch(() => { if (catalogs.get(id) === pending) catalogs.delete(id); });
    }
    return pending;
  }
  /**
   * The admitted views the router lists, by router key: each conversation's latest admission, whose model pi looks up
   * before a hook binds its request, and every admission a running request is bound to until that request's signal
   * ends. A view neither needs is dropped.
   */
  const admitted = new Map<string, { conversationId: string; models: Promise<Models>; requests: number }>();
  const latest = new Map<string, string>();
  /** The view a request of `admission` runs with, and its router key: bound to exactly the model it admitted, with the
   * conversation's credential pins. */
  function admittedView(conversationId: string, admission: Admission, fastMode: boolean): { id: string; models: Promise<Models> } {
    const id = JSON.stringify(['admitted', conversationId, admission.profile.id, admission.profile.revision, admission.requestId, fastMode]);
    return { id, models: admitted.get(id)?.models ?? catalog(admission.profile).then(models => models.scope({ pins: pinsFor(admission.profile.id, conversationId), pinnedModels: [admission.model], fastMode })) };
  }
  function retain(conversationId: string, admission: Admission, fastMode: boolean) {
    const { id, models } = admittedView(conversationId, admission, fastMode);
    const existing = admitted.get(id);
    if (existing) return { id, entry: existing };
    const entry = { conversationId, models, requests: 0 };
    admitted.set(id, entry);
    void models.catch(() => { if (admitted.get(id) === entry) admitted.delete(id); });
    return { id, entry };
  }
  function release(id: string): void {
    const entry = admitted.get(id);
    if (!entry || entry.requests > 0 || latest.get(entry.conversationId) === id) return;
    admitted.delete(id);
    router.unregister(id);
  }
  /** Makes `admission` the conversation's latest, superseding the one before it. */
  async function admit(conversationId: string, admission: Admission): Promise<void> {
    const { id, entry } = retain(conversationId, admission, false);
    const models = await entry.models;
    const previous = latest.get(conversationId);
    latest.set(conversationId, id);
    router.register(models, id);
    if (previous !== undefined && previous !== id) release(previous);
  }
  // Opening history must neither migrate vault state nor choose a replacement provider.
  // Catalogs and admitted views are registered only by explicit admission or catalog interaction.
  const router = createRunModelsRouter(null, async signal => {
    const refusal = signal ? refusals.get(signal) : undefined;
    if (refusal !== undefined) throw new Error(refusal);
    const scope = signal ? scopes.get(signal) : undefined;
    if (!scope) throw new Error('Model request has no durable inference admission');
    signal?.throwIfAborted();
    // AgentDoc can change while another request is queued. The running signal
    // remains bound to the exact chat model captured by its admission.
    return { ...scope.models, getModel: () => scope.models.getModel(scope.admission.model.provider, scope.admission.model.id) };
  });
  // pi checks a retried request's model before any hook binds it, and the router knows only registered views: after a
  // reset every retried turn failed "Model … is not available". Those conversations get their admitted view back now,
  // before the runtime opens.
  for (const conversationId of retrying) {
    const stored = await ctx.storage.get<unknown>(key('active', conversationId));
    if (stored === undefined) continue;
    await admit(conversationId, admissionSchema.parse(stored));
  }
  async function active(conversationId: string): Promise<Admission> {
    const value = await ctx.storage.get<unknown>(key('active', conversationId));
    if (value === undefined) throw new Error('Conversation has no admitted inference run');
    return admissionSchema.parse(value);
  }
  async function bindInferenceConversation(conversationId: string, signal: AbortSignal, _submissionIds: readonly string[], requestIds: readonly string[], serving: { fastMode: boolean }): Promise<void> {
    signal.throwIfAborted();
    const admittedRequests: Admission[] = [];
    for (const requestId of requestIds) {
      const stored = await ctx.storage.get<unknown>(key('admission', conversationId, requestId));
      admittedRequests.push(admissionSchema.parse(stored));
    }
    const admission = admittedRequests[0] ?? await active(conversationId);
    if (admittedRequests.some(candidate => candidate.profile.id !== admission.profile.id || candidate.profile.revision !== admission.profile.revision || candidate.model.provider !== admission.model.provider || candidate.model.id !== admission.model.id)) throw new Error('Queued messages span different inference admissions; submit them as separate runs');
    const { id, entry } = retain(conversationId, admission, serving.fastMode);
    entry.requests++;
    const settle = () => { entry.requests--; release(id); };
    let models: Models;
    try {
      models = await entry.models;
      signal.throwIfAborted();
    } catch (error) {
      settle();
      throw error;
    }
    // The invocation's signal aborts when it ends, the request with it.
    signal.addEventListener('abort', settle, { once: true });
    if (!latest.has(conversationId)) latest.set(conversationId, id);
    scopes.set(signal, { admission, models });
    router.register(models, id);
    await ctx.storage.put(key('active', conversationId), admission);
  }
  return {
    models: router.models,
    editTool(model: { provider: string; modelId: string }) { const selected = router.models.getModel(model.provider, model.modelId); return modelEditTool(selected ?? { provider: model.provider, id: model.modelId }); },
    async admitInference(input: { conversationId: string; requestId: string; parentConversationId?: string; selection?: ModelSelectionIntent }) {
      const admissionKey = key('admission', input.conversationId, input.requestId);
      const existing = await ctx.storage.get<unknown>(admissionKey);
      let admission: Admission;
      if (existing !== undefined) admission = admissionSchema.parse(existing);
      else {
        const inherited = input.parentConversationId ? await active(input.parentConversationId) : null;
        const resolved = inherited ?? await vault().resolveCloudInference(identity.projectId);
        const selection = input.selection ?? inherited?.selection ?? { kind: 'default' };
        const models = await catalog(resolved.profile);
        // Published catalog refresh is credential-free data, not a provider request.
        if (!inherited) await models.refresh({ allowNetwork: true });
        // A configured default is authority, not permission to fall back to a
        // different provider merely because it still has a usable credential.
        const selected = inherited && !input.selection ? { model: inherited.model, thinking: inherited.thinking, role: inherited.role }
          : selection.kind === 'default' || (selection.kind === 'role' && selection.role === 'default') ? { ...await resolveAvailableProfileModel(resolved.profile.settings, models), role: 'default' }
          : await resolveModelSelection(resolved.profile.settings, models, selection);
        admission = admissionSchema.parse({ requestId: input.requestId, conversationId: input.conversationId, profile: resolved.profile, assignmentRevision: resolved.assignmentRevision, selection, ...selected });
        await ctx.storage.put(admissionKey, admission);
      }
      await admit(input.conversationId, admission);
      return { provider: admission.model.provider, modelId: admission.model.id, ...(admission.thinking === undefined ? {} : { thinking: admission.thinking }), ...(admission.role === undefined ? {} : { role: admission.role }) };
    },
    bindInferenceConversation,
    refuseRequest(signal: AbortSignal, reason: string) { refusals.set(signal, reason); },
    async describeImages(signal: AbortSignal, messages: readonly Message[]) {
      const scope = scopes.get(signal);
      const model = scope?.models.getModel(scope.admission.model.provider, scope.admission.model.id);
      if (!scope || !model) return undefined;
      return describeImagesForModel({ model, settings: scope.admission.profile.settings, models: scope.models, messages, signal, cache: {
        read: hash => ctx.storage.get<string>(key('image-description', hash)),
        write: (hash, description) => ctx.storage.put(key('image-description', hash), description),
      } });
    },
    async generateImage(input: { args: z.infer<typeof RuntimeJsonSchema>; conversationId: string; signal?: AbortSignal }): Promise<RuntimeToolResult['content']> {
      const admission = input.signal ? scopes.get(input.signal)?.admission ?? await active(input.conversationId) : await active(input.conversationId);
      const models = await admittedView(input.conversationId, admission, false).models;
      return generateProfileImage(models, input.args, input.signal, admission.profile.settings);
    },
    async modelHelper(input: RuntimeModelHelperInput) {
      const admission = input.signal ? scopes.get(input.signal)?.admission ?? await active(input.conversationId) : await active(input.conversationId);
      const models = await admittedView(input.conversationId, admission, false).models;
      return runProfileModelHelper(models, input.operation, input.args, input.signal, admission.profile.settings);
    },
    session: {
      async catalog() {
        const resolved = await vault().cloudInferenceCatalog(identity.projectId);
        if (!resolved) { router.unregister('catalog'); return { models: [], roles: [] }; }
        const currentProfile = resolved.profile;
        const currentAssignment = resolved.assignmentRevision;
        const readonly = async (): Promise<never> => { throw new Error('Passive inference catalogs cannot mutate state or resolve credentials'); };
        const currentModels = await createVaultModels({
          profileId: currentProfile.id, workspaceId: identity.workspaceId, settings: currentProfile.settings, gate,
          modelsStore: createDurableModelsStore({
            read: name => ctx.storage.get<unknown>(key('catalog', name)), write: readonly, delete: readonly,
          }),
          pins: { read: async () => null, write: readonly },
          vault: {
            list: async (_profileId, provider) => resolved.accounts.filter(account => provider === undefined || account.provider === provider),
            resolve: readonly, recordFailure: readonly,
          },
        });
        router.register(currentModels, 'catalog');
        const models = await currentModels.getAvailable();
        const roles: SessionControlView['roles'] = [];
        const configured = z.object({ modelRoles: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional() }).parse(applyInferenceSettings({}, currentProfile.settings)).modelRoles;
        const availableModels: Models = { ...currentModels, getModels: provider => models.filter(model => provider === undefined || model.provider === provider) };
        for (const role of Object.keys(configured ?? {})) {
          try {
            const selected = resolveProfileModel(currentProfile.settings, availableModels, role);
            roles.push({ id: role, label: MODEL_ROLE_LABELS[role] ?? role, provider: selected.model.provider, model: selected.model.id, thinking: selected.thinking, current: role === 'default' });
          } catch (error) {
            // A historical role may name a retired transport/model. It is not a
            // request to pick a replacement or a reason to block history.
            if (!(error instanceof Error) || error.message !== `Inference profile has no admitted model for role ${role}`) throw error;
          }
        }
        return { models: models.map(model => ({ provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow })), roles,
          ...(currentAssignment === null ? {} : { inference: { profileId: currentProfile.id, profileName: currentProfile.name, profileRevision: currentProfile.revision, assignmentRevision: currentAssignment } }) };
      },
      async reload(_kind: 'settings' | 'instructions' | 'inference') {
        const resolved = await vault().resolveCloudInference(identity.projectId);
        const models = await catalog(resolved.profile);
        const result = await models.refresh({ allowNetwork: true, force: true });
        if (result.errors.size) throw new AggregateError([...result.errors.values()], 'Provider catalog refresh failed');
        router.register(models);
      },
    },
  };
}
