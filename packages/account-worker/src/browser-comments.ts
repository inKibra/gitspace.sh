import { z } from 'zod';
import {
  BROWSER_COMMENT_REPLIES, BROWSER_COMMENT_THREADS_KEPT, RuntimeBrowserCommentFilterSchema, RuntimeBrowserCommentThreadSchema, browserCommentMayResolve, browserCommentPageKey,
  type RuntimeBrowserComment, type RuntimeBrowserCommentAuthor, type RuntimeBrowserCommentFilter, type RuntimeBrowserCommentSource, type RuntimeBrowserCommentThread, type RuntimeBrowserCommentWrite,
} from '@gitspace/protocol-runtime';

/**
 * A workspace's comment threads (docs/APERTURE-DESIGN.md §9) in its runtime storage: one row per thread,
 * `runtime.page-comment:<root createdAt>:<threadId>`, so they list newest first by when they began, and an index entry
 * `runtime.page-comment-thread:<threadId>` naming each thread's row. Past `BROWSER_COMMENT_THREADS_KEPT` threads the
 * oldest go. Crops are files of the workspace's drive under `COMMENT_CROPS`.
 */
export const COMMENT_ROWS = 'runtime.page-comment:';
/** How many thread rows (`COMMENT_ROWS`) the workspace holds. */
const COMMENT_COUNT = 'runtime.page-comment-count';
const COMMENT_INDEX = 'runtime.page-comment-thread:';
/** Where comment crops are kept in the workspace's drive (`browser/comments/<id>.jpg`). */
export const COMMENT_CROPS = 'browser/comments/';
const CROP_FILE = /^browser\/comments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/u;
/** Rows a filtered list reads at a time. */
const LIST_BATCH = 100;

type CommentRows = { list(options: { prefix: string; reverse?: boolean; limit?: number; end?: string }): Promise<Map<string, unknown>> };
type CommentTransaction = CommentRows & { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<boolean> };
export type CommentStorage = CommentTransaction & { transaction<T>(callback: (tx: CommentTransaction) => Promise<T>): Promise<T> };
/** Which threads a writer may touch: a share link's viewers only that share's, a capture share's viewers only that
 * capture's. */
export type CommentScope = { shareId?: string; captureId?: string };
/** What a write did: the thread as it is now, the comment it added (null for a resolve), and whether anything changed. */
export type CommentWritten = { thread: RuntimeBrowserCommentThread; added: RuntimeBrowserComment | null; changed: boolean };
/** A `page-comment` conversation event for the workspace's main conversation. */
export type CommentEvent = { kind: 'page-comment'; requestId: string; sender: { id: string; name: string }; text: string; payload: { threadId: string; commentId: string; reply: boolean; page: { url: string; title: string }; by: string; guest: boolean; source: RuntimeBrowserCommentSource } };
/** Where a change to the workspace's comments is announced (`announceComment`). `relay` is absent when the relay made
 * the change, and tells the share viewers and Chromes itself. */
export type CommentAnnouncer = { live(): void; event(event: CommentEvent): Promise<void>; relay?(thread: RuntimeBrowserCommentThread): Promise<void> };

/** A stored thread row, in the workspace and in the relay's copy of a share's threads. */
const StoredThread = z.strictObject({ version: z.literal(2), thread: RuntimeBrowserCommentThreadSchema });
export type StoredCommentThread = z.infer<typeof StoredThread>;
const legacyBox = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
/** LEGACY: single comments from share links, stored before threads (version 1, until 2026-10-25), read as thread roots
 * with no replies; a reply or resolve rewrites one as a thread. Remove, with the scan in `threadKey`, once no workspace
 * keeps a version 1 row (the relay's share copies hold none two days after this release). */
const LegacyComment = z.object({
  version: z.literal(1), commentId: z.string().uuid(), shareId: z.string().uuid(), by: z.object({ name: z.string(), guest: z.boolean() }), text: z.string(),
  page: z.object({ url: z.string(), title: z.string() }), target: z.object({ role: z.string(), name: z.string(), selectors: z.array(z.string()) }).nullable(),
  region: legacyBox, viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }), scroll: z.object({ x: z.number(), y: z.number() }), crop: z.string().nullable(), createdAt: z.string(),
}).transform((row): RuntimeBrowserCommentThread => ({ root: {
  id: row.commentId, threadId: row.commentId, parentId: null, source: { kind: 'share', shareId: row.shareId }, page: row.page,
  anchor: {
    role: row.target?.role ?? '', name: row.target?.name ?? '', selector: row.target?.selectors[0] ?? '', box: { x: row.region.x, y: row.region.y, w: row.region.width, h: row.region.height },
    ...(row.crop === null ? {} : { cropFile: row.crop }), ...(row.target === null ? { area: true } : {}), scroll: row.scroll, viewport: { w: row.viewport.width, h: row.viewport.height },
  },
  by: { kind: 'person', name: row.by.name, guest: row.by.guest }, text: row.text, createdAt: row.createdAt, resolved: null,
}, replies: [] }));
/** Reads a thread row: a stored thread, or a version 1 comment as a thread. */
export const CommentThreadRowSchema = z.union([StoredThread.transform(row => row.thread), LegacyComment]);

