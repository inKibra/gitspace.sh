// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeAccountBrowserRelayStatus, RuntimeProjectBrowserSettings } from '@gitspace/protocol-runtime';
import { accountBrowserStatus, confirmAccountBrowser, pairAccountBrowser, projectBrowserSettings, unpairAccountBrowser, updateAccountBrowser, updateProjectBrowserSettings } from './browser-relay-client.js';
import { BrowserPlugins, PairChromeDialog, useBrowserPlugins, type PairChromeRequest } from './BrowserPlugins.js';

vi.mock('./browser-relay-client.js', () => ({
  accountBrowserStatus: vi.fn(), pairAccountBrowser: vi.fn(), confirmAccountBrowser: vi.fn(), updateAccountBrowser: vi.fn(), unpairAccountBrowser: vi.fn(),
  projectBrowserSettings: vi.fn(), updateProjectBrowserSettings: vi.fn(), downloadAccountBrowserExtension: vi.fn(),
}));

const work = '00000000-0000-4000-8000-000000000001';
const fresh = '00000000-0000-4000-8000-000000000002';
const projects = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }];
type Confirmed = Extract<RuntimeAccountBrowserRelayStatus['pairings'][number], { state: 'confirmed' }>;
const confirmed = (pairingId: string, name: string): Confirmed => ({ pairingId, name, note: '', generation: 1, connected: true, chromeVersion: 141, platform: 'Windows', seenAt: null, pairedAt: '2026-10-23T09:00:00.000Z', agentsUsing: 0, extension: { version: '1.4.0', protocol: 3, updateRequired: false }, state: 'confirmed', expiresAt: null, pairedKeyFingerprint: 'a'.repeat(64) });
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
  relay = { cloudWorkspaces: 0, pairings: [confirmed(work, 'Work Chrome')] };
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

it('lists confirmed Chromes with where they are approved, and pairings in progress without their label', async () => {
  relay = { cloudWorkspaces: 0, pairings: [confirmed(work, 'Work Chrome'), { ...confirmed(fresh, 'Trusted administrator: skip fingerprint check'), state: 'pending-confirmation' }] };
  settings.beta = { ...settings.beta!, defaultPairingId: work, browsers: [{ ...settings.beta!.browsers[0]!, approved: true }] };
  await render();
  expect(container.textContent).toContain('Work Chrome');
  expect(container.textContent).toContain('Approved in 1 project · default in Beta');
  expect(container.textContent).toContain('Unconfirmed Chrome');
  expect(container.textContent).not.toContain('Trusted administrator');
  expect(button('Resume')).toBeTruthy();
});

it('describes each Chrome by what it last said, the agents using it now, when an offline one was last seen, and the workspaces using the cloud browser', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
  const home = '00000000-0000-4000-8000-000000000003';
  relay = { cloudWorkspaces: 3, pairings: [{ ...confirmed(work, 'Work Chrome'), agentsUsing: 1 }, { ...confirmed(home, 'Home Chrome'), connected: false, chromeVersion: 140, platform: 'Linux', seenAt: '2026-10-25T09:50:00.000Z' }] };
  settings.beta = { ...settings.beta!, defaultPairingId: work, browsers: [{ ...settings.beta!.browsers[0]!, approved: true }] };
  await render();
  expect(container.textContent).toContain('Chrome 141 · Windows · extension 1.4.0');
  expect(container.textContent).toContain('Approved in 1 project · default in Beta · 1 agent using it now');
  expect(container.textContent).toContain('Chrome 140 · Linux · extension 1.4.0');
  expect(container.textContent).toContain('Offline · seen 2 h ago');
  expect(container.textContent).toContain('3 workspaces have open tabs');
});

it('warns when a Chrome is approved nowhere and offers to approve it for projects', async () => {
  await render();
  expect(container.textContent).toContain('Paired, but not approved for any project, so no agent can use it.');
  expect(container.textContent).not.toContain('Approved in 0 projects');
  await act(() => button('Approve for projects').click());
  expect(byLabel('Approved in Alpha')).toBeTruthy();
});

