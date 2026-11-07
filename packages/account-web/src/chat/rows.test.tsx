// @vitest-environment happy-dom
import { APPROVAL_DECISION, APPROVE, planQuestions, type TranscriptItem } from '@gitspace/blocks';
import { automationMessage } from '@gitspace/protocol/automations-contract';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TranscriptItemView } from './TranscriptItemView.js';

function html(item: TranscriptItem): string {
  return renderToStaticMarkup(<TranscriptItemView item={item} active={false} />);
}

function text(item: TranscriptItem): string {
  return new DOMParser().parseFromString(html(item), 'text/html').body.textContent ?? '';
}

describe('the todo row', () => {
  it('says whether the list follows the plan or is the agent\'s own list', () => {
    const plan = text({ id: 't1', type: 'todo', source: 'plan', items: [{ text: 'Add the table', state: 'done', planStep: 'schema' }, { text: 'Wire the form', state: 'active', planStep: 'form' }] });
    expect(plan).toContain('from the plan');
    expect(plan).not.toContain('own list');
    expect(plan).toContain('1/2');
    expect(plan).toContain('Wire the form');
    const own = text({ id: 't2', type: 'todo', source: 'own', items: [{ text: 'Reproduce the crash', state: 'pending' }] });
    expect(own).toContain('own list');
    expect(own).not.toContain('from the plan');
  });

  it('shows why a todo call left the list unchanged', () => {
    expect(text({ id: 't3', type: 'todo', source: 'plan', items: [], error: 'There is no approved plan with steps to load' })).toContain('The list did not change: There is no approved plan with steps to load');
  });
});

describe('the plan approval card', () => {
  const steps = [{ id: 'schema', title: 'Add the table', detail: 'One column per field.', where: ['db/schema.sql'] }, { id: 'form', title: 'Wire the form' }];
  it('lists the proposed steps while it waits and once answered', () => {
    const pending = text({ id: 'p1', type: 'ask', kind: 'plan', toolCallId: 'p1', status: 'pending', steps, questions: planQuestions('Two steps to ship the form.') });
    expect(pending).toContain('Proposed steps · 2');
    expect(pending).toContain('Add the table');
    expect(pending).toContain('db/schema.sql');
    const answered = text({ id: 'p2', type: 'ask', kind: 'plan', toolCallId: 'p2', status: 'answered', steps, questions: planQuestions('Two steps to ship the form.').map((question) => question.id === APPROVAL_DECISION ? { ...question, answer: APPROVE } : question) });
    expect(answered).toContain('Proposed steps · 2');
    expect(answered).toContain('Wire the form');
  });
});

describe('turns that are not the person\'s or the agent\'s', () => {
  const run = automationMessage({ name: 'Review feedback', event: 'pull_request_review.submitted', summary: 'Review on PR #12', instruction: 'Read the review and address it.', fields: { pull_request: 12, reviewer: 'sam' } });

  it('shows an automation run\'s message as the run\'s card, the turn it started or a notice', () => {
    const turnText = text({ id: 'u1', type: 'message', role: 'user', text: run });
    expect(turnText).not.toContain('The event:');
    expect(turnText).toContain('Automation · Review feedback');
    expect(turnText).toContain('pull_request_review.submitted · Review on PR #12');
    expect(turnText).toContain('Read the review and address it.');
    expect(turnText).toContain('Started this turn');
    expect(text({ id: 'n1', type: 'interruption', reason: 'machine', title: 'GitHub', detail: run })).toContain('The agent reads this on its next turn');
  });

  it('shows GitSpace\'s own notices as quiet rows and delivered events as cards of their kind', () => {
    const stack = html({ id: 'n2', type: 'interruption', reason: 'machine', title: 'Stack', detail: '3 commits behind the parent branch.' });
    expect(stack).toContain('data-notice="Stack"');
    expect(text({ id: 'n2', type: 'interruption', reason: 'machine', title: 'Stack', detail: '3 commits behind the parent branch.' })).toBe('Stack · 3 commits behind the parent branch.');
    const reply = text({ id: 'e1', type: 'interruption', reason: 'event', kind: 'agent-message', title: 'Reviewer (child-1)', detail: 'No findings.' });
    expect(reply).toContain('Message from Reviewer (child-1)');
    expect(reply).toContain('Delivered to the agent');
    expect(html({ id: 'e2', type: 'interruption', reason: 'event', kind: 'machine-ready', title: 'Machine', detail: 'The build machine is ready.' })).toContain('data-notice="Machine"');
  });
});
