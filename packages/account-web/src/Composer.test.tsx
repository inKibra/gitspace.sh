// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { automationMessage, type AutomationMessageEvent } from '@gitspace/protocol/automations-contract';
import type { RuntimeBrowserSharePreview, RuntimeDictationServerMessage } from '@gitspace/protocol-runtime';
import { chatAttachments, withoutChatAttachments } from '@gitspace/protocol-runtime/chat-attachments';
import type { SessionControlView } from '@gitspace/protocol-runtime/session-controls';
import { verticalSliceFixture } from './App.js';
import { StandaloneComposer as Composer, type ComposerProps } from './Composer.js';
import { currentDevice } from './device-session.js';
import type { GitSpaceShellProps, SessionControlsProps } from './GitSpaceShell.js';
import type { ArtifactUploadClient } from './inspector/artifact-upload.js';

vi.mock('./device-session.js', () => ({ currentDevice: vi.fn(), deviceRejected: vi.fn() }));

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const keyPair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  if (!('privateKey' in keyPair)) throw new Error('Expected a key pair');
  vi.mocked(currentDevice).mockResolvedValue({ deviceId: '44444444-4444-4444-8444-444444444444', label: 'Browser', publicKey: '', keyPair, enrolledAt: 0, userId: 'user', enrollUrl: 'https://account.test', canDelegate: false });
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

/** An upload authority that files each upload at `<folder>/<name>` and commits it under the digest begin declared. */
function client(commit?: ArtifactUploadClient['commit']) {
  const uploads = new Map<string, { path: string; sha256: string; mediaType: string | null }>();
  return {
    begin: vi.fn<ArtifactUploadClient['begin']>(async ({ fileName, folder, sha256, mediaType }) => {
      const link = `https://account.test/api/uploads/token-${uploads.size + 1}`;
      const path = `${folder ?? 'uploads'}/${fileName}`;
      uploads.set(link, { path, sha256, mediaType });
      return { link, url: `drive://workspace/${path}`, partBytes: 256 * 1024 };
    }),
    part: vi.fn<ArtifactUploadClient['part']>(async ({ partNumber, bytes }) => ({ received: (partNumber - 1) * 256 * 1024 + bytes.length })),
    commit: vi.fn<ArtifactUploadClient['commit']>(commit ?? (async (link) => {
      const upload = uploads.get(link)!;
      return { kind: 'artifact', url: `drive://workspace/${upload.path}`, hash: `sha256:${upload.sha256}`, label: upload.path, mediaType: upload.mediaType, generation: 1 };
    })),
    abort: vi.fn<ArtifactUploadClient['abort']>(async () => undefined),
  };
}

async function attach(...files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

async function draftWithAttachment(text: string, ...files: File[]) {
  const textarea = container.querySelector('textarea')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await attach(...files);
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(); });
  for (let turn = 0; turn < 20; turn += 1) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  return textarea;
}

it('uploads an image and a PDF to the day\'s uploads folder and sends one message naming both', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T09:30:00Z') });
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  const uploads = client();
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} artifactUpload={uploads} running={false} pending={false} onSend={onSend} />));

  const textarea = await draftWithAttachment('Compare these', new File([new Uint8Array(4)], 'shot.png', { type: 'image/png' }), new File([new Uint8Array(10)], 'report (1).pdf', { type: 'application/pdf' }));

  expect(uploads.begin.mock.calls.map(([input]) => [input.fileName, input.folder])).toEqual([['shot.png', 'uploads/2026-11-13'], ['report (1).pdf', 'uploads/2026-11-13']]);
  expect(onSend).toHaveBeenCalledOnce();
  const [text, ...rest] = onSend.mock.calls[0]!;
  expect(rest).toEqual(['followUp', undefined, undefined]);
  expect(text.startsWith('Compare these\n\n')).toBe(true);
  expect(chatAttachments(text)).toEqual([
    { name: 'shot.png', url: 'drive://workspace/uploads/2026-11-13/shot.png', type: 'image/png', size: 4, hash: 'sha256:df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119' },
    { name: 'report (1).pdf', url: 'drive://workspace/uploads/2026-11-13/report (1).pdf', type: 'application/pdf', size: 10, hash: 'sha256:01d448afd928065458cf670b60f5a594d735af0172c8d67f22a81680132681ca' },
  ]);
  expect(text).not.toMatch(/base64|data:image/u);
  expect(textarea.value).toBe('');
  // A removed tile leaves once its exit animation ends.
  await vi.waitFor(() => expect(container.querySelector('[aria-label^="Remove "]')).toBeNull());
});

