// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ToolCallBlock } from '@gitspace/blocks';
import { SessionControlSchema, type RuntimeSessionCommand } from '@gitspace/protocol-runtime/session-controls';
import type { RuntimeQuestion, RuntimeSecureInputQuestion } from '@gitspace/protocol-runtime';
import { QuestionCardsContext, type QuestionCards } from './QuestionCards.js';
import { TranscriptItemView } from './chat/TranscriptItemView.js';

const control = SessionControlSchema.parse({ sessionId: 'main', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, historyAnchorId: null, history: [], goal: null, pendingAsk: null });
const block: ToolCallBlock = { id: 'main:tool:call-1', type: 'tool-call', toolCallId: 'call-1', tool: 'ask_secure_input', status: 'running', args: { source: 'relay', targetId: 'tab-a', origin: 'https://github.com', selector: '#password', kind: 'password', purpose: 'Sign in to GitHub as octocat' } };
const requestId = 'A'.repeat(43);
const secure: RuntimeSecureInputQuestion = {
  requestId, url: `https://acme.gitspace.sh/secure-input/${requestId}`, source: 'chrome', pairingId: '00000000-0000-4000-8000-0000000000b2', browser: 'Studio desktop',
  groupId: '00000000-0000-4000-8000-0000000000a1', targetId: 'tab-a', title: 'Sign in to GitHub · GitHub', workspace: 'checkout-fix', origin: 'https://github.com', selector: '#password',
  kind: 'password', purpose: 'Sign in to GitHub as octocat', expiresAt: '2026-10-25T10:15:00.000Z', callId: 'call-1', askedAt: '2026-10-25T10:00:00.000Z',
};
const question = (card: RuntimeSecureInputQuestion, answer: RuntimeQuestion['answer'] = null): RuntimeQuestion => ({ id: 'question:secure-1', conversationId: 'main', kind: 'secure-input', prompt: card.purpose, choices: ['Decline'], answer, secureInput: card });
let container: HTMLDivElement;
let root: Root;
let requested: RuntimeSessionCommand[];
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); requested = []; });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(questions: RuntimeQuestion[]) {
  const cards: QuestionCards = { questions, async request(command) { requested.push(command); return { control }; }, async answer() { throw new Error('A secure-input card has no approval answer'); }, watch: () => null };
  await act(async () => root.render(<QuestionCardsContext.Provider value={cards}><TranscriptItemView item={block} active /></QuestionCardsContext.Provider>));
}
function buttons(): string[] { return [...container.querySelectorAll('button')].map(button => button.textContent?.trim() ?? ''); }

it('shows what the secret is for, the exact origin, what it asks for, the browser, tab and workspace, and links to its page; it takes no value', async () => {
  await render([question(secure)]);
  expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Secure input · https://github.com');
  expect(container.textContent).toContain('Sign in to GitHub as octocat');
  expect(container.querySelector('[data-secure-input-origin]')?.textContent).toBe('https://github.com');
  expect(container.textContent).toContain('Password · checkout-fix · expires');
  expect(container.textContent).toContain('Studio desktop· Sign in to GitHub · GitHub');
  const enter = [...container.querySelectorAll('a')].find(link => link.textContent === 'Enter securely');
  expect(enter?.getAttribute('href')).toBe(secure.url);
  expect(enter?.getAttribute('target')).toBe('_blank');
  expect(buttons()).toEqual(['Decline']);
  expect(container.querySelectorAll('input, textarea, [contenteditable]')).toHaveLength(0);
});

it('Decline answers the card through the agent\'s question path', async () => {
  await render([question(secure)]);
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Decline')!.click(); });
  expect(requested).toEqual([{ type: 'answerAsk', id: 'question:secure-1', answers: [{ id: 'question:secure-1', selectedOptions: ['Decline'], customInput: null }] }]);
});

it('an ended card is read-only and says how it ended, never with a value', async () => {
  const outcomes: [RuntimeQuestion, string][] = [
    [question(secure, { outcome: 'provided' }), 'Provided and filled'],
    [question(secure, { outcome: 'declined', reason: 'The tab shows another origin' }), 'Declined: The tab shows another origin'],
    [question(secure, { outcome: 'expired' }), 'Expired'],
    [{ ...question(secure), closed: { reason: 'stopped', at: '2026-10-25T10:05:00.000Z' } }, 'Closed: the conversation was stopped or reset'],
  ];
  for (const [ended, shown] of outcomes) {
    await render([ended]);
    expect(container.querySelector('[data-secure-input-outcome]')?.textContent).toBe(shown);
    expect(buttons()).toEqual([]);
    expect(container.querySelector('a')).toBeNull();
  }
});

it('a call without its question (a refusal, or another call\'s question) stays a tool call', async () => {
  await render([question({ ...secure, callId: 'call-2' })]);
  expect(container.querySelector('section[aria-label^="Secure input"]')).toBeNull();
  expect(container.textContent).toContain('ask_secure_input');
});
