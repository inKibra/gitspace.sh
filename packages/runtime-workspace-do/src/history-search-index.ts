import type { EntryRecord } from '@earendil-works/pi-durable';
import { PI_ENTRY_ORDINALS as ENTRY_ORDINALS } from '@gitspace/blocks';
import { historySnippet, identifierParts, matchHistoryText, parseHistoryQuery, searchableText, type HistoryHit, type HistoryQuery, type HistorySearchRequest, type HistoryWorkspaceHits } from '@gitspace/runtime-core/history';
import type { RunningStep } from './running-marks.js';
import { entryEvents, type WithdrawnNotices } from './transcript.js';

/** The SQL surface the index uses: Durable Object storage, or a wrapper that observes each statement. */
export type HistorySearchStorage = { sql: Pick<SqlStorage, 'exec' | 'databaseSize'>; transactionSync<T>(closure: () => T): T };
export type HistorySearchLimits = {
  /** Entry bytes one backfill step reads. */
  stepBytes: number;
  /** Entries and entry bytes one backfill transaction writes. */
  txnEntries: number;
  txnBytes: number;
  /** Entries and entry bytes one write's transaction indexes; more wait for the alarm. */
  liveEntries: number;
  liveBytes: number;
  /** Events and characters one search scans of history the index does not cover yet. */
  scanEvents: number;
  scanCharacters: number;
  /** How long one alarm's drive runs steps before it reschedules. */
  stepWindowMs: number;
};
export const HISTORY_SEARCH_LIMITS: HistorySearchLimits = { stepBytes: 4_000_000, txnEntries: 500, txnBytes: 1_000_000, liveEntries: 256, liveBytes: 4_000_000, scanEvents: 2_000, scanCharacters: 4_000_000, stepWindowMs: 5_000 };
/** One structured line per indexing step, the end of the backfill, or a failure, for Workers observability. */
export type HistorySearchEvent = { event: 'history_search_progress' | 'history_search_built' | 'history_search_step_failed' | 'history_search_live_failed' } & Record<string, string | number | null>;
/** What one backfill step did: `queued` indexed entries a write's transaction left queued; `backfill` indexed one
 * conversation's entries from its high-water mark (`remaining` of them are left). Null once nothing is left. */
export type HistorySearchStep = { phase: 'queued' | 'backfill'; conversationId: string | null; entries: number; events: number; bytes: number; remaining: number | null };
type State = { backfill_end: number; built_at: number | null; failure: string | null; failures: number; retry_at: number | null; running_since: number | null };
/** Events a search reads of one conversation's own entries: those with ordinals below `bound`, reported under the
 * conversation searched (`conversationId`, a fork reads its ancestors' entries up to the fork). */
type Segment = { owner: number; bound: number; conversationId: string };
type Candidate = { owner: number; ordinal: number; score: number };

/** A failed backfill step waits this long, doubling per consecutive failure up to `RETRY_MAX_MS`; after
 * `RETRY_ATTEMPTS` failures the backfill stops, and searches keep scanning what it did not index. */
const RETRY_FIRST_MS = 30_000, RETRY_MAX_MS = 30 * 60_000, RETRY_ATTEMPTS = 8;
const SCAN_PAGE = 32;
const ANCESTRY_LIMIT = 1000;

/**
 * Full-text search of every conversation's transcript: a contentless FTS5 table (`unicode61` words, `detail=full` for
 * phrases, BM25) whose rowid is the event's history ordinal (`entryId * 1024 + n`), so no text is stored twice; snippets
 * re-read the event. Indexed text is `searchableText` of the events `entryEvents` makes of each Pi entry, as
 * `history_read` reads them; camelCase words' parts go in a second column.
 *
 * Pi entries are immutable and only ever inserted. A trigger on Pi's `entries` table queues each new entry in the
 * transaction that writes it, and `written`, run at the end of that same transaction, indexes the queue; what it leaves
 * (a failure, a very large write) the alarm indexes, and searches scan meanwhile. Entries written before the index
 * existed (ids up to `backfill_end`) are indexed from alarms in bounded steps, each conversation from its high-water
 * mark. A search reads the index and scans only the entries it does not cover yet, saying how many (`coverage`).
 */
