import { expect, test } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, type Conversation } from '@earendil-works/pi-durable';
import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Models, type Model, type Api, type ToolCall } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { PlanDoc, QuestionsDoc, TodosDoc, WorkspaceDoc } from './documents.js';
import { answerPlan, type PlanDecision } from './plan.js';
import { createRuntimeTools, type ToolServices } from './tools.js';
import type { JobServices } from './jobs.js';

const model: Model<Api> = { id: 'plan', name: 'Plan', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const unused = async (): Promise<never> => { throw new Error('Unexpected operation'); };
const operations: JobServices = { execute: unused, reconcile: unused, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, wakeAt: unused, deliverConversationEvent: unused, observeProcess: unused, stopProcess: unused };
const step = (id: string, title: string) => ({ id, title, detail: `Do ${title}.` });

/** A conversation whose model makes the queued tool calls, one call per model turn, then replies; a person answers each
 * plan proposal the call posted with the next queued answer, as the workspace runtime's `answer` records it. */
async function fixture(storage = new MemoryStorage()) {
  const turns: (ToolCall | null)[] = [];
  const answers: { approved: boolean; note: string | null }[] = [];
  const decisions: PlanDecision[] = [];
  const services: ToolServices = {
    invoke: unused, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {},
    images: { store: async image => image, load: async image => image },
    results: { put: unused, text: unused },
  };
  const tools = createRuntimeTools(services, operations, (id, context) => harness.abortTask(id, context));
  const registry = createRegistry(); registry.install(defineExtension({ name: 'plan-proof', tools }));
  const models = scriptedModels(turns);
  const harness = await Harness.open(storage, { registry, models, settings: { toolExecution: 'parallel', compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id }, tools } });
  await harness.commit(async tx => { (await tx.doc(WorkspaceDoc)).phase = 'plan'; }, BACKGROUND_CONTEXT);
  /** The person's answer to the open proposal `questionId` of `conversation`. */
  async function answer(conversation: Conversation, questionId: string, decision: { approved: boolean; note: string | null }) {
    const settled = await harness.commit(async tx => {
      const question = (await tx.doc(QuestionsDoc)).items.find(item => item.id === questionId);
      if (question) question.answer = decision;
      return answerPlan(tx, conversation.id, questionId, decision);
    }, BACKGROUND_CONTEXT);
    if (settled) decisions.push(settled);
  }
  let calls = 0;
  /** Runs one tool call in `conversation` and returns its result; a proposal it posted takes the next queued answer. */
  async function run(conversation: Conversation, name: string, args: ToolCall['arguments']) {
    const id = `call-${++calls}`;
    turns.push({ type: 'toolCall', id, name, arguments: args });
    await conversation.submit({ type: 'input', content: `Run ${name}` }, BACKGROUND_CONTEXT);
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
    const result = (await conversation.context(BACKGROUND_CONTEXT)).messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
    if (result?.role !== 'toolResult') throw new Error(`No result for ${id}`);
    const posted = Reflect.get(Object(result.details), 'questionId');
    const queued = answers.shift();
    if (typeof posted === 'string' && queued) await answer(conversation, posted, queued);
    else if (queued) answers.unshift(queued);
    return { isError: result.isError, text: result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') };
  }
  const todos = async (conversation: Conversation) => (await harness.snapshot(TodosDoc, conversation.id, BACKGROUND_CONTEXT))?.items;
  const plan = () => harness.snapshot(PlanDoc, root.id, BACKGROUND_CONTEXT);
  return { harness, root, answers, decisions, answer, run, todos, plan, statuses, tools };
  /** The plan in effect, as each step's status by id. */
  async function statuses() {
    const value = await plan();
    const steps = value?.status === 'approved' ? value.steps : value?.approved?.steps;
    return Object.fromEntries((steps ?? []).map(item => [item.id, item.status]));
  }
}

/** Models that make the queued tool calls, one per turn, then reply. */
function scriptedModels(turns: (ToolCall | null)[]): Models {
  return Object.assign(createModels(), { getModel: () => model, streamSimple() {
    const call = turns.shift() ?? null;
    const reply: AssistantMessage = { role: 'assistant', content: call ? [call] : [{ type: 'text', text: 'Done.' }], api: model.api, provider: model.provider, model: model.id, stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message: reply }); stream.end(reply); return stream;
  } });
}

