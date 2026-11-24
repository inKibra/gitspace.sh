import { badgeColors, ScrollArea, Tooltip } from '@gitspace/ui';
import { CheckDone01, ChevronRight, GitBranch01, Plus } from '@untitledui/icons';
import { useContext, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { StripVolume } from '../chatter/ChatterVolume.js';
import { PHASE_LABEL, PHASES, StatusDot, workspaceStatusColor, workspaceStatusLabel, WorkspaceStatusDot, type WorkspaceView } from '../GitSpaceShell.js';
import { AccountRows, InboxRows, InboxSourcesContext, useInboxCount, useWaitingSummary } from '../inbox/index.js';
import { blocks } from '../sidebar/graph.js';
import { GroupHeading, HeadTag, LabelText, PhaseTag, PrChips, StackCaption, StackMarker } from '../sidebar/parts.js';
import type { LinkedPullRequest } from '../sidebar/project-graph.js';
import { matches, STATE_LABEL, type RowGroup, type RowItem, type Run, type SidebarFilter, type SidebarGroupBy } from '../sidebar/rows.js';
import { stackPosition } from '../sidebar/StackChain.js';
import { boardColumns, type BoardProject } from './columns.js';

/** A card being dragged between Phase columns: where the pointer is, where it holds the card, and the column under it. */
interface CardDrag { item: RowItem; x: number; y: number; dx: number; dy: number; width: number; over: string | null }

/** Tile colours: a stable pick per workspace from the badge palette. */
const TILE_COLORS: readonly string[] = [badgeColors.orange, badgeColors.teal, badgeColors.violet, badgeColors.blue, badgeColors.lime, badgeColors.purple, badgeColors.cyan, badgeColors.amber, badgeColors.indigo, badgeColors.emerald];

function tileColor(key: string): string {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length] ?? badgeColors.gray;
}

/** The workspace's tile: its goal's emoji or its name's initial, in the workspace's own colour, with its status dot. */
function IdentityTile({ item }: { item: RowItem }) {
  const tone = tileColor(`${item.workspace.projectId}/${item.name}`);
  const emoji = item.summary?.goal?.emoji ?? null;
  return <span aria-hidden className="relative flex size-8 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold"
    style={{ color: `color-mix(in oklab, ${tone} 80%, var(--foreground))`, background: `color-mix(in oklab, ${tone} 18%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tone} 30%, transparent)`, fontSize: emoji ? 15 : undefined }}>
    {emoji ?? item.name.charAt(0).toUpperCase()}
    <span className="absolute -bottom-0.5 -right-0.5 flex rounded-full" style={{ background: 'var(--background)', padding: 2 }}>{item.summary ? <WorkspaceStatusDot space={item.summary} /> : <StatusDot color="dim" />}</span>
  </span>;
}

/** One line of what a workspace waits on, in the Inbox's words: its oldest open item. */
function WaitingLine({ workspaceId }: { workspaceId: string }) {
  const waiting = useWaitingSummary(workspaceId);
  return waiting ? <div data-waiting="" className="flex min-w-0 items-center gap-1.5 pl-[42px] text-[12px]" style={{ color: `color-mix(in oklab, ${badgeColors.orange} 75%, var(--foreground))` }}>
    <span className="truncate">{waiting.text}</span>
  </div> : null;
}

/** A workspace's card: its tile, its goal (its name until the workspace reports one) and under it the workspace, phase,
 * pull request, requirements met and plan step; its place in a stack and its planning labels; its status and its
 * agent's last message; and what it waits on (`waiting`): inside the Needs you and Failed columns of State, the Inbox's
 * own rows for it, elsewhere one line; nothing outside the account, where the Inbox has no sources. A stacked card shown
 * in its head's column says where its own state is. */
