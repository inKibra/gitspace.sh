// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeBrowserPageComment, RuntimeBrowserSharePreview, RuntimeBrowserShareServerMessage } from '@gitspace/protocol-runtime';
import { currentDevice } from '../device-session.js';
import type { BrowserDevice } from '../device.js';
import { SharePage } from './SharePage.js';

vi.mock('../device-session.js', () => ({ currentDevice: vi.fn(async () => null), deviceRejected: vi.fn() }));

const shareId = '11111111-1111-4111-8111-111111111111';
const secret = 'S'.repeat(43);
const grace = '22222222-2222-4222-8222-222222222222';
const linus = '33333333-3333-4333-8333-333333333333';
const joinedAt = '2026-10-24T10:00:00.000Z';

class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: unknown[] = [];
  constructor(readonly url: string) { super(); FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = FakeSocket.CLOSED; }
  async open() { await act(async () => { this.readyState = FakeSocket.OPEN; this.dispatchEvent(new Event('open')); }); }
  async receive(message: RuntimeBrowserShareServerMessage) { await act(async () => { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }); }
  async drop() { await act(async () => { this.readyState = FakeSocket.CLOSED; this.dispatchEvent(new Event('close')); }); }
}

type Call = { action: string; body: unknown; device: string | null };
let calls: Call[];
let answers: Record<string, (body: unknown) => Response>;
let root: Root;
let container: HTMLDivElement;
let joins: number;

const answer = (value: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { status: 'ok', value } : { error: value }), { status, headers: { 'content-type': 'application/json' } });
function preview(overrides: Partial<RuntimeBrowserSharePreview> = {}): RuntimeBrowserSharePreview {
  return { sharer: 'Ada', page: { title: 'Checkout', site: 'shop.example' }, comment: true, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), ended: null, ...overrides };
}
function joinedMessage(share = preview()): RuntimeBrowserShareServerMessage {
  return { type: 'joined', viewerId: grace, share, viewers: [{ viewerId: grace, name: 'Grace', guest: true, joinedAt }], comments: [] };
}
const latest = () => FakeSocket.all.at(-1)!;
const byLabel = (label: string) => document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
function button(text: string, scope: HTMLElement = document.body): HTMLButtonElement {
  const element = [...scope.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text);
  if (!element) throw new Error(`Missing button ${text}`);
  return element;
}
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
async function open(share = preview()) {
  answers.preview = () => answer(share);
  window.history.replaceState(null, '', `/s/${shareId}#${secret}`);
  await act(async () => root.render(<SharePage />));
  await settle();
}
async function typeInto(field: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!field) throw new Error('Missing field');
  await act(() => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function join(name = 'Grace') {
  await typeInto(document.body.querySelector('input'), name);
  await act(async () => button('Join').click());
  await settle();
}
/** Joins, opens the socket and answers hello. */
async function watch(share = preview()) {
  await open(share);
  await join();
  await latest().open();
  await latest().receive(joinedMessage(share));
}
async function pointer(type: 'pointermove' | 'pointerdown' | 'pointerup', x: number, y: number) {
  await act(async () => { byLabel('Shared tab')!.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1 })); });
}
const sentOf = (type: string) => latest().sent.filter(message => typeof message === 'object' && message !== null && 'type' in message && message.type === type);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-24T10:00:00.000Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', FakeSocket);
  // Every element is an 800×500 box at the origin: the stage, and the shared tab fitted into it.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 500 }));
  if (!Element.prototype.getAnimations) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  FakeSocket.all = [];
  calls = [];
  joins = 0;
  answers = { join: () => answer({ token: `token-${++joins}`, viewerId: grace, name: 'Grace', guest: true, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }) };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    const body: unknown = await request.json();
    calls.push({ action, body, device: request.headers.get('x-gitspace-device') });
    return answers[action]!(body);
  }));
  window.localStorage.clear();
  vi.mocked(currentDevice).mockResolvedValue(null);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('greets with the preview fetched by the fragment secret and redeems nothing until Join', async () => {
  await open();
  expect(calls).toEqual([{ action: 'preview', body: { secret }, device: null }]);
  const text = document.body.textContent ?? '';
  expect(text).toContain('Ada is sharing a tab with you');
  expect(text).toContain('Checkout');
  expect(text).toContain('shop.example');
  expect(text).toContain('Comment on what you point at');
  expect(text).toContain('Click or type in the tab');
  expect(text).toContain('in 60 minutes');
  expect(FakeSocket.all).toEqual([]);

  await join('Grace');
  expect(calls.map(call => call.action)).toEqual(['preview', 'join']);
  expect(calls[1]!.body).toEqual({ secret, name: 'Grace' });
  expect(FakeSocket.all.map(socket => socket.url)).toEqual([`ws://${window.location.host}/api/shares/${shareId}/live`]);

  // The name is offered again on the next share.
  await act(async () => root.unmount());
  root = createRoot(container);
  await open();
  expect(document.body.querySelector('input')?.value).toBe('Grace');
});

