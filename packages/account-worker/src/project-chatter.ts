import {
  CHATTER_ACTIVE_MS, CHATTER_ACTIVE_TOPICS, CHATTER_ISSUE_STATES, CHATTER_KINDS, CHATTER_PAGE_EVENTS, CHATTER_RETENTION_MS,
  CHATTER_TEXT_CHARACTERS, CHATTER_TOPIC_CHARACTERS, ChatterAuthorSchema, ChatterChangeSchema, ChatterTopicActionSchema,
  displayChatterTopic, normalizeChatterTopic, similarChatterTopic,
  type ChatterAuthor, type ChatterChange, type ChatterEvent, type ChatterIssueState, type ChatterKind, type ChatterPage,
  type ChatterPost, type ChatterTopic, type ChatterTopicAction, type ChatterTopicLine,
} from '@gitspace/protocol/chatter-contract';
import { projectLiveKey } from '@gitspace/protocol/live-notice';
import { z } from 'zod';
import { notifyBrowsers } from './live-notices.js';
import { BudgetedDurableObject } from './storage-quarantine.js';

interface EventRow extends Record<string, SqlStorageValue> {
  seq: number;
  id: string;
  at: string;
  type: string;
  topic_key: string;
  topic: string;
  author_kind: string;
  author_id: string;
  author_name: string;
  kind: string | null;
  text: string | null;
  change_json: string | null;
}

interface TopicRow extends Record<string, SqlStorageValue> {
  key: string;
  display: string;
  first_at: string;
  last_at: string;
  posts: number;
  participants_json: string;
  state: string | null;
  state_by: string | null;
  state_at: string | null;
  fixed_in: string | null;
  filed_json: string | null;
  alias_of: string | null;
}

interface Participant extends ChatterAuthor { posts: number; lastAt: string }

export type ChatterInvalid = { kind: 'invalid'; field: string; message: string };
export type ChatterFailure = ChatterInvalid | { kind: 'notFound'; key: string };
export type ChatterOutcome<T, F extends ChatterFailure = ChatterFailure> = { status: 'ok'; value: T } | { status: 'error'; failure: F };
export interface ChatterPostResult { post: ChatterPost; topic: ChatterTopic; similar: ChatterTopic | null; line: ChatterTopicLine | null }
export interface ChatterActResult { topic: ChatterTopic; line: ChatterTopicLine | null }

/**
 * A project's Chatter (docs/CHATTER-DESIGN.md §5), named `${ACCOUNT_ID}:${projectId}`. Every post has a topic; posts
 * whose topics normalize the same are one thread (`chatter_topics`, one row per key), and an issue is a topic with a
 * state. A topic and all its events expire together 90 days after its last post, by this object's alarm. It never
 * touches the project object; each write tells open tabs through a project `chatter` live notice.
 */
