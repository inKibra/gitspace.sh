import { expect, onTestFinished, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStorage, type Storage } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema, RuntimeQuestionSchema, questionState } from '@gitspace/protocol-runtime';
import { createRuntimeHarness } from './harness.js';
import { PlanDoc, QuestionsDoc, type Question } from './documents.js';
import { createSessionControls } from './session-controls.js';
import { createAutomationRequests } from './automation-requests.js';

const model: Model<Api> = { id: 'questions', name: 'Questions', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
const admitted = async () => ({ provider: 'test', modelId: model.id });

/** A gitspace-ui block whose AskCard `id` asks "Which bucket?" as a required ask. */
function askBlock(id: string): string {
  const spec = {
    root: 'card',
    elements: {
      card: { type: 'AskCard', id, ask: { required: true, prompt: 'Which bucket?' }, props: { questionId: id, question: 'Which bucket?', prompt: 'Which bucket?', options: { $state: '/options' }, value: { $bindState: '/answer' }, answered: { $state: '/answered' } }, children: [] },
    },
    state: { answer: '', options: [{ value: 'assets', label: 'assets' }, { value: 'uploads', label: 'uploads' }] },
  };
  return `\`\`\`gitspace-ui\n${JSON.stringify(spec)}\n\`\`\``;
}
/** A reply that ends with a required block ask: no call, so nothing waits on the person. */
const ASKING: AssistantMessage['content'] = [{ type: 'text', text: `Before I move the files:\n\n${askBlock('bucket')}` }];

/** The workspace runtime's harness over `storage`, whose model replies `first` to the first request and "Done." to every
 * later one; every request's messages are recorded. */
async function open(storage: Storage, first: AssistantMessage['content'] = ASKING) {
  const requests: string[] = [];
  let arrived = Promise.withResolvers<void>();
  const models = Object.assign(createModels(), { getModel: () => model, streamSimple(_model: Model<Api>, request: { messages: unknown[] }) {
    const content = requests.length === 0 ? first : [{ type: 'text' as const, text: 'Done.' }];
    const calls = content.some(part => part.type === 'toolCall');
    const reply: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason: calls ? 'toolUse' : 'stop', timestamp: Date.now(), usage };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: calls ? 'toolUse' : 'stop', message: reply }); stream.end(reply);
    requests.push(JSON.stringify(request.messages));
    const done = arrived; arrived = Promise.withResolvers(); done.resolve();
    return stream;
  } });
  const runtime = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage, models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, invoke: unused, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {}, results: { put: unused, text: unused } },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: () => {}, admitInference: admitted, bindInferenceConversation: async () => {},
    refuseRequest: unused, unfinished: { begin: () => 0, end: () => {} },
  });
  const controls = createSessionControls({ ...runtime, admitInference: admitted, reload: async () => {}, catalog: async () => ({ models: [], roles: [] }),
    history: { conversation: unused, recent: async () => ({ anchorId: null, prompts: [], tokens: null }), page: unused, resolve: unused, transcriptPage: unused, transcriptContent: unused, usage: unused } });
  const automations = createAutomationRequests({ harness: runtime.harness, storage, admitInference: admitted, configureModel: runtime.configureModel, async wake() { runtime.harness.resume(); } });
  async function questions(): Promise<Question[]> { return (await runtime.harness.snapshot(QuestionsDoc, context))?.items ?? []; }
  /** The questions once `count` are recorded: a block ask is posted after the commit that stored its reply. */
  async function posted(count: number): Promise<Question[]> {
    let committed = Promise.withResolvers<void>();
    const observation = runtime.harness.observeCommits({ end() {}, advance() { const done = committed; committed = Promise.withResolvers(); done.resolve(); } });
    try {
      for (let found = await questions(); ; found = await questions()) {
        if (found.length >= count) return found;
        await committed.promise;
      }
    } finally { observation.detach(); }
  }
  /** The question the first turn posted, once that turn ended. */
  async function asked() {
    await runtime.root.waitForIdle(context);
    const [question] = await posted(1);
    if (!question) throw new Error('No question was posted');
    return question;
  }
  /** Every request the provider received once `count` arrived. */
  async function received(count: number) { while (requests.length < count) await arrived.promise; return requests; }
  /** Each question's state and why it closed, by id. */
  async function states() { return Object.fromEntries((await questions()).map(item => [item.id, [questionState(item), item.closed?.reason ?? null]])); }
  return { ...runtime, controls, automations, requests, questions, posted, asked, received, states };
}

