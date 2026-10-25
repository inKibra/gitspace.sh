import { expect, onTestFinished, test, vi } from 'vitest';
import { Type } from 'typebox';
import { Harness, createRegistry, defineExtension, defineTask, defineTool, type ConversationId, type Storage } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord';
import { createModels, createAssistantMessageEventStream, type Models, type Model, type Api, type AssistantMessage } from '@earendil-works/pi-ai';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createConversationTools } from './conversation-tools.js';
import type { ToolServices } from './tools.js';
import { createConversationLifecycle, type ConversationLifecycle } from './conversation-lifecycle.js';
import { BackgroundAgentsDoc, createBackgroundAgentTask, createSubagentReplyExtension } from './background-agents.js';
import { AgentDefinitionContextDoc, SUBAGENT_QUEUED, SubagentRunQueueDoc } from './subagent-state.js';

const context = BACKGROUND_CONTEXT;
const model: Model<Api> = { id: 'queue-fixture', name: 'Queue fixture', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
/** Owner tasks that end once their spawn returned, by task id. */
const spawnsReturned = new Map<string, PromiseWithResolvers<void>>();
const spawnReturned = (id: string) => { const found = spawnsReturned.get(id) ?? Promise.withResolvers<void>(); spawnsReturned.set(id, found); return found; };
/** The task a spawn runs in, as an agents tool call: `hold` stays live; `return` ends once its spawn returned. */
const Owner = defineTask<{ label: 'hold' | 'return' }, { phase: 'run' }, null>({ name: 'proof.QueueOwner', version: 1, initial: () => ({ phase: 'run' }), phases: { async run(task, runtime, ctx) { if (task.input.label === 'hold') await runtime.sleep(Date.now() + 3_600_000, ctx); else await spawnReturned(String(task.id)).promise; await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx); } }, async abort(_task, runtime, ctx) { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx); } });
const SpawnSchema = z.union([z.object({ conversationId: z.string(), submissionId: z.string() }), z.object({ conversationId: z.string(), queued: z.string() })]);

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'gitspace-subagent-queue-'));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  return path;
}

/**
 * A model whose request text decides its answer: a request whose latest user text starts with `hold` answers once
 * released (or ends aborted with its signal); one starting with `wait` first calls agents wait; anything else answers
 * at once. `started(text)` resolves once a request whose latest user text contains `text` is made.
 */
