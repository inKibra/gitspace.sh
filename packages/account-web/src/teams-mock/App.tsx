// Users inside a GitSpace account, mocked on the board mock's shell. The app shell is for work and live state: its
// sidebar's rail is Board, Projects, People, Services, Machines, Browsers, Sessions, Usage and Settings; the live pages open
// beside the sidebar. Settings and a project's settings are full pages that replace the sidebar. The striped strip on
// top is the mock's own View as (not product navigation): the sidebar and board narrow to that user's projects,
// holders show on every row and card, the handle's actions follow their role (refused ones say why), and the Inbox
// holds only what is addressed to them.
import { applyAppearance, type Appearance } from '../appearance.js';
import { WorkspaceGraph } from '../WorkspaceGraph.js';
import { PHASE_LABEL } from '../GitSpaceShell.js';
import { phaseRefusal } from '../sidebar/stack-rules.js';
import { StackToasts, useStackToast } from '../sidebar/stack-toast.js';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, MenuItem, Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarProvider,
  SidebarUserFooter, Tooltip, useIcon, useSidebar,
} from '@gitspace/ui';
import { Columns03, Monitor01, Moon01, Plus, Settings01, Sun, Users01 } from '@untitledui/icons';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BoardColumns, TodayStrip, type BoardActions } from './board.js';
import { actorLabel, APPROVAL_GROUPS, ARRIVING_REQUEST, bots, CARD_ITEMS, HANDLE_REQUESTS, memberships, NOTES, notify, PROJECTS, PROMPTS, projectRoleIdOf, stepUps, TEAM, USERS, userOf, visibleProjects, WORKSPACES, type HandleRequest, type Note, type Phase, type Prompt } from './data.js';
import { UNDO_MS, workspaceName } from './inbox.js';
import { FilterBar, NavRail, ProjectList, type ListActions } from './list.js';
import { allOpenRows, decidersOf, holdersOf, inboxCount, names, rowOf, rowsOf, scopeOf, type MockState, type Row, type SidebarFilter } from './model.js';
import { MockChatter } from './parts.js';
import { Avatar } from './people.js';
import { LiveMachinesPage, LiveBrowsersPage } from './live/machines.js';
import { PeoplePage, PersonPage } from './live/people.js';
import { ProjectOverview, ProjectsGrid } from './live/projects.js';
import { ServicesPage } from './live/services.js';
import { SessionsPage } from './live/sessions.js';
import { UsagePage } from './live/usage.js';
import { ProjectSettingsPage } from './project-settings.js';
import { readRoute, writeRoute, type Route } from './routes.js';
import { SettingsPage } from './settings/index.js';
import { recordAudit } from './settings/data.js';
import { projectRoleOf, roleName, useRoles, why } from './settings/roles.js';
import { MockContext, type MockApi } from './viewer.js';
import { WorkspacePane } from './workspace.js';

/** Past this width the list's groups are columns; releasing there opens the board. */
const SNAP = 520;
/** The sidebar's own width (AppSidebar's provider: 19rem), and the narrowest the list goes. */
const NARROW = 304;
const MIN = 240;
/** The workspace's width beside the board. */
const PANE = 700;
/** The mock's own strip (View as), kept apart from the product. */
const BAR = 30;

const params = new URLSearchParams(window.location.search);
/** Where this browser remembers the Project filter. */
const PICKED_KEY = 'gitspace.mock.teamsProjects';

function readPicked(): ReadonlySet<string> {
  let stored: unknown = null;
  try { stored = JSON.parse(window.localStorage.getItem(PICKED_KEY) ?? 'null'); } catch { /* private mode or malformed */ }
  const ids: readonly unknown[] = params.has('projects') ? (params.get('projects') ?? '').split(',') : Array.isArray(stored) ? stored : [];
  return new Set(PROJECTS.filter((project) => !project.archived && ids.includes(project.id)).map((project) => project.id));
}

export function App() {
  return <MockChatter><StackToasts><Shell /></StackToasts></MockChatter>;
}

