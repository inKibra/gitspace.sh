import { type TranscriptContentPage, type TranscriptItem, type TranscriptRow } from '@gitspace/blocks';
import { expect, it, vi } from 'vitest';
import { TranscriptContentCache } from './transcriptContentCache.js';

function row(ordinal: number): TranscriptRow {
  return {
    id: `row-${ordinal}`, ordinal, turnId: 'turn', turnStatus: 'done', truncated: true, contentBytes: 100, contentRevision: 1,
    item: { id: `row-${ordinal}`, type: 'message', role: 'user', text: 'Transport preview' },
  };
}

function page(id: string, text = `Complete ${id}`): TranscriptContentPage {
  const serialized = JSON.stringify({ id, type: 'message', role: 'user', text });
  return { text: serialized, offset: 0, nextOffset: null, totalCharacters: serialized.length, contentRevision: 1 };
}

it('limits concurrent reads and cancels rows that leave overscan without publishing late content', async () => {
  const cache = new TranscriptContentCache('generation', { bytes: 10_000, entries: 384, reads: 2 });
  const items = [row(0), row(1), row(2), row(3)];
  const loads = items.map(() => Promise.withResolvers<TranscriptContentPage>());
  const read = vi.fn((id: string, _offset: number, _signal: AbortSignal) => loads[Number(id.slice(4))]!.promise);
  cache.setNeeded(items, read);
  expect(read.mock.calls.map(([id]) => id)).toEqual(['row-0', 'row-1']);
  cache.setNeeded([items[1]!, items[2]!], read);
  expect(read.mock.calls[0]![2].aborted).toBe(true);
  expect(read.mock.calls[1]![2].aborted).toBe(false);
  expect(read).toHaveBeenCalledTimes(2);
  loads[0]!.resolve(page('row-0'));
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(read.mock.calls[2]![0]).toBe('row-2');
  expect(cache.get(items[0]!).item).toBeUndefined();
  loads[1]!.resolve(page('row-1'));
  loads[2]!.resolve(page('row-2'));
  await vi.waitFor(() => {
    expect(cache.get(items[1]!).item).toMatchObject({ text: 'Complete row-1' });
    expect(cache.get(items[2]!).item).toMatchObject({ text: 'Complete row-2' });
  });
  cache.setNeeded([items[3]!], read);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  cache.suspend();
  expect(read.mock.calls[3]![2].aborted).toBe(true);
  loads[3]!.resolve(page('row-3'));
  await loads[3]!.promise;
  expect(cache.get(items[3]!).item).toBeUndefined();
});

it('evicts the most distant completed entry and reloads it when it becomes needed again', async () => {
  const cache = new TranscriptContentCache('generation', { bytes: 10_000, entries: 2, reads: 3 });
  const items = [row(0), row(10), row(11)];
  const read = vi.fn(async (id: string) => page(id));
  cache.setNeeded(items.slice(0, 2), read);
  await vi.waitFor(() => expect(cache.get(items[1]!).item).toMatchObject({ text: 'Complete row-10' }));
  cache.setNeeded([items[2]!], read);
  await vi.waitFor(() => expect(cache.get(items[2]!).item).toMatchObject({ text: 'Complete row-11' }));
  expect(cache.get(items[0]!).item).toBeUndefined();
  expect(cache.get(items[1]!).item).toMatchObject({ text: 'Complete row-10' });
  cache.setNeeded([items[0]!], read);
  await vi.waitFor(() => expect(cache.get(items[0]!).item).toMatchObject({ text: 'Complete row-0' }));
  expect(read.mock.calls.filter(([id]) => id === 'row-0')).toHaveLength(2);
  cache.suspend();
});

it('keeps oversized active content complete and releases it as soon as it becomes background content', async () => {
  const cache = new TranscriptContentCache('generation', { bytes: 128, entries: 384, reads: 3 });
  const item = row(0);
  const text = '界'.repeat(1_000);
  const read = vi.fn(async (id: string) => page(id, text));
  cache.setNeeded([item], read);
  await vi.waitFor(() => expect(cache.get(item).item).toMatchObject({ text }));
  cache.setNeeded([item], read);
  expect(cache.get(item).item).toMatchObject({ text });
  cache.setNeeded([], read);
  expect(cache.get(item).item).toBeUndefined();
  cache.setNeeded([item], read);
  await vi.waitFor(() => expect(cache.get(item).item).toMatchObject({ text }));
  expect(read).toHaveBeenCalledTimes(2);
  cache.suspend();
});

