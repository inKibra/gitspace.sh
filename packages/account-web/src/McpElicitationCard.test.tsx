// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ToolCallBlock, TranscriptItem } from '@gitspace/blocks';
import { SessionControlSchema, type RuntimeSessionCommand } from '@gitspace/protocol-runtime/session-controls';
import type { RuntimeMcpElicitationQuestion, RuntimeMcpElicitationRequest, RuntimeQuestion } from '@gitspace/protocol-runtime';
import { QuestionCardsContext, type QuestionCards } from './QuestionCards.js';
import { TranscriptItemView } from './chat/TranscriptItemView.js';
import { toolRuns } from './chat/ToolGroup.js';

const control = SessionControlSchema.parse({ sessionId: 'main', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, historyAnchorId: null, history: [], goal: null, pendingAsk: null });
const block: ToolCallBlock = { id: 'main:tool:call-1', type: 'tool-call', toolCallId: 'call-1', tool: 'codemode', status: 'done', args: { code: 'await linear.create_issue({ title: "Checkout times out" })' } };
const form: RuntimeMcpElicitationRequest = { mode: 'form', message: 'Who should own the new issue?', requestedSchema: { type: 'object', required: ['name', 'seats'], properties: {
  name: { type: 'string', title: 'Name', description: 'Your full name' },
  email: { type: 'string', format: 'email' },
  team: { type: 'string', title: 'Team', enum: ['eng', 'ops'], enumNames: ['Engineering', 'Operations'] },
  region: { type: 'string', title: 'Region', oneOf: [{ const: 'us', title: 'United States' }, { const: 'eu', title: 'Europe' }, { const: 'ap', title: 'Asia Pacific' }, { const: 'sa', title: 'South America' }, { const: 'af', title: 'Africa' }] },
  seats: { type: 'integer', title: 'Seats', minimum: 1, maximum: 10, default: 3 },
  notify: { type: 'boolean', title: 'Notify the team', default: false },
  labels: { type: 'array', title: 'Labels', items: { type: 'string', enum: ['bug', 'feature', 'docs'] } },
  when: { type: 'string', title: 'Due', format: 'date-time' },
} } };
const elicitation = (request: RuntimeMcpElicitationRequest, fields: Partial<RuntimeMcpElicitationQuestion> = {}): RuntimeMcpElicitationQuestion => ({
  connectionId: 'conn-1', connection: 'Linear', server: 'mcp.linear.app', workspace: 'checkout-fix', tool: 'create_issue', request, host: request.mode === 'url' ? new URL(request.url).host : null,
  secretLooking: false, scope: 'request', taskId: null, callId: 'call-1', askedAt: '2026-11-20T10:00:00.000Z', expiresAt: '2026-11-21T10:00:00.000Z', ...fields,
});
const question = (card: RuntimeMcpElicitationQuestion, answer: RuntimeQuestion['answer'] = null, id = 'question:mcp-1'): RuntimeQuestion => ({ id, conversationId: 'main', kind: 'mcp-elicitation', prompt: `${card.connection} asks: ${card.request.message}`, choices: card.request.mode === 'url' ? ['Done', 'Decline', 'Cancel'] : ['Decline', 'Cancel'], answer, mcpElicitation: card });
const link: RuntimeMcpElicitationRequest = { mode: 'url', message: 'Connect your Linear workspace to finish.', url: 'https://linear.app/oauth/authorize?client_id=gitspace&state=abc' };
let container: HTMLDivElement;
let root: Root;
let requested: RuntimeSessionCommand[];
let failure: Error | null;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); requested = []; failure = null; });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(questions: RuntimeQuestion[]) {
  const cards: QuestionCards = { questions, async request(command) { if (failure) throw failure; requested.push(command); return { control }; }, async answer() { throw new Error('An MCP request card has no approval answer'); }, watch: () => null };
  await act(async () => root.render(<QuestionCardsContext.Provider value={cards}><TranscriptItemView item={block} active /></QuestionCardsContext.Provider>));
}
function buttons(): string[] { return [...container.querySelectorAll('button')].filter(button => button.closest('section[data-mcp-elicitation]')).map(button => button.textContent?.trim() ?? ''); }
async function click(label: string) {
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === label)!.click(); });
}
function field(name: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`[data-mcp-field="${name}"] input`)!;
}
async function type(name: string, value: string) {
  const input = field(name);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function check(name: string, value?: string) {
  const input = container.querySelector<HTMLInputElement>(`[data-mcp-field="${name}"] input${value ? `[value="${value}"]` : ''}`)!;
  await act(async () => { input.click(); });
}
async function submit() {
  await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

it('a form shows the server\'s fields with their labels, help, required marks and defaults, attributed to the connection and server', async () => {
  await render([question(elicitation(form))]);
  const card = container.querySelector('section[data-mcp-elicitation="open"]')!;
  expect(card.getAttribute('aria-label')).toBe('Linear asks');
  expect(card.querySelector('[data-mcp-elicitation-source]')?.textContent).toBe('MCP server mcp.linear.app · tool create_issue · checkout-fix');
  expect(card.textContent).toContain('Waiting for you');
  expect(card.textContent).toContain('Who should own the new issue?');
  expect(container.querySelector('[data-mcp-field="name"]')?.textContent).toBe('Name *Your full name');
  expect(field('name').type).toBe('text');
  expect(field('email').type).toBe('email');
  expect(container.querySelector('[data-mcp-field="email"] label')?.textContent).toBe('email');
  expect([...container.querySelectorAll<HTMLInputElement>('[data-mcp-field="team"] input')].map(input => [input.type, input.value, input.parentElement?.textContent])).toEqual([['radio', 'eng', 'Engineering'], ['radio', 'ops', 'Operations']]);
  expect([...container.querySelectorAll('[data-mcp-field="region"] option')].map(option => option.textContent)).toEqual(['Not set', 'United States', 'Europe', 'Asia Pacific', 'South America', 'Africa']);
  expect([field('seats').type, field('seats').value]).toEqual(['number', '3']);
  expect([field('notify').type, field('notify').checked]).toEqual(['checkbox', false]);
  expect([...container.querySelectorAll<HTMLInputElement>('[data-mcp-field="labels"] input')].map(input => `${input.type}:${input.value}`)).toEqual(['checkbox:bug', 'checkbox:feature', 'checkbox:docs']);
  expect(field('when').type).toBe('datetime-local');
  expect(buttons()).toEqual(['Decline', 'Cancel', 'Submit']);
  expect(container.querySelector('[data-mcp-elicitation-secret]')).toBeNull();
});

it('Submit answers with each field the person set, typed as the form says, and leaves out the ones left empty', async () => {
  await render([question(elicitation(form))]);
  await type('name', 'Ada Lovelace');
  await check('team', 'ops');
  const region = container.querySelector<HTMLSelectElement>('[data-mcp-field="region"] select')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(region, 'eu'); region.dispatchEvent(new Event('change', { bubbles: true })); });
  await type('seats', '5');
  await check('notify');
  await check('labels', 'docs');
  await check('labels', 'bug');
  await type('when', '2026-11-20T09:30');
  await submit();
  expect(container.querySelector('[data-mcp-elicitation-issues]')).toBeNull();
  expect(requested).toEqual([{ type: 'answerAsk', id: 'question:mcp-1', answers: [{ id: 'question:mcp-1', selectedOptions: [], customInput: JSON.stringify({ name: 'Ada Lovelace', team: 'ops', region: 'eu', seats: 5, notify: true, labels: ['bug', 'docs'], when: new Date('2026-11-20T09:30').toISOString() }) }] }]);
});

