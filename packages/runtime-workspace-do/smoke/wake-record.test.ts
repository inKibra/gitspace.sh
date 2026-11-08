import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { FULL_SCAN_ROWS, measureEntries, measureTables, openWakeRecord, SAMPLE_ROWS, TABLES_INTERVAL_MS } from '../src/wake-record.js';

/** The part of a Durable Object's SqlStorage the wake record uses, over one SQLite database each "instance" reopens. */
function storage(database: Database): SqlStorage {
  const exec = (query: string, ...bindings: SQLQueryBindings[]) => {
    const rows = database.query(query).all(...bindings);
    return { toArray: () => rows, one: () => rows[0] };
  };
  return Object.assign(Object.create(null), { exec });
}

afterEach(() => { setSystemTime(); });

test('each open says why the object opened, from what the previous instance recorded', () => {
  const database = new Database(':memory:');
  const sql = storage(database);
  setSystemTime(new Date('2026-11-01T10:00:00Z'));
  expect(openWakeRecord(sql, 'release-a', []).reopen).toMatchObject({ reason: 'first', previousOpenAt: null, sincePreviousOpenMs: null });
  // Idle, on the same code: evicted.
  setSystemTime(new Date('2026-11-01T10:05:00Z'));
  const second = openWakeRecord(sql, 'release-a', []);
  expect(second.reopen).toEqual({ reason: 'cold-start', previousOpenAt: '2026-11-01T10:00:00.000Z', sincePreviousOpenMs: 300_000, sinceTurnEndMs: null, previousVersion: 'release-a', version: 'release-a', interrupted: [], liveTasks: 0 });
  setSystemTime(new Date('2026-11-01T10:05:20Z'));
  second.turnEnded();
  // Cut off during a model request, 40 s after a turn ended.
  setSystemTime(new Date('2026-11-01T10:06:00Z'));
  expect(openWakeRecord(sql, 'release-a', ['model request']).reopen).toMatchObject({ reason: 'reset', sincePreviousOpenMs: 60_000, sinceTurnEndMs: 40_000, interrupted: ['model request'] });
  // Cut off between a turn's model requests: its foreground task is still live; a background one is not a turn.
  database.run('CREATE TABLE tasks(id INTEGER PRIMARY KEY, status TEXT NOT NULL, background INTEGER NOT NULL)');
  database.run("INSERT INTO tasks(status, background) VALUES ('running', 0), ('running', 1), ('terminal', 0)");
  expect(openWakeRecord(sql, 'release-a', []).reopen).toMatchObject({ reason: 'reset', liveTasks: 1, sinceTurnEndMs: null });
  // Other code, even mid-turn: the release replaced the instance.
  expect(openWakeRecord(sql, 'release-b', []).reopen).toMatchObject({ reason: 'code-update', previousVersion: 'release-a', version: 'release-b', liveTasks: 1 });
});

test('tables are measured at most once a day, across instances', () => {
  const database = new Database(':memory:');
  setSystemTime(new Date('2026-11-01T10:00:00Z'));
  expect(openWakeRecord(storage(database), null, []).tablesDue()).toBe(true);
  setSystemTime(new Date('2026-11-02T09:59:59Z'));
  expect(openWakeRecord(storage(database), null, []).tablesDue()).toBe(false);
  setSystemTime(new Date(Date.parse('2026-11-01T10:00:00Z') + TABLES_INTERVAL_MS));
  const later = openWakeRecord(storage(database), null, []);
  expect(later.tablesDue()).toBe(true);
  expect(later.tablesDue()).toBe(false);
});

test('entries have their own daily measurement, due on a database whose tables were measured before it existed', () => {
  const database = new Database(':memory:');
  database.run('CREATE TABLE runtime_wakes(id INTEGER PRIMARY KEY CHECK (id = 1), opened_at INTEGER NOT NULL, version TEXT, turn_ended_at INTEGER, tables_at INTEGER)');
  setSystemTime(new Date('2026-11-01T10:00:00Z'));
  database.run('INSERT INTO runtime_wakes(id, opened_at, tables_at) VALUES(1, ?, ?)', [Date.now(), Date.now()]);
  const opened = openWakeRecord(storage(database), null, []);
  expect(opened.tablesDue()).toBe(false);
  expect(opened.entriesDue()).toBe(true);
  setSystemTime(new Date('2026-11-02T09:59:59Z'));
  expect(openWakeRecord(storage(database), null, []).entriesDue()).toBe(false);
  setSystemTime(new Date(Date.parse('2026-11-01T10:00:00Z') + TABLES_INTERVAL_MS));
  expect(openWakeRecord(storage(database), null, []).entriesDue()).toBe(true);
});

