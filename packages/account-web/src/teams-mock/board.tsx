// The board: the sidebar's groups as columns once it is wider than the snap width. Every card is the workspace's
// goal-first context (the Inbox design's tile, goal and progress) over the sidebar row's own parts; a stack stays one
// pile under its head's column. Group by State makes Needs you the Inbox: the account's rows, the approvals by content
// hash and the issue topics head it, and each workspace's waiting rows sit inside its card. Group by Phase lets a card
// be dragged to another column.
import { StripVolume } from '../chatter/ChatterVolume.js';
import { PHASE_LABEL, StatusDot } from '../GitSpaceShell.js';
import { GroupHeading, HeadTag, LabelText, StackCaption, StackMarker } from '../sidebar/parts.js';
import { StatTile, ScrollArea } from '@gitspace/ui';
import { ChevronDown, ChevronRight } from '@untitledui/icons';
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { actorLabel, APPROVAL_GROUPS, CARD_ITEMS, ISSUE_TOPICS, notices, PROJECTS, TODAY, userOf, waitedFor, type Phase } from './data.js';
import { AccountRow, ApprovalGroupCard, CardItems, HandleRequestRow, IssueRow, itemSummary, NoticeRow, type Held, type InboxActions } from './inbox.js';
import { rowParts } from './list.js';
import {
  allOpenRows, approversOf, groupsOf, inboxCount, matches, myAccountItems, myApprovals, myItems, names, openItems, recipientsOf, runsOf, STATE_LABEL,
  type Group, type GroupBy, type MockState, type Row, type Run, type SidebarFilter,
} from './model.js';
import { IdentityLine, IdentityTile } from './parts.js';
import { HandleActions, HoldersOrFree } from './people.js';
import { why } from './settings/roles.js';

export interface BoardActions extends InboxActions {
  select(row: Row): void;
  movePhase(row: Row, phase: Phase): void;
}

/** A card being dragged between Phase columns: where it is and which column is under it. */
interface CardDrag { row: Row; x: number; y: number; dx: number; dy: number; width: number; over: string | null }

/** A Phase column's key names a phase. */
function isPhase(key: string | null): key is Phase { return key === 'plan' || key === 'code' || key === 'review' || key === 'ship'; }

/** The Today strip (the Inbox mock's dashboard): today at a glance in the app's stat tiles, for the projects the
 * Project filter shows (machines are the account's); folds to one line. */
