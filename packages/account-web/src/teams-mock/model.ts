// The board's reading of the mock account as one user sees it: each workspace's row as the sidebar reads it (its live
// colour once its waiting items are answered, its holders), the sidebar's grouping and filters, and what that user's
// Inbox holds: only what is addressed to them.
import { stackTree, type WorkspaceStatusColor } from '@gitspace/protocol-workspace';
import { PHASE_LABEL, PHASES, STATUS_COLOR } from '../GitSpaceShell.js';
import type { SidebarSpaceSummary } from '../AppSidebar.js';
import {
  ACCOUNT_ITEMS, APPROVAL_GROUPS, CARD_ITEMS, PROJECTS, WORKSPACES, principalOf, projectRoleIdOf, statusSummary, USERS,
  type AccountItem, type ApprovalEntry, type CardItem, type HandleRequest, type MockWorkspace, type Phase,
} from './data.js';
import { why } from './settings/roles.js';
import { pendingRecipients, promptRecipients } from './flows/scripts-rules.js';

export type SidebarFilter = 'all' | 'needs-you' | 'mine' | 'free' | 'review' | 'ship';
/** The list always nests under projects: Project there is the real sidebar's None. */
export type GroupBy = 'project' | 'state' | 'phase';
export type RowState = 'needs-you' | 'failed' | 'running' | 'waiting';

export const STATE_OF: Record<WorkspaceStatusColor, RowState> = { orange: 'needs-you', red: 'failed', green: 'running', blue: 'waiting', dim: 'waiting' };
export const STATE_LABEL: Record<RowState, string> = { 'needs-you': 'Needs you', failed: 'Failed', running: 'Running', waiting: 'Waiting' };
export const STATE_COLOR: Record<RowState, WorkspaceStatusColor> = { 'needs-you': 'orange', failed: 'red', running: 'green', waiting: 'blue' };
export const STATE_ORDER: readonly RowState[] = ['needs-you', 'failed', 'running', 'waiting'];
export const FILTERS: readonly { id: SidebarFilter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'needs-you', label: 'Needs you' }, { id: 'mine', label: 'Mine' }, { id: 'free', label: 'Free' }, { id: 'review', label: 'Review' }, { id: 'ship', label: 'Ship' }];
export const GROUP_BYS: readonly { id: GroupBy; label: string }[] = [{ id: 'project', label: 'Project' }, { id: 'state', label: 'State' }, { id: 'phase', label: 'Phase' }];

/** What the people have done to the mock: who is looking, phases moved, holders changed, handle requests open, items
 * sent (`done`) and items held for Undo (`held`). */
export interface MockState {
  viewer: string;
  phases: Readonly<Record<string, Phase>>;
  holders: Readonly<Record<string, readonly string[]>>;
  requests: readonly HandleRequest[];
  done: ReadonlySet<string>;
  held: ReadonlyMap<string, { label: string; at: number }>;
}

/** An open workspace as its row reads it for the viewer. */
export interface Row {
  id: string;
  name: string;
  branch: string;
  workspace: MockWorkspace;
  phase: Phase;
  state: RowState;
  color: WorkspaceStatusColor;
  summary: SidebarSpaceSummary;
  dependsOn: readonly string[];
  relatedTo: readonly string[];
  stackedOn: string | null;
  /** Answered since the mock loaded: the agent works on the answer. */
  answered: boolean;
  holders: readonly string[];
  /** The viewer holds the handle. */
  mine: boolean;
  /** Open requests for its handle. */
  requests: readonly HandleRequest[];
}

export function holdersOf(state: MockState, workspaceId: string): readonly string[] {
  return state.holders[workspaceId] ?? WORKSPACES.find((workspace) => workspace.id === workspaceId)?.holders ?? [];
}

/** The account's Owners and Admins: account rows (machines, paused objects) go to them. */
const ACCOUNT_STAFF: readonly string[] = USERS.filter((user) => user.accountRole === 'owner' || user.accountRole === 'admin').map((user) => user.id);

/** "Maya and Rina", "Deps bot": people by first name, bots by name. */
export function names(ids: readonly string[]): string {
  const firsts = ids.map((id) => principalOf(id).first);
  return firsts.length <= 2 ? firsts.join(' and ') : `${firsts.slice(0, -1).join(', ')} and ${firsts.at(-1)}`;
}

/** Who answers a request for a workspace's handle: its holders, with a bot holder's sponsor in the bot's place (a bot
 * acts only over MCP and answers no one). */
export function decidersOf(state: MockState, workspaceId: string): readonly string[] {
  return [...new Set(holdersOf(state, workspaceId).flatMap((id) => {
    const principal = principalOf(id);
    return principal.kind === 'person' ? [id] : principal.sponsor ? [principal.sponsor] : [];
  }))];
}

/** Who a workspace item goes to: an agent's question, plan, problem or wait goes to its holders' Inboxes (to the
 * users whose project role may assign holders while it is free); a mention to whoever was named. */
