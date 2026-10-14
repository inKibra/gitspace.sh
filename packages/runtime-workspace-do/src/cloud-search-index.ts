import type { RuntimeGitCheckpoint } from '@gitspace/protocol-runtime';
import { createSearchMatcher, searchMatchingLines, searchTrigramQuery, type SearchArguments } from '../../protocol-runtime/src/search.js';
import { compileSearchIgnores, searchPathFilter, searchRoot, type SearchIgnoreRules } from '../../protocol-runtime/src/search-paths.js';
import type { ArtifactsRepositoryReader } from './artifacts.js';

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
  /** Blobs and content bytes indexed per transaction. */
  stepBlobs: number; stepBytes: number;
  /** Tree pairs diffed per transaction. */
  stepTrees: number;
  /** Line-aligned chunk size; a chunk row stays well under the 2 MB Durable Object value limit. */
  chunkBytes: number;
  /** Larger blobs are not indexed and are reported as skipped. */
  blobBytes: number;
  /** More candidate chunks than this falls back to the budgeted path-ordered scan. */
  candidateChunks: number;
  /** Verification budget of one search. */
  verifyFiles: number; verifyBytes: number;
  /** Wall time one alarm spends on steps before rescheduling. */
  stepWindowMs: number;
};
export const CODE_SEARCH_LIMITS: CodeSearchLimits = {
  stepBlobs: 25, stepBytes: 4 * 1024 * 1024, stepTrees: 16, chunkBytes: 1024 * 1024, blobBytes: 8 * 1024 * 1024,
  candidateChunks: 50_000, verifyFiles: 2_000, verifyBytes: 32 * 1024 * 1024, stepWindowMs: 5_000,
};
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
type SearchState = { generation: number; served_commit: string | null; served_tree: string | null; target_commit: string | null; target_tree: string | null };
type ScopeRow = { path: string; blob_id: number; state: number; chunks: number };
type IndexedBlob = { id: number; state: number; chunks: { firstLine: number; content: string }[] };

