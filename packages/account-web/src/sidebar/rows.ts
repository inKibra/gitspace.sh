import { stackTree, type WorkspaceStatusColor } from '@gitspace/protocol-workspace';
import { sidebarWorkspaceSummary, type SidebarSpaceSummary, type SidebarWorkspace } from '../AppSidebar.js';
import { PHASE_LABEL, PHASES, STATUS_COLOR, workspaceStatusColor, type WorkspaceView } from '../GitSpaceShell.js';
import type { ProjectGraph } from './project-graph.js';
import type { ChainWorkspace } from './StackChain.js';

export type SidebarFilter = 'all' | 'needs-you' | 'running' | 'review' | 'ship';
/** How the list nests a project's rows and how the board makes its columns. Project: the list's plain tree; the board's
 * column per project. */
export type SidebarGroupBy = 'project' | 'state' | 'phase';
/** A row's state for filters and Group by State: its status colour read as what it asks of you. A workspace with
 * nothing to show (archived, released, never reported) waits. */
export type RowState = 'needs-you' | 'failed' | 'running' | 'waiting';
export const STATE_OF: Record<WorkspaceStatusColor, RowState> = { orange: 'needs-you', red: 'failed', green: 'running', blue: 'waiting', dim: 'waiting' };
export const STATE_LABEL: Record<RowState, string> = { 'needs-you': 'Needs you', failed: 'Failed', running: 'Running', waiting: 'Waiting' };
export const STATE_COLOR: Record<RowState, WorkspaceStatusColor> = { 'needs-you': 'orange', failed: 'red', running: 'green', waiting: 'blue' };
export const STATE_ORDER: readonly RowState[] = ['needs-you', 'failed', 'running', 'waiting'];
export const FILTERS: readonly { id: SidebarFilter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'needs-you', label: 'Needs you' }, { id: 'running', label: 'Running' }, { id: 'review', label: 'Review' }, { id: 'ship', label: 'Ship' }];
export const GROUP_BYS: readonly { id: SidebarGroupBy; label: string }[] = [{ id: 'project', label: 'Project' }, { id: 'state', label: 'State' }, { id: 'phase', label: 'Phase' }];

/** An open workspace as its row, the board's card, the stack chain and the phase rule read it: its relations, as the
 * account directory holds them (`known` once listed there), and its branch's position against its parent and whether it
 * is ahead of that parent, as the project view last published them. */
export interface RowItem extends ChainWorkspace { workspace: SidebarWorkspace; summary: SidebarSpaceSummary | undefined; state: RowState; phase: WorkspaceView['phase'] | null; relatedTo: readonly string[]; aheadOfParent: string | null; known: boolean }

export function rowItem(workspace: SidebarWorkspace, graph: ProjectGraph | undefined): RowItem {
  const summary = sidebarWorkspaceSummary(workspace);
  const relations = graph?.relations[workspace.id];
  return {
    id: workspace.id, name: workspace.name, branch: workspace.branch, dependsOn: relations?.dependsOn ?? [], relatedTo: relations?.relatedTo ?? [], stackedOn: relations?.stackedOn ?? null,
    position: relations?.position ?? null, aheadOfParent: relations?.aheadOfParent ?? null, known: relations !== undefined,
    status: summary, workspace, summary, state: STATE_OF[summary ? workspaceStatusColor(summary) : 'dim'], phase: workspace.definition?.phase ?? workspace.phase ?? null,
  };
}

export function relationsOf(item: RowItem): WorkspaceView['relations'] {
  return { dependsOn: item.dependsOn, relatedTo: item.relatedTo, stackedOn: item.stackedOn };
}

export function matches(item: RowItem, filter: SidebarFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'needs-you' || filter === 'running') return item.state === filter;
  return item.phase === filter;
}

/** A top-level row and its whole stack, in the tree's order: drawn together wherever the stack shows. */
export type Run = readonly { item: RowItem; stacked: boolean }[];

export function runsOf(items: readonly RowItem[]): Run[] {
  const runs: { item: RowItem; stacked: boolean }[][] = [];
  for (const entry of stackTree(items)) {
    if (!entry.stacked || !runs.length) runs.push([entry]);
    else runs.at(-1)?.push(entry);
  }
  return runs;
}

/** A group of a grouping: a heading in a project's list, a column on the board. `phase`: the phase a Phase group sets
 * (null for the others and for Phase unknown). `order`: how its stacks are ordered, by their heads (null: the tree's
 * order). */
export interface RowGroup { key: string; label: string; tone: string | undefined; phase: WorkspaceView['phase'] | null; holds(item: RowItem): boolean; order: ((a: RowItem, b: RowItem) => number) | null }

/** Orders by a time of each row, oldest or newest first; a row without one goes last. */
function byTime(timeOf: (item: RowItem) => Date | null | undefined, newest: boolean): (a: RowItem, b: RowItem) => number {
  return (a, b) => {
    const left = timeOf(a)?.getTime();
    const right = timeOf(b)?.getTime();
    if (left === undefined || right === undefined) return left === undefined ? right === undefined ? 0 : 1 : -1;
    return newest ? right - left : left - right;
  };
}

