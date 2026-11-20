// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountConnectPage } from './AccountConnectPage.js';
import type { BrowserDevice } from './device.js';

const helpers = vi.hoisted(() => ({
  accountHandleFromUrl: vi.fn((): string | null => 'example'),
  passkeysSupported: vi.fn(() => true),
  preparePasskeySignIn: vi.fn(),
}));
vi.mock('./browser-enrollment.js', () => ({ accountHandleFromUrl: helpers.accountHandleFromUrl }));
vi.mock('./passkeys.js', () => ({
  passkeysSupported: helpers.passkeysSupported,
  preparePasskeySignIn: helpers.preparePasskeySignIn,
  requestStepUp: vi.fn(),
  PasskeyError: class extends Error { constructor(readonly code: string, message: string) { super(message); } },
}));

const keyPair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
if (!('privateKey' in keyPair)) throw new Error('Ed25519 generates a key pair');
const device: BrowserDevice = {
  deviceId: '00000000-0000-4000-8000-0000000000e1', label: 'Browser', publicKey: '', keyPair, enrolledAt: 0, userId: `u-${'a'.repeat(32)}`, enrollUrl: 'https://example.gitspace.sh', canDelegate: true,
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  helpers.accountHandleFromUrl.mockReset().mockReturnValue('example');
  helpers.passkeysSupported.mockReset().mockReturnValue(true);
  helpers.preparePasskeySignIn.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function settle() { await act(async () => { const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, 0); await tick.promise; }); }
function button(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text);
}
async function render(onPasskeySignIn: (signedIn: BrowserDevice) => void) {
  await act(async () => root.render(<AccountConnectPage error={null} onRecover={vi.fn()} onEnroll={vi.fn()} onPasskeySignIn={onPasskeySignIn} />));
  await settle();
}

it('signs in with a passkey prepared on load, running it in the click, and hands the browser device on', async () => {
  const signIn = vi.fn(async () => device);
  helpers.preparePasskeySignIn.mockResolvedValue({ expiresAt: Date.now() + 120_000, signIn });
  const onPasskeySignIn = vi.fn();
  await render(onPasskeySignIn);
  expect(helpers.preparePasskeySignIn).toHaveBeenCalledWith(window.location.origin);
  expect(container.textContent).toContain('Sign in with a passkey you enrolled');
  act(() => {
    button('Sign in with a passkey')!.click();
    expect(signIn).toHaveBeenCalledTimes(1);
  });
  await settle();
  expect(onPasskeySignIn).toHaveBeenCalledWith(device);
});

it('a cancelled passkey says so and prepares a fresh sign-in', async () => {
  const signIn = vi.fn(async (): Promise<BrowserDevice> => { throw Object.assign(new Error('The passkey request was cancelled or timed out. Try again.'), { code: 'PASSKEY_CANCELLED' }); });
  helpers.preparePasskeySignIn.mockResolvedValue({ expiresAt: Date.now() + 120_000, signIn });
  const onPasskeySignIn = vi.fn();
  await render(onPasskeySignIn);
  await act(async () => button('Sign in with a passkey')!.click());
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The passkey request was cancelled or timed out. Try again.');
  expect(onPasskeySignIn).not.toHaveBeenCalled();
  expect(helpers.preparePasskeySignIn).toHaveBeenCalledTimes(2);
});

it('offers no passkey sign-in off an account host', async () => {
  helpers.accountHandleFromUrl.mockReturnValue(null);
  await render(vi.fn());
  expect(button('Sign in with a passkey')).toBeUndefined();
  expect(helpers.preparePasskeySignIn).not.toHaveBeenCalled();
  expect(button('Connect with recovery key')).toBeDefined();
});
