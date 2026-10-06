import { expect, test } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Models, type Model, type Api } from '@earendil-works/pi-ai';
import { RuntimeBrowserArgumentsSchema, RuntimeBrowserApprovalCardSchema, type RuntimeBrowserApprovalCard } from '@gitspace/protocol-runtime';
import { QuestionsDoc, WorkspaceDoc } from './documents.js';
import { SessionControlsDoc } from './session-controls.js';
import { createRuntimeTools, type ToolServices } from './tools.js';
import type { JobServices } from './jobs.js';

const model: Model<Api> = { id: 'browser-proof', name: 'Browser proof', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const unused = async (): Promise<never> => { throw new Error('Unexpected non-browser operation'); };
for (const approvalMode of ['write', 'always-ask'] as const) test(`registered browser group cannot invoke after Reject in ${approvalMode} mode`, async () => {
  let rejected = false, preparations = 0, invocations = 0, generations = 0;
  const afterRejection: string[] = [];
  const services: ToolServices = {
    async prepareBrowser(input) {
      preparations++; if (rejected) afterRejection.push('prepare');
      return RuntimeBrowserApprovalCardSchema.parse({ id: 'preparation', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'attachment', generation: 1, groupId: '00000000-0000-4000-8000-000000000001', groupName: 'Workspace', origins: ['example.com'], source: 'relay', expiresAt: new Date(Date.now() + 60000).toISOString(), action: 'open', requiresApproval: true });
    },
    async invoke() { invocations++; if (rejected) afterRejection.push('invoke'); throw new Error('Browser effect must never run after rejection'); },
    question: unused, instructions: async () => '', authorizeCronTool: unused,
  };
  const operations: JobServices = { execute: unused, reconcile: unused, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, wakeAt: unused, admitInference: unused };
  const tools = createRuntimeTools(services, operations);
  const registry = createRegistry(); registry.install(defineExtension({ name: 'registered-browser-proof', tools }));
  const models: Models = { ...createModels(), getModel: () => model, streamSimple() {
    generations++;
    const reply: AssistantMessage = { role: 'assistant', content: generations === 1 ? [{ type: 'toolCall', id: 'browser-call', name: 'browser', arguments: { action: 'open', source: 'relay', url: 'https://example.com/' } }] : [{ type: 'text', text: 'Rejected; no browser operation performed.' }], api: model.api, provider: model.provider, model: model.id, stopReason: generations === 1 ? 'toolUse' : 'stop', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: reply.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: reply }); stream.end(reply); return stream;
  } };
  const harness = await Harness.open(new MemoryStorage(), { registry, models, settings: { compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id }, tools } });
    await harness.commit(async tx => { (await tx.doc(WorkspaceDoc)).phase = 'code'; (await tx.doc(SessionControlsDoc, root.id)).approvalMode = approvalMode; }, BACKGROUND_CONTEXT);
    await root.submit({ type: 'input', content: 'Open the browser tab.' }, BACKGROUND_CONTEXT);
    const deadline = performance.now() + 5000;
    while (!(await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items.some(question => question.browser && question.answer === null)) {
      if (performance.now() >= deadline) throw new Error('Registered browser tool did not request durable approval');
      const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, 5); await tick.promise;
    }
    expect(invocations).toBe(0);
    rejected = true;
    await harness.commit(async tx => { const questions = await tx.doc(QuestionsDoc); const question = questions.items.find(item => item.browser && item.answer === null); if (!question) throw new Error('Pending browser approval missing'); question.answer = false; }, BACKGROUND_CONTEXT);
    await root.waitForIdle(BACKGROUND_CONTEXT);
    expect(preparations).toBe(1);
    expect(invocations).toBe(0);
    expect(afterRejection).toEqual([]);
    expect(JSON.stringify((await root.context(BACKGROUND_CONTEXT)).messages)).toContain('not approved');
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});