test('entries are measured as a turn reads them: from each conversation\'s newest compaction marker\'s head, by kind, largest first', () => {
  const database = new Database(':memory:');
  database.run('CREATE TABLE entries(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL)');
  const entry = (id: number, conversation: number, kind: string, text: string, head: number | null = null) =>
    database.run('INSERT INTO entries(id, conversation_id, head, commit_seq, record) VALUES(?, ?, ?, ?, ?)', [id, conversation, head, id, JSON.stringify({ id, kind, model: [{ role: 'user', timestamp: id, content: text }] })]);
  // Conversation 1: two compactions; the newer keeps entries from 5 on, so 5, 6 (the marker) and 7 are its range.
  entry(1, 1, 'pi.input', 'a'.repeat(5000));
  entry(2, 1, 'pi.compaction', 'summary', 1);
  entry(3, 1, 'pi.input', 'b'.repeat(100));
  entry(4, 1, 'pi.input', 'c'.repeat(100));
  entry(5, 1, 'pi.tool', 'd'.repeat(2000));
  entry(6, 1, 'pi.compaction', 'summary', 5);
  entry(7, 1, 'pi.input', 'e'.repeat(300));
  // Conversation 2 never compacted: all of it is its range.
  entry(8, 2, 'pi.input', 'f'.repeat(700));
  const sizes = database.query<{ bytes: number }, [number]>('SELECT LENGTH(CAST(record AS BLOB)) AS bytes FROM entries WHERE id = ?');
  const size = (id: number) => sizes.get(id)?.bytes ?? 0;
  const measured = measureEntries(storage(database));
  expect(measured?.largest.slice(0, 3)).toEqual([
    { id: 1, conversationId: 1, kind: 'pi.input', role: 'user', at: 1, bytes: size(1) },
    { id: 5, conversationId: 1, kind: 'pi.tool', role: 'user', at: 5, bytes: size(5) },
    { id: 8, conversationId: 2, kind: 'pi.input', role: 'user', at: 8, bytes: size(8) },
  ]);
  expect(measured?.conversations).toEqual([
    { conversationId: 1, entries: 7, bytes: [1, 2, 3, 4, 5, 6, 7].reduce((sum, id) => sum + size(id), 0), rangeFrom: 5, rangeEntries: 3, rangeBytes: size(5) + size(6) + size(7) },
    { conversationId: 2, entries: 1, bytes: size(8), rangeFrom: null, rangeEntries: 1, rangeBytes: size(8) },
  ]);
  expect(measured?.rangeKinds).toEqual([
    { kind: 'pi.tool', entries: 1, bytes: size(5) },
    { kind: 'pi.input', entries: 2, bytes: size(7) + size(8) },
    { kind: 'pi.compaction', entries: 1, bytes: size(6) },
  ]);
  expect(measureEntries(storage(new Database(':memory:')))).toBeNull();
});

test('a database fixture is measured table by table, largest first, without SQLite or Durable Object internals', () => {
  const database = new Database(':memory:');
  database.run('CREATE TABLE entries(id INTEGER PRIMARY KEY, record TEXT NOT NULL, image BLOB)');
  const insert = database.prepare('INSERT INTO entries(id, record, image) VALUES (?, ?, ?)');
  for (let id = 1; id <= 40; id++) insert.run(id, 'é'.repeat(500), id % 2 ? new Uint8Array(1_000) : null);
  database.run('CREATE TABLE "odd ""name"""(value TEXT)');
  database.run(`INSERT INTO "odd ""name"""(value) VALUES ('${'v'.repeat(100)}')`);
  database.run('CREATE TABLE empty_table(value TEXT)');
  database.run('CREATE TABLE _cf_KV(key TEXT PRIMARY KEY, value BLOB)');
  database.run("INSERT INTO _cf_KV VALUES ('k', 'secret')");
  const measured = measureTables(storage(database), 60_000);
  // An "é" is two bytes stored; each id is its digits.
  const ids = 9 + 31 * 2;
  expect(measured.tables).toEqual([
    { name: 'entries', rows: 40, bytes: 40 * 1_000 + 20 * 1_000 + ids, estimated: false },
    { name: 'odd "name"', rows: 1, bytes: 100, estimated: false },
    { name: 'empty_table', rows: 0, bytes: 0, estimated: false },
  ]);
  expect(measured.measuredBytes).toBe(40 * 1_000 + 20 * 1_000 + ids + 100);
  expect(measured.unmeasured).toEqual([]);
  // Out of time before the first table: every table is named, none read.
  expect(measureTables(storage(database), 0)).toMatchObject({ tables: [], measuredBytes: 0, unmeasured: ['empty_table', 'entries', 'odd "name"'] });
});

test('a table past the full-scan bound is estimated from its newest rows, scaled to its row count', () => {
  const database = new Database(':memory:');
  database.run('CREATE TABLE history(id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  const total = FULL_SCAN_ROWS + 10_000;
  const insert = database.prepare('INSERT INTO history(id, body) VALUES (?, ?)');
  // Old rows are one byte; the newest SAMPLE_ROWS are 100, with five-digit ids.
  database.transaction(() => { for (let id = 1; id <= total; id++) insert.run(id, id > total - SAMPLE_ROWS ? 'b'.repeat(100) : 'a'); })();
  expect(measureTables(storage(database), 60_000).tables).toEqual([{ name: 'history', rows: total, bytes: 105 * total, estimated: true }]);
});
