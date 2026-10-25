import { expect, onTestFinished, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStorage, type Storage } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema, type RuntimeAskTakeoverArguments, type RuntimeTakeoverTab } from '@gitspace/protocol-runtime';
import { createRuntimeHarness } from './harness.js';
import { ConversationLifecycleDoc, type ConversationEvent } from './conversation-lifecycle.js';
import { QuestionsDoc } from './documents.js';
import { createSessionControls } from './session-controls.js';
import { AgentDefinitionContextDoc } from './subagent-state.js';

const model: Model<Api> = { id: 'takeover', name: 'Take over', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
const groupId = '00000000-0000-4000-8000-0000000000a1', pairingId = '00000000-0000-4000-8000-0000000000b2';
const tab: RuntimeTakeoverTab = { source: 'chrome', pairingId, browser: 'Studio desktop', groupId, targetId: 'tab-a', url: 'https://github.com/login', title: 'Sign in to GitHub', holder: 'agent' };
const asked = { source: 'relay', pairingId, targetId: 'tab-a', reason: 'Sign in to GitHub; I cannot enter your password.' };
/** A take or handback of the card's tab, as the account delivers it to the main conversation. */
const browserEvent = (conversationId: string, kind: 'browser-taken' | 'browser-handback', at: string): ConversationEvent => ({
  conversationId, requestId: `${kind}:${groupId}:tab-a:${at}`, kind, sender: { id: groupId, name: 'Chrome "Studio desktop"' },
  text: kind === 'browser-taken' ? 'The user took tab-a.' : 'The user handed tab-a back.', payload: { groupId, targetId: 'tab-a', source: 'chrome', pairingId, at, by: 'gitspace' },
});

/** The workspace runtime's harness over `storage`, whose model asks for a take over once (`args`) and then answers
 * "Done."; every request's messages, every account lookup and every wake the runtime asks for are recorded. */
async function open(storage: Storage, args: object = asked) {
  const requests: string[] = [];
  let arrived = Promise.withResolvers<void>();
  const lookups: RuntimeAskTakeoverArguments[] = [];
  const wakes: number[] = [];
  /** What the runtime reported: a reset cuts the call off, which it reports. */
  const reports: unknown[] = [];
  let woken = Promise.withResolvers<void>();
  const models = { ...createModels(), getModel: () => model, streamSimple(_model: Model<Api>, request: { messages: unknown[] }) {
    const text = JSON.stringify(request.messages);
    const ask = !text.includes('"role":"toolResult"');
    const reply: AssistantMessage = { role: 'assistant', content: ask ? [{ type: 'toolCall', id: 'takeover-call', name: 'ask_takeover', arguments: { ...args } }] : [{ type: 'text', text: 'Done.' }], api: model.api, provider: model.provider, model: model.id, stopReason: ask ? 'toolUse' : 'stop', timestamp: Date.now(), usage };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: ask ? 'toolUse' : 'stop', message: reply }); stream.end(reply);
    requests.push(text);
    const done = arrived; arrived = Promise.withResolvers(); done.resolve();
    return stream;
  } };
  const runtime = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage, models, model: { provider: 'test', modelId: model.id },
    tools: { invoke: unused, prepareBrowser: unused, instructions: async () => '', authorizeCronTool: unused, preflight: async () => {}, async takeoverTab(input) { lookups.push(input.args); return tab; } },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, async wakeAt(at) { wakes.push(at); const done = woken; woken = Promise.withResolvers(); done.resolve(); } },
    retainedRules: { loadRules: async () => [], judge: unused, matchAst: unused }, editTool: () => 'edit',
    onReport: error => { reports.push(error); }, admitInference: async () => ({ provider: 'test', modelId: model.id }), bindInferenceConversation: async () => {},
    refuseRequest: unused, unfinished: { begin: () => 0, end: () => {} },
  });
  const controls = createSessionControls({ ...runtime, admitInference: unused, reload: async () => {}, catalog: async () => ({ models: [], roles: [] }),
    history: { conversation: unused, recent: async () => ({ anchorId: null, prompts: [], tokens: null }), page: unused, resolve: unused, transcriptPage: unused, transcriptContent: unused, usage: unused } });
  /** The takeover card once it is open, with its call's deadline and when it was asked. */
  async function card() {
    const watch = await runtime.harness.watchDoc(QuestionsDoc, context);
    if (!watch) throw new Error('Question document missing');
    const found = Promise.withResolvers<NonNullable<typeof watch.value>['items'][number]>();
    const check = (value: typeof watch.value) => { const question = value?.items.find(item => item.kind === 'takeover'); if (question) found.resolve(question); };
    check(watch.value);
    watch.start(async value => { check(value); });
    try {
      const question = await found.promise;
      if (!question.takeover) throw new Error('A takeover question without its card');
      return { question, until: Date.parse(question.takeover.until), askedAt: Date.parse(question.takeover.askedAt) };
    } finally { await watch.stop(); }
  }
  /** Until the call waits for its card: it asks for the wake at its deadline once that deadline is armed. */
  async function waiting() { while (!wakes.length) await woken.promise; }
  /** Every request the provider received once `count` arrived. */
  async function received(count: number) { while (requests.length < count) await arrived.promise; return requests; }
  /** Settles everything the run and the deliveries left: the conversation idles with nothing pending. */
  async function settled() { await runtime.root.waitForIdle(context); await runtime.lifecycle.recover(); await runtime.root.waitForIdle(context); }
  return { ...runtime, controls, requests, lookups, wakes, reports, card, waiting, received, settled };
}

