import { afterEach, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, InMemoryModelsStore, type Api, type AssistantMessage, type Context, type Model, type Provider, type StreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import { createRequestGate } from './request-gate';
import { createVaultModels } from './index';
import { attemptEvents, attemptEventStream, createAttemptRunner, restoreStandIns, type AttemptRunner } from './attempts';
import { imageReference } from './image-requests';

const providerId = 'attempt-provider';
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const base = { provider: providerId, baseUrl: 'https://provider.invalid', input: ['text', 'image'] as Array<'text' | 'image'>, cost, reasoning: false, contextWindow: 8192, maxTokens: 1024 };
const chat: Model<Api> = { ...base, id: 'chat', name: 'Chat', api: 'attempt-chat' };
const bedrock: Model<Api> = { ...base, id: 'bedrock', name: 'Bedrock-shaped', api: 'bedrock-converse-stream' };
const reference = imageReference({ workspaceId: 'workspace', size: 6, width: 1, height: 1, sha256: 'a'.repeat(64) });
const context: Context = { messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', data: reference }], timestamp: 1 }] };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Seen = { model: string; images: string[]; standInRestored?: string; aborted?: boolean };
function provider(seen: Seen[], options: { hold?: Promise<void>; started?: () => void; aborted?: () => void } = {}): Provider {
  const transport = (model: Model<Api>, received: TranscriptContext, request?: StreamOptions) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const images = received.messages.flatMap(message => message.role === 'user' && typeof message.content !== 'string' ? message.content.flatMap(part => part.type === 'image' ? [part.data] : []) : []);
      const entry: Seen = { model: model.id, images };
      if (model.api === 'bedrock-converse-stream') entry.standInRestored = restoreStandIns(JSON.stringify({ bytes: images[0] }));
      seen.push(entry);
      // Sent through the request's fetch, as pi-ai's providers send: its answer is what the account policy reads.
      await request?.fetch?.('https://provider.invalid/v1', { method: 'POST', body: '{}' });
      if (options.hold) { request?.signal?.addEventListener('abort', () => { entry.aborted = true; options.aborted?.(); }); options.started?.(); await options.hold; }
      const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'seen' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } } };
      stream.push({ type: 'start', partial: reply });
      stream.push({ type: 'done', reason: 'stop', message: reply });
      stream.end(reply);
    })();
    return stream;
  };
  return {
    id: providerId, name: 'Attempt provider',
    auth: { apiKey: { name: 'Key', async resolve({ credential }) { return credential?.key ? { auth: { apiKey: credential.key } } : undefined; } } },
    getModels: () => [chat, bedrock], getAllModels: () => [chat, bedrock], stream: transport, streamSimple: transport,
  };
}
/** A runner on the far side of a serialization boundary, as the inference worker is. */
function remote(local: AttemptRunner): AttemptRunner {
  return async function* (attempt, signal) {
    const sent = JSON.parse(JSON.stringify(attempt));
    yield* attemptEvents(attemptEventStream(aborted => local(sent, aborted)), signal);
  };
}
async function models(run: AttemptRunner, providers: Provider[]) {
  const account = { id: 'key', provider: providerId, type: 'api_key' as const, revision: 1, expiresAt: null, identity: 'key' };
  return createVaultModels({
    profileId: 'profile', workspaceId: 'workspace', modelsStore: new InMemoryModelsStore(), providers, gate: createRequestGate(), run,
    pins: { async read() { return null; }, async write() {} },
    vault: { async list() { return [account]; }, async resolve() { return { id: 'key', provider: providerId, revision: 1, credential: { type: 'api_key', key: 'key' } }; }, async recordFailure() { return { label: 'key', until: 0 }; } },
  });
}

it('runs a streamed request as plain data across a boundary: references in, the reply and the provider\'s answer out', async () => {
  globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200, headers: { 'retry-after': '7' } }));
  const seen: Seen[] = [];
  const answers: Array<{ status: number; headers: Record<string, string> }> = [];
  const catalog = await models(remote(createAttemptRunner({ providers: () => [provider(seen)] })), [provider(seen)]);
  const result = await catalog.streamSimple(catalog.getModel(providerId, 'chat')!, context, { onResponse: response => { answers.push(response); } }).result();
  expect(result.content).toEqual([{ type: 'text', text: 'seen' }]);
  expect(seen).toEqual([{ model: 'chat', images: [reference] }]);
  expect(answers).toEqual([expect.objectContaining({ status: 200, headers: expect.objectContaining({ 'retry-after': '7' }) })]);
});

it('cancels the attempt\'s stream when its request is aborted, and the provider sees the abort', async () => {
  globalThis.fetch = vi.fn(async () => new Response('{}'));
  const seen: Seen[] = [];
  const hold = Promise.withResolvers<void>(), started = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>();
  const catalog = await models(remote(createAttemptRunner({ providers: () => [provider(seen, { hold: hold.promise, started: started.resolve, aborted: aborted.resolve })] })), [provider(seen)]);
  const controller = new AbortController();
  const result = catalog.streamSimple(catalog.getModel(providerId, 'chat')!, context, { signal: controller.signal }).result();
  await started.promise;
  controller.abort(new Error('Stopped'));
  await aborted.promise;
  expect(seen[0]?.aborted).toBe(true);
  hold.resolve();
  expect((await result).stopReason).toBe('aborted');
});

it('gives a Bedrock request base64 stand-ins that become references again in its body, only while it runs', async () => {
  globalThis.fetch = vi.fn(async () => new Response('{}'));
  const seen: Seen[] = [];
  const catalog = await models(remote(createAttemptRunner({ providers: () => [provider(seen)] })), [provider(seen)]);
  await catalog.streamSimple(catalog.getModel(providerId, 'bedrock')!, context).result();
  const standIn = seen[0]!.images[0]!;
  // pi-ai's Bedrock provider decodes the data and the AWS SDK encodes it back: the stand-in survives both.
  expect(btoa(atob(standIn))).toBe(standIn);
  expect(seen[0]!.standInRestored).toBe(JSON.stringify({ bytes: reference }));
  expect(restoreStandIns(JSON.stringify({ bytes: standIn }))).toBe(JSON.stringify({ bytes: standIn }));
});
