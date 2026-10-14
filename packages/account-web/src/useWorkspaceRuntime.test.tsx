// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workspaceLiveKey } from '@gitspace/protocol/live-notice';
import { RuntimeSnapshotSchema, type RuntimeSnapshot, type RuntimeWatchEvent } from '@gitspace/protocol-runtime';
import { liveNotices } from './live-notices.js';
import { useWorkspaceRuntime } from './useWorkspaceRuntime.js';

const rpc = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: rpc } }));
type Reply = { status: 'ok'; value: RuntimeWatchEvent[] } | { status: 'error'; error: Error };
interface Read { workspaceId: string; after: number | null; signal: AbortSignal; reply(value: Reply): Promise<void>; fail(): Promise<void> }
function snapshot(cursor = 0, workspaceId = 'workspace'): RuntimeSnapshot {
  return RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId, cursor, conversations: [], tasks: [], attachments: [], questions: [], documents: {} });
}
function delta(cursor: number): RuntimeWatchEvent {
  return { type: 'delta', baseCursor: cursor - 1, cursor, ops: [['s', ['cursor'], cursor]] };
}
const ok = (...value: RuntimeWatchEvent[]): Reply => ({ status: 'ok', value });
const notice = (version: number, workspaceId = 'workspace') => act(async () => { liveNotices.receive({ ...workspaceLiveKey(workspaceId, 'runtime', 'project'), version }); });
let root: Root;
let container: HTMLDivElement;
let state: { snapshot: RuntimeSnapshot | null; connected: boolean; error: string | null; retry(): void };
let reads: Read[];
function View({ workspaceId = 'workspace' }: { workspaceId?: string }) {
  state = useWorkspaceRuntime('project', workspaceId);
  return <div>{state.snapshot?.workspaceId}:{state.snapshot?.cursor}</div>;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1);
  reads = [];
  rpc.watch.mockReset().mockImplementation((input: { workspaceId: string; after: number | null }, options: { signal: AbortSignal }) => {
    const pending = Promise.withResolvers<Reply>();
    reads.push({
      workspaceId: input.workspaceId, after: input.after, signal: options.signal,
      reply: value => act(async () => { pending.resolve(value); }),
      fail: () => act(async () => { pending.reject(new Error('transport lost')); }),
    });
    return pending.promise;
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

it('reads a snapshot, then refetches once per notice after the current cursor', async () => {
  await act(() => root.render(<View />));
  expect(reads.map(read => read.after)).toEqual([null]);
  await reads[0]!.reply(ok({ type: 'snapshot', snapshot: snapshot(0) }));
  expect(state.snapshot?.cursor).toBe(0);
  expect(state.connected).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(reads).toHaveLength(1);
  await notice(1);
  expect(reads.map(read => read.after)).toEqual([null, 0]);
  await reads[1]!.reply(ok(delta(1)));
  expect(state.snapshot?.cursor).toBe(1);
  expect(reads).toHaveLength(2);
});

it('a burst of notices during a fetch causes exactly one more fetch', async () => {
  await act(() => root.render(<View />));
  await reads[0]!.reply(ok({ type: 'snapshot', snapshot: snapshot(0) }));
  await notice(1);
  await notice(2);
  await notice(3);
  expect(reads).toHaveLength(2);
  await reads[1]!.reply(ok(delta(1)));
  expect(reads.map(read => read.after)).toEqual([null, 0, 1]);
  await reads[2]!.reply(ok(delta(2), delta(3)));
  expect(state.snapshot?.cursor).toBe(3);
  expect(reads).toHaveLength(3);
});

it('applies only the deltas newer than its cursor, in order', async () => {
  await act(() => root.render(<View />));
  await reads[0]!.reply(ok({ type: 'snapshot', snapshot: snapshot(2) }));
  await notice(4);
  expect(reads[1]!.after).toBe(2);
  const applied = state.snapshot;
  await reads[1]!.reply(ok(delta(1), delta(2), delta(3), delta(4)));
  expect(state.snapshot?.cursor).toBe(4);
  expect(state.snapshot).not.toBe(applied);
  expect(reads).toHaveLength(2);
});

it('replaces the replica from a reset and reads after its cursor', async () => {
  await act(() => root.render(<View />));
  await reads[0]!.reply(ok({ type: 'snapshot', snapshot: snapshot(10) }));
  await notice(11);
  await reads[1]!.reply(ok({ type: 'reset', reason: 'cursor-expired', snapshot: snapshot(3) }));
  expect(state.snapshot?.cursor).toBe(3);
  await notice(4);
  expect(reads[2]!.after).toBe(3);
});

it('refetches a snapshot when a delta does not chain onto the replica', async () => {
  await act(() => root.render(<View />));
  await reads[0]!.reply(ok({ type: 'snapshot', snapshot: snapshot(0) }));
  await notice(5);
  await reads[1]!.reply(ok({ type: 'delta', baseCursor: 4, cursor: 5, ops: [['s', ['cursor'], 5]] }));
  expect(state.snapshot?.cursor).toBe(0);
  expect(reads.map(read => read.after)).toEqual([null, 0, null]);
  await reads[2]!.reply(ok({ type: 'snapshot', snapshot: snapshot(7) }));
  expect(state.snapshot?.cursor).toBe(7);
  expect(state.connected).toBe(true);
});

it.each(['throw', 'error'] as const)('retries a failed read after a bounded delay from the last applied cursor (%s)', async (failure) => {
  await act(() => root.render(<View />));
  await reads[0]!.reply(ok({ type: 'snapshot', snapshot: snapshot(1) }));
  await notice(2);
  if (failure === 'throw') await reads[1]!.fail();
  else await reads[1]!.reply({ status: 'error', error: new Error('watch failed') });
  expect(state.connected).toBe(false);
  expect(state.error).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(249); });
  expect(reads).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(reads[2]!.after).toBe(1);
  await reads[2]!.reply(ok(delta(2)));
  expect(state.snapshot?.cursor).toBe(2);
  expect(state.connected).toBe(true);
  expect(state.error).toBeNull();
});

