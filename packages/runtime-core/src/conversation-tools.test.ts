import { expect, test } from 'vitest';
import { z } from 'zod';
import { Type } from 'typebox';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTask, defineTool, type ConversationId, type ModelRef } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord';
import { createModels, createAssistantMessageEventStream, type Models, type Model, type Api, type AssistantMessage } from '@earendil-works/pi-ai';
import { AgentDefinitionSchema, type RuntimeSessionCommand } from '@gitspace/protocol-runtime';
import { createConversationTools } from './conversation-tools.js';
import { createConversationLifecycle, type ConversationLifecycle } from './conversation-lifecycle.js';
import { createBackgroundAgentTask } from './background-agents.js';
import { AgentDefinitionContextDoc } from './subagent-state.js';
import { SessionControlsDoc, createSessionControls } from './session-controls.js';
import { PlanDoc, WorkspaceDoc } from './documents.js';
import type { RuntimeHarnessOptions } from './harness.js';

const context = BACKGROUND_CONTEXT;
const model: Model<Api> = { id: 'child-fixture', name: 'Child fixture', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const definition = AgentDefinitionSchema.parse({ name: 'review', description: 'Review source', source: 'cloud', path: '.agents/agents/review.md', editable: true, content: '---\nmodel: test/file-model\nthinking: low\ntools: read\n---\nOnly the saved reviewer persona.', revision: 'exact-file-revision', modelSelectors: ['test/file-model'], role: null, provider: 'test', model: 'file-model', thinking: 'low', selection: 'definition', tools: ['read'], spawns: null });
const Owner = defineTask<{ label: string }, { phase: 'hold' }, null>({ name: 'proof.SpawnOwner', version: 1, initial: () => ({ phase: 'hold' }), phases: { async hold(task, runtime, ctx) { if (task.input.label !== 'complete') await runtime.sleep(Date.now() + 300000, ctx); await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx); } }, async abort(_task, runtime, ctx) { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx); } });
async function fixture(ownerLabel = 'spawns') {
  const storage = new MemoryStorage();
  const registry = createRegistry();
  const ready = Promise.withResolvers<ConversationLifecycle>();
  const backgroundAgentTask = createBackgroundAgentTask(async event => (await ready.promise).deliver(event));
  const tools = ['read', 'write', 'agents'].map(name => defineTool({ name, description: name, parameters: Type.Object({}), async execute() { return { content: [{ type: 'text' as const, text: name }] }; } }));
  registry.install(defineExtension({ name: 'proof.agents', tasks: [Owner, backgroundAgentTask], tools }));
  const seen: string[] = [];
  const backgroundReceived = Promise.withResolvers<void>();
  const models: Models = { ...createModels(), getModel: (_provider, id) => ({ ...model, id }), streamSimple(selected, input) {
    seen.push(JSON.stringify({ model: selected.id, system: input.systemPrompt, messages: input.messages }));
    if (JSON.stringify(input.messages).includes('Message from BackgroundReviewer')) backgroundReceived.resolve();
    const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Complete.' }], api: model.api, provider: model.provider, model: selected.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(reply); return stream;
  } };
  const harness = await Harness.open(storage, { registry, models, settings: { compaction: { enabled: false } } }, context);
  const root = await harness.root(context, { agent: { model: { provider: 'test', modelId: 'parent-only-model' }, thinkingLevel: 'max', instructions: 'PRIVATE PARENT PERSONA', tools } });
  await root.commit(async tx => { const state = await tx.doc(SessionControlsDoc, root.id); state.definitions = [definition]; state.fastMode = true; state.approvalMode = 'yolo'; state.role = 'parent'; state.selection = { kind: 'explicit', provider: 'test', modelId: 'parent-only-model' }; }, context);
  const catalog = async () => ({ models: [{ provider: 'test', id: 'file-model', name: 'File model', contextWindow: 100000 }], roles: [{ id: 'review', label: 'Reviewer role', provider: 'test', model: 'role-model', thinking: 'medium', current: false }] });
  const admitInference: RuntimeHarnessOptions['admitInference'] = async ({ selection }) => selection?.kind === 'explicit' ? { provider: selection.provider, modelId: selection.modelId } : { provider: 'test', modelId: selection?.kind === 'role' ? 'role-model' : 'default-model' };
  const configureModel = async (id: ConversationId, selected: ModelRef) => { const child = await harness.conversation(id, context); if (!child) throw new Error('Missing child'); const metadata = (await harness.snapshot(AgentDefinitionContextDoc, id, context))?.child; await child.configure({ model: selected, tools: metadata ? tools.filter(tool => metadata.tools.includes(tool.name)) : tools }, context); };
  const lifecycle = createConversationLifecycle({ harness, storage, admitInference, configureModel, wake: async () => {} }); ready.resolve(lifecycle);
  const invoke = createConversationTools({ harness, storage, lifecycle, backgroundAgentTask, admitInference, configureModel, catalog });
  const browserTargets: string[] = [];
  const unexpectedHistory = async (): Promise<never> => { throw new Error('Unexpected history mutation'); };
  const controls = createSessionControls({
    harness, root, lifecycle, admitInference, configureModel, catalog,
    reload: async () => {},
    browser: async id => { browserTargets.push(id); return { groups: [], records: [] }; },
    history: {
      async conversation(id) {
        const found = (await storage.scanConversations({}, 100, undefined, context)).items.find(item => String(item.id) === id);
        if (!found) throw new Error('Conversation not found');
        return found.id;
      },
      recent: async () => ({ anchorId: null, prompts: [], tokens: null }),
      page: unexpectedHistory, resolve: unexpectedHistory, transcriptPage: unexpectedHistory,
      transcriptContent: unexpectedHistory, usage: unexpectedHistory,
    },
  });
  const ownerId = await root.commit(tx => tx.createTask(Owner, { label: ownerLabel }, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true }), context);
  async function call(args: JsonValue, attemptId: string = crypto.randomUUID(), conversationId = String(root.id)) { return invoke({ tool: 'agents', args, conversationId, taskId: String(ownerId), attemptId, requestId: attemptId, replay: 'safe' }); }
  async function spawned(args: JsonValue, attempt?: string) {
    const result = await call(args, attempt);
    const text = result.content.find(part => part.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Spawn result missing');
    const output = z.object({ conversationId: z.string(), name: z.string(), submissionId: z.string() }).parse(JSON.parse(text.text));
    const records = await storage.scanConversations({}, 100, undefined, context);
    const record = records.items.find(item => String(item.id) === output.conversationId);
    if (!record) throw new Error('Spawned conversation missing');
    const child = await harness.conversation(record.id, context);
    if (!child) throw new Error('Child handle missing');
    await child.waitForIdle(context);
    return { output, child };
  }
  return { harness, root, storage, lifecycle, call, spawned, seen, controls, browserTargets, backgroundReceived: backgroundReceived.promise };
}

