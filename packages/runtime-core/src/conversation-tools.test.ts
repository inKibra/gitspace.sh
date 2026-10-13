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
import { SessionControlsDoc, createSessionControls, parseCloudAgentDefinition, sessionControlsExtension } from './session-controls.js';
import { PlanDoc, WorkspaceDoc } from './documents.js';
import type { RuntimeHarnessOptions } from './harness.js';
import { resolveModelSelection, resolveProfileModel } from './inference/admission.js';

const context = BACKGROUND_CONTEXT;
const model: Model<Api> = { id: 'child-fixture', name: 'Child fixture', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const definition = AgentDefinitionSchema.parse({ name: 'review', description: 'Review source', source: 'cloud', path: '.agents/agents/review.md', editable: true, content: '---\nmodel: test/file-model\nthinking: low\ntools: read\n---\nOnly the saved reviewer persona.', revision: 'exact-file-revision', modelSelectors: ['test/file-model'], role: null, provider: 'test', model: 'file-model', thinking: 'low', selection: 'definition', tools: ['read'], spawns: null });
const Owner = defineTask<{ label: string }, { phase: 'hold' }, null>({ name: 'proof.SpawnOwner', version: 1, initial: () => ({ phase: 'hold' }), phases: { async hold(task, runtime, ctx) { if (task.input.label !== 'complete') await runtime.sleep(Date.now() + 300000, ctx); await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx); } }, async abort(_task, runtime, ctx) { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx); } });
async function fixture(ownerLabel = 'spawns', files?: Array<{ path: string; content: string }>) {
  const storage = new MemoryStorage();
  const registry = createRegistry();
  const ready = Promise.withResolvers<ConversationLifecycle>();
  const backgroundAgentTask = createBackgroundAgentTask(async event => (await ready.promise).deliver(event));
  const tools = ['read', 'write', 'agents'].map(name => defineTool({ name, description: name, parameters: Type.Object({}), async execute() { return { content: [{ type: 'text' as const, text: name }] }; } }));
  registry.install(defineExtension({ name: 'proof.agents', tasks: [Owner, backgroundAgentTask], tools }));
  registry.install(sessionControlsExtension);
  const seen: string[] = [];
  const requests: Array<{ model: string; reasoning: NonNullable<Parameters<Models['streamSimple']>[2]>['reasoning'] }> = [];
  const backgroundReceived = Promise.withResolvers<void>();
  const available = ['file-model', 'role-model', 'default-model', 'parent-only-model'].map(id => ({ ...model, id }));
  const settings = { modelRoles: { default: 'test/default-model:high', review: ['other/role-model:low', 'pi/reviewer'], reviewer: 'test/role-model:medium' } };
  const models: Models = { ...createModels(), getModels: provider => available.filter(model => provider === undefined || model.provider === provider), getAvailable: async () => available, getModel: (_provider, id) => ({ ...model, id }), streamSimple(selected, input, options) {
    seen.push(JSON.stringify({ model: selected.id, system: input.systemPrompt, messages: input.messages }));
    requests.push({ model: selected.id, reasoning: options?.reasoning });
    if (JSON.stringify(input.messages).includes('Message from BackgroundReviewer')) backgroundReceived.resolve();
    const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Complete.' }], api: model.api, provider: model.provider, model: selected.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(reply); return stream;
  } };
  const harness = await Harness.open(storage, { registry, models, settings: { extensions: registry.snapshot().installed(), compaction: { enabled: false } } }, context);
  const root = await harness.root(context, { agent: { model: { provider: 'test', modelId: 'parent-only-model' }, thinkingLevel: 'max', instructions: 'PRIVATE PARENT PERSONA', tools } });
  await root.commit(async tx => { const state = await tx.doc(SessionControlsDoc, root.id); state.definitions = files ? [] : [definition]; state.fastMode = true; state.approvalMode = 'yolo'; state.role = 'parent'; state.selection = { kind: 'explicit', provider: 'test', modelId: 'parent-only-model' }; }, context);
  const catalog = async () => {
    const role = resolveProfileModel(settings, models, 'review');
    return { models: available.map(model => ({ provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow })), roles: [{ id: 'review', label: 'Reviewer role', provider: role.model.provider, model: role.model.id, thinking: role.thinking, current: false }] };
  };
  const admitInference: RuntimeHarnessOptions['admitInference'] = async ({ selection }) => {
    const selected = await resolveModelSelection(settings, models, selection ?? { kind: 'default' });
    return { provider: selected.model.provider, modelId: selected.model.id, thinking: selected.thinking };
  };
  const configureModel = async (id: ConversationId, selected: ModelRef) => { const child = await harness.conversation(id, context); if (!child) throw new Error('Missing child'); const metadata = (await harness.snapshot(AgentDefinitionContextDoc, id, context))?.child; await child.configure({ model: { provider: selected.provider, modelId: selected.modelId }, tools: metadata ? tools.filter(tool => metadata.tools.includes(tool.name)) : tools }, context); };
  const lifecycle = createConversationLifecycle({ harness, storage, admitInference, configureModel, wake: async () => {} }); ready.resolve(lifecycle);
  const invoke = createConversationTools({ harness, storage, lifecycle, backgroundAgentTask, admitInference, configureModel, catalog, refreshDefinitions: target => controls.loadDefinitions(target) });
  const browserTargets: string[] = [];
  const unexpectedHistory = async (): Promise<never> => { throw new Error('Unexpected history mutation'); };
  const controls = createSessionControls({
    harness, root, lifecycle, admitInference, configureModel, catalog, approvalDefault: async () => 'write',
    reload: async () => {},
    ...(files ? { loadAgentDefinitions: async () => files } : {}),
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
  return { harness, root, storage, lifecycle, call, spawned, seen, requests, controls, browserTargets, backgroundReceived: backgroundReceived.promise };
}

test('both agent directories accept declared names and invalid paths explain both choices', () => {
  for (const directory of ['.omp', '.agents']) {
    expect(parseCloudAgentDefinition(`${directory}/agents/file.md`, '---\nname: reviewer\n---\nInspect').name).toBe('reviewer');
    expect(parseCloudAgentDefinition(`${directory}/agents/file.md`, 'Inspect').name).toBe('file');
  }
  expect(() => parseCloudAgentDefinition('agents/file.md', 'Inspect')).toThrow(/\.agents\/agents\/\*\.md.*\.omp\/agents\/\*\.md/u);
});

test.each([false, true])('canonical agent name wins discovery and spawn regardless of order (reverse=%s)', async reverse => {
  const canonical = { path: '.agents/agents/canonical-file.md', content: '---\nname: reviewer\ntools: read\n---\nCANONICAL PERSONA' };
  const legacy = { path: '.omp/agents/legacy-file.md', content: '---\nname: reviewer\ntools: read\n---\nLEGACY PERSONA' };
  const files = reverse ? [canonical, legacy] : [legacy, canonical];
  const f = await fixture('spawns', files);
  try {
    const report = (await f.controls.execute(String(f.root.id), { type: 'agentSetup' })).setup;
    expect(report?.agents.map(agent => agent.path)).toEqual([canonical.path]);
    expect(report).toMatchObject({ diagnostics: [{ name: 'reviewer', winnerPath: canonical.path, ignoredPath: legacy.path }] });
    const { child } = await f.spawned({ op: 'spawn', agent: 'reviewer', task: 'Inspect' });
    expect((await child.agent(context)).instructions).toContain('CANONICAL PERSONA');
    expect((await child.agent(context)).instructions).not.toContain('LEGACY PERSONA');
    const winner = report!.agents[0]!;
    const saved = (await f.controls.execute(String(f.root.id), { type: 'saveAgentDefinition', path: winner.path, expectedRevision: winner.revision, content: canonical.content.replace('CANONICAL PERSONA', 'CLOUD PERSONA') })).setup;
    expect(saved?.agents[0]?.source).toBe('cloud');
    const cloud = await f.spawned({ op: 'spawn', agent: 'reviewer', task: 'Inspect saved override' });
    expect((await cloud.child.agent(context)).instructions).toContain('CLOUD PERSONA');
    files.splice(0, files.length, legacy);
    expect((await f.controls.execute(String(f.root.id), { type: 'agentSetup' })).setup?.agents[0]?.source).toBe('cloud');
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

test.each([
  { metadata: 'tools: read, write', error: /disallowed non-read-only tools/u },
  { metadata: 'model: test/unadmitted-model', error: /not admitted/u },
  { metadata: 'tools: [', error: /sequence/iu },
])('invalid repository definitions do not block root prompts and clear on correction or removal ($metadata)', async ({ metadata, error }) => {
  const invalidContent = `---\nname: unavailable\n${metadata}\n---\nUNAVAILABLE PERSONA`;
  const invalid = { path: '.omp/agents/legacy.md', content: invalidContent };
  const valid = { path: '.agents/agents/reviewer.md', content: '---\nname: reviewer\ntools: read\n---\nVALID PERSONA' };
  const files = [invalid, valid];
  const f = await fixture('spawns', files);
  try {
    await f.controls.execute(String(f.root.id), { type: 'prompt', text: 'Proceed despite unavailable definitions' });
    await f.root.waitForIdle(context);
    const report = (await f.controls.execute(String(f.root.id), { type: 'agentSetup' })).setup!;
    expect(report.agents.map(agent => agent.path)).toEqual([valid.path]);
    expect(report.definitionErrors).toEqual([{ path: invalid.path, message: expect.stringMatching(error) }]);
    expect((await f.harness.snapshot(SessionControlsDoc, f.root.id, context))?.definitionErrors).toEqual(report.definitionErrors);
    const rootTurn = JSON.parse(f.seen[0]!);
    const systemText = (turn: { messages: Array<{ role: string; sections?: Record<string, string | null> }> }) => turn.messages.filter(message => message.role === 'system' && message.sections && 'session-controls' in message.sections).at(-1)?.sections?.['session-controls'] ?? '';
    expect(JSON.stringify(rootTurn.messages)).toContain('Proceed despite unavailable definitions');
    expect(systemText(rootTurn)).toContain(invalid.path);
    expect(systemText(rootTurn)).toContain(report.definitionErrors![0]!.message);
    expect(systemText(rootTurn)).not.toContain('UNAVAILABLE PERSONA');
    for (const agent of ['unavailable', invalid.path]) await expect(f.call({ op: 'spawn', agent, task: 'Must not run' })).rejects.toThrow('Requested agent definition not found');
    const available = await f.spawned({ op: 'spawn', agent: 'reviewer', task: 'Inspect' });
    expect((await available.child.agent(context)).instructions).toContain('VALID PERSONA');
    expect((await f.controls.execute(String(available.child.id), { type: 'agentSetup' })).setup?.definitionErrors).toEqual([]);

    invalid.content = '---\nname: unavailable\ntools: read\n---\nCORRECTED PERSONA';
    const corrected = (await f.controls.execute(String(f.root.id), { type: 'agentSetup' })).setup!;
    expect(corrected.definitionErrors).toEqual([]);
    const restored = await f.spawned({ op: 'spawn', agent: 'unavailable', task: 'Inspect corrected definition' });
    expect((await restored.child.agent(context)).instructions).toContain('CORRECTED PERSONA');
    expect((await restored.child.agent(context)).tools.map(tool => tool.name)).toEqual(['read', 'agents']);

    invalid.content = invalidContent;
    await expect(f.call({ op: 'spawn', agent: 'unavailable', task: 'Do not reuse the previous valid definition' })).rejects.toThrow('Requested agent definition not found');
    expect((await f.harness.snapshot(SessionControlsDoc, f.root.id, context))?.definitionErrors).toEqual(report.definitionErrors);
    files.splice(0, 1);
    const removed = (await f.controls.execute(String(f.root.id), { type: 'agentSetup' })).setup!;
    expect(removed.agents.map(agent => agent.path)).toEqual([valid.path]);
    expect(removed.definitionErrors).toEqual([]);
    expect((await f.harness.snapshot(SessionControlsDoc, f.root.id, context))?.definitionErrors).toEqual([]);
    await f.controls.execute(String(f.root.id), { type: 'prompt', text: 'Proceed after removal' });
    await f.root.waitForIdle(context);
    expect(systemText(JSON.parse(f.seen.at(-1)!))).not.toContain(invalid.path);
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

test('strict cloud saves replace unavailable repository definitions and mask same-path errors', async () => {
  const file = { path: '.omp/agents/reviewer.md', content: '---\nname: reviewer\ntools: write\n---\nINVALID PERSONA' };
  const f = await fixture('spawns', [file]);
  try {
    await expect(f.controls.execute(String(f.root.id), { type: 'saveAgentDefinition', path: file.path, expectedRevision: null, content: file.content })).rejects.toThrow(/disallowed non-read-only tools/u);
    await expect(f.controls.execute(String(f.root.id), { type: 'saveAgentDefinition', path: file.path, expectedRevision: null, content: '---\nmodel: test/unadmitted-model\n---\nInspect' })).rejects.toThrow(/not admitted/u);
    const saved = (await f.controls.execute(String(f.root.id), { type: 'saveAgentDefinition', path: file.path, expectedRevision: null, content: '---\nname: reviewer\ntools: read\n---\nCLOUD PERSONA' })).setup!;
    expect(saved.definitionErrors).toEqual([]);
    expect(saved.agents).toEqual([expect.objectContaining({ path: file.path, source: 'cloud', tools: ['read'] })]);
    file.content = '---\nmodel: test/unadmitted-model\n---\nCHANGED INVALID PERSONA';
    const refreshed = (await f.controls.execute(String(f.root.id), { type: 'agentSetup' })).setup!;
    expect(refreshed.definitionErrors).toEqual([]);
    expect(refreshed.agents).toEqual(saved.agents);
    const { child } = await f.spawned({ op: 'spawn', agent: 'reviewer', task: 'Use saved override' });
    expect((await child.agent(context)).instructions).toContain('CLOUD PERSONA');
    expect((await child.agent(context)).tools.map(tool => tool.name)).toEqual(['read', 'agents']);
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

test('legacy-only discovery refreshes before spawn when canonical files appear', async () => {
  const files = [{ path: '.omp/agents/reviewer.md', content: 'Legacy instructions' }];
  const f = await fixture('spawns', files);
  try {
    const legacy = await f.spawned({ op: 'spawn', agent: 'reviewer', task: 'Inspect legacy' });
    expect((await legacy.child.agent(context)).instructions).toContain('Legacy instructions');
    files.push({ path: '.agents/agents/other.md', content: '---\nname: reviewer\n---\nFresh canonical instructions' });
    const fresh = await f.spawned({ op: 'spawn', agent: 'reviewer', task: 'Inspect refreshed' });
    expect((await fresh.child.agent(context)).instructions).toContain('Fresh canonical instructions');
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

test('role and file children independently resolve selection, persona, thinking and readonly tools', async () => {
  const f = await fixture();
  try {
    const role = await f.spawned({ op: 'spawn', role: 'review', name: 'RoleReviewer', task: 'Inspect source' });
    const file = await f.spawned({ op: 'spawn', agent: 'review', name: 'FileReviewer', task: 'Inspect file' });
    expect((await role.child.agent(context)).model?.modelId).toBe('role-model');
    expect((await role.child.agent(context)).thinkingLevel).toBe('medium');
    expect((await file.child.agent(context)).model?.modelId).toBe('file-model');
    expect((await file.child.agent(context)).thinkingLevel).toBe('low');
    expect(f.requests.map(value => value.reasoning)).toEqual(['medium', 'low']);
    expect((await file.child.agent(context)).tools.map(tool => tool.name)).toEqual(['read', 'agents']);
    expect((await role.child.agent(context)).tools.map(tool => tool.name)).not.toContain('write');
    expect(f.seen.join('\n')).not.toContain('PRIVATE PARENT PERSONA');
    expect((await file.child.agent(context)).instructions).toContain('Only the saved reviewer persona.');
    for (const child of [role.child, file.child]) {
      const controls = await f.harness.snapshot(SessionControlsDoc, child.id, context);
      expect(controls?.fastMode).toBe(false);
      expect(controls?.approvalMode).not.toBe('yolo');
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

test('passive controls leave approval unadopted until a prompt is admitted and preserve explicit overrides', async () => {
  const f = await fixture();
  try {
    await f.root.commit(async tx => { (await tx.doc(SessionControlsDoc, f.root.id)).approvalMode = null; }, context);
    await f.controls.execute(String(f.root.id), { type: 'control' });
    expect((await f.harness.snapshot(SessionControlsDoc, f.root.id, context))?.approvalMode).toBeNull();
    const admitted = await f.controls.execute(String(f.root.id), { type: 'prompt', text: 'Admit using the configured approval default.' });
    await f.root.waitForIdle(context);
    expect(admitted.control.approvalMode).toBe('write');
    expect((await f.harness.snapshot(SessionControlsDoc, f.root.id, context))?.approvalMode).toBe('write');
    await f.controls.execute(String(f.root.id), { type: 'setApproval', approvalMode: 'always-ask' }, true);
    const overridden = await f.controls.execute(String(f.root.id), { type: 'prompt', text: 'Keep my explicit approval override.' });
    await f.root.waitForIdle(context);
    expect(overridden.control.approvalMode).toBe('always-ask');
    expect((await f.harness.snapshot(SessionControlsDoc, f.root.id, context))?.approvalMode).toBe('always-ask');
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

test('default and named admissions apply effort while explicit conversation thinking wins until cycling roles', async () => {
  const f = await fixture();
  try {
    await f.root.commit(async tx => { const controls = await tx.doc(SessionControlsDoc, f.root.id); controls.selection = { kind: 'default' }; controls.role = null; }, context);
    await f.controls.execute(String(f.root.id), { type: 'prompt', text: 'Use the default role.' });
    await f.root.waitForIdle(context);
    for (const thinking of ['low', null] as const) {
      await f.controls.execute(String(f.root.id), { type: 'setThinking', thinking });
      await f.controls.execute(String(f.root.id), { type: 'prompt', text: 'Keep my explicit thinking.' });
      await f.root.waitForIdle(context);
      expect((await f.root.agent(context)).thinkingLevel).toBe(thinking ?? 'off');
    }
    await f.controls.execute(String(f.root.id), { type: 'cycleRole', direction: 'forward' });
    await f.controls.execute(String(f.root.id), { type: 'prompt', text: 'Use the named role.' });
    await f.root.waitForIdle(context);
    await f.controls.execute(String(f.root.id), { type: 'setModel', provider: 'test', model: 'file-model' });
    await f.controls.execute(String(f.root.id), { type: 'prompt', text: 'Use the selected model without inheriting the previous role effort.' });
    await f.root.waitForIdle(context);
    expect(f.requests.map(value => value.reasoning)).toEqual(['high', 'low', undefined, 'medium', undefined]);
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

test('file alternatives retain only the selected suffix and explicit frontmatter overrides it', async () => {
  const files = [
    { path: '.agents/agents/suffixed.md', content: '---\nmodel: [test/missing:low, test/file-model:high]\n---\nInspect suffix' },
    { path: '.agents/agents/override.md', content: '---\nmodel: pi/review:high\nthinking: low\n---\nInspect override' },
    { path: '.agents/agents/default.md', content: 'Inspect using profile default' },
  ];
  const f = await fixture('spawns', files);
  try {
    for (const agent of ['suffixed', 'override', 'default']) await f.spawned({ op: 'spawn', agent, task: 'Inspect' });
    expect(f.requests).toEqual([
      { model: 'file-model', reasoning: 'high' }, { model: 'role-model', reasoning: 'low' }, { model: 'default-model', reasoning: 'high' },
    ]);
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

test('persisted conversation effort predating role effort remains an explicit override', async () => {
  const f = await fixture();
  try {
    await f.root.configure({ thinkingLevel: 'low' }, context);
    await f.root.commit(async tx => { const controls = await tx.doc(SessionControlsDoc, f.root.id); controls.selection = { kind: 'default' }; delete controls.thinkingSelection; }, context);
    await f.controls.execute(String(f.root.id), { type: 'prompt', text: 'Keep my saved thinking override.' });
    await f.root.waitForIdle(context);
    expect(f.requests).toEqual([{ model: 'default-model', reasoning: 'low' }]);
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});
