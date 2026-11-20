// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { BROWSER_GRANT_CAPABILITIES } from '@gitspace/protocol/device-grant';
import type { BrowserInvitation, BrowserInvitationStatus, PreparedBrowserInvitation } from './browser-enrollment.js';
import { ConnectBrowserDialog } from './ConnectBrowserDialog.js';
import type { StepUp } from './passkeys.js';

vi.mock('./passkeys.js', () => ({ requestStepUp: vi.fn() }));

const inviteId = '00000000-0000-4000-8000-0000000000a1';
const expiresAt = Date.now() + 5 * 60_000;
const link = `https://example.gitspace.sh/#enroll=${'t'.repeat(40)}`;
let stepUp: StepUp;
let prepared: PreparedBrowserInvitation;
let onPrepare: Mock<() => Promise<PreparedBrowserInvitation>>;
let onCreate: Mock<(prepared: PreparedBrowserInvitation, proof: string | null) => Promise<BrowserInvitation>>;
let container: HTMLDivElement;
let root: Root;
let animationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  stepUp = {
    action: { purpose: 'browser-invitation.create', targets: [inviteId] }, required: true, passkeyAvailable: true, expiresAt: Date.now() + 120_000,
    withPasskey: vi.fn(async () => 'passkey-proof'), withRecoveryKey: vi.fn(async () => 'recovery-proof'),
  };
  prepared = {
    invite: {
      invite: { version: 1, userId: `u-${'a'.repeat(32)}`, inviteId, kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: [...BROWSER_GRANT_CAPABILITIES], canDelegate: true, issuedAt: Date.now(), expiresAt, grantTtlMs: null, enrollUrl: 'https://example.gitspace.sh' },
      signature: 's'.repeat(86), issuer: { kind: 'device', deviceId: '00000000-0000-4000-8000-0000000000b2' },
    },
    stepUp,
  };
  onPrepare = vi.fn(async () => prepared);
  onCreate = vi.fn(async () => ({ inviteId, expiresAt, status: 'pending', deviceId: null, link }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.unstubAllGlobals();
});
async function settle() { await act(async () => { const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, 0); await tick.promise; }); }
function button(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text);
}
async function render() {
  const pending: BrowserInvitationStatus = { inviteId, expiresAt, status: 'pending', deviceId: null };
  await act(async () => root.render(<ConnectBrowserDialog open onOpenChange={vi.fn()} canConnectBrowser onPrepareBrowserInvitation={onPrepare} onCreateBrowserInvitation={onCreate} onBrowserInvitationStatus={async () => pending} onCancelBrowserInvitation={async () => ({ ...pending, status: 'cancelled' })} onBrowserConnected={async () => undefined} />));
  await act(async () => button('Create enrollment link')!.click());
  await settle();
}

it('registers the link only after the step-up proof when one is due', async () => {
  await render();
  expect(onPrepare).toHaveBeenCalledTimes(1);
  expect(onCreate).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Confirm with your passkey to create the link.');
  await act(async () => button('Confirm with passkey')!.click());
  await settle();
  expect(stepUp.withPasskey).toHaveBeenCalledTimes(1);
  expect(onCreate).toHaveBeenCalledWith(prepared, 'passkey-proof');
  expect(document.body.textContent).toContain(link);
  expect(document.body.textContent).toContain('Waiting for browser');
  expect(button('Confirm with passkey')).toBeUndefined();
});

it('registers the link right away when no step-up is due', async () => {
  prepared = { ...prepared, stepUp: { ...stepUp, required: false, passkeyAvailable: false, expiresAt: null } };
  await render();
  expect(onCreate).toHaveBeenCalledWith(prepared, null);
  expect(button('Confirm with passkey')).toBeUndefined();
  expect(document.body.textContent).toContain(link);
});

it('shows a refused step-up and offers a new attempt', async () => {
  onCreate = vi.fn(async () => { throw Object.assign(new Error('Step-up expired'), { code: 'STEP_UP_EXPIRED' }); });
  await render();
  await act(async () => button('Confirm with passkey')!.click());
  await settle();
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('That confirmation expired. Confirm again.');
  expect(button('Create enrollment link')).toBeDefined();
});
