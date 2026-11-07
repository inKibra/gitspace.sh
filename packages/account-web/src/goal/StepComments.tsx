// Comments on a plan step: review threads anchored { kind: 'plan-step', stepId }, shown under the step with their
// messages, a reply box and Resolve, and a box to start a new one.
import { Badge, Button, useShape } from '@gitspace/ui';
import type { ReviewThreadView } from '@gitspace/protocol';
import { MessageSquare01 } from '@untitledui/icons';
import { useState, type ReactElement } from 'react';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { formatDate } from '../inspector/inspector-shared.js';
import { personLabel } from './Evidence.js';

export interface StepCommentHandlers {
  viewerId: string;
  onComment(stepId: string, body: string): Promise<void>;
  onReply(thread: ReviewThreadView, body: string): Promise<void>;
  onResolve(thread: ReviewThreadView, resolved: boolean): Promise<void>;
}

/** A textarea with a send button; clears once the send succeeds and shows why it failed otherwise. */
function CommentBox({ label, action, onSend, onCancel }: { label: string; action: string; onSend(body: string): Promise<void>; onCancel?(): void }): ReactElement {
  const shape = useShape();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (): Promise<void> => {
    const body = draft.trim();
    if (!body || pending) return;
    setPending(true);
    setError(null);
    try {
      await onSend(body);
      setDraft('');
      onCancel?.();
    } catch (cause) {
      setError(rpcErrorMessage(cause, action));
    } finally {
      setPending(false);
    }
  };
  return <div className="flex flex-col gap-2">
    {/* FLUID-GAP: multi-line textarea — the registry has no textarea field. */}
    <textarea aria-label={label} placeholder={label} rows={2} disabled={pending} value={draft} onChange={event => setDraft(event.currentTarget.value)}
      className={`${shape.input} w-full resize-y border border-border bg-surface-2 px-2.5 py-1.5 text-body text-foreground`} />
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    <div className="flex gap-2">
      <Button variant="primary" size="compact" type="button" disabled={pending || !draft.trim()} onClick={() => void send()}>{pending ? 'Saving…' : action}</Button>
      {onCancel ? <Button variant="ghost" size="compact" type="button" disabled={pending} onClick={onCancel}>Cancel</Button> : null}
    </div>
  </div>;
}

function StepThread({ thread, handlers }: { thread: ReviewThreadView; handlers: StepCommentHandlers }): ReactElement {
  const shape = useShape();
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = (): void => {
    setError(null);
    void handlers.onResolve(thread, !thread.resolved).catch((cause: unknown) => setError(rpcErrorMessage(cause, thread.resolved ? 'Reopen comment' : 'Resolve comment')));
  };
  return <article className={`${shape.container} flex flex-col gap-2 border border-border bg-surface-2 p-3`} aria-label="Step comment">
    {thread.messages.map(message => <div key={message.id} className="flex flex-col gap-0.5">
      <span className="text-caption text-muted-foreground"><span className="text-foreground">{personLabel(message.authorId, handlers.viewerId)}</span> · <time className="tabular-nums">{formatDate(message.createdAt)}</time></span>
      <p className={`whitespace-pre-wrap text-body ${thread.resolved ? 'text-muted-foreground' : 'text-foreground'}`}>{message.body}</p>
    </div>)}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    {replying ? <CommentBox label="Reply to this comment" action="Reply" onSend={body => handlers.onReply(thread, body)} onCancel={() => setReplying(false)} />
      : <div className="flex flex-wrap items-center gap-1">
        {thread.resolved ? <Badge variant="dot" size="compact" color="green">Resolved</Badge> : null}
        <Button variant="ghost" size="compact" type="button" onClick={() => setReplying(true)}>Reply</Button>
        <Button variant="ghost" size="compact" type="button" onClick={resolve}>{thread.resolved ? 'Reopen' : 'Resolve'}</Button>
      </div>}
  </article>;
}

export function StepComments({ stepId, stepNumber, threads, handlers }: { stepId: string; stepNumber: number; threads: readonly ReviewThreadView[]; handlers: StepCommentHandlers }): ReactElement {
  const [composing, setComposing] = useState(false);
  return <div className="flex flex-col gap-2">
    {threads.map(thread => <StepThread key={thread.id} thread={thread} handlers={handlers} />)}
    {composing ? <CommentBox label={`Comment on step ${stepNumber}`} action="Comment" onSend={body => handlers.onComment(stepId, body)} onCancel={() => setComposing(false)} />
      : <Button variant="ghost" size="compact" type="button" className="self-start" onClick={() => setComposing(true)}><MessageSquare01 width={13} height={13} />Comment on this step</Button>}
  </div>;
}
