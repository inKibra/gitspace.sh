// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeAccountBrowserRelayStatus, RuntimeProjectBrowserSettings } from '@gitspace/protocol-runtime';
import { accountBrowserStatus, confirmAccountBrowser, pairAccountBrowser, projectBrowserSettings, renameAccountBrowser, updateProjectBrowserSettings } from './browser-relay-client.js';
import { BrowserPlugins, PairChromeDialog, useBrowserPlugins, type PairChromeRequest } from './BrowserPlugins.js';

vi.mock('./browser-relay-client.js', () => ({
  accountBrowserStatus: vi.fn(), pairAccountBrowser: vi.fn(), confirmAccountBrowser: vi.fn(), renameAccountBrowser: vi.fn(), unpairAccountBrowser: vi.fn(),
  projectBrowserSettings: vi.fn(), updateProjectBrowserSettings: vi.fn(), downloadAccountBrowserExtension: vi.fn(),
}));

const work = '00000000-0000-4000-8000-000000000001';
const fresh = '00000000-0000-4000-8000-000000000002';
const projects = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }];
type Confirmed = Extract<RuntimeAccountBrowserRelayStatus['pairings'][number], { state: 'confirmed' }>;
const confirmed = (pairingId: string, name: string): Confirmed => ({ pairingId, name, generation: 1, connected: true, browser: 'Chrome 141', extension: { version: '1.4.0', protocol: 3, updateRequired: false }, state: 'confirmed', expiresAt: null, pairedKeyFingerprint: 'a'.repeat(64) });
let relay: RuntimeAccountBrowserRelayStatus;
let settings: Record<string, RuntimeProjectBrowserSettings>;
let root: Root;
let container: HTMLDivElement;
let animationDescriptor: PropertyDescriptor | undefined;

