import { streamCursorSchema, type StreamEvent } from '@gitspace/protocol-sync';
import { accountLiveKey, projectLiveKey, workspaceLiveKey, type LiveKey, type LiveNotice } from '@gitspace/protocol/live-notice';

type Storage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;
interface ChangeRow extends Record<string, SqlStorageValue> { cursor: number; previous: number; value_json: string }
const RETAINED_CHANGES = 512;
/** Changes one replay returns; further behind, the reader gets the current snapshot instead. */
const REPLAY_LIMIT = 64;

/** A change-log resource as tabs watch it; the account directory reaches tabs over its own socket. */
function liveKeyOfResource(resource: string): LiveKey | null {
  const separator = resource.indexOf(':');
  const kind = separator < 0 ? resource : resource.slice(0, separator);
  const id = resource.slice(separator + 1);
  switch (kind) {
    case 'account-directory': return null;
    case 'project': return projectLiveKey(id, 'project');
    case 'environment':
    case 'space': return workspaceLiveKey(id, kind);
    default: return accountLiveKey(resource);
  }
}

/** App-owned outbox: the state writer appends within the very same transaction. */
export class DurableChangeLog {
  /** Resources appended since the last `wake`, at their newest cursor. */
  private readonly appended = new Map<string, number>();
  /** `notify` receives one notice per changed resource after each committed write; it must not block the writer. */
  constructor(private readonly storage: Storage, private readonly notify?: (notices: LiveNotice[]) => void) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS app_changes(
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, resource TEXT NOT NULL, previous INTEGER NOT NULL, value_json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS app_changes_resource ON app_changes(resource,cursor);
    CREATE TABLE IF NOT EXISTS app_change_heads(resource TEXT PRIMARY KEY,cursor INTEGER NOT NULL);`);
  }
  head(resource: string): number {
    return this.storage.sql.exec<{ cursor: number }>('SELECT cursor FROM app_change_heads WHERE resource=?', resource).toArray()[0]?.cursor ?? 0;
  }
  /** Caller owns the transaction. Do not notify until that transaction has committed. */
  append(resource: string, value: unknown): number {
    const previous = this.head(resource);
    const cursor = this.storage.sql.exec<{ cursor: number }>('INSERT INTO app_changes(resource,previous,value_json) VALUES(?,?,?) RETURNING cursor', resource, previous, JSON.stringify(value)).one().cursor;
    streamCursorSchema.parse(cursor);
    this.storage.sql.exec('INSERT INTO app_change_heads(resource,cursor) VALUES(?,?) ON CONFLICT(resource) DO UPDATE SET cursor=excluded.cursor', resource, cursor);
    this.storage.sql.exec('DELETE FROM app_changes WHERE resource=? AND cursor < COALESCE((SELECT cursor FROM app_changes WHERE resource=? ORDER BY cursor DESC LIMIT 1 OFFSET ?),0)', resource, resource, RETAINED_CHANGES - 1);
    this.appended.set(resource, cursor);
    return cursor;
  }
  /** After the appending transaction committed: tells watching tabs. */
  wake(): void {
    const notices = [...this.appended].flatMap(([resource, version]) => {
      const key = liveKeyOfResource(resource);
      return key ? [{ ...key, version }] : [];
    });
    this.appended.clear();
    if (notices.length > 0) this.notify?.(notices);
  }
  /** The events after `after`, bounded: a reader further behind than `REPLAY_LIMIT` changes gets the current snapshot.
   * `initial` answers an up-to-date reader with the snapshot instead of nothing. */
  replay<T>(resource: string, after: number | null, snapshot: () => T, initial = true): StreamEvent<T>[] {
    if (after !== null) streamCursorSchema.parse(after);
    const head = this.head(resource);
    const full = (): StreamEvent<T> => ({ type: 'snapshot', resource, cursor: head, revision: head, previous: null, value: snapshot() });
    if (after === null) return [full()];
    const rows = this.storage.sql.exec<ChangeRow>('SELECT cursor,previous,value_json FROM app_changes WHERE resource=? AND cursor>? ORDER BY cursor LIMIT ?', resource, after, REPLAY_LIMIT + 1).toArray();
    if (after > head || (after < head && rows[0]?.previous !== after)) {
      return [{ type: 'resync', resource, cursor: head, revision: head, reason: after > head ? 'cursor-ahead' : 'cursor-expired' }, full()];
    }
    if (rows.length > REPLAY_LIMIT) return [full()];
    if (!rows.length) return initial ? [full()] : [];
    return rows.map((row) => ({ type: 'change', resource, cursor: row.cursor, revision: row.cursor, previous: row.previous, value: JSON.parse(row.value_json) as T }));
  }
}