export function TodayStrip({ state, scope, defaultOpen }: { state: MockState; scope: ReadonlySet<string>; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const rows = allOpenRows(state, scope);
  const projects = PROJECTS.filter((project) => !project.archived && scope.has(project.id));
  const working = rows.filter((row) => row.state === 'running').length;
  const waiting = rows.filter((row) => row.state === 'needs-you');
  const longest = Math.max(0, ...CARD_ITEMS.filter((item) => waiting.some((row) => row.id === item.workspaceId) && !state.done.has(item.id)).map((item) => item.since));
  const approvals = myApprovals(state, scope).filter((entry) => !state.done.has(entry.id)).length;
  // Account rows that ask for a decision (an environment or machine-profile proposal, a bot's secret waiting for its
  // sponsor) aren't problems.
  const watchdog = myAccountItems(state, scope).filter((item) => item.kind !== 'environment' && item.kind !== 'profile-proposal' && item.kind !== 'bot-secret');
  const problems = watchdog.length + rows.filter((row) => row.state === 'failed').length;
  const spend = projects.reduce((total, project) => total + (TODAY.spendByProject[project.id] ?? 0), 0);
  const machinesOnline = TODAY.machines - (state.done.has('acc-machine') ? 0 : 1);
  return <section aria-label="Today" className="mx-2 mb-2 flex flex-col gap-2 rounded-2xl border border-border px-3 py-2">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-2 text-left text-[12px] text-muted-foreground hover:text-foreground">
      {open ? <ChevronDown width={14} height={14} /> : <ChevronRight width={14} height={14} />}
      <span className="font-medium text-foreground/80">Today</span>
      {projects.length < PROJECTS.filter((project) => !project.archived).length ? <span className="text-foreground/70">· {projects.map((project) => project.name).join(', ')}</span> : null}
      {open ? null : <span className="truncate tabular-nums">{working} agents working · {waiting.length} waiting on you · {problems} problems · ${spend.toFixed(2)} of ${TODAY.budget} · {machinesOnline} of {TODAY.machines} machines</span>}
    </button>
    {open ? <div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-2">
      <StatTile label="Agents working" value={working} detail={`across ${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`} tone="good" />
      <StatTile label="Waiting on you" value={waiting.length} detail={waiting.length ? `longest ${waitedFor(longest)}` : 'none'} />
      <StatTile label="Open approvals" value={approvals} detail="by content hash" />
      <StatTile label="Problems" value={problems} detail={`${watchdog.length} from the account`} tone={problems ? 'bad' : 'good'} />
      <StatTile label="Spend today" value={`$${spend.toFixed(2)}`} detail={`of $${TODAY.budget} · ${Math.round((spend / TODAY.budget) * 100)}%`} />
      <StatTile label="Machines online" value={`${machinesOnline} of ${TODAY.machines}`} detail={machinesOnline < TODAY.machines ? 'ledger-cloud-2 offline' : 'all up'} tone={machinesOnline < TODAY.machines ? 'bad' : 'good'} />
    </div> : null}
  </section>;
}

/** A workspace's card: its tile, goal and progress, its place in a stack and its planning labels, what it is doing,
 * and inside the Inbox column the rows waiting on the person. */
function WorkspaceCard({ row, rows, column, inbox, selected, dimmed, state, held, now, actions, onDragStart, dragging, onShowApproval }: {
  row: Row; rows: readonly Row[]; column: Group; inbox: boolean; selected: boolean; dimmed: boolean; state: MockState; held: Held; now: number; actions: BoardActions;
  onDragStart: ((row: Row, event: ReactPointerEvent<HTMLElement>) => void) | null; dragging: boolean; onShowApproval(id: string): void;
}) {
  const { parent, position, head, waits, blocked } = rowParts(row, rows);
  // The Inbox column holds only what is addressed to the viewer; elsewhere the card says who it waits on.
  const items = inbox ? myItems(state, row.id) : openItems(state, row.id);
  const pending = items.filter((item) => !held.has(item.id));
  const first = itemSummary(pending);
  const recipients = pending[0] ? recipientsOf(state, pending[0]) : [];
  const summary = inbox || !first ? null : recipients.includes(state.viewer) ? first : { ...first, text: `${first.text} · for ${names(recipients)}` };
  const requests = inbox && row.mine ? row.requests.filter((request) => !state.done.has(request.id)) : [];
  const holding = row.holders.length ? (row.mine ? ['You', ...row.holders.filter((id) => id !== state.viewer).map((id) => actorLabel(id))].join(', ') : row.holders.map((id) => actorLabel(id)).join(', ')) : null;
  const elsewhere = !column.holds(row);
  const relations = parent || waits.length || blocked.length || position?.short;
  return <article data-card={row.id} aria-current={selected || undefined} onPointerDown={onDragStart ? (event) => onDragStart(row, event) : undefined}
    onClick={() => actions.select(row)}
    className={`group/card relative flex min-w-0 cursor-pointer select-none flex-col gap-2 rounded-2xl border bg-card px-3 py-2.5 transition-[opacity,border-color,box-shadow] duration-150 ${selected ? 'border-[#6B97FF]/70 shadow-[0_0_0_1px_rgba(107,151,255,0.5)]' : 'border-border hover:border-foreground/20'} ${dimmed ? 'opacity-40' : ''} ${dragging ? 'opacity-30' : ''} ${row.color === 'dim' && !selected ? 'opacity-75' : ''}`}>
    <div className="flex min-w-0 items-start gap-2.5">
      <IdentityTile workspace={row.workspace} color={row.color} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-start gap-1"><span className="line-clamp-2 text-[14px] font-semibold leading-snug tracking-tight text-foreground" title={row.workspace.goal.title}>{row.workspace.goal.title}</span>{head ? <span className="mt-0.5 shrink-0"><HeadTag /></span> : null}</span>
        <IdentityLine workspace={row.workspace} phase={row.phase} showProject={false} compact={!inbox} />
      </div>
      <StripVolume projectId={row.workspace.projectId} strip={row.id} name={row.name} phase={row.phase} className="mt-0.5 flex shrink-0" />
    </div>
    {relations ? <div className="flex min-w-0 items-center gap-1.5 pl-[42px] text-[11px] text-muted-foreground">
      {parent ? <StackCaption parent={parent.name} position={position} /> : null}
      <StackMarker position={position} ahead={null} />
      <LabelText waits={waits} blocks={blocked} />
    </div> : null}
    <div className="flex min-w-0 flex-col gap-0.5 pl-[42px] text-[12px] text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusDot color={row.color} pulse={row.color === 'green'} />
        <span className="truncate text-foreground/80">{elsewhere ? `${STATE_LABEL[row.state]} · with its stack` : row.answered ? 'working on the answer' : row.state === 'needs-you' ? row.workspace.activity : row.workspace.activity.replace('waiting on you', `waiting on ${row.holders.length ? names(row.holders) : 'a Lead'}`)}</span>
      </span>
      {row.answered || (inbox && items.length) ? null : <span className="line-clamp-2 text-muted-foreground/90">{row.summary.preview}</span>}
    </div>
    {summary ? <div className="flex min-w-0 items-center gap-1.5 pl-[42px] text-[12px]" style={{ color: `color-mix(in oklab, ${summary.tone} 75%, var(--foreground))` }}>
      <summary.icon width={12} height={12} strokeWidth={1.75} className="shrink-0" /><span className="truncate">{summary.text}</span>
    </div> : null}
    <div data-card-handle="" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}
      className="flex min-w-0 cursor-default flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-surface-2 px-2 py-1 text-[11.5px] text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1.5">
        <HoldersOrFree holders={row.holders} size={18} />
        {holding ? <span className="truncate">{holding} {row.holders.length > 1 || row.mine ? 'hold it' : 'holds it'}</span> : null}
      </span>
      <span className="flex-1" />
      <HandleActions row={row} />
    </div>
    {requests.length ? <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} className="flex cursor-default flex-col gap-2 border-t border-border pt-2.5">
      {requests.map((request) => <HandleRequestRow key={request.id} request={request} held={held} now={now} actions={actions} />)}
    </div> : null}
    {inbox ? <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} className="cursor-default">
      <CardItems items={items} held={held} now={now} actions={actions} onShowApproval={onShowApproval} />
    </div> : null}
  </article>;
}

