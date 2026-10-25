import type { RuntimeGitCheckpoint } from '@gitspace/protocol-runtime';
import { createSearchMatcher, searchMatchingLines, searchTrigramQuery, type SearchArguments } from '../../protocol-runtime/src/search.js';
import { compileSearchIgnores, searchPathFilter, searchRoot, type SearchIgnoreRules } from '../../protocol-runtime/src/search-paths.js';
import type { ArtifactsRepositoryReader } from './artifacts.js';
import type { RunningStep } from './running-marks.js';

/** The SQL surface the index uses: Durable Object storage, or a wrapper that observes each statement. */
export type CodeSearchStorage = { sql: Pick<SqlStorage, 'exec'>; transactionSync<T>(closure: () => T): T };
/** Object reads for one indexing step share one repository handle. */
export type CodeSearchSource = { reader(repository: string): Pick<ArtifactsRepositoryReader, 'readTree' | 'readBlob' | 'close'> };
export type CodeSearchSnapshots = {
  /** The canonical snapshot the index converges to. */
  current(): Promise<Pick<RuntimeGitCheckpoint, 'worktreeCommit' | 'worktreeTree'> | null>;
  /** Snapshots published from `ancestor` to `descendant`, or null past `limit` or across unrecorded history. */
  distance(ancestor: string, descendant: string, limit: number): number | null;
};
export type CodeSearchLimits = {
  /** Blobs and content bytes read per step; each transaction commits at most `txnBlobs`/`txnBytes` of them. */
  stepBlobs: number; stepBytes: number; txnBlobs: number; txnBytes: number;
  /** Tree pairs diffed per step. */
  stepTrees: number;
  /** Object reads in flight at once; each blob may be as large as `blobBytes`, so this bounds memory too. */
  readConcurrency: number;
  /** A repository read that has not answered by then fails the step instead of wedging it. */
  readTimeoutMs: number;
  /** Line-aligned chunk size; a chunk row stays well under the 2 MB Durable Object value limit. */
  chunkBytes: number;
  /** Larger blobs are not indexed and are reported as skipped. Hand-written source sits far below the default: in
   * inkibra core the 99th percentile file is 112 KB and the largest source file 168 KB; what is larger is bundles,
   * data, media and changelogs. */
  blobBytes: number;
  /** More candidate chunks than this falls back to the budgeted path-ordered scan. */
  candidateChunks: number;
  /** Verification budget of one search. */
  verifyFiles: number; verifyBytes: number;
  /** Wall time one alarm spends on steps before rescheduling. */
  stepWindowMs: number;
};
/** Bounded so indexing stays far below the 128 MB isolate it shares with agent sessions (and possibly other workspaces):
 * at most `readConcurrency` blobs of `blobBytes` in flight, `stepBytes` held per step, `verifyBytes` per search. */
export const CODE_SEARCH_LIMITS: CodeSearchLimits = {
  stepBlobs: 200, stepBytes: 4 * 1024 * 1024, txnBlobs: 25, txnBytes: 1024 * 1024, stepTrees: 64, readConcurrency: 4, readTimeoutMs: 60_000,
  chunkBytes: 1024 * 1024, blobBytes: 256 * 1024, candidateChunks: 50_000, verifyFiles: 2_000, verifyBytes: 8 * 1024 * 1024, stepWindowMs: 20_000,
};
/** One structured line per indexing step or failure, for Workers observability. */
export type CodeSearchEvent = { event: 'code_search_progress' | 'code_search_step_failed' | 'code_search_blob_skipped' } & Record<string, string | number | null>;
/** What one indexing step did; null once the index serves the current snapshot and holds no garbage. */
export type CodeSearchStep = { phase: 'collect' | 'begin' | 'trees' | 'blobs' | 'publish'; items: number };
export type CodeSearchResult = {
  /** `path:line:text`, path-ordered like grep. */
  matches: string[];
  /** More matches exist past `limit`; page with `offset`. */
  truncated: boolean;
  /** The verification budget ran out before every candidate in scope was checked. */
  partial: boolean;
  indexedCommit: string;
  /** Snapshots between the indexed commit and the working copy; null when unknown. */
  behind: number | null;
  verifiedFiles: number;
  /** In-scope files without indexed content: over the size limits or unreadable. */
  skippedFiles: number;
  notes: string[];
};
type SearchState = { generation: number; served_commit: string | null; served_tree: string | null; target_commit: string | null; target_tree: string | null; build_queued: number; build_indexed: number; failure: string | null; failures: number; retry_at: number | null; running_since: number | null };
type ScopeRow = { path: string; blob_id: number; state: number; chunks: number };
type IndexedBlob = { id: number; state: number; chunks: { firstLine: number; content: string }[]; skipped?: { oid: string; message: string } };

