// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workspaceLiveKey } from '@gitspace/protocol/live-notice';
import type { z } from 'zod';
import { RuntimeBrowserOverviewSchema, RuntimeSnapshotSchema, type RuntimeBrowserCapture, type RuntimeBrowserCaptureView, type RuntimeBrowserCaptureShare, type RuntimeBrowserComment, type RuntimeBrowserCommentThreadView, type RuntimeBrowserGroupAgent, type RuntimeBrowserPreview, type RuntimeBrowserRun, type RuntimeBrowserShare, type RuntimeProjectBrowserSettings } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand } from '@gitspace/protocol-runtime/session-controls';
import { projectBrowserSettings, updateProjectBrowserSettings } from './browser-relay-client.js';
import { liveNotices } from './live-notices.js';
import { FRAMES_AHEAD } from './capture/CapturePlayer.js';
import { BROWSER_REFRESH_MS, browserActivity, RuntimeBrowserTab, useWorkspaceBrowsers, WATCH_REFRESH_MS } from './RuntimeBrowserTab.js';

const rpc = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: rpc } }));
vi.mock('./browser-relay-client.js', () => ({ projectBrowserSettings: vi.fn(), updateProjectBrowserSettings: vi.fn() }));
// The live Watch dialog signs its socket with this browser's device; these tests have none, so it never connects.
vi.mock('./device-session.js', () => ({ currentDevice: vi.fn(async () => null), deviceRejected: vi.fn() }));

const work = '00000000-0000-4000-8000-000000000001';
const group = '00000000-0000-4000-8000-0000000000aa';
const home = '00000000-0000-4000-8000-000000000002';
const homeGroup = '00000000-0000-4000-8000-0000000000ab';
const cloudGroup = '00000000-0000-4000-8000-0000000000ac';
const machineGroup = '00000000-0000-4000-8000-0000000000bb';
const snapshot = RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 0, conversations: [], attachments: [], tasks: [], questions: [], documents: {} });
const empty = { groupId: null, groupName: null, groupColor: null, running: 0, agents: [], tabs: [] };
const started = '2026-10-24T12:00:00.000Z';
/** The main agent's script on a Chrome, begun 12 s before `started`. */
const acting: RuntimeBrowserGroupAgent = { agent: 'main', tool: 'run', commands: 4, startedAt: '2026-10-24T11:59:48.000Z', doing: 'Clicking “Medium”' };
/** The overview as the workspace answers it, before defaults. */
let overview: z.input<typeof RuntimeBrowserOverviewSchema>;
let previews: Record<string, RuntimeBrowserPreview>;
let captures: RuntimeBrowserCaptureView[];
let shares: RuntimeBrowserShare[];
let comments: RuntimeBrowserCommentThreadView[];
let captureShares: RuntimeBrowserCaptureShare[];
let container: HTMLDivElement;
let root: Root;
const commands = (type: RuntimeSessionCommand['type']) => rpc.session.mock.calls.filter(([input]) => input.command.type === type);
function button(text: string): HTMLButtonElement {
  const element = [...document.body.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text);
  if (!element) throw new Error(`Missing button ${text}`);
  return element;
}
function labelled(label: string): HTMLElement {
  const element = document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing ${label}`);
  return element;
}
function filter(label: string): HTMLElement {
  const element = [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find(candidate => candidate.textContent?.includes(label));
  if (!element) throw new Error(`Missing filter ${label}`);
  return element;
}
function Tab({ machines, onCompose }: { machines: readonly { id: string; label: string }[]; onCompose?: (text: string) => void }) {
  const browsers = useWorkspaceBrowsers(snapshot, undefined);
  return <RuntimeBrowserTab snapshot={snapshot} projectName="Golconda" browsers={browsers} machines={machines} onOpenEnvironment={() => {}} onCompose={onCompose} />;
}
async function render(machines: readonly { id: string; label: string }[] = [], onCompose?: (text: string) => void) { await act(async () => root.render(<Tab machines={machines} onCompose={onCompose} />)); }
/** Lets fetches, their bodies and the renders they cause finish. */
async function settle() { for (let round = 0; round < 5; round += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
function share(id: number, fields: Partial<RuntimeBrowserShare> = {}): RuntimeBrowserShare {
  const shareId = `00000000-0000-4000-8000-0000000000e${id}`;
  return { shareId, link: `https://account.test/s/${shareId}#Zq3x_Kd8-Pw0aB7cD9eF1gH2iJ4kL5mN6oP8rS0tU2v${id}`, pairingId: work, browser: 'Work Chrome', targetId: 'tab-a', workspace: { projectId: 'project', workspaceId: 'workspace', groupId: group }, page: { url: 'https://app.example.com/login', title: 'Login' }, comment: false, createdAt: started, expiresAt: '2026-10-24T13:00:00.000Z', endedAt: null, endReason: null, viewers: [], audit: [], ...fields };
}
const threadId = (id: number) => `00000000-0000-4000-8000-0000000000f${id}`;
const ana: RuntimeBrowserComment['by'] = { kind: 'person', name: 'Ana', guest: true };
/** A thread on the login page, its root by `by`; `fields` change the root. */
function thread(id: number, text: string, by: RuntimeBrowserComment['by'], fields: Partial<RuntimeBrowserComment> = {}, cropUrl: string | null = null, replies: RuntimeBrowserComment[] = []): RuntimeBrowserCommentThreadView {
  const root: RuntimeBrowserComment = { id: threadId(id), threadId: threadId(id), parentId: null, source: { kind: 'chrome', pairingId: work }, page: { url: 'https://app.example.com/login', title: 'Login' }, anchor: { role: 'button', name: 'Sign in', selector: '#sign-in', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } }, by, text, createdAt: started, resolved: null, ...fields };
  return { cropUrl, thread: { root, replies } };
}
function reply(id: number, root: string, text: string, by: RuntimeBrowserComment['by']): RuntimeBrowserComment {
  return { id: `00000000-0000-4000-8000-0000000001f${id}`, threadId: root, parentId: root, source: { kind: 'chrome', pairingId: work }, page: { url: 'https://app.example.com/login', title: 'Login' }, anchor: null, by, text, createdAt: started, resolved: null };
}
const chromeWithTab = (): z.input<typeof RuntimeBrowserOverviewSchema>['chromes'] => [{ pairingId: work, name: 'Work Chrome', note: '', connected: true, approved: true, isDefault: true, groupId: group, groupName: 'feature-login', groupColor: null, running: 0, agents: [], tabs: [{ targetId: 'tab-a', url: 'https://app.example.com/login', title: 'Login', addedBy: 'you', usable: true }] }];
function run(id: number, fields: Partial<RuntimeBrowserRun> = {}): RuntimeBrowserRun {
  return { attemptId: `attempt-${id}`, at: started, where: { kind: 'cloud' }, tool: 'run', summary: `Run ${id}`, outcome: 'ok', durationMs: 1200, details: [], ...fields };
}
/** `HH:MM` of `iso` in local time. */
function clock(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
function capture(id: number, fields: Partial<RuntimeBrowserCapture>, files: Record<string, string> = {}): RuntimeBrowserCaptureView {
  return { capture: { version: 2, captureId: `00000000-0000-4000-8000-0000000000c${id}`, name: `Capture ${id}`, by: 'agent', source: 'headless', browser: 'Cloud browser', page: { url: 'https://app.example.com', title: 'App' }, target: null, startedAt: started, endedAt: started, state: 'saved', reason: null, tracks: {}, ...fields }, files };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.clearAllMocks();
  overview = { sites: { origins: [{ pattern: 'httpbin.org', level: 'interact' }, { pattern: 'github.com', level: 'read' }, { pattern: 'localhost', level: 'full' }], revision: null }, cloud: { groupId: null, running: 0, tabs: [] }, machines: [], chromes: [{ pairingId: work, name: 'Work Chrome', note: '', connected: true, approved: false, isDefault: false, ...empty }], runs: [] };
  previews = {};
  captures = [];
  shares = [];
  comments = [];
  captureShares = [];
  rpc.session.mockImplementation(async ({ command }: { command: RuntimeSessionCommand }) => {
    // Decoded with its defaults, as the RPC client decodes every answer.
    if (command.type === 'browserOverview') return { status: 'ok', value: { control: {}, browserOverview: RuntimeBrowserOverviewSchema.parse(overview) } };
    if (command.type === 'browserPreview') return { status: 'ok', value: { control: {}, browserPreview: previews[command.targetId] } };
    if (command.type === 'browserRevoke' || command.type === 'browserStop' || command.type === 'browserCloseTab' || command.type === 'browserFocusTab' || command.type === 'browserCommentShow') return { status: 'ok', value: { control: {} } };
    if (command.type === 'browserStatus') return { status: 'ok', value: { control: {}, browserStatus: { groups: [], records: [] } } };
    if (command.type === 'browserCaptures') return { status: 'ok', value: { control: {}, browserCaptures: captures } };
    if (command.type === 'browserCaptureStart') {
      const recording = capture(9, { name: 'Recording of App', by: 'you', target: { groupId: command.groupId, targetId: command.targetId }, startedAt: new Date().toISOString(), endedAt: null, state: 'recording' });
      captures = [recording, ...captures];
      return { status: 'ok', value: { control: {}, browserCapture: recording } };
    }
    if (command.type === 'browserCaptureStop') {
      const stopped = captures.find(view => view.capture.captureId === command.captureId)!;
      const saved: RuntimeBrowserCaptureView = { ...stopped, capture: { ...stopped.capture, state: 'saved', endedAt: new Date().toISOString(), tracks: { frames: { path: 'frames.bin', index: 'frames.json', count: 40, width: 1280, height: 720 } } } };
      captures = captures.map(view => view.capture.captureId === command.captureId ? saved : view);
      return { status: 'ok', value: { control: {}, browserCapture: saved } };
    }
    if (command.type === 'browserShares') return { status: 'ok', value: { control: {}, browserShares: shares } };
    if (command.type === 'browserComments') return { status: 'ok', value: { control: {}, browserComments: comments.filter(view => (command.status === 'all' || view.thread.root.resolved === null) && (!command.captureId || (view.thread.root.source.kind === 'capture' && view.thread.root.source.captureId === command.captureId))) } };
    // Capture share links and 'Comment at m:ss' (the capture player).
    if (command.type === 'browserCaptureShares') return { status: 'ok', value: { control: {}, browserCaptureShares: captureShares } };
    if (command.type === 'browserCommentAdd') {
      const made = thread(8, command.text, { kind: 'person', name: 'Brad', guest: false }, { source: command.source, page: command.page, anchor: command.anchor, createdAt: '2026-10-24T13:00:00.000Z' });
      comments = [...comments, made];
      return { status: 'ok', value: { control: {}, browserComment: made.thread } };
    }
    if (command.type === 'browserCommentReply' || command.type === 'browserCommentResolve') {
      const view = comments.find(other => other.thread.root.id === command.threadId)!;
      const changed = command.type === 'browserCommentReply'
        ? { ...view.thread, replies: [...view.thread.replies, reply(9, command.threadId, command.text, { kind: 'person', name: 'Brad', guest: false })] }
        : { ...view.thread, root: { ...view.thread.root, resolved: command.reopen ? null : { by: 'Brad', at: started } } };
      comments = comments.map(other => other === view ? { ...view, thread: changed } : other);
      return { status: 'ok', value: { control: {}, browserComment: changed } };
    }
    if (command.type === 'browserShareCreate') {
      const made = share(9, { targetId: command.targetId, comment: command.comment, expiresAt: new Date(Date.parse(started) + command.expiresInMinutes * 60_000).toISOString() });
      shares = [made, ...shares];
      return { status: 'ok', value: { control: {}, browserShare: made } };
    }
    if (command.type === 'browserShareRevoke') {
      const ended = { ...shares.find(other => other.shareId === command.shareId)!, endedAt: new Date().toISOString(), endReason: 'revoked' as const };
      shares = shares.map(other => other.shareId === command.shareId ? ended : other);
      return { status: 'ok', value: { control: {}, browserShare: ended } };
    }
    throw new Error(`Unexpected ${command.type}`);
  });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows each approved site as host · level', async () => {
  await render();
  const sites = [...container.querySelectorAll('[aria-label="Approved sites"] li')].map(chip => chip.textContent);
  expect(sites).toEqual(['httpbin.org· interact', 'github.com· read', 'localhost· full']);
});

