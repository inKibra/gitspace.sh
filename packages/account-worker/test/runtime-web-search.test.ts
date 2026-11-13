import { afterEach, expect, it, vi } from 'vitest';
import type { InferenceProfile } from '@gitspace/protocol/inference';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import type { AttemptRunner, InferenceAttempt } from '@gitspace/runtime-core/inference';
import { createCloudRuntimeInference } from '../src/runtime-inference.js';

const stamp = '2026-01-01T00:00:00.000Z';
afterEach(() => { vi.restoreAllMocks(); });

it("searches with the profile's search selector: Cloudflare's Web Search API, or a model of the profile on its own account", async () => {
  const bodies = new Map<string, unknown>();
  const state = { storage: {
    get: async (key: string) => bodies.get(key),
    put: async (key: string, value: unknown) => { bodies.set(key, structuredClone(value)); },
    delete: async (key: string) => bodies.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...bodies].filter(([key]) => key.startsWith(prefix))),
  } } as unknown as DurableObjectState;
  let profile: InferenceProfile = { version: 1, id: 'profile', name: 'Profile', revision: 1, settings: {}, createdAt: stamp, updatedAt: stamp };
  const accounts = [{ id: 'key', provider: 'anthropic', type: 'api_key', revision: 1, expiresAt: null, identity: 'key' }];
  const vault = {
    resolveCloudInference: async () => ({ profile, assignmentRevision: 1 }),
    cloudInferenceCatalog: async () => ({ profile, assignmentRevision: 1, catalogJson: null, accounts }),
    cloudCredentialAccounts: async () => accounts,
    cloudResolveCredential: async () => ({ id: 'key', provider: 'anthropic', revision: 1, credential: { type: 'api_key', key: 'sk-ant-api-key' } }),
    cloudCredentialFailure: async () => ({ label: 'key', until: 0 }),
    cloudProfileCatalog: async () => '{}',
  };
  const websearch = vi.fn(async (request: { query: string; limit: number; provider?: string }) => Response.json({
    items: [1, 2, 3].map(index => ({ url: `https://example.com/${index}`, title: `Result ${index}`, description: `About ${request.query}` })),
    metadata: { query: request.query, requestId: 'request', latencyMs: 1 },
  }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Searches go through the AI binding or the inference worker'); });
  const attempts: InferenceAttempt[] = [];
  let reply: 'found' | 'refused' = 'found';
  const run: AttemptRunner = async function* (attempt) {
    attempts.push(attempt);
    if (reply === 'refused') {
      yield { type: 'response', status: 400, headers: {} };
      yield { type: 'webSearchError', errorMessage: '400 web search is not enabled for this organization' };
      return;
    }
    yield { type: 'response', status: 200, headers: {} };
    yield { type: 'webSearch', found: { answer: 'Shannon was born in 1916.', results: [{ title: 'Claude Shannon', url: 'https://en.wikipedia.org/wiki/Claude_Shannon', description: 'Born April 30, 1916' }] } };
  };
  const environment = { ACCOUNT_ID: 'account', CREDENTIALS: { getByName: () => vault }, AI: { websearch } } as unknown as Env;
  const runtime = await createCloudRuntimeInference(state, environment, RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), [], run);
  const chat = (await runtime.session.catalog()).models[0]!;
  const admitted = async (revision: number, search: string) => {
    profile = { ...profile, revision, settings: { 'modelRoles.default': `anthropic/${chat.id}`, search } };
    await runtime.admitInference({ conversationId: 'conversation', requestId: `request-${revision}` });
    await runtime.bindInferenceConversation('conversation', new AbortController().signal, [], [`request-${revision}`], { fastMode: false });
  };

  await admitted(2, 'cloudflare/linkup');
  expect(await runtime.webSearch({ conversationId: 'conversation', args: { query: 'claude shannon', limit: 2 } })).toEqual({
    query: 'claude shannon', provider: 'cloudflare/linkup', answer: null,
    results: [{ title: 'Result 1', url: 'https://example.com/1', description: 'About claude shannon' }, { title: 'Result 2', url: 'https://example.com/2', description: 'About claude shannon' }],
  });
  expect(websearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'claude shannon', limit: 2, provider: 'linkup' }));
  expect(attempts).toEqual([]);

  await admitted(3, `anthropic/${chat.id}`);
  expect(await runtime.webSearch({ conversationId: 'conversation', args: { query: 'claude shannon' } })).toEqual({
    query: 'claude shannon', provider: `anthropic/${chat.id}`, answer: 'Shannon was born in 1916.',
    results: [{ title: 'Claude Shannon', url: 'https://en.wikipedia.org/wiki/Claude_Shannon', description: 'Born April 30, 1916' }],
  });
  expect(attempts).toEqual([expect.objectContaining({ method: 'webSearch', model: expect.objectContaining({ provider: 'anthropic', id: chat.id }), search: { query: 'claude shannon', limit: 5 }, credential: expect.objectContaining({ id: 'key' }) })]);
  expect(websearch).toHaveBeenCalledTimes(1);

  reply = 'refused';
  await expect(runtime.webSearch({ conversationId: 'conversation', args: { query: 'claude shannon' } })).rejects.toThrow(`Web search uses anthropic/${chat.id}: 400 web search is not enabled for this organization. Change it in Inference → Services.`);
});
