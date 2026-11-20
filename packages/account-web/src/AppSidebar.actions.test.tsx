// @vitest-environment happy-dom
import { SidebarProvider } from '@gitspace/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verticalSliceFixture } from './App.js';
import type { StackRestack } from '@gitspace/protocol-workspace';
import { AppSidebar, type AppSidebarProps, type SidebarArchive, type SidebarProject, type SidebarWorkspace } from './AppSidebar.js';
import type { GraphRelations } from './sidebar/project-graph.js';

let root: Root;
let container: HTMLDivElement;
let animationDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
    onRestore={() => undefined}
  /></SidebarProvider>));
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Space actions for Saved workspace"]');
  expect(trigger).not.toBeNull();
  await act(() => trigger!.click());
  return Array.from(document.querySelectorAll('[role="menuitem"]'), (item) => item.getAttribute('aria-label'));
}


it('offers only Restore for an archived workspace', async () => {
  expect(await showActions({
    ...saved,
    closedAt: new Date('2026-09-01T00:00:00Z'),
  })).toEqual(['Restore workspace']);
});

it('renames a workspace in place from its menu or by double-clicking its name; Escape keeps the old name', async () => {
  const onRename = vi.fn();
  await act(() => root.render(<SidebarProvider persist={false}><AppSidebar
    view="projects" onView={() => undefined} selected={null}
    projects={[{ id: 'project', name: 'Project', workspaces: [saved] }]} machines={[]}
    onSelectWorkspace={() => undefined} onRename={onRename}
  /></SidebarProvider>));
  const field = () => container.querySelector<HTMLInputElement>('input[aria-label="Workspace name"]');
  const type = async (value: string, key: string) => {
    const input = field()!;
    await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
  };
  await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Space actions for Saved workspace"]')!.click());
  await act(() => document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Rename workspace"]')!.click());
  expect(field()?.value).toBe('Saved workspace');
  await type('Pantry import', 'Enter');
  expect(onRename).toHaveBeenCalledWith('saved', 'Pantry import');
  expect(field()).toBeNull();
  const name = Array.from(container.querySelectorAll('span')).find((span) => span.textContent === 'Saved workspace');
  await act(() => { name!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
  await type('Discarded', 'Escape');
  expect(field()).toBeNull();
  expect(onRename).toHaveBeenCalledTimes(1);
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

const summaryOf = (primaryColor: 'green' | 'orange' | 'blue' | 'dim'): SidebarWorkspace['summary'] => ({ holder: { kind: 'cloud' }, closedAt: null, freshness: 'fresh', status: { ...verticalSliceFixture.baseSpace.status, primaryColor } });
const rel = (stackedOn: string | null, extra: Partial<GraphRelations> = {}): GraphRelations => ({ dependsOn: [], relatedTo: [], stackedOn, position: null, aheadOfParent: null, ...extra });

it('draws each stack whole under its head\'s group, counts every workspace in the heading\'s own state or phase as the filter tabs do, filters them, and remembers the grouping', async () => {
  const workspace = (id: string, phase: 'code' | 'review', color: 'green' | 'orange' | 'blue'): SidebarWorkspace => ({ id, projectId: 'stacks', name: id, branch: id, closedAt: null, phase, summary: summaryOf(color) });
  const project = {
    id: 'stacks', name: 'Stacks', workspaces: [workspace('bakery-core', 'code', 'green'), workspace('bakery-api', 'code', 'orange'), workspace('bakery-payments', 'review', 'blue'), workspace('bakery-docs', 'review', 'orange')],
    graph: { baseBranch: 'main', relations: { 'bakery-api': rel('bakery-core') }, pullRequests: {} },
  };
  const render = () => renderProject({ projects: [project] });
  /** The project's list as headings (label and count) and rows, in order. */
  const listed = () => Array.from(container.querySelectorAll('[data-sidebar="menu-sub"] > li:not([aria-hidden])'), (item) => item.getAttribute('data-workspace') ?? item.textContent ?? '');
  const inset = (id: string) => container.querySelector<HTMLElement>(`[data-workspace="${id}"] button`)?.style.paddingLeft;
  const hint = () => container.querySelector('[aria-label="Group by"]')?.textContent;
  const press = async (group: string, label: string) => {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] button`)).find((candidate) => candidate.textContent?.startsWith(label));
    expect(button).toBeDefined();
    await act(() => button!.click());
  };
  await render();
  expect(listed()).toEqual(['bakery-core', 'bakery-api', 'bakery-payments', 'bakery-docs']);
  expect(hint()).toContain('stacks');
  await press('Group by', 'State');
  // bakery-api needs you yet sits in its stack under its head's Running; Needs you still counts it, as its filter tab
  // does, and Running counts only bakery-core.
  expect(listed()).toEqual(['Needs you2', 'bakery-docs', 'Running1', 'bakery-core', 'bakery-api', 'Waiting1', 'bakery-payments']);
  expect(inset('bakery-api')).toBe('30px');
  expect(container.querySelector('[data-workspace="bakery-api"]')?.textContent).toContain('on bakery-core');
  expect(hint()).toContain('stacks');
  await press('Group by', 'Phase');
  expect(listed()).toEqual(['Review2', 'bakery-payments', 'bakery-docs', 'Code2', 'bakery-core', 'bakery-api']);
  expect(hint()).toContain('stacks');
  await press('Filter workspaces', 'Needs you');
  // The stack stays whole while bakery-api matches; its head is faded and not counted.
  expect(listed()).toEqual(['Review1', 'bakery-docs', 'Code1', 'bakery-core', 'bakery-api']);
  expect(container.querySelector('[data-workspace="bakery-core"] button')?.className).toContain('opacity-40');

  await act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(listed()).toEqual(['Review2', 'bakery-payments', 'bakery-docs', 'Code2', 'bakery-core', 'bakery-api']);
});

/** A bakery: Billing UI (Review) on Billing export (Ship), Billing emails (Code) on Billing UI; Gift cards (Plan) on
 * Loyalty points (Code), waiting on Billing UI; Menu redesign (Review) on its own. */
function bakery(relations: Partial<Record<string, GraphRelations>> = {}): SidebarProject {
  const workspace = (id: string, name: string, phase: SidebarWorkspace['phase'], color: 'green' | 'orange' | 'blue' | 'dim'): SidebarWorkspace => ({ id, projectId: 'bakery', name, branch: id, closedAt: null, phase, summary: summaryOf(color) });
  return {
    id: 'bakery', name: 'Bakery',
    workspaces: [workspace('billing-export', 'Billing export', 'ship', 'green'), workspace('billing-ui', 'Billing UI', 'review', 'orange'), workspace('billing-emails', 'Billing emails', 'code', 'dim'), workspace('menu-redesign', 'Menu redesign', 'review', 'orange'), workspace('loyalty-points', 'Loyalty points', 'code', 'green'), workspace('gift-cards', 'Gift cards', 'plan', 'dim')],
    graph: { baseBranch: 'main', pullRequests: {}, relations: {
      'billing-export': rel(null), 'billing-ui': rel('billing-export'), 'billing-emails': rel('billing-ui'), 'menu-redesign': rel(null), 'loyalty-points': rel(null), 'gift-cards': rel('loyalty-points', { dependsOn: ['billing-ui'] }),
      ...relations,
    } },
  };
}

async function openMenu(name: string): Promise<void> {
  await act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="Space actions for ${name}"]`)!.click());
}
async function choose(label: string): Promise<void> {
  const item = document.querySelector<HTMLElement>(`[role^="menuitem"][aria-label="${label}"]`);
  expect(item).not.toBeNull();
  await act(async () => item!.click());
}
const pickRow = (id: string) => container.querySelector<HTMLButtonElement>(`[data-workspace="${id}"] button`)!;
const toast = () => document.querySelector<HTMLElement>('[data-stack-toast]');
async function undo(): Promise<void> {
  await act(async () => { Array.from(toast()!.querySelectorAll('button')).find((button) => button.textContent === 'Undo')!.click(); });
}

it('stacks from the picker: rows show refusals with reasons, a click applies, and Undo reverses it over what was applied', async () => {
  const before = { dependsOn: [], relatedTo: [], stackedOn: 'billing-export' };
  const after = { dependsOn: [], relatedTo: [], stackedOn: 'menu-redesign' };
  const onSetRelations = vi.fn<NonNullable<AppSidebarProps['onSetRelations']>>(async (_id, relations) => relations);
  await renderProject({ projects: [bakery()], onSetRelations });
  await openMenu('Billing UI');
  await choose('Stack on…');
  expect(container.querySelector('[aria-label="Choosing"]')?.textContent).toContain('Stack Billing UI on…');
  expect(container.querySelector('nav[aria-label="Navigate"]')?.getAttribute('aria-hidden')).toBe('true');
  expect(pickRow('billing-ui').dataset.pick).toBe('source');
  expect(pickRow('billing-emails').dataset.pick).toBe('refused');
  expect(pickRow('billing-emails').textContent).toContain('stacked on Billing UI');
  expect(pickRow('gift-cards').textContent).toContain('only in Plan; Billing UI is in Review');
  expect(pickRow('loyalty-points').textContent).toContain('only in Code; Billing UI is in Review');
  expect(pickRow('menu-redesign').dataset.pick).toBe('choice');
  await act(() => pickRow('gift-cards').click());
  expect(onSetRelations).not.toHaveBeenCalled();
  await act(async () => pickRow('menu-redesign').click());
  expect(onSetRelations).toHaveBeenCalledWith('billing-ui', after, before);
  expect(pickRow('menu-redesign').dataset.pick).toBeUndefined();
  expect(toast()?.textContent).toContain('Billing UI on Menu redesign');
  await undo();
  expect(onSetRelations).toHaveBeenLastCalledWith('billing-ui', before, after);
});

it('shows a refused undo\'s message', async () => {
  const refusal = "Billing UI's relations changed since; nothing was changed";
  const onSetRelations = vi.fn<NonNullable<AppSidebarProps['onSetRelations']>>().mockImplementationOnce(async (_id, relations) => relations).mockRejectedValueOnce(new Error(refusal));
  await renderProject({ projects: [bakery()], onSetRelations });
  await openMenu('Billing UI');
  await choose('Remove from stack');
  expect(onSetRelations).toHaveBeenCalledWith('billing-ui', { dependsOn: [], relatedTo: [], stackedOn: null }, { dependsOn: [], relatedTo: [], stackedOn: 'billing-export' });
  expect(toast()?.textContent).toContain('Billing UI back at the top level');
  await undo();
  expect(toast()?.getAttribute('role')).toBe('alert');
  expect(toast()?.textContent).toContain(refusal);
});

it('reports an archive at once with Undo, then what moved in its stack; its Undo says what it could not put back', async () => {
  const archived = Promise.withResolvers<StackRestack>();
  const putBack = vi.fn(async (): Promise<StackRestack> => ({
    moved: [{ workspaceId: 'menu-redesign', from: 'billing-ui', to: 'billing-export' }],
    kept: [{ workspaceId: 'billing-ui', from: 'billing-export', to: null, reason: 'Billing UI was moved since' }],
  }));
  const onArchive = vi.fn(async (): Promise<SidebarArchive> => ({ done: archived.promise, undo: putBack }));
  await renderProject({ projects: [bakery({ 'menu-redesign': rel('billing-export') })], onArchive });
  await openMenu('Billing export');
  await choose('Archive workspace');
  expect(onArchive).toHaveBeenCalledWith('billing-export');
  expect(toast()?.textContent).toContain('Archiving Billing export…');
  await act(async () => archived.resolve({ moved: [
    { workspaceId: 'billing-ui', from: 'billing-export', to: null },
    { workspaceId: 'menu-redesign', from: 'billing-export', to: 'billing-ui' },
  ], kept: [] }));
  expect(toast()?.textContent).toContain('Billing export archived. Billing UI is the head now; Menu redesign is on it.');
  await undo();
  expect(putBack).toHaveBeenCalledTimes(1);
  expect(toast()?.textContent).toContain('Billing export restored. Not put back: Billing UI was moved since.');
  expect(Array.from(toast()!.querySelectorAll('button'), (button) => button.textContent)).toEqual(['Dismiss']);
});

it('chooses waits-on as a draft: a cycle and the stack parent are refused, Done applies it', async () => {
  const onSetRelations = vi.fn<NonNullable<AppSidebarProps['onSetRelations']>>(async (_id, relations) => relations);
  await renderProject({ projects: [bakery()], onSetRelations });
  await openMenu('Billing UI');
  await choose('Waits on…');
  expect(container.querySelector('[aria-label="Choosing"]')?.textContent).toContain('Billing UI waits on…');
  expect(pickRow('gift-cards').dataset.pick).toBe('refused');
  expect(pickRow('gift-cards').title).toBe('waits on Billing UI');
  expect(pickRow('billing-export').textContent).toContain('Billing UI is stacked on it');
  await act(() => pickRow('loyalty-points').click());
  expect(onSetRelations).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Choosing"]')?.textContent).toContain('+ Loyalty points');
  await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="Choosing"] button')).find((button) => button.textContent === 'Done')!.click());
  expect(onSetRelations).toHaveBeenCalledWith('billing-ui', { dependsOn: ['loyalty-points'], relatedTo: [], stackedOn: 'billing-export' }, { dependsOn: [], relatedTo: [], stackedOn: 'billing-export' });
  expect(toast()?.textContent).toContain('Billing UI waits on Loyalty points');
});

it('offers Restack only once the parent merged, and it unstacks keeping the planning labels', async () => {
  const merged = { parentId: 'billing-export', parentBranch: 'billing-export', baseBranch: 'main', mergeBase: null, parentAhead: 0, parentMerged: 'merged' as const, baseRewritten: false, instruction: null };
  const onSetRelations = vi.fn<NonNullable<AppSidebarProps['onSetRelations']>>(async (_id, relations) => relations);
  await renderProject({ projects: [bakery({ 'billing-ui': rel('billing-export', { relatedTo: ['menu-redesign'], position: merged }) })], onSetRelations });
  expect(pickRow('billing-ui').textContent).toContain('merged — restack onto main');
  await openMenu('Billing UI');
  expect(Array.from(document.querySelectorAll('[role="menuitem"]'), (item) => item.getAttribute('aria-label'))).toEqual(['Stack on…', 'Remove from stack', 'Restack onto main', 'Waits on…', 'Related to…']);
  await choose('Restack onto main');
  expect(onSetRelations).toHaveBeenCalledWith('billing-ui', { dependsOn: [], relatedTo: ['menu-redesign'], stackedOn: null }, { dependsOn: [], relatedTo: ['menu-redesign'], stackedOn: 'billing-export' });
  await openMenu('Billing emails');
  expect(document.querySelector('[role="menuitem"][aria-label="Restack onto main"]')).toBeNull();
});

it('lists every phase in the row menu, a refused one disabled with why, and reports a move with Undo', async () => {
  const onSetPhase = vi.fn<NonNullable<AppSidebarProps['onSetPhase']>>(async () => undefined);
  await renderProject({ projects: [bakery()], onSetPhase });
  const phase = (label: string) => document.querySelector<HTMLElement>(`[role="menuitemradio"][aria-label="${label}"]`);
  await openMenu('Billing UI');
  expect(phase('Review')?.getAttribute('aria-checked')).toBe('true');
  expect(phase('Plan')?.getAttribute('aria-disabled')).toBe('true');
  expect(document.body.textContent).toContain('Billing emails is in Code and stacked on this; move it back first, or unstack it');
  expect(phase('Ship')?.getAttribute('aria-disabled')).toBeNull();
  await act(() => root.unmount());
  root = createRoot(container);
  await renderProject({ projects: [bakery()], onSetPhase });
  await openMenu('Billing emails');
  expect(phase('Review')?.getAttribute('aria-disabled')).toBeNull();
  expect(phase('Ship')?.getAttribute('aria-disabled')).toBe('true');
  expect(document.body.textContent).toContain('Stacked on Billing UI, which is in Review; move it forward first, or unstack this');
  await act(async () => phase('Plan')!.click());
  expect(onSetPhase).toHaveBeenCalledWith('bakery', 'billing-emails', 'plan', 'code');
  expect(toast()?.textContent).toContain('Billing emails moved to Plan');
  await undo();
  expect(onSetPhase).toHaveBeenLastCalledWith('bakery', 'billing-emails', 'code', 'plan');
});

it('working inside a stack fades nothing; hovering a related row fades only its own project\'s unrelated rows', async () => {
  const other: SidebarProject = { id: 'other', name: 'Other', workspaces: [{ id: 'other-work', projectId: 'other', name: 'Other work', branch: 'other-work', closedAt: null, phase: 'code', summary: summaryOf('green') }] };
  await renderProject({ projects: [bakery(), other], selected: { projectId: 'bakery', workspaceId: 'billing-ui' } });
  const faded = (id: string) => pickRow(id).className.includes('opacity-40');
  const relationOf = (id: string) => container.querySelector<HTMLElement>(`[data-workspace="${id}"]`)?.dataset.relation;
  // Selected Billing UI tints its stack and leaves everything else as it is.
  expect(relationOf('billing-export')).toBe('upstream');
  expect(relationOf('billing-emails')).toBe('downstream');
  expect(['menu-redesign', 'loyalty-points', 'other-work'].map(faded)).toEqual([false, false, false]);
  // Hovering Loyalty points (Gift cards is stacked on it) fades Bakery's unrelated rows, not Other's.
  await act(() => pickRow('loyalty-points').focus());
  expect(relationOf('gift-cards')).toBe('downstream');
  expect(['menu-redesign', 'billing-export', 'other-work'].map(faded)).toEqual([true, true, false]);
  await act(() => pickRow('loyalty-points').blur());
  expect(['menu-redesign', 'billing-export', 'other-work'].map(faded)).toEqual([false, false, false]);
});
