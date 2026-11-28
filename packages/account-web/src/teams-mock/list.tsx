// The narrow list: AppSidebar's header (the icon rail: Board, Projects, People, Services, Machines, Browsers, Sessions,
// Usage, Settings; then the filters, Group by and the Project filter) and its project tree (project rows with the project
// agent's line, stacks indented with their guides, relation
// captions, status dots, the Chatter volume bars, archived sections), redrawn on the same kit parts and classes so the
// board can group it its own way.
import { Popover } from '@base-ui/react/popover';
import { PhaseMenuItems, type SidebarSpaceSummary } from '../AppSidebar.js';
import { ProjectAgentVolume, StripVolume } from '../chatter/ChatterVolume.js';
import { STATUS_COLOR, StatusDot, WorkspaceStatusDot } from '../GitSpaceShell.js';
import { GHOST, GhostGlyph } from '../ghost/ghost-parts.js';
import { glyph } from '../glyph.js';
import { PRODUCT_ROUTE_LABELS } from '../routes.js';
import { blocks, lit, relation, type Lit, type Relation } from '../sidebar/graph.js';
import { DOWNSTREAM_TONE, GroupHeading, HeadTag, LabelText, PhaseTag, PrChips, StackCaption, StackMarker, UPSTREAM_TONE } from '../sidebar/parts.js';
import { stackPosition } from '../sidebar/StackChain.js';
import { phaseRefusal } from '../sidebar/stack-rules.js';
import {
  DropdownContent, DropdownLabel, DropdownMenu, DropdownSeparator, DropdownTrigger, MenuItem, SidebarGroup, SidebarGroupAction, SidebarGroupActions, SidebarGroupLabel, SidebarMenu, SidebarMenuAction,
  SidebarMenuActions, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, Tooltip, type IconComponentProps,
} from '@gitspace/ui';
import { Archive, BarChart07, Check, ChevronDown, ChevronRight, Columns03, DotsHorizontal, FolderClosed, FolderPlus, Globe02, Globe04, Monitor01, Plus, Server01, Settings01, Settings02, Users01 } from '@untitledui/icons';
import { createContext, Fragment, useContext, useState, type ComponentType } from 'react';
import { actorLabel, PROJECTS, positionOf, visibleProjects, type Phase } from './data.js';
import { FILTERS, GROUP_BYS, listEntries, matches, names, rowsOf, type GroupBy, type MockState, type Row, type SidebarFilter } from './model.js';
import { HoldersOrFree } from './people.js';
import { useRoles, why } from './settings/roles.js';
import { JoinProjectDialog } from './settings/projects.js';
import { useMock } from './viewer.js';

/** The rail's other icons, in this order after the Board (which leads with the needs-you count): where the work is
 * (Projects) and who does it (People), what is running (Services, Machines, Browsers), who is signed in (Sessions),
 * what it costs (Usage), then Settings, which opens the full-page Settings. */
const NAV: ReadonlyArray<{ view: string; label: string; icon: ComponentType<{ width?: number; height?: number; strokeWidth?: number }> }> = [
  { view: 'projects', label: PRODUCT_ROUTE_LABELS.projects, icon: FolderClosed }, { view: 'people', label: 'People', icon: Users01 }, { view: 'services', label: 'Services', icon: Globe04 },
  { view: 'machines', label: 'Machines', icon: Server01 }, { view: 'browsers', label: 'Browsers', icon: Globe02 }, { view: 'sessions', label: 'Sessions', icon: Monitor01 },
  { view: 'usage', label: 'Usage', icon: BarChart07 }, { view: 'settings', label: 'Settings', icon: Settings01 },
];

/** Left inset of a first-level row and of a row in a stack; the x of each tree guide line (AppSidebar's). */
export const INSET = { first: 14, stacked: 30 };
const FIRST_GUIDES: readonly number[] = [7];
const STACK_GUIDES: readonly number[] = [7, 21];
const ROW = 'relative flex w-full min-w-0 select-none flex-col gap-0.5 rounded-[10px] py-[5px] text-left outline-none transition-[opacity,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-[#6B97FF]/50';
const ArchiveGlyph = glyph(Archive);
const JoinGlyph = glyph(FolderPlus);

/** The icon rail at the top of the sidebar: exactly the Board (with the orange count of what needs you; active while
 * the board is open), then Projects, People, Services, Machines, Browsers, Sessions, Usage and Settings. */
