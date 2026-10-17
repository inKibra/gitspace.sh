import { z } from 'zod';
import { RuntimeIdentitySchema, RuntimeProjectIdSchema, RuntimeWorkspaceIdSchema, RuntimeMachineIdSchema, RuntimeCacheObservationSchema, RuntimeAttachmentFailureSchema } from './base.js';
import { RuntimeExecutionObservationSchema } from './scheduling.js';

export const RuntimeAttachmentLeaseSchema = RuntimeIdentitySchema.extend({ attachmentId: z.string().min(1), generation: z.number().int().nonnegative(), machineId: RuntimeMachineIdSchema });
/** `failure: null` clears the recorded failure; omitting it keeps it. */
export const RuntimeHeartbeatInputSchema = RuntimeAttachmentLeaseSchema.extend({ executionObservation: RuntimeExecutionObservationSchema, cache: RuntimeCacheObservationSchema.optional(), browserCapabilities: z.array(z.enum(['browser', 'browser_control', 'browser.headless', 'browser.relay'])).max(4).optional(), failure: RuntimeAttachmentFailureSchema.nullable().optional() });
export type RuntimeHeartbeatInput = z.infer<typeof RuntimeHeartbeatInputSchema>;
export const RuntimeDetachInputSchema = RuntimeAttachmentLeaseSchema;
/** `repository` is a workspace repository or `project-<projectId>`, which only the open base space
 * holder may lease, to seed the imported base branch; never with workspace or attachment identity. */
export const RuntimeRepositoryCredentialsInputSchema = z.object({
  projectId: RuntimeProjectIdSchema, workspaceId: RuntimeWorkspaceIdSchema.optional(), repository: z.string().min(1).optional(),
  machineId: RuntimeMachineIdSchema.optional(), attachmentId: z.string().min(1).optional(), generation: z.number().int().nonnegative().optional(),
  scope: z.enum(['read', 'write']),
}).refine(input => input.workspaceId !== undefined || input.repository !== undefined, 'Repository identity is required')
  .refine(input => !input.repository?.startsWith('project-')
    || (input.repository === `project-${input.projectId}` && input.workspaceId === undefined && input.attachmentId === undefined), 'A project repository lease names only its own project');
export type RuntimeRepositoryCredentialsInput = z.infer<typeof RuntimeRepositoryCredentialsInputSchema>;
export const RuntimeRepositoryCredentialsSchema = z.object({ remote: z.url(), plaintext: z.string().min(1), expiresAt: z.iso.datetime() });
/** An installation token for the checkout's covered origin. Git's credential protocol does not say whether it fetches
 * or pushes, so a ready checkout asks for `write` and any other for `read`. */
export const RuntimeGitHubTokenInputSchema = RuntimeAttachmentLeaseSchema.extend({ access: z.enum(['read', 'write']) });