function outgoing(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[aria-label="Messages being sent"]');
}

it('empties the composer at Enter and shows the message sending; a failed upload stays on it, and Edit puts its text and file back with what was typed since', async () => {
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  const stored = Promise.withResolvers<never>();
  const uploads = client(() => stored.promise);
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} artifactUpload={uploads} running={false} pending={false} onSend={onSend} />));

  const textarea = await draftWithAttachment('Summarize this', new File([new Uint8Array(10)], 'report.pdf', { type: 'application/pdf' }));
  expect(textarea.value).toBe('');
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Remove report.pdf"]')).toBeNull());
  expect(outgoing()?.textContent).toContain('Summarize this');
  expect([...outgoing()!.querySelectorAll('[role=status]')].map((status) => status.textContent)).toEqual(['Uploaded', 'Sending…']);
  expect(outgoing()?.querySelector('[aria-label="Attachments"]')?.textContent).toContain('report.pdf');

  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'And this');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { stored.reject(new Error('The workspace is no longer open on a machine.')); await stored.promise.catch(() => undefined); });
  await settle();
  expect(onSend).not.toHaveBeenCalled();
  expect(outgoing()?.querySelector('[role=alert]')?.textContent).toBe('Not sent: report.pdf did not upload: The workspace is no longer open on a machine.');
  expect(outgoing()?.textContent).not.toContain('Sending…');

  await act(async () => { [...outgoing()!.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!.click(); });
  expect(textarea.value).toBe('Summarize this\n\nAnd this');
  expect(container.querySelector('[aria-label="Remove report.pdf"]')).not.toBeNull();
  expect(outgoing()).toBeNull();
});

it('sends a failed message again on Retry', async () => {
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  const uploads = client();
  const commit = uploads.commit.getMockImplementation()!;
  let failed = false;
  uploads.commit.mockImplementation(async (link) => {
    if (failed) return commit(link);
    failed = true;
    throw new Error('The workspace is no longer open on a machine.');
  });
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} artifactUpload={uploads} running={false} pending={false} onSend={onSend} />));

  await draftWithAttachment('Summarize this', new File([new Uint8Array(10)], 'report.pdf', { type: 'application/pdf' }));
  expect(outgoing()?.querySelector('[role=alert]')?.textContent).toBe('Not sent: report.pdf did not upload: The workspace is no longer open on a machine.');

  await act(async () => { [...outgoing()!.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!.click(); });
  await settle();
  expect(onSend).toHaveBeenCalledOnce();
  const [text] = onSend.mock.calls[0]!;
  expect(withoutChatAttachments(text)).toBe('Summarize this');
  expect(chatAttachments(text).map((attachment) => attachment.name)).toEqual(['report.pdf']);
  expect(outgoing()?.querySelector('[role=alert]')).toBeNull();
  expect(outgoing()?.textContent).toContain('Sending…');
});

it('shows each attachment\'s remove button without hover, and it removes that file', async () => {
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} artifactUpload={client()} running={false} pending={false} onSend={async () => undefined} />));
  await attach(new File([new Uint8Array(4)], 'shot.png', { type: 'image/png' }), new File([new Uint8Array(10)], 'report.pdf', { type: 'application/pdf' }));

  const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove shot.png"]')!;
  expect(remove.className).not.toMatch(/(?:^|\s)opacity-0(?:\s|$)/u);
  expect(remove.tabIndex).toBe(0);
  await act(async () => remove.click());

  await vi.waitFor(() => expect(container.querySelector('[aria-label="Remove shot.png"]')).toBeNull());
  expect(container.querySelector('[aria-label="Remove report.pdf"]')).not.toBeNull();
});

it('removes the last attachment on Backspace in an empty message, and only then', async () => {
  const uploads = client();
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} artifactUpload={uploads} running={false} pending={false} onSend={async () => undefined} />));
  await attach(new File([new Uint8Array(4)], 'shot.png', { type: 'image/png' }), new File([new Uint8Array(10)], 'report.pdf', { type: 'application/pdf' }));
  const backspace = () => act(() => { container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })); });

  await typeDraft('x');
  await backspace();
  await typeDraft('');
  await backspace();
  await typeDraft('Send what is left');
  await send();

  await vi.waitFor(() => expect(uploads.begin.mock.calls.map(([input]) => input.fileName)).toEqual(['shot.png']));
});

