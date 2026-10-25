// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeBrowserSharePreview } from '@gitspace/protocol-runtime';
import type { SessionControlView } from '@gitspace/protocol-runtime/session-controls';
import { verticalSliceFixture } from './App.js';
import { Composer, type ComposerProps } from './Composer.js';
import type { GitSpaceShellProps } from './GitSpaceShell.js';
import type { ArtifactUploadClient } from './inspector/artifact-upload.js';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client(commit: ArtifactUploadClient['commit']) {
  return {
    begin: vi.fn<ArtifactUploadClient['begin']>(async ({ fileName }) => ({ link: 'https://account.test/api/uploads/token-1', url: `drive://workspace/uploads/${fileName}`, partBytes: 256 * 1024 })),
    part: vi.fn<ArtifactUploadClient['part']>(async ({ partNumber, bytes }) => ({ received: (partNumber - 1) * 256 * 1024 + bytes.length })),
    commit: vi.fn<ArtifactUploadClient['commit']>(commit),
    abort: vi.fn<ArtifactUploadClient['abort']>(async () => undefined),
  };
}

async function draftWithAttachment(text: string, file: File) {
  const textarea = container.querySelector('textarea')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(); });
  for (let turn = 0; turn < 20; turn += 1) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  return textarea;
}

it('uploads attachments that are not sent inline and links them in the prompt', async () => {
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  const uploads = client(async () => ({ kind: 'artifact', url: 'drive://workspace/uploads/report%20(1).pdf', hash: 'hash', label: 'uploads/report (1).pdf', mediaType: 'application/pdf', generation: 1 }));
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} artifactUpload={uploads} running={false} pending={false} onSend={onSend} />));

  const textarea = await draftWithAttachment('Summarize this', new File([new Uint8Array(10)], 'report (1).pdf', { type: 'application/pdf' }));

  expect(uploads.begin).toHaveBeenCalledWith({ fileName: 'report (1).pdf', size: 10, sha256: '01d448afd928065458cf670b60f5a594d735af0172c8d67f22a81680132681ca', mediaType: 'application/pdf' });
  expect(uploads.commit).toHaveBeenCalledWith('https://account.test/api/uploads/token-1');
  expect(onSend.mock.calls.map(([text]) => text)).toEqual(['Summarize this\n\n<attachment name="report (1).pdf" url="drive://workspace/uploads/report%20(1).pdf" type="application/pdf" size="10" />']);
  expect(textarea.value).toBe('');
});

it('keeps the draft and its attachment when the upload fails', async () => {
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  const uploads = client(async () => { throw new Error('The workspace is no longer open on a machine.'); });
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} artifactUpload={uploads} running={false} pending={false} onSend={onSend} />));

  const textarea = await draftWithAttachment('Summarize this', new File([new Uint8Array(10)], 'report.pdf', { type: 'application/pdf' }));

  expect(onSend).not.toHaveBeenCalled();
  expect(container.querySelector('[role=alert]')?.textContent).toBe('The workspace is no longer open on a machine.');
  expect(textarea.value).toBe('Summarize this');
  expect(container.querySelector('[aria-label="Remove report.pdf"]')).not.toBeNull();
});

const shareId = '00000000-0000-4000-8000-0000000000d1';
const secret = 'test-share-secret'.padEnd(43, 'x');
const control: SessionControlView = { sessionId: 'session-a', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null, history: [], historyAnchorId: null };
const greeting: RuntimeBrowserSharePreview = { sharer: 'Brad', page: { title: 'Checkout', site: 'shop.example.com' }, comment: true, expiresAt: '2026-10-24T13:00:00.000Z', ended: null };
/** An hour before the greeting's share expires. */
function beforeShareExpiry() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'));
}

async function typeDraft(text: string) {
  const textarea = container.querySelector('textarea')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // The greeting's fetch, its body and the render it causes.
  for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
  return textarea;
}
async function send() {
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(); });
  for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
}

const connectedTab = { pairingId: '00000000-0000-4000-8000-0000000000a1', browser: 'Work Chrome', groupId: '00000000-0000-4000-8000-0000000000aa', targetId: 'tab-a', url: 'https://shop.example.com/checkout', title: 'Checkout' };

