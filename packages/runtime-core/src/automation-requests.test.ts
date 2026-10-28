import { expect, test } from 'vitest';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Models, type Model, type Api } from '@earendil-works/pi-ai';
import type { ModelSelectionIntent } from '@gitspace/protocol-runtime/session-controls';
import { createAutomationRequests } from './automation-requests.js';
import { createConversationLifecycle } from './conversation-lifecycle.js';
import { SessionControlsDoc } from './session-controls.js';

const context = BACKGROUND_CONTEXT;
const model: Model<Api> = { id: 'controlled', name: 'Controlled', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const reference = { provider: model.provider, modelId: model.id };
function reply(): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text: 'Done' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function requests(harness: Harness, storage: MemoryStorage, admitted: () => void = () => {}) {
  return createAutomationRequests({ harness, storage, async admitInference() { admitted(); return reference; }, async configureModel(id, model) { const target = await harness.conversation(id, context); if (!target) throw new Error('Missing target'); await target.configure({ model }, context); }, async wake() { harness.resume(); } });
}

for (const busy of [false, true]) test(`an automation run's instruction is delivered into the existing root while ${busy ? 'busy' : 'idle'}`, async () => {
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
    const automation = requests(harness, storage);
    const result = await automation.submit({ requestId: 'automation:1', text: 'Scheduled check' });
    expect(result.conversationId).toBe(String(root.id));
    expect((await storage.scanConversations({}, 128, undefined, context)).items.map(item => String(item.id))).toEqual([String(root.id)]);
    release.resolve();
    await root.waitForIdle(context);
    expect(prompts.at(-1)).toContain('Scheduled check');
    expect(await automation.status('automation:1')).toMatchObject({ state: 'succeeded', conversationId: String(root.id), message: null });
  } finally { release.resolve(); await harness.close(context); }
});

test('a retried submission delivers its instruction once, and a request id cannot carry another instruction', async () => {
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
    let admissions = 0;
    const automation = requests(harness, storage, () => { admissions++; });
    await root.submit({ type: 'input', content: 'Busy user work', requestId: 'user' }, context);
    await entered.promise;
    const input = { requestId: 'automation:retried', text: 'Nightly audit' };
    await automation.submit(input);
    expect(await automation.status(input.requestId)).toMatchObject({ state: 'queued', conversationId: String(root.id) });
    expect(await automation.submit(input)).toEqual({ conversationId: String(root.id) });
    await expect(automation.submit({ ...input, text: 'Another instruction' })).rejects.toThrow('Automation request identity changed');
    release.resolve();
    await root.waitForIdle(context);
    expect(await automation.status(input.requestId)).toMatchObject({ state: 'succeeded' });
    await automation.submit(input);
    await root.waitForIdle(context);
    expect(admissions).toBe(1);
    expect(prompts.filter(prompt => prompt.includes('Nightly audit'))).toHaveLength(1);
    expect(prompts).toHaveLength(2);
  } finally { release.resolve(); await harness.close(context); }
});

