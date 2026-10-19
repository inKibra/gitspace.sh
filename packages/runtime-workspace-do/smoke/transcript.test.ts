import { expect, test } from 'bun:test';
import { Harness, MemoryStorage, createRegistry, type Conversation } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, type AssistantMessage } from '@earendil-works/pi-ai';
import { RuntimeTranscriptSchema } from '@gitspace/protocol-runtime';
import type { TranscriptRow } from '@gitspace/blocks';
import { createTranscriptReader, transcriptResponse, type WithdrawnNotices } from '../src/transcript.js';

const context = BACKGROUND_CONTEXT;
const none: WithdrawnNotices = { has: () => false, add: () => {}, count: () => 0 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(content: AssistantMessage['content'], timestamp: number): AssistantMessage {
  return { role: 'assistant', content, api: 'openai-responses', provider: 'openai', model: 'fixture', usage, stopReason: content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop', timestamp };
}
async function fixture(run: (harness: Harness, storage: MemoryStorage, root: Conversation) => Promise<void>) {
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
  try { await run(harness, storage, await harness.root(context)); } finally { await harness.close(context); }
}
/** One user turn that calls `calls` tools, each answered by its own result entry. */
async function turn(root: Conversation, index: number, calls: number) {
  await root.commit(async tx => {
    await tx.appendEntry(root.id, { kind: 'pi.user', model: [{ role: 'user', content: `prompt ${index}`, timestamp: index }] });
    for (let call = 0; call < calls; call++) {
      const id = `call-${index}-${call}`;
      await tx.appendEntry(root.id, { kind: 'pi.assistant', model: [assistant([{ type: 'toolCall', id, name: 'read', arguments: { path: `file-${call}` } }], index)] });
      await tx.appendEntry(root.id, { kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: `result ${index}-${call}` }], isError: false, timestamp: index }] });
    }
    await tx.appendEntry(root.id, { kind: 'pi.assistant', model: [assistant([{ type: 'text', text: `answer ${index}` }], index)] });
  }, context);
}

test('transcript streams read bounded ordinal ranges of a fork-aware Pi view with a fixed tail', async () => {
  await fixture(async (_harness, storage, root) => {
    const pivot = await root.commit(tx => tx.appendEntry(root.id, { kind: 'pi.user', model: [{ role: 'user', content: 'first', timestamp: 1 }, { role: 'user', content: 'second', timestamp: 2 }] }), context);
    await root.commit(tx => tx.appendEntry(root.id, { kind: 'pi.user', model: [{ role: 'user', content: 'other branch', timestamp: 3 }] }), context);
    const branch = await root.fork(pivot.id, { ownership: { kind: 'ownerless' } }, context);
    const own = await branch.commit(tx => tx.appendEntry(branch.id, { kind: 'pi.user', model: [{ role: 'user', content: 'branch', timestamp: 4 }] }), context);
    const response = await transcriptResponse(storage, branch, none);
    await branch.commit(tx => tx.appendEntry(branch.id, { kind: 'pi.user', model: [{ role: 'user', content: 'too late', timestamp: 5 }] }), context);
    const events = RuntimeTranscriptSchema.parse(await response.json());
    const ordinal = (entry: number, index: number) => entry * 1024 + index;
    expect(events.map(event => event.ordinal)).toEqual([ordinal(Number(pivot.id), 0), ordinal(Number(pivot.id), 1), ordinal(Number(own.id), 0)]);
    expect(events.every(event => event.sessionId === String(branch.id))).toBe(true);
    const tail = RuntimeTranscriptSchema.parse(await (await transcriptResponse(storage, branch, none, 'json', { from: ordinal(Number(pivot.id), 1) })).json());
    expect(tail.map(event => event.ordinal)).toEqual([ordinal(Number(pivot.id), 1), ordinal(Number(own.id), 0), ordinal(Number(own.id) + 1, 0)]);
    const newest = RuntimeTranscriptSchema.parse(await (await transcriptResponse(storage, branch, none, 'json', { newestFirst: true, before: ordinal(Number(own.id), 0) })).json());
    expect(newest.map(event => event.ordinal)).toEqual([ordinal(Number(pivot.id), 1), ordinal(Number(pivot.id), 0)]);
  });
});

