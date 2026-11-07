import type { WorkspaceReportBlock } from '@gitspace/blocks';
import { badgeColors, useShape } from '@gitspace/ui';
import { ChevronDown, ChevronRight } from '@untitledui/icons';
import { useState, type ReactNode } from 'react';
import { navigateProductUrl, setProductRoute } from '../routes.js';
import type { ItemInteractionProps } from './TranscriptItemView.js';

export const PERMISSION_BADGE: Record<string, 'green' | 'red' | 'amber' | 'gray'> = { pending: 'amber', 'allowed-once': 'green', 'allowed-always': 'green', denied: 'red' };
const REPORT_OUTCOME: Record<WorkspaceReportBlock['outcome'], { label: string; color: keyof typeof badgeColors }> = {
  finished: { label: 'finished', color: 'blue' },
  failed: { label: 'failed', color: 'red' },
  asked: { label: 'asked', color: 'orange' },
  approval: { label: 'needs approval', color: 'orange' },
};

/** A turn a workspace ran for the project agent, in one line: the workspace (a link to it), how the turn came out, and
 * its reply, failure or question folded to one line until clicked. */
export function WorkspaceReportRow({ item, state, onStateChange }: { item: WorkspaceReportBlock } & ItemInteractionProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = state?.open ?? localOpen;
  const outcome = REPORT_OUTCOME[item.outcome];
  const href = `/?project=${encodeURIComponent(item.projectId)}&workspace=${encodeURIComponent(item.workspaceId)}`;
  const Chevron = open ? ChevronDown : ChevronRight;
  return <div className="min-w-0 text-caption text-muted-foreground" data-workspace-report={item.outcome}>
    <div className="flex min-h-6 min-w-0 items-center gap-2">
      <span className="status-dot" style={{ color: badgeColors[outcome.color] }} aria-hidden />
      <a className="shrink-0 font-medium text-foreground underline-offset-4 hover:underline" href={href} onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigateProductUrl(setProductRoute(new URL(href, window.location.href), 'agent'));
      }}>{item.name}</a>
      <span className="shrink-0">{outcome.label}</span>
      {item.excerpt ? <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]"
        aria-expanded={open}
        aria-label={open ? 'Hide details' : undefined}
        onClick={() => { setLocalOpen(!open); onStateChange?.({ open: !open }); }}
      ><Chevron width={14} height={14} strokeWidth={1.5} className="shrink-0" />{open ? null : <span className="min-w-0 truncate">{item.excerpt}</span>}</button> : null}
    </div>
    {open && item.excerpt ? <p className="whitespace-pre-wrap pb-1 pl-4 [overflow-wrap:anywhere]">{item.excerpt}</p> : null}
  </div>;
}

export function Notice({ icon, title, detail, body, badge }: { icon: ReactNode; title: string; detail?: string; body?: string; badge?: ReactNode }) {
  const shape = useShape();
  return <div className={`${shape.container} flex min-w-0 items-start gap-3 bg-surface-3 px-3 py-2.5 shadow-surface-1`}>
    <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]"><span className="block text-body text-foreground">{title}</span>{detail ? <span className="block whitespace-pre-line text-caption text-muted-foreground">{detail}</span> : null}
      {body ? <details className="mt-1 text-caption"><summary className="cursor-pointer text-muted-foreground">Show full message</summary><pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-caption text-muted-foreground">{body}</pre></details> : null}</span>
    {badge}
  </div>;
}
