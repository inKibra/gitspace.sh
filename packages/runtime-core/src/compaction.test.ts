import { expect, test } from 'vitest';
import { AssistantEntry, MemoryStorage, ToolResultEntry, UserEntry } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { createRuntimeHarness, type RuntimeHarnessOptions } from './harness.js';

const model: Model<Api> = { id: 'summarizer', name: 'Summarizer', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
const OUTPUT = 'y'.repeat(150_000), LOG = `case 7 failed\n${OUTPUT}`;
const answer = (text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, stopReason, ...(stopReason === 'error' ? { errorMessage: 'prompt is too long' } : {}), timestamp: Date.now(), usage });

/** A conversation holding one large tool exchange, the provider's requests, and the record of unfinished requests. */
async function fixture(options: { fullFails?: boolean; unfinished?: Record<string, number> } = {}) {
  const requests: Context[] = [];
  const unfinished = new Map(Object.entries(options.unfinished ?? {}));
  /** Requests refused by signal never reach the provider; their reasons are what the user is shown. */
  const refused = new WeakMap<AbortSignal, string>();
  const refusals: string[] = [];
  const refusal = (signal: AbortSignal | undefined) => {
    const reason = signal ? refused.get(signal) : undefined;
    if (reason !== undefined) refusals.push(reason);
    return reason;
  };
  const models = { ...createModels(), getModel: () => model,
    async completeSimple(_model: Model<Api>, request: Context, streamOptions?: { signal?: AbortSignal }) {
      if (refusal(streamOptions?.signal) !== undefined) return answer('', 'error');
      requests.push(request);
      return options.fullFails && JSON.stringify(request.messages).length > 100_000 ? answer('', 'error') : answer('Handoff: wrote big.ts, the test log failed at case 7.');
    },
    streamSimple(_model: Model<Api>, request: Context, streamOptions?: { signal?: AbortSignal }) {
      const stream = createAssistantMessageEventStream();
      const reason = refusal(streamOptions?.signal);
      if (reason === undefined) requests.push(request);
      const reply = reason === undefined ? answer('Continuing.') : { ...answer('', 'error'), errorMessage: reason };
      if (reason === undefined) stream.push({ type: 'done', reason: 'stop', message: reply });
      else stream.push({ type: 'error', reason: 'error', error: reply });
      stream.end(reply);
      return stream;
    } };
  const options_: RuntimeHarnessOptions = {
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: { invoke: unused, prepareBrowser: unused, takeoverTab: unused, instructions: async () => '', preflight: async () => {} },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [], judge: unused, matchAst: unused }, editTool: () => 'edit',
    onReport: error => { throw error; }, admitInference: unused, bindInferenceConversation: async () => {}, refuseRequest: (signal, reason) => { refused.set(signal, reason); },
    unfinished: { begin: key => { const earlier = unfinished.get(key) ?? 0; unfinished.set(key, earlier + 1); return earlier; }, end: key => { unfinished.delete(key); } },
  };
  const { harness, root } = await createRuntimeHarness(options_);
  await root.commit(async tx => {
    await tx.appendEntry(UserEntry, root.id, { model: [{ role: 'user', content: 'Write big.ts and run the tests', timestamp: 1 }] });
    await tx.appendEntry(AssistantEntry, root.id, { model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'big.ts', content: 'x'.repeat(150_000) } }], api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: 2, usage }] });
    await tx.appendEntry(ToolResultEntry, root.id, { model: [{ role: 'toolResult', toolCallId: 'write-1', toolName: 'write', content: [{ type: 'text', text: LOG }], isError: false, timestamp: 3 }], data: { diagnostics: [] } });
    for (let turn = 0; turn < 8; turn++) await tx.appendEntry(UserEntry, root.id, { model: [{ role: 'user', content: `Recent request ${turn}: ${'z'.repeat(12_000)}`, timestamp: 4 + turn }] });
  }, context);
  return { harness, root, requests, unfinished, refusals };
}
const sent = (request: Context) => JSON.stringify(request.messages);

test('compaction sends the full prefix first and, when that fails, the prefix without heavy tool output', async () => {
  const { harness, root, requests, unfinished } = await fixture({ fullFails: true });
  try {
    await root.compact(undefined, context);
    await root.waitForIdle(context);
    expect(requests).toHaveLength(2);
    expect(sent(requests[0]!)).toContain(OUTPUT);
    expect(sent(requests[1]!)).toContain('case 7 failed');
    expect(sent(requests[1]!)).toContain('more characters left out of this summary request');
    expect(sent(requests[1]!).length).toBeLessThan(30_000);
    expect(JSON.stringify((await root.entries({}, 100, undefined, context)).items)).toContain('Handoff: wrote big.ts');
    expect(unfinished.size).toBe(0);
  } finally { await harness.close(context); }
}, 10_000);

test('a compaction resets cut off is retried whole once, then without heavy tool output, then refused in words', async () => {
  for (const [earlier, expected] of [[1, 'full'], [2, 'lean'], [3, 'refused']] as const) {
    const { harness, root, requests, unfinished, refusals } = await fixture({ unfinished: { 'compaction:1': earlier } });
    try {
      await root.compact(undefined, context).catch(() => undefined);
      await root.waitForIdle(context);
      if (expected === 'refused') {
        // Neither this hook nor pi's own summarizer sends the prefix again.
        expect(requests).toHaveLength(0);
        expect(refusals.at(-1)).toContain('Compaction was cut off by a workspace reset 3 times');
        expect(unfinished.has('compaction:1')).toBe(false);
        continue;
      }
      expect(requests).toHaveLength(1);
      expect(sent(requests[0]!).includes(OUTPUT)).toBe(expected === 'full');
    } finally { await harness.close(context); }
  }
}, 20_000);

test('a turn resets cut off is sent whole once more, then with older tool output cut down, and the next turn is whole again', async () => {
  for (const [earlier, full] of [[1, true], [2, false]] as const) {
    const { harness, root, requests, unfinished } = await fixture({ unfinished: { 'turn:1': earlier } });
    try {
      await root.submit({ type: 'input', content: 'keep going', requestId: 'resume' }, context);
      await root.waitForIdle(context);
      expect(sent(requests[0]!).includes(OUTPUT)).toBe(full);
      expect(sent(requests[0]!)).toContain('case 7 failed');
      expect(unfinished.has('turn:1')).toBe(false);
      await root.submit({ type: 'input', content: 'and again', requestId: 'next' }, context);
      await root.waitForIdle(context);
      expect(sent(requests.at(-1)!)).toContain(OUTPUT);
    } finally { await harness.close(context); }
  }
}, 20_000);

test('a turn resets cut off three times fails in words without a request, and the next message is sent whole', async () => {
  const { harness, root, requests, unfinished, refusals } = await fixture({ unfinished: { 'turn:1': 3 } });
  try {
    await root.submit({ type: 'input', content: 'keep going', requestId: 'resume' }, context);
    await root.waitForIdle(context);
    expect(requests).toHaveLength(0);
    expect(refusals).toEqual([expect.stringContaining("This turn's model request was cut off by a workspace reset 3 times")]);
    expect(unfinished.has('turn:1')).toBe(false);
    expect(JSON.stringify((await root.entries({}, 100, undefined, context)).items)).toContain('stopped sending it');
    await root.submit({ type: 'input', content: 'try again', requestId: 'retry' }, context);
    await root.waitForIdle(context);
    expect(requests).toHaveLength(1);
    expect(sent(requests[0]!)).toContain(OUTPUT);
  } finally { await harness.close(context); }
}, 10_000);
