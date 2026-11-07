// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verticalSliceFixture } from './App.js';
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
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
});

it('keeps the phase and shows the server’s refusal when a phase would pass what the workspace depends on', async () => {
  const refusal = 'Phase review is ahead of relay-hardening (code); a workspace cannot pass the phase of what it depends on';
  const onSetWorkspacePhase = vi.fn(async () => { throw new Error(refusal); });
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} onSetWorkspacePhase={onSetWorkspacePhase} />));
  const trigger = container.querySelector<HTMLElement>('[aria-label="Workspace phase"]');
  expect(trigger?.textContent).toContain('Code');
  await act(() => trigger!.click());
  const review = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'Review');
  expect(review).toBeDefined();
  await act(async () => { review!.click(); });
  expect(onSetWorkspacePhase).toHaveBeenCalledWith(verticalSliceFixture.workspace.id, 'review');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(refusal);
  expect(container.querySelector('[aria-label="Workspace phase"]')?.textContent).toContain('Code');

  await act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Dismiss')!.click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
