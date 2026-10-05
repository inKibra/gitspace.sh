import { z } from 'zod';
import { GitLfsRestoredSchema } from '@gitspace/protocol-workspace';
import { RuntimeAttachmentSchema, RuntimeAttachResultSchema, RuntimeIdentitySchema, RuntimeMachineIdSchema } from './base.js';
import { RuntimeGitCheckpointSchema } from './workspace-controls.js';

const commit = z.string().regex(/^[0-9a-f]{40}$/u);
export const RuntimeAttachmentSourceSchema = z.object({ ref: z.union([commit, z.string().regex(/^refs\/[A-Za-z0-9._/-]+$/u).refine(ref => !ref.includes('..'))]), commit, requiresFiltersOrSubmodules: z.boolean() });
export const RuntimeAttachmentRequestInputSchema = RuntimeIdentitySchema.extend({
  requestId: z.string().min(1), machineId: RuntimeMachineIdSchema,
  sourceRef: RuntimeAttachmentSourceSchema.shape.ref,
  checkout: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('snapshot'), commit }),
    z.object({ kind: z.literal('branch'), commit, branch: z.string().min(1) }),
  ]),
});
export const RuntimeAttachmentRequestResultSchema = z.object({ attachment: RuntimeAttachmentSchema });
export const RuntimePrimaryAttachmentRequestInputSchema = RuntimeIdentitySchema.extend({
  requestId: z.string().min(1), machineId: RuntimeMachineIdSchema,
});
export const RuntimeAttachmentDetachRequestInputSchema = RuntimeIdentitySchema.extend({
  machineId: RuntimeMachineIdSchema, attachmentId: z.string().min(1), generation: z.number().int().nonnegative(),
});
export const RuntimeAssignmentsInputSchema = z.object({ machineId: RuntimeMachineIdSchema });
export const RuntimeAssignmentSchema = z.object({
  grant: RuntimeAttachResultSchema,
  source: RuntimeAttachmentSourceSchema.extend({ remote: z.url().optional(), origin: z.string().nullable() }).nullable(),
  checkpoint: RuntimeGitCheckpointSchema.nullable().default(null),
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