it('swaps a pasted share link out of the draft into a chip of its tab, connects the tab before sending and names the tab instead of the link', async () => {
  beforeShareExpiry();
  const link = `${window.location.origin}/s/${shareId}#${secret}`;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ status: 'ok', value: greeting }));
  vi.stubGlobal('fetch', fetch);
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  const sessionCommand = vi.fn<NonNullable<ComposerProps['sessionCommand']>>(async () => ({ control, browserConnectedTab: connectedTab }));
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} onSend={onSend} sessionCommand={sessionCommand} />));

  const textarea = await typeDraft(`Why does this fail? ${link}`);
  expect(textarea.value).toBe('Why does this fail? ');
  expect(container.querySelector('[aria-label="Tab Checkout"]')?.textContent).toContain('shop.example.com');
  expect(container.querySelector('[aria-label="Tab Checkout"]')?.textContent).toContain('joins this workspace when you send');
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0]!;
  expect(String(url)).toBe(`${window.location.origin}/api/shares/${shareId}/preview`);
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({ secret });

  await send();
  expect(sessionCommand.mock.calls.map(([command]) => command)).toEqual([{ type: 'browserShareConnect', shareId, secret }]);
  expect(sessionCommand.mock.invocationCallOrder[0]).toBeLessThan(onSend.mock.invocationCallOrder[0]!);
  expect(onSend.mock.calls.map(([text]) => text)).toEqual(['[Connected tab "Checkout" (https://shop.example.com/checkout) on Work Chrome, pairingId 00000000-0000-4000-8000-0000000000a1, targetId tab-a; use web_browser with source "relay" and this pairingId]\nWhy does this fail?']);
  expect(textarea.value).toBe('');
  expect(container.querySelector('[aria-label="Shared tabs"]')).toBeNull();
  expect(container.querySelector('[role=status]')?.textContent).toBe('Tab connected: shop.example.com joined this workspace\'s group in Work Chrome. The agent may use it while it stays there.');
});

it('keeps the draft and its tab chip and shows why when the tab cannot be connected', async () => {
  beforeShareExpiry();
  const link = `${window.location.origin}/s/${shareId}#${secret}`;
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => Response.json({ status: 'ok', value: greeting })));
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  const sessionCommand = vi.fn<NonNullable<ComposerProps['sessionCommand']>>(async () => { throw new Error('This share has ended.'); });
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} onSend={onSend} sessionCommand={sessionCommand} />));

  const textarea = await typeDraft(`Look at ${link}`);
  await send();
  expect(sessionCommand).toHaveBeenCalledOnce();
  expect(onSend).not.toHaveBeenCalled();
  expect(container.querySelector('[role=alert]')?.textContent).toBe('This share has ended.');
  expect(textarea.value).toBe('Look at ');
  expect(container.querySelector('[aria-label="Tab Checkout"]')).not.toBeNull();
});

it('sends without connecting a tab whose share ended or that you removed', async () => {
  beforeShareExpiry();
  const ended = '00000000-0000-4000-8000-0000000000d2';
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input) => Response.json({ status: 'ok', value: String(input).includes(ended) ? { ...greeting, page: { title: 'Old cart', site: 'shop.example.com' }, ended: 'revoked' } : greeting })));
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  const sessionCommand = vi.fn<NonNullable<ComposerProps['sessionCommand']>>(async () => ({ control, browserConnectedTab: connectedTab }));
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} onSend={onSend} sessionCommand={sessionCommand} />));

  await typeDraft(`Compare ${window.location.origin}/s/${shareId}#${secret} and ${window.location.origin}/s/${ended}#${secret}`);
  expect(container.querySelector('[aria-label="Tab Old cart"]')?.textContent).toContain("Sharing stopped · it won't join this workspace");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Tab Checkout"] button[aria-label="Remove tab"]')!.click());
  await send();
  expect(sessionCommand).not.toHaveBeenCalled();
  expect(onSend.mock.calls.map(([text]) => text)).toEqual(['Compare and']);
});
