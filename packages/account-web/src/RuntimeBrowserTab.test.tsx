// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workspaceLiveKey } from '@gitspace/protocol/live-notice';
import { RuntimeSnapshotSchema, type RuntimeBrowserCapture, type RuntimeBrowserCaptureView, type RuntimeBrowserOverview, type RuntimeBrowserPageCommentView, type RuntimeBrowserPreview, type RuntimeBrowserShare, type RuntimeProjectBrowserSettings } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand } from '@gitspace/protocol-runtime/session-controls';
import { projectBrowserSettings, updateProjectBrowserSettings } from './browser-relay-client.js';
import { liveNotices } from './live-notices.js';
import { FRAMES_AHEAD } from './RuntimeBrowserCaptures.js';
import { BROWSER_REFRESH_MS, RuntimeBrowserTab } from './RuntimeBrowserTab.js';

const rpc = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: rpc } }));
vi.mock('./browser-relay-client.js', () => ({ projectBrowserSettings: vi.fn(), updateProjectBrowserSettings: vi.fn() }));

const work = '00000000-0000-4000-8000-000000000001';
const group = '00000000-0000-4000-8000-0000000000aa';
const snapshot = RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 0, conversations: [], attachments: [], tasks: [], questions: [], documents: {} });
const empty = { groupId: null, groupName: null, running: 0, tabs: [] };
const started = '2026-10-24T12:00:00.000Z';
let overview: RuntimeBrowserOverview;
let previews: Record<string, RuntimeBrowserPreview>;
let captures: RuntimeBrowserCaptureView[];
let shares: RuntimeBrowserShare[];
let comments: RuntimeBrowserPageCommentView[];
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
async function render(machines: readonly { id: string; label: string }[] = []) { await act(async () => root.render(<RuntimeBrowserTab snapshot={snapshot} machines={machines} onOpenEnvironment={() => {}} />)); }
/** Lets fetches, their bodies and the renders they cause finish. */
async function settle() { for (let round = 0; round < 5; round += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
function share(id: number, fields: Partial<RuntimeBrowserShare> = {}): RuntimeBrowserShare {
  const shareId = `00000000-0000-4000-8000-0000000000e${id}`;
  return { shareId, link: `https://account.test/s/${shareId}#Zq3x_Kd8-Pw0aB7cD9eF1gH2iJ4kL5mN6oP8rS0tU2v${id}`, pairingId: work, browser: 'Work Chrome', targetId: 'tab-a', workspace: { projectId: 'project', workspaceId: 'workspace', groupId: group }, page: { url: 'https://app.example.com/login', title: 'Login' }, comment: false, createdAt: started, expiresAt: '2026-10-24T13:00:00.000Z', endedAt: null, endReason: null, viewers: [], audit: [], ...fields };
}
function comment(id: number, text: string, guest: boolean, cropUrl: string | null): RuntimeBrowserPageCommentView {
  return { cropUrl, comment: { version: 1, commentId: `00000000-0000-4000-8000-0000000000f${id}`, shareId: null, by: { name: guest ? 'Ana' : 'Brad', guest }, text, page: { url: 'https://app.example.com/login', title: 'Login' }, target: { box: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, role: 'button', name: 'Sign in', text: 'Sign in', selectors: ['#sign-in'] }, region: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 }, crop: null, createdAt: started } };
}
const chromeWithTab = (): RuntimeBrowserOverview['chromes'] => [{ pairingId: work, name: 'Work Chrome', note: '', connected: true, approved: true, isDefault: true, groupId: group, groupName: 'feature-login', running: 0, tabs: [{ targetId: 'tab-a', url: 'https://app.example.com/login', title: 'Login', addedBy: 'you', usable: true }] }];
function capture(id: number, fields: Partial<RuntimeBrowserCapture>, files: Record<string, string> = {}): RuntimeBrowserCaptureView {
  return { capture: { version: 1, captureId: `00000000-0000-4000-8000-0000000000c${id}`, name: `Capture ${id}`, by: 'agent', source: 'headless', browser: 'Cloud browser', page: { url: 'https://app.example.com', title: 'App' }, target: null, startedAt: started, endedAt: started, state: 'saved', reason: null, tracks: {}, ...fields }, files };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.clearAllMocks();
  overview = { sites: { origins: ['https://app.example.com', 'https://bank.example.com'], stepsOnly: ['https://bank.example.com'] }, cloud: { groupId: null, running: 0, tabs: [] }, machines: [], chromes: [{ pairingId: work, name: 'Work Chrome', note: '', connected: true, approved: false, isDefault: false, ...empty }] };
  previews = {};
  captures = [];
  shares = [];
  comments = [];
  rpc.session.mockImplementation(async ({ command }: { command: RuntimeSessionCommand }) => {
    if (command.type === 'browserOverview') return { status: 'ok', value: { control: {}, browserOverview: overview } };
    if (command.type === 'browserPreview') return { status: 'ok', value: { control: {}, browserPreview: previews[command.targetId] } };
    if (command.type === 'browserRevoke') return { status: 'ok', value: { control: {} } };
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
    if (command.type === 'browserPageComments') return { status: 'ok', value: { control: {}, browserPageComments: comments } };
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
  expect(chrome.textContent).toContain('For video with sound, click Capture on the tab in Chrome');
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

it('shows each attached machine\'s headless browser with its tabs and previews, and revokes its group on that machine', async () => {
  const machineGroup = '00000000-0000-4000-8000-0000000000bb';
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
  expect(old.textContent).toContain('No tabs open.');
  await act(async () => button('Revoke access').click());
  expect(commands('browserRevoke').map(([input]) => input.command)).toEqual([{ type: 'browserRevoke', machineId: 'darktop', groupId: machineGroup }]);
});

it('lists captures newest first with who made them, their browser, size or length and failures, filtered by kind', async () => {
  captures = [
    capture(1, { name: 'Login screenshot', startedAt: '2026-10-24T12:00:00.000Z', tracks: { image: { path: 'image.jpg', width: 1280, height: 720 } } }, { 'image.jpg': '/files/login' }),
    capture(2, { name: 'Checkout run', by: 'you', source: 'relay', browser: 'Work Chrome', startedAt: '2026-10-24T12:05:00.000Z', endedAt: '2026-10-24T12:06:05.000Z', tracks: { frames: { path: 'frames.bin', index: 'frames.json', count: 65, width: 1280, height: 720 } } }, { 'thumbnail.jpg': '/files/checkout-thumbnail', 'frames.bin': '/files/bin', 'frames.json': '/files/json' }),
    capture(3, { name: 'Lost run', startedAt: '2026-10-24T12:03:00.000Z', endedAt: null, state: 'failed', reason: 'Work Chrome went offline while recording' }),
  ];
  await render();
  const list = labelled('Captures');
  const rows = () => [...list.querySelectorAll('li')].map(row => row.getAttribute('aria-label'));
  expect(rows()).toEqual(['Checkout run', 'Lost run', 'Login screenshot']);
  expect(labelled('Checkout run').textContent).toContain('By you · Work Chrome');
  // A length, not the start time's clock (`1:05:00`).
  expect(labelled('Checkout run').textContent).toMatch(/· 1:05(?!:)/u);
  expect(labelled('Checkout run').querySelector('img')?.getAttribute('src')).toBe('/files/checkout-thumbnail');
  expect(labelled('Login screenshot').textContent).toContain('By agent · Cloud browser');
  expect(labelled('Login screenshot').textContent).toContain('1280×720');
  expect(labelled('Login screenshot').querySelector('img')?.getAttribute('src')).toBe('/files/login');
  expect(labelled('Lost run').textContent).toContain('Work Chrome went offline while recording');
  expect(labelled('Open Lost run').hasAttribute('disabled')).toBe(true);
  await act(async () => button('Screenshots').click());
  expect(rows()).toEqual(['Login screenshot']);
  await act(async () => button('Video').click());
  expect(rows()).toEqual(['Checkout run', 'Lost run']);
  await act(async () => button('All').click());
  expect(rows()).toHaveLength(3);
});

it('copies a capture\'s drive folder to mention it in the chat', async () => {
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  captures = [capture(1, { name: 'Login screenshot', tracks: { image: { path: 'image.jpg', width: 1280, height: 720 } } }, { 'image.jpg': '/files/login' })];
  await render();
  await act(async () => labelled('Mention Login screenshot').click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith('drive://workspace/browser/captures/00000000-0000-4000-8000-0000000000c1/');
  expect(labelled('Mention Login screenshot').textContent).toBe('Copied');
});

it('opens a screenshot as its image and a Chrome recording with sound as a video, without reading its frames', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  captures = [
    capture(1, { name: 'Login screenshot', tracks: { image: { path: 'image.jpg', width: 1280, height: 720 } } }, { 'image.jpg': '/files/login' }),
    capture(2, { name: 'Demo with sound', by: 'you', source: 'relay', browser: 'Work Chrome', startedAt: '2026-10-24T12:05:00.000Z', tracks: { video: { path: 'video.webm', mediaType: 'video/webm', sound: true, durationMs: 42_000 }, frames: { path: 'frames.bin', index: 'frames.json', count: 3, width: 1280, height: 720 } } }, { 'video.webm': '/files/demo', 'frames.bin': '/files/bin', 'frames.json': '/files/json', 'thumbnail.jpg': '/files/demo-thumbnail' }),
  ];
  await render();
  expect(labelled('Demo with sound').textContent).toMatch(/· 0:42(?!:)/u);
  await act(async () => labelled('Open Login screenshot').click());
  expect(document.body.querySelector('img[alt="Login screenshot"]')?.getAttribute('src')).toBe('/files/login');
  expect(document.body.querySelector('video')).toBeNull();
  await act(async () => labelled('Open Demo with sound').click());
  const video = document.body.querySelector('video[aria-label="Video of Demo with sound"]');
  expect(video?.getAttribute('src')).toBe('/files/demo');
  expect(video?.hasAttribute('controls')).toBe(true);
  expect(video?.getAttribute('poster')).toBe('/files/demo-thumbnail');
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
  await act(async () => labelled('Open Checkout run').click());
  await settle();
  expect(ranges).toEqual([`bytes=0-${FRAMES_AHEAD * 4 - 1}`]);
  expect(await shown()).toEqual({ at: 'Checkout run at 0:00', bytes: [0, 0, 0, 0] });

  await act(async () => button('Play').click());
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

  await act(async () => button('Pause').click());
  const seek = document.body.querySelector<HTMLInputElement>('input[aria-label="Seek"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(seek, '30500');
    seek.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  expect(ranges.at(-1)).toBe(`bytes=120-${120 + FRAMES_AHEAD * 4 - 1}`);
  expect(await shown()).toEqual({ at: 'Checkout run at 0:30', bytes: [30, 30, 30, 30] });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect((await shown()).at).toBe('Checkout run at 0:30');
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
  expect(labelled('Agent recording').textContent).toContain('REC 0:30');
  expect(labelled('Open Agent recording').hasAttribute('disabled')).toBe(true);

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
  expect(labelled('Capture App').textContent).toBe('Capture');
  expect(labelled('Recording of App').textContent).toMatch(/· 1:05(?!:)/u);
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

it('shows page comments with where they point, who made them and on which page, and reads them again when one is announced', async () => {
  vi.useFakeTimers();
  comments = [comment(1, 'The button does nothing', true, '/files/crop-1')];
  await render();
  await settle();
  const first = labelled('Comment by Ana');
  expect(first.querySelector('img')?.getAttribute('src')).toBe('/files/crop-1');
  expect(first.textContent).toContain('guest');
  expect(first.textContent).toContain('The button does nothing');
  expect(first.textContent).toContain('On button “Sign in”');
  expect(first.querySelector('a')?.getAttribute('href')).toBe('https://app.example.com/login');

  comments = [comment(2, 'Make it blue', false, null), ...comments];
  await act(async () => { liveNotices.receive({ ...workspaceLiveKey('workspace', 'page-comments', 'project'), version: 1 }); });
  await settle();
  const second = labelled('Comment by Brad');
  expect(second.textContent).toContain('Make it blue');
  expect(second.textContent).not.toContain('guest');
  expect(second.querySelector('img')).toBeNull();
});
