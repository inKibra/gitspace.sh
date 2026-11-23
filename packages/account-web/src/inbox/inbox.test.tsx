// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceStatusRow } from '@gitspace/protocol/account-directory';
import type { ChatterTopic } from '@gitspace/protocol/chatter-contract';
import { emptyWorkspaceStatus, type WaitingItem } from '@gitspace/protocol-workspace';
import { AccountRows, InboxRows, InboxSourcesContext } from './index.js';
import { UNDO_MS } from './held.js';
import { inboxCount, type InboxSources } from './model.js';

const rpc = vi.hoisted(() => ({
  session: vi.fn(async (_input: unknown) => ({ status: 'ok', value: {} })),
  answer: vi.fn(async (_input: unknown) => ({ status: 'ok', value: { accepted: true, cursor: 1 } })),
}));
vi.mock('../rpc-client.js', () => ({ rpcClient: { runtime: { session: rpc.session, answer: rpc.answer } } }));

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const main = { id: '1', agent: null };
const hash = (letter: string) => `sha256:${letter.repeat(64)}`;

function row(projectId: string, workspaceId: string, items: WaitingItem[]): WorkspaceStatusRow {
  return { projectId, workspaceId, status: { ...emptyWorkspaceStatus, primaryColor: 'orange' }, preview: null, waiting: { items, more: 0 }, goal: null };
}
function sources(rows: WorkspaceStatusRow[], changes: Partial<InboxSources> = {}): InboxSources {
  const stamp = '2026-11-01T00:00:00.000Z';
  return {
    rows,
    directory: {
      projects: [{ id: 'crumb', name: 'Crumb', lifecycle: 'active', repositoryReference: null, baseBranch: 'develop', role: null, source: null, revision: 1, remote: null, archivedAt: null, updatedAt: stamp }],
      workspaces: [],
      placements: [],
      machines: [],
    },
    incidents: [], topics: new Map(), dismissedMachines: new Set(), ...changes,
  };
}
function lifecycle(key: string, scripts: { hash: string; fileName: string }[]): WaitingItem {
  return { kind: 'lifecycle-approval', key, since: minutesAgo(9), title: 'Run workspace/materialize', characters: 25, conversation: main, phase: 'workspace/materialize', more: 0,
    scripts: scripts.map(script => ({ ...script, label: 'Materialize', phase: 'workspace/materialize' })) };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  rpc.session.mockClear();
  rpc.answer.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(value: InboxSources, node: React.ReactNode) {
  act(() => root.render(<InboxSourcesContext.Provider value={value}>{node}</InboxSourcesContext.Provider>));
}
function button(label: string | RegExp): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>('button, [role="radio"], [role="checkbox"], [role="option"]')].find(element => typeof label === 'string' ? element.textContent?.trim() === label : label.test(element.textContent ?? ''));
  if (!found) throw new Error(`No button ${String(label)} in: ${document.body.textContent}`);
  return found;
}
function type(placeholder: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('answers a question in place as one message with the answer and the note, and sends nothing before Undo runs out', async () => {
  const asked: WaitingItem = { kind: 'ask', key: 'q-hold', since: minutesAgo(14), title: 'How long should a pickup slot stay held?', characters: 40, conversation: main, choices: ['5 minutes', '10 minutes'] };
  render(sources([row('crumb', 'slot-holds', [asked])]), <InboxRows projectId="crumb" workspaceId="slot-holds" onOpen={() => {}} />);
  act(() => button(/^10 minutes/u).click());
  type('Add a note (optional)…', 'Apple Pay retries take 4 minutes');
  act(() => button('Send').click());
  expect(container.textContent).toContain('Answered · 10 minutes');
  await act(async () => { vi.advanceTimersByTime(UNDO_MS - 100); });
  expect(rpc.session).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(200); });
  const commands = rpc.session.mock.calls.map(([input]) => input);
  expect(commands).toEqual([
    expect.objectContaining({ projectId: 'crumb', workspaceId: 'slot-holds', conversationId: '1', command: { type: 'stageAnswer', questionId: 'q-hold', answer: [{ id: 'q-hold', selectedOptions: ['10 minutes'], customInput: null }] } }),
    expect.objectContaining({ conversationId: '1', command: expect.objectContaining({ type: 'prompt', text: 'Apple Pay retries take 4 minutes', answers: [{ questionId: 'q-hold', answer: [{ id: 'q-hold', selectedOptions: ['10 minutes'], customInput: null }] }] }) }),
  ]);
});

it('Undo takes the answer back: nothing is sent and the question shows again', async () => {
  const plan: WaitingItem = { kind: 'plan', key: 'q-plan-undo', since: minutesAgo(31), title: 'Loyalty stamps on the order receipt', characters: 35, conversation: main, choices: [] };
  render(sources([row('crumb', 'loyalty', [plan])]), <InboxRows projectId="crumb" workspaceId="loyalty" onOpen={() => {}} />);
  act(() => button(/^Approve/u).click());
  act(() => button('Send').click());
  expect(container.textContent).toContain('Plan approved · moves to Code');
  act(() => button(/^Undo/u).click());
  await act(async () => { vi.advanceTimersByTime(UNDO_MS * 2); });
  expect(rpc.session).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Loyalty stamps on the order receipt');
});

