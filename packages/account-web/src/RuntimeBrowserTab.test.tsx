// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema, type RuntimeBrowserOverview, type RuntimeBrowserPreview, type RuntimeProjectBrowserSettings } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand } from '@gitspace/protocol-runtime/session-controls';
import { projectBrowserSettings, updateProjectBrowserSettings } from './browser-relay-client.js';
import { BROWSER_REFRESH_MS, RuntimeBrowserTab } from './RuntimeBrowserTab.js';

const rpc = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: rpc } }));
vi.mock('./browser-relay-client.js', () => ({ projectBrowserSettings: vi.fn(), updateProjectBrowserSettings: vi.fn() }));

const work = '00000000-0000-4000-8000-000000000001';
const group = '00000000-0000-4000-8000-0000000000aa';
const snapshot = RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 0, conversations: [], attachments: [], tasks: [], questions: [], documents: {} });
const empty = { groupId: null, groupName: null, running: 0, tabs: [] };
let overview: RuntimeBrowserOverview;
let previews: Record<string, RuntimeBrowserPreview>;
let container: HTMLDivElement;
let root: Root;
const commands = (type: RuntimeSessionCommand['type']) => rpc.session.mock.calls.filter(([input]) => input.command.type === type);
function button(text: string): HTMLButtonElement {
  const element = [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text);
  if (!element) throw new Error(`Missing button ${text}`);
  return element;
}
async function render() { await act(async () => root.render(<RuntimeBrowserTab snapshot={snapshot} machines={[]} onOpenEnvironment={() => {}} />)); }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.clearAllMocks();
  overview = { sites: { origins: ['https://app.example.com', 'https://bank.example.com'], stepsOnly: ['https://bank.example.com'] }, cloud: { groupId: null, running: 0, tabs: [] }, chromes: [{ pairingId: work, name: 'Work Chrome', note: '', connected: true, approved: false, isDefault: false, ...empty }] };
  previews = {};
  rpc.session.mockImplementation(async ({ command }: { command: RuntimeSessionCommand }) => {
    if (command.type === 'browserOverview') return { status: 'ok', value: { control: {}, browserOverview: overview } };
    if (command.type === 'browserPreview') return { status: 'ok', value: { control: {}, browserPreview: previews[command.targetId] } };
    if (command.type === 'browserRevoke') return { status: 'ok', value: { control: {} } };
    if (command.type === 'browserStatus') return { status: 'ok', value: { control: {}, browserStatus: { groups: [], records: [] } } };
    throw new Error(`Unexpected ${command.type}`);
  });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows approved sites with their level', async () => {
  await render();
  const sites = container.querySelector('[aria-label="Approved sites"]')!;
  expect(sites.textContent).toContain('https://app.example.comscripts');
  expect(sites.textContent).toContain('https://bank.example.comsingle steps');
});

it('offers to approve a confirmed Chrome when none is approved here, making it the default', async () => {
  const settings: RuntimeProjectBrowserSettings = { projectId: 'project', revision: 4, defaultPairingId: null, browsers: [{ pairingId: work, name: 'Work Chrome', note: 'staging admin', generation: 1, connected: true, approved: false }] };
  vi.mocked(projectBrowserSettings).mockResolvedValue(settings);
  vi.mocked(updateProjectBrowserSettings).mockImplementation(async () => { overview = { ...overview, chromes: overview.chromes.map(chrome => ({ ...chrome, approved: true, isDefault: true })) }; return settings; });
  await render();
  expect(container.textContent).toContain("Agents here can't use your Chrome yet");
  await act(async () => button('Approve Work Chrome for this project').click());
  expect(updateProjectBrowserSettings).toHaveBeenCalledWith('project', 4, { defaultPairingId: work, approvals: [{ pairingId: work, note: 'staging admin' }] });
  expect(container.textContent).not.toContain("Agents here can't use your Chrome yet");
  expect(container.querySelector(`[aria-label="Work Chrome"]`)?.textContent).toContain('Project default');
});

