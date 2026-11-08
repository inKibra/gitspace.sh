/**
 * What an opening workspace object can tell about the instance before it, and what its database holds. An instance
 * leaves no trace when it is reset or evicted, so each open records when it opened, on which code, and each turn end
 * when it ended; the next open reads them back.
 */

/** Why the object opened, as far as the previous instance's record shows. `code-update`: it ran other code. `reset`: on
 * the same code, it was cut off while working (a running mark or a live foreground task was left behind). `cold-start`:
 * on the same code with nothing running, as after idle eviction. `first`: no previous open is recorded. */
export type ReopenReason = 'first' | 'code-update' | 'reset' | 'cold-start';
export type Reopen = {
  reason: ReopenReason;
  previousOpenAt: string | null; sincePreviousOpenMs: number | null; sinceTurnEndMs: number | null;
  previousVersion: string | null; version: string | null;
  /** Steps the previous instance was running (`runtime_running` marks it left). */
  interrupted: string[];
  /** Foreground pi tasks not yet terminal: a turn in progress when the previous instance stopped. */
  liveTasks: number;
};
/** `estimated`: `bytes` is scaled from a sample of the table's rows (see `measureTables`). */
export type TableSize = { name: string; rows: number; bytes: number; estimated: boolean };
/** Each table's rows and stored bytes (the sum of its values' byte lengths; indexes and page overhead excluded). Tables
 * past the time budget are named, not measured. */
export type DatabaseTables = { tables: TableSize[]; measuredBytes: number; unmeasured: string[]; ms: number };
export type WakeRecord = {
  reopen: Reopen;
  /** Whether the database's tables were measured within `TABLES_INTERVAL_MS`; marks them measured now if not. */
  tablesDue(): boolean;
  /** Whether pi's entries were measured within `TABLES_INTERVAL_MS`; marks them measured now if not. */
  entriesDue(): boolean;
  turnEnded(): void;
};

/** The least time between two table measurements of one object: SQLite reads are billed per row read. */
export const TABLES_INTERVAL_MS = 24 * 60 * 60_000;
/** Tables with more rows than this have their bytes estimated from a sample instead of summed whole. */
export const FULL_SCAN_ROWS = 50_000;
export const SAMPLE_ROWS = 1_000;

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function openWakeRecord(sql: SqlStorage, version: string | null, interrupted: string[], now = Date.now()): WakeRecord {
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_wakes(id INTEGER PRIMARY KEY CHECK (id = 1), opened_at INTEGER NOT NULL, version TEXT, turn_ended_at INTEGER, tables_at INTEGER)');
  for (const column of ['entries_at INTEGER', 'entries_version TEXT']) {
    try { sql.exec(`ALTER TABLE runtime_wakes ADD COLUMN ${column}`); }
    catch (error) { if (!(error instanceof Error) || !/duplicate column name/u.test(error.message)) throw error; }
  }
  const previous = sql.exec<{ opened_at: number; version: string | null; turn_ended_at: number | null }>('SELECT opened_at, version, turn_ended_at FROM runtime_wakes WHERE id = 1').toArray()[0];
  const tasksTable = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").toArray().length > 0;
  const liveTasks = tasksTable ? sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE status != 'terminal' AND background = 0").one().count : 0;
  const reason: ReopenReason = !previous ? 'first' : previous.version !== version ? 'code-update' : interrupted.length || liveTasks ? 'reset' : 'cold-start';
  sql.exec('INSERT INTO runtime_wakes(id, opened_at, version) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET opened_at = excluded.opened_at, version = excluded.version, turn_ended_at = NULL', now, version);
  return {
    reopen: {
      reason, previousOpenAt: previous ? new Date(previous.opened_at).toISOString() : null, sincePreviousOpenMs: previous ? now - previous.opened_at : null,
      sinceTurnEndMs: previous?.turn_ended_at == null ? null : now - previous.turn_ended_at,
      previousVersion: previous?.version ?? null, version, interrupted, liveTasks,
    },
    tablesDue() {
      const at = sql.exec<{ tables_at: number | null }>('SELECT tables_at FROM runtime_wakes WHERE id = 1').one().tables_at;
      if (at !== null && Date.now() - at < TABLES_INTERVAL_MS) return false;
      sql.exec('UPDATE runtime_wakes SET tables_at = ? WHERE id = 1', Date.now());
      return true;
    },
    entriesDue() {
      const row = sql.exec<{ entries_at: number | null; entries_version: string | null }>('SELECT entries_at, entries_version FROM runtime_wakes WHERE id = 1').one();
      if (row.entries_at !== null && row.entries_version === version && Date.now() - row.entries_at < TABLES_INTERVAL_MS) return false;
      sql.exec('UPDATE runtime_wakes SET entries_at = ?, entries_version = ? WHERE id = 1', Date.now(), version);
      return true;
    },
    turnEnded() { sql.exec('UPDATE runtime_wakes SET turn_ended_at = ? WHERE id = 1', Date.now()); },
  };
}