export function NavRail({ needs, boardActive, current, onBoard, onView }: { needs: number; boardActive: boolean; current: string | null; onBoard(): void; onView(view: string): void }) {
  return <nav aria-label="Navigate" className="flex items-center justify-between gap-0.5 px-0.5">
    <Tooltip content={needs ? `Board · ${needs} need you` : 'Board'} side="bottom">
      <button type="button" aria-label={`Board, ${needs} need you`} aria-current={boardActive ? 'page' : undefined} onClick={onBoard} data-rail="board"
        className={`flex h-7 shrink-0 items-center gap-1 rounded-lg pl-1.5 pr-1 hover:bg-hover hover:text-foreground ${boardActive ? 'bg-active text-foreground' : 'text-muted-foreground'}`}>
        <Columns03 width={16} height={16} strokeWidth={1.5} />
        {needs ? <span className="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10.5px] font-semibold tabular-nums leading-none" style={{ background: STATUS_COLOR.orange, color: '#fff' }}>{needs}</span> : null}
      </button>
    </Tooltip>
    {NAV.map((item) => <Tooltip key={item.view} content={item.label} side="bottom">
      <button type="button" aria-label={item.label} data-rail={item.view} aria-current={current === item.view ? 'page' : undefined} onClick={() => onView(item.view)}
        className={`relative flex size-7 items-center justify-center rounded-lg hover:bg-hover hover:text-foreground ${current === item.view ? 'bg-active text-foreground' : 'text-muted-foreground'}`}>
        <item.icon width={16} height={16} strokeWidth={1.5} />
      </button>
    </Tooltip>)}
  </nav>;
}

/** The Project filter beside Group by: All projects, or any set of them, each with how many of its open workspaces
 * pass the state filter. */
function ProjectFilter({ rows, visible, filter, picked, onPick }: { rows: readonly Row[]; visible: ReadonlySet<string>; filter: SidebarFilter; picked: ReadonlySet<string>; onPick(next: ReadonlySet<string>): void }) {
  const projects = PROJECTS.filter((project) => !project.archived && visible.has(project.id));
  const names = projects.filter((project) => picked.has(project.id)).map((project) => project.name);
  const label = !names.length ? 'All projects' : names.length === 1 ? names[0] : `${names.length} projects`;
  const toggle = (id: string): void => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    // Every project picked is the same as none: All projects.
    onPick(next.size === projects.length ? new Set() : next);
  };
  const option = (key: string, text: string, checked: boolean, count: number, onSelect: () => void) => <button key={key} type="button" role="menuitemcheckbox" aria-checked={checked} onClick={onSelect}
    className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] text-foreground hover:bg-hover">
    <span aria-hidden className={`flex size-4 shrink-0 items-center justify-center rounded-[5px] ${checked ? 'bg-foreground text-background' : 'shadow-[inset_0_0_0_1px_var(--border)]'}`}>{checked ? <Check width={11} height={11} strokeWidth={2.5} /> : null}</span>
    <span className="min-w-0 flex-1 truncate">{text}</span>
    <span className="min-w-4 rounded-full bg-muted px-1 text-center text-[10.5px] leading-4 tabular-nums text-muted-foreground">{count}</span>
  </button>;
  return <Popover.Root modal={false}>
    <Popover.Trigger aria-label={`Project filter: ${label}`} data-project-filter=""
      className={`inline-flex max-w-44 items-center gap-1 rounded-md px-1.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-[#6B97FF]/50 data-[popup-open]:bg-active ${names.length ? 'bg-active text-foreground' : 'hover:bg-hover hover:text-foreground'}`}>
      <FolderClosed width={12} height={12} strokeWidth={1.75} className="shrink-0" /><span className="truncate">{label}</span><ChevronDown width={12} height={12} className="shrink-0 opacity-70" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50 outline-none">
        <Popover.Popup role="menu" aria-label="Projects" className="w-[220px] rounded-xl border border-border bg-background p-1 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.35)] outline-none">
          {option('all', 'All projects', !picked.size, rows.filter((row) => matches(row, filter)).length, () => onPick(new Set()))}
          <div aria-hidden className="mx-2 my-1 h-px bg-border" />
          {projects.map((project) => option(project.id, project.name, picked.has(project.id), rows.filter((row) => row.workspace.projectId === project.id && matches(row, filter)).length, () => toggle(project.id)))}
          <p className="px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">Counts follow the state filter · remembered in this browser</p>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

