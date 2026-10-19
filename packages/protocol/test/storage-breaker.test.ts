import { expect, test } from 'bun:test';
import { installStorageBreaker, StorageQuarantinedError } from '../src/storage-breaker';

/** SQL storage whose every `INSERT` reports `rows` rows written. */
function storage(rows: () => number) {
  return {
    sql: { exec: (query: string) => ({ rowsWritten: query.startsWith('INSERT') ? rows() : 0, toArray: () => [] }) },
    deleteAlarm: async () => {},
  };
}

test('the budget is a rolling window: writes that age out of it no longer count', () => {
  let clock = Date.UTC(2026, 9, 14, 1, 0);
  const target = storage(() => 400);
  const breaker = installStorageBreaker(target, { limit: 1_000, now: () => clock });
  target.sql.exec('INSERT a');
  target.sql.exec('INSERT b');
  clock += 10 * 60_000;
  // The 800 rows of ten minutes ago no longer count.
  target.sql.exec('INSERT c');
  target.sql.exec('INSERT d');
  expect(breaker.status()).toMatchObject({ quarantined: false, rowsWritten: 800 });
  // Within ten minutes of c and d, the budget is spent.
  clock += 60_000;
  target.sql.exec('INSERT e');
  expect(breaker.status()).toMatchObject({ quarantined: true, rowsWritten: 1_200 });
  expect(() => target.sql.exec('SELECT 1')).toThrow(StorageQuarantinedError);
});
