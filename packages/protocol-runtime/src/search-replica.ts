import type { RuntimeAttachment } from './base.js';
import type { RuntimeGitCheckpoint } from './git-checkpoint.js';

/** Readiness alone is not a snapshot proof. Heartbeats are admitted under the exact attachment generation. */
export function caughtUpSearchReplica(attachments: readonly RuntimeAttachment[], checkpoint: RuntimeGitCheckpoint, now = Date.now()): RuntimeAttachment | null {
  return attachments.find(attachment => {
    const observation = attachment.executionObservation;
    if (!observation) return false;
    return attachment.state === 'ready' && (attachment.role === 'primary' || attachment.role === 'replica')
      && attachment.capabilities.includes('grep') && observation.materializedCommit === checkpoint.worktreeCommit
      && observation.activeExecutions === 0 && now - Date.parse(observation.observedAt) <= 30_000
      && Date.parse(observation.observedAt) <= now + 5_000;
  }) ?? null;
}
