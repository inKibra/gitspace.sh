import { DurableObject } from 'cloudflare:workers';
import { strict as assert } from 'node:assert';
import { Harness, createRegistry, type Conversation, type EntryId } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createModels } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { HistorySearchRequest } from '@gitspace/runtime-core/history';
import { HistorySearchIndex, type HistorySearchEvent, type HistorySearchLimits } from '../src/history-search-index.js';
import { DurableObjectSqliteDatabase } from '../src/sqlite.js';
import { createStorageReads } from '../src/storage-reads.js';
import type { WithdrawnNotices } from '../src/transcript.js';

const context = BACKGROUND_CONTEXT;
const none: WithdrawnNotices = { has: () => false, add: () => {} };
const ordinal = (id: EntryId) => Number(id) * 1024;
const FILLER = 'The build finished and the agent read the next file before it answered the question about the release.';

/** Timer turns are where workerd's clock moves: a step is timed across one. */
async function timed<T>(work: () => T): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = work();
  const tick = Promise.withResolvers<void>();
  setTimeout(tick.resolve, 0);
  await tick.promise;
  return { value, ms: Date.now() - started };
}

export class HistorySearchProof extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    await this.ctx.storage.deleteAll();
    return Response.json(new URL(request.url).searchParams.has('benchmark') ? await this.benchmark() : await this.proof());
  }

  /** Pi over this object's SQLite, with each transaction's end calling `written()` of whichever index is open. */
  private async open() {
    const hook: { written(): void } = { written: () => {} };
    const storage = await SqliteStorage.open(new DurableObjectSqliteDatabase(this.ctx.storage, createStorageReads(), () => hook.written()));
    const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
    return { harness, hook, root: await harness.root(context) };
  }

  private index(hook: { written(): void }, options: { limits?: Partial<HistorySearchLimits>; events?: HistorySearchEvent[]; scheduled?: number[]; reports?: unknown[] } = {}) {
    const index = new HistorySearchIndex({
      storage: this.ctx.storage, withdrawn: none, limits: options.limits,
      schedule: async timestamp => { options.scheduled?.push(timestamp); }, report: error => { if (!options.reports) throw error; options.reports.push(error); }, log: event => { options.events?.push(event); },
    });
    hook.written = () => index.written();
    return index;
  }

  private async append(conversation: Conversation, texts: readonly string[]) {
    const ids: EntryId[] = [];
    for (let start = 0; start < texts.length; start += 500) {
      await conversation.commit(async tx => {
        for (const text of texts.slice(start, start + 500)) ids.push((await tx.appendEntry(conversation.id, { kind: 'pi.user', model: [{ role: 'user', content: text, timestamp: Date.UTC(2026, 10, 1) + ids.length * 1000 }] })).id);
      }, context);
    }
    return ids;
  }

  private async proof() {
    const { harness, hook, root } = await this.open();
    const sql = this.ctx.storage.sql;
    try {
      // History written before the index existed: one old event with words nothing else has, 2,500 newer ones, and the
      // events the phrase, ranking and identifier cases read.
      const oldest = (await this.append(root, [`${'Preamble about the plan. '.repeat(20)}The zanzibar marmalade migration was rolled back.`]))[0]!;
      const cases = await this.append(root, [
        'the quick brown fox jumps', 'the brown quick fox jumps',
        'deploy deploy deploy pipeline', `${FILLER} ${FILLER} ${FILLER} Then a deploy started. ${FILLER} ${FILLER}`,
        'We call frobnicateWidget from the loader.',
      ]);
      const pivot = cases.at(-1)!;
      const fork = await root.fork(pivot, { ownership: { kind: 'ownerless' } }, context);
      const [rewound] = await this.append(root, ['After the pivot the quokka plan was dropped.']);
      await this.append(root, Array.from({ length: 2_500 }, (_, n) => `${FILLER} (${n})`));
      const [recent] = await this.append(root, ['A recent note names the wombat release.']);
      const conversations = [Number(root.id)];
      const search = (query: string, options: Partial<HistorySearchRequest> = {}, scope: readonly number[] | null = conversations) => index.search({ query, offset: 0, limit: 20, ...options }, scope);

      const events: HistorySearchEvent[] = [];
      const scheduled: number[] = [];
      const reports: unknown[] = [];
      const entries = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM entries').one().count;
      let index = this.index(hook, { limits: { stepBytes: 60_000, txnEntries: 100 }, events, scheduled, reports });
      assert.equal(sql.exec<{ backfill_end: number }>('SELECT backfill_end FROM history_search_state').one().backfill_end, recent, 'Entries up to the newest one at creation are left to the backfill');

      // Nothing indexed yet: the search scans newest first within its budget. The recent word is found; the old one is
      // more than 2,000 events back, past the scan, and coverage says how much is not indexed.
      const before = await search('wombat zanzibar');
      assert.deepEqual(before.hits.map(hit => [hit.ordinal, hit.indexed]), [[ordinal(recent!), false]]);
      assert.deepEqual(before.coverage, { complete: false, unindexedEntries: entries, scannedEvents: 2_000, scanComplete: false, failure: null });
      assert.ok(scheduled.length > 0, 'A search of an index still being built schedules its alarm');

      // A few steps, then a new isolate (a reset during a step): it resumes from the high-water mark, so across the
      // interruption each entry is read once.
      let read = 0;
      const advance = () => { const step = index.step(); if (step?.phase === 'backfill') read += step.entries; return step; };
      for (let n = 0; n < 3; n++) assert.ok(advance());
      const through = sql.exec<{ through: number }>('SELECT through FROM history_search_conversation WHERE conversation_id=?', Number(root.id)).one().through;
      assert.ok(through > oldest && through < recent!, `Three steps index part of the conversation (through ${through})`);
      const partial = await search('zanzibar');
      assert.deepEqual(partial.hits.map(hit => [hit.ordinal, hit.indexed]), [[ordinal(oldest), true]], 'The indexed head answers while the tail is scanned');
      assert.equal(partial.coverage.complete, false);
      assert.ok(partial.coverage.unindexedEntries < entries - 500, `Coverage shrinks as the backfill goes (${partial.coverage.unindexedEntries} left)`);
      sql.exec('UPDATE history_search_state SET running_since=1');
      index = this.index(hook, { limits: { stepBytes: 60_000, txnEntries: 100 }, events, scheduled, reports });
      await index.drive();
      assert.equal(sql.exec<{ failures: number }>('SELECT failures FROM history_search_state').one().failures, 1, 'A reset during a step counts as a failed step and backs off');
      let steps = 3;
      while (advance()) assert.ok(++steps < 200, 'Each step advances the high-water mark');
      assert.equal(read, entries, 'The backfill read each entry once');
      const indexed = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM history_search_event').one().count;
      assert.equal(indexed, entries, 'Every event is indexed once across the interruption');
      assert.equal(reports.length, 1, 'The reset was reported');
      assert.ok(steps > 10, `Bounded steps (${steps})`);
      const built = events.find(event => event.event === 'history_search_built');
      assert.ok(built && built.events === indexed && typeof built.indexBytes === 'number' && built.indexBytes > 0, 'The end of the backfill logs the index size');

      // A word only in the oldest event is found in one search, with a snippet of the event's own text around it.
      const old = await search('zanzibar');
      assert.deepEqual(old.hits.map(hit => hit.ordinal), [ordinal(oldest)]);
      assert.equal(old.coverage.complete, true);
      assert.ok(!old.hits[0]!.snippet.startsWith('user') && old.hits[0]!.snippet.includes('The zanzibar marmalade migration was rolled back.'), old.hits[0]!.snippet);
      assert.deepEqual((await search('zanzi*')).hits.map(hit => hit.ordinal), [ordinal(oldest)], 'A trailing * matches a prefix');

      // A quoted phrase matches only the exact phrase; the same words unquoted match both.
      assert.deepEqual((await search('"quick brown fox"')).hits.map(hit => hit.ordinal), [ordinal(cases[0]!)]);
      assert.deepEqual((await search('quick brown fox')).hits.map(hit => hit.ordinal).sort(), [ordinal(cases[0]!), ordinal(cases[1]!)].sort());
      // BM25: the short event that says deploy three times ranks above the long one that says it once.
      assert.deepEqual((await search('deploy')).hits.map(hit => hit.ordinal), [ordinal(cases[2]!), ordinal(cases[3]!)]);
      // A camelCase word's parts are words too.
      assert.deepEqual((await search('widget')).hits.map(hit => hit.ordinal), [ordinal(cases[4]!)]);
      // An exclusive ordinal bound (a ghost's until) keeps later events out.
      assert.deepEqual((await search('wombat zanzibar', { before: ordinal(pivot) })).hits.map(hit => hit.ordinal), [ordinal(oldest)]);
      // Pages of ranked hits.
      const page = await search('build', { limit: 5 });
      assert.equal(page.hits.length, 5);
      assert.equal(page.more, true);
      const next = await search('build', { offset: 5, limit: 5 });
      assert.equal(new Set([...page.hits, ...next.hits].map(hit => hit.ordinal)).size, 10);

      // A new event is searchable as soon as its write commits, with no step run.
      const [fresh] = await this.append(root, ['The capybara rollout starts tomorrow.']);
      assert.equal(sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM history_search_pending').one().count, 0);
      assert.deepEqual((await search('capybara')).hits.map(hit => [hit.ordinal, hit.indexed]), [[ordinal(fresh!), true]]);
      assert.equal(index.step(), null);

      // A fork (how a session is rewound) reads its parent only up to the fork: what the parent said after it is not in
      // the fork's history. Its own events, and the parent's before the fork, are, reported under the fork.
      const [own] = await this.append(fork, ['The fork chose the axolotl plan.']);
      assert.deepEqual((await search('quokka', {}, [Number(fork.id)])).hits, []);
      assert.deepEqual((await search('quokka')).hits.map(hit => hit.ordinal), [ordinal(rewound!)]);
      assert.deepEqual((await search('axolotl zanzibar', {}, [Number(fork.id)])).hits.map(hit => [hit.conversationId, hit.ordinal]).sort(), [[String(fork.id), ordinal(own!)], [String(fork.id), ordinal(oldest)]].sort());
      // The whole workspace: each event once, under the conversation it was written in.
      assert.deepEqual((await search('axolotl quokka', {}, null)).hits.map(hit => [hit.conversationId, hit.ordinal]).sort(), [[String(fork.id), ordinal(own!)], [String(root.id), ordinal(rewound!)]].sort());
      return { passed: true };
    } finally { await harness.close(context); }
  }

  /** A 40,000-event transcript of realistic sizes written before the index exists, then indexed with the default
   * limits: steps, bytes and time per step, the index's size, and search times. */
  private async benchmark() {
    const { harness, hook, root } = await this.open();
    const sql = this.ctx.storage.sql;
    try {
      const words = ['build', 'deploy', 'migration', 'bucket', 'worker', 'cache', 'review', 'schema', 'token', 'request', 'parser', 'render', 'session', 'machine', 'branch', 'commit'];
      const texts = Array.from({ length: 40_000 }, (_, n) => {
        const size = n % 10 === 0 ? 8_000 : n % 3 === 0 ? 2_000 : 300;
        let text = `Step ${n}: `;
        for (let k = 0; text.length < size; k++) text += `${words[(n * 7 + k * 13) % words.length]} ${k % 5 === 0 ? `item${n}_${k}` : 'and'} `;
        return n === 123 ? `${text} the unique okapi needle` : text;
      });
      const databaseBefore = sql.databaseSize;
      await this.append(root, texts);
      const entriesBytes = sql.exec<{ bytes: number }>('SELECT SUM(LENGTH(CAST(record AS BLOB))) AS bytes FROM entries').one().bytes;
      const databaseWithEntries = sql.databaseSize;
      const events: HistorySearchEvent[] = [];
      const index = this.index(hook, { events });
      const steps: { entries: number; events: number; bytes: number; ms: number }[] = [];
      for (;;) {
        const step = await timed(() => index.step());
        if (!step.value) break;
        steps.push({ entries: step.value.entries, events: step.value.events, bytes: step.value.bytes, ms: step.ms });
      }
      const indexBytes = events.find(event => event.event === 'history_search_built')?.indexBytes ?? null;
      const conversations = [Number(root.id)];
      const query = async (text: string) => { const started = Date.now(); const value = await index.search({ query: text, offset: 0, limit: 20 }, conversations); const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, 0); await tick.promise; return { hits: value.hits.length, more: value.more, ms: Date.now() - started }; };
      const rare = await query('okapi');
      assert.equal(rare.hits, 1);
      const live = await timed(() => undefined);
      const writeStarted = Date.now();
      await this.append(root, ['A live write about the okapi.']);
      const liveWriteMs = Date.now() - writeStarted;
      return { passed: true, measurement: {
        events: texts.length, entriesBytes, databaseBytes: { before: databaseBefore, withEntries: databaseWithEntries, indexed: sql.databaseSize }, indexBytes,
        steps: steps.length, stepBytes: { max: Math.max(...steps.map(step => step.bytes)), mean: Math.round(steps.reduce((sum, step) => sum + step.bytes, 0) / steps.length) },
        stepMs: { max: Math.max(...steps.map(step => step.ms)), mean: Math.round(steps.reduce((sum, step) => sum + step.ms, 0) / steps.length), total: steps.reduce((sum, step) => sum + step.ms, 0) },
        eventsPerStep: Math.round(steps.reduce((sum, step) => sum + step.events, 0) / steps.length),
        search: { rare, common: await query('deploy'), phrase: await query('"deploy and"'), prefix: await query('pars*') },
        liveWriteMs, timerMs: live.ms,
      } };
    } finally { await harness.close(context); }
  }
}
export default { fetch(request: Request, env: { PROOF: DurableObjectNamespace<HistorySearchProof> }) { return env.PROOF.getByName('proof').fetch(request); } };
