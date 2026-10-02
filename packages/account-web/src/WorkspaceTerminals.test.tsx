// @vitest-environment happy-dom
import type { ProtectedTerminalEvent } from '@gitspace/protocol/rpc-contract';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceTerminals, type WorkspaceTerminalView, type WorkspaceTerminalsProps } from './WorkspaceTerminals.js';

const synchronized = vi.hoisted(() => ({ value: { terminals: [] as WorkspaceTerminalView[], output: null }, cursor: 0, transportError: null }));
vi.mock('./SynchronizationProvider.js', () => ({ useSynchronizedResource: () => synchronized }));
vi.mock('./GitSpaceShell.js', () => ({ EmptyState: () => null }));
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

function channel() {
  type Item = IteratorResult<{ status: 'ok'; value: ProtectedTerminalEvent }>;
  let waiting = Promise.withResolvers<Item>();
  return {
    live: vi.fn((_name: string, _signal: AbortSignal) => ({
      [Symbol.asyncIterator]() { return this; },
      next: () => waiting.promise,
      return: async () => ({ done: true as const, value: undefined }),
    })),
    async emit(value?: ProtectedTerminalEvent) {
      await act(async () => {
        const previous = waiting;
        waiting = Promise.withResolvers<Item>();
        previous.resolve(value ? { done: false, value: { status: 'ok', value } } : { done: true, value: undefined });
      });
      await flushFrames();
    },
  };
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
  return { spaceId: 'space', events: async function* () {}, live, create: async () => terminal, send: vi.fn(async () => undefined), stop: async () => undefined };
}

async function render(options: WorkspaceTerminalsProps) {
  await act(() => root.render(<WorkspaceTerminals {...options} />));
  await flushFrames();
}

it('drains trailing private output after terminal status ends and retains ordered final progress until close', async () => {
  const stream = channel();
  const options = props(stream.live);
  await render(options);
  await stream.emit({ type: 'state', steps: [{ id: '10-prepare', status: 'running', exitCode: null }, { id: '20-configure', status: 'pending', exitCode: null }, { id: '30-fail', status: 'pending', exitCode: null }, { id: '40-unused', status: 'pending', exitCode: null }] });
  await stream.emit({ type: 'output', data: 'Early output\r\n' });
  synchronized.value = { terminals: [{ ...terminal, state: 'failed', exitCode: 7 }], output: null };
  synchronized.cursor++;
  await render(options);
  await stream.emit({ type: 'output', data: 'Failure details\r\n' });
  await stream.emit({ type: 'state', steps: [{ id: '10-prepare', status: 'succeeded', exitCode: 0 }, { id: '20-configure', status: 'succeeded', exitCode: 0 }, { id: '30-fail', status: 'failed', exitCode: 7 }, { id: '40-unused', status: 'pending', exitCode: null }] });
  await stream.emit({ type: 'complete', exitCode: 7 });
  const display = container.querySelector('[aria-label="Terminal output"]')!;
  expect(display.textContent).toBe('Early output\r\nFailure details\r\n');
  expect(Array.from(container.querySelectorAll('ol li'), (row) => row.textContent)).toEqual(['10-preparesucceeded · exit 0', '20-configuresucceeded · exit 0', '30-failfailed · exit 7', '40-unusednot run']);
  await act(async () => {
    display.dispatchEvent(new CustomEvent('terminal-input', { detail: 'secret\r' }));
    await vi.advanceTimersByTimeAsync(3_000);
  });
  expect(options.send).not.toHaveBeenCalled();
  expect(stream.live).toHaveBeenCalledTimes(1);
  await act(() => root.render(null));
  expect(display.textContent).toBe('');
});

it('clears private output on transport loss and reconnects without enabling input before the state handshake', async () => {
  const stream = channel();
  const options = props(stream.live);
  await render(options);
  await stream.emit({ type: 'state', steps: [] });
  await stream.emit({ type: 'output', data: 'private text' });
  await stream.emit();
  expect(container.textContent).not.toContain('private text');
  expect(container.textContent).toContain('previous output was cleared');
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(stream.live).toHaveBeenCalledTimes(2);
  const display = container.querySelector('[aria-label="Terminal output"]')!;
  await act(() => display.dispatchEvent(new CustomEvent('terminal-input', { detail: 'before' })));
  expect(options.send).not.toHaveBeenCalled();
  await stream.emit({ type: 'state', steps: [] });
  await act(() => display.dispatchEvent(new CustomEvent('terminal-input', { detail: 'after' })));
  expect(options.send).toHaveBeenCalledWith('environment', 'after');
  await stream.emit({ type: 'complete', exitCode: 0 });
  await act(() => display.dispatchEvent(new CustomEvent('terminal-input', { detail: 'ended' })));
  expect(options.send).toHaveBeenCalledTimes(1);
});

it('does not retry an already ended run when live delivery is unavailable', async () => {
  synchronized.value = { terminals: [{ ...terminal, state: 'exited', exitCode: 0 }], output: null };
  const stream = channel();
  await render(props(stream.live));
  await stream.emit();
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(stream.live).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('The Environment run has ended.');
});
