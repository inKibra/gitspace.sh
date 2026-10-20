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
async function fixture(options: { fullFails?: boolean; unfinished?: string[] } = {}) {
  const requests: Context[] = [];
  const unfinished = new Set(options.unfinished ?? []);
  const models = { ...createModels(), getModel: () => model,
    async completeSimple(_model: Model<Api>, request: Context) {
      requests.push(request);
      return options.fullFails && JSON.stringify(request.messages).length > 100_000 ? answer('', 'error') : answer('Handoff: wrote big.ts, the test log failed at case 7.');
    },
    streamSimple(_model: Model<Api>, request: Context) {
      requests.push(request);
      const stream = createAssistantMessageEventStream();
      const reply = answer('Continuing.');
      stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(reply);
      return stream;
    } };
  const options_: RuntimeHarnessOptions = {
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: { invoke: unused, prepareBrowser: unused, instructions: async () => '', authorizeCronTool: unused, preflight: async () => {} },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [], judge: unused, matchAst: unused }, editTool: () => 'edit',
    onReport: error => { throw error; }, admitInference: unused, bindInferenceConversation: async () => {},
    unfinished: { begin: key => { const previous = unfinished.has(key); unfinished.add(key); return previous; }, end: key => { unfinished.delete(key); } },
  };
  const { harness, root } = await createRuntimeHarness(options_);
  await root.commit(async tx => {
    await tx.appendEntry(UserEntry, root.id, { model: [{ role: 'user', content: 'Write big.ts and run the tests', timestamp: 1 }] });
    await tx.appendEntry(AssistantEntry, root.id, { model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'big.ts', content: 'x'.repeat(150_000) } }], api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: 2, usage }] });
    await tx.appendEntry(ToolResultEntry, root.id, { model: [{ role: 'toolResult', toolCallId: 'write-1', toolName: 'write', content: [{ type: 'text', text: LOG }], isError: false, timestamp: 3 }], data: { diagnostics: [] } });
    for (let turn = 0; turn < 8; turn++) await tx.appendEntry(UserEntry, root.id, { model: [{ role: 'user', content: `Recent request ${turn}: ${'z'.repeat(12_000)}`, timestamp: 4 + turn }] });
  }, context);
  return { harness, root, requests, unfinished };
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

test('a compaction a reset cut off is retried without heavy tool output', async () => {
  const { harness, root, requests } = await fixture({ unfinished: ['compaction:1'] });
  try {
    await root.compact(undefined, context);
    await root.waitForIdle(context);
    expect(requests).toHaveLength(1);
    expect(sent(requests[0]!)).not.toContain(OUTPUT);
    expect(sent(requests[0]!)).toContain('more characters left out of this summary request');
  } finally { await harness.close(context); }
}, 10_000);

test('a turn whose request a reset cut off sends older tool output cut down, and the next turn is whole again', async () => {
  const { harness, root, requests, unfinished } = await fixture({ unfinished: ['turn:1'] });
  try {
    await root.submit({ type: 'input', content: 'keep going', requestId: 'resume' }, context);
    await root.waitForIdle(context);
    expect(sent(requests[0]!)).not.toContain(OUTPUT);
    expect(sent(requests[0]!)).toContain('case 7 failed');
    expect(unfinished.has('turn:1')).toBe(false);
    await root.submit({ type: 'input', content: 'and again', requestId: 'next' }, context);
    await root.waitForIdle(context);
    expect(sent(requests.at(-1)!)).toContain(OUTPUT);
  } finally { await harness.close(context); }
}, 10_000);
