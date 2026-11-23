import type { LinkedPullRequest } from '../sidebar/project-graph.js';
import { matches, ordered, phaseGroups, runsOf, stateGroups, type RowGroup, type RowItem, type Run, type SidebarFilter, type SidebarGroupBy } from '../sidebar/rows.js';

/** A project's open workspaces as the board reads them, and the pull requests linked to each. */
export interface BoardProject { id: string; name: string; items: readonly RowItem[]; pullRequests: Readonly<Record<string, readonly LinkedPullRequest[]>> }

/** One project's piles in a column: each stack whole, under its head's column. `count`: the project's workspaces whose
 * own state or phase is the column's and that pass the filter. */
export interface BoardSection { project: BoardProject; count: number; runs: readonly Run[] }

/** A column: its group, the workspaces it counts and its sections, project by project. */
export interface BoardColumn { group: RowGroup; count: number; sections: readonly BoardSection[] }

/** The board's columns for a grouping and a filter: State's five, Phase's four (and Phase unknown while any workspace
 * has none), or one per project. A stack shows while any of it passes the filter, whole, in its head's column. */
export function boardColumns(projects: readonly BoardProject[], groupBy: SidebarGroupBy, filter: SidebarFilter): BoardColumn[] {
  const groups: RowGroup[] = groupBy === 'state' ? stateGroups()
    : groupBy === 'phase' ? phaseGroups('board', projects.flatMap((project) => project.items))
      : projects.map((project) => ({ key: project.id, label: project.name, tone: undefined, phase: null, holds: (item: RowItem) => item.workspace.projectId === project.id, order: null }));
  const piles = projects.map((project) => ({ project, runs: runsOf(project.items).filter((run) => run.some(({ item }) => matches(item, filter))) }));
  return groups.map((group) => {
    const sections = piles.flatMap(({ project, runs }): BoardSection[] => {
      const held = ordered(runs.filter((run) => run[0] && group.holds(run[0].item)), group);
      return held.length ? [{ project, runs: held, count: project.items.filter((item) => group.holds(item) && matches(item, filter)).length }] : [];
    });
    return { group, sections, count: projects.reduce((total, project) => total + project.items.filter((item) => group.holds(item) && matches(item, filter)).length, 0) };
  });
}