test('an approved plan loads the todo list; only linked items move its steps, and from:"plan" resumes it after a detour', async () => {
  const f = await fixture();
  try {
    expect(await f.run(f.root, 'todo', { from: 'plan' })).toMatchObject({ isError: true, text: expect.stringContaining('no approved plan') });
    f.answers.push({ approved: true, note: null });
    expect(await f.run(f.root, 'propose_plan', { prompt: 'Build loyalty stamps', choices: [], steps: [step('model', 'the model'), step('api', 'the API'), step('ui', 'the UI')] })).toMatchObject({ isError: false });
    expect(await f.todos(f.root)).toEqual([
      { id: 'model', text: 'the model', status: 'pending', planStep: 'model' },
      { id: 'api', text: 'the API', status: 'pending', planStep: 'api' },
      { id: 'ui', text: 'the UI', status: 'pending', planStep: 'ui' },
    ]);
    expect(await f.plan()).toMatchObject({ status: 'approved', revision: 1, text: 'Build loyalty stamps' });
    // `api` shares a step's id but carries no planStep: it never touches the plan.
    await f.run(f.root, 'todo', { items: [{ id: 'model', text: 'the model', status: 'completed', planStep: 'model' }, { id: 'api', text: 'the API', status: 'completed' }, { id: 'ui', text: 'the UI', status: 'active', planStep: 'ui' }] });
    expect(await f.statuses()).toEqual({ model: 'completed', api: 'pending', ui: 'active' });
    const detour = [{ id: 'flake', text: 'Fix the flaky test', status: 'completed' }];
    await f.run(f.root, 'todo', { items: detour });
    expect(await f.todos(f.root)).toEqual(detour);
    expect(await f.statuses()).toEqual({ model: 'completed', api: 'pending', ui: 'active' });
    expect(await f.run(f.root, 'todo', { from: 'plan' })).toMatchObject({ isError: false });
    expect(await f.todos(f.root)).toEqual([
      { id: 'model', text: 'the model', status: 'completed', planStep: 'model' },
      { id: 'api', text: 'the API', status: 'pending', planStep: 'api' },
      { id: 'ui', text: 'the UI', status: 'active', planStep: 'ui' },
    ]);
    const unknown = await f.run(f.root, 'todo', { items: [{ id: 'docs', text: 'Docs', status: 'completed', planStep: 'docs' }] });
    expect(unknown).toMatchObject({ isError: true, text: expect.stringContaining('plan step docs') });
    expect((await f.todos(f.root))?.map(item => item.id)).toEqual(['model', 'api', 'ui']);
  } finally { await f.harness.close(BACKGROUND_CONTEXT); }
});

test('a revision keeps completed steps by id once approved; a rejected revision leaves the approved plan in effect', async () => {
  const f = await fixture();
  try {
    f.answers.push({ approved: true, note: null }, { approved: false, note: 'Keep the API step.' }, { approved: true, note: 'Ship it.' });
    await f.run(f.root, 'propose_plan', { prompt: 'First', choices: [], steps: [step('model', 'the model'), step('api', 'the API')] });
    await f.run(f.root, 'todo', { items: [{ id: 'model', text: 'the model', status: 'completed', planStep: 'model' }] });
    await f.run(f.root, 'propose_plan', { prompt: 'Without the API', choices: [], steps: [step('model', 'the model'), step('cli', 'the CLI')] });
    expect(await f.plan()).toMatchObject({ status: 'rejected', revision: 1, approved: { text: 'First' } });
    expect(await f.statuses()).toEqual({ model: 'completed', api: 'pending' });
    // The plan in effect is still the first: its steps link, the rejected one's do not.
    expect(await f.run(f.root, 'todo', { items: [{ id: 'api', text: 'the API', status: 'active', planStep: 'api' }] })).toMatchObject({ isError: false });
    expect(await f.run(f.root, 'todo', { items: [{ id: 'cli', text: 'the CLI', status: 'active', planStep: 'cli' }] })).toMatchObject({ isError: true });
    expect(await f.statuses()).toEqual({ model: 'completed', api: 'active' });
    await f.run(f.root, 'propose_plan', { prompt: 'With a CLI', choices: [], steps: [step('model', 'the model'), step('api', 'the API'), step('cli', 'the CLI')] });
    expect(await f.plan()).toMatchObject({ status: 'approved', revision: 2, text: 'With a CLI', approved: null });
    expect(await f.statuses()).toEqual({ model: 'completed', api: 'pending', cli: 'pending' });
    expect((await f.todos(f.root))?.map(item => [item.id, item.status])).toEqual([['model', 'completed'], ['api', 'pending'], ['cli', 'pending']]);
    expect(f.decisions.map(decision => [decision.title, decision.body, decision.decisions])).toEqual([
      ['Approved plan revision 1', '', ['the model', 'the API']],
      ['Rejected the proposed plan', 'Keep the API step.', []],
      ['Approved plan revision 2', 'Ship it.', ['the model', 'the API', 'the CLI']],
    ]);
  } finally { await f.harness.close(BACKGROUND_CONTEXT); }
});

