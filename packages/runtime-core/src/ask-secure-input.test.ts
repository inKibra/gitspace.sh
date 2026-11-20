import { expect, test } from 'vitest';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema, type RuntimeAskSecureInputArguments, type RuntimeSecureInputQuestion } from '@gitspace/protocol-runtime';
import { createRuntimeHarness } from './harness.js';
import { QuestionsDoc } from './documents.js';
import { createSessionControls } from './session-controls.js';
import { expireSecureInputs, secureInputOpen, settleSecureInput } from './secure-input.js';

const model: Model<Api> = { id: 'secure-input', name: 'Secure input', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
const groupId = '00000000-0000-4000-8000-0000000000a1', pairingId = '00000000-0000-4000-8000-0000000000b2';
const requestId = 'r'.repeat(43);
const asked: RuntimeAskSecureInputArguments = { source: 'relay', pairingId, targetId: 'tab-a', origin: 'https://github.com', selector: '#password', kind: 'password', purpose: 'Sign in to GitHub as octocat' };

/** The workspace runtime's harness whose model asks for secure input once and then answers "Done."; every request's
 * messages, every account request and every wake are recorded. `expiresAt` is when the account's request expires. */
async function open(expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()) {
  const requests: string[] = [];
  let arrived = Promise.withResolvers<void>();
  const recorded: { conversationId: string; questionId: string; callId: string; args: RuntimeAskSecureInputArguments }[] = [];
  const wakes: number[] = [];
  const models = Object.assign(createModels(), { getModel: () => model, streamSimple(_model: Model<Api>, request: { messages: unknown[] }) {
    const text = JSON.stringify(request.messages);
    const ask = !text.includes('"role":"toolResult"');
    const reply: AssistantMessage = { role: 'assistant', content: ask ? [{ type: 'toolCall', id: 'secure-call', name: 'ask_secure_input', arguments: { ...asked } }] : [{ type: 'text', text: 'Done.' }], api: model.api, provider: model.provider, model: model.id, stopReason: ask ? 'toolUse' : 'stop', timestamp: Date.now(), usage };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: ask ? 'toolUse' : 'stop', message: reply }); stream.end(reply);
    requests.push(text);
    const done = arrived; arrived = Promise.withResolvers(); done.resolve();
    return stream;
  } });
  const runtime = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, invoke: unused, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {}, results: { put: unused, text: unused },
      async secureInput(input): Promise<RuntimeSecureInputQuestion> {
        recorded.push(input);
        return { requestId, url: `https://account.example/secure-input/${requestId}`, source: 'chrome', pairingId, browser: 'Chrome "Studio desktop"', groupId, targetId: 'tab-a', title: 'Sign in to GitHub', workspace: 'Workspace', origin: asked.origin, selector: '#password', kind: 'password', purpose: asked.purpose, expiresAt, callId: input.callId, askedAt: new Date().toISOString() };
      } },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, async wakeAt(at) { wakes.push(at); } },
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: () => {}, admitInference: async () => ({ provider: 'test', modelId: model.id }), bindInferenceConversation: async () => {},
    refuseRequest: unused, unfinished: { begin: () => 0, end: () => {} },
  });
  const controls = createSessionControls({ ...runtime, admitInference: unused, reload: async () => {}, catalog: async () => ({ models: [], roles: [] }),
    history: { conversation: unused, recent: async () => ({ anchorId: null, prompts: [], tokens: null }), page: unused, resolve: unused, transcriptPage: unused, transcriptContent: unused, usage: unused } });
  await runtime.root.submit({ type: 'input', requestId: 'sign-in', content: 'Sign in to GitHub' }, context);
  await runtime.root.waitForIdle(context);
  const question = (await runtime.harness.snapshot(QuestionsDoc, context))?.items.find(item => item.kind === 'secure-input');
  if (!question?.secureInput) throw new Error('No secure-input question was posted');
  async function received(count: number) { while (requests.length < count) await arrived.promise; return requests; }
  return { ...runtime, controls, requests, recorded, wakes, question, received, id: String(runtime.root.id) };
}

test('ask_secure_input records the request for its question, ends the turn, and wakes the workspace when it expires', async () => {
  const f = await open();
  try {
    expect(f.recorded).toEqual([{ conversationId: f.id, questionId: f.question.id, callId: 'secure-call', args: asked }]);
    expect(f.question).toMatchObject({ kind: 'secure-input', prompt: asked.purpose, choices: ['Decline'], answer: null, secureInput: { requestId, origin: 'https://github.com', callId: 'secure-call' } });
    // The call ended the turn: no request followed its result, and the result says only that it was posted.
    expect(f.requests).toHaveLength(1);
    expect(f.wakes).toEqual([Date.parse(f.question.secureInput?.expiresAt ?? '')]);
    expect(await secureInputOpen(f.harness, f.question.id, requestId)).toBe(true);
  } finally { await f.harness.close(context); }
});

test('a fill answers the request provided: the next input says it was filled, and no request carries the value', async () => {
  const f = await open();
  try {
    await settleSecureInput(f.lifecycle, f.question.id, requestId, { outcome: 'provided' });
    const [, after] = await f.received(2);
    expect(after).toContain(`A person provided the value for your secure-input request (question ${f.question.id}), and GitSpace filled it into the password field #password of tab tab-a in Chrome \\"Studio desktop\\" (https://github.com)`);
    expect(await secureInputOpen(f.harness, f.question.id, requestId)).toBe(false);
    // A second answer, or one naming another request, is refused.
    await expect(settleSecureInput(f.lifecycle, f.question.id, requestId, { outcome: 'provided' })).rejects.toThrow(`Question ${f.question.id} is already answered`);
  } finally { await f.harness.close(context); }
});

test('its card takes Decline alone: any other choice or text is refused, Decline is the next input', async () => {
  const f = await open();
  try {
    const answer = (selectedOptions: string[], customInput: string | null) => f.controls.execute(f.id, { type: 'answerAsk', id: f.question.id, answers: [{ id: f.question.id, selectedOptions, customInput }] });
    await expect(answer([], 'hunter2')).rejects.toThrow('it can only be declined');
    await expect(answer(['Decline'], 'hunter2')).rejects.toThrow('it can only be declined');
    await expect(answer(['Provided'], null)).rejects.toThrow('it can only be declined');
    await answer(['Decline'], null);
    const [, after] = await f.received(2);
    expect(after).toContain(`Your secure-input request (question ${f.question.id}) was declined: The person declined it. Nothing was filled`);
    expect(f.requests.join('\n')).not.toContain('hunter2');
    expect((await f.harness.snapshot(QuestionsDoc, context))?.items[0]?.answer).toEqual({ outcome: 'declined', reason: 'The person declined it' });
  } finally { await f.harness.close(context); }
});

test('a request nobody answered closes as expired at its expiry, and the conversation hears it', async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const f = await open(expiresAt);
  try {
    // Before its expiry it stays open, and the next wake is its expiry.
    expect(await expireSecureInputs(f.harness, f.lifecycle, Date.now())).toBe(Date.parse(expiresAt));
    expect(await secureInputOpen(f.harness, f.question.id, requestId)).toBe(true);
    expect(await expireSecureInputs(f.harness, f.lifecycle, Date.parse(expiresAt))).toBeNull();
    const [, after] = await f.received(2);
    expect(after).toContain(`Your secure-input request (question ${f.question.id}) expired: nobody provided the value in time`);
    expect((await f.harness.snapshot(QuestionsDoc, context))?.items[0]?.answer).toEqual({ outcome: 'expired' });
  } finally { await f.harness.close(context); }
});
