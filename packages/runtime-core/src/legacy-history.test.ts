import { expect, test, onTestFinished } from 'vitest';
import { Harness, MemoryStorage, createRegistry, type Storage, type Cursor, type EntryRecord, type Conversation } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, createAssistantMessageEventStream, type Model, type Api, type AssistantMessage } from '@earendil-works/pi-ai';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { collectTranscriptProjection } from '@gitspace/blocks';
import type { TranscriptEvent } from '@gitspace/protocol-runtime/session-controls';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importLegacyHistory, readLegacyHistoryEvent, legacyHistoryProjection, LegacyHistoryDoc, LegacyHistoryChunk, LegacyHistoryEntry, type LegacyHistoryImportInput } from './legacy-history.js';

const context = BACKGROUND_CONTEXT;
const model: Model<Api> = { id: 'migration-fixture', name: 'Migration fixture', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const identity: Omit<LegacyHistoryImportInput, 'events'> = { operationId: 'migration-one', sourceDigest: 'source-sha256', source: { accountId: 'isolated-account', projectId: 'project', workspaceId: 'workspace', generation: 9, manifestHash: 'manifest-sha256', sessionId: 'canonical-session', ompSessionId: 'original-omp-session', title: 'Original conversation', originalTree: { objectKey: 'immutable/tree.jsonl', objectHash: 'tree-sha256' }, branch: { leafEntryId: 'leaf-nine' } } };
const createdAt = '2026-10-09T00:00:00.000Z';
const events: TranscriptEvent[] = [
  { ordinal: 0, kind: 'message_end', createdAt, payload: { message: { role: 'user', content: 'Historical user request', timestamp: 1 } } },
  { ordinal: 1, kind: 'message_end', createdAt, payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'Historical answer' }, { type: 'toolCall', id: 'old-call', name: 'dangerous_legacy_effect', arguments: { command: 'must never run' } }], timestamp: 2 } } },
  { ordinal: 2, kind: 'message_end', createdAt, payload: { message: { role: 'toolResult', toolCallId: 'old-call', toolName: 'dangerous_legacy_effect', content: [{ type: 'text', text: 'Original tool receipt' }], isError: false, timestamp: 3 } } },
  { ordinal: 3, kind: 'message_end', createdAt, payload: { message: { role: 'custom', customType: 'legacy-note', display: true, content: 'Original custom message' } } },
  { ordinal: 4, kind: 'legacy-extension-state', createdAt, payload: { note: 'Original extension record', branch: 'selected' } },
];
async function fixture(storage: Storage = new MemoryStorage()) {
  const seen: string[] = [];
  const harness = await Harness.open(storage, { registry: createRegistry(), models: { ...createModels(), getModel: () => model, streamSimple(_model, input) {
    seen.push(JSON.stringify(input.messages));
    const stream = createAssistantMessageEventStream();
    const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Fresh Pi response' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 10, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(reply); return stream;
  } }, settings: { compaction: { enabled: false } } }, context);
  const root = await harness.root(context, { agent: { model: { provider: 'test', modelId: model.id } } });
  return { harness, storage, root, seen, import: (source: LegacyHistoryImportInput['events'] = events) => importLegacyHistory({ ...identity, events: source, harness, storage, conversationId: root.id }) };
}
async function entries(f: { root: Conversation }) {
  const records: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do { const page = await f.root.entries({}, 128, cursor, context); records.push(...page.items); cursor = page.next; } while (cursor);
  return records.reverse();
}

