import { expect, test } from 'vitest';
import { ConversationLifecycleDoc } from './conversation-lifecycle.js';
import { z } from 'zod';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { createModels, createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Message, type Models, type Model, type Api, type ToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import { RuntimeBrowserApprovalCardSchema, RuntimeFullOutputDetailsSchema, RuntimeJobAcceptanceSchema, RuntimeJobObservationSchema, TOOL_RESULT_MAX_BYTES, toolResultReference } from '@gitspace/protocol-runtime';
import { QuestionsDoc, TodosDoc, WorkspaceDoc, PlanDoc } from './documents.js';
import { SessionControlsDoc } from './session-controls.js';
import { createRuntimeTools, parseToolArguments, runtimeToolParameters, type ToolServices } from './tools.js';
import type { ToolResultKey } from './tool-results.js';
import { RuntimeWorkspaceArgumentsSchema } from '@gitspace/protocol/inspector-contract';
import { DurableJobsDoc, createJobTask, createJobTool, type JobServices } from './jobs.js';
import { RuntimeBashArgumentsSchema } from '@gitspace/protocol-runtime/tool-arguments';

const model: Model<Api> = { id: 'tool-contract', name: 'Tool contract', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const unused = async (): Promise<never> => { throw new Error('Unexpected operation'); };
const operations: JobServices = { execute: unused, reconcile: unused, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, wakeAt: unused, deliverConversationEvent: unused, observeProcess: unused, stopProcess: unused };
const completed: ToolServices['invoke'] = async input => ({ status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text: `Executed ${input.tool}` }] });
/** Outputs the workspace kept, by reference. */
const kept = new Map<string, string>();
const keptReference = (key: ToolResultKey) => toolResultReference({ workspaceId: 'workspace', ...key });
/** Images the workspace stored, by the data each entered history with. */
const storedImages: string[] = [];
const services: ToolServices = {
  images: { async store(image) { storedImages.push(image.data); return { ...image, data: `stored:${image.data}` }; } },
  invoke: completed,
  async prepareBrowser() { return RuntimeBrowserApprovalCardSchema.parse({ id: 'browser', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'attachment', generation: 1, groupId: '00000000-0000-4000-8000-000000000001', groupName: 'Workspace', origins: [], source: 'headless', expiresAt: new Date(Date.now() + 60000).toISOString(), action: 'tabs' }); },
  question: async () => 'answered', instructions: async () => '', preflight: async () => {},
  async takeoverTab(input) { return { source: 'cloud', pairingId: null, browser: 'Cloud browser', groupId: '00000000-0000-4000-8000-000000000002', targetId: input.args.targetId, url: 'https://example.com/', title: 'Example', holder: 'agent' }; },
  results: {
    async put(input) { kept.set(keptReference(input), input.text); return keptReference(input); },
    async text(key) { const text = kept.get(keptReference(key)); if (text === undefined) throw new Error(`${keptReference(key)} names no kept tool output`); return text; },
  },
};
const samples: Record<string, ToolCall['arguments']> = {
  read: { path: 'src/main.ts', offset: 1, limit: 10 }, write: { path: 'src/main.ts', content: 'new content' },
  edit: { path: 'src/main.ts', edits: [{ oldText: 'old', newText: 'new' }] }, apply_patch: { patch: '*** Begin Patch\n*** Add File: new.ts\n+export {};\n*** End Patch' },
  bash: { command: 'pwd' }, grep: { pattern: 'needle', path: 'src' }, code_search: { pattern: 'needle', path: 'src' }, find: { pattern: '*.ts', path: 'src' }, codemode: { code: 'return 1;' },
  agents: { op: 'list' }, proc: { op: 'list' }, machines: { op: 'list' }, environment: { method: 'get' }, sync: { method: 'status' }, workspace_status: {},
  space_goal: { method: 'get' }, space_phase: { phase: 'code' }, space_workspace: { method: 'current' }, space_automations: { method: 'list' }, space_artifacts: { method: 'list' },
  space_workflow: { method: 'get' }, space_rubric: { method: 'get' }, space_journal: { method: 'list' }, space_guide: { method: 'get' }, space_review: { method: 'list' },
  web_search: { query: 'TypeScript documentation' }, generate_image: { prompt: 'A blue square' }, ast_grep: { pattern: 'foo($A)', path: 'src', language: 'typescript' },
  ast_edit: { ops: [{ pat: 'foo($A)', out: 'bar($A)' }], paths: ['src/main.ts'], language: 'typescript' }, ast_resolve: { proposalId: 'proposal', action: 'reject' },
  history_search: { query: 'decision' }, history_read: { conversationId: 'conversation' }, report_issue: { message: 'Observed concrete failure' },
  checkpoint: { goal: 'Inspect implementation' }, rewind: { checkpoint: 'checkpoint', report: 'Findings' }, delegate_export: { commit: 'a'.repeat(40) },
  mcp_discover: {}, mcp_invoke: { connectionId: 'connection', name: 'lookup', arguments: { query: 'hello' } }, web_browser: { action: 'tabs' },
  todo: { items: [{ id: 'proof', text: 'Exercise registrations', status: 'completed' }] }, ask: { prompt: 'Choose a path', choices: ['A', 'B'] }, propose_plan: { prompt: 'Implement the selected plan', choices: ['Approve', 'Reject'] },
  ask_takeover: { source: 'headless', targetId: 'tab', reason: 'Solve the CAPTCHA' },
};
async function registered(rounds: ToolCall[][], invoke: ToolServices['invoke'] = completed, jobServices: JobServices = operations, extraTools: ToolRegistration[] = [], chatModel: Model<Api> = model) {
  const tools = [...createRuntimeTools({ ...services, invoke }, jobServices, (id, context) => harness.abortTask(id, context), async () => {}), ...extraTools];
  const registry = createRegistry(); registry.install(defineExtension({ name: 'registration-proof', tools, tasks: [createJobTask(jobServices)] }));
  let generation = 0;
  const models: Models = { ...createModels(), getModel: () => chatModel, streamSimple(_model, context) {
    const providerSchema = z.object({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()), anyOf: z.never().optional(), oneOf: z.never().optional(), allOf: z.never().optional() });
    for (const tool of getCurrentTools(context.messages)) providerSchema.parse(tool.parameters);
    const calls = rounds[generation++];
    const reply: AssistantMessage = { role: 'assistant', content: calls ?? [{ type: 'text', text: 'Complete.' }], api: model.api, provider: model.provider, model: model.id, stopReason: calls ? 'toolUse' : 'stop', timestamp: generation, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: calls ? 'toolUse' : 'stop', message: reply }); stream.end(reply); return stream;
  } };
  const harness = await Harness.open(new MemoryStorage(), { registry, models, settings: { toolExecution: 'parallel', compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: chatModel.provider, modelId: chatModel.id }, tools } });
  await harness.commit(async tx => { (await tx.doc(WorkspaceDoc)).phase = 'code'; }, BACKGROUND_CONTEXT);
  return { harness, root, tools };
}
const call = (name: string, args: ToolCall['arguments'], id = name): ToolCall => ({ type: 'toolCall', name, arguments: args, id });

