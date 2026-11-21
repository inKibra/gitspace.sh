// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StepUpAction } from '@gitspace/protocol/device-grant';
import type { StepUp } from './passkeys.js';
import type { McpAccessDraft, McpAccessValue } from './mcp-access.js';
import { McpAccessSettings } from './SettingsPage.js';

const stepUps = vi.hoisted(() => ({ passkeyAvailable: true, requested: new Array<StepUpAction>() }));
vi.mock('./passkeys.js', () => ({
  PasskeyError: class extends Error {},
  requestStepUp: async (action: StepUpAction): Promise<StepUp> => {
    stepUps.requested.push(action);
    return {
      action, required: true, passkeyAvailable: stepUps.passkeyAvailable, expiresAt: Date.now() + 120_000,
      withPasskey: async () => `${action.purpose}:passkey`, withRecoveryKey: async (key: string) => `${action.purpose}:${key}`,
    };
  },
}));

const status: McpAccessValue = { revision: 3, endpoint: 'https://alice.gitspace.sh/mcp', connections: [] };
let drafts: McpAccessDraft[];
let container: HTMLDivElement;
let root: Root;
let animationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  stepUps.passkeyAvailable = true; stepUps.requested = []; drafts = [];
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.unstubAllGlobals();
});
async function settle() { await act(async () => { const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, 0); await tick.promise; }); }
function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].filter(candidate => candidate.textContent?.trim() === text).at(-1);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
async function press(element: HTMLElement) { await act(async () => { element.click(); }); await settle(); }
async function type(input: HTMLInputElement, value: string) {
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
/** Flips the permission switch labelled `label` in the dialog. */
async function toggle(label: string) {
  const found = [...document.body.querySelectorAll<HTMLElement>('[id]')].find(candidate => candidate.textContent === label && document.body.querySelector(`[aria-labelledby="${candidate.id}"]`));
  if (!found) throw new Error(`Missing switch ${label}`);
  await press(found);
}
async function render() {
  await act(async () => root.render(<McpAccessSettings projects={[]} canManageMcp canCreateMcp onMcpStatus={async () => status}
    onMcpCreate={async (_revision, draft) => { drafts.push(draft); return { ...status, revision: 4 }; }} onMcpRotate={async () => status} onMcpDisable={async () => status} />));
  await settle();
  await press(button('Add connection'));
  await type(document.body.querySelector<HTMLInputElement>('input[placeholder="Laptop, CI, Claude Desktop"]')!, 'Agent');
  await settle();
}

it('adds a connection with ordinary permissions without asking for a passkey', async () => {
  await render();
  await press(button('Add connection'));
  expect(stepUps.requested).toEqual([]);
  expect(drafts).toEqual([expect.objectContaining({ label: 'Agent', capabilities: ['rpc.read', 'session.prompt'], stepUp: null })]);
});

it('asks for an mcp-token.create step-up naming the invitation when a powerful permission is ticked, by passkey or by recovery key with none enrolled', async () => {
  await render();
  await toggle('Device management');
  expect(stepUps.requested).toHaveLength(1);
  const [action] = stepUps.requested;
  expect(action).toMatchObject({ purpose: 'mcp-token.create' });
  expect(document.body.textContent).toContain('These permissions need your passkey');
  await press(button('Add connection'));
  expect(drafts.at(-1)).toMatchObject({ capabilities: ['rpc.read', 'session.prompt', 'devices.manage'], inviteId: action?.targets[0], stepUp: 'mcp-token.create:passkey' });
  stepUps.passkeyAvailable = false;
  await settle();
  await press(button('Add connection'));
  await type(document.body.querySelector<HTMLInputElement>('input[placeholder="Laptop, CI, Claude Desktop"]')!, 'Agent');
  await toggle('Device management');
  expect(document.body.textContent).toContain('This account has no passkey yet, so confirm with your recovery key.');
  expect(button('Add connection').disabled).toBe(true);
  await type(document.body.querySelector<HTMLInputElement>('input[placeholder="gsr_…"]')!, 'gsr_answer');
  await press(button('Confirm with recovery key'));
  await press(button('Add connection'));
  expect(drafts.at(-1)).toMatchObject({ stepUp: 'mcp-token.create:gsr_answer' });
});
