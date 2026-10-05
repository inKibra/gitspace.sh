// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema, type RuntimeSnapshot, type RuntimeWatchEvent } from '@gitspace/protocol-runtime';
import { useWorkspaceRuntime } from './useWorkspaceRuntime.js';

const rpc = vi.hoisted(() => ({ snapshot: vi.fn(), watch: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: rpc } }));
type Reply = { status: 'ok'; value: RuntimeWatchEvent } | { status: 'error'; error: Error };
interface ControlledStream {
  iterable: AsyncIterable<Reply>;
  emit(value: Reply): void;
  end(): void;
  fail(): void;
  close: () => Promise<IteratorResult<Reply>>;
}
function controlledStream(): ControlledStream {
  let pending = Promise.withResolvers<IteratorResult<Reply>>();
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  return {
    iterable: { [Symbol.asyncIterator]() { return { next: () => pending.promise, return: close }; } },
    emit(value: Reply) {
      const previous = pending;
      pending = Promise.withResolvers<IteratorResult<Reply>>();
      previous.resolve({ done: false, value });
    },
    end() { pending.resolve({ done: true, value: undefined }); },
    fail() { pending.reject(new Error('transport lost')); },
    close,
  };
}
function snapshot(cursor = 0, workspaceId = 'workspace'): RuntimeSnapshot {
  return RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId, cursor, conversations: [], tasks: [], attachments: [], questions: [], documents: {} });
}
let root: Root;
let container: HTMLDivElement;
let state: { snapshot: RuntimeSnapshot | null; connected: boolean; error: string | null; retry(): void };
let streams: ControlledStream[];
function View({ workspaceId = 'workspace' }: { workspaceId?: string }) {
  state = useWorkspaceRuntime('project', workspaceId);
  return <div>{state.snapshot?.workspaceId}:{state.snapshot?.cursor}</div>;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1);
  rpc.snapshot.mockReset().mockImplementation(async ({ workspaceId }: { workspaceId: string }) => ({ status: 'ok', value: snapshot(0, workspaceId) }));
  streams = [];
  rpc.watch.mockReset().mockImplementation(() => {
    const stream = controlledStream();
    streams.push(stream);
    return stream.iterable;
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['eof', 'throw', 'error'] as const)('automatically resumes the last applied cursor after %s', async (failure) => {
  await act(() => root.render(<View />));
  await act(async () => streams[0]!.emit({ status: 'ok', value: { type: 'delta', baseCursor: 0, cursor: 1, ops: [['s', ['cursor'], 1]] } }));
  await act(async () => {
    if (failure === 'eof') streams[0]!.end();
    else if (failure === 'throw') streams[0]!.fail();
    else streams[0]!.emit({ status: 'error', error: new Error('watch failed') });
  });
  expect(state.connected).toBe(false);
  expect(state.snapshot?.cursor).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(249); });
  expect(streams).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(rpc.watch.mock.calls[1]![0]).toEqual({ projectId: 'project', workspaceId: 'workspace', after: 1 });
  expect(rpc.snapshot).toHaveBeenCalledTimes(1);
  await act(async () => streams[1]!.emit({ status: 'ok', value: { type: 'delta', baseCursor: 1, cursor: 2, ops: [['s', ['cursor'], 2]] } }));
  expect(state.snapshot?.cursor).toBe(2);
  expect(state.connected).toBe(true);
  expect(state.error).toBeNull();
});

it('backs off repeated disconnects with a bounded delay', async () => {
  await act(() => root.render(<View />));
  for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
    const count = streams.length;
    await act(async () => streams[count - 1]!.end());
    await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
    expect(streams).toHaveLength(count);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(streams).toHaveLength(count + 1);
  }
});

it('draws jitter per attempt, including at the cap, and resets after progress', async () => {
  const random = vi.mocked(Math.random).mockReturnValueOnce(0).mockReturnValueOnce(0.5).mockReturnValue(1);
  await act(() => root.render(<View />));
  for (const delay of [125, 375, 1_000, 2_000, 4_000, 8_000, 10_000]) {
    const count = streams.length;
    await act(async () => streams[count - 1]!.end());
    await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
    expect(streams).toHaveLength(count);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(streams).toHaveLength(count + 1);
  }
  random.mockReturnValueOnce(0);
  await act(async () => streams.at(-1)!.end());
  await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
  expect(streams).toHaveLength(8);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(streams).toHaveLength(9);
  await act(async () => streams.at(-1)!.emit({ status: 'ok', value: { type: 'snapshot', snapshot: snapshot(1) } }));
  random.mockReturnValueOnce(0);
  await act(async () => streams.at(-1)!.end());
  await act(async () => { await vi.advanceTimersByTimeAsync(124); });
  expect(streams).toHaveLength(9);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(streams).toHaveLength(10);
  expect(rpc.watch.mock.calls.at(-1)![0].after).toBe(1);
});

