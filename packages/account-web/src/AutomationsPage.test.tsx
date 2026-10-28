// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AUTOMATION_DEFAULT_SETTINGS, automationErrors, parseAutomationSchedule, type AutomationLinkView, type AutomationRecordedEvent, type AutomationRunView, type AutomationSettings, type AutomationView } from '@gitspace/protocol/automations-contract';
import { AutomationsPage, type AutomationWorkspace } from './AutomationsPage.js';

const rpc = vi.hoisted(() => ({ approve: vi.fn(), create: vi.fn(), test: vi.fn(), runOnEvent: vi.fn(), link: vi.fn(), updateSettings: vi.fn() }));
const queries = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./rpc-client.js', () => ({ rpcClient: { automations: { list: 'list', runs: 'runs', overview: 'overview', events: 'events', ...rpc } } }));
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

const workspaces: readonly AutomationWorkspace[] = [{ id: 'ws-recovery', name: 'session-recovery', active: true }, { id: 'ws-old', name: 'old-work', active: false }];

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
  for (const procedure of Object.values(rpc)) procedure.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
});

async function renderProject(automations: readonly AutomationView[], { links = [], settings = AUTOMATION_DEFAULT_SETTINGS }: { links?: readonly AutomationLinkView[]; settings?: AutomationSettings } = {}): Promise<void> {
  queries.set('list', { automations, settings, links, github });
  await act(() => root.render(<AutomationsPage projects={[{ id: 'project', name: 'GitSpace', workspaces }]} projectId="project" onSelectProject={() => undefined} onOpenWorkspace={() => undefined} />));
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
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent === option);
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

it('tests against the chosen recorded event and runs it only for the saved automation unchanged', async () => {
  const events: AutomationRecordedEvent[] = [
    { deliveryId: 'delivery-1143', event: 'pull_request', label: 'PR #1143 · pull_request.opened', receivedAt: new Date('2026-10-27T11:59:00Z') },
    { deliveryId: 'delivery-1144', event: 'pull_request', label: 'PR #1144 · pull_request.opened', receivedAt: new Date('2026-10-27T11:40:00Z') },
  ];
  queries.set('events', events);
  rpc.test.mockResolvedValue({ status: 'ok', value: {
    results: [{ label: 'PR #1144 · pull_request.opened', result: 'Would start workspace review-pr-1144 in Review, linked to PR #1144', runs: true }],
    instruction: 'Review https://github.com/inKibra/inkibra-core/pull/1144.',
    checks: [{ label: 'base branch is main', passed: true }, { label: 'not a draft', passed: null }],
  } });
  const run: AutomationRunView = {
    id: 'run-1144', projectId: 'project', automationId: 'review', automationName: 'Review pull requests', trigger: 'github', event: 'pull_request.opened',
    subject: { kind: 'pullRequest', number: 1144, branch: 'tone', title: 'Faster tone detection', url: 'https://github.com/inKibra/inkibra-core/pull/1144' },
    state: 'running', workspaceId: 'review-pr-1144', outcome: 'Started in Review and linked to PR #1144', checks: [], timeline: [], scheduledFor: at, startedAt: at, finishedAt: null,
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
  expect(field('[aria-label="Test result"]').textContent).toBe('Would start workspace review-pr-1144 in Review, linked to PR #1144');
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
