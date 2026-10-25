import { expect, setSystemTime, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { createAssistantMessageEventStream, createModels, type Context, type Model, type Api } from '@earendil-works/pi-ai';
import { createRunningMarks } from '../src/running-marks.js';

/** The part of a Durable Object's SqlStorage running marks use, over one SQLite database a "reset" reopens. */
function storage(database: Database): SqlStorage {
  const exec = (query: string, ...bindings: SQLQueryBindings[]) => {
    const rows = database.query(query).all(...bindings);
    return { toArray: () => rows };
  };
  return Object.assign(Object.create(null), { exec });
}

test('unfinished attempts are counted across resets until the request finishes, and marks from before counting read as one', () => {
  const database = new Database(':memory:');
  database.run('CREATE TABLE runtime_unfinished(key TEXT PRIMARY KEY, started_at INTEGER NOT NULL)');
  database.run("INSERT INTO runtime_unfinished(key,started_at) VALUES('turn:old', 1)");
  const first = createRunningMarks(storage(database));
  expect(first.unfinished.begin('turn:old')).toBe(1);
  expect(first.unfinished.begin('turn:1')).toBe(0);
  // Each reset reopens the marks over the same storage.
  expect(createRunningMarks(storage(database)).unfinished.begin('turn:1')).toBe(1);
  const third = createRunningMarks(storage(database));
  expect(third.unfinished.begin('turn:1')).toBe(2);
  third.unfinished.end('turn:1');
  expect(createRunningMarks(storage(database)).unfinished.begin('turn:1')).toBe(0);
});

test('a model request a reset cut off is described by what it sent, images and tool-call arguments included', () => {
  const database = new Database(':memory:');
  const marks = createRunningMarks(storage(database));
  const pending = createAssistantMessageEventStream();
  const models = marks.models({ ...createModels(), streamSimple: () => pending });
  const model: Model<Api> = { id: 'opus', name: 'Opus', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://invalid.test', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096 };
  const screenshot = { type: 'image' as const, mimeType: 'image/png', data: 'A'.repeat(300_000) };
  const context: Context = { messages: [
    { role: 'user', content: 'Check the page', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'w', name: 'write', arguments: { path: 'big.ts', content: 'x'.repeat(50_000) } }], api: 'anthropic-messages', provider: 'anthropic', model: 'opus', stopReason: 'toolUse', timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { role: 'toolResult', toolCallId: 'r', toolName: 'read', content: [screenshot, screenshot], isError: false, timestamp: 3 },
  ] };
  void models.streamSimple(model, context);
  // The stream never ends: the next instance finds the request still marked, as after a reset.
  const [mark] = createRunningMarks(storage(database)).leftover;
  expect(mark?.step).toBe('model request');
  expect(mark?.detail).toBe('anthropic/opus: 3 messages, 0.7 MB (2 images, 0.6 MB), system 0 KB, 0 tools 0 KB');
});

test('a reply a reset cut off is described by when the provider answered and how much had arrived, by kind', async () => {
  const database = new Database(':memory:');
  const pending = createAssistantMessageEventStream();
  const answered = Promise.withResolvers<(status: number) => Promise<void>>();
  const models = createRunningMarks(storage(database)).models({ ...createModels(), streamSimple: (selected, _context, options) => { answered.resolve(async status => { await options?.onResponse?.({ status, headers: {} }, selected); }); return pending; } });
  const model: Model<Api> = { id: 'opus', name: 'Opus', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://invalid.test', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096 };
  const partial = { role: 'assistant' as const, content: [], api: 'anthropic-messages' as const, provider: 'anthropic', model: 'opus', stopReason: 'stop' as const, timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const marked = () => database.query('SELECT detail FROM runtime_running').all();
  // The clock is set, not waited on.
  setSystemTime(new Date('2026-10-21T22:00:00Z'));
  try {
    void models.streamSimple(model, { systemPrompt: 's'.repeat(3_000), messages: [{ role: 'user', content: 'Write it', timestamp: 1 }], tools: [{ name: 'write', description: 'd'.repeat(2_000), parameters: { type: 'object', properties: {} } }] });
    // The provider answers after two seconds; nothing has streamed yet.
    setSystemTime(new Date('2026-10-21T22:00:02Z'));
    await (await answered.promise)(200);
    expect(marked()).toEqual([{ detail: 'anthropic/opus: 1 messages, 0.0 MB, system 3 KB, 1 tools 2 KB; answered 200 after 2 s' }]);
    pending.push({ type: 'thinking_delta', contentIndex: 0, delta: 'a'.repeat(40_000), partial });
    await Bun.sleep(0);
    // Under five seconds: the mark still holds only the request.
    expect(marked()).toEqual([{ detail: 'anthropic/opus: 1 messages, 0.0 MB, system 3 KB, 1 tools 2 KB; answered 200 after 2 s' }]);
    setSystemTime(new Date('2026-10-21T22:00:06Z'));
    pending.push({ type: 'toolcall_delta', contentIndex: 1, delta: 'x'.repeat(120_000), partial });
    await Bun.sleep(0);
    expect(marked()).toEqual([{ detail: 'anthropic/opus: 1 messages, 0.0 MB, system 3 KB, 1 tools 2 KB; answered 200 after 2 s; reply after 6 s: 2 events, thinking 40 KB, text 0 KB, tool-call arguments 120 KB' }]);
  } finally { setSystemTime(); }
});

test('a stage a reset cut off is reported with the last progress it recorded, and arms no heartbeat', () => {
  const database = new Database(':memory:');
  let heartbeats = 0;
  const marks = createRunningMarks(storage(database), () => { heartbeats++; });
  marks.stage('conversation recovery', '3 conversations, lifecycle documents 0.1 MB').end();
  const opening = marks.stage('runtime open', 'opening storage; database 1.0 MB');
  opening.update('rebuilding the snapshot: reading conversation 7 after 6 (12.4 MB of entries read, 0.3 MB of views)');
  // A stage ends within its call: arming the heartbeat for it would wake an idle workspace again.
  expect(heartbeats).toBe(0);
  expect(marks.active()).toBe(false);
  expect(createRunningMarks(storage(database)).leftover.map(({ step, detail }) => ({ step, detail }))).toEqual([
    { step: 'runtime open', detail: 'rebuilding the snapshot: reading conversation 7 after 6 (12.4 MB of entries read, 0.3 MB of views)' },
  ]);
});

test('a compaction request a reset cut off is named as compaction, not as a turn', () => {
  const database = new Database(':memory:');
  const models = createRunningMarks(storage(database)).models({ ...createModels(), completeSimple: () => new Promise<never>(() => {}) });
  const model: Model<Api> = { id: 'opus', name: 'Opus', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://invalid.test', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096 };
  void models.completeSimple(model, { messages: [{ role: 'user', content: 'x'.repeat(250_000), timestamp: 1 }] });
  expect(createRunningMarks(storage(database)).leftover.map(({ step, detail }) => ({ step, detail }))).toEqual([
    { step: 'compaction request', detail: 'anthropic/opus: 1 messages, 0.3 MB, system 0 KB, 0 tools 0 KB' },
  ]);
});
