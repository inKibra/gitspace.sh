// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeBrowserCommentBox, RuntimeBrowserHolder, RuntimeBrowserWatchServerMessage } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand, RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { signDeviceRequest } from './device.js';
import { BrowserWatchDialog, framePoint, type BrowserWatchTarget } from './BrowserWatchDialog.js';

vi.mock('./device-session.js', () => ({ currentDevice: vi.fn(async () => ({ deviceId: 'laptop' })), deviceRejected: vi.fn() }));
vi.mock('./device.js', () => ({ signDeviceRequest: vi.fn(async () => 'signed-proof') }));

class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: unknown[] = [];
  constructor(readonly url: string, readonly protocols: string[]) { super(); FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = FakeSocket.CLOSED; }
  async open() { await act(async () => { this.readyState = FakeSocket.OPEN; this.dispatchEvent(new Event('open')); }); }
  async receive(message: RuntimeBrowserWatchServerMessage) { await act(async () => { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }); }
}

const groupId = '00000000-0000-4000-8000-0000000000aa';
const chrome: BrowserWatchTarget = { source: 'chrome', groupId, targetId: 'tab-a', title: 'Login', url: 'https://app.example.com/login', label: 'Work Chrome · feature-login group' };
const cloud: BrowserWatchTarget = { source: 'cloud', groupId, targetId: 'cloud-tab', title: 'App', url: 'https://app.example.com/', label: 'Cloud browser' };
const yours: RuntimeBrowserHolder = { targetId: 'tab-a', holder: 'you', since: '2026-10-25T12:00:00.000Z', by: 'gitspace', device: 'laptop' };
let root: Root;
let container: HTMLDivElement;
/** The workspace's session commands: each is recorded and stays in flight (the dialog follows its socket, not the answer). */
const request = vi.fn<(command: RuntimeSessionCommand) => Promise<RuntimeSessionResult>>();
let closed: number;