function WorkspaceCard({ item, items, pulls, column, waiting, selected, dimmed, onOpen, onDragStart, dragging }: {
  item: RowItem; items: readonly RowItem[]; pulls: readonly LinkedPullRequest[]; column: RowGroup; waiting: 'rows' | 'line' | null; selected: boolean; dimmed: boolean; onOpen(item: RowItem): void;
  onDragStart: ((item: RowItem, event: ReactPointerEvent<HTMLElement>) => void) | null; dragging: boolean;
}) {
  const parent = item.stackedOn ? items.find((other) => other.id === item.stackedOn) : undefined;
  const position = parent ? stackPosition(item.position, parent) : null;
  const head = !parent && items.some((other) => other.stackedOn === item.id);
  const waits = item.dependsOn.flatMap((id) => items.find((other) => other.id === id)?.name ?? []);
  const blocked = blocks(items, item.id).flatMap((id) => items.find((other) => other.id === id)?.name ?? []);
  const goal = item.summary?.goal ?? null;
  const elsewhere = !column.holds(item);
  const color = item.summary ? workspaceStatusColor(item.summary) : 'dim';
  const preview = item.summary?.closedAt ? null : item.summary?.preview ?? null;
  return <article data-card={item.id} aria-label={item.name} aria-current={selected || undefined} onPointerDown={onDragStart ? (event) => onDragStart(item, event) : undefined}
    onClick={() => onOpen(item)}
    className={`group/card relative flex min-w-0 cursor-pointer select-none flex-col gap-2 rounded-2xl border bg-card px-3 py-2.5 transition-[opacity,border-color,box-shadow] duration-150 ${selected ? 'border-[#6B97FF]/70 shadow-[0_0_0_1px_rgba(107,151,255,0.5)]' : 'border-border hover:border-foreground/20'} ${dimmed ? 'opacity-40' : dragging ? 'opacity-30' : ''}`}>
    <div className="flex min-w-0 items-start gap-2.5">
      <IdentityTile item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-start gap-1"><span className="line-clamp-2 text-[14px] font-semibold leading-snug tracking-tight text-foreground" title={goal?.title ?? item.name}>{goal?.title ?? item.name}</span>{head ? <span className="mt-0.5 shrink-0"><HeadTag /></span> : null}</span>
        <div className="flex min-w-0 flex-col gap-0.5 text-[12px] text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1 truncate" title={item.branch}><GitBranch01 width={11} height={11} strokeWidth={1.75} className="shrink-0" /><span className="truncate">{goal ? item.name : item.branch}</span></span>
          <span className="flex min-w-0 items-center gap-2 overflow-hidden">
            <PhaseTag phase={item.phase} />
            <PrChips pulls={pulls} />
            {goal ? <span className="inline-flex shrink-0 items-center gap-1 tabular-nums" title="Requirements accepted"><CheckDone01 width={11} height={11} strokeWidth={1.75} />{goal.met} of {goal.total}</span> : null}
            {goal ? <span className="shrink-0 tabular-nums" title={goal.step?.title ?? 'Plan waiting for approval'}>{goal.step ? `step ${goal.step.index} of ${goal.step.count}` : 'plan waiting'}</span> : null}
          </span>
        </div>
      </div>
      <StripVolume projectId={item.workspace.projectId} strip={item.id} name={item.name} phase={item.phase} className="mt-0.5 flex shrink-0" />
    </div>
    {parent || waits.length || blocked.length || position?.short || item.aheadOfParent ? <div className="flex min-w-0 items-center gap-1.5 pl-[42px] text-[11px] text-muted-foreground">
      {parent ? <StackCaption parent={parent.name} position={position} /> : null}
      <StackMarker position={position} ahead={item.aheadOfParent} />
      <LabelText waits={waits} blocks={blocked} />
    </div> : null}
    <div className="flex min-w-0 flex-col gap-0.5 pl-[42px] text-[12px] text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusDot color={color} pulse={color === 'green'} />
        <span className="truncate text-foreground/80">{elsewhere ? `${STATE_LABEL[item.state]} · with its stack` : item.summary ? workspaceStatusLabel(item.summary) : 'Status unknown'}</span>
      </span>
      {preview ? <span data-workspace-preview="" className="line-clamp-2 text-muted-foreground/90">{preview}</span> : null}
    </div>
    {waiting === 'line' ? <WaitingLine workspaceId={item.id} /> : null}
    {waiting === 'rows' ? <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} className="cursor-default empty:hidden">
      <InboxRows projectId={item.workspace.projectId} workspaceId={item.id} onOpen={(projectId, workspaceId) => { if (workspaceId === item.id && projectId === item.workspace.projectId) onOpen(item); }} />
    </div> : null}
  </article>;
}