it('sends a held answer at once when the page is hidden', async () => {
  const asked: WaitingItem = { kind: 'ask', key: 'q-hidden', since: minutesAgo(5), title: 'Sync photos over cellular?', characters: 26, conversation: main, choices: ['Always', 'Wi-Fi only'] };
  render(sources([row('crumb', 'drafts', [asked])]), <InboxRows projectId="crumb" workspaceId="drafts" onOpen={() => {}} />);
  act(() => button(/^Wi-Fi only/u).click());
  act(() => button('Send').click());
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  await act(async () => { window.dispatchEvent(new Event('visibilitychange')); });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  expect(rpc.session).toHaveBeenCalledTimes(2);
});

it('Approve all declared approves every waiting workspace\'s card by content hash, each card once', async () => {
  const value = sources([
    row('crumb', 'kitchen', [lifecycle('q-kitchen', [{ hash: hash('a'), fileName: 'scripts/materialize.sh' }, { hash: hash('b'), fileName: 'scripts/seed.sh' }])]),
    row('crumb', 'slots', [lifecycle('q-slots', [{ hash: hash('a'), fileName: 'scripts/materialize.sh' }])]),
  ]);
  render(value, <AccountRows scope={null} onOpen={() => {}} />);
  // One row per content hash: materialize.sh once, though two workspaces wait on it.
  expect(container.querySelectorAll('[data-approval]')).toHaveLength(2);
  act(() => button('Approve all declared').click());
  act(() => button('Approve 2 for Crumb').click());
  expect(rpc.answer).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
  expect(rpc.answer.mock.calls.map(([input]) => input)).toEqual(expect.arrayContaining([
    expect.objectContaining({ projectId: 'crumb', workspaceId: 'kitchen', questionId: 'q-kitchen', answer: 'project' }),
    expect.objectContaining({ projectId: 'crumb', workspaceId: 'slots', questionId: 'q-slots', answer: 'project' }),
  ]));
  expect(rpc.answer).toHaveBeenCalledTimes(2);
});

it('lists an offline machine the account wants online, with the workspaces waiting on it', () => {
  const value = sources([], {});
  const machine = { id: 'm-ledger', label: 'ledger-cloud-2', state: 'offline' as const, rpcEndpoint: null, kind: 'sandbox' as const, notes: '', provider: 'cloudflare-sandbox' as const, desiredState: 'online' as const, lifecycleRevision: 1, operationId: null, error: null };
  render({ ...value, directory: { ...value.directory!, machines: [machine, { ...machine, id: 'm-off', label: 'switched-off', desiredState: 'offline' }], placements: [{ spaceId: 'bank-feed', projectId: 'crumb', kind: 'worktree', holderId: 'm-ledger', state: 'open', generation: 1, endpoint: null }] } },
    <AccountRows scope={null} onOpen={() => {}} />);
  expect(container.textContent).toContain('Machine ledger-cloud-2 is offline');
  expect(container.textContent).toContain('bank-feed runs on it and waits');
  expect(container.textContent).not.toContain('switched-off');
  expect(button('Start machine')).toBeTruthy();
});

it('counts fresh rows that block work, each approval once; issues and rows older than two days are not counted', () => {
  const topic: ChatterTopic = { key: 'bun test hangs', display: 'bun test hangs', firstAt: new Date(NOW), lastAt: new Date(NOW), posts: 7, participants: [], state: 'open', stateBy: null, stateAt: null, fixedIn: null, repeats: 0, filed: null, marked: null, sameAs: null };
  const value = sources([
    row('crumb', 'a', [
      { kind: 'ask', key: 'fresh', since: minutesAgo(10), title: 'Fresh?', characters: 6, conversation: main, choices: [] },
      { kind: 'ask', key: 'old', since: minutesAgo(3 * 24 * 60), title: 'Old?', characters: 4, conversation: main, choices: [] },
      lifecycle('q-a', [{ hash: hash('a'), fileName: 'a.sh' }]),
    ]),
    row('crumb', 'b', [lifecycle('q-b', [{ hash: hash('a'), fileName: 'a.sh' }])]),
  ], { topics: new Map([['crumb', [topic]]]) });
  // The fresh question and the one approval.
  expect(inboxCount(value, null, () => false, NOW)).toBe(2);
  // A row cleared in this tab leaves the count.
  expect(inboxCount(value, null, key => key === 'a:fresh', NOW)).toBe(1);
  // Out of scope: nothing.
  expect(inboxCount(value, new Set(['ledger']), () => false, NOW)).toBe(0);
});
