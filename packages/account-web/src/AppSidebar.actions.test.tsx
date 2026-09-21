// @vitest-environment happy-dom
import { SidebarProvider } from '@gitspace/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verticalSliceFixture } from './App.js';
import { AppSidebar, type SidebarWorkspace } from './AppSidebar.js';

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
    onClose={() => undefined} onReopen={() => undefined} onArchive={() => undefined}
    onRestore={() => undefined} onMove={() => undefined}
  /></SidebarProvider>));
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Space actions for Saved workspace"]');
  expect(trigger).not.toBeNull();
  await act(() => trigger!.click());
  return Array.from(document.querySelectorAll('[role="menuitem"]'), (item) => item.getAttribute('aria-label'));
}

it('offers reopen and archive without requiring a runtime for a released workspace', async () => {
  expect(await showActions(saved)).toEqual(['Reopen space', 'Archive workspace']);
});

it('uses archived account state rather than a stale held runtime for its actions', async () => {
  if (verticalSliceFixture.workspace.kind !== 'workspace') throw new Error('Expected workspace fixture');
  expect(await showActions({
    ...saved,
    closedAt: new Date('2026-09-01T00:00:00Z'),
    runtime: { ...verticalSliceFixture.workspace, id: saved.id, projectId: saved.projectId, name: saved.name },
  })).toEqual(['Restore workspace']);
});

it('does not offer reopen or machine controls when placement is unknown', async () => {
  expect(await showActions({ ...saved, summary: { closedAt: null, holder: { kind: 'unknown' }, freshness: 'unknown' } })).toEqual(['Archive workspace']);
});