/** Every ordinary table's row count and value bytes, largest first; DO SQLite has no `dbstat`, and its own `_cf_`
 * tables refuse reads. A table of at most `FULL_SCAN_ROWS` rows is summed whole; a larger one from its newest
 * `SAMPLE_ROWS` rows (by rowid, or the first ones of a table without rowid), scaled to its row count and marked
 * `estimated`. Once `budgetMs` has passed, the remaining tables are left out. */
export function measureTables(sql: SqlStorage, budgetMs: number): DatabaseTables {
  const started = performance.now();
  const names = sql.exec<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name").toArray();
  const tables: TableSize[] = [];
  const unmeasured: string[] = [];
  for (const { name, sql: definition } of names) {
    if (performance.now() - started >= budgetMs) { unmeasured.push(name); continue; }
    const columns = sql.exec<{ name: string }>(`PRAGMA table_info(${quoted(name)})`).toArray().map(column => column.name);
    const bytes = columns.length ? columns.map(column => `COALESCE(LENGTH(CAST(${quoted(column)} AS BLOB)), 0)`).join(' + ') : '0';
    const rows = sql.exec<{ rows: number }>(`SELECT COUNT(*) AS rows FROM ${quoted(name)}`).one().rows;
    if (rows <= FULL_SCAN_ROWS) {
      tables.push({ name, rows, bytes: sql.exec<{ bytes: number | null }>(`SELECT SUM(${bytes}) AS bytes FROM ${quoted(name)}`).one().bytes ?? 0, estimated: false });
      continue;
    }
    const order = /WITHOUT\s+ROWID/iu.test(definition) ? '' : ' ORDER BY rowid DESC';
    const sample = sql.exec<{ rows: number; bytes: number | null }>(`SELECT COUNT(*) AS rows, SUM(${bytes}) AS bytes FROM (SELECT * FROM ${quoted(name)}${order} LIMIT ${SAMPLE_ROWS})`).one();
    tables.push({ name, rows, bytes: Math.round((sample.bytes ?? 0) * rows / sample.rows), estimated: true });
  }
  tables.sort((left, right) => right.bytes - left.bytes);
  return { tables, measuredBytes: tables.reduce((sum, table) => sum + table.bytes, 0), unmeasured, ms: Math.round(performance.now() - started) };
}

/** pi's stored entries as a turn reads them: the largest single entries, and per conversation its entries and bytes in
 * all and in the range pi reads to build a turn's context (from its newest compaction marker's `head`, or the start).
 * `kind` and `role` come from each entry's record; `bytes` is the record's stored length. */
export type EntrySizes = {
  largest: Array<{ id: number; conversationId: number; kind: string | null; role: string | null; at: number | null; bytes: number }>;
  conversations: Array<{ conversationId: number; entries: number; bytes: number; rangeFrom: number | null; rangeEntries: number; rangeBytes: number }>;
  /** The range's entries of every conversation together, by kind. */
  rangeKinds: Array<{ kind: string | null; entries: number; bytes: number }>;
  /** Where the range's bytes are, largest first: per entry kind, each top-level field of the record (`record.model`,
   * `record.data`…), each field of its messages (`model.content`, `model.details`…), each field of their content blocks
   * by block type (`model.content[thinking].thinkingSignature`…) and of tool results' `details`. A string counts its
   * characters, an object or array its JSON. */
  rangeFields: Array<{ kind: string | null; path: string; count: number; bytes: number }>;
  ms: number;
};

/** Measures pi's `entries` table (see `EntrySizes`): several reads of every entry, so at most once a day per object
 * and code version. Null when the database has no such table. */
