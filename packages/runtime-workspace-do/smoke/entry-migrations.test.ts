import { expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { MIGRATED_CHILD_CHARACTERS, stubCodemodeChildren } from '../src/entry-migrations.js';

/** The part of a Durable Object's SqlStorage the migration uses, over one SQLite database. */
function storage(database: Database): SqlStorage {
  const exec = (query: string, ...bindings: SQLQueryBindings[]) => {
    const rows = database.query(query).all(...bindings);
    return { toArray: () => rows, one: () => rows[0] };
  };
  return Object.assign(Object.create(null), { exec });
}

test('codemode child outputs in the range a turn reads keep their head and a note; everything else stays as it was', () => {
  const database = new Database(':memory:');
  database.run('CREATE TABLE entries(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL)');
  const add = (id: number, record: object, head: number | null = null) => database.run('INSERT INTO entries(id, conversation_id, head, commit_seq, record) VALUES(?, 1, ?, ?, ?)', [id, head, id, JSON.stringify({ id, ...record })]);
  const result = (text: string, ...rest: object[]) => ({ kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text }, ...rest], isError: false }] });
  const long = 'x'.repeat(5000);
  const image = { type: 'image', mimeType: 'image/png', data: 'stored:abc' };
  add(1, result(long));
  add(2, { kind: 'gitspace.codemode-context', edits: [{ target: 1, action: 'omit' }] });
  // The newest compaction keeps entries from 3 on: entry 1 is outside every turn's range.
  add(3, { kind: 'pi.compaction' }, 3);
  add(4, result(long, image));
  add(5, result('short'));
  add(6, { kind: 'gitspace.codemode-context', edits: [{ target: 4, action: 'omit' }, { target: 5, action: 'omit' }] });
  // A model-issued call's output, not hidden: the model reads it.
  add(7, result(long));
  const before = new Map(database.query<{ id: number; record: string }, []>('SELECT id, record FROM entries').all().map(row => [row.id, row.record]));
  const migrated = stubCodemodeChildren(storage(database));
  const after = new Map(database.query<{ id: number; record: string }, []>('SELECT id, record FROM entries').all().map(row => [row.id, row.record]));
  expect(migrated).toMatchObject({ rows: 1, bytesBefore: before.get(4)!.length, bytesAfter: after.get(4)!.length });
  const content = JSON.parse(after.get(4)!).model[0].content;
  expect(content[0].text.startsWith(`${long.slice(0, MIGRATED_CHILD_CHARACTERS)}\n[Codemode child output cut`)).toBe(true);
  expect(content[0].text.length).toBeLessThan(MIGRATED_CHILD_CHARACTERS + 200);
  expect(content.slice(1)).toEqual([image]);
  expect(JSON.parse(after.get(4)!)).toMatchObject({ id: 4, kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call', toolName: 'read', isError: false }] });
  for (const id of [1, 2, 3, 5, 6, 7]) expect(after.get(id)).toBe(before.get(id));
  // It runs once: a later open changes nothing.
  database.run('UPDATE entries SET record = ? WHERE id = 7', [JSON.stringify({ id: 7, ...result(long) })]);
  database.run('INSERT INTO entries(id, conversation_id, head, commit_seq, record) VALUES(8, 1, NULL, 8, ?)', [JSON.stringify({ id: 8, kind: 'gitspace.codemode-context', edits: [{ target: 7, action: 'omit' }] })]);
  expect(stubCodemodeChildren(storage(database))).toBeNull();
  expect(JSON.parse(database.query<{ record: string }, []>('SELECT record FROM entries WHERE id = 7').get()!.record).model[0].content[0].text).toBe(long);
});
