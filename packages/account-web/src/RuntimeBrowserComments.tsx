import { browserCommentPageKey, type RuntimeBrowserComment, type RuntimeBrowserCommentThread, type RuntimeBrowserCommentThreadView, type RuntimeBrowserOverview, type RuntimeBrowserShare } from '@gitspace/protocol-runtime';
import { Badge, Button, TabsSubtle, TabsSubtleItem } from '@gitspace/ui';
import type { BrowserWatchTarget } from './BrowserWatchDialog.js';
import { COMMENT_PURPLE, commentAge, commentAnchorLabel, commentAuthorName, numberThreads, useThreadReply } from './comment-threads.js';
import type { ThreadActions } from './comment-threads.js';

/** Which threads the Browser tab lists: unresolved ones, or resolved ones. */
export type CommentFilter = 'open' | 'resolved';
const FILTERS: readonly CommentFilter[] = ['open', 'resolved'];
const FILTER_LABEL: Record<CommentFilter, string> = { open: 'Open', resolved: 'Resolved' };
const SOURCE_LABEL: Record<RuntimeBrowserComment['source']['kind'], string> = { share: 'from a share link', chrome: 'in Chrome', capture: 'in a capture' };

/** Where Show on page shows a thread: your Chrome's tab, which its extension brings forward in comment mode with the
 * thread open; or the Watch dialog on a tab of your Chrome's group (a share's) or of the cloud browser, the thread's
 * pin highlighted on its live frame. */
export type CommentShowTarget =
  | { kind: 'chrome'; groupId: string; targetId: string; browser: string }
  | { kind: 'watch'; target: BrowserWatchTarget; focusInChrome: boolean; takeover: boolean };

/** Where a thread can be shown on its page now, or null: a thread made in Chrome on its Chrome's tab of that page while
 * the Chrome is online; one made on a share in the Watch dialog on the shared tab while it is in the workspace's group;
 * otherwise in the Watch dialog on a cloud browser tab of that page. Threads on a capture are shown by its player. */
export function commentShowTarget(root: RuntimeBrowserComment, overview: RuntimeBrowserOverview | null, shares: readonly RuntimeBrowserShare[] | null): CommentShowTarget | null {
  if (!overview || !root.anchor) return null;
  const key = browserCommentPageKey(root.page.url);
  const onPage = (tab: { url: string }) => browserCommentPageKey(tab.url) === key;
  const { source } = root;
  if (source.kind === 'capture') return null;
  if (source.kind === 'chrome') {
    const chrome = overview.chromes.find(item => item.pairingId === source.pairingId && item.approved && item.connected);
    const tab = chrome?.tabs.find(onPage);
    return chrome?.groupId && tab ? { kind: 'chrome', groupId: chrome.groupId, targetId: tab.targetId, browser: chrome.name } : null;
  }
  const share = shares?.find(item => item.shareId === source.shareId);
  const chrome = share ? overview.chromes.find(item => item.pairingId === share.pairingId && item.approved) : undefined;
  const shared = chrome?.tabs.find(tab => tab.targetId === share?.targetId && onPage(tab));
  if (chrome?.groupId && shared) {
    return { kind: 'watch', target: { source: 'chrome', groupId: chrome.groupId, targetId: shared.targetId, title: shared.title, url: shared.url, label: `${chrome.name} · ${chrome.groupName ?? 'this workspace’s'} group` }, focusInChrome: chrome.connected, takeover: chrome.takeover };
  }
  const cloud = overview.cloud.groupId ? overview.cloud.tabs.find(onPage) : undefined;
  return overview.cloud.groupId && cloud ? { kind: 'watch', target: { source: 'cloud', groupId: overview.cloud.groupId, targetId: cloud.targetId, title: cloud.title, url: cloud.url, label: 'Cloud browser' }, focusInChrome: false, takeover: true } : null;
}

export interface BrowserCommentsProps {
  /** Null until first read. */
  threads: readonly RuntimeBrowserCommentThreadView[] | null;
  error: string | null;
  filter: CommentFilter;
  onFilter(filter: CommentFilter): void;
  actions: ThreadActions;
  /** Where Show on page would show a thread now, if anywhere. */
  showTarget(root: RuntimeBrowserComment): CommentShowTarget | null;
  /** Show on page; `n` is the thread's number, which its pin shows. */
  onShow(thread: RuntimeBrowserCommentThread, n: number, target: CommentShowTarget): void;
  /** The Browser tab's action in progress, if any (`show:<threadId>` for Show on page). */
  pending: string | null;
}

/** The workspace's comment threads, open or resolved, newest first: each with where it points (its crop), the page, who
 * said what, Reply, Resolve or Reopen, and Show on page. Threads start on pages, not here. */
