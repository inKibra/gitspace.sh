import { expect, test } from 'vitest';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema, type RuntimeMcpElicitationRequest, type RuntimeMcpElicitResult, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { createRuntimeHarness } from './harness.js';
import { McpElicitationsDoc, QuestionsDoc } from './documents.js';
import { createSessionControls } from './session-controls.js';
import { runOf } from './runs.js';
import type { ToolServices } from './tools.js';

const model: Model<Api> = { id: 'mcp', name: 'MCP', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
const FORM: RuntimeMcpElicitationRequest = { mode: 'form', message: 'Where to deploy?', requestedSchema: { type: 'object', properties: { region: { type: 'string', enum: ['eu', 'us'] } }, required: ['region'] } };
const SECRET: RuntimeMcpElicitationRequest = { mode: 'form', message: 'Sign in to deploy', requestedSchema: { type: 'object', properties: { apiKey: { type: 'string', title: 'API key' } }, required: ['apiKey'] } };

/**
 * A workspace whose model runs one codemode script calling the `deploy` tool of MCP connection `deployer` and then
 * answers "Done."; the fake server asks `request` once per call and answers with what it received, echoing it. Every
 * model request and every answer the server got are recorded. `windowMs`: how long a call waits on a question.
 */
async function open(request: RuntimeMcpElicitationRequest, windowMs: number) {
  const requests: string[] = [];
  const received: (RuntimeMcpElicitResult | null)[] = [];
  let arrived = Promise.withResolvers<void>();
  const models = Object.assign(createModels(), { getModel: () => model, streamSimple(_model: Model<Api>, input: { messages: unknown[] }) {
    const text = JSON.stringify(input.messages);
    const call = requests.length === 0;
    const reply: AssistantMessage = { role: 'assistant', content: call ? [{ type: 'toolCall', id: 'script', name: 'codemode', arguments: { code: 'await tools.mcp_invoke({ connectionId: "deployer", name: "deploy" });' } }] : [{ type: 'text', text: 'Done.' }], api: model.api, provider: model.provider, model: model.id, stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(), usage };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message: reply }); stream.end(reply);
    requests.push(text);
    const done = arrived; arrived = Promise.withResolvers(); done.resolve();
    return stream;
  } });
  const completed = (input: { requestId: string; attemptId: string }, text: string): RuntimeToolResult => ({ requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text }] });
  const invoke: ToolServices['invoke'] = async input => {
    if (input.tool === 'codemode') {
      const outcome = await input.codemodeTools?.({ tool: 'mcp_invoke', args: { connectionId: 'deployer', name: 'deploy', arguments: {} }, callId: 'mcp', signal: new AbortController().signal });
      return completed(input, JSON.stringify(outcome));
    }
    if (input.tool !== 'mcp_invoke' || !input.mcpElicit) throw new Error(`Unexpected tool ${input.tool}`);
    const answer = await input.mcpElicit({ request, source: { connection: 'Deployer', server: 'deployer 1.0.0', workspace: 'Workspace' }, scope: 'request', taskId: null, inputId: null });
    received.push(answer);
    return completed(input, `deploy got ${JSON.stringify(answer ?? { action: 'cancel' })}`);
  };
  const runtime = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, invoke, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {}, results: { put: unused, text: unused }, mcpElicitationWindowMs: windowMs },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, async wakeAt() {} },
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: () => {}, admitInference: async () => ({ provider: 'test', modelId: model.id }), bindInferenceConversation: async () => {},
    refuseRequest: unused, unfinished: { begin: () => 0, end: () => {} },
  });
  const controls = createSessionControls({ ...runtime, admitInference: unused, reload: async () => {}, catalog: async () => ({ models: [], roles: [] }),
    history: { conversation: unused, recent: async () => ({ anchorId: null, prompts: [], tokens: null }), page: unused, resolve: unused, transcriptPage: unused, transcriptContent: unused, usage: unused } });
  const id = String(runtime.root.id);
  /** The open MCP question, once it is posted. */
  async function question() {
    const watch = await runtime.harness.watchDoc(QuestionsDoc, context);
    if (!watch) throw new Error('Questions missing');
    type Open = NonNullable<typeof watch.value>['items'][number];
    const posted = Promise.withResolvers<Open>();
    const read = (value: typeof watch.value) => { const found = value?.items.find(item => item.kind === 'mcp-elicitation' && item.answer === null && !item.closed); if (found) posted.resolve(found); };
    try {
      read(watch.value);
      watch.start(async call => { if (call.kind === 'value') read(call.value); });
      return await posted.promise;
    } finally { await watch.stop(); }
  }
  async function received2(count: number) { while (requests.length < count) await arrived.promise; return requests; }
  const answer = (questionId: string, selectedOptions: string[], customInput: string | null, answeredBy?: 'mcp-client') => controls.execute(id, { type: 'answerAsk', id: questionId, answers: [{ id: questionId, selectedOptions, customInput }], ...answeredBy ? { answeredBy } : {} }, false, 'device');
  return { ...runtime, controls, requests, received, id, question, answer, waitRequests: received2 };
}

