// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalRequirement, JournalEntryView } from '@gitspace/protocol';
import type { SessionControlView } from '@gitspace/protocol-runtime/session-controls';
import { GoalSurface, type GoalSurfaceProps } from '../inspector/GoalSurface.js';
import { formatDate } from '../inspector/inspector-shared.js';

const at = '2026-03-02T09:30:00.000Z';
const requirement = (id: string, title: string, fields: Partial<GoalRequirement>): GoalRequirement => ({ id, title, description: '', required: true, status: 'review', workflowNodeId: null, criterionId: null, evidence: [], ...fields });
const plan: NonNullable<SessionControlView['plan']> = { status: 'approved', revision: 1, summary: 'Move the queue to the new store.', steps: [
  { id: 'schema', title: 'Add the queue table', detail: '', where: ['src/store/schema.ts'], requirementIds: [], status: 'completed' },
  { id: 'writer', title: 'Write jobs to the table', detail: 'Writes go through one transaction.', where: [], requirementIds: [], status: 'active' },
  { id: 'reader', title: 'Read jobs back in order', detail: '', where: [], requirementIds: [], status: 'pending' },
] };
const task = (content: string, status: 'pending' | 'in_progress' | 'completed', planStep?: string) => ({ content, status, blocker: null, ...(planStep ? { planStep } : {}) });
function control(tasks: SessionControlView['todos'][number]['tasks'], value: SessionControlView['plan']): SessionControlView {
  return { sessionId: 'session', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, context: null, cost: 0,
    todos: tasks.length ? [{ name: 'Workspace', tasks }] : [], queue: { steering: [], followUp: [] }, historyAnchorId: null, history: [], goal: null, pendingAsk: null, plan: value };
}
const decision = (id: string, sequence: number, title: string, fields: Partial<JournalEntryView>): JournalEntryView => ({
  projectId: 'project', spaceId: 'space', id, sequence, kind: 'decision', phaseRunId: null, phase: 'code', title, body: '', outcome: null, decisions: [], surprises: [], evidence: [],
  snapshot: null, delta: null, reverted: null, createdAt: at, createdBy: 'reviewer', ...fields,
});

