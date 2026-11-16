import { expect, test } from 'vitest';
import { AssistantEntry, Harness, MemoryStorage, createRegistry, type EntryRecord } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema, questionState } from '@gitspace/protocol-runtime';
import { piMessageRowId } from '@gitspace/blocks';
import { blockAskQuestionId } from '@gitspace/protocol/gitspace-ui';
import { createRuntimeHarness } from './harness.js';
import { BlockAsksDoc, QuestionsDoc } from './documents.js';
import { closeRepliedQuestions, repairBlockAsks } from './questions.js';
import { createSessionControls } from './session-controls.js';

const model: Model<Api> = { id: 'block-asks', name: 'Block asks', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };

/** A reply whose gitspace-ui block asks "Which cache?" with two choices; `required` says whether it must be answered. */
function choiceBlock(required: boolean): string {
  const spec = {
    root: 'card',
    elements: {
      card: { type: 'Card', id: 'cache-choice', ask: { required, prompt: 'Which cache?' }, props: { title: 'Which cache?' }, children: ['options'] },
      options: { type: 'RadioGroup', props: { label: null, value: { $bindState: '/choice' }, options: { $state: '/options' } }, children: [] },
    },
    state: { choice: '', options: [{ value: 'kv', label: 'Workers KV' }, { value: 'do', label: 'Durable Object' }] },
  };
  return `Pick one:\n\`\`\`gitspace-ui\n${JSON.stringify(spec)}\n\`\`\`\n`;
}

/** The workspace runtime's harness whose model replies `first` (thinking, then the text) to the first request and
 * "Done." to every later one; every request's messages are recorded. */
async function open(first: string, storage = new MemoryStorage()) {
  const requests: string[] = [];
  const reports: unknown[] = [];
  let arrived = Promise.withResolvers<void>();
  const models = Object.assign(createModels(), { getModel: () => model, streamSimple(_model: Model<Api>, request: { messages: unknown[] }) {
    const reply: AssistantMessage = { role: 'assistant', content: requests.length === 0 ? [{ type: 'thinking', thinking: 'A choice for the user.' }, { type: 'text', text: first }] : [{ type: 'text', text: 'Done.' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(reply);
    requests.push(JSON.stringify(request.messages));
    const done = arrived; arrived = Promise.withResolvers(); done.resolve();
    return stream;
  } });
  const runtime = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage, models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, invoke: unused, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {}, results: { put: unused, text: unused } },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: error => { reports.push(error); }, admitInference: async () => ({ provider: 'test', modelId: model.id }), bindInferenceConversation: async () => {},
    refuseRequest: unused, unfinished: { begin: () => 0, end: () => {} },
  });
  const controls = createSessionControls({ ...runtime, admitInference: unused, reload: async () => {}, catalog: async () => ({ models: [], roles: [] }),
    history: { conversation: unused, recent: async () => ({ anchorId: null, prompts: [], tokens: null }), page: unused, resolve: unused, transcriptPage: unused, transcriptContent: unused, usage: unused } });
  /** Submits "Pick a cache" and waits for the turn to end; answers the input's entry and the reply's entry. */
  async function turn(): Promise<{ input: number; reply: EntryRecord }> {
    const submission = await runtime.root.submit({ type: 'input', requestId: 'cache', content: 'Pick a cache' }, context);
    await runtime.root.waitForIdle(context);
    const input = (await submission.status(context)).entry;
    const reply = (await runtime.root.entries({}, 50, undefined, context)).items.find(entry => AssistantEntry.is(entry));
    if (input === undefined || !reply) throw new Error('The turn stored no input or reply');
    return { input: Number(input), reply };
  }
  /** The block-ask questions. */
  async function questions() {
    return (await runtime.harness.snapshot(QuestionsDoc, context))?.items.filter(item => item.id.startsWith('block-ask:')) ?? [];
  }
  /** The block-ask questions once there are any: they are posted after the commit that stored the reply. */
  async function posted() {
    let committed = Promise.withResolvers<void>();
    const observation = runtime.harness.observeCommits({ end() {}, advance() { const done = committed; committed = Promise.withResolvers(); done.resolve(); } });
    try {
      for (let found = await questions(); ; found = await questions()) {
        if (found.length > 0) return found;
        await committed.promise;
      }
    } finally { observation.detach(); }
  }
  /** Every request the provider received once `count` arrived. */
  async function received(count: number) { while (requests.length < count) await arrived.promise; return requests; }
  return { ...runtime, storage, controls, requests, reports, turn, questions, posted, received };
}

test('a required block ask in a stored reply posts one open question under its message row, once, and its answer is the next input', async () => {
  const f = await open(choiceBlock(true));
  try {
    const { input, reply } = await f.turn();
    const conversationId = String(f.root.id);
    // The transcript's row for the reply's text (model message 0, content part 1 after the thinking) in the turn its input opened.
    const id = blockAskQuestionId(piMessageRowId(conversationId, input, Number(reply.id), 0, 1), 'cache-choice');
    const [question, ...others] = await f.posted();
    expect(others).toEqual([]);
    expect(question).toMatchObject({ id, conversationId, kind: 'ask', prompt: 'Which cache?', choices: ['Workers KV', 'Durable Object'], answer: null });
    // Open: the workspace status counts it as Needs you.
    expect(question && questionState(question)).toBe('open');
    // Scanning again finds its question.
    await repairBlockAsks(f.harness, f.storage);
    expect((await f.questions()).map(item => item.id)).toEqual([id]);
    expect(f.requests).toHaveLength(1);
    await f.controls.execute(conversationId, { type: 'answerAsk', id, answers: [{ id: 'cache-choice', selectedOptions: ['Durable Object'], customInput: null }] });
    const [, next] = await f.received(2);
    expect(next).toContain(`The user answered your question (question ${id}).`);
    expect(next).toContain('Question: Which cache?');
    expect(next).toContain('Answer: Durable Object');
    await f.root.waitForIdle(context);
    const answered = (await f.questions()).find(item => item.id === id);
    expect(answered).toMatchObject({ answer: [{ id: 'cache-choice', selectedOptions: ['Durable Object'], customInput: null }], answeredAt: expect.any(String) });
    expect(answered && questionState(answered)).toBe('answered');
    await expect(f.controls.execute(conversationId, { type: 'answerAsk', id, answers: [{ id: 'cache-choice', selectedOptions: ['Workers KV'], customInput: null }] })).rejects.toThrow(`Question ${id} is already answered`);
    expect(f.reports).toEqual([]);
  } finally { await f.harness.close(context); }
});