/** The workspace's threads that match `filter`, newest first. */
export async function workspaceCommentThreads(storage: CommentRows, raw: RuntimeBrowserCommentFilter): Promise<RuntimeBrowserCommentThread[]> {
  const filter = RuntimeBrowserCommentFilterSchema.parse(raw);
  const page = filter.url === undefined ? undefined : browserCommentPageKey(filter.url);
  const found: RuntimeBrowserCommentThread[] = [];
  let end: string | undefined;
  for (;;) {
    const batch = await storage.list({ prefix: COMMENT_ROWS, reverse: true, limit: LIST_BATCH, ...(end === undefined ? {} : { end }) });
    let last: string | undefined;
    for (const [key, value] of batch) {
      last = key;
      const thread = CommentThreadRowSchema.parse(value), { root } = thread;
      if (filter.status === 'open' && root.resolved) continue;
      if (filter.shareId !== undefined && !(root.source.kind === 'share' && root.source.shareId === filter.shareId)) continue;
      if (filter.captureId !== undefined && !(root.source.kind === 'capture' && root.source.captureId === filter.captureId)) continue;
      if (page !== undefined && browserCommentPageKey(root.page.url) !== page) continue;
      found.push(thread);
      if (found.length === filter.limit) return found;
    }
    if (batch.size < LIST_BATCH || last === undefined || last === end) return found;
    end = last;
  }
}

/** Makes a thread, replies in one, or resolves (or reopens) one, as `by`. Only the main agent writes among agents;
 * guests never resolve; a scoped writer touches only its share's or capture's threads. Throws, saying why, when refused. */
export async function writeWorkspaceComment(storage: CommentStorage, write: RuntimeBrowserCommentWrite, by: RuntimeBrowserCommentAuthor, scope: CommentScope = {}): Promise<CommentWritten> {
  if (by.kind === 'agent' && by.conversation !== 'main') throw new Error('Only the main agent replies to and resolves comments; subagents read them');
  const now = new Date().toISOString();
  if (write.op === 'comment') {
    inScope(write.source, scope);
    if (write.anchor.cropFile !== undefined && !CROP_FILE.test(write.anchor.cropFile)) throw new Error(`A comment's crop is a JPEG in ${COMMENT_CROPS} of the workspace's drive`);
    const id = crypto.randomUUID();
    const root: RuntimeBrowserComment = { id, threadId: id, parentId: null, source: write.source, page: { url: write.page.url, title: write.page.title }, anchor: write.anchor, by, text: write.text, createdAt: now, resolved: null };
    const thread = RuntimeBrowserCommentThreadSchema.parse({ root, replies: [] });
    const key = `${COMMENT_ROWS}${now}:${id}`;
    await storage.transaction(async tx => {
      const kept = z.number().int().nonnegative().parse(await tx.get(COMMENT_COUNT) ?? 0) + 1;
      await tx.put(key, { version: 2, thread } satisfies z.infer<typeof StoredThread>);
      await tx.put(`${COMMENT_INDEX}${id}`, key);
      const oldest = kept > BROWSER_COMMENT_THREADS_KEPT ? [...(await tx.list({ prefix: COMMENT_ROWS, limit: kept - BROWSER_COMMENT_THREADS_KEPT })).keys()] : [];
      for (const gone of oldest) {
        await tx.delete(gone);
        await tx.delete(`${COMMENT_INDEX}${gone.slice(gone.lastIndexOf(':') + 1)}`);
      }
      await tx.put(COMMENT_COUNT, kept - oldest.length);
    });
    return { thread, added: root, changed: true };
  }
  if (write.op === 'resolve' && !browserCommentMayResolve(by)) throw new Error('Only the account’s owner and the main agent resolve comments');
  return storage.transaction(async tx => {
    const key = await threadKey(tx, write.threadId);
    if (key === undefined) throw new Error('This comment thread is not in the workspace');
    const thread = CommentThreadRowSchema.parse(await tx.get(key));
    inScope(thread.root.source, scope);
    let next: RuntimeBrowserCommentThread, added: RuntimeBrowserComment | null = null;
    if (write.op === 'reply') {
      if (thread.replies.length >= BROWSER_COMMENT_REPLIES) throw new Error(`This thread has ${BROWSER_COMMENT_REPLIES} replies; start a new comment`);
      added = { id: crypto.randomUUID(), threadId: thread.root.id, parentId: thread.root.id, source: thread.root.source, page: thread.root.page, anchor: null, by, text: write.text, createdAt: now, resolved: null };
      next = { root: thread.root, replies: [...thread.replies, added] };
    } else {
      if ((thread.root.resolved === null) === (write.reopen === true)) return { thread, added: null, changed: false };
      next = { root: { ...thread.root, resolved: write.reopen ? null : { by: by.kind === 'agent' ? 'agent' : by.name, at: now } }, replies: thread.replies };
    }
    const checked = RuntimeBrowserCommentThreadSchema.parse(next);
    await tx.put(key, { version: 2, thread: checked } satisfies z.infer<typeof StoredThread>);
    await tx.put(`${COMMENT_INDEX}${thread.root.id}`, key);
    return { thread: checked, added, changed: true };
  });
}