export function measureEntries(sql: SqlStorage): EntrySizes | null {
  if (!sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries'").toArray().length) return null;
  const started = performance.now();
  const largest = sql.exec<{ id: number; conversation_id: number; kind: string | null; role: string | null; at: number | null; bytes: number }>(
    "SELECT id, conversation_id, json_extract(record, '$.kind') AS kind, json_extract(record, '$.model[0].role') AS role, json_extract(record, '$.model[0].timestamp') AS at, LENGTH(CAST(record AS BLOB)) AS bytes FROM entries ORDER BY bytes DESC LIMIT 20",
  ).toArray().map(row => ({ id: row.id, conversationId: row.conversation_id, kind: row.kind, role: row.role, at: row.at, bytes: row.bytes }));
  // A conversation's range starts at its newest compaction marker's `head`; without one, at its first entry.
  const ranges = 'SELECT conversation_id, head FROM entries WHERE id IN (SELECT MAX(id) FROM entries WHERE head IS NOT NULL GROUP BY conversation_id)';
  const conversations = sql.exec<{ conversation_id: number; entries: number; bytes: number; range_from: number | null; range_entries: number; range_bytes: number }>(
    `SELECT e.conversation_id, COUNT(*) AS entries, SUM(LENGTH(CAST(e.record AS BLOB))) AS bytes, r.head AS range_from,
      SUM(CASE WHEN r.head IS NULL OR e.id >= r.head THEN 1 ELSE 0 END) AS range_entries,
      SUM(CASE WHEN r.head IS NULL OR e.id >= r.head THEN LENGTH(CAST(e.record AS BLOB)) ELSE 0 END) AS range_bytes
     FROM entries e LEFT JOIN (${ranges}) r ON r.conversation_id = e.conversation_id GROUP BY e.conversation_id ORDER BY range_bytes DESC`,
  ).toArray().map(row => ({ conversationId: row.conversation_id, entries: row.entries, bytes: row.bytes, rangeFrom: row.range_from, rangeEntries: row.range_entries, rangeBytes: row.range_bytes }));
  const rangeKinds = sql.exec<{ kind: string | null; entries: number; bytes: number }>(
    `SELECT json_extract(e.record, '$.kind') AS kind, COUNT(*) AS entries, SUM(LENGTH(CAST(e.record AS BLOB))) AS bytes
     FROM entries e LEFT JOIN (${ranges}) r ON r.conversation_id = e.conversation_id WHERE r.head IS NULL OR e.id >= r.head GROUP BY kind ORDER BY bytes DESC LIMIT 15`,
  ).toArray();
  const range = `SELECT e.id, e.record, json_extract(e.record, '$.kind') AS kind FROM entries e LEFT JOIN (${ranges}) r ON r.conversation_id = e.conversation_id WHERE r.head IS NULL OR e.id >= r.head`;
  const size = 'SUM(LENGTH(CAST(f.value AS BLOB)))';
  const rangeFields = sql.exec<{ kind: string | null; path: string; count: number; bytes: number }>(
    `WITH range AS (${range})
     SELECT kind, 'record.' || f.key AS path, COUNT(*) AS count, ${size} AS bytes FROM range, json_each(range.record) f GROUP BY kind, f.key
     UNION ALL
     SELECT kind, 'model.' || f.key, COUNT(*), ${size} FROM range, json_each(range.record, '$.model') m, json_each(m.value) f GROUP BY kind, f.key
     UNION ALL
     SELECT kind, 'model.content[' || COALESCE(json_extract(b.value, '$.type'), '?') || '].' || f.key, COUNT(*), ${size}
       FROM range, json_each(range.record, '$.model') m, json_each(m.value, '$.content') b, json_each(b.value) f
       WHERE json_type(m.value, '$.content') = 'array' AND json_type(b.value) = 'object' GROUP BY kind, json_extract(b.value, '$.type'), f.key
     UNION ALL
     SELECT kind, 'model.details.' || f.key, COUNT(*), ${size}
       FROM range, json_each(range.record, '$.model') m, json_each(m.value, '$.details') f
       WHERE json_type(m.value, '$.details') = 'object' GROUP BY kind, f.key
     ORDER BY bytes DESC LIMIT 40`,
  ).toArray();
  return { largest, conversations, rangeKinds, rangeFields, ms: Math.round(performance.now() - started) };
}
