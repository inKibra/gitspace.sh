// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import type { CloudWorkspaceDefinition } from '@gitspace/protocol/project-authority';
import type { WorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import { AccountWorkPages, type AccountWorkPagesProps } from './AccountWorkPages.js';
import { verticalSliceFixture } from './App.js';
import type { SidebarWorkspace } from './AppSidebar.js';
import type { ProjectLifecycleView } from './GitSpaceShell.js';
import type { Directory } from './useAccountDirectory.js';

const stamp = '2026-09-12T00:00:00.000Z';
const projects: ProjectLifecycleView[] = [
  { id: 'alpha', name: 'Alpha', lifecycle: 'active', repositoryReference: null, baseBranch: 'main', role: null, source: null, revision: 4, archivedAt: null, updatedAt: new Date(stamp) },
  { id: 'beta', name: 'Beta', lifecycle: 'active', repositoryReference: null, baseBranch: 'main', role: null, source: null, revision: 7, archivedAt: null, updatedAt: new Date(stamp) },
];
const idle: WorkspaceStatusSummary = { primaryColor: 'dim', agents: { green: 0, blue: 0, orange: 0, red: 0 }, services: { green: 0, red: 0 }, terminals: { green: 0, red: 0 } };
function saved(id: string, projectId: string, phase: CloudWorkspaceDefinition['phase'], options: Partial<SidebarWorkspace> = {}): SidebarWorkspace {
  return {
    id, projectId, name: id, branch: `feature/${id}`, closedAt: null,
    definition: { id, projectId, name: id, branch: `feature/${id}`, phase, kind: 'worktree', sourceKind: 'base', sourceRef: '', lifecycle: 'active', goalId: null, revision: 1, archivedAt: null, createdAt: stamp, updatedAt: stamp },
    summary: { holder: { kind: 'unknown' }, closedAt: null, freshness: 'unknown', detail: 'Holder is offline' },
    ...options,
  };
}
let root: Root;
let container: HTMLDivElement;
let directory: Directory;
let onOpenWorkspace: Mock;
let onOpenProject: Mock;
let animationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onOpenWorkspace = vi.fn();
  onOpenProject = vi.fn();
  directory = {
    alpha: { workspaces: [saved('alpha-work', 'alpha', 'plan')] },
    beta: { workspaces: [saved('beta-release', 'beta', 'review', { summary: { holder: { kind: 'released' }, closedAt: null, freshness: 'unknown' } }), saved('beta-archive', 'beta', 'ship', { closedAt: new Date(stamp) })] },
  };
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.unstubAllGlobals();
});
async function render(view: AccountWorkPagesProps['view'], actions: AccountWorkPagesProps['actions'] = {}, projectList = projects) {
  await act(() => root.render(<AccountWorkPages view={view} projects={projectList} directory={directory} loading={false} onRefresh={vi.fn()} onOpenWorkspace={onOpenWorkspace} onOpenProject={onOpenProject} actions={actions} />));
}
async function click(label: string) {
  const element = document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing action: ${label}`);
  await act(() => element.click());
}

it('shows other projects and released workspaces without runtime, preserving canonical unassigned and unknown phases', async () => {
  directory.alpha!.workspaces.push(saved('unassigned', 'alpha', null, { runtime: { ...verticalSliceFixture.workspaces[0]!, id: 'unassigned', projectId: 'alpha', phase: 'code', relations: { dependsOn: ['alpha-work'], relatedTo: [], stackedOn: 'alpha-work' }, stack: { blockedBy: ['alpha-work'], blocking: [], findings: [] } } }));
  directory.beta!.workspaces.push(saved('unknown-phase', 'beta', 'code', { definition: undefined, summary: { holder: { kind: 'unknown' }, closedAt: null, status: idle, freshness: 'stale' } }));
  await render('kanban');
  expect(container.querySelector('[aria-label="Plan"]')?.textContent).toContain('alpha-work');
  expect(container.querySelector('[aria-label="Review"]')?.textContent).toContain('beta-release');
  expect(container.querySelector('[aria-label="Unassigned"]')?.textContent).toContain('unassigned');
  expect(container.querySelector('[aria-label="Code"]')?.textContent).not.toContain('unassigned');
  expect(container.querySelector('[aria-label="Phase unknown"]')?.textContent).toContain('unknown-phase');
  expect(container.querySelector('[aria-label="Unassigned"]')?.textContent).toContain('blocked · 1');
  expect(container.querySelector('[title="Stacked on alpha-work"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Open beta-archive"]')).toBeNull();
  expect(container.querySelector('[aria-label="Review"] [data-freshness="unknown"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Phase unknown"] [data-freshness="stale"]')).not.toBeNull();
  await click('Open beta-release');
  expect(onOpenWorkspace).toHaveBeenCalledWith('beta', 'beta-release');
});

it('requires a project choice on board creation and submits the chosen project and phase', async () => {
  const create = vi.fn();
  await render('kanban', { onCreateWorkspace: create });
  await click('New workspace in Plan');
  expect(document.body.querySelector('#create-workspace-form')).toBeNull();
  await click('Create workspace in Beta');
  expect(document.body.querySelector('#create-workspace-form')).not.toBeNull();
  await act(() => {
    const inputs = document.body.querySelectorAll<HTMLInputElement>('#create-workspace-form input');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (const [index, value] of ['chosen-work', 'feature/chosen-work'].entries()) {
      setValue.call(inputs[index], value);
      inputs[index]!.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await act(() => { document.body.querySelector<HTMLFormElement>('#create-workspace-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'beta', phase: 'plan', name: 'chosen-work', branch: 'feature/chosen-work' }));
});

it('preserves released and archived workspace actions with their actual targets and project revisions', async () => {
  const reopen = vi.fn();
  const claim = vi.fn();
  const remove = vi.fn();
  const archiveWorkspace = vi.fn();
  const archiveProject = vi.fn();
  await render('projects', { onReopenSpace: reopen, onClaimWorkspace: claim, onDeleteWorkspace: remove, onArchiveWorkspace: archiveWorkspace, onArchiveProject: archiveProject });
  await click('Reopen beta-release');
  await click('Archive beta-release');
  await click('Restore beta-archive');
  await click('Delete beta-archive');
  expect(reopen).toHaveBeenCalledWith('beta-release');
  expect(archiveWorkspace).toHaveBeenCalledWith('beta-release');
  expect(claim).toHaveBeenCalledWith('beta-archive', null);
  expect(remove).toHaveBeenCalledWith('beta-archive');
  expect(onOpenWorkspace).not.toHaveBeenCalled();
  const beta = [...container.querySelectorAll('section')].find((section) => section.querySelector('button')?.textContent?.startsWith('Beta'))!;
  await act(() => [...beta.querySelectorAll('button')].find((button) => button.textContent === 'Archive')!.click());
  expect(archiveProject).toHaveBeenCalledWith('beta', 7);
});

it('keeps archived projects out of the active list and restores the chosen archived project', async () => {
  const restore = vi.fn();
  await render('projects', { onRestoreProject: restore }, [projects[0]!, { ...projects[1]!, lifecycle: 'archived', archivedAt: new Date(stamp) }]);
  expect(container.querySelector('[aria-label="Open beta-release"]')).toBeNull();
  await click('Project filter');
  const archived = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes('Archived'))!;
  await act(() => archived.click());
  expect(container.querySelector('[aria-label="Open beta-archive"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Open alpha-work"]')).toBeNull();
  await act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Restore')!.click());
  expect(restore).toHaveBeenCalledWith('beta', 7);
});

it('includes base-agent waits and component errors across projects while identifying incomplete coverage', async () => {
  directory.alpha!.baseSummary = { holder: { kind: 'held', machineId: 'remote', label: 'Remote' }, closedAt: null, freshness: 'fresh', status: { ...idle, primaryColor: 'orange', agents: { green: 0, blue: 1, orange: 1, red: 0 } } };
  directory.beta!.workspaces[0]!.summary = { holder: { kind: 'released' }, closedAt: null, freshness: 'stale', status: { ...idle, primaryColor: 'red', services: { green: 0, red: 2 }, terminals: { green: 0, red: 1 } } };
  await render('inbox');
  expect(container.textContent).toContain('1 agent needs permission');
  expect(container.textContent).toContain('1 agent waiting');
  expect(container.textContent).toContain('2 service errors');
  expect(container.textContent).toContain('1 terminal error');
  expect(container.textContent).toContain('Last recorded · stale');
  expect(container.querySelector('[aria-label="Inspect Beta · Base agent"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Inspect Alpha · alpha-work"]')).not.toBeNull();
  await click('Open Alpha · Base agent');
  await click('Open Beta · beta-release');
  expect(onOpenProject).toHaveBeenCalledWith('alpha');
  expect(onOpenWorkspace).toHaveBeenCalledWith('beta', 'beta-release');
});

it('does not claim an empty inbox is healthy when directory or status coverage is unavailable', async () => {
  delete directory.beta;
  await render('inbox');
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain('Beta');
  expect(container.querySelector('[aria-label="Inspect Beta · Base agent"]')).not.toBeNull();
});