/** The header's filters with their counts, Group by and the Project filter. On the board they sit on one line. `rows`
 * are the open workspaces of the projects shown; `everyRow` all of them, for the Project filter's counts. */
export function FilterBar({ rows, everyRow, visible, filter, onFilter, groupBy, onGroupBy, picked, onPick, inline }: {
  rows: readonly Row[]; everyRow: readonly Row[]; visible: ReadonlySet<string>; filter: SidebarFilter; onFilter(filter: SidebarFilter): void; groupBy: GroupBy; onGroupBy(groupBy: GroupBy): void;
  picked: ReadonlySet<string>; onPick(next: ReadonlySet<string>): void; inline: boolean;
}) {
  return <div className={`flex gap-1.5 pb-1 pt-1 ${inline ? 'flex-row flex-wrap items-center gap-x-4' : 'flex-col'}`}>
    <div role="group" aria-label="Filter workspaces" className="flex flex-wrap items-center gap-1 px-2">
      {FILTERS.map((option) => {
        const pressed = option.id === filter;
        const tone = option.id === 'needs-you' ? STATUS_COLOR.orange : null;
        return <button type="button" key={option.id} aria-pressed={pressed} onClick={() => onFilter(option.id)}
          className={`inline-flex h-6 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium transition-colors duration-150 ${pressed ? 'bg-active text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'}`}>
          {tone ? <span className="size-1.5 rounded-full" style={{ background: tone }} /> : null}
          {option.label}
          <span className={`min-w-4 rounded-full px-1 text-center text-[10.5px] leading-4 tabular-nums ${pressed ? 'bg-background text-foreground' : 'bg-muted text-muted-foreground'}`}>{rows.filter((row) => matches(row, option.id)).length}</span>
        </button>;
      })}
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[11px] text-muted-foreground">
      <div role="group" aria-label="Group by" className="flex items-center gap-1">
        Group by
        {GROUP_BYS.map((option) => <button type="button" key={option.id} aria-pressed={groupBy === option.id} onClick={() => onGroupBy(option.id)}
          className={`rounded-md px-1.5 py-0.5 ${groupBy === option.id ? 'bg-active text-foreground' : 'hover:bg-hover hover:text-foreground'}`}>{option.label}</button>)}
      </div>
      <ProjectFilter rows={everyRow} visible={visible} filter={filter} picked={picked} onPick={onPick} />
    </div>
  </div>;
}

