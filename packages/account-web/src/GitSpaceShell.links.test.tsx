// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { planQuestions } from '@gitspace/blocks';
import type { RuntimeQuestion } from '@gitspace/protocol-runtime';
import { verticalSliceFixture } from './App.js';
import { GitSpaceShell, type GitSpaceShellProps } from './GitSpaceShell.js';
import { QuestionCardsContext, type QuestionCards } from './QuestionCards.js';
import type { TranscriptHistory } from './useTranscriptHistory.js';

const plan: RuntimeQuestion = { id: 'question:task-2', conversationId: 'main', kind: 'approval', prompt: '## Loyalty stamps\n\nOne stamp per paid order.', choices: ['Approve', 'Reject'], answer: null };
const attach: RuntimeQuestion = { id: 'machine-attach:m-1:a', conversationId: 'main', kind: 'approval', prompt: 'Attach Desktop to this workspace? Agents may not attach it on their own.', choices: ['Approve', 'Reject'], answer: null, tool: { name: 'machines', args: { op: 'attach', machine: 'm-1' } } };
const rejects = async () => { throw new Error('not used'); };

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
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
});
/** The workspace opened from `link`, its main conversation's cards answering `questions`. */
async function open(link: string, questions: RuntimeQuestion[], props: Partial<GitSpaceShellProps>): Promise<void> {
  window.history.replaceState(null, '', link);
  const cards: QuestionCards = { questions, watch: () => null, request: rejects, answer: rejects };
  await act(async () => root.render(<QuestionCardsContext.Provider value={cards}><GitSpaceShell {...verticalSliceFixture} {...props} /></QuestionCardsContext.Provider>));
}

it('a link naming a card in the main conversation jumps the transcript to its row', async () => {
  const transcript: TranscriptHistory = {
    generation: 'generation', loading: false, initialLoading: false, error: null, saved: false, navigation: null, hasBefore: true, hasAfter: false, total: 3,
    rows: [
      { id: 'row-1', ordinal: 1024, turnId: 'turn-1', turnStatus: 'done', truncated: false, contentBytes: 10, item: { id: 'message-1', type: 'message', role: 'user', text: 'Plan loyalty stamps' } },
      { id: 'row-2', ordinal: 2048, turnId: 'turn-1', turnStatus: 'done', truncated: false, contentBytes: 10, item: { id: 'main:ask:call-2', type: 'ask', kind: 'plan', toolCallId: 'call-2', questionId: plan.id, status: 'pending', questions: planQuestions(plan.prompt) } },
      { id: 'row-3', ordinal: 3072, turnId: 'turn-2', turnStatus: 'done', truncated: false, contentBytes: 10, item: { id: 'message-2', type: 'message', role: 'assistant', text: 'Waiting for your approval.' } },
    ],
    refresh: vi.fn(), loadOlder: vi.fn(), loadNewer: vi.fn(), jumpToLatest: vi.fn(), jumpToRow: vi.fn(), jumpToOrdinal: vi.fn(), setViewport: vi.fn(),
    content: vi.fn(async () => ({ text: '{}', offset: 0, nextOffset: null, totalCharacters: 2 })),
    executionPage: vi.fn(async () => ({ generation: 'generation', revision: 0, rows: [], hasBefore: false, hasAfter: false, total: 0 })),
  };
  await open(`/?project=project&workspace=workspace&question=${encodeURIComponent(plan.id)}`, [plan], { transcript });
  expect(transcript.jumpToOrdinal).toHaveBeenCalledTimes(1);
  expect(transcript.jumpToOrdinal).toHaveBeenCalledWith(2048);
});

it('a link naming a tool approval lights up its approval above the composer', async () => {
  const sessionControls: NonNullable<GitSpaceShellProps['sessionControls']> = {
    value: {
      sessionId: 'session-a', role: null, roleLabel: null, roles: [], provider: 'anthropic', models: [], model: null, thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, goal: null, history: [], historyAnchorId: null,
      pendingAsk: { id: attach.id, source: 'gitspace', links: [], questions: [{ id: 'decision', question: attach.prompt, header: 'Approval required', multi: false, recommended: null, written: false, options: [{ label: 'Approve', description: null, preview: null }, { label: 'Reject', description: null, preview: null }] }] },
    },
    onCycleRole: rejects, onSetModel: rejects, onSetThinking: rejects, onSetFast: rejects, onSetGoal: rejects, onCompact: rejects, onClearQueue: rejects, onRemoveQueuedMessage: rejects, onPromoteQueuedMessage: rejects, onDismissAutomationRun: rejects, onStop: rejects, onNavigateTree: rejects,
  };
  await open(`/?project=project&workspace=workspace&question=${encodeURIComponent(attach.id)}`, [attach], { sessionControls });
  const panel = container.querySelector(`[data-question="${CSS.escape(attach.id)}"]`);
  expect(panel?.textContent).toContain('Attach Desktop to this workspace?');
  expect(panel?.classList.contains('ghost-flash')).toBe(true);
});

it('a link naming the Environment panel opens the Inspector on it', async () => {
  const renderInspector = vi.fn<NonNullable<GitSpaceShellProps['renderInspector']>>(() => <p>Inspector</p>);
  await open('/?project=project&workspace=workspace&panel=environment', [], { renderInspector });
  expect(renderInspector).toHaveBeenCalled();
  expect(renderInspector.mock.calls.at(-1)?.[1]).toBe('environment');
});
