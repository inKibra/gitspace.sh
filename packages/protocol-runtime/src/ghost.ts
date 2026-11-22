import { z } from 'zod';

/**
 * A ghost: a short-lived, read-only chat about one recorded session (docs/GHOSTS-DESIGN.md). A person opens one socket
 * per ghost (`GHOST_PATH?projectId&workspaceId[&conversationId][&until]`, upgraded, signed by one of the account's
 * browser devices in `Sec-WebSocket-Protocol`); no conversation id means the workspace's main conversation. An agent
 * asks one with `ghost_ask` and gets one answer back (`GhostAskResult`), asking the same ghost again by its id while it
 * lives. The ghost lives in memory only, in its own object, and reads that one conversation's transcript and the
 * workspace's drive as they were at its `asOf`: when it started, or with `until` (an entry it reads nothing after) that
 * entry's time. It fades `GHOST_LIFETIME_MS` after its last answer (`keep` moves that on),
 * and closing a person's socket ends it at once. Nothing it read or said is kept; only token counts are, in the
 * account's usage.
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
/** Live ghosts one agent conversation may hold at once (`ghost_ask`). */
export const GHOST_AGENT_LIVE_MAX = 3;
/** The longest answer an agent's ghost returns, so a result fits the asker's context. */
export const GHOST_ANSWER_MAX = 8_000;

const id = z.string().min(1).max(256);
const entry = z.number().int().nonnegative();

/** The socket's query: the session, and `until`, the last entry the ghost may read (decimal). */
export const GhostQuerySchema = z.strictObject({ projectId: id, workspaceId: id, conversationId: id.optional(), until: z.string().regex(/^\d{1,9}$/u).transform(Number).optional() });
/** The query as the browser writes it: every value a string. */
export type GhostQuery = z.input<typeof GhostQuerySchema>;

/** What an answer points at: a transcript entry or run of entries, or lines of a drive file in the version read (its
 * generation and the file's `sha256:` hash there; results recorded before the hash existed have none). */
const entryCite = z.strictObject({ kind: z.literal('entry'), from: entry, to: entry.optional() });
const driveCite = z.strictObject({
  kind: z.literal('drive'), url: z.string().min(1), lines: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  generation: z.number().int().nonnegative().nullable(), hash: z.string().min(1).nullable().default(null),
});
export const GhostCiteSchema = z.discriminatedUnion('kind', [entryCite, driveCite]);
export type GhostCite = z.infer<typeof GhostCiteSchema>;
/** The version of a drive file a ghost read: the drive's generation and the file's hash in it (null when unknown). */
export type GhostDriveVersion = { generation: number | null; hash: string | null };

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
  /** A question; `about` is the entry it is about ("Ask a ghost about this"). */
  z.strictObject({ type: z.literal('ask'), text: z.string().trim().min(1).max(GHOST_QUESTION_MAX), about: entry.optional() }),
  /** Ten more minutes from now. */
  z.strictObject({ type: z.literal('keep') }),
  /** End the ghost now; the socket closes. */
  z.strictObject({ type: z.literal('close') }),
]);
export type GhostClientMessage = z.infer<typeof GhostClientMessageSchema>;

const turn = z.number().int().positive();
const at = z.iso.datetime();

export const GhostServerMessageSchema = z.discriminatedUnion('type', [
  /** The ghost is ready: the session it reads, its size in entries (up to `until` when it has one), the time it reads
   * the drive as of, whether the conversation is the workspace's main one, and the model answering. */
  z.strictObject({
    type: z.literal('ready'), ghostId: z.string().min(1), conversationId: id, title: z.string(), main: z.boolean(), entries: z.number().int().nonnegative(),
    until: entry.nullable(), archived: z.boolean(), driveAsOf: at, expiresAt: at, model: z.string(),
  }),
  /** A read of answer `turn`: started (`done` false), finished, or failed with why. */
  z.strictObject({ type: z.literal('read'), turn, index: z.number().int().nonnegative(), read: GhostReadSchema, done: z.boolean(), failed: z.string().optional() }),
  /** Text of answer `turn` as it streams; a new `round` replaces the text of the round before. */
  z.strictObject({ type: z.literal('text'), turn, round: z.number().int().nonnegative(), delta: z.string() }),
  /** Answer `turn` whole: its text with citations, and, asked to act, the message it drafted for the person to send. */
  z.strictObject({
    type: z.literal('answer'), turn, parts: z.array(GhostPartSchema), draft: z.string().nullable(),
    rounds: z.number().int().nonnegative(), truncated: z.boolean(), expiresAt: at,
  }),
  z.strictObject({ type: z.literal('failed'), turn, message: z.string(), expiresAt: at }),
  /** `keep` moved the deadline. */
  z.strictObject({ type: z.literal('expires'), expiresAt: at }),
  /** The ghost ended and kept nothing; the socket closes. */
  z.strictObject({ type: z.literal('ended'), reason: z.enum(['faded', 'closed', 'failed']), endedAt: at, questions: z.number().int().nonnegative(), message: z.string().optional() }),
]);
export type GhostServerMessage = z.infer<typeof GhostServerMessageSchema>;

