import { RUNTIME_WATCH_EVENT_LIMIT, RuntimeWatchEventSchema, type RuntimeSnapshot, type RuntimeWatchEvent } from '@gitspace/protocol-runtime';

/** Draft payloads may exceed SQLite's per-value limit. */
const PART_CHARS = 16_384;
/** A replay larger than this is answered with a lossless reset instead. */
const REPLAY_BYTES = 1_048_576;

/**
 * What a runtime keeps of its published snapshots. Only the cursor is stored: watchers must see a newer revision after
 * a restart, and the snapshot itself is derived state the runtime rebuilds when it opens. Deltas are kept in memory,
 * the newest `RUNTIME_WATCH_EVENT_LIMIT`; a reader behind them, or across a restart, receives a reset carrying the whole
 * snapshot. A publish therefore writes one row however large the snapshot is (it once rewrote every 16 KB part and
 * delta on each publish: 360 million rows in an hour on 2026-10-14). The composer draft is stored in parts.
 */
export function createReplicaStore(storage: DurableObjectStorage) {
  const sql = storage.sql;
  storage.transactionSync(() => {
    sql.exec('CREATE TABLE IF NOT EXISTS runtime_replica(kind TEXT NOT NULL,cursor INTEGER NOT NULL,part INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,cursor,part))');
    sql.exec('CREATE TABLE IF NOT EXISTS runtime_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),cursor INTEGER NOT NULL)');
    if (sql.exec('SELECT 1 FROM runtime_cursor').toArray().length) return;
    // One-time: the cursor of the snapshots and deltas this store used to keep; their parts are deleted.
    const stored = sql.exec<{ cursor: number | null }>("SELECT MAX(cursor) AS cursor FROM runtime_replica WHERE kind IN ('snapshot','event')").one().cursor ?? 0;
    sql.exec('INSERT INTO runtime_cursor VALUES(1,?)', stored);
    sql.exec("DELETE FROM runtime_replica WHERE kind IN ('snapshot','event')");
    sql.exec('DROP TABLE IF EXISTS runtime_projection');
    sql.exec('DROP TABLE IF EXISTS runtime_publications');
  });
  const deltas: { cursor: number; event: string }[] = [];
  return {
    draft(): string | undefined {
      const parts = sql.exec<{ payload: string }>("SELECT payload FROM runtime_replica WHERE kind='draft' ORDER BY part").toArray();
      return parts.length ? parts.map(row => row.payload).join('') : undefined;
    },
    commitDraft(revision: number, payload: string): void {
      storage.transactionSync(() => {
        sql.exec("DELETE FROM runtime_replica WHERE kind='draft'");
        let part = 0;
        for (let offset = 0; offset < payload.length;) {
          let end = Math.min(payload.length, offset + PART_CHARS);
          // SQLite encodes each value separately; never split a UTF-16 surrogate pair.
          const last = payload.charCodeAt(end - 1);
          if (end < payload.length && last >= 0xd800 && last <= 0xdbff) end--;
          sql.exec("INSERT INTO runtime_replica(kind,cursor,part,payload) VALUES('draft',?,?,?)", revision, part++, payload.slice(offset, end));
          offset = end;
        }
      });
    },
    /** The cursor of the last published snapshot. */
    cursor(): number {
      return sql.exec<{ cursor: number }>('SELECT cursor FROM runtime_cursor').one().cursor;
    },
    /** Records a published snapshot's cursor and, unless null, the delta that reached it. */
    commit(cursor: number, event: string | null): void {
      sql.exec('UPDATE runtime_cursor SET cursor=?', cursor);
      if (event === null) return;
      deltas.push({ cursor, event });
      if (deltas.length > RUNTIME_WATCH_EVENT_LIMIT) deltas.shift();
    },
    events(after: number): { event: string }[] | null {
      const newer = deltas.filter(delta => delta.cursor > after);
      if (newer.reduce((bytes, delta) => bytes + delta.event.length, 0) > REPLAY_BYTES) return null;
      return newer.map(({ event }) => ({ event }));
    },
  };
}

/** The runtime events newer than `after`: the snapshot for a first read, nothing when current, the retained delta chain
 * from `after` to `current`, or a reset carrying `current` when `after` is ahead, expired, gapped or too far behind. */
export function replicaEvents(current: RuntimeSnapshot, after: number | null, retained: (after: number) => { event: string }[] | null): RuntimeWatchEvent[] {
  if (after === null) return [{ type: 'snapshot', snapshot: current }];
  if (after === current.cursor) return [];
  if (after > current.cursor) return [{ type: 'reset', reason: 'cursor-ahead', snapshot: current }];
  const rows = retained(after);
  const deltas: RuntimeWatchEvent[] = [];
  let cursor = after;
  for (const row of rows !== null && rows.length <= RUNTIME_WATCH_EVENT_LIMIT ? rows : []) {
    const event = RuntimeWatchEventSchema.parse(JSON.parse(row.event));
    if (event.type !== 'delta' || event.baseCursor !== cursor) break;
    deltas.push(event);
    cursor = event.cursor;
  }
  return cursor === current.cursor ? deltas : [{ type: 'reset', reason: 'cursor-expired', snapshot: current }];
}