const APPEARANCE_OPTIONS: ReadonlyArray<{ id: Appearance; label: string; icon: typeof Sun }> = [{ id: 'system', label: 'Follow the system', icon: Monitor01 }, { id: 'light', label: 'Light', icon: Sun }, { id: 'dark', label: 'Dark', icon: Moon01 }];

function AppearanceSwitch({ value, onChange }: { value: Appearance; onChange(value: Appearance): void }) {
  return <div role="group" aria-label="Appearance" className="flex shrink-0 items-center rounded-lg p-0.5 shadow-[inset_0_0_0_1px_var(--border)]">
    {APPEARANCE_OPTIONS.map((option) => <Tooltip key={option.id} content={option.label} side="bottom">
      <button type="button" aria-label={option.label} aria-pressed={value === option.id} onClick={() => onChange(option.id)}
        className={`flex size-6 items-center justify-center rounded-md ${value === option.id ? 'bg-active text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'}`}><option.icon width={13} height={13} strokeWidth={1.75} /></button>
    </Tooltip>)}
  </div>;
}

/** The mock's strip, striped so it doesn't read as product navigation: which account this is, and View as (each user,
 * their account role and their project roles on hover). */
function MockBar({ viewer, onViewer, appearance, onAppearance }: { viewer: string; onViewer(id: string): void; appearance: Appearance; onAppearance(value: Appearance): void }) {
  useRoles();
  return <header data-mock-bar="" className="flex shrink-0 items-center gap-3 overflow-x-auto whitespace-nowrap border-b border-dashed border-[#dc6803]/50 px-3 text-[11px] text-[#7a4a00] [scrollbar-width:none] dark:text-[#f5c26b]"
    style={{ height: BAR, background: 'repeating-linear-gradient(-45deg, color-mix(in oklab, #fdb022 16%, transparent) 0 8px, color-mix(in oklab, #fdb022 6%, transparent) 8px 16px)' }}>
    <span className="shrink-0 rounded bg-[#fdb022] px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-wide text-[#3d2600]">Mock: view as</span>
    <div role="radiogroup" aria-label="View as" className="flex shrink-0 items-center gap-0.5">
      {USERS.map((user) => {
        const accountRole = `${user.accountRole.charAt(0).toUpperCase()}${user.accountRole.slice(1)}`;
        const projectRoles = PROJECTS.filter((project) => !project.archived).map((project) => {
          const role = projectRoleIdOf(user.id, project.id);
          return `${project.name}: ${role ? `${roleName(role)}${user.accountRole === 'owner' ? ' (as Owner)' : ''}` : 'not a member'}`;
        });
        return <Tooltip key={user.id} content={<span className="flex flex-col gap-0.5"><span className="font-medium">{user.name} · account role {accountRole}</span>{projectRoles.map((line) => <span key={line}>{line}</span>)}</span>} side="bottom">
          <button type="button" role="radio" aria-checked={viewer === user.id} data-view-as={user.id} onClick={() => onViewer(user.id)}
            className={`flex h-[22px] items-center gap-1 rounded pl-0.5 pr-1.5 ${viewer === user.id ? 'bg-[#fdb022]/35 font-semibold text-[#3d2600] dark:text-[#ffe2a8]' : 'hover:bg-[#fdb022]/20'}`}>
            <Avatar userId={user.id} size={16} />
            <span>{user.first}</span>
            <span className="opacity-70">{accountRole}</span>
          </button>
        </Tooltip>;
      })}
    </div>
    <span className="flex-1" />
    <span className="truncate opacity-80 max-xl:hidden">{TEAM.name} · {USERS.length} users · {bots.use().length} bots · not part of the product</span>
    <AppearanceSwitch value={appearance} onChange={onAppearance} />
  </header>;
}

