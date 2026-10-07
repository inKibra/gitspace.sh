import { z } from 'zod';
import { GitLfsSnapshotSchema } from '@gitspace/protocol-workspace';

const gitObjectId = z.string().regex(/^[0-9a-f]{40}$/u);
export const RuntimeGitCheckpointSchema = z.object({
  checkpointRef: z.string().regex(/^refs\/gitspace\/[A-Za-z0-9._/-]+$/u),
  headCommit: gitObjectId.nullable(),
  branch: z.string().min(1),
  indexCommit: gitObjectId,
  trackedWorktreeCommit: gitObjectId,
  worktreeCommit: gitObjectId,
  indexTree: gitObjectId,
  worktreeTree: gitObjectId,
  lfs: GitLfsSnapshotSchema.optional(),
  conflicts: z.array(z.string().min(1)).optional(),
});
export type RuntimeGitCheckpoint = z.infer<typeof RuntimeGitCheckpointSchema>;
