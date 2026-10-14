// @vitest-environment happy-dom
import { terminalStreamResource } from '@gitspace/protocol/rpc-contract';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SynchronizationContext } from './SynchronizationProvider.js';
import { SynchronizationOwner } from './synchronization.js';
import { WorkspaceTerminals, type WorkspaceTerminalOutput, type WorkspaceTerminalView, type WorkspaceTerminalsProps } from './WorkspaceTerminals.js';

vi.mock('./GitSpaceShell.js', () => ({ EmptyState: ({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) => <div>{title}{description}{action}</div> }));
vi.mock('ghostty-web', () => ({
  init: async () => undefined,
  Terminal: class {
    element!: HTMLPreElement;
    viewportY = 0;
    rows = 40;
    focus() {}
    open(container: HTMLElement) {
      this.element = document.createElement('pre');
      this.element.setAttribute('aria-label', 'Terminal output');
      container.append(this.element);
    }
    write(data: string | Uint8Array) {
      if (typeof data === 'string' && data.startsWith('\x1b')) this.element.textContent = '';
      else this.element.textContent += typeof data === 'string' ? data : new TextDecoder().decode(data);
    }
    reset() { this.element.textContent = ''; }
    dispose() { this.element.remove(); }
    onData() {}
    onScroll() { return { dispose() {} }; }
    scrollToBottom() {}
  },
}));

interface Snapshot { terminals: readonly WorkspaceTerminalView[]; output: WorkspaceTerminalOutput | null }

/** The hub's terminal journal: one head per stream resource, cursors allocated from one account-wide sequence. */
function hub(initial: WorkspaceTerminalView[]) {
  let terminals = initial;
  let sequence = 0;
  const heads = new Map<string, { cursor: number; body: string; value: Snapshot }>();
  const changes = new EventTarget();
  const head = (name: string | null) => {
    const resource = terminalStreamResource('space', 'machine', name);
    const value: Snapshot = { terminals, output: name !== null && terminals.some((terminal) => terminal.name === name) ? { spaceId: 'space', name, state: 'running', cursor: 1, data: `${name} output` } : null };
    const body = JSON.stringify(value);
    const prior = heads.get(resource);
    if (prior?.body === body) return { resource, ...prior };
    const next = { cursor: ++sequence, body, value };
    heads.set(resource, next);
    return { resource, ...next };
  };
  const events: WorkspaceTerminalsProps['events'] = async function* (_machineId, name, _after, signal) {
    let delivered: number | null = null;
    while (!signal.aborted) {
      const changed = Promise.withResolvers<void>();
      changes.addEventListener('change', () => changed.resolve(), { once: true });
      signal.addEventListener('abort', () => changed.resolve(), { once: true });
      const current = head(name);
      if (current.cursor !== delivered) {
        delivered = current.cursor;
        yield { status: 'ok', value: { type: 'snapshot', resource: current.resource, cursor: current.cursor, revision: current.cursor, previous: null, value: current.value } };
      }
      await changed.promise;
    }
  };
  return {
    events,
    update(next: WorkspaceTerminalView[]) {
      terminals = next;
      changes.dispatchEvent(new Event('change'));
    },
    create: async () => {
      const created = shell(`shell-${sequence}`, 10 + sequence);
      terminals = [created, ...terminals];
      changes.dispatchEvent(new Event('change'));
      return created;
    },
    // persist:false shells leave the supervisor inventory once stopped.
    stop: vi.fn(async (_machineId: string, name: string) => {
      terminals = terminals.filter((terminal) => terminal.name !== name);
      changes.dispatchEvent(new Event('change'));
    }),
  };
}

function shell(name: string, createdAt: number, kind: WorkspaceTerminalView['kind'] = 'user'): WorkspaceTerminalView {
  return { spaceId: 'space', name, id: `id-${name}`, kind, state: 'running', machineId: 'machine', owner: null, command: '/bin/bash', cwd: '/workspace', createdAt: new Date(createdAt), exitCode: null };
}

let root: Root;
let container: HTMLDivElement;
let owner: SynchronizationOwner;
const consoleErrors: unknown[][] = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { consoleErrors.push(args); });
  consoleErrors.length = 0;
  owner = new SynchronizationOwner();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  owner.dispose();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
}

async function render(terminals: Pick<WorkspaceTerminalsProps, 'events' | 'create' | 'stop'>) {
  const props: WorkspaceTerminalsProps = { spaceId: 'space', machines: [{ id: 'machine', label: 'Machine' }], machineId: 'machine', onSelectMachine: vi.fn(), events: terminals.events, live: async function* () {}, create: terminals.create, send: vi.fn(async () => undefined), stop: terminals.stop };
  await act(() => root.render(<SynchronizationContext.Provider value={owner}><WorkspaceTerminals {...props} /></SynchronizationContext.Provider>));
  await settle();
}

