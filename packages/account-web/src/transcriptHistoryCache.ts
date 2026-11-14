import { z } from 'zod';
import {
  TRANSCRIPT_CACHE_BYTES,
  TRANSCRIPT_CACHE_ROWS,
  transcriptRowSchema,
  type TranscriptPage,
  type TranscriptPageRequest,
  type TranscriptRow,
} from '@gitspace/blocks';

export interface TranscriptViewport {
  firstId: string | null;
  lastId: string | null;
  following: boolean;
}

export interface TranscriptHistoryCache {
  generation: string | null;
  revision: number;
  rows: readonly TranscriptRow[];
  rowBytes: readonly number[];
  rowRevisions: readonly number[];
  bytes: number;
  hasBefore: boolean;
  hasAfter: boolean;
  total: number;
}

export const EMPTY_TRANSCRIPT_CACHE: TranscriptHistoryCache = {
  generation: null, revision: -1, rows: [], rowBytes: [], rowRevisions: [], bytes: 0,
  hasBefore: false, hasAfter: false, total: 0,
};

const encoder = new TextEncoder();

/** Keeps one contiguous source window, never an accumulating collection of pages. */
export function mergeTranscriptPage(
  cache: TranscriptHistoryCache,
  page: TranscriptPage,
  request: TranscriptPageRequest,
  viewport: TranscriptViewport,
  replace = false,
): TranscriptHistoryCache {
  const sameGeneration = cache.generation === page.generation;
  if (sameGeneration && page.revision < cache.revision) return cache;

  const first = cache.rows[0];
  const last = cache.rows[cache.rows.length - 1];
  const pageFirst = page.rows[0];
  const pageLast = page.rows[page.rows.length - 1];
  const oldIds = new Set(cache.rows.map((row) => row.id));
  // Ordinal gaps are legal. Overlap or a request at our exact boundary, not
  // arithmetic on ordinals, proves that two source windows are adjacent.
  const adjacent = request.generation === cache.generation && (
    (first && request.before === first.ordinal && (!pageLast || pageLast.ordinal < first.ordinal))
    || (last && request.after === last.ordinal && (!pageFirst || pageFirst.ordinal > last.ordinal))
  );
  const connected = sameGeneration && !replace && page.total !== 0 && (
    adjacent || page.rows.some((row) => oldIds.has(row.id))
  );
  const entries = new Map<string, { row: TranscriptRow; bytes: number; revision: number }>();
  if (connected) {
    for (let index = 0; index < cache.rows.length; index++) {
      const row = cache.rows[index]!;
      // A page is authoritative for its covered ordinal interval, including
      // now-hidden calls and an empty edge after the last visible row.
      const coveredStart = !page.hasBefore || (request.after !== null ? row.ordinal > request.after : pageFirst !== undefined && row.ordinal >= pageFirst.ordinal);
      const coveredEnd = !page.hasAfter || (request.before !== null ? row.ordinal < request.before : pageLast !== undefined && row.ordinal <= pageLast.ordinal);
      if (coveredStart && coveredEnd) continue;
      entries.set(row.id, { row, bytes: cache.rowBytes[index]!, revision: cache.rowRevisions[index]! });
    }
  }
  for (const sourceRow of page.rows) {
    // Persisted pre-revision previews remain readable, but must invalidate on
    // their enclosing page revision even when their text and byte size match.
    const row = sourceRow.contentRevision === undefined ? { ...sourceRow, contentRevision: page.revision } : sourceRow;
    entries.set(row.id, { row, bytes: encoder.encode(JSON.stringify(row)).byteLength, revision: page.revision });
  }
  const merged = [...entries.values()].sort((a, b) => a.row.ordinal - b.row.ordinal);
  let hasBefore = page.hasBefore;
  let hasAfter = page.hasAfter;
  if (connected && first && last) {
    hasBefore = !page.hasBefore || pageFirst && pageFirst.ordinal <= first.ordinal
      ? page.hasBefore
      : adjacent && request.before !== null && !pageFirst ? page.hasBefore : cache.hasBefore;
    hasAfter = !page.hasAfter || pageLast && pageLast.ordinal >= last.ordinal
      ? page.hasAfter
      : adjacent && request.after !== null && !pageLast ? page.hasAfter : cache.hasAfter || page.total > cache.total;
  }

  if (merged.length === 0) {
    return { generation: page.generation, revision: page.revision, rows: [], rowBytes: [], rowRevisions: [], bytes: 0, hasBefore, hasAfter, total: page.total };
  }

  let start = viewport.following ? merged.length - 1 : merged.findIndex(({ row }) => row.id === viewport.firstId);
  if (start < 0) start = merged.findIndex(({ row }) => row.id === request.around);
  if (start < 0) start = 0;
  let end = start + 1;
  let bytes = merged[start]!.bytes;
  const visibleEnd = viewport.following ? start : Math.max(start, merged.findIndex(({ row }) => row.id === viewport.lastId));
  const fits = (index: number) => end - start < TRANSCRIPT_CACHE_ROWS && bytes + merged[index]!.bytes <= TRANSCRIPT_CACHE_BYTES;
  // Preserve the visible range first, then spend the remaining budget nearby.
  while (end <= visibleEnd && fits(end)) bytes += merged[end++]!.bytes;
  const anchorStart = start;
  const anchorEnd = end;
  while (start > 0 || end < merged.length) {
    const left = start > 0 && fits(start - 1);
    const right = end < merged.length && fits(end);
    if (!left && !right) break;
    if (left && (!right || viewport.following || anchorStart - start <= end - anchorEnd)) bytes += merged[--start]!.bytes;
    else bytes += merged[end++]!.bytes;
  }
  const retained = merged.slice(start, end);
  return {
    generation: page.generation,
    revision: page.revision,
    rows: retained.map(({ row }) => row),
    rowBytes: retained.map(({ bytes: size }) => size),
    rowRevisions: retained.map(({ revision }) => revision),
    bytes,
    hasBefore: hasBefore || start > 0,
    hasAfter: hasAfter || end < merged.length,
    total: page.total,
  };
}

/** What this browser saves of a transcript for its next first paint: the newest rows of its window, at most this many
 * bytes. */
export const SAVED_TRANSCRIPT_BYTES = 1024 * 1024;
export const savedTranscriptSchema = z.object({
  generation: z.string().min(1),
  revision: z.number().int().nonnegative(),
  rows: z.array(transcriptRowSchema).max(TRANSCRIPT_CACHE_ROWS),
  hasBefore: z.boolean(),
  hasAfter: z.boolean(),
  total: z.number().int().nonnegative(),
});
export type SavedTranscript = z.infer<typeof savedTranscriptSchema>;

/** The newest rows of `cache` that fit `SAVED_TRANSCRIPT_BYTES`, with the generation and revision they came from. */
export function savedTranscript(cache: TranscriptHistoryCache): SavedTranscript | null {
  if (cache.generation === null) return null;
  let start = cache.rows.length;
  let bytes = 0;
  while (start > 0 && bytes + cache.rowBytes[start - 1]! <= SAVED_TRANSCRIPT_BYTES) bytes += cache.rowBytes[--start]!;
  return { generation: cache.generation, revision: cache.revision, rows: cache.rows.slice(start), hasBefore: cache.hasBefore || start > 0, hasAfter: cache.hasAfter, total: cache.total };
}
