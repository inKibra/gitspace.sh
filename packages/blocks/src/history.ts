import { z } from 'zod';
import { sideAgentBlockSchema, turnBlockSchema, turnItemSchema, type TurnBlock } from './model.js';

export const TRANSCRIPT_PAGE_ROWS = 64;
export const TRANSCRIPT_PAGE_BYTES = 96 * 1024;
export const TRANSCRIPT_CACHE_ROWS = 384;
export const TRANSCRIPT_CACHE_BYTES = 64 * 1024 * 1024;
export const TRANSCRIPT_CONTENT_CHARACTERS = 256 * 1024;
// Persisted SQLite and R2 chunks keep their original width across response-size changes.
export const TRANSCRIPT_CONTENT_CHUNK_CHARACTERS = 16 * 1024;
export const TRANSCRIPT_ROW_BYTES = 16 * 1024;

/** UTF-8 size without allocating an encoded copy of a potentially large source item. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const transcriptItemSchema = z.discriminatedUnion('type', [
  ...turnItemSchema.options,
  sideAgentBlockSchema,
]);
export type TranscriptItem = z.infer<typeof transcriptItemSchema>;

export const transcriptRowSchema = z.object({
  id: z.string().min(1),
  ordinal: position,
  turnId: z.string().min(1),
  turnStatus: turnBlockSchema.shape.status,
  item: transcriptItemSchema,
  truncated: z.boolean(),
  contentBytes: position,
  contentRevision: position.optional(),
}).refine((row) => utf8Bytes(JSON.stringify(row)) <= TRANSCRIPT_ROW_BYTES, 'Transcript row exceeds its preview byte limit');
export type TranscriptRow = z.infer<typeof transcriptRowSchema>;

/** Group the supplied window only; never fetch or synthesize missing history. */
export function transcriptRowsToTurns(rows: readonly TranscriptRow[]): TurnBlock[] {
  const turns = new Map<string, TurnBlock>();
  for (const row of rows) {
    let turn = turns.get(row.turnId);
    if (!turn) {
      turn = { id: row.turnId, type: 'turn', status: row.turnStatus, items: [], sideAgents: [] };
      turns.set(row.turnId, turn);
    }
    turn.status = row.turnStatus;
    if (row.item.type === 'message' && row.item.role === 'user') turn.user = row.item;
    else if (row.item.type === 'side-agent') turn.sideAgents.push(row.item);
    else turn.items.push(row.item);
  }
  return [...turns.values()];
}

export const transcriptPageRequestSchema = z.object({
  generation: z.string().min(1).nullable().default(null),
  before: position.nullable().default(null),
  after: position.nullable().default(null),
  around: z.string().min(1).nullable().default(null),
  executionId: z.string().min(1).nullable().optional(),
}).refine((request) => Number(request.before !== null) + Number(request.after !== null) + Number(request.around !== null) <= 1,
  'Only one transcript page selector is allowed');
export type TranscriptPageRequest = z.infer<typeof transcriptPageRequestSchema>;

export const transcriptPageSchema = z.object({
  generation: z.string().min(1),
  revision: position,
  rows: z.array(transcriptRowSchema).max(TRANSCRIPT_PAGE_ROWS),
  hasBefore: z.boolean(),
  hasAfter: z.boolean(),
  total: position,
}).refine((page) => utf8Bytes(JSON.stringify(page.rows)) <= TRANSCRIPT_PAGE_BYTES, 'Transcript page exceeds its preview byte limit');
export type TranscriptPage = z.infer<typeof transcriptPageSchema>;

export const transcriptContentRequestSchema = z.object({
  generation: z.string().min(1),
  rowId: z.string().min(1),
  offset: position,
});
export type TranscriptContentRequest = z.infer<typeof transcriptContentRequestSchema>;

export const transcriptContentPageSchema = z.object({
  text: z.string().max(TRANSCRIPT_CONTENT_CHARACTERS),
  offset: position,
  nextOffset: position.nullable(),
  totalCharacters: position,
  contentRevision: position.optional(),
});
export type TranscriptContentPage = z.infer<typeof transcriptContentPageSchema>;

// Leave room for the row envelope (including its repeated item/turn identifiers).
const ITEM_PREVIEW_BYTES = TRANSCRIPT_ROW_BYTES - 2 * 1024;
const OMITTED = Symbol('omitted');
const LITERAL_KEYS: Record<string, true> = { type: true, role: true, status: true, mimeType: true, reason: true, risk: true, kind: true };

