import { expect, test } from 'vitest';
import { historySnippet, identifierParts, matchHistoryText, parseHistoryQuery, searchHistory, type HistoryHit, type HistorySearchRequest, type HistorySearchSource, type HistoryWorkspaceHits } from './history.js';

const everything = async (_state: string, questions: Record<string, string>) => Object.fromEntries(Object.keys(questions).map(id => [id, 1]));
const coverage = { complete: true, unindexedEntries: 0, scannedEvents: 0, scanComplete: true, failure: null };
const hit = (ordinal: number, score: number, snippet = `event ${ordinal}`): HistoryHit => ({ conversationId: '1', ordinal, createdAt: '2026-11-23T00:00:00.000Z', snippet, indexed: true, score });

/** Workspaces whose ranked hits are given, best first; each request pages them as a workspace object would. */
function source(ranked: Readonly<Record<string, readonly HistoryHit[]>>, requests: HistorySearchRequest[] = []): HistorySearchSource {
  return {
    workspaceIds: Object.keys(ranked),
    async search(workspaceId, request): Promise<HistoryWorkspaceHits> {
      requests.push(request);
      const hits = ranked[workspaceId] ?? [];
      return { hits: hits.slice(request.offset, request.offset + request.limit), more: hits.length > request.offset + request.limit, coverage };
    },
  };
}

test('a quoted phrase must appear exactly; words rank, prefixes and identifier parts match as the index tokenizes them', () => {
  const query = parseHistoryQuery('"Four things are still" #1438 rollout*');
  expect(query?.match).toBe('"four things are still" AND ("1438" OR "rollout"*)');
  expect(matchHistoryText('Four things are still left on #1438 before it ships.', query!)).toEqual({ matches: 2, at: 0 });
  expect(matchHistoryText('Things are still moving; four of them left.', query!)).toBeNull();
  expect(matchHistoryText('The rollouts of four things are still due.', query!)).toEqual({ matches: 2, at: 4 });
  // snake_case and hyphenated words are phrases of their parts; camelCase words also match a part.
  expect(parseHistoryQuery('snake_case foo-bar')?.match).toBe('("snake case" OR "foo bar")');
  expect(matchHistoryText('call parseHistoryQuery here', parseHistoryQuery('history')!)).toEqual({ matches: 1, at: 5 });
  expect(identifierParts('parseHistoryQuery and HTTPServer, not lowercase')).toBe('parse History Query HTTP Server');
  expect(parseHistoryQuery('"" !!')).toBeNull();
  expect(historySnippet(`${'x'.repeat(300)}needle`, 300)).toBe(`${'x'.repeat(200)}needle`);
});

test('the judge orders a page but never drops a match, and a judge that cannot answer leaves the BM25 order', async () => {
  const ranked = source({ mailbox: [hit(1024, 9), hit(2048, 5), hit(3072, 1)] });
  // The judge thinks the best BM25 match is incidental: it moves down, and stays.
  const low = async () => ({ '0': 0.1, '1': 0.9, '2': 0.5 });
  const judged = await searchHistory('bucket', ranked, low);
  expect(judged.results.map(result => [result.ordinal, result.relevance])).toEqual([[2048, 0.9], [3072, 0.5], [1024, 0.1]]);
  const prose = async (): Promise<Record<string, number>> => { throw new SyntaxError('Unexpected token \'T\', "The query "... is not valid JSON'); };
  const found = await searchHistory('bucket', ranked, prose);
  expect(found).toMatchObject({ judged: false, judgeError: expect.stringContaining('not valid JSON') });
  expect(found.results.map(result => [result.ordinal, result.relevance])).toEqual([[1024, null], [2048, null], [3072, null]]);
});

test('the cursor pages ranked matches; several workspaces merge by rank, indexed matches before scanned ones', async () => {
  const requests: HistorySearchRequest[] = [];
  const one = source({ mailbox: [hit(1024, 9), hit(2048, 5), hit(3072, 1)] }, requests);
  const first = await searchHistory('bucket', one, everything, undefined, 2);
  expect(first.results.map(result => result.ordinal)).toEqual([1024, 2048]);
  expect(first.coverage).toEqual([{ workspaceId: 'mailbox', ...coverage }]);
  const second = await searchHistory('bucket', one, everything, first.cursor ?? undefined, 2);
  expect(second.results.map(result => result.ordinal)).toEqual([3072]);
  expect(second.cursor).toBeNull();
  expect(requests.map(request => [request.offset, request.limit])).toEqual([[0, 2], [2, 2]]);

  const scanned = { ...hit(9216, 3), indexed: false };
  const two = source({ a: [hit(1024, 9), hit(2048, 2), scanned], b: [hit(4096, 5)] });
  const merged = await searchHistory('bucket', two, everything, undefined, 3);
  expect(merged.results.map(result => [result.workspaceId, result.ordinal])).toEqual([['a', 1024], ['b', 4096], ['a', 2048]]);
  const rest = await searchHistory('bucket', two, everything, merged.cursor ?? undefined, 3);
  expect(rest.results.map(result => [result.workspaceId, result.ordinal])).toEqual([['a', 9216]]);
});
