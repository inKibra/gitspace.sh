import { stackTree, type WorkspaceStatusColor } from '@gitspace/protocol-workspace';
import { sidebarWorkspaceSummary, type SidebarSpaceSummary, type SidebarWorkspace } from '../AppSidebar.js';
import { PHASE_LABEL, PHASES, STATUS_COLOR, workspaceStatusColor, type WorkspaceView } from '../GitSpaceShell.js';
import type { ProjectGraph } from './project-graph.js';
import type { ChainWorkspace } from './StackChain.js';

export type SidebarFilter = 'all' | 'needs-you' | 'running' | 'review' | 'ship';
/** How the list nests a project's rows and how the board makes its columns. Project: the list's plain tree; the board's
 * column per project. */
export type SidebarGroupBy = 'project' | 'state' | 'phase';
/** A row's state for filters and Group by State: its status colour read as what it asks of you. */
export type RowState = 'needs-you' | 'failed' | 'running' | 'waiting' | 'idle';
export const STATE_OF: Record<WorkspaceStatusColor, RowState> = { orange: 'needs-you', red: 'failed', green: 'running', blue: 'waiting', dim: 'idle' };
export const STATE_LABEL: Record<RowState, string> = { 'needs-you': 'Needs you', failed: 'Failed', running: 'Running', waiting: 'Waiting', idle: 'Idle' };
export const STATE_COLOR: Record<RowState, WorkspaceStatusColor> = { 'needs-you': 'orange', failed: 'red', running: 'green', waiting: 'blue', idle: 'dim' };
export const STATE_ORDER: readonly RowState[] = ['needs-you', 'failed', 'running', 'waiting', 'idle'];
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
 * (null for the others and for Phase unknown). */
export interface RowGroup { key: string; label: string; tone: string | undefined; phase: WorkspaceView['phase'] | null; holds(item: RowItem): boolean }

export function stateGroups(): RowGroup[] {
  return STATE_ORDER.map((state) => ({ key: state, label: STATE_LABEL[state], tone: STATUS_COLOR[STATE_COLOR[state]], phase: null, holds: (item: RowItem) => item.state === state }));
}

/** Phase groups: the list nests them from Ship down, the board's columns run Plan to Ship. Phase unknown follows while
 * any of `items` has no phase. */
export function phaseGroups(order: 'list' | 'board', items: readonly RowItem[]): RowGroup[] {
  const phases = order === 'list' ? [...PHASES].reverse() : PHASES;
  const groups: RowGroup[] = phases.map((phase) => ({ key: phase, label: PHASE_LABEL[phase], tone: undefined, phase, holds: (item: RowItem) => item.phase === phase }));
  return items.some((item) => item.phase === null) ? [...groups, { key: 'unknown', label: 'Phase unknown', tone: undefined, phase: null, holds: (item: RowItem) => item.phase === null }] : groups;
}

/** What a project lists: a group heading, or a row (faded when it is only there to keep its stack whole). `key` names
 * the entry a landing preview follows. */
export type Entry = { kind: 'heading'; key: string; label: string; tone: string | undefined; count: number } | { kind: 'row'; key: string; item: RowItem; stacked: boolean; dimmed: boolean };

/**
 * A project's rows under a filter and a grouping. Every grouping draws stacks whole, as the tree draws them: a stack shows
 * while any of it matches, the rest faded. State and Phase put each stack under its head's group; a heading counts the
 * project's workspaces whose own state or phase is the heading's and that pass the filter, wherever their stack is drawn,
 * so it agrees with the filter tabs.
 */
export function listEntries(items: readonly RowItem[], filter: SidebarFilter, groupBy: SidebarGroupBy): Entry[] {
  const shown = runsOf(items).filter((run) => run.some(({ item }) => matches(item, filter)));
  const rows = (run: Run) => run.map(({ item, stacked }): Entry => ({ kind: 'row', key: item.id, item, stacked, dimmed: !matches(item, filter) }));
  if (groupBy === 'project') return shown.flatMap(rows);
  const groups = groupBy === 'state' ? stateGroups() : phaseGroups('list', items);
  return groups.flatMap((group): Entry[] => {
    const held = shown.filter((run) => run[0] && group.holds(run[0].item));
    if (!held.length) return [];
    const count = items.filter((item) => group.holds(item) && matches(item, filter)).length;
    return [{ kind: 'heading', key: `heading-${group.key}`, label: group.label, tone: group.tone, count }, ...held.flatMap(rows)];
  });
}
