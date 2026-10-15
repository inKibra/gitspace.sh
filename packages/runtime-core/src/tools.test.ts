import { expect, test } from 'vitest';
import { z } from 'zod';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { createModels, createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Models, type Model, type Api, type ToolCall } from '@earendil-works/pi-ai';
import { RuntimeBrowserApprovalCardSchema, RuntimeJobAcceptanceSchema, RuntimeJobObservationSchema } from '@gitspace/protocol-runtime';
import { QuestionsDoc, TodosDoc, WorkspaceDoc, PlanDoc } from './documents.js';
import { SessionControlsDoc } from './session-controls.js';
import { createRuntimeTools, runtimeToolParameters, type ToolServices } from './tools.js';
import { DurableJobsDoc, createJobTask, createJobTool, type JobServices } from './jobs.js';
import { RuntimeBashArgumentsSchema } from '@gitspace/protocol-runtime/tool-arguments';

const model: Model<Api> = { id: 'tool-contract', name: 'Tool contract', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const unused = async (): Promise<never> => { throw new Error('Unexpected operation'); };
const operations: JobServices = { execute: unused, reconcile: unused, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, wakeAt: unused, deliverConversationEvent: unused, observeProcess: unused, stopProcess: unused };
const completed: ToolServices['invoke'] = async input => ({ status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text: `Executed ${input.tool}` }] });
const services: ToolServices = {
  invoke: completed,
  async prepareBrowser() { return RuntimeBrowserApprovalCardSchema.parse({ id: 'browser', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'attachment', generation: 1, groupId: '00000000-0000-4000-8000-000000000001', groupName: 'Workspace', origins: [], source: 'headless', expiresAt: new Date(Date.now() + 60000).toISOString(), action: 'tabs' }); },
  question: async () => 'answered', instructions: async () => '', authorizeCronTool: unused, preflight: async () => {},
};
const samples: Record<string, ToolCall['arguments']> = {
  read: { path: 'src/main.ts', offset: 1, limit: 10 }, write: { path: 'src/main.ts', content: 'new content' },
  edit: { path: 'src/main.ts', edits: [{ oldText: 'old', newText: 'new' }] }, apply_patch: { patch: '*** Begin Patch\n*** Add File: new.ts\n+export {};\n*** End Patch' },
  bash: { command: 'pwd' }, grep: { pattern: 'needle', path: 'src' }, code_search: { pattern: 'needle', path: 'src' }, find: { pattern: '*.ts', path: 'src' }, codemode: { code: 'return 1;' },
  agents: { op: 'list' }, proc: { op: 'list' }, machines: { op: 'list' }, environment: { method: 'get' }, sync: { method: 'status' }, workspace_status: {},
  space_goal: { method: 'get' }, space_phase: { phase: 'code' }, space_workspace: { method: 'current' }, space_artifacts: { method: 'list' },
  space_workflow: { method: 'get' }, space_rubric: { method: 'get' }, space_journal: { method: 'list' }, space_guide: { method: 'get' }, space_review: { method: 'list' },
  web_search: { query: 'TypeScript documentation' }, generate_image: { prompt: 'A blue square' }, ast_grep: { pattern: 'foo($A)', path: 'src', language: 'typescript' },
  ast_edit: { ops: [{ pat: 'foo($A)', out: 'bar($A)' }], paths: ['src/main.ts'], language: 'typescript' }, ast_resolve: { proposalId: 'proposal', action: 'reject' },
  history_search: { query: 'decision' }, history_read: { conversationId: 'conversation' }, report_issue: { message: 'Observed concrete failure' },
  checkpoint: { goal: 'Inspect implementation' }, rewind: { checkpoint: 'checkpoint', report: 'Findings' }, delegate_export: { commit: 'a'.repeat(40) },
  mcp_discover: {}, mcp_invoke: { connectionId: 'connection', name: 'lookup', arguments: { query: 'hello' } }, web_browser: { action: 'tabs' },
  todo: { items: [{ id: 'proof', text: 'Exercise registrations', status: 'completed' }] }, ask: { prompt: 'Choose a path', choices: ['A', 'B'] }, propose_plan: { prompt: 'Implement the selected plan', choices: ['Approve', 'Reject'] },
};
async function registered(rounds: ToolCall[][], invoke: ToolServices['invoke'] = completed, jobServices: JobServices = operations, extraTools: ToolRegistration[] = []) {
  const tools = [...createRuntimeTools({ ...services, invoke }, jobServices, (id, context) => harness.abortTask(id, context), async () => {}), ...extraTools];
  const registry = createRegistry(); registry.install(defineExtension({ name: 'registration-proof', tools, tasks: [createJobTask(jobServices)] }));
  let generation = 0;
  const models: Models = { ...createModels(), getModel: () => model, streamSimple(_model, context) {
    const providerSchema = z.object({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()), anyOf: z.never().optional(), oneOf: z.never().optional(), allOf: z.never().optional() });
    for (const tool of getCurrentTools(context.messages)) providerSchema.parse(tool.parameters);
    const calls = rounds[generation++];
    const reply: AssistantMessage = { role: 'assistant', content: calls ?? [{ type: 'text', text: 'Complete.' }], api: model.api, provider: model.provider, model: model.id, stopReason: calls ? 'toolUse' : 'stop', timestamp: generation, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: calls ? 'toolUse' : 'stop', message: reply }); stream.end(reply); return stream;
  } };
  const harness = await Harness.open(new MemoryStorage(), { registry, models, settings: { toolExecution: 'parallel', compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id }, tools } });
  await harness.commit(async tx => { (await tx.doc(WorkspaceDoc)).phase = 'code'; }, BACKGROUND_CONTEXT);
  return { harness, root, tools };
}
const call = (name: string, args: ToolCall['arguments'], id = name): ToolCall => ({ type: 'toolCall', name, arguments: args, id });

