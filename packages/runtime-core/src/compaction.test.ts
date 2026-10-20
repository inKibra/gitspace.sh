import { expect, test } from 'vitest';
import { AssistantEntry, MemoryStorage, ToolResultEntry, UserEntry } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, type Api, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { createRuntimeHarness, type RuntimeHarnessOptions } from './harness.js';

const model: Model<Api> = { id: 'summarizer', name: 'Summarizer', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400_000, maxTokens: 4096 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };

test('a compaction request carries what tools were called and the start of what they returned, not every byte', async () => {
  const requests: Context[] = [];
  const models = { ...createModels(), getModel: () => model, async completeSimple(_model: Model<Api>, request: Context): Promise<AssistantMessage> {
    requests.push(request);
    return { role: 'assistant', content: [{ type: 'text', text: 'Handoff: wrote big.ts, the test log failed at case 7.' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage };
  } };
  const options: RuntimeHarnessOptions = {
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: { invoke: unused, prepareBrowser: unused, instructions: async () => '', authorizeCronTool: unused, preflight: async () => {} },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [], judge: unused, matchAst: unused }, editTool: () => 'edit',
    onReport: error => { throw error; }, admitInference: unused, bindInferenceConversation: async () => {},
  };
  const { harness, root } = await createRuntimeHarness(options);
  try {
    const file = 'x'.repeat(150_000), log = `case 7 failed\n${'y'.repeat(150_000)}`;
    await root.commit(async tx => {
      await tx.appendEntry(UserEntry, root.id, { model: [{ role: 'user', content: 'Write big.ts and run the tests', timestamp: 1 }] });
      await tx.appendEntry(AssistantEntry, root.id, { model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'big.ts', content: file } }], api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: 2, usage }] });
      await tx.appendEntry(ToolResultEntry, root.id, { model: [{ role: 'toolResult', toolCallId: 'write-1', toolName: 'write', content: [{ type: 'text', text: log }], isError: false, timestamp: 3 }], data: { diagnostics: [] } });
      for (let turn = 0; turn < 8; turn++) await tx.appendEntry(UserEntry, root.id, { model: [{ role: 'user', content: `Recent request ${turn}: ${'z'.repeat(12_000)}`, timestamp: 4 + turn }] });
    }, context);
    await root.compact(undefined, context);
    await root.waitForIdle(context);
    expect(requests).toHaveLength(1);
    const sent = JSON.stringify(requests[0]!.messages);
    expect(sent).toContain('big.ts');
    expect(sent).toContain('case 7 failed');
    expect(sent).toContain('more characters left out of this summary request');
    expect(sent.length).toBeLessThan(30_000);
    const entries = await root.entries({}, 100, undefined, context);
    expect(JSON.stringify(entries.items)).toContain('Handoff: wrote big.ts');
  } finally { await harness.close(context); }
}, 10_000);
