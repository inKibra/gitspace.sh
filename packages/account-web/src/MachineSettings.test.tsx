// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rpcErrors } from '@gitspace/protocol/rpc-contract';
import type { MachineDiscardConfirmation } from '@gitspace/protocol/machine-discard';
import { MachineSettings } from './SettingsPage.js';

let container: HTMLDivElement;
let root: Root;
let animationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  vi.stubGlobal('confirm', vi.fn(() => true));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  if (root) await act(() => root.unmount());
  container?.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function button(label: string) {
  const target = [...document.body.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!target) throw new Error(`Missing button: ${label}`);
  await act(() => target.click());
}
async function phrase(value: string) {
  const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Confirm machine name"]');
  if (!input) throw new Error('Missing discard confirmation input');
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function fixture(action: MachineDiscardConfirmation['action']) {
  const confirmation: MachineDiscardConfirmation = { machineId: 'cloud-a', action, token: 'bound-work-and-revision-token' };
  const refusal = rpcErrors.machineDiscardRequired({ message: 'Workspace checkpoint could not publish local work.', confirmation, workspaces: [{ projectId: 'project-alpha', workspaceId: 'workspace-review', generation: 7, reason: 'unpublished-local-work' }] });
  const invoke = vi.fn(async (approval?: MachineDiscardConfirmation) => { if (!approval) throw refusal; });
  const control = vi.fn(async (_action: 'sleep' | 'resume', _id: string, approval?: MachineDiscardConfirmation) => invoke(approval));
  const destroy = vi.fn(async (_id: string, approval?: MachineDiscardConfirmation) => invoke(approval));
  const noop = async () => {};
  await act(() => root.render(<MachineSettings machines={[{ id: 'cloud-a', label: 'Review cloud', state: 'online', kind: 'sandbox', provider: 'cloudflare-sandbox', notes: '', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null }]} onUpdateMachine={noop} onCreateSandbox={noop} onControlMachine={control} onDestroyMachine={destroy} cloudImages={[]} cloudImageDefault={null} cloudImageError={null} onChangeCloudImage={noop} onRecoverCloudImage={noop} onSetCloudImageDefault={noop} />));
  await button(action === 'sleep' ? 'Stop' : 'Destroy');
  return { confirmation, invoke, control, destroy };
}
it.each(['sleep', 'destroy'] as const)('requires the machine name before explicitly discarding refused %s work', async (action) => {
  const { confirmation, invoke, control, destroy } = await fixture(action);
  expect(document.body.textContent).toContain('project-alpha');
  expect(document.body.textContent).toContain('workspace-review');
  expect(invoke).toHaveBeenCalledTimes(1);
  await phrase('Wrong machine');
  await button(action === 'sleep' ? 'Discard and stop' : 'Discard and destroy');
  expect(invoke).toHaveBeenCalledTimes(1);
  await phrase('Review cloud');
  await button(action === 'sleep' ? 'Discard and stop' : 'Discard and destroy');
  expect(invoke).toHaveBeenCalledTimes(2);
  if (action === 'sleep') expect(control).toHaveBeenLastCalledWith('sleep', 'cloud-a', confirmation);
  else expect(destroy).toHaveBeenLastCalledWith('cloud-a', confirmation);
});
it('cancels refused discard without sending confirmation', async () => {
  const { invoke } = await fixture('sleep');
  await phrase('Review cloud');
  await button('Cancel discard');
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(document.body.querySelector('input[aria-label="Confirm machine name"]')).toBeNull();
});
