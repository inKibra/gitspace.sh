// @vitest-environment happy-dom
import type { StackStatus } from '@gitspace/protocol';
import { SidebarProvider } from '@gitspace/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppSidebar } from '../AppSidebar.js';
import type * as LiveNotices from '../live-notices.js';
import type * as Synchronization from '../SynchronizationProvider.js';
import { useProjectGraphs } from './project-graph.js';

/** The project view's read, which a test resolves; the links stay unread. */
const view: { read: { state: 'pending' } | { state: 'success'; value: unknown } } = vi.hoisted(() => ({ read: { state: 'pending' } }));
const reads = vi.hoisted(() => ({ refetch: vi.fn(async () => {}), procedures: { view: {}, links: {} } }));
vi.mock('result-rpc/react', () => ({ useResultQuery: (procedure: object) => ({ ...procedure === reads.procedures.view ? view.read : { state: 'pending' }, refetch: reads.refetch }) }));
vi.mock('../rpc-client.js', () => ({ rpcClient: { space: { view: reads.procedures.view }, automations: { list: reads.procedures.links } } }));
vi.mock('../live-notices.js', async (importOriginal) => ({ ...await importOriginal<typeof LiveNotices>(), useLiveChanges: () => null }));
vi.mock('../SynchronizationProvider.js', async (importOriginal) => ({ ...await importOriginal<typeof Synchronization>(), useProjectChanges: () => null }));

let root: Root;
let container: HTMLDivElement;
let animationDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // The sidebar's scroll area asks for animations happy-dom does not implement.
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  reads.refetch.mockClear();
  view.read = { state: 'pending' };
});

const bakery = [{ id: 'bakery', baseBranch: 'main' }];

it('reads a listed project\'s graph again on request and settles once the read ended; an unlisted one settles at once', async () => {
  const hook: { refresh?: (projectId: string) => Promise<void> } = {};
  function Graphs() {
    const graphs = useProjectGraphs(bakery, []);
    hook.refresh = graphs.refresh;
    return <>{graphs.readers}</>;
  }
  await act(() => root.render(<Graphs />));
  expect(reads.refetch).not.toHaveBeenCalled();
  // React renders the request once the first act ends; the read it starts settles the promise.
  let read: Promise<void> | undefined;
  await act(async () => { read = hook.refresh?.('bakery'); });
  await act(async () => { await read; });
  // The project view, read again; its automations are not.
  expect(reads.refetch).toHaveBeenCalledTimes(1);
  await act(async () => { await hook.refresh?.('elsewhere'); });
  expect(reads.refetch).toHaveBeenCalledTimes(1);
});

it('draws the sidebar\'s stacks from the directory\'s relations before the project view is read, then adds the positions it measured against the same parents', async () => {
  const ids = ['bakery-core', 'bakery-api', 'bakery-docs'];
  const parent: Record<string, string> = { 'bakery-api': 'bakery-core', 'bakery-docs': 'bakery-core' };
  const workspaces = ids.map((id) => ({ id, projectId: 'bakery', kind: 'worktree' as const, lifecycle: 'active' as const, relations: { dependsOn: [], relatedTo: [], stackedOn: parent[id] ?? null } }));
  const behind = (parentId: string): StackStatus => ({ parentId, parentBranch: parentId, baseBranch: 'main', mergeBase: null, parentAhead: 2, parentMerged: 'not-merged', baseRewritten: false, instruction: null });
  function Sidebar() {
    const { graphs, readers } = useProjectGraphs(bakery, workspaces);
    return <SidebarProvider persist={false}>{readers}<AppSidebar view="projects" onView={() => undefined} selected={null} machines={[]} onSelectWorkspace={() => undefined}
      projects={[{ id: 'bakery', name: 'Bakery', workspaces: ids.map((id) => ({ id, projectId: 'bakery', name: id, branch: id, closedAt: null, phase: 'code' })), graph: graphs.bakery }]} /></SidebarProvider>;
  }
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-workspace="${id}"]`);
  await act(() => root.render(<Sidebar />));
  for (const id of ['bakery-api', 'bakery-docs']) {
    expect(row(id)?.querySelector('button')?.style.paddingLeft).toBe('30px');
    expect(row(id)?.textContent).toContain('on bakery-core');
  }
  expect(row('bakery-api')?.textContent).not.toContain('2 behind');
  // The view, read before bakery-docs moved from bakery-old onto bakery-core, measured it against bakery-old: only
  // bakery-api's position and phase finding show.
  const read = (id: string, stackedOn: string | null) => ({ id, relations: { dependsOn: [], relatedTo: [], stackedOn },
    stack: { waitsOn: [], blocks: [], position: stackedOn ? behind(stackedOn) : null, findings: stackedOn ? [{ code: 'ahead-of-parent', message: `${id} is in a later phase than ${stackedOn}`, workspaceId: stackedOn }] : [] } });
  view.read = { state: 'success', value: { project: { baseBranch: 'main' }, workspaces: [read('bakery-core', null), read('bakery-api', 'bakery-core'), read('bakery-docs', 'bakery-old')] } };
  await act(() => root.render(<Sidebar />));
  expect(row('bakery-api')?.textContent).toContain('2 behind');
  expect(row('bakery-api')?.textContent).toContain('ahead of its parent');
  expect(row('bakery-docs')?.textContent).toContain('on bakery-core');
  expect(row('bakery-docs')?.textContent).not.toContain('2 behind');
  expect(row('bakery-docs')?.textContent).not.toContain('ahead of its parent');
});