/** The conversation event for a person's new comment or reply: the main agent hears who said what, where, and the
 * thread to answer in. Agents' own comments make none. */
export function commentEvent(comment: RuntimeBrowserComment, root: RuntimeBrowserComment): CommentEvent | null {
  if (comment.by.kind !== 'person') return null;
  const who = `${comment.by.name}${comment.by.guest ? ' (guest)' : ''}`, excerpt = comment.text.length > 500 ? `${comment.text.slice(0, 500)}…` : comment.text;
  const source = root.source;
  const where = source.kind === 'capture' ? `capture ${source.captureId} at ${Math.floor(source.atMs / 60_000)}:${String(Math.floor(source.atMs / 1000) % 60).padStart(2, '0')}, page "${root.page.title}" (${root.page.url})`
    : `"${root.page.title}" (${root.page.url})${source.kind === 'share' ? ', through a share link' : ', in the user’s Chrome'}`;
  const anchor = root.anchor && (root.anchor.role || root.anchor.name) ? `, on ${root.anchor.area ? 'an area around ' : ''}${root.anchor.role} “${root.anchor.name}”` : root.anchor?.area ? ', on an area of the page' : '';
  const said = comment.parentId === null ? `${who} commented on ${where}${anchor}: "${excerpt}"` : `${who} replied in comment thread ${root.id} on ${where}: "${excerpt}"`;
  return {
    kind: 'page-comment', requestId: `page-comment:${comment.id}`, sender: { id: root.id, name: who },
    text: `${said}\nThread ${root.id}. Read it with web_browser {action:"comments"}, answer with {action:"commentReply", threadId:"${root.id}", text} (shown as you on the page and to its viewers), and resolve it with {action:"commentResolve", threadId:"${root.id}"} once it is handled.`,
    payload: { threadId: root.id, commentId: comment.id, reply: comment.parentId !== null, page: { url: root.page.url, title: root.page.title }, by: comment.by.name, guest: comment.by.guest, source },
  };
}

/** What follows a change to the workspace's comments: tabs showing the Browser tab hear of it, the main conversation
 * hears of a person's new comment or reply (once per comment: its request id is the comment's), and the relay tells
 * the thread's share viewers and the Chromes holding the workspace's groups. The change is kept even when an
 * announcement fails, which is logged. */
export async function announceComment(announcer: CommentAnnouncer, written: CommentWritten): Promise<void> {
  if (!written.changed) return;
  announcer.live();
  const threadId = written.thread.root.id, event = written.added ? commentEvent(written.added, written.thread.root) : null;
  if (event) await announcer.event(event).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_comment_event_failed', threadId, error: String(error) })));
  if (announcer.relay) await announcer.relay(written.thread).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_comment_relay_failed', threadId, error: String(error) })));
}

/** Refuses a scoped writer a thread outside its share or capture. */
function inScope(source: RuntimeBrowserCommentSource, scope: CommentScope): void {
  if (scope.shareId !== undefined && !(source.kind === 'share' && source.shareId === scope.shareId)) throw new Error('This comment thread is not on this share');
  if (scope.captureId !== undefined && !(source.kind === 'capture' && source.captureId === scope.captureId)) throw new Error('This comment thread is not on this capture');
}

/** A thread's row key: from its index entry, else (a version 1 row, which has none) by scanning the rows. */
async function threadKey(storage: CommentTransaction, threadId: string): Promise<string | undefined> {
  const indexed = z.string().optional().parse(await storage.get(`${COMMENT_INDEX}${threadId}`));
  if (indexed !== undefined) return indexed;
  // LEGACY: version 1 rows (see `LegacyComment`); remove with it.
  for (const key of (await storage.list({ prefix: COMMENT_ROWS })).keys()) if (key.endsWith(`:${threadId}`)) return key;
  return undefined;
}
