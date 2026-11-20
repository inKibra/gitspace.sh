// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSecureInputPageRequestSchema, SECURE_INPUT_API_PATH, type RuntimeSecureInputOutcome, type RuntimeSecureInputPageRequest, type RuntimeSecureInputView } from '@gitspace/protocol-runtime/secure-input';
import { STEP_UP_HEADER, type StepUpAction } from '@gitspace/protocol/device-grant';
import type { StepUp } from './passkeys.js';
import { SecureInputPage } from './SecureInputPage.js';

// The page's signed fetch, answered by each test: `view` for op view, `answer` for submit, useSaved and decline.
const api = vi.hoisted(() => ({ handle: async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new Error('No API in this test'); } }));
vi.mock('./device.js', () => ({
  DeviceRejectedError: class extends Error {},
  loadDevice: async () => null,
  createDeviceSignedFetch: () => (input: RequestInfo | URL, init?: RequestInit) => api.handle(input, init),
}));
// Step-ups the page asks for: each proof names its purpose and how it was given.
const stepUps = vi.hoisted(() => ({ passkeyAvailable: true, requested: new Array<StepUpAction>() }));
vi.mock('./passkeys.js', () => ({
  requestStepUp: async (action: StepUpAction): Promise<StepUp> => {
    stepUps.requested.push(action);
    return {
      action, required: true, passkeyAvailable: stepUps.passkeyAvailable, expiresAt: Date.now() + 120_000,
      withPasskey: async () => `${action.purpose}:passkey`, withRecoveryKey: async (key: string) => `${action.purpose}:${key}`,
    };
  },
}));

const id = 'B'.repeat(43);
const secret = 'hunter2-correct-horse';
const credentialId = '00000000-0000-4000-8000-0000000000c3';
let view: RuntimeSecureInputView;
let viewStatus: number;
let answer: Promise<RuntimeSecureInputOutcome>;
let requests: RuntimeSecureInputPageRequest[];
let proofs: (string | null)[];
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  view = { id, state: 'open', workspace: 'checkout-fix', purpose: 'Sign in to GitHub as octocat', origin: 'https://github.com', kind: 'password', source: 'chrome', browser: 'Studio desktop', title: 'Sign in to GitHub · GitHub', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), saved: [] };
  viewStatus = 200;
  answer = Promise.resolve({ outcome: 'provided', saved: false });
  requests = [];
  proofs = [];
  stepUps.passkeyAvailable = true;
  stepUps.requested = [];
  api.handle = async (input, init) => {
    expect(String(input)).toBe(SECURE_INPUT_API_PATH);
    const sent = RuntimeSecureInputPageRequestSchema.parse(JSON.parse(String(init?.body)));
    requests.push(sent);
    proofs.push(new Headers(init?.headers).get(STEP_UP_HEADER));
    if (sent.op !== 'view') return Response.json({ status: 'ok', value: await answer });
    return viewStatus === 200 ? Response.json({ status: 'ok', value: view }) : Response.json({ status: 'error', error: { code: 'SECURE_INPUT_NOT_FOUND', message: 'No such request on this account' } }, { status: viewStatus });
  };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function settle() { await act(async () => { const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, 0); await tick.promise; }); }
/** Renders the page and opens the request with a passkey. */
async function render() {
  await act(async () => root.render(<SecureInputPage id={id} />));
  await settle();
  await click('Confirm with passkey');
  await settle();
}
function field(): HTMLInputElement | null { return container.querySelector('input'); }
async function type(value: string) {
  const input = field()!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.trim().startsWith(text));
  if (!button) throw new Error(`Missing button ${text}`);
  await act(async () => { button.click(); });
  await settle();
}