it('attaches an image pasted into the message', async () => {
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} onSend={async () => undefined} />));
  const screenshot = new File([new Uint8Array(10)], 'image.png', { type: 'image/png' });
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [screenshot], types: ['Files'] } });

  await act(async () => container.querySelector('textarea')!.dispatchEvent(paste));

  expect(container.querySelector('[aria-label="Remove image.png"]')).not.toBeNull();
  expect(paste.defaultPrevented).toBe(true);
});

// A session command in flight (the send itself, or the read of the agent's controls when a turn starts or ends) holds
// the send. A disabled box would drop the browser's focus and refuse the paste.
it('takes a paste while a session command is in flight and sends it, with its image, once the command settles', async () => {
  const sending = Promise.withResolvers<void>();
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(() => sending.promise);
  const uploads = client();
  const render = (pending: boolean) => act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} artifactUpload={uploads} running={false} pending={pending} onSend={onSend} />));
  await render(false);
  const textarea = await typeDraft('First message');
  await send();
  await render(true);

  expect(textarea.disabled).toBe(false);
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [new File([new Uint8Array(10)], 'image.png', { type: 'image/png' })], types: ['Files', 'text/plain'] } });
  await act(async () => textarea.dispatchEvent(paste));
  // DOM emulation does not insert the text a paste carries.
  await typeDraft('Second message');
  await act(() => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  expect(onSend).toHaveBeenCalledOnce();
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(true);

  await act(async () => { sending.resolve(); await sending.promise; });
  await render(false);
  expect(textarea.value).toBe('Second message');
  await send();
  await vi.waitFor(() => expect(onSend.mock.calls.map(([text]) => [withoutChatAttachments(text), chatAttachments(text).map((attachment) => attachment.name)])).toEqual([['First message', []], ['Second message', ['image.png']]]));
});

const shareId = '00000000-0000-4000-8000-0000000000d1';
const secret = 'test-share-secret'.padEnd(43, 'x');
const control: SessionControlView = { sessionId: 'session-a', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null, history: [], historyAnchorId: null };
const greeting: RuntimeBrowserSharePreview = { sharer: 'Brad', page: { title: 'Checkout', site: 'shop.example.com', icon: null }, comment: true, expiresAt: '2026-10-24T13:00:00.000Z', ended: null, browser: 'Work Chrome', online: true };
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
  // The greeting's fetch (signed in WebCrypto, outside React's turns), its body and the render it causes.
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).not.toContain('Reading the shared tab…'); });
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
  const request = new Request(...fetch.mock.calls[0]!);
  expect(request.url).toBe(`${window.location.origin}/api/shares/${shareId}/preview`);
  expect(request.method).toBe('POST');
  expect(await request.json()).toEqual({ secret });
  // Asked as this browser's device, the account names the Chrome holding the tab, and the chip shows it.
  expect(request.headers.get('x-gitspace-device')).toEqual(expect.any(String));
  expect(container.querySelector('[aria-label="Tab Checkout"]')?.textContent).toContain('shop.example.com· Work Chrome');

  await send();
  expect(sessionCommand.mock.calls.map(([command]) => command)).toEqual([{ type: 'browserShareConnect', shareId, secret }]);
  expect(sessionCommand.mock.invocationCallOrder[0]).toBeLessThan(onSend.mock.invocationCallOrder[0]!);
  expect(onSend.mock.calls.map(([text]) => text)).toEqual(['[Connected tab "Checkout" (https://shop.example.com/checkout) on Work Chrome, pairingId 00000000-0000-4000-8000-0000000000a1, targetId tab-a; use web_browser with source "relay" and this pairingId]\nWhy does this fail?']);
  expect(textarea.value).toBe('');
  expect(container.querySelector('[aria-label="Shared tabs"]')).toBeNull();
  expect([...container.querySelectorAll('[role=status]')].map((status) => status.textContent)).toContain('Tab connected: shop.example.com joined this workspace\'s group in Work Chrome. The agent may use it while it stays there.');
});

