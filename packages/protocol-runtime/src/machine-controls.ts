import { z } from 'zod';
import { RuntimeIdentitySchema, RuntimeProjectIdSchema, RuntimeWorkspaceIdSchema, RuntimeMachineIdSchema, RuntimeCacheObservationSchema, RuntimeCacheActionSchema } from './base.js';
import { RuntimeExecutionObservationSchema } from './scheduling.js';

export const RuntimeAttachmentLeaseSchema = RuntimeIdentitySchema.extend({ attachmentId: z.string().min(1), generation: z.number().int().nonnegative(), machineId: RuntimeMachineIdSchema });
export const RuntimeHeartbeatInputSchema = RuntimeAttachmentLeaseSchema.extend({ executionObservation: RuntimeExecutionObservationSchema, cache: RuntimeCacheObservationSchema.optional(), cacheAction: RuntimeCacheActionSchema.pick({ requestId: true, error: true }).extend({ status: z.enum(['running', 'completed', 'failed']) }).optional(), browserCapabilities: z.array(z.enum(['browser', 'browser_control', 'browser.headless', 'browser.relay'])).max(4).optional() });
export type RuntimeHeartbeatInput = z.infer<typeof RuntimeHeartbeatInputSchema>;
export const RuntimeDetachInputSchema = RuntimeAttachmentLeaseSchema.extend({ state: z.enum(['draining', 'detached', 'lost']), discardHeldBack: z.boolean().optional() });
export const RuntimeRepositoryCredentialsInputSchema = z.object({
  projectId: RuntimeProjectIdSchema, workspaceId: RuntimeWorkspaceIdSchema.optional(), repository: z.string().min(1).optional(),
  machineId: RuntimeMachineIdSchema.optional(), attachmentId: z.string().min(1).optional(), generation: z.number().int().nonnegative().optional(),
  scope: z.enum(['read', 'write']),
}).refine(input => input.workspaceId !== undefined || input.repository !== undefined, 'Repository identity is required');
export const RuntimeRepositoryCredentialsSchema = z.object({ remote: z.url(), plaintext: z.string().min(1), expiresAt: z.iso.datetime() });