function tabs() {
  return Array.from(container.querySelectorAll('[role="tab"]'), (tab) => ({ name: tab.querySelector('span[aria-hidden="true"]')?.textContent, selected: tab.getAttribute('aria-selected') === 'true' }));
}
function selectedTab() {
  return tabs().find((tab) => tab.selected)?.name;
}
function runningCount() {
  return container.querySelector('header')?.textContent?.match(/(\d+) running/u)?.[1];
}
function output() {
  return container.querySelector('[aria-label="Terminal output"]')?.textContent;
}

it('terminating the only user shell settles on the empty state without exceeding update depth', async () => {
  const terminals = hub([shell('shell-main', 1)]);
  await render(terminals);
  expect(selectedTab()).toBe('shell-main');
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Terminate shell-main"]')?.click());
  await settle();
  await settle();
  expect(terminals.stop).toHaveBeenCalledWith('machine', 'shell-main');
  expect(consoleErrors.flat().join(' ')).not.toMatch(/Maximum update depth/u);
  expect(tabs()).toEqual([]);
  expect(container.textContent).toContain('No terminals');
});

it('terminating the selected user shell selects a remaining terminal and removes only that shell', async () => {
  const terminals = hub([shell('shell-main', 3), shell('agent-test', 2, 'agent'), shell('life-move-7', 1, 'lifecycle')]);
  await render(terminals);
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Terminate shell-main"]')?.click());
  await settle();
  await settle();
  expect(consoleErrors.flat().join(' ')).not.toMatch(/Maximum update depth/u);
  expect(tabs().map((tab) => tab.name)).toEqual(['agent-test', 'life-move-7']);
  expect(runningCount()).toBe('2');
  expect(selectedTab()).toBe('agent-test');
  expect(output()).toBe('agent-test output');
});

it('keeps a chosen tab and its output across later snapshots', async () => {
  const lifecycle = shell('life-move-7', 1, 'lifecycle');
  const terminals = hub([shell('shell-main', 3), shell('agent-test', 2, 'agent'), lifecycle]);
  await render(terminals);
  expect(selectedTab()).toBe('shell-main');
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[2]?.click());
  await settle();
  expect(selectedTab()).toBe('life-move-7');
  expect(output()).toBe('life-move-7 output');
  terminals.update([shell('agent-build', 4, 'agent'), shell('shell-main', 3), shell('agent-test', 2, 'agent'), lifecycle]);
  await settle();
  expect(selectedTab()).toBe('life-move-7');
  expect(output()).toBe('life-move-7 output');
  expect(tabs().map((tab) => tab.name)).toEqual(['agent-build', 'shell-main', 'agent-test', 'life-move-7']);
});

it('lists the machine terminals without reverting to an earlier snapshot of another stream', async () => {
  const lifecycle = shell('life-move-7', 1, 'lifecycle');
  const terminals = hub([shell('shell-main', 3), shell('agent-test', 2, 'agent'), lifecycle]);
  await render(terminals);
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[2]?.click());
  await settle();
  // An agent opens a terminal while shell-main's stream is idle; shell-main's last snapshot predates it.
  terminals.update([shell('agent-build', 4, 'agent'), shell('shell-main', 3), shell('agent-test', 2, 'agent'), lifecycle]);
  await settle();
  expect(runningCount()).toBe('4');
  const counts: Array<string | undefined> = [];
  const observer = new MutationObserver(() => counts.push(runningCount()));
  observer.observe(container, { subtree: true, childList: true, characterData: true });
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]?.click());
  await settle();
  observer.disconnect();
  expect(counts.filter((count) => count !== '4')).toEqual([]);
  expect(tabs().map((tab) => tab.name)).toEqual(['agent-build', 'shell-main', 'agent-test', 'life-move-7']);
  expect(selectedTab()).toBe('shell-main');
  expect(output()).toBe('shell-main output');
});

it('selects a created terminal at once and keeps it when the machine list catches up', async () => {
  const terminals = hub([shell('shell-main', 3), shell('life-move-7', 1, 'lifecycle')]);
  await render(terminals);
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'New terminal')?.click());
  const created = selectedTab();
  expect(created).toMatch(/^shell-\d+$/u);
  await settle();
  expect(selectedTab()).toBe(created);
  expect(tabs().map((tab) => tab.name)).toEqual([created, 'shell-main', 'life-move-7']);
  expect(output()).toBe(`${created} output`);
});
