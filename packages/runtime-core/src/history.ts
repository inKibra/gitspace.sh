import { z } from 'zod';

/** Ordinal bounds of one transcript read: `from` inclusive, `before` exclusive. Ordinals are `entryId * 1024 + n`. */
export const RuntimeTranscriptRangeSchema = z.object({
  from: z.number().int().nonnegative().optional(),
  before: z.number().int().nonnegative().optional(),
  newestFirst: z.boolean().optional(),
});
export type RuntimeTranscriptRange = z.infer<typeof RuntimeTranscriptRangeSchema>;

export type HistoryJudge = (state: string, questions: Record<string, string>) => Promise<Record<string, number>>;

/** The deepest rank a search pages to: `offset + limit` never exceeds it. */
export const HISTORY_SEARCH_RANKED = 500;
const SNIPPET_BEFORE = 200;
const SNIPPET_CHARACTERS = 800;

/** One workspace's part of a search: `before` is an exclusive ordinal bound (a ghost's `until`); `offset` and `limit`
 * page its ranked hits. */
export const HistorySearchRequestSchema = z.object({
  query: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  before: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().max(HISTORY_SEARCH_RANKED),
  limit: z.number().int().positive().max(HISTORY_SEARCH_RANKED),
});
export type HistorySearchRequest = z.infer<typeof HistorySearchRequestSchema>;
/** One matching event. Indexed hits rank by BM25 (`score`, higher is better) and come before every hit of the scan of
 * history not yet indexed, which rank by the number of query words they contain. */
export type HistoryHit = { conversationId: string; ordinal: number; createdAt: string; snippet: string; indexed: boolean; score: number };
/** How much of the searched history the index covers: `unindexedEntries` entries are not indexed yet (an index still
 * being built, or one that failed: `failure`); a bounded scan read `scannedEvents` of their events, all of them when
 * `scanComplete`. */
export type HistoryCoverage = { complete: boolean; unindexedEntries: number; scannedEvents: number; scanComplete: boolean; failure: string | null };
export type HistoryWorkspaceHits = { hits: HistoryHit[]; more: boolean; coverage: HistoryCoverage };
export type HistorySearchSource = {
  workspaceIds: readonly string[];
  /** Search only this conversation (its fork ancestors' entries up to the fork included). */
  conversationId?: string;
  /** Only events with ordinals below this. */
  before?: number;
  search(workspaceId: string, request: HistorySearchRequest): Promise<HistoryWorkspaceHits>;
};

const HistorySearchCursorSchema = z.object({ offset: z.number().int().nonnegative().max(HISTORY_SEARCH_RANKED) });
/** One match: where it is, a snippet, the `history_read` call for the whole event, and the judge's relevance (null when
 * the judge could not answer). */
type HistorySearchResult = { workspaceId: string; conversationId: string; ordinal: number; createdAt: string; snippet: string; content: { mode: 'content'; workspaceId: string; conversationId: string; ordinal: number; contentOffset: number }; relevance: number | null };

/**
 * Ranked search of whole transcripts: each workspace answers from its full-text index (BM25), and scans only the part of
 * its history the index does not cover yet, saying how much that is (`coverage`). A "quoted phrase" must appear exactly;
 * other words rank matches (a trailing `*` matches a prefix). The cursor pages the ranked matches. A judge (the profile's
 * Decisions service, else its fast model) orders each page by relevance and never drops a match; when it cannot answer
 * (no fast model, a reply that is not JSON) the page keeps its BM25 order, with `judged: false` and why.
 */
export async function searchHistory(query: string, source: HistorySearchSource, judge: HistoryJudge, cursor?: string, limit = 20) {
  const { offset } = cursor ? HistorySearchCursorSchema.parse(JSON.parse(cursor)) : { offset: 0 };
  if (!parseHistoryQuery(query) || !source.workspaceIds.length) return { results: [], cursor: null, coverage: [] };
  const count = Math.min(limit, HISTORY_SEARCH_RANKED - offset);
  // One workspace pages itself; several each return their best `offset + count`, and the page is cut from the merge.
  const single = source.workspaceIds.length === 1;
  const request = { query, ...(source.conversationId === undefined ? {} : { conversationId: source.conversationId }), ...(source.before === undefined ? {} : { before: source.before }) };
  const answers = await Promise.all(source.workspaceIds.map(async workspaceId => ({ workspaceId, ...await source.search(workspaceId, single ? { ...request, offset, limit: count } : { ...request, offset: 0, limit: offset + count }) })));
  const ranked = answers.flatMap(answer => answer.hits.map(hit => ({ workspaceId: answer.workspaceId, ...hit })));
  if (!single) ranked.sort((left, right) => Number(right.indexed) - Number(left.indexed) || right.score - left.score);
  const page = single ? ranked.slice(0, count) : ranked.slice(offset, offset + count);
  const more = answers.some(answer => answer.more) || ranked.length > (single ? count : offset + count);
  const next = more && offset + count < HISTORY_SEARCH_RANKED ? JSON.stringify({ offset: offset + count }) : null;
  const coverage = answers.map(answer => ({ workspaceId: answer.workspaceId, ...answer.coverage }));
  if (!page.length) return { results: [], cursor: next, coverage };
  const result = (hit: (typeof page)[number], relevance: number | null): HistorySearchResult => ({ workspaceId: hit.workspaceId, conversationId: hit.conversationId, ordinal: hit.ordinal, createdAt: hit.createdAt, snippet: hit.snippet, content: { mode: 'content', workspaceId: hit.workspaceId, conversationId: hit.conversationId, ordinal: hit.ordinal, contentOffset: 0 }, relevance });
  const state = JSON.stringify({ query, candidates: page.map((hit, index) => ({ id: String(index), text: hit.snippet })) });
  const questions = Object.fromEntries(page.map((_hit, index) => [String(index), `Does candidate ${index} contain information substantively relevant to the user's history query, rather than an incidental token match?`]));
  let scores: Record<string, number>;
  try {
    scores = await judge(state, questions);
  } catch (error) {
    return { results: page.map(hit => result(hit, null)), cursor: next, coverage, judged: false, judgeError: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
  // Every hit contains the query's terms: the judge only orders the page, ties keeping their BM25 order.
  const results = page.map((hit, index) => ({ index, value: result(hit, scores[String(index)] ?? null) }))
    .sort((left, right) => (right.value.relevance ?? -1) - (left.value.relevance ?? -1) || left.index - right.index)
    .map(item => item.value);
  return { results, cursor: next, coverage };
}

/** The text of an event that history search indexes: every string in it except identifiers, signatures and ciphertext. */
export function searchableText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(searchableText).join('\n');
  if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => !['id', 'conversationId', 'taskId', 'requestId', 'attemptId', 'signature', 'ciphertext', 'entryId'].includes(key)).map(([, item]) => searchableText(item)).join('\n');
  return '';
}

