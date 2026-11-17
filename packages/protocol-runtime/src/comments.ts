// Comments on what an agent wrote (docs/BLOCK-DOCUMENTS-DESIGN.md §3–§4). A person stages a comment against an anchor;
// it waits in the workspace's staged comments (a runtime document) and goes with their next message as a "Comment: …"
// line followed by its data; the agent answers it with a gitspace-ui Reply block naming its id. Comments live in those
// messages only: the runtime's lookup (comment → anchor → message, reply → comment) is derived from the transcript.
// A person's answer to an open question waits beside them (a staged answer) and goes with their next message as an
// "Answer to …" line followed by its data; the runtime records it as the question's answer in the commit that takes
// the message.
import { z } from 'zod';
import { RuntimeApprovalAnswerSchema, RuntimeJsonSchema, askAnswerParts } from './base.js';

/** What a comment quotes, as people read it. */
export const COMMENT_QUOTE_MAX = 280;
/** A selection a text anchor finds again: at most this many characters. */
export const COMMENT_EXACT_MAX = 2000;
/** Characters of text kept on each side of a text anchor's selection. */
export const COMMENT_CONTEXT = 32;
export const COMMENT_NOTE_MAX = 4000;
/** Comments staged at once in a workspace. */
export const STAGED_COMMENTS_MAX = 64;

/** `cm-` and 12 hex digits, made by the runtime when the comment is staged. */
export const CommentIdSchema = z.string().regex(/^cm-[0-9a-f]{12}$/u);
const Reference = z.string().min(1).max(512);

/** The document a comment is in: a chat turn (`turnId`, the transcript's turn row id), the workspace Goal at a revision,
 * or a Change Guide revision. A conversation's comments go on the turns of its comment window: from the turn of the
 * newest message a person or the project agent sent on (automated inputs open turns inside it); the Goal's and the
 * Guide's never lock. */
export const CommentDocumentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('turn'), conversationId: z.string().min(1), turnId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('goal'), revision: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('guide'), revision: z.number().int().positive() }).strict(),
]);
export type CommentDocument = z.infer<typeof CommentDocumentSchema>;
/** The documents whose comments stay open across turns. */
export const OPEN_DOCUMENT_KINDS = ['goal', 'guide'] as const;
export type OpenDocumentKind = (typeof OPEN_DOCUMENT_KINDS)[number];

/**
 * Where in its document a comment is. In a chat turn a message is `message:<row id>`, a tool call `tool-call:<row id>`,
 * and a gitspace-ui block `<message row id>#<element id>` (its root element's id), or `<message row id>#@<hash>` for a
 * block whose root has no id. In the Goal and a Change Guide an entity is `requirement:<id>`, `decision:<entry id>`,
 * `section:<id>` or `exhibit:<section id>:<path>`, and a block in one of its Markdown fields `<entity>#<element id>`.
 * `item`: a row, step, line or frame of a block (`path` as `rows/2`, `label` as people read it). `text`: a text-quote
 * selector inside `within` (a message, an entity or a block), found again by `findTextQuote`. `lines`: lines of an
 * exhibit's diff on one side, at the file's blob there. `time`: a moment of a video; `frame`: a frame of a Sequence.
 */
export const CommentTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('block'), id: Reference }).strict(),
  z.object({ kind: z.literal('item'), block: Reference, path: z.string().min(1).max(200), label: z.string().min(1).max(120) }).strict(),
  z.object({ kind: z.literal('entity'), ref: Reference }).strict(),
  z.object({ kind: z.literal('text'), within: Reference.nullable(), exact: z.string().min(1).max(COMMENT_EXACT_MAX), prefix: z.string().max(COMMENT_CONTEXT), suffix: z.string().max(COMMENT_CONTEXT) }).strict(),
  z.object({ kind: z.literal('lines'), exhibit: Reference, side: z.enum(['base', 'head']), start: z.number().int().positive(), end: z.number().int().positive(), blobId: z.string().min(1).max(128).nullable() }).strict()
    .refine((target) => target.end >= target.start, { message: 'A line range ends at or after its start', path: ['end'] }),
  z.object({ kind: z.literal('time'), block: Reference, seconds: z.number().nonnegative() }).strict(),
  z.object({ kind: z.literal('frame'), block: Reference, index: z.number().int().nonnegative() }).strict(),
]);

