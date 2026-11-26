// @vitest-environment happy-dom
import type { WorkspacePhase, WorkspaceStatusColor } from '@gitspace/protocol-workspace';
import { SidebarProvider } from '@gitspace/ui';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { AppSidebar, type AppSidebarProps, type SidebarProject, type SidebarWorkspace } from '../AppSidebar.js';
import { navigateProductUrl, productRouteFromLocation } from '../routes.js';
import type { GraphRelations } from '../sidebar/project-graph.js';

// The Inbox's rows are InboxRows' to test: here they mark where they render. The factory runs before the file's static
// imports, so it loads React itself.
vi.mock('../inbox/index.js', async () => {
  const { createContext } = await import('react');
  return {
    InboxSourcesContext: createContext({}),
    AccountRows: () => null,
    InboxRows: ({ workspaceId }: { workspaceId: string }) => <div data-inbox-rows={workspaceId} />,
    // The rail's badge reads the Inbox's count, not the number of orange workspaces (3 in these rows).
    useInboxCount: () => 7,
    useWaitingSummary: () => null,
  };
});

let root: Root;
let container: HTMLDivElement;
let panelWidth = 304;
let shownProjects: readonly SidebarProject[] = [];
let onSetPhase: Mock<NonNullable<AppSidebarProps['onSetPhase']>>;
let onSelectWorkspace: Mock<AppSidebarProps['onSelectWorkspace']>;

function status(color: WorkspaceStatusColor) {
  return { primaryColor: color, agents: { green: color === 'green' ? 1 : 0, blue: 0, orange: color === 'orange' ? 1 : 0, red: color === 'red' ? 1 : 0 }, machines: { attached: 1, online: 1, ready: 1 }, sync: { conflicts: 0, problems: 0 } };
}

interface Spec { id: string; phase: WorkspacePhase; color: WorkspaceStatusColor; stackedOn?: string; dependsOn?: readonly string[]; stateSince?: string; waitingSince?: string }

function project(id: string, name: string, specs: readonly Spec[]): SidebarProject {
  const workspaces: SidebarWorkspace[] = specs.map((spec) => ({ id: spec.id, projectId: id, name: spec.id, branch: `feature/${spec.id}`, closedAt: null, phase: spec.phase,
    summary: { holder: { kind: 'cloud' }, closedAt: null, freshness: 'fresh', status: status(spec.color), preview: `${spec.id} is at work`,
      stateSince: spec.stateSince ? new Date(spec.stateSince) : null, waitingSince: spec.waitingSince ? new Date(spec.waitingSince) : null } }));
  const relations = Object.fromEntries(specs.map((spec): [string, GraphRelations] => [spec.id, { dependsOn: spec.dependsOn ?? [], relatedTo: [], stackedOn: spec.stackedOn ?? null, position: null, aheadOfParent: null }]));
  return { id, name, lifecycle: 'active', workspaces, graph: { baseBranch: 'main', relations, pullRequests: {} } };
}

const PROJECTS: readonly SidebarProject[] = [
  project('crumb', 'Crumb', [
    { id: 'slot-holds', phase: 'code', color: 'orange' },
    { id: 'slot-picker-ui', phase: 'code', color: 'green', stackedOn: 'slot-holds' },
    { id: 'loyalty-stamps', phase: 'plan', color: 'orange' },
    { id: 'menu-cache', phase: 'review', color: 'blue' },
    { id: 'allergen-labels', phase: 'review', color: 'dim', dependsOn: ['menu-cache'] },
    { id: 'checkout', phase: 'ship', color: 'red' },
  ]),
  project('ledger', 'Ledger', [
    { id: 'invoice-pdf', phase: 'code', color: 'green' },
    { id: 'bank-feed', phase: 'code', color: 'orange' },
  ]),
];

