// @vitest-environment happy-dom
import type { SpacePlacementView } from '@gitspace/protocol';
import type { CloudWorkspaceDefinition } from '@gitspace/protocol/project-authority';
import type { AccountDirectorySnapshot } from '@gitspace/protocol/account-directory';
import type { StreamEvent } from '@gitspace/protocol-sync';
import type { BaseSpaceViewCodec, WorkspaceViewCodec } from '@gitspace/protocol/rpc-contract';
import { SidebarProvider } from '@gitspace/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InputOf } from 'result-rpc';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { AppSidebar } from './AppSidebar.js';
import type { ProjectLifecycleView } from './GitSpaceShell.js';
import { ACCOUNT_DIRECTORY_CHANGED, type ProductRoute } from './routes.js';
import { useAccountDirectory, type Directory, type DirectoryClient } from './useAccountDirectory.js';
import { SynchronizationContext, useAccountMachines, useAccountProjects } from './SynchronizationProvider.js';
import { SynchronizationOwner, type SynchronizationSource } from './synchronization.js';

type DirectoryProject = Pick<ProjectLifecycleView, 'id' | 'name' | 'lifecycle'>;
type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
interface RuntimeSnapshot {
  baseSpace: Mutable<InputOf<typeof BaseSpaceViewCodec>>;
  workspaces: Array<Mutable<InputOf<typeof WorkspaceViewCodec>>>;
}
type RuntimeReply = { status: 'ok'; value: RuntimeSnapshot } | { status: 'error'; error: Error };
interface Fixture {
  projects: DirectoryProject[];
  saved: { a: CloudWorkspaceDefinition[]; b: CloudWorkspaceDefinition[] };
  placements: Array<{ -readonly [Key in keyof SpacePlacementView]: SpacePlacementView[Key] }>;
  machines: Array<{ id: string; label: string; state: 'online' | 'offline'; desiredState: 'online' | 'offline' }>;
  runtime: RuntimeSnapshot;
  failures: { directory: string | null; runtime: string | null };
  bootstrap: Mock<() => Promise<RuntimeReply>>;
  client: DirectoryClient;
  source: SynchronizationSource<AccountDirectorySnapshot>;
  revisions: Record<string, number>;
  publish: () => void;
}
const working = { primaryColor: 'green' as const, agents: { green: 1, blue: 0, orange: 0, red: 0 }, services: { green: 0, red: 0 }, terminals: { green: 0, red: 0 } };
const waiting = { ...working, primaryColor: 'blue' as const, agents: { green: 0, blue: 1, orange: 0, red: 0 } };