it('keeps the message with its tab and shows why when the tab cannot be connected, and Edit puts both back into the composer', async () => {
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
  expect(outgoing()?.querySelector('[role=alert]')?.textContent).toBe('Not sent: This share has ended.');
  expect(outgoing()?.textContent).toContain('shop.example.com');
  expect(textarea.value).toBe('');
  expect(container.querySelector('[aria-label="Tab Checkout"]')).toBeNull();

  await act(async () => { [...outgoing()!.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!.click(); });
  expect(textarea.value).toBe('Look at');
  expect(container.querySelector('[aria-label="Tab Checkout"]')).not.toBeNull();
  expect(outgoing()).toBeNull();
});

it('says when the shared tab’s Chrome is offline, so sending would not connect it', async () => {
  beforeShareExpiry();
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => Response.json({ status: 'ok', value: { ...greeting, online: false } })));
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} onSend={vi.fn()} sessionCommand={vi.fn()} />));
  await typeDraft(`Look at ${window.location.origin}/s/${shareId}#${secret}`);
  expect(container.querySelector('[aria-label="Tab Checkout"]')?.textContent).toContain('Work Chrome is offline · open that Chrome to connect this tab');
});

it('sends without connecting a tab whose share ended or that you removed', async () => {
  beforeShareExpiry();
  const ended = '00000000-0000-4000-8000-0000000000d2';
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input) => Response.json({ status: 'ok', value: new Request(input).url.includes(ended) ? { ...greeting, page: { title: 'Old cart', site: 'shop.example.com', icon: null }, ended: 'revoked' } : greeting })));
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

it('turns a capture mention into a chip named from the workspace’s captures and sends the mention for the workspace to expand', async () => {
  const captureId = '6f0c2a7e-1b2c-4d3e-8f90-a1b2c3d4e5f6', other = '00000000-0000-4000-8000-0000000000c2';
  const view = { capture: { version: 2 as const, captureId, name: 'Order a pizza', by: 'you' as const, source: 'relay' as const, browser: 'Work Chrome', page: { url: 'https://shop.test/', title: 'Shop' }, target: null, startedAt: '2026-10-25T19:31:00.000Z', endedAt: '2026-10-25T19:31:14.000Z', state: 'saved' as const, reason: null, tracks: { steps: { path: 'steps.json' as const, count: 5 } }, skill: null }, files: {} };
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  const sessionCommand = vi.fn<NonNullable<ComposerProps['sessionCommand']>>(async () => ({ control, browserCaptures: [view] }));
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} onSend={onSend} sessionCommand={sessionCommand} />));

  const textarea = container.querySelector('textarea')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, `capture://${captureId} capture://${other} Make a skill of it`);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
  expect(textarea.value).toBe('Make a skill of it');
  expect(sessionCommand.mock.calls.map(([command]) => command)).toEqual([{ type: 'browserCaptures' }]);
  expect(container.querySelector('[aria-label="Capture Order a pizza"]')?.textContent).toBe('Order a pizza· 5 steps');
  expect(container.querySelector(`[aria-label="Capture ${other}"]`)?.textContent).toBe('Capture· not found in this workspace');
  await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="Capture ${other}"] button[aria-label="Remove capture"]`)!.click());
  await send();
  expect(onSend.mock.calls.map(([text]) => text)).toEqual([`capture://${captureId}\nMake a skill of it`]);
  expect(container.querySelector('[aria-label="Mentioned captures"]')).toBeNull();
});

const reviewEvents: AutomationMessageEvent[] = [
  ...[12, 40, 7].map((line, index): AutomationMessageEvent => ({ kind: 'comment', event: 'pull_request_review_comment.created', author: 'dana', path: 'src/cart/total.ts', line, state: null, text: `Comment ${index + 1}`, url: null })),
  { kind: 'review', event: 'pull_request_review.submitted', author: 'dana', path: null, line: null, state: 'changes_requested', text: '', url: null },
];
const waitingRun = automationMessage({ run: 'run-41', name: 'Review feedback', source: 'github', subject: 'PR #1434', instruction: 'Address the review.', events: reviewEvents });