/** The sidebar's right edge: dragged, it resizes; released past the snap width, the board opens. */
function Edge({ width, onMove, onRelease }: { width: number; onMove(width: number): void; onRelease(width: number): void }) {
  const { setIsResizing } = useSidebar();
  const [active, setActive] = useState(false);
  const start = useRef<{ x: number; width: number; last: number } | null>(null);
  const down = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width, last: width };
    setActive(true);
    setIsResizing(true);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = start.current;
    if (!drag) return;
    drag.last = Math.max(MIN, Math.min(window.innerWidth - 120, drag.width + event.clientX - drag.x));
    onMove(drag.last);
  };
  const up = (): void => {
    const drag = start.current;
    start.current = null;
    setActive(false);
    setIsResizing(false);
    if (drag) onRelease(drag.last);
  };
  return <Tooltip content={<span>Drag to resize · past {SNAP} px it opens the board <kbd className="ml-1 rounded border border-border px-1 font-mono text-[10px]">B</kbd></span>} side="right" followCursor="y" forceOpen={active ? false : undefined}>
    <div role="separator" aria-orientation="vertical" aria-label="Resize the sidebar; past the snap width it opens the board" data-edge=""
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      className={`absolute inset-y-0 right-0 z-30 w-2 cursor-col-resize touch-none after:absolute after:inset-y-0 after:right-0 after:w-px after:transition-colors after:duration-80 hover:after:bg-foreground/25 ${active ? 'after:bg-[#6B97FF]' : 'after:bg-transparent'}`} />
  </Tooltip>;
}