it('retries an unavailable initial snapshot before subscribing', async () => {
  rpc.snapshot.mockRejectedValueOnce(new Error('snapshot unavailable'));
  await act(() => root.render(<View />));
  expect(streams).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(state.snapshot?.cursor).toBe(0);
  expect(streams).toHaveLength(1);
});

it('recovers a gap with a fresh snapshot even when recovery initially fails', async () => {
  await act(() => root.render(<View />));
  rpc.snapshot.mockRejectedValueOnce(new Error('snapshot unavailable')).mockResolvedValueOnce({ status: 'ok', value: snapshot(7) });
  await act(async () => streams[0]!.emit({ status: 'ok', value: { type: 'delta', baseCursor: 4, cursor: 5, ops: [['s', ['cursor'], 5]] } }));
  expect(streams[0]!.close).toHaveBeenCalledTimes(1);
  expect(state.snapshot?.cursor).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(state.snapshot?.cursor).toBe(7);
  expect(rpc.watch.mock.calls[1]![0].after).toBe(7);
});

it('accepts server cursor resets and resumes from their replacement snapshot', async () => {
  rpc.snapshot.mockResolvedValueOnce({ status: 'ok', value: snapshot(10) });
  await act(() => root.render(<View />));
  await act(async () => streams[0]!.emit({ status: 'ok', value: { type: 'reset', reason: 'cursor-ahead', snapshot: snapshot(3) } }));
  await act(async () => streams[0]!.end());
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(state.snapshot?.cursor).toBe(3);
  expect(rpc.watch.mock.calls[1]![0].after).toBe(3);
});

it('aborts the old workspace and ignores late stream callbacks', async () => {
  await act(() => root.render(<View />));
  const oldSignal = rpc.watch.mock.calls[0]![1].signal as AbortSignal;
  await act(() => root.render(<View workspaceId="other" />));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => streams[0]!.emit({ status: 'ok', value: { type: 'snapshot', snapshot: snapshot(99) } }));
  expect(state.snapshot?.workspaceId).toBe('other');
  expect(state.snapshot?.cursor).toBe(0);
  expect(streams).toHaveLength(2);
});

it('ignores a late snapshot from an abandoned workspace', async () => {
  const old = Promise.withResolvers<{ status: 'ok'; value: RuntimeSnapshot }>();
  rpc.snapshot.mockReturnValueOnce(old.promise);
  await act(() => root.render(<View />));
  await act(() => root.render(<View workspaceId="other" />));
  await act(async () => old.resolve({ status: 'ok', value: snapshot(99) }));
  expect(state.snapshot?.workspaceId).toBe('other');
  expect(streams).toHaveLength(1);
});

it('cancels pending reconnects on workspace switch and unmount', async () => {
  await act(() => root.render(<View />));
  await act(async () => streams[0]!.end());
  await act(() => root.render(<View workspaceId="other" />));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(streams).toHaveLength(2);
  await act(async () => streams[1]!.end());
  await act(() => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(streams).toHaveLength(2);
});

it('online and manual retries cancel previous subscriptions and scheduled retries', async () => {
  await act(() => root.render(<View />));
  const firstSignal = rpc.watch.mock.calls[0]![1].signal as AbortSignal;
  await act(async () => { window.dispatchEvent(new Event('online')); });
  expect(firstSignal.aborted).toBe(true);
  await act(async () => streams[1]!.end());
  await act(() => state.retry());
  expect(streams).toHaveLength(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(streams).toHaveLength(3);
  await act(() => root.render(null));
  expect((rpc.watch.mock.calls[2]![1].signal as AbortSignal).aborted).toBe(true);
  await act(async () => streams[2]!.fail());
  expect(vi.getTimerCount()).toBe(0);
});
