import { expect, test } from 'vitest';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { createRuntimeHarness } from './harness.js';

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
const modelOf = (id: string, api: Api): Model<Api> => ({ id, name: id, provider: 'test', api, baseUrl: 'https://invalid.test', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4096 });
/** The body pi-ai builds for Bedrock with thinking on: its own interleaved-thinking beta beside the thinking fields. */
const bedrockBody = () => ({ modelId: 'model', messages: [], additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: 1024 }, anthropic_beta: ['interleaved-thinking-2025-05-14'] } });

/** The request body sent for one turn on `model`: the provider builds `bedrockBody()` and passes it through pi's payload
 * hook, as pi-ai's providers do before sending. */
async function sentBody(model: Model<Api>) {
  let sent: unknown;
  const models = Object.assign(createModels(), { getModel: () => model,
    streamSimple(_model: Model<Api>, _request: unknown, options?: SimpleStreamOptions) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const body = bedrockBody();
        sent = await options?.onPayload?.(body, model) ?? body;
        const answer: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage };
        stream.push({ type: 'done', reason: 'stop', message: answer });
        stream.end(answer);
      })();
      return stream;
    } });
  const { harness, root } = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {}, results: { put: unused, text: unused },
      async invoke(input) { return { requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text: '[]' }] }; } },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [], judge: unused, matchAst: unused }, editTool: () => 'edit',
    onReport: error => { throw error; }, admitInference: unused, bindInferenceConversation: async () => {}, refuseRequest: unused,
    unfinished: { begin: () => 0, end: () => {} },
  });
  try {
    await root.submit({ type: 'input', content: 'Write the file.', requestId: 'turn' }, context);
    await root.waitForIdle(context);
    return sent;
  } finally { await harness.close(context); }
}

test('Claude on Bedrock streams tool input: the fine-grained beta joins pi-ai\'s own, other fields kept', async () => {
  expect(await sentBody(modelOf('us.anthropic.claude-opus-5-5', 'bedrock-converse-stream'))).toEqual({
    modelId: 'model', messages: [],
    additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: 1024 }, anthropic_beta: ['interleaved-thinking-2025-05-14', 'fine-grained-tool-streaming-2025-05-14'] },
  });
});

test('Other models, Claude on other APIs and GovCloud Claude are sent as pi-ai built them', async () => {
  for (const model of [modelOf('amazon.nova-pro-v1:0', 'bedrock-converse-stream'), modelOf('claude-opus-5-5', 'anthropic-messages'), modelOf('us-gov.anthropic.claude-opus-5-5', 'bedrock-converse-stream')]) {
    expect(await sentBody(model)).toEqual(bedrockBody());
  }
});