test('ask_takeover waits through the take until the user hands the tab back, and the agent hears it once, from the call', async () => {
  const f = await open(new MemoryStorage());
  try {
    await f.root.submit({ type: 'input', requestId: 'sign-in', content: 'Open GitHub' }, context);
    const { question, until, askedAt } = await f.card();
    expect(question).toMatchObject({ kind: 'takeover', prompt: asked.reason, answer: null, takeover: { ...tab, callId: 'takeover-call', waiting: true } });
    expect(f.lookups).toEqual([{ ...asked, timeoutMinutes: 30 }]);
    await f.waiting();
    expect(f.wakes).toEqual([until]);
    expect(until - askedAt).toBe(30 * 60_000);
    const id = String(f.root.id);
    await f.lifecycle.deliver(browserEvent(id, 'browser-taken', '2026-10-25T10:00:00.000Z'));
    expect((await f.harness.snapshot(QuestionsDoc, context))?.items[0]).toMatchObject({ answer: null, takeover: { holder: 'you' } });
    // The user holds the tab: the call still waits, and Not now is refused.
    expect(f.requests).toHaveLength(1);
    await expect(f.controls.execute(id, { type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['Not now'], customInput: null }] })).rejects.toThrow('Resume agent');
    await f.lifecycle.deliver(browserEvent(id, 'browser-handback', '2026-10-25T10:05:00.000Z'));
    const [, after] = await f.received(2);
    expect(after).toContain('The user handed the tab back; observe it again before acting.');
    await f.settled();
    // The call reported the take and the handback: neither reaches the agent again as a message.
    expect(f.requests).toHaveLength(2);
    expect((await f.harness.snapshot(ConversationLifecycleDoc, f.root.id, context))?.events).toEqual([]);
    expect((await f.harness.snapshot(QuestionsDoc, context))?.items[0]).toMatchObject({ answer: 'handed-back', takeover: { holder: 'agent' } });
  } finally { await f.harness.close(context); }
});

