import { expect, test } from 'vitest';
import { MemoryStorage, type ToolExecutionResult } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { LIFECYCLE_APPROVAL_CHOICES, RuntimeIdentitySchema, type RuntimeLifecycleApprovalAnswer, type RuntimeLifecycleApprovalRequest } from '@gitspace/protocol-runtime';
import { createRuntimeHarness } from './harness.js';
import { QuestionsDoc } from './documents.js';

const model: Model<Api> = { id: 'lifecycle', name: 'Lifecycle', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
const run = { method: 'runPhase', phase: 'machine/prepare', runId: 'prepare-1' };
const pending: RuntimeLifecycleApprovalRequest = { phase: 'machine/prepare', scripts: [{
  hash: `sha256:${'a'.repeat(64)}`, kind: 'script', label: '10-install.sh', phase: 'machine/prepare', fileName: '10-install.sh',
  content: '#!/bin/sh\nbun install --frozen-lockfile\n', previous: { content: '#!/bin/sh\nbun install\n', approvedBy: 'device-1' },
}] };

/** A workspace runtime whose model runs `machine/prepare` once through `environment` and then answers "Done."; its
 * scripts await approval until a card is approved, and every run that reaches the account is recorded. */
async function open() {
  const invoked: unknown[] = [];
  let approved = false;
  const models = Object.assign(createModels(), { getModel: () => model, streamSimple(_model: Model<Api>, request: { messages: unknown[] }) {
    const call = !JSON.stringify(request.messages).includes('"role":"toolResult"');
    const reply: AssistantMessage = { role: 'assistant', content: call ? [{ type: 'toolCall', id: 'prepare-call', name: 'environment', arguments: { ...run } }] : [{ type: 'text', text: 'Done.' }], api: model.api, provider: model.provider, model: model.id, stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(), usage };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message: reply }); stream.end(reply);
    return stream;
  } });
  const runtime = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: {
      images: { store: async image => image, load: async image => image }, prepareBrowser: unused, takeoverTab: unused, instructions: async () => '', preflight: async () => {}, results: { put: unused, text: unused },
      async invoke(input) { invoked.push(input.args); return { requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text: 'machine/prepare succeeded' }] }; },
      async lifecycleApproval(input) { return input.tool === 'environment' && !approved ? pending : null; },
    },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [], judge: unused, matchAst: unused }, editTool: () => 'edit',
    onReport: () => {}, admitInference: async () => ({ provider: 'test', modelId: model.id }), bindInferenceConversation: async () => {},
    refuseRequest: unused, unfinished: { begin: () => 0, end: () => {} },
  });
  /** The approval card once the call opened it. */
  async function card() {
    const watch = await runtime.harness.watchDoc(QuestionsDoc, context);
    if (!watch) throw new Error('Question document missing');
    const found = Promise.withResolvers<NonNullable<typeof watch.value>['items'][number]>();
    const check = (value: typeof watch.value) => { const question = value?.items.find(item => item.kind === 'lifecycle-approval'); if (question) found.resolve(question); };
    check(watch.value);
    watch.start(async call => { if (call.kind === 'value') check(call.value); });
    try { return await found.promise; } finally { await watch.stop(); }
  }
  /** The person's answer, as the account records it once it approved the scripts (an approval lands first). */
  async function answer(id: string, choice: RuntimeLifecycleApprovalAnswer) {
    if (choice !== 'not-now') approved = true;
    await runtime.harness.commit(async tx => { const question = (await tx.doc(QuestionsDoc)).items.find(item => item.id === id); if (question) question.answer = choice; }, context);
  }
  /** The environment call's result once the turn ended. */
  async function result(): Promise<Pick<ToolExecutionResult, 'isError'> & { text: string }> {
    await runtime.root.waitForIdle(context);
    const message = (await runtime.root.context(context)).messages.find(item => item.role === 'toolResult');
    if (message?.role !== 'toolResult') throw new Error('The environment call has no result');
    return { isError: message.isError, text: message.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('') };
  }
  return { ...runtime, invoked, card, answer, result };
}
test.each<RuntimeLifecycleApprovalAnswer>(['project', 'workspace'])('a run with unapproved scripts waits on a card; approved (%s), it runs once', async choice => {
  const f = await open();
  try {
    await f.root.submit({ type: 'input', requestId: 'prepare', content: 'Prepare the machine' }, context);
    const question = await f.card();
    expect(question).toMatchObject({ kind: 'lifecycle-approval', answer: null, choices: Object.values(LIFECYCLE_APPROVAL_CHOICES), lifecycle: { ...pending, callId: 'prepare-call' } });
    expect(question.prompt).toContain('10-install.sh');
    expect(f.invoked).toEqual([]);
    await f.answer(question.id, choice);
    expect(await f.result()).toEqual({ isError: false, text: 'machine/prepare succeeded' });
    expect(f.invoked).toEqual([run]);
  } finally { await f.harness.close(context); }
});

test('Not now on the card returns that the scripts were not approved, and the run never starts', async () => {
  const f = await open();
  try {
    await f.root.submit({ type: 'input', requestId: 'prepare', content: 'Prepare the machine' }, context);
    const question = await f.card();
    await f.answer(question.id, 'not-now');
    const result = await f.result();
    expect(result.isError).toBe(true);
    expect(result.text).toContain('did not approve 10-install.sh (Not now)');
    expect(f.invoked).toEqual([]);
  } finally { await f.harness.close(context); }
});
