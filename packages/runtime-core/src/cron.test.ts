import { expect, test, vi } from 'vitest';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, GenerationTask, hook } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Models, type Model, type Api } from '@earendil-works/pi-ai';
import { bindCronGeneration, cronToolScopes, createCronRuntime } from './cron.js';
import { Type } from 'typebox';
import { createConversationLifecycle } from './conversation-lifecycle.js';
import { CronRequestsDoc } from './documents.js';

const context = BACKGROUND_CONTEXT;
const model: Model<Api> = { id: 'controlled', name: 'Controlled', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const reference = { provider: model.provider, modelId: model.id };
function reply(): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text: 'Done' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
for (const busy of [false, true]) test(`cron delivers into the existing root while ${busy ? 'busy' : 'idle'}`, async () => {
  const storage = new MemoryStorage();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const prompts: string[] = [];
  const models: Models = { ...createModels(), getModel: () => model, streamSimple(_model, input) {
    prompts.push(JSON.stringify(input));
    const stream = createAssistantMessageEventStream();
    const finish = () => { const message = reply(); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); };
    if (busy && prompts.length === 1) { entered.resolve(); void release.promise.then(finish); } else finish();
    return stream;
  } };
  const harness = await Harness.open(storage, { registry: createRegistry(), models, settings: { compaction: { enabled: false } } }, context);
  try {
    const root = await harness.root(context, { agent: { model: reference } });
    if (busy) { await root.submit({ type: 'input', content: 'User work', requestId: 'user' }, context); await entered.promise; }
    const cron = createCronRuntime({ harness, storage, admitInference: async () => reference, async configureModel(id, model) { const target = await harness.conversation(id, context); if (!target) throw new Error('Missing target'); await target.configure({ model }, context); }, async wake() { harness.resume(); } });
    const result = await cron.submit({ requestId: 'cron-1', text: 'Scheduled check', readScopes: ['src/**'], writeScopes: [] });
    expect(result.conversationId).toBe(String(root.id));
    expect((await storage.scanConversations({}, 128, undefined, context)).items.map(item => String(item.id))).toEqual([String(root.id)]);
    release.resolve();
    await root.waitForIdle(context);
    expect(prompts.at(-1)).toContain('Scheduled check');
    expect(await cron.status('cron-1')).toMatchObject({ state: 'succeeded', conversationId: String(root.id), message: null });
  } finally { release.resolve(); await harness.close(context); }
});

