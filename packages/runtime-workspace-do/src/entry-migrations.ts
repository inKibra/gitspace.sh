/** Characters of text a migrated codemode child output keeps, as `CODEMODE_CHILD_OUTPUT_LIMITS` keeps of a new one. */
export const MIGRATED_CHILD_CHARACTERS = 1000;
/** Entries one statement rewrites: a Durable Object's SQLite takes at most 100 bound parameters a statement. */
const BATCH_ROWS = 90;
const NOTE = `[Codemode child output cut to its first ${MIGRATED_CHILD_CHARACTERS} characters when this conversation was migrated; the model never saw it and the script received it whole.]`;

export type ChildMigration = { rows: number; bytesBefore: number; bytesAfter: number; ms: number };

/**
 * One-time, per object: the codemode child outputs already stored at full size (up to 50 KB each) in the range a turn
 * reads, each conversation's entries from its newest compaction marker's `head` on. They are the `pi.tool-result`
 * entries a `gitspace.codemode-context` entry hides with an `omit` edit; their text items longer than
 * `MIGRATED_CHILD_CHARACTERS` keep that many characters and a note, other items (image references) stay. Entries before
 * a range are never read by a turn and are left. The rows are found in one scan inside SQLite and rewritten
 * `BATCH_ROWS` at a time, so no record is loaded into the isolate. Null when it already ran or there are no entries.
 */
export function stubCodemodeChildren(sql: SqlStorage): ChildMigration | null {
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_one_time_steps(name TEXT PRIMARY KEY)');
  if (sql.exec("SELECT 1 FROM runtime_one_time_steps WHERE name='stub-codemode-children'").toArray().length) return null;
  if (!sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries'").toArray().length) return null;
  const started = performance.now();
  const ranges = 'SELECT conversation_id, head FROM entries WHERE id IN (SELECT MAX(id) FROM entries WHERE head IS NOT NULL GROUP BY conversation_id)';
  const rows = sql.exec<{ id: number; bytes: number }>(
    `WITH targets AS (
       SELECT DISTINCT CAST(json_extract(edit.value, '$.target') AS INTEGER) AS id FROM entries c, json_each(c.record, '$.edits') edit
       WHERE json_extract(c.record, '$.kind') = 'gitspace.codemode-context' AND json_extract(edit.value, '$.action') = 'omit')
     SELECT e.id, LENGTH(CAST(e.record AS BLOB)) AS bytes FROM entries e JOIN targets t ON t.id = e.id LEFT JOIN (${ranges}) r ON r.conversation_id = e.conversation_id
     WHERE (r.head IS NULL OR e.id >= r.head) AND json_extract(e.record, '$.kind') = 'pi.tool-result' AND json_type(e.record, '$.model[0].content') = 'array'
       AND EXISTS (SELECT 1 FROM json_each(e.record, '$.model[0].content') b WHERE json_extract(b.value, '$.type') = 'text' AND LENGTH(json_extract(b.value, '$.text')) > ?)`,
    MIGRATED_CHILD_CHARACTERS,
  ).toArray();
  let bytesAfter = 0;
  for (let start = 0; start < rows.length; start += BATCH_ROWS) {
    const batch = rows.slice(start, start + BATCH_ROWS).map(row => row.id);
    const ids = batch.map(() => '?').join(',');
    sql.exec(
      `UPDATE entries SET record = json_set(record, '$.model[0].content', (
         SELECT json_group_array(CASE WHEN json_extract(b.value, '$.type') = 'text' AND LENGTH(json_extract(b.value, '$.text')) > ?1
           THEN json_object('type', 'text', 'text', substr(json_extract(b.value, '$.text'), 1, ?1) || char(10) || ?2) ELSE json(b.value) END)
         FROM json_each(entries.record, '$.model[0].content') b))
       WHERE id IN (${ids})`,
      MIGRATED_CHILD_CHARACTERS, NOTE, ...batch,
    );
    bytesAfter += sql.exec<{ bytes: number | null }>(`SELECT SUM(LENGTH(CAST(record AS BLOB))) AS bytes FROM entries WHERE id IN (${ids})`, ...batch).one().bytes ?? 0;
  }
  sql.exec("INSERT INTO runtime_one_time_steps(name) VALUES('stub-codemode-children')");
  return { rows: rows.length, bytesBefore: rows.reduce((sum, row) => sum + row.bytes, 0), bytesAfter, ms: Math.round(performance.now() - started) };
}
