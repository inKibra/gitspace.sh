// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verticalSliceFixture } from '../App.js';
import type { BlockState } from '../blocks/BlockActions.js';
import { Composer } from '../Composer.js';
import type { GitSpaceShellProps } from '../GitSpaceShell.js';
import { ComposerStagingProvider, useComposerStaging, workspaceBlockActions, type ComposerStaging } from './staging.js';

vi.mock('../device-session.js', () => ({ currentDevice: vi.fn(async () => null), deviceRejected: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let staging: ComposerStaging | null = null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  staging = null;
  vi.unstubAllGlobals();
});

function Probe() {
  staging = useComposerStaging();
  return null;
}

/** A block's GitSpace-owned state, recording what staging wrote to it. */
function block() {
  return { setStaged: vi.fn<BlockState['setStaged']>(), setSent: vi.fn<BlockState['setSent']>(), setAnswered: vi.fn<BlockState['setAnswered']>(), notify: vi.fn<BlockState['notify']>(), set: vi.fn<BlockState['set']>() };
}

function render(onSend: NonNullable<GitSpaceShellProps['onSend']>) {
  return act(() => root.render(<ComposerStagingProvider>
    <Probe />
    <Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} onSend={onSend} />
  </ComposerStagingProvider>));
}

async function type(text: string) {
  const textarea = container.querySelector('textarea')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function send() {
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(); });
  for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
}

function chips(): string[] {
  return [...container.querySelectorAll('[aria-label="Staged in your message"] > li')].map((chip) => chip.getAttribute('aria-label') ?? '');
}

it('shows a staged choice as a chip, swaps it when the same key is staged again, and un-stages the block when the chip is removed', async () => {
  await render(async () => undefined);
  const storage = block();
  await act(() => staging!.stage({ key: 'storage', kind: 'decision', label: 'SQLite', detail: 'Storage engine', payload: null }, { state: storage, key: 'engine' }));
  await act(() => staging!.stage({ key: 'storage', kind: 'decision', label: 'Postgres', detail: 'Storage engine', payload: null }, { state: storage, key: 'engine' }));

  expect(chips()).toEqual(['Decision Postgres']);
  expect(storage.setStaged.mock.calls).toEqual([['engine', 'SQLite'], ['engine', 'Postgres']]);
  expect(container.querySelector('textarea')?.getAttribute('placeholder')).toBe('Say why, or add context; your choices go with it…');

  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Remove decision Postgres"]')!.click(); });
  expect(chips()).toEqual([]);
  expect(storage.setStaged).toHaveBeenLastCalledWith('engine', null);
});

it('sends the chips without text as one message of their lines, and their blocks show them sent', async () => {
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  await render(onSend);
  const decision = block();
  const question = block();
  await act(() => {
    staging!.stage({ key: 'storage', kind: 'decision', label: 'Postgres', detail: 'Storage engine', payload: null }, { state: decision, key: 'engine' });
    staging!.stage({ key: 'q', kind: 'answer', label: 'Weekly', detail: 'How often?', payload: { questionId: 'cadence', answer: 'weekly' } }, { state: question, key: 'cadence', answers: true });
  });
  await send();

  expect(onSend).toHaveBeenCalledOnce();
  expect(onSend.mock.calls[0]?.[0]).toBe('Decided: Postgres (Storage engine)\nAnswered: Weekly (How often?)\n~~~json\n{\n  "questionId": "cadence",\n  "answer": "weekly"\n}\n~~~');
  expect(decision.setSent).toHaveBeenLastCalledWith('engine', 'Postgres');
  expect(decision.setStaged).toHaveBeenLastCalledWith('engine', null);
  expect(question.setAnswered).toHaveBeenCalledWith('Weekly');
  expect(chips()).toEqual([]);
});

it('puts the text first and the chips\' lines after it in the one message, and keeps the chips when the send fails', async () => {
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => { throw new Error('The agent is offline.'); });
  await render(onSend);
  const review = block();
  await act(() => staging!.stage({ key: 'batch', kind: 'review', label: '2 comments', payload: null }, { state: review, key: 'batch' }));
  await type('Address these first');
  await send();

  expect(onSend.mock.calls.map(([text]) => text)).toEqual(['Address these first\n\nReview batch: 2 comments']);
  expect(chips()).toEqual(['Review batch 2 comments']);
  expect(review.setSent).not.toHaveBeenCalledWith('batch', '2 comments');
});

it('hands the staged decisions to the send with the message, and none for answer or review chips', async () => {
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  await render(onSend);
  await act(() => {
    staging!.stage({ key: 'storage', kind: 'decision', label: 'Postgres', detail: 'Storage engine', payload: { sectionId: 'storage' } }, { state: block(), key: 'engine' });
    staging!.stage({ key: 'cache', kind: 'decision', label: 'No cache', payload: null }, { state: block(), key: 'cache' });
    staging!.stage({ key: 'q', kind: 'answer', label: 'Weekly', payload: null }, { state: block(), key: 'cadence' });
  });
  await type('It already runs in production');
  await send();
  expect(onSend.mock.calls[0]?.[3]).toEqual([
    { title: 'Storage engine', choice: 'Postgres', sectionId: 'storage', payload: { sectionId: 'storage' } },
    { title: 'No cache' },
  ]);

  await act(() => {
    staging!.stage({ key: 'q', kind: 'answer', label: 'Weekly', payload: null }, { state: block(), key: 'cadence' });
    staging!.stage({ key: 'batch', kind: 'review', label: '2 comments', payload: null }, { state: block(), key: 'batch' });
  });
  await send();
  expect(onSend.mock.calls[1]?.[0]).toBe('Answered: Weekly\nReview batch: 2 comments');
  expect(onSend.mock.calls[1]?.[3]).toEqual([]);
});

it('stages a block\'s choices under keys of their own block, and a failed sign-off unticks its row', async () => {
  await render(async () => undefined);
  const setAcceptance = vi.fn(async () => { throw new Error('The goal changed.'); });
  const actions = workspaceBlockActions({ staging, setAcceptance });
  const first = block();
  const second = block();
  await act(async () => {
    await actions.record_decision?.({ question: 'Storage engine', choice: 'Postgres', rationale: null }, first);
    await actions.record_decision?.({ question: 'Storage engine', choice: 'SQLite', rationale: null }, second);
  });
  expect(chips()).toEqual(['Decision Postgres', 'Decision SQLite']);

  await expect(actions.accept_requirement?.({ id: 'req-1', accepted: true, label: null, checkedPath: '/rows/0/checked' }, first)).rejects.toThrow('The goal changed.');
  expect(setAcceptance).toHaveBeenCalledWith('req-1', true);
  expect(first.set).toHaveBeenCalledWith('/rows/0/checked', false);
});