it('links to pairing when no Chrome is confirmed on the account', async () => {
  overview = { ...overview, chromes: [] };
  await render();
  await act(async () => button('Pair a Chrome').click());
  expect(window.location.pathname).toBe('/plugins');
  expect(new URL(window.location.href).searchParams.get('pair')).toBe('project');
});

it('shows each tab with who opened it and its preview, or why there is none, and no recovery section without records', async () => {
  overview = { ...overview, chromes: [{ pairingId: work, name: 'Work Chrome', note: '', connected: true, approved: true, isDefault: true, groupId: group, groupName: 'feature-login', running: 2, tabs: [
    { targetId: 'tab-a', url: 'https://app.example.com/login', title: 'Login', addedBy: 'agent', usable: true },
    { targetId: 'tab-b', url: 'https://app.example.com/settings', title: 'Settings', addedBy: 'you', usable: true },
  ] }] };
  previews = {
    'tab-a': { targetId: 'tab-a', capturedAt: '2026-10-23T12:00:00.000Z', image: { mediaType: 'image/jpeg', data: 'aW1hZ2U=' }, reason: null },
    'tab-b': { targetId: 'tab-b', capturedAt: '2026-10-23T12:00:00.000Z', image: null, reason: 'Preview appears while the agent uses this tab' },
  };
  await render();
  const chrome = container.querySelector('[aria-label="Work Chrome"]')!;
  expect(chrome.textContent).toContain('feature-login');
  expect(chrome.textContent).toContain('▶ running 2');
  expect(chrome.textContent).toContain('Opened by agent');
  expect(chrome.textContent).toContain('You added it');
  expect(chrome.querySelector('img[alt="Preview of Login"]')?.getAttribute('src')).toBe('data:image/jpeg;base64,aW1hZ2U=');
  expect(chrome.textContent).toContain('Preview appears while the agent uses this tab');
  expect(commands('browserPreview').map(([input]) => input.command)).toEqual([{ type: 'browserPreview', groupId: group, targetId: 'tab-a' }, { type: 'browserPreview', groupId: group, targetId: 'tab-b' }]);
  expect(container.querySelector('[aria-label="Browser recovery"]')).toBeNull();
  expect(container.textContent).not.toContain('No browser groups');
});

it('rereads the overview and visible previews every ten seconds', async () => {
  vi.useFakeTimers();
  overview = { ...overview, cloud: { groupId: group, running: 0, tabs: [{ targetId: 'tab-c', url: 'https://app.example.com', title: 'App', addedBy: null, usable: true }] } };
  previews = { 'tab-c': { targetId: 'tab-c', capturedAt: '2026-10-23T12:00:00.000Z', image: null, reason: 'The cloud browser is not running' } };
  await render();
  expect(commands('browserOverview')).toHaveLength(1);
  expect(commands('browserPreview')).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_REFRESH_MS); });
  expect(commands('browserOverview')).toHaveLength(2);
  expect(commands('browserPreview')).toHaveLength(2);
});

it('revokes this workspace\'s group on a Chrome only after you confirm, then shows it without a group', async () => {
  overview = { ...overview, chromes: [{ pairingId: work, name: 'Work Chrome', note: '', connected: true, approved: true, isDefault: true, groupId: group, groupName: 'feature-login', running: 0, tabs: [] }] };
  const confirm = vi.fn(() => false);
  vi.stubGlobal('confirm', confirm);
  await render();
  await act(async () => button('Revoke access').click());
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(commands('browserRevoke')).toHaveLength(0);
  confirm.mockReturnValue(true);
  overview = { ...overview, chromes: overview.chromes.map(chrome => ({ ...chrome, groupId: null, groupName: null })) };
  await act(async () => button('Revoke access').click());
  expect(commands('browserRevoke').map(([input]) => input.command)).toEqual([{ type: 'browserRevoke', groupId: group }]);
  expect(container.querySelector('[aria-label="Work Chrome"]')?.textContent).toContain('No tab group yet');
});