it('backs off repeated failures with a bounded delay', async () => {
  await act(() => root.render(<View />));
  for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
    const count = reads.length;
    await reads[count - 1]!.fail();
    await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
    expect(reads).toHaveLength(count);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(reads).toHaveLength(count + 1);
  }
});

it('stops listening on workspace switch and unmount and ignores late replies', async () => {
  await act(() => root.render(<View />));
  await act(() => root.render(<View workspaceId="other" />));
  expect(reads[0]!.signal.aborted).toBe(true);
  await reads[0]!.reply(ok({ type: 'snapshot', snapshot: snapshot(99) }));
  await reads[1]!.reply(ok({ type: 'snapshot', snapshot: snapshot(0, 'other') }));
  expect(state.snapshot?.workspaceId).toBe('other');
  expect(state.snapshot?.cursor).toBe(0);
  await notice(1);
  expect(reads).toHaveLength(2);
  await notice(1, 'other');
  expect(reads.map(read => read.workspaceId)).toEqual(['workspace', 'other', 'other']);
  await reads[2]!.reply(ok(delta(1)));
  await act(() => root.render(null));
  await notice(2, 'other');
  expect(reads).toHaveLength(3);
});

it('cancels a pending retry on workspace switch and unmount', async () => {
  await act(() => root.render(<View />));
  await reads[0]!.fail();
  await act(() => root.render(<View workspaceId="other" />));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(reads.map(read => read.workspaceId)).toEqual(['workspace', 'other']);
  await reads[1]!.fail();
  await act(() => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(reads).toHaveLength(2);
});

it('online and manual retries abort the previous read and refetch after the current cursor', async () => {
  await act(() => root.render(<View />));
  await reads[0]!.reply(ok({ type: 'snapshot', snapshot: snapshot(4) }));
  await notice(5);
  await act(async () => { window.dispatchEvent(new Event('online')); });
  expect(reads[1]!.signal.aborted).toBe(true);
  expect(reads[2]!.after).toBe(4);
  await reads[2]!.fail();
  await act(() => state.retry());
  expect(reads[3]!.after).toBe(4);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(reads).toHaveLength(4);
});
