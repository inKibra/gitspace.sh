import { defineErrors, type InputOf } from 'result-rpc';
import { z } from 'zod';
import { CHATTER_KINDS } from '@gitspace/protocol-runtime/tool-arguments';
import { FILED_ISSUE_EXCERPT_MAX } from '@gitspace/protocol-runtime/workspace-controls';
import { wire } from './json-wire.js';

// Chatter: a project's ambient chat (docs/CHATTER-DESIGN.md). Every post has a topic; posts whose topics normalize the
// same are one thread, and an issue is a topic with a state.

export { CHATTER_KINDS };
export type ChatterKind = typeof CHATTER_KINDS[number];
export const CHATTER_ISSUE_STATES = ['open', 'resolved', 'dismissed'] as const;
export type ChatterIssueState = typeof CHATTER_ISSUE_STATES[number];
export const CHATTER_AUTHOR_KINDS = ['person', 'workspace', 'project', 'gitspace'] as const;

/** Characters in a topic as written. */
export const CHATTER_TOPIC_CHARACTERS = 80;
/** Characters in a post's text. */
export const CHATTER_TEXT_CHARACTERS = 2_000;
/** Characters in a fixed-in commit reference. */
export const CHATTER_FIXED_IN_CHARACTERS = 200;
/** A topic and all its events expire this long after its last post, whatever its state. */
export const CHATTER_RETENTION_MS = 90 * 24 * 60 * 60_000;
/** A topic is active while its last post is this recent, or while it is an open issue. */
export const CHATTER_ACTIVE_MS = 7 * 24 * 60 * 60_000;
/** Active topics one listing returns. */
export const CHATTER_ACTIVE_TOPICS = 30;
/** Events one page returns at most. */
export const CHATTER_PAGE_EVENTS = 100;
/** Words a suggested topic takes from a post's text. */
const SUGGESTED_TOPIC_WORDS = 5;

