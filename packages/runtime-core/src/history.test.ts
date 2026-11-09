import { expect, test } from 'vitest';
import { searchHistory, type HistoryEvent, type HistorySearchSource } from './history.js';

/** One workspace's main conversation holding `texts`, newest last. */
function source(texts: readonly string[]): HistorySearchSource {
  const events: HistoryEvent[] = texts.map((text, index) => ({ ordinal: (index + 1) * 1024, payload: { message: { role: 'assistant', content: text } }, createdAt: new Date(Date.UTC(2026, 10, 9, 0, index)).toISOString() }));
  return {
    workspaceIds: ['mailbox'],
    conversations: async () => ['1'],
    async *events(_workspaceId, _conversationId, before) { yield* [...events].reverse().filter(event => before === undefined || event.ordinal < before); },
  };
}

const history = source([
  'Four things are still left on #1438 before it ships.',
  'Things are still moving; four of them left.',
  'The rebuild is left for later.',
]);

test('a quoted phrase must appear exactly; other words only rank', async () => {
  const everything = async (_state: string, questions: Record<string, string>) => Object.fromEntries(Object.keys(questions).map(id => [id, 1]));
  const found = await searchHistory('"Four things are still" #1438', history, everything);
  expect(found.results.map(result => result.ordinal)).toEqual([1024]);
  // Without quotes the same words match all three, best first.
  const loose = await searchHistory('four things still left', history, everything);
  expect(loose.results.map(result => result.ordinal)).toEqual([2048, 1024, 3072]);
});

test('a judge that cannot answer leaves the matches ranked by words, and says so', async () => {
  const prose = async (): Promise<Record<string, number>> => { throw new SyntaxError('Unexpected token \'T\', "The query "... is not valid JSON'); };
  const found = await searchHistory('"Four things are still"', history, prose);
  expect(found).toMatchObject({ judged: false, judgeError: expect.stringContaining('not valid JSON') });
  expect(found.results.map(result => [result.ordinal, result.relevance])).toEqual([[1024, null]]);
});
