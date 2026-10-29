import { expect, onTestFinished, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStorage, type ConversationId, type Storage } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { createRuntimeHarness } from './harness.js';
import type { ConversationEvent } from './conversation-lifecycle.js';

const model: Model<Api> = { id: 'run-end', name: 'Run end', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
/** A subagent's reply and a background command's completion, as their producers deliver them. */
const events = (conversationId: ConversationId): ConversationEvent[] => [
  { conversationId: String(conversationId), requestId: 'reply:child-1', kind: 'agent-message', sender: { id: 'child-1', name: 'Reviewer' }, text: 'Review done' },
  { conversationId: String(conversationId), requestId: 'job-completion:job:7', kind: 'command-completed', text: 'Background command job:7 completed:\nbuilt' },
];

/** The workspace runtime's harness over `storage`. Its provider holds each request until the test answers it; every wake
 * the runtime asks for is recorded. */
async function open(storage: Storage) {
  const requests: Array<{ text: string; answer(): void }> = [];
  let arrived = Promise.withResolvers<void>();
  const wakes: number[] = [];
  const reports: unknown[] = [];
  const models = { ...createModels(), getModel: () => model, streamSimple(_model: Model<Api>, request: { messages: unknown[] }, streamOptions?: { signal?: AbortSignal }) {
    const stream = createAssistantMessageEventStream();
    const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage };
    // A reset cuts the request off: it ends aborted, as a provider stream does.
    const cut = () => { const error = { ...reply, stopReason: 'aborted' as const }; stream.push({ type: 'error', reason: 'aborted', error }); stream.end(error); };
    streamOptions?.signal?.addEventListener('abort', cut, { once: true });
    requests.push({ text: JSON.stringify(request.messages), answer() { streamOptions?.signal?.removeEventListener('abort', cut); stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(reply); } });
    const done = arrived; arrived = Promise.withResolvers(); done.resolve();
    return stream;
  } };
  const runtime = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage, models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, invoke: unused, prepareBrowser: unused, takeoverTab: unused, instructions: async () => '', preflight: async () => {}, results: { put: unused, text: unused } },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async at => { wakes.push(at); } },
    retainedRules: { loadRules: async () => [], judge: unused, matchAst: unused }, editTool: () => 'edit',
    onReport: error => { reports.push(error); }, admitInference: async () => ({ provider: 'test', modelId: model.id }), bindInferenceConversation: async () => {},
    refuseRequest: (_signal, reason) => { reports.push(reason); }, unfinished: { begin: () => 0, end: () => {} },
  });
  /** The `index`-th request the provider received, once it arrives. */
  async function request(index: number) {
    while (requests.length <= index) await arrived.promise;
    return requests[index]!;
  }
  return { ...runtime, wakes, reports, request };
}

test('events that reach a running conversation go in when its run ends, with no wake scheduled for them', async () => {
  const f = await open(new MemoryStorage());
  try {
    await f.root.submit({ type: 'input', requestId: 'work', content: 'Long work' }, context);
    const working = await f.request(0);
    for (const event of events(f.root.id)) await f.lifecycle.deliver(event);
    // An alarm drive while the run continues (the heartbeat's) delivers nothing and arms nothing either.
    await f.lifecycle.recover();
    expect(f.wakes).toEqual([]);
    expect(working.text).not.toContain('Review done');
    working.answer();
    const next = await f.request(1);
    expect(next.text).toContain('Review done');
    expect(next.text).toContain('Background command job:7 completed');
    next.answer();
    await f.root.waitForIdle(context);
    expect(f.wakes).toEqual([]);
    expect(f.reports).toEqual([]);
  } finally { await f.harness.close(context); }
});

test('events held by a run a reset cut off go in when the run the alarm drive resumes ends', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-run-end-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const before = await open(await openNodeJsonlStorage(directory, context));
  try {
    await before.root.submit({ type: 'input', requestId: 'work', content: 'Long work' }, context);
    await before.request(0);
    for (const event of events(before.root.id)) await before.lifecycle.deliver(event);
    expect(before.wakes).toEqual([]);
  } finally { await before.harness.close(context); }
  const after = await open(await openNodeJsonlStorage(directory, context));
  try {
    // The heartbeat's alarm drive: recovery, then resume.
    await after.lifecycle.recover();
    after.harness.resume();
    expect(after.wakes).toEqual([]);
    const resumed = await after.request(0);
    expect(resumed.text).toContain('Long work');
    expect(resumed.text).not.toContain('Review done');
    resumed.answer();
    const next = await after.request(1);
    expect(next.text).toContain('Review done');
    expect(next.text).toContain('Background command job:7 completed');
    next.answer();
    await after.root.waitForIdle(context);
    expect(after.wakes).toEqual([]);
    expect(after.reports).toEqual([]);
  } finally { await after.harness.close(context); }
});
