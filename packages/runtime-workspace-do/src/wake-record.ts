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