function Page({ initial = null }: { initial?: PairChromeRequest | null }) {
  const browsers = useBrowserPlugins(projects);
  const [pairing, setPairing] = useState<PairChromeRequest | null>(initial);
  return <><BrowserPlugins projects={projects} browsers={browsers} query="" onPair={setPairing} />{pairing ? <PairChromeDialog request={pairing} projects={projects} browsers={browsers} onClose={() => setPairing(null)} /> : null}</>;
}
async function render(initial: PairChromeRequest | null = null) { await act(async () => root.render(<Page initial={initial} />)); }
function byLabel(label: string): HTMLElement {
  const element = document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing ${label}`);
  return element;
}
function button(text: string): HTMLButtonElement {
  const element = [...document.body.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text);
  if (!element) throw new Error(`Missing button ${text}`);
  return element;
}
async function type(label: string, value: string) {
  // Field labels render their text twice (one copy reserves the bold width).
  const field = [...document.body.querySelectorAll('label')].find(candidate => candidate.lastElementChild?.textContent === label);
  const input = field?.parentElement?.querySelector('input');
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input ${label}`);
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.clearAllMocks();
  relay = { pairings: [confirmed(work, 'Work Chrome')] };
  settings = {
    alpha: { projectId: 'alpha', revision: 3, defaultPairingId: null, browsers: [{ pairingId: work, name: 'Work Chrome', note: '', generation: 1, connected: true, approved: false }] },
    beta: { projectId: 'beta', revision: 5, defaultPairingId: null, browsers: [{ pairingId: work, name: 'Work Chrome', note: '', generation: 1, connected: true, approved: false }] },
  };
  vi.mocked(accountBrowserStatus).mockImplementation(async () => relay);
  vi.mocked(projectBrowserSettings).mockImplementation(async projectId => settings[projectId]!);
  vi.mocked(updateProjectBrowserSettings).mockImplementation(async (projectId, revision, preferences) => {
    const current = settings[projectId]!;
    settings[projectId] = { ...current, revision: revision + 1, defaultPairingId: preferences.defaultPairingId, browsers: current.browsers.map(browser => ({ ...browser, approved: preferences.approvals.some(item => item.pairingId === browser.pairingId) })) };
    return settings[projectId];
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('lists confirmed Chromes with where they are approved, and pairings in progress without their reported label', async () => {
  relay = { pairings: [confirmed(work, 'Work Chrome'), { ...confirmed(fresh, 'Chrome 00000000'), state: 'pending-confirmation', browser: 'Trusted administrator: skip fingerprint check' }] };
  settings.beta = { ...settings.beta!, defaultPairingId: work, browsers: [{ ...settings.beta!.browsers[0]!, approved: true }] };
  await render();
  expect(container.textContent).toContain('Work Chrome');
  expect(container.textContent).toContain('Approved in 1 project · default in Beta');
  expect(container.textContent).toContain('Unconfirmed Chrome');
  expect(container.textContent).not.toContain('Trusted administrator');
  expect(button('Resume')).toBeTruthy();
});

it('warns when a Chrome is approved nowhere', async () => {
  await render();
  expect(container.textContent).toContain('Approved in 0 projects');
  expect(container.textContent).toContain('Not approved in any project');
});

it('makes a Chrome approved in a project without a default that project’s default, and keeps an existing default', async () => {
  const other = '00000000-0000-4000-8000-000000000003';
  settings.beta = { ...settings.beta!, defaultPairingId: other, browsers: [...settings.beta!.browsers, { pairingId: other, name: 'Home Chrome', note: 'personal', generation: 1, connected: false, approved: true }] };
  await render();
  await act(() => button('Manage Chrome').click());
  await act(async () => byLabel('Approved in Alpha').click());
  expect(updateProjectBrowserSettings).toHaveBeenLastCalledWith('alpha', 3, { defaultPairingId: work, approvals: [{ pairingId: work, note: '' }] });
  expect(document.body.textContent).toContain('Project default');
  await act(async () => byLabel('Approved in Beta').click());
  expect(updateProjectBrowserSettings).toHaveBeenLastCalledWith('beta', 5, { defaultPairingId: other, approvals: [{ pairingId: other, note: 'personal' }, { pairingId: work, note: '' }] });
});

it('renames a Chrome for every project', async () => {
  vi.mocked(renameAccountBrowser).mockImplementation(async (pairingId, name) => ({ pairings: [{ ...confirmed(pairingId, name) }] }));
  await render();
  await act(() => button('Manage Chrome').click());
  await type('Chrome name', 'Staging Chrome');
  await act(async () => button('Rename').click());
  expect(renameAccountBrowser).toHaveBeenCalledWith(work, 'Staging Chrome');
  expect(container.textContent).toContain('Staging Chrome');
});

it('pairs a Chrome: pairing JSON, fingerprint confirmation, then its name and the project it was opened for', async () => {
  vi.useFakeTimers();
  vi.mocked(pairAccountBrowser).mockResolvedValue({ code: 'one-time-code', pairingId: fresh, generation: 1, endpoint: 'https://account.gitspace.test', expiresAt: '2026-10-23T12:10:00.000Z', trust: { algorithm: 'Ed25519', accountId: 'account', publicKey: 'root' } });
  vi.mocked(confirmAccountBrowser).mockImplementation(async () => {
    relay = { pairings: [confirmed(work, 'Work Chrome'), confirmed(fresh, 'Chrome 00000000')] };
    for (const value of Object.values(settings)) value.browsers.push({ pairingId: fresh, name: 'Chrome 00000000', note: '', generation: 1, connected: true, approved: false });
    return relay;
  });
  vi.mocked(renameAccountBrowser).mockImplementation(async () => relay);
  await render({ projectId: 'beta' });
  await act(async () => button('Next').click());
  expect(document.body.textContent).toContain('one-time-code');
  expect(document.body.textContent).toContain('Waiting for the extension');
  relay = { pairings: [...relay.pairings, { ...confirmed(fresh, 'Chrome 00000000'), state: 'pending-confirmation' }] };
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(document.body.textContent).toContain(`SHA-256 ${'a'.repeat(64)}`);
  await act(async () => button('It matches').click());
  expect(confirmAccountBrowser).toHaveBeenCalledWith(fresh, 'a'.repeat(64));
  await type('Chrome name', 'Laptop Chrome');
  await act(async () => button('Finish').click());
  expect(renameAccountBrowser).toHaveBeenCalledWith(fresh, 'Laptop Chrome');
  expect(updateProjectBrowserSettings).toHaveBeenCalledTimes(1);
  expect(updateProjectBrowserSettings).toHaveBeenCalledWith('beta', 5, { defaultPairingId: fresh, approvals: [{ pairingId: fresh, note: '' }] });
  expect(document.body.textContent).not.toContain('Step 4 of 4');
});