/** A run drawn whole: the head's card, and its stack indented under it on the tree's guide. */
function Pile({ run, render }: { run: Run; render(item: RowItem): ReactNode }) {
  const [top, ...rest] = run;
  if (!top) return null;
  return <div className="flex min-w-0 flex-col gap-2">
    {render(top.item)}
    {rest.length ? <div className="relative flex flex-col gap-2 pl-4">
      <span aria-hidden className="pointer-events-none absolute bottom-4 left-[7px] top-0 w-px bg-border" />
      {rest.map(({ item }) => <div key={item.id} className="relative">
        <span aria-hidden className="pointer-events-none absolute -left-[9px] top-6 h-px w-2 bg-border" />
        {render(item)}
      </div>)}
    </div> : null}
  </div>;
}

/** The column under a point: the nearest `[data-column]` of the elements there. */
function columnAt(x: number, y: number): string | null {
  for (const element of document.elementsFromPoint(x, y)) {
    const key = element.closest<HTMLElement>('[data-column]')?.dataset.column;
    if (key !== undefined) return key;
  }
  return null;
}

/** The Needs you column's head: what the Inbox counts in the projects shown, and what it lists. */
function InboxHeading({ tone, scope, fold }: { tone: string | undefined; scope: ReadonlySet<string>; fold?: { open: boolean; onToggle(): void } }) {
  return <>
    <GroupHeading tone={tone} count={useInboxCount(scope)} fold={fold}>Needs you · Inbox</GroupHeading>
    <p className="px-2 pb-1 text-[11px] text-muted-foreground">Counts what blocks an agent or is broken · issues and mentions are listed, not counted</p>
  </>;
}

/**
 * The board's columns: the sidebar's groups side by side. Every card sits in a project section of its column, each
 * stack one pile under its head's column. In State, Needs you is the Inbox: the account's rows head it and each waiting
 * workspace's card holds its rows. In Phase a card is dragged to another column to move its phase (`onMove`, which
 * applies the phase rule).
 */