/** The account frame's part the board needs: the sidebar, its route and the workspace open, from the URL. */
function Frame() {
  const [href, setHref] = useState(window.location.href);
  useEffect(() => {
    const changed = (): void => setHref(window.location.href);
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);
  const url = new URL(href);
  const route = productRouteFromLocation(url);
  const projectId = url.searchParams.get('project');
  return <SidebarProvider persist={false} width="19rem">
    <AppSidebar view={route === 'settings' ? 'agent' : route} onView={() => undefined} selected={projectId ? { projectId, workspaceId: url.searchParams.get('workspace') } : null}
      projects={shownProjects} machines={[]} onSelectWorkspace={onSelectWorkspace} onSetPhase={onSetPhase} />
  </SidebarProvider>;
}

async function show(path: string): Promise<void> {
  window.history.replaceState(null, '', path);
  await act(() => root.render(<Frame />));
  await act(() => navigateProductUrl(new URL(path, window.location.origin), 'replace'));
}

function location(): URL {
  return new URL(window.location.href);
}

function column(key: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-column="${key}"]`);
  if (!found) throw new Error(`No column ${key}`);
  return found;
}

function cards(key: string): string[] {
  return [...column(key).querySelectorAll<HTMLElement>('[data-card]')].map((card) => card.dataset.card ?? '');
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent === label);
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

async function drag(target: Element, from: number, to: number): Promise<void> {
  await act(() => { target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: from, clientY: 10, button: 0, pointerId: 1 })); });
  await act(() => { target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: to, clientY: 10, pointerId: 1 })); });
}

async function release(target: Element, at: number): Promise<void> {
  await act(() => { target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: at, clientY: 10, pointerId: 1 })); });
}

async function key(name: string): Promise<void> {
  await act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })); });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('innerWidth', 1440);
  if (!Element.prototype.getAnimations) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: () => undefined });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return this.dataset.slot === 'sidebar' ? panelWidth : 0; } });
  panelWidth = 304;
  shownProjects = PROJECTS;
  onSetPhase = vi.fn(async () => undefined);
  onSelectWorkspace = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture');
  vi.unstubAllGlobals();
});

it('reflows the list into columns past the snap width, opens the board on release, and narrows back to the list', async () => {
  await show('/?project=crumb&workspace=slot-holds');
  const edge = container.querySelector('[data-sidebar-edge]');
  if (!edge) throw new Error('No sidebar edge');
  await drag(edge, 300, 450);
  expect(container.querySelector('[data-column]')).toBeNull();
  await act(() => { edge.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 600, clientY: 10, pointerId: 1 })); });
  // The list's grouping (Project here) is the columns'.
  expect(cards('crumb')).toContain('slot-holds');
  expect(container.textContent).toContain('Release to open the board');
  expect(location().pathname).toBe('/');
  await release(edge, 600);
  expect(location().pathname).toBe('/board');
  // The workspace on screen stays open, beside the board.
  expect(location().searchParams.get('workspace')).toBe('slot-holds');

  panelWidth = 900;
  await drag(edge, 900, 400);
  await release(edge, 400);
  expect(location().pathname).toBe('/');
  expect(location().searchParams.get('workspace')).toBe('slot-holds');
  expect(container.querySelector('[data-column]')).toBeNull();
});

it('closes the workspace beside the board when the divider is dragged to the window edge', async () => {
  await show('/board?group=state&project=crumb&workspace=slot-holds');
  panelWidth = 740;
  const edge = container.querySelector('[data-sidebar-edge]');
  if (!edge) throw new Error('No sidebar edge');
  await drag(edge, 740, 1000);
  await release(edge, 1000);
  expect(location().pathname).toBe('/board');
  expect(location().searchParams.get('workspace')).toBe('slot-holds');
  await drag(edge, 740, 1400);
  await release(edge, 1400);
  expect(location().pathname).toBe('/board');
  expect(location().searchParams.has('workspace')).toBe(false);
  expect(location().searchParams.has('project')).toBe(false);
});

it('opens the board from the rail, which counts what needs you, and toggles it with B', async () => {
  await show('/');
  const rail = container.querySelector<HTMLButtonElement>('[data-rail="board"]');
  expect(rail?.getAttribute('aria-label')).toBe('Board, 7 need you');
  await act(() => rail?.click());
  expect(location().pathname).toBe('/board');
  expect(container.querySelector('[data-rail="board"]')?.getAttribute('aria-current')).toBe('page');
  await key('b');
  expect(location().pathname).toBe('/');
  await key('B');
  expect(location().pathname).toBe('/board');
  // B typed into a field is text, not the board.
  const field = document.createElement('input');
  container.append(field);
  await act(() => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true })); });
  expect(location().pathname).toBe('/board');
});

it('puts each workspace in its grouping column with its stack whole under its head, and narrows to the picked projects', async () => {
  await show('/board?group=state');
  expect(cards('needs-you')).toEqual(['slot-holds', 'slot-picker-ui', 'loyalty-stamps', 'bank-feed']);
  expect(cards('running')).toEqual(['invoice-pdf']);
  expect(cards('failed')).toEqual(['checkout']);
  // A workspace that never reported waits; there is no Idle.
  expect(cards('waiting')).toEqual(['menu-cache', 'allergen-labels']);
  expect(container.querySelector('[data-column="idle"]')).toBeNull();
  // The stacked workspace runs, but shows with its head, saying so; Running counts it.
  expect(column('needs-you').querySelector('[data-card="slot-picker-ui"]')?.textContent).toContain('Running · with its stack');
  expect(column('running').textContent).toMatch(/Running\s*2/u);
  // In the Needs you column each waiting workspace's card holds its Inbox rows.
  expect(column('needs-you').querySelector('[data-card="slot-holds"] [data-inbox-rows="slot-holds"]')).not.toBeNull();

  await show('/board?group=phase');
  expect(cards('plan')).toEqual(['loyalty-stamps']);
  expect(cards('code')).toEqual(['slot-holds', 'slot-picker-ui', 'invoice-pdf', 'bank-feed']);
  expect(cards('review')).toEqual(['menu-cache', 'allergen-labels']);
  expect(cards('ship')).toEqual(['checkout']);

  await show('/board?group=project');
  expect(cards('crumb')).toHaveLength(6);
  expect(cards('ledger')).toEqual(['invoice-pdf', 'bank-feed']);

  await show('/board?group=phase&projects=ledger');
  expect(cards('code')).toEqual(['invoice-pdf', 'bank-feed']);
  expect(container.querySelector('[data-card="slot-holds"]')).toBeNull();
  expect(container.textContent).toContain('2 workspaces in 1 project');

  // The Needs you filter keeps a stack whole while any of it needs you, the rest faded.
  await show('/board?group=phase');
  await act(() => button('Needs you3').click());
  expect(cards('code')).toEqual(['slot-holds', 'slot-picker-ui', 'bank-feed']);
  expect(container.querySelector('[data-card="slot-picker-ui"]')?.className).toContain('opacity-40');
});

it('moves a card dragged to another Phase column, with Undo, and refuses a move the phase rule forbids', async () => {
  let under = 'review';
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [column(under)] });
  await show('/board?group=phase');
  const dragCard = async (id: string): Promise<void> => {
    const card = container.querySelector(`[data-card="${id}"]`);
    if (!card) throw new Error(`No card ${id}`);
    await act(() => { card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 })); });
    await act(() => { window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 40 })); });
    await act(() => { window.dispatchEvent(new PointerEvent('pointerup', { clientX: 300, clientY: 40 })); });
  };
  await dragCard('slot-picker-ui');
  expect(onSetPhase).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Stacked on slot-holds');

  under = 'code';
  await dragCard('loyalty-stamps');
  expect(onSetPhase).toHaveBeenCalledWith('crumb', 'loyalty-stamps', 'code', 'plan');
  await act(async () => button('Undo').click());
  expect(onSetPhase).toHaveBeenLastCalledWith('crumb', 'loyalty-stamps', 'plan', 'code');
  Reflect.deleteProperty(document, 'elementsFromPoint');
});

it('opens a card’s workspace beside the board, narrowing the board, and the whole board again once closed', async () => {
  await show('/board?group=state');
  expect(container.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]')?.style.getPropertyValue('--sidebar-width')).toBe('1440px');
  await act(() => container.querySelector<HTMLElement>('[data-card="bank-feed"]')?.click());
  expect(location().pathname).toBe('/board');
  expect(location().searchParams.get('project')).toBe('ledger');
  expect(location().searchParams.get('workspace')).toBe('bank-feed');
  expect(container.querySelector('[data-card="bank-feed"]')?.getAttribute('aria-current')).toBe('true');
  expect(container.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]')?.style.getPropertyValue('--sidebar-width')).toBe('740px');
  expect(onSelectWorkspace).not.toHaveBeenCalled();
  await key('Escape');
  expect(location().searchParams.has('workspace')).toBe(false);
});

it('keeps its grouping and project pick in the URL, and the list takes them on when it folds back', async () => {
  await show('/board?group=phase&projects=ledger');
  expect(button('Phase').getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('[data-project-filter]')?.getAttribute('aria-label')).toBe('Project filter: Ledger');
  await act(() => button('State').click());
  expect(location().searchParams.get('group')).toBe('state');
  expect(location().searchParams.get('projects')).toBe('ledger');
  await show(location().pathname + location().search);
  expect(button('State').getAttribute('aria-pressed')).toBe('true');
  expect(cards('needs-you')).toEqual(['bank-feed']);
  await key('b');
  expect(location().pathname).toBe('/');
  expect(location().searchParams.has('group')).toBe(false);
  expect(button('State').getAttribute('aria-pressed')).toBe('true');
  expect(container.textContent).toContain('Ledger');
  expect(container.textContent).not.toContain('Crumb');
  // Opening the board again starts from what the list keeps.
  await key('b');
  expect(location().searchParams.get('group')).toBe('state');
  expect(location().searchParams.get('projects')).toBe('ledger');
});

it('returns from the whole board to the list with the last workspace opened, or the board’s first', async () => {
  await show('/board?group=state');
  expect(button('Sidebar view')).toBeDefined();
  await act(() => button('Sidebar view').click());
  expect(location().pathname).toBe('/');
  expect(location().searchParams.get('workspace')).toBe('slot-holds');

  await show('/board?group=state&project=ledger&workspace=bank-feed');
  // Beside a workspace, its own header folds the board; the board has no Sidebar view.
  expect([...document.querySelectorAll('button')].some((candidate) => candidate.getAttribute('aria-label') === 'Sidebar view')).toBe(false);
  await key('Escape');
  expect(location().searchParams.has('workspace')).toBe(false);
  await act(() => button('Sidebar view').click());
  expect(location().searchParams.get('project')).toBe('ledger');
  expect(location().searchParams.get('workspace')).toBe('bank-feed');
});

it('orders Waiting and Running by their latest change and Needs you by what has waited longest, on the board and in the list, stacks whole', async () => {
  shownProjects = [project('crumb', 'Crumb', [
    { id: 'old-wait', phase: 'review', color: 'blue', stateSince: '2026-11-20T09:00:00Z' },
    { id: 'never-reported', phase: 'plan', color: 'dim' },
    { id: 'new-wait', phase: 'review', color: 'blue', stateSince: '2026-11-23T09:00:00Z' },
    { id: 'mid-wait', phase: 'code', color: 'dim', stateSince: '2026-11-22T09:00:00Z' },
    { id: 'old-run', phase: 'code', color: 'green', stateSince: '2026-11-23T08:00:00Z' },
    { id: 'new-run', phase: 'code', color: 'green', stateSince: '2026-11-23T10:00:00Z' },
    { id: 'asked-late', phase: 'code', color: 'orange', stateSince: '2026-11-20T09:00:00Z', waitingSince: '2026-11-23T07:00:00Z' },
    { id: 'its-member', phase: 'code', color: 'green', stackedOn: 'asked-late', stateSince: '2026-11-23T11:00:00Z' },
    { id: 'asked-early', phase: 'code', color: 'orange', stateSince: '2026-11-23T09:00:00Z', waitingSince: '2026-11-22T07:00:00Z' },
  ])];
  await show('/board?group=state');
  expect(cards('waiting')).toEqual(['new-wait', 'mid-wait', 'old-wait', 'never-reported']);
  expect(cards('running')).toEqual(['new-run', 'old-run']);
  expect(cards('needs-you')).toEqual(['asked-early', 'asked-late', 'its-member']);

  window.localStorage.setItem('gitspace.sidebar.groupBy', 'state');
  await act(() => root.unmount());
  root = createRoot(container);
  await show('/');
  const listed = [...container.querySelectorAll<HTMLElement>('[data-workspace]')].map((row) => row.dataset.workspace);
  expect(listed).toEqual(['asked-early', 'asked-late', 'its-member', 'new-run', 'old-run', 'new-wait', 'mid-wait', 'old-wait', 'never-reported']);
});

it('folds a State or Phase heading in its own project only, each grouping remembered apart, across a reload; the board\'s columns fold on their own', async () => {
  window.localStorage.setItem('gitspace.sidebar.groupBy', 'state');
  await show('/');
  // Crumb's headings come first, then Ledger's.
  const heading = (label: string, project: 'crumb' | 'ledger'): HTMLButtonElement => {
    const found = [...container.querySelectorAll<HTMLButtonElement>('[data-group-heading]')].filter((candidate) => candidate.textContent?.startsWith(label));
    const one = found[project === 'crumb' ? 0 : 1];
    if (!one) throw new Error(`No heading ${label} in ${project}`);
    return one;
  };
  const listed = (id: string): boolean => container.querySelector(`[data-workspace="${id}"]`) !== null;
  await act(() => heading('Needs you', 'crumb').click());
  expect(heading('Needs you', 'crumb').getAttribute('aria-expanded')).toBe('false');
  expect(heading('Needs you', 'crumb').textContent).toContain('2');
  expect(listed('slot-holds') || listed('loyalty-stamps')).toBe(false);
  // Ledger's Needs you is its own: still open.
  expect(heading('Needs you', 'ledger').getAttribute('aria-expanded')).toBe('true');
  expect(listed('bank-feed')).toBe(true);

  // A reload keeps it folded.
  await act(() => root.unmount());
  root = createRoot(container);
  await show('/');
  expect(heading('Needs you', 'crumb').getAttribute('aria-expanded')).toBe('false');
  expect(heading('Needs you', 'ledger').getAttribute('aria-expanded')).toBe('true');

  // Phase's groups are folded on their own.
  await act(() => button('Phase').click());
  expect(listed('menu-cache')).toBe(true);
  await act(() => heading('Review', 'crumb').click());
  expect(listed('menu-cache')).toBe(false);
  await act(() => button('State').click());
  expect(heading('Needs you', 'crumb').getAttribute('aria-expanded')).toBe('false');
  expect(heading('Waiting', 'crumb').getAttribute('aria-expanded')).toBe('true');

  // The board's columns span every project and fold apart from the list's headings.
  await key('b');
  expect(column('needs-you').dataset.folded).toBeUndefined();
  expect(cards('needs-you')).toEqual(expect.arrayContaining(['slot-holds', 'bank-feed']));
  await key('b');
  expect(heading('Needs you', 'crumb').getAttribute('aria-expanded')).toBe('false');
});
