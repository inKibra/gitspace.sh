import {
  CHATTER_ACTIVE_MS, CHATTER_ACTIVE_TOPICS, CHATTER_ISSUE_STATES, CHATTER_KINDS, CHATTER_LEVELS, CHATTER_MAX_PICKS, CHATTER_PAGE_EVENTS, CHATTER_PROJECT_STRIP, CHATTER_RETENTION_MS,
  CHATTER_TEXT_CHARACTERS, CHATTER_TOPIC_CHARACTERS, ChatterAuthorSchema, ChatterChangeSchema, ChatterFiledSchema, ChatterSpotSchema, ChatterTopicActionSchema,
  defaultChatterLevel, displayChatterTopic, normalizeChatterTopic, runtimeFailureChatterTopic, similarChatterTopic,
  type ChatterAuthor, type ChatterChange, type ChatterDigest, type ChatterEvent, type ChatterFiled, type ChatterHeard, type ChatterHearings, type ChatterIssueState, type ChatterKind,
  type ChatterLeft, type ChatterLevel, type ChatterPage, type ChatterPost, type ChatterProjectMuteLine, type ChatterReturnedLine, type ChatterSpot, type ChatterTopic, type ChatterTopicAction,
  type ChatterTopicLine, type ChatterVolumeLine, type ChatterVolumes,
} from '@gitspace/protocol/chatter-contract';
import { projectLiveKey } from '@gitspace/protocol/live-notice';
import { z } from 'zod';
import {
  ChatterListenerSchema, chatterStrip, digestPicks, digestQuestion, pickDigest, projectDecider, stripLevel, weighDigest,
  type ChatterListener, type ChatterMix, type DigestDecide, type TopicPick,
} from './chatter-digest.js';
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
  author_phase: string | null;
  spot_json: string | null;
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
  repeats: number;
}

interface Participant extends ChatterAuthor { posts: number; lastAt: string }

interface VolumeRow extends Record<string, SqlStorageValue> { strip: string; level: string | null; muted: number; by: string; at: string }
interface SettingsRow extends Record<string, SqlStorageValue> { id: number; project_id: string | null; project_muted: number; by: string | null; at: string | null; build_at: number | null; build_since: number | null }
/** A listener: its description and position (`heard`, the newest offset it was told; `heard_at`, its last turn start),
 * and its latest built digest of the posts after `after_offset` through `through`. */
interface DigestRow extends Record<string, SqlStorageValue> {
  listener: string;
  profile_json: string;
  heard: number;
  heard_at: string;
  after_offset: number | null;
  through: number | null;
  digest_json: string | null;
  built_at: string | null;
}
type VolumeChange = { strip: string; name: string; level: ChatterLevel; muted: boolean; from: ChatterLevel; wasMuted: boolean };
/** What a turn start hears: its digest, the posts it heard (oldest first), how many others in how many topics, and the
 * characters every new post but its own would take quoted whole (what the digest saves against). */
export interface ChatterHearing { digest: ChatterDigest; posts: ChatterPost[]; others: number; otherTopics: number; fullCharacters: number }

export type ChatterInvalid = { kind: 'invalid'; field: string; message: string };
export type ChatterFailure = ChatterInvalid | { kind: 'notFound'; key: string };
export type ChatterOutcome<T, F extends ChatterFailure = ChatterFailure> = { status: 'ok'; value: T } | { status: 'error'; failure: F };
export interface ChatterPostResult { post: ChatterPost; topic: ChatterTopic; similar: ChatterTopic | null; line: ChatterTopicLine | null }
export interface ChatterActResult { topic: ChatterTopic; line: ChatterTopicLine | null }
/** A runtime failure posted as a GitSpace tooling post, or folded into its open topic as a repeat. */
export type ChatterFailureResult = { kind: 'posted'; post: ChatterPost; topic: ChatterTopic } | { kind: 'repeated'; topic: ChatterTopic };
/** What `chatter_read` returns: topics (one topic's row, the active topics, or issue topics) and posts, newest first. */
export interface ChatterRead { topics: ChatterTopic[]; posts: ChatterPost[]; cursor: number; more: boolean }
/** Posts `read` returns when the caller names no limit. */
const READ_POSTS = 30;
/** Issue topics one workspace's Issues tab lists at most. */
const WORKSPACE_ISSUES = 100;
/** A workspace's tooling posts the Issues tab shows per topic, newest first. */
const ISSUE_POSTS = 3;
/** Authors that are a workspace: its agent, the project agent (the base workspace), or GitSpace for its runtime. */
const WORKSPACE_AUTHOR_KINDS = "('workspace','project','gitspace')";
/** Posts one digest weighs, the newest; older ones are left to `chatter_read`. */
const DIGEST_POSTS = 300;
/** A conversation that never heard starts with the posts of this last stretch. */
const FIRST_HEARING_MS = 24 * 60 * 60_000;
/** Digests are built for listeners that started a turn this recently; an idle one is built for when it next runs. */
const LISTENER_ACTIVE_MS = 2 * 60 * 60_000;
/** A build runs this long after the last post of a burst… */
const BUILD_SETTLE_MS = 30_000;
/** …and no later than this after the first. */
const BUILD_LONGEST_MS = 2 * 60_000;
/** A listener in a long run (no turn start since its last build) is rebuilt at most this often. */
const REBUILD_MS = 10 * 60_000;
/** Posts this recent make their author's sidebar indicator glow. */
const RECENT_POST_MS = 15_000;
/** Characters a quoted post's line takes besides its text: time, author, phase, kind and reason. */
const DIGEST_LINE_CHARACTERS = 60;

