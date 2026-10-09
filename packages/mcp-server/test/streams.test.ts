import { describe, expect, test } from 'bun:test';
import { readLivePage, STREAM_LIMITS, type RpcResult, type Subscription } from '../src/streams.js';

function source(values: RpcResult[]): Subscription {
  return { close() {}, async *[Symbol.asyncIterator]() { yield* values; } };
}
const event = (cursor: number, previous: number | null, value: unknown = cursor): Extract<RpcResult, { status: 'ok' }> => ({ status: 'ok', value: { type: previous === null ? 'snapshot' : 'change', resource: 'test', cursor, previous, revision: cursor, value } });

describe('bounded live stream continuation', () => {
  test('resumes Chord deltas after a bounded page and replaces state on reset', async () => {
    const values: RpcResult[] = Array.from({ length: STREAM_LIMITS.items + 1 }, (_, index) => ({
      status: 'ok', value: { type: 'delta', baseCursor: index, cursor: index + 1, ops: [] },
    }));
    const first = await readLivePage({ path: 'runtime.watch', input: { spaceId: 's', after: 0 }, stream: source(values), encode: value => value, signal: new AbortController().signal });
    expect(first.nextInput).toEqual({ spaceId: 's', after: STREAM_LIMITS.items });
    const second = await readLivePage({ path: 'runtime.watch', input: first.nextInput!, stream: source(values.slice(STREAM_LIMITS.items)), encode: value => value, signal: new AbortController().signal });
    expect([...first.items, ...second.items]).toEqual(values.map(value => value.status === 'ok' ? value.value : null));
    const reset = { type: 'reset', snapshot: { cursor: 90 }, reason: 'cursor-expired' };
    const replacement = await readLivePage({ path: 'runtime.watch', input: { after: 1 }, stream: source([{ status: 'ok', value: reset }]), encode: value => value, signal: new AbortController().signal });
    expect(replacement).toEqual({ items: [reset], nextInput: { after: 90 }, reason: 'resync', gap: true, complete: false });
  });

  test('rejects a Chord delta whose base is not the delivered state', async () => {
    await expect(readLivePage({ path: 'runtime.watch', input: { after: 4 }, stream: source([{ status: 'ok', value: { type: 'delta', baseCursor: 5, cursor: 6, ops: [] } }]), encode: value => value, signal: new AbortController().signal })).rejects.toThrow('STREAM_CURSOR_GAP');
  });

  test('retains the Chord cursor preceding an over-budget delta', async () => {
    const values: RpcResult[] = [1, 2].map(cursor => ({ status: 'ok', value: { type: 'delta', baseCursor: cursor - 1, cursor, ops: [['a', ['text'], 'a'.repeat(600_000)]] } }));
    const page = await readLivePage({ path: 'runtime.watch', input: { after: 0 }, stream: source(values), encode: value => value, signal: new AbortController().signal });
    expect(page.nextInput).toEqual({ after: 1 });
    expect(page.items).toEqual([values[0]!.status === 'ok' ? values[0]!.value : null]);
  });

  test('returns the original backend cursor without dropping the next page boundary', async () => {
    const values = Array.from({ length: STREAM_LIMITS.items + 2 }, (_, index) => event(index + 1, index === 0 ? null : index));
    const first = await readLivePage({ path: 'project.events', input: { after: null }, stream: source(values), encode: (value) => value, signal: new AbortController().signal });
    expect(first.nextInput).toEqual({ after: STREAM_LIMITS.items });
    expect(first.complete).toBe(false);
    const second = await readLivePage({ path: 'project.events', input: first.nextInput!, stream: source(values.slice(STREAM_LIMITS.items)), encode: (value) => value, signal: new AbortController().signal });
    expect([...first.items, ...second.items]).toEqual(values.map((value) => value.value));
    expect(second.reason).toBe('ended');
    expect(second.complete).toBe(false);
  });

  test('retains the cursor preceding a frame that would exceed the byte budget', async () => {
    const values = [event(1, null, 'a'.repeat(600_000)), event(2, 1, 'b'.repeat(600_000))];
    const page = await readLivePage({ path: 'project.events', input: { after: null }, stream: source(values), encode: (value) => value, signal: new AbortController().signal });
    expect(page.items).toEqual([values[0]!.value]);
    expect(page.nextInput).toEqual({ after: 1 });
  });

  test('reports resynchronization rather than treating an expired cursor as completion', async () => {
    const resync = { type: 'resync', resource: 'test', cursor: 9, revision: 9, reason: 'cursor-expired' };
    const page = await readLivePage({ path: 'project.events', input: { after: 1 }, stream: source([{ status: 'ok', value: resync }]), encode: (value) => value, signal: new AbortController().signal });
    expect(page).toEqual({ items: [resync], nextInput: { after: null }, complete: false, gap: true, reason: 'resync' });
  });

  test('does not turn a broken chain or operation failure into a successful page', async () => {
    await expect(readLivePage({ path: 'project.events', input: { after: 4 }, stream: source([event(7, 6)]), encode: (value) => value, signal: new AbortController().signal })).rejects.toThrow('STREAM_CURSOR_GAP');
    await expect(readLivePage({ path: 'project.events', input: { after: null }, stream: source([{ status: 'error', error: { _tag: 'OperationFailed' } }]), encode: (value) => value, signal: new AbortController().signal })).rejects.toThrow('GitSpace operation failed');
  });

});
