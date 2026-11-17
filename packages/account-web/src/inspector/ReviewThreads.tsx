// Review threads, retired (docs/BLOCK-DOCUMENTS-DESIGN.md §4): threads written before comments replaced them stay
// readable on their old anchors (a file's lines, a plan step), read-only. New comments go through the comment layer.
import { Badge, Button, Elevated, ScrollArea, useShape } from '@gitspace/ui';
import type { ReviewThreadView } from '@gitspace/protocol';
import { XClose } from '@untitledui/icons';
import type { ReactElement } from 'react';
import { formatDate } from './inspector-shared.js';

const DECISION_LABEL: Record<ReviewThreadView['decision'], string> = { pending: 'Pending', approved: 'Approved', 'changes-requested': 'Changes requested' };

/** A thread's messages, oldest first. */
function Messages({ thread }: { thread: ReviewThreadView }): ReactElement {
  const shape = useShape();
  return <>{thread.messages.map((message) => <article className="flex gap-2" key={message.id}>
    <span className={`${shape.bg} grid size-7 shrink-0 place-items-center bg-muted text-caption font-medium text-muted-foreground`} aria-hidden>{message.authorId.split(/[^A-Za-z0-9]+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'}</span>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5"><header className="flex items-baseline justify-between gap-2"><strong className="text-body font-medium text-foreground">{message.authorId}</strong><time className="text-caption text-muted-foreground tabular-nums">{formatDate(message.createdAt)}</time></header><p className="whitespace-pre-wrap text-body text-muted-foreground">{message.body}</p></div>
  </article>)}</>;
}

/** One older review thread under the file it is on, read-only: its anchor, decision, state and messages. */
export function ThreadPanel({ thread, onClose }: { thread: ReviewThreadView; onClose: () => void }) {
  const title = thread.anchor.kind === 'line' ? `${thread.anchor.path} · lines ${thread.anchor.startLine}–${thread.anchor.endLine}` : thread.anchor.kind;
  return <Elevated offset={1} className="flex max-h-[50%] shrink-0 flex-col border-t border-border" aria-label="Review thread">
    <header className="flex items-center gap-2 px-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col"><strong className="text-body font-medium text-foreground">Review thread · read-only</strong><span className="truncate text-caption text-muted-foreground tabular-nums">{title}</span></span>
      <Badge variant="dot" size="compact" color={thread.resolved ? 'green' : 'gray'}>{thread.resolved ? 'Resolved' : DECISION_LABEL[thread.decision]}</Badge>
      <Button variant="ghost" size="icon-compact" type="button" aria-label="Close review thread" onClick={onClose}><XClose width={16} height={16} strokeWidth={1.5} /></Button>
    </header>
    {thread.anchorState === 'stale' ? <p className="flex flex-wrap items-center gap-2 px-3 pb-2 text-caption text-muted-foreground"><Badge variant="dot" color="amber">Stale anchor</Badge>{thread.staleReason ?? 'The repository identity changed after this thread was created.'}</p> : null}
    <ScrollArea className="min-h-0 flex-1"><div className="flex flex-col gap-3 px-3 pb-3"><Messages thread={thread} /></div></ScrollArea>
    <p className="border-t border-border px-3 py-2 text-caption text-muted-foreground">Review threads are retired. Comment on the change in the Change Guide; your comments go to the agent with your next message.</p>
  </Elevated>;
}

/** Older review threads on a plan step, read-only. */
export function StepThreads({ threads }: { threads: readonly ReviewThreadView[] }): ReactElement | null {
  const shape = useShape();
  if (!threads.length) return null;
  return <div className="flex flex-col gap-2">{threads.map((thread) => <section key={thread.id} aria-label="Earlier step comment" className={`${shape.container} flex flex-col gap-2 border border-border bg-surface-2 p-3`}>
    <Messages thread={thread} />
    {thread.resolved ? <Badge variant="dot" size="compact" color="green">Resolved</Badge> : null}
  </section>)}</div>;
}
