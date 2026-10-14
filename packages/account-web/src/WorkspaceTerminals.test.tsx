// @vitest-environment happy-dom
import { workspaceLiveKey } from '@gitspace/protocol/live-notice';
import { terminalLiveResource, type ProtectedTerminalBatch, type ProtectedTerminalEvent } from '@gitspace/protocol/rpc-contract';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { liveNotices } from './live-notices.js';
import { WorkspaceTerminals, type WorkspaceTerminalView, type WorkspaceTerminalsProps } from './WorkspaceTerminals.js';

const synchronized = vi.hoisted(() => ({ value: { terminals: [] as WorkspaceTerminalView[], output: null }, cursor: 0, transportError: null }));
vi.mock('./SynchronizationProvider.js', () => ({ useSynchronizedResource: () => synchronized }));
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
    onData(listener: (data: string) => void) { this.element.addEventListener('terminal-input', (event) => listener((event as CustomEvent<string>).detail)); }
    onScroll() { return { dispose() {} }; }
    scrollToBottom() {}
  },
}));

let root: Root;
let container: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let version = 0;
const terminal: WorkspaceTerminalView = { spaceId: 'space', name: 'environment', id: 'run', kind: 'lifecycle', state: 'running', machineId: 'machine', owner: null, command: 'workspace/materialize', cwd: '/workspace', createdAt: new Date(0), exitCode: null, protected: true };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  synchronized.value = { terminals: [{ ...terminal }], output: null };
  synchronized.cursor = 1;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** `terminals.live` reads, each answered by the test in order. */
function channel() {
  type Read = PromiseWithResolvers<{ status: 'ok'; value: ProtectedTerminalBatch } | { status: 'error'; error: Error }>;
  const reads: Read[] = [];
  let answered = 0;
  const next = () => {
    const read = reads[answered++];
    if (!read) throw new Error('No read is waiting for an answer');
    return read;
  };
  return {
    live: vi.fn((_machineId: string, _name: string, _after: number | null, _signal: AbortSignal) => {
      const read: Read = Promise.withResolvers();
      reads.push(read);
      return read.promise;
    }),
    async answer(cursor: number, events: ProtectedTerminalEvent[]) {
      await act(async () => { next().resolve({ status: 'ok', value: { cursor, events } }); });
      await flushFrames();
    },
    async fail() {
      await act(async () => { next().resolve({ status: 'error', error: new Error('Tunnel closed') }); });
      await flushFrames();
    },
  };
}

/** The machine announces a change of the protected terminal's output. */
async function notice() {
  await act(async () => { liveNotices.receive({ ...workspaceLiveKey('space', terminalLiveResource('machine', 'environment')), version: ++version }); });
}

async function flushFrames() {
  await act(async () => {
    await Promise.resolve();
    while (frames.size > 0) {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    }
  });
}

function props(live: WorkspaceTerminalsProps['live']): WorkspaceTerminalsProps {
  return { spaceId: 'space', machines: [{ id: 'machine', label: 'Machine' }], machineId: 'machine', onSelectMachine: vi.fn(), events: async () => ({ status: 'ok', value: [] }), live, create: async () => terminal, send: vi.fn(async () => undefined), stop: async () => undefined };
}

function button(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text);
}

async function render(options: WorkspaceTerminalsProps) {
  await act(() => root.render(<WorkspaceTerminals {...options} />));
  await flushFrames();
}

function output() {
  return container.querySelector('[aria-label="Terminal output"]')?.textContent;
}

it('reads again only on a notice, once, after the current cursor, appending only newer output', async () => {
  const stream = channel();
  await render(props(stream.live));
  expect(stream.live).toHaveBeenCalledTimes(1);
  expect(stream.live).toHaveBeenLastCalledWith('machine', 'environment', null, expect.any(AbortSignal));
  await stream.answer(3, [{ type: 'state', steps: [] }]);
  // No notice, no read.
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(stream.live).toHaveBeenCalledTimes(1);
  await notice();
  expect(stream.live).toHaveBeenCalledTimes(2);
  expect(stream.live).toHaveBeenLastCalledWith('machine', 'environment', 3, expect.any(AbortSignal));
  await stream.answer(5, [{ type: 'output', data: 'first ' }]);
  expect(output()).toBe('first ');
  await notice();
  expect(stream.live).toHaveBeenLastCalledWith('machine', 'environment', 5, expect.any(AbortSignal));
  await stream.answer(6, [{ type: 'output', data: 'second' }]);
  expect(output()).toBe('first second');
  expect(stream.live).toHaveBeenCalledTimes(3);
});

it('reads once more after a burst of notices that arrives while a read is in flight', async () => {
  const stream = channel();
  await render(props(stream.live));
  await stream.answer(1, [{ type: 'state', steps: [] }]);
  await notice();
  expect(stream.live).toHaveBeenCalledTimes(2);
  await notice();
  await notice();
  await notice();
  expect(stream.live).toHaveBeenCalledTimes(2);
  await stream.answer(2, [{ type: 'output', data: 'a' }]);
  expect(stream.live).toHaveBeenCalledTimes(3);
  expect(stream.live).toHaveBeenLastCalledWith('machine', 'environment', 2, expect.any(AbortSignal));
  await stream.answer(2, []);
  expect(stream.live).toHaveBeenCalledTimes(3);
  expect(output()).toBe('a');
});

