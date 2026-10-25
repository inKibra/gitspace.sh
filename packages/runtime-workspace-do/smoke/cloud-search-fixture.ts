import { DurableObject } from 'cloudflare:workers';
import { strict as assert } from 'node:assert';
import { searchSnapshotFiles, type SearchArguments } from '../../protocol-runtime/src/search.js';
import { CodeSearchIndex, type CodeSearchEvent, type CodeSearchLimits, type CodeSearchSource, type CodeSearchStorage } from '../src/cloud-search-index.js';
import { createRunningMarks, type RunningStep } from '../src/running-marks.js';

type Commit = { worktreeCommit: string; worktreeTree: string };

async function sha1(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A repository blob that records when its bytes are read. */
class RecordedBlob extends Blob {
  private readonly loaded: () => void;
  constructor(content: string, loaded: () => void) { super([content]); this.loaded = loaded; }
  override async arrayBuffer(): Promise<ArrayBuffer> { this.loaded(); return super.arrayBuffer(); }
}
/** A content-addressed repository that records every object read. */
class Repository {
  readonly trees = new Map<string, ArtifactsTreeEntry[]>();
  readonly blobs = new Map<string, string>();
  readonly commits: Commit[] = [];
  readonly treeReads: string[] = [];
  readonly blobReads: string[] = [];
  /** Blobs whose bytes were read, not only their size. */
  readonly blobLoads: string[] = [];
  failTrees = false;
  /** Tree reads that never answer, as a wedged repository call would; `hung` settles once one starts. */
  hangTrees = false;
  hung = Promise.withResolvers<void>();
  readonly failBlobs = new Set<string>();
  /** Per-read delay, standing in for the repository service's round trip. */
  latencyMs = 0;
  /** Blob reads wait for `blobRelease`; `blobsHung` settles once one starts. */
  hangBlobs = false;
  blobsHung = Promise.withResolvers<void>();
  blobRelease = Promise.withResolvers<void>();
  readonly source: CodeSearchSource = {
    reader: () => ({
      readTree: async oid => {
        if (this.latencyMs) await new Promise(resolve => setTimeout(resolve, this.latencyMs));
        if (this.failTrees) throw new Error('Artifacts is unavailable');
        if (this.hangTrees) { this.hung.resolve(); return new Promise<never>(() => {}); }
        this.treeReads.push(oid);
        return this.trees.get(oid) ?? null;
      },
      readBlob: async oid => {
        if (this.latencyMs) await new Promise(resolve => setTimeout(resolve, this.latencyMs));
        if (this.failBlobs.has(oid)) throw new Error('MEMORY_LIMIT');
        if (this.hangBlobs) { this.blobsHung.resolve(); await this.blobRelease.promise; }
        this.blobReads.push(oid);
        const content = this.blobs.get(oid);
        return content === undefined ? null : new RecordedBlob(content, () => { this.blobLoads.push(oid); });
      },
      close: async () => {},
    }),
  };
  async commit(files: ReadonlyMap<string, string>): Promise<Commit> {
    const worktreeTree = await this.tree(files, '');
    const commit = { worktreeCommit: await sha1(`commit ${this.commits.length} ${worktreeTree}`), worktreeTree };
    this.commits.push(commit);
    return commit;
  }
  /** The id of the tree at `path` ('' is the root) in a commit. */
  subtree(commit: Commit, path: string): string {
    let oid = commit.worktreeTree;
    for (const name of path.split('/').filter(Boolean)) {
      const entry = this.trees.get(oid)?.find(candidate => candidate.name === name);
      if (entry?.type !== 'tree') throw new Error(`No tree at ${path}`);
      oid = entry.hash;
    }
    return oid;
  }
  async blobId(content: string): Promise<string> { return sha1(`blob ${content}`); }
  private async tree(files: ReadonlyMap<string, string>, prefix: string): Promise<string> {
    const names = new Map<string, 'blob' | 'tree'>();
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length), slash = rest.indexOf('/');
      names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'blob' : 'tree');
    }
    const entries: ArtifactsTreeEntry[] = [];
    for (const [name, type] of [...names].sort(([left], [right]) => left < right ? -1 : 1)) {
      if (type === 'tree') { entries.push({ name, type, mode: '40000', hash: await this.tree(files, `${prefix}${name}/`) }); continue; }
      const content = files.get(prefix + name) ?? '';
      const hash = await this.blobId(content);
      this.blobs.set(hash, content);
      entries.push({ name, type, mode: '100644', hash });
    }
    const hash = await sha1(`tree ${JSON.stringify(entries)}`);
    this.trees.set(hash, entries);
    return hash;
  }
}

