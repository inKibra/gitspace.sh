import type { ReactNode } from 'react';
import type { RuntimeSnapshot } from '@gitspace/protocol-runtime';
import type { RuntimeCacheActionInput } from '@gitspace/protocol-runtime/attachment-controls';
import { Button, useShape } from '@gitspace/ui';
import { StatusDot } from '../GitSpaceShell.js';
import { cachePresentation } from './cache-presentation.js';

type Attachment = RuntimeSnapshot['attachments'][number];
/** One attached machine: its status, then its setup results and its sync state, each on its own line. */
export function CacheMachineRow({ attachment, name, pending, now, blockers, runs, onAction, onDetach, onOpenLog }: {
  attachment: Attachment; name: string; pending: boolean; now: number; blockers?: ReactNode; runs?: ReactNode;
  onAction(action: RuntimeCacheActionInput['action']): void; onDetach(): void; onOpenLog?(runId: string): void;
}) {
  const shape = useShape();
  const cache = attachment.cache;
  const status = cachePresentation(attachment, now);
  const setupAction = attachment.cacheAction?.action === 'setup' ? attachment.cacheAction : null;
  return <section aria-label={`Machine ${name}`} className={`${shape.container} flex flex-col gap-3 bg-surface-2 p-4 shadow-surface-1`}>
    <header className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-body font-medium">{name}</h3><p className="text-caption text-muted-foreground">{cache?.platform ?? 'OS not reported'}</p></div><span role="status" className="flex items-center gap-2 text-caption"><StatusDot color={status.color} />{status.label}</span></header>
    {cache ? <div aria-label="Machine setup" className="flex flex-col gap-1 text-caption">
      <h4 className="font-medium text-muted-foreground">Setup{setupAction && ['requested', 'running'].includes(setupAction.status) ? ' · running' : ''}</h4>
      {cache.setup.length ? <ul className="flex flex-col gap-1">{cache.setup.map(step => <li key={step.phase} className="flex flex-wrap items-center justify-between gap-2">
        <span className={step.state === 'failed' ? 'break-words text-destructive' : undefined}>{step.phase} · {step.state === 'waiting-for-approval' ? 'waiting for approval' : step.state}{step.error ? ` · ${step.error}` : ''}</span>
        {step.runId && onOpenLog ? <Button variant="ghost" size="compact" className="min-h-10" onClick={() => onOpenLog(step.runId!)}>View log</Button> : null}
      </li>)}</ul> : <p className="text-muted-foreground">Not run yet</p>}
      {setupAction?.status === 'failed' && setupAction.error ? <p className="break-words text-destructive">{setupAction.error}</p> : null}
    </div> : null}
    {cache ? <div aria-label="Machine sync" className="flex flex-col gap-1 text-caption tabular-nums">
      <p className="text-muted-foreground">Last sync · {cache.lastSyncAt ? new Date(cache.lastSyncAt).toLocaleString() : 'not yet'}</p>
      {attachment.failure ? <p className="break-words text-warning">Sync problem · {attachment.failure.message}</p> : null}
    </div> : null}
    {blockers}{runs}
    <footer className="flex flex-wrap gap-1">
      {attachment.role === 'cache' ? <Button variant="secondary" size="compact" className="min-h-10" disabled={pending || attachment.state === 'draining'} onClick={() => onAction({ kind: 'setup' })}>Run setup</Button> : null}
      <Button variant="ghost" size="compact" className="min-h-10" disabled={pending || attachment.state === 'draining'} onClick={onDetach}>{attachment.state === 'draining' ? 'Detaching…' : 'Detach'}</Button>
    </footer>
  </section>;
}

const LOSS_REASON: Record<NonNullable<Attachment['lossReason']>, string> = {
  deadline: 'lease expired',
  'machine-destroyed': 'machine destroyed',
  'machine-revoked': 'machine revoked',
  operator: 'released by operator',
};

/** Lost attachments are terminal history: listed compactly, collapsed, and never actionable. */
export function ReleasedMachineList({ attachments, label }: { attachments: readonly Attachment[]; label(machineId: string): string }) {
  if (!attachments.length) return null;
  return <details className="text-caption">
    <summary className="min-h-10 cursor-pointer text-muted-foreground">Released machines · {attachments.length}</summary>
    <ul aria-label="Released machines" className="flex flex-col gap-1 pt-1">{attachments.map(attachment => <li key={attachment.attachmentId} className="flex flex-wrap items-center justify-between gap-2 tabular-nums"><span>{label(attachment.machineId)}</span><span className="text-muted-foreground">Lost{attachment.lossReason ? ` — ${LOSS_REASON[attachment.lossReason]}` : ''} · {new Date(attachment.updatedAt).toLocaleString()}</span></li>)}</ul>
  </details>;
}