async function fixture(storage: Storage, hold = true) {
  const registry = createRegistry();
  const ready = Promise.withResolvers<ConversationLifecycle>();
  const deliver: ConversationLifecycle['deliver'] = async event => (await ready.promise).deliver(event);
  const backgroundAgentTask = createBackgroundAgentTask(deliver);
  const invoking = Promise.withResolvers<ToolServices['invoke']>();
  const waiting: string[] = [];
  const waitingNow = new Map<number, PromiseWithResolvers<void>>();
  const agents = defineTool({ name: 'agents', description: 'agents', parameters: Type.Object({ op: Type.String(), timeoutMs: Type.Number() }), async execute(args, api, ctx) {
    waiting.push(String(api.conversationId));
    waitingNow.get(waiting.length)?.resolve();
    const result = await (await invoking.promise)({ tool: 'agents', args, conversationId: String(api.conversationId), taskId: String(api.taskId), attemptId: String(api.taskId), requestId: String(api.taskId), replay: 'safe', ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}) });
    return { output: result.content.flatMap(part => part.type === 'text' ? [{ type: 'text' as const, text: part.text }] : []) };
  } });
  const tools = [defineTool({ name: 'read', description: 'read', parameters: Type.Object({}), async execute() { return { output: [{ type: 'text' as const, text: 'read' }] }; } }), agents];
  registry.install(defineExtension({ name: 'proof.queue', tasks: [Owner, backgroundAgentTask], tools }));
  registry.install(createSubagentReplyExtension(deliver));
  const requests: string[] = [];
  const held = new Map<string, () => void>();
  const starts = new Map<string, PromiseWithResolvers<void>>();
  const started = (text: string) => { const found = starts.get(text) ?? Promise.withResolvers<void>(); starts.set(text, found); if (requests.some(request => request.includes(text))) found.resolve(); return found.promise; };
  const models: Models = { ...createModels(), getModel: () => model, streamSimple(_selected, input, options) {
    const latest = input.messages.findLast(message => message.role === 'user' || message.role === 'toolResult');
    const text = latest?.role === 'user' ? typeof latest.content === 'string' ? latest.content : latest.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : '';
    requests.push(text);
    for (const [key, found] of starts) if (text.includes(key)) found.resolve();
    const stream = createAssistantMessageEventStream();
    const answer = (message: AssistantMessage) => { stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }); stream.end(message); };
    const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Complete.' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage };
    if (text.startsWith('wait')) answer({ ...reply, content: [{ type: 'toolCall', id: 'wait-call', name: 'agents', arguments: { op: 'wait', timeoutMs: 30_000 } }], stopReason: 'toolUse' });
    else if (hold && text.startsWith('hold')) {
      const abort = () => { const error = { ...reply, stopReason: 'aborted' as const }; stream.push({ type: 'error', reason: 'aborted', error }); stream.end(error); };
      options?.signal?.addEventListener('abort', abort, { once: true });
      held.set(text, () => { options?.signal?.removeEventListener('abort', abort); answer(reply); });
    } else answer(reply);
    return stream;
  } };
  const harness = await Harness.open(storage, { registry, models, settings: { extensions: registry.snapshot().installed(), compaction: { enabled: false } } }, context);
  const root = await harness.root(context, { agent: { model: { provider: 'test', modelId: model.id }, tools } });
  const reports: unknown[] = [];
  const admitInference = async () => ({ provider: 'test', modelId: model.id });
  const configureModel = async (id: ConversationId) => { const conversation = await harness.conversation(id, context); if (!conversation) throw new Error('Missing fixture conversation'); await conversation.configure({ model: { provider: 'test', modelId: model.id }, tools }, context); };
  const lifecycle = createConversationLifecycle({ harness, storage, admitInference, configureModel, report: error => { reports.push(error); } });
  ready.resolve(lifecycle);
  const invoke = createConversationTools({ harness, storage, lifecycle, backgroundAgentTask, admitInference, configureModel, catalog: async () => ({ models: [], roles: [] }) });
  invoking.resolve(invoke);
  const owner = (label: 'hold' | 'return') => root.commit(tx => tx.createTask(Owner, { label }, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true }), context);
  const ownerId = await owner('hold');
  async function call(args: JsonValue, attemptId: string = crypto.randomUUID(), conversationId = String(root.id), taskId = ownerId) {
    const result = await invoke({ tool: 'agents', args, conversationId, taskId: String(taskId), attemptId, requestId: attemptId, replay: 'safe' });
    const text = result.content.find(part => part.type === 'text');
    if (text?.type !== 'text') throw new Error('Tool result missing');
    return text.text;
  }
  // A background anchor waits for its spawn's task to end: the agents tool call, which ends once the spawn returned.
  async function spawn(name: string, task: string, background = false) {
    const taskId = background ? await owner('return') : ownerId;
    const result = SpawnSchema.parse(JSON.parse(await call({ op: 'spawn', name, task, background }, name, String(root.id), taskId)));
    spawnReturned(String(taskId)).resolve();
    return result;
  }
  const queue = async () => {
    const ids = (await harness.snapshot(SubagentRunQueueDoc, context))?.queue.map(item => item.conversationId) ?? [];
    return Promise.all(ids.map(async id => (await harness.snapshot(AgentDefinitionContextDoc, (await conversation(id)).id, context))?.child?.name));
  };
  async function conversation(id: string) {
    const record = (await storage.scanConversations({}, 100, undefined, context)).items.find(item => String(item.id) === id);
    const found = record && await harness.conversation(record.id, context);
    if (!found) throw new Error('Conversation not found');
    return found;
  }
  const release = (text: string) => { const done = held.get(text); if (!done) throw new Error(`${text} is not held`); held.delete(text); done(); };
  const inWait = (count: number) => { const found = waitingNow.get(count) ?? Promise.withResolvers<void>(); waitingNow.set(count, found); if (waiting.length >= count) found.resolve(); return found.promise; };
  return { harness, root, lifecycle, call, spawn, queue, conversation, release, started, requests, reports, inWait };
}