test('a reply ending with a required block ask ends the turn with nothing waiting; the ask outlives a restart, and its answer starts the next turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-questions-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const before = await open(await openNodeJsonlStorage(directory, context));
  try {
    await before.root.submit({ type: 'input', requestId: 'buckets', content: 'Move the files' }, context);
    const question = await before.asked();
    expect(question).toMatchObject({ kind: 'ask', prompt: 'Which bucket?', choices: ['assets', 'uploads'] });
    // The reply is the turn's last message: no call was made and no request followed it.
    expect(before.requests).toHaveLength(1);
    expect((await before.root.context(context)).messages.flatMap(message => message.role === 'system' ? [] : [message.role])).toEqual(['user', 'assistant']);
  } finally { await before.harness.close(context); }
  const after = await open(await openNodeJsonlStorage(directory, context));
  try {
    await after.lifecycle.recover();
    after.harness.resume();
    const question = await after.asked();
    expect(questionState(question)).toBe('open');
    await after.controls.execute(String(after.root.id), { type: 'answerAsk', id: question.id, answers: [{ id: 'bucket', selectedOptions: ['uploads'], customInput: null }] });
    const [next] = await after.received(1);
    expect(next).toContain(`The user answered your question (question ${question.id}).`);
    expect(next).toContain('Answer: uploads');
    await after.root.waitForIdle(context);
    expect((await after.questions()).find(item => item.id === question.id)).toMatchObject({ answer: [{ id: 'bucket', selectedOptions: ['uploads'], customInput: null }], answeredAt: expect.any(String) });
  } finally { await after.harness.close(context); }
});

test('a dismissed question is closed: the agent hears it, and an answer is refused afterwards', async () => {
  const f = await open(new MemoryStorage());
  try {
    await f.root.submit({ type: 'input', requestId: 'buckets', content: 'Move the files' }, context);
    const question = await f.asked();
    const id = String(f.root.id);
    await f.controls.execute(id, { type: 'dismissQuestion', id: question.id });
    const [, next] = await f.received(2);
    expect(next).toContain(`The user dismissed your question (question ${question.id}) without answering it.`);
    await f.root.waitForIdle(context);
    expect((await f.questions()).find(item => item.id === question.id)).toMatchObject({ answer: null, closed: { reason: 'dismissed' } });
    await expect(f.controls.execute(id, { type: 'answerAsk', id: question.id, answers: [{ id: 'bucket', selectedOptions: ['uploads'], customInput: null }] })).rejects.toThrow(`Question ${question.id} is closed (the person dismissed it), so it can no longer be answered.`);
    expect(f.requests).toHaveLength(2);
  } finally { await f.harness.close(context); }
});

test('stopping the conversation closes its open question, which then refuses an answer', async () => {
  const f = await open(new MemoryStorage());
  try {
    await f.root.submit({ type: 'input', requestId: 'buckets', content: 'Move the files' }, context);
    const question = await f.asked();
    const id = String(f.root.id);
    await f.controls.execute(id, { type: 'stop' });
    expect((await f.questions()).find(item => item.id === question.id)).toMatchObject({ answer: null, closed: { reason: 'stopped' } });
    await expect(f.controls.execute(id, { type: 'answerAsk', id: question.id, answers: [{ id: 'bucket', selectedOptions: ['uploads'], customInput: null }] })).rejects.toThrow('a person stopped or reset the conversation that asked it');
    expect(f.requests).toHaveLength(1);
  } finally { await f.harness.close(context); }
});

