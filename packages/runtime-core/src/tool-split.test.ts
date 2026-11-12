import { expect, test } from 'vitest';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, getCurrentTools, type Api, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { createRuntimeHarness } from './harness.js';
import { AgentDefinitionContextDoc } from './subagent-state.js';
import type { CodemodeToolOutcome, ToolServices } from './tools.js';

const model: Model<Api> = { id: 'splitter', name: 'Splitter', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
const reply = (content: AssistantMessage['content']): AssistantMessage => ({ role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason: content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: 1, usage });
const done = (input: Parameters<ToolServices['invoke']>[0], text: string): RuntimeToolResult => ({ requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text }] });

test('a main conversation calls code-only tools from codemode, and a subagent is offered the ones its definition lists', async () => {
  const offered: string[][] = [];
  const script: CodemodeToolOutcome[] = [];
  let first = true;
  const models = Object.assign(createModels(), { getModel: () => model,
    streamSimple(_model: Model<Api>, request: Context) {
      offered.push(getCurrentTools(request.messages).map(tool => tool.name).sort());
      const message = first ? reply([{ type: 'toolCall', id: 'script', name: 'codemode', arguments: { code: 'return tools.space_goal({ method: "get" })' } }]) : reply([{ type: 'text', text: 'Done.' }]);
      first = false;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
      stream.end(message);
      return stream;
    } });
  const invoke: ToolServices['invoke'] = async input => {
    if (input.tool !== 'codemode') return done(input, `${input.tool} ran`);
    if (!input.codemodeTools) throw new Error('Missing codemode authority');
    script.push(await input.codemodeTools({ tool: 'space_goal', args: { method: 'get' }, callId: 'goal', signal: AbortSignal.timeout(5000) }));
    return done(input, 'script ran');
  };
  const { harness, root, configureModel } = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, invoke, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {}, results: { put: unused, text: unused } },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: error => { throw error; }, admitInference: unused, bindInferenceConversation: async () => {}, refuseRequest: () => {},
    unfinished: { begin: () => 0, end: () => {} },
  });
  try {
    await root.submit({ type: 'input', content: 'Read the goal.', requestId: 'goal' }, context);
    await root.waitForIdle(context);
    expect(offered[0]).toContain('codemode');
    expect(offered[0]).toContain('bash');
    expect(offered[0]).not.toContain('space_goal');
    expect(offered[0]).not.toContain('history_search');
    expect(script).toEqual([{ status: 'completed', value: [{ type: 'text', text: 'space_goal ran' }] }]);

    const child = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
    await child.commit(async tx => {
      (await tx.doc(AgentDefinitionContextDoc, child.id)).child = { parentId: String(root.id), name: 'Reader', requestedName: 'Reader', attemptId: 'spawn-1', definition: null, selection: { kind: 'default' }, role: null, thinking: null, tools: ['read', 'history_search'], model: { provider: 'test', modelId: model.id } };
    }, context);
    await configureModel(child.id, { provider: 'test', modelId: model.id });
    expect((await child.agent(context)).tools.map(tool => tool.name).sort()).toEqual(['history_search', 'read']);
  } finally { await harness.close(context); }
}, 10_000);
