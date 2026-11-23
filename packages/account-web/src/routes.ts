export type AppView = 'agent' | 'board' | 'projects' | 'inference' | 'plugins' | 'skills' | 'automations' | 'secrets' | 'monitoring';
export type ProductRoute = AppView | 'settings';

export const PRODUCT_ROUTE_LABELS: Record<ProductRoute, string> = {
  agent: 'Workspace',
  board: 'Board',
  projects: 'Projects',
  inference: 'Inference',
  plugins: 'Plugins',
  skills: 'Skills',
  automations: 'Automations',
  secrets: 'Secrets & values',
  monitoring: 'Monitoring',
  settings: 'Account settings',
};

/** A page that leaves the workspace selection behind. The board keeps it: the workspace opens beside it. */
export function isGlobalView(route: ProductRoute): route is Exclude<AppView, 'agent' | 'board'> {
  return route !== 'agent' && route !== 'board' && route !== 'settings';
}

const PATH_BY_ROUTE: Record<ProductRoute, string> = {
  agent: '/',
  board: '/board',
  projects: '/projects',
  inference: '/inference',
  plugins: '/plugins',
  skills: '/skills',
  automations: '/automations',
  secrets: '/secrets',
  monitoring: '/monitoring',
  settings: '/settings',
};
const ROUTE_BY_PATH: Record<string, ProductRoute> = Object.fromEntries(Object.entries(PATH_BY_ROUTE).map(([route, path]) => [path, route as ProductRoute]));

/** The project chosen on the Automations page; absent, it shows every project. */
export const AUTOMATIONS_PROJECT_PARAM = 'for';
/** The run whose detail the Automations page opens. */
export const AUTOMATIONS_RUN_PARAM = 'run';
/** How the board groups its columns: `state`, `phase` or `project`. */
export const BOARD_GROUP_PARAM = 'group';
/** The projects the board's Project filter picked, comma-separated; absent, this browser's last pick. */
export const BOARD_PROJECTS_PARAM = 'projects';
/** `graph`: the board shows the account's workspace graph in place of its columns. */
export const BOARD_VIEW_PARAM = 'show';

export function productRouteFromLocation(location: Pick<Location, 'pathname' | 'search'>): ProductRoute {
  const pathname = location.pathname.length > 1 ? location.pathname.replace(/\/+$/, '') : location.pathname;
  const params = new URLSearchParams(location.search);
  if (pathname === '/' && (params.get('view') === 'settings' || params.get('gallery') === 'settings')) return 'settings';
  const stableRoute = ROUTE_BY_PATH[pathname];
  if (stableRoute !== undefined) return stableRoute;
  return 'agent';
}

export function setProductRoute(url: URL, route: ProductRoute): URL {
  url.pathname = PATH_BY_ROUTE[route];
  url.searchParams.delete('view');
  url.searchParams.delete('gallery');
  if (route !== 'settings') url.searchParams.delete('mode');
  if (route !== 'inference') url.searchParams.delete('profile');
  if (route !== 'plugins') { url.searchParams.delete('tab'); url.searchParams.delete('pair'); url.searchParams.delete('manage'); }
  if (route !== 'automations') { url.searchParams.delete(AUTOMATIONS_PROJECT_PARAM); url.searchParams.delete(AUTOMATIONS_RUN_PARAM); }
  if (route !== 'board') { url.searchParams.delete(BOARD_GROUP_PARAM); url.searchParams.delete(BOARD_PROJECTS_PARAM); url.searchParams.delete(BOARD_VIEW_PARAM); }
  if (isGlobalView(route)) {
    url.searchParams.delete('project');
    url.searchParams.delete('workspace');
  }
  return url;
}

/** Plugins → Browsers, where Chromes are paired and approved per project; `pairFor` opens the pairing dialog with
 * that project chosen. */
export function browserPluginsUrl(pairFor?: string): URL {
  const url = setProductRoute(new URL(window.location.href), 'plugins');
  url.searchParams.set('tab', 'browsers');
  if (pairFor) url.searchParams.set('pair', pairFor);
  return url;
}

/** Automations with `projectId` chosen in its header, or every project when null; `runId` opens that run's detail. */
export function automationsUrl(projectId: string | null, runId: string | null = null): URL {
  const url = setProductRoute(new URL(window.location.href), 'automations');
  if (projectId) url.searchParams.set(AUTOMATIONS_PROJECT_PARAM, projectId);
  else url.searchParams.delete(AUTOMATIONS_PROJECT_PARAM);
  if (runId) url.searchParams.set(AUTOMATIONS_RUN_PARAM, runId);
  else url.searchParams.delete(AUTOMATIONS_RUN_PARAM);
  return url;
}

export function productPath(route: ProductRoute): string {
  return PATH_BY_ROUTE[route];
}

/** Same-document navigation; subscribers also handle the browser's Back/Forward. */
export function navigateProductUrl(url: URL, mode: 'push' | 'replace' = 'push'): void {
  if (mode === 'push' && url.href === window.location.href) return;
  window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Shows a project's agent view: one of its workspaces, or the project agent's when `workspaceId` is null. */
export function selectInspection(projectId: string, workspaceId: string | null): void {
  const url = new URL(window.location.href);
  url.searchParams.set('project', projectId);
  if (workspaceId) url.searchParams.set('workspace', workspaceId);
  else url.searchParams.delete('workspace');
  navigateProductUrl(setProductRoute(url, 'agent'));
}

export const ACCOUNT_DIRECTORY_CHANGED = 'gitspace:account-directory-changed';
