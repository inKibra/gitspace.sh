import type { WorkspaceStatusColor } from '@gitspace/protocol-workspace';
import { Tooltip, badgeColors } from '@gitspace/ui';
import { ArrowNarrowDown, ArrowNarrowUp, Check, CornerDownRight, XClose } from '@untitledui/icons';
import type { CSSProperties, ReactNode } from 'react';
import { PHASE_LABEL, PHASES, STATUS_COLOR, StatusDot, type WorkspaceView } from '../GitSpaceShell.js';
import type { LinkedPullRequest } from './project-graph.js';
import type { StackPosition } from './StackChain.js';

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

/** A pull request's checks as its chip marks them; none and not yet read are unmarked. */
const CHECKS: Record<NonNullable<LinkedPullRequest['checks']>, { label: string; mark: ReactNode }> = {
  passing: { label: 'checks pass', mark: <Check width={11} height={11} strokeWidth={2.25} style={{ color: badgeColors.green }} aria-label="checks pass" /> },
  failing: { label: 'checks fail', mark: <XClose width={11} height={11} strokeWidth={2.25} style={{ color: badgeColors.red }} aria-label="checks fail" /> },
  pending: { label: 'checks running', mark: <span className="size-1.5 animate-pulse rounded-full" style={{ background: badgeColors.amber }} aria-label="checks running" /> },
  none: { label: 'no checks', mark: null },
};

/** `#42 · open ✓`: a pull request linked to the workspace, its title on hover. Merged is tinted, a draft dashed, a
 * closed one faded; checks show on open and draft ones. `full` (the header) adds the state to an open one and its
 * title. */
export function PrChip({ pr, full = false }: { pr: LinkedPullRequest; full?: boolean }) {
  const live = pr.state === 'open' || pr.state === 'draft';
  const checks = live && pr.checks ? CHECKS[pr.checks] : null;
  const style: CSSProperties = pr.state === 'merged'
    ? { color: badgeColors.violet, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${badgeColors.violet} 35%, transparent)` }
    : pr.state === 'draft' ? {} : { boxShadow: 'inset 0 0 0 1px var(--border)' };
  const chip = <span data-pr-state={pr.state ?? 'unknown'} className={`inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full px-1.5 font-mono text-[10.5px] tabular-nums ${pr.state === 'draft' ? 'border border-dashed border-border text-muted-foreground' : pr.state === 'closed' ? 'text-muted-foreground opacity-70' : 'text-foreground/80'}`} style={style}>
    #{pr.number}
    {pr.state && (full || pr.state !== 'open') ? <span className="text-muted-foreground">· {pr.state}</span> : null}
    {checks?.mark ?? null}
    {full ? <span className="max-w-64 truncate font-sans text-muted-foreground">· {pr.title}</span> : null}
  </span>;
  const tip = [`#${pr.number} ${pr.title}`, pr.state, checks?.label].filter(Boolean).join(' · ');
  return <Tooltip content={tip} side="bottom">{pr.url ? <a href={pr.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0" onClick={event => event.stopPropagation()}>{chip}</a> : chip}</Tooltip>;
}

/** A workspace's pull requests, open and draft ones first. `full` (the header, the Goal view) shows each, the first
 * with its title; otherwise (a sidebar row) the first and how many more. */
export function PrChips({ pulls, full = false }: { pulls: readonly LinkedPullRequest[]; full?: boolean }) {
  const [first, ...rest] = pulls;
  if (!first) return null;
  if (full) return <span className="inline-flex min-w-0 flex-wrap items-center gap-1">{pulls.map((pr, index) => <PrChip key={pr.number} pr={pr} full={index === 0} />)}</span>;
  return <span className="inline-flex shrink-0 items-center gap-1">
    <PrChip pr={first} />
    {rest.length ? <Tooltip content={rest.map(pr => `#${pr.number}${pr.state ? ` ${pr.state}` : ''}`).join(', ')} side="bottom"><span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">+{rest.length}</span></Tooltip> : null}
  </span>;
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

/** "↑ blocked by X, Y" and "↓ blocking Z", one or both, only while they hold; a stack parent is told by the nesting and
 * its caption instead. */
export function DependencyText({ blockedBy, blocking }: { blockedBy: readonly string[]; blocking: readonly string[] }) {
  if (!blockedBy.length && !blocking.length) return null;
  return <span className="flex min-w-0 items-center gap-1.5 truncate">
    {blockedBy.length ? <span className="inline-flex min-w-0 items-center gap-0.5 truncate" style={{ color: `color-mix(in oklab, ${UPSTREAM_TONE} 75%, var(--muted-foreground))` }}><ArrowNarrowUp width={11} height={11} strokeWidth={2} className="shrink-0" /><span className="truncate">blocked by {names(blockedBy, blockedBy.length > 1 && blocking.length ? 1 : 2)}</span></span> : null}
    {blocking.length ? <span className="inline-flex min-w-0 shrink-0 items-center gap-0.5" style={{ color: `color-mix(in oklab, ${DOWNSTREAM_TONE} 75%, var(--muted-foreground))` }}><ArrowNarrowDown width={11} height={11} strokeWidth={2} className="shrink-0" />blocking {blockedBy.length ? blocking.length : names(blocking, 1)}</span> : null}
  </span>;
}

/** "↳ on bakery-core · 2 behind": the workspace a stacked row builds on and merges after, with its git position
 * against it when that is read and not up to date; the full position and the command that takes it in on hover. */
export function StackCaption({ parent, position }: { parent: string; position: StackPosition | null }) {
  const title = [`Stacked on ${parent}: it merges after it`, position?.text, position?.command ? `to take it in: ${position.command}` : null].filter(Boolean).join('. ');
  return <span className="inline-flex min-w-0 shrink items-center gap-0.5" title={title}><CornerDownRight width={11} height={11} strokeWidth={1.75} className="shrink-0" /><span className="truncate">on {parent}{position?.short ? ` · ${position.short}` : ''}</span></span>;
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
