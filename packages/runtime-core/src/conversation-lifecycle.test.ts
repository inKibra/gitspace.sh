import { expect, test, onTestFinished } from 'vitest';
import { Harness, MemoryStorage, createRegistry, defineTask, defineExtension, type ConversationId, type Storage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, createAssistantMessageEventStream, type Models, type Model, type Api, type AssistantMessage } from '@earendil-works/pi-ai';
import { createConversationLifecycle, ConversationLifecycleDoc, type ConversationEvent } from './conversation-lifecycle.js';
import { AgentDefinitionContextDoc } from './subagent-state.js';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const context = BACKGROUND_CONTEXT;
const model: Model<Api> = { id: 'lifecycle-fixture', name: 'Lifecycle fixture', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
async function fixture(storage: Storage = new MemoryStorage(), blocked = false) {
  const seen: string[] = [];
  const threeStarted = Promise.withResolvers<void>();
  let aborted = 0;
  let wakeCount = 0;
  let backgroundAborted = 0;
  const background = defineTask<null, { phase: 'wait' }, null>({ name: 'proof.BackgroundCommand', version: 1, initial: () => ({ phase: 'wait' }), phases: { async wait(_task, runtime, ctx) { await runtime.sleep(Date.now() + 300000, ctx); await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx); } }, async abort(_task, runtime, ctx) { backgroundAborted++; await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx); } });
  const registry = createRegistry(); registry.install(defineExtension({ name: 'proof.background', tasks: [background] }));
  const models: Models = { ...createModels(), getModel: () => model, streamSimple(_model, input, options) {
    seen.push(JSON.stringify(input.messages));
    if (seen.length === 3) threeStarted.resolve();
    const stream = createAssistantMessageEventStream();
    const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Complete.' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const finish = () => { aborted++; const error = { ...reply, stopReason: 'aborted' as const }; stream.push({ type: 'error', reason: 'aborted', error }); stream.end(error); };
    if (blocked) { if (options?.signal?.aborted) finish(); else options?.signal?.addEventListener('abort', finish, { once: true }); }
    else { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(reply); }
    return stream;
  } };
  const harness = await Harness.open(storage, { registry, models, settings: { compaction: { enabled: false } } }, context);
  const root = await harness.root(context, { agent: { model: { provider: 'test', modelId: model.id } } });
  if (blocked) await root.commit(tx => tx.createTask(background, null, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true }), context);
  const lifecycle = createConversationLifecycle({ harness, storage, admitInference: async () => ({ provider: 'test', modelId: model.id }), async configureModel(id, selected) { const conversation = await harness.conversation(id, context); if (!conversation) throw new Error('Missing fixture conversation'); await conversation.configure({ model: selected }, context); }, async wake() { wakeCount++; } });
  return { harness, root, lifecycle, storage, seen, aborted: () => aborted, backgroundAborted: () => backgroundAborted, wakeCount: () => wakeCount, threeStarted: threeStarted.promise };
}

test('idle event delivery wakes inference with visible durable sender labels and does not duplicate retries', async () => {
  const f = await fixture();
  try {
    const event: ConversationEvent = { conversationId: String(f.root.id), requestId: 'message-1', kind: 'agent-message', sender: { id: 'child-1', name: 'Reviewer' }, text: 'Boundary checked' };
    await f.lifecycle.deliver(event);
    await f.root.waitForIdle(context);
    await f.lifecycle.deliver(event);
    await f.root.waitForIdle(context);
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]).toContain('Message from Reviewer (child-1)');
    const entries = await f.root.entries({}, 100, undefined, context);
    expect(entries.items.filter(entry => entry.kind === 'gitspace.agent-message').map(entry => entry.data)).toEqual([{ requestId: 'message-1', text: 'Boundary checked', sender: { id: 'child-1', name: 'Reviewer' } }]);
    expect(f.wakeCount()).toBe(1);
  } finally { await f.harness.close(context); }
});

test('Stop aborts three actual running child conversations and persists the latch across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-agent-lifecycle-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(await openNodeJsonlStorage(directory, context), true);
  const children: ConversationId[] = [];
  try {
    for (const name of ['One', 'Two', 'Three']) {
      const child = await f.harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'test', modelId: model.id } } }, context);
      children.push(child.id);
      await child.commit(async tx => { (await tx.doc(AgentDefinitionContextDoc, child.id)).child = { parentId: String(f.root.id), name, attemptId: name, definition: null, selection: { kind: 'role', role: 'review' }, role: 'review', thinking: null, tools: [], model: { provider: 'test', modelId: model.id } }; }, context);
      await child.submit({ type: 'input', requestId: name, content: 'Remain running' }, context);
    }
    await f.threeStarted;
    await f.lifecycle.stop(String(f.root.id));
    expect(f.aborted()).toBe(3);
    expect(f.backgroundAborted()).toBe(1);
    for (const id of children) expect((await f.harness.snapshot(ConversationLifecycleDoc, id, context))?.stopped).toBe(true);
    await f.lifecycle.deliver({ conversationId: String(f.root.id), requestId: 'late-completion', kind: 'command-completed', text: 'Background command finished after Stop' });
    expect(f.seen).toHaveLength(3);
    expect(f.wakeCount()).toBe(0);
  } finally { await f.harness.close(context); }
  const reopened = await fixture(await openNodeJsonlStorage(directory, context));
  try {
    await reopened.lifecycle.deliver({ conversationId: String(reopened.root.id), requestId: 'late-message', kind: 'agent-message', sender: { id: String(children[0]), name: 'One' }, text: 'Durable followup' });
    await reopened.lifecycle.deliver({ conversationId: String(children[0]), requestId: 'late-child-message', kind: 'agent-message', sender: { id: String(reopened.root.id), name: 'parent' }, text: 'Queued child followup' });
    await reopened.lifecycle.recover();
    expect(reopened.seen).toEqual([]);
    expect(await reopened.lifecycle.wait(String(reopened.root.id), { timeoutMs: 100 })).toEqual({ kind: 'stopped' });
    await reopened.lifecycle.resume(String(reopened.root.id));
    await reopened.harness.waitForIdle(context);
    expect(reopened.seen.join('\n')).toContain('Background command finished after Stop');
    expect(reopened.seen.join('\n')).toContain('Message from One');
    expect(reopened.seen.join('\n')).toContain('Queued child followup');
    for (const id of children) expect((await reopened.harness.snapshot(ConversationLifecycleDoc, id, context))?.stopped).toBe(false);
  } finally { await reopened.harness.close(context); }
}, 5000);

test('wait returns first durable event of every kind, then times out, and supports cancellation', async () => {
  const f = await fixture();
  try {
    const kinds = ['agent-message', 'command-completed', 'process-exited'] as const;
    for (const kind of kinds) {
      const waiting = f.lifecycle.wait(String(f.root.id), { timeoutMs: 1000 });
      const event: ConversationEvent = { conversationId: String(f.root.id), requestId: kind, kind, text: kind };
      await f.lifecycle.deliver(event);
      expect(await waiting).toEqual(event);
    }
    expect(await f.lifecycle.wait(String(f.root.id), { timeoutMs: 1 })).toEqual({ kind: 'timeout' });
    const controller = new AbortController();
    const waiting = f.lifecycle.wait(String(f.root.id), { timeoutMs: 300000, signal: controller.signal });
    controller.abort(new Error('cancel wait'));
    await expect(waiting).rejects.toThrow('cancel wait');
    await f.root.waitForIdle(context);
  } finally { await f.harness.close(context); }
});
