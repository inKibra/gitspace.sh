import { afterEach, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, InMemoryModelsStore, type Api, type AssistantMessage, type Context, type Model, type Provider, type StreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { createRequestGate } from './request-gate';
import { createVaultModels } from './index';
import { attemptEvents, attemptEventStream, createAttemptRunner, restoreStandIns, type AttemptRunner } from './attempts';
import type { ImageRequestTransport } from './image-requests';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { imageReference } from '@gitspace/protocol-runtime/image-reference';

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
    vault: { async list() { return [account]; }, async resolve() { return { id: 'key', provider: providerId, revision: 1, credential: { type: 'api_key', key: 'key' } }; }, async recordFailure() { return { label: 'key', until: 0 }; }, async catalog() { return {}; } },
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

it('ends an attempt whose stream breaks with the provider\'s error, naming how long it ran, what it received and what its request carried', async () => {
  globalThis.fetch = vi.fn(async () => new Response('{}'));
  const streaming: Provider = { ...provider([]), stream: brokenTransport, streamSimple: brokenTransport };
  function brokenTransport(model: Model<Api>, received: TranscriptContext, request?: StreamOptions) {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      // The body carries the stored image as its reference, as pi-ai's providers serialize it.
      await request?.fetch?.('https://provider.invalid/v1', { method: 'POST', body: JSON.stringify(received) });
      const partial: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'abc' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } } };
      stream.push({ type: 'start', partial });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'abc', partial });
      // As a provider's request does, the stream ends when the attempt is cancelled.
      request?.signal?.addEventListener('abort', () => { const aborted: AssistantMessage = { ...partial, stopReason: 'aborted' }; stream.push({ type: 'error', reason: 'aborted', error: aborted }); stream.end(aborted); }, { once: true });
    })();
    return stream;
  }
  const across = remote(createAttemptRunner({ providers: () => [streaming] }));
  // The inference worker's isolate ends after the first delta: its stream breaks.
  const broken: AttemptRunner = async function* (attempt, signal) {
    for await (const event of across(attempt, signal)) {
      yield event;
      if (event.type === 'text_delta') throw new Error('Network connection lost.');
    }
  };
  const catalog = await models(broken, [streaming]);
  const result = await catalog.streamSimple(catalog.getModel(providerId, 'chat')!, context).result();
  expect(result.stopReason).toBe('error');
  expect(result.errorMessage).toMatch(/^Network connection lost\. \(after \d+\.\d s: 2 events, 3 characters received; request 0\.0 MB, 1 messages, 1 images \(0\.0 MB\)\)$/u);
  expect(isRetryableAssistantError(result)).toBe(true);
});

it('names what a request carried when its connection to the provider is lost, before or during the answer, and leaves a final error as the provider stated it', async () => {
  const refusing: Provider = { ...provider([]), stream: refusingTransport, streamSimple: refusingTransport };
  function refusingTransport(model: Model<Api>, received: TranscriptContext, request?: StreamOptions) {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      let errorMessage: string;
      try {
        const response = await request?.fetch?.('https://provider.invalid/v1', { method: 'POST', body: JSON.stringify(received) });
        // An answered 200 whose body is then cut off reads as the lost connection; any other answer is the provider's own.
        errorMessage = response?.ok ? 'Network connection lost.' : `Provider answered ${response?.status}`;
      } catch (error) { errorMessage = error instanceof Error ? error.message : String(error); }
      const failed: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: 'error', errorMessage, timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } } };
      stream.push({ type: 'error', reason: 'error', error: failed });
      stream.end(failed);
    })();
    return stream;
  }
  /** The request's catalog, its image request sent by `send` (the request carries a stored image). */
  const catalogSending = (send: ImageRequestTransport) => models(remote(createAttemptRunner({ providers: () => [refusing], imageTransport: send })), [refusing]);
  const measures = /^Network connection lost\. \(after \d+\.\d s: 1 events, 0 characters received; request 0\.0 MB, 1 messages, 1 images \(0\.0 MB\)\)$/u;
  // Lost while the request goes out: no answer arrives.
  const unanswered = await (await catalogSending(async () => { throw new Error('Network connection lost.'); })).streamSimple(chat, context).result();
  expect(unanswered.errorMessage).toMatch(measures);
  expect(isRetryableAssistantError(unanswered)).toBe(true);
  // Lost after the provider answered 200.
  const cut = await (await catalogSending(async () => new Response('{}', { status: 200 }))).streamSimple(chat, context).result();
  expect(cut.errorMessage).toMatch(measures);
  const refused = await (await catalogSending(async () => new Response('{}', { status: 400 }))).streamSimple(chat, context).result();
  expect(refused.errorMessage).toBe('Provider answered 400');
});

it('streams a long tool call across the attempt boundary in bytes linear in its arguments, every delta still carrying the message so far', async () => {
  const anthropic = builtinProviders().find(candidate => candidate.id === 'anthropic');
  const model = anthropic?.getModels().find(candidate => candidate.id === 'claude-opus-5-5');
  if (!anthropic || !model) throw new Error('Anthropic catalog missing');
  // A 40 KB file written in 4,000 deltas, as a model writes a large mock in one call.
  const piece = 'x'.repeat(10);
  const events = [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"mock.html","content":"' } },
    ...Array.from({ length: 4_000 }, () => ({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: piece } })),
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4_000 } },
    { type: 'message_stop' },
  ];
  globalThis.fetch = vi.fn(async () => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
  const attempt = { method: 'streamSimple' as const, model, context: { messages: [{ role: 'user' as const, content: 'write it', timestamp: 1 }] }, options: {}, credential: { id: 'key', provider: 'anthropic', revision: 1, credential: { type: 'api_key' as const, key: 'sk-ant-api03-test' } }, settings: {}, fastMode: false, claude: { profileId: 'profile', sessionId: 'session' } };
  let bytes = 0;
  const counted = attemptEventStream(signal => createAttemptRunner({ providers: () => [anthropic] })(attempt, signal)).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { bytes += chunk.byteLength; controller.enqueue(chunk); } }));
  const received = [];
  for await (const event of attemptEvents(counted)) received.push(event);
  // Each delta resending the whole message so far made this 163 MB.
  expect(bytes).toBeLessThan(2_000_000);
  const deltas = received.filter(event => event.type === 'toolcall_delta');
  expect(deltas).toHaveLength(4_002);
  expect(deltas.every(event => event.type === 'toolcall_delta' && event.partial.content[0]?.type === 'toolCall')).toBe(true);
  const done = received.find(event => event.type === 'done');
  expect(done?.type === 'done' && done.message.content[0]).toMatchObject({ type: 'toolCall', name: 'write', arguments: { path: 'mock.html', content: piece.repeat(4_000) } });
});
