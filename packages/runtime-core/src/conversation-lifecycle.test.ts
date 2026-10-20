import { expect, test, onTestFinished, vi } from 'vitest';
import { Harness, MemoryStorage, createRegistry, defineTask, defineExtension, type ConversationId, type Storage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, createAssistantMessageEventStream, type Models, type Model, type Api, type AssistantMessage } from '@earendil-works/pi-ai';
import { createConversationLifecycle, ConversationLifecycleDoc, type ConversationEvent } from './conversation-lifecycle.js';
import { AgentDefinitionContextDoc } from './subagent-state.js';
import { SessionControlsDoc } from './session-controls.js';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Polls until `done` holds, failing after a second. */
async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done(); waited += 10) {
    if (waited > 1_000) throw new Error('Condition not reached');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const context = BACKGROUND_CONTEXT;
const model: Model<Api> = { id: 'lifecycle-fixture', name: 'Lifecycle fixture', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
async function fixture(storage: Storage = new MemoryStorage(), blocked = false, failFirst?: Promise<void>) {
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
    if (failFirst && seen.length === 1) void failFirst.then(() => { const error = { ...reply, stopReason: 'error' as const, errorMessage: 'Provider unavailable' }; stream.push({ type: 'error', reason: 'error', error }); stream.end(error); });
    else if (blocked) { if (options?.signal?.aborted) finish(); else options?.signal?.addEventListener('abort', finish, { once: true }); }
    else { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(reply); }
    return stream;
  } };
  const harness = await Harness.open(storage, { registry, models, settings: { compaction: { enabled: false } } }, context);
  const root = await harness.root(context, { agent: { model: { provider: 'test', modelId: model.id } } });
  if (blocked) await root.commit(tx => tx.createTask(background, null, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true }), context);
  const reports: unknown[] = [];
  // Admission fails for a selection the profile does not define, as a role label stored before validation does.
  const admitInference = async (input: { selection?: { kind: string; role?: string } }) => {
    if (input.selection?.kind === 'role' && input.selection.role === 'Deep') throw new Error('Inference role Deep is not defined in this profile');
    return { provider: 'test', modelId: model.id };
  };
  const lifecycle = createConversationLifecycle({ harness, storage, admitInference, report: error => { reports.push(error); }, async configureModel(id, selected) { const conversation = await harness.conversation(id, context); if (!conversation) throw new Error('Missing fixture conversation'); await conversation.configure({ model: selected }, context); }, async wake() { wakeCount++; } });
  return { harness, root, lifecycle, storage, seen, reports, aborted: () => aborted, backgroundAborted: () => backgroundAborted, wakeCount: () => wakeCount, threeStarted: threeStarted.promise };
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
    expect(f.seen[0]).toContain('source=\\"Reviewer (child-1)\\"');
    const entries = await f.root.entries({}, 100, undefined, context);
    expect(entries.items.filter(entry => entry.kind === 'gitspace.agent-message').map(entry => entry.data)).toEqual([{ requestId: 'message-1', text: 'Boundary checked', sender: { id: 'child-1', name: 'Reviewer' } }]);
    expect(f.wakeCount()).toBe(1);
  } finally { await f.harness.close(context); }
});

test('events delivered during a run that ends without an answer reach the agent on the next drive', async () => {
  const f = await fixture(new MemoryStorage(), true);
  try {
    const first: ConversationEvent = { conversationId: String(f.root.id), requestId: 'job-1', kind: 'command-completed', text: 'Background command job:1 completed:\nfirst' };
    await f.lifecycle.deliver(first);
    await f.lifecycle.deliver({ ...first, requestId: 'job-2', text: 'Background command job:2 completed:\nsecond' });
    await until(() => f.seen.length === 1);
    await f.root.abort(context);
    await f.root.waitForIdle(context);
    await f.lifecycle.recover();
    await until(() => f.seen.length === 2);
    expect(f.seen[1]).toContain('Background command job:2 completed');
    await f.root.abort(context);
  } finally { await f.harness.close(context); }
}, 5000);

