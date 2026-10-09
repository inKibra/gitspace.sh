// @vitest-environment happy-dom
import { SidebarProvider } from '@gitspace/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verticalSliceFixture } from './App.js';
import { AppSidebar, type AppSidebarProps, type SidebarWorkspace } from './AppSidebar.js';
import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';

const lfsRpc = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: { snapshot: lfsRpc.snapshot } } }));

let root: Root;
let container: HTMLDivElement;
let animationDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  lfsRpc.snapshot.mockReset();
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
});

const saved: SidebarWorkspace = {
  id: 'saved', projectId: 'project', name: 'Saved workspace', branch: 'feature', closedAt: null,
  summary: { closedAt: null, holder: { kind: 'released' }, freshness: 'fresh' },
};

async function showActions(workspace: SidebarWorkspace) {
  await act(() => root.render(<SidebarProvider persist={false}><AppSidebar
    view="projects" onView={() => undefined}
    selected={{ projectId: 'project', workspaceId: 'saved' }}
    projects={[{ id: 'project', name: 'Project', workspaces: [workspace] }]}
    machines={[{ id: 'desk', label: 'Desk' }]}
    onSelectWorkspace={() => undefined}
    onReleaseMachines={() => undefined} onArchive={() => undefined}
    onRestore={() => undefined} onMove={() => undefined}
  /></SidebarProvider>));
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Space actions for Saved workspace"]');
  expect(trigger).not.toBeNull();
  await act(() => trigger!.click());
  return Array.from(document.querySelectorAll('[role="menuitem"]'), (item) => item.getAttribute('aria-label'));
}


it('uses archived account state rather than a stale held runtime for its actions', async () => {
  if (verticalSliceFixture.workspace.kind !== 'workspace') throw new Error('Expected workspace fixture');
  expect(await showActions({
    ...saved,
    closedAt: new Date('2026-09-01T00:00:00Z'),
    runtime: { ...verticalSliceFixture.workspace, id: saved.id, projectId: saved.projectId, name: saved.name },
  })).toEqual(['Restore workspace']);
});


it('blocks a workspace move until its own saved LFS list is explicitly accepted', async () => {
  if (verticalSliceFixture.workspace.kind !== 'workspace') throw new Error('Expected workspace fixture');
  const commit = 'a'.repeat(40);
  lfsRpc.snapshot.mockResolvedValue({ status: 'ok', value: RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'saved', cursor: 1, conversations: [], attachments: [], tasks: [], questions: [], documents: { 'gitspace.code': { checkpointRef: 'refs/gitspace/checkpoint', headCommit: commit, branch: 'main', indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: commit, worktreeTree: commit, lfs: { objects: [], heldBack: [{ path: 'saved/local.mov', kind: 'added' }] } } } }) });
  vi.stubGlobal('confirm', vi.fn(() => true));
  const move = vi.fn();
  await renderProject({ machines: [{ id: 'desk', label: 'Desk' }], onMove: move, projects: [{ id: 'project', name: 'Project', workspaces: [{ ...saved, summary: { closedAt: null, holder: { kind: 'held', machineId: 'origin', label: 'Origin' }, freshness: 'stale' }, runtime: { ...verticalSliceFixture.workspace, id: saved.id, projectId: saved.projectId, name: saved.name } }] }] });
  const begin = async () => {
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Space actions for Saved workspace"]')!.click());
    await act(() => document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Move to Desk"]')!.click());
  };
  const choose = async (text: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text);
    expect(button).toBeDefined();
    await act(() => button!.click());
  };
  await begin();
  expect(document.body.textContent).toContain('saved/local.mov');
  expect(lfsRpc.snapshot).toHaveBeenCalledWith({ projectId: 'project', workspaceId: 'saved' });
  expect(move).not.toHaveBeenCalled();
  await choose('Cancel');
  expect(move).not.toHaveBeenCalled();
  await begin();
  await choose('Commit first');
  expect(move).not.toHaveBeenCalled();
  expect(new URL(window.location.href).searchParams.get('workspace')).toBe('saved');
  await begin();
  await choose('Continue without them');
  expect(move).toHaveBeenCalledExactlyOnceWith('saved', 'desk');
});

async function renderProject(props: Partial<AppSidebarProps> = {}) {
  await act(() => root.render(<SidebarProvider persist={false}><AppSidebar
    view="projects" onView={() => undefined}
    selected={null}
    projects={[{ id: 'project', name: 'Project', workspaces: [saved] }]}
    machines={[]}
    onSelectWorkspace={() => undefined}
    {...props}
  /></SidebarProvider>));
}

function workspaceRowHidden(): boolean {
  const row = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Saved workspace'));
  expect(row).toBeDefined();
  return row!.closest('[aria-hidden="true"]') !== null;
}

/** The kit hides hover-only action clusters with `opacity-0` until the row is hovered. */
function toggleHiddenAtRest(label: string): boolean {
  const toggle = container.querySelector(`button[aria-label="${label}"]`);
  expect(toggle).not.toBeNull();
  return toggle!.closest('[data-sidebar="menu-actions"]')!.classList.contains('opacity-0');
}

it('folds a project and remembers the choice across a remount', async () => {
  await renderProject();
  expect(workspaceRowHidden()).toBe(false);
  expect(toggleHiddenAtRest('Collapse Project')).toBe(true);
  await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Collapse Project"]')!.click());
  expect(workspaceRowHidden()).toBe(true);
  expect(container.querySelector('button[aria-label="Expand Project"]')?.getAttribute('aria-expanded')).toBe('false');
  expect(toggleHiddenAtRest('Expand Project')).toBe(false);

  await act(() => root.unmount());
  root = createRoot(container);
  await renderProject();
  expect(workspaceRowHidden()).toBe(true);
  await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Expand Project"]')!.click());
  expect(workspaceRowHidden()).toBe(false);
});

it('ignores a malformed stored fold preference', async () => {
  window.localStorage.setItem('gitspace.sidebar.collapsedProjects', '{not json');
  await renderProject();
  expect(workspaceRowHidden()).toBe(false);
});

it('shows a folded project while one of its workspaces is selected, keeping the fold for later', async () => {
  window.localStorage.setItem('gitspace.sidebar.collapsedProjects', JSON.stringify(['project']));
  await renderProject({ selected: { projectId: 'project', workspaceId: 'saved' } });
  expect(workspaceRowHidden()).toBe(false);
  expect(container.querySelector('button[aria-label="Collapse Project"]')?.getAttribute('aria-expanded')).toBe('true');

  await renderProject({ selected: { projectId: 'project', workspaceId: null } });
  expect(workspaceRowHidden()).toBe(true);
});

it('opens project settings from the project row menu', async () => {
  const onOpenProjectSettings = vi.fn();
  await renderProject({ onOpenProjectSettings });
  await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Space actions for Project"]')!.click());
  const item = document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Project settings"]');
  expect(item).not.toBeNull();
  await act(() => item!.click());
  expect(onOpenProjectSettings).toHaveBeenCalledWith('project');
});
