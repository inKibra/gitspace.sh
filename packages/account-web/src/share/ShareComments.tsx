import { Badge } from '@gitspace/ui';
import type { RuntimeBrowserPageComment } from '@gitspace/protocol-runtime';

/** The share's comments, newest first: who, what they said, and what they pointed at. */
export function ShareComments({ comments }: { comments: RuntimeBrowserPageComment[] }) {
  return <section aria-label="Comments" className="flex flex-col gap-2">
    <h2 className="text-caption font-medium text-muted-foreground">Comments</h2>
    {comments.length === 0
      ? <p className="text-caption text-muted-foreground">No comments yet. Turn on Comment, then click what you want to talk about, or drag over an area.</p>
      : <ol className="flex flex-col gap-2">
        {comments.toReversed().map(comment => <li key={comment.commentId} className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2">
          <div className="flex items-center gap-2 text-caption">
            <span className="truncate font-medium text-foreground">{comment.by.name}</span>
            {comment.by.guest ? <Badge size="compact" color="gray">guest</Badge> : null}
            <time dateTime={comment.createdAt} className="ml-auto shrink-0 text-muted-foreground tabular-nums">{new Date(comment.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
          </div>
          <p className="whitespace-pre-wrap break-words text-body text-foreground">{comment.text}</p>
          <span className="truncate text-caption text-muted-foreground">
            {comment.target ? `On ${comment.target.role || 'element'}${comment.target.name ? ` “${comment.target.name}”` : ''}` : 'On an area of the page'}
          </span>
        </li>)}
      </ol>}
  </section>;
}