/** A run drawn whole: the head's card, and its stack indented under it on the tree's guide. */
function Pile({ run, render }: { run: Run; render(row: Row): ReactNode }) {
  const [top, ...rest] = run;
  if (!top) return null;
  return <div className="flex min-w-0 flex-col gap-2">
    {render(top.row)}
    {rest.length ? <div className="relative flex flex-col gap-2 pl-4">
      <span aria-hidden className="pointer-events-none absolute bottom-4 left-[7px] top-0 w-px bg-border" />
      {rest.map(({ row }) => <div key={row.id} className="relative">
        <span aria-hidden className="pointer-events-none absolute -left-[9px] top-6 h-px w-2 bg-border" />
        {render(row)}
      </div>)}
    </div> : null}
  </div>;
}

export function BoardColumns({ state, groupBy, filter, scope, held, now, selectedId, actions }: { state: MockState; groupBy: GroupBy; filter: SidebarFilter; scope: ReadonlySet<string>; held: Held; now: number; selectedId: string | null; actions: BoardActions }) {
  const [drag, setDrag] = useState<CardDrag | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const columns = groupsOf(groupBy, true, scope);
  const projects = PROJECTS.filter((project) => !project.archived && scope.has(project.id));
  // Approvals go to every user whose role may approve them; the rest of the group stays off this viewer's Inbox.
  const mine = new Set(myApprovals(state, scope).map((entry) => entry.id));
  // What happened to the viewer's things (a note dismissed, a resource revoked): listed atop the Inbox, never counted.
  const myNotices = notices.use().filter((notice) => notice.to === state.viewer);
  const approvalGroups = APPROVAL_GROUPS.filter((group) => scope.has(group.projectId)).map((group) => ({ ...group, entries: group.entries.filter((entry) => mine.has(entry.id)) })).filter((group) => group.entries.length);
  const routedAway = APPROVAL_GROUPS.flatMap((group) => group.entries).filter((entry) => scope.has(entry.projectId) && !mine.has(entry.id) && !state.done.has(entry.id));
  const phased = groupBy === 'phase';
  const columnAt = (x: number, y: number): string | null => document.elementsFromPoint(x, y).map((element) => element.closest<HTMLElement>('[data-column]')?.dataset.column).find((key) => key !== undefined) ?? null;
  // Phase columns take a card by its drag: a press that moves starts it; a press that doesn't is the card's click.
  const startDrag = (row: Row, event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    const card = event.currentTarget.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    const move = (pointer: PointerEvent): void => {
      if (!moved && Math.hypot(pointer.clientX - start.x, pointer.clientY - start.y) < 5) return;
      moved = true;
      setDrag({ row, x: pointer.clientX, y: pointer.clientY, dx: start.x - card.left, dy: start.y - card.top, width: card.width, over: columnAt(pointer.clientX, pointer.clientY) });
    };
    const up = (pointer: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) return;
      const over = columnAt(pointer.clientX, pointer.clientY);
      setDrag(null);
      // The click that follows a drag must not open the card.
      window.addEventListener('click', (click) => click.stopPropagation(), { capture: true, once: true });
      const phase = columns.find((column) => column.key === over)?.key;
      if (phase === 'plan' || phase === 'code' || phase === 'review' || phase === 'ship') { if (phase !== row.phase) actions.movePhase(row, phase); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const showApproval = (id: string): void => {
    const target = board.current?.querySelector<HTMLElement>(`[data-approval="${CSS.escape(id)}"]`);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target?.animate([{ backgroundColor: 'color-mix(in oklab, #f59e0b 22%, transparent)' }, { backgroundColor: 'transparent' }], { duration: 1600 });
  };
  const shownRows = allOpenRows(state, scope);
  const rowsByProject = new Map(projects.map((project) => [project.id, shownRows.filter((row) => row.workspace.projectId === project.id)]));
  return <div ref={board} className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-2 pb-2" data-board="">
    {columns.map((column) => {
      const inbox = groupBy === 'state' && column.key === 'needs-you';
      const failed = groupBy === 'state' && column.key === 'failed';
      const count = shownRows.filter((row) => column.holds(row) && matches(row, filter)).length;
      const sections = projects.flatMap((project) => {
        const rows = rowsByProject.get(project.id) ?? [];
        const runs = runsOf(rows).filter((run) => run[0] && column.holds(run[0].row) && run.some(({ row }) => matches(row, filter)));
        return runs.length ? [{ project, rows, runs }] : [];
      });
      const over = drag?.over === column.key && drag.row.phase !== column.key;
      return <section key={column.key} data-column={column.key} aria-label={column.label}
        className={`flex min-h-0 min-w-0 flex-col rounded-2xl transition-colors duration-150 ${inbox ? 'min-w-[380px] flex-[1.7]' : 'min-w-[260px] flex-1'} ${over ? 'bg-[#6B97FF]/8 shadow-[inset_0_0_0_1.5px_rgba(107,151,255,0.55)]' : ''}`}>
        <div className="px-1">
          <GroupHeading tone={column.tone} count={inbox ? inboxCount(state, scope) : count}>{column.label}{inbox ? ' · Inbox' : ''}</GroupHeading>
          {inbox ? <p className="px-2 pb-1 text-[11px] text-muted-foreground">Addressed to {userOf(state.viewer).first}: questions from workspaces you hold, requests for your handles, approvals your role decides · mentions listed, not counted</p> : null}
        </div>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full">
          <div className="flex flex-col gap-2 px-1 pb-24 pt-1">
            {inbox ? <>
              {myAccountItems(state, scope).map((item) => <AccountRow key={item.id} item={item} held={held} now={now} actions={actions} />)}
              {myNotices.map((notice) => <NoticeRow key={notice.id} notice={notice} />)}
              {ISSUE_TOPICS.filter((topic) => !state.done.has(topic.id) && scope.has(topic.projectId)).map((topic) => <IssueRow key={topic.id} topic={topic} held={held} now={now} actions={actions} />)}
            </> : null}
            {sections.map(({ project, rows, runs }) => <div key={project.id} className="flex flex-col gap-2">
              {groupBy === 'project' ? null : <div className="-mx-1"><GroupHeading count={rows.filter((row) => column.holds(row) && matches(row, filter)).length}>{project.name}</GroupHeading></div>}
              {runs.map((run) => <Pile key={run[0]?.row.id} run={run} render={(row) => <WorkspaceCard row={row} rows={rows} column={column} inbox={inbox || failed} selected={selectedId === row.id} dimmed={!matches(row, filter)}
                state={state} held={held} now={now} actions={actions} onDragStart={phased ? startDrag : null} dragging={drag?.row.id === row.id} onShowApproval={showApproval} />} />)}
            </div>)}
            {inbox && approvalGroups.some((group) => group.entries.some((entry) => !state.done.has(entry.id))) ? <>
              <div className="-mx-1 pt-1"><GroupHeading tone="#f59e0b" count={approvalGroups.flatMap((group) => group.entries).filter((entry) => !state.done.has(entry.id) && !held.has(entry.id)).length}>Approvals · one per content</GroupHeading></div>
              {approvalGroups.map((group) => <ApprovalGroupCard key={group.id} group={group} held={held} now={now} done={state.done} actions={actions} />)}
            </> : null}
            {inbox && routedAway.length ? <p data-routed-away="" className="rounded-xl px-2 py-1.5 text-[11.5px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
              {routedAway.length} {routedAway.length === 1 ? 'approval waits' : 'approvals wait'} on {names(approversOf(routedAway[0]!))} · not yours to decide in {PROJECTS.find((project) => project.id === routedAway[0]?.projectId)?.name}
            </p> : null}
            {!sections.length && !inbox ? <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">Nothing {groupBy === 'phase' ? `in ${column.label}` : 'here'}</p> : null}
            {over && drag ? (() => {
              const refused = isPhase(column.key) ? why(state.viewer, drag.row.workspace.projectId, `phase.${column.key}`) : null;
              return <div data-drop-refused={refused ? '' : undefined} className="flex min-h-14 items-center justify-center rounded-2xl border border-dashed px-3 text-center text-[12px]"
                style={refused ? { borderColor: 'color-mix(in oklab, #ef4444 70%, transparent)', color: '#ef4444' } : { borderColor: 'rgba(107,151,255,0.7)', color: '#6B97FF' }}>{refused ?? `Move ${drag.row.name} to ${column.label}`}</div>;
            })() : null}
          </div>
        </ScrollArea>
      </section>;
    })}
    {drag ? <div aria-hidden className="pointer-events-none fixed z-[70] rotate-[1.5deg] rounded-2xl border border-[#6B97FF]/70 bg-card px-3 py-2.5 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.45)]"
      style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.width }}>
      <div className="flex min-w-0 items-start gap-2.5">
        <IdentityTile workspace={drag.row.workspace} color={drag.row.color} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[14px] font-semibold tracking-tight">{drag.row.workspace.goal.title}</span>
          <IdentityLine workspace={drag.row.workspace} phase={drag.row.phase} showProject={false} />
        </div>
      </div>
      <p className="pl-[42px] pt-1.5 text-[12px]" style={{ color: '#6B97FF' }}>{isPhase(drag.over) && drag.over !== drag.row.phase ? (why(state.viewer, drag.row.workspace.projectId, `phase.${drag.over}`) ?? `Drop to move to ${columns.find((column) => column.key === drag.over)?.label}`) : `In ${PHASE_LABEL[drag.row.phase]}`}</p>
    </div> : null}
  </div>;
}