export class HistorySearchIndex {
  private readonly limits: HistorySearchLimits;
  private readonly unavailable: string | null = null;
  /** A drive in flight holds this lease, so two alarms do not run steps side by side. */
  private leaseUntil = 0;
  /** The first drive of an isolate checks whether the previous isolate was reset in the middle of a step. */
  private checkedReset = false;
  /** A run of failed live indexing is reported once, when it starts. */
  private liveFailing = false;
  private readonly now: () => number;

  /** Cheap enough for every open: tables, the trigger and the backfill bound are created once; nothing is indexed here. */
  constructor(private readonly options: { storage: HistorySearchStorage; withdrawn: WithdrawnNotices; schedule(timestamp: number): Promise<void>; report(error: unknown): void; log?(event: HistorySearchEvent): void; mark?(step: string, detail: string): RunningStep; limits?: Partial<HistorySearchLimits>; now?: () => number }) {
    this.limits = { ...HISTORY_SEARCH_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    const { storage } = options;
    try {
      storage.transactionSync(() => {
        storage.sql.exec('CREATE TABLE IF NOT EXISTS history_search_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), backfill_end INTEGER NOT NULL, built_at INTEGER, failure TEXT, failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, running_since INTEGER)');
        // Own entries up to `through` (and up to `backfill_end`) are indexed.
        storage.sql.exec('CREATE TABLE IF NOT EXISTS history_search_conversation(conversation_id INTEGER PRIMARY KEY, through INTEGER NOT NULL)');
        storage.sql.exec('CREATE TABLE IF NOT EXISTS history_search_pending(entry_id INTEGER PRIMARY KEY)');
        // Each indexed event and the conversation whose entry it is: searches filter by conversation, and indexing twice
        // is a no-op.
        storage.sql.exec('CREATE TABLE IF NOT EXISTS history_search_event(ordinal INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL)');
        storage.sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS history_search_fts USING fts5(body, parts, tokenize='unicode61', content='', contentless_delete=1, detail=full)");
        storage.sql.exec('INSERT OR IGNORE INTO history_search_state(singleton, backfill_end) SELECT 1, COALESCE(MAX(id), -1) FROM entries');
        storage.sql.exec('CREATE TRIGGER IF NOT EXISTS history_search_entry AFTER INSERT ON entries BEGIN INSERT OR IGNORE INTO history_search_pending(entry_id) VALUES(new.id); END');
      });
    } catch (error) {
      // History search must never keep the workspace runtime from opening; searches scan instead.
      this.unavailable = error instanceof Error ? error.message : String(error);
      options.report(error);
    }
  }

  /** At open: an index whose backfill has not finished gets an alarm. */
  scheduleBackfill(): Promise<void> {
    if (this.unavailable) return Promise.resolve();
    const state = this.state();
    return state.built_at === null && state.failures < RETRY_ATTEMPTS ? this.options.schedule(Date.now()) : Promise.resolve();
  }

  /** Runs at the end of every storage transaction, inside it: indexes the entries it wrote, so an event is searchable
   * as soon as its write commits. A failure leaves them queued for the alarm (searches scan them meanwhile) and never
   * fails the write. */
  written(): void {
    if (this.unavailable) return;
    try {
      if (this.indexPending(this.limits.liveEntries, this.limits.liveBytes).more) this.options.schedule(Date.now()).catch(this.options.report);
      this.liveFailing = false;
    } catch (error) {
      if (this.liveFailing) return;
      this.liveFailing = true;
      this.log({ event: 'history_search_live_failed', message: error instanceof Error ? error.message : String(error) });
      this.options.report(error);
    }
  }

  /** Advance the backfill for one alarm's window, rescheduling while work remains. A failed step (a throw, or a reset
   * during one) waits out a doubling backoff before the next, until retrying stops. */
  async drive(): Promise<void> {
    if (this.unavailable || Date.now() < this.leaseUntil) return;
    const state = this.state();
    if (!this.checkedReset) {
      this.checkedReset = true;
      // Set while a step runs and cleared when its drive ends: still set in a new isolate, the old one was reset during
      // the step (out of memory, or a deploy). Retrying at once would repeat what reset it.
      if (state.running_since !== null) { await this.failed(new Error(`The history indexing step started ${new Date(state.running_since).toISOString()} never finished: the workspace was reset during it`), 0); return; }
    }
    if (state.failures >= RETRY_ATTEMPTS) return;
    if (state.retry_at !== null && this.now() < state.retry_at) { await this.options.schedule(state.retry_at); return; }
    // An idle drive writes nothing.
    if (state.built_at !== null && !this.options.storage.sql.exec('SELECT 1 FROM history_search_pending LIMIT 1').toArray().length) return;
    const lease = this.leaseUntil = Date.now() + 2 * this.limits.stepWindowMs;
    try { await this.advance(); } finally {
      if (this.leaseUntil === lease) this.leaseUntil = 0;
      this.options.storage.sql.exec('UPDATE history_search_state SET running_since=NULL WHERE singleton=1 AND running_since IS NOT NULL');
    }
  }

  private async advance(): Promise<void> {
    const deadline = Date.now() + this.limits.stepWindowMs;
    const sql = this.options.storage.sql;
    for (;;) {
      const started = Date.now();
      sql.exec('UPDATE history_search_state SET running_since=? WHERE singleton=1', this.now());
      const mark = this.options.mark?.('history search', `indexing up to ${Math.round(this.limits.stepBytes / 1_000_000)} MB of transcript entries`);
      let step: HistorySearchStep | null;
      try { step = this.step(); }
      catch (error) { await this.failed(error, Date.now() - started); return; }
      finally { mark?.end(); }
      // Requests run between steps; the clock moves with this wait, so the step's time is measured.
      const pause = Promise.withResolvers<void>();
      setTimeout(pause.resolve, 0);
      await pause.promise;
      if (!step) return;
      sql.exec('UPDATE history_search_state SET failure=NULL, failures=0, retry_at=NULL WHERE singleton=1 AND (failure IS NOT NULL OR failures>0)');
      if (step.entries) this.log({ event: 'history_search_progress', ...step, stepMs: Date.now() - started });
      if (Date.now() >= deadline) { await this.options.schedule(Date.now()); return; }
    }
  }

  /** Records a failed step and when the next may run; the workspace's QA record gets the first failure of a run and the
   * one after which retrying stops. */
  private async failed(error: unknown, stepMs: number): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const failures = this.state().failures + 1;
    const retryAt = failures < RETRY_ATTEMPTS ? this.now() + Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS) : null;
    this.options.storage.sql.exec('UPDATE history_search_state SET failure=?, failures=?, retry_at=?, running_since=NULL WHERE singleton=1', message, failures, retryAt);
    this.log({ event: 'history_search_step_failed', message, stepMs, failures, retryInMs: retryAt === null ? null : retryAt - this.now() });
    if (failures === 1) this.options.report(error);
    if (retryAt === null) this.options.report(new Error(`history_search stopped indexing after ${failures} failed steps: ${message}. Searches scan the history it did not index.`));
    else await this.options.schedule(retryAt);
  }

  /** One bounded unit of work: entries left queued by writes, else the next conversation's entries from its high-water
   * mark, `stepBytes` read and written in transactions of `txnEntries`/`txnBytes`. */
  step(): HistorySearchStep | null {
    const { storage } = this.options;
    const sql = storage.sql;
    const queued = storage.transactionSync(() => this.indexPending(this.limits.txnEntries, this.limits.stepBytes));
    if (queued.entries) return { phase: 'queued', conversationId: null, entries: queued.entries, events: queued.events, bytes: queued.bytes, remaining: null };
    const state = this.state();
    const next = sql.exec<{ id: number; through: number }>('SELECT c.id, COALESCE(h.through, -1) AS through FROM conversations c LEFT JOIN history_search_conversation h ON h.conversation_id=c.id WHERE COALESCE(h.through, -1) < ? ORDER BY c.id LIMIT 1', state.backfill_end).toArray()[0];
    if (!next) {
      if (state.built_at === null) {
        sql.exec('UPDATE history_search_state SET built_at=? WHERE singleton=1', this.now());
        this.log({ event: 'history_search_built', events: sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM history_search_event').one().count, indexBytes: this.indexBytes(), databaseBytes: sql.databaseSize });
      }
      return null;
    }
    const rows: { id: number; record: string }[] = [];
    let bytes = 0, exhausted = true;
    for (const row of sql.exec<{ id: number; record: string }>('SELECT id, record FROM entries WHERE conversation_id=? AND id>? AND id<=? ORDER BY id', next.id, next.through, state.backfill_end)) {
      if (rows.length && bytes >= this.limits.stepBytes) { exhausted = false; break; }
      rows.push(row);
      bytes += row.record.length;
    }
    let events = 0, start = 0, through = next.through;
    do {
      let end = start, size = 0;
      while (end < rows.length && end - start < this.limits.txnEntries && (end === start || size < this.limits.txnBytes)) size += rows[end++]!.record.length;
      const batch = rows.slice(start, end);
      start = end;
      through = start === rows.length && exhausted ? state.backfill_end : batch.at(-1)!.id;
      events += storage.transactionSync(() => {
        let indexed = 0;
        for (const row of batch) indexed += this.indexEntry(next.id, row.record);
        sql.exec('INSERT INTO history_search_conversation(conversation_id, through) VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET through=MAX(through, excluded.through)', next.id, through);
        return indexed;
      });
    } while (start < rows.length);
    const remaining = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM entries WHERE conversation_id=? AND id>? AND id<=?', next.id, through, state.backfill_end).one().count;
    return { phase: 'backfill', conversationId: String(next.id), entries: rows.length, events, bytes, remaining };
  }

  /** Ranked hits of the conversations named (null: every conversation of the workspace), and a bounded scan of the
   * entries the index does not cover yet. */
  async search(request: HistorySearchRequest, conversations: readonly number[] | null): Promise<HistoryWorkspaceHits> {
    const query = parseHistoryQuery(request.query);
    if (!query) return { hits: [], more: false, coverage: { complete: true, unindexedEntries: 0, scannedEvents: 0, scanComplete: true, failure: this.unavailable } };
    const state = this.unavailable ? null : this.state();
    // An index created by this release has no alarm pending yet.
    if (state && state.built_at === null && state.failures < RETRY_ATTEMPTS && Date.now() >= this.leaseUntil) await this.options.schedule(Date.now());
    const segments = this.segments(conversations, request.before);
    const wanted = request.offset + request.limit + 1;
    const indexed = state ? this.indexed(query, segments, wanted) : [];
    const scan = this.scan(query, segments, state);
    const owners = new Map(segments.map(segment => [segment.owner, segment.conversationId]));
    const ranked: (Candidate | HistoryHit)[] = [...indexed, ...scan.hits];
    const hits = ranked.slice(request.offset, request.offset + request.limit).flatMap(hit => {
      if ('snippet' in hit) return [hit];
      const event = this.event(hit.ordinal, query);
      return event ? [{ conversationId: owners.get(hit.owner) ?? String(hit.owner), ordinal: hit.ordinal, createdAt: event.createdAt, snippet: event.snippet, indexed: true, score: hit.score }] : [];
    });
    return {
      hits, more: ranked.length > request.offset + request.limit,
      coverage: { complete: state !== null && scan.unindexed === 0, unindexedEntries: scan.unindexed, scannedEvents: scan.events, scanComplete: scan.complete, failure: this.unavailable ?? state?.failure ?? null },
    };
  }

  private state(): State {
    return this.options.storage.sql.exec<State>('SELECT backfill_end, built_at, failure, failures, retry_at, running_since FROM history_search_state WHERE singleton=1').one();
  }

  private log(event: HistorySearchEvent): void {
    if (this.options.log) { this.options.log(event); return; }
    if (event.event === 'history_search_progress' || event.event === 'history_search_built') console.log(JSON.stringify(event));
    else console.error(JSON.stringify(event));
  }

  /** Indexes queued entries, at most `maxEntries` and about `maxBytes`; `more` when some are left. */
  private indexPending(maxEntries: number, maxBytes: number): { entries: number; events: number; bytes: number; more: boolean } {
    const sql = this.options.storage.sql;
    const rows: { entry_id: number; conversation_id: number | null; record: string | null }[] = [];
    let bytes = 0, more = false;
    for (const row of sql.exec<{ entry_id: number; conversation_id: number | null; record: string | null }>('SELECT p.entry_id, e.conversation_id, e.record FROM history_search_pending p LEFT JOIN entries e ON e.id=p.entry_id ORDER BY p.entry_id')) {
      if (rows.length === maxEntries || (rows.length && bytes >= maxBytes)) { more = true; break; }
      rows.push(row);
      bytes += row.record?.length ?? 0;
    }
    let events = 0;
    for (const row of rows) {
      if (row.conversation_id !== null && row.record !== null) events += this.indexEntry(row.conversation_id, row.record);
      sql.exec('DELETE FROM history_search_pending WHERE entry_id=?', row.entry_id);
    }
    return { entries: rows.length, events, bytes, more };
  }

  /** Indexes one entry's events not indexed yet; returns how many it indexed. */
  private indexEntry(conversationId: number, record: string): number {
    const sql = this.options.storage.sql;
    const entry: EntryRecord = JSON.parse(record);
    let indexed = 0;
    for (const event of entryEvents(entry, undefined, this.options.withdrawn)) {
      if (!sql.exec('INSERT OR IGNORE INTO history_search_event(ordinal, conversation_id) VALUES(?,?) RETURNING ordinal', event.ordinal, conversationId).toArray().length) continue;
      const text = searchableText(event.payload);
      if (text) sql.exec('INSERT INTO history_search_fts(rowid, body, parts) VALUES(?,?,?)', event.ordinal, text, identifierParts(text));
      indexed++;
    }
    return indexed;
  }

  /** The conversations' own-entry segments: each conversation's, then its fork ancestors' up to each fork. An owner
   * reached from several conversations keeps its widest bound, reported under itself when it was named. */
  private segments(conversations: readonly number[] | null, before: number | undefined): Segment[] {
    const sql = this.options.storage.sql;
    const ids = conversations ?? sql.exec<{ id: number }>('SELECT id FROM conversations ORDER BY id').toArray().map(row => row.id);
    const segments = new Map<number, Segment>();
    for (const id of ids) {
      let owner = id, bound = before ?? Number.MAX_SAFE_INTEGER;
      for (let depth = 0; depth < ANCESTRY_LIMIT; depth++) {
        const known = segments.get(owner);
        if (!known || bound > known.bound || (bound === known.bound && owner === id)) segments.set(owner, { owner, bound, conversationId: String(id) });
        const parent = sql.exec<{ parent: number | null; at: number | null }>("SELECT json_extract(record,'$.parent.conversationId') AS parent, json_extract(record,'$.parent.at') AS at FROM conversations WHERE id=?", owner).toArray()[0];
        if (parent === undefined || parent.parent === null || parent.at === null) break;
        bound = Math.min(bound, (parent.at + 1) * ENTRY_ORDINALS);
        owner = parent.parent;
      }
    }
    return [...segments.values()];
  }

  /** The best `wanted` indexed events of the segments, BM25 first (FTS5's bm25 is lower for better matches; words
   * matched in camelCase parts weigh half). */
  private indexed(query: HistoryQuery, segments: readonly Segment[], wanted: number): Candidate[] {
    return this.options.storage.sql.exec<Candidate>(`WITH hits AS MATERIALIZED (SELECT rowid AS ordinal, bm25(history_search_fts, 1.0, 0.5) AS rank FROM history_search_fts WHERE history_search_fts MATCH ?1)
      SELECT h.ordinal, e.conversation_id AS owner, -h.rank AS score FROM hits h JOIN history_search_event e ON e.ordinal=h.ordinal
      JOIN json_each(?2) s ON json_extract(s.value, '$[0]')=e.conversation_id AND h.ordinal<json_extract(s.value, '$[1]')
      ORDER BY h.rank, h.ordinal DESC LIMIT ?3`, query.match, JSON.stringify(segments.map(segment => [segment.owner, segment.bound])), wanted).toArray();
  }

  /** Scans, newest first and within `scanEvents`/`scanCharacters`, the segments' entries the index does not cover:
   * above a conversation's high-water mark up to `backfill_end`, and entries still queued (every entry when the index
   * is unavailable). `unindexed` counts those entries whether or not the scan reached them. */
  private scan(query: HistoryQuery, segments: readonly Segment[], state: State | null): { hits: HistoryHit[]; unindexed: number; events: number; complete: boolean } {
    const sql = this.options.storage.sql;
    const where = state ? 'conversation_id=?1 AND id<=?2 AND ((id>?3 AND id<=?4) OR id IN (SELECT entry_id FROM history_search_pending))' : 'conversation_id=?1 AND id<=?2 AND id>?3 AND id<=?4';
    const hits: HistoryHit[] = [];
    let unindexed = 0, events = 0, characters = 0, complete = true;
    for (const segment of segments) {
      const upper = Math.floor((segment.bound - 1) / ENTRY_ORDINALS);
      const through = state ? sql.exec<{ through: number }>('SELECT through FROM history_search_conversation WHERE conversation_id=?', segment.owner).toArray()[0]?.through ?? -1 : -1;
      const end = state ? Math.min(upper, state.backfill_end) : upper;
      const bindings = [segment.owner, upper, through, end];
      unindexed += sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM entries WHERE ${where}`, ...bindings).one().count;
      for (let below = upper + 1; complete;) {
        const rows = sql.exec<{ id: number; record: string }>(`SELECT id, record FROM entries WHERE ${where} AND id<?5 ORDER BY id DESC LIMIT ${SCAN_PAGE}`, ...bindings, below).toArray();
        for (const row of rows) {
          if (events >= this.limits.scanEvents || characters >= this.limits.scanCharacters) { complete = false; break; }
          const entry: EntryRecord = JSON.parse(row.record);
          for (const event of entryEvents(entry, undefined, this.options.withdrawn).reverse()) {
            if (event.ordinal >= segment.bound) continue;
            // Indexed already (a write queued out of id order): the index answered for it.
            if (state && sql.exec('SELECT 1 FROM history_search_event WHERE ordinal=?', event.ordinal).toArray().length) continue;
            events++;
            const text = searchableText(event.payload);
            characters += text.length;
            const found = matchHistoryText(text, query);
            if (found) hits.push({ conversationId: segment.conversationId, ordinal: event.ordinal, createdAt: event.createdAt, snippet: historySnippet(text, found.at), indexed: false, score: found.matches });
          }
        }
        if (rows.length < SCAN_PAGE) break;
        below = rows.at(-1)!.id;
      }
    }
    hits.sort((left, right) => right.score - left.score || right.ordinal - left.ordinal);
    return { hits, unindexed, events, complete };
  }

  /** An indexed event re-read from its entry, with a snippet around its first match. */
  private event(ordinal: number, query: HistoryQuery): { createdAt: string; snippet: string } | null {
    const row = this.options.storage.sql.exec<{ record: string }>('SELECT record FROM entries WHERE id=?', Math.floor(ordinal / ENTRY_ORDINALS)).toArray()[0];
    if (!row) return null;
    const entry: EntryRecord = JSON.parse(row.record);
    const event = entryEvents(entry, undefined, this.options.withdrawn).find(item => item.ordinal === ordinal);
    if (!event) return null;
    const text = searchableText(event.payload);
    return { createdAt: event.createdAt, snippet: historySnippet(text, matchHistoryText(text, query)?.at ?? 0) };
  }

  /** Bytes of the index: FTS5's segment blocks and per-row sizes, and the event table's 16-byte rows (Durable Objects'
   * SQLite has no dbstat table). Null if a shadow table cannot be read; the line must not fail the step. */
  private indexBytes(): number | null {
    try { return this.options.storage.sql.exec<{ bytes: number }>('SELECT (SELECT COALESCE(SUM(length(block)), 0) FROM history_search_fts_data) + (SELECT COALESCE(SUM(length(sz)), 0) FROM history_search_fts_docsize) + 16 * (SELECT COUNT(*) FROM history_search_event) AS bytes').one().bytes; }
    catch { return null; }
  }
}
