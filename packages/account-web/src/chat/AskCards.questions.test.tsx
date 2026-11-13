// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planQuestions, type AskBlock } from '@gitspace/blocks';
import type { RuntimeQuestion } from '@gitspace/protocol-runtime';
import { SessionControlSchema, type RuntimeSessionCommand } from '@gitspace/protocol-runtime/session-controls';
import { QuestionCardsContext, type QuestionCards } from '../QuestionCards.js';
import { AskBlockView } from './AskCards.js';

const control = SessionControlSchema.parse({ sessionId: 'main', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, historyAnchorId: null, history: [], goal: null, pendingAsk: null });
const ask: AskBlock = { id: 'main:ask:call-1', type: 'ask', toolCallId: 'call-1', questionId: 'question:task-1', status: 'pending', questions: [{ id: 'question-1', prompt: 'Which bucket?', options: [{ id: 'assets', title: 'assets' }, { id: 'uploads', title: 'uploads' }] }] };
const plan: AskBlock = { id: 'main:ask:call-2', type: 'ask', kind: 'plan', toolCallId: 'call-2', questionId: 'question:task-2', status: 'pending', questions: planQuestions('## Loyalty stamps\n\nOne stamp per paid order.') };
const asked: RuntimeQuestion = { id: 'question:task-1', conversationId: 'main', kind: 'ask', prompt: 'Which bucket?', choices: ['assets', 'uploads'], answer: null };
const proposed: RuntimeQuestion = { id: 'question:task-2', conversationId: 'main', kind: 'approval', prompt: '## Loyalty stamps\n\nOne stamp per paid order.', choices: ['Approve', 'Reject'], answer: null };
let container: HTMLDivElement;
let root: Root;
let requested: RuntimeSessionCommand[];
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); requested = []; });
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function render(item: AskBlock, questions: RuntimeQuestion[], refusal?: string): Promise<void> {
  const cards: QuestionCards = {
    questions, watch: () => null,
    async request(command) { if (refusal) throw new Error(refusal); requested.push(command); return { control }; },
    async answer() { throw new Error('Not answered here'); },
  };
  await act(async () => root.render(<QuestionCardsContext.Provider value={cards}><AskBlockView item={item} /></QuestionCardsContext.Provider>));
}
function origin(): string | null | undefined { return container.querySelector('[data-ask-origin]')?.textContent; }
function chosen(text: string): boolean {
  const row = [...container.querySelectorAll('li')].find((item) => item.textContent?.includes(text));
  if (!row) throw new Error(`No row ${text}`);
  return row.querySelector('[aria-label="Chosen"]') !== null;
}
function button(text: string): HTMLButtonElement | undefined { return [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text); }

describe('an ask card that posted a workspace question', () => {
  it('is open while its question is open, or not in the snapshot yet, and answers through the conversation', async () => {
    await render(ask, []);
    expect(origin()).toBe('Questionasked by the workspace agentWaiting for you');
    await render(ask, [asked]);
    expect(origin()).toBe('Questionasked by the workspace agentWaiting for you');
    await act(async () => { container.querySelector<HTMLElement>('[role="radio"]')!.click(); });
    expect(requested).toEqual([{ type: 'answerAsk', id: 'question:task-1', answers: [{ id: 'question-1', selectedOptions: ['assets'], customInput: null }] }]);
  });

  it('once answered shows the answer the question stored, read only, and who answered it', async () => {
    await render(ask, [{ ...asked, answer: [{ id: 'question-1', selectedOptions: ['uploads'], customInput: null }], answeredBy: { by: 'project-agent', at: '2026-11-07T10:00:00.000Z', for: 'Brad' } }]);
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Question, answered');
    expect(chosen('uploads')).toBe(true);
    expect(chosen('assets')).toBe(false);
    expect(origin()).toBe('Questionasked by the workspace agent· Answered by the project agent for Brad');
    expect(container.querySelector('[role="radio"]')).toBeNull();
    expect(button('Dismiss')).toBeUndefined();
  });

  it('a plan answered shows the decision and the note it stored', async () => {
    await render(plan, [{ ...proposed, answer: { approved: false, note: 'Keep the stamp card behind the flag.' } }]);
    expect(container.textContent).toContain('Plan approval · answered');
    expect(container.textContent).toContain('Rejected');
    expect(container.textContent).toContain('Keep the stamp card behind the flag.');
  });

  it.each<[NonNullable<RuntimeQuestion['closed']>['reason'], string]>([
    ['dismissed', 'Dismissed'],
    ['stopped', 'Closed: the conversation was stopped or reset'],
    ['expired', 'Expired'],
  ])('once closed (%s) says why and offers no answer', async (reason, label) => {
    await render(ask, [{ ...asked, closed: { reason, at: '2026-11-07T10:00:00.000Z' } }]);
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe(`Question, ${label}`);
    expect(origin()).toBe(`Questionasked by the workspace agent· ${label}`);
    expect(chosen('uploads')).toBe(false);
    expect(container.querySelector('[role="radio"]')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('Dismiss closes the question unanswered', async () => {
    await render(ask, [asked]);
    await act(async () => { button('Dismiss')!.click(); });
    expect(requested).toEqual([{ type: 'dismissQuestion', id: 'question:task-1' }]);
  });

  it('a refused Dismiss says why on the card and keeps it open', async () => {
    await render(ask, [asked], 'Question question:task-1 is closed (the person dismissed it), so it can no longer be answered.');
    await act(async () => { button('Dismiss')!.click(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('so it can no longer be answered');
    expect(button('Dismiss')?.disabled).toBe(false);
  });
});
