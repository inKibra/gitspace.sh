import type { ReactNode } from 'react';
import type { RuntimeSnapshot } from '@gitspace/protocol-runtime';
import type { RuntimeCacheActionInput } from '@gitspace/protocol-runtime/attachment-controls';
import { Badge, Button, useShape } from '@gitspace/ui';
import { StatusDot } from '../GitSpaceShell.js';
import { cachePresentation } from './cache-presentation.js';

type Attachment = RuntimeSnapshot['attachments'][number];
export function CacheMachineRow({ attachment, name, isDefault, pending, now, blockers, runs, onAction, onDefault, onDetach, onOpenLog }: {
  attachment: Attachment; name: string; isDefault: boolean; pending: boolean; now: number; blockers?: ReactNode; runs?: ReactNode;
  onAction(action: RuntimeCacheActionInput['action']): void; onDefault(): void; onDetach(): void; onOpenLog?(runId: string): void;
}) {
  const shape = useShape();
  const cache = attachment.cache;
  const status = cachePresentation(attachment, now);
  const reclaimMinutes = cache?.reclaimAt ? Math.max(0, Math.ceil((Date.parse(cache.reclaimAt) - now) / 60_000)) : null;
  return <section aria-label={`Machine ${name}`} className={`${shape.container} flex flex-col gap-3 bg-surface-2 p-4 shadow-surface-1`}>
    <header className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-body font-medium">{name}</h3><p className="text-caption text-muted-foreground">{cache?.platform ?? 'OS not reported'}</p></div><span className="flex items-center gap-2 text-caption"><StatusDot color={status.color} />{status.label}{isDefault ? <Badge>Default</Badge> : null}</span></header>
    {!status.ready ? <p className="text-caption text-muted-foreground">{status.label === 'Paused' ? 'The next command automatically resumes this cache and catches up with cloud files before running.' : status.label === 'Reclaimed' ? 'The next command rebuilds this local cache and catches up with cloud files before running.' : `Commands cannot run here: ${status.label === 'Offline' ? 'the machine heartbeat is unavailable.' : status.label === 'Draining' ? 'the cache is publishing changes before removal.' : status.label === 'Waiting approval' ? 'setup requires approval below.' : status.label === 'Setup failed' ? 'setup failed; inspect its logs before trying again.' : 'machine preparation has not completed.'}`}</p> : null}
    {cache ? <>
      {cache.state === 'live' ? <p className="text-caption">Live · {cache.activity.length ? cache.activity.map(item => `${item.reason}: ${item.name}`).join(' · ') : 'No activity reported'}</p> : null}
      {cache.pausedAt ? <p className="text-caption tabular-nums">Paused since {new Date(cache.pausedAt).toLocaleString()}</p> : null}
      {cache.state === 'reclaimed' ? <p className="text-caption text-muted-foreground">Local cache reclaimed. Cloud files and conversations remain available.</p> : null}
      <p className="text-caption text-muted-foreground tabular-nums">Last sync · {cache.lastSyncAt ? new Date(cache.lastSyncAt).toLocaleString() : 'Not yet synchronized'}</p>
      {cache.reclaimBlocked ? <p role="alert" className="text-caption text-warning">Reclamation blocked · {cache.reclaimBlocked}</p> : null}
      {reclaimMinutes !== null && cache.state === 'paused' ? <p className="text-caption text-muted-foreground tabular-nums">{reclaimMinutes > 0 ? `Reclaim in ${reclaimMinutes} minutes` : 'Reclamation due'} · only after safe publication</p> : null}
      <ul className="flex flex-col gap-1 text-caption" aria-label="Machine setup progress">{cache.setup.map(step => <li key={step.phase} className="flex flex-col gap-1"><span className="flex flex-wrap items-center justify-between gap-2"><span>{step.phase} · {step.state === 'waiting-for-approval' ? 'Waiting approval' : step.state}</span>{step.runId && onOpenLog ? <Button variant="ghost" size="compact" className="min-h-10" onClick={() => onOpenLog(step.runId!)}>View {step.phase} log</Button> : null}</span>{step.error ? <span role="status" className="break-words text-destructive">{step.error}</span> : null}</li>)}</ul>
      {cache.activity.some(item => ['command', 'service', 'watcher', 'proc', 'terminal'].includes(item.reason)) ? <div><h4 className="text-caption font-medium">Running processes & services</h4><ul className="text-caption text-muted-foreground">{cache.activity.filter(item => ['command', 'service', 'watcher', 'proc', 'terminal'].includes(item.reason)).map((item, index) => <li key={`${item.reason}:${item.name}:${index}`}>{item.reason} · {item.name}</li>)}</ul></div> : null}
      <label className="flex min-h-10 items-center gap-2 text-caption"><input type="checkbox" aria-label={`Work locally on ${name}`} checked={cache.localWorkOptIn} disabled={pending || attachment.state === 'draining'} onChange={event => onAction({ kind: 'local-work', enabled: event.target.checked })} />Work locally · keep this cache live while using local tools</label>
    </> : <p className="text-caption text-muted-foreground">{attachment.role} · {attachment.state}</p>}
    {attachment.cacheAction ? <p role="status" className="text-caption">{attachment.cacheAction.action} · {attachment.cacheAction.status}{attachment.cacheAction.error ? ` · ${attachment.cacheAction.error}` : ''}</p> : null}
    {attachment.failure ? <p role="status" className="break-words text-caption text-destructive">{attachment.failure.operation} failed · {attachment.failure.message} · {attachment.failure.attempts} {attachment.failure.attempts === 1 ? 'attempt' : 'attempts'}{attachment.failure.nextRetryAt ? ` · retrying at ${new Date(attachment.failure.nextRetryAt).toLocaleString()}` : ''}</p> : null}
    {blockers}{runs}
    <footer className="flex flex-wrap gap-1">
      {attachment.role === 'cache' ? <><Button variant="ghost" size="compact" className="min-h-10" disabled={pending || isDefault || !status.ready} onClick={onDefault}>Make default</Button><Button variant="secondary" size="compact" className="min-h-10" disabled={pending || attachment.state === 'draining'} onClick={() => onAction({ kind: 'setup' })}>Setup again</Button><Button variant="ghost" size="compact" className="min-h-10" disabled={pending || cache?.state === 'reclaimed' || attachment.state === 'draining'} onClick={() => onAction({ kind: 'reclaim' })}>Reclaim now</Button></> : null}
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
