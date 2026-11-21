import { z } from 'zod';

/**
 * A ghost: a short-lived, read-only chat about one recorded session (docs/GHOSTS-DESIGN.md). A person opens one socket
 * per ghost (`GHOST_PATH?projectId&workspaceId[&conversationId]`, upgraded, signed by one of the account's browser
 * devices in `Sec-WebSocket-Protocol`); no conversation id means the workspace's main conversation. The ghost lives in
 * memory only, in its own object, and reads that one conversation's transcript and the workspace's drive as it was when
 * the ghost started. It fades `GHOST_LIFETIME_MS` after its last answer (`keep` moves that on), and closing the socket
 * ends it at once. Nothing it read or said is kept; only token counts are, in the account's usage.
 */

export const GHOST_PATH = '/api/ghost';
/** How long a ghost lives after its last answer, or after `keep`. */
export const GHOST_LIFETIME_MS = 10 * 60_000;
/** The last stretch of a ghost's life, when the window fades and offers to keep it. */
export const GHOST_WARN_MS = 60_000;
/** Tool rounds one answer may use; at the cap it answers from what it read. */
export const GHOST_MAX_ROUNDS = 6;
export const GHOST_QUESTION_MAX = 4_000;
/** Ordinals per transcript entry: an event's ordinal is `entry * 1024 + n`, and a ghost cites entries. */
export const GHOST_ENTRY_ORDINALS = 1024;

const id = z.string().min(1).max(256);
const entry = z.number().int().nonnegative();

export const GhostQuerySchema = z.strictObject({ projectId: id, workspaceId: id, conversationId: id.optional() });
export type GhostQuery = z.infer<typeof GhostQuerySchema>;

/** What an answer points at: a transcript entry or run of entries, or lines of a drive file in the generation read. */
export const GhostCiteSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('entry'), from: entry, to: entry.optional() }),
  z.strictObject({ kind: z.literal('drive'), url: z.string().min(1), lines: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(), generation: z.number().int().nonnegative().nullable() }),
]);
export type GhostCite = z.infer<typeof GhostCiteSchema>;

/** One read the ghost made while answering: a search with its hit count, a run of transcript entries, a drive file. */
export const GhostReadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('search'), query: z.string(), hits: z.number().int().nonnegative().nullable() }),
  z.strictObject({ kind: z.literal('read'), from: entry.nullable(), to: entry.nullable() }),
  z.strictObject({ kind: z.literal('drive'), url: z.string(), generation: z.number().int().nonnegative().nullable() }),
]);
export type GhostRead = z.infer<typeof GhostReadSchema>;

export const GhostPartSchema = z.union([z.string(), GhostCiteSchema]);
export type GhostPart = z.infer<typeof GhostPartSchema>;

export const GhostClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ask'), text: z.string().trim().min(1).max(GHOST_QUESTION_MAX) }),
  /** Ten more minutes from now. */
  z.strictObject({ type: z.literal('keep') }),
  /** End the ghost now; the socket closes. */
  z.strictObject({ type: z.literal('close') }),
]);
export type GhostClientMessage = z.infer<typeof GhostClientMessageSchema>;

const turn = z.number().int().positive();
const at = z.iso.datetime();

export const GhostServerMessageSchema = z.discriminatedUnion('type', [
  /** The ghost is ready: the session it reads, its size in entries, the drive time it reads, and the model answering. */
  z.strictObject({
    type: z.literal('ready'), ghostId: z.string().min(1), conversationId: id, title: z.string(), entries: z.number().int().nonnegative(),
    archived: z.boolean(), driveAsOf: at, expiresAt: at, model: z.string(),
  }),
  /** A read of answer `turn`: started (`done` false), finished, or failed with why. */
  z.strictObject({ type: z.literal('read'), turn, index: z.number().int().nonnegative(), read: GhostReadSchema, done: z.boolean(), failed: z.string().optional() }),
  /** Text of answer `turn` as it streams; a new `round` replaces the text of the round before. */
  z.strictObject({ type: z.literal('text'), turn, round: z.number().int().nonnegative(), delta: z.string() }),
  /** Answer `turn` whole: its text with citations, and, asked to act, the message it drafted for the person to send. */
  z.strictObject({ type: z.literal('answer'), turn, parts: z.array(GhostPartSchema), draft: z.string().nullable(), rounds: z.number().int().nonnegative(), truncated: z.boolean(), expiresAt: at }),
  z.strictObject({ type: z.literal('failed'), turn, message: z.string(), expiresAt: at }),
  /** `keep` moved the deadline. */
  z.strictObject({ type: z.literal('expires'), expiresAt: at }),
  /** The ghost ended and kept nothing; the socket closes. */
  z.strictObject({ type: z.literal('ended'), reason: z.enum(['faded', 'closed', 'failed']), endedAt: at, questions: z.number().int().nonnegative(), message: z.string().optional() }),
]);
export type GhostServerMessage = z.infer<typeof GhostServerMessageSchema>;

/** `[#118]`, `[#93-117]` (or an en dash), `[drive://workspace/notes/plan.md:19-20]`: how an answer cites, inline. */
const CITE = /\[(?:#(\d+)(?:\s*[-–]\s*#?(\d+))?|(drive:\/\/[^\]\s]+?)(?::(\d+)(?:[-–](\d+))?)?)\]/gu;

/** An answer's text as parts: text and citations, in order. `generations` names the drive generation each file was
 * read at. */
export function ghostParts(text: string, generations: ReadonlyMap<string, number | null>): GhostPart[] {
  const parts: GhostPart[] = [];
  let from = 0;
  for (const match of text.matchAll(CITE)) {
    if (match.index > from) parts.push(text.slice(from, match.index));
    const [, start, end, url, first, last] = match;
    if (start !== undefined) {
      const cite: GhostCite = end === undefined || end === start ? { kind: 'entry', from: Number(start) } : { kind: 'entry', from: Number(start), to: Number(end) };
      parts.push(cite);
    } else if (url !== undefined) {
      const line = first === undefined ? null : Number(first);
      parts.push({ kind: 'drive', url, ...(line === null || line < 1 ? {} : { lines: [line, Math.max(line, last === undefined ? line : Number(last))] }), generation: generations.get(url) ?? null });
    }
    from = match.index + match[0].length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}