it('shows an automation run waiting in the queue as its run, apart from the person’s queued messages, and acts on its run', async () => {
  const done = async (): Promise<void> => undefined;
  const dismissRun = vi.fn<SessionControlsProps['onDismissAutomationRun']>(done);
  const promote = vi.fn<SessionControlsProps['onPromoteQueuedMessage']>(done);
  const remove = vi.fn<SessionControlsProps['onRemoveQueuedMessage']>(done);
  const controls: SessionControlsProps = {
    value: { ...control, queue: { steering: [], followUp: ['Also update the docs', waitingRun] } },
    onCycleRole: done, onSetModel: done, onSetThinking: done, onSetFast: done, onSetGoal: done, onCompact: done, onClearQueue: done, onAnswerAsk: done, onStop: done, onNavigateTree: done,
    onRemoveQueuedMessage: remove, onPromoteQueuedMessage: promote, onDismissAutomationRun: dismissRun,
  };
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} controls={controls} running pending={false} onSend={vi.fn()} />));

  const run = container.querySelector('[aria-label="Automation Review feedback"]')!;
  expect(run.textContent).toBe('Review feedback · PR #14343 comments, 1 review · delivered when this turn endsDeliver nowDismissOpen run');
  expect([...container.querySelectorAll('[aria-label^="Queued message"]')].map((row) => row.getAttribute('aria-label'))).toEqual(['Queued message 1 of 1: Also update the docs']);
  expect(container.textContent).not.toContain('Automation input');

  const [deliver, dismiss] = [...run.querySelectorAll('button')];
  await act(async () => deliver!.click());
  expect(promote).toHaveBeenCalledExactlyOnceWith(1);
  await act(async () => dismiss!.click());
  expect(dismissRun).toHaveBeenCalledExactlyOnceWith('run-41');
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove queued message: Also update the docs"]')!.click());
  expect(remove).toHaveBeenCalledExactlyOnceWith('followUp', 0);
});

/** The dictation socket as the composer opens it: what it sent, and server messages delivered on demand. */
class DictationSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: DictationSocket[] = [];
  readyState = DictationSocket.OPEN;
  binaryType = 'blob';
  sent: (string | ArrayBuffer)[] = [];
  constructor(readonly url: string) { super(); DictationSocket.all.push(this); }
  send(data: string | ArrayBuffer) { this.sent.push(data); }
  close() { this.readyState = DictationSocket.CLOSED; }
  async receive(message: RuntimeDictationServerMessage) { await act(async () => { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }); }
}
/** The worklet's port, answering a flush at once. */
class FakeWorkletPort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(message: unknown) { if (message === 'flush') queueMicrotask(() => this.onmessage?.({ data: 'flushed' })); }
}
class FakeWorkletNode {
  port = new FakeWorkletPort();
  disconnect() {}
}
class FakeAudioContext {
  state = 'running';
  audioWorklet = { addModule: async () => undefined };
  createMediaStreamSource() { return { connect() {} }; }
  async close() { this.state = 'closed'; }
}

/** A browser whose microphone opens as `getUserMedia` answers, with an audio graph and a dictation socket of fakes. */
function microphone(getUserMedia: () => Promise<unknown>) {
  vi.stubGlobal('WebSocket', DictationSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pcm16');
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(getUserMedia) } });
  DictationSocket.all = [];
}
async function settle() {
  for (let turn = 0; turn < 20; turn += 1) await act(() => { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, 0); return promise; });
}

it('dictates into the draft at the cursor without sending, showing what it hears while you speak', async () => {
  microphone(async () => ({ getTracks: () => [{ stop() {} }] }));
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} onSend={onSend} />));
  const textarea = container.querySelector('textarea')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Fix please');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  textarea.setSelectionRange(4, 4);

  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!.click());
  await settle();
  const socket = DictationSocket.all[0]!;
  const opened = new URL(socket.url);
  expect(`${opened.pathname}${opened.search}`).toBe(`/api/dictation?${new URLSearchParams({ projectId: verticalSliceFixture.workspace.projectId, workspaceId: verticalSliceFixture.workspace.id })}`);
  await socket.receive({ type: 'ready', mode: 'live' });
  await socket.receive({ type: 'interim', text: 'the log in' });
  expect(container.querySelector('[role=status]')?.textContent).toBe('the log in');
  await socket.receive({ type: 'final', text: 'the login page' });
  await settle();

  expect(textarea.value).toBe('Fix the login page please');
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Stop dictation"]')!.click());
  await settle();
  expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: 'stop' }));
  await socket.receive({ type: 'done' });
  expect(container.querySelector('button[aria-label="Dictate"]')).not.toBeNull();
  expect(onSend).not.toHaveBeenCalled();
});

it('says plainly when the microphone is blocked, and opens no dictation', async () => {
  microphone(async () => { throw new DOMException('Permission denied', 'NotAllowedError'); });
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} onSend={async () => undefined} />));

  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!.click());
  await settle();

  expect(container.querySelector('[role=alert]')?.textContent).toBe('Microphone access is blocked. Allow the microphone for this site in your browser, then try again.');
  expect(DictationSocket.all).toEqual([]);
});
