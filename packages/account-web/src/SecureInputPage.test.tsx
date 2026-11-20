// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSecureInputPageRequestSchema, SECURE_INPUT_API_PATH, type RuntimeSecureInputOutcome, type RuntimeSecureInputPageRequest, type RuntimeSecureInputView } from '@gitspace/protocol-runtime/secure-input';
import { SecureInputPage } from './SecureInputPage.js';

// The page's signed fetch, answered by each test: `view` for op view, `answer` for submit, useSaved and decline.
const api = vi.hoisted(() => ({ handle: async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new Error('No API in this test'); } }));
vi.mock('./device.js', () => ({
  DeviceRejectedError: class extends Error {},
  loadDevice: async () => null,
  createDeviceSignedFetch: () => (input: RequestInfo | URL, init?: RequestInit) => api.handle(input, init),
}));

const id = 'B'.repeat(43);
const secret = 'hunter2-correct-horse';
const credentialId = '00000000-0000-4000-8000-0000000000c3';
let view: RuntimeSecureInputView;
let viewStatus: number;
let answer: Promise<RuntimeSecureInputOutcome>;
let requests: RuntimeSecureInputPageRequest[];
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  view = { id, state: 'open', workspace: 'checkout-fix', purpose: 'Sign in to GitHub as octocat', origin: 'https://github.com', kind: 'password', source: 'chrome', browser: 'Studio desktop', title: 'Sign in to GitHub · GitHub', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), saved: [] };
  viewStatus = 200;
  answer = Promise.resolve({ outcome: 'provided', saved: false });
  requests = [];
  api.handle = async (input, init) => {
    expect(String(input)).toBe(SECURE_INPUT_API_PATH);
    const sent = RuntimeSecureInputPageRequestSchema.parse(JSON.parse(String(init?.body)));
    requests.push(sent);
    if (sent.op !== 'view') return Response.json({ status: 'ok', value: await answer });
    return viewStatus === 200 ? Response.json({ status: 'ok', value: view }) : Response.json({ status: 'error', error: { code: 'SECURE_INPUT_NOT_FOUND', message: 'No such request on this account' } }, { status: viewStatus });
  };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function settle() { await act(async () => { const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, 0); await tick.promise; }); }
async function render() { await act(async () => root.render(<SecureInputPage id={id} />)); await settle(); }
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
