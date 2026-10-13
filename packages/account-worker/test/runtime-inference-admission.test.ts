import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileApprovalMode, type InferenceProfile } from '@gitspace/protocol/inference';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { createCloudRuntimeInference } from '../src/runtime-inference.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai';
import { createConversationLifecycle } from '@gitspace/runtime-core';
import { createSessionControls, SessionControlsDoc, sessionApprovalMode, type SessionControlServices } from '@gitspace/runtime-core/session-controls';

async function sessionFixture(runtime: Pick<SessionControlServices, 'admitInference'> & { session: Pick<SessionControlServices, 'catalog' | 'reload'> }, approvalDefault: SessionControlServices['approvalDefault']) {
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT);
  const configureModel: SessionControlServices['configureModel'] = async (id, model) => {
    const conversation = await harness.conversation(id, BACKGROUND_CONTEXT);
    if (!conversation) throw new Error('Conversation missing');
    await conversation.configure({ model }, BACKGROUND_CONTEXT);
  };
  const lifecycle = createConversationLifecycle({ harness, storage, configureModel, admitInference: runtime.admitInference, wake: async () => {} });
  const unavailable = async (): Promise<never> => { throw new Error('Unused history operation'); };
  const controls = createSessionControls({
    harness, root, lifecycle, configureModel, admitInference: runtime.admitInference, approvalDefault, ...runtime.session,
    history: {
      conversation: unavailable, resolve: unavailable, usage: unavailable,
      recent: async () => ({ anchorId: null, prompts: [], tokens: null }),
      page: async () => ({ entries: [], anchorId: null, beforeCursor: null, afterCursor: null }),
      transcriptPage: async () => ({ generation: 'history', revision: 0, rows: [], hasBefore: false, hasAfter: false, total: 0 }),
      transcriptContent: async () => ({ text: 'Saved history', offset: 0, nextOffset: null, totalCharacters: 13 }),
    },
  });
  return { harness, root, controls };
}

const stamp = '2026-01-01T00:00:00.000Z';
afterEach(() => { vi.restoreAllMocks(); });

