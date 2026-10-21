import { expect, test } from 'bun:test';
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
  expect(mark?.detail).toBe('anthropic/opus: 3 messages, 0.7 MB (2 images, 0.6 MB)');
});