test('every registered tool advertises its real object contract and executes through the Harness registration path', async () => {
  const routed: string[] = [];
  const fixture = await registered([Object.entries(samples).map(([name, args]) => call(name, args))], async input => { routed.push(input.tool); return completed(input); }, { ...operations, wakeAt: async () => {} });
  const { harness, root, tools } = fixture;
  try {
    expect(tools.map(tool => tool.name).sort()).toEqual(Object.keys(samples).sort());
    // ask_takeover waits for its card: Not now ends it.
    await harness.commit(async tx => { await tx.doc(QuestionsDoc); }, BACKGROUND_CONTEXT);
    const watch = await harness.watchDoc(QuestionsDoc, BACKGROUND_CONTEXT);
    if (!watch) throw new Error('Question document missing');
    const opened = Promise.withResolvers<void>();
    watch.start(async value => { if (value?.items.some(item => item.kind === 'takeover')) opened.resolve(); });
    await root.submit({ type: 'input', content: 'Exercise all registered contracts.' }, BACKGROUND_CONTEXT);
    await opened.promise;
    await watch.stop();
    await harness.commit(async tx => { for (const item of (await tx.doc(QuestionsDoc)).items) if (item.kind === 'takeover') item.answer = 'declined'; }, BACKGROUND_CONTEXT);
    await root.waitForIdle(BACKGROUND_CONTEXT);
    const results = (await root.context(BACKGROUND_CONTEXT)).messages.filter(message => message.role === 'toolResult');
    expect(results.map(result => result.toolCallId).sort()).toEqual(Object.keys(samples).sort());
    expect(results.filter(result => result.isError)).toEqual([]);
    // The transcript shows the answer from the result's details, not from its text.
    expect(results.find(result => result.toolCallId === 'ask')?.details).toEqual({ results: [{ selectedOptions: [], customInput: 'answered' }] });
    // Models call web_browser (OpenAI reserves `browser`); dispatch keeps the signed protocol name.
    expect(routed.sort()).toEqual(Object.keys(samples).filter(name => !['todo', 'ask', 'propose_plan', 'ask_takeover'].includes(name)).map(name => name === 'web_browser' ? 'browser' : name).sort());
    expect((await harness.snapshot(TodosDoc, root.id, BACKGROUND_CONTEXT))?.items).toEqual(samples.todo?.items);
    expect((await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items.map(question => question.kind).sort()).toEqual(['approval', 'ask', 'takeover']);
    expect((await harness.snapshot(PlanDoc, root.id, BACKGROUND_CONTEXT))?.status).toBe('proposed');
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
test('an image the conversation\'s model cannot take never enters history, and one it can enters as its stored bytes', async () => {
  const png = (width: number, height: number) => {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height);
    return { type: 'image' as const, mimeType: 'image/png', data: btoa(String.fromCharCode(...bytes)) };
  };
  storedImages.length = 0;
  const vision: Model<Api> = { ...model, input: ['text', 'image'], inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592 } } } };
  const fixture = await registered([[call('read', samples.read ?? {})]], async input => ({ status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text: 'Two captures' }, png(1440, 5400), png(1280, 800)] }), operations, [], vision);
  try {
    await fixture.root.submit({ type: 'input', content: 'Read the screenshots.' }, BACKGROUND_CONTEXT);
    await fixture.root.waitForIdle(BACKGROUND_CONTEXT);
    const [result] = (await fixture.root.context(BACKGROUND_CONTEXT)).messages.filter(message => message.role === 'toolResult');
    expect(storedImages).toEqual([png(1280, 800).data]);
    expect(result?.content.map(part => part.type === 'image' ? `image ${part.data === `stored:${png(1280, 800).data}` ? '1280x800' : 'other'}` : part.text)).toEqual([
      'Two captures',
      '[Image not shown: it is 1440x5400, larger than the 2000x2000 the model accepts. Crop it, capture only the visible viewport, or describe what you need from it.]',
      'image 1280x800',
    ]);
  } finally { await fixture.harness.close(BACKGROUND_CONTEXT); }
});
test('published operation parameters admit both command and control arguments', () => {
  const advertised = z.fromJSONSchema(runtimeToolParameters(RuntimeBashArgumentsSchema));
  expect(advertised.parse({ command: 'pwd' })).toEqual({ command: 'pwd' });
  expect(advertised.parse({ op: 'list' })).toEqual({ op: 'list' });
});