it('says an ended share has ended, without offering to join', async () => {
  await open(preview({ ended: 'revoked' }));
  expect(document.body.textContent).toContain('This share has ended');
  expect(document.body.textContent).toContain('Ada stopped sharing.');
  expect([...document.body.querySelectorAll('button')].some(candidate => candidate.textContent === 'Join')).toBe(false);
  expect(calls.map(call => call.action)).toEqual(['preview']);
});

it('says a link with a wrong secret opens nothing', async () => {
  answers.preview = () => answer({ code: 'SHARE_UNKNOWN', message: 'Unknown share' }, 404);
  window.history.replaceState(null, '', `/s/${shareId}#${secret}`);
  await act(async () => root.render(<SharePage />));
  await settle();
  expect(document.body.textContent).toContain('This link doesn’t open a share');
  expect(document.body.textContent).not.toContain('Join');
});

it('joins signed by this browser’s enrolled device as the account, without asking for a name', async () => {
  const keyPair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  if (!('privateKey' in keyPair)) throw new Error('Expected a key pair');
  const device: BrowserDevice = { deviceId: '44444444-4444-4444-8444-444444444444', label: 'Browser', publicKey: '', keyPair, enrolledAt: 0, userId: 'user', enrollUrl: 'https://account.test', canDelegate: false };
  vi.mocked(currentDevice).mockResolvedValue(device);
  await open();
  expect(document.body.textContent).toContain('Joining as Ada');
  expect(document.body.querySelector('input')).toBeNull();
  await act(async () => button('Join').click());
  // Signing runs in WebCrypto, outside the faked clock.
  await act(async () => { await vi.waitFor(() => expect(calls).toHaveLength(2)); });
  expect(calls[1]).toMatchObject({ action: 'join', body: { secret, name: 'Ada' }, device: expect.any(String) });
});

