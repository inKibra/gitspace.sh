// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToolCallBlock } from '@gitspace/blocks';
import { SessionControlSchema, type RuntimeSessionCommand } from '@gitspace/protocol-runtime/session-controls';
import type { RuntimeQuestion, RuntimeTakeoverQuestion } from '@gitspace/protocol-runtime';
import { TakeoverCardsContext, type TakeoverCards } from './TakeoverCard.js';
import { TranscriptItemView } from './TurnTranscript.js';

const groupId = '00000000-0000-4000-8000-0000000000a1';
const control = SessionControlSchema.parse({ sessionId: 'main', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, historyAnchorId: null, history: [], goal: null, pendingAsk: null });
const block: ToolCallBlock = { id: 'main:tool:call-1', type: 'tool-call', toolCallId: 'call-1', tool: 'ask_takeover', status: 'running', args: { source: 'relay', targetId: 'tab-a', reason: 'Sign in to GitHub' } };
const chrome: RuntimeTakeoverQuestion = { source: 'chrome', pairingId: '00000000-0000-4000-8000-0000000000b2', browser: 'Studio desktop', groupId, targetId: 'tab-a', url: 'https://github.com/login', title: 'Sign in to GitHub', holder: 'agent', callId: 'call-1', askedAt: '2026-10-25T10:00:00.000Z', until: '2026-10-25T10:30:00.000Z', waiting: true };
const cloud: RuntimeTakeoverQuestion = { ...chrome, source: 'cloud', pairingId: null, browser: 'Cloud browser', url: 'https://shop.example/pay', title: 'Pay' };
const question = (takeover: RuntimeTakeoverQuestion, answer: RuntimeQuestion['answer'] = null): RuntimeQuestion => ({ id: 'question:task-1', conversationId: 'main', kind: 'takeover', prompt: 'Sign in to **GitHub**; I cannot enter your password.', choices: ['Take over', 'Not now'], answer, takeover });
let container: HTMLDivElement;
let root: Root;
let requested: RuntimeSessionCommand[];
let watched: string[];
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); requested = []; watched = []; });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(questions: RuntimeQuestion[]) {
  const cards: TakeoverCards = {
    questions, async request(command) { requested.push(command); return { control }; },
    watch: (card, onClose) => { watched.push(card.targetId); return <button type="button" onClick={onClose}>Watching {card.title}</button>; },
  };
  await act(async () => root.render(<TakeoverCardsContext.Provider value={cards}><TranscriptItemView item={block} active /></TakeoverCardsContext.Provider>));
}
function buttons(): string[] { return [...container.querySelectorAll('button')].map(button => button.textContent?.trim() ?? ''); }
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button ${text}`);
  await act(async () => { button.click(); });
}

it('shows why the agent asks, the browser and the tab; Take over on Chrome takes the tab and brings it to the front', async () => {
  await render([question(chrome)]);
  expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Take over · Studio desktop');
  expect(container.textContent).toContain('Sign in to GitHub; I cannot enter your password.');
  expect(container.textContent).toContain('Studio desktop· github.com/login');
  expect(buttons()).toEqual(['Not now', 'Take over']);
  await click('Take over');
  expect(requested).toEqual([{ type: 'browserTakeOver', groupId, targetId: 'tab-a' }, { type: 'browserFocusTab', groupId, targetId: 'tab-a' }]);
  expect(watched).toEqual([]);
});

it('Take over on the cloud browser takes the tab and opens its Watch dialog', async () => {
  await render([question(cloud)]);
  expect(container.textContent).toContain('Cloud browser· shop.example/pay');
  await click('Take over');
  expect(requested).toEqual([{ type: 'browserTakeOver', groupId, targetId: 'tab-a' }]);
  expect(watched).toEqual(['tab-a']);
  await click('Watching Pay');
  expect(buttons()).not.toContain('Watching Pay');
});

it('Not now answers the card through the agent\'s question path', async () => {
  await render([question(chrome)]);
  await click('Not now');
  expect(requested).toEqual([{ type: 'answerAsk', id: 'question:task-1', answers: [{ id: 'question:task-1', selectedOptions: ['Not now'], customInput: null }] }]);
});

it('while you hold the tab the card says so and Resume agent hands it back', async () => {
  await render([question({ ...chrome, holder: 'you' })]);
  expect(container.textContent).toContain('You’re in control');
  expect(container.textContent).toContain('The agent is paused · it sees your changes when it resumes');
  expect(buttons()).toEqual(['Focus in Chrome', 'Resume agent']);
  await click('Resume agent');
  expect(requested).toEqual([{ type: 'browserResume', groupId, targetId: 'tab-a' }]);
  await click('Focus in Chrome');
  expect(requested.at(-1)).toEqual({ type: 'browserFocusTab', groupId, targetId: 'tab-a' });
});

it('a card the agent stopped waiting for stays open and says so', async () => {
  await render([question({ ...chrome, waiting: false })]);
  expect(container.textContent).toContain('The agent stopped waiting. If you take the tab, it hears when you hand it back.');
  expect(buttons()).toEqual(['Not now', 'Take over']);
});

it('an ended card is read-only: handed back, or Not now; a call without its question (a refusal) stays a tool call', async () => {
  await render([question(chrome, 'handed-back')]);
  expect(container.textContent).toContain('Handed back');
  expect(buttons()).toEqual([]);
  await render([question(chrome, 'declined')]);
  expect(container.textContent).toContain('Not now');
  expect(buttons()).toEqual([]);
  await render([]);
  expect(container.querySelector('section[aria-label^="Take over"]')).toBeNull();
  expect(container.textContent).toContain('ask_takeover');
});

it('an action that fails says why on the card', async () => {
  const failing: TakeoverCards = { questions: [question(chrome)], request: vi.fn(async () => { throw new Error('This Chrome is offline'); }), watch: () => null };
  await act(async () => root.render(<TakeoverCardsContext.Provider value={failing}><TranscriptItemView item={block} active /></TakeoverCardsContext.Provider>));
  await click('Take over');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('This Chrome is offline');
  expect(buttons()).toEqual(['Not now', 'Take over']);
});