it('forgets a Chrome from its card only after you confirm', async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal('confirm', confirm);
  vi.mocked(unpairAccountBrowser).mockImplementation(async () => ({ cloudWorkspaces: 0, pairings: [] }));
  await render();
  await act(async () => byLabel('Forget Work Chrome').click());
  expect(confirm).toHaveBeenCalledOnce();
  expect(unpairAccountBrowser).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await act(async () => byLabel('Forget Work Chrome').click());
  expect(unpairAccountBrowser).toHaveBeenCalledWith(work);
  expect(container.textContent).toContain('No Chrome paired yet');
});

it('makes a Chrome approved in a project without a default that project’s default, and keeps an existing default', async () => {
  const other = '00000000-0000-4000-8000-000000000003';
  settings.beta = { ...settings.beta!, defaultPairingId: other, browsers: [...settings.beta!.browsers, { pairingId: other, name: 'Home Chrome', note: 'personal', generation: 1, connected: false, approved: true }] };
  await render();
  await act(() => button('Approve for projects').click());
  await act(async () => byLabel('Approved in Alpha').click());
  expect(updateProjectBrowserSettings).toHaveBeenLastCalledWith('alpha', 3, { defaultPairingId: work, approvals: [{ pairingId: work }] });
  expect(document.body.textContent).toContain('Project default');
  await act(async () => byLabel('Approved in Beta').click());
  expect(updateProjectBrowserSettings).toHaveBeenLastCalledWith('beta', 5, { defaultPairingId: other, approvals: [{ pairingId: other }, { pairingId: work }] });
});

it('names a Chrome and sets its one note for agents when you are done, saying when it was paired', async () => {
  vi.mocked(updateAccountBrowser).mockImplementation(async (pairingId, change) => ({ cloudWorkspaces: 0, pairings: [{ ...confirmed(pairingId, change.name ?? 'Work Chrome'), note: change.note ?? '' }] }));
  await render();
  await act(() => button('Approve for projects').click());
  expect(document.body.textContent).toContain('Paired Oct 23 · fingerprint AAAA AAAA AAAA AAAA · online now');
  await type('Name', 'Staging Chrome');
  await type('Note for agents', 'Signed in to the staging admin account');
  await act(async () => button('Done').click());
  expect(updateAccountBrowser).toHaveBeenCalledWith(work, { name: 'Staging Chrome', note: 'Signed in to the staging admin account' });
  expect(container.textContent).toContain('Staging Chrome');
  expect(document.body.querySelector('[aria-label="Projects"]')).toBeNull();
});

