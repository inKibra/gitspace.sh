import { expect, test } from 'bun:test';
import { cacheActivity } from '../src/runtime-cache-activity.js';

const now = Date.parse('2026-10-06T12:00:00.000Z');
const policy = { idleGraceSeconds: 900, reclaimSeconds: 86400 };
const cache = { state: 'live' as const, platform: process.platform, activity: [], lastActivityAt: new Date(now).toISOString(), pausedAt: null, reclaimAt: null, lastSyncAt: null, localWorkOptIn: false, reclaimBlocked: null, setup: [] };

test('cache grace expires into retained pause and later reclamation', () => {
  const grace = cacheActivity(cache, [], policy, now + 899_000);
  expect(grace.state).toBe('live');
  expect(grace.activity).toEqual([{ reason: 'grace', name: 'Recent GitSpace activity' }]);
  const paused = cacheActivity(cache, [], policy, now + 900_000);
  expect(paused.state).toBe('paused');
  expect(paused.pausedAt).toBe(new Date(now + 900_000).toISOString());
  expect(paused.reclaimAt).toBe(new Date(now + 900_000 + 86400_000).toISOString());
  expect(cacheActivity(paused, [], policy, now + 900_000 + 86400_000).state).toBe('draining');
});

test('live terminal and process reasons renew liveness; closing starts grace', () => {
  const terminal = cacheActivity(cache, [{ reason: 'terminal', name: 'shell' }], policy, now + 900_000);
  expect(terminal.state).toBe('live');
  expect(terminal.lastActivityAt).toBe(new Date(now + 900_000).toISOString());
  const closed = cacheActivity(terminal, [], policy, now + 901_000);
  expect(closed.activity).toEqual([{ reason: 'grace', name: 'Recent GitSpace activity' }]);
  const running = cacheActivity(closed, [{ reason: 'proc', name: 'server' }], policy, now + 1900_000);
  expect(closed.lastActivityAt).toBe(new Date(now + 901_000).toISOString());
  expect(running.state).toBe('live');
  expect(running.activity).toEqual([{ reason: 'proc', name: 'server' }]);
});

test('explicit local work holds live while paused caches otherwise remain paused', () => {
  const paused = cacheActivity(cache, [], policy, now + 900_000);
  expect(cacheActivity(paused, [], policy, now + 1000_000).state).toBe('paused');
  const optedIn = cacheActivity({ ...paused, localWorkOptIn: true }, [], policy, now + 1000_000);
  expect(optedIn.state).toBe('live');
  expect(optedIn.pausedAt).toBeNull();
  expect(optedIn.activity).toEqual([{ reason: 'local-work', name: 'Local work enabled' }]);
});
