import { Badge, Button, Elevated, ScrollArea, Select, SelectTrigger, useShape } from '@gitspace/ui';
import type { ReviewThreadView } from '@gitspace/protocol';
import { XClose } from '@untitledui/icons';
import { useRef, useState } from 'react';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { selectOptions, type ThreadSelection, formatDate } from './inspector-shared.js';

function initials(value: string): string { return value.split(/[^A-Za-z0-9]+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'; }
export function ThreadPanel({ thread, selection, onClose, onCreate, onReply, onResolve }: { thread: ReviewThreadView | null; selection: ThreadSelection | null; onClose: () => void; onCreate: (body: string) => Promise<void>; onReply: (body: string) => Promise<void>; onResolve: (resolved: boolean, decision: ReviewThreadView['decision']) => Promise<void> }) {
  const shape = useShape();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const mutate = async (operation: () => Promise<void>, clearDraft = false): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await operation();
      if (clearDraft) setDraft('');
    } catch (cause) {
      setError(rpcErrorMessage(cause, 'Update review thread'));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const title = thread ? thread.anchor.kind === 'line' ? `${thread.anchor.path} · lines ${thread.anchor.startLine}–${thread.anchor.endLine}` : thread.anchor.kind : selection ? `${selection.path} · lines ${selection.startLine}–${selection.endLine}` : 'Review thread';
  const send = (): void => { const body = draft.trim(); if (!body) return; void mutate(() => thread ? onReply(body) : onCreate(body), true); };
  return <Elevated offset={1} className="flex max-h-[50%] shrink-0 flex-col border-t border-border">
    <header className="flex items-center gap-2 px-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col"><strong className="text-body font-medium text-foreground">{thread ? 'Review thread' : 'New review thread'}</strong><span className="truncate text-caption text-muted-foreground tabular-nums">{title}</span></span>
      {thread ? <Button variant="secondary" size="compact" type="button" disabled={pending} onClick={() => void mutate(() => onResolve(!thread.resolved, thread.resolved ? 'pending' : thread.decision))}>{thread.resolved ? 'Reopen' : 'Resolve'}</Button> : null}
      <Button variant="ghost" size="icon-compact" type="button" disabled={pending} aria-label="Close review thread" onClick={onClose}><XClose width={16} height={16} strokeWidth={1.5} /></Button>
    </header>
    {thread?.anchorState === 'stale' ? <p className="flex flex-wrap items-center gap-2 px-3 pb-2 text-caption text-muted-foreground"><Badge variant="dot" color="amber">Stale anchor</Badge>{thread.staleReason ?? 'The repository identity changed after this thread was created.'}</p> : null}
    <ScrollArea className="min-h-0 flex-1"><div className="flex flex-col gap-3 px-3 pb-3">{thread?.messages.map((message) => <article className="flex gap-2" key={message.id}>
      <span className={`${shape.bg} grid size-7 shrink-0 place-items-center bg-muted text-caption font-medium text-muted-foreground`} aria-hidden>{initials(message.authorId)}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5"><header className="flex items-baseline justify-between gap-2"><strong className="text-body font-medium text-foreground">{message.authorId}</strong><time className="text-caption text-muted-foreground tabular-nums">{formatDate(message.createdAt)}</time></header><p className="text-body text-muted-foreground">{message.body}</p></div>
    </article>)}</div></ScrollArea>
    <div className="flex flex-col gap-2 border-t border-border p-3">
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
      {/* FLUID-GAP: multi-line textarea — the registry has no textarea field. */}
      <textarea aria-label={thread ? 'Reply to review thread' : 'Start review thread'} disabled={pending} value={draft} onChange={(event) => setDraft(event.currentTarget.value)} placeholder={thread ? 'Reply with durable review context' : 'Describe the issue on this line'} className={`${shape.input} min-h-20 w-full resize-y border border-border bg-surface-2 p-2 text-body text-foreground`} />
      <footer className="flex items-center justify-between gap-2">
        {thread ? <Select value={thread.decision} disabled={pending} size="compact" onValueChange={(value) => void mutate(() => onResolve(thread.resolved, value as ReviewThreadView['decision']))}><SelectTrigger aria-label="Review decision" />{selectOptions([{ value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'changes-requested', label: 'Changes requested' }])}</Select> : <span />}
        <Button variant="primary" size="compact" type="button" disabled={pending || !draft.trim()} onClick={send}>{pending ? 'Saving…' : thread ? 'Reply' : 'Start thread'}</Button>
      </footer>
    </div>
  </Elevated>;
}