describe('durable inference selection intent', () => {
  it('resolves new admissions with current revisions while retaining admitted models and fallback notices across recovery', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const bodies = new Map<string, unknown>();
    const state = { storage: {
      get: async (key: string) => bodies.get(key),
      put: async (key: string, value: unknown) => { bodies.set(key, structuredClone(value)); },
      delete: async (key: string) => bodies.delete(key),
    } } as unknown as DurableObjectState;
    let profile: InferenceProfile = { version: 1, id: 'profile', name: 'Profile', revision: 1, settings: {}, createdAt: stamp, updatedAt: stamp };
    let assignmentRevision = 1;
    const vault = {
      resolveCloudInference: async () => ({ profile, assignmentRevision }),
      cloudInferenceCatalog: async () => ({ profile, assignmentRevision, accounts: [{ id: 'key', provider: 'openai', type: 'api_key', revision: 1, expiresAt: null, identity: null }] }),
      cloudCredentialAccounts: async () => [{ id: 'key', provider: 'openai', type: 'api_key', revision: 1, identity: 'test' }],
      cloudResolveCredential: async () => { throw new Error('Catalog/admission must not resolve provider credentials'); },
    };
    const environment = { ACCOUNT_ID: 'account', CREDENTIALS: { getByName: () => vault } } as unknown as Env;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      expect(String(input)).toMatch(/^https:\/\/pi\.dev\/api\/models\/providers\/openai\?/u);
      return Response.json([], { headers: { etag: 'catalog-1' } });
    });
    const identity = RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' });
    const runtime = await createCloudRuntimeInference(state, environment, identity);
    const catalog = await runtime.session.catalog();
    const first = catalog.models[0]!;
    const second = catalog.models.find(model => model.id !== first.id)!;
    expect(second).toBeDefined();
    profile = { ...profile, settings: { 'modelRoles.default': `openai/${first.id}:high`, 'modelRoles.fast': [`other/${first.id}:high`, 'pi/selected'], 'modelRoles.selected': `openai/${first.id}:low` } };
    const admitted = await runtime.admitInference({ conversationId: 'conversation', requestId: 'first', selection: { kind: 'role', role: 'fast' } });
    expect(admitted).toEqual({ provider: 'openai', modelId: first.id, thinking: 'low' });
    expect((await runtime.session.catalog()).roles.find(role => role.id === 'fast')).toMatchObject({ provider: 'openai', model: first.id, thinking: 'low' });
    await runtime.bindInferenceConversation('conversation', new AbortController().signal, [], ['first'], { fastMode: false });
    profile = { ...profile, revision: 2, settings: { 'modelRoles.default': `openai/${second.id}:high`, 'modelRoles.fast': `openai/${second.id}:medium` } };
    assignmentRevision = 2;
    const next = await runtime.admitInference({ conversationId: 'conversation', requestId: 'second', selection: { kind: 'role', role: 'fast' } });
    expect(next).toEqual({ provider: 'openai', modelId: second.id, thinking: 'medium' });
    expect(await runtime.admitInference({ conversationId: 'child', requestId: 'child', parentConversationId: 'conversation' })).toEqual(admitted);
    expect(await runtime.admitInference({ conversationId: 'conversation', requestId: 'first' })).toEqual(admitted);
    const fallback = await runtime.admitInference({ conversationId: 'conversation', requestId: 'removed', selection: { kind: 'explicit', provider: 'openai', modelId: 'removed' } });
    expect(fallback).toEqual({ provider: 'openai', modelId: second.id, thinking: 'high' });
    const recovered = await createCloudRuntimeInference(state, environment, identity);
    expect(await recovered.admitInference({ conversationId: 'conversation', requestId: 'first' })).toEqual(admitted);
    const notices = await recovered.bindInferenceConversation('conversation', new AbortController().signal, [], ['removed'], { fastMode: false });
    expect(notices).toEqual([{ requestId: 'removed', message: expect.stringContaining('openai/removed') }]);
    const recoveredCatalog = await recovered.session.catalog();
    expect('inference' in recoveredCatalog ? recoveredCatalog.inference?.profileRevision : undefined).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 4 * 60 * 60 * 1000 + 1;
    await recovered.session.catalog();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await recovered.session.reload('inference');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects an unsupported default instead of falling back to another authenticated provider, then admits the reselected OpenAI model', async () => {
    const bodies = new Map<string, unknown>();
    const state = { storage: {
      get: async (key: string) => bodies.get(key),
      put: async (key: string, value: unknown) => { bodies.set(key, structuredClone(value)); },
      delete: async (key: string) => bodies.delete(key),
    } } as unknown as DurableObjectState;
    let profile: InferenceProfile = { version: 1, id: 'profile', name: 'Profile', revision: 1, settings: { modelRoles: { default: 'openai-codex/retired' } }, createdAt: stamp, updatedAt: stamp };
    const accounts = [{ id: 'other', provider: 'anthropic', type: 'oauth', revision: 1, expiresAt: 1, identity: null }];
    const resolveCredential = vi.fn(async (): Promise<never> => { throw new Error('Admission must not resolve credentials'); });
    const vault = {
      resolveCloudInference: async () => ({ profile, assignmentRevision: 1 }),
      cloudInferenceCatalog: async () => ({ profile, assignmentRevision: 1, accounts }),
      cloudCredentialAccounts: async () => accounts,
      cloudResolveCredential: resolveCredential,
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json([]));
    const runtime = await createCloudRuntimeInference(state, { ACCOUNT_ID: 'account', CREDENTIALS: { getByName: () => vault } } as unknown as Env, RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }));
    const historical = await runtime.session.catalog();
    expect(historical.models.some(model => model.provider === 'anthropic')).toBe(true);
    expect(historical.roles).toEqual([]);
    await expect(runtime.admitInference({ conversationId: 'conversation', requestId: 'unsupported' })).rejects.toThrow('Inference profile has no admitted model for role default');
    await expect(runtime.admitInference({ conversationId: 'conversation', requestId: 'unsupported-default-role', selection: { kind: 'role', role: 'default' } })).rejects.toThrow('Inference profile has no admitted model for role default');
    expect(bodies.has(`runtime-inference:${JSON.stringify(['admission', 'conversation', 'unsupported'])}`)).toBe(false);
    accounts.push({ id: 'fresh', provider: 'openai', type: 'oauth', revision: 1, expiresAt: Date.now() + 3600000, identity: null });
    const supported = (await runtime.session.catalog()).models.find(model => model.provider === 'openai')!;
    profile = { ...profile, revision: 2, settings: { modelRoles: { default: `openai/${supported.id}:medium` } } };
    expect(await runtime.admitInference({ conversationId: 'conversation', requestId: 'reselected' })).toEqual({ provider: 'openai', modelId: supported.id, thinking: 'medium' });
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it('keeps passive catalogs read-only with unsupported legacy roles and preserves configured custom model metadata', async () => {
    const rejectMutation = vi.fn(async (): Promise<never> => { throw new Error('Passive read crossed a mutation or credential boundary'); });
    const state = { storage: { get: async () => undefined, put: rejectMutation, delete: rejectMutation } } as unknown as DurableObjectState;
    const profile: InferenceProfile = {
      version: 1, id: 'configured', name: 'Configured', revision: 3, createdAt: stamp, updatedAt: stamp,
      settings: {
        modelRoles: { default: 'openai-codex/retired', custom: 'studio/custom-chat:0:high' },
        providers: { models: { studio: { name: 'Studio', models: [{
          id: 'custom-chat:0', name: 'Custom Chat', api: 'openai-responses', baseUrl: 'https://studio.example/v1',
          reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 4096,
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        }] } } },
      },
    };
    let configured = true;
    const vault = {
      cloudInferenceCatalog: async () => configured ? { profile, assignmentRevision: 4, accounts: [
        { id: 'key', provider: 'studio', type: 'api_key', revision: 1, expiresAt: null, identity: null },
        { id: 'legacy', provider: 'openai-codex', type: 'oauth', revision: 1, expiresAt: 1, identity: null },
      ] } : null,
      resolveCloudInference: rejectMutation, cloudCredentialAccounts: rejectMutation,
      cloudResolveCredential: rejectMutation, cloudCredentialFailure: rejectMutation,
    };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(rejectMutation);
    const runtime = await createCloudRuntimeInference(state, { ACCOUNT_ID: 'account', CREDENTIALS: { getByName: () => vault } } as unknown as Env, RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }));
    const catalog = await runtime.session.catalog();
    expect(catalog).toEqual({
      models: [{ provider: 'studio', id: 'custom-chat:0', name: 'Custom Chat', contextWindow: 32768 }],
      roles: [{ id: 'custom', label: 'custom', provider: 'studio', model: 'custom-chat:0', thinking: 'high', current: false }],
      inference: { profileId: 'configured', profileName: 'Configured', profileRevision: 3, assignmentRevision: 4 },
      approvalDefault: 'yolo',
    });
    expect(runtime.models.getModel('studio', 'custom-chat:0')).toMatchObject({ name: 'Custom Chat', contextWindow: 32768 });
    expect(runtime.models.getModels('studio').map(model => model.id)).toEqual(['custom-chat:0']);
    configured = false;
    expect(await runtime.session.catalog()).toEqual({ models: [], roles: [] });
    expect(runtime.models.getModel('studio', 'custom-chat:0')).toBeUndefined();
    expect(rejectMutation).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads control and history with no migrated vault snapshot without adopting approval or resolving inference', async () => {
    const rejectMutation = vi.fn(async (): Promise<never> => { throw new Error('Vault requires explicit inference admission'); });
    const vault = {
      cloudInferenceCatalog: async () => null,
      resolveCloudInference: rejectMutation, cloudCredentialAccounts: rejectMutation,
      cloudResolveCredential: rejectMutation, cloudCredentialFailure: rejectMutation,
    };
    const runtime = await createCloudRuntimeInference(
      { storage: { get: async () => undefined, put: rejectMutation, delete: rejectMutation } } as unknown as DurableObjectState,
      { ACCOUNT_ID: 'account', CREDENTIALS: { getByName: () => vault } } as unknown as Env,
      RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }),
    );
    const f = await sessionFixture(runtime, rejectMutation);
    try {
      const commands = [
        { type: 'control' },
        { type: 'historyPage', request: { anchorId: null, direction: 'around', cursor: null } },
        { type: 'transcriptPage', request: { generation: null, before: null, after: null, around: null } },
        { type: 'transcriptContent', request: { generation: 'history', rowId: 'saved', offset: 0 } },
      ] as const;
      for (const command of commands) {
        const result = await f.controls.execute(String(f.root.id), command);
        expect(result.control).toMatchObject({ sessionId: String(f.root.id), models: [], roles: [], approvalMode: 'always-ask' });
        if (command.type !== 'control') expect(result[command.type]).toBeDefined();
      }
      expect((await f.harness.snapshot(SessionControlsDoc, f.root.id, BACKGROUND_CONTEXT))?.approvalMode).toBeNull();
      expect(rejectMutation).not.toHaveBeenCalled();
      await expect(f.controls.execute(String(f.root.id), { type: 'prompt', text: 'Explicit admission' })).rejects.toThrow('Vault requires explicit inference admission');
      expect(rejectMutation).toHaveBeenCalledTimes(1);
      expect((await f.harness.snapshot(SessionControlsDoc, f.root.id, BACKGROUND_CONTEXT))?.approvalMode).toBeNull();
    } finally { await f.harness.close(BACKGROUND_CONTEXT); }
  });

  it('previews configured approval without adopting it, then retains authoritative and explicit session modes', async () => {
    let profile: InferenceProfile = { version: 1, id: 'profile', name: 'Profile', revision: 1, settings: { 'approval.defaultMode': 'yolo', 'modelRoles.default': 'openai-codex/retired' }, createdAt: stamp, updatedAt: stamp };
    const rejectMutation = vi.fn(async (): Promise<never> => { throw new Error('Unexpected credential resolution or storage write'); });
    const resolveCloudInference = vi.fn(async () => ({ profile, assignmentRevision: 1 }));
    const vault = {
      cloudInferenceCatalog: async () => ({ profile, assignmentRevision: 1, accounts: [] }),
      resolveCloudInference, cloudCredentialAccounts: rejectMutation, cloudResolveCredential: rejectMutation,
    };
    const runtime = await createCloudRuntimeInference(
      { storage: { get: async () => undefined, put: rejectMutation, delete: rejectMutation } } as unknown as DurableObjectState,
      { ACCOUNT_ID: 'account', CREDENTIALS: { getByName: () => vault } } as unknown as Env,
      RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }),
    );
    const approvalDefault = async () => profileApprovalMode((await vault.resolveCloudInference()).profile.settings);
    const f = await sessionFixture(runtime, approvalDefault);
    try {
      expect((await f.controls.control(f.root)).approvalMode).toBe('yolo');
      expect((await f.harness.snapshot(SessionControlsDoc, f.root.id, BACKGROUND_CONTEXT))?.approvalMode).toBeNull();
      profile = { ...profile, revision: 2, settings: { ...profile.settings, 'approval.defaultMode': 'always-ask' } };
      expect((await f.controls.control(f.root)).approvalMode).toBe('always-ask');
      expect(resolveCloudInference).not.toHaveBeenCalled();
      expect(rejectMutation).not.toHaveBeenCalled();
      expect(await sessionApprovalMode(f.root, f.root.id, BACKGROUND_CONTEXT, approvalDefault)).toBe('always-ask');
      profile = { ...profile, revision: 3, settings: { ...profile.settings, 'approval.defaultMode': 'yolo' } };
      expect((await f.controls.control(f.root)).approvalMode).toBe('always-ask');
      expect(await sessionApprovalMode(f.root, f.root.id, BACKGROUND_CONTEXT, approvalDefault)).toBe('always-ask');
      await f.controls.execute(String(f.root.id), { type: 'setApproval', approvalMode: 'write' }, true);
      expect((await f.controls.control(f.root)).approvalMode).toBe('write');
      expect(await sessionApprovalMode(f.root, f.root.id, BACKGROUND_CONTEXT, approvalDefault)).toBe('write');
      expect(resolveCloudInference).toHaveBeenCalledTimes(1);
      expect(rejectMutation).not.toHaveBeenCalled();
    } finally { await f.harness.close(BACKGROUND_CONTEXT); }
  });
});
