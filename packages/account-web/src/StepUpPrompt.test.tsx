// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PasskeyError, type StepUp } from './passkeys.js';
import { StepUpPrompt } from './StepUpPrompt.js';

vi.mock('./passkeys.js', () => ({
  PasskeyError: class extends Error { constructor(readonly code: string, message: string) { super(message); } },
  requestStepUp: vi.fn(),
}));

function stepUp(overrides: Partial<StepUp> = {}): StepUp {
  return {
    action: { purpose: 'passkey.revoke', targets: ['credential'] }, required: true, passkeyAvailable: true, expiresAt: Date.now() + 120_000,
    withPasskey: vi.fn(async () => 'passkey-proof'), withRecoveryKey: vi.fn(async () => 'recovery-proof'), ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function settle() { await act(async () => { const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, 0); await tick.promise; }); }
function button(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text);
}

it('runs the passkey in the click itself and hands its proof on', async () => {
  const challenge = stepUp();
  const onProof = vi.fn();
  await act(async () => root.render(<StepUpPrompt stepUp={challenge} onProof={onProof} />));
  act(() => {
    button('Confirm with passkey')!.click();
    expect(challenge.withPasskey).toHaveBeenCalledTimes(1);
  });
  await settle();
  expect(onProof).toHaveBeenCalledWith('passkey-proof');
  expect(challenge.withRecoveryKey).not.toHaveBeenCalled();
});

it('shows why the passkey failed and hands nothing on', async () => {
  const challenge = stepUp({ withPasskey: vi.fn(async () => { throw new PasskeyError('PASSKEY_CANCELLED', 'The passkey request was cancelled or timed out. Try again.'); }) });
  const onProof = vi.fn();
  await act(async () => root.render(<StepUpPrompt stepUp={challenge} onProof={onProof} />));
  await act(async () => button('Confirm with passkey')!.click());
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The passkey request was cancelled or timed out. Try again.');
  expect(onProof).not.toHaveBeenCalled();
});

it('confirms with the recovery key instead, clearing the field', async () => {
  const challenge = stepUp();
  const onProof = vi.fn();
  await act(async () => root.render(<StepUpPrompt stepUp={challenge} onProof={onProof} />));
  expect(container.querySelector('summary')?.textContent).toBe('Use your recovery key instead');
  const field = container.querySelector<HTMLInputElement>('input[placeholder="gsr_…"]')!;
  expect(field.type).toBe('password');
  expect(field.getAttribute('autocomplete')).toBe('off');
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'gsr_example-recovery-key'); field.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button('Confirm with recovery key')!.click());
  await settle();
  expect(challenge.withRecoveryKey).toHaveBeenCalledWith('gsr_example-recovery-key');
  expect(challenge.withPasskey).not.toHaveBeenCalled();
  expect(onProof).toHaveBeenCalledWith('recovery-proof');
  expect(field.value).toBe('');
});

it('without an enrolled passkey says so and offers only the recovery key', async () => {
  await act(async () => root.render(<StepUpPrompt stepUp={stepUp({ passkeyAvailable: false })} onProof={vi.fn()} />));
  expect(button('Confirm with passkey')).toBeUndefined();
  expect(container.textContent).toContain('No passkey is enrolled on this account yet. Enroll one under Settings → Connections → Passkeys');
  expect(container.querySelector('details')).toBeNull();
  expect(container.querySelector('input[placeholder="gsr_…"]')).not.toBeNull();
});
