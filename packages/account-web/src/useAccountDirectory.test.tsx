// @vitest-environment happy-dom
import type { SpacePlacementView } from '@gitspace/protocol';
import type { CloudWorkspaceDefinition } from '@gitspace/protocol/project-authority';
import type { AccountDirectorySnapshot } from '@gitspace/protocol/account-directory';
import type { StreamEvent } from '@gitspace/protocol-sync';
import { SidebarProvider } from '@gitspace/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppSidebar } from './AppSidebar.js';
import type { ProjectLifecycleView } from './GitSpaceShell.js';
import { ACCOUNT_DIRECTORY_CHANGED, type ProductRoute } from './routes.js';
import { useWorkspaceProjection, type Directory, type WorkspaceProjection } from './useAccountDirectory.js';
import { SynchronizationContext, useAccountMachines, useAccountProjects } from './SynchronizationProvider.js';
import { SynchronizationOwner, type SynchronizationSource } from './synchronization.js';
import { WorkspaceStatuses } from './workspace-statuses.js';

type DirectoryProject = Pick<ProjectLifecycleView, 'id' | 'name' | 'lifecycle'>;
interface Fixture {
  projects: DirectoryProject[];
  saved: { a: CloudWorkspaceDefinition[]; b: CloudWorkspaceDefinition[] };
  /** Workspace ids whose space authority has cloud runtime state. */
  cloud: Set<string>;
  placements: Array<{ -readonly [Key in keyof SpacePlacementView]: SpacePlacementView[Key] }>;
  machines: Array<{ id: string; label: string; state: 'online' | 'offline'; desiredState: 'online' | 'offline' }>;
  failures: { directory: string | null };
  source: SynchronizationSource<AccountDirectorySnapshot>;
  revisions: Record<string, number>;
  publish: () => void;
}
const working = { primaryColor: 'green' as const, agents: { green: 1, blue: 0, orange: 0, red: 0 }, machines: { attached: 0, online: 0, ready: 0 }, sync: { conflicts: 0, problems: 0 } };
const waiting = { ...working, primaryColor: 'blue' as const, agents: { green: 0, blue: 1, orange: 0, red: 0 } };

let statuses: WorkspaceStatuses;