test('cron scopes stay on their own generation across tool rounds and retries', async () => {
  const storage = new MemoryStorage();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const observed: Array<{ turn: number; allowed: boolean }> = [];
  const prompts: string[] = [];
  const effects = defineTool({ name: 'effect', description: 'Try an out-of-scope write', parameters: Type.Object({}), async execute(_args, api, ctx) {
    const scopes = await cronToolScopes(api, ctx);
    const allowed = scopes.every(scope => scope.writeScopes.includes('outside.txt'));
    observed.push({ turn: prompts.length, allowed });
    return { isError: !allowed, content: [{ type: 'text', text: allowed ? 'written' : 'scope denied' }] };
  } });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'cron-test', tools: [effects], hooks: [hook(GenerationTask, { async beforeRequest(_input, api, ctx) { await bindCronGeneration(harness, api, ctx); } })] }));
  const models: Models = { ...createModels(), getModel: () => model, streamSimple(_model, input) {
    prompts.push(JSON.stringify(input));
    const turn = prompts.length;
    const stream = createAssistantMessageEventStream();
    const finish = () => {
      const message = reply();
      if ([1, 3, 4, 6].includes(turn)) { message.content = [{ type: 'toolCall', id: `call-${turn}`, name: 'effect', arguments: {} }]; message.stopReason = 'toolUse'; }
      stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
      stream.end(message);
    };
    if (turn === 1) { entered.resolve(); void release.promise.then(finish); } else finish();
    return stream;
  } };
  const harness = await Harness.open(storage, { registry, models, settings: { followUpMode: 'one-at-a-time', compaction: { enabled: false } } }, context);
  try {
    const root = await harness.root(context, { agent: { model: reference, tools: [effects] } });
    let admissions = 0;
    const cron = createCronRuntime({ harness, storage, async admitInference() { admissions++; return reference; }, async configureModel(id, model) { const target = await harness.conversation(id, context); if (!target) throw new Error('Missing target'); await target.configure({ model }, context); }, async wake() { harness.resume(); } });
    await root.submit({ type: 'input', content: 'Busy user work', requestId: 'user-1' }, context);
    await entered.promise;
    const input = { requestId: 'cron-scoped', text: 'Restricted cron work', readScopes: ['src/**'], writeScopes: ['src/**'] };
    await cron.submit(input);
    expect(await cron.status(input.requestId)).toMatchObject({ state: 'queued', conversationId: String(root.id), message: null });
    await root.submit({ type: 'input', content: 'Subsequent user work', requestId: 'user-2', whenBusy: 'followUp' }, context);
    expect(await cron.submit(input)).toEqual({ conversationId: String(root.id) });
    await expect(cron.submit({ ...input, writeScopes: ['**'] })).rejects.toThrow('Cron request identity changed');
    release.resolve();
    await root.waitForIdle(context);
    expect(observed).toEqual([{ turn: 1, allowed: true }, { turn: 3, allowed: false }, { turn: 4, allowed: false }, { turn: 6, allowed: true }]);
    expect(prompts[1]).not.toContain('Restricted cron work');
    expect(prompts[2]).toContain('[Scheduled cron: cron-scoped]');
    expect(prompts[2]).not.toContain('Subsequent user work');
    expect(await cron.status(input.requestId)).toMatchObject({ state: 'succeeded', conversationId: String(root.id), message: null });
    await cron.submit(input);
    expect(admissions).toBe(1);
    expect(prompts).toHaveLength(7);
    expect((await storage.scanConversations({}, 128, undefined, context)).items.map(item => String(item.id))).toEqual([String(root.id)]);
  } finally { release.resolve(); await harness.close(context); }
});

test('queued steering and distinct cron scopes cannot merge into one turn', async () => {
  const storage = new MemoryStorage();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const permissions: boolean[][] = [];
  let requests = 0;
  const effect = defineTool({ name: 'effect', description: 'Check two write destinations', parameters: Type.Object({}), async execute(_args, api, ctx) {
    const scopes = await cronToolScopes(api, ctx);
    permissions.push(['a.txt', 'b.txt'].map(path => scopes.every(scope => scope.writeScopes.includes(path))));
    return { content: [{ type: 'text', text: 'Checked permissions' }] };
  } });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'cron-isolation', tools: [effect], hooks: [hook(GenerationTask, { async beforeRequest(_input, api, ctx) { await bindCronGeneration(harness, api, ctx); } })] }));
  const models: Models = { ...createModels(), getModel: () => model, streamSimple() {
    const turn = ++requests;
    const stream = createAssistantMessageEventStream();
    const finish = () => {
      const message = reply();
      if ([2, 4, 6].includes(turn)) { message.content = [{ type: 'toolCall', id: `call-${turn}`, name: 'effect', arguments: {} }]; message.stopReason = 'toolUse'; }
      stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }); stream.end(message);
    };
    if (turn === 1) { entered.resolve(); void release.promise.then(finish); } else finish();
    return stream;
  } };
  const harness = await Harness.open(storage, { registry, models, settings: { followUpMode: 'one-at-a-time', compaction: { enabled: false } } }, context);
  try {
    const root = await harness.root(context, { agent: { model: reference, tools: [effect] } });
    const cron = createCronRuntime({ harness, storage, admitInference: async () => reference, async configureModel(id, model) { const target = await harness.conversation(id, context); if (!target) throw new Error('Missing target'); await target.configure({ model }, context); }, async wake() { harness.resume(); } });
    await root.submit({ type: 'input', content: 'Initial work', requestId: 'initial' }, context);
    await entered.promise;
    await root.submit({ type: 'input', content: 'User steering', requestId: 'steering', whenBusy: 'steer' }, context);
    await cron.submit({ requestId: 'cron-a', text: 'Write A', readScopes: [], writeScopes: ['a.txt'] });
    await cron.submit({ requestId: 'cron-b', text: 'Write B', readScopes: [], writeScopes: ['b.txt'] });
    release.resolve();
    await root.waitForIdle(context);
    expect(permissions).toEqual([[true, true], [true, false], [false, true]]);
    expect((await cron.status('cron-a')).state).toBe('succeeded');
    expect((await cron.status('cron-b')).state).toBe('succeeded');
  } finally { release.resolve(); await harness.close(context); }
});

