import type { WorkspaceStatusColor } from '@gitspace/protocol-workspace';
import { Tooltip, badgeColors } from '@gitspace/ui';
import { ArrowNarrowDown, ArrowNarrowUp, Check, ChevronRight, CornerDownRight, XClose } from '@untitledui/icons';
import type { CSSProperties, ReactNode } from 'react';
import { PHASE_LABEL, PHASES, STATUS_COLOR, StatusDot, type WorkspaceView } from '../GitSpaceShell.js';
import type { LinkedPullRequest } from './project-graph.js';
import type { StackPosition } from './StackChain.js';

/** What the focused workspace sits on or waits on (violet) and what sits on it or waits on it (teal); neither is a
 * status colour. */
export const UPSTREAM_TONE = '#a855f7';
export const DOWNSTREAM_TONE = '#14b8a6';
/** The picker's and the head tag's accent, the focus ring's blue. */
export const ACCENT = '#6B97FF';

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

/** Four pips (plan, code, review, ship) filled up to the phase; the phase's name is its title and accessible name. */
export function PhaseTag({ phase }: { phase: WorkspaceView['phase'] | null }) {
  const reached = phase === null ? -1 : PHASES.indexOf(phase);
  const name = phase === null ? 'Phase unknown' : `Phase: ${PHASE_LABEL[phase]}`;
  return <span role="img" aria-label={name} title={name} className="inline-flex shrink-0 gap-[2px]">
    {PHASES.map((step, index) => <span key={step} className="h-[5px] w-[3px] rounded-[1px]" style={{ background: index <= reached ? 'var(--foreground)' : 'color-mix(in oklab, var(--foreground) 18%, transparent)', opacity: index <= reached ? 0.55 : 1 }} />)}
  </span>;
}

/** "↑ waits on X" and "↓ blocks Y", one or both: planning labels, so neither says it blocks anything from moving. */
export function LabelText({ waits, blocks }: { waits: readonly string[]; blocks: readonly string[] }) {
  if (!waits.length && !blocks.length) return null;
  return <span className="flex min-w-0 items-center gap-1.5 truncate">
    {waits.length ? <span className="inline-flex min-w-0 items-center gap-0.5 truncate" style={{ color: `color-mix(in oklab, ${UPSTREAM_TONE} 75%, var(--muted-foreground))` }}><ArrowNarrowUp width={11} height={11} strokeWidth={2} className="shrink-0" /><span className="truncate">waits on {waits.join(', ')}</span></span> : null}
    {blocks.length ? <span className="inline-flex min-w-0 items-center gap-0.5 truncate" style={{ color: `color-mix(in oklab, ${DOWNSTREAM_TONE} 75%, var(--muted-foreground))` }}><ArrowNarrowDown width={11} height={11} strokeWidth={2} className="shrink-0" /><span className="truncate">blocks {waits.length ? blocks.length : blocks[0]}{!waits.length && blocks.length > 1 ? ` +${blocks.length - 1}` : ''}</span></span> : null}
  </span>;
}

/** "↳ on bakery-core" beside a stacked row's name: the workspace it builds on and merges after. It gives way before
 * the name does (it shrinks a thousand times faster); its title has the full text, the position and the command that
 * takes it in. */
export function StackCaption({ parent, position }: { parent: string; position: StackPosition | null }) {
  const title = [`Stacked on ${parent}: it merges after it`, position?.text, position?.command ? `to take it in: ${position.command}` : null].filter(Boolean).join('. ');
  return <span className="inline-flex min-w-0 shrink-[1000] items-center gap-0.5 overflow-hidden text-[11.5px] text-muted-foreground" title={title}><CornerDownRight width={11} height={11} strokeWidth={1.75} className="shrink-0" /><span className="truncate">on {parent}</span></span>;
}

/** How a stacked branch stands against its parent, on the row's second line: "3 behind", "base rewritten", "merged —
 * restack onto main"; then, in the warning tone, "ahead of its parent" for a member already in a later phase than its
 * parent (only possible from before the phase rule). Nothing when up to date and in step. */
export function StackMarker({ position, ahead }: { position: StackPosition | null; ahead: string | null }) {
  return <>
    {position?.short ? <span className="shrink-0" title={position.text}>{position.short}</span> : null}
    {ahead ? <span className="shrink-0" title={ahead} style={{ color: `color-mix(in oklab, ${STATUS_COLOR.orange} 80%, var(--muted-foreground))` }}>ahead of its parent</span> : null}
  </>;
}

/** The subtle mark on a stack's head: the root its members sit under, which merges first. */
export function HeadTag() {
  return <span title="Head: leads its stack and merges first" className="ml-1 shrink-0 rounded-[5px] px-1 text-[10px] font-medium leading-[14px]" style={{ color: ACCENT, background: `color-mix(in oklab, ${ACCENT} 12%, transparent)` }}>head</span>;
}

/** A group heading inside a project: its label, its count and a rule. With `fold`, the heading is a button that folds
 * its group away and back (a chevron says which), its count still showing while folded. */
export function GroupHeading({ children, count, tone, fold }: { children: ReactNode; count: number; tone?: string; fold?: { open: boolean; onToggle(): void } }) {
  const parts = <>
    {fold ? <ChevronRight width={12} height={12} strokeWidth={2} aria-hidden className={`-ml-0.5 shrink-0 transition-[rotate] duration-80 ${fold.open ? 'rotate-90' : ''}`} /> : null}
    {tone ? <span className="size-1.5 rounded-full" style={{ background: tone }} /> : null}
    <span>{children}</span>
    <span className="tabular-nums text-muted-foreground/70">{count}</span>
    <span className="h-px flex-1 bg-border" />
  </>;
  const className = 'flex w-full items-center gap-1.5 px-2 pb-0.5 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
  return fold ? <button type="button" aria-expanded={fold.open} data-group-heading="" onClick={fold.onToggle}
    className={`${className} rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-[#6B97FF]/50`}>{parts}</button>
    : <div className={className}>{parts}</div>;
}
