// @vitest-environment happy-dom
import { APPROVAL_DECISION, APPROVE, planQuestions, type TranscriptItem } from '@gitspace/blocks';
import { automationMessage, type AutomationMessageEvent } from '@gitspace/protocol/automations-contract';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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
  const comment = (author: string, path: string, line: number, text: string, id: number): AutomationMessageEvent => ({ kind: 'comment', event: 'pull_request_review_comment.created', author, path, line, state: null, text, url: `https://github.com/acme/widgets/pull/1434#discussion_r${id}` });
  const events: AutomationMessageEvent[] = [
    comment('dana', 'src/cart/total.ts', 12, 'Round after summing, not per line.', 1),
    comment('dana', 'src/cart/total.ts', 40, 'This branch is never reached.', 2),
    comment('sam', 'src/cart/tax.ts', 7, 'Tax belongs to the shipping address.', 3),
    { kind: 'review', event: 'pull_request_review.submitted', author: 'sam', path: null, line: null, state: 'changes_requested', text: 'Close, two fixes left.', url: 'https://github.com/acme/widgets/pull/1434#pullrequestreview-9' },
  ];
  const run = automationMessage({ run: 'run-7', name: 'Review feedback', source: 'github', subject: 'PR #1434', instruction: 'Read the review and address it.', events });

  it('shows an automation run\'s message as the run\'s card, the turn it started or a notice', () => {
    const turnText = text({ id: 'u1', type: 'message', role: 'user', text: run });
    expect(turnText).not.toContain('Automation input');
    expect(turnText).not.toContain('"kind"');
    expect(turnText).toContain('Review feedback · PR #1434 · 3 comments, 1 review');
    expect(turnText).toContain('Read the review and address it.');
    expect(turnText).toContain('Started this turn');
    expect(text({ id: 'n1', type: 'interruption', reason: 'machine', title: 'GitHub', detail: run })).toContain('The agent reads this on its next turn');
  });

  it('lists the run\'s events under a fold: who, where, what they said and the link to GitHub', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(() => root.render(<TranscriptItemView item={{ id: 'u2', type: 'message', role: 'user', text: run }} active={false} />));
    expect(container.textContent).not.toContain('Round after summing');
    const fold = [...container.querySelectorAll('button')].find(button => button.textContent === 'Events · 3 comments, 1 review');
    await act(async () => fold?.click());
    const rows = [...container.querySelectorAll('[aria-label="Events"] > li')];
    expect(rows.map(row => row.textContent)).toEqual([
      '@danasrc/cart/total.ts:12GitHubRound after summing, not per line.',
      '@danasrc/cart/total.ts:40GitHubThis branch is never reached.',
      '@samsrc/cart/tax.ts:7GitHubTax belongs to the shipping address.',
      '@samreview · requested changesGitHubClose, two fixes left.',
    ]);
    expect(rows.map(row => row.querySelector('a')?.getAttribute('href'))).toEqual(events.map(event => event.url));
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('shows an automation message stored in the single-event form as the run\'s card, not as the person\'s message', async () => {
    const fields = {
      action: 'created', 'sender.login': 'dana', 'repository.full_name': 'acme/widgets', 'subject.title': 'Cart totals', 'subject.url': 'https://github.com/acme/widgets/pull/14',
      'pull_request.html_url': 'https://github.com/acme/widgets/pull/14', 'pull_request.title': 'Cart totals', 'pull_request.number': '14', 'pull_request.user.login': 'robin',
      'pull_request.base.ref': 'main', 'pull_request.head.ref': 'cart-totals', 'comment.html_url': 'https://github.com/acme/widgets/pull/14#discussion_r5',
      'comment.user.login': 'dana', 'comment.body': 'Round after summing, not per line.', 'comment.path': 'src/cart/total.ts',
    };
    const stored = `Automation "Review feedback to its workspace" · pull_request_review_comment.created · Review comment from @dana on PR #14 · Cart totals\n\nA person reviewed this workspace's pull request or commented on it. Read the feedback and address it.\n\nThe event:\n${JSON.stringify(fields, null, 2)}`;
    const turn = text({ id: 'u3', type: 'message', role: 'user', text: stored });
    expect(turn).toContain('Review feedback to its workspace · PR #14 · 1 comment');
    expect(turn).toContain('Started this turn');
    expect(turn).not.toContain('The event:');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(() => root.render(<TranscriptItemView item={{ id: 'u3', type: 'message', role: 'user', text: stored }} active={false} />));
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Events · 1 comment')?.click());
    expect([...container.querySelectorAll('[aria-label="Events"] > li')].map(row => row.textContent)).toEqual(['@danasrc/cart/total.tsGitHubRound after summing, not per line.']);
    await act(() => root.unmount());
    vi.unstubAllGlobals();
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