it('shows the request: workspace, purpose, the exact origin, what it asks for, the browser and tab, the time left; the field is masked and Save is off', async () => {
  await render();
  expect(requests).toEqual([{ op: 'view', id }]);
  expect(container.textContent).toContain('Workspace checkout-fix');
  expect(container.textContent).toContain('Sign in to GitHub as octocat');
  expect(container.querySelector('[data-secure-input-origin]')?.textContent).toBe('https://github.com');
  expect(container.textContent).toContain('Asks forPassword');
  expect(container.textContent).toContain('BrowserStudio desktop');
  expect(container.textContent).toContain('TabSign in to GitHub · GitHub');
  expect(container.textContent).toMatch(/Expires(9:5\d|10:00) left/u);
  expect(field()?.type).toBe('password');
  expect(field()?.getAttribute('autocomplete')).toBe('off');
  expect(container.querySelector('[role="checkbox"]')?.getAttribute('aria-label')).toBe('Save for https://github.com');
  expect(container.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('false');
});

it('a one-time code field is masked and asks for digits and the code the phone offers', async () => {
  view = { ...view, kind: 'otp' };
  await render();
  expect(field()?.type).toBe('password');
  expect(field()?.getAttribute('autocomplete')).toBe('one-time-code');
  expect(field()?.getAttribute('inputmode')).toBe('numeric');
});

it('Submit sends the value unsaved, clears it at once and shows it nowhere; the outcome names the origin', async () => {
  const pending = Promise.withResolvers<RuntimeSecureInputOutcome>();
  answer = pending.promise;
  await render();
  await type(secret);
  expect(field()?.value).toBe(secret);
  await click('Submit');
  expect(requests.at(-1)).toEqual({ op: 'submit', id, value: secret, save: false });
  expect(field()?.value).toBe('');
  expect(document.documentElement.outerHTML).not.toContain(secret);
  pending.resolve({ outcome: 'provided', saved: false });
  await settle();
  expect(container.querySelector('[data-secure-input-outcome]')?.textContent).toBe('Filled into https://github.com');
  expect(field()).toBeNull();
  expect(document.documentElement.outerHTML).not.toContain(secret);
});

it('ticking Save sends save, and the outcome says the value was saved for the origin', async () => {
  answer = Promise.resolve({ outcome: 'provided', saved: true });
  await render();
  await act(async () => { container.querySelector<HTMLElement>('[role="checkbox"]')!.click(); });
  expect(container.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
  await type(secret);
  await click('Submit');
  expect(requests.at(-1)).toEqual({ op: 'submit', id, value: secret, save: true });
  expect(container.querySelector('[data-secure-input-outcome]')?.textContent).toBe('Filled into https://github.comSaved for https://github.com');
});

it('Use saved value fills the value saved for the origin by its credential id', async () => {
  view = { ...view, saved: [{ credentialId, savedAt: '2026-11-02T09:30:00.000Z' }] };
  await render();
  await click('Use saved value (saved ');
  expect(requests.at(-1)).toEqual({ op: 'useSaved', id, credentialId });
  expect(container.querySelector('[data-secure-input-outcome]')?.textContent).toBe('Filled into https://github.com');
});

it('Decline declines the request and says why nothing was filled', async () => {
  answer = Promise.resolve({ outcome: 'declined', reason: 'You declined' });
  await render();
  await click('Decline');
  expect(requests.at(-1)).toEqual({ op: 'decline', id });
  expect(container.querySelector('[data-secure-input-outcome]')?.textContent).toBe('Not filled: You declined');
  expect(field()).toBeNull();
});

it('a request already answered, expired or closed says why and takes no input', async () => {
  const states: [RuntimeSecureInputView, string][] = [
    [{ ...view, state: 'used' }, 'This request was already answered.'],
    [{ ...view, state: 'expired' }, 'This request expired before anyone answered it.'],
    [{ ...view, state: 'closed' }, 'This request was closed'],
    [{ ...view, expiresAt: new Date(Date.now() - 1000).toISOString() }, 'This request expired before anyone answered it.'],
  ];
  for (const [shown, why] of states) {
    view = shown;
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.textContent).toContain(why);
    expect(field()).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
  }
});

it('a request the account refuses shows the account\'s message and no input', async () => {
  viewStatus = 404;
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('No such request on this account');
  expect(field()).toBeNull();
});

it('opening asks for a secure-input.open step-up and sends its proof with view', async () => {
  await act(async () => root.render(<SecureInputPage id={id} />));
  await settle();
  expect(container.textContent).toContain('Confirm with your passkey to open this request.');
  expect(requests).toEqual([]);
  expect(stepUps.requested).toEqual([{ purpose: 'secure-input.open', targets: [id] }]);
  await click('Confirm with passkey');
  await settle();
  expect(requests).toEqual([{ op: 'view', id }]);
  expect(proofs).toEqual(['secure-input.open:passkey']);
  expect(stepUps.requested.at(-1)).toEqual({ purpose: 'secure-input.answer', targets: [id] });
});

it('Submit and Use saved value send the secure-input.answer proof; Decline sends none', async () => {
  view = { ...view, saved: [{ credentialId, savedAt: '2026-11-02T09:30:00.000Z' }] };
  answer = new Promise(() => undefined);
  await render();
  await type(secret);
  await click('Submit');
  expect(requests.at(-1)).toEqual({ op: 'submit', id, value: secret, save: false });
  expect(proofs.at(-1)).toBe('secure-input.answer:passkey');

  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  await click('Use saved value (saved ');
  expect(requests.at(-1)).toEqual({ op: 'useSaved', id, credentialId });
  expect(proofs.at(-1)).toBe('secure-input.answer:passkey');

  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  await click('Decline');
  expect(requests.at(-1)).toEqual({ op: 'decline', id });
  expect(proofs.at(-1)).toBeNull();
});

it('without an enrolled passkey it says so, opens with the recovery key, and answers with a recovery-key proof', async () => {
  stepUps.passkeyAvailable = false;
  await act(async () => root.render(<SecureInputPage id={id} />));
  await settle();
  expect(container.textContent).toContain('No passkey is enrolled on this account yet. Enroll one under Settings → Connections → Passkeys');
  await type('gsr_open');
  await click('Confirm with recovery key');
  await settle();
  expect(proofs).toEqual(['secure-input.open:gsr_open']);
  const submit = [...container.querySelectorAll('button')].find(button => button.textContent === 'Submit');
  await type(secret);
  expect(submit?.disabled).toBe(true);
  const recovery = container.querySelector<HTMLInputElement>('input[placeholder="gsr_…"]')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(recovery, 'gsr_answer'); recovery.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('Confirm with recovery key');
  expect(container.textContent).toContain('Recovery key accepted.');
  await click('Submit');
  expect(requests.at(-1)).toEqual({ op: 'submit', id, value: secret, save: false });
  expect(proofs.at(-1)).toBe('secure-input.answer:gsr_answer');
});

it('a step-up the account refuses on open says why and fetches a fresh challenge', async () => {
  api.handle = async () => Response.json({ status: 'error', error: { code: 'STEP_UP_ENROLL_REQUIRED', message: 'Enroll a passkey first' } }, { status: 403 });
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('This account has no passkey yet. Enroll one under Settings → Connections → Passkeys first, or confirm with your recovery key.');
  expect(stepUps.requested).toEqual([{ purpose: 'secure-input.open', targets: [id] }, { purpose: 'secure-input.open', targets: [id] }]);
  expect(field()).not.toBeNull();
});