it('offers to approve a confirmed Chrome when none is approved here, making it the default', async () => {
  const settings: RuntimeProjectBrowserSettings = { projectId: 'project', revision: 4, defaultPairingId: null, browsers: [{ pairingId: work, name: 'Work Chrome', note: 'staging admin', generation: 1, connected: true, approved: false, takeover: false, powers: [], powersSupported: true }] };
  vi.mocked(projectBrowserSettings).mockResolvedValue(settings);
  vi.mocked(updateProjectBrowserSettings).mockImplementation(async () => { overview = { ...overview, chromes: overview.chromes.map(chrome => ({ ...chrome, approved: true, isDefault: true })) }; return settings; });
  await render();
  expect(container.textContent).toContain("Agents here can't use your Chrome yet");
  expect(container.textContent).toContain('Work Chrome is paired and online, but not approved for Golconda');
  await act(async () => button('Approve Work Chrome for Golconda').click());
  expect(updateProjectBrowserSettings).toHaveBeenCalledWith('project', 4, { defaultPairingId: work, approvals: [{ pairingId: work, powers: [] }] });
  expect(container.textContent).not.toContain("Agents here can't use your Chrome yet");
  expect(container.querySelector(`[aria-label="Work Chrome"]`)?.textContent).toContain('Project default');
});

it('turns a power on for an approved Chrome from its card, keeping its other powers, and asks for 5.11 before offering Everything', async () => {
  const settings: RuntimeProjectBrowserSettings = { projectId: 'project', revision: 7, defaultPairingId: work, browsers: [{ pairingId: work, name: 'Work Chrome', note: '', generation: 1, connected: true, approved: true, takeover: false, powers: ['record'], powersSupported: false }] };
  vi.mocked(projectBrowserSettings).mockResolvedValue(settings);
  vi.mocked(updateProjectBrowserSettings).mockImplementation(async (_projectId, _revision, preferences) => {
    overview = { ...overview, chromes: overview.chromes.map(chrome => ({ ...chrome, powers: preferences.approvals[0]!.powers })) };
    return settings;
  });
  overview = { ...overview, chromes: [{ ...chromeWithTab()[0]!, powers: ['record'], powersSupported: false }] };
  await render();
  const card = labelled('Work Chrome');
  expect(card.querySelector('header')?.textContent).toContain('Video');
  expect(card.textContent).toContain('Update the extension in this Chrome to 5.11 for powers and Everything to work');
  expect(() => button('Allow everything for 1 hour')).toThrow();
  await act(async () => labelled('Debug (profiles, traces, heap snapshots) on Work Chrome').click());
  expect(updateProjectBrowserSettings).toHaveBeenCalledWith('project', 7, { defaultPairingId: work, approvals: [{ pairingId: work, powers: ['record', 'debug'] }] });
  expect(card.querySelector('header')?.textContent).toContain('Debug');
});