function proofFiles(): Map<string, string> {
  const files = new Map<string, string>([
    ['.gitignore', 'docs/ignored/\n*.log\n!keep.log\n'],
    ['README.md', 'GitSpace readme\nneedle in readme\n'],
    ['src/a.ts', 'export const needle = 1;\nconst Needle = 2;\n'],
    ['src/copy.ts', 'export const needle = 1;\nconst Needle = 2;\n'],
    ['src/nested/b.ts', 'function searchOrderedFiles() {}\nNEEDLE again\n'],
    ['src/.hidden.ts', 'needle hidden\n'],
    ['docs/guide.md', 'A guide\nneedle docs\n'],
    ['docs/kelvin.md', 'temperature in \u212Aelvin\n'],
    ['docs/longs.md', 'the mi\u017F\u017Fion\n'],
    ['docs/ignored/x.md', 'needle ignored\n'],
    ['keep.log', 'needle kept\n'],
    ['drop.log', 'needle dropped\n'],
    ['bin.dat', 'needle\0binary'],
    ['multi.txt', 'start\nend\nother\n'],
    ['chunks/long.txt', `${Array.from({ length: 40 }, (_, n) => `line ${n} ${n === 33 ? 'needle deep' : 'filler'}`).join('\n')}\nstart\nend\n`],
    // One line longer than a chunk: the index skips it and says so.
    ['big/line.txt', `${'x'.repeat(200)} needle\n`],
    // Skipped by path and never read: an image silently (binary), a lockfile as a skipped file.
    ['assets/logo.png', 'needle in an image\n'],
    ['package-lock.json', '{ "needle": "lock" }\n'],
  ]);
  for (let n = 0; n < 120; n++) files.set(`other/file${String(n).padStart(3, '0')}.txt`, `ordinary line ${n}\n${n % 40 === 0 ? 'needle outside\n' : ''}`);
  return files;
}

export class CodeSearchProof extends DurableObject {
  /** The clock indexing backoff reads; tests move it instead of waiting. */
  private clock = 1_000_000;
  private readonly scheduled: number[] = [];
  async fetch(request: Request): Promise<Response> {
    await this.ctx.storage.deleteAll();
    const url = new URL(request.url);
    const latency = Number(url.searchParams.get('latency') ?? 0);
    return Response.json(latency ? await this.firstBuild(latency) : url.searchParams.has('benchmark') ? await this.benchmark() : await this.proof());
  }

  private open(repository: Repository, snapshot: { current: Commit | null }, options: { limits?: Partial<CodeSearchLimits>; storage?: CodeSearchStorage; reports?: unknown[]; events?: CodeSearchEvent[]; mark?(step: string, detail: string): RunningStep } = {}) {
    return new CodeSearchIndex({
      storage: options.storage ?? this.ctx.storage, source: repository.source, repository: 'workspace-proof',
      snapshots: {
        current: async () => snapshot.current,
        distance: (ancestor, descendant) => {
          const ids = repository.commits.map(commit => commit.worktreeCommit);
          const from = ids.indexOf(ancestor), to = ids.indexOf(descendant);
          return from < 0 || to < from ? null : to - from;
        },
      },
      schedule: async timestamp => { this.scheduled.push(timestamp - this.clock); }, now: () => this.clock,
      report: error => { if (!options.reports) throw error; options.reports.push(error); }, log: event => { options.events?.push(event); }, mark: options.mark, limits: options.limits,
    });
  }

