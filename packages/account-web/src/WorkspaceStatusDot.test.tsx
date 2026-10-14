// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyWorkspaceStatus, type WorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import { verticalSliceFixture } from './App.js';
import type { SidebarSpaceSummary } from './AppSidebar.js';
import { GitSpaceShell } from './GitSpaceShell.js';

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
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.unstubAllGlobals();
});

const agents = (counts: Partial<WorkspaceStatusSummary['agents']>) => ({ ...emptyWorkspaceStatus.agents, ...counts });
const cases: Array<{ name: string; summary: SidebarSpaceSummary; color: string }> = [
  { name: 'a running task', summary: { holder: { kind: 'cloud' }, closedAt: null, freshness: 'fresh', status: { ...emptyWorkspaceStatus, primaryColor: 'green', agents: agents({ green: 1 }) } }, color: '#22c55e' },
  { name: 'an approval', summary: { holder: { kind: 'cloud' }, closedAt: null, freshness: 'fresh', status: { ...emptyWorkspaceStatus, primaryColor: 'orange', agents: agents({ orange: 1 }) } }, color: '#f97316' },
  { name: 'a failure', summary: { holder: { kind: 'cloud' }, closedAt: null, freshness: 'fresh', status: { ...emptyWorkspaceStatus, primaryColor: 'red', agents: agents({ red: 1 }) } }, color: '#ef4444' },
  { name: 'an agent waiting for the user', summary: { holder: { kind: 'cloud' }, closedAt: null, freshness: 'fresh', status: { ...emptyWorkspaceStatus, primaryColor: 'blue', agents: agents({ blue: 1 }) } }, color: '#3b82f6' },
  { name: 'running work the browser cannot confirm', summary: { holder: { kind: 'cloud' }, closedAt: null, freshness: 'stale', status: { ...emptyWorkspaceStatus, primaryColor: 'green', agents: agents({ green: 1 }) } }, color: '#f97316' },
];

for (const { name, summary, color } of cases) {
  it(`shows ${name} in the same color in the sidebar row, the header and the workspace picker`, async () => {
    const workspace = verticalSliceFixture.workspace;
    await act(async () => root.render(<GitSpaceShell {...verticalSliceFixture} runtimeSummary={summary} onCreateWorkspace={async () => undefined} />));
    const dot = (element: Element | null | undefined) => element?.querySelector<HTMLElement>('.status-dot')?.style.color;
    const header = dot(container.querySelector('nav[aria-label="Location"]')?.parentElement);
    const row = dot(container.querySelector(`button[title^="${workspace.branch} · "]`));
    await act(async () => container.querySelector<HTMLElement>(`[aria-label="New workspace in ${workspace.projectName}"]`)!.click());
    // A picker card's accessible name sits on its overlay button; the dot is in the card around it.
    const picker = dot(document.body.querySelector(`[aria-label="Pick ${workspace.name}"]`)?.parentElement);
    expect({ header, row, picker }).toEqual({ header: color, row: color, picker: color });
  });
}
