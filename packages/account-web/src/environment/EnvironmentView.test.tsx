// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { EnvironmentView } from './EnvironmentView.js';
import { environmentFixture } from './fixtures.js';

it('keeps machine controls beside the complete editable environment definition', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const noop = () => {};
  try {
    await act(() => root.render(<EnvironmentView model={environmentFixture} machinePanel={<section aria-label="Workspace machines">Real machine controls</section>} onProfileChange={noop} onApprove={noop} onRevoke={noop} onGrantSecret={noop} onInputChange={noop} onUpdateCheck={noop} onDeleteCheck={noop} onAddCheck={noop} onAddValue={noop} onOpenSecrets={noop} onRunChecks={noop} onRunLifecycle={noop} />));
    expect(container.querySelector('[aria-label="Workspace machines"]')).not.toBeNull();
    for (const label of ['Checks', 'Secrets', 'Values', 'Lifecycle scripts', 'Browser origins']) expect(container.textContent).toContain(label);
    expect(container.querySelector('[aria-label="Runtime profile"]')).not.toBeNull();
  } finally { await act(() => root.unmount()); container.remove(); if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations'); vi.unstubAllGlobals(); }
});

it('keeps the environment definition editable without a machine but runs checks only on one', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const noop = () => {};
  try {
    await act(() => root.render(<EnvironmentView model={environmentFixture} runtimeAvailable={false} onProfileChange={noop} onApprove={noop} onRevoke={noop} onGrantSecret={noop} onInputChange={noop} onUpdateCheck={noop} onDeleteCheck={noop} onAddCheck={noop} onAddValue={noop} onOpenSecrets={noop} onRunChecks={noop} onRunLifecycle={noop} />));
    const button = (label: string) => [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
    expect([...container.querySelectorAll('fieldset')].map((fieldset) => fieldset.disabled)).toEqual([false, false]);
    expect(button('Add check')?.matches(':disabled')).toBe(false);
    expect(button('Add value')?.matches(':disabled')).toBe(false);
    expect(container.querySelector('[aria-label="Runtime profile"]')?.matches(':disabled')).toBe(false);
    expect(button('Run checks')?.matches(':disabled')).toBe(true);
  } finally { await act(() => root.unmount()); container.remove(); if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations'); vi.unstubAllGlobals(); }
});