it('after Join says hello, offers its size, sends its pointer at most 20 times a second, and shows frames and others’ named pointers', async () => {
  await open();
  await join();
  const socket = latest();
  await socket.open();
  expect(socket.sent).toEqual([{ type: 'hello', token: 'token-1' }, { type: 'size', width: 800, height: 500 }]);
  await socket.receive(joinedMessage());

  await pointer('pointermove', 400, 250);
  await pointer('pointermove', 200, 100);
  await pointer('pointermove', 80, 50);
  expect(sentOf('pointer')).toEqual([{ type: 'pointer', at: { x: 0.5, y: 0.5 } }]);
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(sentOf('pointer')).toEqual([{ type: 'pointer', at: { x: 0.5, y: 0.5 } }, { type: 'pointer', at: { x: 0.1, y: 0.1 } }]);

  await socket.receive({ type: 'frame', data: 'AAAA', width: 1280, height: 800 });
  expect(document.body.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');

  await socket.receive({ type: 'viewers', viewers: [
    { viewerId: grace, name: 'Grace', guest: true, joinedAt, at: { x: 0.1, y: 0.1 } },
    { viewerId: linus, name: 'Linus', guest: false, joinedAt, at: { x: 0.25, y: 0.75 } },
  ] });
  const linusPointer = byLabel('Linus\'s pointer');
  expect(linusPointer?.style.left).toBe('25%');
  expect(linusPointer?.style.top).toBe('75%');
  expect(byLabel('Watching')?.textContent).toContain('Grace (you)');
  expect(byLabel('Watching')?.textContent).toContain('Linus');
});

it('offers no Comment mode on a view-only share', async () => {
  await open(preview({ comment: false }));
  expect(document.body.textContent).toContain('Comment: this share is view only');
  await join();
  await latest().open();
  await latest().receive(joinedMessage(preview({ comment: false })));
  expect([...document.body.querySelectorAll('button')].some(candidate => candidate.textContent?.includes('Comment'))).toBe(false);
  expect(byLabel('Comments')).toBeNull();
});

it('in Comment mode outlines what the pointer hovers and comments on what is clicked', async () => {
  await watch();
  await act(async () => button('Comment').click());
  await pointer('pointermove', 400, 250);
  expect(sentOf('hit')).toEqual([{ type: 'hit', at: { x: 0.5, y: 0.5 } }]);
  await latest().receive({ type: 'hit', at: { x: 0.5, y: 0.5 }, target: { box: { x: 0.4, y: 0.45, width: 0.2, height: 0.1 }, role: 'button', name: 'Pay now', text: 'Pay now', selectors: ['#pay'] } });
  const outline = byLabel('button Pay now');
  expect(outline?.style.left).toBe('40%');
  expect(outline?.style.width).toBe('20%');

  await pointer('pointerdown', 400, 250);
  await pointer('pointerup', 400, 250);
  const box = byLabel('New comment');
  expect(box?.textContent).toContain('On button “Pay now”');
  await typeInto(box!.querySelector('textarea'), 'This should say the total');
  await act(async () => button('Comment', box!).click());
  expect(sentOf('comment')).toEqual([{ type: 'comment', at: { x: 0.5, y: 0.5 }, text: 'This should say the total' }]);

  const comment: RuntimeBrowserPageComment = {
    version: 1, commentId: '55555555-5555-4555-8555-555555555555', shareId, by: { name: 'Grace', guest: true }, text: 'This should say the total',
    page: { url: 'https://shop.example/checkout', title: 'Checkout' }, target: { box: { x: 0.4, y: 0.45, width: 0.2, height: 0.1 }, role: 'button', name: 'Pay now', text: 'Pay now', selectors: ['#pay'] },
    region: { x: 0.4, y: 0.45, width: 0.2, height: 0.1 }, viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0 }, crop: null, createdAt: '2026-10-24T10:01:00.000Z',
  };
  await latest().receive({ type: 'comments', comments: [comment] });
  expect(byLabel('New comment')).toBeNull();
  const panel = byLabel('Comments')!.textContent;
  expect(panel).toContain('Grace');
  expect(panel).toContain('guest');
  expect(panel).toContain('This should say the total');
  expect(panel).toContain('On button “Pay now”');
});

it('comments on a dragged area', async () => {
  await watch();
  await act(async () => button('Comment').click());
  await pointer('pointerdown', 80, 50);
  await pointer('pointermove', 400, 250);
  await pointer('pointerup', 400, 250);
  const box = byLabel('New comment')!;
  expect(box.textContent).toContain('On this area');
  await typeInto(box.querySelector('textarea'), 'Too crowded');
  await act(async () => button('Comment', box).click());
  expect(sentOf('comment')).toEqual([{ type: 'comment', region: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 }, text: 'Too crowded' }]);
});

it('shows the ended state when the share ends while watching, and does not reconnect', async () => {
  await watch();
  await latest().receive({ type: 'ended', reason: 'expired' });
  await latest().drop();
  expect(document.body.textContent).toContain('This share has ended');
  expect(document.body.textContent).toContain('Its time ran out.');
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(calls.filter(call => call.action === 'join')).toHaveLength(1);
  expect(FakeSocket.all).toHaveLength(1);
});

it('joins again with a fresh token when the socket drops', async () => {
  await watch();
  await latest().drop();
  expect(document.body.textContent).toContain('Reconnecting');
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(calls.filter(call => call.action === 'join')).toHaveLength(2);
  expect(FakeSocket.all).toHaveLength(2);
  await latest().open();
  expect(latest().sent[0]).toEqual({ type: 'hello', token: 'token-2' });
  await latest().receive(joinedMessage());
  expect(document.body.textContent).not.toContain('Reconnecting');
});