it('allows Everything on an approved Chrome for an hour, counts it down, ends it now, and rereads the overview at its exact expiry', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(started));
  // A hidden page skips the ten-second refresh, so every overview read here is one the Everything controls caused.
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  overview = { ...overview, chromes: [{ ...chromeWithTab()[0]!, powersSupported: true }] };
  const answer = rpc.session.getMockImplementation()!;
  rpc.session.mockImplementation(async (input: { command: RuntimeSessionCommand }) => {
    if (input.command.type !== 'browserEverything') return answer(input);
    const everything = input.command.on ? { expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() } : null;
    overview = { ...overview, chromes: overview.chromes.map(chrome => ({ ...chrome, everything })) };
    return { status: 'ok', value: { control: {} } };
  });
  await render();
  await settle();
  await act(async () => button('Allow everything for 1 hour').click());
  await settle();
  expect(commands('browserEverything').map(([input]) => input.command)).toEqual([{ type: 'browserEverything', pairingId: work, on: true }]);
  expect(labelled('Everything').textContent).toContain('Everything · 60 min left');
  await act(async () => { await vi.advanceTimersByTimeAsync(8 * 60_000); });
  expect(labelled('Everything').textContent).toContain('Everything · 52 min left');
  await act(async () => button('End now').click());
  await settle();
  expect(commands('browserEverything').at(-1)?.[0].command).toEqual({ type: 'browserEverything', pairingId: work, on: false });
  expect(container.querySelector('[aria-label="Everything"]')).toBeNull();
  await act(async () => button('Allow everything for 1 hour').click());
  await settle();
  // Everything lapses on the server at its expiry without a notice; the card reads the overview then, not before.
  overview = { ...overview, chromes: overview.chromes.map(chrome => ({ ...chrome, everything: null })) };
  const reads = commands('browserOverview').length;
  await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60_000 - 1); });
  expect(commands('browserOverview')).toHaveLength(reads);
  expect(labelled('Everything').textContent).toContain('Everything · 1 min left');
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  await settle();
  expect(commands('browserOverview')).toHaveLength(reads + 1);
  expect(container.querySelector('[aria-label="Everything"]')).toBeNull();
  expect(button('Allow everything for 1 hour')).toBeTruthy();
});

it('links to pairing when no Chrome is confirmed on the account', async () => {
  overview = { ...overview, chromes: [] };
  await render();
  await act(async () => button('Pair a Chrome').click());
  expect(window.location.pathname).toBe('/plugins');
  expect(new URL(window.location.href).searchParams.get('pair')).toBe('project');
});