test('withdrawing a queued cron leaves the active user turn and other queued messages untouched', async () => {
  const storage = new MemoryStorage();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const prompts: string[] = [];
  const models: Models = { ...createModels(), getModel: () => model, streamSimple(_model, input) {
    prompts.push(JSON.stringify(input));
    const stream = createAssistantMessageEventStream();
    const finish = () => { const message = reply(); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); };
    if (prompts.length === 1) { entered.resolve(); void release.promise.then(finish); } else finish();
    return stream;
  } };
  const harness = await Harness.open(storage, { registry: createRegistry(), models, settings: { followUpMode: 'one-at-a-time', compaction: { enabled: false } } }, context);
  try {
    const root = await harness.root(context, { agent: { model: reference } });
    const cron = createCronRuntime({ harness, storage, admitInference: async () => reference, async configureModel(id, model) { const target = await harness.conversation(id, context); if (!target) throw new Error('Missing target'); await target.configure({ model }, context); }, async wake() { harness.resume(); } });
    const user = await root.submit({ type: 'input', content: 'User work must finish', requestId: 'user' }, context);
    await entered.promise;
    const input = { requestId: 'withdraw-cron', text: 'Never run this cron', readScopes: ['src/**'], writeScopes: [] };
    await cron.submit(input);
    await root.submit({ type: 'input', content: 'Other queued user work', requestId: 'other', whenBusy: 'followUp' }, context);
    expect(await cron.withdraw(input.requestId)).toMatchObject({ state: 'withdrawn' });
    await cron.submit(input);
    release.resolve();
    await root.waitForIdle(context);
    expect((await user.status(context)).status).toBe('done');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Other queued user work');
    expect(prompts.join('\n')).not.toContain('Never run this cron');
    expect(await cron.status(input.requestId)).toMatchObject({ state: 'withdrawn' });
  } finally { release.resolve(); await harness.close(context); }
});

test('a queued cancellation racing with placement requires explicit workspace Stop confirmation', async () => {
  const storage = new MemoryStorage();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const models: Models = { ...createModels(), getModel: () => model, streamSimple() {
    const stream = createAssistantMessageEventStream();
    entered.resolve();
    void release.promise.then(() => { const message = reply(); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); });
    return stream;
  } };
  const harness = await Harness.open(storage, { registry: createRegistry(), models, settings: { compaction: { enabled: false } } }, context);
  try {
    const root = await harness.root(context, { agent: { model: reference } });
    const cron = createCronRuntime({ harness, storage, admitInference: async () => reference, async configureModel(id, model) { const target = await harness.conversation(id, context); if (!target) throw new Error('Missing target'); await target.configure({ model }, context); }, async wake() { harness.resume(); } });
    await cron.submit({ requestId: 'race-cron', text: 'Running cron', readScopes: [], writeScopes: [] });
    await entered.promise;
    expect(await cron.withdraw('race-cron')).toMatchObject({ state: 'running' });
    await expect(cron.cancel('race-cron', false)).rejects.toThrow('explicit confirmation');
    expect(await cron.status('race-cron')).toMatchObject({ state: 'running' });
    release.resolve();
    await root.waitForIdle(context);
    expect(await cron.status('race-cron')).toMatchObject({ state: 'succeeded' });
  } finally { release.resolve(); await harness.close(context); }
});

