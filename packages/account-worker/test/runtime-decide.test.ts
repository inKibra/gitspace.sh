import { afterEach, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { InferenceProfile } from '@gitspace/protocol/inference';
import { RuntimeIdentitySchema, type ServiceUsage } from '@gitspace/protocol-runtime';
import type { AttemptRunner, InferenceAttempt } from '@gitspace/runtime-core/inference';
import { createCloudRuntimeInference } from '../src/runtime-inference.js';

const stamp = '2026-01-01T00:00:00.000Z';
afterEach(() => { vi.restoreAllMocks(); });

const questions = {
  risky: { type: 'bool', instructions: 'Could this break sign-in?' },
  size: { type: 'choice', instructions: 'How large is it?', criteria: { small: 'A few lines', large: null } },
  quality: { type: 'score', instructions: 'How good is it?', criteria: ['poor', 'fair', 'good'] },
};
/** System One's wire answers to `questions`: bool is `noul`, score asked as a choice of level indexes. */
const wireAnswers = {
  risky: { type: 'noul', noul: 0.8 },
  size: { type: 'choice', choice: 'small', probabilities: { small: 0.75, large: 0.25 }, confidence: 0.9 },
  quality: { type: 'choice', choice: '2', probabilities: { 0: 0, 1: 0.5, 2: 0.5 }, confidence: 0.6 },
};
const answers = {
  risky: { bool: 0.8 },
  size: { choice: 'small', probabilities: { small: 0.75, large: 0.25 }, confidence: 0.9 },
  quality: { score: 1.5, probabilities: { 0: 0, 1: 0.5, 2: 0.5 }, confidence: 0.6 },
};
const fastAnswers = {
  risky: { bool: 0.1 },
  size: { choice: 'large', probabilities: { small: 0, large: 1 }, confidence: 0.5 },
  quality: { score: 0, probabilities: { 0: 1, 1: 0, 2: 0 }, confidence: 0.5 },
};

it('decides with the profile\'s Decisions service on the AI binding, falls back to the fast model, and records each answer\'s usage', async () => {
  const bodies = new Map<string, unknown>();
  const state = { storage: {
    get: async (key: string) => bodies.get(key),
    put: async (key: string, value: unknown) => { bodies.set(key, structuredClone(value)); },
    delete: async (key: string) => bodies.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...bodies].filter(([key]) => key.startsWith(prefix))),
  } } as unknown as DurableObjectState;
  let profile: InferenceProfile = { version: 1, id: 'profile', name: 'Profile', revision: 1, settings: {}, createdAt: stamp, updatedAt: stamp };
  const accounts = [{ id: 'key', provider: 'anthropic', type: 'api_key', revision: 1, expiresAt: null, identity: 'key' }];
  const recorded: ServiceUsage[] = [];
  const vault = {
    resolveCloudInference: async () => ({ profile, assignmentRevision: 1 }),
    cloudInferenceCatalog: async () => ({ profile, assignmentRevision: 1, catalogJson: null, accounts }),
    cloudCredentialAccounts: async () => accounts,
    cloudResolveCredential: async () => ({ id: 'key', provider: 'anthropic', revision: 1, credential: { type: 'api_key', key: 'sk-ant-api-key' } }),
    cloudCredentialFailure: async () => ({ label: 'key', until: 0 }),
    cloudProfileCatalog: async () => '{}',
    recordServiceUsage: async (usage: ServiceUsage) => { recorded.push(usage); },
  };
  let failing = false;
  const run = vi.fn(async (model: string, input: Record<string, unknown>) => {
    if (failing) throw new Error('3040: Capacity temporarily exceeded');
    // Third-party models on Workers AI answer as a completed run; Cloudflare's own answer directly.
    const output = { answers: wireAnswers, usage: { input_tokens: 1_000_000, output_tokens: 0 } };
    return model === 'typesafe/jev' ? { state: 'Completed', result: output } : { model, ...output, seen: input };
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Decisions go through the AI binding or the inference worker'); });
  const attempts: InferenceAttempt[] = [];
  const attempt: AttemptRunner = async function* (request) {
    attempts.push(request);
    if (request.method === 'webSearch') throw new Error('No searches here');
    const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(fastAnswers) }], api: request.model.api, provider: request.model.provider, model: request.model.id, stopReason: 'stop', timestamp: 0, usage: { input: 300, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 350, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } } };
    yield { type: 'response', status: 200, headers: {} };
    yield { type: 'start', partial: reply };
    yield { type: 'done', reason: 'stop', message: reply };
  };
  const environment = { ACCOUNT_ID: 'account', CREDENTIALS: { getByName: () => vault }, AI: { run } } as unknown as Env;
  const runtime = await createCloudRuntimeInference(state, environment, RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), [], attempt);
  const chat = (await runtime.session.catalog()).models[0]!;
  const admitted = async (revision: number, decisions?: string) => {
    profile = { ...profile, revision, settings: { 'modelRoles.default': `anthropic/${chat.id}`, 'modelRoles.fast': `anthropic/${chat.id}`, ...(decisions === undefined ? {} : { decisions }) } };
    await runtime.admitInference({ conversationId: 'conversation', requestId: `request-${revision}` });
    await runtime.bindInferenceConversation('conversation', new AbortController().signal, [], [`request-${revision}`], { fastMode: false });
  };
  const decide = () => runtime.decide({ conversationId: 'conversation', args: { state: { title: 'Fix login' }, questions } });

  // Unset: Clef-flash on the platform's Cloudflare account, priced from pi-ai's catalog.
  await admitted(2);
  expect(await decide()).toEqual({ answers, model: 'cloudflare/clef-flash', usage: { input: 1_000_000, output: 0, costUsd: 0.038 }, fallback: null });
  expect(run).toHaveBeenLastCalledWith('@cf/cloudflare/clef-flash', expect.objectContaining({ state: { title: 'Fix login' }, questions: expect.objectContaining({ risky: { type: 'noul', instructions: 'Could this break sign-in?', criteria: { true: 'Yes', false: 'No' } } }) }), {});
  await admitted(3, 'cloudflare/jev');
  expect(await decide()).toMatchObject({ answers, model: 'cloudflare/jev', fallback: null });
  expect(run).toHaveBeenLastCalledWith('typesafe/jev', expect.anything(), {});
  expect(attempts).toEqual([]);

  // A failing model, and off: the fast model answers, and says why.
  failing = true;
  expect(await decide()).toEqual({ answers: fastAnswers, model: `anthropic/${chat.id}`, usage: { input: 300, output: 50, costUsd: 0.002 }, fallback: expect.stringContaining('cloudflare/jev: ') });
  await admitted(4, 'off');
  expect(await decide()).toMatchObject({ answers: fastAnswers, model: `anthropic/${chat.id}`, fallback: 'Decisions is off' });
  expect(attempts).toHaveLength(2);

  // Codemode's judge is a decision's answers alone.
  expect(await runtime.modelHelper({ conversationId: 'conversation', operation: 'judge', args: { state: 'Fix login', questions } })).toEqual(fastAnswers);
  await vi.waitFor(() => expect(recorded).toHaveLength(5));
  expect(recorded.slice(0, 3)).toEqual([
    { service: 'decision', profileId: 'profile', model: 'cloudflare/clef-flash', requests: 1, input: 1_000_000, output: 0, costUsd: 0.038 },
    { service: 'decision', profileId: 'profile', model: 'cloudflare/jev', requests: 1, input: 1_000_000, output: 0, costUsd: 0.042 },
    { service: 'decision', profileId: 'profile', model: `anthropic/${chat.id}`, requests: 1, input: 300, output: 50, costUsd: 0.002 },
  ]);
});
