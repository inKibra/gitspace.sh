// @vitest-environment happy-dom
import type { TurnBlock } from '@gitspace/blocks';
import type { SessionControlView } from '@gitspace/protocol-runtime/session-controls';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verticalSliceFixture } from '../App.js';
import { GitSpaceShell, type GitSpaceShellProps, type SessionControlsProps } from '../GitSpaceShell.js';

let root: Root;
let container: HTMLDivElement;
let animationDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.unstubAllGlobals();
});

const waiting: GitSpaceShellProps['mainAgent'] = { id: 'session-a', title: 'Workspace agent', state: 'waiting', model: 'GPT-5.6' };
const control: SessionControlView = { sessionId: 'session-a', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null, history: [], historyAnchorId: null };

function controls(followUp: string[]): SessionControlsProps {
  const done = async (): Promise<void> => undefined;
  return {
    value: { ...control, queue: { steering: [], followUp } },
    onCycleRole: done, onSetModel: done, onSetThinking: done, onSetFast: done, onSetGoal: done, onCompact: done, onClearQueue: done, onAnswerAsk: done, onStop: done, onNavigateTree: done,
    onRemoveQueuedMessage: done, onPromoteQueuedMessage: done, onDismissAutomationRun: done,
  };
}

async function enter(text: string): Promise<HTMLTextAreaElement> {
  const textarea = container.querySelector('textarea')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  return textarea;
}

function outgoing(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[aria-label="Messages being sent"]');
}

it('shows a sent message at the end of the transcript as sending until the transcript has it, then only the transcript’s', async () => {
  const accepted = Promise.withResolvers<void>();
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(() => accepted.promise);
  const answered: TurnBlock = { id: 'turn-2', type: 'turn', status: 'running', user: { id: 'turn-2-user', type: 'message', role: 'user', text: 'Ship the release notes' }, items: [], sideAgents: [] };
  const render = (turns: TurnBlock[]) => act(() => root.render(<GitSpaceShell {...verticalSliceFixture} mainAgent={waiting} turns={turns} onSend={onSend} />));
  await render([...verticalSliceFixture.turns]);

  const textarea = await enter('Ship the release notes');
  expect(textarea.value).toBe('');
  expect(onSend.mock.calls.map(([text]) => text)).toEqual(['Ship the release notes']);
  expect(outgoing()?.textContent).toBe('Ship the release notesSending…');
  expect(outgoing()?.previousElementSibling?.tagName).toBe('ARTICLE');

  // Accepted, but not in the transcript yet: it stays where it is.
  await act(async () => { accepted.resolve(); await accepted.promise; });
  expect(outgoing()?.textContent).toBe('Ship the release notesSending…');

  await render([...verticalSliceFixture.turns, answered]);
  expect(outgoing()).toBeNull();
  expect(container.textContent?.split('Ship the release notes')).toHaveLength(2);
});

it('shows a message sent during a turn as sending until the session queues it, then as its queued row', async () => {
  const accepted = Promise.withResolvers<void>();
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(() => accepted.promise);
  const render = (followUp: string[]) => act(() => root.render(<GitSpaceShell {...verticalSliceFixture} sessionControls={controls(followUp)} onSend={onSend} />));
  const queued = () => [...container.querySelectorAll('[aria-label^="Queued message"]')].map((row) => row.getAttribute('aria-label'));
  await render([]);

  const textarea = await enter('Also update the docs');
  expect(textarea.value).toBe('');
  expect(onSend.mock.calls.map(([text, behavior]) => [text, behavior])).toEqual([['Also update the docs', 'followUp']]);
  expect(outgoing()?.textContent).toBe('Also update the docsSending…');
  expect(queued()).toEqual([]);

  await act(async () => { accepted.resolve(); await accepted.promise; });
  await render(['Also update the docs']);
  expect(outgoing()).toBeNull();
  expect(queued()).toEqual(['Queued message 1 of 1: Also update the docs']);
});