const count = z.number().int().nonnegative();
const ref = z.string().min(1);
/** A citation as the asking agent reads it, with `ref`: a `history://<workspace>/<conversation>#<entry>[-<entry>]`
 * reference for entries, and for a file the `drive://` path the asker reads it by, with its lines. */
export const GhostAskCiteSchema = z.discriminatedUnion('kind', [entryCite.extend({ ref }), driveCite.extend({ ref })]);
export type GhostAskCite = z.infer<typeof GhostAskCiteSchema>;
/** A Chatter citation or read in a `ghost_ask` result recorded before ghosts stopped reading Chatter (2026-11-22): it
 * parses and is dropped; the answer's `[chatter:N]` stays plain text. */
const recordedChatter = z.looseObject({ kind: z.literal('chatter') });
/** `ghost_ask`'s result: one answer of an agent's ghost about one session. `answer` cites inline as the ghost wrote it,
 * by the session's entry numbers and its workspace's drive paths; `cites` names each citation as the asker can read it.
 * `until` is the last entry it could read (results recorded before `until` existed have none), `driveAsOf` the time it
 * read the drive as of. `ghostId` asks the same ghost again until `expiresAt`. */
export const GhostAskResultSchema = z.strictObject({
  ghostId: z.uuid(), expiresAt: at,
  session: z.strictObject({ workspaceId: id, workspace: z.string(), conversationId: id, title: z.string(), main: z.boolean(), archived: z.boolean() }),
  until: entry.nullable().default(null),
  answer: z.string(),
  cites: z.array(z.union([GhostAskCiteSchema, recordedChatter])).transform(cites => cites.flatMap(cite => cite.kind === 'chatter' ? [] : [cite])),
  reads: z.array(z.union([GhostReadSchema, recordedChatter])).transform(reads => reads.flatMap(read => read.kind === 'chatter' ? [] : [read])),
  driveAsOf: at,
  /** Asked to act: the message the ghost drafted, for the asker to send or post itself. */
  draft: z.string().nullable(),
  rounds: count, truncated: z.boolean(),
  /** What this answer spent, counted in the asking workspace's usage. */
  usage: z.strictObject({ model: z.string(), requests: count, input: count, output: count, costUsd: z.number().nonnegative() }),
});
export type GhostAskResult = z.infer<typeof GhostAskResultSchema>;

/** `[#118]`, `[#93-117]` (or an en dash), `[drive://workspace/notes/plan.md:19-20]`: how an answer cites, inline. */
const CITE = /\[(?:#(\d+)(?:\s*[-–]\s*#?(\d+))?|(drive:\/\/[^\]\s]+?)(?::(\d+)(?:[-–](\d+))?)?)\]/gu;

/** An answer's text as parts: text and citations, in order. `versions` names the version each drive file was read
 * at. */
export function ghostParts(text: string, versions: ReadonlyMap<string, GhostDriveVersion>): GhostPart[] {
  const parts: GhostPart[] = [];
  let from = 0;
  for (const match of text.matchAll(CITE)) {
    if (match.index > from) parts.push(text.slice(from, match.index));
    const [, start, end, url = '', first, last] = match;
    if (start !== undefined) {
      const cite: GhostCite = end === undefined || end === start ? { kind: 'entry', from: Number(start) } : { kind: 'entry', from: Number(start), to: Number(end) };
      parts.push(cite);
    } else {
      const line = first === undefined ? null : Number(first);
      const version = versions.get(url);
      parts.push({ kind: 'drive', url, ...(line === null || line < 1 ? {} : { lines: [line, Math.max(line, last === undefined ? line : Number(last))] }), generation: version?.generation ?? null, hash: version?.hash ?? null });
    }
    from = match.index + match[0].length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}
