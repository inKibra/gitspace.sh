import { expect, test } from 'bun:test';
import { estimateMemory, VISIT_LIMIT } from '../src/memory-estimate.js';

test('an estimate past its bound stops, keeps what it measured and leaves later holders out', () => {
  const estimate = estimateMemory({
    drafts: { text: 'd'.repeat(5_000) },
    tasks: Array.from({ length: VISIT_LIMIT + 1_000 }, (_, index) => ({ id: `task-${index}` })),
    views: { text: 'v'.repeat(50_000) },
  });
  expect(estimate.truncated).toBe(true);
  expect(estimate.visited).toBe(VISIT_LIMIT);
  expect(Object.keys(estimate.holders)).toEqual(['drafts', 'tasks']);
  expect(estimate.holders.drafts).toBeGreaterThanOrEqual(5_000);
  // The array's slots, and the tasks the walk reached before its bound.
  expect(estimate.holders.tasks).toBeGreaterThan(8 * VISIT_LIMIT);
  expect(estimate.totalBytes).toBe(estimate.holders.drafts! + estimate.holders.tasks!);
});

test('an estimate within its bound measures every holder', () => {
  const estimate = estimateMemory({ tasks: Array.from({ length: 1_000 }, (_, index) => ({ id: `task-${index}` })), views: { text: 'v'.repeat(50_000) } });
  expect(estimate.truncated).toBe(false);
  expect(estimate.holders.views).toBeGreaterThanOrEqual(50_000);
});