it('shows each tab with who opened it and its preview, or why there is none, and no recovery section without records', async () => {
  overview = { ...overview, chromes: [{ pairingId: work, name: 'Work Chrome', note: '', connected: true, approved: true, isDefault: true, groupId: group, groupName: 'feature-login', groupColor: null, running: 2, agents: [], tabs: [
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
  expect(chrome.textContent).toContain('▶ feature-login');
  // LEGACY: an extension before 5.8 reports running scripts but no agents.
  expect(chrome.textContent).toContain('2 scripts running');
  expect(chrome.textContent).toContain('Opened by agent');
  expect(chrome.textContent).toContain('You added it');
  expect(chrome.querySelector('img[alt="Preview of Login"]')?.getAttribute('src')).toBe('data:image/jpeg;base64,aW1hZ2U=');
  expect(chrome.textContent).toContain('Preview appears while the agent uses this tab');
  expect(chrome.textContent).toContain('For video with sound, click Capture on the tab in Chrome');
  expect(commands('browserPreview').map(([input]) => input.command)).toEqual([{ type: 'browserPreview', groupId: group, targetId: 'tab-a' }, { type: 'browserPreview', groupId: group, targetId: 'tab-b' }]);
  expect(container.querySelector('[aria-label="Browser recovery"]')).toBeNull();
  expect(container.textContent).not.toContain('No browser groups');
});

it('marks the tab an agent acts on as Agent acting and a tab you hold as You’re in control', async () => {
  overview = { ...overview, chromes: [{ ...chromeWithTab()[0]!, agents: [{ ...acting, targetId: 'tab-b' }], tabs: [
    { targetId: 'tab-a', url: 'https://app.example.com/login', title: 'Login', addedBy: 'agent', usable: true, holder: 'you' },
    { targetId: 'tab-b', url: 'https://app.example.com/settings', title: 'Settings', addedBy: 'agent', usable: true },
    { targetId: 'tab-c', url: 'https://app.example.com/help', title: 'Help', addedBy: 'you', usable: true },
  ] }] };
  await render();
  expect(labelled('Preview of Login').textContent).toContain('You’re in control');
  expect(labelled('Preview of Settings').textContent).toContain('Agent acting');
  expect(labelled('Preview of Help').textContent).not.toMatch(/Agent acting|in control/u);
});

it('opens a machine’s headless tab in the Watch dialog from its preview, reading its preview every few seconds and showing how old it is', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(started));
  overview = { ...overview, machines: [{ machineId: 'darktop', groupId: machineGroup, tabs: [{ targetId: 'tab-m', url: 'https://app.example.com/login', title: 'Login', addedBy: null, usable: true }], error: null }] };
  previews = { 'tab-m': { targetId: 'tab-m', capturedAt: new Date(Date.parse(started) - 3000).toISOString(), image: { mediaType: 'image/jpeg', data: 'aW1hZ2U=' }, reason: null } };
  await render([{ id: 'darktop', label: 'Darktop' }]);
  await settle();
  expect(labelled('Tab Login').textContent).toContain('3 s ago');
  const reads = commands('browserPreview').length;
  await act(async () => labelled('Preview of Login').click());
  await settle();
  const dialog = document.body.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain('Headless browser on Darktop');
  expect(dialog.querySelector('img[alt="Live view of Login"]')?.getAttribute('src')).toBe('data:image/jpeg;base64,aW1hZ2U=');
  await act(async () => { await vi.advanceTimersByTimeAsync(WATCH_REFRESH_MS); });
  // The dialog reads once when it opens and again after WATCH_REFRESH_MS; the tile waits for its own ten seconds.
  expect(commands('browserPreview')).toHaveLength(reads + 2);
  expect(dialog.textContent).toContain(`${3 + WATCH_REFRESH_MS / 1000} s ago`);
  await act(async () => button('Done').click());
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
});

it('counts the browsers with open tabs, and those running scripts, for the tab label and Environment', () => {
  const tab = { targetId: 'tab-a', url: 'https://app.example.com', title: 'App', addedBy: null, usable: true };
  expect(browserActivity(RuntimeBrowserOverviewSchema.parse({ ...overview, chromes: [{ ...chromeWithTab()[0]!, running: 1 }, { ...chromeWithTab()[0]!, pairingId: '00000000-0000-4000-8000-000000000009', approved: false }], cloud: { groupId: group, running: 0, tabs: [tab] }, machines: [{ machineId: 'darktop', groupId: null, tabs: [], error: null }] }))).toEqual({ open: 2, running: 1 });
  expect(browserActivity(RuntimeBrowserOverviewSchema.parse(overview))).toEqual({ open: 0, running: 0 });
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
  overview = { ...overview, chromes: [{ pairingId: work, name: 'Work Chrome', note: '', connected: true, approved: true, isDefault: true, groupId: group, groupName: 'feature-login', groupColor: null, running: 0, agents: [], tabs: [] }] };
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

it('shows each attached machine\'s headless browser with its tabs and previews, and revokes its group on that machine', async () => {
  overview = { ...overview, machines: [
    { machineId: 'darktop', groupId: machineGroup, tabs: [{ targetId: 'tab-m', url: 'https://app.example.com/dash', title: 'Dashboard', addedBy: null, usable: true }], error: null },
    { machineId: 'old-box', groupId: null, tabs: [], error: 'Update GitSpace on this machine to see its browser' },
  ] };
  previews = { 'tab-m': { targetId: 'tab-m', capturedAt: '2026-10-23T12:00:00.000Z', image: null, reason: 'The headless browser is busy' } };
  vi.stubGlobal('confirm', vi.fn(() => true));
  await render([{ id: 'darktop', label: 'Darktop' }]);
  const darktop = container.querySelector('[aria-label="Headless browser on Darktop"]')!;
  expect(darktop.textContent).toContain('Dashboard');
  expect(darktop.textContent).toContain('The headless browser is busy');
  expect(commands('browserPreview').map(([input]) => input.command)).toEqual([{ type: 'browserPreview', groupId: machineGroup, targetId: 'tab-m' }]);
  const old = container.querySelector('[aria-label="Headless browser on old-box"]')!;
  expect(old.textContent).toContain('Update GitSpace on this machine to see its browser');
  expect(old.textContent).toContain('No open tabs.');
  await act(async () => button('Revoke access').click());
  expect(commands('browserRevoke').map(([input]) => input.command)).toEqual([{ type: 'browserRevoke', machineId: 'darktop', groupId: machineGroup }]);
});

it('shows the group in its Chrome colour with ▶ and each agent acting there: its call, commands, time and what it is doing', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(started));
  overview = { ...overview, chromes: [{ ...chromeWithTab()[0]!, groupColor: 'blue', agents: [acting] }] };
  await render();
  await settle();
  const chrome = labelled('Work Chrome');
  const chip = [...chrome.querySelectorAll<HTMLElement>('span')].find(span => span.textContent === '▶ feature-login');
  expect(chip?.style.background).toMatch(/^(#1a73e8|rgb\(26, 115, 232\))$/u);
  expect(chrome.textContent).toContain('main · browser.run · 4 commands · 0:12 · Clicking “Medium”');
  expect(chrome.textContent).not.toContain('scripts running');
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(chrome.textContent).toContain('main · browser.run · 4 commands · 0:17 · Clicking “Medium”');
});

it('stops what agents run in a connected Chrome\'s group, then reads the browsers again; an offline Chrome has no Stop', async () => {
  overview = { ...overview, chromes: [{ ...chromeWithTab()[0]!, agents: [acting] }, { ...chromeWithTab()[0]!, pairingId: home, name: 'Home Chrome', isDefault: false, connected: false, groupId: homeGroup, running: 1, tabs: [] }] };
  await render();
  expect([...labelled('Home Chrome').querySelectorAll('button')].map(element => element.textContent?.trim())).not.toContain('Stop');
  const reads = commands('browserOverview').length;
  overview = { ...overview, chromes: overview.chromes.map(chrome => chrome.pairingId === work ? { ...chrome, agents: [] } : chrome) };
  await act(async () => button('Stop').click());
  expect(commands('browserStop').map(([input]) => input.command)).toEqual([{ type: 'browserStop', groupId: group }]);
  expect(commands('browserOverview')).toHaveLength(reads + 1);
  expect(labelled('Work Chrome').textContent).not.toContain('▶');
  expect([...labelled('Work Chrome').querySelectorAll('button')].map(element => element.textContent?.trim())).not.toContain('Stop');
});

it('closes a tab of a connected Chrome\'s group or of the cloud browser from its tile, then reads the browsers again; not on an offline Chrome or a machine', async () => {
  overview = { ...overview,
    chromes: [chromeWithTab()[0]!, { ...chromeWithTab()[0]!, pairingId: home, name: 'Home Chrome', isDefault: false, connected: false, groupId: homeGroup, tabs: [{ targetId: 'tab-h', url: 'https://app.example.com/home', title: 'Home', addedBy: 'you', usable: true }] }],
    cloud: { groupId: cloudGroup, running: 0, tabs: [{ targetId: 'tab-c', url: 'https://app.example.com', title: 'App', addedBy: null, usable: true }] },
    machines: [{ machineId: 'darktop', groupId: machineGroup, tabs: [{ targetId: 'tab-m', url: 'https://app.example.com/dash', title: 'Dashboard', addedBy: null, usable: true }], error: null }] };
  await render([{ id: 'darktop', label: 'Darktop' }]);
  expect(labelled('Tab Home').querySelector('[aria-label="Close tab Home"]')).toBeNull();
  expect(labelled('Tab Dashboard').querySelector('[aria-label="Close tab Dashboard"]')).toBeNull();
  const reads = commands('browserOverview').length;
  overview = { ...overview, chromes: overview.chromes.map(chrome => chrome.pairingId === work ? { ...chrome, tabs: [] } : chrome) };
  await act(async () => labelled('Close tab Login').click());
  expect(commands('browserCloseTab').map(([input]) => input.command)).toEqual([{ type: 'browserCloseTab', groupId: group, targetId: 'tab-a' }]);
  expect(commands('browserOverview')).toHaveLength(reads + 1);
  expect(container.querySelector('[aria-label="Tab Login"]')).toBeNull();
  await act(async () => labelled('Close tab App').click());
  expect(commands('browserCloseTab').map(([input]) => input.command)).toEqual([{ type: 'browserCloseTab', groupId: group, targetId: 'tab-a' }, { type: 'browserCloseTab', groupId: cloudGroup, targetId: 'tab-c' }]);
});

it('brings a connected Chrome\'s tab to the front from the Watch dialog, showing there why it could not', async () => {
  vi.useFakeTimers();
  overview = { ...overview, chromes: chromeWithTab(), cloud: { groupId: cloudGroup, running: 0, tabs: [{ targetId: 'tab-c', url: 'https://app.example.com', title: 'App', addedBy: null, usable: true }] } };
  await render();
  await settle();
  await act(async () => labelled('Watch App').click());
  expect([...document.body.querySelector('[role="dialog"]')!.querySelectorAll('button')].map(element => element.textContent?.trim())).not.toContain('Focus in Chrome');
  await act(async () => button('Done').click());

  await act(async () => labelled('Watch Login').click());
  await act(async () => button('Focus in Chrome').click());
  await settle();
  expect(commands('browserFocusTab').map(([input]) => input.command)).toEqual([{ type: 'browserFocusTab', groupId: group, targetId: 'tab-a' }]);
  const answer = rpc.session.getMockImplementation()!;
  rpc.session.mockImplementation(async (input: { command: RuntimeSessionCommand }) => input.command.type === 'browserFocusTab' ? { status: 'error', error: new Error('The tab is no longer in this workspace’s group.') } : answer(input));
  await act(async () => button('Focus in Chrome').click());
  await settle();
  const dialog = document.body.querySelector('[role="dialog"]');
  expect([...dialog?.querySelectorAll('[role="alert"]') ?? []].map(alert => alert.textContent)).toContain('The tab is no longer in this workspace’s group.');
});

const captureId = (id: number) => `00000000-0000-4000-8000-0000000000c${id}`;
/** Sets a controlled field's value as typing does. */
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('lists captures newest first with their track pills, whether the agent saved them as a skill, and who made them where, filtered by track with counts', async () => {
  captures = [
    capture(1, { name: 'Settings page after the fix', startedAt: '2026-10-24T12:00:00.000Z', tracks: { image: { path: 'image.jpg', width: 1440, height: 900 } } }, { 'image.jpg': '/files/settings' }),
    capture(2, { name: 'Order a pizza', by: 'you', source: 'relay', browser: 'Work Chrome', page: { url: 'https://httpbin.org/forms/post', title: 'Pizza' }, startedAt: '2026-10-24T12:05:00.000Z', endedAt: '2026-10-24T12:05:14.000Z', tracks: { video: { path: 'video.webm', mediaType: 'video/webm', sound: true, durationMs: 14_000 }, steps: { path: 'steps.json', count: 5 }, layout: { path: 'layout.jsonl', count: 30 } } }, { 'thumbnail.jpg': '/files/pizza-thumbnail', 'video.webm': '/files/pizza' }),
    capture(3, { name: 'Sign in to staging', by: 'you', source: 'relay', browser: 'Work Chrome', startedAt: '2026-10-24T12:04:00.000Z', endedAt: '2026-10-24T12:05:05.000Z', tracks: { frames: { path: 'frames.bin', index: 'frames.json', count: 65, width: 1280, height: 720 }, steps: { path: 'steps.json', count: 9 } }, skill: { path: '.gitspace/skills/staging-sign-in/SKILL.md', commit: 'a3f9c21d0e4b' } }, { 'frames.bin': '/files/bin', 'frames.json': '/files/json' }),
    capture(4, { name: 'Lost run', startedAt: '2026-10-24T12:03:00.000Z', endedAt: null, state: 'failed', reason: 'Work Chrome went offline while recording' }),
  ];
  comments = [thread(1, 'Telephone only matters for delivery', ana, { source: { kind: 'capture', captureId: captureId(2), atMs: 4000 } })];
  await render();
  const rows = () => [...labelled('Captures').querySelectorAll('li')].map(row => row.getAttribute('aria-label'));
  expect(rows()).toEqual(['Order a pizza', 'Sign in to staging', 'Lost run', 'Settings page after the fix']);
  const pizza = labelled('Order a pizza').textContent;
  for (const pill of ['5 steps', '1 comment', 'video 0:14 · sound', 'layout', 'Not in repo', 'You · Work Chrome · httpbin.org/forms/post']) expect(pizza).toContain(pill);
  expect(pizza).not.toContain('Saved as skill');
  expect(labelled('Order a pizza').querySelector('img')?.getAttribute('src')).toBe('/files/pizza-thumbnail');
  const staging = labelled('Sign in to staging').textContent;
  // A length, not the start time's clock (`1:05:00`).
  expect(staging).toMatch(/video 1:05(?!:)/u);
  for (const pill of ['9 steps', 'Saved as skill', 'Agent saved it to .gitspace/skills/staging-sign-in/SKILL.md in a3f9c21']) expect(staging).toContain(pill);
  expect(staging).not.toContain('Not in repo');
  const settings = labelled('Settings page after the fix').textContent;
  expect(settings).toContain('screenshot · 1440×900');
  expect(settings).toContain('Agent · capture() in a run · Cloud browser');
  expect(settings).not.toContain('Not in repo');
  expect(labelled('View Settings page after the fix')).toBeTruthy();
  expect(labelled('Lost run').textContent).toContain('Work Chrome went offline while recording');
  expect(labelled('Play Lost run').hasAttribute('disabled')).toBe(true);
  expect(labelled('Share Lost run').hasAttribute('disabled')).toBe(true);

  expect(filter('All').textContent).toContain('All · 4');
  await act(async () => filter('Steps · 2').click());
  expect(rows()).toEqual(['Order a pizza', 'Sign in to staging']);
  await act(async () => filter('Comments · 1').click());
  expect(rows()).toEqual(['Order a pizza']);
  await act(async () => filter('Video · 3').click());
  expect(rows()).toEqual(['Order a pizza', 'Sign in to staging', 'Lost run']);
  await act(async () => filter('Screenshots · 1').click());
  expect(rows()).toEqual(['Settings page after the fix']);
});

it('mentions a capture in the chat composer as a capture link, and asks the agent for a site there', async () => {
  const compose = vi.fn<(text: string) => void>();
  captures = [capture(1, { name: 'Login screenshot', tracks: { image: { path: 'image.jpg', width: 1280, height: 720 } } }, { 'image.jpg': '/files/login' })];
  await render([], compose);
  await act(async () => labelled('Mention Login screenshot').click());
  expect(compose).toHaveBeenLastCalledWith(`capture://${captureId(1)} `);
  await act(async () => button('Ask agent to add a site').click());
  expect(compose).toHaveBeenLastCalledWith(expect.stringContaining('browser.origins in .gitspace/bundle.json'));
});

it('opens a screenshot as its image and a Chrome recording with sound as a video, without reading its frames', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  captures = [
    capture(1, { name: 'Login screenshot', tracks: { image: { path: 'image.jpg', width: 1280, height: 720 } } }, { 'image.jpg': '/files/login' }),
    capture(2, { name: 'Demo with sound', by: 'you', source: 'relay', browser: 'Work Chrome', startedAt: '2026-10-24T12:05:00.000Z', tracks: { video: { path: 'video.webm', mediaType: 'video/webm', sound: true, durationMs: 42_000 }, frames: { path: 'frames.bin', index: 'frames.json', count: 3, width: 1280, height: 720 } } }, { 'video.webm': '/files/demo', 'frames.bin': '/files/bin', 'frames.json': '/files/json', 'thumbnail.jpg': '/files/demo-thumbnail' }),
  ];
  await render();
  expect(labelled('Demo with sound').textContent).toContain('video 0:42 · sound');
  await act(async () => labelled('View Login screenshot').click());
  expect(document.body.querySelector('img[alt="Login screenshot"]')?.getAttribute('src')).toBe('/files/login');
  expect(document.body.querySelector('video')).toBeNull();
  await act(async () => labelled('Play Demo with sound').click());
  const video = document.body.querySelector('video[aria-label="Video of Demo with sound"]');
  expect(video?.getAttribute('src')).toBe('/files/demo');
  expect(video?.getAttribute('poster')).toBe('/files/demo-thumbnail');
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('0:00 / 0:42');
  expect(fetch).not.toHaveBeenCalled();
});

it('plays a screencast recording at its recorded times, reading frames.bin by byte range ahead of the playhead', async () => {
  vi.useFakeTimers();
  const index = { version: 1, frames: Array.from({ length: 40 }, (_, frame) => ({ t: frame * 1000, offset: frame * 4, length: 4 })) };
  const bin = Uint8Array.from({ length: 160 }, (_, offset) => Math.floor(offset / 4));
  const ranges: string[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (input === '/files/json') return Response.json(index);
    const range = new Headers(init?.headers).get('Range') ?? '';
    ranges.push(range);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/u.exec(range) ?? [];
    return new Response(bin.slice(Number(start), Number(end) + 1), { status: 206 });
  }));
  const blobs = new Map<string, Blob>();
  const createObjectURL = URL.createObjectURL;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { const url = createObjectURL(blob); if (blob instanceof Blob) blobs.set(url, blob); return url; });
  captures = [capture(1, { name: 'Checkout run', by: 'you', source: 'relay', browser: 'Work Chrome', endedAt: '2026-10-24T12:00:39.000Z', tracks: { frames: { path: 'frames.bin', index: 'frames.json', count: 40, width: 1280, height: 720 } } }, { 'frames.bin': '/files/bin', 'frames.json': '/files/json' })];
  const shown = async () => {
    const image = document.body.querySelector('img[alt^="Checkout run at"]');
    return { at: image?.getAttribute('alt'), bytes: [...new Uint8Array(await blobs.get(image?.getAttribute('src') ?? '')!.arrayBuffer())] };
  };
  await render();
  await act(async () => labelled('Play Checkout run').click());
  await settle();
  expect(ranges).toEqual([`bytes=0-${FRAMES_AHEAD * 4 - 1}`]);
  expect(await shown()).toEqual({ at: 'Checkout run at 0:00', bytes: [0, 0, 0, 0] });

  await act(async () => labelled('Play').click());
  await act(async () => { await vi.advanceTimersByTimeAsync(999); });
  expect((await shown()).at).toBe('Checkout run at 0:00');
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  await settle();
  expect(await shown()).toEqual({ at: 'Checkout run at 0:01', bytes: [1, 1, 1, 1] });
  expect(ranges).toEqual([`bytes=0-${FRAMES_AHEAD * 4 - 1}`, `bytes=${FRAMES_AHEAD * 4}-${FRAMES_AHEAD * 8 - 1}`]);
  // One frame per act: React applies each frame's render (and schedules the next frame's timer) when its act ends.
  for (const step of [1000, 1000]) await act(async () => { await vi.advanceTimersByTimeAsync(step); });
  await settle();
  expect(await shown()).toEqual({ at: 'Checkout run at 0:03', bytes: [3, 3, 3, 3] });

  await act(async () => labelled('Pause').click());
  await type(document.body.querySelector<HTMLInputElement>('input[aria-label="Seek"]')!, '30500');
  await settle();
  expect(ranges.at(-1)).toBe(`bytes=120-${120 + FRAMES_AHEAD * 4 - 1}`);
  expect(await shown()).toEqual({ at: 'Checkout run at 0:30', bytes: [30, 30, 30, 30] });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect((await shown()).at).toBe('Checkout run at 0:30');
});