let root: Root;
let container: HTMLDivElement;
let props: GoalSurfaceProps;
const unexpected = async (): Promise<never> => { throw new Error('Unexpected action'); };
async function render() { await act(async () => root.render(<GoalSurface {...props} />)); }
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label);
  expect(found, label).toBeDefined();
  return found!;
}
function step(number: number): HTMLElement {
  return container.querySelector<HTMLElement>(`li[aria-label^="Step ${number}:"]`)!;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  if (!('getAnimations' in Element.prototype)) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  props = {
    overview: { projectId: 'project', spaceId: 'space', revision: 1, goal: { projectId: 'project', spaceId: 'space', id: 'goal', revision: 3, title: 'Jobs survive a restart', summary: 'Queued jobs are lost when the worker restarts.', phase: 'code', requirements: [], createdAt: at, updatedAt: at, updatedBy: 'agent' }, workflow: null, rubric: null, journal: { entries: 0, openPhaseRunId: null, recent: [] }, changeGuide: null, review: { total: 0, unresolved: 0 } },
    journalEntries: [], threads: [], viewerId: 'reviewer',
    comments: { viewerId: 'reviewer', onComment: unexpected, onReply: unexpected, onResolve: unexpected },
    onOpenEvidence() {}, onOpenGuideSection() {}, onOpenJournal() {}, onOpenProduct() {},
  };
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('Goal tab', () => {
  it('shows each plan step’s state and the step the todo list is on', async () => {
    props.controls = control([task('Add the queue table', 'completed', 'schema'), task('Write jobs to the table', 'in_progress', 'writer')], plan);
    await render();
    expect(container.textContent).toContain('1 of 3 steps done');
    expect(container.textContent).toContain('The todo list is on step 2.');
    expect(step(1).textContent).toContain('Done');
    expect(step(2).textContent).toContain('In progress · todo list is here');
    expect(step(3).textContent).not.toContain('todo list is here');
    expect(container.textContent).not.toContain('Detour');
  });

  it('labels a todo list of the agent’s own a detour, naming its current task', async () => {
    props.controls = control([task('Write jobs to the table', 'completed', 'writer'), task('Fix the flaky clock test', 'in_progress')], plan);
    await render();
    expect(container.textContent).toContain('Detour: Fix the flaky clock test');
    expect(container.textContent).not.toContain('todo list is here');
  });

  it('shows no plan until the agent proposes one, and a proposal as awaiting approval', async () => {
    await render();
    expect(container.textContent).toContain('No plan yet');
    props.controls = control([], { ...plan, status: 'proposed', revision: 0 });
    await render();
    expect(container.textContent).toContain('Awaiting your approval');
    expect(container.textContent).toContain('Needs you: approve the proposed plan');
  });

  it('comments on a plan step through the step’s handler', async () => {
    const onComment = vi.fn(async () => undefined);
    props.controls = control([], plan);
    props.comments = { ...props.comments, onComment };
    await render();
    await act(async () => step(2).querySelector('button')!.click());
    expect(step(2).textContent).toContain('Writes go through one transaction.');
    await act(async () => button('Comment on this step').click());
    const textarea = step(2).querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Keep the old queue until the backfill ends.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Comment').click());
    expect(onComment).toHaveBeenCalledWith('writer', 'Keep the old queue until the backfill ends.');
  });

  it('accepts a requirement with evidence to check, shows who accepted one and when, and reopens it', async () => {
    const onSetAcceptance = vi.fn(async () => undefined);
    props.onSetAcceptance = onSetAcceptance;
    props.overview = { ...props.overview, goal: { ...props.overview.goal!, requirements: [
      requirement('restart', 'Jobs survive a restart', { status: 'review' }),
      requirement('order', 'Jobs keep their order', { status: 'accepted', acceptedBy: 'reviewer', acceptedAt: at }),
      requirement('metrics', 'Queue depth is measured', { status: 'missing' }),
    ] } };
    await render();
    expect(container.textContent).toContain('1/3 required');
    expect(button('Accept: Queue depth is measured').disabled).toBe(true);
    await act(async () => button('Accept: Jobs survive a restart').click());
    expect(onSetAcceptance).toHaveBeenLastCalledWith('restart', true);
    expect(container.querySelector('li[aria-label="Jobs keep their order"]')!.textContent).toContain(`Accepted by you · ${formatDate(at)}`);
    await act(async () => button('Reopen').click());
    expect(onSetAcceptance).toHaveBeenLastCalledWith('order', false);
  });

  it('shows why acceptance failed', async () => {
    props.onSetAcceptance = async () => { throw new Error('Revision conflict'); };
    props.overview = { ...props.overview, goal: { ...props.overview.goal!, requirements: [requirement('restart', 'Jobs survive a restart', { status: 'review' })] } };
    await render();
    await act(async () => button('Accept: Jobs survive a restart').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Revision conflict');
  });

  it('lists decisions newest first with their citations, marking a superseded one', async () => {
    props.journalEntries = [
      decision('first', 1, 'Keep jobs in memory', { createdBy: 'device-other' }),
      decision('note', 2, 'Ran the suite', { kind: 'narrative' }),
      decision('second', 3, 'Store jobs in SQLite', { supersedes: 'first', citations: [{ conversationId: 'conversation', messageId: 'message', who: 'Sam', at, quote: 'A restart must not lose jobs.' }] }),
    ];
    await render();
    const decisions = [...container.querySelectorAll('section[aria-label="Decisions"] li[aria-label]')].map(node => node.getAttribute('aria-label'));
    expect(decisions).toEqual(['Store jobs in SQLite', 'Keep jobs in memory']);
    const second = container.querySelector('li[aria-label="Store jobs in SQLite"]')!.textContent;
    expect(second).toContain('Decided by you');
    expect(second).toContain('replaces “Keep jobs in memory”');
    expect(second).toContain('Sam');
    expect(second).toContain('“A restart must not lose jobs.”');
    const first = container.querySelector('li[aria-label="Keep jobs in memory"]')!.textContent;
    expect(first).toContain('Superseded by “Store jobs in SQLite”');
    expect(first).toContain('Decided by device-other');
    expect(container.textContent).not.toContain('Ran the suite');
  });

  it('says automations are unavailable when they could not be read, instead of showing an empty grid', async () => {
    const retry = vi.fn();
    props.scope = { kind: 'workspace', id: 'ws', projectId: 'project', projectName: 'acme', name: 'durable-queue', branch: 'feat/durable-queue', phase: 'code', generation: 1, possessedBy: 'cloud', holder: { kind: 'cloud' }, status: { primaryColor: 'dim', agents: { green: 0, blue: 0, orange: 0, red: 0 }, machines: { attached: 0, online: 0, ready: 0 }, sync: { conflicts: 0, problems: 0 } }, closedAt: null, relations: { dependsOn: [], relatedTo: [], stackedOn: null }, stack: { blockedBy: [], blocking: [], findings: [] } };
    props.automations = { automations: [], exceptions: [], read: false, busy: null, error: 'Read automations: offline', set() {}, retry };
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Automations are unavailable. Read automations: offline');
    expect(container.textContent).not.toContain('No automation sends to');
    await act(async () => button('Retry').click());
    expect(retry).toHaveBeenCalled();
  });
});