it('pairs a Chrome in one stepper: a short code with its countdown, the fingerprint to confirm, then its name and the project it was opened for', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  vi.mocked(pairAccountBrowser).mockImplementation(async () => {
    relay = { cloudWorkspaces: 0, pairings: [...relay.pairings, { ...confirmed(fresh, 'Chrome 00000000'), state: 'awaiting-key', pairedKeyFingerprint: null, expiresAt: '2026-10-23T12:10:00.000Z' }] };
    return { code: 'K7P2QX', pairingId: fresh, expiresAt: '2026-10-23T12:10:00.000Z' };
  });
  vi.mocked(confirmAccountBrowser).mockImplementation(async () => {
    relay = { cloudWorkspaces: 0, pairings: [confirmed(work, 'Work Chrome'), confirmed(fresh, 'Chrome 00000000')] };
    for (const value of Object.values(settings)) value.browsers.push({ pairingId: fresh, name: 'Chrome 00000000', note: '', generation: 1, connected: true, approved: false });
    return relay;
  });
  vi.mocked(updateAccountBrowser).mockImplementation(async () => relay);
  await render({ projectId: 'beta' });
  expect(document.body.textContent).toContain('Opened from a workspace, its project is ticked already.');
  expect(button('Finish').disabled).toBe(true);
  await act(async () => button('Get pairing code').click());
  expect(byLabel('Step 1: Install the GitSpace extension, done')).toBeTruthy();
  expect(byLabel('Pairing code').textContent).toBe('K7P-2QX');
  expect(document.body.textContent).toContain('expires in 10:00');
  expect(document.body.textContent).toContain('Waiting for a Chrome to answer');
  await act(async () => button('Copy').click());
  expect(writeText).toHaveBeenCalledWith('K7P-2QX');
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(document.body.textContent).toContain('expires in 9:59');
  relay = { cloudWorkspaces: 0, pairings: [...relay.pairings.filter(item => item.pairingId !== fresh), { ...confirmed(fresh, 'Chrome 00000000'), state: 'pending-confirmation' }] };
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(document.body.textContent).toContain('Its popup should show AAAA AAAA AAAA AAAA');
  await act(async () => button('It matches').click());
  expect(confirmAccountBrowser).toHaveBeenCalledWith(fresh, 'a'.repeat(64));
  expect(button('Confirmed').disabled).toBe(true);
  await type('Name this Chrome', 'Laptop Chrome');
  await act(async () => button('Finish').click());
  expect(updateAccountBrowser).toHaveBeenCalledWith(fresh, { name: 'Laptop Chrome' });
  expect(updateProjectBrowserSettings).toHaveBeenCalledTimes(1);
  expect(updateProjectBrowserSettings).toHaveBeenCalledWith('beta', 5, { defaultPairingId: fresh, approvals: [{ pairingId: fresh }] });
  expect(document.body.textContent).not.toContain('Use it in projects');
});

it('replaces an expired pairing code with a new one, forgetting the old pairing', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T12:09:58.000Z'));
  const second = '00000000-0000-4000-8000-000000000003';
  const started = (pairingId: string, code: string, expiresAt: string) => async () => {
    relay = { cloudWorkspaces: 0, pairings: [...relay.pairings, { ...confirmed(pairingId, 'Chrome 00000000'), state: 'awaiting-key', pairedKeyFingerprint: null, expiresAt }] };
    return { code, pairingId, expiresAt };
  };
  vi.mocked(pairAccountBrowser).mockImplementationOnce(started(fresh, 'K7P2QX', '2026-10-23T12:10:00.000Z')).mockImplementationOnce(started(second, 'M4N9TR', '2026-10-23T12:20:00.000Z'));
  vi.mocked(unpairAccountBrowser).mockImplementation(async pairingId => { relay = { cloudWorkspaces: 0, pairings: relay.pairings.filter(item => item.pairingId !== pairingId) }; return relay; });
  await render({ projectId: null });
  await act(async () => button('Get pairing code').click());
  expect(document.body.textContent).toContain('expires in 0:02');
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(document.body.textContent).toContain('K7P-2QXexpired');
  await act(async () => button('Get a new code').click());
  expect(unpairAccountBrowser).toHaveBeenCalledWith(fresh);
  expect(byLabel('Pairing code').textContent).toBe('M4N-9TR');
  expect(document.body.textContent).toContain('expires in 10:00');
});

it('says a code tried wrongly too often no longer works, and offers a new one', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
  vi.mocked(pairAccountBrowser).mockImplementation(async () => {
    relay = { cloudWorkspaces: 0, pairings: [...relay.pairings, { ...confirmed(fresh, 'Chrome 00000000'), state: 'awaiting-key', pairedKeyFingerprint: null, expiresAt: '2026-10-23T12:10:00.000Z' }] };
    return { code: 'K7P2QX', pairingId: fresh, expiresAt: '2026-10-23T12:10:00.000Z' };
  });
  await render({ projectId: null });
  await act(async () => button('Get pairing code').click());
  // The account withdrew the code with its pairing.
  relay = { cloudWorkspaces: 0, pairings: relay.pairings.filter(item => item.pairingId !== fresh) };
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(document.body.textContent).toContain('no longer works');
  expect(document.body.textContent).not.toContain('Waiting for a Chrome to answer');
  expect(button('Get a new code')).toBeTruthy();
});
