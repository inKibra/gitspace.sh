import type { RuntimeCacheObservation, RuntimeCachePolicy } from '@gitspace/protocol-runtime';

/** Only observed GitSpace effects renew activity; polling and snapshot traffic do not. */
export function cacheActivity(previous: RuntimeCacheObservation, observed: RuntimeCacheObservation['activity'], policy: RuntimeCachePolicy, now: number): RuntimeCacheObservation {
  const activity = [...observed];
  if (previous.localWorkOptIn) activity.push({ reason: 'local-work', name: 'Local work enabled' });
  if (activity.length) return { ...previous, state: 'live', activity, lastActivityAt: new Date(now).toISOString(), pausedAt: null, reclaimAt: null };
  if (previous.activity.some(item => !['grace', 'sync'].includes(item.reason))) return { ...previous, state: 'live', activity: [{ reason: 'grace', name: 'Recent GitSpace activity' }], lastActivityAt: new Date(now).toISOString(), pausedAt: null, reclaimAt: null };
  const pauseAt = Date.parse(previous.lastActivityAt) + policy.idleGraceSeconds * 1000;
  if (now < pauseAt) return { ...previous, state: 'live', activity: [{ reason: 'grace', name: 'Recent GitSpace activity' }], pausedAt: null, reclaimAt: null };
  const pausedAt = previous.pausedAt ?? new Date(pauseAt).toISOString();
  const reclaimAt = new Date(Date.parse(pausedAt) + policy.reclaimSeconds * 1000).toISOString();
  return { ...previous, state: now >= Date.parse(reclaimAt) ? 'draining' : 'paused', activity: [], pausedAt, reclaimAt };
}
