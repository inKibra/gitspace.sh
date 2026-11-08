import { expect, test } from 'bun:test';
import { createStorageReads } from '../src/storage-reads.js';

test('reads count under the scope that made them, across awaits and alongside unscoped reads, until taken', async () => {
  const reads = createStorageReads();
  const contextRead = Promise.withResolvers<void>();
  const rebuild = reads.within('rebuild', async () => {
    reads.record([{ id: 1, record: 'r'.repeat(1_000) }]);
    // A turn's context is read while the rebuild waits between its reads.
    await contextRead.promise;
    reads.record([{ id: 2, record: 'r'.repeat(2_000) }, { id: 3, record: null }]);
  });
  const transcript = reads.within('transcript', async () => {
    await contextRead.promise;
    reads.record([{ image: new Uint8Array(300) }]);
  });
  reads.record([{ id: 4, record: 'c'.repeat(5_000) }]);
  contextRead.resolve();
  await Promise.all([rebuild, transcript]);
  expect(reads.take()).toEqual({
    rebuild: { queries: 2, rows: 3, bytes: 8 + 1_000 + 8 + 2_000 + 8 },
    transcript: { queries: 1, rows: 1, bytes: 300 },
    other: { queries: 1, rows: 1, bytes: 8 + 5_000 },
    largestBytes: 5_008,
  });
  expect(reads.take()).toEqual({ rebuild: { queries: 0, rows: 0, bytes: 0 }, transcript: { queries: 0, rows: 0, bytes: 0 }, other: { queries: 0, rows: 0, bytes: 0 }, largestBytes: 0 });
});