/** `quote`: what the person saw where they commented. */
export const CommentAnchorSchema = z.object({ document: CommentDocumentSchema, target: CommentTargetSchema, quote: z.string().max(COMMENT_QUOTE_MAX) }).strict();
export type CommentAnchor = z.infer<typeof CommentAnchorSchema>;
export type CommentTarget = z.infer<typeof CommentTargetSchema>;

export const CommentNoteSchema = z.string().trim().min(1).max(COMMENT_NOTE_MAX);

/** A comment as a message carries it. */
export const SentCommentSchema = z.object({ id: CommentIdSchema, anchor: CommentAnchorSchema, note: CommentNoteSchema }).strict();
export type SentComment = z.infer<typeof SentCommentSchema>;

/** A comment waiting for the person's next message; `deviceId`: the device that staged it. */
export const StagedCommentSchema = SentCommentSchema.extend({ stagedAt: z.iso.datetime(), deviceId: z.string().min(1).nullable() });
export type StagedComment = z.infer<typeof StagedCommentSchema>;

/** A person's answer to an open question as a message carries it: an ask's parts (`{ id, selectedOptions,
 * customInput }` per question it asks), a plan approval's `{ approved, note }`. */
export const SentAnswerSchema = z.object({ questionId: z.string().min(1).max(512), answer: RuntimeJsonSchema }).strict();
export type SentAnswer = z.infer<typeof SentAnswerSchema>;
/** An answer waiting for the person's next message, one per question: staging another answer replaces it. */
export const StagedAnswerSchema = SentAnswerSchema.extend({ stagedAt: z.iso.datetime(), deviceId: z.string().min(1).nullable() });
export type StagedAnswer = z.infer<typeof StagedAnswerSchema>;
/** Answers staged at once in a workspace. */
export const STAGED_ANSWERS_MAX = 32;

/** The snapshot's `gitspace.comments` document: the staged comments and answers, oldest first, the lookup's revision,
 * which moves whenever a sent comment or a reply joins the lookup, and `window`, the turn where the main conversation's
 * comment window starts (null before its first message): rows of that turn and later turns take comments. */
export const CommentsDocumentSchema = z.object({ staged: z.array(StagedCommentSchema).max(STAGED_COMMENTS_MAX), answers: z.array(StagedAnswerSchema).max(STAGED_ANSWERS_MAX).default([]), lookupRevision: z.number().int().nonnegative(), window: z.string().min(1).nullable().default(null) });
export type CommentsDocument = z.infer<typeof CommentsDocumentSchema>;

/** A sent comment in the lookup: its anchor, and the person's message row that carries it. */
export const CommentPointerSchema = z.object({ id: CommentIdSchema, conversationId: z.string().min(1), message: z.string().min(1), anchor: CommentAnchorSchema });
export type CommentPointer = z.infer<typeof CommentPointerSchema>;
/** An agent message row that answers `comment` with a Reply block. */
export const CommentReplyPointerSchema = z.object({ row: z.string().min(1), comment: CommentIdSchema });
export type CommentReplyPointer = z.infer<typeof CommentReplyPointerSchema>;
/** The lookup's comments on some turns and the replies to them. */
export const CommentLookupSchema = z.object({ comments: z.array(CommentPointerSchema), replies: z.array(CommentReplyPointerSchema) });
export type CommentLookup = z.infer<typeof CommentLookupSchema>;

