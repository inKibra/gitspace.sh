import { Badge } from '@gitspace/ui';
import type { RuntimeBrowserCommentThread } from '@gitspace/protocol-runtime';
import { COMMENT_PURPLE, commentAnchorLabel, commentAuthorName } from '../comment-threads.js';

/** The share's threads, newest first, each with its pin's number: who started it, what they said, what they pointed
 * at and how many replies it has. Choosing one opens it over the page. */
export function ShareComments({ threads, open, onOpen }: { threads: readonly { thread: RuntimeBrowserCommentThread; n: number }[]; open: string | null; onOpen(threadId: string): void }) {
  return <section aria-label="Comments" className="flex flex-col gap-3">
    <h2 className="text-body font-semibold text-foreground">Comments{threads.length > 0 ? <span className="font-normal text-muted-foreground"> · {threads.length}</span> : null}</h2>
    {threads.length === 0
      ? <p className="text-caption text-muted-foreground">No comments yet. Turn on Comment, then click what you want to talk about, or drag over an area.</p>
      : <ol className="flex flex-col gap-1">
        {threads.toReversed().map(({ thread: { root, replies }, n }) => <li key={root.id}>
          <button type="button" aria-label={`Comment ${n} by ${commentAuthorName(root.by)}`} aria-pressed={open === root.id} onClick={() => onOpen(root.id)}
            className={`flex w-full gap-2 rounded-lg p-2 text-left text-caption ${open === root.id ? 'bg-surface-3' : 'hover:bg-hover'}`}>
            <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full rounded-bl-none text-[10px] font-bold text-white" style={{ background: root.resolved ? '#525252' : COMMENT_PURPLE }}>{n}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="whitespace-pre-wrap break-words text-body text-foreground">{root.text}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="truncate">{commentAuthorName(root.by)}</span>
                {root.by.kind === 'person' && root.by.guest ? <Badge size="compact" color="gray">guest</Badge> : null}
                <time dateTime={root.createdAt} className="tabular-nums">{new Date(root.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
                {replies.length ? <span>· {replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span> : null}
                {root.resolved ? <span>· resolved</span> : null}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">On {commentAnchorLabel(root.anchor)}</span>
            </span>
          </button>
        </li>)}
      </ol>}
  </section>;
}