test('legacy messages, tools and custom records remain readable and passive through restart; only a fresh prompt executes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-legacy-import-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const first = await fixture(await openNodeJsonlStorage(directory, context));
  const receipt = await first.import((async function* () { for (const event of events) yield { ...event, createdAt: new Date(event.createdAt) }; })());
  expect(first.seen).toEqual([]);
  expect((await first.harness.inspect(context)).tasks).toEqual([]);
  await first.harness.close(context);
  const reopened = await fixture(await openNodeJsonlStorage(directory, context));
  try {
    expect(await reopened.import()).toEqual(receipt);
    expect(receipt.source).toEqual(identity.source);
    const records = await entries(reopened);
    expect(records.filter(LegacyHistoryEntry.is)).toHaveLength(events.length);
    const recovered: TranscriptEvent[] = [];
    for (const entry of records) { const event = await readLegacyHistoryEvent(reopened.storage, entry); if (event) recovered.push(event); }
    expect(recovered).toEqual(events);
    const projection = collectTranscriptProjection(recovered.map(event => ({ ...legacyHistoryProjection(event), sessionId: 'pi-fixture' })));
    const readable = JSON.stringify(projection.turns);
    for (const text of ['Historical user request', 'Historical answer', 'Original tool receipt', 'Original custom message', 'Original extension record']) expect(readable).toContain(text);
    reopened.harness.resume();
    await reopened.harness.waitForIdle(context);
    expect(reopened.seen).toEqual([]);
    expect((await reopened.storage.scanSubmissions({}, 1, undefined, context)).items).toEqual([]);
    await reopened.root.submit({ type: 'input', requestId: 'fresh-explicit-user-message', content: 'Start fresh Pi work' }, context);
    await reopened.root.waitForIdle(context);
    expect(reopened.seen).toHaveLength(1);
    expect(reopened.seen[0]).toContain('Start fresh Pi work');
    expect(reopened.seen[0]).not.toContain('Historical');
    expect(reopened.seen[0]).not.toContain('dangerous_legacy_effect');
    expect((await entries(reopened)).flatMap(entry => entry.model ?? []).some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('Fresh Pi response'))).toBe(true);
    expect(await reopened.import()).toEqual(receipt);
    expect(reopened.seen).toHaveLength(1);
  } finally { await reopened.harness.close(context); }
});

test('a row-sized chunk interruption resumes without duplicates or losing large Unicode content', async () => {
  const f = await fixture();
  const content = 'Large preserved content \u{1D504}\n'.repeat(90_000);
  const source = [{ ordinal: 0, kind: 'message_end', createdAt, payload: { message: { role: 'user', content, timestamp: 1 } } }];
  const commit = f.harness.commit.bind(f.harness);
  let interrupted = false;
  f.harness.commit = async (change, ctx) => {
    const result = await commit(change, ctx);
    if (!interrupted && (await f.harness.snapshot(LegacyHistoryDoc, f.root.id, context))?.state?.pending) { interrupted = true; throw new Error('interrupted after durable chunk'); }
    return result;
  };
  try {
    await expect(f.import(source)).rejects.toThrow('interrupted after durable chunk');
    f.harness.commit = commit;
    const receipt = await f.import(source);
    const before = await entries(f);
    expect(before.filter(LegacyHistoryChunk.is).every(entry => new TextEncoder().encode(JSON.stringify(entry)).byteLength < 128_000)).toBe(true);
    expect(await f.import(source)).toEqual(receipt);
    expect((await entries(f)).map(entry => entry.id)).toEqual(before.map(entry => entry.id));
    const entry = before.find(LegacyHistoryEntry.is)!;
    expect((await readLegacyHistoryEvent(f.storage, entry))?.payload).toEqual(source[0]!.payload);
    expect(f.seen).toEqual([]);
  } finally { f.harness.commit = commit; await f.harness.close(context); }
});

test('interrupted imports reject changed prefixes, changed source identities, and shortened completed streams', async () => {
  const f = await fixture();
  try {
    await expect(f.import((async function* () { yield events[0]!; throw new Error('source disconnected'); })())).rejects.toThrow('source disconnected');
    await expect(f.import([{ ...events[0]!, payload: { message: { role: 'user', content: 'Changed history' } } }, ...events.slice(1)])).rejects.toThrow('prefix changed');
    await expect(importLegacyHistory({ ...identity, sourceDigest: 'different-source', events, harness: f.harness, storage: f.storage, conversationId: f.root.id })).rejects.toThrow('source conflicts');
    const receipt = await f.import();
    await expect(f.import(events.slice(0, -1))).rejects.toThrow('ended before');
    expect(await f.import()).toEqual(receipt);
    expect((await entries(f)).filter(LegacyHistoryEntry.is)).toHaveLength(events.length);
  } finally { await f.harness.close(context); }
});