test('an optional block ask posts no question', async () => {
  const f = await open(choiceBlock(false));
  try {
    await f.turn();
    await repairBlockAsks(f.harness, f.storage);
    expect(await f.questions()).toEqual([]);
    expect(f.reports).toEqual([]);
  } finally { await f.harness.close(context); }
});

test('a reply stored with no scan after it (a reset between its commit and its question\'s) gets its question when the workspace opens', async () => {
  const storage = new MemoryStorage();
  // The last scan read every entry so far; pi stores an input and a reply with a required ask, and the workspace object
  // resets before the commit that posts its question.
  const plain = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
  const root = await plain.root(context);
  const stored = await root.commit(async tx => {
    (await tx.doc(BlockAsksDoc)).through = 0;
    const input = await tx.appendEntry(root.id, { kind: 'pi.user', model: [{ role: 'user', content: 'Pick a cache', timestamp: 1 }] });
    await tx.createSubmission({ conversationId: root.id, type: 'input', status: 'placed', entry: input.id });
    const reply = await tx.appendEntry(root.id, { kind: AssistantEntry.kind, model: [{ role: 'assistant', content: [{ type: 'text', text: choiceBlock(true) }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 2, usage }] });
    return { input: Number(input.id), reply: Number(reply.id) };
  }, context);
  const conversationId = String(root.id);
  // Closing a harness closes its storage; the reset leaves the stored rows to the workspace's next open.
  const f = await open('Done.', storage);
  try {
    expect(String(f.root.id)).toBe(conversationId);
    const [question, ...others] = await f.questions();
    expect(others).toEqual([]);
    expect(question).toMatchObject({ id: blockAskQuestionId(piMessageRowId(conversationId, stored.input, stored.reply, 0, 0), 'cache-choice'), kind: 'ask', prompt: 'Which cache?', answer: null });
    expect(question && questionState(question)).toBe('open');
    expect((await f.harness.snapshot(BlockAsksDoc, context))?.through).toBeGreaterThanOrEqual(stored.reply);
    expect(f.reports).toEqual([]);
  } finally { await f.harness.close(context); }
});

test('a person\'s message taken before a reply\'s question is posted makes it post closed as replied; a later reply\'s question opens', async () => {
  const storage = new MemoryStorage();
  const plain = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
  try {
    const root = await plain.root(context);
    const conversationId = String(root.id);
    // pi stores a reply with a required ask; its question is not posted yet.
    const stored = await root.commit(async tx => {
      (await tx.doc(BlockAsksDoc)).through = 0;
      const input = await tx.appendEntry(root.id, { kind: 'pi.user', model: [{ role: 'user', content: 'Pick a cache', timestamp: 1 }] });
      await tx.createSubmission({ conversationId: root.id, type: 'input', status: 'placed', entry: input.id });
      const reply = await tx.appendEntry(root.id, { kind: AssistantEntry.kind, model: [{ role: 'assistant', content: [{ type: 'text', text: choiceBlock(true) }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 2, usage }] });
      return { input: Number(input.id), reply: Number(reply.id) };
    }, context);
    // The person writes in the chat first: the commit that takes their message, as a prompt from a device makes it.
    await root.commit(async tx => {
      await closeRepliedQuestions(tx, root.id);
      await root.submit(tx, { type: 'input', requestId: 'person', content: 'Use KV.' });
    }, context);
    await repairBlockAsks(plain, storage);
    const id = blockAskQuestionId(piMessageRowId(conversationId, stored.input, stored.reply, 0, 0), 'cache-choice');
    const [question, ...others] = (await plain.snapshot(QuestionsDoc, context))?.items ?? [];
    expect(others).toEqual([]);
    expect(question).toMatchObject({ id, kind: 'ask', answer: null, closed: { reason: 'replied' } });
    // Nothing waits on the person: Needs you counts open questions only.
    expect(question && questionState(question)).toBe('closed');

    // A reply stored after the person's message asks anew: its question opens.
    const later = await root.commit(async tx => {
      const input = await tx.appendEntry(root.id, { kind: 'pi.user', model: [{ role: 'user', content: 'Pick again', timestamp: 3 }] });
      await tx.createSubmission({ conversationId: root.id, type: 'input', status: 'placed', entry: input.id });
      const reply = await tx.appendEntry(root.id, { kind: AssistantEntry.kind, model: [{ role: 'assistant', content: [{ type: 'text', text: choiceBlock(true) }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 4, usage }] });
      return { input: Number(input.id), reply: Number(reply.id) };
    }, context);
    await repairBlockAsks(plain, storage);
    const reasked = (await plain.snapshot(QuestionsDoc, context))?.items.find(item => item.id !== id);
    expect(reasked && questionState(reasked)).toBe('open');
    expect(later.reply).toBeGreaterThan(stored.reply);
  } finally { await plain.close(context); }
});