// Blob states. GENERATED blobs are skipped by path and never read.
const PENDING = 0, TEXT = 1, BINARY = 2, TOO_LARGE = 3, UNREADABLE = 4, GENERATED = 5;
/** FTS rowid = blob id × CHUNKS_PER_BLOB + chunk ordinal. */
const CHUNKS_PER_BLOB = 4096;
const GARBAGE_ROWS = 256, SCOPE_PAGE = 256, BEHIND_LIMIT = 100;
/** A blob whose read fails this often is skipped (reported as unreadable) instead of blocking the build. */
const BLOB_ATTEMPTS = 3;
/** A failed build attempt waits this long, doubling per consecutive failure up to `RETRY_MAX_MS`. After `RETRY_ATTEMPTS`
 * failures (about an hour) indexing stops until the working copy changes again. */
const RETRY_FIRST_MS = 30_000, RETRY_MAX_MS = 30 * 60_000, RETRY_ATTEMPTS = 8;
/** Media, fonts, archives and compiled objects: binary, so never read. */
const BINARY_PATH = /\.(png|jpe?g|gif|webp|avif|bmp|ico|icns|tiff?|heic|psd|mp3|wav|flac|ogg|m4a|aac|mp4|mov|webm|mkv|avi|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|jar|pdf|exe|dll|so|dylib|wasm|class|pyc|sqlite3?)$/iu;
/** Generated text no one searches by hand: never read, and reported as skipped. */
const GENERATED_PATH = /(^|\/)node_modules\/|\.min\.(js|css)$|\.map$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum)$/u;

const kibibytes = (count: number) => `${Math.round(count / 1024)} KiB`;
/** Settles with `operation`, or rejects once `ms` pass: a read that never answers must not wedge indexing. */
function bounded<T>(operation: Promise<T>, ms: number, what: string): Promise<T> {
  // Each timer is cleared as its read settles: Workers cap the timers one invocation may hold at 10,000.
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms);
    operation.then(value => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}
/** Runs `work` over `items` with at most `limit` in flight; `more` stops new work once a budget is spent. */
async function pooled<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>, more: () => boolean = () => true): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && more()) await work(items[next++]!);
  }));
}

/** Line-aligned pieces: a match within one line never spans two chunks, so chunk-level candidates lose nothing. */
function splitChunks(id: number, bytes: Uint8Array, chunkBytes: number): IndexedBlob {
  if (bytes.includes(0)) return { id, state: BINARY, chunks: [] };
  const chunks: IndexedBlob['chunks'] = [];
  for (let start = 0, line = 0; start < bytes.length;) {
    let end = Math.min(bytes.length, start + chunkBytes);
    if (end < bytes.length) {
      const newline = bytes.lastIndexOf(10, end - 1);
      // A line longer than a chunk, or a file of too many chunks, cannot be split without losing matches.
      if (newline < start || chunks.length + 1 === CHUNKS_PER_BLOB) return { id, state: TOO_LARGE, chunks: [] };
      end = newline + 1;
    }
    const piece = bytes.subarray(start, end);
    // Cutting after a newline byte never splits a UTF-8 sequence; only the file's leading BOM is dropped, as a whole-file decode does.
    chunks.push({ firstLine: line, content: new TextDecoder('utf-8', { ignoreBOM: start > 0 }).decode(piece) });
    for (const byte of piece) if (byte === 10) line++;
    start = end;
  }
  return { id, state: TEXT, chunks };
}

/**
 * Per-workspace code search: a contentless FTS5 trigram index keyed by Git blob, so identical content is indexed once.
 * Alarm steps diff each new snapshot's trees against the served one and index changed blobs in bounded transactions.
 * File rows are versioned by generation: a search reads the last complete generation while the next is built, and the
 * build becomes visible in one statement. Rows and blobs no generation can see are collected in later steps.
 */
export class CodeSearchIndex {
  private readonly limits: CodeSearchLimits;
  private readonly unavailable: string | null = null;
  /** A drive in flight holds this lease; one whose reads wedged loses it, and a later alarm drives instead. */
  private leaseUntil = 0;
  /** The first drive of an isolate checks whether the previous isolate was reset in the middle of a build step. */
  private checkedReset = false;
  private ignores: { generation: number; rules: SearchIgnoreRules } | undefined;
  private readonly blobFailures = new Map<number, number>();
  private readonly now: () => number;