/** The thread key: lower case, every run of punctuation a space, whitespace collapsed and trimmed. */
export function normalizeChatterTopic(topic: string): string {
  return topic.toLowerCase().replace(/[\p{P}`]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** A topic as written, for display: whitespace collapsed, cut to `CHATTER_TOPIC_CHARACTERS`. */
export function displayChatterTopic(topic: string): string {
  return topic.replace(/\s+/gu, ' ').trim().slice(0, CHATTER_TOPIC_CHARACTERS).trim();
}

/** The composer's suggestion: the first words of the text's first sentence, without code marks. */
export function suggestChatterTopic(text: string): string {
  const sentence = text.replaceAll('`', '').split(/[.!?\n](?:\s|$)|\n/u)[0] ?? '';
  return displayChatterTopic(sentence.split(/\s+/u).filter(Boolean).slice(0, SUGGESTED_TOPIC_WORDS).join(' ').replace(/[\p{P}]+$/u, ''));
}

/** Tool names written another way that mean the same tool. */
const TOOL_ALIASES: Readonly<Record<string, string>> = { shell: 'bash', sh: 'bash', terminal: 'bash' };

/** A tool name as a tooling post's topic carries it: normalized like a topic, without an MCP prefix (`mcp__server__`)
 * or a trailing `tool`, known aliases folded (`Bash`, `bash tool`, `shell` → `bash`). */
export function normalizeChatterTool(tool: string): string {
  const name = normalizeChatterTopic(tool.replace(/^mcp__.*?__/u, '')).replace(/ tool$/u, '');
  return TOOL_ALIASES[name] ?? name;
}

/** A tooling post's default topic: its normalized title, then its normalized tool (`bun test hangs · bash`), the title
 * cut so the tool fits; without a tool, the title alone. */
export function toolingChatterTopic(title: string, tool: string | null): string {
  const named = tool === null ? '' : normalizeChatterTool(tool);
  if (named === '') return displayChatterTopic(normalizeChatterTopic(title));
  const room = Math.max(CHATTER_TOPIC_CHARACTERS - named.length - 3, 0);
  return displayChatterTopic(`${normalizeChatterTopic(title).slice(0, room).trim()} · ${named}`);
}

/** The fixed topic of a failure GitSpace's runtime records: its source, then the error's first line with ids and
 * numbers left out (`model request: Network connection lost.`), so every occurrence of one failure is one topic. */
export function runtimeFailureChatterTopic(source: string, message: string): string {
  const error = (message.split('\n')[0] ?? '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '…')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/giu, '…')
    .replace(/\d+/gu, '…');
  return displayChatterTopic(`${source}: ${error}`);
}

const STOP_WORDS: Readonly<Record<string, true>> = {
  a: true, an: true, the: true, in: true, on: true, of: true, for: true, to: true, with: true, and: true, or: true,
  is: true, are: true, was: true, when: true, at: true, by: true, from: true, after: true, during: true,
};

/** A word without a plural or `-ing`/`-ed` ending, so `hangs`, `hanging` and `hang` compare equal. */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function topicWords(key: string): Set<string> {
  return new Set(key.split(' ').filter(word => word && !STOP_WORDS[word]).map(stem));
}

function bigrams(key: string): Map<string, number> {
  const compact = key.replaceAll(' ', '');
  const counts = new Map<string, number>();
  for (let index = 0; index < compact.length - 1; index++) {
    const pair = compact.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/** How alike two normalized topics are, 0 to 1; 0 when they are not similar (docs/CHATTER-DESIGN.md §5.1): word sets
 * overlapping by at least half, one containing the other with at least two shared words, or keys nearly the same
 * string (character-bigram Dice ≥ 0.8). */
export function chatterTopicSimilarity(left: string, right: string): number {
  const a = topicWords(left);
  const b = topicWords(right);
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  const union = a.size + b.size - shared;
  const jaccard = union === 0 ? 0 : shared / union;
  const contained = shared >= 2 && (shared === a.size || shared === b.size);
  const x = bigrams(left);
  const y = bigrams(right);
  let overlap = 0;
  let total = 0;
  for (const [pair, count] of x) { overlap += Math.min(count, y.get(pair) ?? 0); total += count; }
  for (const count of y.values()) total += count;
  const dice = total === 0 ? 0 : (2 * overlap) / total;
  if (jaccard < 0.5 && !contained && dice < 0.8) return 0;
  return Math.max(jaccard, dice, contained ? 0.5 : 0);
}

/** The active topic most like `key` (most posts on a tie), or null when none is similar. `key` itself is skipped. */
export function similarChatterTopic<T extends { key: string; posts: number }>(key: string, active: readonly T[]): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const topic of active) {
    if (topic.key === key) continue;
    const score = chatterTopicSimilarity(key, topic.key);
    if (score > bestScore || (score > 0 && score === bestScore && best !== null && topic.posts > best.posts)) {
      best = topic;
      bestScore = score;
    }
  }
  return best;
}

export const ChatterAuthorSchema = z.object({ kind: z.enum(CHATTER_AUTHOR_KINDS), id: z.string().min(1), name: z.string() }).strict();
export type ChatterAuthor = z.infer<typeof ChatterAuthorSchema>;
export const ChatterAuthorCodec = wire.serializable((value): value is ChatterAuthor => ChatterAuthorSchema.safeParse(value).success, { id: 'gitspace/chatter-author/v1', jsonSchema: ChatterAuthorSchema });

/** What a `topic` line records: an issue state change (`from` null when the topic was not an issue), or another topic
 * merged into this one. */
export const ChatterChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), state: z.enum(CHATTER_ISSUE_STATES), from: z.enum(CHATTER_ISSUE_STATES).nullable(), fixedIn: z.string().nullable() }).strict(),
  z.object({ kind: z.literal('merge'), from: z.string().min(1), fromDisplay: z.string() }).strict(),
]);
export type ChatterChange = z.infer<typeof ChatterChangeSchema>;
export const ChatterChangeCodec = wire.serializable((value): value is ChatterChange => ChatterChangeSchema.safeParse(value).success, { id: 'gitspace/chatter-change/v1', jsonSchema: ChatterChangeSchema });

/** Where a tooling post's failure happened: the tool, a history:// or result:// reference, and the machine (null when
 * none). */
export const ChatterSpotSchema = z.object({ tool: z.string().min(1), reference: z.string().min(1), machine: z.string().nullable() }).strict();
export type ChatterSpot = z.infer<typeof ChatterSpotSchema>;
export const ChatterSpotCodec = wire.serializable((value): value is ChatterSpot => ChatterSpotSchema.safeParse(value).success, { id: 'gitspace/chatter-spot/v1', jsonSchema: ChatterSpotSchema });

export const ChatterPostCodec = wire.object({
  type: wire.literal('post'),
  offset: wire.integer({ min: 1 }),
  id: wire.string,
  at: wire.date,
  /** The normalized topic, after following a merge. */
  topicKey: wire.string,
  /** The topic as this post's author wrote it. */
  topic: wire.string,
  author: ChatterAuthorCodec,
  /** A workspace author's phase when it posted; null for anyone else. */
  phase: wire.nullable(wire.string),
  kind: wire.enum(CHATTER_KINDS),
  text: wire.string,
  /** A tooling post's tool, reference and machine; null for other posts and for a person's. */
  spot: wire.nullable(ChatterSpotCodec),
});
export type ChatterPost = InputOf<typeof ChatterPostCodec>;

export const ChatterTopicLineCodec = wire.object({
  type: wire.literal('topic'),
  offset: wire.integer({ min: 1 }),
  id: wire.string,
  at: wire.date,
  topicKey: wire.string,
  author: ChatterAuthorCodec,
  change: ChatterChangeCodec,
});
export type ChatterTopicLine = InputOf<typeof ChatterTopicLineCodec>;

/** An agent's post the hand-off check returned: it asked `to` (a workspace's name, or "another workspace") to do work,
 * so it was not posted. It belongs to no topic (`topicKey` is empty); `topic` is the one the agent gave. */
