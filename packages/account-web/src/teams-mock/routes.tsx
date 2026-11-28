// The mock's routes, all in the query string so every screen has a link: `as` (View as), `view` (work, one of the live
// pages people | person | projects | project | services | machines | browsers | sessions | usage, or one of the full
// pages settings | project-settings), `page` (a settings page, a project-settings section, or `add` on Machines),
// `person` (whose page on the People page, or which bot under Settings › Bots), `project` (the project overview or
// project settings), `mode` (list | board), `group`, `open` (a workspace), `projects`, `theme`. Pages read their own
// extra parameters (`tab`, `ptab`, `profile`, `who`).
import type { Appearance } from '../appearance.js';
import { USERS } from './data.js';
import type { GroupBy } from './model.js';

/** Live pages sit beside the app sidebar; full pages replace it. */
export type LiveView = 'people' | 'person' | 'projects' | 'project' | 'services' | 'machines' | 'browsers' | 'sessions' | 'usage';
export type View = 'work' | LiveView | 'settings' | 'project-settings';
const VIEWS: readonly View[] = ['work', 'people', 'person', 'projects', 'project', 'services', 'machines', 'browsers', 'sessions', 'usage', 'settings', 'project-settings'];

export interface Route {
  as: string;
  view: View;
  page: string | null;
  person: string | null;
  project: string | null;
  mode: 'list' | 'board';
  group: GroupBy;
  open: string | null;
  /** The whole board shows the workspace graph instead of columns (`board=graph`). */
  graph: boolean;
  theme: Appearance;
}

const GROUPS: Readonly<Record<string, GroupBy>> = { state: 'state', phase: 'phase', project: 'project' };
const THEMES: Readonly<Record<string, Appearance>> = { system: 'system', light: 'light', dark: 'dark' };

export function readRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const as = params.get('as') ?? 'maya';
  const mode = params.get('mode') === 'board' ? 'board' : 'list';
  return {
    as: USERS.some((user) => user.id === as) ? as : 'maya',
    view: VIEWS.find((view) => view === params.get('view')) ?? 'work',
    page: params.get('page'),
    person: params.get('person'),
    project: params.get('project'),
    mode,
    group: GROUPS[params.get('group') ?? ''] ?? 'state',
    open: params.has('open') ? (params.get('open') || null) : mode === 'board' ? null : 'slot-holds',
    graph: mode === 'board' && params.get('board') === 'graph',
    theme: THEMES[params.get('theme') ?? ''] ?? 'system',
  };
}

/** Keeps the address bar on the current route without a reload (other parameters, like `projects`, stay). */
export function writeRoute(route: Route): void {
  const params = new URLSearchParams(window.location.search);
  const set = (key: string, value: string | null): void => { if (value === null) params.delete(key); else params.set(key, value); };
  set('as', route.as);
  set('view', route.view === 'work' ? null : route.view);
  set('page', route.page);
  set('person', route.view === 'settings' || route.view === 'person' ? route.person : null);
  set('project', route.view === 'project' || route.view === 'project-settings' ? route.project : null);
  set('mode', route.mode);
  set('group', route.group);
  set('open', route.open ?? '');
  set('board', route.mode === 'board' && route.graph ? 'graph' : null);
  set('theme', route.theme === 'system' ? null : route.theme);
  window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
}
