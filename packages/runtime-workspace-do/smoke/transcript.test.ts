import { expect, test } from 'bun:test';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { importLegacyHistory } from '@gitspace/runtime-core';
import { RuntimeTranscriptSchema } from '@gitspace/protocol-runtime';
import { transcriptResponse } from '../src/transcript.js';

const context = BACKGROUND_CONTEXT;
test('large passive events stream chronologically with bounded scans, cancellation and a fixed fork-aware tail', async () => {
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
  try {
    const root = await harness.root(context);
    const text = 'Historical Unicode \u{1D504}\n'.repeat(210_000);
    await importLegacyHistory({ harness, storage, conversationId: root.id, operationId: 'stream-proof', sourceDigest: 'stream-source', source: { accountId: 'isolated', projectId: 'project', workspaceId: 'workspace', generation: 1, manifestHash: 'manifest', sessionId: 'source', ompSessionId: 'original', title: 'Passive history', originalTree: { objectKey: 'tree', objectHash: 'hash' }, branch: { leafEntryId: 'leaf' } }, events: (async function* () {
      for (let index = 0; index < 3; index++) yield { ordinal: index * 2, kind: 'legacy-note', payload: { index, text }, createdAt: '2026-10-09T00:00:00.000Z' };
    })() });
    const pivot = await root.commit(tx => tx.appendEntry(root.id, { kind: 'native', model: [{ role: 'user', content: 'first native', timestamp: 1 }, { role: 'user', content: 'second native', timestamp: 2 }] }), context);
    const branch = await root.fork(pivot.id, { ownership: { kind: 'ownerless' } }, context);
    let scans = 0;
    const scan = storage.scanEntries.bind(storage);
    storage.scanEntries = async (query, limit, cursor, ctx) => { expect(limit).toBeLessThanOrEqual(128); scans++; return scan(query, limit, cursor, ctx); };
    const cancelled = await transcriptResponse(storage, branch, 'ndjson');
    const initialScans = scans;
    const reader = cancelled.body!.getReader();
    const first = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(first.value)).payload).toEqual({ index: 0, text });
    expect(scans - initialScans).toBeLessThan(8);
    await reader.cancel();
    const afterCancel = scans;
    await Promise.resolve();
    expect(scans).toBe(afterCancel);
    const response = await transcriptResponse(storage, branch);
    await branch.commit(tx => tx.appendEntry(branch.id, { kind: 'native', model: [{ role: 'user', content: 'too late', timestamp: 3 }] }), context);
    const events = RuntimeTranscriptSchema.parse(await response.json());
    expect(events.map(event => event.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(events.slice(0, 3).map(event => event.payload)).toEqual([0, 1, 2].map(index => ({ index, text })));
    expect(events.slice(-2).map(event => event.payload.message)).toEqual([
      { role: 'user', content: 'first native', timestamp: 1 },
      { role: 'user', content: 'second native', timestamp: 2 },
    ]);
    expect(events.every(event => event.sessionId === String(branch.id))).toBe(true);
    expect((await harness.inspect(context)).tasks).toEqual([]);
  } finally { await harness.close(context); }
});