it('an answer the form does not take shows why and sends nothing', async () => {
  await render([question(elicitation(form))]);
  await type('seats', '11');
  await type('email', 'not-an-address');
  await submit();
  expect([...container.querySelectorAll('[data-mcp-elicitation-issues] li')].map(item => item.textContent)).toEqual(['name is required', 'email is an email address', 'seats is at most 10']);
  expect(requested).toEqual([]);
});

it('Decline and Cancel send that choice without the form', async () => {
  await render([question(elicitation(form))]);
  await click('Decline');
  await click('Cancel');
  expect(requested).toEqual([
    { type: 'answerAsk', id: 'question:mcp-1', answers: [{ id: 'question:mcp-1', selectedOptions: ['Decline'], customInput: null }] },
    { type: 'answerAsk', id: 'question:mcp-1', answers: [{ id: 'question:mcp-1', selectedOptions: ['Cancel'], customInput: null }] },
  ]);
});

it('a failed answer shows the error', async () => {
  await render([question(elicitation(form))]);
  failure = new Error('Only a person in GitSpace answers this request');
  await click('Decline');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Only a person in GitSpace answers this request');
});

it('a form that looks like it asks for a secret warns where the value goes and takes it in password inputs; its answer is never shown', async () => {
  const secret = elicitation({ mode: 'form', message: 'Enter your API key', requestedSchema: { type: 'object', required: ['apiKey'], properties: { apiKey: { type: 'string', title: 'API key' }, scope: { type: 'string', enum: ['read', 'write'] } } } }, { secretLooking: true });
  await render([question(secret)]);
  expect(container.querySelector('[data-mcp-elicitation-secret]')?.textContent).toBe('This looks like it asks for a secret. What you enter goes to Linear’s MCP server (mcp.linear.app), not to GitSpace, and only a person answers it here; the agent never sees it.');
  expect(field('apiKey').type).toBe('password');
  expect(field('scope').type).toBe('radio');
  const answers: RuntimeQuestion['answer'][] = [{ action: 'accept', withheld: true }, { action: 'accept', content: { apiKey: 'typed value hunter2' } }];
  for (const answer of answers) {
    await render([question(secret, answer)]);
    expect(container.querySelector('[data-mcp-elicitation-outcome]')?.textContent).toBe('Answered (values not shown)');
    expect(container.textContent).not.toContain('hunter2');
    expect(container.querySelectorAll('section input, section select')).toHaveLength(0);
    expect(container.querySelector('[data-mcp-elicitation-secret]')).toBeNull();
  }
});

