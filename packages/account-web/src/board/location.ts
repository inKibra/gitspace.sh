import { BOARD_GROUP_PARAM, BOARD_PROJECTS_PARAM, BOARD_VIEW_PARAM, navigateProductUrl, setProductRoute } from '../routes.js';
import { GROUP_BYS, type SidebarGroupBy } from '../sidebar/rows.js';

/** The board as its URL says it: the grouping and the picked projects (null: the URL names none), and whether it shows
 * the graph. */
export interface BoardLocation { group: SidebarGroupBy | null; projects: readonly string[] | null; graph: boolean }

/** What the board shows: its grouping, the picked projects (none: all) and the graph or the columns. */
export interface BoardState { group: SidebarGroupBy; projects: readonly string[]; graph: boolean }

export function readBoardLocation(url: Pick<URL, 'searchParams'>): BoardLocation {
  const params = url.searchParams;
  const projects = params.get(BOARD_PROJECTS_PARAM);
  return {
    group: GROUP_BYS.find((option) => option.id === params.get(BOARD_GROUP_PARAM))?.id ?? null,
    projects: projects === null ? null : projects.split(',').filter(Boolean),
    graph: params.get(BOARD_VIEW_PARAM) === 'graph',
  };
}

function withBoard(url: URL, state: BoardState): URL {
  url.searchParams.set(BOARD_GROUP_PARAM, state.group);
  if (state.projects.length) url.searchParams.set(BOARD_PROJECTS_PARAM, state.projects.join(','));
  else url.searchParams.delete(BOARD_PROJECTS_PARAM);
  if (state.graph) url.searchParams.set(BOARD_VIEW_PARAM, 'graph');
  else url.searchParams.delete(BOARD_VIEW_PARAM);
  return url;
}

/** Opens the board as `state` says; the workspace on screen stays open beside it. */
export function openBoard(state: BoardState): void {
  navigateProductUrl(withBoard(setProductRoute(new URL(window.location.href), 'board'), state));
}

/** Rewrites the open board's grouping, project pick or view, in place. */
export function setBoard(state: BoardState): void {
  navigateProductUrl(withBoard(new URL(window.location.href), state), 'replace');
}

/** Folds the board back to the list with `open` open: the workspace that was beside the board, the last one opened, or
 * the first on the board (null: none, the list alone). */
export function foldBoard(open: { projectId: string; workspaceId: string } | null): void {
  const url = setProductRoute(new URL(window.location.href), 'agent');
  if (open) {
    url.searchParams.set('project', open.projectId);
    url.searchParams.set('workspace', open.workspaceId);
  }
  navigateProductUrl(url);
}

/** Opens a workspace beside the board. */
export function openBeside(projectId: string, workspaceId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('project', projectId);
  url.searchParams.set('workspace', workspaceId);
  navigateProductUrl(url);
}

/** Closes the workspace beside the board: the whole board again. */
export function closeBeside(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('project');
  url.searchParams.delete('workspace');
  navigateProductUrl(url);
}

const PICKED_KEY = 'gitspace.sidebar.projects';

/** The projects this browser's Project filter last picked; missing, malformed or unreadable storage picks none. */
export function readPicked(): readonly string[] {
  if (typeof window === 'undefined') return [];
  let parsed: unknown = null;
  try { parsed = JSON.parse(window.localStorage.getItem(PICKED_KEY) ?? 'null'); } catch { /* private mode or malformed */ }
  return Array.isArray(parsed) ? parsed.filter((id: unknown): id is string => typeof id === 'string') : [];
}

export function storePicked(projects: readonly string[]): void {
  try { window.localStorage.setItem(PICKED_KEY, JSON.stringify(projects)); } catch { /* private mode */ }
}