const groupId = '00000000-0000-4000-8000-000000000001';
const automaticCases = [
  { name: 'default headless in write', approvalMode: 'write', args: { action: 'open', url: 'https://example.com/' } },
  { name: 'default headless in always-ask', approvalMode: 'always-ask', args: { action: 'open', url: 'https://example.com/' } },
  { name: 'default headless in yolo', approvalMode: 'yolo', args: { action: 'open', url: 'https://example.com/' } },
  { name: 'relay group creation in yolo', approvalMode: 'yolo', args: { action: 'open', source: 'relay', url: 'https://example.com/' } },
  { name: 'relay evaluation in always-ask', approvalMode: 'always-ask', args: { action: 'evaluate', source: 'relay', targetId: 'target', expression: 'document.title' } },
] as const;

for (const { name, args, approvalMode } of automaticCases) test(`${name} does not create per-call approval questions`, async () => {
  let generations = 0;
  const preparations: RuntimeBrowserApprovalCard[] = [];
  const dispatched: Array<Parameters<ToolServices['invoke']>[0]> = [];
  const services: ToolServices = {
    async prepareBrowser(input) {
      const parsed = RuntimeBrowserArgumentsSchema.parse(input.args);
      const card = RuntimeBrowserApprovalCardSchema.parse({
        id: `preparation:${input.attemptId}`, projectId: 'project', workspaceId: 'workspace',
        machineId: 'machine', attachmentId: 'attachment', generation: 1,
        groupId, groupName: 'Workspace', origins: parsed.source === 'relay' ? ['example.com'] : [], source: parsed.source,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), action: parsed.action, requiresApproval: parsed.source === 'relay' && parsed.action === 'open',
      });
      preparations.push(card);
      return card;
    },
    async invoke(input) {
      expect(input.args).toEqual(RuntimeBrowserArgumentsSchema.parse(args));
      dispatched.push(input);
      return { status: 'completed', requestId: input.requestId, attemptId: input.attemptId, content: [{ type: 'text', text: 'Browser action completed.' }] };
    },
    question: unused, instructions: async () => '', authorizeCronTool: unused,
  };
  const operations: JobServices = { execute: unused, reconcile: unused, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, wakeAt: unused, admitInference: unused };
  const tools = createRuntimeTools(services, operations);
  const registry = createRegistry(); registry.install(defineExtension({ name: 'automatic-browser-proof', tools }));
  const models: Models = { ...createModels(), getModel: () => model, streamSimple() {
    generations++;
    const reply: AssistantMessage = { role: 'assistant', content: generations === 1 ? [{ type: 'toolCall', id: 'browser-call', name: 'browser', arguments: args }] : [{ type: 'text', text: 'Completed.' }], api: model.api, provider: model.provider, model: model.id, stopReason: generations === 1 ? 'toolUse' : 'stop', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: reply.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: reply }); stream.end(reply); return stream;
  } };
  const harness = await Harness.open(new MemoryStorage(), { registry, models, settings: { compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id }, tools } });
    await harness.commit(async tx => { (await tx.doc(WorkspaceDoc)).phase = 'code'; (await tx.doc(SessionControlsDoc, root.id)).approvalMode = approvalMode; }, BACKGROUND_CONTEXT);
    await root.submit({ type: 'input', content: 'Perform the browser action.' }, BACKGROUND_CONTEXT);
    const deadline = performance.now() + 5000;
    while (dispatched.length === 0) {
      const questions = await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT);
      expect(questions?.items.filter(question => question.answer === null) ?? []).toEqual([]);
      if (performance.now() >= deadline) throw new Error('Yolo browser action did not dispatch');
      const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, 5); await tick.promise;
    }
    await root.waitForIdle(BACKGROUND_CONTEXT);
    expect(preparations).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
    expect((await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items ?? []).toEqual([]);
    expect(JSON.stringify((await root.context(BACKGROUND_CONTEXT)).messages)).toContain('Browser action completed.');
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
