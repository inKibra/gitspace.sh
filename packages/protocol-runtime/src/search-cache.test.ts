import { expect, test } from 'bun:test';
import { RuntimeAttachmentSchema } from './base.js';
import { RuntimeGitCheckpointSchema } from './git-checkpoint.js';
import { caughtUpSearchCache } from './search-cache.js';

const checkpoint = RuntimeGitCheckpointSchema.parse({ checkpointRef: 'refs/gitspace/checkpoints', headCommit: 'a'.repeat(40), branch: 'main', indexCommit: 'b'.repeat(40), trackedWorktreeCommit: 'c'.repeat(40), worktreeCommit: 'c'.repeat(40), indexTree: 'd'.repeat(40), worktreeTree: 'e'.repeat(40) });
test('ready stale or desired-commit-only caches cannot serve canonical grep', () => {
  const now = Date.now();
  const cache = RuntimeAttachmentSchema.parse({ projectId: 'p', workspaceId: 'w', attachmentId: 'a', machineId: 'm', generation: 1, role: 'cache', state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['grep'], updatedAt: new Date(now).toISOString(), heartbeatAt: new Date(now).toISOString() });
  expect(caughtUpSearchCache([cache], checkpoint, now)).toBeNull();
  expect(caughtUpSearchCache([{ ...cache, executionObservation: { activeExecutions: 0, observedAt: new Date(now).toISOString(), materializedCommit: 'f'.repeat(40) } }], checkpoint, now)).toBeNull();
  const current = { ...cache, executionObservation: { activeExecutions: 0, observedAt: new Date(now).toISOString(), materializedCommit: checkpoint.worktreeCommit } };
  expect(caughtUpSearchCache([current], checkpoint, now)?.attachmentId).toBe('a');
  expect(caughtUpSearchCache([current], checkpoint, now + 30_001)).toBeNull();
  expect(caughtUpSearchCache([{ ...current, state: 'lost' }], checkpoint, now)).toBeNull();
});
