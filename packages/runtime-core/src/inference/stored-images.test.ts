import { expect, it } from 'vitest';
import { createAssistantMessageEventStream, InMemoryModelsStore, type Api, type AssistantMessage, type Context, type Model, type Provider, type TranscriptContext } from '@earendil-works/pi-ai';
import { createVaultModels } from './index';
import { createRequestGate } from './request-gate';
import { imageReference } from './image-requests';

const providerId = 'stored-images-provider';
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const base = { provider: providerId, baseUrl: 'https://provider.invalid', input: ['text', 'image'] as Array<'text' | 'image'>, cost, reasoning: false, contextWindow: 8192, maxTokens: 1024 };
/** Bedrock Converse writes image bytes into its request itself; the other sends the base64 text it is given. */
const bytesModel: Model<Api> = { ...base, id: 'bytes', name: 'Writes bytes', api: 'bedrock-converse-stream' };
const textModel: Model<Api> = { ...base, id: 'text', name: 'Sends text', api: 'stored-images-text' };
const reference = imageReference({ workspaceId: 'workspace', size: 6, width: 1, height: 1, sha256: 'a'.repeat(64) });

it('a provider that writes image bytes itself gets stored images loaded; any other gets their references', async () => {
  const received = new Map<string, unknown[]>();
  const transport = (model: Model<Api>, context: TranscriptContext) => {
    received.set(model.id, context.messages.flatMap(message => message.role === 'user' && typeof message.content !== 'string' ? message.content.filter(part => part.type === 'image').map(part => part.data) : []));
    const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: reply });
    stream.end(reply);
    return stream;
  };
  const provider: Provider = {
    id: providerId, name: 'Stored images provider',
    auth: { apiKey: { name: 'Test key', async resolve({ credential }) { return credential?.key ? { auth: { apiKey: credential.key } } : undefined; } } },
    getModels: () => [bytesModel, textModel], getAllModels: () => [bytesModel, textModel],
    stream: transport, streamSimple: transport,
  };
  const account = { id: 'key', provider: providerId, type: 'api_key' as const, revision: 1, expiresAt: null, identity: 'key' };
  const models = await createVaultModels({
    profileId: 'profile', workspaceId: 'workspace', modelsStore: new InMemoryModelsStore(), providers: [provider], gate: createRequestGate(),
    pins: { async read() { return null; }, async write() {} },
    vault: { async list() { return [account]; }, async resolve() { return { id: 'key', provider: providerId, revision: 1, credential: { type: 'api_key', key: 'key' } }; }, async recordFailure() { return { label: 'key', until: 0 }; } },
    images: { send: async () => { throw new Error('No request here goes through the inference Worker'); }, load: async image => ({ ...image, data: 'aW1hZ2U=' }) },
  });
  const context: Context = { messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', data: reference }], timestamp: 1 }] };
  for (const model of [bytesModel, textModel]) {
    const admitted = models.getModel(providerId, model.id);
    if (!admitted) throw new Error(`${model.id} was not admitted`);
    await models.streamSimple(admitted, context).result();
  }
  expect(received.get('bytes')).toEqual(['aW1hZ2U=']);
  expect(received.get('text')).toEqual([reference]);
});
