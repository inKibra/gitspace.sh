export type AppView = 'agent' | 'kanban' | 'projects' | 'plugins' | 'skills' | 'crons' | 'secrets' | 'inbox';
export type ProductRoute = AppView | 'settings';

const PATH_BY_ROUTE: Record<ProductRoute, string> = {
  agent: '/',
  kanban: '/kanban',
  projects: '/projects',
  plugins: '/plugins',
  skills: '/skills',
  crons: '/crons',
  secrets: '/secrets',
  inbox: '/inbox',
  settings: '/settings',
};
const ROUTE_BY_PATH: Record<string, ProductRoute> = Object.fromEntries(Object.entries(PATH_BY_ROUTE).map(([route, path]) => [path, route as ProductRoute]));

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

export const ACCOUNT_DIRECTORY_CHANGED = 'gitspace:account-directory-changed';