/** Project `a` and its worktree are open on the desk machine with working status rows; project `b` is released. */
function fixture(): Fixture {
  const projects = [{ id: 'a', name: 'Alpha', lifecycle: 'active' as const }, { id: 'b', name: 'Beta', lifecycle: 'active' as const }];
  const savedMetadata = { sourceKind: 'base' as const, sourceRef: 'main', sourceCommit: null, lifecycle: 'active' as const, goalId: null, revision: 1, remote: null, archivedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
  const definitions = (id: string): CloudWorkspaceDefinition[] => [
    { ...savedMetadata, id, projectId: id, kind: 'base', name: id, branch: 'main', phase: null },
    { ...savedMetadata, id: `${id}-work`, projectId: id, kind: 'worktree', name: `${id === 'a' ? 'Alpha' : 'Beta'} work`, branch: 'feature', phase: id === 'a' ? 'code' : 'review' },
  ];
  const saved = { a: definitions('a'), b: definitions('b') };
  const placements = projects.flatMap(({ id }) => definitions(id).map((space) => ({ spaceId: space.id, projectId: id, kind: space.kind, holderId: id === 'a' ? 'desk' : 'unassigned', generation: 1, state: id === 'a' ? 'open' : 'closed', endpoint: id === 'a' ? '/machine/desk/rpc' : null })));
  const machines: Fixture['machines'] = [{ id: 'desk', label: 'Desk machine', state: 'online', desiredState: 'online' }, { id: 'laptop', label: 'Laptop', state: 'online', desiredState: 'online' }];
  const failures = { directory: null as string | null };
  const cloud = new Set<string>();
  const revisions = { a: 1, b: 1 };
  const snapshot = (): AccountDirectorySnapshot => structuredClone({
    projects: projects.map((project) => ({ ...project, repositoryReference: null, baseBranch: 'main', role: null, source: null, revision: 1, remote: null, archivedAt: null, updatedAt: savedMetadata.updatedAt })),
    workspaces: [...saved.a, ...saved.b].map((space) => ({ ...space, cloudRuntime: cloud.has(space.id) })), placements,
    machines: machines.map((machine) => ({ ...machine, rpcEndpoint: `/machine/${machine.id}/rpc`, kind: 'physical', notes: '', provider: 'physical', lifecycleRevision: 1, operationId: null, error: null })),
    projectRevisions: revisions,
  });
  let cursor = 0;
  let notify = () => {};
  const queued: StreamEvent<AccountDirectorySnapshot>[] = [];
  const source: SynchronizationSource<AccountDirectorySnapshot> = async function* (_after, signal) {
    const abort = () => notify();
    signal.addEventListener('abort', abort, { once: true });
    queued.length = 0;
    try {
      if (failures.directory) { yield { status: 'error', error: new Error(failures.directory) }; return; }
      yield { status: 'ok', value: { type: 'snapshot', resource: 'account-directory', cursor: ++cursor, revision: cursor, previous: null, value: snapshot() } };
      while (!signal.aborted) {
        const next = queued.shift();
        if (next) { yield { status: 'ok', value: next }; continue; }
        const ready = Promise.withResolvers<void>();
        notify = ready.resolve;
        await ready.promise;
      }
    } finally { signal.removeEventListener('abort', abort); }
  };
  const publish = () => {
    const previous = cursor++;
    queued.push({ type: 'change', resource: 'account-directory', cursor, revision: cursor, previous, value: snapshot() });
    notify();
  };
  statuses.receive({ type: 'statuses', rows: [{ projectId: 'a', workspaceId: 'a', status: working }, { projectId: 'a', workspaceId: 'a-work', status: working }] });
  return { projects, saved, cloud, placements, machines, failures, source, revisions, publish };
}

let container: HTMLDivElement;
let root: Root;
let animationDescriptor: PropertyDescriptor | undefined;
let directory: Directory;
let synchronization: SynchronizationOwner;
let acceptRuntime: WorkspaceProjection['acceptRuntime'];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  directory = {};
  synchronization = new SynchronizationOwner();
  statuses = new WorkspaceStatuses();
});

afterEach(async () => {
  await act(() => root.unmount());
  synchronization.dispose();
  container.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.unstubAllGlobals();
});

function Probe(props: { scene: Fixture; selected?: { projectId: string; workspaceId: string | null } | null; view?: ProductRoute; projects?: Fixture['projects'] }) {
  return <SynchronizationContext.Provider value={synchronization}><DirectoryProbe {...props} /></SynchronizationContext.Provider>;
}
function DirectoryProbe({ scene, selected = null, view = 'settings', projects = scene.projects }: { scene: Fixture; selected?: { projectId: string; workspaceId: string | null } | null; view?: ProductRoute; projects?: Fixture['projects'] }) {
  ({ directory, acceptRuntime } = useWorkspaceProjection(projects, scene.source, statuses));
  return <SidebarProvider persist={false}><AppSidebar view={view} onView={() => undefined} selected={selected} projects={projects.map((project) => ({ ...project, ...(directory[project.id] ?? { workspaces: [] }) }))} machines={[]} onSelectWorkspace={() => undefined} /></SidebarProvider>;
}

async function refresh(): Promise<void> {
  await act(async () => { window.dispatchEvent(new Event(ACCOUNT_DIRECTORY_CHANGED)); });
}

function workspaceSummary() {
  return directory.a?.workspaces.find((space) => space.id === 'a-work')?.summary;
}

function row(label: string): HTMLElement {
  const element = [...container.querySelectorAll<HTMLElement>('[data-sidebar="menu-button"], [data-sidebar="menu-sub-button"]')].find((candidate) => candidate.textContent?.startsWith(label));
  if (!element) throw new Error(`Missing sidebar row: ${label}`);
  return element;
}