test('a person\'s message closes the conversation\'s open questions as replied; an automation\'s or a deviceless prompt closes none, and the plan stays unapproved', async () => {
  // One reply asks with a block and proposes a plan.
  const f = await open(new MemoryStorage(), [...ASKING, { type: 'toolCall', id: 'plan-call', name: 'propose_plan', arguments: { prompt: 'Move the files to uploads', choices: ['Approve', 'Reject'], steps: [{ id: 'move', title: 'Move the files', detail: 'Copy, then delete.' }] } }]);
  try {
    const id = String(f.root.id);
    await f.root.submit({ type: 'input', requestId: 'buckets', content: 'Move the files' }, context);
    await f.root.waitForIdle(context);
    const asked = await f.posted(2);
    const ask = asked.find(item => item.kind === 'ask');
    const plan = asked.find(item => item.kind === 'approval');
    if (!ask || !plan) throw new Error('The reply did not ask and propose');
    expect(await f.states()).toEqual({ [ask.id]: ['open', null], [plan.id]: ['open', null] });
    expect((await f.controls.control(f.root)).pendingAsk?.id).toBe(ask.id);

    // An automation's message and a prompt sent from no device (an inspector, a machine) are not the person's reply.
    await f.automations.submit({ requestId: 'automation:nightly:1', text: 'Nightly check: report the bucket sizes.' });
    await f.received(2);
    await f.root.waitForIdle(context);
    await f.controls.execute(id, { type: 'prompt', text: 'Status?' });
    await f.received(3);
    await f.root.waitForIdle(context);
    expect(await f.states()).toEqual({ [ask.id]: ['open', null], [plan.id]: ['open', null] });

    // The person writes in the chat instead of answering.
    await f.controls.execute(id, { type: 'prompt', text: 'Keep them where they are for now.' }, false, 'browser');
    expect(await f.states()).toEqual({ [ask.id]: ['closed', 'replied'], [plan.id]: ['closed', 'replied'] });
    const [, , , next] = await f.received(4);
    expect(next).toContain('Keep them where they are for now.');
    await f.root.waitForIdle(context);
    // Nothing is approved: the proposal stays proposed for the agent to revise, and the plan's card takes no answer.
    expect(await f.harness.snapshot(PlanDoc, f.root.id, context)).toMatchObject({ status: 'proposed', questionId: plan.id, revision: 0, approved: null });
    // Nothing waits on the person any more: no open question, no pending ask.
    expect((await f.questions()).filter(item => questionState(item) === 'open')).toEqual([]);
    expect((await f.controls.control(f.root)).pendingAsk).toBeNull();
    await expect(f.controls.execute(id, { type: 'answerAsk', id: ask.id, answers: [{ id: 'bucket', selectedOptions: ['uploads'], customInput: null }] })).rejects.toThrow(`Question ${ask.id} is closed (the person wrote in the chat instead of answering it), so it can no longer be answered.`);
  } finally { await f.harness.close(context); }
});

test('the person answering one question through its card answers it and closes the conversation\'s others as replied', async () => {
  const f = await open(new MemoryStorage(), [{ type: 'text', text: `Two things:\n\n${askBlock('bucket')}\n\n${askBlock('region')}` }]);
  try {
    const id = String(f.root.id);
    await f.root.submit({ type: 'input', requestId: 'buckets', content: 'Move the files' }, context);
    await f.root.waitForIdle(context);
    const [first, second] = await f.posted(2);
    if (!first || !second) throw new Error('The reply did not ask twice');
    await f.controls.execute(id, { type: 'answerAsk', id: first.id, answers: [{ id: 'bucket', selectedOptions: ['uploads'], customInput: null }] }, false, 'browser');
    expect(await f.states()).toEqual({ [first.id]: ['answered', null], [second.id]: ['closed', 'replied'] });
    const [, next] = await f.received(2);
    expect(next).toContain(`The user answered your question (question ${first.id}).`);
    await f.root.waitForIdle(context);
  } finally { await f.harness.close(context); }
});

