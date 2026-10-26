// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeBrowserCapture, RuntimeBrowserCaptureShareOpened, RuntimeBrowserCaptureSharePreview, RuntimeBrowserComment, RuntimeBrowserCommentThread } from '@gitspace/protocol-runtime';
import { z } from 'zod';
import { CaptureSharePage } from './CaptureSharePage.js';

vi.mock('../device-session.js', () => ({ currentDevice: vi.fn(async () => null), deviceRejected: vi.fn() }));

const captureShareId = '11111111-1111-4111-8111-111111111111';
const captureId = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';
const secret = 'S'.repeat(43);
const url = 'https://httpbin.org/forms/post';
const telephone = { role: 'textbox', name: 'Telephone:', selector: '#tel', box: { x: 0.1, y: 0.3, w: 0.4, h: 0.05 } };
const capture: RuntimeBrowserCapture = {
  version: 2, captureId, name: 'Pizza form review', by: 'you', source: 'relay', browser: 'Studio desktop', page: { url, title: 'Pizza' }, target: null,
  startedAt: '2026-10-25T10:00:00.000Z', endedAt: '2026-10-25T10:04:12.000Z', state: 'saved', reason: null,
  tracks: { video: { path: 'video.webm', mediaType: 'video/webm', sound: true, durationMs: 252_000 }, layout: { path: 'layout.jsonl', count: 1 } },
};
const root0: RuntimeBrowserComment = { id: threadId, threadId, parentId: null, source: { kind: 'capture', captureId, atMs: 31_000 }, page: { url, title: 'Pizza' }, anchor: telephone, by: { kind: 'person', name: 'Bradley', guest: false }, text: 'Telephone only matters for delivery orders.', createdAt: '2026-10-25T10:01:00.000Z', resolved: null };

type Call = { action: string; body: Record<string, unknown> };
let calls: Call[];
let root: Root;
let container: HTMLDivElement;

const answer = (value: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { status: 'ok', value } : { error: value }), { status, headers: { 'content-type': 'application/json' } });
function button(text: string): HTMLButtonElement {
  const element = [...document.body.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text);
  if (!element) throw new Error(`Missing button ${text}`);
  return element;
}
const labelled = (label: string) => {
  const element = document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing ${label}`);
  return element;
};
async function settle() { for (let round = 0; round < 4; round += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
async function typeInto(field: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!field) throw new Error('Missing field');
  await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  calls = [];
  const preview: RuntimeBrowserCaptureSharePreview = { sharer: 'Bradley', capture: { name: 'Pizza form review', page: { url, title: 'Pizza' }, durationMs: 252_000, comments: 1 }, comment: true, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(), ended: null };
  const opened: RuntimeBrowserCaptureShareOpened = {
    token: 'viewer-token', name: 'Ana', guest: true, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), sharer: 'Bradley', comment: true, shareExpiresAt: preview.expiresAt,
    capture, files: { 'video.webm': '/api/capture-shares/x/files/video', 'layout.jsonl': '/api/capture-shares/x/files/layout' }, threads: [{ root: root0, replies: [] }],
  };
  const layout = { atMs: 0, viewport: { w: 1000, h: 625 }, scroll: { x: 0, y: 0 }, elements: [telephone] };
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    if (path.endsWith('/files/layout')) return new Response(JSON.stringify(layout));
    const action = /\/api\/capture-shares\/[^/]+\/([a-z]+)$/u.exec(new URL(path, 'https://account.test').pathname)?.[1] ?? '';
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(String(init?.body)));
    calls.push({ action, body });
    if (action === 'preview') return answer(preview);
    if (action === 'open') return answer(opened);
    const made: RuntimeBrowserCommentThread = body.op === 'reply'
      ? { root: root0, replies: [{ ...root0, id: '44444444-4444-4444-8444-444444444444', parentId: threadId, anchor: null, source: root0.source, by: { kind: 'person', name: 'Ana', guest: true }, text: String(body.text) }] }
      : { root: { ...root0, id: '55555555-5555-4555-8555-555555555555', threadId: '55555555-5555-4555-8555-555555555555', source: { kind: 'capture', captureId, atMs: Number(body.atMs) }, by: { kind: 'person', name: 'Ana', guest: true }, text: String(body.text) }, replies: [] };
    return answer({ thread: made });
  }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 625 }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('greets with the shared capture, then plays it for a guest who replies and comments at a moment but cannot resolve', async () => {
  window.history.replaceState(null, '', `/c/${captureShareId}#${secret}`);
  await act(async () => root.render(<CaptureSharePage />));
  await settle();
  expect(calls).toEqual([{ action: 'preview', body: { secret } }]);
  const greeting = document.body.textContent;
  for (const text of ['Bradley shared a capture with you', 'Bradley\'s browser doesn\'t need to be on', 'Pizza form review', 'httpbin.org/forms/post · 4:12 · 1 comment', '✓ Watch the whole session and scrub through it', '✓ Reply, and comment at any moment on anything', '✕ The live page: this is a recording', 'Ends in 7 days']) expect(greeting).toContain(text);
  expect(button('Open').disabled).toBe(true);
  await typeInto(document.body.querySelector('input'), 'Ana');
  await act(async () => button('Open').click());
  await settle();
  expect(calls.at(-1)).toEqual({ action: 'open', body: { secret, name: 'Ana' } });
  expect(document.body.textContent).toContain('Pizza form review · capture from Bradley · 4:12 · whole recording');

  // The thread opens at its moment; a guest replies under their name and gets no Resolve.
  await act(async () => labelled('Comment 1 at 0:31').click());
  const thread = labelled('Comment thread 1');
  expect(thread.querySelector('textarea')?.getAttribute('placeholder')).toBe('Reply as Ana (guest)…');
  expect([...thread.querySelectorAll('button')].map(element => element.textContent)).not.toContain('Resolve');
  await typeInto(thread.querySelector('textarea'), 'Or pickup?');
  await act(async () => button('Reply').click());
  await settle();
  expect(calls.at(-1)).toEqual({ action: 'comments', body: { op: 'reply', token: 'viewer-token', threadId, text: 'Or pickup?' } });

  await act(async () => button('Comment at 0:31').click());
  const surface = labelled('Point at what to comment on');
  for (const kind of ['pointerdown', 'pointerup']) await act(async () => { surface.dispatchEvent(new PointerEvent(kind, { bubbles: true, clientX: 300, clientY: 200, pointerId: 1 })); });
  await typeInto(labelled('New comment').querySelector('textarea'), 'Should this say it is optional?');
  await act(async () => button('Comment').click());
  await settle();
  expect(calls.at(-1)).toEqual({ action: 'comments', body: { op: 'comment', token: 'viewer-token', atMs: 31_000, page: { url, title: 'Pizza' }, anchor: telephone, text: 'Should this say it is optional?' } });
  expect(labelled('Comment 2 at 0:31').textContent).toContain('Ana (guest) · at 0:31');
});