test('a subagent\'s todo list is its own: the parent\'s plan neither loads it nor links to it', async () => {
  const f = await fixture();
  try {
    const child = await f.harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: model.provider, modelId: model.id }, tools: f.tools } }, BACKGROUND_CONTEXT);
    const own = [{ id: 'read', text: 'Read the code', status: 'active' }];
    await f.run(child, 'todo', { items: own });
    f.answers.push({ approved: true, note: null });
    await f.run(f.root, 'propose_plan', { prompt: 'Plan', choices: [], steps: [step('model', 'the model')] });
    expect(await f.todos(child)).toEqual(own);
    expect(await f.run(child, 'todo', { items: [{ id: 'model', text: 'the model', status: 'completed', planStep: 'model' }] })).toMatchObject({ isError: true });
    expect(await f.run(child, 'todo', { from: 'plan' })).toMatchObject({ isError: true });
    expect(await f.todos(child)).toEqual(own);
    expect(await f.statuses()).toEqual({ model: 'pending' });
  } finally { await f.harness.close(BACKGROUND_CONTEXT); }
});

test('a proposal whose step detail holds an invalid block fails with the step\'s issues and proposes nothing', async () => {
  const f = await fixture();
  try {
    const result = await f.run(f.root, 'propose_plan', { prompt: 'Plan', choices: [], steps: [step('model', 'the model'), { id: 'ui', title: 'the UI', detail: 'Layout:\n\n```gitspace-ui\n{ "root": "card" }\n```\n' }] });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('steps/1/detail: block 1') });
    expect(await f.plan()).toBeUndefined();
  } finally { await f.harness.close(BACKGROUND_CONTEXT); }
});

test('a model must send steps: a proposal without them is refused and proposes nothing', async () => {
  const f = await fixture();
  try {
    expect(Reflect.get(f.tools.find(tool => tool.name === 'propose_plan')?.parameters ?? {}, 'required')).toContain('steps');
    expect(await f.run(f.root, 'propose_plan', { prompt: 'Plan', choices: [] })).toMatchObject({ isError: true, text: expect.stringContaining('steps') });
    expect(await f.plan()).toBeUndefined();
  } finally { await f.harness.close(BACKGROUND_CONTEXT); }
});

test('a proposal recorded without steps and waiting at a deploy is posted again after it and approved as a Markdown-only plan', async () => {
  // The storage outlives the Harness that closes for the deploy, as a database does.
  const storage = new Proxy(new MemoryStorage(), { get: (target, key) => key === 'close' ? async () => {} : Reflect.get(target, key) });
  const asked = Promise.withResolvers<void>();
  // propose_plan as deployed before plans had steps: it records the question and the plan's text, then waits.
  const deployed = defineTool({ name: 'propose_plan', description: 'Propose a plan.', parameters: Type.Object({ prompt: Type.String(), choices: Type.Array(Type.String()) }), replay: 'safe', async execute(input, api, context) {
    const id = await api.memo('gitspace.question', `question:${api.taskId}`, context);
    await api.commit(async tx => {
      (await tx.doc(QuestionsDoc)).items.push({ id, conversationId: String(api.conversationId), kind: 'approval', prompt: input.prompt, choices: input.choices, answer: null });
      const plan = await tx.doc(PlanDoc, api.conversationId); plan.text = input.prompt; plan.status = 'proposed'; plan.questionId = id;
    }, context);
    asked.resolve();
    const { promise, reject } = Promise.withResolvers<never>();
    context.abortSignal?.addEventListener('abort', () => reject(new Error('closed')), { once: true });
    return promise;
  } });
  const registry = createRegistry(); registry.install(defineExtension({ name: 'plan-proof', tools: [deployed] }));
  const before = await Harness.open(storage, { registry, models: scriptedModels([{ type: 'toolCall', id: 'call-old', name: 'propose_plan', arguments: { prompt: 'Add loyalty stamps', choices: [] } }]), settings: { compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
  const waiting = await before.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id }, tools: [deployed] } });
  await waiting.submit({ type: 'input', content: 'Plan loyalty stamps' }, BACKGROUND_CONTEXT);
  await asked.promise;
  await before.close(BACKGROUND_CONTEXT);

  const f = await fixture(storage);
  try {
    // The call runs again under the release that posts questions: it finds its question and ends, leaving it open.
    await f.root.waitForIdle(BACKGROUND_CONTEXT);
    const result = (await f.root.context(BACKGROUND_CONTEXT)).messages.find(message => message.role === 'toolResult' && message.toolCallId === 'call-old');
    expect(result).toMatchObject({ isError: false });
    const [question] = (await f.harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items ?? [];
    if (!question) throw new Error('The proposal has no question');
    expect(question).toMatchObject({ answer: null, askedAt: expect.any(String) });
    await f.answer(f.root, question.id, { approved: true, note: 'Go ahead.' });
    expect(await f.plan()).toMatchObject({ status: 'approved', revision: 1, text: 'Add loyalty stamps', steps: [] });
    expect(f.decisions.map(decision => [decision.title, decision.body, decision.decisions])).toEqual([['Approved plan revision 1', 'Go ahead.', []]]);
    expect(await f.todos(f.root)).toBeUndefined();
  } finally { await f.harness.close(BACKGROUND_CONTEXT); }
});