test('a question from the removed ask tool, open in a stored workspace, is still answered through its card', async () => {
  const f = await open(new MemoryStorage());
  try {
    const id = String(f.root.id);
    await f.harness.commit(async tx => {
      (await tx.doc(QuestionsDoc)).items.push({ id: 'question:7', conversationId: id, kind: 'ask', prompt: 'Which bucket?', choices: ['assets', 'uploads'], answer: null, askedAt: '2026-11-15T10:00:00.000Z' });
    }, context);
    await f.controls.execute(id, { type: 'answerAsk', id: 'question:7', answers: [{ id: 'question:7', selectedOptions: ['assets'], customInput: null }] }, false, 'browser');
    const [next] = await f.received(1);
    expect(next).toContain('The user answered your question (question question:7).');
    expect(next).toContain('Answer: assets');
    await f.root.waitForIdle(context);
    expect(await f.states()).toMatchObject({ 'question:7': ['answered', null] });
  } finally { await f.harness.close(context); }
});

test('opening a workspace closes the legacy questions whose asking call ended, and keeps the rest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-questions-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const tab = { source: 'cloud' as const, pairingId: null, browser: 'Cloud browser', groupId: '00000000-0000-4000-8000-0000000000a1', targetId: 'tab-a', url: 'https://example.com/', title: 'Example', holder: 'agent' as const };
  // A card as releases that held the asking call open stored it: it said how long the call waited.
  const legacyCard = { ...tab, callId: 'takeover-call', askedAt: '2026-11-01T10:00:00.000Z', until: '2026-11-01T10:30:00.000Z', waiting: false };
  const before = await open(await openNodeJsonlStorage(directory, context));
  try {
    const conversationId = String(before.root.id);
    await before.harness.commit(async tx => {
      const questions = await tx.doc(QuestionsDoc);
      // Asked before questions recorded `askedAt`, by calls that no longer run (no task has these ids).
      questions.items.push(
        { id: 'question:9001', conversationId, kind: 'ask', prompt: 'Which bucket?', choices: [], answer: null },
        { id: 'question:9002', conversationId, kind: 'approval', prompt: 'Approve the plan?', choices: [], answer: null },
        { id: 'question:9003', conversationId, kind: 'takeover', prompt: 'Sign in', choices: ['Take over', 'Not now'], answer: null, takeover: legacyCard },
        { id: 'question:9004', conversationId, kind: 'ask', prompt: 'Answered long ago', choices: [], answer: 'yes' },
        // A machine-attach approval holds no call: it stays open.
        { id: 'machine-attach:lab:1', conversationId, kind: 'approval', prompt: 'Attach the lab machine?', choices: ['Approve', 'Reject'], answer: null, tool: { name: 'machines', args: { op: 'attach', machine: 'lab' } } },
      );
      const plan = await tx.doc(PlanDoc, before.root.id);
      plan.text = 'Approve the plan?'; plan.status = 'proposed'; plan.questionId = 'question:9002';
    }, context);
  } finally { await before.harness.close(context); }
  const after = await open(await openNodeJsonlStorage(directory, context));
  try {
    const items = await after.questions();
    expect(items.map(item => [item.id, questionState(item), item.closed?.reason ?? null])).toEqual([
      ['question:9001', 'closed', 'expired'], ['question:9002', 'closed', 'expired'], ['question:9003', 'closed', 'expired'], ['question:9004', 'answered', null], ['machine-attach:lab:1', 'open', null],
    ]);
    // The snapshot reads every question again: the old card lost the fields its schema no longer has.
    expect(RuntimeQuestionSchema.array().safeParse(items).success).toBe(true);
    expect((await after.harness.snapshot(PlanDoc, after.root.id, context))?.status).toBe('draft');
  } finally { await after.harness.close(context); }
});
