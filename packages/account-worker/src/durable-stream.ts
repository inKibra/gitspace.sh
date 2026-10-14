import { decodeChangeStream, streamCursorSchema, type StreamEvent } from '@gitspace/protocol-sync';
import { accountLiveKey, projectLiveKey, workspaceLiveKey, type LiveKey, type LiveNotice } from '@gitspace/protocol/live-notice';
import { RpcTarget } from 'cloudflare:workers';

/** The machine environment watch (`project.environment.watch`) still streams; browsers read `replay` after a notice. */
export interface DurableStreamSubscription {
  stream: ReadableStream<Uint8Array>;
  lifetime: RpcTarget;
}

/** RPC stream cancellation alone does not release the producer's pending pull. */
class SubscriptionLifetime extends RpcTarget {
  readonly #close: () => void;
  constructor(close: () => void) { super(); this.#close = close; }
  [Symbol.dispose](): void { this.#close(); }
}

/** Dispose the whole RPC result: the body alone does not own producer cleanup. */
export async function* consumeDurableStream<T = unknown>(subscription: Pick<DurableStreamSubscription, 'stream'> & Disposable, signal: AbortSignal): AsyncGenerator<StreamEvent<T>> {
  using owned = subscription;
  yield* decodeChangeStream(owned.stream, signal) as AsyncIterable<StreamEvent<T>>;
}

type Storage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;
const signals = new WeakMap<Storage, Set<() => void>>();
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
  private readonly listeners: Set<() => void>;
  /** Resources appended since the last `wake`, at their newest cursor. */
  private readonly appended = new Map<string, number>();
  /** `notify` receives one notice per changed resource after each committed write; it must not block the writer. */
  constructor(private readonly storage: Storage, private readonly notify?: (notices: LiveNotice[]) => void) {
    let listeners = signals.get(storage);
    if (!listeners) { listeners = new Set(); signals.set(storage, listeners); }
    this.listeners = listeners;
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
  /** After the appending transaction committed: wakes streaming watchers and tells watching tabs. */
  wake(): void {
    for (const listener of this.listeners) listener();
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
  watch(resource: string, after: number | null, snapshot: () => unknown): DurableStreamSubscription {
    if (after !== null) streamCursorSchema.parse(after);
    let cursor = after;
    let initial = true;
    let stopped = false;
    let waiting: (() => void) | undefined;
    const encoder = new TextEncoder();
    const notify = () => { waiting?.(); waiting = undefined; };
    this.listeners.add(notify);
    const close = () => { stopped = true; this.listeners.delete(notify); notify(); };
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => { source = controller; },
      pull: async (controller) => {
        try {
          while (!stopped) {
            // Install the waiter before observing durable state: commits cannot fall
            // into a read/subscribe gap, including while the consumer is backpressured.
            const changed = new Promise<void>((resolve) => { waiting = resolve; });
            const head = this.head(resource);
            const send = (event: StreamEvent<unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            if (cursor === null) {
              const value = snapshot();
              send({ type: 'snapshot', resource, cursor: head, revision: head, previous: null, value });
              cursor = head; initial = false; return;
            }
            const rows = this.storage.sql.exec<ChangeRow>('SELECT cursor,previous,value_json FROM app_changes WHERE resource=? AND cursor>? ORDER BY cursor LIMIT 64', resource, cursor).toArray();
            if (cursor > head || (cursor < head && rows[0]?.previous !== cursor)) {
              send({ type: 'resync', resource, cursor: head, revision: head, reason: cursor > head ? 'cursor-ahead' : 'cursor-expired' });
              cursor = null; continue;
            }
            if (rows.length) {
              for (const row of rows) {
                send({ type: 'change', resource, cursor: row.cursor, revision: row.cursor, previous: row.previous, value: JSON.parse(row.value_json) });
                cursor = row.cursor;
              }
              initial = false; return;
            }
            if (initial) {
              send({ type: 'snapshot', resource, cursor: head, revision: head, previous: null, value: snapshot() });
              initial = false; return;
            }
            await changed;
          }
        } catch (error) { close(); controller.error(error); }
      },
      cancel: close,
    }, { highWaterMark: 1 });
    return { stream, lifetime: new SubscriptionLifetime(() => {
      if (stopped) return;
      close();
      if (source.desiredSize !== null) source.close();
    }) };
  }
}
