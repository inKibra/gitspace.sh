export const MAGIC_KEYWORDS = ['ultrathink', 'orchestrate', 'workflowz'] as const;
export type MagicKeyword = (typeof MAGIC_KEYWORDS)[number];

const MAGIC_KEYWORD_RE = /(?<!\S)(ultrathink|orchestrate|workflowz)(?!\S)/gu;

export function segmentMagicKeywords(text: string): Array<{ text: string; keyword?: MagicKeyword }> {
  const segments: Array<{ text: string; keyword?: MagicKeyword }> = [];
  let cursor = 0;
  for (const match of text.matchAll(MAGIC_KEYWORD_RE)) {
    const start = match.index;
    if (start > cursor) segments.push({ text: text.slice(cursor, start) });
    const keyword = match[0] as MagicKeyword;
    segments.push({ text: keyword, keyword });
    cursor = start + keyword.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