export class ProjectChatterDO extends BudgetedDurableObject {
  private readonly participantsSchema = z.array(ChatterAuthorSchema.extend({ posts: z.number().int().nonnegative(), lastAt: z.string() }));
  private readonly postSchema = z.object({
    projectId: z.string().min(1),
    id: z.string().min(1).max(128),
    topic: z.string(),
    kind: z.enum(CHATTER_KINDS),
    text: z.string(),
    author: ChatterAuthorSchema,
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS chatter_events(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          at TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('post', 'topic')),
          topic_key TEXT NOT NULL,
          topic TEXT NOT NULL,
          author_kind TEXT NOT NULL,
          author_id TEXT NOT NULL,
          author_name TEXT NOT NULL,
          kind TEXT,
          text TEXT,
          change_json TEXT
        );
        CREATE INDEX IF NOT EXISTS chatter_events_topic ON chatter_events(topic_key, seq);
        CREATE INDEX IF NOT EXISTS chatter_events_at ON chatter_events(at);
        CREATE TABLE IF NOT EXISTS chatter_topics(
          key TEXT PRIMARY KEY,
          display TEXT NOT NULL,
          first_at TEXT NOT NULL,
          last_at TEXT NOT NULL,
          posts INTEGER NOT NULL,
          participants_json TEXT NOT NULL,
          state TEXT CHECK (state IN ('open', 'resolved', 'dismissed')),
          state_by TEXT,
          state_at TEXT,
          fixed_in TEXT,
          filed_json TEXT,
          alias_of TEXT
        );
        CREATE INDEX IF NOT EXISTS chatter_topics_last ON chatter_topics(last_at);
        CREATE INDEX IF NOT EXISTS chatter_topics_state ON chatter_topics(state, last_at);
        CREATE INDEX IF NOT EXISTS chatter_topics_alias ON chatter_topics(alias_of);
      `);
    });
  }

  /** A page of the stream, oldest first (`ChatterPageCodec`). */
  watch(input: { after?: number; before?: number; topic?: string; limit?: number }): ChatterPage {
    const limit = Math.min(input.limit ?? CHATTER_PAGE_EVENTS, CHATTER_PAGE_EVENTS);
    const key = input.topic === undefined ? null : this.resolve(normalizeChatterTopic(input.topic));
    const topic = key === null ? '' : 'AND topic_key = ?';
    const bindings = key === null ? [] : [key];
    let rows: EventRow[];
    if (input.after !== undefined) {
      rows = this.rows<EventRow>(`SELECT * FROM chatter_events WHERE seq > ? ${topic} ORDER BY seq LIMIT ?`, input.after, ...bindings, limit + 1);
    } else {
      rows = this.rows<EventRow>(`SELECT * FROM chatter_events WHERE seq < ? ${topic} ORDER BY seq DESC LIMIT ?`, input.before ?? Number.MAX_SAFE_INTEGER, ...bindings, limit + 1).reverse();
    }
    const more = rows.length > limit;
    const page = more ? (input.after !== undefined ? rows.slice(0, limit) : rows.slice(1)) : rows;
    const keys = [...new Set(page.map(row => row.topic_key))];
    const topics = keys.length === 0 ? [] : this.rows<TopicRow>(`SELECT * FROM chatter_topics WHERE key IN (${keys.map(() => '?').join(',')})`, ...keys);
    const cursor = this.rows<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM chatter_events')[0]?.seq ?? 0;
    return { events: page.map(row => this.eventView(row)), topics: topics.map(row => this.topicView(row)), cursor, more };
  }

  /** The active topics (a post in the last 7 days, or an open issue), newest first; with `query`, every live topic
   * whose key contains it. */
  topics(input: { query?: string; limit?: number }): ChatterTopic[] {
    const query = input.query === undefined ? '' : normalizeChatterTopic(input.query);
    if (query === '') return this.active(Date.now(), Math.min(input.limit ?? CHATTER_ACTIVE_TOPICS, 100)).map(row => this.topicView(row));
    return this.rows<TopicRow>('SELECT * FROM chatter_topics WHERE alias_of IS NULL AND instr(key, ?) > 0 ORDER BY last_at DESC LIMIT ?', query, Math.min(input.limit ?? 20, 100))
      .map(row => this.topicView(row));
  }

  /**
   * A post under its topic. A retry with the same `id` returns the first post. A new topic gets the closest active
   * topic as `similar`. A tooling post opens its topic as an issue, or reopens it when resolved or dismissed (a fresh
   * report means the failure came back); any other post leaves the state alone.
   */
  async post(raw: { projectId: string; id: string; topic: string; kind: ChatterKind; text: string; author: ChatterAuthor }): Promise<ChatterOutcome<ChatterPostResult, ChatterInvalid>> {
    const input = this.postSchema.parse(raw);
    const written = this.rows<EventRow>("SELECT * FROM chatter_events WHERE id = ? AND type = 'post'", input.id)[0];
    if (written) {
      const post = this.eventView(written);
      const topic = this.topicRow(written.topic_key);
      if (post.type === 'post' && topic) return { status: 'ok', value: { post, topic: this.topicView(topic), similar: null, line: null } };
    }
    if (input.topic.trim().length > CHATTER_TOPIC_CHARACTERS) return invalid('topic', `A topic is at most ${CHATTER_TOPIC_CHARACTERS} characters`);
    const display = displayChatterTopic(input.topic);
    const normalized = normalizeChatterTopic(display);
    if (normalized === '') return invalid('topic', 'A topic names one specific thing in a few words');
    const text = input.text.trim();
    if (text === '') return invalid('text', 'A post needs text');
    if (text.length > CHATTER_TEXT_CHARACTERS) return invalid('text', `A post is at most ${CHATTER_TEXT_CHARACTERS} characters`);
    const now = Date.now();
    const at = new Date(now).toISOString();
    const key = this.resolve(normalized);
    const existing = this.topicRow(key);
    const similar = existing ? null : similarChatterTopic(key, this.active(now, CHATTER_ACTIVE_TOPICS));
    const opens = input.kind === 'tooling' && existing?.state !== 'open';
    const seq = this.ctx.storage.transactionSync(() => {
      const posted = this.insert({ id: input.id, at, type: 'post', topicKey: key, topic: display, author: input.author, kind: input.kind, text, change: null });
      if (existing) {
        this.ctx.storage.sql.exec('UPDATE chatter_topics SET last_at = ?, posts = posts + 1, participants_json = ? WHERE key = ?',
          at, JSON.stringify(this.joined(this.participants(existing), input.author, 1, at)), key);
      } else {
        this.ctx.storage.sql.exec('INSERT INTO chatter_topics(key, display, first_at, last_at, posts, participants_json) VALUES (?, ?, ?, ?, 1, ?)',
          key, display, at, at, JSON.stringify(this.joined([], input.author, 1, at)));
      }
      if (!opens) return posted;
      this.ctx.storage.sql.exec("UPDATE chatter_topics SET state = 'open', state_by = ?, state_at = ? WHERE key = ?", input.author.name, at, key);
      return this.insert({ id: `${input.id}:open`, at, type: 'topic', topicKey: key, topic: display, author: input.author, kind: null, text: null, change: { kind: 'state', state: 'open', from: issueState(existing?.state ?? null), fixedIn: null } });
    });
    await this.changed(input.projectId, seq);
    const events = this.rows<EventRow>('SELECT * FROM chatter_events WHERE id IN (?, ?) ORDER BY seq', input.id, `${input.id}:open`).map(row => this.eventView(row));
    const post = events.find(event => event.type === 'post');
    const line = events.find(event => event.type === 'topic');
    const topic = this.topicRow(key);
    if (!post || post.type !== 'post' || !topic) throw new Error('Chatter post was not recorded');
    return { status: 'ok', value: { post, topic: this.topicView(topic), similar: similar ? this.topicView(similar) : null, line: line?.type === 'topic' ? line : null } };
  }

  /**
   * A person's action on a topic. State: a topic that is not an issue can only be opened; `fixedIn` goes with
   * resolved. Merge: the topic's events move to `into` (after following its alias), its aliases follow, `into` keeps
   * its state unless it has none, and the merged topic stays as an alias so a later post under it lands in `into`.
   */
  async act(input: { projectId: string; key: string; action: ChatterTopicAction; author: ChatterAuthor }): Promise<ChatterOutcome<ChatterActResult>> {
    const action = ChatterTopicActionSchema.safeParse(input.action);
    if (!action.success) return invalid('action', action.error.issues[0]?.message ?? 'Unknown topic action');
    const author = ChatterAuthorSchema.parse(input.author);
    const named = normalizeChatterTopic(input.key);
    const at = new Date().toISOString();
    const id = crypto.randomUUID();
    if (action.data.kind === 'state') {
      const row = this.topicRow(this.resolve(named));
      if (!row) return { status: 'error', failure: { kind: 'notFound', key: named } };
      const { state, fixedIn } = action.data;
      const from = issueState(row.state);
      if (from === null && state !== 'open') return invalid('action', 'A topic that is not an issue can only be opened');
      if (fixedIn !== null && state !== 'resolved') return invalid('action', 'A fixed-in commit goes with resolving');
      const fixed = state === 'resolved' ? fixedIn : row.fixed_in;
      if (state === from && fixed === row.fixed_in) return { status: 'ok', value: { topic: this.topicView(row), line: null } };
      const seq = this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('UPDATE chatter_topics SET state = ?, state_by = ?, state_at = ?, fixed_in = ? WHERE key = ?', state, author.name, at, fixed, row.key);
        return this.insert({ id, at, type: 'topic', topicKey: row.key, topic: row.display, author, kind: null, text: null, change: { kind: 'state', state, from, fixedIn: state === 'resolved' ? fixedIn : null } });
      });
      await this.changed(input.projectId, seq);
      return this.acted(row.key, id);
    }
    const source = this.topicRow(named);
    if (!source) return { status: 'error', failure: { kind: 'notFound', key: named } };
    if (source.alias_of !== null) return invalid('key', `This topic was already merged into ${source.alias_of}`);
    const intoKey = this.resolve(normalizeChatterTopic(action.data.into));
    const into = this.topicRow(intoKey);
    if (!into) return { status: 'error', failure: { kind: 'notFound', key: intoKey } };
    if (into.key === source.key) return invalid('into', 'A topic can’t be merged into itself');
    const seq = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('UPDATE chatter_events SET topic_key = ? WHERE topic_key = ?', into.key, source.key);
      this.ctx.storage.sql.exec('UPDATE chatter_topics SET alias_of = ? WHERE alias_of = ?', into.key, source.key);
      let participants = this.participants(into);
      for (const participant of this.participants(source)) participants = this.joined(participants, participant, participant.posts, participant.lastAt);
      const keepsState = into.state !== null;
      this.ctx.storage.sql.exec(
        'UPDATE chatter_topics SET first_at = ?, last_at = ?, posts = ?, participants_json = ?, state = ?, state_by = ?, state_at = ?, fixed_in = ? WHERE key = ?',
        source.first_at < into.first_at ? source.first_at : into.first_at, source.last_at > into.last_at ? source.last_at : into.last_at,
        into.posts + source.posts, JSON.stringify(participants),
        keepsState ? into.state : source.state, keepsState ? into.state_by : source.state_by, keepsState ? into.state_at : source.state_at, keepsState ? into.fixed_in : source.fixed_in,
        into.key,
      );
      this.ctx.storage.sql.exec("UPDATE chatter_topics SET alias_of = ?, posts = 0, participants_json = '[]', state = NULL, state_by = NULL, state_at = NULL, fixed_in = NULL WHERE key = ?", into.key, source.key);
      return this.insert({ id, at, type: 'topic', topicKey: into.key, topic: into.display, author, kind: null, text: null, change: { kind: 'merge', from: source.key, fromDisplay: source.display } });
    });
    await this.changed(input.projectId, seq);
    return this.acted(into.key, id);
  }

  /** The project is deleted: its posts, topics and alarm go with it. */
  async erase(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Each topic whose last post is 90 days old goes, with its events and the aliases pointing at it. */
  async alarm(): Promise<void> {
    const cutoff = new Date(Date.now() - CHATTER_RETENTION_MS).toISOString();
    const expired = this.rows<{ key: string }>('SELECT key FROM chatter_topics WHERE alias_of IS NULL AND last_at <= ?', cutoff);
    if (expired.length > 0) {
      this.ctx.storage.transactionSync(() => {
        for (const { key } of expired) {
          this.ctx.storage.sql.exec('DELETE FROM chatter_events WHERE topic_key = ?', key);
          this.ctx.storage.sql.exec('DELETE FROM chatter_topics WHERE key = ? OR alias_of = ?', key, key);
        }
      });
    }
    await this.reschedule();
  }

  private async changed(projectId: string, seq: number): Promise<void> {
    await this.reschedule();
    await notifyBrowsers(this.env, [{ ...projectLiveKey(projectId, 'chatter'), version: seq }]);
  }

  /** The alarm follows the oldest topic's expiry. */
  private async reschedule(): Promise<void> {
    const oldest = this.rows<{ at: string | null }>('SELECT MIN(last_at) AS at FROM chatter_topics WHERE alias_of IS NULL')[0]?.at ?? null;
    if (oldest === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const due = Date.parse(oldest) + CHATTER_RETENTION_MS;
    if (await this.ctx.storage.getAlarm() !== due) await this.ctx.storage.setAlarm(due);
  }

  private acted(key: string, id: string): ChatterOutcome<ChatterActResult> {
    const topic = this.topicRow(key);
    const line = this.rows<EventRow>('SELECT * FROM chatter_events WHERE id = ?', id)[0];
    if (!topic || !line) throw new Error('Chatter topic action was not recorded');
    const view = this.eventView(line);
    return { status: 'ok', value: { topic: this.topicView(topic), line: view.type === 'topic' ? view : null } };
  }

  private insert(event: { id: string; at: string; type: 'post' | 'topic'; topicKey: string; topic: string; author: ChatterAuthor; kind: ChatterKind | null; text: string | null; change: ChatterChange | null }): number {
    return this.ctx.storage.sql.exec<{ seq: number }>(
      'INSERT INTO chatter_events(id, at, type, topic_key, topic, author_kind, author_id, author_name, kind, text, change_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq',
      event.id, event.at, event.type, event.topicKey, event.topic, event.author.kind, event.author.id, event.author.name, event.kind, event.text, event.change === null ? null : JSON.stringify(event.change),
    ).one().seq;
  }

  /** A topic key after following a merge. */
  private resolve(key: string): string {
    return this.rows<{ alias_of: string | null }>('SELECT alias_of FROM chatter_topics WHERE key = ?', key)[0]?.alias_of ?? key;
  }

  private active(now: number, limit: number): TopicRow[] {
    return this.rows<TopicRow>("SELECT * FROM chatter_topics WHERE alias_of IS NULL AND (last_at >= ? OR state = 'open') ORDER BY last_at DESC LIMIT ?", new Date(now - CHATTER_ACTIVE_MS).toISOString(), limit);
  }

  private topicRow(key: string): TopicRow | undefined {
    return this.rows<TopicRow>('SELECT * FROM chatter_topics WHERE key = ?', key)[0];
  }

  private participants(row: TopicRow): Participant[] {
    return this.participantsSchema.parse(JSON.parse(row.participants_json));
  }

  /** `participants` with `author` counted `posts` more times, the most recent first. */
  private joined(participants: readonly Participant[], author: ChatterAuthor, posts: number, at: string): Participant[] {
    const known = participants.find(entry => entry.kind === author.kind && entry.id === author.id);
    const others = participants.filter(entry => entry !== known);
    const lastAt = known && known.lastAt > at ? known.lastAt : at;
    const name = known && known.lastAt > at ? known.name : author.name;
    return [...others, { kind: author.kind, id: author.id, name, posts: (known?.posts ?? 0) + posts, lastAt }].sort((left, right) => right.lastAt.localeCompare(left.lastAt));
  }

  private topicView(row: TopicRow): ChatterTopic {
    return {
      key: row.key,
      display: row.display,
      firstAt: new Date(row.first_at),
      lastAt: new Date(row.last_at),
      posts: row.posts,
      participants: this.participants(row).map(({ kind, id, name }) => ({ kind, id, name })),
      state: issueState(row.state),
      stateBy: row.state_by,
      stateAt: row.state_at === null ? null : new Date(row.state_at),
      fixedIn: row.fixed_in,
    };
  }

  private eventView(row: EventRow): ChatterEvent {
    const author = ChatterAuthorSchema.parse({ kind: row.author_kind, id: row.author_id, name: row.author_name });
    const at = new Date(row.at);
    if (row.type === 'post') {
      return { type: 'post', offset: row.seq, id: row.id, at, topicKey: row.topic_key, topic: row.topic, author, kind: z.enum(CHATTER_KINDS).parse(row.kind), text: row.text ?? '' };
    }
    return { type: 'topic', offset: row.seq, id: row.id, at, topicKey: row.topic_key, author, change: ChatterChangeSchema.parse(JSON.parse(row.change_json ?? 'null')) };
  }

  private rows<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }
}

function invalid(field: string, message: string): { status: 'error'; failure: ChatterInvalid } {
  return { status: 'error', failure: { kind: 'invalid', field, message } };
}

function issueState(value: string | null): ChatterIssueState | null {
  return CHATTER_ISSUE_STATES.find(state => state === value) ?? null;
}
