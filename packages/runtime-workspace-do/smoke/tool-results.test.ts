import { expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { createToolResultStore } from '../src/tool-results.js';

/** The part of a Durable Object's SqlStorage the store uses, over one SQLite database. */
function storage(database: Database): SqlStorage {
  const exec = (query: string, ...bindings: SQLQueryBindings[]) => {
    const rows = database.query(query).all(...bindings);
    return { toArray: () => rows };
  };
  return Object.assign(Object.create(null), { exec });
}
/** `count` numbered lines, with `needle` on line `at`. */
const numbered = (count: number, at = 0) => Array.from({ length: count }, (_, index) => `line ${index + 1}${index + 1 === at ? ' needle' : ''}\n`).join('');
const MB = 1024 * 1024;
const key = (callId: string) => ({ conversationId: '7', callId });

test('a kept output reads back by line offset and limit across its stored pages, and a reference names it', async () => {
  const database = new Database(':memory:');
  const results = createToolResultStore(storage(database), 'workspace', 500 * MB);
  const output = numbered(200_000);
  expect(await results.put({ ...key('toolu_01|call/1'), text: output })).toBe('result://workspace/7/toolu_01%7Ccall%2F1');
  expect(database.query('SELECT COUNT(*) AS pages FROM runtime_tool_result_pages').get()).toEqual({ pages: Math.ceil(output.length / (512 * 1024)) });
  expect(await results.text(key('toolu_01|call/1'))).toBe(output);
  // Line 150,000 starts 1.7 MB in, in the fourth stored page.
  const page = await results.answer(key('toolu_01|call/1'), { tool: 'read', args: { path: 'result://workspace/7/toolu_01%7Ccall%2F1', offset: 150_000, limit: 3 } });
  expect(page.split('\n').slice(0, 3)).toEqual(['line 150000', 'line 150001', 'line 150002']);
  expect(page).toContain('read again with offset 150003');
});

test('grep finds a line far past what the transcript showed, and pages its matches', async () => {
  const database = new Database(':memory:');
  const results = createToolResultStore(storage(database), 'workspace', 500 * MB);
  await results.put({ ...key('long'), text: numbered(60_000, 54_321) });
  const grep = (args: { pattern: string; offset?: number; limit?: number }) => results.answer(key('long'), { tool: 'grep', args: { path: 'result://workspace/7/long', hidden: false, gitignore: true, multiline: false, caseSensitive: true, offset: 0, limit: 1000, ...args } });
  expect(await grep({ pattern: 'needle' })).toBe('54321:line 54321 needle');
  expect(await grep({ pattern: '^line 5999[0-9]$', limit: 4 })).toBe('59990:line 59990\n59991:line 59991\n59992:line 59992\n59993:line 59993\n[More matches: grep again with offset 4]');
  expect(await grep({ pattern: '^line 5999[0-9]$', offset: 8, limit: 4 })).toBe('59998:line 59998\n59999:line 59999');
});

test('a rerun of a call replaces its earlier attempt\'s output instead of keeping both', async () => {
  const database = new Database(':memory:');
  const results = createToolResultStore(storage(database), 'workspace', 500 * MB);
  await results.put({ ...key('rerun'), text: numbered(200_000) });
  await results.put({ ...key('rerun'), text: 'second attempt' });
  expect(await results.text(key('rerun'))).toBe('second attempt');
  expect(database.query('SELECT COUNT(*) AS rows FROM runtime_tool_results').get()).toEqual({ rows: 1 });
  expect(database.query('SELECT COUNT(*) AS pages FROM runtime_tool_result_pages').get()).toEqual({ pages: 1 });
});

test('past the workspace cap the oldest outputs are pruned as one is written, and their references say so', async () => {
  const database = new Database(':memory:');
  const results = createToolResultStore(storage(database), 'workspace', 3 * MB);
  const megabyte = 'x'.repeat(MB);
  for (const callId of ['first', 'second', 'third']) await results.put({ ...key(callId), text: megabyte });
  expect(await results.text(key('first'))).toBe(megabyte);
  await results.put({ ...key('fourth'), text: megabyte });
  await expect(results.text(key('first'))).rejects.toThrow('result://workspace/7/first was pruned: a workspace keeps 3 MB of long tool outputs');
  await expect(results.answer(key('first'), { tool: 'read', args: { path: 'result://workspace/7/first' } })).rejects.toThrow('was pruned');
  for (const callId of ['second', 'third', 'fourth']) expect(await results.text(key(callId))).toBe(megabyte);
  expect(database.query('SELECT COUNT(*) AS pages FROM runtime_tool_result_pages').get()).toEqual({ pages: 3 * 2 });
  // An output larger than the whole cap is still kept: only older ones make room.
  await results.put({ ...key('huge'), text: 'y'.repeat(4 * MB) });
  for (const callId of ['second', 'third', 'fourth']) await expect(results.text(key(callId))).rejects.toThrow('was pruned');
  expect((await results.text(key('huge'))).length).toBe(4 * MB);
  await expect(results.text(key('never'))).rejects.toThrow('result://workspace/7/never names no kept tool output');
});