test('cron execution clock starts after the queued user finishes and overdue notices do not create a turn', async () => {
  const storage = new MemoryStorage();
  const userEntered = Promise.withResolvers<void>();
  const cronEntered = Promise.withResolvers<void>();
  const releaseUser = Promise.withResolvers<void>();
  const releaseCron = Promise.withResolvers<void>();
  let count = 0;
  let now = 1000000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'cron-clock', hooks: [hook(GenerationTask, { async beforeRequest(_input, api, ctx) { await bindCronGeneration(harness, api, ctx); } })] }));
  const models: Models = { ...createModels(), getModel: () => model, streamSimple() {
    const stream = createAssistantMessageEventStream();
    const user = ++count === 1;
    (user ? userEntered : cronEntered).resolve();
    void (user ? releaseUser : releaseCron).promise.then(() => { const message = reply(); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); });
    return stream;
  } };
  const harness = await Harness.open(storage, { registry, models, settings: { followUpMode: 'one-at-a-time', compaction: { enabled: false } } }, context);
  try {
    const root = await harness.root(context, { agent: { model: reference } });
    const options = { harness, storage, admitInference: async () => reference, async configureModel(id: typeof root.id, model: typeof reference) { const target = await harness.conversation(id, context); if (!target) throw new Error('Missing target'); await target.configure({ model }, context); }, async wake() { harness.resume(); } };
    const cron = createCronRuntime(options);
    const user = await root.submit({ type: 'input', content: 'Long user job', requestId: 'user' }, context);
    await userEntered.promise;
    await cron.submit({ requestId: 'clock-cron', text: 'Cron work', readScopes: ['src/**'], writeScopes: [] });
    now += 2 * 3600000;
    expect(await cron.status('clock-cron')).toMatchObject({ state: 'queued' });
    expect((await cron.status('clock-cron')).startedAt).toBeUndefined();
    await cron.notifyOverdue('clock-cron');
    releaseUser.resolve();
    await cronEntered.promise;
    expect((await user.status(context)).status).toBe('done');
    expect(await cron.status('clock-cron')).toMatchObject({ state: 'running', startedAt: now });
    now += 3600001;
    await cron.notifyOverdue('clock-cron');
    const recovered = createCronRuntime(options);
    await recovered.notifyOverdue('clock-cron');
    const entries = await storage.scanEntries({ conversationId: root.id }, 100, undefined, context);
    expect(entries.items.filter(entry => entry.kind === 'gitspace.cron-overdue')).toHaveLength(1);
    expect((await harness.snapshot(CronRequestsDoc, context))?.requests['clock-cron']?.startedAt).toBe(now - 3600001);
    expect(count).toBe(2);
    releaseCron.resolve();
    await root.waitForIdle(context);
    expect(await recovered.status('clock-cron')).toMatchObject({ state: 'succeeded', startedAt: now - 3600001 });
    expect(count).toBe(2);
  } finally { releaseUser.resolve(); releaseCron.resolve(); await harness.close(context); clock.mockRestore(); }
});

test('confirmed cancellation stops the workspace lifecycle while unconfirmed running cancellation cannot', async () => {
  const storage = new MemoryStorage();
  const entered = Promise.withResolvers<void>();
  const models: Models = { ...createModels(), getModel: () => model, streamSimple(_model, _input, options) {
    const stream = createAssistantMessageEventStream();
    entered.resolve();
    options?.signal?.addEventListener('abort', () => {
      const error = { ...reply(), stopReason: 'aborted' as const, errorMessage: 'Stopped' };
      stream.push({ type: 'error', reason: 'aborted', error }); stream.end(error);
    }, { once: true });
    return stream;
  } };
  const harness = await Harness.open(storage, { registry: createRegistry(), models, settings: { compaction: { enabled: false } } }, context);
  try {
    const root = await harness.root(context, { agent: { model: reference } });
    const options = { harness, storage, admitInference: async () => reference, async configureModel(id: typeof root.id, model: typeof reference) { const target = await harness.conversation(id, context); if (!target) throw new Error('Missing target'); await target.configure({ model }, context); }, async wake() { harness.resume(); } };
    const lifecycle = createConversationLifecycle(options);
    const cron = createCronRuntime({ ...options, stop: lifecycle.stop });
    await cron.submit({ requestId: 'stop-cron', text: 'Cron work', readScopes: [], writeScopes: [] });
    await entered.promise;
    await expect(cron.cancel('stop-cron', false)).rejects.toThrow('explicit confirmation');
    expect((await cron.status('stop-cron')).state).toBe('running');
    await cron.cancel('stop-cron', true);
    await root.waitForIdle(context);
    expect((await cron.status('stop-cron')).state).toBe('failed');
    await expect(lifecycle.runWhileActive(String(root.id), async () => 'unexpected')).rejects.toThrow('stopped');
  } finally { await harness.close(context); }
});