function fixture(): Fixture {
  const projects = [{ id: 'a', name: 'Alpha', lifecycle: 'active' as const }, { id: 'b', name: 'Beta', lifecycle: 'active' as const }];
  const savedMetadata = { sourceKind: 'base' as const, sourceRef: 'main', sourceCommit: null, lifecycle: 'active' as const, goalId: null, revision: 1, archivedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
  const definitions = (id: string): CloudWorkspaceDefinition[] => [
    { ...savedMetadata, id, projectId: id, kind: 'base', name: id, branch: 'main', phase: null },
    { ...savedMetadata, id: `${id}-work`, projectId: id, kind: 'worktree', name: `${id === 'a' ? 'Alpha' : 'Beta'} work`, branch: 'feature', phase: id === 'a' ? 'code' : 'review' },
  ];
  const saved = { a: definitions('a'), b: definitions('b') };
  const placements = projects.flatMap(({ id }) => definitions(id).map((space) => ({ spaceId: space.id, projectId: id, kind: space.kind, holderId: id === 'a' ? 'desk' : 'unassigned', generation: 1, state: id === 'a' ? 'open' : 'closed', endpoint: id === 'a' ? '/machine/desk/rpc' : null })));
  const machines: Fixture['machines'] = [{ id: 'desk', label: 'Desk machine', state: 'online', desiredState: 'online' }, { id: 'laptop', label: 'Laptop', state: 'online', desiredState: 'online' }];
  const runtime: RuntimeSnapshot = {
    baseSpace: { id: 'a', projectId: 'a', kind: 'base', name: 'Alpha', branch: 'main', possessedBy: 'desk', spaceGeneration: 1, closedAt: null, status: working },
    workspaces: [{
      id: 'a-work', projectId: 'a', projectName: 'Alpha', name: 'Alpha work', branch: 'feature', rootPath: '/workspaces/a-work',
      phase: 'code', possessedBy: 'desk', spaceGeneration: 1, possessionGeneration: 1, closedAt: null, status: working,
      relations: { dependsOn: ['a-parent'], relatedTo: ['a-related'], stackedOn: 'a-parent' },
      stack: { blockedBy: ['a-parent'], blocking: ['a-child'], findings: [{ code: 'parent-behind', message: 'Parent branch is behind', workspaceId: 'a-parent' }] },
    }],
  };
  const failures = { directory: null as string | null, runtime: null as string | null };
  const revisions = { a: 1, b: 1 };
  const snapshot = (): AccountDirectorySnapshot => structuredClone({
    projects: projects.map((project) => ({ ...project, repositoryReference: null, baseBranch: 'main', role: null, source: null, revision: 1, archivedAt: null, updatedAt: savedMetadata.updatedAt })),
    workspaces: [...saved.a, ...saved.b], placements,
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
  const bootstrap = vi.fn<() => Promise<RuntimeReply>>(async () => failures.runtime ? { status: 'error', error: new Error(failures.runtime) } : { status: 'ok', value: structuredClone(runtime) });
  const client: DirectoryClient = { bootstrap };
  return { projects, saved, placements, machines, runtime, failures, bootstrap, client, source, revisions, publish };
}

let container: HTMLDivElement;
let root: Root;
let animationDescriptor: PropertyDescriptor | undefined;
let directory: Directory;
let synchronization: SynchronizationOwner;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  directory = {};
  synchronization = new SynchronizationOwner();
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
  directory = useAccountDirectory(projects, scene.client, scene.source);
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
  expect(directory.b?.baseSummary?.holder.kind).toBe('released');
  expect(directory.b?.workspaces[0]?.summary?.holder.kind).toBe('released');
  expect(directory.a?.workspaces[0]?.runtime).toMatchObject({
    kind: 'workspace', projectId: 'a', projectName: 'Alpha', name: 'Alpha work', branch: 'feature', phase: 'code', generation: 1,
    holder: { kind: 'held', machineId: 'desk', label: 'Desk machine' },
    relations: { dependsOn: ['a-parent'], relatedTo: ['a-related'], stackedOn: 'a-parent' },
    stack: { blockedBy: ['a-parent'], blocking: ['a-child'], findings: [{ code: 'parent-behind', workspaceId: 'a-parent' }] },
  });
  const betaCircle = row('Beta work').querySelector('.status-dot');
  expect(betaCircle).not.toBeNull();
  await act(async () => { root.render(<Probe scene={scene} selected={{ projectId: 'a', workspaceId: 'a-work' }} view="agent" />); });
  expect(row('Beta work').querySelector('.status-dot')).toBe(betaCircle);
  expect(directory.b?.workspaces[0]?.summary?.status).toBeUndefined();
});

it('retains the same status circles through partial and failed refreshes, then confirms fresh recovery', async () => {
  const scene = fixture();
  await act(async () => { root.render(<Probe scene={scene} />); });
  const workspaceCircle = row('Alpha work').querySelector('.status-dot');
  const baseCircle = row('Alpha').querySelector('.status-dot');
  const rowCount = container.querySelectorAll('[data-sidebar="menu-sub-item"]').length;
  const pending = Promise.withResolvers<RuntimeReply>();
  scene.bootstrap.mockImplementationOnce(() => pending.promise);
  await refresh();
  expect(workspaceSummary()).toMatchObject({ status: { primaryColor: 'green' }, freshness: 'fresh', refreshing: true });
  expect(directory.a?.workspaces[0]?.runtime?.stack.blockedBy).toEqual(['a-parent']);
  expect(row('Alpha work').querySelector('.status-dot')).toBe(workspaceCircle);
  expect(workspaceCircle?.getAttribute('data-pulse')).toBe('true');
  await act(async () => { pending.resolve({ status: 'error', error: new Error('Runtime disconnected') }); });
  expect(workspaceSummary()).toMatchObject({ status: { primaryColor: 'green' }, freshness: 'stale', refreshing: false });
  expect(directory.a?.workspaces[0]?.runtime?.relations.stackedOn).toBe('a-parent');
  expect(row('Alpha work').querySelector('.status-dot')).toBe(workspaceCircle);
  expect(row('Alpha').querySelector('.status-dot')).toBe(baseCircle);
  expect(workspaceCircle?.hasAttribute('data-pulse')).toBe(false);
  expect(row('Alpha').getAttribute('aria-description')).toContain('Runtime disconnected');
  expect(container.querySelectorAll('[data-sidebar="menu-sub-item"]')).toHaveLength(rowCount);
  const recovery = Promise.withResolvers<RuntimeReply>();
  scene.bootstrap.mockImplementationOnce(() => recovery.promise);
  await refresh();
  expect(workspaceSummary()?.freshness).toBe('stale');
  expect(row('Alpha').getAttribute('aria-description')).toContain('Runtime disconnected');
  scene.runtime.workspaces[0]!.status = waiting;
  await act(async () => { recovery.resolve({ status: 'ok', value: structuredClone(scene.runtime) }); });
  expect(workspaceSummary()).toMatchObject({ status: { primaryColor: 'blue' }, freshness: 'fresh', refreshing: false });
  expect(row('Alpha work').querySelector('.status-dot')).toBe(workspaceCircle);
  expect(row('Alpha').querySelector('.status-dot')).toBe(baseCircle);
  expect(baseCircle?.getAttribute('data-pulse')).toBe('true');
  expect(row('Alpha').hasAttribute('aria-description')).toBe(false);
  expect(directory.a?.error).toBeNull();
});

it('retains compatible data on directory failure and applies confirmed closes on recovery even with an offline machine', async () => {
  const scene = fixture();
  await act(async () => { root.render(<Probe scene={scene} />); });
  scene.failures.directory = 'Directory disconnected';
  await refresh();
  expect(workspaceSummary()).toMatchObject({ status: { primaryColor: 'green' }, holder: { kind: 'held', machineId: 'desk' }, freshness: 'stale' });
  expect(directory.a?.workspaces[0]?.runtime?.relations.stackedOn).toBe('a-parent');
  expect(directory.a?.error).not.toBeNull();
  scene.failures.directory = null;
  scene.saved.a[1]!.name = 'Renamed work';
  scene.machines[0]!.state = 'offline';
  scene.placements.find((space) => space.spaceId === 'a-work')!.state = 'closed';
  await refresh();
  expect(directory.a?.workspaces[0]?.name).toBe('Renamed work');
  expect(workspaceSummary()).toMatchObject({ holder: { kind: 'released' }, freshness: 'fresh' });
  expect(workspaceSummary()?.status).toBeUndefined();
  expect(directory.a?.workspaces[0]?.runtime).toBeUndefined();
  expect(directory.a?.workspaces[0]?.definition?.phase).toBe('code');
  expect(directory.a?.baseSummary).toMatchObject({ status: { primaryColor: 'green' }, freshness: 'stale' });
  scene.machines[0]!.state = 'online';
  await refresh();
  expect(directory.a?.baseSummary?.freshness).toBe('fresh');
  expect(directory.a?.error).toBeNull();
});

it('rejects old runtime status after same-holder generation changes and moves', async () => {
  const scene = fixture();
  await act(async () => { root.render(<Probe scene={scene} />); });
  const placement = scene.placements.find((space) => space.spaceId === 'a-work')!;
  placement.generation = 2;
  await refresh();
  expect(workspaceSummary()).toMatchObject({ generation: 2, freshness: 'unknown' });
  expect(workspaceSummary()?.status).toBeUndefined();
  expect(directory.a?.workspaces[0]?.runtime).toBeUndefined();
  expect(row('Alpha work').querySelector('.status-dot')).not.toBeNull();
  expect(row('Alpha work').querySelector('[data-pulse]')).toBeNull();
  expect(directory.a?.error).not.toBeNull();
  scene.runtime.workspaces[0]!.spaceGeneration = 2;
  scene.runtime.workspaces[0]!.status = waiting;
  await refresh();
  expect(workspaceSummary()).toMatchObject({ generation: 2, status: { primaryColor: 'blue' }, freshness: 'fresh' });
  expect(directory.a?.workspaces[0]?.runtime).toMatchObject({ generation: 2, status: { primaryColor: 'blue' } });
  placement.holderId = 'laptop';
  placement.endpoint = '/machine/laptop/rpc';
  await refresh();
  expect(workspaceSummary()?.holder).toMatchObject({ kind: 'held', machineId: 'laptop' });
  expect(workspaceSummary()?.status).toBeUndefined();
  expect(directory.a?.workspaces[0]?.runtime).toBeUndefined();
  scene.runtime.workspaces[0]!.possessedBy = 'laptop';
  await refresh();
  expect(workspaceSummary()).toMatchObject({ status: { primaryColor: 'blue' }, freshness: 'fresh' });
  expect(directory.a?.workspaces[0]?.runtime?.holder).toEqual({ kind: 'held', machineId: 'laptop', label: 'Laptop' });
  placement.state = 'closing';
  await refresh();
  expect(workspaceSummary()?.status).toBeUndefined();
  expect(directory.a?.workspaces[0]?.runtime).toBeUndefined();
  placement.state = 'open';
  placement.generation = 3;
  await refresh();
  expect(workspaceSummary()?.status).toBeUndefined();
  expect(directory.a?.workspaces[0]?.runtime).toBeUndefined();
});

it('coalesces changes during an in-flight read and ignores its superseded runtime response', async () => {
  const scene = fixture();
  await act(async () => { root.render(<Probe scene={scene} />); });
  const pending = Promise.withResolvers<RuntimeReply>();
  const staleRuntime = structuredClone(scene.runtime);
  scene.bootstrap.mockImplementationOnce(() => pending.promise);
  await refresh();
  const placement = scene.placements.find((space) => space.spaceId === 'a-work')!;
  placement.generation = 2;
  scene.runtime.workspaces[0]!.spaceGeneration = 2;
  scene.runtime.workspaces[0]!.status = waiting;
  await act(async () => {
    window.dispatchEvent(new Event(ACCOUNT_DIRECTORY_CHANGED));
    window.dispatchEvent(new Event(ACCOUNT_DIRECTORY_CHANGED));
  });
  expect(workspaceSummary()?.generation).toBe(2);
  expect(workspaceSummary()?.status).toBeUndefined();
  expect(directory.a?.workspaces[0]?.runtime).toBeUndefined();
  await act(async () => { pending.resolve({ status: 'ok', value: staleRuntime }); });
  expect(workspaceSummary()).toMatchObject({ generation: 2, status: { primaryColor: 'blue' }, freshness: 'fresh' });
  expect(directory.a?.workspaces[0]?.runtime).toMatchObject({ generation: 2, status: { primaryColor: 'blue' } });
});

it('does not resurrect archived, removed, or reintroduced project scopes from retained runtime data', async () => {
  const scene = fixture();
  await act(async () => { root.render(<Probe scene={scene} />); });
  const placementIndex = scene.placements.findIndex((space) => space.spaceId === 'a-work');
  const [placement] = scene.placements.splice(placementIndex, 1);
  await refresh();
  expect(directory.a?.workspaces[0]?.id).toBe('a-work');
  expect(workspaceSummary()).toMatchObject({ holder: { kind: 'unknown' }, freshness: 'unknown' });
  expect(workspaceSummary()?.status).toBeUndefined();
  expect(workspaceSummary()?.generation).toBeUndefined();
  expect(directory.a?.workspaces[0]?.runtime).toBeUndefined();
  scene.placements.push(placement!);
  await refresh();
  expect(workspaceSummary()).toMatchObject({ status: { primaryColor: 'green' }, freshness: 'fresh' });
  scene.saved.a[1]!.archivedAt = '2026-09-01T00:00:00.000Z';
  await refresh();
  expect(workspaceSummary()?.closedAt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
  expect(workspaceSummary()?.status).toBeUndefined();
  expect(directory.a?.workspaces[0]?.runtime).toBeUndefined();
  expect(directory.a?.workspaces[0]?.definition?.archivedAt).toBe('2026-09-01T00:00:00.000Z');
  scene.saved.a = scene.saved.a.filter((space) => space.kind === 'base');
  await refresh();
  expect(directory.a?.workspaces).toEqual([]);
  expect(container.textContent).not.toContain('Alpha work');
  await act(async () => { root.render(<Probe scene={scene} projects={[]} />); });
  expect(directory).toEqual({});
  scene.failures.runtime = 'Runtime unavailable';
  await act(async () => { root.render(<Probe scene={scene} />); });
  expect(directory.a?.baseSummary?.status).toBeUndefined();
  expect(directory.a?.baseSummary?.freshness).toBe('unknown');
  expect(directory.a?.workspaces[0]?.runtime).toBeUndefined();
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
  expect(directory.a?.workspaces[0]?.runtime?.phase).toBe('code');
  expect(directory.b?.workspaces.map((space) => ({ id: space.id, phase: space.definition?.phase, holder: space.summary?.holder.kind, runtime: space.runtime }))).toEqual([
    { id: 'b-work', phase: 'review', holder: 'released', runtime: undefined },
    { id: 'b-offline', phase: 'ship', holder: 'held', runtime: undefined },
    { id: 'b-unknown', phase: null, holder: 'unknown', runtime: undefined },
  ]);
  expect(directory.b?.workspaces.find((space) => space.id === 'b-offline')?.definition).toMatchObject({ sourceKind: 'workspace', sourceRef: 'b-work' });
  scene.failures.runtime = 'Holder unavailable';
  await refresh();
  await act(async () => { root.render(<Probe scene={scene} selected={{ projectId: 'b', workspaceId: 'b-offline' }} view="inbox" />); });
  expect(directory.a?.workspaces[0]?.definition?.phase).toBe('plan');
  expect(directory.b?.workspaces.map((space) => space.id)).toEqual(['b-work', 'b-offline', 'b-unknown']);
  expect(directory.b?.workspaces.find((space) => space.id === 'b-offline')?.summary?.holder).toEqual({ kind: 'held', machineId: 'laptop', label: 'Laptop' });
});

it('rejects another project runtime and invalidates a confirmed native close without removing its cloud definition', async () => {
  const scene = fixture();
  scene.runtime.workspaces[0]!.projectId = 'b';
  await act(async () => { root.render(<Probe scene={scene} />); });
  expect(directory.a?.workspaces[0]?.runtime).toBeUndefined();
  expect(workspaceSummary()?.status).toBeUndefined();
  expect(directory.a?.workspaces[0]?.definition?.phase).toBe('code');
  scene.runtime.workspaces[0]!.projectId = 'a';
  await refresh();
  expect(directory.a?.workspaces[0]?.runtime?.relations.stackedOn).toBe('a-parent');
  scene.runtime.workspaces[0]!.closedAt = new Date('2026-09-12T00:00:00.000Z');
  scene.runtime.workspaces[0]!.possessedBy = null;
  await refresh();
  expect(directory.a?.workspaces[0]?.runtime).toBeUndefined();
  expect(workspaceSummary()?.status).toBeUndefined();
  expect(directory.a?.workspaces[0]?.definition).toMatchObject({ id: 'a-work', phase: 'code', archivedAt: null });
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
  expect(directory.b?.workspaces[0]?.runtime).toBeUndefined();
});

it('refreshes activity revisions only for the affected project without idle sidebar fan-out', async () => {
  const scene = fixture();
  const source = vi.fn(scene.source);
  scene.source = source;
  for (let index = 0; index < 100; index++) scene.saved.b.push({ ...scene.saved.b[1]!, id: `b-archived-${index}`, lifecycle: 'archived', archivedAt: '2026-09-12T00:00:00.000Z' });
  await act(async () => { root.render(<Probe scene={scene} />); });
  expect(source).toHaveBeenCalledOnce();
  expect(scene.bootstrap).toHaveBeenCalledOnce();
  scene.runtime.workspaces[0]!.status = waiting;
  scene.revisions.b!++;
  await act(async () => { scene.publish(); });
  expect(workspaceSummary()?.status?.primaryColor).toBe('green');
  expect(scene.bootstrap).toHaveBeenCalledOnce();
  scene.revisions.a!++;
  await act(async () => { scene.publish(); });
  expect(workspaceSummary()?.status?.primaryColor).toBe('blue');
  expect(scene.bootstrap).toHaveBeenCalledTimes(2);
  expect(source).toHaveBeenCalledOnce();
});

it('refreshes only the changed holder and confirms status after that machine returns online', async () => {
  const scene = fixture();
  const placement = scene.placements.find((space) => space.spaceId === 'a-work')!;
  placement.holderId = 'laptop';
  placement.endpoint = '/machine/laptop/rpc';
  scene.runtime.workspaces[0]!.possessedBy = 'laptop';
  await act(async () => { root.render(<Probe scene={scene} />); });
  expect(scene.bootstrap).toHaveBeenCalledTimes(2);
  scene.runtime.baseSpace.status = waiting;
  scene.runtime.workspaces[0]!.status = waiting;
  scene.machines[1]!.state = 'offline';
  await act(async () => { scene.publish(); });
  expect(directory.a?.baseSummary).toMatchObject({ status: { primaryColor: 'green' }, freshness: 'fresh' });
  expect(workspaceSummary()).toMatchObject({ status: { primaryColor: 'green' }, freshness: 'stale' });
  expect(scene.bootstrap).toHaveBeenCalledTimes(2);
  scene.machines[1]!.state = 'online';
  await act(async () => { scene.publish(); });
  expect(directory.a?.baseSummary).toMatchObject({ status: { primaryColor: 'green' }, freshness: 'fresh' });
  expect(workspaceSummary()).toMatchObject({ status: { primaryColor: 'blue' }, freshness: 'fresh' });
  expect(scene.bootstrap).toHaveBeenCalledTimes(3);
});

it('does not let a late native response resurrect a project deleted by the directory feed', async () => {
  const scene = fixture();
  await act(async () => { root.render(<Probe scene={scene} />); });
  const pending = Promise.withResolvers<RuntimeReply>();
  scene.bootstrap.mockImplementationOnce(() => pending.promise);
  scene.revisions.a!++;
  await act(async () => { scene.publish(); });
  scene.projects.splice(0, 1);
  await act(async () => { scene.publish(); });
  expect(directory.a).toBeUndefined();
  await act(async () => { pending.resolve({ status: 'ok', value: scene.runtime }); });
  expect(directory.a).toBeUndefined();
  expect(directory.b?.workspaces[0]?.id).toBe('b-work');
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
  expect(scene.bootstrap).toHaveBeenCalledOnce();
});