  /** `mark` records each step that reads the repository while it runs (running marks), so a reset names it and its sizes. */
  constructor(private readonly options: { storage: CodeSearchStorage; source: CodeSearchSource; repository: string; snapshots: CodeSearchSnapshots; schedule(timestamp: number): Promise<void>; report(error: unknown): void; log?(event: CodeSearchEvent): void; mark?(step: string, detail: string): RunningStep; limits?: Partial<CodeSearchLimits>; now?: () => number }) {
    const sql = options.storage.sql;
    this.limits = { ...CODE_SEARCH_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    // The hand-rolled index stored one row per (trigram, path); FTS5 replaces it.
    for (const table of ['runtime_search_trigrams', 'runtime_search_chunks', 'runtime_search_files', 'runtime_search_state']) sql.exec(`DROP TABLE IF EXISTS ${table}`);
    sql.exec('CREATE TABLE IF NOT EXISTS code_search_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL, served_commit TEXT, served_tree TEXT, target_commit TEXT, target_tree TEXT, build_queued INTEGER NOT NULL DEFAULT 0, build_indexed INTEGER NOT NULL DEFAULT 0, failure TEXT, failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, running_since INTEGER)');
    // Progress columns arrived after the first release of this table; the retry columns arrived with the 256 KiB and
    // generated-path limits, so an index that lacks them still holds blobs built under the old limits.
    const columns = new Set(sql.exec<{ name: string }>('PRAGMA table_info(code_search_state)').toArray().map(column => column.name));
    const oldLimits = !columns.has('running_since');
    for (const column of ['build_queued INTEGER NOT NULL DEFAULT 0', 'build_indexed INTEGER NOT NULL DEFAULT 0', 'failure TEXT', 'failures INTEGER NOT NULL DEFAULT 0', 'retry_at INTEGER', 'running_since INTEGER']) if (!columns.has(column.split(' ')[0]!)) sql.exec(`ALTER TABLE code_search_state ADD COLUMN ${column}`);
    sql.exec('INSERT OR IGNORE INTO code_search_state(singleton,generation) VALUES(1,0)');
    sql.exec('CREATE TABLE IF NOT EXISTS code_search_blob(id INTEGER PRIMARY KEY, oid TEXT NOT NULL UNIQUE, state INTEGER NOT NULL, chunks INTEGER NOT NULL, refs INTEGER NOT NULL)');
    sql.exec(`CREATE INDEX IF NOT EXISTS code_search_blob_pending ON code_search_blob(id) WHERE state=${PENDING}`);
    sql.exec('CREATE TABLE IF NOT EXISTS code_search_chunk(blob_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, first_line INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(blob_id,ordinal)) WITHOUT ROWID');
    // A row is visible to generations [since, until); the primary key makes a path prefix a range scan.
    sql.exec('CREATE TABLE IF NOT EXISTS code_search_file(path TEXT NOT NULL, since INTEGER NOT NULL, until INTEGER, blob_id INTEGER NOT NULL, ignore_rules INTEGER NOT NULL, PRIMARY KEY(path,since)) WITHOUT ROWID');
    sql.exec('CREATE INDEX IF NOT EXISTS code_search_file_superseded ON code_search_file(until) WHERE until IS NOT NULL');
    sql.exec('CREATE INDEX IF NOT EXISTS code_search_file_ignore ON code_search_file(path) WHERE ignore_rules=1');
    sql.exec('CREATE TABLE IF NOT EXISTS code_search_tree(prefix TEXT PRIMARY KEY, old_tree TEXT, new_tree TEXT NOT NULL) WITHOUT ROWID');
    try {
      sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS code_search_fts USING fts5(body, tokenize='trigram case_sensitive 0', content='', contentless_delete=1, detail=none)");
    } catch (error) {
      // Code search must never keep the workspace runtime from opening.
      this.unavailable = error instanceof Error ? error.message : String(error);
      options.report(error);
    }
    if (oldLimits && !this.unavailable) this.dropOverLimitBlobs();
  }

  /** Once: blobs indexed before the size and path limits leave the index, as a build under the limits would skip them. */
  private dropOverLimitBlobs(): void {
    const { storage } = this.options;
    const oversized = storage.sql.exec<{ id: number }>(`SELECT blob_id AS id FROM code_search_chunk GROUP BY blob_id HAVING SUM(length(CAST(content AS BLOB)))>?`, this.limits.blobBytes).toArray().map(row => ({ id: row.id, state: TOO_LARGE }));
    const generated = storage.sql.exec<{ id: number; path: string }>(`SELECT b.id, f.path FROM code_search_file f JOIN code_search_blob b ON b.id=f.blob_id WHERE b.state=${TEXT}`).toArray()
      .flatMap(row => BINARY_PATH.test(row.path) ? [{ id: row.id, state: BINARY }] : GENERATED_PATH.test(row.path) ? [{ id: row.id, state: GENERATED }] : []);
    if (!oversized.length && !generated.length) return;
    storage.transactionSync(() => {
      for (const blob of [...oversized, ...generated]) {
        const row = storage.sql.exec<{ chunks: number }>(`UPDATE code_search_blob SET state=?, chunks=0 WHERE id=? AND state=${TEXT} RETURNING (SELECT COUNT(*) FROM code_search_chunk WHERE blob_id=?) AS chunks`, blob.state, blob.id, blob.id).toArray()[0];
        if (!row) continue;
        for (let ordinal = 0; ordinal < row.chunks; ordinal++) storage.sql.exec('DELETE FROM code_search_fts WHERE rowid=?', blob.id * CHUNKS_PER_BLOB + ordinal);
        storage.sql.exec('DELETE FROM code_search_chunk WHERE blob_id=?', blob.id);
      }
    });
  }

  /** A snapshot was published: index it from an alarm, never inside the publishing request. A build that stopped
   * retrying tries again. */
  changed(): Promise<void> {
    if (this.unavailable) return Promise.resolve();
    this.options.storage.sql.exec('UPDATE code_search_state SET failures=0, retry_at=NULL WHERE singleton=1 AND failures>=?', RETRY_ATTEMPTS);
    return this.options.schedule(Date.now());
  }

  /** Advance indexing for one alarm's window, rescheduling while work remains. Steps are safe to run concurrently;
   * the lease only keeps two drives from duplicating reads, and never makes a caller wait on another's promise.
   * A failed attempt (a thrown step, or a reset during one) waits out a doubling backoff before the next, until retrying
   * stops. */
  async drive(): Promise<void> {
    if (this.unavailable) return;
    if (Date.now() < this.leaseUntil) return;
    const state = this.state();
    if (!this.checkedReset) {
      this.checkedReset = true;
      // Set while a build step runs and cleared when its drive ends: still set in a new isolate, the old one was
      // reset during the step (out of memory, or a deploy). Retrying at once would repeat what reset it.
      if (state.running_since !== null) { await this.failed(new Error(`The indexing run started ${new Date(state.running_since).toISOString()} never finished: the workspace was reset during it`), 0); return; }
    }
    if (state.failures >= RETRY_ATTEMPTS) return;
    if (state.retry_at !== null && this.now() < state.retry_at) { await this.options.schedule(state.retry_at); return; }
    const lease = this.leaseUntil = Date.now() + this.limits.stepWindowMs + 2 * this.limits.readTimeoutMs;
    try { await this.advance(); } finally {
      if (this.leaseUntil === lease) this.leaseUntil = 0;
      this.options.storage.sql.exec('UPDATE code_search_state SET running_since=NULL WHERE singleton=1 AND running_since IS NOT NULL');
    }
  }

  private async advance(): Promise<void> {
    const deadline = Date.now() + this.limits.stepWindowMs;
    const sql = this.options.storage.sql;
    for (;;) {
      const started = Date.now();
      // Only build steps read the repository; marking them alone keeps idle drives free of writes.
      if (this.state().target_tree !== null) sql.exec('UPDATE code_search_state SET running_since=? WHERE singleton=1 AND running_since IS NULL', this.now());
      let step: CodeSearchStep | null;
      try { step = await this.step(); }
      catch (error) { await this.failed(error, Date.now() - started); return; }
      if (!step) return;
      sql.exec('UPDATE code_search_state SET failure=NULL, failures=0, retry_at=NULL WHERE singleton=1 AND (failure IS NOT NULL OR failures>0)');
      this.log({ event: 'code_search_progress', repository: this.options.repository, phase: step.phase, items: step.items, stepMs: Date.now() - started, ...this.progress() });
      if (Date.now() >= deadline) { await this.options.schedule(Date.now()); return; }
    }
  }

  /** Records a failed attempt and when the next may run. The log line is written every time; the workspace QA record
   * gets a run of failures twice: when it starts and when retrying stops. */
  private async failed(error: unknown, stepMs: number): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const failures = this.state().failures + 1;
    const retryAt = failures < RETRY_ATTEMPTS ? this.now() + Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS) : null;
    this.options.storage.sql.exec('UPDATE code_search_state SET failure=?, failures=?, retry_at=?, running_since=NULL WHERE singleton=1', message, failures, retryAt);
    this.log({ event: 'code_search_step_failed', repository: this.options.repository, message, stepMs, failures, retryInMs: retryAt === null ? null : retryAt - this.now(), ...this.progress() });
    if (failures === 1) this.options.report(error);
    if (retryAt === null) this.options.report(new Error(`code_search stopped retrying after ${failures} failed indexing steps: ${message}. The next change to the working copy tries again.`));
    else await this.options.schedule(retryAt);
  }

  /** One bounded unit of work. */
  async step(): Promise<CodeSearchStep | null> {
    const collected = this.collectGarbage();
    if (collected) return { phase: 'collect', items: collected };
    const state = this.state();
    if (state.target_tree === null) {
      const current = await this.options.snapshots.current();
      if (!current || current.worktreeCommit === state.served_commit) return null;
      this.begin(current);
      return { phase: 'begin', items: 1 };
    }
    const trees = await this.diffTrees(state.generation + 1);
    if (trees) return { phase: 'trees', items: trees };
    const blobs = await this.indexBlobs();
    if (blobs) return { phase: 'blobs', items: blobs };
    // Every changed path and blob is in place: the next generation becomes visible in one statement.
    this.options.storage.sql.exec(`UPDATE code_search_state SET generation=generation+1, served_commit=target_commit, served_tree=target_tree, target_commit=NULL, target_tree=NULL
      WHERE singleton=1 AND target_tree IS NOT NULL AND NOT EXISTS (SELECT 1 FROM code_search_tree) AND NOT EXISTS (SELECT 1 FROM code_search_blob WHERE state=${PENDING})`);
    return { phase: 'publish', items: 1 };
  }

  /** Build counters for logs and for the answer a search gives while the first index is built. Pending trees are counted
   * up to 1000, so a step's log line never scans a large listing frontier. */
  private progress() {
    const state = this.state();
    const trees = this.options.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM (SELECT 1 FROM code_search_tree LIMIT 1001)').one().count;
    return { servedCommit: state.served_commit, targetCommit: state.target_commit, queuedFiles: state.build_queued, indexedFiles: state.build_indexed, pendingFiles: state.build_queued - state.build_indexed, pendingTrees: trees > 1000 ? '1000+' : trees, failure: state.failure };
  }

  private log(event: CodeSearchEvent): void {
    if (this.options.log) { this.options.log(event); return; }
    if (event.event === 'code_search_progress') console.log(JSON.stringify(event));
    else console.error(JSON.stringify(event));
  }

  async search(input: SearchArguments): Promise<CodeSearchResult> {
    if (this.unavailable) throw new Error(`code_search is unavailable in this workspace (${this.unavailable}); use grep on an attached machine`);
    const current = await this.options.snapshots.current();
    const pending = this.state();
    // A snapshot published before this index existed has no alarm pending yet.
    if (current && current.worktreeCommit !== pending.served_commit && pending.target_tree === null) await this.options.schedule(Date.now());
    // Read after the last await: the synchronous search below sees one generation, which no step can collect meanwhile.
    const state = this.state();
    const stale = current !== null && current.worktreeCommit !== state.served_commit;
    const commit = state.served_commit;
    if (commit === null) {
      const progress = this.progress();
      const counted = progress.targetCommit === null ? 'starting' : `${progress.indexedFiles} of ${progress.queuedFiles}${progress.pendingTrees ? '+' : ''} files indexed${progress.pendingTrees ? `, ${progress.pendingTrees} directories left to list` : ''}`;
      throw new Error(`code_search is building the first index: ${counted}${progress.failure ? ` (${state.failures >= RETRY_ATTEMPTS ? 'indexing stopped after failed steps until the working copy changes' : 'the last step failed and is retried'}: ${progress.failure})` : ''}; retry shortly, or use grep on an attached machine`);
    }
    const { generation } = state;
    const sql = this.options.storage.sql;
    const { args, regex } = createSearchMatcher(input);
    try {
      const root = searchRoot(args.path);
      const accepts = searchPathFilter(args, args.gitignore ? this.ignoreRules(generation) : []);
      const query = searchTrigramQuery(regex.syntax());
      const candidates = query === null ? null : this.candidates(query);
      const matches: string[] = [];
      let matched = 0, truncated = false, verifiedFiles = 0, verifiedBytes = 0, skippedFiles = 0, stoppedAt: string | null = null;
      outer: for (const file of this.scope(root, generation)) {
        if (!accepts(file.path) || file.state === BINARY) continue;
        if (file.state !== TEXT) { skippedFiles++; continue; }
        // Multiline matches may cross chunk boundaries, so every chunk of a multi-chunk file is a candidate.
        const ordinals = candidates === null || (args.multiline && file.chunks > 1) ? null : candidates.get(file.blob_id);
        if (ordinals === undefined) continue;
        if (verifiedFiles === this.limits.verifyFiles || verifiedBytes >= this.limits.verifyBytes) { stoppedAt = file.path; break; }
        verifiedFiles++;
        const chunks = ordinals === null
          ? sql.exec<{ first_line: number; content: string }>('SELECT first_line, content FROM code_search_chunk WHERE blob_id=? ORDER BY ordinal', file.blob_id).toArray()
          : ordinals.map(ordinal => sql.exec<{ first_line: number; content: string }>('SELECT first_line, content FROM code_search_chunk WHERE blob_id=? AND ordinal=?', file.blob_id, ordinal).one());
        for (const chunk of args.multiline ? [{ first_line: 0, content: chunks.map(piece => piece.content).join('') }] : chunks) {
          verifiedBytes += chunk.content.length;
          for (const { line, text } of searchMatchingLines(regex, args.multiline, chunk.content)) {
            if (matched++ < args.offset) continue;
            if (matches.length === args.limit) { truncated = true; break outer; }
            matches.push(`${file.path}:${chunk.first_line + line + 1}:${text}`);
          }
        }
      }
      const behind = stale ? this.options.snapshots.distance(commit, current.worktreeCommit, BEHIND_LIMIT) : 0;
      const notes: string[] = [];
      if (stoppedAt !== null) notes.push(`Verified ${verifiedFiles} files in path order and stopped before ${stoppedAt}${query === null ? ': the pattern has no 3-character literal to look up in the index' : candidates === null ? ': too many files contain the pattern\'s literals' : ''}. Narrow path, glob or pattern, or use grep on an attached machine for an exhaustive search.`);
      if (skippedFiles) notes.push(`${skippedFiles} files in scope are not indexed (over ${this.limits.blobBytes / 1024} KiB, a line over ${this.limits.chunkBytes / 1024} KiB, generated (minified, a source map or a lockfile), or unreadable); grep on an attached machine searches them.`);
      if (stale) notes.push(`The index is at ${commit}, ${behind === null ? 'an unknown number of' : behind} snapshot(s) behind the working copy; ${state.failures >= RETRY_ATTEMPTS ? 'indexing stopped after failed steps until the working copy changes' : 'newer changes are being indexed'}${state.target_commit === null ? '' : ` (${state.build_indexed} of ${state.build_queued} changed files done)`}${state.failure ? `; the last indexing step failed${state.failures >= RETRY_ATTEMPTS ? '' : ' and is retried'}: ${state.failure}` : ''}.`);
      return { matches, truncated, partial: stoppedAt !== null, indexedCommit: commit, behind, verifiedFiles, skippedFiles, notes };
    } finally { regex.free(); }
  }

  private state(): SearchState {
    return this.options.storage.sql.exec<SearchState>('SELECT generation, served_commit, served_tree, target_commit, target_tree, build_queued, build_indexed, failure, failures, retry_at, running_since FROM code_search_state WHERE singleton=1').one();
  }

  private begin(current: Pick<RuntimeGitCheckpoint, 'worktreeCommit' | 'worktreeTree'>): void {
    const { storage } = this.options;
    storage.transactionSync(() => {
      // Re-read inside the transaction: a concurrent drive may have begun this build already.
      const state = this.state();
      if (state.target_tree !== null || state.served_commit === current.worktreeCommit) return;
      if (current.worktreeTree === state.served_tree) {
        storage.sql.exec('UPDATE code_search_state SET served_commit=? WHERE singleton=1', current.worktreeCommit);
        return;
      }
      storage.sql.exec('UPDATE code_search_state SET target_commit=?, target_tree=?, build_queued=0, build_indexed=0 WHERE singleton=1', current.worktreeCommit, current.worktreeTree);
      storage.sql.exec('INSERT INTO code_search_tree(prefix,old_tree,new_tree) VALUES(?,?,?)', '', state.served_tree, current.worktreeTree);
    });
  }

  /** Unchanged subtrees are never read: only tree pairs whose ids differ are queued. Returns the pairs diffed. */
  private async diffTrees(next: number): Promise<number> {
    const { storage, source, repository } = this.options;
    const pairs = storage.sql.exec<{ prefix: string; old_tree: string | null; new_tree: string }>('SELECT prefix, old_tree, new_tree FROM code_search_tree LIMIT ?', this.limits.stepTrees).toArray();
    if (!pairs.length) return 0;
    const mark = this.options.mark?.('code search', `listing ${pairs.length} changed directories, ${this.limits.readConcurrency} at a time`);
    try {
      const reader = source.reader(repository);
      const read = async (oid: string | null, prefix: string) => {
        if (oid === null) return [];
        const entries = await bounded(reader.readTree(oid), this.limits.readTimeoutMs, `Reading tree ${oid} (${prefix || '/'})`);
        if (!entries) throw new Error(`Search tree ${oid} for ${prefix || '/'} is missing from the workspace repository`);
        return entries;
      };
      const diffs: { prefix: string; new_tree: string; before: ArtifactsTreeEntry[]; after: ArtifactsTreeEntry[] }[] = [];
      try {
        await pooled(pairs, this.limits.readConcurrency, async pair => {
          const [before, after] = await Promise.all([read(pair.old_tree, pair.prefix), read(pair.new_tree, pair.prefix)]);
          diffs.push({ prefix: pair.prefix, new_tree: pair.new_tree, before, after });
        });
      } finally { await bounded(reader.close(), this.limits.readTimeoutMs, 'Closing the repository reader').catch(() => {}); }
      mark?.update(`applying ${diffs.length} changed directories: ${diffs.reduce((sum, diff) => sum + diff.before.length + diff.after.length, 0)} tree entries`);
      storage.transactionSync(() => {
        let queued = 0;
        for (const diff of diffs) {
          // A pair another drive already applied is gone; applying it twice would double-count references.
          if (!storage.sql.exec('DELETE FROM code_search_tree WHERE prefix=? AND new_tree=? RETURNING prefix', diff.prefix, diff.new_tree).toArray().length) continue;
          const before = new Map(diff.before.map(entry => [entry.name, entry]));
          for (const entry of diff.after) { if (this.applyEntry(diff.prefix + entry.name, before.get(entry.name), entry, next)) queued++; before.delete(entry.name); }
          for (const [name, entry] of before) this.applyEntry(diff.prefix + name, entry, undefined, next);
        }
        if (queued) storage.sql.exec('UPDATE code_search_state SET build_queued=build_queued+? WHERE singleton=1', queued);
      });
      return diffs.length;
    } finally { mark?.end(); }
  }

  /** Records one changed entry for generation `next`; true when it queued a blob this build must index. */
  private applyEntry(path: string, before: ArtifactsTreeEntry | undefined, after: ArtifactsTreeEntry | undefined, next: number): boolean {
    const sql = this.options.storage.sql;
    if (before?.type === 'tree' && after?.type === 'tree') {
      if (before.hash !== after.hash) sql.exec('INSERT INTO code_search_tree(prefix,old_tree,new_tree) VALUES(?,?,?)', `${path}/`, before.hash, after.hash);
      return false;
    }
    // Regular and executable files; symlinks and submodules have no searchable content.
    const wasFile = before?.type === 'blob' || before?.type === 'exec', isFile = after?.type === 'blob' || after?.type === 'exec';
    if (wasFile && isFile && before.hash === after.hash) return false;
    if (before?.type === 'tree') sql.exec('UPDATE code_search_file SET until=? WHERE path>=? AND path<? AND until IS NULL', next, `${path}/`, `${path}0`);
    else if (wasFile) sql.exec('UPDATE code_search_file SET until=? WHERE path=? AND until IS NULL', next, path);
    if (after?.type === 'tree') sql.exec('INSERT INTO code_search_tree(prefix,old_tree,new_tree) VALUES(?,?,?)', `${path}/`, null, after.hash);
    else if (isFile) {
      // Binary and generated paths are settled here and never read; content they share with another path keeps the
      // state its first reference gave it.
      const state = BINARY_PATH.test(path) ? BINARY : GENERATED_PATH.test(path) ? GENERATED : PENDING;
      const blob = sql.exec<{ id: number; refs: number; state: number }>('INSERT INTO code_search_blob(oid,state,chunks,refs) VALUES(?,?,0,1) ON CONFLICT(oid) DO UPDATE SET refs=refs+1 RETURNING id, refs, state', after.hash, state).one();
      sql.exec('INSERT INTO code_search_file(path,since,until,blob_id,ignore_rules) VALUES(?,?,NULL,?,?)', path, next, blob.id, /(^|\/)\.(git)?ignore$/u.test(path) ? 1 : 0);
      // Blobs are collected as their last reference goes, so a first pending reference is a blob this build must index.
      return blob.refs === 1 && blob.state === PENDING;
    }
    return false;
  }

  /** Reads up to `stepBlobs` pending blobs, `readConcurrency` at a time, and commits them in transactions of at most
   * `txnBlobs`/`txnBytes` (each FTS5 transaction writes one segment). Returns the blobs settled. */
  private async indexBlobs(): Promise<number> {
    const { storage, source, repository } = this.options;
    const pending = storage.sql.exec<{ id: number; oid: string }>(`SELECT id, oid FROM code_search_blob WHERE state=${PENDING} LIMIT ?`, this.limits.stepBlobs).toArray();
    if (!pending.length) return 0;
    const mark = this.options.mark?.('code search', `reading ${pending.length} blobs, ${this.limits.readConcurrency} at a time, up to ${kibibytes(this.limits.stepBytes)}`);
    try {
      const indexed: IndexedBlob[] = [];
      let bytes = 0, over = 0, largest = 0, firstError: unknown;
      const reader = source.reader(repository);
      try {
        await pooled(pending, this.limits.readConcurrency, async blob => {
          try {
            const value = await bounded(reader.readBlob(blob.oid), this.limits.readTimeoutMs, `Reading blob ${blob.oid}`);
            if (!value) indexed.push({ id: blob.id, state: UNREADABLE, chunks: [] });
            // Settled from its size alone: the bytes of a blob over the limit are never read here.
            else if (value.size > this.limits.blobBytes) { over++; largest = Math.max(largest, value.size); indexed.push({ id: blob.id, state: TOO_LARGE, chunks: [] }); }
            else {
              bytes += value.size;
              indexed.push(splitChunks(blob.id, new Uint8Array(await bounded(value.arrayBuffer(), this.limits.readTimeoutMs, `Reading blob ${blob.oid}`)), this.limits.chunkBytes));
            }
          } catch (error) {
            firstError ??= error;
            // One unreadable object (e.g. too large for the repository service to buffer) must not stall every later build.
            const failures = (this.blobFailures.get(blob.id) ?? 0) + 1;
            this.blobFailures.set(blob.id, failures);
            if (failures < BLOB_ATTEMPTS) return;
            this.blobFailures.delete(blob.id);
            indexed.push({ id: blob.id, state: UNREADABLE, chunks: [], skipped: { oid: blob.oid, message: error instanceof Error ? error.message : String(error) } });
          }
        }, () => bytes < this.limits.stepBytes);
      } finally { await bounded(reader.close(), this.limits.readTimeoutMs, 'Closing the repository reader').catch(() => {}); }
      if (!indexed.length) throw firstError ?? new Error('No pending blob could be read');
      mark?.update(`indexing ${indexed.length} blobs: ${kibibytes(bytes)} read${over ? `, ${over} over ${kibibytes(this.limits.blobBytes)} skipped (largest ${kibibytes(largest)})` : ''}`);
      for (let start = 0; start < indexed.length;) {
        let end = start, size = 0;
        while (end < indexed.length && end - start < this.limits.txnBlobs && (end === start || size < this.limits.txnBytes)) size += indexed[end++]!.chunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
        const batch = indexed.slice(start, end);
        start = end;
        const settled = storage.transactionSync(() => {
          const written = batch.filter(blob => {
            // Settled by a concurrent drive already: its chunks are in place.
            if (!storage.sql.exec(`UPDATE code_search_blob SET state=?, chunks=? WHERE id=? AND state=${PENDING} RETURNING id`, blob.state, blob.chunks.length, blob.id).toArray().length) return false;
            blob.chunks.forEach((chunk, ordinal) => {
              storage.sql.exec('INSERT INTO code_search_chunk(blob_id,ordinal,first_line,content) VALUES(?,?,?,?)', blob.id, ordinal, chunk.firstLine, chunk.content);
              storage.sql.exec('INSERT INTO code_search_fts(rowid,body) VALUES(?,?)', blob.id * CHUNKS_PER_BLOB + ordinal, chunk.content);
            });
            return true;
          });
          if (written.length) storage.sql.exec('UPDATE code_search_state SET build_indexed=build_indexed+? WHERE singleton=1', written.length);
          return written;
        });
        for (const blob of settled) if (blob.skipped) this.log({ event: 'code_search_blob_skipped', repository, ...blob.skipped });
      }
      return indexed.length;
    } finally { mark?.end(); }
  }

  /** Rows no generation can see any more, and the blobs they were the last reference to. Returns the rows collected. */
  private collectGarbage(): number {
    const { storage } = this.options;
    const rows = storage.sql.exec<{ path: string; since: number }>('SELECT path, since FROM code_search_file WHERE until IS NOT NULL AND until<=? LIMIT ?', this.state().generation, GARBAGE_ROWS).toArray();
    if (!rows.length) return 0;
    storage.transactionSync(() => {
      for (const row of rows) {
        const removed = storage.sql.exec<{ blob_id: number }>('DELETE FROM code_search_file WHERE path=? AND since=? RETURNING blob_id', row.path, row.since).toArray()[0];
        if (!removed) continue;
        const blob = storage.sql.exec<{ refs: number; chunks: number }>('UPDATE code_search_blob SET refs=refs-1 WHERE id=? RETURNING refs, chunks', removed.blob_id).one();
        if (blob.refs > 0) continue;
        for (let ordinal = 0; ordinal < blob.chunks; ordinal++) storage.sql.exec('DELETE FROM code_search_fts WHERE rowid=?', removed.blob_id * CHUNKS_PER_BLOB + ordinal);
        storage.sql.exec('DELETE FROM code_search_chunk WHERE blob_id=?', removed.blob_id);
        storage.sql.exec('DELETE FROM code_search_blob WHERE id=?', removed.blob_id);
      }
    });
    return rows.length;
  }

  /** Candidate chunks by blob, or null when there are too many to beat a path-ordered scan. */
  private candidates(query: string): Map<number, number[]> | null {
    const hits = new Map<number, number[]>();
    let count = 0;
    for (const { rowid } of this.options.storage.sql.exec<{ rowid: number }>('SELECT rowid FROM code_search_fts WHERE code_search_fts MATCH ? ORDER BY rowid LIMIT ?', query, this.limits.candidateChunks + 1)) {
      if (++count > this.limits.candidateChunks) return null;
      const blob = Math.floor(rowid / CHUNKS_PER_BLOB), ordinal = rowid % CHUNKS_PER_BLOB;
      const ordinals = hits.get(blob);
      if (ordinals) ordinals.push(ordinal); else hits.set(blob, [ordinal]);
    }
    return hits;
  }

  /** Files of one generation in path order, a page at a time; only rows inside `root` are read. */
  private *scope(root: string, generation: number): Generator<ScopeRow> {
    const sql = this.options.storage.sql;
    const select = 'SELECT f.path, f.blob_id, b.state, b.chunks FROM code_search_file f JOIN code_search_blob b ON b.id=f.blob_id WHERE f.since<=?2 AND (f.until IS NULL OR f.until>?2)';
    if (root) {
      const file = sql.exec<ScopeRow>(`${select} AND f.path=?1`, root, generation).toArray()[0];
      if (file) { yield file; return; }
    }
    // A directory spans [root/, root0): '0' is the character after '/'.
    const bounds = root ? [`${root}0`] : [];
    let after: string | null = null;
    for (;;) {
      const page: ScopeRow[] = sql.exec<ScopeRow>(`${select} AND f.path${after === null ? '>=' : '>'}?1${root ? ' AND f.path<?3' : ''} ORDER BY f.path LIMIT ${SCOPE_PAGE}`, after ?? (root ? `${root}/` : ''), generation, ...bounds).toArray();
      yield* page;
      const last = page[SCOPE_PAGE - 1];
      if (!last) return;
      after = last.path;
    }
  }

  /** .gitignore/.ignore rules are parsed once per generation, not per search. */
  private ignoreRules(generation: number): SearchIgnoreRules {
    if (this.ignores?.generation === generation) return this.ignores.rules;
    const sql = this.options.storage.sql;
    const files = sql.exec<{ path: string; blob_id: number; state: number }>('SELECT f.path, f.blob_id, b.state FROM code_search_file f JOIN code_search_blob b ON b.id=f.blob_id WHERE f.ignore_rules=1 AND f.since<=? AND (f.until IS NULL OR f.until>?)', generation, generation).toArray();
    const rules = compileSearchIgnores(files.filter(file => file.state === TEXT).map(file => ({
      path: file.path,
      content: sql.exec<{ content: string }>('SELECT content FROM code_search_chunk WHERE blob_id=? ORDER BY ordinal', file.blob_id).toArray().map(chunk => chunk.content).join(''),
    })));
    this.ignores = { generation, rules };
    return rules;
  }
}