it('spans the whole capture when its screencast sent its last frame early: the last frame holds until the end, and markers sit at their moments', async () => {
  vi.useFakeTimers();
  // A still page repaints rarely: three frames in the first 2 s of a 23 s capture.
  const index = { version: 1, frames: [0, 1000, 2000].map((t, frame) => ({ t, offset: frame * 4, length: 4 })) };
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (input === '/files/json') return Response.json(index);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/u.exec(new Headers(init?.headers).get('Range') ?? '') ?? [];
    return new Response(Uint8Array.from({ length: 12 }, (_, offset) => Math.floor(offset / 4)).slice(Number(start), Number(end) + 1), { status: 206 });
  }));
  captures = [capture(1, { name: 'Quiet page', by: 'you', source: 'relay', browser: 'Work Chrome', endedAt: '2026-10-24T12:00:23.000Z', tracks: { frames: { path: 'frames.bin', index: 'frames.json', count: 3, width: 1280, height: 720 } } }, { 'frames.bin': '/files/bin', 'frames.json': '/files/json' })];
  comments = [thread(1, 'Still says loading', ana, { source: { kind: 'capture', captureId: captureId(1), atMs: 20_000 } })];
  await render();
  await act(async () => labelled('Play Quiet page').click());
  await settle();
  const player = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(player.textContent).toContain('0:00 / 0:23');
  expect(labelled('Comment 1 on the timeline').style.left).toBe(`${20_000 / 23_000 * 100}%`);

  await act(async () => labelled('Play').click());
  for (const step of [1000, 1000]) await act(async () => { await vi.advanceTimersByTimeAsync(step); });
  await settle();
  expect(player.querySelector('img[alt^="Quiet page at"]')?.getAttribute('alt')).toBe('Quiet page at 0:02');
  await act(async () => { await vi.advanceTimersByTimeAsync(20_999); });
  expect(player.textContent).toContain('0:02 / 0:23');
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  await settle();
  expect(player.textContent).toContain('0:23 / 0:23');
  expect(player.querySelector('img[alt^="Quiet page at"]')?.getAttribute('alt')).toBe('Quiet page at 0:02');
  expect(labelled('Play')).not.toBeNull();
});