it('populates every project and holder independently of the selected pane', async () => {
  const scene = fixture();
  await act(async () => { root.render(<Probe scene={scene} />); });
  expect(directory.a?.baseSummary?.status?.primaryColor).toBe('green');
  expect(directory.a?.workspaces[0]?.summary?.holder).toEqual({ kind: 'held', machineId: 'desk', label: 'Desk machine' });
  expect(directory.a?.workspaces[0]?.definition).toMatchObject({ name: 'Alpha work', branch: 'feature', phase: 'code' });
  expect(directory.b?.baseSummary?.holder.kind).toBe('released');
  expect(directory.b?.workspaces[0]?.summary?.holder.kind).toBe('released');
  const betaCircle = row('Beta work').querySelector('.status-dot');
  expect(betaCircle).not.toBeNull();
  await act(async () => { root.render(<Probe scene={scene} selected={{ projectId: 'a', workspaceId: 'a-work' }} view="agent" />); });
  expect(row('Beta work').querySelector('.status-dot')).toBe(betaCircle);
  expect(directory.b?.workspaces[0]?.summary?.status).toBeUndefined();
});

it('shows a cloud workspace by its status row, without its stale legacy placement or any machine', async () => {
  const scene = fixture();
  scene.cloud.add('a-work');
  statuses.receive({ type: 'statuses', rows: [{ projectId: 'a', workspaceId: 'a-work', status: waiting }] });
  await act(async () => { root.render(<Probe scene={scene} />); });
  expect(workspaceSummary()).toEqual({ closedAt: null, holder: { kind: 'cloud' }, status: waiting, freshness: 'fresh', refreshing: false });
  expect(directory.a?.baseSummary?.holder).toEqual({ kind: 'held', machineId: 'desk', label: 'Desk machine' });
  expect(row('Alpha work').getAttribute('title')).toBe('feature · Waiting');
  expect(container.textContent).not.toContain('Desk machine');
});

it('updates one unopened cloud row from its status message', async () => {
  const scene = fixture();
  scene.projects[0]!.lifecycle = 'cloud-only';
  scene.machines.length = 0;
  await act(async () => { root.render(<Probe scene={scene} view="projects" />); });
  expect(directory.a?.workspaces[0]?.summary).toMatchObject({ holder: { kind: 'cloud' }, status: working, freshness: 'fresh' });
  await act(async () => { statuses.receive({ type: 'status', projectId: 'a', workspaceId: 'a-work', status: waiting }); });
  expect(directory.a?.workspaces[0]?.summary).toMatchObject({ holder: { kind: 'cloud' }, status: waiting, freshness: 'fresh' });
  expect(directory.a?.baseSummary?.status).toEqual(working);
  expect(row('Alpha work').getAttribute('title')).toBe('feature · Waiting');
});

it('shows a machine-held workspace by its status row and updates it when the row changes', async () => {
  const scene = fixture();
  await act(async () => { root.render(<Probe scene={scene} />); });
  expect(workspaceSummary()).toEqual({ closedAt: null, generation: 1, holder: { kind: 'held', machineId: 'desk', label: 'Desk machine' }, status: working, freshness: 'fresh', refreshing: false, detail: null });
  expect(row('Alpha work').getAttribute('title')).toBe('feature · Working');
  await act(async () => { statuses.receive({ type: 'status', projectId: 'a', workspaceId: 'a-work', status: waiting }); });
  expect(workspaceSummary()).toMatchObject({ holder: { kind: 'held', machineId: 'desk' }, status: waiting, freshness: 'fresh' });
  expect(directory.a?.baseSummary?.status).toEqual(working);
  expect(row('Alpha work').getAttribute('title')).toBe('feature · Waiting');
  await act(async () => { statuses.receive({ type: 'statuses', rows: [{ projectId: 'a', workspaceId: 'a', status: working }] }); });
  expect(workspaceSummary()).toMatchObject({ holder: { kind: 'held', machineId: 'desk' }, freshness: 'unknown' });
  expect(workspaceSummary()?.status).toBeUndefined();
});

it('keeps an open pane\'s accepted activity over an older status row across directory refreshes', async () => {
  const scene = fixture();
  await act(async () => { root.render(<Probe scene={scene} selected={{ projectId: 'a', workspaceId: 'a-work' }} view="agent" />); });
  await act(async () => {
    acceptRuntime('a', 'a-work', { ...workspaceSummary()!, status: waiting, freshness: 'stale', detail: 'Connection unavailable' });
  });
  expect(workspaceSummary()).toMatchObject({ status: { primaryColor: 'blue' }, freshness: 'stale' });
  await refresh();
  expect(workspaceSummary()).toMatchObject({ status: { primaryColor: 'blue' }, freshness: 'stale' });
  expect(row('Alpha work').querySelector('.status-dot')?.hasAttribute('data-pulse')).toBe(false);
});