test('role and file children independently resolve selection, persona, thinking and readonly tools', async () => {
  const f = await fixture();
  try {
    const role = await f.spawned({ op: 'spawn', role: 'review', name: 'RoleReviewer', task: 'Inspect source' });
    const file = await f.spawned({ op: 'spawn', agent: 'review', name: 'FileReviewer', task: 'Inspect file' });
    expect((await role.child.agent(context)).model?.modelId).toBe('role-model');
    expect((await role.child.agent(context)).thinkingLevel).toBe('medium');
    expect((await file.child.agent(context)).model?.modelId).toBe('file-model');
    expect((await file.child.agent(context)).thinkingLevel).toBe('low');
    expect((await file.child.agent(context)).tools.map(tool => tool.name)).toEqual(['read', 'agents']);
    expect((await role.child.agent(context)).tools.map(tool => tool.name)).not.toContain('write');
    expect(f.seen.join('\n')).not.toContain('PRIVATE PARENT PERSONA');
    expect((await file.child.agent(context)).instructions).toContain('Only the saved reviewer persona.');
    for (const child of [role.child, file.child]) {
      const controls = await f.harness.snapshot(SessionControlsDoc, child.id, context);
      expect(controls?.fastMode).toBe(false);
      expect(controls?.approvalMode).toBe('write');
      expect(controls?.goal).toBe(null);
      expect(await f.harness.snapshot(PlanDoc, child.id, context)).toBeUndefined();
    }
    await f.root.commit(async tx => { (await tx.doc(SessionControlsDoc, f.root.id)).definitions = [{ ...definition, content: 'Changed later', revision: 'next' }]; }, context);
    expect((await f.harness.snapshot(AgentDefinitionContextDoc, file.child.id, context))?.child?.definition).toEqual(definition);
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

test('spawn retries are idempotent, sibling names unique, and forged child spawn/stop fail', async () => {
  const f = await fixture();
  try {
    const args = { op: 'spawn', role: 'review', name: 'Reviewer', task: 'Inspect' };
    const first = await f.spawned(args, 'stable-attempt');
    const retried = await f.spawned(args, 'stable-attempt');
    expect(retried.output).toEqual(first.output);
    await expect(f.call(args)).rejects.toThrow('already in use');
    await expect(f.call({ op: 'spawn', role: 'review', task: 'Nested' }, 'nested', String(first.child.id))).rejects.toThrow('cannot spawn');
    await expect(f.call({ op: 'stop', id: String(f.root.id) }, 'stop-parent', String(first.child.id))).rejects.toThrow('cannot stop');
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

test('children address parent and siblings by name or id and reject unrelated conversations', async () => {
  const f = await fixture();
  try {
    const first = await f.spawned({ op: 'spawn', role: 'review', name: 'First', task: 'Inspect' });
    const second = await f.spawned({ op: 'spawn', role: 'review', name: 'Second', task: 'Inspect' });
    await f.call({ op: 'send', to: 'Second', message: 'Named sibling message' }, 'to-sibling', String(first.child.id));
    await second.child.waitForIdle(context);
    await f.call({ op: 'send', to: 'parent', message: 'Parent result' }, 'to-parent', String(first.child.id));
    await f.root.waitForIdle(context);
    expect(f.seen.join('\n')).toContain('Message from First');
    expect(f.seen.join('\n')).toContain('Named sibling message');
    expect(f.seen.join('\n')).toContain('Parent result');
    const stranger = await f.harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
    await expect(f.call({ op: 'send', to: String(stranger.id), message: 'No cross-family delivery' }, 'stranger', String(first.child.id))).rejects.toThrow('not a parent or sibling');
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

test('background agent completion uses its durable address and wakes the idle parent', async () => {
  const f = await fixture('complete');
  try {
    await f.spawned({ op: 'spawn', role: 'review', name: 'BackgroundReviewer', task: 'Inspect', background: true });
    await f.backgroundReceived;
    await f.root.waitForIdle(context);
    expect(f.seen.join('\n')).toContain('Background agent BackgroundReviewer settled');
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
}, 5000);

test('a child session cannot change workspace phase while root controls remain usable', async () => {
  const f = await fixture();
  try {
    const { child } = await f.spawned({ op: 'spawn', role: 'review', task: 'Inspect' });
    await f.harness.commit(async tx => { (await tx.doc(WorkspaceDoc)).phase = 'code'; }, context);
    await expect(f.controls.execute(String(child.id), { type: 'setWorkspacePhase', phase: 'ship' }, true)).rejects.toThrow();
    expect((await f.harness.snapshot(WorkspaceDoc, context))?.phase).toBe('code');
    const view = await f.controls.execute(String(child.id), { type: 'control' }, true);
    expect(view.control.sessionId).toBe(String(child.id));
    await f.controls.execute(String(f.root.id), { type: 'setWorkspacePhase', phase: 'ship' }, true);
    expect((await f.harness.snapshot(WorkspaceDoc, context))?.phase).toBe('ship');
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

const childMutations = [
  { type: 'browserRevoke', machineId: 'machine', groupId: '11111111-1111-4111-8111-111111111111' },
  { type: 'browserReconcile', machineId: 'machine', recordId: 'record' },
  { type: 'browserDiscard', machineId: 'machine', recordId: 'record' },
  { type: 'reloadSettings' }, { type: 'clearQueue' }, { type: 'resume' },
] satisfies RuntimeSessionCommand[];
test.each(childMutations)('a child session rejects $type before workspace or browser effects', async command => {
  const f = await fixture();
  try {
    const { child } = await f.spawned({ op: 'spawn', role: 'review', task: 'Inspect' });
    await expect(f.controls.execute(String(child.id), command, true)).rejects.toThrow();
    expect(f.browserTargets).toEqual([]);
    if (command.type.startsWith('browser')) {
      await f.controls.execute(String(f.root.id), command, true);
      expect(f.browserTargets).toEqual([String(f.root.id)]);
    }
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});
