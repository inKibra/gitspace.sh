import { expect, onTestFinished, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStorage, type Storage } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema, type RuntimeAskTakeoverArguments, type RuntimeTakeoverTab } from '@gitspace/protocol-runtime';
import { createRuntimeHarness } from './harness.js';
import type { ConversationEvent } from './conversation-lifecycle.js';
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
 * "Done."; every request's messages and every account lookup are recorded. */
async function open(storage: Storage, args: object = asked) {
  const requests: string[] = [];
  let arrived = Promise.withResolvers<void>();
  const lookups: RuntimeAskTakeoverArguments[] = [];
  const models = Object.assign(createModels(), { getModel: () => model, streamSimple(_model: Model<Api>, request: { messages: unknown[] }) {
    const text = JSON.stringify(request.messages);
    const ask = !text.includes('"role":"toolResult"');
    const reply: AssistantMessage = { role: 'assistant', content: ask ? [{ type: 'toolCall', id: 'takeover-call', name: 'ask_takeover', arguments: { ...args } }] : [{ type: 'text', text: 'Done.' }], api: model.api, provider: model.provider, model: model.id, stopReason: ask ? 'toolUse' : 'stop', timestamp: Date.now(), usage };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: ask ? 'toolUse' : 'stop', message: reply }); stream.end(reply);
    requests.push(text);
    const done = arrived; arrived = Promise.withResolvers(); done.resolve();
    return stream;
  } });
  const runtime = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage, models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, invoke: unused, prepareBrowser: unused, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {}, async takeoverTab(input) { lookups.push(input.args); return tab; }, results: { put: unused, text: unused } },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: () => {}, admitInference: async () => ({ provider: 'test', modelId: model.id }), bindInferenceConversation: async () => {},
    refuseRequest: unused, unfinished: { begin: () => 0, end: () => {} },
  });
  const controls = createSessionControls({ ...runtime, admitInference: unused, reload: async () => {}, catalog: async () => ({ models: [], roles: [] }),
    history: { conversation: unused, recent: async () => ({ anchorId: null, prompts: [], tokens: null }), page: unused, resolve: unused, transcriptPage: unused, transcriptContent: unused, usage: unused } });
  /** The takeover card, once the turn that posted it ended. */
  async function card() {
    await runtime.root.waitForIdle(context);
    const question = (await runtime.harness.snapshot(QuestionsDoc, context))?.items.find(item => item.kind === 'takeover');
    if (!question?.takeover) throw new Error('No takeover card was posted');
    return question;
  }
  /** Every request the provider received once `count` arrived. */
  async function received(count: number) { while (requests.length < count) await arrived.promise; return requests; }
  /** Settles everything the run and the deliveries left: the conversation idles with nothing pending. */
  async function settled() { await runtime.root.waitForIdle(context); await runtime.lifecycle.recover(); await runtime.root.waitForIdle(context); }
  return { ...runtime, controls, requests, lookups, card, received, settled };
}

test('ask_takeover posts its card and ends the turn; the take is told, and the handback answers the card as the next input', async () => {
  const f = await open(new MemoryStorage());
  try {
    await f.root.submit({ type: 'input', requestId: 'sign-in', content: 'Open GitHub' }, context);
    const question = await f.card();
    expect(question).toMatchObject({ kind: 'takeover', prompt: asked.reason, answer: null, takeover: { ...tab, callId: 'takeover-call' } });
    expect(f.lookups).toEqual([asked]);
    // The call ended the turn: no request followed its result.
    expect(f.requests).toHaveLength(1);
    const id = String(f.root.id);
    await f.lifecycle.deliver(browserEvent(id, 'browser-taken', '2026-10-25T10:00:00.000Z'));
    await f.settled();
    expect((await f.harness.snapshot(QuestionsDoc, context))?.items[0]).toMatchObject({ answer: null, takeover: { holder: 'you' } });
    // The user holds the tab: Not now and dismissing are refused.
    await expect(f.controls.execute(id, { type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['Not now'], customInput: null }] })).rejects.toThrow('Resume agent');
    await expect(f.controls.execute(id, { type: 'dismissQuestion', id: question.id })).rejects.toThrow('Resume agent');
    const before = f.requests.length;
    await f.lifecycle.deliver(browserEvent(id, 'browser-handback', '2026-10-25T10:05:00.000Z'));
    const requests = await f.received(before + 1);
    expect(requests.at(-1)).toContain('The user handed tab-a back.');
    await f.settled();
    expect((await f.harness.snapshot(QuestionsDoc, context))?.items[0]).toMatchObject({ answer: 'handed-back', takeover: { holder: 'agent' } });
  } finally { await f.harness.close(context); }
});

test('Not now closes the card and is the next input; Take over is not an answer, and a second answer is refused', async () => {
  const f = await open(new MemoryStorage());
  try {
    await f.root.submit({ type: 'input', requestId: 'sign-in', content: 'Open GitHub' }, context);
    const question = await f.card();
    const id = String(f.root.id);
    await expect(f.controls.execute(id, { type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['Take over'], customInput: null }] })).rejects.toThrow('answered only by Not now');
    await f.controls.execute(id, { type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['Not now'], customInput: null }] });
    const [, after] = await f.received(2);
    expect(after).toContain('The user declined to take over tab tab-a (Sign in to GitHub) in Studio desktop (Not now)');
    await f.settled();
    expect((await f.harness.snapshot(QuestionsDoc, context))?.items[0]?.answer).toBe('declined');
    await expect(f.controls.execute(id, { type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: ['Not now'], customInput: null }] })).rejects.toThrow(`Question ${question.id} is already answered`);
  } finally { await f.harness.close(context); }
});

test('a card outlives a restart of the runtime; its handback after the restart starts the next turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-takeover-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const before = await open(await openNodeJsonlStorage(directory, context));
  try {
    await before.root.submit({ type: 'input', requestId: 'sign-in', content: 'Open GitHub' }, context);
    await before.card();
  } finally { await before.harness.close(context); }
  const after = await open(await openNodeJsonlStorage(directory, context));
  try {
    // The alarm drive after the reset: recovery, then resume. No call runs again, and the account is not asked again.
    await after.lifecycle.recover();
    after.harness.resume();
    expect(after.lookups).toEqual([]);
    expect((await after.harness.snapshot(QuestionsDoc, context))?.items[0]).toMatchObject({ answer: null });
    expect((await after.harness.snapshot(QuestionsDoc, context))?.items[0]?.closed).toBeUndefined();
    await after.lifecycle.deliver(browserEvent(String(after.root.id), 'browser-handback', '2026-10-25T10:05:00.000Z'));
    const requests = await after.received(1);
    expect(requests.at(-1)).toContain('The user handed tab-a back.');
    await after.settled();
    expect((await after.harness.snapshot(QuestionsDoc, context))?.items[0]?.answer).toBe('handed-back');
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
