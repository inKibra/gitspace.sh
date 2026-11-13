import { expect, test } from 'vitest';
import { MemoryStorage } from '@earendil-works/pi-durable';
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

/** A workspace runtime whose model runs `machine/prepare` through `environment`, runs it again when told the scripts
 * were approved, and otherwise answers "Done."; its scripts await approval until a card is approved, and every request
 * and every run that reaches the account is recorded. */
async function open() {
  const invoked: unknown[] = [];
  const requests: string[] = [];
  let approved = false;
  const models = Object.assign(createModels(), { getModel: () => model, streamSimple(_model: Model<Api>, request: { messages: unknown[] }) {
    const text = JSON.stringify(request.messages);
    requests.push(text);
    const runs = text.split('"id":"prepare-call-').length - 1;
    const call = runs === 0 || (runs === 1 && text.includes('Call environment again'));
    const reply: AssistantMessage = { role: 'assistant', content: call ? [{ type: 'toolCall', id: `prepare-call-${runs + 1}`, name: 'environment', arguments: { ...run } }] : [{ type: 'text', text: 'Done.' }], api: model.api, provider: model.provider, model: model.id, stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(), usage };
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
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: () => {}, admitInference: async () => ({ provider: 'test', modelId: model.id }), bindInferenceConversation: async () => {},
    refuseRequest: unused, unfinished: { begin: () => 0, end: () => {} },
  });
  /** The approval card, once the turn that posted it ended. */
  async function card() {
    await runtime.root.waitForIdle(context);
    const question = (await runtime.harness.snapshot(QuestionsDoc, context))?.items.find(item => item.kind === 'lifecycle-approval');
    if (!question) throw new Error('No lifecycle approval card was posted');
    return question;
  }
  /** The person's answer, as the workspace runtime records it once the account approved the scripts (an approval lands
   * first); the turn it starts ends before this returns. */
  async function answer(id: string, choice: RuntimeLifecycleApprovalAnswer) {
    if (choice !== 'not-now') approved = true;
    await runtime.lifecycle.closeQuestion(id, async () => ({ closure: { answer: choice }, value: undefined }));
    await runtime.root.waitForIdle(context);
  }
  /** Every tool result of the conversation, as its text. */
  async function results() {
    return (await runtime.root.context(context)).messages.flatMap(item => item.role === 'toolResult' ? [item.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')] : []);
  }
  return { ...runtime, invoked, requests, card, answer, results };
}
test.each<RuntimeLifecycleApprovalAnswer>(['project', 'workspace'])('a run with unapproved scripts posts a card and ends the turn; approved (%s), the agent hears it and its next run runs', async choice => {
  const f = await open();
  try {
    await f.root.submit({ type: 'input', requestId: 'prepare', content: 'Prepare the machine' }, context);
    const question = await f.card();
    expect(question).toMatchObject({ kind: 'lifecycle-approval', answer: null, choices: Object.values(LIFECYCLE_APPROVAL_CHOICES), lifecycle: { ...pending, callId: 'prepare-call-1' } });
    expect(question.prompt).toContain('10-install.sh');
    expect(f.invoked).toEqual([]);
    expect(f.requests).toHaveLength(1);
    expect(await f.results()).toEqual([expect.stringContaining(`Posted the approval of 10-install.sh, which machine/prepare runs (it did not run) to the user as question ${question.id}`)]);
    await f.answer(question.id, choice);
    expect(f.requests[1]).toContain(`The user approved 10-install.sh for ${choice === 'project' ? 'every workspace of the project' : 'this workspace'} (question ${question.id})`);
    expect((await f.results()).at(-1)).toBe('machine/prepare succeeded');
    expect(f.invoked).toEqual([run]);
  } finally { await f.harness.close(context); }
});

test('Not now on the card is the agent\'s next input, and the run never starts', async () => {
  const f = await open();
  try {
    await f.root.submit({ type: 'input', requestId: 'prepare', content: 'Prepare the machine' }, context);
    const question = await f.card();
    await f.answer(question.id, 'not-now');
    expect(f.requests[1]).toContain('did not approve 10-install.sh (Not now)');
    expect(f.invoked).toEqual([]);
    expect((await f.harness.snapshot(QuestionsDoc, context))?.items.find(item => item.id === question.id)?.answer).toBe('not-now');
  } finally { await f.harness.close(context); }
});