/**
 * A project's Chatter (docs/CHATTER-DESIGN.md §5), named `${ACCOUNT_ID}:${projectId}`. Every post has a topic; posts
 * whose topics normalize the same are one thread (`chatter_topics`, one row per key), and an issue is a topic with a
 * state. A returned post (an agent's that asked another workspace to do work) is a line under no topic. A topic and all
 * its events expire together 90 days after its last post, a returned line 90 days after its own time, by this object's
 * alarm. It never touches the project object; each write tells open tabs through a project `chatter` live notice.
 */
export class ProjectChatterDO extends BudgetedDurableObject {
  private readonly participantsSchema = z.array(ChatterAuthorSchema.extend({ posts: z.number().int().nonnegative(), lastAt: z.string() }));
  private readonly volumeChangeSchema = z.object({ strip: z.string(), name: z.string(), level: z.enum(CHATTER_LEVELS), muted: z.boolean(), from: z.enum(CHATTER_LEVELS), wasMuted: z.boolean() });
  private readonly builtSchema = z.object({
    heard: z.array(z.object({ offset: z.number().int(), via: z.enum(['floor', 'pick', 'newest']), reason: z.string(), strong: z.boolean() })),
    left: z.array(z.object({ offset: z.number().int(), why: z.string() })),
    model: z.string().nullable(),
  });
  private readonly postSchema = z.object({
    projectId: z.string().min(1),
    id: z.string().min(1).max(128),
    topic: z.string(),
    kind: z.enum(CHATTER_KINDS),
    text: z.string(),
    author: ChatterAuthorSchema,
    phase: z.string().nullable().default(null),
    spot: ChatterSpotSchema.nullable().default(null),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      const events = this.rows<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='chatter_events'")[0]?.sql ?? null;
      // An earlier table allowed fewer line types (milestone 2 also lacked a phase and spot): it is rebuilt once, keeping
      // the columns it had.
      const legacy = events !== null && !events.includes("'project-mute'");
      this.ctx.storage.transactionSync(() => {
        if (legacy) sql.exec('ALTER TABLE chatter_events RENAME TO chatter_events_old; DROP INDEX IF EXISTS chatter_events_topic; DROP INDEX IF EXISTS chatter_events_at');
        sql.exec(`
          CREATE TABLE IF NOT EXISTS chatter_events(
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            at TEXT NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('post', 'topic', 'returned', 'volume', 'project-mute')),
            topic_key TEXT NOT NULL,
            topic TEXT NOT NULL,
            author_kind TEXT NOT NULL,
            author_id TEXT NOT NULL,
            author_name TEXT NOT NULL,
            kind TEXT,
            text TEXT,
            change_json TEXT,
            author_phase TEXT,
            spot_json TEXT
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
            alias_of TEXT,
            repeats INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS chatter_topics_last ON chatter_topics(last_at);
          CREATE INDEX IF NOT EXISTS chatter_topics_state ON chatter_topics(state, last_at);
          CREATE INDEX IF NOT EXISTS chatter_topics_alias ON chatter_topics(alias_of);
          CREATE TABLE IF NOT EXISTS chatter_volumes(strip TEXT PRIMARY KEY, level TEXT CHECK (level IN ('mute', 'low', 'normal', 'high')), muted INTEGER NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS chatter_settings(id INTEGER PRIMARY KEY CHECK (id = 1), project_id TEXT, project_muted INTEGER NOT NULL DEFAULT 0, by TEXT, at TEXT, build_at INTEGER, build_since INTEGER);
          CREATE TABLE IF NOT EXISTS digests(
            listener TEXT PRIMARY KEY,
            profile_json TEXT NOT NULL,
            heard INTEGER NOT NULL,
            heard_at TEXT NOT NULL,
            after_offset INTEGER,
            through INTEGER,
            digest_json TEXT,
            built_at TEXT
          );
        `);
        if (legacy) {
          const kept = this.rows<{ name: string }>('PRAGMA table_info(chatter_events_old)').map(column => column.name).join(', ');
          sql.exec(`INSERT INTO chatter_events(${kept}) SELECT ${kept} FROM chatter_events_old`);
          sql.exec('DROP TABLE chatter_events_old');
        }
        if (!this.rows<{ name: string }>('PRAGMA table_info(chatter_topics)').some(column => column.name === 'repeats')) sql.exec('ALTER TABLE chatter_topics ADD COLUMN repeats INTEGER NOT NULL DEFAULT 0');
      });
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
    const keys = [...new Set(page.map(row => row.topic_key).filter(Boolean))];
    return { events: page.map(row => this.eventView(row)), topics: this.topicRows(keys).map(row => this.topicView(row)), cursor: this.cursor(), more };
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
   * report means the failure came back); any other post leaves the state alone. `phase` is a workspace author's phase,
   * `spot` a tooling post's tool, reference and machine.
   */
  async post(raw: { projectId: string; id: string; topic: string; kind: ChatterKind; text: string; author: ChatterAuthor; phase?: string | null; spot?: ChatterSpot | null }): Promise<ChatterOutcome<ChatterPostResult, ChatterInvalid>> {
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
      const posted = this.insert({ id: input.id, at, type: 'post', topicKey: key, topic: display, author: input.author, kind: input.kind, text, change: null, phase: input.phase, spot: input.spot });
      if (existing) {
        this.ctx.storage.sql.exec('UPDATE chatter_topics SET last_at = ?, posts = posts + 1, participants_json = ? WHERE key = ?',
          at, JSON.stringify(this.joined(this.participants(existing), input.author, 1, at)), key);
      } else {
        this.ctx.storage.sql.exec('INSERT INTO chatter_topics(key, display, first_at, last_at, posts, participants_json) VALUES (?, ?, ?, ?, 1, ?)',
          key, display, at, at, JSON.stringify(this.joined([], input.author, 1, at)));
      }
      if (!opens) return posted;
      this.ctx.storage.sql.exec("UPDATE chatter_topics SET state = 'open', state_by = ?, state_at = ? WHERE key = ?", input.author.name, at, key);
      return this.insert({ id: `${input.id}:open`, at, type: 'topic', topicKey: key, topic: display, author: input.author, kind: null, text: null, change: { kind: 'state', state: 'open', from: issueState(existing?.state ?? null), fixedIn: null }, phase: null, spot: null });
    });
    this.buildSoon(input.projectId);
    await this.changed(input.projectId, seq);
    const events = this.rows<EventRow>('SELECT * FROM chatter_events WHERE id IN (?, ?) ORDER BY seq', input.id, `${input.id}:open`).map(row => this.eventView(row));
    const post = events.find(event => event.type === 'post');
    const line = events.find(event => event.type === 'topic');
    const topic = this.topicRow(key);
    if (!post || post.type !== 'post' || !topic) throw new Error('Chatter post was not recorded');
    return { status: 'ok', value: { post, topic: this.topicView(topic), similar: similar ? this.topicView(similar) : null, line: line?.type === 'topic' ? line : null } };
  }

  /** An agent's post the hand-off check returned: a line under no topic naming who it asked (`to`), its text kept for
   * people to read on demand. A retry with the same `id` returns the first line. */
  async returned(raw: { projectId: string; id: string; topic: string; kind: ChatterKind; text: string; author: ChatterAuthor; phase?: string | null; to: string }): Promise<ChatterReturnedLine> {
    const input = this.postSchema.extend({ to: z.string().min(1) }).parse(raw);
    if (!this.rows<EventRow>('SELECT * FROM chatter_events WHERE id = ?', input.id)[0]) {
      const seq = this.insert({ id: input.id, at: new Date().toISOString(), type: 'returned', topicKey: '', topic: displayChatterTopic(input.topic), author: input.author, kind: input.kind, text: input.text.trim().slice(0, CHATTER_TEXT_CHARACTERS), change: null, phase: input.phase, spot: null, to: input.to });
      await this.changed(input.projectId, seq);
    }
    const row = this.rows<EventRow>('SELECT * FROM chatter_events WHERE id = ?', input.id)[0];
    const line = row ? this.eventView(row) : null;
    if (line?.type !== 'returned') throw new Error('Chatter returned line was not recorded');
    return line;
  }

  /**
   * A failure GitSpace's runtime recorded in `workspace`: a tooling post by GitSpace under the fixed topic of its source
   * and error (docs/CHATTER-DESIGN.md §5.1), referencing the workspace's history. While that topic is open and this
   * workspace already posted under it with the same reference, it writes no post: the topic's last activity moves and
   * its repeat count goes up.
   */
  async runtimeFailure(input: { projectId: string; workspace: { id: string; name: string }; source: string; message: string }): Promise<ChatterFailureResult> {
    const topic = runtimeFailureChatterTopic(input.source, input.message);
    const key = this.resolve(normalizeChatterTopic(topic));
    const reference = `history://${input.workspace.id}`;
    const author: ChatterAuthor = { kind: 'gitspace', id: input.workspace.id, name: input.workspace.name };
    const row = this.topicRow(key);
    const repeat = row?.state === 'open' && this.rows<{ one: number }>(
      "SELECT 1 AS one FROM chatter_events WHERE topic_key = ? AND type = 'post' AND author_kind = 'gitspace' AND author_id = ? AND json_extract(spot_json, '$.reference') = ? LIMIT 1",
      key, input.workspace.id, reference,
    ).length > 0;
    if (row && repeat) {
      const at = new Date().toISOString();
      this.ctx.storage.sql.exec('UPDATE chatter_topics SET last_at = ?, repeats = repeats + 1, participants_json = ? WHERE key = ?', at, JSON.stringify(this.joined(this.participants(row), author, 0, at)), key);
      await this.changed(input.projectId, this.cursor());
      const topicRow = this.topicRow(key);
      if (!topicRow) throw new Error('Chatter topic vanished');
      return { kind: 'repeated', topic: this.topicView(topicRow) };
    }
    const text = input.message.trim().slice(0, CHATTER_TEXT_CHARACTERS) || 'The runtime reported a failure without a message.';
    const posted = await this.post({ projectId: input.projectId, id: crypto.randomUUID(), topic, kind: 'tooling', text, author, phase: null, spot: { tool: input.source, reference, machine: null } });
    if (posted.status === 'error') throw new Error(`Runtime failure was not posted: ${posted.failure.message}`);
    return { kind: 'posted', post: posted.value.post, topic: posted.value.topic };
  }

  /** `chatter_read`: one topic's row and posts (`topic`), or the issue topics (`issue`, `state`) or active topics with
   * the project's posts; posts newest first, of one `kind` and after an offset when given. */
  read(input: { topic?: string; kind?: ChatterKind; issue?: boolean; state?: ChatterIssueState; after?: number; limit?: number }): ChatterRead {
    const limit = Math.min(input.limit ?? READ_POSTS, CHATTER_PAGE_EVENTS);
    const key = input.topic === undefined ? null : this.resolve(normalizeChatterTopic(input.topic));
    const filters = ["type = 'post'", 'seq > ?'];
    const bindings: SqlStorageValue[] = [input.after ?? 0];
    if (key !== null) { filters.push('topic_key = ?'); bindings.push(key); }
    if (input.kind !== undefined) { filters.push('kind = ?'); bindings.push(input.kind); }
    const rows = this.rows<EventRow>(`SELECT * FROM chatter_events WHERE ${filters.join(' AND ')} ORDER BY seq DESC LIMIT ?`, ...bindings, limit + 1);
    const topics = key !== null ? this.topicRows([key])
      : input.state !== undefined ? this.rows<TopicRow>('SELECT * FROM chatter_topics WHERE alias_of IS NULL AND state = ? ORDER BY last_at DESC LIMIT 100', input.state)
      : input.issue === true ? this.rows<TopicRow>("SELECT * FROM chatter_topics WHERE alias_of IS NULL AND state IS NOT NULL ORDER BY state = 'open' DESC, last_at DESC LIMIT 100")
      : this.active(Date.now(), CHATTER_ACTIVE_TOPICS);
    return {
      topics: topics.map(row => this.topicView(row)),
      posts: rows.slice(0, limit).flatMap(row => { const view = this.eventView(row); return view.type === 'post' ? [view] : []; }),
      cursor: this.cursor(),
      more: rows.length > limit,
    };
  }

  /** One workspace's issues: the issue topics it posted in (as its agent, as the project agent, or GitSpace for its
   * runtime), open first, then the most recently active; with each topic's latest tooling posts by it. */
  issues(workspaceId: string): { topics: ChatterTopic[]; posts: ChatterPost[] } {
    const topics = this.rows<TopicRow>(
      `SELECT * FROM chatter_topics WHERE alias_of IS NULL AND state IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(participants_json) WHERE json_extract(value, '$.id') = ? AND json_extract(value, '$.kind') IN ${WORKSPACE_AUTHOR_KINDS})
        ORDER BY state = 'open' DESC, last_at DESC LIMIT ?`,
      workspaceId, WORKSPACE_ISSUES,
    );
    const keys = topics.map(row => row.key);
    const posts = keys.length === 0 ? [] : this.rows<EventRow>(
      `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY topic_key ORDER BY seq DESC) AS rank FROM chatter_events
        WHERE type = 'post' AND kind = 'tooling' AND author_id = ? AND author_kind IN ${WORKSPACE_AUTHOR_KINDS} AND topic_key IN (${keys.map(() => '?').join(',')}))
        WHERE rank <= ? ORDER BY seq DESC`,
      workspaceId, ...keys, ISSUE_POSTS,
    );
    return { topics: topics.map(row => this.topicView(row)), posts: posts.flatMap(row => { const view = this.eventView(row); return view.type === 'post' ? [view] : []; }) };
  }

  /** An issue topic as filing reads it: its row and its latest tooling post's spot (the tool, reference and machine),
   * preferring the given workspace's. */
  issue(key: string, workspaceId: string): { topic: ChatterTopic; spot: ChatterSpot | null } | null {
    const row = this.topicRow(this.resolve(normalizeChatterTopic(key)));
    if (!row || row.state === null) return null;
    const latest = this.rows<{ spot_json: string | null }>(
      "SELECT spot_json FROM chatter_events WHERE topic_key = ? AND type = 'post' AND spot_json IS NOT NULL ORDER BY author_id = ? DESC, seq DESC LIMIT 1", row.key, workspaceId,
    )[0];
    return { topic: this.topicView(row), spot: latest?.spot_json ? ChatterSpotSchema.parse(JSON.parse(latest.spot_json)) : null };
  }

  /** Records that a person filed an issue topic with GitSpace or opened its GitHub draft. */
  async filed(input: { projectId: string; key: string; filed: ChatterFiled }): Promise<ChatterTopic> {
    const filed = ChatterFiledSchema.parse(input.filed);
    const key = this.resolve(normalizeChatterTopic(input.key));
    this.ctx.storage.sql.exec('UPDATE chatter_topics SET filed_json = ? WHERE key = ?', JSON.stringify(filed), key);
    const row = this.topicRow(key);
    if (!row) throw new Error('Chatter topic vanished');
    await this.changed(input.projectId, this.cursor());
    return this.topicView(row);
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
        return this.insert({ id, at, type: 'topic', topicKey: row.key, topic: row.display, author, kind: null, text: null, change: { kind: 'state', state, from, fixedIn: state === 'resolved' ? fixedIn : null }, phase: null, spot: null });
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
        'UPDATE chatter_topics SET first_at = ?, last_at = ?, posts = ?, repeats = ?, participants_json = ?, state = ?, state_by = ?, state_at = ?, fixed_in = ? WHERE key = ?',
        source.first_at < into.first_at ? source.first_at : into.first_at, source.last_at > into.last_at ? source.last_at : into.last_at,
        into.posts + source.posts, into.repeats + source.repeats, JSON.stringify(participants),
        keepsState ? into.state : source.state, keepsState ? into.state_by : source.state_by, keepsState ? into.state_at : source.state_at, keepsState ? into.fixed_in : source.fixed_in,
        into.key,
      );
      this.ctx.storage.sql.exec("UPDATE chatter_topics SET alias_of = ?, posts = 0, repeats = 0, participants_json = '[]', state = NULL, state_by = NULL, state_at = NULL, fixed_in = NULL WHERE key = ?", into.key, source.key);
      return this.insert({ id, at, type: 'topic', topicKey: into.key, topic: into.display, author, kind: null, text: null, change: { kind: 'merge', from: source.key, fromDisplay: source.display }, phase: null, spot: null });
    });
    await this.changed(input.projectId, seq);
    return this.acted(into.key, id);
  }

  /**
   * A listening agent's turn start (docs/CHATTER-DESIGN.md §6): its digest of the posts after `after`, its
   * conversation's position (null for a conversation that never heard: the listener's own position, else the last day).
   * The precomputed row is used when it covers that position; what came after the build gets the floor and the newest
   * topics. Never a model call. Records the listener's description and position, so the next build is made for it.
   */
  hear(raw: { listener: ChatterListener; after: number | null }): ChatterHearing {
    const listener = ChatterListenerSchema.parse(raw.listener);
    const now = Date.now();
    const row = this.rows<DigestRow>('SELECT * FROM digests WHERE listener = ?', listener.listener)[0];
    const cursor = this.cursor();
    const after = Math.min(raw.after ?? row?.heard ?? this.offsetSince(now - FIRST_HEARING_MS), cursor);
    const settings = this.settings();
    const posts = new Map(after < cursor && !settings.muted ? this.digestPosts(after, cursor).map(post => [post.offset, post]) : []);
    let heard: ChatterHeard[] = [];
    let left: ChatterLeft[] = [];
    let builtAt: Date | null = null;
    let model: string | null = null;
    if (posts.size) {
      const built = row ? this.built(row) : null;
      let from = after;
      if (built && built.after <= after && built.through > after) {
        heard = built.heard.filter(entry => posts.has(entry.offset));
        left = built.left.filter(entry => posts.has(entry.offset));
        ({ builtAt, model } = built);
        from = built.through;
      }
      if (from < cursor) {
        const picked = new Set(heard.flatMap(entry => entry.via === 'pick' ? [posts.get(entry.offset)?.topicKey ?? ''] : [])).size;
        const fresh = pickDigest(weighDigest(listener, [...posts.values()].filter(post => post.offset > from), this.mix()), null, CHATTER_MAX_PICKS - picked);
        heard = [...heard, ...fresh.heard];
        left = [...left, ...fresh.left];
      }
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO digests(listener, profile_json, heard, heard_at) VALUES (?, ?, ?, ?) ON CONFLICT(listener) DO UPDATE SET profile_json = excluded.profile_json, heard = MAX(digests.heard, excluded.heard), heard_at = excluded.heard_at',
      listener.listener, JSON.stringify(listener), cursor, new Date(now).toISOString(),
    );
    return {
      digest: { listener: listener.listener, name: listener.name, after, through: cursor, builtAt, model, muted: settings.muted, heard, left },
      posts: heard.flatMap(entry => posts.get(entry.offset) ?? []),
      others: left.length,
      otherTopics: new Set(left.map(entry => posts.get(entry.offset)?.topicKey ?? '')).size,
      fullCharacters: [...heard, ...left].reduce((total, entry) => total + (posts.get(entry.offset)?.text.length ?? 0) + DIGEST_LINE_CHARACTERS, 0),
    };
  }

  /** Hear as: the latest digest built for `listener`, or, when none is built, its floor and the newest topics since it
   * last heard (the last day for a listener that never did). `name` names a listener this object has not heard yet. */
  digestPreview(input: { listener: string; name: string }): ChatterDigest {
    const row = this.rows<DigestRow>('SELECT * FROM digests WHERE listener = ?', input.listener)[0];
    const built = row ? this.built(row) : null;
    const listener: ChatterListener = row ? ChatterListenerSchema.parse(JSON.parse(row.profile_json)) : { listener: input.listener, name: input.name, phase: null, goal: '', head: null, stack: [], waitsOn: [] };
    if (this.settings().muted) return { listener: input.listener, name: listener.name, after: row?.heard ?? 0, through: this.cursor(), builtAt: null, model: null, muted: true, heard: [], left: [] };
    if (built) return { listener: input.listener, name: listener.name, after: built.after, through: built.through, builtAt: built.builtAt, model: built.model, muted: false, heard: built.heard, left: built.left };
    const cursor = this.cursor();
    const after = Math.min(row?.heard ?? this.offsetSince(Date.now() - FIRST_HEARING_MS), cursor);
    const fresh = pickDigest(weighDigest(listener, this.digestPosts(after, cursor), this.mix()), null);
    return { listener: input.listener, name: listener.name, after, through: cursor, builtAt: null, model: null, muted: false, heard: fresh.heard, left: fresh.left };
  }

  /** Who hears the post at `offset`: its author's level, and every built digest over it that has it or left it out. */
  hearings(offset: number): ChatterHearings {
    const row = this.rows<EventRow>("SELECT * FROM chatter_events WHERE seq = ? AND type = 'post'", offset)[0];
    const post = row ? this.eventView(row) : null;
    if (post?.type !== 'post') return { level: null, heard: [], missed: [] };
    const strip = chatterStrip(post.author);
    const heard: ChatterHearings['heard'][number][] = [];
    const missed: ChatterHearings['missed'][number][] = [];
    for (const digest of this.rows<DigestRow>('SELECT * FROM digests WHERE digest_json IS NOT NULL AND after_offset < ? AND through >= ?', offset, offset)) {
      const built = this.built(digest);
      const name = ChatterListenerSchema.parse(JSON.parse(digest.profile_json)).name;
      const got = built?.heard.find(entry => entry.offset === offset);
      const left = built?.left.find(entry => entry.offset === offset);
      if (got) heard.push({ listener: digest.listener, name, via: got.via, reason: got.reason, strong: got.strong });
      else if (left) missed.push({ listener: digest.listener, name, why: left.why });
    }
    return { level: strip === null ? null : stripLevel(this.mix(), strip, post.phase), heard, missed };
  }

  /** The project's volumes: the strips people set, the project mute, and the strips that posted in the last few seconds. */
  volumes(): ChatterVolumes {
    const settings = this.settings();
    const recent = this.rows<{ author_kind: string; author_id: string; at: string }>(
      `SELECT author_kind, author_id, MAX(at) AS at FROM chatter_events WHERE type = 'post' AND at >= ? AND author_kind IN ${WORKSPACE_AUTHOR_KINDS} GROUP BY author_kind, author_id`,
      new Date(Date.now() - RECENT_POST_MS).toISOString(),
    );
    return {
      strips: this.rows<VolumeRow>('SELECT * FROM chatter_volumes').map(row => ({ strip: row.strip, level: chatterLevel(row.level), muted: row.muted === 1, by: row.by, at: new Date(row.at) })),
      projectMuted: settings.by === null || settings.at === null ? null : { on: settings.muted, by: settings.by, at: new Date(settings.at) },
      recent: recent.map(entry => ({ strip: entry.author_kind === 'project' ? CHATTER_PROJECT_STRIP : entry.author_id, at: new Date(entry.at) })),
    };
  }

  /** A person sets a strip's notch, its M, or both (`phase` is a workspace strip's, for its default): a change writes a
   * volume line and rebuilds the digests soon, since levels shape them. */
  async setVolume(input: { projectId: string; strip: string; name: string; phase: string | null; level?: ChatterLevel; muted?: boolean; author: ChatterAuthor }): Promise<{ volumes: ChatterVolumes; line: ChatterVolumeLine | null }> {
    const author = ChatterAuthorSchema.parse(input.author);
    const current = this.rows<VolumeRow>('SELECT * FROM chatter_volumes WHERE strip = ?', input.strip)[0];
    const set = chatterLevel(current?.level ?? null);
    const from = set ?? defaultChatterLevel(input.phase);
    const wasMuted = current?.muted === 1;
    const level = input.level ?? set;
    const muted = input.muted ?? wasMuted;
    if ((level ?? from) === from && muted === wasMuted) return { volumes: this.volumes(), line: null };
    const at = new Date().toISOString();
    const id = crypto.randomUUID();
    const seq = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO chatter_volumes(strip, level, muted, by, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(strip) DO UPDATE SET level = excluded.level, muted = excluded.muted, by = excluded.by, at = excluded.at',
        input.strip, level, muted ? 1 : 0, author.name, at);
      return this.insert({ id, at, type: 'volume', topicKey: '', topic: '', author, kind: null, text: null, change: { strip: input.strip, name: input.name, level: level ?? from, muted, from, wasMuted }, phase: null, spot: null });
    });
    this.buildSoon(input.projectId);
    await this.changed(input.projectId, seq);
    const line = this.rows<EventRow>('SELECT * FROM chatter_events WHERE id = ?', id)[0];
    const view = line ? this.eventView(line) : null;
    return { volumes: this.volumes(), line: view?.type === 'volume' ? view : null };
  }

  /** A person mutes or unmutes Chatter for the project: posts stay in the stream and `chatter_read`, and no agent gets a
   * digest while it is muted. A change writes a line; unmuting rebuilds the digests soon. */
  async setProjectMute(input: { projectId: string; on: boolean; author: ChatterAuthor }): Promise<{ volumes: ChatterVolumes; line: ChatterProjectMuteLine | null }> {
    const author = ChatterAuthorSchema.parse(input.author);
    if (this.settings().muted === input.on) return { volumes: this.volumes(), line: null };
    const at = new Date().toISOString();
    const id = crypto.randomUUID();
    const seq = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO chatter_settings(id, project_id, project_muted, by, at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, project_muted = excluded.project_muted, by = excluded.by, at = excluded.at',
        input.projectId, input.on ? 1 : 0, author.name, at);
      return this.insert({ id, at, type: 'project-mute', topicKey: '', topic: '', author, kind: null, text: null, change: { on: input.on }, phase: null, spot: null });
    });
    if (!input.on) this.buildSoon(input.projectId);
    await this.changed(input.projectId, seq);
    const line = this.rows<EventRow>('SELECT * FROM chatter_events WHERE id = ?', id)[0];
    const view = line ? this.eventView(line) : null;
    return { volumes: this.volumes(), line: view?.type === 'project-mute' ? view : null };
  }

  /** Answers a build's decisions with the project's inference profile; a test puts its own in. */
  decider: (projectId: string) => Promise<DigestDecide> = projectId => projectDecider(this.env, projectId);

  /** The project is deleted: its posts, topics and alarm go with it. */
  async erase(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** A digest build that is due runs first. Then each topic whose last post is 90 days old goes, with its events and the
   * aliases pointing at it; so does each line without a topic 90 days old. */
  async alarm(): Promise<void> {
    const due = this.settings().buildAt;
    if (due !== null && due <= Date.now()) {
      this.ctx.storage.sql.exec('UPDATE chatter_settings SET build_at = NULL, build_since = NULL WHERE id = 1');
      try { await this.build(); }
      catch (error) { console.error(JSON.stringify({ event: 'chatter_digest_build_failed', message: error instanceof Error ? error.message : String(error) })); }
    }
    const cutoff = new Date(Date.now() - CHATTER_RETENTION_MS).toISOString();
    const expired = this.rows<{ key: string }>('SELECT key FROM chatter_topics WHERE alias_of IS NULL AND last_at <= ?', cutoff);
    this.ctx.storage.transactionSync(() => {
      for (const { key } of expired) {
        this.ctx.storage.sql.exec('DELETE FROM chatter_events WHERE topic_key = ?', key);
        this.ctx.storage.sql.exec('DELETE FROM chatter_topics WHERE key = ? OR alias_of = ?', key, key);
      }
      this.ctx.storage.sql.exec("DELETE FROM chatter_events WHERE topic_key = '' AND at <= ?", cutoff);
    });
    await this.reschedule();
  }

  /**
   * The precomputed digests (docs/CHATTER-DESIGN.md §5, decision 2): for each listener that started a turn in the last
   * LISTENER_ACTIVE_MS and has posts it has not heard, its floor plus the topics one Decisions call picks for it among
   * the rest (one call per listener, every offered topic a question of it); a failed call leaves the floor plus the
   * newest topics. An idle listener is built for when it next runs. A listener that has not started a turn since its
   * last build (a long run) is rebuilt at most once per REBUILD_MS, the skipped build scheduled for then. While Chatter
   * is muted for the project, nothing is.
   */
  private async build(): Promise<void> {
    const settings = this.settings();
    const projectId = settings.projectId;
    if (settings.muted || projectId === null) return;
    const now = Date.now();
    const cursor = this.cursor();
    const mix = this.mix();
    const listeners: DigestRow[] = [];
    let later: number | null = null;
    for (const row of this.rows<DigestRow>('SELECT * FROM digests WHERE heard_at >= ? AND heard < ?', new Date(now - LISTENER_ACTIVE_MS).toISOString(), cursor)) {
      if (row.through === cursor && row.after_offset === row.heard) continue;
      const rebuild = row.built_at === null || row.built_at <= row.heard_at ? now : Date.parse(row.built_at) + REBUILD_MS;
      if (rebuild <= now) listeners.push(row);
      else later = Math.min(later ?? rebuild, rebuild);
    }
    if (later !== null) this.ctx.storage.sql.exec('UPDATE chatter_settings SET build_at = COALESCE(MIN(build_at, ?), ?) WHERE id = 1', later, later);
    let decide: Promise<DigestDecide> | null = null;
    await Promise.all(listeners.map(async row => {
      const listener = ChatterListenerSchema.parse(JSON.parse(row.profile_json));
      const weighed = weighDigest(listener, this.digestPosts(row.heard, cursor), mix);
      const question = digestQuestion(listener, weighed.candidates);
      let picks: Map<string, TopicPick> | null = new Map();
      let model: string | null = null;
      if (question) {
        try {
          decide ??= this.decider(projectId);
          const answer = await (await decide)(question.args);
          picks = digestPicks(question.keys, answer.answers);
          model = answer.model;
        } catch (error) {
          picks = null;
          console.warn(JSON.stringify({ event: 'chatter_digest_unpicked', listener: listener.listener, message: error instanceof Error ? error.message : String(error) }));
        }
      }
      const { heard, left } = pickDigest(weighed, picks);
      this.ctx.storage.sql.exec('UPDATE digests SET after_offset = ?, through = ?, digest_json = ?, built_at = ? WHERE listener = ?',
        row.heard, cursor, JSON.stringify({ heard, left, model }), new Date().toISOString(), row.listener);
    }));
  }

  private async changed(projectId: string, seq: number): Promise<void> {
    await this.reschedule();
    await notifyBrowsers(this.env, [{ ...projectLiveKey(projectId, 'chatter'), version: seq }]);
  }

  /** Posts settle before a build: it runs BUILD_SETTLE_MS after the last of a burst, and no later than BUILD_LONGEST_MS
   * after the first, so a steady stream still builds. The caller reschedules the alarm. */
  private buildSoon(projectId: string): void {
    const now = Date.now();
    const since = this.settings().buildSince ?? now;
    this.ctx.storage.sql.exec('INSERT INTO chatter_settings(id, project_id, build_at, build_since) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, build_at = excluded.build_at, build_since = excluded.build_since',
      projectId, Math.min(since + BUILD_LONGEST_MS, now + BUILD_SETTLE_MS), since);
  }

  /** The alarm follows the next digest build, or the oldest topic's or topic-less line's expiry. */
  private async reschedule(): Promise<void> {
    const oldest = this.rows<{ at: string | null }>(
      "SELECT MIN(at) AS at FROM (SELECT MIN(last_at) AS at FROM chatter_topics WHERE alias_of IS NULL UNION ALL SELECT MIN(at) AS at FROM chatter_events WHERE topic_key = '')",
    )[0]?.at ?? null;
    const build = this.settings().buildAt;
    const expiry = oldest === null ? null : Date.parse(oldest) + CHATTER_RETENTION_MS;
    const due = build === null ? expiry : expiry === null ? build : Math.min(build, expiry);
    if (due === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (await this.ctx.storage.getAlarm() !== due) await this.ctx.storage.setAlarm(due);
  }

  private settings(): { projectId: string | null; muted: boolean; by: string | null; at: string | null; buildAt: number | null; buildSince: number | null } {
    const row = this.rows<SettingsRow>('SELECT * FROM chatter_settings WHERE id = 1')[0];
    return { projectId: row?.project_id ?? null, muted: row?.project_muted === 1, by: row?.by ?? null, at: row?.at ?? null, buildAt: row?.build_at ?? null, buildSince: row?.build_since ?? null };
  }

  private mix(): ChatterMix {
    return { strips: new Map(this.rows<VolumeRow>('SELECT * FROM chatter_volumes').map(row => [row.strip, { level: chatterLevel(row.level), muted: row.muted === 1 }])) };
  }

  /** A listener's precomputed digest, or null when none is built. */
  private built(row: DigestRow): { after: number; through: number; builtAt: Date; model: string | null; heard: ChatterHeard[]; left: ChatterLeft[] } | null {
    if (row.digest_json === null || row.after_offset === null || row.through === null || row.built_at === null) return null;
    const stored = this.builtSchema.parse(JSON.parse(row.digest_json));
    return { after: row.after_offset, through: row.through, builtAt: new Date(row.built_at), ...stored };
  }

  /** The posts after `after` through `through`, oldest first; past DIGEST_POSTS, only the newest. */
  private digestPosts(after: number, through: number): ChatterPost[] {
    return this.rows<EventRow>("SELECT * FROM chatter_events WHERE type = 'post' AND seq > ? AND seq <= ? ORDER BY seq DESC LIMIT ?", after, through, DIGEST_POSTS)
      .reverse().flatMap(row => { const view = this.eventView(row); return view.type === 'post' ? [view] : []; });
  }

  /** The offset just before the first event at or after `at` (ms); the newest offset when there is none. */
  private offsetSince(at: number): number {
    const first = this.rows<{ seq: number | null }>('SELECT MIN(seq) AS seq FROM chatter_events WHERE at >= ?', new Date(at).toISOString())[0]?.seq ?? null;
    return first === null ? this.cursor() : first - 1;
  }

  private acted(key: string, id: string): ChatterOutcome<ChatterActResult> {
    const topic = this.topicRow(key);
    const line = this.rows<EventRow>('SELECT * FROM chatter_events WHERE id = ?', id)[0];
    if (!topic || !line) throw new Error('Chatter topic action was not recorded');
    const view = this.eventView(line);
    return { status: 'ok', value: { topic: this.topicView(topic), line: view.type === 'topic' ? view : null } };
  }

  private insert(event: { id: string; at: string; type: ChatterEvent['type']; topicKey: string; topic: string; author: ChatterAuthor; kind: ChatterKind | null; text: string | null; change: ChatterChange | VolumeChange | { on: boolean } | null; phase: string | null; spot: ChatterSpot | null; to?: string }): number {
    const change = event.to !== undefined ? { to: event.to } : event.change;
    return this.ctx.storage.sql.exec<{ seq: number }>(
      'INSERT INTO chatter_events(id, at, type, topic_key, topic, author_kind, author_id, author_name, kind, text, change_json, author_phase, spot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq',
      event.id, event.at, event.type, event.topicKey, event.topic, event.author.kind, event.author.id, event.author.name, event.kind, event.text,
      change === null ? null : JSON.stringify(change), event.phase, event.spot === null ? null : JSON.stringify(event.spot),
    ).one().seq;
  }

  private cursor(): number {
    return this.rows<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM chatter_events')[0]?.seq ?? 0;
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

  private topicRows(keys: readonly string[]): TopicRow[] {
    return keys.length === 0 ? [] : this.rows<TopicRow>(`SELECT * FROM chatter_topics WHERE key IN (${keys.map(() => '?').join(',')})`, ...keys);
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
      repeats: row.repeats,
      filed: row.filed_json === null ? null : ChatterFiledSchema.parse(JSON.parse(row.filed_json)),
    };
  }

  private eventView(row: EventRow): ChatterEvent {
    const author = ChatterAuthorSchema.parse({ kind: row.author_kind, id: row.author_id, name: row.author_name });
    const at = new Date(row.at);
    if (row.type === 'post') {
      return { type: 'post', offset: row.seq, id: row.id, at, topicKey: row.topic_key, topic: row.topic, author, phase: row.author_phase, kind: z.enum(CHATTER_KINDS).parse(row.kind), text: row.text ?? '', spot: row.spot_json === null ? null : ChatterSpotSchema.parse(JSON.parse(row.spot_json)) };
    }
    if (row.type === 'volume') {
      const { strip, name, level, muted, from, wasMuted } = this.volumeChangeSchema.parse(JSON.parse(row.change_json ?? 'null'));
      return { type: 'volume', offset: row.seq, id: row.id, at, topicKey: '', author, strip, name, level, muted, from, wasMuted };
    }
    if (row.type === 'project-mute') return { type: 'project-mute', offset: row.seq, id: row.id, at, topicKey: '', author, on: z.object({ on: z.boolean() }).parse(JSON.parse(row.change_json ?? 'null')).on };
    if (row.type === 'returned') {
      return { type: 'returned', offset: row.seq, id: row.id, at, topicKey: '', topic: row.topic, author, kind: z.enum(CHATTER_KINDS).parse(row.kind), text: row.text ?? '', to: z.object({ to: z.string() }).parse(JSON.parse(row.change_json ?? '{}')).to };
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

function chatterLevel(value: string | null): ChatterLevel | null {
  return CHATTER_LEVELS.find(level => level === value) ?? null;
}