/** Needs you: what has waited longest first (its oldest open item, else since it began to need you). The others: the
 * latest change first. */
const STATE_ORDERING: Record<RowState, (a: RowItem, b: RowItem) => number> = {
  'needs-you': byTime((item) => item.summary?.waitingSince ?? item.summary?.stateSince, false),
  failed: byTime((item) => item.summary?.stateSince, true),
  running: byTime((item) => item.summary?.stateSince, true),
  waiting: byTime((item) => item.summary?.stateSince, true),
};

export function stateGroups(): RowGroup[] {
  return STATE_ORDER.map((state) => ({ key: state, label: STATE_LABEL[state], tone: STATUS_COLOR[STATE_COLOR[state]], phase: null, holds: (item: RowItem) => item.state === state, order: STATE_ORDERING[state] }));
}

/** A group's stacks in its order, by their heads; a sort keeps the tree's order among equals. */
export function ordered(runs: readonly Run[], group: RowGroup): readonly Run[] {
  const order = group.order;
  return order ? [...runs].sort((a, b) => a[0] && b[0] ? order(a[0].item, b[0].item) : 0) : runs;
}

/** Phase groups: the list nests them from Ship down, the board's columns run Plan to Ship. Phase unknown follows while
 * any of `items` has no phase. */
export function phaseGroups(order: 'list' | 'board', items: readonly RowItem[]): RowGroup[] {
  const phases = order === 'list' ? [...PHASES].reverse() : PHASES;
  const groups: RowGroup[] = phases.map((phase) => ({ key: phase, label: PHASE_LABEL[phase], tone: undefined, phase, holds: (item: RowItem) => item.phase === phase, order: null }));
  return items.some((item) => item.phase === null) ? [...groups, { key: 'unknown', label: 'Phase unknown', tone: undefined, phase: null, holds: (item: RowItem) => item.phase === null, order: null }] : groups;
}

/** What a project lists: a group heading (`group`: its group's key; `collapsed`: its rows hidden), or a row (faded when
 * it is only there to keep its stack whole). `key` names the entry a landing preview follows. */
export type Entry = { kind: 'heading'; key: string; group: string; label: string; tone: string | undefined; count: number; collapsed: boolean } | { kind: 'row'; key: string; item: RowItem; stacked: boolean; dimmed: boolean };

/**
 * A project's rows under a filter and a grouping. Every grouping draws stacks whole, as the tree draws them: a stack shows
 * while any of it matches, the rest faded. State and Phase put each stack under its head's group; a heading counts the
 * project's workspaces whose own state or phase is the heading's and that pass the filter, wherever their stack is drawn,
 * so it agrees with the filter tabs. A group in `collapsed` lists its heading, with its count, and none of its rows.
 */
export function listEntries(items: readonly RowItem[], filter: SidebarFilter, groupBy: SidebarGroupBy, collapsed: ReadonlySet<string>): Entry[] {
  const shown = runsOf(items).filter((run) => run.some(({ item }) => matches(item, filter)));
  const rows = (run: Run) => run.map(({ item, stacked }): Entry => ({ kind: 'row', key: item.id, item, stacked, dimmed: !matches(item, filter) }));
  if (groupBy === 'project') return shown.flatMap(rows);
  const groups = groupBy === 'state' ? stateGroups() : phaseGroups('list', items);
  return groups.flatMap((group): Entry[] => {
    const held = ordered(shown.filter((run) => run[0] && group.holds(run[0].item)), group);
    if (!held.length) return [];
    const count = items.filter((item) => group.holds(item) && matches(item, filter)).length;
    const folded = collapsed.has(group.key);
    return [{ kind: 'heading', key: `heading-${group.key}`, group: group.key, label: group.label, tone: group.tone, count, collapsed: folded }, ...folded ? [] : held.flatMap(rows)];
  });
}

/** The groups folded away, per grouping: State's and Phase's are kept apart. Project grouping folds projects instead. */
export type CollapsedGroups = Readonly<Record<'state' | 'phase', readonly string[]>>;

const COLLAPSED_GROUPS_KEY = 'gitspace.sidebar.collapsedGroups';

/** The groups this browser folded away; missing, malformed or unreadable storage folds none. */
export function readCollapsedGroups(): CollapsedGroups {
  if (typeof window === 'undefined') return { state: [], phase: [] };
  let parsed: unknown = null;
  try { parsed = JSON.parse(window.localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? 'null'); } catch { /* private mode or malformed */ }
  const keys = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((key: unknown): key is string => typeof key === 'string') : [];
  return parsed !== null && typeof parsed === 'object' ? { state: keys(Reflect.get(parsed, 'state')), phase: keys(Reflect.get(parsed, 'phase')) } : { state: [], phase: [] };
}

export function storeCollapsedGroups(groups: CollapsedGroups): void {
  try { window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(groups)); } catch { /* private mode */ }
}