/** Orange and green counts after a project's name (AppSidebar's `StateCounts`). */
export function StateCounts({ rows }: { rows: readonly Row[] }) {
  const needs = rows.filter((row) => row.state === 'needs-you').length;
  const running = rows.filter((row) => row.state === 'running').length;
  if (!needs && !running) return null;
  return <span className="ml-1.5 inline-flex shrink-0 items-center gap-1.5 text-[11px] font-normal tabular-nums">
    {needs ? <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full" style={{ background: STATUS_COLOR.orange }} />{needs}</span> : null}
    {running ? <span className="inline-flex items-center gap-1 text-muted-foreground"><span className="size-1.5 rounded-full" style={{ background: STATUS_COLOR.green }} />{running}</span> : null}
  </span>;
}

/** What a list row's actions and clicks reach. */
export interface ListActions {
  select(row: Row): void;
  askGhost(row: Row): void;
  movePhase(row: Row, phase: Phase): void;
  say(text: string): void;
}

/** A workspace row's second line and caption, as AppSidebar's `row` composes them. */
export function rowParts(row: Row, rows: readonly Row[]) {
  const parent = row.stackedOn ? rows.find((other) => other.id === row.stackedOn) : undefined;
  const position = parent ? stackPosition(positionOf(row.workspace), parent) : null;
  const head = !parent && rows.some((other) => other.stackedOn === row.id);
  const waits = row.dependsOn.flatMap((id) => rows.find((other) => other.id === id)?.name ?? []);
  const blocked = blocks(rows, row.id).flatMap((id) => rows.find((other) => other.id === id)?.name ?? []);
  return { parent, position, head, waits, blocked };
}

/** The row's actions menu: the handle (claim, ask, take over, let go) under the viewer's role, then its Phase section
 * under the viewer's role and the phase rule, as SpaceMenu draws it. A refused item stays, greyed, with its reason. */
export function RowMenu({ row, rows, actions }: { row: Row; rows: readonly Row[]; actions: ListActions }) {
  useRoles();
  const api = useMock();
  const me = api.viewer.id;
  const projectId = row.workspace.projectId;
  const rule = (item: Row) => ({ id: item.id, name: item.name, phase: item.phase, dependsOn: item.dependsOn, relatedTo: item.relatedTo, stackedOn: item.stackedOn });
  const archived = row.workspace.archived;
  const handle: ReadonlyArray<{ label: string; reason: string | null; run(): void }> = row.mine ? [{ label: 'Let go of the handle', reason: null, run: () => api.release(row.id) }]
    : !row.holders.length ? [{ label: 'Claim the handle', reason: why(me, projectId, 'workspace.claim'), run: () => api.claim(row.id) }]
    : [
      { label: `Ask ${names(row.holders)} for the handle`, reason: row.requests.some((request) => request.from === me) ? `You asked · waiting on ${names(row.holders)}` : why(me, projectId, 'workspace.ask'), run: () => api.ask(row.id) },
      { label: 'Take over', reason: why(me, projectId, 'workspace.takeover'), run: () => api.takeOver(row.id) },
    ];
  const archiveRefusal = why(me, projectId, 'workspace.archive');
  return <DropdownMenu>
    <DropdownTrigger render={<SidebarMenuAction aria-label={`Space actions for ${row.name}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
    <DropdownContent className="min-w-[260px] w-[260px]" align="start" sideOffset={4}>
      {archived ? <MenuItem index={0} icon={glyph(Archive)} label="Restore workspace" onSelect={() => actions.say('Restore is not part of the mock')} /> : <>
        <DropdownLabel>{row.holders.length ? `Handle · ${row.holders.map((id) => actorLabel(id)).join(', ')}` : 'Handle · free'}</DropdownLabel>
        {handle.map((item, index) => <Fragment key={item.label}>
          <MenuItem index={index} label={item.label} disabled={item.reason !== null} onSelect={item.run} />
          {item.reason ? <p className="px-2 pb-1 text-[11px] text-muted-foreground">{item.reason}</p> : null}
        </Fragment>)}
        <DropdownSeparator />
        <DropdownLabel>Phase</DropdownLabel>
        <PhaseMenuItems phase={{ current: row.phase, refusal: (next) => why(me, projectId, `phase.${next}`) ?? phaseRefusal(rows.map(rule), rule(row), next), onSet: (next) => actions.movePhase(row, next) }} from={handle.length} />
        <DropdownSeparator />
        <MenuItem index={handle.length + 4} icon={ArchiveGlyph} label="Archive workspace" disabled={archiveRefusal !== null} onSelect={() => actions.say('Archive is not part of the mock')} />
        {archiveRefusal ? <p className="px-2 pb-1 text-[11px] text-muted-foreground">{archiveRefusal}</p> : null}
      </>}
    </DropdownContent>
  </DropdownMenu>;
}

function GhostAction({ row, actions }: { row: Row; actions: ListActions }) {
  return <Tooltip content={row.workspace.archived ? 'Ask a ghost · reads the archived session' : 'Ask a ghost · reads this conversation, changes nothing'} side="right">
    <SidebarMenuAction aria-label={`Ask a ghost about ${row.name}`} onClick={() => actions.askGhost(row)} style={{ color: `color-mix(in oklab, ${GHOST} 80%, var(--foreground))` }}><GhostGlyph size={15} /></SidebarMenuAction>
  </Tooltip>;
}

/** A workspace row (AppSidebar's `WorkspaceRow`): status dot and name, the stack caption and head tag, then the phase
 * pips, pull request, stack marker, planning labels and the agent's last message; volume bars under the dot; actions
 * on hover. A focused row lights what it sits on (violet) and what sits on it (teal). */
function WorkspaceRow({ row, rows, kin, selected, stacked, dimmed, archived, actions, onHover }: { row: Row; rows: readonly Row[]; kin: Relation; selected: boolean; stacked: boolean; dimmed: boolean; archived: boolean; actions: ListActions; onHover(id: string | null): void }) {
  const { summary } = row;
  const inset = stacked ? INSET.stacked : INSET.first;
  const guides = archived ? [] : stacked ? STACK_GUIDES : FIRST_GUIDES;
  const tone = kin === 'upstream' ? UPSTREAM_TONE : kin === 'downstream' ? DOWNSTREAM_TONE : null;
  const { parent, position, head, waits, blocked } = rowParts(row, rows);
  const className = `${ROW} pr-2 group-hover/menu-sub-item:pr-8 ${selected ? 'bg-active' : 'hover:bg-hover'} ${kin === 'unrelated' || dimmed ? 'opacity-40' : ''}`;
  return <SidebarMenuSubItem data-workspace={row.id} data-relation={kin}>
    <button type="button" aria-current={selected ? 'page' : undefined} title={`${row.branch} · ${summary.preview ?? ''}`} onClick={() => actions.select(row)}
      onMouseEnter={() => onHover(row.id)} onMouseLeave={() => onHover(null)} className={className} style={{ paddingLeft: inset }}>
      {guides.map((x) => <span key={x} aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-border" style={{ left: x }} />)}
      {tone ? <>
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 rounded-[10px]" style={{ left: Math.max(inset - 6, 0), background: `linear-gradient(90deg, color-mix(in oklab, ${tone} 16%, transparent), transparent 75%)` }} />
        <span aria-hidden className="pointer-events-none absolute inset-y-1 w-0.5 rounded-full" style={{ left: Math.max(inset - 6, 1), background: tone, boxShadow: `0 0 8px color-mix(in oklab, ${tone} 60%, transparent)` }} />
      </> : null}
      <span className="relative flex min-w-0 items-center gap-1.5">
        <span className="inline-flex size-4 shrink-0 items-center justify-center" data-freshness="fresh">{summary.closedAt ? <ArchiveGlyph size={14} strokeWidth={1.5} /> : <WorkspaceStatusDot space={summary} />}</span>
        <span className={`min-w-0 truncate text-body ${row.state === 'needs-you' || selected ? 'font-medium text-foreground' : 'text-foreground/90'}`}>{row.name}</span>
        {parent ? <StackCaption parent={parent.name} position={position} /> : null}
        {head && !archived ? <HeadTag /> : null}
        {archived ? null : <span className="ml-auto flex shrink-0 items-center gap-1 pl-1">
          {row.mine && row.requests.length ? <span title={`${names(row.requests.map((request) => request.from))} asked for the handle`} className="rounded-full px-1.5 text-[10px] font-medium leading-4 text-white" style={{ background: STATUS_COLOR.orange }}>{row.requests.length} ask</span> : null}
          <HoldersOrFree holders={row.holders} size={16} />
        </span>}
      </span>
      <span className="relative flex min-h-[18px] min-w-0 items-center gap-1.5 overflow-hidden pl-[22px] text-[11px] text-muted-foreground">
        <PhaseTag phase={row.phase} />
        {archived ? null : <><PrChips pulls={row.workspace.pulls} /><StackMarker position={position} ahead={null} /><LabelText waits={waits} blocks={blocked} /></>}
        {summary.preview && !summary.closedAt ? <span data-workspace-preview="" className="min-w-0 flex-1 truncate text-muted-foreground/90">{summary.preview}</span> : null}
      </span>
    </button>
    {archived ? null : <StripVolume projectId={row.workspace.projectId} strip={row.id} name={row.name} phase={row.phase} className="absolute bottom-[6px] z-10 flex" style={{ left: inset }} />}
    <SidebarMenuActions showOnHover className="top-1/2 -translate-y-1/2"><GhostAction row={row} actions={actions} /><RowMenu row={row} rows={rows} actions={actions} /></SidebarMenuActions>
  </SidebarMenuSubItem>;
}

/** A project row's gear: the project's own settings (members, inference, plugins, secrets, credentials, environment,
 * automations). */
function ProjectSettingsAction({ projectId, name }: { projectId: string; name: string }) {
  const { navigate } = useMock();
  return <Tooltip content={`${name} settings`} side="top"><SidebarMenuAction aria-label={`${name} settings`} onClick={() => navigate('project-settings', { project: projectId, page: 'members' })}><Settings02 width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction></Tooltip>;
}

const ProjectSummaryContext = createContext<SidebarSpaceSummary | undefined>(undefined);
/** Icon slots take component types, so this one stays stable while the context carries the project agent's status. */
function ProjectStatusGlyph({ className, size }: IconComponentProps) {
  const summary = useContext(ProjectSummaryContext);
  return <span className={`inline-flex items-center justify-center ${className ?? ''}`} style={{ width: size, height: size }}>{summary ? <WorkspaceStatusDot space={summary} /> : <StatusDot color="dim" />}</span>;
}

function projectSummary(color: Row['color'], archived: boolean): SidebarSpaceSummary {
  return { holder: { kind: 'cloud' }, closedAt: archived ? new Date('2026-10-01') : null, freshness: 'fresh', status: { primaryColor: color, agents: { green: color === 'green' ? 1 : 0, blue: 0, orange: 0, red: 0 }, machines: { attached: 1, online: 1, ready: 1 }, sync: { conflicts: 0, problems: 0 } } };
}

/** A project row, the hairline under it and its workspaces under the filter and grouping (AppSidebar's `ProjectRows`). */
function ProjectRows({ projectId, state, filter, groupBy, selectedId, actions, collapsed, onCollapse }: { projectId: string; state: MockState; filter: SidebarFilter; groupBy: GroupBy; selectedId: string | null; actions: ListActions; collapsed: boolean; onCollapse(open: boolean): void }) {
  const project = PROJECTS.find((candidate) => candidate.id === projectId);
  const [showArchived, setShowArchived] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  if (!project) return null;
  const rows = rowsOf(state, project.id, false);
  const archivedRows = rowsOf(state, project.id, true);
  // A hovered row with relations lights them and fades the rest; the selected one only tints its relations.
  const hoverLight = lit(rows, hovered);
  const focus = [hoverLight, lit(rows, selectedId)].find((light): light is Lit => light !== null && light.upstream.size + light.downstream.size > 0) ?? null;
  const fades = focus !== null && focus === hoverLight;
  const entries = listEntries(rows, filter, groupBy, new Set(PROJECTS.map((candidate) => candidate.id)));
  const open = !collapsed;
  return <SidebarMenuItem>
    <ProjectSummaryContext.Provider value={projectSummary(project.agentColor, project.archived)}>
      <SidebarMenuButton className={project.archived ? 'opacity-60' : undefined} icon={ProjectStatusGlyph} title={`${project.name} · project agent`} onClick={() => actions.say(`Opens ${project.name}’s project agent`)}>
        <span data-project-name="" className="min-w-0 truncate font-semibold">{project.name}</span>
        <StateCounts rows={rows} />
      </SidebarMenuButton>
    </ProjectSummaryContext.Provider>
    {project.archived ? null : <ProjectAgentVolume projectId={project.id} />}
    <SidebarMenuActions showOnHover={open}>
      <SidebarMenuAction aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`} aria-expanded={open} onClick={() => onCollapse(!open)}><ChevronRight width={16} height={16} strokeWidth={1.5} className={open ? 'rotate-90 transition-[rotate] duration-80' : 'transition-[rotate] duration-80'} /></SidebarMenuAction>
      {project.archived ? null : <Tooltip content="New workspace" side="top"><SidebarMenuAction aria-label={`New workspace in ${project.name}`} onClick={() => actions.say('New workspace is not part of the mock')}><Plus width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction></Tooltip>}
      {project.archived ? null : <ProjectSettingsAction projectId={project.id} name={project.name} />}
    </SidebarMenuActions>
    <SidebarMenuSub open={open} className="ml-0 gap-0 border-l-0 pl-1">
      <li aria-hidden className="mx-2 mb-1 mt-0.5 h-px list-none bg-foreground/15" />
      {entries.map((entry) => <Fragment key={entry.key}>
        {entry.kind === 'heading' ? <li className="list-none"><GroupHeading tone={entry.tone} count={entry.count}>{entry.label}</GroupHeading></li>
          : <WorkspaceRow row={entry.row} rows={rows} kin={relation(focus, entry.row.id) === 'unrelated' && !fades ? 'none' : relation(focus, entry.row.id)} selected={selectedId === entry.row.id} stacked={entry.stacked} dimmed={entry.dimmed} archived={false} actions={actions} onHover={setHovered} />}
      </Fragment>)}
      {rows.length && !rows.some((row) => matches(row, filter)) ? <li className="list-none px-2 py-1 text-[11px] text-muted-foreground">No workspaces match this filter</li> : null}
      {archivedRows.length ? <SidebarMenuSubItem>
        <SidebarMenuSubButton render={<button type="button" onClick={() => setShowArchived((value) => !value)} aria-expanded={showArchived} />} icon={ArchiveGlyph}>Archived</SidebarMenuSubButton>
        <SidebarMenuBadge>{archivedRows.length}</SidebarMenuBadge>
      </SidebarMenuSubItem> : null}
      {showArchived ? archivedRows.map((row) => <WorkspaceRow key={row.id} row={row} rows={archivedRows} kin="none" selected={selectedId === row.id} stacked={false} dimmed={false} archived actions={actions} onHover={() => undefined} />) : null}
    </SidebarMenuSub>
  </SidebarMenuItem>;
}

/** The Projects group: the active projects the Project filter shows, then, for an Admin, the projects they aren't in
 * with Join project, then the Archived projects fold (while no project is picked). */
export function ProjectList({ state, filter, groupBy, scope, selectedId, actions }: { state: MockState; filter: SidebarFilter; groupBy: GroupBy; scope: ReadonlySet<string>; selectedId: string | null; actions: ListActions }) {
  const { viewer } = useMock();
  const [joining, setJoining] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [openArchived, setOpenArchived] = useState<ReadonlySet<string>>(new Set());
  const fold = (id: string, open: boolean): void => setCollapsed((current) => { const next = new Set(current); if (open) next.delete(id); else next.add(id); return next; });
  const unfold = (id: string, open: boolean): void => setOpenArchived((current) => { const next = new Set(current); if (open) next.add(id); else next.delete(id); return next; });
  const active = PROJECTS.filter((project) => !project.archived && scope.has(project.id));
  const archived = PROJECTS.filter((project) => project.archived && visibleProjects(state.viewer).has(project.id));
  const joinable = viewer.accountRole === 'admin' ? PROJECTS.filter((project) => !project.archived && !visibleProjects(state.viewer).has(project.id)) : [];
  return <SidebarGroup collapsible>
    <SidebarGroupLabel>Projects</SidebarGroupLabel>
    <SidebarGroupActions>
      <Tooltip content="New project" side="top"><SidebarGroupAction aria-label="New project" onClick={() => actions.say('New project is not part of the mock')}><FolderPlus width={16} height={16} strokeWidth={1.5} /></SidebarGroupAction></Tooltip>
    </SidebarGroupActions>
    <SidebarMenu>
      {active.map((project) => <ProjectRows key={project.id} projectId={project.id} state={state} filter={filter} groupBy={groupBy} selectedId={selectedId} actions={actions} collapsed={collapsed.has(project.id)} onCollapse={(open) => fold(project.id, open)} />)}
      {joinable.map((project) => <SidebarMenuItem key={project.id} data-joinable={project.id}>
        <Tooltip content={`You’re an Admin, not a member of ${project.name}, so you don’t see its workspaces. Joining is recorded in its members and the audit log.`} side="right">
          <SidebarMenuButton icon={JoinGlyph} className="text-muted-foreground" aria-label={`Join project ${project.name}`} onClick={() => setJoining(project.id)}>
            <span className="min-w-0 truncate">{project.name}</span><span className="ml-1.5 shrink-0 text-[11px] font-normal">· not a member</span>
            <span className="ml-auto shrink-0 rounded-md px-1.5 text-[11px] font-medium leading-5 text-foreground shadow-[inset_0_0_0_1px_var(--border)]">Join project</span>
          </SidebarMenuButton>
        </Tooltip>
      </SidebarMenuItem>)}
      {archived.length ? <SidebarMenuItem>
        <SidebarMenuButton icon={ArchiveGlyph} aria-expanded={archivedOpen} onClick={() => setArchivedOpen((value) => !value)}>Archived projects</SidebarMenuButton>
        <SidebarMenuBadge>{archived.length}</SidebarMenuBadge>
      </SidebarMenuItem> : null}
      {archivedOpen ? archived.map((project) => <ProjectRows key={project.id} projectId={project.id} state={state} filter={filter} groupBy={groupBy} selectedId={selectedId} actions={actions} collapsed={!openArchived.has(project.id)} onCollapse={(open) => unfold(project.id, open)} />) : null}
    </SidebarMenu>
    {joining ? <JoinProjectDialog projectId={joining} onClose={() => setJoining(null)} /> : null}
  </SidebarGroup>;
}

