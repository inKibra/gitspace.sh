import { z } from 'zod';

/** Ordinal bounds of one transcript read: `from` inclusive, `before` exclusive. Ordinals are `entryId * 1024 + n`. */
export const RuntimeTranscriptRangeSchema = z.object({
  from: z.number().int().nonnegative().optional(),
  before: z.number().int().nonnegative().optional(),
  newestFirst: z.boolean().optional(),
});
export type RuntimeTranscriptRange = z.infer<typeof RuntimeTranscriptRangeSchema>;

export type HistoryEvent = { ordinal: number; payload: Record<string, unknown>; createdAt: string };
export type HistorySearchSource = {
  workspaceIds: readonly string[];
  conversations(workspaceId: string): Promise<readonly string[]>;
  /** Newest-first events of one conversation with ordinals below `before`. */
  events(workspaceId: string, conversationId: string, before: number | undefined): AsyncIterable<HistoryEvent>;
};
export type HistoryJudge = (state: string, questions: Record<string, string>) => Promise<Record<string, number>>;

const HistorySearchCursorSchema = z.object({ workspace: z.number().int().nonnegative(), conversation: z.number().int().nonnegative(), before: z.number().int().nonnegative().optional() });
type Position = z.infer<typeof HistorySearchCursorSchema>;
type Candidate = { workspaceId: string; conversationId: string; ordinal: number; createdAt: string; text: string; matches: number };
/** One search call reads at most this much history; `cursor` resumes exactly where it stopped. */
const SCAN_EVENTS = 2_000;
const SCAN_CHARACTERS = 4_000_000;
const SNIPPET_BEFORE = 200;
const SNIPPET_CHARACTERS = 800;

/** Bounded newest-first scan of Pi transcripts; nothing is indexed or copied. */
export async function searchHistory(query: string, source: HistorySearchSource, judge: HistoryJudge, cursor?: string, limit = 20) {
  const terms = [...new Set((query.match(/[\p{L}\p{N}_]+/gu) ?? []).map(term => term.toLowerCase()))];
  if (!terms.length || !source.workspaceIds.length) return { results: [], cursor: null };
  const wanted = Math.min(100, Math.max(limit * 3, 30));
  const candidates: Candidate[] = [];
  let scanned = 0;
  let characters = 0;
  let next: Position | null = null;
  let position: Position = cursor ? HistorySearchCursorSchema.parse(JSON.parse(cursor)) : { workspace: 0, conversation: 0 };
  scan: for (; position.workspace < source.workspaceIds.length; position = { workspace: position.workspace + 1, conversation: 0 }) {
    const workspaceId = source.workspaceIds[position.workspace]!;
    const conversations = await source.conversations(workspaceId);
    for (; position.conversation < conversations.length; position = { workspace: position.workspace, conversation: position.conversation + 1 }) {
      const conversationId = conversations[position.conversation]!;
      for await (const event of source.events(workspaceId, conversationId, position.before)) {
        if (scanned >= SCAN_EVENTS || characters >= SCAN_CHARACTERS || candidates.length >= wanted) {
          next = { ...position, before: event.ordinal + 1 };
          break scan;
        }
        scanned++;
        const text = searchableText(event.payload);
        characters += text.length;
        const lower = text.toLowerCase();
        let first = -1;
        let matches = 0;
        for (const term of terms) {
          const at = lower.indexOf(term);
          if (at < 0) continue;
          matches++;
          if (first < 0 || at < first) first = at;
        }
        if (first < 0) continue;
        const start = Math.max(0, first - SNIPPET_BEFORE);
        candidates.push({ workspaceId, conversationId, ordinal: event.ordinal, createdAt: event.createdAt, text: text.slice(start, start + SNIPPET_CHARACTERS), matches });
      }
    }
  }
  const nextCursor = next ? JSON.stringify(next) : null;
  if (!candidates.length) return { results: [], cursor: nextCursor };
  candidates.sort((left, right) => right.matches - left.matches);
  const state = JSON.stringify({ query, candidates: candidates.map((row, index) => ({ id: String(index), text: row.text })) });
  const questions = Object.fromEntries(candidates.map((_row, index) => [String(index), `Does candidate ${index} contain information substantively relevant to the user's history query, rather than an incidental token match?`]));
  const scores = await judge(state, questions);
  const results = candidates.flatMap((row, index) => (scores[String(index)] ?? 0) >= 0.7 ? [{ workspaceId: row.workspaceId, conversationId: row.conversationId, ordinal: row.ordinal, createdAt: row.createdAt, snippet: row.text, content: { mode: 'content' as const, workspaceId: row.workspaceId, conversationId: row.conversationId, ordinal: row.ordinal, contentOffset: 0 }, relevance: scores[String(index)] }] : []).slice(0, limit);
  return { results, cursor: nextCursor };
}

function searchableText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(searchableText).join('\n');
  if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => !['id', 'conversationId', 'taskId', 'requestId', 'attemptId', 'signature', 'ciphertext', 'entryId'].includes(key)).map(([, item]) => searchableText(item)).join('\n');
  return '';
}