export const ChatterReturnedLineCodec = wire.object({
  type: wire.literal('returned'),
  offset: wire.integer({ min: 1 }),
  id: wire.string,
  at: wire.date,
  topicKey: wire.literal(''),
  topic: wire.string,
  author: ChatterAuthorCodec,
  kind: wire.enum(CHATTER_KINDS),
  text: wire.string,
  to: wire.string,
});
export type ChatterReturnedLine = InputOf<typeof ChatterReturnedLineCodec>;

export const ChatterEventCodec = wire.union([ChatterPostCodec, ChatterTopicLineCodec, ChatterReturnedLineCodec]);
export type ChatterEvent = InputOf<typeof ChatterEventCodec>;

/** A topic filed with GitSpace or shared as a GitHub issue draft: when, by whom, and where to. */
export const ChatterFiledSchema = z.object({ at: z.iso.datetime(), by: z.string(), target: z.enum(['gitspace', 'repository']) }).strict();
export type ChatterFiled = z.infer<typeof ChatterFiledSchema>;
export const ChatterFiledCodec = wire.serializable((value): value is ChatterFiled => ChatterFiledSchema.safeParse(value).success, { id: 'gitspace/chatter-filed/v1', jsonSchema: ChatterFiledSchema });

export const ChatterTopicCodec = wire.object({
  key: wire.string,
  /** The topic as its first post wrote it. */
  display: wire.string,
  firstAt: wire.date,
  lastAt: wire.date,
  posts: wire.integer({ min: 0 }),
  /** Everyone who posted under it, the most recent first. */
  participants: wire.array(ChatterAuthorCodec),
  /** Null while the topic is not an issue. */
  state: wire.nullable(wire.enum(CHATTER_ISSUE_STATES)),
  stateBy: wire.nullable(wire.string),
  stateAt: wire.nullable(wire.date),
  fixedIn: wire.nullable(wire.string),
  /** Runtime failures that recurred from a workspace already posted under it with the same reference: counted, not
   * posted. */
  repeats: wire.integer({ min: 0 }),
  /** The last filing with GitSpace or GitHub draft shared; null when never. */
  filed: wire.nullable(ChatterFiledCodec),
});
export type ChatterTopic = InputOf<typeof ChatterTopicCodec>;

/** A page of the stream, oldest first, with the rows of the topics its events are under. `cursor` is the object's
 * newest offset: the next `after`. Reading newest or `before`, `more` says older events remain; reading `after`, it
 * says newer events remain. */
export const ChatterPageCodec = wire.object({
  events: wire.array(ChatterEventCodec),
  topics: wire.array(ChatterTopicCodec),
  cursor: wire.integer({ min: 0 }),
  more: wire.boolean,
});
export type ChatterPage = InputOf<typeof ChatterPageCodec>;

/** What a person does to a topic: set its issue state (with the fixing commit when resolving), or merge it into
 * another topic. */
export const ChatterTopicActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), state: z.enum(CHATTER_ISSUE_STATES), fixedIn: z.string().trim().min(1).max(CHATTER_FIXED_IN_CHARACTERS).nullable().default(null) }).strict(),
  z.object({ kind: z.literal('merge'), into: z.string().min(1).max(CHATTER_TOPIC_CHARACTERS * 2) }).strict(),
]);
export type ChatterTopicAction = z.input<typeof ChatterTopicActionSchema>;
export const ChatterTopicActionCodec = wire.serializable((value): value is ChatterTopicAction => ChatterTopicActionSchema.safeParse(value).success, { id: 'gitspace/chatter-topic-action/v1', jsonSchema: ChatterTopicActionSchema });

/** A person's decision to send an issue topic out: file it with GitSpace (the reviewed excerpt goes to GitSpace's
 * issue list), or open a GitHub issue draft at GitSpace's or the project's repository with the redacted excerpt. */
export const ChatterFileActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), excerpt: z.string().trim().min(1).max(FILED_ISSUE_EXCERPT_MAX) }).strict(),
  z.object({ kind: z.literal('share'), target: z.enum(['gitspace', 'repository']), redactedExcerpt: z.string().trim().min(1).max(FILED_ISSUE_EXCERPT_MAX), confirmed: z.literal(true) }).strict(),
]);
export type ChatterFileAction = z.input<typeof ChatterFileActionSchema>;
export const ChatterFileActionCodec = wire.serializable((value): value is ChatterFileAction => ChatterFileActionSchema.safeParse(value).success, { id: 'gitspace/chatter-file-action/v1', jsonSchema: ChatterFileActionSchema });

export const chatterErrors = defineErrors('gitspace-chatter', {
  chatterInvalid: { data: wire.object({ field: wire.string, message: wire.string }), httpStatus: 400 },
  topicNotFound: { data: wire.object({ projectId: wire.string, key: wire.string }), httpStatus: 404 },
});
