import type { InspectorView } from '@gitspace/protocol';
import { Badge, Button, ThinkingIndicator, useShape } from '@gitspace/ui';
import { RefreshCcw01, Trash01 } from '@untitledui/icons';
import { useRef, useState } from 'react';
import type { WorkspaceCreationState } from './GitSpaceShell.js';
import { glyph } from './glyph.js';
import { rpcErrorMessage } from './rpc-error-message.js';

type CreationOperation = NonNullable<InspectorView['creation']>;

const STEP_STATE: Record<CreationOperation['state'], { label: string; color: 'gray' | 'amber' | 'green' | 'red' }> = {
  queued: { label: 'Waiting', color: 'gray' },
  claimed: { label: 'Starting', color: 'amber' },
  running: { label: 'Running', color: 'amber' },
  blocked: { label: 'Blocked', color: 'amber' },
  failed: { label: 'Failed', color: 'red' },
  succeeded: { label: 'Done', color: 'green' },
  canceled: { label: 'Canceled', color: 'gray' },
};

export interface WorkspaceCreationPanelProps {
  name: string;
  state: WorkspaceCreationState;
  creation: InspectorView['creation'];
  /** Resumes creation at its first incomplete step; rejects with the reason it could not. */
  onRetry(): Promise<void>;
  /** Permanently deletes the workspace; the panel confirms first. */
  onDelete(): Promise<void>;
}

/** A worktree that is still being created or whose creation failed: it has nothing to open, only Retry or Delete. */
export function WorkspaceCreationPanel({ name, state, creation, onRetry, onDelete }: WorkspaceCreationPanelProps) {
  const shape = useShape();
  const [pending, setPending] = useState<'retry' | 'delete' | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: 'retry' | 'delete', operation: () => Promise<void>): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(action);
    setError(null);
    try { await operation(); }
    catch (cause) { setError(rpcErrorMessage(cause, action === 'retry' ? 'Retry workspace creation' : 'Delete workspace')); }
    finally { pendingRef.current = false; setPending(null); }
  };
  const failed = state === 'failed';
  const reason = creation?.error ?? creation?.steps.find((step) => step.state === 'failed')?.message ?? 'Creation did not finish.';
  return <section aria-label={failed ? 'Workspace creation failed' : 'Creating workspace'} className={`${shape.container} flex w-full min-w-0 max-w-xl flex-col gap-3 bg-surface-2 p-6 shadow-surface-1 [overflow-wrap:anywhere]`}>
    <div className="flex items-center gap-2">
      {failed ? null : <ThinkingIndicator size="compact" className="shrink-0 p-0 [&>span[aria-hidden]]:hidden" />}
      <h1 className="text-title font-semibold text-foreground">{failed ? 'Workspace creation failed' : 'Creating workspace…'}</h1>
    </div>
    <p role={failed ? undefined : 'status'} className="text-body text-muted-foreground">{failed ? reason : `${name} is being prepared. It opens when every step finishes.`}</p>
    {creation?.steps.length ? <ol aria-label="Creation steps" className="flex flex-col gap-1">
      {creation.steps.map((step) => <li key={step.id} className="flex min-w-0 items-center justify-between gap-3 text-caption text-foreground">
        <span className="min-w-0 truncate">{step.label}</span>
        <Badge variant="dot" size="compact" color={STEP_STATE[step.state].color}>{STEP_STATE[step.state].label}</Badge>
      </li>)}
    </ol> : null}
    {failed ? <div className="flex flex-wrap items-center gap-2 pt-1">
      <Button variant="secondary" size="compact" loading={pending === 'retry'} disabled={pending !== null} onClick={() => void run('retry', onRetry)} leadingIcon={glyph(RefreshCcw01)}>{pending === 'retry' ? 'Retrying…' : 'Retry'}</Button>
      <Button variant="ghost" size="compact" loading={pending === 'delete'} disabled={pending !== null} onClick={() => { if (window.confirm(`Delete ${name}? Its partial checkout and cloud records are removed. This cannot be undone.`)) void run('delete', onDelete); }} leadingIcon={glyph(Trash01)}>{pending === 'delete' ? 'Deleting…' : 'Delete'}</Button>
    </div> : null}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
  </section>;
}