/** A word as SQLite FTS5's `unicode61` tokenizer reads text: a run of letters, digits and marks; `_` and punctuation
 * separate words, so snake_case is two words. */
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
/** A camelCase word: `unicode61` keeps it one token, so its parts are indexed again, in a second column. */
const CAMEL = /\p{Ll}\p{Lu}|\p{Lu}\p{Lu}\p{Ll}/u;
const CAMEL_PART = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;
/** Lowercased with diacritics removed, as `unicode61` compares tokens. */
const fold = (word: string) => word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The parts of the camelCase words of `text`, space-separated: the index's second column, so `camel` finds camelCase. */
export function identifierParts(text: string): string {
  const parts: string[] = [];
  for (const [word] of text.matchAll(WORD)) if (CAMEL.test(word)) parts.push(...word.split(CAMEL_PART));
  return parts.join(' ');
}

type Word = { token: string; at: number; parts: readonly string[] };
function wordsOf(text: string): Word[] {
  return [...text.matchAll(WORD)].map(match => ({ token: fold(match[0]), at: match.index, parts: CAMEL.test(match[0]) ? match[0].split(CAMEL_PART).map(fold) : [] }));
}

/** Consecutive words; a prefix needle's last word matches any word it starts. */
type Needle = { tokens: readonly string[]; prefix: boolean };
/** A parsed query: phrases a match must contain, words that rank it, and the FTS5 expression for both. */
export type HistoryQuery = { phrases: readonly Needle[]; words: readonly Needle[]; match: string };

/** Parses a history query; null when it has no word to look for. Each needle is one FTS5 string of its tokens, so no
 * query text reaches FTS5's syntax: `snake_case` and `foo-bar` are two-word phrases, as the tokenizer indexed them. */
export function parseHistoryQuery(query: string): HistoryQuery | null {
  const quoted = /["“”]([^"“”]+)["“”]/gu;
  // A word of marks alone folds to nothing; FTS5 reads no token there either.
  const needle = (text: string, prefix: boolean): Needle[] => { const tokens = wordsOf(text).map(word => word.token).filter(Boolean); return tokens.length ? [{ tokens, prefix }] : []; };
  const phrases = [...query.matchAll(quoted)].flatMap(match => needle(match[1]!, false));
  const seen = new Set<string>();
  const words = query.replace(quoted, ' ').split(/\s+/u).flatMap(chunk => needle(chunk, chunk.endsWith('*'))).filter(word => {
    const key = `${word.tokens.join(' ')}${word.prefix ? '*' : ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!phrases.length && !words.length) return null;
  const quote = (item: Needle) => `"${item.tokens.join(' ')}"${item.prefix ? '*' : ''}`;
  const match = [...phrases.map(quote), ...(words.length ? [`(${words.map(quote).join(' OR ')})`] : [])].join(' AND ');
  return { phrases, words, match };
}

/** Where `needle` first occurs in `words`; a one-word needle also matches a camelCase word's part. */
function find(words: readonly Word[], needle: Needle): number | null {
  const last = needle.tokens.length - 1;
  const matches = (candidate: string, token: string, prefix: boolean) => prefix ? candidate.startsWith(token) : candidate === token;
  for (let start = 0; start + last < words.length; start++) {
    let k = 0;
    for (; k <= last; k++) {
      const word = words[start + k]!, token = needle.tokens[k]!, prefix = needle.prefix && k === last;
      if (!matches(word.token, token, prefix) && !(last === 0 && word.parts.some(part => matches(part, token, prefix)))) break;
    }
    if (k > last) return words[start]!.at;
  }
  return null;
}

/** Whether `text` matches the query as the index would: every phrase, and at least one word when there is no phrase.
 * `matches` counts the phrases and words found; `at` is where the first one starts. */
export function matchHistoryText(text: string, query: HistoryQuery): { matches: number; at: number } | null {
  const words = wordsOf(text);
  let at = Number.POSITIVE_INFINITY, matches = 0;
  for (const phrase of query.phrases) {
    const found = find(words, phrase);
    if (found === null) return null;
    matches++; at = Math.min(at, found);
  }
  for (const word of query.words) {
    const found = find(words, word);
    if (found === null) continue;
    matches++; at = Math.min(at, found);
  }
  return matches ? { matches, at } : null;
}

/** The snippet of a match starting at `at`: some text before it and the rest of the window after. */
export function historySnippet(text: string, at: number): string {
  const start = Math.max(0, at - SNIPPET_BEFORE);
  return text.slice(start, start + SNIPPET_CHARACTERS);
}
