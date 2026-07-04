/**
 * Magic keywords — trigger words the agent recognizes in a user message to
 * activate a special mode (extra thinking, orchestration, workflow authoring).
 *
 * SOURCE OF TRUTH / SYNC: these mirror oh-my-pi's `modes/magic-keywords` set
 * (`ultrathink`, `orchestrate`, `workflowz`). The SDK does not export the list —
 * only `hasMagicKeyword()` / `highlightMagicKeywords()` (ANSI, for its terminal
 * editor) — so we keep the list here for web-side (HTML) highlighting and guard
 * it with a test that asserts the SDK still recognizes each keyword
 * (`magic-keywords.sync.test.ts`). If that test fails, OMP renamed/removed a
 * keyword; if OMP *adds* one, add it here (the drift test can't detect additions).
 *
 * Matching mirrors the SDK: a standalone, lowercase word (bounded by whitespace
 * or string edges), so `workflowz` triggers but `Workflowz`, `workflowzed`, and
 * `workflowz.ts` do not.
 */

export const MAGIC_KEYWORDS = ['ultrathink', 'orchestrate', 'workflowz'] as const;

export type MagicKeyword = (typeof MAGIC_KEYWORDS)[number];

export interface MagicKeywordRange {
  start: number;
  end: number;
  keyword: MagicKeyword;
}

// Standalone lowercase word: not preceded/followed by a non-whitespace char.
// Matches the SDK's `(?<!\S)word(?!\S)` semantics.
const MAGIC_KEYWORD_RE = new RegExp(`(?<!\\S)(${MAGIC_KEYWORDS.join('|')})(?!\\S)`, 'g');

/** All magic-keyword occurrences in `text`, as [start, end) ranges (in order). */
export function findMagicKeywordRanges(text: string): MagicKeywordRange[] {
  if (!text) return [];
  const ranges: MagicKeywordRange[] = [];
  MAGIC_KEYWORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MAGIC_KEYWORD_RE.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length, keyword: match[0] as MagicKeyword });
  }
  return ranges;
}

/** Cheap test for "does this text contain a magic keyword as standalone prose?". */
export function hasMagicKeyword(text: string): boolean {
  if (!text) return false;
  MAGIC_KEYWORD_RE.lastIndex = 0;
  return MAGIC_KEYWORD_RE.test(text);
}

/**
 * Split `text` into alternating plain / keyword segments for rendering. Each
 * segment is `{ text, keyword? }`; keyword segments carry the matched keyword.
 */
export function segmentMagicKeywords(text: string): Array<{ text: string; keyword?: MagicKeyword }> {
  const ranges = findMagicKeywordRanges(text);
  if (ranges.length === 0) return text ? [{ text }] : [];
  const parts: Array<{ text: string; keyword?: MagicKeyword }> = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start) });
    parts.push({ text: text.slice(range.start, range.end), keyword: range.keyword });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}
