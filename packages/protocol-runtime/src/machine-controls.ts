import { z } from 'zod';
import { RuntimeIdentitySchema, RuntimeProjectIdSchema, RuntimeWorkspaceIdSchema, RuntimeMachineIdSchema } from './base.js';
import { RuntimeExecutionObservationSchema } from './scheduling.js';

export const RuntimeAttachmentLeaseSchema = RuntimeIdentitySchema.extend({ attachmentId: z.string().min(1), generation: z.number().int().nonnegative(), machineId: RuntimeMachineIdSchema });
export const RuntimeHeartbeatInputSchema = RuntimeAttachmentLeaseSchema.extend({ executionObservation: RuntimeExecutionObservationSchema, browserCapabilities: z.array(z.enum(['browser', 'browser_control', 'browser.headless', 'browser.relay'])).max(4).optional() });
export const RuntimeDetachInputSchema = RuntimeAttachmentLeaseSchema.extend({ state: z.enum(['draining', 'detached', 'lost']) });
export const RuntimeRepositoryCredentialsInputSchema = z.object({
  projectId: RuntimeProjectIdSchema, workspaceId: RuntimeWorkspaceIdSchema.optional(), repository: z.string().min(1).optional(),
  machineId: RuntimeMachineIdSchema.optional(), attachmentId: z.string().min(1).optional(), generation: z.number().int().nonnegative().optional(),
  scope: z.enum(['read', 'write']),
}).refine(input => input.workspaceId !== undefined || input.repository !== undefined, 'Repository identity is required');
export const RuntimeRepositoryCredentialsSchema = z.object({ remote: z.url(), plaintext: z.string().min(1), expiresAt: z.iso.datetime() });
