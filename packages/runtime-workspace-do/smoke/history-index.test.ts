import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RuntimeHistoryIndex, type HistorySql, type HistoryDocument } from '@gitspace/runtime-core/history';

test('large history payload fragments round-trip Unicode and search deduplicates events before limiting', async () => {
  const database = new Database(':memory:');
  const sql: HistorySql = {
    exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: (string | number | null)[]): T[] {
      return database.query<T, (string | number | null)[]>(query).all(...bindings);
    },
  };
  try {
    const history = new RuntimeHistoryIndex(sql);
    const large: HistoryDocument = { workspaceId: 'workspace', conversationId: 'main', ordinal: 0, createdAt: '2026-10-09T00:00:00.000Z', payload: { text: `${'x'.repeat(16_373)}\u{1D504} ${'needle Unicode \u{1D504}\n'.repeat(240_000)}tail preserved` } };
    const small: HistoryDocument = { ...large, ordinal: 1, payload: { text: 'another needle result' } };
    history.index([large, small]);
    expect([...history.content('workspace', 'main', 0)].join('')).toBe(JSON.stringify(large.payload));
    expect(database.query<{ bytes: number }, []>('SELECT max(length(CAST(text AS BLOB))) AS bytes FROM gitspace_history_payload_parts').get()!.bytes).toBeLessThanOrEqual(65_536);
    const judge = async (_state: string, questions: Record<string, string>) => Object.fromEntries(Object.keys(questions).map(key => [key, 1]));
    const found = await history.search('needle', ['workspace'], judge);
    expect(found.map(result => result.ordinal).sort()).toEqual([0, 1]);
    expect(found.every(result => result.content.mode === 'content' && result.snippet.length <= 4000)).toBe(true);
    history.index([large, small]);
    expect((await history.search('needle', ['workspace'], judge)).map(result => result.ordinal).sort()).toEqual([0, 1]);
    history.index([{ ...large, payload: { text: 'replacement does not match the prior term' } }]);
    expect((await history.search('needle', ['workspace'], judge)).map(result => result.ordinal)).toEqual([1]);
    expect([...history.content('workspace', 'main', 0)].join('')).toBe('{"text":"replacement does not match the prior term"}');
    history.index([{ ...small, ordinal: 2, payload: { text: `${' '.repeat(16_380)}boundarytoken preserved` } }]);
    expect((await history.search('boundarytoken', ['workspace'], judge)).map(result => result.ordinal)).toEqual([2]);
  } finally { database.close(); }
});
