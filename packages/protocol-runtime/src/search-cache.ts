import type { RuntimeAttachment } from './base.js';
import type { RuntimeGitCheckpoint } from './git-checkpoint.js';

/** Readiness alone is not a snapshot proof. Heartbeats are admitted under the exact attachment generation. */
export function caughtUpSearchCache(attachments: readonly RuntimeAttachment[], checkpoint: RuntimeGitCheckpoint, now = Date.now()): RuntimeAttachment | null {
  return attachments.find(attachment => {
    const observation = attachment.executionObservation;
    if (!observation) return false;
    return attachment.state === 'ready' && attachment.role === 'cache' && attachment.heartbeatAt !== null && now - Date.parse(attachment.heartbeatAt) <= 30_000
      && attachment.capabilities.includes('grep') && observation.materializedCommit === checkpoint.worktreeCommit
      && observation.activeExecutions === 0 && now - Date.parse(observation.observedAt) <= 30_000
      && Date.parse(observation.observedAt) <= now + 5_000;
  }) ?? null;
}
