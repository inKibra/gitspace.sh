import type { WithdrawnNotices } from './transcript.js';

/** Withdrawn notices kept beside the immutable entries they hide, in the runtime's own SQLite. */
export function createWithdrawnNotices(sql: SqlStorage): WithdrawnNotices {
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_withdrawn_notices(entry_id TEXT PRIMARY KEY)');
  const ids = new Set(sql.exec<{ entry_id: string }>('SELECT entry_id FROM runtime_withdrawn_notices').toArray().map(row => row.entry_id));
  return {
    has: entryId => ids.has(entryId),
    count: () => ids.size,
    add(entryIds) {
      for (const entryId of entryIds) {
        sql.exec('INSERT OR IGNORE INTO runtime_withdrawn_notices(entry_id) VALUES(?)', entryId);
        ids.add(entryId);
      }
    },
  };
}