/** At most `max` characters of `value` on one line. */
export function commentExcerpt(value: string, max: number): string {
  const line = value.replace(/\s+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A sent comment's line and its data: the line is what people read, the data what the agent reads. */
const COMMENT_DATA = /^Comment on [^\n]*\n~~~json\n([\s\S]*?)\n~~~$/gmu;
const CommentDataSchema = z.object({ comment: SentCommentSchema });

/** The message a send delivers with staged comments: the person's text, then each comment's line and data. */
export function commentsMessage(text: string, comments: readonly SentComment[]): string {
  const lines = comments.map((comment) => `Comment on “${commentExcerpt(comment.anchor.quote, 80)}”: ${commentExcerpt(comment.note, 160)}\n~~~json\n${JSON.stringify({ comment: { id: comment.id, note: comment.note, anchor: comment.anchor } }, null, 2)}\n~~~`);
  return [text.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
}

/** An answer as people read it: a plan approval's decision and note, an ask's chosen options and written text. */
export function answerShown(answer: unknown): string {
  const approval = RuntimeApprovalAnswerSchema.safeParse(answer);
  if (approval.success) return [approval.data.approved ? 'Approve' : 'Reject', approval.data.note].filter(Boolean).join(' · ');
  return askAnswerParts(answer).map((part) => [...part.selectedOptions, ...part.customInput?.trim() ? [part.customInput.trim()] : []].join('; ')).filter(Boolean).join(' · ');
}

/** The message a send delivers with staged answers: the person's text, then each answer's line (the question's
 * prompt and the answer, as people read them) and data. */
export function answersMessage(text: string, answers: readonly { prompt: string; sent: SentAnswer }[]): string {
  const lines = answers.map(({ prompt, sent }) => `Answer to “${commentExcerpt(prompt, 80)}”: ${commentExcerpt(answerShown(sent.answer), 160)}\n~~~json\n${JSON.stringify({ answer: sent }, null, 2)}\n~~~`);
  return [text.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
}

/** The comments a sent message carries, in order. */
export function messageComments(text: string): SentComment[] {
  const found: SentComment[] = [];
  for (const match of text.matchAll(COMMENT_DATA)) {
    let data: unknown;
    try {
      data = JSON.parse(match[1] ?? '');
    } catch {
      continue;
    }
    const parsed = CommentDataSchema.safeParse(data);
    if (parsed.success) found.push(parsed.data.comment);
  }
  return found;
}

/** The message as people read it above its comments: without the comments' lines and data, which close it. */
export function withoutComments(text: string): string {
  const stripped = text.replace(COMMENT_DATA, (line, data: string) => {
    try {
      return CommentDataSchema.safeParse(JSON.parse(data)).success ? '' : line;
    } catch {
      return line;
    }
  });
  return stripped === text ? text : stripped.trimEnd();
}

/** A text-quote selector: the selected text and up to `COMMENT_CONTEXT` characters on each side. */
export interface TextQuote { exact: string; prefix: string; suffix: string }

/** The selector for `text[start, end)`. */
export function textQuoteAt(text: string, start: number, end: number): TextQuote {
  return { exact: text.slice(start, end), prefix: text.slice(Math.max(0, start - COMMENT_CONTEXT), start), suffix: text.slice(end, end + COMMENT_CONTEXT) };
}

/**
 * Where `quote` is in `text`: of the places its exact text appears, the one whose surroundings agree longest with its
 * prefix and suffix (the first on a tie), so text changed elsewhere never moves it. Null when the exact text is gone:
 * the comment is outdated.
 */
export function findTextQuote(text: string, quote: TextQuote): { start: number; end: number } | null {
  if (!quote.exact) return null;
  let best: { start: number; score: number } | null = null;
  for (let start = text.indexOf(quote.exact); start !== -1; start = text.indexOf(quote.exact, start + 1)) {
    let before = 0;
    while (before < quote.prefix.length && text[start - 1 - before] === quote.prefix[quote.prefix.length - 1 - before]) before++;
    const end = start + quote.exact.length;
    let after = 0;
    while (after < quote.suffix.length && text[end + after] === quote.suffix[after]) after++;
    if (best === null || before + after > best.score) best = { start, score: before + after };
  }
  return best === null ? null : { start: best.start, end: best.start + quote.exact.length };
}
