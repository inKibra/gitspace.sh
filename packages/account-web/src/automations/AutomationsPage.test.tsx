// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AUTOMATION_DEFAULT_SETTINGS, automationErrors, parseAutomationSchedule, type AutomationException, type AutomationLinkView, type AutomationRecordedEvent, type AutomationRunView, type AutomationSettings, type AutomationView } from '@gitspace/protocol/automations-contract';
import { AutomationsPage, type AutomationWorkspace } from './AutomationsPage.js';

const rpc = vi.hoisted(() => ({ approve: vi.fn(), create: vi.fn(), update: vi.fn(), test: vi.fn(), runOnEvent: vi.fn(), link: vi.fn(), updateSettings: vi.fn(), setException: vi.fn(), retryRun: vi.fn() }));
const queries = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../rpc-client.js', () => ({ rpcClient: { automations: { list: 'list', runs: 'runs', overview: 'overview', events: 'events', authors: 'authors', exceptions: { list: 'exceptions', set: rpc.setException }, ...rpc } } }));
vi.mock('result-rpc/react', async () => ({
  ...await vi.importActual<object>('result-rpc/react'),
  useResultQuery: (procedure: string) => ({ state: 'success', value: queries.get(procedure), fetch: 'idle', refetch: async () => {} }),
}));

const at = new Date('2026-10-27T09:00:00Z');
const github = { repository: 'inKibra/inkibra-core', bot: '@gitspace-bradleat' };

const proposed: AutomationView = {
  id: 'audit', projectId: 'project', revision: 3, name: 'Nightly dependency audit',
  trigger: { kind: 'schedule', cron: '0 6 * * *' }, conditions: [],
  action: { kind: 'messageProjectAgent', instruction: 'Audit the dependencies.' },
  enabled: false, createdBy: 'projectAgent', isDefault: false,
  proposal: { conversationId: 'conversation', asked: 'Can you audit dependencies every night?', reason: 'Updates land most nights.', tested: [{ label: 'Tue 06:00 UTC', result: 'Would message the project agent', runs: true }], proposedAt: at },
  nextRunAt: null, lastRun: null, createdAt: at, updatedAt: at,
};

const review: AutomationView = {
  id: 'review', projectId: 'project', revision: 2, name: 'Review pull requests',
  trigger: { kind: 'github', events: [{ event: 'pull_request', actions: ['opened', 'ready_for_review'] }] },
  conditions: [{ kind: 'baseBranch', mode: 'oneOf', values: ['main'] }, { kind: 'draft', draft: false }],
  action: { kind: 'startWorkspace', mode: 'review', instruction: 'Review {{pull_request.html_url}}.' },
  enabled: true, createdBy: 'person', isDefault: false, proposal: null,
  nextRunAt: null, lastRun: null, createdAt: at, updatedAt: at,
};

const linked: AutomationView = {
  id: 'feedback', projectId: 'project', revision: 1, name: 'Review feedback',
  trigger: { kind: 'github', events: [{ event: 'pull_request_review_comment', actions: ['created'] }] }, conditions: [],
  action: { kind: 'sendToLinked', wake: false, orProjectAgent: false, instruction: 'Address the review comment.' },
  enabled: true, createdBy: 'person', isDefault: true, proposal: null,
  nextRunAt: null, lastRun: null, createdAt: at, updatedAt: at,
};

const workspaces: readonly AutomationWorkspace[] = [{ id: 'ws-recovery', name: 'session-recovery', active: true, phase: 'code' }, { id: 'ws-old', name: 'old-work', active: false, phase: 'ship' }];

let root: Root;
let container: HTMLDivElement;
let animations: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T12:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animations) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  queries.clear();
  queries.set('overview', { projects: [], runs: [] });
  queries.set('runs', []);
  queries.set('events', []);
  queries.set('authors', { people: [], bots: [] });
  for (const procedure of Object.values(rpc)) procedure.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  queries.set('exceptions', []);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
});

