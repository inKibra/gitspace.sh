import { z } from 'zod';

/**
 * Comments on pages (docs/APERTURE-DESIGN.md §9, B2): threads a workspace keeps (`gitspace.page-comments`). A thread
 * is its root comment, which points at something on a page (`anchor`), and the replies under it. Comments come from
 * people watching a share link, from the in-page comment tool on your Chrome, from a capture's timeline, from the
 * Inspector's Browser tab and from the main agent. The account's owner and the main agent resolve a thread; guests
 * and subagents never do.
 *
 * Boxes are fractions of the page's viewport, 0 to 1 from its top-left, so they hold at every frame and screen size.
 */

const uuid = z.string().uuid();
const fraction = z.number().min(0).max(1);
/** The longest comment, in characters. */
export const BROWSER_COMMENT_TEXT_MAX = 4000;
/** Threads a workspace keeps; past it the oldest go. */
export const BROWSER_COMMENT_THREADS_KEPT = 2000;
/** Replies one thread takes. */
export const BROWSER_COMMENT_REPLIES = 100;
/** The largest crop a comment keeps, in bytes of JPEG. */
export const BROWSER_COMMENT_CROP_BYTES = 400 * 1024;

export const RuntimeBrowserCommentTextSchema = z.string().trim().min(1).max(BROWSER_COMMENT_TEXT_MAX);
/** A person's name as shown on their comments: a share viewer's, or the account's for its owner. */
export const RuntimeBrowserCommentNameSchema = z.string().trim().min(1).max(60);
export const RuntimeBrowserCommentBoxSchema = z.strictObject({ x: fraction, y: fraction, w: fraction, h: fraction });
export type RuntimeBrowserCommentBox = z.infer<typeof RuntimeBrowserCommentBoxSchema>;
export const RuntimeBrowserCommentPageSchema = z.strictObject({ url: z.string().max(8192), title: z.string().max(500) });

/** Where a comment was made: a share link's viewer, your Chrome's in-page tool, or a capture's timeline at `atMs`. */
export const RuntimeBrowserCommentSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('share'), shareId: uuid }),
  z.strictObject({ kind: z.literal('chrome'), pairingId: uuid }),
  z.strictObject({ kind: z.literal('capture'), captureId: uuid, atMs: z.number().int().nonnegative() }),
]);
export type RuntimeBrowserCommentSource = z.infer<typeof RuntimeBrowserCommentSourceSchema>;

/** What a root comment points at: an element's accessible role and name and a selector to find it again, its box, and
 * `cropFile`, the workspace drive path of a JPEG of that area (`browser/comments/<id>.jpg`; read it as
 * `drive://workspace/<cropFile>`). `area`: a dragged area, whose role, name and selector are the element around it (all
 * empty when none). `scroll` (the page's scroll offset) and `viewport` (its size), in CSS pixels when the comment was
 * made, place the box on the page as it scrolls; comments made before they were kept have neither. */
export const RuntimeBrowserCommentAnchorSchema = z.strictObject({
  role: z.string().max(64), name: z.string().max(500), selector: z.string().max(1024), box: RuntimeBrowserCommentBoxSchema,
  cropFile: z.string().max(512).optional(), area: z.boolean().optional(),
  scroll: z.strictObject({ x: z.number(), y: z.number() }).optional(),
  viewport: z.strictObject({ w: z.number().int().positive(), h: z.number().int().positive() }).optional(),
});
export type RuntimeBrowserCommentAnchor = z.infer<typeof RuntimeBrowserCommentAnchorSchema>;

/** Who wrote a comment: a person (`guest` unless the account's owner), or an agent of the workspace (`conversation`:
 * `main`, or a subagent's conversation id). */
export const RuntimeBrowserCommentAuthorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('person'), name: RuntimeBrowserCommentNameSchema, guest: z.boolean() }),
  z.strictObject({ kind: z.literal('agent'), conversation: z.string().min(1).max(256) }),
]);
export type RuntimeBrowserCommentAuthor = z.infer<typeof RuntimeBrowserCommentAuthorSchema>;

/** Who resolved a thread (a person's name, or `agent`) and when. */
export const RuntimeBrowserCommentResolvedSchema = z.strictObject({ by: z.string().min(1).max(128), at: z.iso.datetime() });

/** One comment. A root has `threadId` = its own `id`, no `parentId`, an anchor and `resolved`; a reply has its root's
 * `threadId` and `parentId`, no anchor, and `resolved` null. */
export const RuntimeBrowserCommentSchema = z.strictObject({
  id: uuid, threadId: uuid, parentId: uuid.nullable(), source: RuntimeBrowserCommentSourceSchema, page: RuntimeBrowserCommentPageSchema,
  anchor: RuntimeBrowserCommentAnchorSchema.nullable(), by: RuntimeBrowserCommentAuthorSchema, text: RuntimeBrowserCommentTextSchema,
  createdAt: z.iso.datetime(), resolved: RuntimeBrowserCommentResolvedSchema.nullable(),
});
export type RuntimeBrowserComment = z.infer<typeof RuntimeBrowserCommentSchema>;

