import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferenceProfile } from '@gitspace/protocol/inference';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { createCloudRuntimeInference } from '../src/runtime-inference.js';

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
    profile = { ...profile, settings: { 'modelRoles.default': `openai/${first.id}`, 'modelRoles.fast': `openai/${first.id}` } };
    const admitted = await runtime.admitInference({ conversationId: 'conversation', requestId: 'first', selection: { kind: 'role', role: 'fast' } });
    expect(admitted.modelId).toBe(first.id);
    await runtime.bindInferenceConversation('conversation', new AbortController().signal, [], ['first'], { fastMode: false });
    profile = { ...profile, revision: 2, settings: { 'modelRoles.default': `openai/${second.id}`, 'modelRoles.fast': `openai/${second.id}` } };
    assignmentRevision = 2;
    const next = await runtime.admitInference({ conversationId: 'conversation', requestId: 'second', selection: { kind: 'role', role: 'fast' } });
    expect(next.modelId).toBe(second.id);
    expect(await runtime.admitInference({ conversationId: 'child', requestId: 'child', parentConversationId: 'conversation' })).toEqual(admitted);
    expect(await runtime.admitInference({ conversationId: 'conversation', requestId: 'first' })).toEqual(admitted);
    const fallback = await runtime.admitInference({ conversationId: 'conversation', requestId: 'removed', selection: { kind: 'explicit', provider: 'openai', modelId: 'removed' } });
    expect(fallback.modelId).toBe(second.id);
    const recovered = await createCloudRuntimeInference(state, environment, identity);
    expect(await recovered.admitInference({ conversationId: 'conversation', requestId: 'first' })).toEqual(admitted);
    const notices = await recovered.bindInferenceConversation('conversation', new AbortController().signal, [], ['removed'], { fastMode: false });
    expect(notices).toEqual([{ requestId: 'removed', message: expect.stringContaining('openai/removed') }]);
    expect((await recovered.session.catalog()).inference?.profileRevision).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 4 * 60 * 60 * 1000 + 1;
    await recovered.session.catalog();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
