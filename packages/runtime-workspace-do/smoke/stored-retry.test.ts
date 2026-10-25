import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { createStoredRetry, type StoredRetry } from '../src/stored-retry.js';

/** The part of a Durable Object's SqlStorage the retry uses, over one SQLite database a "reset" reopens. */
function storage(database: Database): SqlStorage {
  const exec = (query: string, ...bindings: SQLQueryBindings[]) => {
    const rows = database.query(query).all(...bindings);
    return { toArray: () => rows };
  };
  return Object.assign(Object.create(null), { exec });
}

const NOW = new Date('2026-10-24T12:00:00Z').getTime();
afterEach(() => { setSystemTime(); });

/** LFS retention's schedule: 5 s doubling to 30 minutes, 10 tries. */
function harness(database: Database, outcome: { fail: boolean }) {
  const delays: number[] = [], reports: string[] = [];
  const open = () => createStoredRetry(storage(database), {
    table: 'runtime_lfs_retention_failures', event: 'lfs_retention_failed', workspaceId: 'workspace', firstMs: 5_000, maxMs: 30 * 60_000, attempts: 10,
    schedule: async timestamp => { delays.push(timestamp - NOW); },
    report: error => { reports.push(error instanceof Error ? error.message : String(error)); },
    stopped: (failures, message) => { reports.push(`stopped after ${failures}: ${message}`); },
  });
  const attempt = (retry: StoredRetry) => retry.run(async () => { if (outcome.fail) throw new Error('Retention unavailable'); });
  return { delays, reports, open, attempt };
}

test('a failure that keeps happening is retried on a doubling backoff that survives resets, then stops and says so', async () => {
  setSystemTime(NOW);
  const database = new Database(':memory:');
  const { delays, reports, open, attempt } = harness(database, { fail: true });
  let retry = open();
  for (let tries = 1; tries <= 12; tries++) {
    // The workspace is evicted between tries; the next try runs in a new instance.
    if (tries % 3 === 0) retry = open();
    await expect(attempt(retry)).rejects.toThrow('Retention unavailable');
  }
  expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 1_280_000]);
  expect(reports).toEqual(['Retention unavailable', 'stopped after 10: Retention unavailable']);
  expect(retry.stopped()).toBe(true);
});

test('a success, or new work after retrying stopped, starts the backoff and the reporting over', async () => {
  setSystemTime(NOW);
  const database = new Database(':memory:');
  const outcome = { fail: true };
  const { delays, reports, open, attempt } = harness(database, outcome);
  const retry = open();
  for (let tries = 1; tries <= 3; tries++) await expect(attempt(retry)).rejects.toThrow('Retention unavailable');
  outcome.fail = false;
  await attempt(retry);
  outcome.fail = true;
  await expect(attempt(retry)).rejects.toThrow('Retention unavailable');
  expect(delays).toEqual([5_000, 10_000, 20_000, 5_000]);
  expect(reports).toEqual(['Retention unavailable', 'Retention unavailable']);
  for (let tries = 2; tries <= 10; tries++) await retry.failed(new Error('Retention unavailable'));
  expect(retry.stopped()).toBe(true);
  retry.clear();
  delays.length = 0;
  await retry.failed(new Error('Retention unavailable'));
  expect([retry.stopped(), delays]).toEqual([false, [5_000]]);
});