test('a question nobody answers in time pauses the call and ends the turn; answered, the host calls again and replays the answer, and the result is the agent\'s next input', async () => {
  const f = await open(FORM, 30);
  try {
    await f.root.submit({ type: 'input', requestId: 'deploy', content: 'Deploy it' }, context);
    await f.root.waitForIdle(context);
    // The window passed: the server got cancel on that attempt, and the turn ended without another model request.
    expect(f.received).toEqual([null]);
    expect(f.requests).toHaveLength(1);
    const asked = await f.question();
    expect(asked).toMatchObject({ prompt: 'Deployer asks: Where to deploy?', choices: ['Decline', 'Cancel'], mcpElicitation: { connection: 'Deployer', tool: 'deploy', workspace: 'Workspace', request: FORM, host: null, secretLooking: false, scope: 'request', callId: 'script' } });
    expect((await runOf(f.harness, f.storage, f.root, 'deploy', context)).state).toBe('waiting');
    // An answer that does not fit the server's form is refused; nothing reaches the server.
    await expect(f.answer(asked.id, [], JSON.stringify({ region: 'mars' }))).rejects.toThrow('does not fit Deployer\'s form: region is one of eu, us');
    await f.answer(asked.id, [], JSON.stringify({ region: 'eu' }));
    const [, after] = await f.waitRequests(2);
    expect(f.received).toEqual([null, { action: 'accept', content: { region: 'eu' } }]);
    expect(after).toContain('Deployer\'s deploy finished after GitSpace continued it');
    expect(after).toContain('deploy got {\\"action\\":\\"accept\\",\\"content\\":{\\"region\\":\\"eu\\"}}');
    await f.root.waitForIdle(context);
    expect(await runOf(f.harness, f.storage, f.root, 'deploy', context)).toMatchObject({ state: 'finished', text: 'Done.' });
    expect(Object.values((await f.harness.snapshot(McpElicitationsDoc, context))?.calls ?? {}).map(call => call.state)).not.toContain('waiting');
  } finally { await f.harness.close(context); }
});

test('Decline reaches the server, and the agent hears what the server answered', async () => {
  const f = await open(FORM, 30);
  try {
    await f.root.submit({ type: 'input', requestId: 'deploy', content: 'Deploy it' }, context);
    await f.root.waitForIdle(context);
    const asked = await f.question();
    await f.answer(asked.id, ['Decline'], null);
    const [, after] = await f.waitRequests(2);
    expect(f.received).toEqual([null, { action: 'decline' }]);
    expect(after).toContain('declined');
    expect(after).toContain('deploy got {\\"action\\":\\"decline\\"}');
  } finally { await f.harness.close(context); }
});

test('a question answered within the window is given to the server in the same call, and the turn goes on', async () => {
  const f = await open(FORM, 10_000);
  try {
    await f.root.submit({ type: 'input', requestId: 'deploy', content: 'Deploy it' }, context);
    const asked = await f.question();
    // While the call waits on it, the run waits on the question.
    expect((await runOf(f.harness, f.storage, f.root, 'deploy', context)).question?.id).toBe(asked.id);
    await f.answer(asked.id, [], JSON.stringify({ region: 'us' }));
    await f.root.waitForIdle(context);
    expect(f.received).toEqual([{ action: 'accept', content: { region: 'us' } }]);
    expect(f.requests).toHaveLength(2);
    expect(Object.keys((await f.harness.snapshot(McpElicitationsDoc, context))?.calls ?? {})).toEqual([]);
  } finally { await f.harness.close(context); }
});

test('a form that looks like it asks for a secret takes only a person\'s answer, which the agent never sees', async () => {
  const f = await open(SECRET, 30);
  try {
    await f.root.submit({ type: 'input', requestId: 'deploy', content: 'Deploy it' }, context);
    await f.root.waitForIdle(context);
    const asked = await f.question();
    expect(asked.mcpElicitation?.secretLooking).toBe(true);
    await expect(f.answer(asked.id, [], JSON.stringify({ apiKey: 'sk-live-1234' }), 'mcp-client')).rejects.toThrow('only a person answers it');
    await f.answer(asked.id, [], JSON.stringify({ apiKey: 'sk-live-1234' }));
    const [, after] = await f.waitRequests(2);
    // Only the validated answer reached the server; the agent hears that it was answered, never the value.
    expect(f.received).toEqual([null, { action: 'accept', content: { apiKey: 'sk-live-1234' } }]);
    expect(after).not.toContain('sk-live-1234');
    expect(after).toContain('[redacted]');
    expect((await f.harness.snapshot(QuestionsDoc, context))?.items.find(item => item.id === asked.id)?.answer).toEqual({ action: 'accept', withheld: true });
  } finally { await f.harness.close(context); }
});