it('rejects active observations after cloud close and across holder or generation changes', async () => {
  const scene = fixture();
  await act(async () => { root.render(<Probe scene={scene} />); });
  const oldSummary = { ...workspaceSummary()!, status: waiting };
  const placement = scene.placements.find((item) => item.spaceId === 'a-work')!;
  placement.state = 'closed';
  await act(async () => { scene.publish(); });
  await act(async () => { acceptRuntime('a', 'a-work', oldSummary); });
  expect(workspaceSummary()).toMatchObject({ holder: { kind: 'released' } });
  expect(workspaceSummary()?.status).toBeUndefined();
  placement.state = 'open';
  placement.holderId = 'laptop';
  placement.generation = 2;
  await act(async () => { scene.publish(); });
  await act(async () => { acceptRuntime('a', 'a-work', oldSummary); });
  expect(workspaceSummary()).toMatchObject({ holder: { kind: 'held', machineId: 'laptop' }, generation: 2, status: working });
});

it('retains compatible data on directory failure and applies confirmed closes on recovery even with an offline machine', async () => {
  const scene = fixture();
  await act(async () => { root.render(<Probe scene={scene} />); });
  scene.failures.directory = 'Directory disconnected';
  await refresh();
  expect(workspaceSummary()).toMatchObject({ status: { primaryColor: 'green' }, holder: { kind: 'held', machineId: 'desk' } });
  expect(directory.a?.error).not.toBeNull();
  scene.failures.directory = null;
  scene.saved.a[1]!.name = 'Renamed work';
  scene.machines[0]!.state = 'offline';
  scene.placements.find((space) => space.spaceId === 'a-work')!.state = 'closed';
  await refresh();
  expect(directory.a?.workspaces[0]?.name).toBe('Renamed work');
  expect(workspaceSummary()).toMatchObject({ holder: { kind: 'released' }, freshness: 'fresh' });
  expect(workspaceSummary()?.status).toBeUndefined();
  expect(directory.a?.workspaces[0]?.definition?.phase).toBe('code');
  expect(directory.a?.baseSummary).toMatchObject({ holder: { kind: 'held', machineId: 'desk' }, status: { primaryColor: 'green' }, freshness: 'fresh' });
  expect(directory.a?.error).toBeNull();
});