it('spans the whole capture when its video names a shorter length', async () => {
  captures = [capture(2, { name: 'Short video', by: 'you', source: 'relay', browser: 'Work Chrome', endedAt: '2026-10-24T12:00:23.000Z', tracks: { video: { path: 'video.webm', mediaType: 'video/webm', sound: false, durationMs: 23_000 } } }, { 'video.webm': '/files/short' })];
  await render();
  await act(async () => labelled('Play Short video').click());
  const player = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  const video = player.querySelector('video')!;
  Object.defineProperty(video, 'duration', { value: 13 });
  await act(async () => { video.dispatchEvent(new Event('loadedmetadata')); });
  expect(player.textContent).toContain('0:00 / 0:23');
});

it('plays a capture with its steps and numbered comments on the timeline; a comment seeks there and opens its thread; Comment at m:ss anchors to the element the layout track kept then', async () => {
  vi.useFakeTimers();
  const url = 'https://httpbin.org/forms/post';
  const steps = [
    { atMs: 1000, kind: 'goto', url },
    { atMs: 4000, kind: 'fill', locator: 'getByLabel(\'Customer name:\')', value: 'Ada', url },
    { atMs: 6000, kind: 'fill', locator: 'getByLabel(\'Password\')', value: '«secret»', url },
    { atMs: 7000, kind: 'request', method: 'POST', mutating: true, url: 'https://httpbin.org/post' },
  ];
  const telephone = { role: 'textbox', name: 'Telephone:', selector: '#tel', box: { x: 0.1, y: 0.3, w: 0.4, h: 0.05 } };
  const layout = [
    { atMs: 0, viewport: { w: 1000, h: 625 }, scroll: { x: 0, y: 0 }, elements: [] },
    { atMs: 8000, viewport: { w: 1000, h: 625 }, scroll: { x: 0, y: 0 }, elements: [{ role: 'form', name: '', selector: 'form', box: { x: 0, y: 0, w: 1, h: 1 } }, telephone] },
  ];
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async input => input === '/files/steps' ? Response.json(steps) : new Response(layout.map(sample => JSON.stringify(sample)).join('\n'))));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 625 }));
  captures = [capture(2, { name: 'Order a pizza', by: 'you', source: 'relay', browser: 'Work Chrome', page: { url, title: 'Pizza' }, endedAt: '2026-10-24T12:00:14.000Z', tracks: { video: { path: 'video.webm', mediaType: 'video/webm', sound: true, durationMs: 14_000 }, steps: { path: 'steps.json', count: 4 }, layout: { path: 'layout.jsonl', count: 2 } } }, { 'video.webm': '/files/pizza', 'steps.json': '/files/steps', 'layout.jsonl': '/files/layout' })];
  comments = [
    thread(1, 'Customer name first', ana, { source: { kind: 'capture', captureId: captureId(2), atMs: 3000 } }),
    thread(2, 'Medium by default', { kind: 'person', name: 'Brad', guest: false }, { source: { kind: 'capture', captureId: captureId(2), atMs: 9000 }, createdAt: '2026-10-24T12:01:00.000Z' }),
  ];
  await render();
  await act(async () => labelled('Play Order a pizza').click());
  await settle();
  const player = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(commands('browserComments').map(([input]) => input.command)).toContainEqual({ type: 'browserComments', status: 'all', captureId: captureId(2), limit: 500 });
  expect(labelled('Comment 1 on the timeline').style.left).toBe(`${3000 / 14_000 * 100}%`);
  expect(labelled('Comment 2 on the timeline').style.left).toBe(`${9000 / 14_000 * 100}%`);
  expect([...player.querySelectorAll<HTMLElement>('[data-step-tick]')].map(tick => tick.style.left)).toEqual(steps.map(step => `${step.atMs / 14_000 * 100}%`));
  // Pins show only once the playhead reaches their moment.
  expect(player.querySelector('[aria-label="Comment 1"]')).toBeNull();

  await act(async () => filter('Steps · 4').click());
  const listed = player.querySelector('[aria-label="Comments and steps"]')!.textContent;
  for (const text of ['getByLabel(\'Customer name:\')', '"Ada"', 'getByLabel(\'Password\')', '«secret» (masked)', 'Request POST', 'changes data']) expect(listed).toContain(text);
  await act(async () => filter('Comments · 2').click());

  await act(async () => labelled('Comment 2 at 0:09').click());
  expect(player.textContent).toContain('0:09 / 0:14');
  expect(player.querySelector('video')?.currentTime).toBe(9);
  expect(player.querySelector('[aria-label="Comment 1"]')).not.toBeNull();
  expect(labelled('Comment thread 2').textContent).toContain('Medium by default');
  await act(async () => labelled('Comment 1 on the timeline').click());
  expect(player.textContent).toContain('0:03 / 0:14');
  expect(labelled('Comment thread 1').textContent).toContain('Customer name first');

  await type(player.querySelector<HTMLInputElement>('input[aria-label="Seek"]')!, '9000');
  await act(async () => button('Comment at 0:09').click());
  const surface = labelled('Point at what to comment on');
  const pointer = (kind: string) => act(async () => { surface.dispatchEvent(new PointerEvent(kind, { bubbles: true, clientX: 300, clientY: 200, pointerId: 1 })); });
  await pointer('pointermove');
  expect(player.textContent).toContain('textbox “Telephone:” · from the recording');
  await pointer('pointerdown');
  await pointer('pointerup');
  expect(labelled('New comment').textContent).toContain('On textbox “Telephone:” · at 0:09');
  await type(labelled('New comment').querySelector('textarea')!, 'Should this say it is optional?');
  await act(async () => button('Comment').click());
  await settle();
  expect(commands('browserCommentAdd').map(([input]) => input.command)).toEqual([{ type: 'browserCommentAdd', source: { kind: 'capture', captureId: captureId(2), atMs: 9000 }, page: { url, title: 'Pizza' }, anchor: telephone, text: 'Should this say it is optional?' }]);
  expect(labelled('Comment 3 at 0:09').textContent).toContain('Should this say it is optional?');
});