// Blob states.
const PENDING = 0, TEXT = 1, BINARY = 2, TOO_LARGE = 3, UNREADABLE = 4;
/** FTS rowid = blob id × CHUNKS_PER_BLOB + chunk ordinal. */
const CHUNKS_PER_BLOB = 4096;
const GARBAGE_ROWS = 256, SCOPE_PAGE = 256, BEHIND_LIMIT = 100;
/** Blob reads in flight at once; each blob may be as large as `blobBytes`. */
const READ_CONCURRENCY = 4;

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
  private driving: Promise<void> | undefined;
  private ignores: { generation: number; rules: SearchIgnoreRules } | undefined;
  private reported: string | undefined;

  constructor(private readonly options: { storage: CodeSearchStorage; source: CodeSearchSource; repository: string; snapshots: CodeSearchSnapshots; schedule(timestamp: number): Promise<void>; report(error: unknown): void; limits?: Partial<CodeSearchLimits> }) {
    const sql = options.storage.sql;
    this.limits = { ...CODE_SEARCH_LIMITS, ...options.limits };
    // The hand-rolled index stored one row per (trigram, path); FTS5 replaces it.
    for (const table of ['runtime_search_trigrams', 'runtime_search_chunks', 'runtime_search_files', 'runtime_search_state']) sql.exec(`DROP TABLE IF EXISTS ${table}`);
    sql.exec('CREATE TABLE IF NOT EXISTS code_search_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL, served_commit TEXT, served_tree TEXT, target_commit TEXT, target_tree TEXT)');
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
  }

  /** A snapshot was published: index it from an alarm, never inside the publishing request. */
  changed(): Promise<void> {
    return this.unavailable ? Promise.resolve() : this.options.schedule(Date.now());
  }

  /** Advance indexing for one alarm's window, rescheduling while work remains. One drive runs at a time. */
  drive(): Promise<void> {
    this.driving ??= this.advance().finally(() => { this.driving = undefined; });
    return this.driving;
  }

  private async advance(): Promise<void> {
    if (this.unavailable) return;
    const deadline = Date.now() + this.limits.stepWindowMs;
    try {
      while (await this.step()) if (Date.now() >= deadline) { await this.options.schedule(Date.now() + 1_000); return; }
      this.reported = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A persistent failure is reported once, then retried with backoff.
      if (message !== this.reported) { this.reported = message; this.options.report(error); }
      await this.options.schedule(Date.now() + 30_000);
    }
  }

  /** One bounded unit of work; false once the index serves the current snapshot and holds no garbage. */
  async step(): Promise<boolean> {
    const collected = this.collectGarbage();
    const state = this.state();
    if (state.target_tree === null) {
      const current = await this.options.snapshots.current();
      if (!current || current.worktreeCommit === state.served_commit) return collected;
      this.begin(state, current);
      return true;
    }
    if (await this.diffTrees(state.generation + 1)) return true;
    if (await this.indexBlobs()) return true;
    // Every changed path and blob is in place: the next generation becomes visible in one statement.
    this.options.storage.sql.exec('UPDATE code_search_state SET generation=generation+1, served_commit=target_commit, served_tree=target_tree, target_commit=NULL, target_tree=NULL WHERE singleton=1');
    return true;
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
    if (commit === null) throw new Error('code_search is still building the first index of this workspace; retry shortly, or use grep on an attached machine');
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
      if (skippedFiles) notes.push(`${skippedFiles} files in scope are not indexed (over ${this.limits.blobBytes / 1024 / 1024} MiB, a line over ${this.limits.chunkBytes / 1024 / 1024} MiB, or unreadable); grep on an attached machine searches them.`);
      if (stale) notes.push(`The index is at ${commit}, ${behind === null ? 'an unknown number of' : behind} snapshot(s) behind the working copy; newer changes are being indexed.`);
      return { matches, truncated, partial: stoppedAt !== null, indexedCommit: commit, behind, verifiedFiles, skippedFiles, notes };
    } finally { regex.free(); }
  }

  private state(): SearchState {
    return this.options.storage.sql.exec<SearchState>('SELECT generation, served_commit, served_tree, target_commit, target_tree FROM code_search_state WHERE singleton=1').one();
  }

  private begin(state: SearchState, current: Pick<RuntimeGitCheckpoint, 'worktreeCommit' | 'worktreeTree'>): void {
    const { storage } = this.options;
    if (current.worktreeTree === state.served_tree) {
      storage.sql.exec('UPDATE code_search_state SET served_commit=? WHERE singleton=1', current.worktreeCommit);
      return;
    }
    storage.transactionSync(() => {
      storage.sql.exec('UPDATE code_search_state SET target_commit=?, target_tree=? WHERE singleton=1', current.worktreeCommit, current.worktreeTree);
      storage.sql.exec('INSERT INTO code_search_tree(prefix,old_tree,new_tree) VALUES(?,?,?)', '', state.served_tree, current.worktreeTree);
    });
  }

  /** Unchanged subtrees are never read: only tree pairs whose ids differ are queued. */
  private async diffTrees(next: number): Promise<boolean> {
    const { storage, source, repository } = this.options;
    const pairs = storage.sql.exec<{ prefix: string; old_tree: string | null; new_tree: string }>('SELECT prefix, old_tree, new_tree FROM code_search_tree LIMIT ?', this.limits.stepTrees).toArray();
    if (!pairs.length) return false;
    const reader = source.reader(repository);
    const diffs = await Promise.all(pairs.map(async pair => {
      const [before, after] = await Promise.all([pair.old_tree === null ? [] : reader.readTree(pair.old_tree), reader.readTree(pair.new_tree)]);
      if (!before || !after) throw new Error(`Search tree for ${pair.prefix || '/'} is missing from the workspace repository`);
      return { prefix: pair.prefix, before, after };
    })).finally(() => reader.close());
    storage.transactionSync(() => {
      for (const diff of diffs) {
        const before = new Map(diff.before.map(entry => [entry.name, entry]));
        for (const entry of diff.after) { this.applyEntry(diff.prefix + entry.name, before.get(entry.name), entry, next); before.delete(entry.name); }
        for (const [name, entry] of before) this.applyEntry(diff.prefix + name, entry, undefined, next);
        storage.sql.exec('DELETE FROM code_search_tree WHERE prefix=?', diff.prefix);
      }
    });
    return true;
  }

  private applyEntry(path: string, before: ArtifactsTreeEntry | undefined, after: ArtifactsTreeEntry | undefined, next: number): void {
    const sql = this.options.storage.sql;
    if (before?.type === 'tree' && after?.type === 'tree') {
      if (before.hash !== after.hash) sql.exec('INSERT INTO code_search_tree(prefix,old_tree,new_tree) VALUES(?,?,?)', `${path}/`, before.hash, after.hash);
      return;
    }
    // Regular and executable files; symlinks and submodules have no searchable content.
    const wasFile = before?.type === 'blob' || before?.type === 'exec', isFile = after?.type === 'blob' || after?.type === 'exec';
    if (wasFile && isFile && before.hash === after.hash) return;
    if (before?.type === 'tree') sql.exec('UPDATE code_search_file SET until=? WHERE path>=? AND path<? AND until IS NULL', next, `${path}/`, `${path}0`);
    else if (wasFile) sql.exec('UPDATE code_search_file SET until=? WHERE path=? AND until IS NULL', next, path);
    if (after?.type === 'tree') sql.exec('INSERT INTO code_search_tree(prefix,old_tree,new_tree) VALUES(?,?,?)', `${path}/`, null, after.hash);
    else if (isFile) {
      const blob = sql.exec<{ id: number }>(`INSERT INTO code_search_blob(oid,state,chunks,refs) VALUES(?,${PENDING},0,1) ON CONFLICT(oid) DO UPDATE SET refs=refs+1 RETURNING id`, after.hash).one();
      sql.exec('INSERT INTO code_search_file(path,since,until,blob_id,ignore_rules) VALUES(?,?,NULL,?,?)', path, next, blob.id, /(^|\/)\.(git)?ignore$/u.test(path) ? 1 : 0);
    }
  }

  private async indexBlobs(): Promise<boolean> {
    const { storage, source, repository } = this.options;
    const pending = storage.sql.exec<{ id: number; oid: string }>(`SELECT id, oid FROM code_search_blob WHERE state=${PENDING} LIMIT ?`, this.limits.stepBlobs).toArray();
    if (!pending.length) return false;
    const indexed: IndexedBlob[] = [];
    const reader = source.reader(repository);
    try {
      // Groups stop once the byte budget is reached; the rest stay pending for the next step.
      for (let start = 0, bytes = 0; start < pending.length && bytes < this.limits.stepBytes; start += READ_CONCURRENCY) {
        const group = await Promise.all(pending.slice(start, start + READ_CONCURRENCY).map(async blob => ({ id: blob.id, value: await reader.readBlob(blob.oid) })));
        for (const { id, value } of group) {
          if (!value) indexed.push({ id, state: UNREADABLE, chunks: [] });
          else if (value.size > this.limits.blobBytes) indexed.push({ id, state: TOO_LARGE, chunks: [] });
          else {
            bytes += value.size;
            indexed.push(splitChunks(id, new Uint8Array(await value.arrayBuffer()), this.limits.chunkBytes));
          }
        }
      }
    } finally { await reader.close(); }
    storage.transactionSync(() => {
      for (const blob of indexed) {
        blob.chunks.forEach((chunk, ordinal) => {
          storage.sql.exec('INSERT INTO code_search_chunk(blob_id,ordinal,first_line,content) VALUES(?,?,?,?)', blob.id, ordinal, chunk.firstLine, chunk.content);
          storage.sql.exec('INSERT INTO code_search_fts(rowid,body) VALUES(?,?)', blob.id * CHUNKS_PER_BLOB + ordinal, chunk.content);
        });
        storage.sql.exec('UPDATE code_search_blob SET state=?, chunks=? WHERE id=?', blob.state, blob.chunks.length, blob.id);
      }
    });
    return true;
  }

  /** Rows no generation can see any more, and the blobs they were the last reference to. */
  private collectGarbage(): boolean {
    const { storage } = this.options;
    const rows = storage.sql.exec<{ path: string; since: number; blob_id: number }>('SELECT path, since, blob_id FROM code_search_file WHERE until IS NOT NULL AND until<=? LIMIT ?', this.state().generation, GARBAGE_ROWS).toArray();
    if (!rows.length) return false;
    storage.transactionSync(() => {
      for (const row of rows) {
        storage.sql.exec('DELETE FROM code_search_file WHERE path=? AND since=?', row.path, row.since);
        const blob = storage.sql.exec<{ refs: number; chunks: number }>('UPDATE code_search_blob SET refs=refs-1 WHERE id=? RETURNING refs, chunks', row.blob_id).one();
        if (blob.refs > 0) continue;
        for (let ordinal = 0; ordinal < blob.chunks; ordinal++) storage.sql.exec('DELETE FROM code_search_fts WHERE rowid=?', row.blob_id * CHUNKS_PER_BLOB + ordinal);
        storage.sql.exec('DELETE FROM code_search_chunk WHERE blob_id=?', row.blob_id);
        storage.sql.exec('DELETE FROM code_search_blob WHERE id=?', row.blob_id);
      }
    });
    return true;
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