it('a link shows the page\'s host and whose page it is, opens only from its link, and I finished says it is done', async () => {
  await render([question(elicitation(link))]);
  expect(container.querySelector('[data-mcp-elicitation-host]')?.textContent).toBe('linear.app');
  expect(container.textContent).toContain(link.url);
  expect(container.textContent).toContain('This page belongs to Linear, not GitSpace.');
  const open = [...container.querySelectorAll('a')].find(anchor => anchor.textContent === 'Open linear.app');
  expect([open?.getAttribute('href'), open?.getAttribute('target'), open?.getAttribute('rel')]).toEqual([link.url, '_blank', 'noopener noreferrer']);
  expect(buttons()).toEqual(['Decline', 'Cancel', 'I finished']);
  expect(container.querySelector('form')).toBeNull();
  await click('I finished');
  expect(requested).toEqual([{ type: 'answerAsk', id: 'question:mcp-1', answers: [{ id: 'question:mcp-1', selectedOptions: ['Done'], customInput: null }] }]);
});

it('an ended card is read-only and says how it ended', async () => {
  const outcomes: [RuntimeQuestion, string][] = [
    [question(elicitation(form), { action: 'accept', content: { name: 'Ada', seats: 2, labels: ['bug', 'docs'] } }), 'AcceptedName:AdaSeats:2Labels:bug, docs'],
    [question(elicitation(link), { action: 'accept' }), 'Done on linear.app'],
    [question(elicitation(form), { action: 'decline' }), 'Declined'],
    [question(elicitation(link), { action: 'cancel' }), 'Cancelled'],
    [question(elicitation(form), { action: 'cancel', expired: true }), 'Nobody answered in time (cancelled)'],
    [{ ...question(elicitation(form)), closed: { reason: 'stopped', at: '2026-11-20T10:05:00.000Z' } }, 'Closed: the conversation was stopped or reset'],
  ];
  for (const [ended, shown] of outcomes) {
    await render([ended]);
    expect(container.querySelector('[data-mcp-elicitation-outcome]')?.textContent).toBe(shown);
    expect(buttons()).toEqual([]);
    expect(container.querySelectorAll('section input, section a')).toHaveLength(0);
    expect(container.textContent).not.toContain('Waiting for you');
  }
});

it('the call shows first, then a card per request it made in the order the server asked; another call\'s requests stay off it', async () => {
  const first = question(elicitation(form, { askedAt: '2026-11-20T10:00:00.000Z' }), { action: 'accept', content: { name: 'Ada', seats: 2 } }, 'question:first');
  const followUp = question(elicitation(link, { askedAt: '2026-11-20T10:02:00.000Z' }), null, 'question:follow-up');
  const other = question(elicitation({ mode: 'form', message: 'Another call asks', requestedSchema: { type: 'object', properties: {} } }, { callId: 'call-2' }), null, 'question:other');
  await render([followUp, other, first]);
  const sections = [...container.querySelectorAll('section[data-mcp-elicitation]')];
  expect(sections.map(section => section.getAttribute('data-mcp-elicitation'))).toEqual(['answered', 'open']);
  expect(container.textContent).not.toContain('Another call asks');
  expect(container.textContent!.indexOf('codemode')).toBeGreaterThanOrEqual(0);
  expect(container.textContent!.indexOf('codemode')).toBeLessThan(container.textContent!.indexOf('Linear asks'));
  const read = (id: string): TranscriptItem => ({ id: `main:tool:${id}`, type: 'tool-call', toolCallId: id, tool: 'read', status: 'done', args: {} });
  const cards: QuestionCards = { questions: [first], request: async () => ({ control }), answer: async () => undefined, watch: () => null };
  const runs = toolRuns([read('read-1'), block, read('read-2')].map(item => ({ item, turnId: 'turn-1' })), cards);
  expect(runs.map(run => run.tools ? run.entries.map(entry => entry.item.id) : run.entry.item.id)).toEqual([['main:tool:read-1'], 'main:tool:call-1', ['main:tool:read-2']]);
});

it('a call no server paused stays a plain tool call', async () => {
  await render([question(elicitation(form, { callId: 'call-2' }))]);
  expect(container.querySelector('section[data-mcp-elicitation]')).toBeNull();
  expect(container.textContent).toContain('codemode');
});

it('the retried call\'s result shows as an event from the connection\'s MCP server, delivered to the agent', async () => {
  const result: TranscriptItem = { id: 'main:event:result', type: 'interruption', reason: 'event', kind: 'mcp-result', title: 'Linear (MCP server)', detail: 'Linear\'s create_issue finished: created ENG-42' };
  await act(async () => root.render(<TranscriptItemView item={result} active={false} />));
  const card = container.querySelector('[data-event="mcp-result"]')!;
  expect(card.textContent).toContain('Linear (MCP server) finished');
  expect(card.textContent).toContain('Linear\'s create_issue finished: created ENG-42');
  expect(card.textContent).toContain('Delivered to the agent');
});