it('captures a tab from its tile, shows REC with the time recorded on every recording tab, and stops it', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(started));
  overview = { ...overview, cloud: { groupId: group, running: 0, tabs: [
    { targetId: 'tab-c', url: 'https://app.example.com', title: 'App', addedBy: null, usable: true },
    { targetId: 'tab-d', url: 'https://app.example.com/docs', title: 'Docs', addedBy: null, usable: true },
  ] } };
  captures = [capture(2, { name: 'Agent recording', target: { groupId: group, targetId: 'tab-d' }, startedAt: '2026-10-24T11:59:30.000Z', endedAt: null, state: 'recording' })];
  await render();
  expect(labelled('Cloud browser').textContent).not.toContain('video with sound');
  expect(labelled('Tab Docs').textContent).toContain('REC 0:30');
  expect(labelled('Agent recording').textContent).toContain('recording 0:30');
  expect(labelled('Play Agent recording').hasAttribute('disabled')).toBe(true);

  await act(async () => labelled('Capture App').click());
  await settle();
  expect(commands('browserCaptureStart').map(([input]) => input.command)).toEqual([{ type: 'browserCaptureStart', groupId: group, targetId: 'tab-c' }]);
  expect(labelled('Tab App').textContent).toContain('REC 0:00');
  await act(async () => { await vi.advanceTimersByTimeAsync(65_000); });
  expect(labelled('Tab App').textContent).toContain('REC 1:05');
  expect(labelled('Tab Docs').textContent).toContain('REC 1:35');

  await act(async () => labelled('Stop capturing App').click());
  await settle();
  expect(commands('browserCaptureStop').map(([input]) => input.command)).toEqual([{ type: 'browserCaptureStop', captureId: '00000000-0000-4000-8000-0000000000c9' }]);
  expect(labelled('Tab App').textContent).not.toContain('REC');
  expect(container.querySelector('[aria-label="Capture App"]')).not.toBeNull();
  expect(labelled('Recording of App').textContent).toMatch(/video 1:05(?!:)/u);
  expect(labelled('Tab Docs').textContent).toContain('REC 1:35');
});

it('shares a Chrome tab from its tile with comments and the expiry you chose, then shows its link to copy', async () => {
  vi.useFakeTimers();
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  overview = { ...overview, chromes: chromeWithTab(), cloud: { groupId: group, running: 0, tabs: [{ targetId: 'tab-c', url: 'https://app.example.com', title: 'App', addedBy: null, usable: true }] } };
  await render();
  expect(container.querySelector('[aria-label="Share App"]')).toBeNull();
  await act(async () => labelled('Share Login').click());
  const popover = labelled('Share link for Login');
  await act(async () => popover.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const expiry = popover.querySelector<HTMLSelectElement>('select[aria-label="Expires after"]')!;
  expect(expiry.value).toBe('60');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(expiry, '480');
    expiry.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => button('Create link').click());
  await settle();
  expect(commands('browserShareCreate').map(([input]) => input.command)).toEqual([{ type: 'browserShareCreate', groupId: group, targetId: 'tab-a', comment: true, expiresInMinutes: 480 }]);
  const link = shares[0]!.link;
  expect(labelled('Share link for Login').querySelector<HTMLInputElement>('input[aria-label="Link for Login"]')?.value).toBe(link);
  expect(labelled('Share link for Login').textContent).toContain('View, point and comment');
  await act(async () => labelled('Share link for Login').querySelector<HTMLButtonElement>('button[aria-label="Copy link for Login"]')!.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith(link);
  expect(labelled('Shares').textContent).toContain('Login');
});

it('lists live and ended shares with who is watching and the time left, and stops sharing one', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(started));
  shares = [
    share(1, { expiresAt: '2026-10-24T13:15:00.000Z', comment: true, viewers: [{ viewerId: '00000000-0000-4000-8000-000000000101', name: 'Ana', guest: true, joinedAt: started }, { viewerId: '00000000-0000-4000-8000-000000000102', name: 'Brad', guest: false, joinedAt: started }], audit: [{ at: started, event: 'joined', by: 'Ana', guest: true, detail: null }, { at: started, event: 'created', by: 'you', guest: false, detail: null }] }),
    share(2, { page: { url: 'https://app.example.com/old', title: 'Old page' }, endedAt: started, endReason: 'expired' }),
  ];
  await render();
  await settle();
  const live = labelled('Share of Login');
  expect(live.textContent).toContain('Watching: Ana (guest), Brad');
  expect(live.textContent).toContain('1 h 15 min left');
  expect(live.textContent).toContain('View, point and comment');
  expect(live.querySelector('details')?.hasAttribute('open')).toBe(false);
  expect(live.querySelector('details')?.textContent).toContain('Ana (guest) joined');
  const ended = labelled('Share of Old page');
  expect(ended.textContent).toContain('Expired');
  expect(ended.querySelector('button')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000); });
  expect(labelled('Share of Login').textContent).toContain('45 min left');

  await act(async () => labelled('Stop sharing Login').click());
  await settle();
  expect(commands('browserShareRevoke').map(([input]) => input.command)).toEqual([{ type: 'browserShareRevoke', shareId: shares[0]!.shareId }]);
  expect(labelled('Share of Login').textContent).toContain('Stopped');
  expect(container.querySelector('[aria-label="Stop sharing Login"]')).toBeNull();
});

it('lists open threads with their crop, who started them, what they point at, on which page, and their replies, and reads them again when one is announced', async () => {
  vi.useFakeTimers();
  comments = [thread(1, 'The button does nothing', ana, {}, '/files/crop-1', [reply(1, threadId(1), 'Fixed: it was disabled', { kind: 'agent', conversation: 'main' })])];
  await render();
  await settle();
  // The Captures list reads every thread (status all) to count each capture's; the list here reads the open ones.
  expect(commands('browserComments').map(([input]) => input.command)).toContainEqual({ type: 'browserComments', status: 'open', limit: 100 });
  const first = labelled('Thread by Ana');
  expect(first.querySelector('img')?.getAttribute('src')).toBe('/files/crop-1');
  expect(first.textContent).toContain('guest');
  expect(first.textContent).toContain('The button does nothing');
  expect(first.textContent).toContain('On button “Sign in”');
  expect(first.querySelector('a')?.getAttribute('href')).toBe('https://app.example.com/login');
  expect(first.querySelector('[aria-label="Replies"]')?.textContent).toContain('main · agent');
  expect(first.querySelector('[aria-label="Replies"]')?.textContent).toContain('Fixed: it was disabled');

  comments = [thread(2, 'Make it blue', { kind: 'person', name: 'Brad', guest: false }, { createdAt: '2026-10-24T12:01:00.000Z' }), ...comments];
  await act(async () => { liveNotices.receive({ ...workspaceLiveKey('workspace', 'page-comments', 'project'), version: 1 }); });
  await settle();
  const second = labelled('Thread by Brad');
  expect(second.textContent).toContain('Make it blue');
  expect(second.textContent).not.toContain('guest');
  expect(second.querySelector('img')).toBeNull();
});

