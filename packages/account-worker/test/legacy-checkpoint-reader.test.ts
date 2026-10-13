import { describe, expect, it } from 'vitest';
import { openLegacySession } from '../src/legacy-checkpoint-reader.js';

const timestamp = '2026-09-16T01:35:45.731Z';
const header = { type: 'session', version: 3, id: 'omp', timestamp, cwd: '/saved' };
const message = (id: string, parentId: string | null, text: string) => ({ type: 'message', id, parentId, timestamp, message: { role: 'user', content: text } });
function source(records: unknown[], width = 19) {
  const bytes = new TextEncoder().encode(records.map(record => JSON.stringify(record)).join('\n'));
  return async function* () {
    for (let offset = 0; offset < bytes.byteLength; offset += width) yield bytes.subarray(offset, offset + width);
  };
}
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}

describe('legacy checkpoint tree reader', () => {
  it('reports the whole tree while projecting only the selected leaf across split UTF-8 records', async () => {
    const opened = await openLegacySession(source([
      { type: 'title', v: 1, title: 'Saved' }, header,
      message('root', null, 'A multilingual root: café 日本語'),
      message('old', 'root', 'Abandoned branch'),
      { type: 'compaction', id: 'compact', parentId: 'root', timestamp, summary: 'Retained tree metadata' },
      message('current', 'compact', 'Current branch'),
      { type: 'custom', id: 'metadata', parentId: 'current', timestamp, customType: 'saved-metadata', data: { value: 'Preserved event' } },
    ], 1), 'canonical', 'omp');
    expect(opened.tree).toEqual({ leafEntryId: 'metadata', entries: 5, messages: 3, branchEntries: 4, branchMessages: 2, leaves: 2 });
    expect(await collect(opened.events)).toEqual([
      { sessionId: 'canonical', ordinal: 1, kind: 'message_end', payload: { message: { role: 'user', content: 'A multilingual root: café 日本語' } }, createdAt: new Date(timestamp) },
      { sessionId: 'canonical', ordinal: 2, kind: 'message_end', payload: { message: { role: 'user', content: 'Current branch' } }, createdAt: new Date(timestamp) },
      { sessionId: 'canonical', ordinal: 3, kind: 'saved-metadata', payload: { value: 'Preserved event' }, createdAt: new Date(timestamp) },
    ]);
  });

  it('does not discard an oversized message spanning storage chunks', async () => {
    const content = 'Saved payload\n'.repeat(50_000);
    const opened = await openLegacySession(source([header, message('large', null, content)], 64 * 1024), 'canonical', 'omp');
    expect((await collect(opened.events))[0]?.payload).toEqual({ message: { role: 'user', content } });
  });

  it('preserves displayed and hidden custom messages as passive historical messages', async () => {
    const custom = { customType: 'async-result', display: true, content: 'Recovered tool completion', details: { status: 'done' }, attribution: { agent: 'historical' } };
    const hidden = { customType: 'mid-run-todo-nudge', display: false, content: 'Historical nudge' };
    const opened = await openLegacySession(source([
      header,
      { type: 'custom_message', id: 'visible', parentId: null, timestamp, ...custom },
      { type: 'custom_message', id: 'hidden', parentId: 'visible', timestamp, ...hidden },
    ]), 'canonical', 'omp');
    expect(await collect(opened.events)).toEqual([
      { sessionId: 'canonical', ordinal: 1, kind: 'message_end', payload: { message: { ...custom, role: 'custom' } }, createdAt: new Date(timestamp) },
      { sessionId: 'canonical', ordinal: 2, kind: 'message_end', payload: { message: { ...hidden, role: 'custom' } }, createdAt: new Date(timestamp) },
    ]);
  });

  it('rejects a corrupt abandoned branch rather than presenting the valid leaf as recovered history', async () => {
    await expect(openLegacySession(source([
      header, message('root', null, 'Root'), message('broken', 'missing', 'Broken'), message('leaf', 'root', 'Current'),
    ]), 'canonical', 'omp')).rejects.toThrow();
  });

  it('rejects duplicate tree identities and malformed UTF-8 before returning events', async () => {
    await expect(openLegacySession(source([header, message('same', null, 'First'), message('same', 'same', 'Second')]), 'canonical', 'omp')).rejects.toThrow();
    const invalid = async function* () { yield new Uint8Array([0xc3]); yield new Uint8Array([0x28]); };
    await expect(openLegacySession(invalid, 'canonical', 'omp')).rejects.toThrow();
  });

  it('distinguishes a valid empty session from missing bytes or a foreign session identity', async () => {
    const opened = await openLegacySession(source([header]), 'canonical', 'omp');
    expect(opened.tree).toEqual({ leafEntryId: null, entries: 0, messages: 0, branchEntries: 0, branchMessages: 0, leaves: 0 });
    expect(await collect(opened.events)).toEqual([]);
    await expect(openLegacySession(source([]), 'canonical', 'omp')).rejects.toThrow();
    await expect(openLegacySession(source([header]), 'canonical', 'foreign')).rejects.toThrow();
  });
});