export function recipientsOf(state: MockState, item: CardItem): readonly string[] {
  if (item.kind === 'mention') return [item.to];
  const holders = holdersOf(state, item.workspaceId);
  if (holders.length) return holders;
  const projectId = WORKSPACES.find((workspace) => workspace.id === item.workspaceId)?.projectId ?? '';
  return USERS.map((user) => user.id).filter((id) => why(id, projectId, 'workspace.assign') === null);
}

/** An environment approval goes to every user whose role may approve it in its project. */
export function approversOf(entry: ApprovalEntry): readonly string[] {
  return USERS.map((user) => user.id).filter((id) => why(id, entry.projectId, 'environment.approve') === null);
}

/** An account row goes to Owners and Admins, to the people it names (a project's Leads for a failed automation run),
 * and to the holders of the workspaces it stops. An environment proposal goes to the project's Leads only; a
 * machine-profile proposal to Owners and Admins only. A bot's
 * request to use its own secret goes to the bot's current sponsor only. A script waiting for approval goes to whoever
 * may approve it for the scope it is requested for (none once no version is pending). */
export function accountRecipients(state: MockState, item: AccountItem): readonly string[] {
  if (item.kind === 'profile-proposal') return ACCOUNT_STAFF;
  if (item.kind === 'environment' && item.projectId) {
    const projectId = item.projectId;
    return USERS.filter((user) => projectRoleIdOf(user.id, projectId) === 'lead').map((user) => user.id);
  }
  if (item.kind === 'bot-secret') {
    const bot = item.bot ? principalOf(item.bot) : null;
    const sponsor = bot?.kind === 'bot' ? bot.sponsor : null;
    return sponsor ? [sponsor] : [];
  }
  if (item.kind === 'script') return item.run ? promptRecipients(item.run, (id) => holdersOf(state, id)) : item.script ? pendingRecipients(item.script, (id) => holdersOf(state, id)) : [];
  return [...new Set([...ACCOUNT_STAFF, ...(item.to ?? []), ...item.workspaces.flatMap((id) => holdersOf(state, id))])];
}

/** The approvals and items a workspace's agent waits on that are still open (held ones included: Undo can bring them
 * back). */
export function openItems(state: MockState, workspaceId: string): readonly CardItem[] {
  return CARD_ITEMS.filter((item) => item.workspaceId === workspaceId && !state.done.has(item.id) && !(item.kind === 'approval-wait' && state.done.has(item.approval)));
}

/** The open items addressed to the viewer. */
export function myItems(state: MockState, workspaceId: string): readonly CardItem[] {
  return openItems(state, workspaceId).filter((item) => recipientsOf(state, item).includes(state.viewer));
}

function counted(item: CardItem): boolean {
  return item.kind !== 'mention';
}

export function rowOf(state: MockState, workspace: MockWorkspace): Row {
  const waiting = CARD_ITEMS.filter((item) => item.workspaceId === workspace.id && counted(item));
  const answered = waiting.length > 0 && openItems(state, workspace.id).filter(counted).length === 0;
  const color: WorkspaceStatusColor = answered ? 'green' : workspace.color;
  const holders = holdersOf(state, workspace.id);
  const mine = holders.includes(state.viewer);
  const requests = state.requests.filter((request) => request.workspaceId === workspace.id);
  // Orange means an agent waits on a person; it needs the viewer only when the wait is addressed to them.
  const forMe = myItems(state, workspace.id).some(counted) || (mine && requests.length > 0);
  const base = STATE_OF[color];
  const rowState: RowState = base === 'needs-you' ? (forMe ? 'needs-you' : 'waiting') : forMe ? 'needs-you' : base;
  const waitingOn = base === 'needs-you' && !forMe ? `Waiting on ${holders.length ? names(holders) : 'a Lead'} · ` : '';
  const preview = answered ? 'Working on the answer…' : `${waitingOn}${workspace.preview}`;
  return {
    id: workspace.id, name: workspace.name, branch: workspace.branch, workspace, phase: state.phases[workspace.id] ?? workspace.phase,
    state: rowState, color, answered, holders, mine, requests,
    summary: { holder: { kind: 'cloud' }, closedAt: workspace.archived ? new Date('2026-11-01') : null, status: statusSummary(color), freshness: 'fresh', preview },
    dependsOn: workspace.dependsOn, relatedTo: workspace.relatedTo, stackedOn: workspace.stackedOn,
  };
}

export function rowsOf(state: MockState, projectId: string, archived: boolean): Row[] {
  return WORKSPACES.filter((workspace) => workspace.projectId === projectId && workspace.archived === archived).map((workspace) => rowOf(state, workspace));
}

/** The projects the viewer sees, narrowed by the Project filter's pick (none picked is every visible one). */
export function scopeOf(picked: ReadonlySet<string>, visible: ReadonlySet<string>): ReadonlySet<string> {
  const narrowed = [...picked].filter((id) => visible.has(id));
  return narrowed.length ? new Set(narrowed) : visible;
}

export function allOpenRows(state: MockState, scope: ReadonlySet<string>): Row[] {
  return PROJECTS.filter((project) => !project.archived && scope.has(project.id)).flatMap((project) => rowsOf(state, project.id, false));
}

