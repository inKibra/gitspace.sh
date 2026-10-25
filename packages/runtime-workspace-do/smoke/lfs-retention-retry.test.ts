import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { createLfsRetentionRetry } from '../src/lfs-retention-retry.js';

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

function harness(database: Database, outcome: { fail: boolean }) {
  const delays: number[] = [], reports: string[] = [];
  const open = () => createLfsRetentionRetry(storage(database), {
    workspaceId: 'workspace',
    retain: async () => { if (outcome.fail) throw new Error('Retention unavailable'); },
    schedule: async timestamp => { delays.push(timestamp - NOW); },
    report: error => { reports.push(error instanceof Error ? error.message : String(error)); },
  });
  return { delays, reports, open };
}

test('a retention that keeps failing is retried on a doubling backoff that survives resets, then stops and says so', async () => {
  setSystemTime(NOW);
  const database = new Database(':memory:');
  const { delays, reports, open } = harness(database, { fail: true });
  let retry = open();
  for (let attempt = 1; attempt <= 12; attempt++) {
    // The workspace is evicted between tries; the next try runs in a new instance.
    if (attempt % 3 === 0) retry = open();
    await expect(retry.retain()).rejects.toThrow('Retention unavailable');
  }
  expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 1_280_000]);
  expect(reports).toHaveLength(2);
  expect(reports[0]).toBe('Retention unavailable');
  expect(reports[1]).toStartWith('LFS retention stopped retrying after 10 failures: Retention unavailable.');
});

test('a success starts the backoff and the reporting over', async () => {
  setSystemTime(NOW);
  const database = new Database(':memory:');
  const outcome = { fail: true };
  const { delays, reports, open } = harness(database, outcome);
  const retry = open();
  for (let attempt = 1; attempt <= 3; attempt++) await expect(retry.retain()).rejects.toThrow('Retention unavailable');
  outcome.fail = false;
  await retry.retain();
  outcome.fail = true;
  await expect(retry.retain()).rejects.toThrow('Retention unavailable');
  expect(delays).toEqual([5_000, 10_000, 20_000, 5_000]);
  expect(reports).toEqual(['Retention unavailable', 'Retention unavailable']);
});
