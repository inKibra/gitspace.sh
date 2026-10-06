import { expect, test } from 'vitest';
import { z } from 'zod';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Models, type Model, type Api, type ToolCall } from '@earendil-works/pi-ai';
import { RuntimeBrowserApprovalCardSchema } from '@gitspace/protocol-runtime';
import { QuestionsDoc, TodosDoc, WorkspaceDoc, PlanDoc } from './documents.js';
import { SessionControlsDoc } from './session-controls.js';
import { createRuntimeTools, type ToolServices } from './tools.js';
import { DurableJobsDoc, type JobServices } from './jobs.js';

const model: Model<Api> = { id: 'tool-contract', name: 'Tool contract', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const unused = async (): Promise<never> => { throw new Error('Unexpected operation'); };
const operations: JobServices = { execute: unused, reconcile: unused, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, wakeAt: unused, admitInference: unused };
const completed: ToolServices['invoke'] = async input => ({ status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text: `Executed ${input.tool}` }] });
const services: ToolServices = {
  invoke: completed,
  async prepareBrowser() { return RuntimeBrowserApprovalCardSchema.parse({ id: 'browser', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'attachment', generation: 1, groupId: '00000000-0000-4000-8000-000000000001', groupName: 'Workspace', origins: [], source: 'headless', expiresAt: new Date(Date.now() + 60000).toISOString(), action: 'tabs', requiresApproval: false }); },
  question: async () => 'answered', instructions: async () => '', authorizeCronTool: unused,
};
const samples: Record<string, ToolCall['arguments']> = {
  read: { path: 'src/main.ts', offset: 1, limit: 10 }, write: { path: 'src/main.ts', content: 'new content' },
  edit: { path: 'src/main.ts', edits: [{ oldText: 'old', newText: 'new' }] }, apply_patch: { patch: '*** Begin Patch\n*** Add File: new.ts\n+export {};\n*** End Patch' },
  bash: { command: 'pwd' }, grep: { pattern: 'needle', path: 'src' }, find: { pattern: '*.ts', path: 'src' }, codemode: { code: 'return 1;' },
  agents: { op: 'list' }, jobs: { op: 'list' }, proc: { op: 'list' }, machines: { op: 'list' }, environment: { method: 'get' },
  space_goal: { method: 'get' }, space_phase: { phase: 'code' }, space_workspace: { method: 'current' }, space_artifacts: { method: 'list' },
  space_workflow: { method: 'get' }, space_rubric: { method: 'get' }, space_journal: { method: 'list' }, space_guide: { method: 'get' }, space_review: { method: 'list' },
  web_search: { query: 'TypeScript documentation' }, generate_image: { prompt: 'A blue square' }, ast_grep: { pattern: 'foo($A)', path: 'src', language: 'typescript' },
  ast_edit: { ops: [{ pat: 'foo($A)', out: 'bar($A)' }], paths: ['src/main.ts'], language: 'typescript' }, ast_resolve: { proposalId: 'proposal', action: 'reject' },
  history_search: { query: 'decision' }, history_read: { conversationId: 'conversation' }, report_issue: { message: 'Observed concrete failure' },
  checkpoint: { goal: 'Inspect implementation' }, rewind: { checkpoint: 'checkpoint', report: 'Findings' }, delegate_export: { commit: 'a'.repeat(40) },
  mcp_discover: {}, mcp_invoke: { connectionId: 'connection', name: 'lookup', arguments: { query: 'hello' } }, browser: { action: 'tabs' },
  todo: { items: [{ id: 'proof', text: 'Exercise registrations', status: 'completed' }] }, ask: { prompt: 'Choose a path', choices: ['A', 'B'] }, propose_plan: { prompt: 'Implement the selected plan', choices: ['Approve', 'Reject'] },
};
async function registered(rounds: ToolCall[][], invoke: ToolServices['invoke'] = completed, jobServices: JobServices = operations) {
  const tools = createRuntimeTools({ ...services, invoke }, jobServices);
  const registry = createRegistry(); registry.install(defineExtension({ name: 'registration-proof', tools }));
  let generation = 0;
  const models: Models = { ...createModels(), getModel: () => model, streamSimple() {
    const calls = rounds[generation++];
    const reply: AssistantMessage = { role: 'assistant', content: calls ?? [{ type: 'text', text: 'Complete.' }], api: model.api, provider: model.provider, model: model.id, stopReason: calls ? 'toolUse' : 'stop', timestamp: generation, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: calls ? 'toolUse' : 'stop', message: reply }); stream.end(reply); return stream;
  } };
  const harness = await Harness.open(new MemoryStorage(), { registry, models, settings: { toolExecution: 'parallel', compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id }, tools } });
  await harness.commit(async tx => { (await tx.doc(WorkspaceDoc)).phase = 'code'; (await tx.doc(SessionControlsDoc, root.id)).approvalMode = 'yolo'; }, BACKGROUND_CONTEXT);
  return { harness, root, tools };
}
const call = (name: string, args: ToolCall['arguments'], id = name): ToolCall => ({ type: 'toolCall', name, arguments: args, id });

