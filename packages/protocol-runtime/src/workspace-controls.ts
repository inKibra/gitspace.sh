import { z } from 'zod';
import { RuntimeIdentitySchema, RuntimeMachineIdSchema, RuntimeActionResultSchema } from './base.js';
import { RuntimeGitCheckpointSchema } from './git-checkpoint.js';
export { RuntimeGitCheckpointSchema } from './git-checkpoint.js';
const gitObjectId = z.string().regex(/^[0-9a-f]{40}$/u);
export const RuntimeSnapshotCommitInputSchema = RuntimeIdentitySchema.extend({ attachmentId: z.string(), generation: z.number().int().nonnegative(), checkpoint: RuntimeGitCheckpointSchema, previousWorktreeCommit: gitObjectId.nullable() });
export const RuntimeSnapshotCommitResultSchema = RuntimeActionResultSchema.extend({ checkpoint: RuntimeGitCheckpointSchema });
export const RuntimeCreationSchema = z.object({ state: z.enum(['pending', 'forking', 'checkout', 'materializing', 'ready', 'failed']), taskId: z.string().nullable(), message: z.string().nullable() });
/** The reviewed copy of an issue sent with "File with GitSpace", at most this many characters. */
export const FILED_ISSUE_EXCERPT_MAX = 8000;
/** An issue a person filed with GitSpace from a workspace: the account object's copy, read by the GitSpace agent. */
export const FiledIssueSchema = z.object({ id: z.string(), projectId: z.string(), workspaceId: z.string(), title: z.string(), excerpt: z.string().min(1).max(FILED_ISSUE_EXCERPT_MAX), tool: z.string().nullable(), model: z.string(), historyRef: z.string(), createdAt: z.iso.datetime(), filedAt: z.iso.datetime(), filedBy: z.string(), state: z.enum(['open', 'resolved']), resolution: z.object({ at: z.iso.datetime(), commit: gitObjectId.optional(), note: z.string().optional() }).nullable() });
/** Newest filed first; `before` pages by `filedAt`. */
export const FiledIssueListInputSchema = z.object({ state: z.enum(['open', 'resolved']).optional(), before: z.iso.datetime().optional(), limit: z.number().int().min(1).max(100).default(50) });
export const FiledIssueResolveInputSchema = z.object({ id: z.string().min(1), commit: gitObjectId.optional(), note: z.string().min(1).max(2000).optional() });
export type RuntimeSnapshotCommitInput = z.infer<typeof RuntimeSnapshotCommitInputSchema>;
export type RuntimeSnapshotCommitResult = z.infer<typeof RuntimeSnapshotCommitResultSchema>;
export type FiledIssue = z.infer<typeof FiledIssueSchema>;
export type FiledIssueListInput = z.input<typeof FiledIssueListInputSchema>;
export type FiledIssueResolveInput = z.infer<typeof FiledIssueResolveInputSchema>;