export function BoardColumns({ projects, groupBy, filter, selectedId, collapsed, onToggleGroup, onOpen, onMove, onNewWorkspace }: {
  projects: readonly BoardProject[]; groupBy: SidebarGroupBy; filter: SidebarFilter; selectedId: string | null; collapsed: ReadonlySet<string>; onToggleGroup(group: string): void;
  onOpen(item: RowItem): void; onMove: ((item: RowItem, phase: WorkspaceView['phase']) => void) | null; onNewWorkspace?: (projectId: string) => void;
}) {
  const [drag, setDrag] = useState<CardDrag | null>(null);
  const columns = boardColumns(projects, groupBy, filter);
  const scope = new Set(projects.map((project) => project.id));
  // The Inbox's sources come with the account; outside it the board shows no Inbox parts.
  const inboxed = useContext(InboxSourcesContext) !== null;
  // Phase columns take a card by its drag: a press that moves starts it; a press that doesn't is the card's click.
  const startDrag = onMove && groupBy === 'phase' ? (item: RowItem, event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    const card = event.currentTarget.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    const move = (pointer: PointerEvent): void => {
      if (!moved && Math.hypot(pointer.clientX - start.x, pointer.clientY - start.y) < 5) return;
      moved = true;
      setDrag({ item, x: pointer.clientX, y: pointer.clientY, dx: start.x - card.left, dy: start.y - card.top, width: card.width, over: columnAt(pointer.clientX, pointer.clientY) });
    };
    const up = (pointer: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) return;
      setDrag(null);
      // The click that follows a drag, in the same task, does not open the card.
      const swallow = (click: MouseEvent): void => click.stopPropagation();
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }));
      const phase = PHASES.find((candidate) => candidate === columnAt(pointer.clientX, pointer.clientY));
      if (phase && phase !== item.phase) onMove(item, phase);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  } : null;
  const dropPhase = PHASES.find((phase) => phase === drag?.over) ?? null;
  return <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-2 pb-2" data-board="">
    {columns.map(({ group, count, sections }) => {
      const inbox = inboxed && groupBy === 'state' && group.key === 'needs-you';
      const waiting = !inboxed ? null : groupBy === 'state' && (group.key === 'needs-you' || group.key === 'failed') ? 'rows' : 'line';
      const over = drag !== null && drag.over === group.key && group.phase !== null && group.phase !== drag.item.phase;
      const fold = groupBy === 'project' ? undefined : { open: !collapsed.has(group.key), onToggle: () => onToggleGroup(group.key) };
      // A folded column is a narrow strip: its colour, count and name, opening on a click; the others take its room.
      if (fold && !fold.open) return <section key={group.key} data-column={group.key} aria-label={group.label} data-folded=""
        className={`flex min-h-0 w-10 shrink-0 flex-col rounded-2xl transition-colors duration-150 ${over ? 'bg-[#6B97FF]/8 shadow-[inset_0_0_0_1.5px_rgba(107,151,255,0.55)]' : 'bg-foreground/[0.03]'}`}>
        <button type="button" aria-expanded={false} aria-label={`${group.label}, ${count}`} onClick={fold.onToggle}
          className="flex flex-1 flex-col items-center gap-2 rounded-2xl py-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-[#6B97FF]/50">
          <ChevronRight width={12} height={12} strokeWidth={2} aria-hidden className="shrink-0" />
          {group.tone ? <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: group.tone }} /> : null}
          <span className="tabular-nums text-muted-foreground/70">{count}</span>
          <span className="rotate-180 whitespace-nowrap [writing-mode:vertical-rl]">{group.label}</span>
        </button>
      </section>;
      return <section key={group.key} data-column={group.key} aria-label={group.label}
        className={`flex min-h-0 min-w-0 flex-col rounded-2xl transition-colors duration-150 ${inbox ? 'min-w-[380px] flex-[1.7]' : 'min-w-[260px] flex-1'} ${over ? 'bg-[#6B97FF]/8 shadow-[inset_0_0_0_1.5px_rgba(107,151,255,0.55)]' : ''}`}>
        <div className="flex items-center gap-1 px-1">
          <div className="min-w-0 flex-1">{inbox ? <InboxHeading tone={group.tone} scope={scope} fold={fold} /> : <GroupHeading tone={group.tone} count={count} fold={fold}>{group.label}</GroupHeading>}</div>
          {groupBy === 'project' && onNewWorkspace ? <Tooltip content="New workspace" side="top"><button type="button" aria-label={`New workspace in ${group.label}`} onClick={() => onNewWorkspace(group.key)} className="mt-2 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"><Plus width={14} height={14} strokeWidth={1.5} /></button></Tooltip> : null}
        </div>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full">
          <div className="flex flex-col gap-2 px-1 pb-24 pt-1">
            {inbox ? <AccountRows scope={scope} onOpen={(projectId, workspaceId) => { const target = projects.find((project) => project.id === projectId)?.items.find((item) => item.id === workspaceId); if (target) onOpen(target); }} /> : null}
            {sections.map(({ project, runs, count: projectCount }) => <div key={project.id} className="flex flex-col gap-2">
              {groupBy === 'project' ? null : <div className="-mx-1"><GroupHeading count={projectCount}>{project.name}</GroupHeading></div>}
              {runs.map((run) => <Pile key={run[0]?.item.id} run={run} render={(item) => <WorkspaceCard key={item.id} item={item} items={project.items} pulls={project.pullRequests[item.id] ?? []} column={group} waiting={waiting} selected={selectedId === item.id}
                dimmed={!matches(item, filter)} onOpen={onOpen} onDragStart={startDrag} dragging={drag?.item.id === item.id} />} />)}
            </div>)}
            {!sections.length && !inbox ? <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">Nothing {groupBy === 'phase' ? `in ${group.label}` : 'here'}</p> : null}
            {over && drag ? <div className="flex h-14 items-center justify-center rounded-2xl border border-dashed border-[#6B97FF]/70 text-[12px] text-[#6B97FF]">Move {drag.item.name} to {group.label}</div> : null}
          </div>
        </ScrollArea>
      </section>;
    })}
    {drag ? <div aria-hidden className="pointer-events-none fixed z-[70] rotate-[1.5deg] rounded-2xl border border-[#6B97FF]/70 bg-card px-3 py-2.5 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.45)]"
      style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.width }}>
      <div className="flex min-w-0 items-start gap-2.5">
        <IdentityTile item={drag.item} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[14px] font-semibold tracking-tight">{drag.item.summary?.goal?.title ?? drag.item.name}</span>
          <span className="inline-flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground"><GitBranch01 width={11} height={11} strokeWidth={1.75} className="shrink-0" /><span className="truncate">{drag.item.summary?.goal ? drag.item.name : drag.item.branch}</span></span>
        </div>
      </div>
      <p className="pl-[42px] pt-1.5 text-[12px] text-[#6B97FF]">{dropPhase && dropPhase !== drag.item.phase ? `Drop to move to ${PHASE_LABEL[dropPhase]}` : drag.item.phase ? `In ${PHASE_LABEL[drag.item.phase]}` : 'Phase unknown'}</p>
    </div> : null}
  </div>;
}