test('Not now ends the call with the decline; Take over is not an answer', async () => {
  const f = await open(new MemoryStorage());
  try {
    await f.root.submit({ type: 'input', requestId: 'sign-in', content: 'Open GitHub' }, context);
    const { question } = await f.card();
    const id = String(f.root.id);
    await expect(f.controls.execute(id, { type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['Take over'], customInput: null }] })).rejects.toThrow('answered only by Not now');
    await f.controls.execute(id, { type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['Not now'], customInput: null }] });
    const [, after] = await f.received(2);
    expect(after).toContain('The user declined (Not now).');
    await f.settled();
    expect((await f.harness.snapshot(QuestionsDoc, context))?.items[0]?.answer).toBe('declined');
  } finally { await f.harness.close(context); }
});

test('with no answer the call ends at its timeout and the card stays open; a later handback reaches the agent as a message', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => { vi.useRealTimers(); });
  const f = await open(new MemoryStorage(), { ...asked, timeoutMinutes: 5 });
  try {
    await f.root.submit({ type: 'input', requestId: 'sign-in', content: 'Open GitHub' }, context);
    const { until, askedAt } = await f.card();
    await f.waiting();
    expect(until - askedAt).toBe(5 * 60_000);
    // The deadline is the card's: the real milliseconds the call took to start waiting count against it.
    vi.advanceTimersByTime(5 * 60_000 - 1000);
    expect(f.requests).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    const [, after] = await f.received(2);
    expect(after).toContain('No answer yet; the request stays open in the chat.');
    await f.settled();
    expect((await f.harness.snapshot(QuestionsDoc, context))?.items[0]).toMatchObject({ answer: null, takeover: { waiting: false } });
    // No call waits for the card now: its tab's handback is the agent's next message, and it answers the card.
    await f.lifecycle.deliver(browserEvent(String(f.root.id), 'browser-handback', '2026-10-25T10:05:00.000Z'));
    const [, , next] = await f.received(3);
    expect(next).toContain('The user handed tab-a back.');
    await f.settled();
    expect((await f.harness.snapshot(QuestionsDoc, context))?.items[0]?.answer).toBe('handed-back');
  } finally { await f.harness.close(context); }
});

test('a call a reset cut off waits again for the same card and returns on its handback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-takeover-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const before = await open(await openNodeJsonlStorage(directory, context));
  let until = 0;
  try {
    await before.root.submit({ type: 'input', requestId: 'sign-in', content: 'Open GitHub' }, context);
    until = (await before.card()).until;
    await before.waiting();
  } finally { await before.harness.close(context); }
  const after = await open(await openNodeJsonlStorage(directory, context));
  try {
    // The alarm drive after the reset: recovery, then resume.
    await after.lifecycle.recover();
    after.harness.resume();
    await after.waiting();
    // The rerun found its card: the account was not asked again and the deadline is the first one.
    expect(after.lookups).toEqual([]);
    expect(after.wakes).toEqual([until]);
    await after.lifecycle.deliver(browserEvent(String(after.root.id), 'browser-handback', '2026-10-25T10:05:00.000Z'));
    const requests = await after.received(1);
    expect(requests.at(-1)).toContain('The user handed the tab back; observe it again before acting.');
    await after.settled();
    expect(after.requests).toHaveLength(1);
  } finally { await after.harness.close(context); }
});

test('a subagent is refused before any card opens', async () => {
  const f = await open(new MemoryStorage());
  try {
    await f.root.commit(async tx => { (await tx.doc(AgentDefinitionContextDoc, f.root.id)).child = { parentId: 'parent', name: 'Researcher', attemptId: 'spawn', definition: null, selection: { kind: 'default' }, role: null, thinking: null, tools: ['read'], model: null }; }, context);
    await f.root.submit({ type: 'input', requestId: 'sign-in', content: 'Open GitHub' }, context);
    const [, after] = await f.received(2);
    expect(after).toContain('Subagent Researcher cannot use ask_takeover: only the main agent asks the user to take over a tab.');
    await f.settled();
    expect(f.lookups).toEqual([]);
    expect((await f.harness.snapshot(QuestionsDoc, context))?.items).toEqual([]);
  } finally { await f.harness.close(context); }
});