export function matches(row: Row, filter: SidebarFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'needs-you') return row.state === filter;
  if (filter === 'mine') return row.mine;
  if (filter === 'free') return row.holders.length === 0;
  return row.phase === filter;
}

/** A run of rows the tree draws together: a top-level row and its whole stack. */
export type Run = readonly { row: Row; stacked: boolean }[];

export function runsOf(rows: readonly Row[]): Run[] {
  const runs: { row: Row; stacked: boolean }[][] = [];
  for (const entry of stackTree(rows)) {
    const placed = { row: entry.item, stacked: entry.stacked };
    if (!entry.stacked || !runs.length) runs.push([placed]);
    else runs.at(-1)?.push(placed);
  }
  return runs;
}

export interface Group { key: string; label: string; tone: string | undefined; color: WorkspaceStatusColor | null; holds(row: Row): boolean }

/** The groups of a grouping, in the order the list and the board show them. The list nests Phase from Ship down, as
 * the sidebar does; the board's columns run Plan to Ship. */
export function groupsOf(groupBy: GroupBy, board: boolean, scope: ReadonlySet<string>): Group[] {
  if (groupBy === 'state') return STATE_ORDER.map((state) => ({ key: state, label: STATE_LABEL[state], tone: STATUS_COLOR[STATE_COLOR[state]], color: STATE_COLOR[state], holds: (row: Row) => row.state === state }));
  if (groupBy === 'phase') return (board ? [...PHASES] : [...PHASES].reverse()).map((phase) => ({ key: phase, label: PHASE_LABEL[phase], tone: undefined, color: null, holds: (row: Row) => row.phase === phase }));
  return PROJECTS.filter((project) => !project.archived && scope.has(project.id)).map((project) => ({ key: project.id, label: project.name, tone: undefined, color: null, holds: (row: Row) => row.workspace.projectId === project.id }));
}

/** What a project lists under a filter and a grouping, as AppSidebar's `listEntries`. */
export type Entry = { kind: 'heading'; key: string; label: string; tone: string | undefined; count: number } | { kind: 'row'; key: string; row: Row; stacked: boolean; dimmed: boolean };

export function listEntries(rows: readonly Row[], filter: SidebarFilter, groupBy: GroupBy, scope: ReadonlySet<string>): Entry[] {
  const shown = runsOf(rows).filter((run) => run.some(({ row }) => matches(row, filter)));
  const entries = (run: Run): Entry[] => run.map(({ row, stacked }) => ({ kind: 'row', key: row.id, row, stacked, dimmed: !matches(row, filter) }));
  if (groupBy === 'project') return shown.flatMap(entries);
  return groupsOf(groupBy, false, scope).flatMap((group): Entry[] => {
    const held = shown.filter((run) => run[0] && group.holds(run[0].row));
    if (!held.length) return [];
    const count = rows.filter((row) => group.holds(row) && matches(row, filter)).length;
    return [{ kind: 'heading', key: `heading-${group.key}`, label: group.label, tone: group.tone, count }, ...held.flatMap(entries)];
  });
}

/** The approvals the viewer may decide, in `scope`. */
export function myApprovals(state: MockState, scope: ReadonlySet<string>): ApprovalEntry[] {
  return APPROVAL_GROUPS.flatMap((group) => group.entries).filter((entry) => scope.has(entry.projectId) && approversOf(entry).includes(state.viewer));
}

/** The account rows addressed to the viewer, in `scope`. */
export function myAccountItems(state: MockState, scope: ReadonlySet<string>): AccountItem[] {
  return ACCOUNT_ITEMS.filter((item) => !state.done.has(item.id) && (item.projectId === null || scope.has(item.projectId)) && accountRecipients(state, item).includes(state.viewer));
}

/** Handle requests the viewer holds the handle for (they decide), in `scope`. */
export function myRequests(state: MockState, scope: ReadonlySet<string>): HandleRequest[] {
  return state.requests.filter((request) => {
    const workspace = WORKSPACES.find((candidate) => candidate.id === request.workspaceId);
    return workspace !== undefined && scope.has(workspace.projectId) && !state.done.has(request.id) && decidersOf(state, request.workspaceId).includes(state.viewer);
  });
}

/** What the viewer's Inbox badge counts in `scope`: their open, counted items (questions, plans, problems), handle
 * requests, approvals their role may decide, and account rows addressed to them. Mentions are listed, never counted. */
export function inboxCount(state: MockState, scope: ReadonlySet<string>): number {
  const open = (id: string): boolean => !state.done.has(id) && !state.held.has(id);
  const cards = WORKSPACES.filter((workspace) => scope.has(workspace.projectId) && !workspace.archived)
    .flatMap((workspace) => myItems(state, workspace.id)).filter((item) => counted(item) && item.kind !== 'approval-wait' && open(item.id)).length;
  const approvals = myApprovals(state, scope).filter((entry) => open(entry.id)).length;
  const account = myAccountItems(state, scope).filter((item) => open(item.id)).length;
  const requests = myRequests(state, scope).filter((request) => open(request.id)).length;
  return cards + approvals + account + requests;
}
