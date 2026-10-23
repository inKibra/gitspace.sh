import { z } from 'zod';
import { RuntimeIdentitySchema, RuntimeMachineIdSchema, RuntimeActionResultSchema } from './base.js';
import { RuntimeGitCheckpointSchema } from './git-checkpoint.js';
export { RuntimeGitCheckpointSchema } from './git-checkpoint.js';
export const RuntimeQaActionResultSchema = RuntimeActionResultSchema.extend({ shareDraft: z.url().optional() });
const gitObjectId = z.string().regex(/^[0-9a-f]{40}$/u);
export const RuntimeSnapshotCommitInputSchema = RuntimeIdentitySchema.extend({ attachmentId: z.string(), generation: z.number().int().nonnegative(), checkpoint: RuntimeGitCheckpointSchema, previousWorktreeCommit: gitObjectId.nullable() });
export const RuntimeSnapshotCommitResultSchema = RuntimeActionResultSchema.extend({ checkpoint: RuntimeGitCheckpointSchema });
export const RuntimeCreationSchema = z.object({ state: z.enum(['pending', 'forking', 'checkout', 'materializing', 'ready', 'failed']), taskId: z.string().nullable(), message: z.string().nullable() });
/** `fixedIn` and `filedAt` are absent from items recorded before they existed. */
export const RuntimeQaItemSchema = z.object({ id: z.string(), title: z.string(), description: z.string(), historyRef: z.string(), tool: z.string().nullable(), model: z.string(), runtimeVersion: z.string(), state: z.enum(['open', 'dismissed', 'merged', 'shared', 'fixed']), duplicateOf: z.string().nullable(), fixedIn: gitObjectId.nullable().default(null), filedAt: z.iso.datetime().nullable().default(null), createdAt: z.iso.datetime() });
/** The reviewed copy of an issue sent with "File with GitSpace", at most this many characters. */
export const RUNTIME_QA_FILED_EXCERPT_MAX = 8000;
export const RuntimeQaActionInputSchema = RuntimeIdentitySchema.extend({ itemId: z.string(), action: z.discriminatedUnion('kind', [z.object({ kind: z.literal('dismiss') }), z.object({ kind: z.literal('merge'), targetId: z.string() }), z.object({ kind: z.literal('fixed'), commit: gitObjectId }), z.object({ kind: z.literal('file'), excerpt: z.string().min(1).max(RUNTIME_QA_FILED_EXCERPT_MAX) }), z.object({ kind: z.literal('share'), target: z.enum(['gitspace', 'repository']), redactedExcerpt: z.string().min(1), confirmed: z.literal(true) })]) });
export const RuntimeQaDocumentSchema = z.object({ items: z.array(RuntimeQaItemSchema) });
/** An issue a person filed with GitSpace from a workspace: the account object's copy, read by the GitSpace agent. */
export const FiledIssueSchema = z.object({ id: z.string(), projectId: z.string(), workspaceId: z.string(), title: z.string(), excerpt: z.string().min(1).max(RUNTIME_QA_FILED_EXCERPT_MAX), tool: z.string().nullable(), model: z.string(), historyRef: z.string(), createdAt: z.iso.datetime(), filedAt: z.iso.datetime(), filedBy: z.string(), state: z.enum(['open', 'resolved']), resolution: z.object({ at: z.iso.datetime(), commit: gitObjectId.optional(), note: z.string().optional() }).nullable() });
/** Newest filed first; `before` pages by `filedAt`. */
export const FiledIssueListInputSchema = z.object({ state: z.enum(['open', 'resolved']).optional(), before: z.iso.datetime().optional(), limit: z.number().int().min(1).max(100).default(50) });
export const FiledIssueResolveInputSchema = z.object({ id: z.string().min(1), commit: gitObjectId.optional(), note: z.string().min(1).max(2000).optional() });
export type RuntimeSnapshotCommitInput = z.infer<typeof RuntimeSnapshotCommitInputSchema>;
export type RuntimeSnapshotCommitResult = z.infer<typeof RuntimeSnapshotCommitResultSchema>;
export type RuntimeQaActionInput = z.infer<typeof RuntimeQaActionInputSchema>;
export type RuntimeQaItem = z.infer<typeof RuntimeQaItemSchema>;
export type FiledIssue = z.infer<typeof FiledIssueSchema>;
export type FiledIssueListInput = z.input<typeof FiledIssueListInputSchema>;
export type FiledIssueResolveInput = z.infer<typeof FiledIssueResolveInputSchema>;
