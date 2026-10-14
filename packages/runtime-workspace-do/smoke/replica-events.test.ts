import { expect, test } from 'bun:test';
import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { replicaEvents } from '../src/replica-store.js';

const snapshot = (cursor: number) => RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor, conversations: [], tasks: [], attachments: [], questions: [], documents: {} });
const delta = (cursor: number) => ({ type: 'delta' as const, baseCursor: cursor - 1, cursor, ops: [['s', ['documents', 'n'], cursor]] });
/** Retained deltas read like the replica: only cursors newer than the reader's. */
function retained(cursors: number[]) {
  return (after: number) => cursors.filter(cursor => cursor > after).map(cursor => ({ event: JSON.stringify(delta(cursor)) }));
}

test('a reader receives only the deltas newer than its cursor, in order', () => {
  expect(replicaEvents(snapshot(7), 5, retained([3, 4, 5, 6, 7]))).toEqual([delta(6), delta(7)]);
  expect(replicaEvents(snapshot(7), 7, retained([3, 4, 5, 6, 7]))).toEqual([]);
  expect(replicaEvents(snapshot(7), null, retained([3, 4, 5, 6, 7]))).toEqual([{ type: 'snapshot', snapshot: snapshot(7) }]);
});

test('a gap, an expired cursor, an oversized backlog or a cursor ahead resets to the current snapshot', () => {
  const current = snapshot(7);
  expect(replicaEvents(current, 4, retained([3, 4, 6, 7]))).toEqual([{ type: 'reset', reason: 'cursor-expired', snapshot: current }]);
  expect(replicaEvents(current, 1, retained([3, 4, 5, 6, 7]))).toEqual([{ type: 'reset', reason: 'cursor-expired', snapshot: current }]);
  expect(replicaEvents(current, 5, () => null)).toEqual([{ type: 'reset', reason: 'cursor-expired', snapshot: current }]);
  expect(replicaEvents(current, 9, retained([7]))).toEqual([{ type: 'reset', reason: 'cursor-ahead', snapshot: current }]);
});

test('a reader further behind than one bounded read resets instead of receiving a partial chain', () => {
  const cursors = Array.from({ length: 300 }, (_, index) => index + 1);
  expect(replicaEvents(snapshot(300), 44, retained(cursors))).toHaveLength(256);
  expect(replicaEvents(snapshot(300), 43, retained(cursors))).toEqual([{ type: 'reset', reason: 'cursor-expired', snapshot: snapshot(300) }]);
});