async function renderProject(automations: readonly AutomationView[], { links = [], settings = AUTOMATION_DEFAULT_SETTINGS, modelRoles = ['default', 'deep', 'fast', 'taste'], runId = null }: { links?: readonly AutomationLinkView[]; settings?: AutomationSettings; modelRoles?: readonly string[]; runId?: string | null } = {}): Promise<void> {
  queries.set('list', { automations, settings, links, modelRoles, github });
  await act(() => root.render(<AutomationsPage projects={[{ id: 'project', name: 'GitSpace', workspaces }]} projectId="project" runId={runId} onSelectProject={() => undefined} onCloseRun={() => undefined} onOpenWorkspace={() => undefined} />));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(element => element.textContent?.trim() === label);
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

function field<T extends HTMLElement = HTMLInputElement>(selector: string): T {
  const found = document.body.querySelector<T>(selector);
  if (!found) throw new Error(`No field ${selector}`);
  return found;
}

function alerts(): (string | null)[] {
  return [...document.body.querySelectorAll('[role="alert"]')].map(alert => alert.textContent);
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function enter(element: HTMLInputElement): Promise<void> {
  await act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
}

async function choose(trigger: string, option: string): Promise<void> {
  const select = document.body.querySelector<HTMLElement>(`[aria-label="${trigger}"]`);
  if (!select) throw new Error(`No select ${trigger}`);
  await act(() => select.click());
  // The newest listbox is last; one still closing may offer the same option.
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].findLast(element => element.textContent === option);
  if (!item) throw new Error(`No option ${option}`);
  await act(() => item.click());
}

async function menu(trigger: HTMLElement, item: string): Promise<void> {
  await act(() => trigger.click());
  const found = document.body.querySelector<HTMLElement>(`[role="menuitem"][aria-label="${item}"]`);
  if (!found) throw new Error(`No menu item ${item}`);
  await act(() => found.click());
}

async function toggleAction(group: string, action: string): Promise<void> {
  const found = [...field(`[role="group"][aria-label="${group}"]`).querySelectorAll('button')].find(element => element.textContent === action);
  if (!found) throw new Error(`No action ${action} in ${group}`);
  await act(() => found.click());
}

it('switches a proposal on at the revision the card shows', async () => {
  rpc.approve.mockResolvedValue({ status: 'ok', value: { ...proposed, revision: 4, enabled: true, proposal: null } });
  await renderProject([proposed]);
  expect(container.textContent).toContain('Can you audit dependencies every night?');
  await act(() => button('Switch on').click());
  expect(rpc.approve).toHaveBeenCalledExactlyOnceWith({ projectId: 'project', automationId: 'audit', revision: 3 });
});

it('refuses a cron expression the parser rejects, with its message, and reads a valid one back', async () => {
  rpc.create.mockResolvedValue({ status: 'ok', value: proposed });
  await renderProject([]);
  await act(() => button('New automation').click());
  await choose('Trigger', 'Schedule');
  expect(field('[aria-label="Schedule readback"]').textContent).toContain('Every day at 06:00 UTC');
  await type(field('input[aria-label="Name"]'), 'Weekday audit');
  await type(field<HTMLTextAreaElement>('textarea[aria-label="Instruction"]'), 'Audit the dependencies.');
  await choose('Repeats', 'Custom cron expression');
  await type(field('input[aria-label="Cron expression (UTC)"]'), '0 25 * * *');
  const refusal = parseAutomationSchedule('0 25 * * *');
  if (!('error' in refusal)) throw new Error('The parser accepted an hour of 25');
  expect(alerts()).toContain(refusal.error);
  expect(document.body.querySelector('[aria-label="Schedule readback"]')).toBeNull();
  await act(() => button('Create automation').click());
  expect(rpc.create).not.toHaveBeenCalled();

  await type(field('input[aria-label="Cron expression (UTC)"]'), '30 6 * * 1-5');
  expect(field('[aria-label="Schedule readback"]').textContent).toContain('Weekdays at 06:30 UTC');
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
  await act(async () => button('Create automation').click());
  expect(rpc.create).toHaveBeenCalledExactlyOnceWith({ projectId: 'project', draft: {
    name: 'Weekday audit', trigger: { kind: 'schedule', cron: '30 6 * * 1-5' }, conditions: [], action: { kind: 'messageProjectAgent', instruction: 'Audit the dependencies.' }, enabled: true,
  } });
});

it('inserts a field at the cursor in the instruction', async () => {
  await renderProject([]);
  await act(() => button('New automation').click());
  const instruction = field<HTMLTextAreaElement>('textarea[aria-label="Instruction"]');
  await type(instruction, 'Audit  today');
  await act(() => {
    instruction.focus();
    instruction.setSelectionRange(6, 6);
  });
  await act(() => button('Insert a field').click());
  const item = document.body.querySelector<HTMLElement>('[role="menuitem"][aria-label="Automation name · {{automation.name}}"]');
  if (!item) throw new Error('No Automation name field');
  await act(() => item.click());
  expect(instruction.value).toBe('Audit {{automation.name}} today');
});

it('saves the chosen events, actions and filters, without a filter the events no longer offer or one left empty', async () => {
  rpc.create.mockResolvedValue({ status: 'ok', value: review });
  await renderProject([]);
  await act(() => button('New automation').click());
  await type(field('input[aria-label="Name"]'), 'Review pull requests');
  await type(field<HTMLTextAreaElement>('textarea[aria-label="Instruction"]'), 'Review {{pull_request.html_url}}.');
  await toggleAction('Pull request actions', 'ready_for_review');
  await toggleAction('Pull request actions', 'synchronize');

  await menu(button('Add a filter'), 'Base branch');
  await act(async () => button('Create automation').click());
  expect(rpc.create).not.toHaveBeenCalled();
  expect(alerts()).toContain('Add at least one value, or remove this filter.');
  const base = field('input[aria-label="Add to Base branch"]');
  await type(base, 'main');
  await enter(base);
  await menu(button('Add a filter'), 'Labels');
  const labels = field('input[aria-label="Add to Labels"]');
  await type(labels, 'wontfix');
  await enter(labels);
  await choose('Labels rule', 'has none of');

  await act(() => button('Add an event').click());
  await choose('Event 2', 'Review comment');
  expect(field('[aria-label="Conditions readback"]').textContent).toBe('Runs for events into main.');
  await act(async () => button('Create automation').click());
  expect(rpc.create).toHaveBeenCalledExactlyOnceWith({ projectId: 'project', draft: {
    name: 'Review pull requests',
    trigger: { kind: 'github', events: [{ event: 'pull_request', actions: ['opened', 'synchronize'] }, { event: 'pull_request_review_comment', actions: ['created'] }] },
    conditions: [{ kind: 'baseBranch', mode: 'oneOf', values: ['main'] }],
    action: { kind: 'startWorkspace', mode: 'review', instruction: 'Review {{pull_request.html_url}}.' },
    enabled: true,
  } });
});

it('edits people and bots in sections of their own, suggesting the bots that wrote recent events', async () => {
  rpc.create.mockResolvedValue({ status: 'ok', value: review });
  queries.set('authors', {
    people: [{ login: 'dana', count: 4, lastSeenAt: new Date('2026-10-27T11:00:00Z') }],
    bots: [{ login: 'coderabbitai[bot]', count: 3, lastSeenAt: new Date('2026-10-27T10:00:00Z') }, { login: 'github-actions[bot]', count: 9, lastSeenAt: new Date('2026-10-26T12:00:00Z') }],
  });
  await renderProject([]);
  await act(() => button('New automation').click());
  await type(field('input[aria-label="Name"]'), 'Review pull requests');
  await type(field<HTMLTextAreaElement>('textarea[aria-label="Instruction"]'), 'Review {{pull_request.html_url}}.');
  expect([...document.body.querySelectorAll('[aria-label="Only if"] section')].map(section => section.getAttribute('aria-label'))).toEqual(['People', 'Bots']);

  await choose('Bots rule', 'All except these');
  const suggested = [...field('section[aria-label="Bots"]').querySelectorAll('datalist option')].map(option => [option.getAttribute('value'), option.getAttribute('label')]);
  expect(suggested).toEqual([['coderabbitai[bot]', '3 recent · 2h ago'], ['github-actions[bot]', '9 recent · 1d ago']]);
  const bots = field('input[aria-label="Add to Bots"]');
  await type(bots, 'github-actions[bot]');
  await enter(bots);
  await choose('People rule', 'None');
  expect(field('[aria-label="Conditions readback"]').textContent).toBe('Runs for pull requests from bots except github-actions[bot], from no people.');
  await act(async () => button('Create automation').click());
  expect(rpc.create).toHaveBeenCalledExactlyOnceWith({ projectId: 'project', draft: expect.objectContaining({
    conditions: [{ kind: 'bots', mode: 'noneOf', values: ['github-actions[bot]'] }, { kind: 'people', mode: 'none', values: [] }],
  }) });
});

it('starts a workspace in the chosen mode and model role, offering the roles of the project\'s inference profile', async () => {
  rpc.create.mockResolvedValue({ status: 'ok', value: review });
  await renderProject([], { modelRoles: ['default', 'deep', 'fast', 'taste', 'reviewer'] });
  await act(() => button('New automation').click());
  await type(field('input[aria-label="Name"]'), 'Review pull requests');
  await type(field<HTMLTextAreaElement>('textarea[aria-label="Instruction"]'), 'Review {{pull_request.html_url}}.');
  await choose('Mode', 'Code');
  await act(() => field('[aria-label="Model role"]').click());
  const listboxes = [...document.body.querySelectorAll('[role="listbox"]')];
  expect([...listboxes.at(-1)?.querySelectorAll('[role="option"]') ?? []].map(option => option.textContent)).toEqual(['Default', 'Deep', 'Fast', 'Taste', 'reviewer']);
  await act(() => field('[aria-label="Model role"]').click());
  await choose('Model role', 'reviewer');
  await act(async () => button('Create automation').click());
  const action = { kind: 'startWorkspace', mode: 'code', role: 'reviewer', instruction: 'Review {{pull_request.html_url}}.' };
  expect(rpc.create).toHaveBeenCalledExactlyOnceWith({ projectId: 'project', draft: expect.objectContaining({ action }) });
});

it('tests against the chosen recorded event and runs it only for the saved automation unchanged', async () => {
  const events: AutomationRecordedEvent[] = [
    { deliveryId: 'delivery-1143', event: 'pull_request', label: 'PR #1143 · pull_request.opened', receivedAt: new Date('2026-10-27T11:59:00Z') },
    { deliveryId: 'delivery-1144', event: 'pull_request', label: 'PR #1144 · pull_request.opened', receivedAt: new Date('2026-10-27T11:40:00Z') },
  ];
  queries.set('events', events);
  rpc.test.mockResolvedValue({ status: 'ok', value: {
    results: [{ label: 'PR #1144 · pull_request.opened', result: 'Would start workspace review-pr-1144 in Review with model role Default, linked to PR #1144', runs: true }],
    instruction: 'Review https://github.com/inKibra/inkibra-core/pull/1144.',
    checks: [{ label: 'base branch is main', passed: true }, { label: 'not a draft', passed: null }],
  } });
  const run: AutomationRunView = {
    id: 'run-1144', projectId: 'project', automationId: 'review', automationName: 'Review pull requests', trigger: 'github', event: 'pull_request.opened',
    subject: { kind: 'pullRequest', number: 1144, branch: 'tone', title: 'Faster tone detection', url: 'https://github.com/inKibra/inkibra-core/pull/1144' },
    state: 'running', workspaceId: 'review-pr-1144', phase: 'review', skipReason: null, outcome: 'Started in Review and linked to PR #1144', checks: [], timeline: [], scheduledFor: at, startedAt: at, finishedAt: null,
    events: [{ at, event: 'pull_request.opened', label: 'PR #1144 · Faster tone detection opened', url: null, folded: false }],
  };
  rpc.runOnEvent.mockResolvedValue({ status: 'ok', value: run });
  await renderProject([review]);
  await menu(field('[aria-label="Actions for Review pull requests"]'), 'Test with a past event');
  await choose('Recorded event', 'PR #1144 · pull_request.opened · 20m ago');

  const name = field('input[aria-label="Name"]');
  await type(name, 'Review pull requests now');
  await act(async () => button('Test').click());
  expect(button('Run it').disabled).toBe(true);
  expect(container.ownerDocument.body.textContent).toContain('Save it first to run it');

  await type(name, 'Review pull requests');
  await act(async () => button('Test').click());
  const draft = { name: 'Review pull requests', trigger: review.trigger, conditions: review.conditions, action: review.action, enabled: true };
  expect(rpc.test).toHaveBeenLastCalledWith({ projectId: 'project', draft, deliveryId: 'delivery-1144' });
  const checks = [...field('[aria-label="Checks"]').querySelectorAll('li')].map(check => check.textContent);
  expect(checks).toEqual(['base branch is main', 'not a draft (not checked)']);
  expect(field('[aria-label="Test result"]').textContent).toBe('Would start workspace review-pr-1144 in Review with model role Default, linked to PR #1144');
  expect(field('[aria-label="Rendered instruction"]').textContent).toBe('Review https://github.com/inKibra/inkibra-core/pull/1144.');
  expect(rpc.runOnEvent).not.toHaveBeenCalled();

  await act(async () => button('Run it').click());
  expect(rpc.runOnEvent).toHaveBeenCalledExactlyOnceWith({ projectId: 'project', automationId: 'review', deliveryId: 'delivery-1144' });
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('PR #1144 · Faster tone detection');
});

it('links the pull request or issue a number or GitHub link names to the chosen workspace', async () => {
  rpc.link.mockResolvedValueOnce({ status: 'error', error: automationErrors.automationInvalid({ field: 'subject', message: 'PR #1140 is not in inKibra/inkibra-core' }) });
  rpc.link.mockResolvedValue({ status: 'ok', value: {} });
  await renderProject([review]);

  await act(() => button('Link a pull request or issue').click());
  await choose('Workspace', 'session-recovery');
  const subject = field('input[aria-label="Number or link"]');
  await type(subject, 'pull 1140');
  await act(async () => button('Link').click());
  expect(rpc.link).not.toHaveBeenCalled();
  await type(subject, '#1140');
  await act(async () => button('Link').click());
  expect(rpc.link).toHaveBeenLastCalledWith({ projectId: 'project', subject: { kind: 'pullRequest', number: 1140 }, workspaceId: 'ws-recovery' });
  expect(alerts()).toContain('PR #1140 is not in inKibra/inkibra-core');

  await choose('Workspace', 'old-work (closed)');
  await type(subject, 'https://github.com/inKibra/inkibra-core/issues/386');
  await act(async () => button('Link').click());
  expect(rpc.link).toHaveBeenLastCalledWith({ projectId: 'project', subject: { kind: 'issue', number: 386 }, workspaceId: 'ws-old' });
});

it('saves the trust list with a login added without its @, and without one removed', async () => {
  const settings = { ...AUTOMATION_DEFAULT_SETTINGS, trusted: ['mira-contract'] };
  rpc.updateSettings.mockResolvedValue({ status: 'ok', value: settings });
  await renderProject([review], { settings });
  await type(field('input[aria-label="GitHub login"]'), ' @renovate[bot] ');
  await act(async () => button('Trust').click());
  expect(rpc.updateSettings).toHaveBeenLastCalledWith({ projectId: 'project', settings: { ...settings, trusted: ['mira-contract', 'renovate[bot]'] } });
  await act(async () => field('[aria-label="Stop trusting @mira-contract"]').click());
  expect(rpc.updateSettings).toHaveBeenLastCalledWith({ projectId: 'project', settings: { ...settings, trusted: [] } });
});

function phases(): [string | null, string | null, boolean][] {
  return [...field('[role="group"][aria-label="Phases"]').querySelectorAll('button')].map(element => [element.textContent, element.getAttribute('aria-pressed'), element.disabled]);
}

it('shows the phases of each automation that reaches a workspace, and saves the phases chosen in the editor', async () => {
  rpc.update.mockResolvedValue({ status: 'ok', value: linked });
  const checks: AutomationView = { ...linked, id: 'checks', name: 'Failed checks', phases: ['review'] };
  await renderProject([linked, checks, { ...linked, id: 'mentions', name: 'Mentions', phases: ['code', 'review'] }, review]);
  const chips = [...document.body.querySelectorAll('button[aria-label^="Phases:"]')].map(chip => chip.textContent);
  expect(chips).toEqual(['Every phase', 'Review only', 'Code · Review']);

  await act(() => field('[aria-label="Phases: Review only. Edit"]').click());
  expect(phases()).toEqual([['Plan', 'false', false], ['Code', 'false', false], ['Review', 'true', true], ['Ship', 'false', false], ['Every phase', 'false', false]]);
  await act(() => button('Code').click());
  expect(field('[aria-label="Phases readback"]').textContent).toContain('Code · Review.');
  await act(async () => button('Save changes').click());
  expect(rpc.update).toHaveBeenLastCalledWith({ projectId: 'project', automationId: 'checks', draft: {
    name: 'Failed checks', trigger: checks.trigger, conditions: [], action: checks.action, enabled: true, phases: ['code', 'review'],
  } });

  await act(() => field('[aria-label="Phases: Code · Review. Edit"]').click());
  await act(() => button('Plan').click());
  await act(() => button('Ship').click());
  expect(phases().map(([label, pressed]) => [label, pressed])).toEqual([['Plan', 'true'], ['Code', 'true'], ['Review', 'true'], ['Ship', 'true'], ['Every phase', 'true']]);
  await act(async () => button('Save changes').click());
  expect(rpc.update).toHaveBeenLastCalledWith({ projectId: 'project', automationId: 'mentions', draft: {
    name: 'Mentions', trigger: linked.trigger, conditions: [], action: linked.action, enabled: true,
  } });
});

it('records a workspace\'s exception when a cell leaves the automation\'s phases, and removes it when the cell returns', async () => {
  rpc.setException.mockImplementation(async (input: { automationId: string; workspaceId: string; phase: AutomationException['phase']; enabled: boolean | null }) => {
    const exception = input.enabled === null ? null : { automationId: input.automationId, workspaceId: input.workspaceId, phase: input.phase, enabled: input.enabled, at: '2026-10-27T11:00:00.000Z', by: 'device' };
    queries.set('exceptions', exception ? [exception] : []);
    return { status: 'ok', value: { exception } };
  });
  await renderProject([{ ...linked, phases: ['review'] }]);
  const cell = (phase: string) => field(`[role="switch"][aria-label^="Review feedback in ${phase}"]`);
  expect(['Plan', 'Code', 'Review', 'Ship'].map(phase => cell(phase).getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false']);

  await act(async () => cell('Review').click());
  expect(rpc.setException).toHaveBeenLastCalledWith({ projectId: 'project', automationId: 'feedback', workspaceId: 'ws-recovery', phase: 'review', enabled: false });
  expect(cell('Review').getAttribute('aria-label')).toBe('Review feedback in Review (exception)');
  expect(cell('Review').getAttribute('aria-checked')).toBe('false');
  expect(field('[aria-label="Exceptions for session-recovery"]').textContent).toContain('Review feedback off in Review for this workspace');

  await act(async () => cell('Review').click());
  expect(rpc.setException).toHaveBeenLastCalledWith({ projectId: 'project', automationId: 'feedback', workspaceId: 'ws-recovery', phase: 'review', enabled: null });
  expect(cell('Review').getAttribute('aria-label')).toBe('Review feedback in Review');
  expect(cell('Review').getAttribute('aria-checked')).toBe('true');

  await act(async () => cell('Code').click());
  expect(rpc.setException).toHaveBeenLastCalledWith({ projectId: 'project', automationId: 'feedback', workspaceId: 'ws-recovery', phase: 'code', enabled: true });
  expect(cell('Code').getAttribute('aria-checked')).toBe('true');
  await act(() => button('1 workspace exception').click());
  await act(async () => field('[aria-label="Remove the exception for session-recovery in Code"]').click());
  expect(rpc.setException).toHaveBeenLastCalledWith({ projectId: 'project', automationId: 'feedback', workspaceId: 'ws-recovery', phase: 'code', enabled: null });
  expect(cell('Code').getAttribute('aria-checked')).toBe('false');
  expect(container.textContent).toContain('No workspace exceptions');
});

it('shows the workspace\'s phase a run reached, and a skip its phase decided apart from other skips', async () => {
  const run = { projectId: 'project', automationId: 'feedback', automationName: 'Review feedback', trigger: 'github', event: 'pull_request_review_comment.created', subject: null, timeline: [], scheduledFor: at, startedAt: null, finishedAt: at, events: [] } satisfies Partial<AutomationRunView>;
  const trust = { label: '@bradleat has write access', passed: true };
  queries.set('runs', [
    { ...run, id: 'by-phase', state: 'skipped', workspaceId: 'ws-recovery', phase: 'code', skipReason: 'phase', outcome: 'Skipped: session-recovery is in Code; it runs in Review', checks: [trust, { label: 'session-recovery is in Code; it runs in Review', passed: false }] },
    { ...run, id: 'unlinked', state: 'skipped', workspaceId: null, phase: null, skipReason: null, outcome: 'Skipped: no linked workspace', checks: [trust] },
    { ...run, id: 'sent', state: 'finished', workspaceId: 'ws-recovery', phase: 'review', skipReason: null, outcome: 'Sent to session-recovery as a notice', checks: [trust] },
  ] satisfies AutomationRunView[]);
  await renderProject([linked]);
  const cells = (id: string) => [...field(`tr[data-run="${id}"]`).querySelectorAll('td')].map(cell => cell.textContent);
  expect(cells('by-phase')).toEqual(['skipped · phase', 'Review feedbackSkipped: session-recovery is in Code; it runs in Review', 'Review feedbackpull_request_review_comment.created', 'session-recoveryin Code', '3h ago']);
  expect(cells('unlinked')).toEqual(['skipped', 'Review feedbackSkipped: no linked workspace', 'Review feedbackpull_request_review_comment.created', '—', '3h ago']);
  expect(cells('sent')[3]).toBe('session-recoveryin Review');

  await act(() => field('tr[data-run="by-phase"]').click());
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('session-recovery was in Code');
});

it('opens the run a link names with its batch of events, and runs an ended batch again as one new run', async () => {
  const url = 'https://github.com/acme/widgets/pull/1434';
  const batch: AutomationRunView = {
    id: 'run-batch', projectId: 'project', automationId: 'feedback', automationName: 'Review feedback', trigger: 'github', event: 'pull_request_review_comment.created',
    subject: { kind: 'pullRequest', number: 1434, branch: 'cart', title: 'Cart totals', url }, state: 'finished', workspaceId: 'ws-recovery', phase: 'code', skipReason: null,
    outcome: 'Sent to session-recovery', checks: [], timeline: [], scheduledFor: at, startedAt: at, finishedAt: at,
    events: [
      { at: new Date('2026-10-27T08:58:00Z'), event: 'pull_request_review_comment.created', label: 'Review comment from @dana on PR #1434 · Cart totals', url: `${url}#discussion_r1`, folded: false },
      { at: new Date('2026-10-27T08:58:00Z'), event: 'pull_request_review.submitted', label: 'Review (commented) from @dana on PR #1434 · Cart totals', url: `${url}#pullrequestreview-2`, folded: true },
    ],
  };
  queries.set('runs', [batch]);
  rpc.retryRun.mockResolvedValue({ status: 'ok', value: { ...batch, id: 'run-again', state: 'queued', outcome: 'Waiting for a slot', finishedAt: null } });
  await renderProject([linked], { runId: 'run-batch' });

  const events = [...field('[role="dialog"] [aria-label="Events"]').querySelectorAll('li')].map(event => event.textContent);
  expect(events).toEqual(['08:58:00Review comment from @dana on PR #1434 · Cart totalsGitHub', '08:58:00Review (commented) from @dana on PR #1434 · Cart totalsEmpty review, folded into its commentsGitHub']);
  await act(async () => button('Run again').click());
  expect(rpc.retryRun).toHaveBeenCalledExactlyOnceWith({ projectId: 'project', runId: 'run-batch' });
  expect(field('[role="dialog"]').textContent).toContain('Waiting for a slot');
  expect([...document.body.querySelectorAll('button')].some(element => element.textContent?.trim() === 'Run again')).toBe(false);
});