test('a conversation whose admission fails does not keep recovery from delivering to the others', async () => {
  const f = await fixture();
  try {
    const broken = await f.harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'test', modelId: model.id } } }, context);
    // As a spawn stored it before roles were validated: the label in both the child record and its session controls.
    await broken.commit(async tx => {
      (await tx.doc(AgentDefinitionContextDoc, broken.id)).child = { parentId: String(f.root.id), name: 'Broken', attemptId: 'broken', definition: null, selection: { kind: 'role', role: 'Deep' }, role: 'Deep', thinking: null, tools: [], model: null };
      const controls = await tx.doc(SessionControlsDoc, broken.id);
      controls.selection = { kind: 'role', role: 'Deep' };
      controls.role = 'Deep';
    }, context);
    await expect(f.lifecycle.deliver({ conversationId: String(broken.id), requestId: 'to-broken', kind: 'agent-message', text: 'Unadmittable' })).rejects.toThrow('role Deep');
    // Pending for the root since before a reset: only recovery delivers it.
    const pending: ConversationEvent = { conversationId: String(f.root.id), requestId: 'to-root', kind: 'command-completed', text: 'Background command job:9 completed' };
    await f.root.commit(async tx => { (await tx.doc(ConversationLifecycleDoc, f.root.id)).events.push({ event: pending, delivered: false, consumed: false }); }, context);
    await f.lifecycle.recover();
    await f.root.waitForIdle(context);
    expect(f.seen.some(messages => messages.includes('Background command job:9 completed'))).toBe(true);
    expect(f.reports.map(String)).toEqual([`Error: Conversation ${String(broken.id)} could not resume: Inference role Deep is not defined in this profile`]);
  } finally { await f.harness.close(context); }
}, 5000);

test('events that pile up while the agent is busy reach it together as one message', async () => {
  const f = await fixture(new MemoryStorage(), true);
  try {
    const first: ConversationEvent = { conversationId: String(f.root.id), requestId: 'job-1', kind: 'command-completed', text: 'job:1 completed' };
    await f.lifecycle.deliver(first);
    await until(() => f.seen.length === 1);
    await f.lifecycle.deliver({ ...first, requestId: 'job-2', text: 'job:2 completed' });
    await f.lifecycle.deliver({ conversationId: String(f.root.id), requestId: 'reply-1', kind: 'agent-message', sender: { id: 'child-1', name: 'Reviewer' }, text: 'No findings' });
    await f.root.abort(context);
    await f.root.waitForIdle(context);
    await f.lifecycle.recover();
    await until(() => f.seen.length === 2);
    expect(f.seen[1]).toContain('job:2 completed');
    expect(f.seen[1]).toContain('source=\\"Reviewer (child-1)\\"');
    await f.root.abort(context);
    await f.root.waitForIdle(context);
    await f.lifecycle.recover();
    expect(f.seen).toHaveLength(2);
  } finally { await f.harness.close(context); }
}, 5000);

test('input queued behind a run that fails without an answer starts on the next drive', async () => {
  const fail = Promise.withResolvers<void>();
  const f = await fixture(new MemoryStorage(), false, fail.promise);
  try {
    await f.root.submit({ type: 'input', requestId: 'first', content: 'First request' }, context);
    await until(() => f.seen.length === 1);
    await f.root.submit({ type: 'input', requestId: 'second', content: 'Queued request', whenBusy: 'followUp' }, context);
    fail.resolve();
    await f.root.waitForIdle(context);
    expect(f.seen).toHaveLength(1);
    await f.lifecycle.recover();
    await f.root.waitForIdle(context);
    expect(f.seen).toHaveLength(2);
    expect(f.seen[1]).toContain('Queued request');
  } finally { await f.harness.close(context); }
}, 5000);

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
    await reopened.lifecycle.recover();
    await reopened.harness.waitForIdle(context);
    expect(reopened.seen.join('\n')).toContain('Background command finished after Stop');
    expect(reopened.seen.join('\n')).toContain('source=\\"One');
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