/** A thread: its root and its replies, oldest first. */
export const RuntimeBrowserCommentThreadSchema = z.strictObject({ root: RuntimeBrowserCommentSchema, replies: z.array(RuntimeBrowserCommentSchema).max(BROWSER_COMMENT_REPLIES) });
export type RuntimeBrowserCommentThread = z.infer<typeof RuntimeBrowserCommentThreadSchema>;
/** A thread as the Browser tab shows it, with a sealed `/files/` link to its root's crop while the crop is in the drive. */
export const RuntimeBrowserCommentThreadViewSchema = z.strictObject({ thread: RuntimeBrowserCommentThreadSchema, cropUrl: z.string().max(4096).nullable() });
export type RuntimeBrowserCommentThreadView = z.infer<typeof RuntimeBrowserCommentThreadViewSchema>;

/** Which threads a list returns: unresolved ones, or every one. */
export const RuntimeBrowserCommentStatusSchema = z.enum(['open', 'all']);
export type RuntimeBrowserCommentStatus = z.infer<typeof RuntimeBrowserCommentStatusSchema>;
/** Narrows a list to one share's, one capture's or one page's threads (a page by its URL without the fragment). */
export const RuntimeBrowserCommentFilterSchema = z.strictObject({
  status: RuntimeBrowserCommentStatusSchema.default('open'), limit: z.number().int().min(1).max(500).default(50),
  shareId: uuid.optional(), captureId: uuid.optional(), url: z.string().max(8192).optional(),
});
export type RuntimeBrowserCommentFilter = z.input<typeof RuntimeBrowserCommentFilterSchema>;

/** A change to a workspace's comments, whoever makes it: a new thread (`comment`, with its source, page and anchor), a
 * reply, or resolving (or reopening) a thread. Who makes it travels beside it. */
export const RuntimeBrowserCommentWriteSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('comment'), source: RuntimeBrowserCommentSourceSchema, page: RuntimeBrowserCommentPageSchema, anchor: RuntimeBrowserCommentAnchorSchema, text: RuntimeBrowserCommentTextSchema }),
  z.strictObject({ op: z.literal('reply'), threadId: uuid, text: RuntimeBrowserCommentTextSchema }),
  z.strictObject({ op: z.literal('resolve'), threadId: uuid, reopen: z.boolean().optional() }),
]);
export type RuntimeBrowserCommentWrite = z.infer<typeof RuntimeBrowserCommentWriteSchema>;

/** Where your Chrome's in-page comment tool files and reads comments (`POST`, signed with its pairing key, label
 * `comment`). Each request names a live workspace group on that Chrome: comments land in its workspace. */
export const BROWSER_COMMENT_PATH = '/api/browser-relay/comments';
/** Requests of your Chrome's in-page comment tool. `comment` makes a thread on the page (with `capture`, on that
 * capture's timeline at `atMs`, for a capture this Chrome is recording into the same workspace); `crop` is a base64
 * JPEG of the anchored area, at most `BROWSER_COMMENT_CROP_BYTES`. `list` returns the page's threads, resolved ones too.
 * Answers: `{ thread }` for comment, reply and resolve; `{ threads, name }` for list, `name` being yours as your
 * comments show it. */
export const RuntimeBrowserCommentChromeRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('comment'), groupId: uuid, page: RuntimeBrowserCommentPageSchema, anchor: RuntimeBrowserCommentAnchorSchema.omit({ cropFile: true }),
    crop: z.string().max(Math.ceil(BROWSER_COMMENT_CROP_BYTES / 3) * 4).optional(), text: RuntimeBrowserCommentTextSchema,
    capture: z.strictObject({ captureId: uuid, atMs: z.number().int().nonnegative() }).optional(),
  }),
  z.strictObject({ op: z.literal('reply'), groupId: uuid, threadId: uuid, text: RuntimeBrowserCommentTextSchema }),
  z.strictObject({ op: z.literal('resolve'), groupId: uuid, threadId: uuid, reopen: z.boolean().optional() }),
  z.strictObject({ op: z.literal('list'), groupId: uuid, url: z.string().max(8192) }),
]);
export type RuntimeBrowserCommentChromeRequest = z.infer<typeof RuntimeBrowserCommentChromeRequestSchema>;

/** A page's URL as threads are matched to it: without its fragment. */
export function browserCommentPageKey(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/** Whether a person may resolve: the account's owner, never a guest. Agents are checked by their conversation. */
export function browserCommentMayResolve(by: RuntimeBrowserCommentAuthor): boolean {
  return by.kind === 'agent' ? by.conversation === 'main' : !by.guest;
}