test('transcript pages project bounded turn-aligned windows that page back losslessly', async () => {
  await fixture(async (_harness, storage, root) => {
    for (let index = 0; index < 12; index++) await turn(root, index, index === 6 ? 70 : 2);
    let scanned = 0;
    const scan = storage.scanEntries.bind(storage);
    storage.scanEntries = async (query, limit, cursor, ctx) => { const page = await scan(query, limit, cursor, ctx); scanned += page.items.length; return page; };
    const reader = createTranscriptReader(storage, none);
    const request = { generation: null, before: null, after: null, around: null };
    let page = await reader.page(root.id, request);
    expect(scanned).toBeLessThan(600);
    const generation = page.generation;
    const rows: TranscriptRow[] = [...page.rows];
    for (let pages = 0; page.hasBefore; pages++) {
      expect(pages).toBeLessThan(20);
      expect(page.rows.length).toBeGreaterThan(0);
      page = await reader.page(root.id, { ...request, generation, before: page.rows[0]!.ordinal });
      expect(page.rows.at(-1)!.ordinal).toBeLessThan(rows[0]!.ordinal);
      rows.unshift(...page.rows);
    }
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    const users = rows.filter(row => row.item.type === 'message' && row.item.role === 'user');
    expect(users.map(row => row.item.type === 'message' ? row.item.text : '')).toEqual(Array.from({ length: 12 }, (_value, index) => `prompt ${index}`));
    // Every call completed, including calls on pages cut inside the 70-call turn; turn identity never splits.
    const tools = rows.filter(row => row.item.type === 'tool-call');
    expect(tools).toHaveLength(92);
    expect(tools.every(row => row.item.type === 'tool-call' && row.item.status === 'done')).toBe(true);
    expect(new Set(rows.map(row => row.turnId)).size).toBe(12);
    expect(rows.every(row => row.turnStatus === 'done')).toBe(true);
    const tool = tools[30]!;
    const content = await reader.content(root.id, { generation, rowId: tool.id, offset: 0 });
    expect(JSON.parse(content.text)).toMatchObject({ id: tool.id, type: 'tool-call', status: 'done' });
    const around = await reader.page(root.id, { ...request, generation, around: users[3]!.id });
    expect(around.rows[0]!.id).toBe(users[3]!.id);
    const after = await reader.page(root.id, { ...request, generation, after: around.rows.at(-1)!.ordinal });
    expect(after.rows[0]!.ordinal).toBeGreaterThan(around.rows.at(-1)!.ordinal);
    expect(rows.findIndex(row => row.id === after.rows[0]!.id)).toBe(rows.findIndex(row => row.id === around.rows.at(-1)!.id) + 1);
  });
});

test('withdrawn notices leave the transcript while the other notices stay', async () => {
  await fixture(async (_harness, storage, root) => {
    await turn(root, 0, 1);
    const notice = (text: string) => root.commit(tx => tx.appendEntry(root.id, { kind: 'gitspace.machine-notice', data: { source: 'Machine' }, model: [{ role: 'user', content: text, timestamp: 1 }] }), context);
    const flood = await Promise.all([notice('Sync with Darktop failed: internal error; reference = a'), notice('Sync with Darktop failed: internal error; reference = b')]);
    await notice('Machine Darktop went offline.');
    await turn(root, 1, 1);
    const ids = new Set(flood.map(entry => String(entry.id)));
    const withdrawn: WithdrawnNotices = { has: id => ids.has(id), add: () => {}, count: () => ids.size };
    const page = await createTranscriptReader(storage, withdrawn).page(root.id, { generation: null, before: null, after: null, around: null });
    const text = JSON.stringify(page.rows);
    expect(text).not.toContain('Sync with Darktop failed');
    expect(text).toContain('Machine Darktop went offline.');
    expect(text).toContain('answer 1');
  });
});
