import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';

/** Snapshot and delta payloads may exceed SQLite's per-value limit. */
export function createReplicaStore(storage: DurableObjectStorage) {
  const sql = storage.sql;
  function put(kind: 'snapshot' | 'event' | 'draft', cursor: number, payload: string) {
    let part = 0;
    for (let offset = 0; offset < payload.length;) {
      let end = Math.min(payload.length, offset + 16_384);
      // SQLite encodes each value separately; never split a UTF-16 surrogate pair.
      const last = payload.charCodeAt(end - 1);
      if (end < payload.length && last >= 0xd800 && last <= 0xdbff) end--;
      sql.exec('INSERT INTO runtime_replica(kind,cursor,part,payload) VALUES(?,?,?,?)', kind, cursor, part++, payload.slice(offset, end));
      offset = end;
    }
  }
  storage.transactionSync(() => {
    sql.exec('CREATE TABLE IF NOT EXISTS runtime_replica(kind TEXT NOT NULL,cursor INTEGER NOT NULL,part INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,cursor,part))');
    const previous = new Set(sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('runtime_projection','runtime_publications')").toArray().map(row => row.name));
    if (previous.has('runtime_projection')) {
      for (const row of sql.exec<{ snapshot: string }>('SELECT snapshot FROM runtime_projection WHERE id=1')) {
        put('snapshot', RuntimeSnapshotSchema.parse(JSON.parse(row.snapshot)).cursor, row.snapshot);
      }
      sql.exec('DROP TABLE runtime_projection');
    }
    if (previous.has('runtime_publications')) {
      for (const row of sql.exec<{ cursor: number; event: string }>('SELECT cursor,event FROM runtime_publications ORDER BY cursor')) put('event', row.cursor, row.event);
      sql.exec('DROP TABLE runtime_publications');
    }
  });
  return {
    draft(): string | undefined {
      const parts = sql.exec<{ payload: string }>("SELECT payload FROM runtime_replica WHERE kind='draft' ORDER BY part").toArray();
      return parts.length ? parts.map(row => row.payload).join('') : undefined;
    },
    commitDraft(revision: number, payload: string): void {
      storage.transactionSync(() => {
        sql.exec("DELETE FROM runtime_replica WHERE kind='draft'");
        put('draft', revision, payload);
      });
    },
    snapshot(): string | undefined {
      const parts = sql.exec<{ payload: string }>("SELECT payload FROM runtime_replica WHERE kind='snapshot' ORDER BY part").toArray();
      return parts.length ? parts.map(row => row.payload).join('') : undefined;
    },
    commit(cursor: number, snapshot: string, event: string): void {
      storage.transactionSync(() => {
        sql.exec("DELETE FROM runtime_replica WHERE kind='snapshot'");
        put('snapshot', cursor, snapshot);
        put('event', cursor, event);
        sql.exec("DELETE FROM runtime_replica WHERE kind='event' AND cursor < ?", Math.max(0, cursor - 256));
      });
    },
    events(after: number): { event: string }[] | null {
      const bytes = sql.exec<{ bytes: number }>("SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM runtime_replica WHERE kind='event' AND cursor > ?", after).toArray()[0]?.bytes ?? 0;
      // A reset is lossless and avoids buffering an arbitrarily large replay backlog.
      if (bytes > 1_048_576) return null;
      const events: { event: string }[] = [];
      let cursor: number | undefined;
      let parts: string[] = [];
      for (const row of sql.exec<{ cursor: number; payload: string }>("SELECT cursor,payload FROM runtime_replica WHERE kind='event' AND cursor > ? ORDER BY cursor,part", after)) {
        if (cursor !== undefined && cursor !== row.cursor) { events.push({ event: parts.join('') }); parts = []; }
        cursor = row.cursor;
        parts.push(row.payload);
      }
      if (parts.length) events.push({ event: parts.join('') });
      return events;
    },
  };
}