it('does not resurrect archived, removed, or reintroduced project scopes from retained data', async () => {
  const scene = fixture();
  await act(async () => { root.render(<Probe scene={scene} />); });
  const placementIndex = scene.placements.findIndex((space) => space.spaceId === 'a-work');
  const [placement] = scene.placements.splice(placementIndex, 1);
  await refresh();
  expect(directory.a?.workspaces[0]?.id).toBe('a-work');
  expect(workspaceSummary()).toMatchObject({ holder: { kind: 'unknown' }, detail: 'Placement unavailable' });
  expect(workspaceSummary()?.generation).toBeUndefined();
  scene.placements.push(placement!);
  await refresh();
  expect(workspaceSummary()).toMatchObject({ holder: { kind: 'held', machineId: 'desk' }, status: { primaryColor: 'green' }, freshness: 'fresh' });
  scene.saved.a[1]!.archivedAt = '2026-09-01T00:00:00.000Z';
  await refresh();
  expect(workspaceSummary()?.closedAt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
  expect(workspaceSummary()?.status).toBeUndefined();
  expect(directory.a?.workspaces[0]?.definition?.archivedAt).toBe('2026-09-01T00:00:00.000Z');
  scene.saved.a = scene.saved.a.filter((space) => space.kind === 'base');
  await refresh();
  expect(directory.a?.workspaces).toEqual([]);
  expect(container.textContent).not.toContain('Alpha work');
  await act(async () => { root.render(<Probe scene={scene} projects={[]} />); });
  expect(directory).toEqual({});
  await act(async () => { root.render(<Probe scene={scene} />); });
  expect(directory.a?.workspaces).toEqual([]);
  expect(container.textContent).not.toContain('Alpha work');
});

it('keeps canonical phases and source metadata for released, offline, and unknown workspaces across projects', async () => {
  const scene = fixture();
  scene.saved.a[1]!.phase = 'plan';
  scene.saved.b.push(
    { ...scene.saved.b[1]!, id: 'b-offline', name: 'Beta offline', phase: 'ship', sourceKind: 'workspace', sourceRef: 'b-work' },
    { ...scene.saved.b[1]!, id: 'b-unknown', name: 'Beta unknown', phase: null },
  );
  scene.placements.push({ spaceId: 'b-offline', projectId: 'b', kind: 'worktree', holderId: 'laptop', generation: 1, state: 'open', endpoint: '/machine/laptop/rpc' });
  scene.machines[1]!.state = 'offline';
  await act(async () => { root.render(<Probe scene={scene} selected={{ projectId: 'a', workspaceId: 'a-work' }} view="kanban" />); });
  expect(directory.a?.workspaces[0]?.definition?.phase).toBe('plan');
  expect(directory.b?.workspaces.map((space) => ({ id: space.id, phase: space.definition?.phase, holder: space.summary?.holder.kind }))).toEqual([
    { id: 'b-work', phase: 'review', holder: 'released' },
    { id: 'b-offline', phase: 'ship', holder: 'held' },
    { id: 'b-unknown', phase: null, holder: 'unknown' },
  ]);
  expect(directory.b?.workspaces.find((space) => space.id === 'b-offline')?.definition).toMatchObject({ sourceKind: 'workspace', sourceRef: 'b-work' });
  await refresh();
  await act(async () => { root.render(<Probe scene={scene} selected={{ projectId: 'b', workspaceId: 'b-offline' }} view="monitoring" />); });
  expect(directory.a?.workspaces[0]?.definition?.phase).toBe('plan');
  expect(directory.b?.workspaces.map((space) => space.id)).toEqual(['b-work', 'b-offline', 'b-unknown']);
  expect(directory.b?.workspaces.find((space) => space.id === 'b-offline')?.summary?.holder).toEqual({ kind: 'held', machineId: 'laptop', label: 'Laptop' });
});

it('keeps archived project workspace records available to the account Projects page', async () => {
  const scene = fixture();
  scene.projects[1]!.lifecycle = 'archived';
  for (const space of scene.saved.b) {
    space.lifecycle = 'archived';
    space.archivedAt = '2026-09-12T00:00:00.000Z';
  }
  await act(async () => { root.render(<Probe scene={scene} view="projects" />); });
  expect(directory.b?.workspaces[0]?.definition?.phase).toBe('review');
  expect(directory.b?.workspaces[0]?.closedAt).toEqual(new Date('2026-09-12T00:00:00.000Z'));
  expect(directory.b?.workspaces[0]?.summary?.holder.kind).toBe('released');
});

it('shares the sidebar snapshot with account project and machine consumers', async () => {
  const scene = fixture();
  const source = vi.fn(scene.source);
  scene.source = source;
  synchronization.channel('account-directory', source);
  function AccountReaders() {
    const projects = useAccountProjects();
    const machines = useAccountMachines();
    return <output>{projects.state === 'success' ? projects.value.map((project) => `${project.name}:${project.updatedAt.toISOString()}`).join(',') : projects.state} / {machines.state === 'success' ? machines.value.map((machine) => machine.label).join(',') : machines.state}</output>;
  }
  await act(async () => { root.render(<><Probe scene={scene} /><SynchronizationContext.Provider value={synchronization}><AccountReaders /></SynchronizationContext.Provider></>); });
  expect(source).toHaveBeenCalledOnce();
  expect(container.querySelector('output')?.textContent).toContain('Alpha:2026-09-01T00:00:00.000Z');
  expect(container.querySelector('output')?.textContent).toContain('Desk machine,Laptop');
  scene.machines[0]!.label = 'Renamed desk';
  await act(async () => { scene.publish(); });
  expect(workspaceSummary()?.holder).toEqual({ kind: 'held', machineId: 'desk', label: 'Renamed desk' });
  expect(container.querySelector('output')?.textContent).toContain('Renamed desk,Laptop');
  expect(source).toHaveBeenCalledOnce();
});