it('does not accumulate earlier complete streaming revisions behind the current one', async () => {
  const cache = new TranscriptContentCache('generation', { bytes: 500, entries: 3, reads: 3 });
  const neighbor = row(1);
  const item = row(0);
  let revision = 0;
  const read = vi.fn(async (id: string) => page(id, id === item.id ? `Complete revision ${revision}` : `Complete ${id}`));
  cache.setNeeded([neighbor], read);
  await vi.waitFor(() => expect(cache.get(neighbor).item).toMatchObject({ text: 'Complete row-1' }));
  for (revision = 1; revision <= 4; revision++) {
    const update = { ...item, contentRevision: revision };
    cache.setNeeded([update], read);
    await vi.waitFor(() => expect(cache.get(update).item).toMatchObject({ text: `Complete revision ${revision}` }));
  }
  expect(cache.get(neighbor).item).toMatchObject({ text: 'Complete row-1' });
  cache.suspend();
});

it('reads legacy 16 Ki-character chunks without requiring response revisions', async () => {
  const cache = new TranscriptContentCache('generation');
  const item = row(0);
  const complete: TranscriptItem = { id: item.id, type: 'message', role: 'user', text: 'Complete legacy content '.repeat(2_000) };
  const serialized = JSON.stringify(complete);
  const read = vi.fn(async (_id: string, offset: number) => ({
    text: serialized.slice(offset, offset + 16_384), offset,
    nextOffset: offset + 16_384 < serialized.length ? offset + 16_384 : null, totalCharacters: serialized.length,
  }));
  cache.setNeeded([item], read);
  await vi.waitFor(() => expect(cache.get(item).item).toEqual(complete));
  expect(read.mock.calls.map(([, offset]) => offset)).toEqual([0, 16_384, 32_768]);
  cache.suspend();
});

it('restarts mixed same-size chunks without hiding prior complete content or reporting a streaming error', async () => {
  const cache = new TranscriptContentCache('generation');
  const item = row(0);
  const complete = page(item.id, 'New complete content');
  const split = Math.floor(complete.text.length / 2);
  const retry = Promise.withResolvers<TranscriptContentPage>();
  const read = vi.fn<(id: string, offset: number, signal: AbortSignal) => Promise<TranscriptContentPage>>()
    .mockResolvedValueOnce(page(item.id, 'Old complete content'))
    .mockResolvedValueOnce({ ...complete, text: complete.text.slice(0, split), nextOffset: split, contentRevision: 2 })
    .mockResolvedValueOnce({ ...complete, text: complete.text.slice(split), offset: split, contentRevision: 3 })
    .mockImplementationOnce(() => retry.promise);
  cache.setNeeded([item], read);
  await vi.waitFor(() => expect(cache.get(item).item).toMatchObject({ text: 'Old complete content' }));
  const updated = { ...item, contentRevision: 2 };
  cache.setNeeded([updated], read);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  expect(read.mock.calls.map(([, offset]) => offset)).toEqual([0, 0, split, 0]);
  expect(cache.get(updated).item).toMatchObject({ text: 'Old complete content' });
  expect(cache.get(updated).error).toBeUndefined();
  retry.resolve({ ...complete, contentRevision: 3 });
  await vi.waitFor(() => expect(cache.get(updated).item).toMatchObject({ text: 'New complete content' }));
  cache.setNeeded([updated], read);
  cache.setNeeded([{ ...item, contentRevision: 3 }], read);
  expect(read).toHaveBeenCalledTimes(4);
  cache.suspend();
});

it('accepts a single-response item newer than its preview and reuses its actual revision', async () => {
  const cache = new TranscriptContentCache('generation');
  const item = row(0);
  const read = vi.fn(async (id: string) => ({ ...page(id), contentRevision: 3 }));
  cache.setNeeded([item], read);
  await vi.waitFor(() => expect(cache.get(item).item).toMatchObject({ text: 'Complete row-0' }));
  cache.setNeeded([{ ...item, contentRevision: 2 }], read);
  cache.setNeeded([{ ...item, contentRevision: 3 }], read);
  expect(read).toHaveBeenCalledOnce();
  cache.suspend();
});
