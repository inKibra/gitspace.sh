// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verticalSliceFixture } from './App.js';
import { GitSpaceShell, type GitSpaceShellProps, type WorkspaceView } from './GitSpaceShell.js';

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

// agent-blame (Code) is stacked on relay-hardening (Review), and follow-up (Code) is stacked on agent-blame.
const [open, parent] = verticalSliceFixture.workspaces as [WorkspaceView, WorkspaceView];
const scope: WorkspaceView = { ...open, relations: { dependsOn: [], relatedTo: [], stackedOn: parent.id } };
const member: WorkspaceView = { ...open, id: 'workspace-d', name: 'follow-up', branch: 'follow-up', relations: { dependsOn: [], relatedTo: [], stackedOn: open.id } };
const props: GitSpaceShellProps = { ...verticalSliceFixture, workspace: scope, workspaces: [scope, parent, member] };
const phase = (label: string) => document.querySelector<HTMLElement>(`[role="menuitemradio"][aria-label="${label}"]`);
const toast = () => document.querySelector<HTMLElement>('[data-stack-toast]');

it('lists every phase and says why one is refused before it is chosen; a move reports with Undo', async () => {
  const onSetWorkspacePhase = vi.fn<NonNullable<GitSpaceShellProps['onSetWorkspacePhase']>>(async () => undefined);
  await act(() => root.render(<GitSpaceShell {...props} onSetWorkspacePhase={onSetWorkspacePhase} />));
  const trigger = container.querySelector<HTMLElement>('[aria-label="Workspace phase"]');
  expect(trigger?.textContent).toContain('Code');
  await act(() => trigger!.click());
  expect(document.body.textContent).toContain('Phase · never ahead of its parent');
  expect(phase('Code')?.getAttribute('aria-checked')).toBe('true');
  expect(phase('Ship')?.getAttribute('aria-disabled')).toBe('true');
  expect(document.body.textContent).toContain('Stacked on relay-hardening, which is in Review; move it forward first, or unstack this');
  expect(phase('Plan')?.getAttribute('aria-disabled')).toBe('true');
  expect(document.body.textContent).toContain('follow-up is in Code and stacked on this; move it back first, or unstack it');
  await act(() => phase('Ship')!.click());
  expect(onSetWorkspacePhase).not.toHaveBeenCalled();
  await act(async () => phase('Review')!.click());
  expect(onSetWorkspacePhase).toHaveBeenCalledWith(open.id, 'review', 'code');
  expect(toast()?.textContent).toContain('agent-blame moved to Review');
  await act(async () => Array.from(toast()!.querySelectorAll('button')).find((button) => button.textContent === 'Undo')!.click());
  expect(onSetWorkspacePhase).toHaveBeenLastCalledWith(open.id, 'code', 'review');
});

it('keeps the phase and shows the server’s refusal when the server still refuses a move', async () => {
  const refusal = 'agent-blame is in Review now, not Code; nothing was changed';
  const onSetWorkspacePhase = vi.fn(async () => { throw new Error(refusal); });
  await act(() => root.render(<GitSpaceShell {...props} onSetWorkspacePhase={onSetWorkspacePhase} />));
  await act(() => container.querySelector<HTMLElement>('[aria-label="Workspace phase"]')!.click());
  await act(async () => phase('Review')!.click());
  expect(toast()?.getAttribute('role')).toBe('alert');
  expect(toast()?.textContent).toContain(refusal);
  expect(container.querySelector('[aria-label="Workspace phase"]')?.textContent).toContain('Code');
});