  private async proof() {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE runtime_search_trigrams(gram TEXT NOT NULL, path TEXT NOT NULL)');
    const repository = new Repository();
    const files = proofFiles();
    const first = await repository.commit(files);
    const snapshot: { current: Commit | null } = { current: first };
    // Small limits drive multi-step builds, multi-chunk files and an over-long line.
    const limits: Partial<CodeSearchLimits> = { chunkBytes: 64, blobBytes: 4096, stepBlobs: 5, stepBytes: 256, stepTrees: 2 };
    const index = this.open(repository, snapshot, { limits });
    assert.equal(sql.exec("SELECT name FROM sqlite_master WHERE name='runtime_search_trigrams'").toArray().length, 0, 'The hand-rolled trigram table is dropped');
    await assert.rejects(index.search({ pattern: 'needle', path: '.' }), /building the first index: starting;.*grep on an attached machine/u);
    let steps = 0, step = await index.step();
    // While the first build runs, a search says how far it is.
    for (; step && step.phase !== 'blobs'; step = await index.step()) steps++;
    await assert.rejects(index.search({ pattern: 'needle', path: '.' }), /building the first index: 5 of \d+ files indexed; retry shortly/u);
    for (; step; step = await index.step()) steps++;
    assert.ok(steps > 10, `Bounded steps build the index (${steps})`);
    const unread = ['assets/logo.png', 'package-lock.json'], skippedPaths = ['big/line.txt', ...unread];
    assert.equal(repository.blobReads.length, new Set([...files].filter(([path]) => !unread.includes(path)).map(([, content]) => content)).size, 'Each distinct blob is read once; identical files share it');
    for (const path of unread) assert.ok(!repository.blobReads.includes(await repository.blobId(files.get(path) ?? '')), `${path} is never read`);
    assert.equal(sql.exec<{ refs: number }>('SELECT refs FROM code_search_blob WHERE oid=?', await repository.blobId(files.get('src/a.ts') ?? '')).one().refs, 2);

    // The index answers exactly what the JS reference finds in the same files; the over-long line and skipped paths are not searched.
    const reference = (source: ReadonlyMap<string, string>) => [...source].filter(([path]) => !skippedPaths.includes(path)).map(([path, content]) => ({ path, content }));
    const cases: SearchArguments[] = [
      { pattern: 'needle', path: '.' },
      { pattern: 'needle', path: '.', caseSensitive: false },
      { pattern: '(?i)NEEDLE', path: 'src' },
      { pattern: 'need(le|ful)\\s', path: '.' },
      { pattern: 'kelvin', path: '.', caseSensitive: false },
      { pattern: 'MISSION', path: 'docs', caseSensitive: false },
      { pattern: 'needle', path: '.', hidden: true, gitignore: false },
      { pattern: 'needle', path: '.', glob: '*.log' },
      { pattern: 'needle', path: '.', glob: '!*.md' },
      { pattern: 'start\nend', path: '.', multiline: true },
      { pattern: 'filler\nline 2\\d', path: 'chunks', multiline: true },
      { pattern: 'line 3\\d', path: 'chunks/long.txt' },
      { pattern: 'needle', path: '.', offset: 2, limit: 3 },
      { pattern: '\\w+\\(', path: '.' },
      { pattern: 'e', path: 'src' },
      { pattern: 'ordinary line 1[0-9]', path: 'other' },
    ];
    const parity = async (source: ReadonlyMap<string, string>) => {
      for (const args of cases) {
        const expected = searchSnapshotFiles(reference(source), args), actual = await index.search(args);
        assert.equal(actual.matches.join('\n'), expected.text, JSON.stringify(args));
        assert.equal(actual.truncated, expected.truncated, JSON.stringify(args));
        assert.equal(actual.partial, false, JSON.stringify(args));
        assert.equal(actual.behind, 0, JSON.stringify(args));
      }
    };
    await parity(files);
    const skipped = await index.search({ pattern: 'needle', path: '.' });
    assert.equal(skipped.skippedFiles, 2, 'The over-long line and the lockfile; the image is binary');
    assert.match(skipped.notes.join(' '), /not indexed/u);
    assert.match((await index.search({ pattern: 'kelvin', path: '.', caseSensitive: false })).matches.join('\n'), /docs\/kelvin\.md:1/u, 'SQLite folds the Kelvin sign like Rust (?i)');
    assert.match((await index.search({ pattern: 'MISSION', path: '.', caseSensitive: false })).matches.join('\n'), /docs\/longs\.md:1/u, 'SQLite folds long s like Rust (?i)');

    // A path-prefix search reads file rows and chunks inside the prefix only.
    const statements: { query: string; bindings: unknown[]; rowsRead: () => number }[] = [];
    const storage = this.ctx.storage;
    const recording: CodeSearchStorage = {
      sql: { exec: <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) => { const cursor = sql.exec<T>(query, ...bindings); statements.push({ query, bindings, rowsRead: () => cursor.rowsRead }); return cursor; } },
      transactionSync: closure => storage.transactionSync(closure),
    };
    const scoped = this.open(repository, snapshot, { limits, storage: recording });
    await scoped.search({ pattern: 'warm', path: 'src' }); // Ancestor .gitignore rules are parsed once per generation.
    const allFiles = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM code_search_file').one().count;
    // docs/ sorts before the 120 other/ files and src/ after them: both range bounds are exercised.
    for (const root of ['docs', 'src']) for (const pattern of ['needle', '\\w+']) {
      const inside = new Set(sql.exec<{ blob_id: number }>('SELECT blob_id FROM code_search_file WHERE path>=? AND path<?', `${root}/`, `${root}0`).toArray().map(row => row.blob_id));
      const insideFiles = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM code_search_file WHERE path>=? AND path<?', `${root}/`, `${root}0`).one().count;
      statements.length = 0;
      const result = await scoped.search({ pattern, path: root, hidden: true });
      assert.ok(result.matches.length > 0 && result.matches.every(line => line.startsWith(`${root}/`)), `${root} ${pattern}`);
      const chunks = statements.filter(statement => statement.query.includes('FROM code_search_chunk'));
      assert.ok(chunks.length > 0 && chunks.every(statement => inside.has(Number(statement.bindings[0]))), `${root} ${pattern}: chunks outside the prefix were read`);
      const scopeRows = statements.filter(statement => statement.query.includes('FROM code_search_file f')).reduce((sum, statement) => sum + statement.rowsRead(), 0);
      assert.ok(scopeRows <= 4 * insideFiles + 4 && allFiles > 4 * scopeRows, `${root} ${pattern}: read ${scopeRows} file rows for ${insideFiles} in scope of ${allFiles}`);
    }