test('every registered tool advertises its real object contract and executes through the Harness registration path', async () => {
  const routed: string[] = [];
  const fixture = await registered([Object.entries(samples).map(([name, args]) => call(name, args))], async input => { routed.push(input.tool); return completed(input); });
  const { harness, root, tools } = fixture;
  try {
    expect(tools.map(tool => tool.name).sort()).toEqual(Object.keys(samples).sort());
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(25);
      expect(tool.description).not.toMatch(/^GitSpace \w+; executes through/u);
      const schema = z.object({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()).optional(), anyOf: z.array(z.unknown()).optional(), oneOf: z.array(z.unknown()).optional(), allOf: z.array(z.unknown()).optional() }).parse(tool.parameters);
      expect(Boolean(schema.properties || schema.anyOf || schema.oneOf || schema.allOf)).toBe(true);
      expect(schema.properties?.args).not.toEqual({});
    }
    await root.submit({ type: 'input', content: 'Exercise all registered contracts.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(BACKGROUND_CONTEXT);
    const results = (await root.context(BACKGROUND_CONTEXT)).messages.filter(message => message.role === 'toolResult');
    expect(results.map(result => result.toolCallId).sort()).toEqual(Object.keys(samples).sort());
    expect(results.filter(result => result.isError)).toEqual([]);
    expect(routed.sort()).toEqual(Object.keys(samples).filter(name => !['jobs', 'todo', 'ask', 'propose_plan'].includes(name)).sort());
    expect((await harness.snapshot(TodosDoc, root.id, BACKGROUND_CONTEXT))?.items).toEqual(samples.todo?.items);
    expect((await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items.map(question => question.kind).sort()).toEqual(['approval', 'ask']);
    expect((await harness.snapshot(PlanDoc, root.id, BACKGROUND_CONTEXT))?.status).toBe('proposed');
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});

test('registration rejects missing required fields and invalid nested edits without dispatching', async () => {
  const routed: string[] = [];
  const { harness, root } = await registered([[call('read', {}), call('edit', { path: 'file', edits: [{ oldText: '', newText: 'value' }] }), call('mcp_invoke', { connectionId: 'connection' })]], async input => { routed.push(input.tool); return completed(input); });
  try {
    await root.submit({ type: 'input', content: 'Exercise invalid arguments.' }, BACKGROUND_CONTEXT); await root.waitForIdle(BACKGROUND_CONTEXT);
    const results = (await root.context(BACKGROUND_CONTEXT)).messages.filter(message => message.role === 'toolResult');
    expect(results.map(result => result.toolCallId).sort()).toEqual(['edit', 'mcp_invoke', 'read']);
    expect(results.every(result => result.isError)).toBe(true);
    expect(routed).toEqual([]);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});

test('registered mutations serialize across multi-tool rounds and failure while safe reads run concurrently', async () => {
  const started = Promise.withResolvers<void>(), readsFinished = Promise.withResolvers<void>();
  let active = 0, maximum = 0, reads = 0, calls = 0;
  const effects: string[] = [];
  const { harness, root } = await registered([
    [call('write', { path: 'first', content: 'one' }, 'first'), call('write', { path: 'second', content: 'two' }, 'second'), call('read', { path: 'read-a' }, 'read-a'), call('read', { path: 'read-b' }, 'read-b')],
    [call('write', { path: 'third', content: 'three' }, 'third')],
  ], async input => {
    if (input.tool === 'read') {
      await started.promise;
      expect(active).toBe(1);
      reads++;
      if (reads === 2) readsFinished.resolve();
      await readsFinished.promise;
      return completed(input);
    }
    active++; maximum = Math.max(maximum, active); calls++; effects.push(input.requestId);
    try {
      if (calls === 1) { started.resolve(); await readsFinished.promise; throw new Error('First mutation failed'); }
      return completed(input);
    } finally { active--; }
  });
  try {
    await root.submit({ type: 'input', content: 'Exercise parallel reads and serialized writes.' }, BACKGROUND_CONTEXT); await root.waitForIdle(BACKGROUND_CONTEXT);
    expect(maximum).toBe(1); expect(reads).toBe(2); expect(calls).toBe(3);
    expect(new Set(effects)).toEqual(new Set(['first', 'second', 'third']));
    expect(effects.at(-1)).toBe('third');
    const results = (await root.context(BACKGROUND_CONTEXT)).messages.filter(message => message.role === 'toolResult');
    expect(results.filter(result => result.isError)).toHaveLength(1);
    expect(results.find(result => result.toolCallId === 'third')?.isError).toBe(false);
  } finally { started.resolve(); readsFinished.resolve(); await harness.close(BACKGROUND_CONTEXT); }
});

test('machine selectors survive real bash and proc registrations and invalid selectors never dispatch', async () => {
  const routed: Array<Parameters<ToolServices['invoke']>[0]> = [];
  const bash = { command: 'pwd', on: 'machine-chosen', at: 'commit-selected' };
  const proc = { op: 'list', on: { needs: ['linux'], prefer: 'idle' }, at: 'branch-selected' };
  const { harness, root } = await registered([[
    call('bash', bash, 'selected-bash'), call('proc', proc, 'selected-proc'),
    call('bash', { command: 'pwd', on: '' }, 'invalid-bash'),
    call('proc', { op: 'list', on: { prefer: 'busy' } }, 'invalid-proc'),
    call('bash', { command: 'pwd', at: 42 }, 'invalid-source'),
  ]], async input => { routed.push(input); return completed(input); });
  try {
    await root.submit({ type: 'input', content: 'Select machines explicitly.' }, BACKGROUND_CONTEXT);
    await root.waitForIdle(BACKGROUND_CONTEXT);
    expect(routed.find(input => input.requestId === 'selected-bash')?.args).toEqual(bash);
    expect(routed.find(input => input.requestId === 'selected-proc')?.args).toEqual(proc);
    expect(routed.map(input => input.requestId).sort()).toEqual(['selected-bash', 'selected-proc']);
    const results = (await root.context(BACKGROUND_CONTEXT)).messages.filter(message => message.role === 'toolResult');
    expect(results.filter(result => result.isError).map(result => result.toolCallId).sort()).toEqual(['invalid-bash', 'invalid-proc', 'invalid-source']);
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
    { method: 'runChecks', runId: 'checks', rerun: true, deadlineAt: '2030-01-01T00:00:00.000Z', on: 'machine', at: 'source' },
    { method: 'runPhase', runId: 'prepare', phase: 'machine/prepare', rerun: true, deadlineAt: '2030-01-01T00:00:00.000Z', on: { needs: ['linux'], prefer: 'idle' }, at: 'source' },
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
  const environment = createRuntimeTools(services, operations).find(tool => tool.name === 'environment');
  if (!environment) throw new Error('Missing environment registration');
  const advertised = JSON.stringify(environment.parameters);
  expect(advertised).not.toContain('"interactive"');
  expect(advertised).not.toContain('"cloud/destroy"');
});

test('jobs reject unavailable execution before returning acceptance or creating durable work', async () => {
  let executions = 0;
  const { harness, root } = await registered([[call('jobs', { op: 'run', application: 'sh', args: ['-c', 'pwd'] })]], completed, {
    ...operations,
    jobScope: async () => { throw new Error('No machine attached: attach a ready workspace replica.'); },
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