it('filters open and resolved threads', async () => {
  vi.useFakeTimers();
  comments = [thread(1, 'Still broken', ana), thread(2, 'Wrong colour', ana, { createdAt: '2026-10-24T12:01:00.000Z', resolved: { by: 'Brad', at: started } })];
  await render();
  await settle();
  const listed = () => [...labelled('Page comments').querySelectorAll('li[aria-label^="Thread by"]')].map(row => row.textContent);
  expect(listed()).toEqual([expect.stringContaining('Still broken')]);
  await act(async () => filter('Resolved').click());
  await settle();
  expect(commands('browserComments').map(([input]) => input.command)).toContainEqual({ type: 'browserComments', status: 'all', limit: 100 });
  expect(listed()).toEqual([expect.stringContaining('Wrong colour')]);
  expect(listed()[0]).toContain('Resolved by Brad');
  expect(button('Reopen')).toBeTruthy();
});

it('replies to a thread and resolves it from the tab', async () => {
  vi.useFakeTimers();
  comments = [thread(1, 'The button does nothing', ana)];
  await render();
  await settle();
  const row = labelled('Thread by Ana');
  const field = row.querySelector<HTMLInputElement>('input[aria-label="Your reply"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'Looking at it now');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Reply').click());
  await settle();
  expect(commands('browserCommentReply').map(([input]) => input.command)).toEqual([{ type: 'browserCommentReply', threadId: threadId(1), text: 'Looking at it now' }]);
  expect(labelled('Thread by Ana').querySelector('[aria-label="Replies"]')?.textContent).toContain('Looking at it now');
  expect(labelled('Thread by Ana').querySelector<HTMLInputElement>('input[aria-label="Your reply"]')?.value).toBe('');

  await act(async () => button('Resolve').click());
  await settle();
  expect(commands('browserCommentResolve').map(([input]) => input.command)).toEqual([{ type: 'browserCommentResolve', threadId: threadId(1) }]);
  expect(container.querySelector('[aria-label="Thread by Ana"]')).toBeNull();
});

it('Show on page brings a Chrome thread’s tab forward, opens a share thread’s tab in the Watch dialog, and offers nothing for a capture', async () => {
  vi.useFakeTimers();
  overview = { ...overview, chromes: chromeWithTab() };
  shares = [share(1)];
  // Newest first, as the workspace answers.
  comments = [
    thread(3, 'Made on a capture', ana, { source: { kind: 'capture', captureId: '00000000-0000-4000-8000-0000000000c1', atMs: 4000 }, createdAt: '2026-10-24T12:02:00.000Z' }),
    thread(2, 'Made on the share', ana, { source: { kind: 'share', shareId: shares[0]!.shareId }, createdAt: '2026-10-24T12:01:00.000Z' }),
    thread(1, 'Made in Chrome', { kind: 'person', name: 'Brad', guest: false }),
  ];
  await render();
  await settle();
  await act(async () => [...labelled('Thread by Brad').querySelectorAll('button')].find(item => item.textContent === 'Show on page')!.click());
  await settle();
  expect(commands('browserCommentShow').map(([input]) => input.command)).toEqual([{ type: 'browserCommentShow', groupId: group, targetId: 'tab-a', threadId: threadId(1) }]);

  const rows = [...labelled('Page comments').querySelectorAll<HTMLElement>('li[aria-label="Thread by Ana"]')];
  expect(rows.map(row => [...row.querySelectorAll('button')].some(item => item.textContent === 'Show on page'))).toEqual([false, true]);
  await act(async () => [...rows[1]!.querySelectorAll('button')].find(item => item.textContent === 'Show on page')!.click());
  await settle();
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Work Chrome · feature-login group');
  expect(commands('browserCommentShow')).toHaveLength(1);
});

it('names the commit the approved sites were read at', async () => {
  overview = { ...overview, sites: { ...overview.sites, revision: 'dd0a157c4b1e9f2a3d5c6b7a8e9f0a1b2c3d4e5f' } };
  await render();
  expect(labelled('Approved sites').querySelector('p')?.textContent).toBe('From .gitspace/bundle.json at dd0a157, approved in Environment. Your Chrome only opens these; the cloud browser is unrestricted.');
});

it('lists recent runs newest first with when and where they ran, failures and refusals in red, and their details on demand', async () => {
  overview = { ...overview, runs: [
    run(1, { at: '2026-10-24T19:21:00.000Z', where: { kind: 'chrome', name: 'Work Chrome' }, tool: 'act', summary: 'act fill “Customer name”', durationMs: 900, details: ['ref 4ed25e98:3', 'changed 1 field'] }),
    run(2, { at: '2026-10-24T19:20:00.000Z', summary: 'goto localhost:5173/settings', outcome: 'failed' }),
    run(3, { at: '2026-10-24T19:15:00.000Z', where: { kind: 'machine', machineId: 'darktop' }, tool: 'screenshot', summary: 'screenshot app.example.com/dash' }),
    run(4, { at: '2026-10-24T19:12:00.000Z', where: { kind: 'chrome', name: null }, summary: 'Refused: no Chrome approved for Golconda', outcome: 'refused' }),
  ] };
  await render([{ id: 'darktop', label: 'Darktop' }]);
  const runs = labelled('Recent runs');
  expect([...runs.querySelectorAll('li[aria-label]')].map(row => row.textContent)).toEqual([
    `${clock('2026-10-24T19:21:00.000Z')}Work Chromeact fill “Customer name”Details`,
    `${clock('2026-10-24T19:20:00.000Z')}Cloud browsergoto localhost:5173/settingsDetails`,
    `${clock('2026-10-24T19:15:00.000Z')}Headless browser on Darktopscreenshot app.example.com/dashDetails`,
    `${clock('2026-10-24T19:12:00.000Z')}Your ChromeRefused: no Chrome approved for GolcondaDetails`,
  ]);
  expect(labelled('Run act fill “Customer name”').querySelector('.text-destructive')).toBeNull();
  expect(labelled('Run goto localhost:5173/settings').querySelector('.text-destructive')?.textContent).toBe('goto localhost:5173/settings');
  expect(labelled('Run Refused: no Chrome approved for Golconda').querySelector('.text-destructive')?.textContent).toBe('Refused: no Chrome approved for Golconda');

  const first = labelled('Run act fill “Customer name”');
  await act(async () => first.querySelector('button')!.click());
  expect([...first.querySelectorAll('li')].map(line => line.textContent)).toEqual(['browser.act · took 0.9 s', 'ref 4ed25e98:3', 'changed 1 field']);
  await act(async () => first.querySelector('button')!.click());
  expect(first.querySelectorAll('li')).toHaveLength(0);
});

it('reads the browsers again when a report of a Chrome group is announced', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(started));
  overview = { ...overview, chromes: chromeWithTab() };
  await render();
  await settle();
  expect(labelled('Recent runs').textContent).toContain('No browser runs yet.');
  const reads = commands('browserOverview').length;
  overview = { ...overview, chromes: [{ ...chromeWithTab()[0]!, agents: [acting] }], runs: [run(1, { summary: 'goto app.example.com/login' })] };
  await act(async () => { liveNotices.receive({ ...workspaceLiveKey('workspace', 'browsers', 'project'), version: 1 }); });
  await settle();
  expect(commands('browserOverview')).toHaveLength(reads + 1);
  expect(labelled('Work Chrome').textContent).toContain('main · browser.run · 4 commands · 0:12');
  expect(labelled('Recent runs').querySelector('[aria-label="Run goto app.example.com/login"]')).not.toBeNull();
});
