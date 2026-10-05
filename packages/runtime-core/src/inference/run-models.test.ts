import { expect, it } from 'vitest';
import { createAssistantMessageEventStream, InMemoryModelsStore, type Api, type Model, type AssistantMessage, type Provider } from '@earendil-works/pi-ai';
import { createRunModelsRouter } from './run-models.js';
import { createVaultModels } from './index.js';

it('dispatches the signal-bound admission even when the picker changes the model and API', async () => {
  const original: Model<Api> = { provider: 'test', id: 'original', name: 'Original', api: 'openai-responses', baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const next: Model<Api> = { ...original, id: 'next', api: 'anthropic-messages' };
  const dispatch = (model: Model<Api>) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `${model.api}/${model.id}` }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'done', reason: 'stop', message }); stream.end();
    return stream;
  };
  const provider: Provider = { id: 'test', name: 'Test', getModels: () => [original, next], auth: { apiKey: { name: 'Local fake', resolve: async () => ({ auth: { apiKey: 'unused' }, source: 'test' }) } }, stream: dispatch, streamSimple: dispatch };
  const models = await createVaultModels({
    profileId: 'profile', conversationId: 'conversation', providers: [provider], modelsStore: new InMemoryModelsStore(),
    pins: { read: async () => null, write: async () => {} },
    vault: {
      list: async () => [{ id: 'key', provider: 'test', type: 'api_key', revision: 1, expiresAt: null, identity: 'test' }],
      resolve: async () => ({ id: 'key', provider: 'test', revision: 1, credential: { type: 'api_key', key: 'local-fake' } }),
    },
  });
  const first = new AbortController();
  const second = new AbortController();
  const router = createRunModelsRouter(models, async signal => ({ ...models, getModel: () => signal === first.signal ? original : next }));
  const [inFlight, newAdmission] = await Promise.all([
    router.models.completeSimple(next, { messages: [] }, { signal: first.signal }),
    router.models.completeSimple(next, { messages: [] }, { signal: second.signal }),
  ]);
  expect(inFlight.stopReason).toBe('stop');
  expect(newAdmission.stopReason).toBe('stop');
  expect(inFlight.model).toBe('original');
  expect(inFlight.api).toBe('openai-responses');
  expect(newAdmission.model).toBe('next');
  expect(newAdmission.api).toBe('anthropic-messages');
  const incompatible = await router.models.complete(next, { messages: [] }, { signal: first.signal });
  expect(incompatible.stopReason).toBe('error');
  expect(incompatible.errorMessage).toContain('Model API is not admitted');
});
