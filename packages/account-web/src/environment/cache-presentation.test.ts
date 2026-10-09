import { expect, it } from 'vitest';
import { RuntimeAttachmentSchema, RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { cachePresentation, environmentCacheSummary } from './cache-presentation.js';

it('keeps a healthy cache from hiding a failed peer and never calls a stale heartbeat ready', () => {
  const stamp = '2026-10-06T12:00:00.000Z';
  const live = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'live', machineId: 'one', generation: 1, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: [], updatedAt: stamp, heartbeatAt: stamp, cache: { state: 'live', platform: 'linux', activity: [{ reason: 'command', name: 'bun dev' }], lastActivityAt: stamp, pausedAt: null, reclaimAt: null, lastSyncAt: stamp, localWorkOptIn: false, setup: [] } });
  const failed = RuntimeAttachmentSchema.parse({ ...live, attachmentId: 'failed', machineId: 'two', cache: { ...live.cache, state: 'setup', setup: [{ phase: 'checks', state: 'failed', runId: 'run' }] } });
  const snapshot = RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 1, attachments: [live, failed], conversations: [], tasks: [], questions: [], documents: {} });
  expect(environmentCacheSummary(snapshot, Date.parse(stamp))).toMatchObject({ count: 2, ready: 1, color: 'red' });
  expect(environmentCacheSummary({ ...snapshot, attachments: [live] }, Date.parse(stamp) + 31_000)).toMatchObject({ ready: 0, label: 'Offline' });
  expect(environmentCacheSummary({ ...snapshot, attachments: [] })).toMatchObject({ ready: 0, label: 'No machine', color: 'dim' });
});

it.each(['failed', 'waiting-for-approval'] as const)('reports an unavailable machine before its %s setup state', state => {
  const stamp = '2026-10-06T12:00:00.000Z';
  const attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'cache', machineId: 'one', generation: 1, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: [], updatedAt: stamp, heartbeatAt: stamp, cache: { state: 'setup', platform: 'linux', activity: [], lastActivityAt: stamp, pausedAt: null, reclaimAt: null, lastSyncAt: stamp, localWorkOptIn: false, setup: [{ phase: 'checks', state, runId: null }] } });
  expect(cachePresentation(attachment, Date.parse(stamp) + 30_001)).toMatchObject({ label: 'Offline', ready: false });
  expect(cachePresentation({ ...attachment, state: 'lost' }, Date.parse(stamp))).toMatchObject({ label: 'Offline', ready: false });
});

it('counts only live attachments so lost and detached history never drives the environment summary', () => {
  const stamp = '2026-10-06T12:00:00.000Z';
  const live = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'live', machineId: 'one', generation: 1, role: 'runner', checkout: { kind: 'snapshot', commit: 'a'.repeat(40) }, state: 'ready', capabilities: [], updatedAt: stamp, heartbeatAt: stamp });
  const lost = Array.from({ length: 6 }, (_, index) => ({ ...live, attachmentId: `lost-${index}`, state: 'lost' as const, lossReason: 'machine-destroyed' as const }));
  const snapshot = RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 1, attachments: [...lost, { ...live, attachmentId: 'detached', state: 'detached' }], conversations: [], tasks: [], questions: [], documents: {} });
  expect(environmentCacheSummary(snapshot, Date.parse(stamp))).toEqual({ count: 0, ready: 0, label: 'No machine', color: 'dim' });
  expect(environmentCacheSummary({ ...snapshot, attachments: [...snapshot.attachments, live] }, Date.parse(stamp))).toEqual({ count: 1, ready: 1, label: 'Live', color: 'green' });
});
