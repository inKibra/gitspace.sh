import type { ReactNode } from 'react';
import { Button, useShape } from '@gitspace/ui';
import { StatusDot } from '../GitSpaceShell.js';
import type { WorkspaceMachine } from '../workspace-status.js';

/** One attached machine: its status, then its setup results and its sync state, each on its own line. */
export function CacheMachineRow({ machine, name, pending, blockers, runs, onDetach, onOpenLog }: {
  machine: WorkspaceMachine; name: string; pending: boolean; blockers?: ReactNode; runs?: ReactNode;
  onDetach(): void; onOpenLog?(runId: string): void;
}) {
  const shape = useShape();
  const { setup, sync } = machine.status;
  return <section aria-label={`Machine ${name}`} className={`${shape.container} flex flex-col gap-3 bg-surface-2 p-4 shadow-surface-1`}>
    <header className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-body font-medium">{name}</h3><p className="text-caption text-muted-foreground">{machine.attachment.cache?.platform ?? 'OS not reported'}</p></div><span role="status" className="flex items-center gap-2 text-caption"><StatusDot color={machine.color} />{machine.label}</span></header>
    <div aria-label="Machine setup" className="flex flex-col gap-1 text-caption">
      <h4 className="font-medium text-muted-foreground">Setup</h4>
      {setup.length ? <ul aria-label="Machine setup results" className="flex flex-col gap-1">{setup.map(step => <li key={step.phase} className="flex flex-wrap items-center justify-between gap-2">
        <span className={step.state === 'failed' ? 'break-words text-destructive' : undefined}>{step.phase} · {step.state === 'waiting-for-approval' ? 'waiting for approval' : step.state}{step.error ? ` · ${step.error}` : ''}</span>
        {step.runId && onOpenLog ? <Button variant="ghost" size="compact" className="min-h-10" onClick={() => onOpenLog(step.runId!)}>View log</Button> : null}
      </li>)}</ul> : <p className="text-muted-foreground">Not run yet</p>}
    </div>
    <div aria-label="Machine sync" className="flex flex-col gap-1 text-caption tabular-nums">
      <p className="text-muted-foreground">Last sync · {sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString() : 'not yet'}{sync.unsent ? ` · ${sync.unsent} unsent ${sync.unsent === 1 ? 'change' : 'changes'}` : ''}{sync.unapplied ? ' · cloud changes not yet on this machine' : ''}</p>
      {sync.problem ? <p className="break-words text-warning">Sync problem · {sync.problem}</p> : null}
      {sync.conflicts.length ? <ul aria-label="Sync conflicts" className="list-inside list-disc break-all font-mono text-destructive">{sync.conflicts.map(path => <li key={path}>{path}</li>)}</ul> : null}
    </div>
    {blockers}{runs}
    <footer className="flex flex-wrap gap-1">
      <Button variant="ghost" size="compact" className="min-h-10" disabled={pending} onClick={onDetach}>Detach</Button>
    </footer>
  </section>;
}