export function BrowserComments({ threads, error, filter, onFilter, actions, showTarget, onShow, pending }: BrowserCommentsProps) {
  const listed = threads?.filter(view => filter === 'open' ? view.thread.root.resolved === null : view.thread.root.resolved !== null) ?? null;
  const numbers = new Map(numberThreads(listed?.map(view => view.thread) ?? []).map(({ thread, n }) => [thread.root.id, n]));
  const now = Date.now();
  return <section aria-label="Page comments" className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-body font-medium">Page comments</h3>
      <TabsSubtle size="compact" selectedIndex={FILTERS.indexOf(filter)} onSelect={index => onFilter(FILTERS[index] ?? 'open')} idPrefix="page-comments" aria-label="Which comments">
        {FILTERS.map((item, index) => <TabsSubtleItem key={item} index={index} label={listed && item === filter ? `${FILTER_LABEL[item]} · ${listed.length}` : FILTER_LABEL[item]} />)}
      </TabsSubtle>
    </div>
    {error ? <p role="alert" className="text-caption text-destructive">{error}{threads ? ' Showing the last comments read.' : ''}</p> : null}
    {listed === null ? (error ? null : <p role="status" className="text-caption text-muted-foreground">Loading comments…</p>)
      : listed.length === 0 ? <p className="text-caption text-muted-foreground">{filter === 'open' ? 'No open comments. People comment on pages from a share link with comments or from the comment tool in your Chrome; agents read and answer them with web_browser.' : 'No resolved comments.'}</p>
        : <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface-1 text-caption">{listed.map(view => {
          const n = numbers.get(view.thread.root.id) ?? 0;
          return <CommentThreadRow key={view.thread.root.id} view={view} n={n} now={now} actions={actions} target={showTarget(view.thread.root)} pending={pending} onShow={target => onShow(view.thread, n, target)} />;
        })}</ul>}
  </section>;
}

function CommentThreadRow({ view: { thread, cropUrl }, n, now, actions, target, pending, onShow }: { view: RuntimeBrowserCommentThreadView; n: number; now: number; actions: ThreadActions; target: CommentShowTarget | null; pending: string | null; onShow(target: CommentShowTarget): void }) {
  const { root, replies } = thread;
  const draft = useThreadReply(root.id, actions);
  const name = commentAuthorName(root.by);
  return <li aria-label={`Thread by ${name}`} className="flex min-w-0 gap-3 p-2.5">
    {cropUrl ? <img className="aspect-[16/10] w-24 shrink-0 rounded-md border border-border bg-surface-2 object-contain" src={cropUrl} alt={`Where ${name} commented`} /> : null}
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <p className="flex flex-wrap items-center gap-2">
        <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full rounded-bl-none text-[10px] font-bold text-white" style={{ background: root.resolved ? '#525252' : COMMENT_PURPLE }}>{n}</span>
        <span className="font-medium">{name}</span>
        {root.by.kind === 'person' && root.by.guest ? <Badge size="compact" color="gray">guest</Badge> : root.by.kind === 'agent' ? <Badge size="compact" color="blue">agent</Badge> : null}
        <time className="tabular-nums text-muted-foreground" dateTime={root.createdAt} title={new Date(root.createdAt).toLocaleString()}>{commentAge(root.createdAt, now)}</time>
        {root.resolved ? <Badge size="compact" color="green">Resolved by {root.resolved.by}</Badge> : null}
      </p>
      <p className="whitespace-pre-wrap break-words text-body">{root.text}</p>
      <p className="flex min-w-0 flex-wrap gap-x-1 text-muted-foreground">
        <span>On {commentAnchorLabel(root.anchor)} · {SOURCE_LABEL[root.source.kind]} ·</span>
        <a className="min-w-0 truncate underline" href={root.page.url} target="_blank" rel="noreferrer" title={root.page.url}>{root.page.title || root.page.url}</a>
      </p>
      {replies.length ? <ol aria-label="Replies" className="flex flex-col gap-1.5 border-l-2 border-border pl-2.5">{replies.map(reply => <li key={reply.id} className="flex flex-col">
        <span><span className="font-medium">{commentAuthorName(reply.by)}</span>{reply.by.kind === 'person' && reply.by.guest ? ' (guest)' : reply.by.kind === 'agent' ? ' · agent' : ''} <time className="tabular-nums text-muted-foreground" dateTime={reply.createdAt}>· {commentAge(reply.createdAt, now)}</time></span>
        <span className="whitespace-pre-wrap break-words text-body">{reply.text}</span>
      </li>)}</ol> : null}
      <form aria-label={`Reply to ${name}`} className="flex min-w-0 items-center gap-2" onSubmit={event => { event.preventDefault(); draft.send(); }}>
        <input aria-label="Your reply" value={draft.text} maxLength={4000} placeholder="Reply…" disabled={draft.busy === 'reply'} onChange={event => draft.setText(event.currentTarget.value)} className="min-h-8 min-w-0 flex-1 rounded-md bg-surface-3 px-2 text-caption" />
        <Button type="submit" variant="secondary" size="compact" disabled={!draft.text.trim() || draft.busy !== null} loading={draft.busy === 'reply'}>Reply</Button>
      </form>
      {draft.error ? <p role="alert" className="text-destructive">{draft.error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="compact" disabled={draft.busy !== null} loading={draft.busy === 'resolve'} onClick={() => draft.resolve(root.resolved !== null)}>{root.resolved ? 'Reopen' : 'Resolve'}</Button>
        {target ? <Button variant="ghost" size="compact" disabled={pending !== null} loading={pending === `show:${root.id}`} title={target.kind === 'chrome' ? `Opens the tab in ${target.browser} with comment mode on` : `Watch ${target.target.label} with this comment’s pin`} onClick={() => onShow(target)}>Show on page</Button> : null}
      </div>
    </div>
  </li>;
}
