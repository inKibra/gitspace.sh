import { expect, it } from 'bun:test';
import { snapshotPage } from '../src/snapshot-page.js';

it('continues a finite read without mixing changed or different resources', async () => {
  const values = ['first', 'second', 'third'];
  const first = await snapshotPage(values, { identity: { spaceId: 'one', url: 'local://workspace/log' }, cursor: null, limit: 2 });
  expect(first.items).toEqual(['first', 'second']);
  const next = await snapshotPage(values, { identity: { spaceId: 'one', url: 'local://workspace/log' }, cursor: first.nextCursor, limit: 2 });
  expect(next).toEqual({ items: ['third'], nextCursor: null });
  await expect(snapshotPage(['first', 'changed', 'third'], { identity: { spaceId: 'one', url: 'local://workspace/log' }, cursor: first.nextCursor, limit: 2 })).rejects.toThrow('Snapshot changed');
  await expect(snapshotPage(values, { identity: { spaceId: 'two', url: 'local://workspace/log' }, cursor: first.nextCursor, limit: 2 })).rejects.toThrow('Snapshot changed');
});