test('every registered tool advertises its real object contract and executes through the Harness registration path', async () => {
  const routed: string[] = [];
  const fixture = await registered([Object.entries(samples).map(([name, args]) => call(name, args))], async input => { routed.push(input.tool); return completed(input); });
  const { harness, root, tools } = fixture;
  try {
    expect(tools.map(tool => tool.name).sort()).toEqual(Object.keys(samples).sort());
    await root.submit({ type: 'input', content: 'Exercise all registered contracts.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(BACKGROUND_CONTEXT);
    const results = (await root.context(BACKGROUND_CONTEXT)).messages.filter(message => message.role === 'toolResult');
    expect(results.map(result => result.toolCallId).sort()).toEqual(Object.keys(samples).sort());
    expect(results.filter(result => result.isError)).toEqual([]);
    // Models call web_browser (OpenAI reserves `browser`); dispatch keeps the signed protocol name.
    expect(routed.sort()).toEqual(Object.keys(samples).filter(name => !['todo', 'ask', 'propose_plan'].includes(name)).map(name => name === 'web_browser' ? 'browser' : name).sort());
    expect((await harness.snapshot(TodosDoc, root.id, BACKGROUND_CONTEXT))?.items).toEqual(samples.todo?.items);
    expect((await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items.map(question => question.kind).sort()).toEqual(['approval', 'ask']);
    expect((await harness.snapshot(PlanDoc, root.id, BACKGROUND_CONTEXT))?.status).toBe('proposed');
  } finally { await harness.close(BACKGROUND_CONTEXT); }
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
      }, context);
      if (mode === 'cancelled') {
        controller.abort(interrupted);
        await expect(pending).rejects.toThrow('Cancelled bounded command wait');
      } else expect(RuntimeJobObservationSchema.parse(await pending).status).toBe(mode === 'settled' ? 'not-started' : 'accepted');
      return { content: [{ type: 'text', text: mode }] };
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
      return { content: [{ type: 'text', text: 'Accepted.' }] };
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