test('an automation\'s model role is admitted for its first run and becomes the conversation\'s role; a role the profile lacks is refused and changes nothing', async () => {
  const storage = new MemoryStorage();
  const prompts: string[] = [];
  const models: Models = { ...createModels(), getModel: () => model, streamSimple(_model, input) {
    prompts.push(JSON.stringify(input));
    const stream = createAssistantMessageEventStream();
    const message = reply();
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end(message);
    return stream;
  } };
  const harness = await Harness.open(storage, { registry: createRegistry(), models, settings: { compaction: { enabled: false } } }, context);
  try {
    const root = await harness.root(context, { agent: { model: reference } });
    const admitted: ModelSelectionIntent[] = [];
    const automation = createAutomationRequests({
      harness, storage,
      // As the cloud admits: a role the profile does not define is refused.
      async admitInference({ selection = { kind: 'default' } }) {
        if (selection.kind === 'role' && selection.role === 'gone') throw new Error('Inference role gone is not defined in this profile; its roles are default, deep, fast, taste, reviewer');
        admitted.push(selection);
        return { ...reference, ...(selection.kind === 'role' ? { role: selection.role } : {}) };
      },
      async configureModel(id, value) { const target = await harness.conversation(id, context); if (!target) throw new Error('Missing target'); await target.configure({ model: value }, context); },
      async wake() { harness.resume(); },
    });
    const controls = async () => harness.snapshot(SessionControlsDoc, root.id, context);

    await expect(automation.submit({ requestId: 'automation:gone', text: 'Review as gone', role: 'gone' })).rejects.toThrow('Inference role gone is not defined');
    expect((await controls())?.role ?? null).toBeNull();

    await automation.submit({ requestId: 'automation:start', text: 'Review the pull request', role: 'reviewer' });
    await root.waitForIdle(context);
    expect(admitted).toEqual([{ kind: 'role', role: 'reviewer' }]);
    expect(await controls()).toMatchObject({ role: 'reviewer', selection: { kind: 'role', role: 'reviewer' } });
    // A later run with no role keeps the conversation's.
    await automation.submit({ requestId: 'automation:feedback', text: 'Address the review feedback' });
    await root.waitForIdle(context);
    expect(admitted).toEqual([{ kind: 'role', role: 'reviewer' }, { kind: 'role', role: 'reviewer' }]);
    expect(prompts.some(prompt => prompt.includes('Review as gone'))).toBe(false);
  } finally { await harness.close(context); }
});

test('withdrawing a queued instruction leaves the active user turn and other queued messages untouched', async () => {
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
    const automation = requests(harness, storage);
    const user = await root.submit({ type: 'input', content: 'User work must finish', requestId: 'user' }, context);
    await entered.promise;
    const input = { requestId: 'automation:withdrawn', text: 'Never run this automation' };
    await automation.submit(input);
    await root.submit({ type: 'input', content: 'Other queued user work', requestId: 'other', whenBusy: 'followUp' }, context);
    expect(await automation.withdraw(input.requestId)).toMatchObject({ state: 'withdrawn' });
    await automation.submit(input);
    release.resolve();
    await root.waitForIdle(context);
    expect((await user.status(context)).status).toBe('done');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Other queued user work');
    expect(prompts.join('\n')).not.toContain('Never run this automation');
    expect(await automation.status(input.requestId)).toMatchObject({ state: 'withdrawn' });
  } finally { release.resolve(); await harness.close(context); }
});

test('a withdrawal racing with placement reports the instruction running and leaves it running', async () => {
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
    const automation = requests(harness, storage);
    await automation.submit({ requestId: 'automation:race', text: 'Running automation' });
    await entered.promise;
    expect(await automation.withdraw('automation:race')).toMatchObject({ state: 'running' });
    expect(await automation.status('automation:race')).toMatchObject({ state: 'running' });
    release.resolve();
    await root.waitForIdle(context);
    expect(await automation.status('automation:race')).toMatchObject({ state: 'succeeded' });
  } finally { release.resolve(); await harness.close(context); }
});

test('cancelling a running instruction stops the workspace agent', async () => {
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
    const options = { report: (error: unknown) => { throw error; }, harness, storage, admitInference: async () => reference, async configureModel(id: typeof root.id, model: typeof reference) { const target = await harness.conversation(id, context); if (!target) throw new Error('Missing target'); await target.configure({ model }, context); }, async wake() { harness.resume(); } };
    const lifecycle = createConversationLifecycle(options);
    const automation = createAutomationRequests({ ...options, stop: lifecycle.stop });
    await automation.submit({ requestId: 'automation:stop', text: 'Automation work' });
    await entered.promise;
    await automation.cancel('automation:stop');
    await root.waitForIdle(context);
    expect((await automation.status('automation:stop')).state).toBe('failed');
    await expect(lifecycle.runWhileActive(String(root.id), async () => 'unexpected')).rejects.toThrow('stopped');
  } finally { await harness.close(context); }
});