    // No 3-character literal: a budgeted path-ordered scan, partial when the cap is hit and a prefix of the full answer.
    const capped = this.open(repository, snapshot, { limits: { ...limits, verifyFiles: 10 } });
    const scan = await capped.search({ pattern: '\\w+', path: 'other' });
    assert.equal(scan.partial, true);
    assert.equal(scan.verifiedFiles, 10);
    assert.deepEqual(scan.matches, searchSnapshotFiles(reference(files), { pattern: '\\w+', path: 'other' }).text.split('\n').slice(0, scan.matches.length));
    assert.match(scan.notes.join(' '), /no 3-character literal/u);
    const narrow = await capped.search({ pattern: 'needle outside', path: 'other' });
    assert.equal(narrow.partial, false, 'Index candidates stay within the verification budget');
    assert.equal(narrow.matches.length, 3);
    assert.equal((await capped.search({ pattern: '\\w+', path: 'src/nested' })).partial, false, 'A scan within budget is complete');

    // Second commit: only changed trees and new blobs are read; searches serve the indexed commit until the build lands.
    const previousSource = new Map(files);
    files.set('src/nested/b.ts', 'function searchOrderedFiles() {}\nNEEDLE changed\n');
    files.set('src/new.ts', files.get('src/a.ts') ?? '');
    files.delete('README.md');
    files.set('docs/renamed.md', files.get('docs/guide.md') ?? '');
    files.delete('docs/guide.md');
    repository.treeReads.length = 0; repository.blobReads.length = 0;
    const second = await repository.commit(files);
    snapshot.current = second;
    const stale = await index.search({ pattern: 'needle in readme', path: '.' });
    assert.equal(stale.indexedCommit, first.worktreeCommit);
    assert.equal(stale.behind, 1);
    assert.deepEqual(stale.matches, ['README.md:2:needle in readme']);
    while (await index.step()) { const midway = await index.search({ pattern: 'needle', path: '.' }); assert.ok([first.worktreeCommit, second.worktreeCommit].includes(midway.indexedCommit)); }
    assert.deepEqual(repository.blobReads, [await repository.blobId(files.get('src/nested/b.ts') ?? '')], 'Only the changed blob is read');
    const changedTrees = new Set(['', 'src', 'src/nested', 'docs'].flatMap(path => [repository.subtree(first, path), repository.subtree(second, path)]));
    assert.deepEqual(new Set(repository.treeReads), changedTrees, 'Only changed trees are read');
    assert.ok(!repository.treeReads.includes(repository.subtree(second, 'other')));
    const fresh = await index.search({ pattern: 'needle', path: '.' });
    assert.equal(fresh.indexedCommit, second.worktreeCommit);
    assert.equal(fresh.behind, 0);
    await parity(files);
    assert.equal(sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM code_search_file WHERE until IS NOT NULL').one().count, 0, 'Superseded rows are collected');
    assert.equal(sql.exec('SELECT id FROM code_search_blob WHERE oid=?', await repository.blobId(previousSource.get('src/nested/b.ts') ?? '')).toArray().length, 0, 'An unreferenced blob is collected');
    assert.equal(sql.exec('SELECT rowid FROM code_search_fts WHERE code_search_fts MATCH ?', '"aga" AND "gai"').toArray().length, 0, 'Its FTS rows are deleted');
    assert.equal(sql.exec<{ refs: number }>('SELECT refs FROM code_search_blob WHERE oid=?', await repository.blobId(files.get('src/a.ts') ?? '')).one().refs, 3);

    // A failing build is logged on every attempt, reported once, shown to searches, and never hides the served generation.
    const reports: unknown[] = [], events: CodeSearchEvent[] = [];
    const retried = this.open(repository, snapshot, { limits, reports, events });
    files.set('src/a.ts', 'export const replaced = 1;\n');
    snapshot.current = await repository.commit(files);
    repository.failTrees = true;
    this.scheduled.length = 0;
    await retried.drive();
    await retried.drive();
    assert.deepEqual(this.scheduled, [30_000, 30_000], 'A drive inside the backoff reads nothing and keeps the retry time');
    this.clock += 30_000;
    await retried.drive();
    assert.equal(this.scheduled.at(-1), 60_000, 'Consecutive failures double the wait');
    assert.equal(reports.length, 1);
    assert.deepEqual(events.filter(event => event.event === 'code_search_step_failed').map(event => event.message), ['Artifacts is unavailable', 'Artifacts is unavailable']);
    assert.deepEqual(events.filter(event => event.event === 'code_search_step_failed').map(event => event.retryInMs), [30_000, 60_000]);
    const failing = await retried.search({ pattern: 'needle', path: 'src' });
    assert.equal(failing.indexedCommit, second.worktreeCommit);
    assert.match(failing.notes.join(' '), /1 snapshot\(s\) behind.*last indexing step failed and is retried: Artifacts is unavailable/u);
    repository.failTrees = false;
    events.length = 0;
    await retried.drive();
    assert.equal(events.length, 0, 'Recovery waits out the backoff');
    this.clock += 60_000;
    await retried.drive();
    assert.ok(events.length > 0 && events.every(event => event.event === 'code_search_progress' && typeof event.stepMs === 'number' && event.failure === null), JSON.stringify(events));
    assert.deepEqual(events.map(event => event.phase).filter((phase, n, all) => phase !== all[n - 1]), ['trees', 'blobs', 'publish', 'collect'], 'The failed drive had begun this build; recovery resumes it');
    const repaired = await retried.search({ pattern: 'replaced', path: 'src' });
    assert.deepEqual([repaired.indexedCommit, repaired.behind, repaired.matches, repaired.notes], [snapshot.current.worktreeCommit, 0, ['src/a.ts:1:export const replaced = 1;'], []]);

    // Retrying stops after 8 failures (about an hour) and says so; the next change to the working copy tries again.
    files.set('src/a.ts', 'export const stopped = 1;\n');
    snapshot.current = await repository.commit(files);
    repository.failTrees = true;
    reports.length = 0; events.length = 0;
    for (let attempt = 0; attempt < 8; attempt++) { await retried.drive(); this.clock += 30 * 60_000; }
    assert.deepEqual(events.filter(event => event.event === 'code_search_step_failed').map(event => event.retryInMs), [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, null]);
    assert.deepEqual(reports.map(error => error instanceof Error ? error.message : String(error)), ['Artifacts is unavailable', 'code_search stopped retrying after 8 failed indexing steps: Artifacts is unavailable. The next change to the working copy tries again.']);
    this.scheduled.length = 0; events.length = 0;
    await retried.drive();
    assert.deepEqual([this.scheduled, events], [[], []], 'A drive after retrying stopped reads nothing and arms nothing');
    assert.match((await retried.search({ pattern: 'stopped', path: 'src' })).notes.join(' '), /indexing stopped after failed steps until the working copy changes.*; the last indexing step failed: Artifacts is unavailable/u);
    repository.failTrees = false;
    this.scheduled.length = 0;
    await retried.changed();
    assert.equal(this.scheduled.length, 1, 'A change to the working copy wakes indexing again');
    await retried.drive();
    assert.deepEqual((await retried.search({ pattern: 'stopped', path: 'src' })).matches, ['src/a.ts:1:export const stopped = 1;']);

    // A repository read that never answers fails the step after the read timeout instead of wedging every later drive.
    const wedged = this.open(repository, snapshot, { limits: { ...limits, readTimeoutMs: 20 }, reports, events });
    files.set('src/wedged.ts', 'wedged\n');
    snapshot.current = await repository.commit(files);
    repository.hangTrees = true;
    events.length = 0;
    await wedged.drive();
    assert.match(String(events.at(-1)?.message), /did not answer within 0.02 s/u);
    repository.hangTrees = false;
    this.clock += 30_000;

    // Two drives racing over one build index each blob and reference once; an object the repository cannot serve is
    // skipped after its attempts instead of blocking the build.
    const racing = Array.from({ length: 12 }, (_, n) => `race/file${n}.ts`);
    for (const path of racing) files.set(path, `race ${path}\n`);
    snapshot.current = await repository.commit(files);
    repository.failBlobs.add(await repository.blobId(files.get('race/file3.ts') ?? ''));
    events.length = 0;
    const racers = [this.open(repository, snapshot, { limits: { ...limits, stepWindowMs: 60_000 }, reports, events }), this.open(repository, snapshot, { limits: { ...limits, stepWindowMs: 60_000 }, reports, events })];
    // A step whose only blob fails throws: later rounds wait out its backoff.
    for (let round = 0; round < 4; round++) { await Promise.all(racers.map(racer => racer.drive())); this.clock += 30 * 60_000; }
    assert.equal(events.filter(event => event.event === 'code_search_blob_skipped').length, 1, JSON.stringify(events.filter(event => event.event !== 'code_search_progress')));
    const raced = await racers[0]!.search({ pattern: 'race', path: 'race' });
    assert.equal(raced.indexedCommit, snapshot.current.worktreeCommit);
    assert.equal(raced.matches.length, 11);
    assert.equal(raced.skippedFiles, 1);
    assert.equal(sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM code_search_blob b WHERE refs != (SELECT COUNT(*) FROM code_search_file f WHERE f.blob_id=b.id)').one().count, 0, 'References match file rows');
    assert.deepEqual(sql.exec('SELECT build_queued, build_indexed FROM code_search_state').one(), { build_queued: 12, build_indexed: 12 }, 'Counters track the build in progress, each blob once');
    repository.failBlobs.clear();
    // The skipped object leaves the index with its file; everything else still matches the reference.
    files.delete('race/file3.ts');
    snapshot.current = await repository.commit(files);
    await racers[0]!.drive();
    await parity(files);

    // A build step names itself in the running marks while it reads, so a reset during it is reported on the next open
    // with what it was reading; a blob over the size limit is settled from its size, its bytes never read.
    const marks = createRunningMarks(sql);
    const progress: string[] = [];
    const marked = this.open(repository, snapshot, { limits: { ...limits, stepBytes: 64 * 1024 }, reports, events, mark: (step, detail) => {
      const mark = marks.stage(step, detail);
      return { update: next => { progress.push(next); mark.update(next); }, end: () => mark.end() };
    } });
    files.set('data/large.json', `${'x'.repeat(9_000)}\n`);
    files.set('data/small.txt', 'small\n');
    snapshot.current = await repository.commit(files);
    repository.hangBlobs = true;
    const reading = marked.drive();
    await repository.blobsHung.promise;
    assert.deepEqual(createRunningMarks(sql).leftover.map(({ step, detail }) => ({ step, detail })), [{ step: 'code search', detail: 'reading 2 blobs, 4 at a time, up to 64 KiB' }]);
    repository.hangBlobs = false;
    repository.blobRelease.resolve();
    await reading;
    assert.deepEqual(progress.filter(line => !/^applying 1 changed directories: \d+ tree entries$/u.test(line)), ['indexing 2 blobs: 0 KiB read, 1 over 4 KiB skipped (largest 9 KiB)']);
    const large = await repository.blobId(files.get('data/large.json') ?? '');
    assert.ok(repository.blobReads.includes(large) && !repository.blobLoads.includes(large), 'The oversized blob is settled from its size without reading its bytes');
    assert.ok(repository.blobLoads.includes(await repository.blobId('small\n')));
    assert.equal(sql.exec('SELECT id FROM runtime_running').toArray().length, 0, 'A finished step leaves no mark');

    // An isolate reset during a build step (out of memory, a deploy) leaves the step's running mark, which the next open
    // reports, and the build marked running: the next isolate's first drive counts it as a failed attempt and backs off
    // instead of repeating the step that reset it.
    files.set('src/reset.ts', 'reset\n');
    snapshot.current = await repository.commit(files);
    repository.hangTrees = true;
    repository.hung = Promise.withResolvers<void>();
    void this.open(repository, snapshot, { limits: { ...limits, readTimeoutMs: 3_600_000 }, mark: marks.stage }).drive();
    await repository.hung.promise;
    assert.deepEqual(createRunningMarks(sql).leftover.map(({ step, detail }) => ({ step, detail })), [{ step: 'code search', detail: 'listing 1 changed directories, 4 at a time' }]);
    repository.hangTrees = false;
    repository.treeReads.length = 0; events.length = 0; this.scheduled.length = 0;
    const restarted = this.open(repository, snapshot, { limits, reports, events });
    await restarted.drive();
    await restarted.drive();
    assert.deepEqual(repository.treeReads, [], 'Nothing is read inside the backoff');
    assert.match(String(events[0]?.message), /never finished: the workspace was reset during it/u);
    assert.deepEqual(this.scheduled, [30_000, 30_000]);
    this.clock += 30_000;
    await restarted.drive();
    assert.deepEqual((await restarted.search({ pattern: 'reset', path: 'src' })).matches, ['src/reset.ts:1:reset']);
    return { passed: true, steps };
  }

  /** Wall time of a first build shaped like the GitSpace repository (1,283 files in 175 directories) when every
   * repository read takes `latency` ms, driven as alarms drive it. */
  private async firstBuild(latency: number) {
    const repository = new Repository();
    const files = new Map<string, string>();
    for (let n = 0; n < 1283; n++) files.set(`packages/pkg${String(n % 25).padStart(2, '0')}/dir${String(n % 7)}/file${String(n).padStart(4, '0')}.ts`, `export const item${n} = ${n};\n${'// line\n'.repeat(200)}`);
    const snapshot: { current: Commit | null } = { current: await repository.commit(files) };
    repository.latencyMs = latency;
    const index = this.open(repository, snapshot);
    const start = performance.now();
    let drives = 0;
    for (; drives < 1000 && (await index.drive(), (await index.search({ pattern: 'item42 ', path: '.' }).catch(() => null)) === null); drives++);
    const result = await index.search({ pattern: 'item42 ', path: '.' });
    assert.deepEqual(result.matches, ['packages/pkg17/dir0/file0042.ts:1:export const item42 = 42;']);
    return { passed: true, measurement: { files: files.size, trees: repository.trees.size, latencyMs: latency, drives: drives + 1, buildMs: performance.now() - start, treeReads: repository.treeReads.length, blobReads: repository.blobReads.length } };
  }

  /** Rows read/written, as Durable Objects bill them, and timings for a 10,000-file build, a one-file update and searches. */
  private async benchmark() {
    const repository = new Repository();
    const files = new Map<string, string>();
    for (let n = 0; n < 10_000; n++) files.set(`src/dir${String(n % 100).padStart(3, '0')}/file${String(n).padStart(5, '0')}.ts`, `export const item${n} = '${'ordinary '.repeat(64)}';\n${n === 4242 ? 'uniqueNeedle' : 'ordinary'}\n`);
    const snapshot: { current: Commit | null } = { current: await repository.commit(files) };
    const storage = this.ctx.storage;
    const open: { rowsRead: number; rowsWritten: number }[] = [];
    let rowsRead = 0, rowsWritten = 0;
    const settle = () => { for (const cursor of open) { rowsRead += cursor.rowsRead; rowsWritten += cursor.rowsWritten; } open.length = 0; };
    const counting: CodeSearchStorage = {
      sql: { exec: <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) => { const cursor = storage.sql.exec<T>(query, ...bindings); open.push(cursor); return cursor; } },
      transactionSync: closure => storage.transactionSync(closure),
    };
    const index = this.open(repository, snapshot, { storage: counting });
    const measure = async <T>(work: () => Promise<T>) => {
      settle(); rowsRead = 0; rowsWritten = 0;
      const start = performance.now(), value = await work();
      settle();
      return { value, cost: { ms: performance.now() - start, rowsRead, rowsWritten } };
    };
    const build = await measure(async () => { let steps = 0; while (await index.step()) { settle(); steps++; } return steps; });
    const rare = await measure(() => index.search({ pattern: 'uniqueNeedle', path: '.' }));
    const common = await measure(() => index.search({ pattern: 'ordinary', path: 'src/dir007' }));
    const scan = await measure(() => index.search({ pattern: '\\w+\\(', path: '.' }));
    assert.deepEqual(rare.value.matches, ['src/dir042/file04242.ts:2:uniqueNeedle']);
    files.set('src/dir001/file00001.ts', 'replacementNeedle\n');
    snapshot.current = await repository.commit(files);
    repository.blobReads.length = 0; repository.treeReads.length = 0;
    const update = await measure(async () => { while (await index.step()) settle(); });
    assert.deepEqual((await index.search({ pattern: 'replacementNeedle', path: '.' })).matches, ['src/dir001/file00001.ts:1:replacementNeedle']);
    const contentBytes = [...files.values()].reduce((sum, text) => sum + new TextEncoder().encode(text).byteLength, 0);
    return { passed: true, measurement: {
      files: files.size, contentBytes, databaseBytes: storage.sql.databaseSize,
      build: { steps: build.value, ...build.cost }, update: { blobReads: repository.blobReads.length, treeReads: repository.treeReads.length, ...update.cost },
      rareLiteral: { verifiedFiles: rare.value.verifiedFiles, ...rare.cost }, commonTrigramInPrefix: { matches: common.value.matches.length, ...common.cost },
      noLiteralScan: { partial: scan.value.partial, verifiedFiles: scan.value.verifiedFiles, ...scan.cost },
    } };
  }
}
export default { fetch(request: Request, env: { PROOF: DurableObjectNamespace<CodeSearchProof> }) { return env.PROOF.getByName('proof').fetch(request); } };