test('registration rejects missing required fields and invalid nested edits without dispatching', async () => {
  const routed: string[] = [];
  const { harness, root } = await registered([[call('read', {}), call('edit', { path: 'file', edits: [{ oldText: '', newText: 'value' }] }), call('mcp_invoke', { connectionId: 'connection' }), call('bash', { op: 'status' }, 'bash-missing-job'), call('bash', { op: 'list', command: 'pwd' }, 'bash-mixed-operation')]], async input => { routed.push(input.tool); return completed(input); });
  try {
    await root.submit({ type: 'input', content: 'Exercise invalid arguments.' }, BACKGROUND_CONTEXT); await root.waitForIdle(BACKGROUND_CONTEXT);
    const results = (await root.context(BACKGROUND_CONTEXT)).messages.filter(message => message.role === 'toolResult');
    expect(results.map(result => result.toolCallId).sort()).toEqual(['bash-missing-job', 'bash-mixed-operation', 'edit', 'mcp_invoke', 'read']);
    expect(results.every(result => result.isError)).toBe(true);
    expect(routed).toEqual([]);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});

test('registered mutations run one at a time and in model order across rounds, and a failed one does not stop the rest', async () => {
  let active = 0, maximum = 0;
  const effects: string[] = [];
  const { harness, root } = await registered([
    [call('write', { path: 'first', content: 'one' }, 'first'), call('write', { path: 'second', content: 'two' }, 'second'), call('read', { path: 'read-a' }, 'read-a'), call('read', { path: 'read-b' }, 'read-b')],
    [call('write', { path: 'third', content: 'three' }, 'third')],
  ], async input => {
    effects.push(input.requestId);
    if (input.tool === 'read') return completed(input);
    active++; maximum = Math.max(maximum, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (input.requestId === 'first') throw new Error('First mutation failed');
      return completed(input);
    } finally { active--; }
  });
  try {
    await root.submit({ type: 'input', content: 'Exercise ordered writes and reads.' }, BACKGROUND_CONTEXT); await root.waitForIdle(BACKGROUND_CONTEXT);
    expect(maximum).toBe(1);
    expect(effects).toEqual(['first', 'second', 'read-a', 'read-b', 'third']);
    const results = (await root.context(BACKGROUND_CONTEXT)).messages.filter(message => message.role === 'toolResult');
    expect(results.filter(result => result.isError)).toHaveLength(1);
    expect(results.find(result => result.toolCallId === 'third')?.isError).toBe(false);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}, 5000);
test('machine selectors survive real bash and proc registrations and invalid selectors never dispatch', async () => {
  const routed: Array<Parameters<ToolServices['invoke']>[0]> = [];
  const bash = { command: 'pwd', on: 'machine-chosen' };
  const proc = { op: 'list', on: { needs: ['linux'], prefer: 'idle' } };
  const { harness, root } = await registered([[
    call('bash', bash, 'selected-bash'), call('proc', proc, 'selected-proc'),
    call('bash', { command: 'pwd', on: '' }, 'invalid-bash'),
    call('proc', { op: 'list', on: { prefer: 'busy' } }, 'invalid-proc'),
  ]], async input => { routed.push(input); return completed(input); });
  try {
    await root.submit({ type: 'input', content: 'Select machines explicitly.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(BACKGROUND_CONTEXT);
    expect(routed.find(input => input.requestId === 'selected-bash')?.args).toEqual(bash);
    expect(routed.find(input => input.requestId === 'selected-proc')?.args).toEqual(proc);
    expect(routed.map(input => input.requestId).sort()).toEqual(['selected-bash', 'selected-proc']);
    const results = (await root.context(BACKGROUND_CONTEXT)).messages.filter(message => message.role === 'toolResult');
    expect(results.filter(result => result.isError).map(result => result.toolCallId).sort()).toEqual(['invalid-bash', 'invalid-proc']);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});

test('find registration rejects unsupported glob instead of silently dropping a filter', async () => {
  const routed: string[] = [];
  const { harness, root } = await registered([[call('find', { pattern: '*.ts', path: 'src', glob: '*.md' })]], async input => { routed.push(input.tool); return completed(input); });
  try {
    await root.submit({ type: 'input', content: 'Find with an unsupported filter.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(BACKGROUND_CONTEXT);
    const results = (await root.context(BACKGROUND_CONTEXT)).messages.filter(message => message.role === 'toolResult');
    expect(results.map(result => ({ id: result.toolCallId, error: result.isError }))).toEqual([{ id: 'find', error: true }]);
    expect(routed).toEqual([]);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});

test('agent environment registration rejects human lifecycle options before dispatch and accepts supported runs', async () => {
  const supported: ToolCall['arguments'][] = [
    { method: 'runChecks', runId: 'checks', rerun: true, deadlineAt: '2030-01-01T00:00:00.000Z', on: 'machine' },
    { method: 'runPhase', runId: 'prepare', phase: 'machine/prepare', rerun: true, deadlineAt: '2030-01-01T00:00:00.000Z', on: { needs: ['linux'], prefer: 'idle' } },
  ];
  const forbidden: ToolCall['arguments'][] = [
    { method: 'runChecks', runId: 'interactive-checks', interactive: true },
    { method: 'runChecks', runId: 'noninteractive-checks', interactive: false },
    { method: 'runPhase', runId: 'interactive-phase', phase: 'machine/prepare', interactive: true },
    { method: 'runPhase', runId: 'noninteractive-phase', phase: 'machine/prepare', interactive: false },
    { method: 'runPhase', runId: 'destroy', phase: 'cloud/destroy' },
  ];
  const routed: string[] = [];
  const { harness, root } = await registered([[...supported.map((args, index) => call('environment', args, `valid-${index}`)), ...forbidden.map((args, index) => call('environment', args, `invalid-${index}`))]], async input => { routed.push(input.requestId); return completed(input); });
  try {
    await root.submit({ type: 'input', content: 'Exercise agent lifecycle boundary.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(BACKGROUND_CONTEXT);
    const results = (await root.context(BACKGROUND_CONTEXT)).messages.filter(message => message.role === 'toolResult');
    expect(results.filter(result => result.isError).map(result => result.toolCallId).sort()).toEqual(forbidden.map((_, index) => `invalid-${index}`));
    expect(routed.sort()).toEqual(['valid-0', 'valid-1']);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});

test('agent advertised lifecycle schema excludes human options', () => {
  const environment = createRuntimeTools(services, operations, unused, unused).find(tool => tool.name === 'environment');
  if (!environment) throw new Error('Missing environment registration');
  const advertised = JSON.stringify(environment.parameters);
  expect(advertised).not.toContain('"interactive"');
  expect(advertised).not.toContain('"cloud/destroy"');
});

test('background bash rejects unavailable execution before returning acceptance or creating durable work', async () => {
  let executions = 0;
  const { harness, root } = await registered([[call('bash', { command: 'pwd', background: true })]], completed, {
    ...operations,
    jobScope: async () => { throw new Error('No machine attached: attach a ready workspace cache.'); },
    execute: async () => { executions++; return unused(); },
  });
  try {
    await root.submit({ type: 'input', content: 'Run without an available machine.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(BACKGROUND_CONTEXT);
    const result = (await root.context(BACKGROUND_CONTEXT)).messages.find(message => message.role === 'toolResult');
    expect(result?.role === 'toolResult' && result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('No machine attached');
    expect((await harness.snapshot(DurableJobsDoc, root.id, BACKGROUND_CONTEXT))?.records ?? {}).toEqual({});
    expect(executions).toBe(0);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});

test('a mutating machine command with no machine attached fails before dispatch', async () => {
  let dispatched = 0;
  const tools = createRuntimeTools({ ...services, async invoke(input) { dispatched++; return completed(input); }, async preflight(input) { if (input.tool === 'bash') throw new Error('No machine attached: attach a ready workspace cache or choose an available execution machine.'); } }, operations, (id, context) => harness.abortTask(id, context), async () => {});
  const registry = createRegistry(); registry.install(defineExtension({ name: 'preflight-proof', tools }));
  let generation = 0;
  const models: Models = { ...createModels(), getModel: () => model, streamSimple() {
    const calls = generation++ === 0 ? [call('bash', { command: 'touch effect' })] : undefined;
    const reply: AssistantMessage = { role: 'assistant', content: calls ?? [{ type: 'text', text: 'Complete.' }], api: model.api, provider: model.provider, model: model.id, stopReason: calls ? 'toolUse' : 'stop', timestamp: generation, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: calls ? 'toolUse' : 'stop', message: reply }); stream.end(reply); return stream;
  } };
  const harness = await Harness.open(new MemoryStorage(), { registry, models, settings: { compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id }, tools } });
    await harness.commit(async tx => { (await tx.doc(WorkspaceDoc)).phase = 'code'; }, BACKGROUND_CONTEXT);
    await root.submit({ type: 'input', content: 'Run a command.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(withAbortSignal(AbortSignal.timeout(1500), BACKGROUND_CONTEXT));
    expect((await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items ?? []).toEqual([]);
    expect(dispatched).toBe(0);
    const result = (await root.context(BACKGROUND_CONTEXT)).messages.find(message => message.role === 'toolResult');
    expect(result?.role === 'toolResult' && result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('No machine attached');
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}, 5000);

for (const mode of ['settled', 'timeout', 'cancelled'] as const) test(`bash wait observes ${mode} without returning an immediate stale acceptance`, async () => {
  const probe = defineTool({
    name: 'wait-probe', description: 'Exercise a durable command wait.', parameters: Type.Object({}), replay: 'safe',
    async execute(_input, api, context) {
      const acceptedAt = new Date().toISOString();
      const acceptance = RuntimeJobAcceptanceSchema.parse({ status: 'accepted', acceptedAt, job: { projectId: 'project', workspaceId: 'workspace', jobId: 'waiting-command', taskId: String(api.taskId), conversationId: String(api.conversationId), requestId: 'waiting-command' } });
      await api.commit(async tx => {
        (await tx.doc(DurableJobsDoc, api.conversationId)).records.command = { acceptance, observation: acceptance, args: { command: 'true', background: true }, fingerprint: 'accepted', spawningTask: api.taskId, deadlineAt: new Date(Date.now() + 10000).toISOString(), attemptId: 'waiting-command', cancelRequested: false, delivered: false };
      }, context);
      const controller = new AbortController();
      const interrupted = new Error('Cancelled bounded command wait');
      let finished = false;
      // The timeout case deliberately exercises the production timer against the actual Harness watch.
      const pending = createJobTool(operations)({ op: 'wait', job: acceptance.job, timeoutMs: mode === 'timeout' ? 50 : 1000 }, api, withAbortSignal(controller.signal, context));
      void pending.then(() => { finished = true; }, () => { finished = true; });
      await api.snapshot(DurableJobsDoc, api.conversationId, context);
      await api.snapshot(DurableJobsDoc, api.conversationId, context);
      expect(finished).toBe(false);
      if (mode === 'settled') await api.commit(async tx => {
        (await tx.doc(DurableJobsDoc, api.conversationId)).records.command.observation = RuntimeJobObservationSchema.parse({ status: 'not-started', job: acceptance.job, reason: 'cancelled', completedAt: new Date().toISOString() });
        // The job task delivers its completion as it settles; the wait that returns it makes that message redundant.
        (await tx.doc(ConversationLifecycleDoc, api.conversationId)).events.push({ event: { conversationId: String(api.conversationId), requestId: 'job-completion:waiting-command', kind: 'command-completed', text: 'did not start' } });
      }, context);
      if (mode === 'cancelled') {
        controller.abort(interrupted);
        await expect(pending).rejects.toThrow('Cancelled bounded command wait');
      } else expect(RuntimeJobObservationSchema.parse(await pending).status).toBe(mode === 'settled' ? 'not-started' : 'accepted');
      if (mode === 'settled') expect(await api.snapshot(ConversationLifecycleDoc, api.conversationId, context)).toMatchObject({ events: [], handled: ['job-completion:waiting-command'] });
      return { output: [{ type: 'text', text: mode }] };
    },
  });
  const { harness, root } = await registered([[call('wait-probe', {})]], completed, operations, [probe]);
  try {
    await root.submit({ type: 'input', content: 'Observe the accepted command.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(withAbortSignal(AbortSignal.timeout(2000), BACKGROUND_CONTEXT));
    const result = (await root.context(BACKGROUND_CONTEXT)).messages.find(message => message.role === 'toolResult');
    expect(result?.role === 'toolResult' && result.isError).toBe(false);
    expect(result?.content).toEqual([{ type: 'text', text: mode }]);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}, 4000);

test('a background command settles on its executor result and delivers its completion once', async () => {
  const delivered: Array<{ requestId: string; payload: unknown }> = [];
  let finished: string | null = null;
  let resume = () => {};
  const { harness, root } = await registered([[call('bash', { command: 'make build', background: true }, 'start')]], completed, {
    ...operations,
    // Production wakes the Harness from an alarm; background tasks run on resume.
    wakeAt: async at => { setTimeout(() => resume(), Math.max(0, at - Date.now())); },
    async execute(input) { finished = input.attemptId; return { status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text: 'built' }] }; },
    async reconcile(attemptId) { return finished === attemptId ? { status: 'completed', requestId: attemptId, attemptId, content: [{ type: 'text', text: 'built' }] } : null; },
    async deliverConversationEvent(input) { delivered.push({ requestId: input.requestId, payload: input.payload }); },
  });
  resume = () => harness.resume();
  try {
    await root.submit({ type: 'input', content: 'Build in the background.' }, BACKGROUND_CONTEXT);
    await harness.waitForIdle(withAbortSignal(AbortSignal.timeout(3000), BACKGROUND_CONTEXT));
    for (let waited = 0; delivered.length === 0 && waited < 3000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
    await harness.waitForIdle(withAbortSignal(AbortSignal.timeout(3000), BACKGROUND_CONTEXT));
    expect(delivered).toHaveLength(1);
    const observation = RuntimeJobObservationSchema.parse(delivered[0]!.payload);
    expect(observation.status === 'terminal' && observation.result.status).toBe('completed');
    const jobs = Object.values((await harness.snapshot(DurableJobsDoc, root.id, BACKGROUND_CONTEXT))?.records ?? {});
    expect(jobs.map(job => [job.observation.status, job.delivered])).toEqual([['terminal', true]]);
  } finally { resume = () => {}; await harness.close(BACKGROUND_CONTEXT); }
}, 5000);

test('finished background commands are kept to the most recent while running and undelivered ones stay', async () => {
  const seed = defineTool({
    name: 'seed-jobs', description: 'Store earlier background commands.', parameters: Type.Object({}), replay: 'safe',
    async execute(_input, api, context) {
      await api.commit(async tx => {
        const doc = await tx.doc(DurableJobsDoc, api.conversationId);
        const store = (key: string, index: number, settled: boolean, delivered: boolean) => {
          const job = { projectId: 'project', workspaceId: 'workspace', jobId: `job:${key}`, taskId: key, conversationId: String(api.conversationId), requestId: `task:${key}` };
          const acceptance = RuntimeJobAcceptanceSchema.parse({ status: 'accepted', acceptedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), job });
          const observation = settled ? RuntimeJobObservationSchema.parse({ status: 'terminal', job, result: { status: 'completed', requestId: key, attemptId: key, content: [{ type: 'text', text: 'x'.repeat(1000) }] }, completedAt: new Date(Date.UTC(2026, 0, 1, 1, index)).toISOString() }) : acceptance;
          doc.records[key] = { acceptance, observation, args: { command: 'true', background: true }, fingerprint: key, spawningTask: api.taskId, deadlineAt: new Date(Date.now() + 10000).toISOString(), attemptId: key, cancelRequested: false, delivered };
        };
        store('running', 0, false, false);
        store('undelivered', 1, true, false);
        for (let index = 0; index < 100; index++) store(`finished-${index}`, index, true, true);
      }, context);
      return { output: [{ type: 'text', text: 'Seeded.' }] };
    },
  });
  let finished: string | null = null;
  const { harness, root } = await registered([[call('seed-jobs', {})], [call('bash', { command: 'make build', background: true }, 'start')]], completed, {
    ...operations,
    wakeAt: async () => {},
    async execute(input) { finished = input.attemptId; return { status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text: 'built' }] }; },
    async reconcile(attemptId) { return finished === attemptId ? { status: 'completed', requestId: attemptId, attemptId, content: [{ type: 'text', text: 'built' }] } : null; },
    async deliverConversationEvent() {},
  }, [seed]);
  try {
    await root.submit({ type: 'input', content: 'Build in the background.' }, BACKGROUND_CONTEXT);
    await harness.waitForIdle(withAbortSignal(AbortSignal.timeout(3000), BACKGROUND_CONTEXT));
    const records = Object.entries((await harness.snapshot(DurableJobsDoc, root.id, BACKGROUND_CONTEXT))?.records ?? {});
    const started = records.find(([key]) => !['running', 'undelivered'].includes(key) && !key.startsWith('finished-'));
    expect(started?.[1]).toMatchObject({ observation: { status: 'terminal' }, delivered: true });
    // The 32 most recently finished stay beside the new command, which finished after the others were pruned.
    expect(records.map(([key]) => key).filter(key => key !== started?.[0]).sort()).toEqual(['running', 'undelivered', ...Array.from({ length: 32 }, (_, index) => `finished-${68 + index}`)].sort());
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}, 5000);

test('bash logs exposes executor failures as tool errors rather than successful text', async () => {
  const logs = call('bash', {}, 'failed-logs');
  const seed = defineTool({
    name: 'accept-command', description: 'Admit a command fixture.', parameters: Type.Object({}), replay: 'safe',
    async execute(_input, api, context) {
      const acceptance = RuntimeJobAcceptanceSchema.parse({ status: 'accepted', acceptedAt: new Date().toISOString(), job: { projectId: 'project', workspaceId: 'workspace', jobId: 'log-command', taskId: String(api.taskId), conversationId: String(api.conversationId), requestId: 'log-command' } });
      await api.commit(async tx => {
        (await tx.doc(DurableJobsDoc, api.conversationId)).records.command = { acceptance, observation: acceptance, args: { command: 'true', background: true }, fingerprint: 'accepted', spawningTask: api.taskId, deadlineAt: new Date(Date.now() + 10000).toISOString(), attemptId: 'log-command', cancelRequested: false, delivered: false };
      }, context);
      logs.arguments = { op: 'logs', job: acceptance.job };
      return { output: [{ type: 'text', text: 'Accepted.' }] };
    },
  });
  const { harness, root } = await registered([[call('accept-command', {})], [logs]], completed, {
    ...operations,
    async controlJob(input) { return { status: 'failed', requestId: 'failed-logs', attemptId: input.attemptId, content: [], error: { code: 'unavailable', message: 'Command output is unavailable' } }; },
  }, [seed]);
  try {
    await root.submit({ type: 'input', content: 'Read the command output.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(withAbortSignal(AbortSignal.timeout(2000), BACKGROUND_CONTEXT));
    const result = (await root.context(BACKGROUND_CONTEXT)).messages.find(message => message.role === 'toolResult' && message.toolCallId === 'failed-logs');
    expect(result?.role === 'toolResult' && result.isError).toBe(true);
    expect(JSON.stringify(result?.content)).toContain('Command output is unavailable');
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}, 4000);

test('codemode children own durable attempts', async () => {
  const invoked: Array<Parameters<ToolServices['invoke']>[0]> = [];
  const fixture = await registered([[call('codemode', { code: 'composed' })]], async input => {
    invoked.push(input);
    if (input.tool !== 'codemode') return completed(input);
    if (!input.codemodeTools) throw new Error('Missing durable codemode tool authority');
    const signal = AbortSignal.timeout(2000);
    await input.codemodeTools({ tool: 'read', args: { path: 'before.txt' }, callId: 'nested-read', signal });
    await input.codemodeTools({ tool: 'write', args: { path: 'allowed.txt', content: 'allowed' }, callId: 'nested-write', signal });
    await expect(input.codemodeTools({ tool: 'codemode', args: { code: 'return 1' }, callId: 'nested-isolate', signal })).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('Nested codemode') });
    return completed(input);
  });
  try {
    await fixture.root.submit({ type: 'input', content: 'Compose tools.' }, BACKGROUND_CONTEXT);
    await fixture.root.waitForIdle(withAbortSignal(AbortSignal.timeout(3000), BACKGROUND_CONTEXT));
    expect(invoked.map(input => input.tool)).toEqual(['codemode', 'read', 'write']);
    expect(new Set(invoked.map(input => input.attemptId)).size).toBe(3);
    const rawResults = (await fixture.root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.flatMap(entry => entry.model ?? []).filter(message => message.role === 'toolResult');
    const results = (await fixture.root.context(BACKGROUND_CONTEXT)).messages.filter(message => message.role === 'toolResult');
    expect(results.some(result => result.toolCallId.startsWith('nested-'))).toBe(false);
    const parentResult = results.find(result => result.toolCallId === 'codemode');
    expect(parentResult?.isError, JSON.stringify(parentResult)).not.toBe(true);
  } finally { await fixture.harness.close(BACKGROUND_CONTEXT); }
}, 5000);

test('codemode authority distinguishes definitive denied reads from interrupted child effects', async () => {
  let effects = 0;
  const outcomes: unknown[] = [];
  const fixture = await registered([[call('codemode', { code: 'outcome-proof' })]], async input => {
    if (input.tool === 'write') { effects++; return completed(input); }
    if (input.tool === 'read') return { requestId: input.requestId, attemptId: input.attemptId, status: 'interrupted', content: [{ type: 'text', text: 'Unknown executor outcome' }] };
    if (!input.codemodeTools) throw new Error('Missing codemode authority');
    for (const [tool, args, callId] of [['write', { path: 'effect', content: 'once' }, 'effect'], ['ungranted-read', {}, 'denied'], ['read', { path: 'unknown' }, 'unknown']] as const) {
      outcomes.push(await input.codemodeTools({ tool, args, callId, signal: AbortSignal.timeout(2000) }).catch(error => ({ thrown: String(error) })));
    }
    return completed(input);
  });
  try {
    await fixture.root.submit({ type: 'input', content: 'Distinguish child outcomes.' }, BACKGROUND_CONTEXT);
    await fixture.root.waitForIdle(withAbortSignal(AbortSignal.timeout(3000), BACKGROUND_CONTEXT));
    expect(effects).toBe(1);
    expect(outcomes).toMatchObject([{ status: 'completed' }, { status: 'failed' }, { status: 'interrupted' }]);
  } finally { await fixture.harness.close(BACKGROUND_CONTEXT); }
}, 5000);

test('a round that writes runs its calls in the order the model wrote them, so a read sees the write', async () => {
  const order: string[] = [];
  const { harness, root } = await registered([[call('write', { path: 'a.ts', content: 'a' }, 'write'), call('read', { path: 'a.ts' }, 'read')]], async input => {
    order.push(`start ${input.tool}`);
    if (input.tool === 'write') await new Promise(resolve => setTimeout(resolve, 50));
    order.push(`end ${input.tool}`);
    return completed(input);
  });
  try {
    await root.submit({ type: 'input', content: 'Write a file, then read it.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(withAbortSignal(AbortSignal.timeout(3000), BACKGROUND_CONTEXT));
    expect(order).toEqual(['start write', 'end write', 'start read', 'end read']);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}, 5000);

test('a rejected tool call names only the problems of the method it asked for, or the methods it can ask for', () => {
  const reject = (input: unknown) => { try { parseToolArguments('space_workspace', RuntimeWorkspaceArgumentsSchema, input); } catch (error) { return error instanceof Error ? error.message : String(error); } throw new Error('accepted'); };
  // The live call: create without branch or sourceRef, plus a key create does not take.
  const create = reject({ method: 'create', name: 'notice-probe', sourceKind: 'base', bogus: true });
  expect(create).toContain('Invalid space_workspace method create arguments');
  expect(create).toMatch(/branch: /);
  expect(create).toMatch(/sourceRef: /);
  expect(create).toContain('bogus');
  expect(create).not.toMatch(/"get"|workspaceId|instruction/);
  expect(reject({ method: 'launch' })).toMatch(/method: unknown value, expected one of .*status, progress, start, create, open/);
  expect(reject({ name: 'x' })).toMatch(/method: required, one of .*start, create, open, restore, setRelations, links, link, unlink$/);
  expect(parseToolArguments('space_workspace', RuntimeWorkspaceArgumentsSchema, { method: 'status' })).toEqual({ method: 'status' });
});

/** `count` numbered lines of 30 bytes each. */
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${String(index + 1).padStart(6, '0')}: ${'x'.repeat(15)}\n`).join('');
/** The result the model saw for call `id`. */
function resultOf(messages: readonly Message[], id: string): ToolResultMessage {
  const result = messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
  if (result?.role !== 'toolResult') throw new Error(`No result for ${id}`);
  return result;
}

test('an output longer than the transcript keeps is kept whole; the model sees its head, ending in where the rest is', async () => {
  const output = numbered(5000);
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  const { harness, root } = await registered([[call('bash', { command: 'seq 5000' }, 'long-output')]], async input => ({ status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text: output }, image] }), operations, [], { ...model, input: ['text', 'image'] });
  try {
    await root.submit({ type: 'input', content: 'Print every line.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(withAbortSignal(AbortSignal.timeout(3000), BACKGROUND_CONTEXT));
    const result = resultOf((await root.context(BACKGROUND_CONTEXT)).messages, 'long-output');
    const reference = keptReference({ conversationId: String(root.id), callId: 'long-output' });
    expect(kept.get(reference)).toBe(output);
    expect(RuntimeFullOutputDetailsSchema.parse(result.details).fullOutput).toEqual({ reference, bytes: output.length, lines: 5000, keptBytes: output.length });
    expect(result.content.filter(item => item.type === 'image')).toEqual([{ ...image, data: `stored:${image.data}` }]);
    const shown = result.content.flatMap(item => item.type === 'text' ? [item.text] : []);
    expect(shown).toHaveLength(1);
    const lines = shown[0]!.split('\n');
    const note = lines.pop() ?? '';
    // Whole lines from the first, then the note: the harness kept all of it, the reference included.
    expect(lines).toEqual(output.split('\n').slice(0, lines.length));
    expect(lines.length).toBeGreaterThan(1000);
    expect(note).toContain(reference);
    expect(note).toContain(`offset ${lines.length + 1} reads on`);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}, 5000);

test('a codemode child gets the whole output the transcript cut, and one past 25 MB fails naming the part kept', async () => {
  const whole = numbered(5000);
  const huge = numbered(Math.ceil((TOOL_RESULT_MAX_BYTES + 1024 * 1024) / 30));
  const outcomes: unknown[] = [];
  const { harness, root } = await registered([[call('codemode', { code: 'filter' })]], async input => {
    if (input.tool === 'read') return { status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text: input.requestId === 'whole' ? whole : huge }] };
    if (!input.codemodeTools) throw new Error('Missing codemode authority');
    for (const callId of ['whole', 'huge']) outcomes.push(await input.codemodeTools({ tool: 'read', args: { path: `${callId}.txt` }, callId, signal: AbortSignal.timeout(5000) }));
    return completed(input);
  });
  try {
    await root.submit({ type: 'input', content: 'Filter the output.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(withAbortSignal(AbortSignal.timeout(10_000), BACKGROUND_CONTEXT));
    const hugeReference = keptReference({ conversationId: String(root.id), callId: 'huge' });
    expect(outcomes).toEqual([{ status: 'completed', value: [{ type: 'text', text: whole }] }, { status: 'failed', error: expect.stringContaining(hugeReference) }]);
    // Past the cap the first 25 MB is kept, in whole lines.
    const keptHuge = kept.get(hugeReference) ?? '';
    expect(keptHuge.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(keptHuge.length).toBeGreaterThan(TOOL_RESULT_MAX_BYTES - 30);
    expect(huge.startsWith(keptHuge)).toBe(true);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}, 15_000);

test('a background command\'s long logs are kept whole like any other output', async () => {
  const logs = call('bash', {}, 'long-logs');
  const output = numbered(4000);
  const seed = defineTool({
    name: 'accept-command', description: 'Admit a command fixture.', parameters: Type.Object({}), replay: 'safe',
    async execute(_input, api, context) {
      const acceptance = RuntimeJobAcceptanceSchema.parse({ status: 'accepted', acceptedAt: new Date().toISOString(), job: { projectId: 'project', workspaceId: 'workspace', jobId: 'log-command', taskId: String(api.taskId), conversationId: String(api.conversationId), requestId: 'log-command' } });
      await api.commit(async tx => {
        (await tx.doc(DurableJobsDoc, api.conversationId)).records.command = { acceptance, observation: acceptance, args: { command: 'true', background: true }, fingerprint: 'accepted', spawningTask: api.taskId, deadlineAt: new Date(Date.now() + 10000).toISOString(), attemptId: 'log-command', cancelRequested: false, delivered: false };
      }, context);
      logs.arguments = { op: 'logs', job: acceptance.job };
      return { output: [{ type: 'text', text: 'Accepted.' }] };
    },
  });
  const { harness, root } = await registered([[call('accept-command', {})], [logs]], completed, {
    ...operations,
    async controlJob(input) { return { status: 'completed', requestId: 'long-logs', attemptId: input.attemptId, content: [{ type: 'text', text: output }] }; },
  }, [seed]);
  try {
    await root.submit({ type: 'input', content: 'Read the command output.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(withAbortSignal(AbortSignal.timeout(3000), BACKGROUND_CONTEXT));
    const reference = keptReference({ conversationId: String(root.id), callId: 'long-logs' });
    expect(kept.get(reference)).toContain(JSON.stringify(output));
    expect(JSON.stringify(resultOf((await root.context(BACKGROUND_CONTEXT)).messages, 'long-logs').content)).toContain(reference);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}, 4000);

test('one line of JSON past the cap is kept and shown indented, so lines page it, and codemode parses the same value', async () => {
  const value = { file: 'figma', comments: Array.from({ length: 2000 }, (_, index) => ({ id: `comment-${index}`, author: { name: `Person ${index}`, handle: `person-${index}` }, message: 'detail '.repeat(5) })) };
  const line = JSON.stringify(value);
  const outcomes: unknown[] = [];
  const { harness, root } = await registered([[call('mcp_invoke', { connectionId: 'figma', name: 'list_comments', arguments: {} }, 'comments')], [call('codemode', { code: 'parse' })]], async input => {
    if (input.tool === 'mcp_invoke') return { status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text: line }] };
    if (!input.codemodeTools) throw new Error('Missing codemode authority');
    outcomes.push(await input.codemodeTools({ tool: 'mcp_invoke', args: { connectionId: 'figma', name: 'list_comments', arguments: {} }, callId: 'child-comments', signal: AbortSignal.timeout(5000) }));
    return completed(input);
  });
  try {
    await root.submit({ type: 'input', content: 'List the comments.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(withAbortSignal(AbortSignal.timeout(5000), BACKGROUND_CONTEXT));
    expect(line.length).toBeGreaterThan(2 * 50 * 1024);
    expect(kept.get(keptReference({ conversationId: String(root.id), callId: 'comments' }))).toBe(JSON.stringify(value, null, 2));
    const shown = resultOf((await root.context(BACKGROUND_CONTEXT)).messages, 'comments').content.flatMap(item => item.type === 'text' ? [item.text] : [])[0] ?? '';
    expect(shown.split('\n').slice(0, 9)).toEqual(['{', '  "file": "figma",', '  "comments": [', '    {', '      "id": "comment-0",', '      "author": {', '        "name": "Person 0",', '        "handle": "person-0"', '      },']);
    const [outcome] = z.tuple([z.object({ status: z.literal('completed'), value: z.tuple([z.object({ type: z.literal('text'), text: z.string() })]) })]).parse(outcomes);
    expect(JSON.parse(outcome.value[0].text)).toEqual(value);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}, 5000);
