// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AUTOMATION_DEFAULT_SETTINGS, parseAutomationSchedule, type AutomationView } from '@gitspace/protocol/automations-contract';
import { AutomationsPage } from './AutomationsPage.js';

const rpc = vi.hoisted(() => ({ approve: vi.fn(), create: vi.fn() }));
const queries = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./rpc-client.js', () => ({ rpcClient: { automations: { list: 'list', runs: 'runs', overview: 'overview', ...rpc } } }));
vi.mock('result-rpc/react', async () => ({
  ...await vi.importActual<object>('result-rpc/react'),
  useResultQuery: (procedure: string) => ({ state: 'success', value: queries.get(procedure), fetch: 'idle', refetch: async () => {} }),
}));

const proposed: AutomationView = {
  id: 'audit', projectId: 'project', revision: 3, name: 'Nightly dependency audit',
  trigger: { kind: 'schedule', cron: '0 6 * * *' },
  action: { kind: 'messageProjectAgent', instruction: 'Audit the dependencies.' },
  enabled: false, createdBy: 'projectAgent',
  proposal: { conversationId: 'conversation', asked: 'Can you audit dependencies every night?', reason: 'Updates land most nights.', tested: [{ label: 'Tue 06:00 UTC', result: 'Would message the project agent', runs: true }], proposedAt: new Date('2026-10-27T09:00:00Z') },
  nextRunAt: null, lastRun: null, createdAt: new Date('2026-10-27T09:00:00Z'), updatedAt: new Date('2026-10-27T09:00:00Z'),
};

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
  rpc.approve.mockReset();
  rpc.create.mockReset();
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

async function renderProject(automations: readonly AutomationView[]): Promise<void> {
  queries.set('list', { automations, settings: AUTOMATION_DEFAULT_SETTINGS });
  await act(() => root.render(<AutomationsPage projects={[{ id: 'project', name: 'GitSpace', workspaces: [] }]} projectId="project" onSelectProject={() => undefined} onOpenWorkspace={() => undefined} />));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(element => element.textContent?.trim() === label);
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

function field<T extends HTMLInputElement | HTMLTextAreaElement>(selector: string): T {
  const found = document.body.querySelector<T>(selector);
  if (!found) throw new Error(`No field ${selector}`);
  return found;
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(trigger: string, option: string): Promise<void> {
  const select = document.body.querySelector<HTMLElement>(`[aria-label="${trigger}"]`);
  if (!select) throw new Error(`No select ${trigger}`);
  await act(() => select.click());
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent === option);
  if (!item) throw new Error(`No option ${option}`);
  await act(() => item.click());
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
  expect(field('[aria-label="Schedule readback"]').textContent).toContain('Every day at 06:00 UTC');
  await type(field('input[aria-label="Name"]'), 'Weekday audit');
  await type(field('textarea[aria-label="Instruction"]'), 'Audit the dependencies.');
  await choose('Repeats', 'Custom cron expression');
  await type(field('input[aria-label="Cron expression (UTC)"]'), '0 25 * * *');
  const refusal = parseAutomationSchedule('0 25 * * *');
  if (!('error' in refusal)) throw new Error('The parser accepted an hour of 25');
  expect([...document.body.querySelectorAll('[role="alert"]')].map(alert => alert.textContent)).toContain(refusal.error);
  expect(document.body.querySelector('[aria-label="Schedule readback"]')).toBeNull();
  await act(() => button('Create automation').click());
  expect(rpc.create).not.toHaveBeenCalled();

  await type(field('input[aria-label="Cron expression (UTC)"]'), '30 6 * * 1-5');
  expect(field('[aria-label="Schedule readback"]').textContent).toContain('Weekdays at 06:30 UTC');
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
  await act(async () => button('Create automation').click());
  expect(rpc.create).toHaveBeenCalledExactlyOnceWith({ projectId: 'project', draft: {
    name: 'Weekday audit', trigger: { kind: 'schedule', cron: '30 6 * * 1-5' }, action: { kind: 'messageProjectAgent', instruction: 'Audit the dependencies.' }, enabled: true,
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