/**
 * Copy a bounded prefix only when the complete item exceeds the row budget.
 * The original item remains the store's full-content value.
 */
function previewValue(value: unknown, budget: { remaining: number; truncated: boolean }, key = ''): unknown {
  if (typeof value === 'string') {
    if (LITERAL_KEYS[key] || key === 'language' && value === 'mermaid') {
      budget.remaining -= utf8Bytes(JSON.stringify(value));
      return value;
    }
    const available = Math.max(1, Math.min(4096, budget.remaining));
    let end = 0;
    let bytes = 2;
    while (end < value.length) {
      const code = value.charCodeAt(end);
      let width = 1;
      let cost = code < 0x80 ? code < 0x20 ? 6 : code === 0x22 || code === 0x5c ? 2 : 1 : code < 0x800 ? 2 : 3;
      if (code >= 0xd800 && code <= 0xdbff && end + 1 < value.length
        && value.charCodeAt(end + 1) >= 0xdc00 && value.charCodeAt(end + 1) <= 0xdfff) {
        width = 2;
        cost = 4;
      } else if (code >= 0xd800 && code <= 0xdfff) cost = 6;
      if (bytes + cost > available) break;
      bytes += cost;
      end += width;
    }
    // All schema IDs are nonempty, even when the display budget is exhausted.
    if (key === 'id' && value.length && end === 0) end = value.codePointAt(0)! > 0xffff ? 2 : 1;
    const result = value.slice(0, end);
    budget.remaining -= utf8Bytes(JSON.stringify(result));
    if (end < value.length) budget.truncated = true;
    return result;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    budget.remaining -= 2;
    for (const [index, entry] of value.entries()) {
      if (budget.remaining < 256 || index >= 64) {
        budget.truncated = true;
        break;
      }
      const next = previewValue(entry, budget);
      if (next !== OMITTED) result.push(next);
      budget.remaining--;
    }
    return result;
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const inlineImage = source.type === 'image' && typeof source.url === 'string' && source.url.startsWith('data:')
      ? source.url
      : typeof source.data === 'string' && typeof source.mimeType === 'string' ? source.data : undefined;
    if (inlineImage !== undefined) {
      // Reserve the entire image before copying other fields: base64 is atomic.
      if (inlineImage.length > 2048 || typeof source.id === 'string' && source.id.length > 2048
        || typeof source.alt === 'string' && source.alt.length > 2048) {
        budget.truncated = true;
        return OMITTED;
      }
      const image = source.type === 'image'
        ? { id: source.id, type: 'image', url: source.url, ...(source.alt !== undefined ? { alt: source.alt } : {}) }
        : { data: source.data, mimeType: source.mimeType };
      const bytes = utf8Bytes(JSON.stringify(image));
      if (bytes <= Math.min(4096, budget.remaining)) {
        budget.remaining -= bytes;
        return image;
      }
      budget.truncated = true;
      return OMITTED;
    }
    const result: Record<string, unknown> = {};
    budget.remaining -= 2;
    // Stable identities take priority over display text regardless of key order.
    if (typeof source.id === 'string') {
      budget.remaining -= 7;
      result.id = previewValue(source.id, budget, 'id');
    }
    for (const field of Object.keys(source)) {
      if (field === 'args' || field === 'details') {
        if (source[field] !== undefined) budget.truncated = true;
        continue;
      }
      if (field === 'id') continue;
      if (source[field] === undefined) continue;
      budget.remaining -= utf8Bytes(JSON.stringify(field)) + 2;
      const next = previewValue(source[field], budget, field);
      if (next !== OMITTED) result[field] = next;
    }
    return result;
  }
  budget.remaining -= String(value).length;
  return value;
}

export function previewTranscriptItem(item: TranscriptItem): { item: TranscriptItem; truncated: boolean; contentBytes: number } {
  const contentBytes = utf8Bytes(JSON.stringify(item));
  if (contentBytes <= ITEM_PREVIEW_BYTES) return { item, truncated: false, contentBytes };
  const budget = { remaining: ITEM_PREVIEW_BYTES - 1024, truncated: false };
  let preview = previewValue(item, budget) as TranscriptItem | typeof OMITTED;
  // A standalone inline image still needs a schema-valid, non-loading row.
  if (preview === OMITTED) preview = {
    id: previewValue(item.id, budget, 'id') as string,
    type: 'image',
    url: '',
    alt: 'Image available in full content',
  };
  return { item: preview, truncated: budget.truncated, contentBytes };
}