const latest = () => FakeSocket.all.at(-1)!;
const inputs = () => latest().sent.filter(message => typeof message === 'object' && message !== null && 'type' in message && message.type !== 'size');
function button(text: string): HTMLButtonElement | undefined { return [...document.body.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text); }
const screen = () => document.body.querySelector<HTMLElement>('[role="application"]')!;
async function show(target: BrowserWatchTarget, options: { takeover?: boolean; focusInChrome?: boolean; pin?: { n: number; box: RuntimeBrowserCommentBox } } = {}) {
  await act(async () => root.render(<BrowserWatchDialog identity={{ projectId: 'project', workspaceId: 'workspace' }} request={request} target={target} takeover={options.takeover ?? true} focusInChrome={options.focusInChrome ?? target.source === 'chrome'} pin={options.pin} onClose={() => { closed += 1; root.render(null); }} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
async function pointer(type: 'pointerdown' | 'pointerup' | 'pointermove', x: number, y: number, pointerType = 'mouse') {
  await act(async () => { screen().dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerType, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1 })); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', FakeSocket);
  // Every element is an 800×500 box at the origin: the frame (16:10) fills the screen exactly.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 500 }));
  if (!Element.prototype.getAnimations) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  FakeSocket.all = [];
  closed = 0;
  request.mockReset();
  request.mockImplementation(() => new Promise<RuntimeSessionResult>(() => {}));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('maps a point of the shown frame to fractions of the tab’s viewport, and none where the frame is not drawn', () => {
  // A 2:1 frame in an 800×500 box is drawn 800×400, 50 px from its top.
  expect(framePoint({ left: 0, top: 0, width: 800, height: 500 }, { width: 1000, height: 500 }, { x: 400, y: 50 })).toEqual({ x: 0.5, y: 0 });
  expect(framePoint({ left: 100, top: 0, width: 800, height: 500 }, { width: 1000, height: 500 }, { x: 300, y: 350 })).toEqual({ x: 0.25, y: 0.75 });
  expect(framePoint({ left: 0, top: 0, width: 800, height: 500 }, { width: 1000, height: 500 }, { x: 400, y: 20 })).toBeNull();
});

it('shows the tab live on a socket this device signs, and closing the dialog stops it', async () => {
  await show(chrome);
  expect(latest().url).toBe('ws://localhost:3000/api/browser-watch?source=chrome&projectId=project&workspaceId=workspace&groupId=00000000-0000-4000-8000-0000000000aa&targetId=tab-a');
  expect(latest().protocols).toEqual(['gitspace-device.signed-proof']);
  expect(vi.mocked(signDeviceRequest)).toHaveBeenCalledWith({ deviceId: 'laptop' }, { method: 'GET', path: '/api/browser-watch?source=chrome&projectId=project&workspaceId=workspace&groupId=00000000-0000-4000-8000-0000000000aa&targetId=tab-a', body: new Uint8Array() });
  await latest().open();
  expect(latest().sent).toContainEqual({ type: 'size', width: 800, height: 500 });
  await latest().receive({ type: 'control', holder: null, input: false });
  await latest().receive({ type: 'frame', data: 'AAAA', width: 1280, height: 800 });
  expect(document.body.querySelector('img[alt="Live view of Login"]')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
  expect([...document.body.querySelectorAll('[role="dialog"] button')].map(element => element.textContent?.trim()).filter(text => text && text !== 'Close')).toEqual(['Focus in Chrome', 'Take over', 'Done']);
  await act(async () => button('Done')!.click());
  expect(closed).toBe(1);
  expect(latest().readyState).toBe(FakeSocket.CLOSED);
});

it('Show on page highlights the comment thread’s pin where it pointed on the live frame', async () => {
  await show(chrome, { pin: { n: 3, box: { x: 0.25, y: 0.5, w: 0.25, h: 0.1 } } });
  await latest().open();
  expect(screen().querySelector('[aria-label="Comment 3"]')).toBeNull();
  await latest().receive({ type: 'frame', data: 'AAAA', width: 1280, height: 800 });
  const pin = screen().querySelector<HTMLElement>('[aria-label="Comment 3"]')!;
  expect(pin.textContent).toBe('3');
  expect(parseFloat(pin.style.left)).toBeCloseTo(50);
  expect(parseFloat(pin.style.top)).toBeCloseTo(50);
});

it('sends your input only while this device holds the tab, at the spot of the frame you pointed at', async () => {
  await show(cloud);
  await latest().open();
  await latest().receive({ type: 'frame', data: 'AAAA', width: 1280, height: 800 });
  await latest().receive({ type: 'control', holder: null, input: false });
  await pointer('pointerdown', 400, 125);
  await act(async () => { screen().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', code: 'KeyA', keyCode: 65 })); });
  expect(inputs()).toEqual([]);

  await latest().receive({ type: 'control', holder: { ...yours, targetId: 'cloud-tab' }, input: true });
  expect(document.body.textContent).toContain('You’re in control');
  expect(document.body.textContent).toContain('main is paused · it sees your changes when it resumes');
  expect(button('Take over')).toBeUndefined();
  await pointer('pointerdown', 400, 125);
  await pointer('pointerup', 400, 125);
  await act(async () => { screen().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', code: 'KeyA', keyCode: 65 })); });
  expect(inputs()).toEqual([
    { type: 'mouse', event: 'down', x: 0.5, y: 0.25, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 },
    { type: 'mouse', event: 'up', x: 0.5, y: 0.25, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 },
    { type: 'key', event: 'down', key: 'a', code: 'KeyA', keyCode: 65, text: 'a', location: 0, repeat: false, modifiers: 0 },
  ]);

  // Taken in Chrome itself: the person at that keyboard drives it, not this device.
  await latest().receive({ type: 'control', holder: { ...yours, targetId: 'cloud-tab', by: 'chrome', device: null }, input: false });
  expect(document.body.textContent).toContain('You’re in control in Chrome');
  await pointer('pointerdown', 100, 100);
  expect(inputs()).toHaveLength(3);
  await act(async () => button('Resume agent')!.click());
  expect(request.mock.calls.map(([command]) => command)).toEqual([{ type: 'browserResume', groupId, targetId: 'cloud-tab' }]);
});

it('takes the tab over for this device; a Chrome whose extension cannot be taken over says to update it', async () => {
  await show(chrome);
  await latest().open();
  await act(async () => button('Take over')!.click());
  expect(request.mock.calls.map(([command]) => command)).toEqual([{ type: 'browserTakeOver', groupId, targetId: 'tab-a' }]);
  await act(async () => root.render(null));
  await show(chrome, { takeover: false });
  expect(button('Take over')).toBeUndefined();
  expect(document.body.textContent).toContain('Update the extension to take over from here');
});

it('on a touch screen, maps your taps to touches and types into the tab from its text field', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)', media: query, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
  await show(cloud);
  await latest().open();
  await latest().receive({ type: 'frame', data: 'AAAA', width: 1280, height: 800 });
  await latest().receive({ type: 'control', holder: { ...yours, targetId: 'cloud-tab' }, input: true });
  await pointer('pointerdown', 200, 250, 'touch');
  await pointer('pointerup', 200, 250, 'touch');
  const field = document.body.querySelector<HTMLInputElement>('input[aria-label="Text for the page"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Ada'); field.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button('Type')!.click());
  expect(inputs()).toEqual([
    { type: 'touch', event: 'start', points: [{ id: 0, x: 0.25, y: 0.5 }], modifiers: 0 },
    { type: 'touch', event: 'end', points: [], modifiers: 0 },
    { type: 'text', text: 'Ada' },
  ]);
  expect(field.value).toBe('');
});
