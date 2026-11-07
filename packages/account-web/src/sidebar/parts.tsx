import type { WorkspaceStatusColor } from '@gitspace/protocol-workspace';
import { Tooltip } from '@gitspace/ui';
import { ArrowNarrowDown, ArrowNarrowUp, CornerDownRight } from '@untitledui/icons';
import type { ReactNode } from 'react';
import { PHASE_LABEL, PHASES, STATUS_COLOR, StatusDot, type WorkspaceView } from '../GitSpaceShell.js';
import type { LinkedPullRequest } from './project-graph.js';

/** What the focused workspace waits on (violet) and what waits on it (teal); neither is a status colour. */
export const UPSTREAM_TONE = '#a855f7';
export const DOWNSTREAM_TONE = '#14b8a6';

/** A quiet tinted pill with the status dot and its written label. */
export function StatusBadge({ color, label }: { color: WorkspaceStatusColor; label: string }) {
  const tone = STATUS_COLOR[color];
  return <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full pl-2 pr-2.5 text-[11px] font-medium" style={{ background: `color-mix(in oklab, ${tone} 12%, transparent)`, color: `color-mix(in oklab, ${tone} 70%, var(--foreground))`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tone} 25%, transparent)` }}>
    <StatusDot color={color} pulse={color === 'green'} /><span className="truncate">{label}</span>
  </span>;
}

/** `#1336`, or `#1336 · open` in the header: the pull request linked to the workspace, its title on hover. */
export function PrChip({ pr, full = false }: { pr: LinkedPullRequest; full?: boolean }) {
  const chip = <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full px-1.5 font-mono text-[10.5px] tabular-nums text-foreground/80" style={{ boxShadow: 'inset 0 0 0 1px var(--border)' }}>
    #{pr.number}{full ? <span className="max-w-64 truncate font-sans text-muted-foreground">· {pr.title}</span> : null}
  </span>;
  return <Tooltip content={`#${pr.number} ${pr.title}`} side="bottom">{pr.url ? <a href={pr.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0" onClick={event => event.stopPropagation()}>{chip}</a> : chip}</Tooltip>;
}

/** Four pips (plan, code, review, ship) filled up to the phase, then its name. */
export function PhaseTag({ phase, label = true }: { phase: WorkspaceView['phase'] | null; label?: boolean }) {
  const reached = phase === null ? -1 : PHASES.indexOf(phase);
  return <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground" title={phase === null ? 'Phase unknown' : `Phase: ${PHASE_LABEL[phase]}`}>
    <span className="inline-flex gap-[2px]" aria-hidden>{PHASES.map((step, index) => <span key={step} className="h-[5px] w-[3px] rounded-[1px]" style={{ background: index <= reached ? 'var(--foreground)' : 'color-mix(in oklab, var(--foreground) 18%, transparent)', opacity: index <= reached ? 0.55 : 1 }} />)}</span>
    {label && phase !== null ? PHASE_LABEL[phase] : null}
  </span>;
}

function names(values: readonly string[], limit: number): string {
  const shown = values.slice(0, limit).join(', ');
  return values.length > limit ? `${shown} +${values.length - limit}` : shown;
}

/** "↑ waits on X, Y" and "↓ blocks Z", one or both; a stack parent is told by the nesting and its caption instead. */
export function DependencyText({ waitsOn, blocks }: { waitsOn: readonly string[]; blocks: readonly string[] }) {
  if (!waitsOn.length && !blocks.length) return null;
  return <span className="flex min-w-0 items-center gap-1.5 truncate">
    {waitsOn.length ? <span className="inline-flex min-w-0 items-center gap-0.5 truncate" style={{ color: `color-mix(in oklab, ${UPSTREAM_TONE} 75%, var(--muted-foreground))` }}><ArrowNarrowUp width={11} height={11} strokeWidth={2} className="shrink-0" /><span className="truncate">waits on {names(waitsOn, waitsOn.length > 1 && blocks.length ? 1 : 2)}</span></span> : null}
    {blocks.length ? <span className="inline-flex min-w-0 shrink-0 items-center gap-0.5" style={{ color: `color-mix(in oklab, ${DOWNSTREAM_TONE} 75%, var(--muted-foreground))` }}><ArrowNarrowDown width={11} height={11} strokeWidth={2} className="shrink-0" />blocks {waitsOn.length ? blocks.length : names(blocks, 1)}</span> : null}
  </span>;
}

/** "↳ on health-in-chat": the workspace a stacked row builds on and merges after. */
export function StackCaption({ parent }: { parent: string }) {
  return <span className="inline-flex min-w-0 shrink items-center gap-0.5" title={`Stacked on ${parent}: it merges after it`}><CornerDownRight width={11} height={11} strokeWidth={1.75} className="shrink-0" /><span className="truncate">on {parent}</span></span>;
}

/** A group heading inside a project: its label, its count and a rule. */
export function GroupHeading({ children, count, tone }: { children: ReactNode; count: number; tone?: string }) {
  return <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
    {tone ? <span className="size-1.5 rounded-full" style={{ background: tone }} /> : null}
    <span>{children}</span>
    <span className="tabular-nums text-muted-foreground/70">{count}</span>
    <span className="h-px flex-1 bg-border" />
  </div>;
}