it('drains trailing private output after terminal status ends and retains ordered final progress until close', async () => {
  const stream = channel();
  const options = props(stream.live);
  await render(options);
  await stream.answer(1, [{ type: 'state', steps: [{ id: '10-prepare', status: 'running', exitCode: null }, { id: '20-configure', status: 'pending', exitCode: null }, { id: '30-fail', status: 'pending', exitCode: null }, { id: '40-unused', status: 'pending', exitCode: null }] }]);
  await notice();
  await stream.answer(2, [{ type: 'output', data: 'Early output\r\n' }]);
  synchronized.value = { terminals: [{ ...terminal, state: 'failed', exitCode: 7 }], output: null };
  synchronized.cursor++;
  await render(options);
  await notice();
  await stream.answer(4, [
    { type: 'output', data: 'Failure details\r\n' },
    { type: 'state', steps: [{ id: '10-prepare', status: 'succeeded', exitCode: 0 }, { id: '20-configure', status: 'succeeded', exitCode: 0 }, { id: '30-fail', status: 'failed', exitCode: 7 }, { id: '40-unused', status: 'pending', exitCode: null }] },
  ]);
  await notice();
  await stream.answer(5, [{ type: 'complete', exitCode: 7 }]);
  const display = container.querySelector('[aria-label="Terminal output"]')!;
  expect(display.textContent).toBe('Early output\r\nFailure details\r\n');
  expect(Array.from(container.querySelectorAll('ol li'), (row) => row.textContent)).toEqual(['10-preparesucceeded · exit 0', '20-configuresucceeded · exit 0', '30-failfailed · exit 7', '40-unusednot run']);
  await act(async () => {
    display.dispatchEvent(new CustomEvent('terminal-input', { detail: 'secret\r' }));
    await vi.advanceTimersByTimeAsync(3_000);
  });
  expect(options.send).not.toHaveBeenCalled();
  // Completion ends the reads; later notices read nothing.
  await notice();
  expect(stream.live).toHaveBeenCalledTimes(4);
  await act(() => root.render(null));
  expect(display.textContent).toBe('');
});

it('clears private output when a read fails and reattaches without replay, enabling input only after the state handshake', async () => {
  const stream = channel();
  const options = props(stream.live);
  await render(options);
  await stream.answer(1, [{ type: 'state', steps: [] }]);
  await notice();
  await stream.answer(2, [{ type: 'output', data: 'private text' }]);
  await notice();
  await stream.fail();
  expect(container.textContent).not.toContain('private text');
  expect(container.textContent).toContain('previous output was cleared');
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(stream.live).toHaveBeenCalledTimes(4);
  expect(stream.live).toHaveBeenLastCalledWith('machine', 'environment', null, expect.any(AbortSignal));
  const display = container.querySelector('[aria-label="Terminal output"]')!;
  await act(() => display.dispatchEvent(new CustomEvent('terminal-input', { detail: 'before' })));
  expect(options.send).not.toHaveBeenCalled();
  await stream.answer(5, [{ type: 'state', steps: [] }]);
  await act(() => display.dispatchEvent(new CustomEvent('terminal-input', { detail: 'after' })));
  expect(options.send).toHaveBeenCalledWith('machine', 'environment', 'after');
  await notice();
  await stream.answer(6, [{ type: 'complete', exitCode: 0 }]);
  await act(() => display.dispatchEvent(new CustomEvent('terminal-input', { detail: 'ended' })));
  expect(options.send).toHaveBeenCalledTimes(1);
});

it('does not retry an already ended run when its read fails', async () => {
  synchronized.value = { terminals: [{ ...terminal, state: 'exited', exitCode: 0 }], output: null };
  const stream = channel();
  await render(props(stream.live));
  await stream.fail();
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(stream.live).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('The Environment run has ended.');
});

it('offers the attach action instead of a terminal when no machine is attached as a ready cache', async () => {
  const onAttachMachine = vi.fn();
  const create = vi.fn(async () => terminal);
  await render({ ...props(channel().live), machines: [], machineId: null, onAttachMachine, create });
  expect(container.textContent).toContain('Attach a machine to open a terminal');
  expect(button('New terminal')).toBeUndefined();
  await act(() => button('Attach a machine')?.click());
  expect(onAttachMachine).toHaveBeenCalledTimes(1);
  expect(create).not.toHaveBeenCalled();
});

it('opens terminals only on the attached machine the user picks', async () => {
  synchronized.value = { terminals: [], output: null };
  const onSelectMachine = vi.fn();
  const create = vi.fn(async () => terminal);
  const machines: WorkspaceTerminalsProps['machines'] = [{ id: 'cache-a', label: 'Cache A' }, { id: 'cache-b', label: 'Cache B' }];
  const options = { ...props(channel().live), machines, machineId: null, onSelectMachine, create };
  await render(options);
  // Two ready caches and no pick: nothing is chosen for the user.
  expect(container.textContent).toContain('Choose a machine');
  expect(button('New terminal')).toBeUndefined();
  await act(() => button('Cache B')?.click());
  expect(onSelectMachine).toHaveBeenCalledWith('cache-b');
  await render({ ...options, machineId: 'cache-b' });
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="Terminal machine"]')?.value).toBe('cache-b');
  await act(() => button('New terminal')?.click());
  expect(create).toHaveBeenCalledWith('cache-b');
});