function Shell() {
  useRoles();
  const toast = useStackToast();
  const PanelLeft = useIcon('panel-left');
  const [route, setRoute] = useState<Route>(() => readRoute(window.location.search));
  const go = useCallback((change: Partial<Route>): void => setRoute((current) => ({ ...current, ...change })), []);
  useEffect(() => { writeRoute(route); }, [route]);
  const viewer = userOf(route.as);
  const mode = route.mode;
  const groupBy = route.group;
  const openId = route.open;
  const appearance = route.theme;
  const [viewport, setViewport] = useState(window.innerWidth);
  const [listWidth, setListWidth] = useState(() => Number(params.get('width')) || NARROW);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [filter, setFilter] = useState<SidebarFilter>('all');
  const [picked, setPicked] = useState<ReadonlySet<string>>(readPicked);
  const pick = (next: ReadonlySet<string>): void => {
    setPicked(next);
    try { window.localStorage.setItem(PICKED_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
  };
  const liveMemberships = memberships.use();
  const visible = useMemo(() => new Set([...visibleProjects(viewer.id)].filter((id) => !PROJECTS.find((project) => project.id === id)?.archived)), [viewer.id, liveMemberships]);
  const scope = scopeOf(picked, visible);
  const [phases, setPhases] = useState<Readonly<Record<string, Phase>>>({});
  const [holders, setHolders] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [requests, setRequests] = useState<readonly HandleRequest[]>(() => params.get('arrive') === 'now' ? [...HANDLE_REQUESTS, ARRIVING_REQUEST] : HANDLE_REQUESTS);
  const [notes, setNotes] = useState<readonly Note[]>(NOTES);
  const [prompts, setPrompts] = useState<readonly Prompt[]>(PROMPTS);
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [held, setHeld] = useState<ReadonlyMap<string, { label: string; at: number; about: string }>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  const [confirmGroup, setConfirmGroup] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; key: number } | null>(null);
  const state: MockState = useMemo(() => ({ viewer: viewer.id, phases, holders, requests, done, held }), [viewer.id, phases, holders, requests, done, held]);

  useEffect(() => { applyAppearance(appearance); }, [appearance]);
  useEffect(() => {
    const resize = (): void => setViewport(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3_200);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const say = useCallback((text: string): void => setNotice({ text, key: Date.now() }), []);

  // Theo's request for slot-holds arrives a moment after the mock opens (`?arrive=now` has it there already, `never`
  // keeps it away); it lands in the holders' Inboxes.
  useEffect(() => {
    const arrive = params.get('arrive');
    if (arrive === 'now' || arrive === 'never') return;
    const timer = window.setTimeout(() => setRequests((current) => current.some((request) => request.id === ARRIVING_REQUEST.id) ? current : [...current, ARRIVING_REQUEST]), Number(arrive) || 2_500);
    return () => window.clearTimeout(timer);
  }, []);

  // Held rows tick down their Undo, then send: the item is done, and a workspace with nothing left waiting runs.
  useEffect(() => {
    if (!held.size) return;
    const timer = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      const expired = [...held].filter(([, entry]) => at - entry.at >= UNDO_MS).map(([id]) => id);
      if (!expired.length) return;
      const nextDone = new Set([...done, ...expired]);
      setDone(nextDone);
      setHeld((current) => new Map([...current].filter(([id]) => !expired.includes(id))));
      const started = WORKSPACES.filter((workspace) => CARD_ITEMS.some((item) => item.workspaceId === workspace.id && expired.some((id) => id === item.id || (item.kind === 'approval-wait' && item.approval === id))))
        .filter((workspace) => rowOf({ ...state, done: nextDone, held: new Map() }, workspace).answered);
      if (started.length) toast.applied(`${started.map((workspace) => workspace.name).join(', ')} ${started.length === 1 ? 'has' : 'have'} the answer · Running`, null);
    }, 250);
    return () => window.clearInterval(timer);
  }, [held, done, state, toast]);

  const columns = mode === 'board' || (dragWidth ?? listWidth) >= SNAP;
  const boardWidth = openId ? Math.max(640, viewport - PANE) : viewport;
  const width = dragWidth ?? (mode === 'board' ? boardWidth : listWidth);
  const reflowing = dragWidth !== null && dragWidth >= SNAP && mode === 'list';
  const rows = allOpenRows(state, scope);
  const everyRow = allOpenRows(state, visible);
  const shownProjects = PROJECTS.filter((project) => !project.archived && scope.has(project.id)).length;
  // A workspace in a project the viewer can't see doesn't open for them.
  const openWorkspace = WORKSPACES.find((workspace) => workspace.id === openId && visibleProjects(viewer.id).has(workspace.projectId));
  const openRow = openWorkspace ? rowOf(state, openWorkspace) : null;
  /** A live page fills the main area beside the sidebar; Settings and project settings replace the sidebar. */
  const live = route.view !== 'work' && route.view !== 'settings' && route.view !== 'project-settings';
  const fullPage = route.view === 'settings' || route.view === 'project-settings';

  const toBoard = (): void => { go({ mode: 'board', view: 'work', page: null }); setDragWidth(null); };
  const toList = (): void => { go({ mode: 'list', view: 'work', page: null, open: openId ?? 'slot-holds' }); setListWidth(NARROW); setDragWidth(null); };
  const setHoldersOf = (workspaceId: string, next: (current: readonly string[]) => readonly string[]): void =>
    setHolders((current) => ({ ...current, [workspaceId]: next(current[workspaceId] ?? WORKSPACES.find((workspace) => workspace.id === workspaceId)?.holders ?? []) }));
  const movePhase = (row: Row, phase: Phase): void => {
    const refusedByRole = why(viewer.id, row.workspace.projectId, `phase.${phase}`);
    if (refusedByRole) { toast.refused(new Error(refusedByRole), 'Change phase'); return; }
    const project = rowsOf(state, row.workspace.projectId, false);
    const rule = (item: Row) => ({ id: item.id, name: item.name, phase: item.phase, dependsOn: item.dependsOn, relatedTo: item.relatedTo, stackedOn: item.stackedOn });
    const refusedByStack = phaseRefusal(project.map(rule), rule(row), phase);
    if (refusedByStack) { toast.refused(new Error(refusedByStack), 'Change phase'); return; }
    const previous = row.phase;
    setPhases((current) => ({ ...current, [row.id]: phase }));
    toast.applied(`${viewer.first} moved ${row.name} to ${PHASE_LABEL[phase]}`, async () => { setPhases((current) => ({ ...current, [row.id]: previous })); });
  };
  const resolve = (id: string, label: string, about: string): void => { const at = Date.now(); setNow(at); setHeld((current) => new Map(current).set(id, { label, at, about: workspaceName(about) })); };

  const api: MockApi = {
    viewer, state, say,
    navigate: (view, extra) => go(view === 'settings' ? { view, page: extra?.page ?? 'profile', person: extra?.person ?? null }
      : view === 'project-settings' ? { view, project: extra?.project ?? 'crumb', page: extra?.page ?? 'members' }
      : view === 'project' ? { view, project: extra?.project ?? 'crumb', page: null }
      : view === 'person' ? { view, person: extra?.person ?? viewer.id, page: null }
      : { view, page: extra?.page ?? null }),
    open: (workspaceId) => go({ open: workspaceId, view: 'work', page: null }),
    claim: (workspaceId) => { setHoldersOf(workspaceId, () => [viewer.id]); say(`You hold ${workspaceName(workspaceId)} · your machines, browser, connections and model credentials join it`); },
    ask: (workspaceId) => {
      setRequests((current) => [...current, { id: `hr-${viewer.id}-${workspaceId}`, workspaceId, from: viewer.id, since: 0, note: '' }]);
      say(`Asked ${names(decidersOf(state, workspaceId))} for ${workspaceName(workspaceId)} · it’s in their Inbox; nothing changes until one of them answers`);
    },
    takeOver: (workspaceId) => {
      const was = holdersOf(state, workspaceId);
      setHoldersOf(workspaceId, () => [viewer.id]);
      setRequests((current) => current.filter((request) => request.workspaceId !== workspaceId));
      say(`You took over ${workspaceName(workspaceId)} from ${names(was)} · they’re told; their own resources detach, running processes keep going`);
    },
    assign: (workspaceId, userId) => { setHoldersOf(workspaceId, (current) => [...current, userId]); say(`${userOf(userId).first} now holds ${workspaceName(workspaceId)} · assigned by ${viewer.first}; they’re told in their Inbox`); },
    release: (workspaceId) => {
      const rest = holdersOf(state, workspaceId).filter((id) => id !== viewer.id);
      const dropped = stepUps.get().filter((entry) => entry.workspaceId === workspaceId && entry.userId === viewer.id);
      stepUps.set(stepUps.get().filter((entry) => !dropped.includes(entry)));
      setHoldersOf(workspaceId, (current) => current.filter((id) => id !== viewer.id));
      say(`You let go of ${workspaceName(workspaceId)} · your machine and connections detach (processes keep running)${dropped.length ? ` · cleared shell for ${dropped.map((entry) => entry.credential).join(', ')} closed` : ''}${rest.length ? ` · ${names(rest)} still hold it` : ' · it’s free'}`);
    },
    acceptRequest: (requestId, acceptMode) => {
      const request = requests.find((candidate) => candidate.id === requestId);
      if (!request) return;
      setHoldersOf(request.workspaceId, (current) => acceptMode === 'add' ? [...current, request.from] : [...current.filter((id) => id !== viewer.id), request.from]);
      setRequests((current) => current.filter((candidate) => candidate.id !== requestId));
      toast.applied(acceptMode === 'add' ? `${viewer.first} gave ${userOf(request.from).first} the handle on ${workspaceName(request.workspaceId)} · they hold it together` : `${viewer.first} handed ${workspaceName(request.workspaceId)} to ${userOf(request.from).first}`, null);
    },
    declineRequest: (requestId) => {
      const request = requests.find((candidate) => candidate.id === requestId);
      setRequests((current) => current.filter((candidate) => candidate.id !== requestId));
      if (request) say(`Declined · ${userOf(request.from).first} is told; they can still leave notes`);
    },
  };

  const actions: BoardActions & ListActions = {
    select: (row) => go({ open: row.id, view: 'work', page: null }),
    askGhost: (row) => say(`A ghost of ${row.name} opens: it reads the conversation and changes nothing`),
    movePhase,
    say,
    resolve,
    undo: (id) => setHeld((current) => { const next = new Map(current); next.delete(id); return next; }),
    open: (workspaceId) => go({ open: workspaceId, view: 'work', page: null }),
    approveAll: setConfirmGroup,
    askWhy: (workspaceId) => say(`A ghost of ${workspaceName(workspaceId)} opens at the question: why did the agent ask this?`),
  };

  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, [role="dialog"]'))) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'b' || event.key === 'B') { event.preventDefault(); if (mode === 'board') toList(); else toBoard(); }
      if (event.key === 'Escape' && mode === 'board') go({ open: null });
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const confirm = APPROVAL_GROUPS.find((group) => group.id === confirmGroup);
  const confirmEntries = confirm ? confirm.entries.filter((entry) => !done.has(entry.id) && !held.has(entry.id)) : [];
  const confirmProject = PROJECTS.find((project) => project.id === confirm?.projectId)?.name ?? '';
  const count = inboxCount(state, visible);

  return <MockContext.Provider value={api}>
    <div className="flex h-dvh flex-col">
      <MockBar viewer={viewer.id} onViewer={(id) => go({ as: id })} appearance={appearance} onAppearance={(theme) => go({ theme })} />
      {fullPage ? <div className="gitspace-shell flex min-h-0 flex-col" style={{ height: `calc(100dvh - ${BAR}px)` }}>
        {route.view === 'settings' ? <SettingsPage page={route.page} person={route.person} navigate={(page, person) => go({ view: 'settings', page, person: person ?? null })} onBack={() => go({ view: 'work', page: null, person: null })} />
          : <ProjectSettingsPage project={route.project ?? 'crumb'} section={route.page ?? 'members'} onProject={(project) => go({ project })} onSection={(page) => go({ page })} onBack={() => go({ view: 'project', page: null })} />}
      </div> : <SidebarProvider className="gitspace-shell min-h-0" style={{ height: `calc(100dvh - ${BAR}px)` }} persist={false} width={`${live ? NARROW : width}px`}>
        <Sidebar variant="inset" rail={false}>
          {live ? null : <Edge width={width} onMove={setDragWidth} onRelease={(released) => {
            if (released >= SNAP) { go({ mode: 'board' }); setDragWidth(null); return; }
            go({ mode: 'list', open: openId ?? 'slot-holds' }); setListWidth(released); setDragWidth(null);
          }} />}
          <SidebarHeader>
            <div className={`flex items-center gap-3 ${columns && !live ? '' : 'relative'}`}>
              <div className={columns && !live ? 'w-[264px] shrink-0' : 'min-w-0 flex-1'}><NavRail needs={count} boardActive={mode === 'board' && !live} current={live ? (route.view === 'project' ? 'projects' : route.view === 'person' ? 'people' : route.view) : null} onBoard={toBoard}
                onView={(view) => go(view === 'settings' ? { view: 'settings', page: 'profile', person: null } : view === 'projects' || view === 'people' || view === 'services' || view === 'machines' || view === 'browsers' || view === 'sessions' || view === 'usage' ? { view, page: null } : {})} /></div>
              {columns && !live ? <>
                <span className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-foreground"><Columns03 width={15} height={15} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />Board<span className="truncate text-[12px] font-normal text-muted-foreground">· {rows.length} {rows.length === 1 ? 'workspace' : 'workspaces'} in {shownProjects} {shownProjects === 1 ? 'project' : 'projects'}</span></span>
                {mode === 'board' ? <div role="group" aria-label="Board view" className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  {[{ graph: false, label: 'Columns' }, { graph: true, label: 'Graph' }].map((option) => <button key={option.label} type="button" aria-pressed={route.graph === option.graph} onClick={() => go({ graph: option.graph })}
                    className={`rounded-md px-1.5 py-0.5 ${route.graph === option.graph ? 'bg-active text-foreground' : 'hover:bg-hover hover:text-foreground'}`}>{option.label}</button>)}
                </div> : null}
                <Tooltip content="New project" side="bottom"><Button variant="ghost" size="icon-compact" aria-label="New project" onClick={() => api.navigate('projects', { page: 'new' })}><Plus width={16} height={16} strokeWidth={1.75} /></Button></Tooltip>
                <span className="flex-1" />
                {reflowing ? <span className="shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-medium text-white" style={{ background: '#6B97FF' }}>Release to open the board</span>
                  : mode === 'board' && !openRow ? <Tooltip content="Sidebar view" side="bottom"><Button variant="ghost" size="icon-compact" aria-label="Sidebar view" onClick={toList}><PanelLeft /></Button></Tooltip> : null}
              </> : null}
            </div>
          </SidebarHeader>
          {columns && !live ? <div className="flex min-h-0 flex-1 flex-col">
            <FilterBar rows={rows} everyRow={everyRow} visible={visible} filter={filter} onFilter={setFilter} groupBy={groupBy} onGroupBy={(group) => go({ group })} picked={picked} onPick={pick} inline />
            {mode === 'board' ? <TodayStrip key={openId ? 'beside' : 'whole'} state={state} scope={scope} defaultOpen={!openId} /> : <div className="h-1" />}
            {mode === 'board' && route.graph ? <div data-board-graph="" className="min-h-0 flex-1 px-2 pb-2">
              <WorkspaceGraph height="100%" selectedId={openId} onSelect={(id) => go({ open: id })}
                workspaces={rows.map((row) => ({ id: row.id, projectId: row.workspace.projectId, projectName: PROJECTS.find((project) => project.id === row.workspace.projectId)?.name ?? row.workspace.projectId,
                  name: row.name, branch: row.branch, phase: row.phase, relations: { dependsOn: row.dependsOn, relatedTo: row.relatedTo, stackedOn: row.stackedOn },
                  closedAt: null, holder: row.summary.holder, status: row.summary.status, freshness: row.summary.freshness }))} />
            </div> : <BoardColumns state={state} groupBy={groupBy} filter={filter} scope={scope} held={held} now={now} selectedId={mode === 'board' ? openId : null} actions={actions} />}
          </div> : <>
            <SidebarContent>
              <FilterBar rows={rows} everyRow={everyRow} visible={visible} filter={filter} onFilter={setFilter} groupBy={groupBy} onGroupBy={(group) => go({ group })} picked={picked} onPick={pick} inline={false} />
              <ProjectList state={state} filter={filter} groupBy={groupBy} scope={scope} selectedId={live ? null : openId} actions={actions} />
            </SidebarContent>
            <SidebarFooter>
              <SidebarUserFooter className="min-w-0" name={viewer.name} avatar={<Avatar userId={viewer.id} size={20} />}
                menu={<>
                  <MenuItem index={0} icon={({ size }) => <Settings01 width={size} height={size} />} label="Settings" onSelect={() => api.navigate('settings', { page: 'profile' })} />
                  <MenuItem index={1} icon={({ size }) => <Users01 width={size} height={size} />} label="People & roles" onSelect={() => api.navigate('settings', { page: 'people' })} />
                </>} />
            </SidebarFooter>
          </>}
        </Sidebar>
        <SidebarInset className={`min-w-0 overflow-hidden transition-opacity duration-150 ${reflowing ? 'opacity-45' : ''} ${mode === 'board' && !openRow && !live ? 'hidden' : ''}`}>
          {route.view === 'people' ? <PeoplePage />
            : route.view === 'person' ? <PersonPage key={`${route.person}:${viewer.id}`} personId={route.person ?? viewer.id} />
            : route.view === 'projects' ? <ProjectsGrid key={`${viewer.id}:${route.page ?? ''}`} creating={route.page === 'new'} />
            : route.view === 'project' ? <ProjectOverview key={route.project} projectId={route.project ?? 'crumb'} />
            : route.view === 'services' ? <ServicesPage />
            : route.view === 'machines' ? <LiveMachinesPage key={route.page ?? ''} adding={route.page === 'add'} />
            : route.view === 'browsers' ? <LiveBrowsersPage />
            : route.view === 'sessions' ? <SessionsPage />
            : route.view === 'usage' ? <UsagePage />
            : openRow ? <WorkspacePane key={openRow.id} row={openRow} rows={rowsOf(state, openRow.workspace.projectId, false)} board={mode === 'board'} done={done} held={held} now={now}
              notes={notes.filter((note) => note.workspaceId === openRow.id)} prompts={prompts.filter((prompt) => prompt.workspaceId === openRow.id)}
              onNote={(text) => { setNotes((current) => [...current, { id: `n-${Date.now()}`, workspaceId: openRow.id, from: viewer.id, since: 0, text, state: 'open' }]); say(`Note left beside the composer · ${names(openRow.holders) || 'a holder'} can send it to the agent`); }}
              onSendNote={(note) => {
                setNotes((current) => current.map((candidate) => candidate.id === note.id ? { ...candidate, state: 'sent', by: viewer.id } : candidate));
                setPrompts((current) => [...current, { id: `p-${note.id}`, workspaceId: openRow.id, from: viewer.id, minutesAgo: 0, text: note.text, via: note.from }]);
                say(`Sent ${actorLabel(note.from)}’s note to the agent as ${viewer.first}`);
              }}
              onDismissNote={(note) => {
                setNotes((current) => current.map((candidate) => candidate.id === note.id ? { ...candidate, state: 'dismissed', by: viewer.id } : candidate));
                notify({ to: note.from, from: viewer.id, text: `${viewer.first} dismissed your note in ${openRow.name}`, detail: `“${note.text}”` });
                say(`Dismissed ${actorLabel(note.from)}’s note · they see “Dismissed by ${viewer.first}”`);
              }}
              onEditNote={(note, text) => { setNotes((current) => current.map((candidate) => candidate.id === note.id ? { ...candidate, text, edited: true } : candidate)); say('Note edited'); }}
              onDeleteNote={(note) => {
                setNotes((current) => current.filter((candidate) => candidate.id !== note.id));
                if (note.from === viewer.id) { say('Note deleted · it leaves no trace'); return; }
                recordAudit({ actor: viewer.id, kind: 'comment', project: openRow.workspace.projectId, text: `Deleted ${actorLabel(note.from)}’s note in ${openRow.name} as ${projectRoleOf(viewer.id, openRow.workspace.projectId)?.name}: “${note.text}”` });
                say(`Deleted ${actorLabel(note.from)}’s note · it’s in the audit log`);
              }}
              onPrompt={(text) => setPrompts((current) => [...current, { id: `p-${Date.now()}`, workspaceId: openRow.id, from: viewer.id, minutesAgo: 0, text }])}
              onAnswer={(id, label) => actions.resolve(id, label, openRow.id)} onUndo={actions.undo} onMovePhase={(phase) => movePhase(openRow, phase)}
              onExpand={toList} onClose={() => go({ open: null })} onAskGhost={() => actions.askGhost(openRow)} />
              : openId && !openWorkspace ? <p className="m-auto max-w-sm text-center text-[13px] text-muted-foreground">{viewer.first} isn’t in this workspace’s project. Members see only the projects they’re added to.</p> : null}
        </SidebarInset>

        <Dialog open={confirm !== undefined} onOpenChange={(open) => { if (!open) setConfirmGroup(null); }}>
          <DialogContent size="lg">
            <DialogHeader>
              <DialogTitle>Approve {confirmEntries.length} for {confirmProject}?</DialogTitle>
              <DialogDescription>Each runs, or opens, in every {confirmProject} workspace that declares it, now and later, until its content changes. Agents waiting on them continue at once. Recorded as approved by {viewer.name}.</DialogDescription>
            </DialogHeader>
            <ul className="flex flex-col divide-y divide-border">
              {confirmEntries.map((entry) => <li key={entry.id} className="flex flex-col gap-0.5 py-2">
                <span className="text-[13px] font-medium text-foreground">{entry.file} <span className="font-mono text-[11px] text-muted-foreground">#{entry.hash}</span></span>
                <span className="text-[12px] text-muted-foreground">{entry.kindLabel} · {[entry.declared.base ? `on ${entry.declared.base}` : null, entry.declared.workspaces.length ? `in ${entry.declared.workspaces.join(', ')}` : null].filter(Boolean).join(' and ')}</span>
              </li>)}
            </ul>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setConfirmGroup(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => { for (const entry of confirmEntries) actions.resolve(entry.id, `Approved for ${confirmProject} by ${viewer.first}`, entry.file); setConfirmGroup(null); }}>Approve {confirmEntries.length} for {confirmProject}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

      </SidebarProvider>}
      {notice ? <div key={notice.key} role="status" data-notice="" className="pointer-events-none fixed bottom-14 left-1/2 z-50 max-w-[640px] -translate-x-1/2 rounded-xl bg-foreground px-3.5 py-2 text-center text-[12px] text-background shadow-lg">{notice.text}</div> : null}
    </div>
  </MockContext.Provider>;
}
