import { describe, expect, it } from 'vitest';
import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Models, type Model, type Api } from '@earendil-works/pi-ai';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, type ConversationId, type ModelRef } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from 'typebox';
import { createRetainedRulesExtension, parseRetainedRule, type RetainedRule } from './retained-rules.js';
import { createConversationTools } from './conversation-tools.js';
import { createConversationLifecycle, type ConversationLifecycle } from './conversation-lifecycle.js';
import { createBackgroundAgentTask } from './background-agents.js';

const model: Model<Api> = { id: 'controlled', name: 'Controlled', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
function message(text: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

/** A root agent whose first reply spawns a `sub` child; every model request is kept as sent. */
async function fixture(rules: RetainedRule[]) {
  const storage = new MemoryStorage();
  const requests: string[] = [];
  let harness: Harness;
  let lifecycle: ConversationLifecycle;
  const admitInference = async () => ({ provider: model.provider, modelId: model.id });
  const configureModel = async (id: ConversationId, selected: ModelRef) => {
    const conversation = await harness.conversation(id, BACKGROUND_CONTEXT);
    if (!conversation) throw new Error('Conversation missing');
    await conversation.configure({ model: selected, tools: [] }, BACKGROUND_CONTEXT);
  };
  const backgroundAgentTask = createBackgroundAgentTask(event => lifecycle.deliver(event));
  const models: Models = Object.assign(createModels(), { getModel: () => model, streamSimple(_model, input) {
    requests.push(JSON.stringify(input));
    const stream = createAssistantMessageEventStream();
    const reply = message('Done');
    if (requests.length === 1) { reply.content = [{ type: 'toolCall', id: 'spawn-call', name: 'spawn', arguments: {} }]; reply.stopReason = 'toolUse'; }
    stream.push({ type: 'done', reason: reply.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: reply }); stream.end(reply);
    return stream;
  } } satisfies Partial<Models>);
  const spawn = defineTool({ name: 'spawn', description: 'Spawn a sub agent', parameters: Type.Object({}), async execute(_args, api) {
    const result = await createConversationTools({ harness, storage, lifecycle, backgroundAgentTask, admitInference, configureModel, catalog: async () => ({ models: [], roles: [{ id: 'sub', label: 'sub', provider: model.provider, model: model.id, thinking: null, current: false }] }) })({ tool: 'agents', args: { op: 'spawn', role: 'sub', task: 'Child task' }, conversationId: String(api.conversationId), taskId: String(api.taskId), requestId: 'spawn-request', attemptId: 'spawn-attempt', replay: 'unsafe', signal: AbortSignal.timeout(30_000) });
    return { output: result.status === 'completed' ? result.content : [{ type: 'text' as const, text: 'Spawn failed' }] };
  } });
  const registry = createRegistry();
  registry.install(createRetainedRulesExtension({ async loadRules() { return rules; } }));
  registry.install(defineExtension({ name: 'effects', tools: [spawn], tasks: [backgroundAgentTask] }));
  harness = await Harness.open(storage, { registry, models, settings: { compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
  lifecycle = createConversationLifecycle({ report: error => { throw error; }, harness, storage, admitInference, configureModel });
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id }, tools: [spawn] } });
  return { root, requests, harness };
}

describe('project rules', () => {
  it('gives each agent the rules scoped to it: always-applied ones inline, the others by name to read', async () => {
    const f = await fixture([
      parseRetainedRule('main.md', '---\nagents: main\nalwaysApply: true\n---\nMAIN-ONLY-INSTRUCTION'),
      parseRetainedRule('sub.md', '---\nagents: sub\nalwaysApply: true\n---\nSUB-ONLY-INSTRUCTION'),
      parseRetainedRule('typia.md', '---\ndescription: Typia validators live in schema files\ncondition: "typia\\\\.createValidate"\n---\nMove the validator.'),
    ]);
    try {
      await f.root.submit({ type: 'input', content: 'Proceed' }, BACKGROUND_CONTEXT);
      await f.root.waitForIdle(BACKGROUND_CONTEXT);
      const [main] = f.requests;
      const child = f.requests.find(request => request.includes('Child task'));
      expect(main).toContain('MAIN-ONLY-INSTRUCTION');
      expect(main).not.toContain('SUB-ONLY-INSTRUCTION');
      expect(main).toContain('Rule typia: Typia validators live in schema files (read rule://typia)');
      expect(main).not.toContain('Move the validator.');
      expect(child).toContain('SUB-ONLY-INSTRUCTION');
      expect(child).not.toContain('MAIN-ONLY-INSTRUCTION');
    } finally { await f.harness.close(BACKGROUND_CONTEXT); }
  });
});
