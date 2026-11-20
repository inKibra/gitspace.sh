// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeviceView } from '@gitspace/protocol';
import type { PasskeyView } from '@gitspace/protocol/passkey-access';
import type { PasskeyEnrollment, StepUp } from './passkeys.js';
import { PasskeySettings } from './SettingsPage.js';

const passkeys = vi.hoisted(() => ({
  listPasskeys: vi.fn(),
  revokePasskey: vi.fn(),
  preparePasskeyEnrollment: vi.fn(),
  requestStepUp: vi.fn(),
  passkeysSupported: vi.fn(() => true),
}));
vi.mock('./passkeys.js', () => ({
  ...passkeys,
  PasskeyError: class extends Error { constructor(readonly code: string, message: string) { super(message); } },
}));

const browserId = '00000000-0000-4000-8000-0000000000d1';
const devices: DeviceView[] = [{ deviceId: browserId, kind: 'browser', label: 'Studio laptop', scope: 'user', capabilities: [], boundAt: '2026-11-01T00:00:00.000Z', expiresAt: null, revokedAt: null, active: true, current: true }];
const synced: PasskeyView = { credentialId: 'c'.repeat(22), label: 'Laptop', algorithm: -7, backupEligible: true, transports: ['internal', 'hybrid'], createdAt: Date.parse('2026-11-02T10:00:00.000Z'), enrolledBy: browserId, lastUsedAt: null, revokedAt: null };
const securityKey: PasskeyView = { ...synced, credentialId: 'k'.repeat(22), label: 'Desk key', backupEligible: false, transports: ['usb', 'nfc'], revokedAt: Date.parse('2026-11-10T10:00:00.000Z') };
let challenge: StepUp;
let container: HTMLDivElement;
let root: Root;
let animationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  challenge = {
    action: { purpose: 'passkey.revoke', targets: [synced.credentialId] }, required: true, passkeyAvailable: true, expiresAt: Date.now() + 120_000,
    withPasskey: vi.fn(async () => 'passkey-proof'), withRecoveryKey: vi.fn(async () => 'recovery-proof'),
  };
  passkeys.listPasskeys.mockReset().mockResolvedValue({ passkeys: [synced, securityKey], rpId: 'example.gitspace.sh' });
  passkeys.revokePasskey.mockReset().mockResolvedValue({ ...synced, revokedAt: Date.now() });
  passkeys.requestStepUp.mockReset().mockResolvedValue(challenge);
  passkeys.preparePasskeyEnrollment.mockReset();
  passkeys.passkeysSupported.mockReset().mockReturnValue(true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.unstubAllGlobals();
});
async function settle() { await act(async () => { const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, 0); await tick.promise; }); }
async function click(text: string) {
  const target = [...document.body.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text);
  if (!target) throw new Error(`Missing button ${text}`);
  await act(async () => target.click());
  await settle();
}
async function render() { await act(async () => root.render(<PasskeySettings devices={devices} />)); await settle(); }

it('lists each passkey with its kind, enrolling browser and state, the recovery state, and the one-passkey nudge', async () => {
  await render();
  const text = container.textContent ?? '';
  expect(text).toContain('LaptopSynced passkey');
  expect(text).toContain('by Studio laptop · never used');
  expect(text).toContain('Desk keySecurity keyRevoked');
  expect(text).toContain('A recovery key (gsr_…) exists for this account. GitSpace never stores it and cannot tell whether you kept it.');
  expect(text).toContain('Add a second passkey, preferably from a different provider');
  expect(text).toContain('Add a passkey');
  expect([...container.querySelectorAll('button')].filter(button => button.textContent === 'Revoke')).toHaveLength(1);
});

it('revoking asks for a passkey.revoke step-up and passes its proof to revokePasskey', async () => {
  await render();
  await click('Revoke');
  expect(passkeys.requestStepUp).toHaveBeenCalledWith({ purpose: 'passkey.revoke', targets: [synced.credentialId] });
  expect(document.body.textContent).toContain('Browsers it already connected keep working until you revoke them under Browsers.');
  expect(passkeys.revokePasskey).not.toHaveBeenCalled();
  await click('Confirm with passkey');
  expect(challenge.withPasskey).toHaveBeenCalledTimes(1);
  expect(passkeys.revokePasskey).toHaveBeenCalledWith(synced.credentialId, 'passkey-proof');
  expect(passkeys.listPasskeys).toHaveBeenCalledTimes(2);
});

it('adding a passkey confirms the step-up first, then creates it with that proof', async () => {
  const create = vi.fn(async () => synced);
  const enrollment: PasskeyEnrollment = { stepUp: { ...challenge, action: { purpose: 'passkey.enroll', targets: ['registration'] } }, expiresAt: Date.now() + 120_000, create };
  passkeys.preparePasskeyEnrollment.mockResolvedValue(enrollment);
  await render();
  await click('Add a passkey');
  expect(document.body.querySelector('input[placeholder="Laptop, phone, security key"]')).toBeNull();
  await click('Confirm with passkey');
  expect(create).not.toHaveBeenCalled();
  await click('Create passkey');
  expect(create).toHaveBeenCalledWith('Passkey 2', 'passkey-proof');
  expect(passkeys.listPasskeys).toHaveBeenCalledTimes(2);
});

it('with no active passkey offers to enroll this device without a step-up, and nudges to enroll', async () => {
  passkeys.listPasskeys.mockResolvedValue({ passkeys: [securityKey], rpId: 'example.gitspace.sh' });
  const create = vi.fn(async () => synced);
  passkeys.preparePasskeyEnrollment.mockResolvedValue({ stepUp: null, expiresAt: Date.now() + 120_000, create });
  await render();
  expect(container.textContent).toContain('Enroll a passkey. Secure input needs one');
  await click('Enroll this device');
  await click('Create passkey');
  expect(create).toHaveBeenCalledWith('Passkey', null);
});

it('a browser without passkey support cannot enroll and says why', async () => {
  passkeys.passkeysSupported.mockReturnValue(false);
  await render();
  const enroll = [...container.querySelectorAll('button')].find(button => button.textContent === 'Add a passkey');
  expect(enroll?.disabled).toBe(true);
  expect(container.textContent).toContain('This browser cannot create passkeys.');
});
