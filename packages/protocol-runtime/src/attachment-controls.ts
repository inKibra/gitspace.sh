import { z } from 'zod';
import { GitLfsRestoredSchema } from '@gitspace/protocol-workspace';
import { RuntimeAttachmentSchema, RuntimeAttachResultSchema, RuntimeIdentitySchema, RuntimeMachineIdSchema, RuntimeCachePolicySchema } from './base.js';
import { RuntimeGitCheckpointSchema } from './workspace-controls.js';

const commit = z.string().regex(/^[0-9a-f]{40}$/u);
export const RuntimeAttachmentSourceSchema = z.object({ ref: z.union([commit, z.string().regex(/^refs\/[A-Za-z0-9._/-]+$/u).refine(ref => !ref.includes('..'))]), commit, requiresFiltersOrSubmodules: z.boolean(), checkpoint: RuntimeGitCheckpointSchema.optional() });
export const RuntimeAttachmentRequestInputSchema = RuntimeIdentitySchema.extend({
  requestId: z.string().min(1), machineId: RuntimeMachineIdSchema,
  sourceRef: RuntimeAttachmentSourceSchema.shape.ref,
  checkout: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('snapshot'), commit }),
    z.object({ kind: z.literal('branch'), commit, branch: z.string().min(1) }),
  ]),
});
export const RuntimeAttachmentRequestResultSchema = z.object({ attachment: RuntimeAttachmentSchema });
export const RuntimeCacheAttachmentRequestInputSchema = RuntimeIdentitySchema.extend({
  requestId: z.string().min(1), machineId: RuntimeMachineIdSchema,
});
export const RuntimeAttachmentDetachRequestInputSchema = RuntimeIdentitySchema.extend({
  machineId: RuntimeMachineIdSchema, attachmentId: z.string().min(1), generation: z.number().int().nonnegative(),
  discardHeldBack: z.boolean().optional(),
});
export const RuntimeCacheActionInputSchema = RuntimeAttachmentDetachRequestInputSchema.omit({ discardHeldBack: true }).extend({
  requestId: z.string().min(1),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('setup') }),
    z.object({ kind: z.literal('reclaim'), discardHeldBack: z.boolean().optional() }),
    z.object({ kind: z.literal('local-work'), enabled: z.boolean() }),
  ]),
});
export type RuntimeCacheActionInput = z.infer<typeof RuntimeCacheActionInputSchema>;
export const RuntimeAssignmentsInputSchema = z.object({ machineId: RuntimeMachineIdSchema, workspace: RuntimeIdentitySchema.optional(), afterSnapshot: commit.optional() }).refine(input => input.afterSnapshot === undefined || input.workspace !== undefined, 'Snapshot wait requires a workspace');
export const RuntimeAssignmentSchema = z.object({
  grant: RuntimeAttachResultSchema,
  source: RuntimeAttachmentSourceSchema.extend({ remote: z.url().optional(), origin: z.string().nullable() }).nullable(),
  checkpoint: RuntimeGitCheckpointSchema.nullable().default(null),
  sourceCheckpoint: RuntimeGitCheckpointSchema.optional(),
  cachePolicy: RuntimeCachePolicySchema.default({ idleGraceSeconds: 900, reclaimSeconds: 86400 }),
});
export const RuntimeAssignmentsResultSchema = z.object({ assignments: z.array(RuntimeAssignmentSchema) });
export const RuntimeAttachmentReadyInputSchema = RuntimeIdentitySchema.extend({
  machineId: RuntimeMachineIdSchema, attachmentId: z.string().min(1), generation: z.number().int().nonnegative(),
  commit, prerequisitesComplete: z.literal(true), capabilities: z.array(z.string()),
  lfsRestored: z.array(GitLfsRestoredSchema).optional(),
});
export const RuntimeAttachmentReadyResultSchema = RuntimeAttachmentRequestResultSchema;
export type RuntimeAttachmentRequestInput = z.infer<typeof RuntimeAttachmentRequestInputSchema>;
export type RuntimeAttachmentSource = z.infer<typeof RuntimeAttachmentSourceSchema>;
export type RuntimeAttachmentReadyInput = z.infer<typeof RuntimeAttachmentReadyInputSchema>;
