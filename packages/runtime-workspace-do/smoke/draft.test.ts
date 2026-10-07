import { expect, test } from 'bun:test';
import { WorkspaceDraftStore } from '../src/draft.js';

test('serializes competing writes, persists restart state and fences accepted-send clear', async () => {
  let stored: unknown;
  const storage = { read: async () => stored, write: async (value: unknown) => { stored = value; } };
  const owner = new WorkspaceDraftStore(storage); await owner.initialize();
  const [a, b] = await Promise.all([owner.save({ text: 'A', expectedRevision: 0 }, 'device-a'), owner.save({ text: 'B', expectedRevision: 0 }, 'device-b')]);
  expect(a.status).toBe('saved'); expect(b.status).toBe('conflict');
  const revision = owner.snapshot().revision;
  await owner.save({ text: 'newer', expectedRevision: revision }, 'device-b');
  expect((await owner.clear(revision, 'device-a')).status).toBe('conflict');
  const restarted = new WorkspaceDraftStore(storage); await restarted.initialize();
  expect(restarted.snapshot()).toMatchObject({ text: 'newer', revision: revision + 1, deviceId: 'device-b' });
  await restarted.clear(restarted.snapshot().revision, 'device-b'); expect(restarted.snapshot().text).toBe('');
});
