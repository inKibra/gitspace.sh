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
import { PlanDoc, QuestionsDoc } from './documents.js';
import { createSessionControls } from './session-controls.js';

const model: Model<Api> = { id: 'questions', name: 'Questions', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };

/** The workspace runtime's harness over `storage`, whose model asks "Which bucket?" once and then answers "Done.";
 * every request's messages are recorded. */
async function open(storage: Storage) {
  const requests: string[] = [];
  let arrived = Promise.withResolvers<void>();
  const models = Object.assign(createModels(), { getModel: () => model, streamSimple(_model: Model<Api>, request: { messages: unknown[] }) {
    const text = JSON.stringify(request.messages);
    const ask = !text.includes('"role":"toolResult"');
    const reply: AssistantMessage = { role: 'assistant', content: ask ? [{ type: 'toolCall', id: 'ask-call', name: 'ask', arguments: { prompt: 'Which bucket?', choices: ['assets', 'uploads'] } }] : [{ type: 'text', text: 'Done.' }], api: model.api, provider: model.provider, model: model.id, stopReason: ask ? 'toolUse' : 'stop', timestamp: Date.now(), usage };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: ask ? 'toolUse' : 'stop', message: reply }); stream.end(reply);
    requests.push(text);
    const done = arrived; arrived = Promise.withResolvers(); done.resolve();
    return stream;
  } });
  const runtime = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage, models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, invoke: unused, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {}, results: { put: unused, text: unused } },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: () => {}, admitInference: async () => ({ provider: 'test', modelId: model.id }), bindInferenceConversation: async () => {},
    refuseRequest: unused, unfinished: { begin: () => 0, end: () => {} },
  });
  const controls = createSessionControls({ ...runtime, admitInference: unused, reload: async () => {}, catalog: async () => ({ models: [], roles: [] }),
    history: { conversation: unused, recent: async () => ({ anchorId: null, prompts: [], tokens: null }), page: unused, resolve: unused, transcriptPage: unused, transcriptContent: unused, usage: unused } });
  /** The question the turn posted, once that turn ended. */
  async function asked() {
    await runtime.root.waitForIdle(context);
    const question = (await runtime.harness.snapshot(QuestionsDoc, context))?.items.find(item => item.kind === 'ask');
    if (!question) throw new Error('No question was posted');
    return question;
  }
  /** Every request the provider received once `count` arrived. */
  async function received(count: number) { while (requests.length < count) await arrived.promise; return requests; }
  return { ...runtime, controls, requests, asked, received };
}

test('an ask outlives a restart of the runtime, and its answer starts the next turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-questions-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const before = await open(await openNodeJsonlStorage(directory, context));
  try {
    await before.root.submit({ type: 'input', requestId: 'buckets', content: 'Move the files' }, context);
    const question = await before.asked();
    // The call ended the turn: the question is posted, and no request followed its result.
    expect(before.requests).toHaveLength(1);
    expect((await before.root.context(context)).messages.find(message => message.role === 'toolResult')?.details).toEqual({ questionId: question.id });
  } finally { await before.harness.close(context); }
  const after = await open(await openNodeJsonlStorage(directory, context));
  try {
    await after.lifecycle.recover();
    after.harness.resume();
    const question = await after.asked();
    expect(questionState(question)).toBe('open');
    await after.controls.execute(String(after.root.id), { type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['uploads'], customInput: null }] });
    const [next] = await after.received(1);
    expect(next).toContain(`The user answered your question (question ${question.id}).`);
    expect(next).toContain('Answer: uploads');
    await after.root.waitForIdle(context);
    expect((await after.harness.snapshot(QuestionsDoc, context))?.items.find(item => item.id === question.id)).toMatchObject({ answer: [{ id: question.id, selectedOptions: ['uploads'], customInput: null }], answeredAt: expect.any(String) });
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
    const closed = (await f.harness.snapshot(QuestionsDoc, context))?.items.find(item => item.id === question.id);
    expect(closed).toMatchObject({ answer: null, closed: { reason: 'dismissed' } });
    await expect(f.controls.execute(id, { type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['uploads'], customInput: null }] })).rejects.toThrow(`Question ${question.id} is closed (the person dismissed it), so it can no longer be answered.`);
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
    expect((await f.harness.snapshot(QuestionsDoc, context))?.items.find(item => item.id === question.id)).toMatchObject({ answer: null, closed: { reason: 'stopped' } });
    await expect(f.controls.execute(id, { type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['uploads'], customInput: null }] })).rejects.toThrow('a person stopped or reset the conversation that asked it');
    expect(f.requests).toHaveLength(1);
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
    const items = (await after.harness.snapshot(QuestionsDoc, context))?.items ?? [];
    expect(items.map(item => [item.id, questionState(item), item.closed?.reason ?? null])).toEqual([
      ['question:9001', 'closed', 'expired'], ['question:9002', 'closed', 'expired'], ['question:9003', 'closed', 'expired'], ['question:9004', 'answered', null], ['machine-attach:lab:1', 'open', null],
    ]);
    // The snapshot reads every question again: the old card lost the fields its schema no longer has.
    expect(RuntimeQuestionSchema.array().safeParse(items).success).toBe(true);
    expect((await after.harness.snapshot(PlanDoc, after.root.id, context))?.status).toBe('draft');
  } finally { await after.harness.close(context); }
});