test('six spawns run four and queue two; a finished run starts the oldest queued, whose task it receives once', async () => {
  const f = await fixture(await openNodeJsonlStorage(await directory(), context));
  try {
    const results = [];
    for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) results.push(await f.spawn(name, `hold ${name}`));
    expect(results.map(result => 'queued' in result ? result.queued : 'running')).toEqual(['running', 'running', 'running', 'running', SUBAGENT_QUEUED, SUBAGENT_QUEUED]);
    await Promise.all(['A', 'B', 'C', 'D'].map(name => f.started(`hold ${name}`)));
    expect(f.requests).toEqual(['hold A', 'hold B', 'hold C', 'hold D']);
    const listed = z.array(z.object({ name: z.string(), queued: z.string().optional() })).parse(JSON.parse(await f.call({ op: 'list' })));
    expect(listed.filter(member => member.queued).map(member => member.name)).toEqual(['E', 'F']);
    // A retried spawn of a queued child queues nothing twice.
    expect('queued' in await f.spawn('E', 'hold E')).toBe(true);
    expect(await f.queue()).toEqual(['E', 'F']);

    f.release('hold A');
    await f.started('hold E');
    expect(await f.queue()).toEqual(['F']);
    expect(f.requests.filter(request => request.startsWith('hold'))).toEqual(['hold A', 'hold B', 'hold C', 'hold D', 'hold E']);
    const retried = await f.spawn('E', 'hold E');
    if (!('submissionId' in retried)) throw new Error('Started child reported queued');
    const child = await f.conversation(retried.conversationId);
    const tasks = (await child.entries({}, 100, undefined, context)).items.flatMap(entry => entry.model ?? []).filter(message => message.role === 'user');
    expect(tasks.map(message => message.content)).toEqual(['hold E']);

    f.release('hold B');
    await f.started('hold F');
    expect(await f.queue()).toEqual([]);
    for (const name of ['C', 'D', 'E', 'F']) f.release(`hold ${name}`);
    await f.harness.waitForIdle(context);
    expect(f.reports).toEqual([]);
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

test('queued children still start after the workspace object resets', async () => {
  const path = await directory();
  const first = await fixture(await openNodeJsonlStorage(path, context));
  try {
    for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) await first.spawn(name, `hold ${name}`);
    await Promise.all(['A', 'B', 'C', 'D'].map(name => first.started(`hold ${name}`)));
    expect(await first.queue()).toEqual(['E', 'F']);
  } finally { await first.harness.close(context); }
  expect(first.requests.some(request => request === 'hold E' || request === 'hold F')).toBe(false);
  const reopened = await fixture(await openNodeJsonlStorage(path, context), false);
  try {
    await reopened.lifecycle.recover();
    reopened.harness.resume();
    await Promise.all([reopened.started('hold E'), reopened.started('hold F')]);
    await reopened.harness.waitForIdle(context);
    expect(await reopened.queue()).toEqual([]);
    expect(reopened.requests.filter(request => request === 'hold E' || request === 'hold F').sort()).toEqual(['hold E', 'hold F']);
    expect(reopened.reports).toEqual([]);
  } finally { await reopened.lifecycle.stop(String(reopened.root.id)); await reopened.harness.close(context); }
});

test('stopping a queued child takes it out of the queue, and stopping the workspace empties it', async () => {
  const f = await fixture(await openNodeJsonlStorage(await directory(), context));
  try {
    const spawned = [];
    for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) spawned.push(await f.spawn(name, `hold ${name}`));
    await Promise.all(['A', 'B', 'C', 'D'].map(name => f.started(`hold ${name}`)));
    expect(await f.call({ op: 'stop', id: spawned[4]!.conversationId })).toBe('Agent stopped');
    expect(await f.queue()).toEqual(['F']);
    f.release('hold A');
    await f.started('hold F');
    expect(await f.queue()).toEqual([]);
    expect(f.requests).not.toContain('hold E');

    expect('queued' in await f.spawn('G', 'hold G')).toBe(true);
    await f.lifecycle.stop(String(f.root.id));
    expect(await f.queue()).toEqual([]);
    await f.harness.waitForIdle(context);
    expect(f.requests).not.toContain('hold G');
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

test('a message to an idle child while four run is queued until one of them finishes', async () => {
  const f = await fixture(await openNodeJsonlStorage(await directory(), context));
  try {
    await f.spawn('A', 'quick A');
    await f.started('quick A');
    await (await f.conversation((await f.spawn('A', 'quick A')).conversationId)).waitForIdle(context);
    for (const name of ['B', 'C', 'D', 'E']) await f.spawn(name, `hold ${name}`);
    await Promise.all(['B', 'C', 'D', 'E'].map(name => f.started(`hold ${name}`)));
    expect(await f.call({ op: 'send', to: 'A', message: 'Follow up for A' })).toBe(`Message durably admitted; ${SUBAGENT_QUEUED}`);
    expect(await f.queue()).toEqual(['A']);
    expect(f.requests.some(request => request.includes('Follow up for A'))).toBe(false);
    f.release('hold B');
    await f.started('Follow up for A');
    expect(await f.queue()).toEqual([]);
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

test('a background child waits in the queue and its anchor ends only after its run', async () => {
  const f = await fixture(await openNodeJsonlStorage(await directory(), context));
  try {
    for (const name of ['A', 'B', 'C', 'D']) await f.spawn(name, `hold ${name}`);
    const background = await f.spawn('E', 'hold E', true);
    expect('queued' in background).toBe(true);
    const anchor = Object.values((await f.harness.snapshot(BackgroundAgentsDoc, f.root.id, context))?.children ?? {})[0]?.owner;
    if (!anchor) throw new Error('Background anchor missing');
    const order: string[] = [];
    const ended = f.harness.waitForTask(anchor, context).then(settled => { order.push(`anchor ${settled.state.outcome.status}`); });
    await Promise.all(['A', 'B', 'C', 'D'].map(name => f.started(`hold ${name}`)));
    f.release('hold A');
    await f.started('hold E');
    order.push('E started');
    f.release('hold E');
    await ended;
    expect(order).toEqual(['E started', 'anchor completed']);
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});

test('children waiting on a queued sibling hold their slots only until their waits time out', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => { vi.useRealTimers(); });
  const f = await fixture(await openNodeJsonlStorage(await directory(), context));
  try {
    for (const name of ['A', 'B', 'C', 'D']) await f.spawn(name, `wait for E (${name})`);
    expect('queued' in await f.spawn('E', 'quick E')).toBe(true);
    await f.inWait(4);
    expect(f.requests).not.toContain('quick E');
    vi.advanceTimersByTime(30_000);
    await f.started('quick E');
    expect(await f.queue()).toEqual([]);
  } finally { await f.lifecycle.stop(String(f.root.id)); await f.harness.close(context); }
});
