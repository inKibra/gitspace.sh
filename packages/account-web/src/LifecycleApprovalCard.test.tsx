// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ToolCallBlock } from '@gitspace/blocks';
import { SessionControlSchema } from '@gitspace/protocol-runtime/session-controls';
import { LIFECYCLE_APPROVAL_CHOICES, type RuntimeLifecycleApprovalAnswer, type RuntimeLifecycleApprovalQuestion, type RuntimeQuestion } from '@gitspace/protocol-runtime';
import { TakeoverCardsContext, type TakeoverCards } from './TakeoverCard.js';
import { TranscriptItemView } from './chat/TranscriptItemView.js';

const control = SessionControlSchema.parse({ sessionId: 'main', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, historyAnchorId: null, history: [], goal: null, pendingAsk: null });
const block: ToolCallBlock = { id: 'main:tool:call-1', type: 'tool-call', toolCallId: 'call-1', tool: 'environment', status: 'running', args: { method: 'runPhase', phase: 'machine/prepare', runId: 'prepare-1' } };
const card: RuntimeLifecycleApprovalQuestion = { phase: 'machine/prepare', callId: 'call-1', scripts: [
  { hash: `sha256:${'a'.repeat(64)}`, kind: 'script', label: '10-install.sh', phase: 'machine/prepare', fileName: '10-install.sh', content: '#!/bin/sh\nbun install --frozen-lockfile\necho done\n', previous: { content: '#!/bin/sh\nbun install\necho done\n', approvedBy: 'device-1' } },
  { hash: `sha256:${'b'.repeat(64)}`, kind: 'script', label: '20-tools.sh', phase: 'machine/prepare', fileName: '20-tools.sh', content: 'brew install jq\n', previous: null },
] };
const question = (answer: RuntimeQuestion['answer'] = null): RuntimeQuestion => ({ id: 'question:task-1', conversationId: 'main', kind: 'lifecycle-approval', prompt: 'The agent wants to run machine/prepare. 10-install.sh, 20-tools.sh need your approval first.', choices: Object.values(LIFECYCLE_APPROVAL_CHOICES), answer, lifecycle: card });
let container: HTMLDivElement;
let root: Root;
let answered: Array<[string, RuntimeLifecycleApprovalAnswer]>;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); answered = []; });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(questions: RuntimeQuestion[], refusal?: string) {
  const cards: TakeoverCards = {
    questions, async request() { return { control }; }, watch: () => null,
    async answer(questionId, answer) { if (refusal) throw new Error(refusal); answered.push([questionId, answer]); },
  };
  await act(async () => root.render(<TakeoverCardsContext.Provider value={cards}><TranscriptItemView item={block} active /></TakeoverCardsContext.Provider>));
}
/** The card's buttons; the tool call below it has its own. */
function buttons(): string[] { return [...container.querySelectorAll('section button')].map(button => button.textContent?.trim() ?? ''); }
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button ${text}`);
  await act(async () => { button.click(); });
}

it('shows each script on the environment call, a changed one as its diff against the last approved version, with the three choices', async () => {
  await render([question()]);
  expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Lifecycle approval · machine/prepare');
  expect(container.textContent).toContain('10-install.sh· changed since approved by device-1');
  const diff = [...(container.querySelector('pre[aria-label="Changes to 10-install.sh"]')?.querySelectorAll('[data-diff]') ?? [])].map(line => `${line.getAttribute('data-diff')}:${line.textContent}`);
  expect(diff).toEqual(['same:  #!/bin/sh', 'removed:- bun install', 'added:+ bun install --frozen-lockfile', 'same:  echo done']);
  expect(container.textContent).toContain('20-tools.sh· no approved version');
  expect(container.querySelector('pre[aria-label="Content of 20-tools.sh"]')?.textContent).toBe('brew install jq\n');
  expect(buttons()).toEqual(['Not now', 'Only this workspace', 'Approve for the project']);
  // The call itself still shows below its card.
  expect(container.textContent).toContain('environment');
});

it.each<[string, RuntimeLifecycleApprovalAnswer]>([['Approve for the project', 'project'], ['Only this workspace', 'workspace'], ['Not now', 'not-now']])('%s answers the card with %s', async (label, choice) => {
  await render([question()]);
  await click(label);
  expect(answered).toEqual([['question:task-1', choice]]);
});

it('a refused approval says why on the card and keeps its choices', async () => {
  await render([question()], 'Execution approval requires lifecycle control authorization');
  await click('Approve for the project');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Execution approval requires lifecycle control authorization');
  expect(buttons()).toEqual(['Not now', 'Only this workspace', 'Approve for the project']);
});

it('an answered card is read-only and says what was chosen; a call without a card stays a tool call', async () => {
  await render([question('workspace')]);
  expect(container.querySelector('section')?.getAttribute('data-answer')).toBe('workspace');
  expect(container.textContent).toContain('Approved for this workspace');
  expect(buttons()).toEqual([]);
  await render([question('not-now')]);
  expect(container.querySelector('section')?.getAttribute('data-answer')).toBe('not-now');
  expect(buttons()).toEqual([]);
  await render([]);
  expect(container.querySelector('section[aria-label^="Lifecycle approval"]')).toBeNull();
  expect(container.textContent).toContain('environment');
});
