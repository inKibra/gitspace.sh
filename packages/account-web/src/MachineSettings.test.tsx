// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UserSettings } from '@gitspace/protocol';
import { rpcErrors } from '@gitspace/protocol/rpc-contract';
import type { MachineDiscardConfirmation } from '@gitspace/protocol/machine-discard';
import type { CloudImageSelection } from '@gitspace/protocol/cloud-image';
import { MachineSettings } from './SettingsPage.js';

const settings: UserSettings = { version: 1, revision: 2, onboardingComplete: true, profile: { displayName: 'Brad', handle: 'brad' }, git: { authorName: '', authorEmail: '' }, defaults: { machineId: null, enterAction: 'queue', appearance: 'system' }, machines: { cacheReclaimSeconds: 86400 }, updatedAt: '2026-10-03T00:00:00.000Z', updatedBy: 'browser' };
const noop = async () => {};
function render(overrides: Partial<ComponentProps<typeof MachineSettings>> = {}) {
  return act(() => root.render(<MachineSettings settings={settings} onChange={vi.fn()} machines={[]} onUpdateMachine={noop} onCreateSandbox={noop} onControlMachine={noop} onDestroyMachine={noop} cloudImages={[]} cloudImageDefault={null} cloudImageError={null} onChangeCloudImage={noop} onRecoverCloudImage={noop} onSetCloudImageDefault={noop} {...overrides} />));
}

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
  await render({ machines: [{ id: 'cloud-a', label: 'Review cloud', state: 'online', kind: 'sandbox', provider: 'cloudflare-sandbox', notes: '', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null }], onControlMachine: control, onDestroyMachine: destroy });
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
it('edits the account-wide paused cache retention through the settings draft', async () => {
  const onChange = vi.fn();
  await render({ onChange });
  const trigger = document.body.querySelector<HTMLElement>('[aria-label="Reclaim paused caches after"]');
  if (!trigger) throw new Error('Missing reclaim control');
  expect(trigger.textContent).toContain('24 hours');
  await act(() => trigger.click());
  const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options.map((option) => option.textContent)).toEqual(['1 hour', '6 hours', '24 hours', '72 hours', '168 hours']);
  await act(() => options.find((option) => option.textContent === '72 hours')?.click());
  expect(onChange).toHaveBeenCalledWith({ ...settings, machines: { cacheReclaimSeconds: 259200 } });
});
it('keeps every other machine and its discard dialog usable while one machine operation hangs', async () => {
  const machine = (id: string, label: string) => ({ id, label, state: 'online' as const, kind: 'sandbox' as const, provider: 'cloudflare-sandbox' as const, notes: '', desiredState: 'online' as const, lifecycleRevision: 1, operationId: null, error: null });
  const confirmation: MachineDiscardConfirmation = { machineId: 'cloud-b', action: 'sleep', token: 'bound-work-and-revision-token' };
  const refusal = rpcErrors.machineDiscardRequired({ message: 'Workspace checkpoint could not publish local work.', confirmation, workspaces: [{ projectId: 'project-alpha', workspaceId: 'workspace-review', generation: 7, reason: 'unpublished-local-work' }] });
  const hung = Promise.withResolvers<void>();
  const destroy = vi.fn((_id: string) => hung.promise);
  const control = vi.fn(async (_action: 'sleep' | 'resume', _id: string, approval?: MachineDiscardConfirmation) => { if (!approval) throw refusal; });
  await render({ machines: [machine('cloud-a', 'Stuck cloud'), machine('cloud-b', 'Healthy cloud')], onControlMachine: control, onDestroyMachine: destroy });
  // The nearest ancestor of a machine's title that holds buttons is that machine's card.
  const card = (label: string) => {
    let element = [...document.body.querySelectorAll('*')].find((candidate) => candidate.children.length === 0 && candidate.textContent === label)?.parentElement ?? null;
    while (element && !element.querySelector('button')) element = element.parentElement;
    return element;
  };
  const action = (label: string, text: string) => {
    const target = [...(card(label)?.querySelectorAll('button') ?? [])].find((candidate) => candidate.textContent === text);
    if (!target) throw new Error(`Missing ${text} on ${label}`);
    return target;
  };
  await act(() => action('Stuck cloud', 'Destroy').click());
  expect(destroy).toHaveBeenCalledWith('cloud-a');
  expect(action('Stuck cloud', 'Stop').disabled).toBe(true);
  expect(action('Healthy cloud', 'Destroy').disabled).toBe(false);
  await act(() => action('Healthy cloud', 'Stop').click());
  const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Confirm machine name"]');
  expect(input?.disabled).toBe(false);
  await phrase('Healthy cloud');
  await button('Discard and stop');
  expect(control).toHaveBeenLastCalledWith('sleep', 'cloud-b', confirmation);
  await act(async () => { hung.resolve(); await hung.promise; });
});
it('shows account image verification progress and failure beside the pin action', async () => {
  const verification = Promise.withResolvers<void>();
  const pin = vi.fn((_selection: CloudImageSelection) => verification.promise);
  const machine = (id: string) => ({ id, label: id, state: 'online' as const, kind: 'sandbox' as const, provider: 'cloudflare-sandbox' as const, notes: '', desiredState: 'online' as const, lifecycleRevision: 1, operationId: null, error: null });
  // Machines push the image panel far below the section's top-level alert.
  await render({ machines: [machine('cloud-a'), machine('cloud-b')], onSetCloudImageDefault: pin });
  await button('Choose account image');
  await act(() => document.body.querySelector<HTMLElement>('[aria-label="Cloud image source"]')!.click());
  await act(() => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'Custom immutable OCI image')!.click());
  const image = `ghcr.io/team/image@sha256:${'a'.repeat(64)}`;
  const input = document.body.querySelector<HTMLInputElement>('input[placeholder^="registry.example.com"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, image);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await button('Verify and pin default');
  expect(pin).toHaveBeenCalledWith({ kind: 'custom', image });
  let panel = [...document.body.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Verify and pin default')!.parentElement;
  while (panel && !panel.textContent?.includes('Choose account cloud image')) panel = panel.parentElement;
  expect(panel?.querySelector('[role="status"]')?.textContent).toContain('Verifying');
  await act(async () => { verification.reject(rpcErrors.operationFailed({ operation: 'set cloud image default', message: 'images/prepare returned 409' })); await verification.promise.catch(() => undefined); });
  expect(panel?.querySelector('[role="alert"]')?.textContent).toContain('images/prepare returned 409');
  expect(panel?.querySelector('[role="status"]')).toBeNull();
});
