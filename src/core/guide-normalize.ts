/**
 * Pure normalizers for agent-authored review-guide fields.
 *
 * BROWSER-SAFE by construction: no imports, no Node builtins. The share viewer
 * fetches `review/guide.json` as raw artifact bytes rather than through
 * `readReviewGuide`, so it needs the same coercion — and importing
 * `core/review-guide.ts` into a `.web.tsx` would pull `fs` into the client
 * bundle and blank the page.
 */

/**
 * Coerce `asks` to the `string[]` the renderers declare.
 *
 * The sibling `callouts` field is `Array<{tone, text}>`, so a narrator writing
 * `asks: [{ text: "…" }]` is an easy and observed mistake. Rendered directly as
 * a React child that throws "Objects are not valid as a React child", which
 * escapes to the ErrorBoundary and white-screens the whole app instead of
 * degrading one section. Submission now rejects the shape, but guides already
 * committed to artifact branches still carry it, so readers stay forgiving.
 */
export function normalizeGuideAsks(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const asks: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry.trim()) asks.push(entry);
    } else if (entry !== null && typeof entry === 'object' && 'text' in entry && typeof entry.text === 'string') {
      if (entry.text.trim()) asks.push(entry.text);
    }
    // Anything else is unrenderable — drop it rather than crash the pane.
  }
  return asks;
}
