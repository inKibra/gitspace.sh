import { expect, test } from 'vitest';
import { AssistantEntry, MemoryStorage, ToolResultEntry, UserEntry, type Conversation } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Context, type ImageContent, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { createRuntimeHarness } from './harness.js';
import { AgentDefinitionContextDoc } from './subagent-state.js';

const model: Model<Api> = { id: 'seer', name: 'Seer', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
const answer: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Seen.' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 1, usage };
/** A 100x100 PNG: only its header is read. */
const screenshot: ImageContent = { type: 'image', mimeType: 'image/png', data: btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 100, 0, 0, 0, 100, ...new Array<number>(9).fill(0))) };

/** Six screenshots taken by browser calls, then a prompt. */
async function withScreenshots(conversation: Conversation) {
  await conversation.commit(async tx => {
    await tx.appendEntry(UserEntry, conversation.id, { model: [{ role: 'user', content: 'Check the page', timestamp: 1 }] });
    for (let index = 0; index < 6; index++) {
      await tx.appendEntry(AssistantEntry, conversation.id, { model: [{ ...answer, content: [{ type: 'toolCall', id: `shot-${index}`, name: 'browser', arguments: {} }], stopReason: 'toolUse' }] });
      await tx.appendEntry(ToolResultEntry, conversation.id, { model: [{ role: 'toolResult', toolCallId: `shot-${index}`, toolName: 'browser', content: [{ type: 'text', text: `shot ${index}` }, screenshot], isError: false, timestamp: 2 }], data: { diagnostics: [] } });
    }
  }, context);
  await conversation.submit({ type: 'input', content: 'What changed?', requestId: `ask-${String(conversation.id)}` }, context);
  await conversation.waitForIdle(context);
}

test('a subagent sends its newest 4 screenshots while the main conversation sends all of them', async () => {
  const requests: Context[] = [];
  const models = { ...createModels(), getModel: () => model,
    streamSimple(_model: Model<Api>, request: Context) {
      requests.push(request);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: answer });
      stream.end(answer);
      return stream;
    } };
  const { harness, root } = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: { invoke: unused, prepareBrowser: unused, takeoverTab: unused, instructions: async () => '', authorizeCronTool: unused, preflight: async () => {} },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [], judge: unused, matchAst: unused }, editTool: () => 'edit',
    onReport: error => { throw error; }, admitInference: unused, bindInferenceConversation: async () => {}, refuseRequest: () => {},
    unfinished: { begin: () => 0, end: () => {} },
  });
  try {
    const child = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
    await child.configure({ model: { provider: 'test', modelId: model.id } }, context);
    await child.commit(async tx => {
      (await tx.doc(AgentDefinitionContextDoc, child.id)).child = { parentId: String(root.id), name: 'Looker', requestedName: 'Looker', attemptId: 'spawn-1', definition: null, selection: { kind: 'default' }, role: null, thinking: null, tools: ['browser'], model: { provider: 'test', modelId: model.id } };
    }, context);
    const shown = (request: Context) => request.messages.flatMap(message => message.role === 'toolResult' ? message.content.map(part => part.type === 'image' ? 'image' : part.text) : []);
    await withScreenshots(child);
    // The oldest 2 go as one block (half of 4); the newest 4 are sent.
    expect(shown(requests.at(-1)!).filter(part => part === 'image')).toHaveLength(4);
    expect(shown(requests.at(-1)!).slice(0, 2)).toEqual(['shot 0', '[Image not shown: older images were left out to keep this request within its image limits. Capture it again if you need it.]']);
    await withScreenshots(root);
    expect(shown(requests.at(-1)!).filter(part => part === 'image')).toHaveLength(6);
  } finally { await harness.close(context); }
}, 10_000);
